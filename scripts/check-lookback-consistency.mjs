// scripts/check-lookback-consistency.mjs — 增量 lookback / 审计窗口 / 重述窗口的一致性门禁（#2428）。
//
// ## 它防的是哪一类窟窿
//
// 三个数字本应互相咬合，却各自写在三个地方：
//   ① 各增量 mart 的 `incremental_cutoff(N)` —— mart 每轮重建到 T−N；
//   ② `materialize.sh` 的审计窗口 —— 窗口对账只比 `today−N` 之后的分区；
//   ③ `recon-restate.sh` 的重述窗口 —— 每晚 heal `T-3 .. T-(3+RESTATE_DAYS-1)`。
//
// 2026-11-17 实测过一次不咬合的代价：lookback=7、restate 深度 9 ⇒ T-8/T-9 被 heal 后
// **mart 不重建、窗口审计也看不到**（静默漏检），而全史审计又必然报「湖新 mart 旧」。
// 咬合关系：`N ≥ restate 最深日 + 1`（留一天余量），且 ① == ②（否则窗口宽于重建范围必假红）。
//
// ## 判据
//   A. 仓内所有 `incremental_cutoff(N)` 的 N 一致；出现非数字实参 ⇒ 红（防有人用表达式绕开比对）；
//   B. `materialize.sh` 的审计窗口 N == A；
//   C. `gen-fct-measures.mjs` 的 `incrementalLookback` == A（生成区与手写区同窗）；
//   D. A ≥ `SETTLE_DAYS + RESTATE_DAYS − 1 + 1`（覆盖 restate 最深日并留一天）。
//
// 用法：`pnpm exec tsx scripts/check-lookback-consistency.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))

/**
 * 递归收集 dbt/models 下的 .sql。
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectSql(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectSql(p, out)
    else if (name.endsWith('.sql')) out.push(p)
  }
  return out
}

/**
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  console.error(`check-lookback-consistency: FAILED\n${msg}`)
  process.exit(1)
}

// ── A. 模型里的 cutoff ────────────────────────────────────────────────────────
// 允许按模型声明不同的 lookback（例如月度粒度模型需要 60 天），但**必须逐个登记理由**；
// 未登记的偏离一刀判红，避免「某个模型悄悄换窗」这种静默漂移。
const ALLOWED_DIVERGENCE = new Map([
  [
    'dbt/models/lemeng/marts/fct_purchase_concentration.sql',
    { days: 60, why: '月度粒度：cutoff 需对齐月首（date_trunc），10 天会截断当月' },
  ],
])

const perFile = new Map() // 相对路径 -> N（同文件内不一致也判红）
for (const file of collectSql(join(ROOT, 'dbt/models'))) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).split('\\').join('/')
  for (const m of text.matchAll(/incremental_cutoff\(([^)]*)\)/g)) {
    const arg = m[1].trim()
    if (!/^\d+$/.test(arg)) {
      fail(`模型 ${rel} 的 incremental_cutoff 实参不是字面量数字："${arg}"`)
    }
    const n = Number(arg)
    if (perFile.has(rel) && perFile.get(rel) !== n) {
      fail(`模型 ${rel} 内部出现多个 lookback（${perFile.get(rel)} / ${n}）`)
    }
    perFile.set(rel, n)
  }
}
if (perFile.size === 0) fail('dbt/models 下没有任何 incremental_cutoff(N) —— 判据失去了观测面')

const counts = new Map()
for (const n of perFile.values()) counts.set(n, (counts.get(n) ?? 0) + 1)
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
  fail('无法判定「默认 lookback」：最多的两档出现次数相同，请显式收敛到一档')
}
const modelLookback = sorted[0][0]
for (const [rel, n] of perFile) {
  if (n === modelLookback) continue
  const allow = ALLOWED_DIVERGENCE.get(rel)
  if (!allow) fail(`模型 ${rel} 的 lookback=${n} 偏离默认 ${modelLookback}，且未登记理由`)
  if (allow.days !== n) {
    fail(`模型 ${rel} 登记的是 ${allow.days} 天，实际写了 ${n} 天（登记与实现漂移）`)
  }
}

// ── B. 审计窗口 ───────────────────────────────────────────────────────────────
const mat = readFileSync(join(ROOT, 'scripts/lemeng/materialize.sh'), 'utf8')
const windowMatch = mat.match(/print\(\(today - timedelta\(days=(\d+)\)\)\.isoformat\(\)/)
if (!windowMatch) fail('materialize.sh 里找不到 audit_window_pair() 的 timedelta(days=N)')
const windowLookback = Number(windowMatch[1])

// ── C. 生成器 ────────────────────────────────────────────────────────────────
const gen = readFileSync(join(ROOT, 'scripts/gen-fct-measures.mjs'), 'utf8')
const genLookbacks = [...gen.matchAll(/incrementalLookback:\s*(\d+)/g)].map((m) => Number(m[1]))
if (genLookbacks.length === 0) fail('gen-fct-measures.mjs 里找不到 incrementalLookback')
const genSet = new Set(genLookbacks)

// ── D. 重述窗口 ───────────────────────────────────────────────────────────────
const restate = readFileSync(join(ROOT, 'scripts/lemeng/recon-restate.sh'), 'utf8')
const restateDays = Number(restate.match(/RESTATE_DAYS=\$\{RESTATE_DAYS:-(\d+)\}/)?.[1])
const settleDays = Number(restate.match(/SETTLE_DAYS=\$\{SETTLE_DAYS:-(\d+)\}/)?.[1])
if (!Number.isFinite(restateDays) || !Number.isFinite(settleDays)) {
  fail('recon-restate.sh 里读不到 RESTATE_DAYS / SETTLE_DAYS 默认值')
}
const deepest = settleDays + restateDays - 1 // T-deepest 是最深的可 heal 日
const required = deepest + 1
const minLookback = Math.min(...perFile.values())

const problems = []
if (windowLookback !== modelLookback) {
  problems.push(
    `审计窗口 ${windowLookback} ≠ 默认 lookback ${modelLookback}（窗口宽于重建范围 ⇒ 必然假红；窄于则漏检）`,
  )
}
if (windowLookback > minLookback) {
  problems.push(`审计窗口 ${windowLookback} > 最小 lookback ${minLookback}（窗口内仍有模型不会被重建）`)
}
for (const n of genSet) {
  if (n !== modelLookback) problems.push(`生成器 incrementalLookback=${n} ≠ 默认 ${modelLookback}`)
}
if (minLookback < required) {
  problems.push(
    `最小 lookback ${minLookback} < 重述深度 + 1 = ${required}（restate heal 到 T-${deepest}，更深的日 mart 不重建 ⇒ 静默漏检）`,
  )
}
if (problems.length > 0) fail(problems.map((p) => `  - ${p}`).join('\n'))

console.log(
  `check-lookback-consistency: OK（lookback=${modelLookback}；审计窗口=${windowLookback}；` +
    `生成器=${[...genSet].join('/')}；restate 最深 T-${deepest}；余量 ${modelLookback - deepest} 天）`,
)
