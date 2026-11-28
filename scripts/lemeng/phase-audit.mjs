#!/usr/bin/env node
// phase-audit.mjs — **排班相位审计**（只读）：谁在写哪几天 × 谁在什么时候跑（#2960）。
//
// ── 它回答什么 ────────────────────────────────────────────────────────────────
// 这条线最贵的一类缺陷是「相位撞车」：读正在被重写的湖分区 ⇒ ETag 失败 / 读到半截 / 覆盖写腰斩
// （正典 §1.6 案例 20/22/37/40）。我们修它们的方式一直是**把某个 job 挪个时间**，
// 而「挪」没有留下推导，上游一变（采集窗口、lookback、超时）就全部失配。
//
// 本脚本不改任何东西，只把**现状**画出来：
//   · 写侧：console 排班（每账套一份 schedules.json）→ 触发时刻 + 它**会重写哪几天**
//   · 读侧：平台调度器 job → 触发时刻（读哪几天见各 job 的语义，由 registry/正典声明）
// 然后给出两类风险：
//   A. **时钟重叠**：两个 job 在同一分钟前后触发且都属于「重活」（同一台机、抢 pg/湖）
//   B. **可变面相交**：读侧 job 的读窗口与该源的可变窗口相交，且未声明用闭窗谓词
//
// ⚠️ 「会重写哪几天」不是从代码里推导的（引擎不声明），是本文件 **CLASSIFY** 的声明视图——
//    按管线名族归类，**新的写法要在这里登记**，否则会显示 unknown 而不是猜一个。
//
// ⚠️ **已知边界**：② 的拥挤度只看「每小时第几分」，**不看小时范围**——例如 tick 的 `*/10 9-23`
//    只在 9–23 点跑，而 08:50 的 windows.l1 与它在分钟上相同却不会真的撞。判定真实撞车要叠加小时窗，
//    那是下一步（本脚本先把「谁在写可变面」和「哪几分钟挤」摆出来，不做最终裁决）。
//
// 用法：node scripts/lemeng/phase-audit.mjs [--json] [--root <dir>]
// 退出码：0 恒（只读审计；风险条数见输出）

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHANGHAI_TZ } from '../lib/time-semantics.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 写侧可变窗口的**声明视图**（按管线名族）。
 * `days` 用相对今天的天数：0=今天，1=昨天…
 * ⚠️ 这只是「我们认为它是这样」，与代码无关；发现不符就改这里（并回写正典 §1.5.2）。
 */
export const CLASSIFY = [
  // ⚠️ 下面每条都在 2026-11-28 **逐个核对了管线定义**（sink key 的 bizday 模板 / 父管线 SQL 的
  // `unnest([...])`）。核之前凭印象写的 6 条里有 4 条是错的——**声明不准，门禁就是假的**。
  { match: /\.snapshot\.l0(\.|$)/, days: [2], why: '库存快照 L0：写 bizday=${date-2d}（T-2）' },
  { match: /\.snapshot\.catchup/, days: [3], why: '库存快照补采：写 bizday=${date-3d}（T-3）' },
  { match: /\.snapshot\.backfill/, days: [], why: '库存快照回填：写显式 BIZDAY（按需，非周期可变面）' },
  { match: /\.windows\.l1$/, days: [1, 2, 3], why: '窗口重采：父管线 `unnest([1,2,3])` ⇒ T-1..T-3' },
  { match: /\.close\.l1$/, days: [1], why: '日结：`now()-1 day` ⇒ T-1' },
  { match: /\.daily_sealed\.reconcile$/, days: [], why: '封版对账：src.minio 读 _DAILY → snk.postgres 写 PG 表，**不改湖分区**' },
  { match: /recon\.preagg/, days: [3], why: '对账父管线：写 T-3 源快照' },
  { match: /\.l0(\.|$)/, days: [0], why: 'L0 采集：写今天' },
  { match: /\.tick\.l1$/, days: [0], why: '10m 车道采集：写今天' },
  { match: /\.backfill/, days: [], why: '回填：历史（由队列决定，非周期可变面）' },
  { match: /\.compact/, days: [], why: '压缩：读封版月、写 _MONTH（不改原始分区）' },
  { match: /\.metric_profile/, days: [], why: '指标画像：周更快照，不改原始分区' },
]

/**
 * **读侧声明表**：平台 job → 它读哪几天 + 用什么手段避可变面。
 *
 * `days`：读的相对日集合（`null` = 全史）。`tz`：cron 的时区（平台 job 是 UTC）。
 * `guard`：`closed` = 已用闭窗谓词（只读到「已闭窗」的边界前）；`sealed` = 只读封版天/月文件。
 * ⚠️ 与 CLASSIFY 一样是**声明视图**：新增 job 必须在这里登记（或显式标 unknown）。
 */
export const READERS = [
  { key: 'data.dbt_tick', days: [0, 1], tz: 'UTC', guard: 'closed', why: 'tick 只建今天（+昨天尾窗），闭窗谓词挡当前小时' },
  { key: 'data.dbt_hourly_retail_derived', cron: '5 1-15 * * *', days: [0,1,2,3,4,5,6,7,8,9,10], tz: 'UTC', guard: 'closed', why: 'key 由 hourlyLaneJob 生成（源码里不是字面量）⇒ cron 在这里显式声明' },
  { key: 'data.dbt_tables', days: null, tz: 'UTC', guard: 'closed', why: '全史 CTAS；读湖但走闭窗谓词' },
  { key: 'data.dbt_tables_recon', days: null, tz: 'UTC', guard: null, why: '全史；**无闭窗谓词**（读源快照 + 构件）' },
  { key: 'data.dbt_audit_a1', days: [3,4,5,6,7,8,9,10], tz: 'UTC', guard: null, why: '审计上界 T-3（audit_until_date），不读 T-1/T-2' },
  { key: 'data.dbt_audit_window', days: [3,4,5,6,7,8,9,10], tz: 'UTC', guard: null },
  { key: 'data.recon_restate', days: [3,4,5,6,7,8,9], tz: 'UTC', guard: null },
  { key: 'data.lake_compact_index', days: [], tz: 'UTC', guard: 'sealed', why: '只读封版月文件与原始月内文件' },
  { key: 'data.backfill_slice', days: [], tz: 'UTC', guard: null, why: '读历史（队列决定），与今日可变面无关' },
]

/**
 * 把一条管线名归类成「会重写哪几天」。
 * @param {string} id 管线 id
 * @returns {{days: number[], why: string}}
 */
export function classify(id) {
  for (const c of CLASSIFY) if (c.match.test(id)) return { days: c.days, why: c.why }
  return { days: [], why: 'unknown（未登记：请在 CLASSIFY 里声明，别猜）' }
}

/** cron 的分钟字段 → 「每小时第几分」列表；支持星号步长 / 区间步长 / 逗号列表。 @param {string} cron @returns {number[]} */
export function minutesOf(cron) {
  const f = String(cron ?? '').trim().split(/\s+/)[0] ?? ''
  if (!f || f === '*') return Array.from({ length: 60 }, (_, i) => i)
  /** @type {Set<number>} */
  const out = new Set()
  for (const part of f.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) continue
    const step = Number(m[2] ?? 1)
    let lo = 0
    let hi = 59
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number)
      lo = a
      hi = b ?? a
    }
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * cron（含小时字段）→ 「HH:MM」集合，按给定时区解释。
 * 平台 job 的 cron 是 UTC，console 是上海时区 —— 必须先换算再比，否则差 8 小时。
 * @param {string} cron @param {string} tz @returns {Set<string>}
 */
export function minutesOfDay(cron, tz) {
  const [mm, hh] = String(cron ?? '').trim().split(/\s+/)
  const ms = minutesOf(mm)
  const hs = hourSet(hh)
  /** @type {Set<string>} */
  const out = new Set()
  for (const h of hs) for (const m of ms) out.add(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  if (tz === 'UTC') {
    /** @type {Set<string>} */
    const cst = new Set()
    for (const k of out) {
      const [h, m] = k.split(':').map(Number)
      cst.add(`${String((h + 8) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
    return cst
  }
  return out
}

/** cron 小时字段 → 小时集合。 @param {string} f @returns {number[]} */
function hourSet(f) {
  if (!f || f === '*') return Array.from({ length: 24 }, (_, i) => i)
  /** @type {Set<number>} */
  const out = new Set()
  for (const part of String(f).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) continue
    const step = Number(m[2] ?? 1)
    let lo = 0
    let hi = 23
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number)
      lo = a
      hi = b ?? a
    }
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return [...out]
}

/** @param {number[]} a @param {number[]} b @param {number} tol 相差 ≤tol 分钟算重叠 @returns {boolean} */
export function overlapsInClock(a, b, tol = 2) {
  for (const x of a) for (const y of b) if (Math.abs(x - y) <= tol) return true
  return false
}

/** @param {string} root @returns {Array<{book:string,id:string,cron:string,days:number[],why:string}>} */
export function readWriteSide(root) {
  const dir = join(root, 'deploy/duckle/console/schedules')
  if (!existsSync(dir)) return []
  /** @type {any[]} */
  const out = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const book = f.replace(/\.json$/, '')
    /** @type {any} */
    let list = []
    try { list = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    for (const s of Array.isArray(list) ? list : []) {
      const cron = s?.kind?.expr ?? ''
      if (!cron || s?.enabled === false) continue
      const id = String(s?.pipeline_id ?? s?.id ?? '')
      const { days, why } = classify(id)
      out.push({ book, id, cron, days, why })
    }
  }
  return out
}

/** 从 registry 源码里取某 key 的 cron（只读；避免本脚本依赖数据库）。 @param {string} key @returns {{cron:string}|null} */
export function scheduleOf(key) {
  const f = join(ROOT, 'apps/server/src/scheduler/registry.ts')
  if (!existsSync(f)) return null
  const src = readFileSync(f, 'utf8')
  const re = new RegExp(`key: '${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]{0,3000}?cron: '([^']+)'`)
  const m = re.exec(src)
  return m ? { cron: m[1] } : null
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const check = args.includes('--check')
  const rootArg = args.indexOf('--root')
  const root = rootArg > -1 ? args[rootArg + 1] : ROOT
  const writers = readWriteSide(root)

  // ① 可变面清单：谁在重写 T-1/T-2（这是子弹本身）
  const mutables = writers.filter((w) => w.days.some((d) => d >= 1))

  // ② 每分钟拥挤度：按 CST 分钟统计「同一分钟会重写数据」的管线数（跨账套合并看，
  //    因为两个 console 跑在同一台机上，抢的是同一份 CPU/pg/湖带宽）
  /** @type {Map<number, string[]>} */
  const byMinute = new Map()
  for (const w of writers) {
    if (w.days.length === 0) continue
    for (const m of minutesOf(w.cron)) {
      const arr = byMinute.get(m) ?? []
      arr.push(`${w.book}:${w.id}`)
      byMinute.set(m, arr)
    }
  }
  const crowded = [...byMinute.entries()]
    .filter(([, v]) => v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12)

  const unknown = writers.filter((w) => w.why.startsWith('unknown'))

  // ③ 读侧求交：读窗口 × 可变面 × 时钟重叠，且读侧没有声明 mitigation
  /** @type {any[]} */
  const conflicts = []
  for (const r of READERS) {
    const sched = r.cron ? { cron: r.cron } : scheduleOf(r.key)
    if (!sched) continue
    const rMinutes = minutesOfDay(sched.cron, r.tz ?? 'UTC')
    const rDays = r.days
    for (const w of mutables) {
      const shareDay = rDays === null || w.days.some((d) => rDays.includes(d))
      if (!shareDay) continue
      const wMinutes = minutesOfDay(w.cron, SHANGHAI_TZ)
      const clockHit = [...rMinutes].some((k) => wMinutes.has(k))
      if (!clockHit) continue
      if (r.guard === 'closed' || r.guard === 'sealed') continue
      conflicts.push({ reader: r.key, readerCron: sched.cron, writer: `${w.book}/${w.id}`, writerCron: w.cron, days: w.days })
    }
  }

  if (json) {
    console.log(JSON.stringify({
      writers: writers.length,
      unknown: unknown.map((u) => `${u.book}/${u.id}`),
      mutableFaces: mutables.map((w) => ({ book: w.book, id: w.id, cron: w.cron, days: w.days })),
      crowdedMinutes: crowded.map(([m, v]) => ({ minute: m, n: v.length, who: v })),
      conflicts,
    }, null, 2))
    if (check && conflicts.length > 0) process.exit(1)
    return
  }
  console.log(`PHASE_AUDIT writers=${writers.length} unknown=${unknown.length} mutable_faces=${mutables.length} crowded_minutes=${crowded.length}`)
  const byDays = writers.reduce((/** @type {Record<string, number>} */ m, w) => {
    const k = w.days.length === 0 ? '不改可变面' : `重写 T-${w.days.join('/T-')}`
    m[k] = (m[k] ?? 0) + 1
    return m
  }, {})
  for (const [k, v] of Object.entries(byDays).sort()) console.log(`  可变面 ${k}: ${v} 条`)
  for (const u of unknown) console.log(`  ⚠️ UNKNOWN ${u.book}/${u.id}（${u.cron}）——请在 CLASSIFY 登记`)
  console.log('  ── ① 重写 T-1/T-2 的写者（子弹）')
  for (const w of mutables) console.log(`   ${String(w.days.map((d) => 'T-' + d)).padEnd(14)} ${w.book}/${w.id}（${w.cron}）`)
  console.log('  ── ② 最拥挤的 CST 分钟（≥3 条会重写数据同时触发）')
  for (const [m, v] of crowded) console.log(`   第 ${String(m).padStart(2)} 分: ${v.length} 条 — ${v.slice(0, 4).join(' / ')}${v.length > 4 ? ' …' : ''}`)
  console.log(`  ── ③ 读侧求交：无 mitigation 的冲突 ${conflicts.length} 组`)
  for (const c of conflicts) console.log(`   ${c.reader}（${c.readerCron}）↔ ${c.writer}（${c.writerCron}，重写 T-${c.days.join('/T-')}）`)
  if (check) {
    // CI 门禁：非 0 即红。⚠️ 判据是「读侧**没有声明避让手段**却与可变面相交」——
    // 有 mitigation（闭窗谓词 / 只读封版 / 上界 T-3）的不算冲突，那是**声明过的**设计。
    if (conflicts.length > 0) {
      console.error(`PHASE_AUDIT_FAIL conflicts=${conflicts.length}（读侧缺避让手段；见上表：要么加闭窗谓词/上界，要么挪相位并在此声明）`)
      process.exit(1)
    }
    console.log('PHASE_AUDIT_CHECK_OK conflicts=0')
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
