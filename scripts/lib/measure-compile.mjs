// scripts/lib/measure-compile.mjs — measure 两阶段编译的纯函数（P3.0 聚合面组件化 / issue #1012）。
//
// 只做字符串拼装：不读仓、不连库、也不认识 grain 名 → 分组键的映射（那是生成器的表）。
// 拆成纯函数的两个理由：
//   ① 生成器（gen-fct-measures.mjs）要被 `--check` 在 CI 里跑，纯函数才能在单测里逐字钉住 SQL；
//   ② 「能不能两阶段编译」是**编译期**判据（grain 缺失 / keys 空 / non_additive 一律抛错），
//      不能降级成一份「看起来能跑、数却错了」的 SQL —— 错数比报错更糟。
//
// 语义：measure.expr 自带聚合，故 stage 1 在组件自述的 grain 键上求 `measure_value`，
// stage 2 才在指标粒度上 `sum(measure_value)`。反过来（把 expr 直接塞进指标粒度的 select）
// 会在错的粒度上求值，行级差额被抹平。
/** @typedef {import('../sync-data-semantics.mjs').Measure} Measure */

/**
 * 阶段 1：`<expr>` 在 `keys` 分组上的 per-group 表达式（用作 CTE 主体）。
 *
 * @param {{ measure: Measure, keys: string[], baseAlias: string }} a `baseAlias` 原样进 from 子句
 * @returns {string}
 */
export function compilePerGroup({ measure, keys, baseAlias }) {
  if (!measure.grain) throw new Error('measure 缺 grain —— 两阶段编译必须知道逐组求值的键')
  if (keys.length === 0) throw new Error('两阶段编译的 keys 不能为空')
  return `select ${keys.join(', ')}, (${measure.expr}) as measure_value from ${baseAlias} group by ${keys.join(', ')}`
}

/**
 * 阶段 2：指标粒度的聚合（`sum(<value>)::numeric(20,2)`）。
 *
 * `stock` 允许求和：跨时间不可加性由调用方的时间键保证；`non_additive` 任何上卷都不成立 ⇒ 抛错。
 *
 * @param {{ measure: Measure, column: string, valueExpr: string }} a
 * @returns {string}
 */
export function compileAggregate({ measure, column, valueExpr }) {
  if (measure.additivity === 'non_additive') throw new Error(`non_additive measure 不能直接求和（column=${column}）`)
  return `sum(${valueExpr})::numeric(20,2) as ${column}`
}
