#!/usr/bin/env node
// oa-standard-approval-reconcile.mjs — 标准审批（企微）小时级对账（OA P2 Task 5 / issue #2385）。
//
// 分工：企微审批应用是**执行方与事实源**；平台只做只读镜像（forms.external_approval）。
// 回调（T4）是主通路，本 job 是它的兜底：每小时按**已发布的 `wecom_native` 绑定**逐租户
// 拉企微数据，补上回调丢失的单与详情。写入与回调**同一个幂等键**（org, provider, provider_ref），
// 谁先写谁生效，重复跑不新增行。
//
// 两条通路（`--mode`）：
//   ① list（缺省 auto 先试）：gettoken → getapprovaldata 列举时间窗内的 SpNo → 逐条
//      getapprovaldetail → 过滤到本租户绑定过的 template_id → upsert。
//   ② detail（auto 在列表端点不可用时自动降级；也可 `--mode=detail` 强制）：
//      只补「回调已到达、detail is null」的镜像行（getapprovaldetail 补齐），并显式打
//      `discovery=callback_only` —— 此时**发现新单仍依赖回调**，不假装能发现。
//      T1 的真实取证结论落地前不把任何一档当成「已证可用」：auto 遇到列表端点非 0 errcode
//      就降级并留下 `evt=list_unavailable`，不静默当成功。
//
// 配置口径（plan §Global Constraints / migration 022 注释）：
//   · 绑定：forms.asset_version 中 kind='approval_def'、当前 active 版本（asset_head）、
//     status='published'、body->>'provider'='wecom_native'；
//   · 租户凭据：platform.tenant 五列（corp_id / agent_id / secret / token / aes_key），
//     **缺任一 ⇒ 跳过该租户并打 `evt=config_missing`**（不猜、不回落登录应用）；
//     敏感值只从 DB 取来喂请求，日志/统计**绝不输出值**（只输出缺了哪几列）。
//
// 告警面（本仓 job 的既有口径：结构化 stderr 日志 + 退出码）：
//   · `evt=config_missing` / `evt=list_unavailable` / `evt=detail_failed` / `evt=unknown_status`
//     等行即告警事实，作业日志/OO 可直接检索；
//   · token 失败 ⇒ 最终退出码 1（`evt=token_failed`），不能把整租户的镜像静默停在旧状态。
//
// 用法（容器内与既有 job 同姿势：`pnpm exec tsx scripts/...` 或直接 node）：
//   DATABASE_URL=... node scripts/oa-standard-approval-reconcile.mjs [--dry-run]
//     [--mode=auto|list|detail] [--window-minutes=120] [--detail-limit=200] [--max-pages=20]
//
// 退出码：0 = 跑完（含 config_missing 的跳过）；1 = 有租户 token 失败（其余租户照跑）；
//         2 = 环境/连接类（缺 DATABASE_URL、连库失败等）。
//
// ⚠️ upsert SQL 与 `modules/forms/storage.ts` 的 `upsertExternalApproval` **同源同语义**
//   （本文件是 .mjs，为保持 `node` 可直接运行不 import TS；两者改动必须一起改，
//   storage 侧由 modules/forms/kernel.test.ts 兜底）。语义：status 后写胜；其余可空列
//   coalesce —— 「只带状态」的更新不能把先到的标题/申请人/摘要擦成 null。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// 仓库根不依赖 pg（照 oa-approval-reconcile.mjs：从 apps/server 的依赖树取，且延迟到 main）。
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))

export const WECOM_API_BASE = 'https://qyapi.weixin.qq.com'
/** 企微 getapprovaldata 的时间窗上限（官方：starttime 不早于当前时间 30 天）。 */
const MAX_WINDOW_MINUTES = 30 * 24 * 60
/** 官方列表单页上限。 */
const LIST_PAGE_SIZE = 100

/**
 * @typedef {Object} PublishedBinding
 * @property {string} org            platform org（platform.tenant.casdoor_org）
 * @property {string} assetId        绑定资产 id（管理面/排障用）
 * @property {number} version        当前 active 且 published 的版本
 * @property {string} processCode    企微审批模板编号（template_id / process_code）
 * @property {string} name           绑定的人话名称（日志用）
 */

/**
 * @typedef {Object} TenantApprovalCreds
 * @property {string} org
 * @property {string|null} corpId
 * @property {string|null} agentId
 * @property {string|null} secret
 * @property {string|null} token
 * @property {string|null} aesKey
 */

/**
 * 镜像写入行（与 forms.external_approval 列一一对应；provider 固定 'wecom'）。
 * @typedef {Object} ExternalApprovalWrite
 * @property {string} org
 * @property {string} provider
 * @property {string} processCode
 * @property {string} providerRef
 * @property {string|null} title
 * @property {string|null} requester
 * @property {string} status      pending/approved/rejected/canceled（storage 层第二道白名单）
 * @property {Date|null} startedAt
 * @property {Date|null} finishedAt
 * @property {unknown} detail     可得的摘要；拿不到就 null（不假装有）
 */

/**
 * 数据面端口：生产实现走 pg（createPgStore），单测注入内存替身。
 * @typedef {Object} ReconcileStore
 * @property {() => Promise<PublishedBinding[]>} listPublishedBindings
 * @property {(orgs: string[]) => Promise<TenantApprovalCreds[]>} tenantCredentials
 * @property {(org: string, processCodes: string[], limit: number) => Promise<Array<{ providerRef: string, processCode: string }>>} listDetailMissing
 * @property {(row: ExternalApprovalWrite) => Promise<void>} upsertExternalApproval
 */

/**
 * @typedef {Object} RunOptions
 * @property {ReconcileStore} store
 * @property {typeof fetch} fetchImpl
 * @property {() => Date} [now]
 * @property {(line: string) => void} [log]
 * @property {number} [windowMinutes]
 * @property {number} [detailLimit]
 * @property {number} [maxPages]
 * @property {'auto'|'list'|'detail'} [mode]
 * @property {boolean} [dryRun]
 * @property {string} [baseUrl]
 */

/**
 * @typedef {Object} ReconcileStats
 * @property {number} bindings      已发布 wecom_native 绑定行数
 * @property {number} tenants       真正跑了 API 的租户数（已配齐凭据）
 * @property {number} synced        upsert 次数（含幂等重复写；行数看表）
 * @property {number} skipped       跳过的租户（配置缺失）+ 跳过的行（状态/模板无法映射）
 * @property {number} errors        失败计数（token/列表/详情/映射）
 * @property {number} detailFilled  降级通路里用 detail 补齐的行数
 * @property {string[]} configMissingOrgs
 * @property {string[]} listUnavailableOrgs
 * @property {string|null} discovery 'callback_only' = 本跑走的是「只补详情」降级
 */

/** @type {(v: unknown) => v is string} */
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0

/** @param {unknown} e @returns {string} */
function errText(e) {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 企微 sp_status → 镜像状态白名单。**只映射有确定语义的值**：
 * 1=审批中 2=已同意 3=已驳回 4=已撤销 6=通过后撤销（撤销族）。
 * 7=已删除 / 10=已支付 及未知值 ⇒ null（调用方记 `evt=unknown_status` 并跳过，
 * 不把「删除/支付」猜成通过或撤销 —— 拿不到确定语义就不写）。
 * @param {unknown} spStatus
 * @returns {'pending'|'approved'|'rejected'|'canceled'|null}
 */
export function mapSpStatus(spStatus) {
  if (typeof spStatus !== 'number') return null
  switch (spStatus) {
    case 1: return 'pending'
    case 2: return 'approved'
    case 3: return 'rejected'
    case 4: return 'canceled'
    case 6: return 'canceled'
    default: return null
  }
}

/** @param {unknown} v @returns {number|null} */
function unixSecondsToMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  const ms = v * 1000
  // 粗卫生检查：1970/2100 之外的值按「不可信」处理（企微返回秒；防有人塞毫秒）
  if (ms < Date.UTC(1970, 0, 2) || ms > Date.UTC(2100, 0, 1)) return null
  return ms
}

/**
 * 从 sp_record 里取最后一个审批动作时间（unix 秒）→ 终态行的 finished_at。
 * 拿不到就 null——不拿 apply_time 冒充办结时间。
 * @param {unknown} records
 * @returns {number|null}
 */
function lastApprovalMs(records) {
  let maxSec = null
  if (Array.isArray(records)) {
    for (const rec of records) {
      const details = rec !== null && typeof rec === 'object' && Array.isArray(rec.details) ? rec.details : []
      for (const d of details) {
        const t = d !== null && typeof d === 'object' ? d.sptime : undefined
        if (typeof t === 'number' && Number.isFinite(t) && t > 0 && (maxSec === null || t > maxSec)) maxSec = t
      }
    }
  }
  return maxSec === null ? null : unixSecondsToMs(maxSec)
}

/**
 * getapprovaldetail 的 info → 镜像写行。纯函数（单测直接喂真实形状样本）。
 * 只做**投影**：detail 里只放企微真实返回的字段，不补默认值、不编字段。
 * @param {string} org
 * @param {unknown} info
 * @returns {{ ok: true, row: ExternalApprovalWrite } | { ok: false, reason: 'detail_incomplete'|'unknown_status' }}
 */
export function detailToRow(org, info) {
  if (info === null || typeof info !== 'object') return { ok: false, reason: 'detail_incomplete' }
  const i = /** @type {Record<string, unknown>} */ (info)
  const rawRef = i['sp_no']
  const rawTemplate = i['template_id']
  const providerRef = nonEmpty(rawRef) ? rawRef : null
  const processCode = nonEmpty(rawTemplate) ? rawTemplate : null
  if (providerRef === null || processCode === null) return { ok: false, reason: 'detail_incomplete' }

  const status = mapSpStatus(i['sp_status'])
  if (status === null) return { ok: false, reason: 'unknown_status' }

  const rawApplyer = i['applyer']
  const applyer = rawApplyer !== null && typeof rawApplyer === 'object'
    ? /** @type {Record<string, unknown>} */ (rawApplyer)
    : null
  const rawUser = applyer === null ? undefined : applyer['userid']
  const requester = nonEmpty(rawUser) ? rawUser : null
  const rawTitle = i['sp_name']

  const startedMs = unixSecondsToMs(i['apply_time'])
  const finishedMs = status === 'pending' ? null : lastApprovalMs(i['sp_record'])

  /** @type {Record<string, unknown>} */
  const detail = {}
  for (const key of ['template_id', 'sp_name', 'sp_status', 'apply_time', 'applyer', 'apply_data', 'sp_record', 'notifyer', 'comments']) {
    if (i[key] !== undefined) detail[key] = i[key]
  }

  return {
    ok: true,
    row: {
      org,
      provider: 'wecom',
      processCode,
      providerRef,
      title: nonEmpty(rawTitle) ? rawTitle : null,
      requester,
      status,
      startedAt: startedMs === null ? null : new Date(startedMs),
      finishedAt: finishedMs === null ? null : new Date(finishedMs),
      detail,
    },
  }
}

/**
 * 单租户凭据完整性：五列缺任一 ⇒ 返回缺的列名（**不含值**）。
 * @param {TenantApprovalCreds | undefined} c
 * @returns {string[]}
 */
export function missingCredFields(c) {
  if (!c) return ['tenant_row']
  /** @type {string[]} */
  const missing = []
  if (!nonEmpty(c.corpId)) missing.push('corp_id')
  if (!nonEmpty(c.agentId)) missing.push('agent_id')
  if (!nonEmpty(c.secret)) missing.push('secret')
  if (!nonEmpty(c.token)) missing.push('token')
  if (!nonEmpty(c.aesKey)) missing.push('aes_key')
  return missing
}

/**
 * @param {TenantApprovalCreds} c
 * @returns {{ org: string, corpId: string, secret: string } | null}
 */
function completeCreds(c) {
  const { corpId, secret } = c
  if (!nonEmpty(corpId) || !nonEmpty(secret)) return null
  return { org: c.org, corpId, secret }
}

// ── 企微 API（失败只抛不含敏感值的错误；URL 里带 secret/token，绝不进日志） ──

/**
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, corpId: string, secret: string }} p
 * @returns {Promise<string>}
 */
async function getAccessToken({ fetchImpl, baseUrl, corpId, secret }) {
  const url = `${baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`gettoken HTTP ${res.status}`)
  const j = /** @type {any} */ (await res.json())
  if (j.errcode !== 0 || !nonEmpty(j.access_token)) {
    throw new Error(`gettoken errcode=${j.errcode} errmsg=${j.errmsg}`)
  }
  return j.access_token
}

/**
 * 列表端点（getapprovaldata）：只回 SpNo 列表，模板过滤靠详情。
 * 任何失败都返回 `{ok:false, reason}`（调用方决定 auto 降级 / list 模式报错）。
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, token: string, starttime: number, endtime: number, maxPages: number }} p
 * @returns {Promise<{ ok: true, spNos: string[] } | { ok: false, reason: string }>}
 */
async function listApprovalSpNos({ fetchImpl, baseUrl, token, starttime, endtime, maxPages }) {
  /** @type {string[]} */
  const spNos = []
  let cursor = ''
  for (let page = 0; page < maxPages; page += 1) {
    let res
    try {
      res = await fetchImpl(`${baseUrl}/cgi-bin/oa/getapprovaldata?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ starttime, endtime, cursor, size: LIST_PAGE_SIZE }),
      })
    } catch (e) {
      return { ok: false, reason: `network ${errText(e)}` }
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    /** @type {any} */
    let j
    try {
      j = await res.json()
    } catch (e) {
      return { ok: false, reason: `bad_json ${errText(e)}` }
    }
    if (j.errcode !== 0) return { ok: false, reason: `errcode=${j.errcode} errmsg=${j.errmsg}` }
    const list = Array.isArray(j.data?.sp_no_list) ? j.data.sp_no_list : []
    for (const sp of list) if (nonEmpty(sp)) spNos.push(sp)
    const next = j.data?.next_cursor
    // 空/0/未变化的 cursor = 没有下一页（防服务端回环导致死循环）
    if (next === undefined || next === null || next === '' || next === 0 || String(next) === cursor) break
    cursor = String(next)
  }
  return { ok: true, spNos }
}

/**
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, token: string, spNo: string }} p
 * @returns {Promise<unknown>} info
 */
async function getApprovalDetail({ fetchImpl, baseUrl, token, spNo }) {
  const res = await fetchImpl(`${baseUrl}/cgi-bin/oa/getapprovaldetail?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sp_no: spNo }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = /** @type {any} */ (await res.json())
  if (j.errcode !== 0 || j.info === null || typeof j.info !== 'object') {
    throw new Error(`errcode=${j.errcode} errmsg=${j.errmsg}`)
  }
  return j.info
}

// ── 主流程（端口注入 ⇒ 单测用内存 store + 假 fetch，不连库不连网） ──

/**
 * @param {RunOptions} options
 * @returns {Promise<{ exitCode: number, stats: ReconcileStats }>}
 */
export async function runReconcile(options) {
  const {
    store,
    fetchImpl,
    now = () => new Date(),
    log = (line) => console.error(line),
    windowMinutes = 120,
    detailLimit = 200,
    maxPages = 20,
    mode = 'auto',
    dryRun = false,
    baseUrl = WECOM_API_BASE,
  } = options

  /** @type {ReconcileStats} */
  const stats = {
    bindings: 0, tenants: 0, synced: 0, skipped: 0, errors: 0,
    detailFilled: 0, configMissingOrgs: [], listUnavailableOrgs: [], discovery: null,
  }
  let tokenFailures = 0

  const bindings = await store.listPublishedBindings()
  /** @type {Map<string, Map<string, PublishedBinding>>} */
  const byOrg = new Map()
  for (const b of bindings) {
    if (!nonEmpty(b.processCode)) {
      log(`evt=binding_invalid org=${b.org} asset=${b.assetId} reason=no_process_code`)
      continue
    }
    stats.bindings += 1
    let codes = byOrg.get(b.org)
    if (!codes) { codes = new Map(); byOrg.set(b.org, codes) }
    codes.set(b.processCode, b)
  }

  const orgs = [...byOrg.keys()]
  const credsRows = orgs.length === 0 ? [] : await store.tenantCredentials(orgs)
  /** @type {Map<string, TenantApprovalCreds>} */
  const credsByOrg = new Map(credsRows.map((c) => /** @type {[string, TenantApprovalCreds]} */ ([c.org, c])))

  const nowSec = Math.floor(now().getTime() / 1000)
  const window = Math.max(1, Math.min(windowMinutes, MAX_WINDOW_MINUTES))
  const starttime = nowSec - window * 60
  const endtime = nowSec

  for (const [org, codes] of byOrg) {
    const creds = credsByOrg.get(org)
    const missing = missingCredFields(creds)
    if (missing.length > 0) {
      stats.skipped += 1
      stats.configMissingOrgs.push(org)
      // 告警事实：只报缺哪几列，绝不输出值
      log(`evt=config_missing org=${org} missing=${missing.join(',')}`)
      continue
    }
    const complete = completeCreds(/** @type {TenantApprovalCreds} */ (creds))
    if (!complete) {
      // missingCredFields 已覆盖；这里只是给 TS 收窄（不可能走到）
      stats.skipped += 1
      stats.configMissingOrgs.push(org)
      log(`evt=config_missing org=${org} missing=unknown`)
      continue
    }

    stats.tenants += 1
    let token
    try {
      token = await getAccessToken({ fetchImpl, baseUrl, corpId: complete.corpId, secret: complete.secret })
    } catch (e) {
      tokenFailures += 1
      stats.errors += 1
      log(`evt=token_failed org=${org} ${errText(e)}`)
      continue
    }

    const processCodes = [...codes.keys()]
    let useDetailFallback = mode === 'detail'

    if (mode !== 'detail') {
      const listed = await listApprovalSpNos({ fetchImpl, baseUrl, token, starttime, endtime, maxPages })
      if (!listed.ok) {
        stats.errors += 1
        stats.listUnavailableOrgs.push(org)
        log(`evt=list_unavailable org=${org} reason=${listed.reason}`)
        // auto：降级为「只补回调已到但缺详情的行」；list：按失败收口（不冒充跑过列表）
        if (mode === 'list') continue
        useDetailFallback = true
      } else {
        let unknownTemplate = 0
        for (const spNo of listed.spNos) {
          let info
          try {
            info = await getApprovalDetail({ fetchImpl, baseUrl, token, spNo })
          } catch (e) {
            stats.errors += 1
            log(`evt=detail_failed org=${org} sp=${spNo} ${errText(e)}`)
            continue
          }
          const mapped = detailToRow(org, info)
          if (!mapped.ok) {
            stats.skipped += 1
            stats.errors += 1
            log(`evt=${mapped.reason} org=${org} sp=${spNo}`)
            continue
          }
          if (!codes.has(mapped.row.processCode)) {
            // 同一审批应用里还有别的模板：不是本租户绑定的单，计数但不写（也不静默）
            unknownTemplate += 1
            continue
          }
          stats.synced += 1
          if (!dryRun) await store.upsertExternalApproval(mapped.row)
        }
        if (unknownTemplate > 0) log(`evt=unknown_template org=${org} count=${unknownTemplate}`)
      }
    }

    if (useDetailFallback) {
      if (stats.discovery === null) stats.discovery = 'callback_only'
      // 显式记录降级事实（验收/排障按这个字面量检索）
      log(`discovery=callback_only org=${org} reason=list_unavailable`)
      const rows = await store.listDetailMissing(org, processCodes, detailLimit)
      for (const row of rows) {
        let info
        try {
          info = await getApprovalDetail({ fetchImpl, baseUrl, token, spNo: row.providerRef })
        } catch (e) {
          stats.errors += 1
          log(`evt=detail_failed org=${org} sp=${row.providerRef} ${errText(e)}`)
          continue
        }
        const mapped = detailToRow(org, info)
        if (!mapped.ok) {
          stats.skipped += 1
          stats.errors += 1
          log(`evt=${mapped.reason} org=${org} sp=${row.providerRef}`)
          continue
        }
        if (mapped.row.processCode !== row.processCode) {
          // 行上的 process_code 与企微详情不一致 ⇒ 不跨模板改写（交人看）
          stats.skipped += 1
          log(`evt=template_mismatch org=${org} sp=${row.providerRef} row=${row.processCode} api=${mapped.row.processCode}`)
          continue
        }
        stats.synced += 1
        stats.detailFilled += 1
        if (!dryRun) await store.upsertExternalApproval(mapped.row)
      }
    }
  }

  return { exitCode: tokenFailures > 0 ? 1 : 0, stats }
}

// ── 生产端口：pg（只读 SELECT + 与 storage 同语义的 upsert） ──

/**
 * @param {{ query: (text: string, values?: any[]) => Promise<{ rows: any[] }> }} pool
 * @returns {ReconcileStore}
 */
export function createPgStore(pool) {
  return {
    async listPublishedBindings() {
      const { rows } = await pool.query(
        `select v.org, v.asset_id, v.version, v.body
           from forms.asset_version v
           join forms.asset_head h
             on h.org = v.org and h.kind = v.kind and h.asset_id = v.asset_id
            and h.active_version = v.version
          where v.kind = 'approval_def'
            and v.status = 'published'
            and v.body->>'provider' = 'wecom_native'
          order by v.org, v.asset_id`,
      )
      /** @type {PublishedBinding[]} */
      const out = []
      for (const r of rows) {
        const body = /** @type {Record<string, unknown>} */ (
          r.body !== null && typeof r.body === 'object' ? r.body : {}
        )
        out.push({
          org: String(r.org),
          assetId: String(r.asset_id),
          version: Number(r.version),
          processCode: nonEmpty(body.processCode) ? body.processCode.trim() : '',
          name: nonEmpty(body.name) ? body.name.trim() : '',
        })
      }
      return out
    },

    async tenantCredentials(orgs) {
      if (orgs.length === 0) return []
      const { rows } = await pool.query(
        `select casdoor_org as org,
                wecom_approval_corp_id  as corp_id,
                wecom_approval_agent_id as agent_id,
                wecom_approval_secret   as secret,
                wecom_approval_token    as token,
                wecom_approval_aes_key  as aes_key
           from platform.tenant
          where casdoor_org = any($1::text[])`,
        [orgs],
      )
      return rows.map((r) => ({
        org: String(r.org),
        corpId: r.corp_id ?? null,
        agentId: r.agent_id ?? null,
        secret: r.secret ?? null,
        token: r.token ?? null,
        aesKey: r.aes_key ?? null,
      }))
    },

    async listDetailMissing(org, processCodes, limit) {
      if (processCodes.length === 0) return []
      const { rows } = await pool.query(
        `select provider_ref, process_code
           from forms.external_approval
          where org = $1
            and provider = 'wecom'
            and detail is null
            and process_code = any($2::text[])
          order by started_at desc nulls last, id desc
          limit $3`,
        [org, processCodes, limit],
      )
      return rows.map((r) => ({ providerRef: String(r.provider_ref), processCode: String(r.process_code) }))
    },

    async upsertExternalApproval(row) {
      await pool.query(
        `insert into forms.external_approval
           (org, provider, process_code, provider_ref, title, requester, status,
            started_at, finished_at, detail, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
         on conflict (org, provider, provider_ref) do update
           set process_code = excluded.process_code,
               title        = coalesce(excluded.title, forms.external_approval.title),
               requester    = coalesce(excluded.requester, forms.external_approval.requester),
               status       = excluded.status,
               started_at   = coalesce(excluded.started_at, forms.external_approval.started_at),
               finished_at  = coalesce(excluded.finished_at, forms.external_approval.finished_at),
               detail       = coalesce(excluded.detail, forms.external_approval.detail),
               synced_at    = now()`,
        [
          row.org, row.provider, row.processCode, row.providerRef,
          row.title, row.requester, row.status,
          row.startedAt, row.finishedAt,
          row.detail === undefined || row.detail === null ? null : JSON.stringify(row.detail),
        ],
      )
    },
  }
}

// ── CLI ──

/** @param {string[]} argv @param {string} name @param {number} fallback @returns {number} */
function argOf(argv, name, fallback) {
  const pref = `--${name}=`
  const hit = argv.find((a) => a.startsWith(pref))
  if (hit === undefined) return fallback
  const n = Number(hit.slice(pref.length))
  return Number.isFinite(n) ? n : fallback
}

/** @param {string[]} argv @returns {'auto'|'list'|'detail'} */
function modeOf(argv) {
  const pref = '--mode='
  const hit = argv.find((a) => a.startsWith(pref))
  const v = hit === undefined ? 'auto' : hit.slice(pref.length)
  return v === 'list' || v === 'detail' ? v : 'auto'
}

async function main() {
  const argv = process.argv.slice(2)
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[oa-standard-approval-reconcile] DATABASE_URL 未设置')
    process.exitCode = 2
    return
  }
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const store = createPgStore(pool)
    const result = await runReconcile({
      store,
      fetchImpl: fetch,
      mode: modeOf(argv),
      windowMinutes: argOf(argv, 'window-minutes', 120),
      detailLimit: argOf(argv, 'detail-limit', 200),
      maxPages: argOf(argv, 'max-pages', 20),
      dryRun: argv.includes('--dry-run'),
    })
    console.log(JSON.stringify(result.stats, null, 2))
    process.exitCode = result.exitCode
  } catch (e) {
    console.error('[oa-standard-approval-reconcile] fatal:', e)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// 只在直接执行时跑 main（被单测 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
