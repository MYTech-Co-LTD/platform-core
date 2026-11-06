#!/usr/bin/env node
// report-entity-coverage.mjs —— W4 Task 2：实体绑定覆盖率与**建议映射**（只读，不写盘）。
//
// 用法：`pnpm exec tsx scripts/report-entity-coverage.mjs [rootDir]`
// 输出：覆盖率一行 + 未绑定指标的「关系 → 建议实体」，供人确认后再落盘。
//
// 建议规则（保守，不猜）：
//   · 关系有明确业务对象 ⇒ 给建议（RELATION_ENTITY）；
//   · 关系对应对象**尚未在 entities.yml 声明** ⇒ 建议标记为 `?<对象>`，提示先补声明；
//   · 关系不在表里 ⇒ 建议为空（`—`），必须人工判定。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** 事实表 → 业务对象（保守表；不确定的一律不写）。 */
/** @type {Record<string, string>} */
export const RELATION_ENTITY = {
  fct_retail_sale: 'branch',
  fct_retail_comparable_growth: 'branch',
  fct_retail_order_line: 'order',
  fct_branch_day_activity: 'branch',
  fct_branch_indicator: 'branch',
  fct_branch_expense: 'branch',
  fct_contribution: 'branch',
  fct_client_contribution: 'client',
  fct_client_expense: 'client',
  fct_purchase: 'supplier',
  fct_purchase_concentration: 'supplier',
  fct_transfer_line_quality: 'transfer',
  fct_transfer_item: 'transfer',
  fct_hq_outbound: 'storehouse',
  fct_saler_commission: 'saler',
  fct_inventory_snapshot: 'storehouse',
  fct_inventory_movement: 'storehouse',
}

/** 从 select_sql / expression 里取关系名（`sum(rel.col)` / `from rel`）。 */
/** @param {unknown} selectSql @returns {string} */
export function relationOf(selectSql) {
  if (typeof selectSql !== 'string' || selectSql === '') return ''
  const m = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(selectSql)
  if (m !== null) return (m[1] ?? '').split('.').pop() ?? ''
  const a = /\b(?:sum|avg|min|max|count)\s*\(\s*(?:distinct\s+)?([A-Za-z_][A-Za-z0-9_]*)\./i.exec(selectSql)
  return a === null ? '' : (a[1] ?? '')
}

/**
 * @param {unknown} metricsDoc l1_metrics.yml 解析结果
 * @param {Set<string>} declaredEntities entities.yml 里已声明的对象名
 */
/** @param {any} metricsDoc @param {Set<string>} declaredEntities */
export function coverage(metricsDoc, declaredEntities) {
  /** @type {any[]} */
  const items = Array.isArray(metricsDoc?.metrics) ? metricsDoc.metrics : []
  const rows = items.map((m) => {
    const name = typeof m?.name === 'string' ? m.name : ''
    const entity = typeof m?.entity === 'string' ? m.entity.trim() : ''
    /** @type {string} */
    const rel = relationOf(typeof m?.expression === 'string' ? m.expression : (typeof m?.select_sql === 'string' ? m.select_sql : ''))
    /** @type {string} */
    const suggested = entity !== '' ? entity : (RELATION_ENTITY[rel] ?? '')
    const needsDeclare = suggested !== '' && !declaredEntities.has(suggested)
    return { name, entity, relation: rel, suggested: needsDeclare ? `?${suggested}` : suggested }
  })
  const bound = rows.filter(/** @param {{ entity: string }} r */ (r) => r.entity !== '').length
  return { total: rows.length, bound, rows }
}

/** CLI */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const sem = join(rootDir, 'dbt', 'semantics')
  const metrics = parse(readFileSync(join(sem, 'l1_metrics.yml'), 'utf8'))
  // 实体正典 = l1_metrics.yml 顶层 entities（W4：不另建 entities.yml）
  const declared = new Set(Object.keys(metrics?.entities ?? {}))
  const { total, bound, rows } = coverage(metrics, declared)
  console.log(`entity 绑定：${bound}/${total}（${((bound / total) * 100).toFixed(1)}%）`)
  const unbound = rows.filter(/** @param {{ entity: string }} r */ (r) => r.entity === '')
  if (unbound.length === 0) return
  console.log('\n未绑定（关系 → 建议实体；`?x` = 该对象尚未在 entities.yml 声明，`—` = 需人工判定）：')
  for (const r of unbound) {
    console.log(`  ${r.name.padEnd(44)} ${(r.relation || '—').padEnd(30)} ${r.suggested || '—'}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
