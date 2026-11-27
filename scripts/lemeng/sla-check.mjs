// scripts/lemeng/sla-check.mjs — 数据新鲜度 SLA 的**只读**测量器（路线图 2026-11-24 D1/D2）。
//
// 只做三件事：读 `scripts/lemeng/sla.json` → 取三个时钟（source / built / now）→ 打印 JSON 报告。
// **不写库、不发探针、不退出非零**——D4 才把判红接到 OO 告警；先观测 2–3 天校准阈值。
//
// 两个时钟（设计见路线图 §4 D1）：
//   · source_at：10m = `staging.retail_hot` 的 max(run_token)（数据真正进热层的时刻）；
//                1h = 域内各源 console 的 last_ok 取 **min**（木桶）；
//   · built_at： `platform.job_run` 里该 job 最近一次 status='ok' 的 finished_at（执行钟）。
//
// 用法：node scripts/lemeng/sla-check.mjs [--json] [--now <iso>] [--root <dir>]
// 环境：DATABASE_URL（平台库）、DATA_WAREHOUSE_URL（pg_duckdb）、SLA_WORKSPACES（默认两卷路径）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SHANGHAI_TZ } from '../lib/time-semantics.mjs'
import { emitProbe } from '../probe-emit.mjs'

export const SCRIPT_NAME = 'sla-check'
export const CONFIG_REL = 'scripts/lemeng/sla.json'
export const DEFAULT_WORKSPACES = ['/data/ws3120', '/data/ws64188']

/**
 * `pg` 只在 workspace 包里（apps/server / modules/data），根 `/app/node_modules` 没有（pnpm 布局）。
 * 从 `scripts/lemeng/` 直接 `createRequire(...)('pg')` 会 MODULE_NOT_FOUND；按顺序回退到包内解析。
 * @param {string} root 仓根（容器里 /app）
 * @returns {any}
 */
function loadPg(root) {
  const bases = [
    import.meta.url,
    pathToFileURL(join(root, 'apps/server/package.json')).href,
    pathToFileURL(join(root, 'modules/data/package.json')).href,
  ]
  for (const base of bases) {
    try {
      return createRequire(base)('pg')
    } catch {
      // 试下一个
    }
  }
  throw new Error('找不到 pg 模块（试过 scripts/、apps/server、modules/data）')
}

/** `YYYY-MM-DD_HHMMSS`（duckle `${datetime}`，UTC）→ Date；非法 → null。 @param {any} token @returns {Date|null} */
export function parseRunToken(token) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(String(token ?? ''))
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** console `last_run_at` 解析：裸 `YYYY-MM-DD HH:mm:ss` 按 CST（+08:00）补；ISO 带时区直接解析。 @param {any} raw @returns {Date|null} */
export function parseConsoleTime(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  // ⚠️ **裸形态必须先判**：`Date.parse('2026-11-25 10:30:00')` 会按**进程时区**解释
  // （CI 是 UTC ⇒ 10:30Z；本机 CST ⇒ 02:30Z）——不先判就会「本机绿 / CI 红」。
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s)
  if (naive) {
    const d = new Date(`${naive[1]}T${naive[2]}+08:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const direct = Date.parse(s)
  return Number.isNaN(direct) ? null : new Date(direct)
}

/** 上海墙钟的「当天第几分钟」。 @param {Date} d @returns {number} */
export function cstMinuteOfDay(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return h * 60 + m
}

/** `"HH:MM"` → 当天第几分钟。 @param {any} s @returns {number} */
function hhmm(s) {
  const [h, m] = String(s).split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

/**
 * 窗口内已过的分钟数（CST；跨零点窗口安全）。窗口外返回 null。
 * 用于**窗口起步宽限**：窗口刚开时「最后一次 ok build」必然是昨天的，直接判 age 必然假红。
 * @param {Date} now
 * @param {{start: string, end: string} | 'all'} window
 * @returns {number|null}
 */
export function minutesIntoWindow(now, window) {
  if (!window || window === 'all') return null
  if (!inWindow(now, window)) return null
  const start = hhmm(window.start)
  return (((cstMinuteOfDay(now) - start) % 1440) + 1440) % 1440
}

/** 活跃窗口（CST）；window 为 'all' 或缺省 ⇒ 恒 true；支持跨零点（start > end）。 @param {Date} now @param {any} window @returns {boolean} */
export function inWindow(now, window) {
  if (!window || window === 'all') return true
  const start = hhmm(window.start)
  const end = hhmm(window.end)
  const n = cstMinuteOfDay(now)
  return start <= end ? (n >= start && n <= end) : (n >= start || n <= end)
}

/**
 * @typedef {{
 *   now: Date,
 *   jobs: Map<string, Date|null>,
 *   hotRunTokens: string[],
 *   consoleLastOk: Map<string, Date|null>
 * }} Clocks
 *
 * @typedef {{
 *   product: string, job: string, windowActive: boolean,
 *   sourceAt: string|null, builtAt: string|null,
 *   lagSourceToBuildMs: number|null, buildAgeMs: number|null,
 *   verdict: 'OK'|'WARN'|'ERR'|'UNKNOWN'|'SKIP', detail: string
 * }} SlaRow
 */

/**
 * 单行判据；纯函数（测试注入 clocks，不碰库）。
 * @param {Date} now
 * @param {string} job
 * @param {Date|null} built
 * @param {Date|null} source
 * @param {boolean} windowActive
 * @param {any} sla
 * @returns {{ windowActive: boolean, sourceAt: string|null, builtAt: string|null, lagSourceToBuildMs: number|null, buildAgeMs: number|null, verdict: 'OK'|'WARN'|'ERR'|'UNKNOWN'|'SKIP', detail: string }}
 */
function judge(now, job, built, source, windowActive, sla, elapsedInWindowMin = /** @type {number|null} */ (null)) {
  const builtIso = built ? built.toISOString() : null
  const sourceIso = source ? source.toISOString() : null
  if (!windowActive) {
    return { windowActive, sourceAt: sourceIso, builtAt: builtIso, lagSourceToBuildMs: null, buildAgeMs: null, verdict: 'SKIP', detail: '窗口外' }
  }
  // 窗口起步宽限（2026-11-26）：窗口刚开的 N 分钟内不判——此时"最后一次 ok build"必然是昨天的，
  // 判 age 必然假红（实测 09:00 那批 80 条 ERR 全来自此）。源↔建判据仍然生效（它不看绝对 age）。
  const grace = Number(sla?.windowGraceMinutes ?? 0)
  if (grace > 0 && elapsedInWindowMin !== null && elapsedInWindowMin < grace) {
    return { windowActive, sourceAt: sourceIso, builtAt: builtIso, lagSourceToBuildMs: null, buildAgeMs: null,
      verdict: 'SKIP', detail: `窗口起步宽限（已过 ${elapsedInWindowMin}m < ${grace}m，不判 age）` }
  }
  if (!built) {
    return { windowActive, sourceAt: sourceIso, builtAt: null, lagSourceToBuildMs: null, buildAgeMs: null, verdict: 'ERR', detail: '窗口内无 ok 运行' }
  }
  const ageMs = now.getTime() - built.getTime()
  const lagMs = source ? built.getTime() - source.getTime() : null
  const miss = Number(sla.missingOkMinutes ?? 0) * 60_000
  const interval = Number(sla.buildIntervalMinutes ?? 0) * 60_000
  const stb = Number(sla.sourceToBuildMinutes ?? 0) * 60_000
  /** @type {'OK'|'WARN'|'ERR'|'UNKNOWN'|'SKIP'} */
  let verdict = 'OK'
  const notes = []
  if (miss > 0 && ageMs > miss) { verdict = 'ERR'; notes.push(`build age ${Math.round(ageMs / 60000)}m > ${sla.missingOkMinutes}m`) }
  else if (interval > 0 && ageMs > interval) { verdict = 'WARN'; notes.push(`build age ${Math.round(ageMs / 60000)}m > ${sla.buildIntervalMinutes}m`) }
  // 判据按**方向**拆开（2026-11-27，#2899）——旧实现用 |built − source|，两个方向被混为一谈：
  //   · `source > built`（lag<0，源有新数据而建没跟上）**超过阈值** ⇒ **建落后**，ERR；
  //   · `built ≥ source`（lag≥0，建已跑到源前面）⇒ **源侧没有新数据可建，不是延迟**。
  //     夜里门店停止下单后 `retail_hot.run_token` 冻结，而 tick 仍每 10 分钟重建 ⇒ |lag| 会从
  //     12 分钟机械涨到 60+ 分钟，两天造出 101 条假红（占全部 ERR 的 84%，实测）。
  //
  // ⚠️ 已知边界：**源自己断了**（白天也不来数）本判据看不出来——它只回答「源有数时建跟上了没有」。
  //    源断供由采集面负责（`platform.verify_ingest` / 断言 `fresh` / `data.monitor` 的 missing·stale），
  //    不要在这里用「建全新鲜但源很旧」去猜断供：那与「夜里正常无单」同形，猜必假红。
  if (lagMs !== null && stb > 0 && -lagMs > stb) {
    verdict = 'ERR'
    notes.push(`建落后源 ${Math.round(-lagMs / 60000)}m > ${sla.sourceToBuildMinutes}m`)
  } else if (lagMs !== null && lagMs < 0) {
    // 源领先但未超阈值：1h 的源 10 分钟一更、build 1 小时一次 ⇒ 这是**节拍**，不是违规。
    notes.push(`源领先建 ${Math.round(-lagMs / 60000)}m（阈值内）`)
  } else if (lagMs !== null && lagMs > 0) {
    notes.push(`源无新数据（建已跟上，源闲置 ${Math.round(lagMs / 60000)}m）`)
  }
  if (lagMs === null && verdict === 'OK') { verdict = 'UNKNOWN'; notes.push('source clock missing') }
  return {
    windowActive, sourceAt: sourceIso, builtAt: builtIso, lagSourceToBuildMs: lagMs, buildAgeMs: ageMs,
    verdict, detail: notes.join('; ') || 'ok',
  }
}

/**
 * @param {any} config sla.json
 * @param {Clocks} clocks
 * @returns {{ generatedAt: string, products: SlaRow[] }}
 */
export function computeReport(config, clocks) {
  const { now, jobs, hotRunTokens, consoleLastOk } = clocks
  /** @type {SlaRow[]} */
  const rows = []
  const products = config?.products ?? {}

  const ten = products.retail_10m
  if (ten) {
    const built = jobs.get(ten.job) ?? null
    const tokens = /** @type {Date[]} */ ((hotRunTokens ?? []).map(parseRunToken).filter(Boolean))
    const source = tokens.length ? new Date(Math.min(...tokens.map((d) => d.getTime()))) : null
    rows.push({ product: 'retail_10m', job: ten.job, ...judge(now, ten.job, built, source, inWindow(now, ten.window), ten.sla ?? {}, minutesIntoWindow(now, ten.window)) })
  }

  const oneHour = products.nonretail_1h
  if (oneHour) {
    for (const [domain, dRaw] of Object.entries(oneHour.domains ?? {})) {
      const d = /** @type {any} */ (dRaw ?? {})
      const built = jobs.get(d.job) ?? null
      const sources = Array.isArray(d.sources) ? d.sources : []
      const times = sources.map((/** @type {string} */ s) => consoleLastOk.get(s) ?? null)
      // 木桶：任何一个源缺 last_ok 就算「源钟不完整」（不拿部分值冒充）。
      const source = times.length > 0 && times.every(Boolean)
        ? new Date(Math.min(...times.map((/** @type {Date} */ t) => t.getTime())))
        : null
      rows.push({ product: `nonretail_1h.${domain}`, job: d.job, ...judge(now, d.job, built, source, inWindow(now, oneHour.window), oneHour.sla ?? {}, minutesIntoWindow(now, oneHour.window)) })
    }
  }

  // 日档产品（daily = 夜间 tables；daily_report = 两个日粒度增量 mart）——同一判据（age）。
  for (const key of ['daily', 'daily_report']) {
    const d = products[key]
    if (!d) continue
    const built = jobs.get(d.job) ?? null
    const maxAge = Number(d.sla?.maxAgeMinutes ?? 0) * 60_000
    const age = built ? now.getTime() - built.getTime() : null
    const verdict = !built ? 'ERR' : (maxAge > 0 && (age ?? 0) > maxAge ? 'ERR' : 'OK')
    rows.push({
      product: key, job: d.job, windowActive: true,
      sourceAt: null, builtAt: built ? built.toISOString() : null,
      lagSourceToBuildMs: null, buildAgeMs: age, verdict,
      detail: verdict === 'OK' ? 'ok' : (built ? `age ${Math.round((age ?? 0) / 60000)}m > ${d.sla?.maxAgeMinutes}m` : '无 ok 运行'),
    })
  }
  return { generatedAt: now.toISOString(), products: rows }
}

/**
 * D4：从报告里挑出要投 OO 的行——**只有 ERR**。
 * 单独抽成纯函数是为了机检「WARN/SKIP/OK 不会进告警」（否则一次窗口起步宽限就能刷出一屏）。
 * @param {any} report
 * @returns {SlaRow[]}
 */
export function errRows(report) {
  const rows = /** @type {SlaRow[]} */ (Array.isArray(report?.products) ? report.products : [])
  return rows.filter((/** @type {SlaRow} */ r) => r && r.verdict === 'ERR')
}

const MEASURE_DDL = `create schema if not exists data;
create table if not exists data.sla_measure (
  measured_at timestamptz default now(),
  product text not null,
  job text not null,
  window_active boolean not null,
  source_at timestamptz,
  built_at timestamptz,
  lag_source_to_build_ms bigint,
  build_age_ms bigint,
  verdict text not null,
  detail text
);`

/** D3：幂等建测量表（观测模式；D4 才接告警）。 @param {any} pool @returns {Promise<void>} */
export async function ensureMeasureTable(pool) {
  await pool.query(MEASURE_DDL)
}

/** D3：把一次报告写进 `data.sla_measure`。 @param {any} pool @param {any} report @returns {Promise<void>} */
export async function insertMeasures(pool, report) {
  const rows = Array.isArray(report?.products) ? report.products : []
  if (rows.length === 0) return
  /** @type {string[]} */
  const values = []
  /** @type {any[]} */
  const params = []
  rows.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    const b = i * 9
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`)
    params.push(r.product, r.job, r.windowActive, r.sourceAt, r.builtAt, r.lagSourceToBuildMs, r.buildAgeMs, r.verdict, r.detail)
  })
  await pool.query(
    `insert into data.sla_measure
       (product, job, window_active, source_at, built_at, lag_source_to_build_ms, build_age_ms, verdict, detail)
     values ${values.join(',')}`,
    params,
  )
}

/** 从两个 console 工作区读 `schedules.json`，返回 scheduleId → last_ok（Date|null），跨卷取 min。 */
export function readConsoleLastOk(dirs = DEFAULT_WORKSPACES) {
  /** @type {Map<string, Date|null>} */
  const perWorkspace = new Map()
  for (const dir of dirs) {
    const file = join(dir, 'schedules.json')
    if (!existsSync(file)) continue
    let list
    try {
      list = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const s of Array.isArray(list) ? list : []) {
      const id = String(s?.id ?? '')
      if (!id) continue
      const ok = String(s?.last_run_status ?? '') === 'ok' ? parseConsoleTime(s?.last_run_at) : null
      const prev = perWorkspace.get(id)
      if (!perWorkspace.has(id)) perWorkspace.set(id, ok)
      else if (ok && prev) { if (ok.getTime() < prev.getTime()) perWorkspace.set(id, ok) }
      else if (ok && !prev) perWorkspace.set(id, ok)
    }
  }
  return perWorkspace
}

/** CLI：只读测量并打印 JSON；退出码恒 0（D4 才接告警）。 */
async function main() {
  const args = process.argv.slice(2)
  /** @param {string} name */
  const get = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const root = get('--root') ?? fileURLToPath(new URL('../..', import.meta.url))
  const nowIso = get('--now')
  const now = nowIso ? new Date(nowIso) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error(`--now 非法：${nowIso}`)
  const config = JSON.parse(readFileSync(join(root, CONFIG_REL), 'utf8'))

  const { Pool } = loadPg(root)
  const platformUrl = process.env.DATABASE_URL
  const warehouseUrl = process.env.DATA_WAREHOUSE_URL
  if (!platformUrl) throw new Error('缺 DATABASE_URL')
  if (!warehouseUrl) throw new Error('缺 DATA_WAREHOUSE_URL')

  const jobKeys = []
  for (const p of Object.values(config.products ?? {})) {
    if (p.job) jobKeys.push(p.job)
    for (const d of Object.values(p.domains ?? {})) if (d.job) jobKeys.push(d.job)
  }

  const platform = new Pool({ connectionString: platformUrl })
  const warehouse = new Pool({ connectionString: warehouseUrl })
  try {
    /** @type {Map<string, Date|null>} */
    const jobs = new Map()
    for (const key of [...new Set(jobKeys)]) {
      const { rows } = await platform.query(
        "select finished_at from platform.job_run where key=$1 and status='ok' order by id desc limit 1",
        [key],
      )
      jobs.set(key, rows[0]?.finished_at ? new Date(rows[0].finished_at) : null)
    }
    const hot = await warehouse.query('select system_book, max(run_token) as token from staging.retail_hot group by 1')
    const hotRunTokens = hot.rows.map((/** @type {any} */ r) => r.token).filter(Boolean)
    const wsDirs = (process.env.SLA_WORKSPACES ?? DEFAULT_WORKSPACES.join(','))
      .split(',').map((s) => s.trim()).filter(Boolean)
    const consoleLastOk = readConsoleLastOk(wsDirs)

    const report = computeReport(config, { now, jobs, hotRunTokens, consoleLastOk })
    // D3：测量表照写；D4 起**只有 ERR 行**进 OO 探针（`sla`），桥转发企微。
    // 只投事实、不改判定、不改退出码（probe-emit 的红线）；缺 OO 三元组时 emitProbe 自己跳过。
    await ensureMeasureTable(warehouse)
    await insertMeasures(warehouse, report)
    for (const row of errRows(report)) {
      await emitProbe({
        probe: 'sla',
        check: row.product,
        verdict: 'ERR',
        detail: `${row.job}: ${row.detail}`.slice(0, 400),
        mode: 'hard',
      })
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await platform.end().catch(() => {})
    await warehouse.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
