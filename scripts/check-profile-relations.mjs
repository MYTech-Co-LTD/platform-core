// check-profile-relations.mjs — W2 profiler 关系清单 ↔ L1 语义声明的漂移闸。
//
// ## 盯的是什么
//
// `deploy/duckle/console/pipelines/lemeng.metric_profile.3120.json` 的驱动表是**静态**的
// （21 个 `staging.*` 关系，从 `dbt/semantics/l1_metrics.yml` 的 expression 反解后写死）。
// L1 语义声明新增/删除指标、换关系时，profiler 不会自动跟着变：
//   · 少了 → 新 marts 永远没有画像 ⇒ 候选生成看不见它（静默缺口）；
//   · 多了 → 对已退役关系白跑（噪声，且退役表可能已 drop ⇒ run 红）。
// 两边都是**无声**的，故用本脚本显式对照。
//
// ## 判据（差集非空 ⇒ 打印 + exit 1）
//
// 期望集 = `l1_metrics.yml` 所有 `metrics[].expression` 里 `<relation>.<column>` 的 relation
//          （只认 `fct_` / `stg_` / `vw_` 前缀；L1 表达式按约定写 `sum(fct_x.col)`，见该文件头注）。
// 实际集 = profiler 父管线 `drv` 节点 SQL 里 `'staging.<relation>'` 字面量。
// 两侧都去重、排序后比差集；`missing`（该 profile 但没列）与 `extra`（列了但 L1 不用）分别打印。
//
// ⚠️ **不接 CI（评审 2026-11-05 裁决）**：L1 声明的增删本来就要求人工重排 profiler，
//    这条闸是**给人和脚本用的**；等 Task 5 的候选链路稳定后再决定是否进 CI。
//
// 用法：`pnpm exec tsx scripts/check-profile-relations.mjs [--root <仓根>]`
// 失败字面量：`PROFILE_RELATIONS_FAILED:`（每条违规一行，exit 1）；用法错 exit 2。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

const rootArgIdx = process.argv.indexOf('--root')
const ROOT = rootArgIdx === -1 ? '.' : process.argv[rootArgIdx + 1]
if (typeof ROOT !== 'string' || ROOT.length === 0) {
  console.error('check-profile-relations: --root 需要一个目录参数')
  process.exit(2)
}

/** 只认这三类关系前缀：L1 声明里的 `<relation>.<column>` 按约定只可能是它们。 */
const RELATION_RE = /\b((?:fct|stg|vw)_[a-z0-9_]+)\s*\./g

/**
 * 深度遍历语义声明，收集所有字符串里出现的 `<relation>.<column>` 关系名。
 *
 * 为什么遍历整份文档而不是只读 `expression`：L1 声明有四种写算式的地方——
 * `expression`（单式）/ `ratio.numerator|denominator`（比率）/ `expr`（列级）/ `compose`（组合），
 * 只读 expression 会漏掉 11 条 ratio 与列级定义（实测：`fct_transfer_item` 与
 * `fct_purchase_concentration` 只在 ratio 里出现）。前缀过滤保证 prose 里的普通词不会被误收。
 * @param {unknown} node
 * @param {Set<string>} out
 */
function collectRelations(node, out) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(RELATION_RE)) out.add(`staging.${m[1]}`)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) collectRelations(v, out)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node)) collectRelations(v, out)
  }
}

const ymlPath = join(ROOT, 'dbt/semantics/l1_metrics.yml')
const pipelinePath = join(ROOT, 'deploy/duckle/console/pipelines/lemeng.metric_profile.3120.json')

/** @type {any} */
let semantics
try {
  semantics = parseYaml(readFileSync(ymlPath, 'utf8'))
} catch (e) {
  console.error(`PROFILE_RELATIONS_FAILED: 读不了 ${ymlPath}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
const metrics = Array.isArray(semantics?.metrics) ? semantics.metrics : []
if (metrics.length === 0) {
  console.error(`PROFILE_RELATIONS_FAILED: ${ymlPath} 里没有 metrics（结构漂移，本闸没东西可判）`)
  process.exit(1)
}

const expected = new Set()
/** 只扫 `metrics`（不是整份 YAML）：其它键是给人读的说明，不该定义期望集。 */
collectRelations(metrics, expected)

/** @type {any} */
let pipeline
try {
  pipeline = JSON.parse(readFileSync(pipelinePath, 'utf8'))
} catch (e) {
  console.error(`PROFILE_RELATIONS_FAILED: 读不了 ${pipelinePath}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
const drv = (pipeline.nodes ?? []).find((/** @type {any} */ n) => n?.id === 'drv')
const sql = drv?.data?.properties?.sql
if (typeof sql !== 'string' || sql.length === 0) {
  console.error('PROFILE_RELATIONS_FAILED: 父管线里找不到 drv 节点的 SQL（结构漂移）')
  process.exit(1)
}
const actual = new Set()
for (const m of sql.matchAll(/'(staging\.[a-z0-9_]+)'/g)) actual.add(m[1])
if (actual.size === 0) {
  console.error('PROFILE_RELATIONS_FAILED: drv SQL 里没抽到任何 staging.* 关系（形状变了？）')
  process.exit(1)
}

const missing = [...expected].filter((r) => !actual.has(r)).sort()
const extra = [...actual].filter((r) => !expected.has(r)).sort()
if (missing.length === 0 && extra.length === 0) {
  console.log(`check-profile-relations: OK（${expected.size} 关系，L1 声明 ↔ profiler 一致）`)
  process.exit(0)
}
for (const r of missing) {
  console.error(`PROFILE_RELATIONS_FAILED: missing ${r} —— L1 声明在用，但 profiler 驱动表没列它（新 marts 不会有画像）`)
}
for (const r of extra) {
  console.error(`PROFILE_RELATIONS_FAILED: extra ${r} —— profiler 在 profile 它，但没有任何 L1 expression 用到（退役关系？）`)
}
process.exit(1)
