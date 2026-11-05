#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：纯核（mineOnce / classify）有同名 .test.ts 兜底；tsc 根工程解析不到
// pg 类型，不为此给根加依赖（backfill-identity-links.mjs / provision-tenant.mjs 同款头注）。
// demand-mining.mjs —— Phase 2 每日挖掘（openship job 经 docker exec 在 server 容器内跑）。
// 复用容器既有 env：DATABASE_URL + OO_READ_URL/OO_READ_ORG/OO_READ_TOKEN（无新凭据）。
// 退出码：0 = 成功（含 0 条）；1 = 环境/链路失败（缺 env、DB 不可达、OO 失败、翻页护栏）——不吞。
import { createRequire } from 'node:module'
import { mineOnce } from '../modules/data/domain/demand/mine.ts'
import { readCursor, upsertDemand, writeCursor } from '../modules/data/domain/demand/store.ts'
import { loadPlatformCatalog } from '../modules/data/domain/metric-store.ts'

const DAY_US = 86_400_000_000
/** OO `_search` 单页条数（同 verify-ingest）。 */
const PAGE_SIZE = 1000
/** 翻页护栏：超过即**抛错**（拒绝静默截断；也防 OO 忽略 `from` 时无限循环）。 */
const MAX_PAGES = 100

const need = (k) => {
  const v = String(process.env[k] ?? '').trim()
  if (v === '') throw new Error(`demand-mining: 缺 ${k}`)
  return v
}

const authHeader = (raw) => {
  const t = raw.trim()
  return /^(Basic|Bearer)\s/i.test(t) ? t : `Basic ${t}`
}

/**
 * 组织级 OO `_search`（流级 `_search` 在该版本 404）。返回**全部**命中（内部翻页）。
 *
 * - 时间参数是**微秒 epoch**；`start_time` 不能为 0（首轮用 7 天回看窗口兜底）。
 * - 排序字段按流区分：`askdata_verified` 的键形是 `sessionid`，但 `askdata_conv` /
 *   `askdata_stuck` 是 `session_id`（生产实测：写 `sessionid` ⇒ 400 unknown field）。
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
      if (batch.length < PAGE_SIZE) break
      if (typeof data.total === 'number' && from >= data.total) break
    }
    return hits
  }
}

async function main() {
  const org = need('PLATFORM_ORG')
  const dsn = need('DATABASE_URL')
  const oo = ooSearch({ url: need('OO_READ_URL'), org: need('OO_READ_ORG'), token: need('OO_READ_TOKEN') })
  // 不能用静态 `import pg from 'pg'`：scripts/ 在 pnpm 隔离 node_modules 下解析不到根级 pg
  // （tsx 的 CJS require 钩子能解析、ESM 静态 import 不能）。与 notify-health.mjs 同款取法。
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dsn })
  try {
    const endUs = Date.now() * 1000
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
      readConv: (_o, sinceUs) => oo('askdata_conv', sinceUs, endUs, { exclusive: true }),
      readStuck: async (_o, sessions) => {
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
      catalogIds: async (o) => (await loadPlatformCatalog(pool)).map((m) => m.id),
      upsert: (o, d) => upsertDemand(pool, o, d),
    }, org, endUs)
    console.log(
      `demand-mining: scanned=${summary.scanned} alias=${summary.alias} new_metric=${summary.newMetric} ` +
      `drill=${summary.drill} hunt=${summary.hunt} skipped_probe=${summary.skippedProbe} ` +
      `cursor_audit=${summary.cursorAudit} cursor_conv=${summary.cursorConv}`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(`demand-mining: FAIL ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1 })
