#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：纯核（mineOnce / classify）有同名 .test.ts 兜底；tsc 根工程解析不到
// pg 类型，不为此给根加依赖（backfill-identity-links.mjs / provision-tenant.mjs 同款头注）。
// demand-mining.mjs —— Phase 2 每日挖掘（openship job 经 docker exec 在 server 容器内跑）。
// 复用容器既有 env：DATABASE_URL + OO_READ_URL/OO_READ_ORG/OO_READ_TOKEN（无新凭据）。
// 退出码：0 = 成功（含 0 条）；1 = 环境/链路失败（缺 env、DB 不可达、OO 失败、翻页护栏）——不吞。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mineOnce } from '../modules/data/domain/demand/mine.ts'
import { readCursor, upsertDemand, writeCursor } from '../modules/data/domain/demand/store.ts'
import { loadPlatformCatalog } from '../modules/data/domain/metric-store.ts'

const DAY_US = 86_400_000_000
// 对话流：历史 `askdata_conv` 已停更（2026-10-16 起无写入），实际活的是 `askdata_trace`。
const CONV_STREAM = process.env.ASK_DEMAND_CONV_STREAM ?? 'askdata_trace'
/** OO `_search` 单页条数（同 verify-ingest）。 */
const PAGE_SIZE = 1000
/** 翻页护栏：超过即**抛错**（拒绝静默截断；也防 OO 忽略 `from` 时无限循环）。 */
const MAX_PAGES = 100

const need = (k) => {
  const v = String(process.env[k] ?? '').trim()
  if (v === '') throw new Error(`demand-mining: 缺 ${k}`)
  return v
}

/**
 * 参数面：`--org <org>` / `--all-tenants` 互斥；都不传 = PLATFORM_ORG（向后兼容）。
 * 打错参数不静默（未知键/缺值/空值全抛）。
 */
export function parseArgs(argv) {
  let org = null
  let allTenants = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--all-tenants') { allTenants = true; continue }
    if (arg === '--org') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error('--org 缺值')
      org = v
      i += 1
      continue
    }
    if (arg.startsWith('--org=')) { org = arg.slice('--org='.length); continue }
    if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`)
    throw new Error(`无法识别的参数: ${arg}`)
  }
  if (allTenants && org !== null) throw new Error('--org 与 --all-tenants 互斥')
  if (org !== null) {
    org = org.trim()
    if (org === '') throw new Error('--org 不能为空')
  }
  return { allTenants, org }
}

/**
 * 解析本轮要跑的 org 列表。`--all-tenants` 的空列表**不猜、不空跑成功**（退出 1）。
 */
export function resolveOrgs(args, { platformOrg, tenants }) {
  if (args.allTenants) {
    if (!Array.isArray(tenants) || tenants.length === 0) {
      throw new Error('--all-tenants：platform.tenant 无租户（拒绝空跑成功）')
    }
    return [...tenants]
  }
  if (args.org !== null) return [args.org]
  const p = String(platformOrg ?? '').trim()
  if (p === '') throw new Error('缺 PLATFORM_ORG（未传 --org 时的缺省租户）')
  return [p]
}

/**
 * 对话侧归因护栏：`askdata_trace` / `askdata_stuck` **没有租户字段**（2026-11-07 实测），
 * 只有部署恰好 1 个租户时才能把会话归到本 org。多租户 ⇒ 跳过（显式标记，不造假归属）。
 */
export function convMiningAllowed(tenantCount) {
  return tenantCount === 1
}

/**
 * 逐 org 串行跑，**失败隔离**：单 org 失败只记录，其余继续。
 * 返回顺序与入参一致（ok/failed 各自保持相对顺序）。
 */
export async function runPerOrg(orgs, run) {
  const ok = []
  const failed = []
  for (const org of orgs) {
    try {
      ok.push({ org, value: await run(org) })
    } catch (e) {
      failed.push({ org, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ok, failed }
}

const authHeader = (raw) => {
  const t = raw.trim()
  return /^(Basic|Bearer)\s/i.test(t) ? t : `Basic ${t}`
}

/**
 * 组织级 OO `_search`（流级 `_search` 在该版本 404）。返回**全部**命中（内部翻页）。
 *
 * - 时间参数是**微秒 epoch**；`start_time` 不能为 0（首轮用 7 天回看窗口兜底）。
 * - 排序字段按流区分：`askdata_verified` 的键形是 `sessionid`，但 `askdata_trace` /
 *   `askdata_stuck` 是 `session_id`（生产实测：写 `sessionid` ⇒ 400 unknown field）。
 * - **`askdata_conv` 是冻结流**（2026-10-16 后再无写入，566 行停更）；活的对话流是 `askdata_trace`
 *   （`export-transcript.py` 的默认 STREAM）。故 conv 侧默认读 trace，可用 `ASK_DEMAND_CONV_STREAM` 覆盖。
 * - `exclusive`：游标语义为「不含」（SQL 用 `>`）；首轮（cursor=0）仍用 `>=`。
 */
function ooSearch(opts) {
  const base = opts.url.replace(/\/+$/, '')
  return async (stream, sinceUs, endUs, { exclusive = false } = {}) => {
    const startTime = sinceUs > 0 ? sinceUs : endUs - 7 * DAY_US   // OO 拒绝 start_time=0
    const cmp = exclusive && sinceUs > 0 ? '>' : '>='
    const sql = `select * from "${stream}" where _timestamp ${cmp} ${Math.trunc(sinceUs)} `
      + 'order by _timestamp asc, seq asc, session_id asc'
    const hits = []
    let from = 0
    let pageNo = 0
    for (;;) {
      if (pageNo >= MAX_PAGES) {
        throw new Error(
          `demand-mining: ${stream} 翻页超过 ${MAX_PAGES} 页（${MAX_PAGES * PAGE_SIZE} 行）仍未读完——拒绝静默截断`,
        )
      }
      const res = await fetch(`${base}/api/${encodeURIComponent(opts.org)}/_search`, {
        method: 'POST',
        headers: { Authorization: authHeader(opts.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { sql, start_time: startTime, end_time: endUs, from, size: PAGE_SIZE },
        }),
      })
      if (!res.ok) throw new Error(`demand-mining: OO _search HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`)
      const data = await res.json()
      if (data === null || typeof data !== 'object' || !Array.isArray(data.hits)) {
        throw new Error('demand-mining: OO _search 响应缺 hits 数组（不静默当空结果）')
      }
      const batch = data.hits
      hits.push(...batch)
      from += batch.length
      pageNo += 1
      // `total` 权威，**不能**先看 `batch.length < PAGE_SIZE`：OO 可能把 `size` 限到小于
      // PAGE_SIZE，那样首页就退出、而 `total` 再大也不翻 ⇒ 静默丢数据。无 `total` 时才退回
      // 按本页条数判断（拿不到权威计数，至少不无限翻）。
      const done = typeof data.total === 'number' ? from >= data.total : batch.length < PAGE_SIZE
      if (done) break
    }
    return hits
  }
}

/** 部署内所有租户（`platform.tenant.casdoor_org`）。查询失败上抛——不能静默当 0 个租户。 */
async function listTenantOrgs(pool) {
  const { rows } = await pool.query('select casdoor_org from platform.tenant order by id')
  return rows.map((r) => String(r.casdoor_org ?? '').trim()).filter((s) => s !== '')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dsn = need('DATABASE_URL')
  // 不能用静态 `import pg from 'pg'`：scripts/ 在 pnpm 隔离 node_modules 下解析不到根级 pg
  // （tsx 的 CJS require 钩子能解析、ESM 静态 import 不能）。与 notify-health.mjs 同款取法。
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dsn })
  try {
    // 租户枚举：`--all-tenants` 失败即抛；单 org 模式失败按「多租户未知」处理（跳过对话侧）。
    let tenants = null
    try {
      tenants = await listTenantOrgs(pool)
    } catch (e) {
      if (args.allTenants) throw e
      console.error(`demand-mining: 租户枚举失败（${e instanceof Error ? e.message : e}）⇒ 按多租户处理，跳过对话侧`)
    }
    const orgs = resolveOrgs(args, { platformOrg: process.env.PLATFORM_ORG ?? '', tenants: tenants ?? [] })
    // conv 侧归因护栏：只有部署恰好 1 个租户时才挖（两个 OO 流没有租户字段）。
    const convAllowed = tenants !== null && convMiningAllowed(tenants.length)
    const oo = convAllowed
      ? ooSearch({ url: need('OO_READ_URL'), org: need('OO_READ_ORG'), token: need('OO_READ_TOKEN') })
      : null
    const endUs = Date.now() * 1000
    // L1 词表是平台共享的：整轮只加载一次（`mineOnce` 逐 org 调用，但内容相同）。
    let catalogPromise = null
    const catalogIds = async () => {
      if (catalogPromise === null) catalogPromise = loadPlatformCatalog(pool)
      return (await catalogPromise).map((m) => m.id)
    }

    const out = await runPerOrg(orgs, async (org) => {
      const summary = await mineOnce({
        readCursor: (o, s) => readCursor(pool, o, s),
        writeCursor: (o, s, v) => writeCursor(pool, o, s, v),
        // 水位由 `mineOnce` 从**本批返回的行**推导；这里**不**另报 maxId——读行带 limit，
        // 全表 max 会越过未读行（静默丢行）。
        readAudit: async (o, sinceId) => {
          const { rows } = await pool.query(
            `select id, metric_id, reason, params from data.query_audit
              where org = $1 and id > $2 and reason in ('metric_not_declared','no_detail_binding')
              order by id asc limit 1000`, [o, sinceId],
          )
          return rows
        },
        readConv: (_o, sinceUs) => {
          if (oo === null) throw new Error('对话侧不可用（多租户部署无归因字段）')
          return oo(CONV_STREAM, sinceUs, endUs, { exclusive: true })
        },
        readStuck: async (_o, sessions) => {
          if (oo === null) throw new Error('对话侧不可用（多租户部署无归因字段）')
          const want = new Set(sessions)
          if (want.size === 0) return new Map()
          // 全窗口翻页（不按 `session_id in (...)` 拼 SQL：会话 id 来自外部数据，不注入）。
          // 代价是每次扫 30 天；护栏在 ooSearch 里，超限抛错而不是静默截断。
          const hits = await oo('askdata_stuck', endUs - 30 * DAY_US, endUs)
          const byKey = new Map()   // (session,seq) → 版本号最大的一条
          for (const h of hits) {
            const sid = String(h.session_id ?? '')
            if (!want.has(sid)) continue
            const key = `${sid}#${h.seq}`
            const ver = Number(h.rule_ver ?? 0)
            if ((byKey.get(key)?.ruleVer ?? -1) >= ver) continue
            byKey.set(key, { rule: h.rule, seq: h.seq, ruleVer: ver, text: String(h.evidence ?? '').slice(0, 200) })
          }
          const bySession = new Map()
          for (const [key, ev] of byKey) {
            const sid = key.slice(0, key.lastIndexOf('#'))
            const arr = bySession.get(sid) ?? []
            arr.push(ev)
            bySession.set(sid, arr)
          }
          return bySession
        },
        catalogIds,
        upsert: (o, d) => upsertDemand(pool, o, d),
      }, org, endUs, { skipConv: !convAllowed })
      console.log(
        `demand-mining: org=${org} scanned=${summary.scanned} alias=${summary.alias} new_metric=${summary.newMetric} ` +
        `drill=${summary.drill} hunt=${summary.hunt} skipped_probe=${summary.skippedProbe} ` +
        `cursor_audit=${summary.cursorAudit} cursor_conv=${summary.cursorConv} ` +
        `conv=${summary.convSkipped === true ? 'skipped(multi-tenant)' : 'ok'}`,
      )
      return summary
    })

    for (const f of out.failed) console.error(`demand-mining: org=${f.org} FAIL ${f.error}`)
    if (out.failed.length > 0) {
      console.error(
        `demand-mining: orgs=${orgs.length} ok=${out.ok.length} failed=${out.failed.length} `
        + `failed_orgs=${out.failed.map((f) => f.org).join(',')}`,
      )
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`demand-mining: FAIL ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1 })
}
