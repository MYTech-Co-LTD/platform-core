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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 写侧可变窗口的**声明视图**（按管线名族）。
 * `days` 用相对今天的天数：0=今天，1=昨天…
 * ⚠️ 这只是「我们认为它是这样」，与代码无关；发现不符就改这里（并回写正典 §1.5.2）。
 */
export const CLASSIFY = [
  { match: /\.snapshot(\.|$)/, days: [0, 1, 2], why: '库存快照类：每小时重采 T-0..T-2' },
  { match: /\.windows\.l1$/, days: [1, 2], why: '窗口重采：整天重写 T-1..T-2' },
  { match: /\.close\.l1$/, days: [1], why: '日结：重写 T-1' },
  { match: /\.daily_sealed\.reconcile$/, days: [1], why: '封版对账：重写 T-1' },
  { match: /recon\.preagg/, days: [3], why: '对账父管线：写 T-3 源快照' },
  { match: /\.l0(\.|$)/, days: [0], why: 'L0 采集：写今天' },
  { match: /\.tick\.l1$/, days: [0], why: '10m 车道采集：写今天' },
  { match: /\.backfill/, days: [], why: '回填：历史（由队列决定，非周期可变面）' },
  { match: /\.compact/, days: [], why: '压缩：读封版月、写 _MONTH（不改原始分区）' },
  { match: /\.metric_profile/, days: [], why: '指标画像：周更快照，不改原始分区' },
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

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
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

  if (json) {
    console.log(JSON.stringify({
      writers: writers.length,
      unknown: unknown.map((u) => `${u.book}/${u.id}`),
      mutableFaces: mutables.map((w) => ({ book: w.book, id: w.id, cron: w.cron, days: w.days })),
      crowdedMinutes: crowded.map(([m, v]) => ({ minute: m, n: v.length, who: v })),
    }, null, 2))
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
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
