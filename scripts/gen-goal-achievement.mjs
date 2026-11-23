#!/usr/bin/env node
// scripts/gen-goal-achievement.mjs — 目标定义（goals.yml）→ 两段生成关系（件②，#2708）。
//
// 读三份**静态事实源**（不连库 ⇒ CI 恒有牙齿）：
//   ① `dbt/semantics/goals.yml`                  目标定义（唯一事实源，见该文件头注）
//   ② `contracts/forms/data-plane/<form_def>.json` 件① 表单字段契约（字段类型的事实源；
//      由 scripts/gen-forms-data-projection.mjs 从真库生成，本脚本只读不改）
//   ③ `dbt/semantics/l1_metrics.yml`             actuals 引用的既有 L1 指标（口径不复制，D7）
//
// 生成两份产物，逐目标一份：
//   · `dbt/models/goals/stg_goal_values__<goal>.sql`
//       段① DuckDB：`read_parquet` forms 提交湖 + payload 逐字段提取 + 显式 cast。
//       **无任何 join**（数据面正典 B1；探针 2026-11-23 实测 DuckDB 语句引用不了 PG 关系）。
//   · `dbt/models/goals/mart_goal_achievement__<goal>.sql`
//       段② PG 原生：段① 表 ⨝ actuals marts ⨝ 日期 spine → 达成率 / 时间进度 / data_status。
//
// ## 生成物纪律（与 gen-forms-data-projection / gen-data-projection 同款）
//
//   · 默认      写文件（并删除「声明里已无此目标」的孤儿产物——只动本生成器命名空间）
//   · `--check` 重新生成全部产物并与 committed 逐字节比对；任一差异（内容 / 孤儿）⇒ exit 1
//   · ี้ยง静态：无 DATABASE_URL 依赖，CI gates 每次都真跑
//
// ## 与 L1 声明的咬合（不生成 l1_metrics.yml，但会校验它）
//
// `scripts/sync-data-semantics.mjs` 只认 `dbt/semantics/l1_metrics.yml` 一个文件 ⇒ 指标声明必须
// 手写在那一份里（生成物无法被 sync 读到）。为防止「生成的列」与「手写的指标」漂开，本脚本在
// 生成/校验时**逐条核对**每 goal×metric 的两条指标（achievement_rate / progress_rate）在
// l1_metrics.yml 里存在，且 ratio 的分子/分母引用本脚本产出的列；缺一条 ⇒ 响亮失败。
//
// 用法：
//   node scripts/gen-goal-achievement.mjs [--check] [rootDir]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

/** 目标定义声明（唯一事实源）。 */
export const GOALS_REL_PATH = 'dbt/semantics/goals.yml'
/** L1 指标声明（actuals 解析面）。 */
export const L1_REL_PATH = 'dbt/semantics/l1_metrics.yml'
/** 件① 表单字段契约目录（生成物，由件① 生成器维护）。 */
export const CONTRACT_REL_DIR = 'contracts/forms/data-plane'
/** 生成模型目录（仓根相对）。为什么归 lemeng 域见 goals.yml 头注。 */
export const MODEL_REL_DIR = 'dbt/models/goals'
/** 段① 文件名前缀（本生成器命名空间的一半）。 */
export const STAGE_ONE_STEM = 'stg_goal_values__'
/** 段② 文件名前缀（本生成器命名空间的另一半）。 */
export const MART_STEM = 'mart_goal_achievement__'
/** 目标命名空间：`<部署标识>:<slug>`。 */
export const GOAL_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
/** v1 只支持月周期（见 goals.yml 字段约定）。 */
export const V1_PERIOD = 'month'
/** v1 只支持门店维度（D5：目标必须落店粒度才能分母收缩）。 */
export const V1_DIMENSIONS = ['branch_num']

/**
 * actuals 引用形态：v1 只收 `sum(<关系>.<列>)`（可加单关系；率类/复合留第二刀）。
 * 解析出关系名与列名，用于生成 PG 段的 actual CTE 与 `ref()`。
 * @param {string} expression
 * @returns {{ relation: string, column: string } | null}
 */
export function parseActualExpression(expression) {
  const m = String(expression).trim().match(/^sum\(\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*\)$/i)
  return m === null ? null : { relation: m[1], column: m[2] }
}

/**
 * 目标声明 → 校验后的结构（形状错误带目标名抛出——门禁要能指名道姓）。
 * @param {unknown} raw
 * @returns {GoalSpec}
 */
export function normalizeGoal(raw) {
  const g = /** @type {Record<string, any>} */ (raw ?? {})
  const name = String(g['goal'] ?? '')
  if (!GOAL_NAME_RE.test(name)) {
    throw new Error(`goals.yml: goal 必须是 \`<部署标识>:<slug>\` 两段小写蛇形，收到 ${JSON.stringify(name)}`)
  }
  const [deployment, slug] = name.split(':')
  const label = String(g['label'] ?? '').trim()
  if (label === '') throw new Error(`goals.yml: ${name} 缺 label`)
  const org = String(g['org'] ?? '').trim()
  if (org === '') throw new Error(`goals.yml: ${name} 缺 org`)

  const period = String(g['period'] ?? '')
  if (period !== V1_PERIOD) throw new Error(`goals.yml: ${name} 的 period 只支持 '${V1_PERIOD}'（v1），收到 ${JSON.stringify(period)}`)

  const systemBook = String(g['system_book'] ?? '').trim()
  if (!/^[0-9][0-9a-z_]*$/.test(systemBook)) {
    throw new Error(`goals.yml: ${name} 缺/错 system_book（目标归属账套，如 '3120'；两本账套门店号有重叠，必须钉住）`)
  }
  const metricSource = String(g['metric_source'] ?? 'lemeng').trim()
  if (!/^[a-z][a-z0-9_]*$/.test(metricSource)) {
    throw new Error(`goals.yml: ${name} 的 metric_source 必须是单段小写蛇形（如 lemeng），收到 ${JSON.stringify(metricSource)}`)
  }

  const dimensions = Array.isArray(g['dimensions']) ? g['dimensions'].map((d) => String(d)) : []
  if (dimensions.length !== V1_DIMENSIONS.length || dimensions.some((d, i) => d !== V1_DIMENSIONS[i])) {
    throw new Error(`goals.yml: ${name} 的 dimensions 只支持 ${JSON.stringify(V1_DIMENSIONS)}（v1），收到 ${JSON.stringify(dimensions)}`)
  }

  const scope = g['scope']
  if (scope !== undefined && scope !== null) {
    const s = /** @type {Record<string, unknown>} */ (scope)
    if (s['assessed_war_zone_only'] === true) {
      throw new Error(`goals.yml: ${name} 声明了 scope.assessed_war_zone_only——v1 未实现考核战区过滤（第二刀），不要声明未生效的口径`)
    }
    throw new Error(`goals.yml: ${name} 的 scope 只认识 assessed_war_zone_only（v1 不支持任何 scope），收到 ${JSON.stringify(scope)}`)
  }

  const ts = /** @type {Record<string, any>} */ (g['target_source'] ?? {})
  const formDef = String(ts['form_def'] ?? '').trim()
  if (formDef === '') throw new Error(`goals.yml: ${name} 缺 target_source.form_def`)
  const periodField = String(ts['period_field'] ?? '').trim()
  if (periodField === '') throw new Error(`goals.yml: ${name} 缺 target_source.period_field`)
  /** @type {Record<string, string>} */
  const dimensionFields = {}
  for (const [dim, field] of Object.entries(/** @type {Record<string, unknown>} */ (ts['dimension_fields'] ?? {}))) {
    dimensionFields[dim] = String(field)
  }
  for (const dim of dimensions) {
    if (dimensionFields[dim] === undefined) throw new Error(`goals.yml: ${name} 的 dimension_fields 缺 ${dim}`)
  }
  for (const dim of Object.keys(dimensionFields)) {
    if (!dimensions.includes(dim)) throw new Error(`goals.yml: ${name} 的 dimension_fields 声明了非 dimensions 的键 ${dim}`)
  }
  /** @type {Record<string, string>} */
  const valueFields = {}
  for (const [metric, field] of Object.entries(/** @type {Record<string, unknown>} */ (ts['value_fields'] ?? {}))) {
    valueFields[metric] = String(field)
  }
  if (Object.keys(valueFields).length === 0) throw new Error(`goals.yml: ${name} 缺 target_source.value_fields`)

  /** @type {Record<string, string>} */
  const actuals = {}
  for (const [metric, metricName] of Object.entries(/** @type {Record<string, unknown>} */ (g['actuals'] ?? {}))) {
    actuals[metric] = String(metricName)
  }
  const valueKeys = Object.keys(valueFields).sort().join(',')
  const actualKeys = Object.keys(actuals).sort().join(',')
  if (valueKeys !== actualKeys) {
    throw new Error(`goals.yml: ${name} 的 value_fields 与 actuals 键集必须相等（value=[${valueKeys}] actual=[${actualKeys}]）`)
  }

  return { goal: name, deployment, slug, label, org, period, metricSource, systemBook, dimensions, formDef, periodField, dimensionFields, valueFields, actuals }
}

/**
 * @typedef {object} GoalSpec
 * @property {string} goal
 * @property {string} deployment
 * @property {string} slug
 * @property {string} label
 * @property {string} org
 * @property {string} period
 * @property {string} metricSource
 * @property {string} systemBook
 * @property {string[]} dimensions
 * @property {string} formDef
 * @property {string} periodField
 * @property {Record<string, string>} dimensionFields
 * @property {Record<string, string>} valueFields
 * @property {Record<string, string>} actuals
 */

/**
 * 读 goals.yml → 校验后的目标清单。
 * @param {string} rootDir
 * @returns {GoalSpec[]}
 */
export function readGoals(rootDir) {
  const file = join(rootDir, GOALS_REL_PATH)
  const doc = /** @type {Record<string, unknown>} */ (parseYaml(readFileSync(file, 'utf8')))
  const list = doc?.['goals']
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${GOALS_REL_PATH}: 顶层 goals 必须是非空数组`)
  const names = new Set()
  return list.map((raw) => {
    const g = normalizeGoal(raw)
    if (names.has(g.goal)) throw new Error(`${GOALS_REL_PATH}: goal 重名 ${g.goal}`)
    names.add(g.goal)
    return g
  })
}

/**
 * 段① / 段② 的关系名（文件名去扩展）。
 * @param {GoalSpec} goal
 */
export function stageOneRelation(goal) {
  return `${STAGE_ONE_STEM}${goal.slug}`
}
/** @param {GoalSpec} goal */
export function martRelation(goal) {
  return `${MART_STEM}${goal.slug}`
}

/**
 * 每 goal×metric 的两条 L1 指标名（`<metric_source>:goal:<goalSlug>_<metric>_<kind>`）。
 * kind 用短后缀 `rate`（达成率）/ `pace`（时间进度）：对账 test 名由指标名机械派生且有 63 字符硬限
 * （#2750 真机：`..._outbound_achievement_rate` 派生 64 字符 ⇒ dbt 建 relation 报错）。
 * 指标名三段小写蛇形（check-data-models 规则 ⑥）；源段由 goals.yml 的 `metric_source` 给（缺省
 * `lemeng`——实际值来自乐檬 marts，且对账 test 的落点按源段分目录，见 goals.yml 字段约定）。
 * @param {GoalSpec} goal
 * @param {string} metric
 * @param {'rate' | 'pace'} kind
 */
export function goalMetricName(goal, metric, kind) {
  return `${goal.metricSource}:goal:${goal.slug}_${metric}_${kind}`
}

/**
 * 读件① 表单契约（字段 → 列/类型；本脚本只消费，不生成）。
 * @param {string} rootDir
 * @param {string} formDef
 * @returns {{ form_def_id: string, org: string, version: number, relationSlug: string, columns: Array<{ field: string, column: string, kind: string, sql_type: string }> }}
 */
export function readFormContract(rootDir, formDef) {
  const file = join(rootDir, CONTRACT_REL_DIR, `${formDef}.json`)
  if (!existsSync(file)) {
    throw new Error(
      `找不到表单字段契约 ${CONTRACT_REL_DIR}/${formDef}.json —— 目标源的 form_def 必须是已发布且 dataPlane.enabled 的表单；` +
        '先跑 `DATABASE_URL=<平台库> node scripts/gen-forms-data-projection.mjs` 生成契约并提交',
    )
  }
  const doc = /** @type {any} */ (JSON.parse(readFileSync(file, 'utf8')))
  if (doc?.form_def_id !== formDef) throw new Error(`${CONTRACT_REL_DIR}/${formDef}.json 的 form_def_id=${JSON.stringify(doc?.form_def_id)} 与文件名不符`)
  if (!Array.isArray(doc?.columns) || doc.columns.length === 0) throw new Error(`${CONTRACT_REL_DIR}/${formDef}.json 没有 columns`)
  return doc
}

/**
 * 读 l1_metrics.yml 的指标索引（name → 声明）。
 * @param {string} rootDir
 * @returns {Map<string, Record<string, any>>}
 */
export function readL1Index(rootDir) {
  const doc = /** @type {Record<string, unknown>} */ (parseYaml(readFileSync(join(rootDir, L1_REL_PATH), 'utf8')))
  const list = doc?.['metrics']
  /** @type {Map<string, Record<string, any>>} */
  const index = new Map()
  if (!Array.isArray(list)) return index
  for (const m of list) index.set(String(/** @type {any} */ (m)?.name), /** @type {any} */ (m))
  return index
}

/**
 * 目标声明 + 表单契约 → 段① DuckDB SQL（只碰 parquet，无 join）。
 * @param {GoalSpec} goal
 * @param {{ columns: Array<{ field: string, column: string, kind: string, sql_type: string }> }} contract
 * @returns {string}
 */
export function buildStageOneSql(goal, contract) {
  /** @type {Map<string, { field: string, column: string, kind: string, sql_type: string }>} */
  const byField = new Map(contract.columns.map((c) => [c.field, c]))
  /** @type {Array<{ field: string, column: string, kind: string, sql_type: string }>} */
  const picked = []
  const need = [goal.periodField, ...Object.values(goal.dimensionFields), ...Object.values(goal.valueFields)]
  for (const field of need) {
    const col = byField.get(field)
    if (col === undefined) {
      throw new Error(`目标 ${goal.goal}：表单字段 ${field} 不在契约 ${goal.formDef} 的 columns 里（表单改过字段？重跑件① 生成器）`)
    }
    picked.push(col)
  }
  const periodCol = /** @type {any} */ (byField.get(goal.periodField))
  if (periodCol.kind !== 'string' && periodCol.kind !== 'enum') throw new Error(`目标 ${goal.goal}：周期字段 ${goal.periodField} 必须是 string/enum（收到 ${periodCol.kind}）`)
  for (const [dim, field] of Object.entries(goal.dimensionFields)) {
    const col = /** @type {any} */ (byField.get(field))
    if (col.kind !== 'string' && col.kind !== 'enum') throw new Error(`目标 ${goal.goal}：维度 ${dim} 的字段 ${field} 必须是 string/enum（收到 ${col.kind}）`)
  }
  for (const [metric, field] of Object.entries(goal.valueFields)) {
    const col = /** @type {any} */ (byField.get(field))
    if (col.kind !== 'number' && col.kind !== 'integer') throw new Error(`目标 ${goal.goal}：目标值 ${metric} 的字段 ${field} 必须是 number/integer（收到 ${col.kind}）`)
  }

  /** 列别名 → 输出名。维度与周期沿用目标语义名（branch_num / period），目标值沿用
   *  physics 名（target_sale），避免与段② 的 `actual_*` 混淆。 */
  /** @param {{ field: string, column: string, kind: string, sql_type: string }} c @param {string} alias */
  const extract = (c, alias) => {
    const path = `$.${c.field}`
    if (c.kind === 'number' || c.kind === 'integer') {
      return `cast(json_extract_string(r['payload'], '${path}') as ${c.sql_type}) as ${alias}`
    }
    return `json_extract_string(r['payload'], '${path}') as ${alias}`
  }

  /** @type {string[]} */
  const lines = []
  lines.push(`  ${extract(periodCol, 'period')}`)
  for (const [dim, field] of Object.entries(goal.dimensionFields)) {
    lines.push(`  ${extract(/** @type {any} */ (byField.get(field)), dim)}`)
  }
  for (const [metric, field] of Object.entries(goal.valueFields)) {
    lines.push(`  ${extract(/** @type {any} */ (byField.get(field)), `target_${metric}`)}`)
  }

  return [
    "{{ config(materialized='table') }}",
    '-- 生成物：scripts/gen-goal-achievement.mjs — 手改会被 --check 回写（改口径只改 dbt/semantics/goals.yml）',
    `-- 目标：${goal.goal}（${goal.label}） 来源表单：${goal.formDef}（契约 ${CONTRACT_REL_DIR}/${goal.formDef}.json）`,
    '-- 件② 段① DuckDB：只碰 forms 提交湖 parquet（payload 是整列 varchar JSON 的 schema-on-read 提取，',
    '--   ADR-0005 §13.1 ①）；**无任何 join**（B1）；取列一律 r[\'列名\'] 形态。',
    '-- 行 = 一次提交（同一 (period, 维度) 的多次提交在段② 取 submitted_at 最新，轮次内可改）。',
    'select',
    '  r[\'batch_id\']::varchar as batch_id,',
    '  {{ subject_org() }} as org,',
    '  r[\'bizday\']::date as bizday,',
    "  r['submission_id']::bigint as submission_id,",
    "  r['submitted_at']::timestamptz as submitted_at,",
    lines.join(',\n'),
    'from read_parquet(',
    '  \'s3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet\'',
    ') r',
    `where r['form_def_id'] = '${goal.formDef}'`,
    '',
  ].join('\n')
}

/**
 * 目标声明 + L1 索引 → 段② PG 原生 SQL（join 段① + actuals marts + 日期 spine）。
 * @param {GoalSpec} goal
 * @param {Map<string, Record<string, any>>} l1
 * @returns {string}
 */
export function buildAchievementSql(goal, l1) {
  /** @type {Array<{ metric: string, relation: string, column: string }>} */
  const actuals = []
  for (const [metric, metricName] of Object.entries(goal.actuals)) {
    const decl = l1.get(metricName)
    if (decl === undefined) {
      throw new Error(`目标 ${goal.goal}: actuals.${metric} 引用的指标 ${metricName} 不在 ${L1_REL_PATH}（先声明口径再引用）`)
    }
    if (decl['ratio'] !== undefined) {
      throw new Error(`目标 ${goal.goal}: actuals.${metric} 引用的 ${metricName} 是率类（ratio）——v1 只收可加单关系 sum(<关系>.<列>)`)
    }
    const parsed = parseActualExpression(String(decl['expression'] ?? ''))
    if (parsed === null) {
      throw new Error(`目标 ${goal.goal}: actuals.${metric} 引用的 ${metricName} 的 expression 不是 sum(<关系>.<列>)（v1 白名单）`)
    }
    actuals.push({ metric, ...parsed })
  }

  const mart = martRelation(goal)
  const stageOne = stageOneRelation(goal)
  const dims = goal.dimensions

  // actuals CTE：逐指标一条（同关系可重复声明为多条——dbt 的 ref 去重不影响查询计划）
  const actualCtes = actuals.map((a) => [
    `actual_${a.metric} as (`,
    '    select',
    "        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,",
    ...dims.map((d) => `        f.${d}::text as ${d},`),
    `        sum(f.${a.column})::numeric(20,4) as actual_${a.metric}`,
    `    from {{ ref('${a.relation}') }} f`,
    `    where f.system_book = '${goal.systemBook}'`,
    '      and f.bizday >= (select min(first_day) from goal)',
    '      and f.bizday <= (select max(last_day) from goal)',
    '    group by 1' + dims.map((_, i) => `, ${i + 2}`).join(''),
    '),',
  ].join('\n')).join('\n')

  const joins = actuals.map((a) => (
    `left join actual_${a.metric} a_${a.metric} using (period${dims.map((d) => `, ${d}`).join('')})`
  )).join('\n')

  const actualCols = actuals.flatMap((a) => ([
    `    coalesce(a_${a.metric}.actual_${a.metric}, 0)::numeric(20,4) as actual_${a.metric},`,
    `    (case when g.target_${a.metric} > 0 then round(coalesce(a_${a.metric}.actual_${a.metric}, 0) / g.target_${a.metric}, 4) end)::numeric(10,4) as ${a.metric}_achievement_rate,`,
  ])).join('\n')

  // 数值列一律带 typmod：PG 的无精度 numeric 在 pg_duckdb 里是 UnsupportedPostgresType，
  // DuckDB 路由的语句连 sum() 都绑不上（#2750 真机：Binder Error 'sum(UnsupportedPostgresType)'）。
  // 数据面工件要能被 DuckDB 直接消费 ⇒ 目标/实际/比率全部显式 `::numeric(p,s)`。
  const targetCols = actuals.map((a) => `    g.target_${a.metric}::numeric(20,4) as target_${a.metric},`).join('\n')
  const groupBy = ['1', ...dims.map((_, i) => String(i + 2))].join(', ')

  return [
    "{{ config(materialized='table') }}",
    '-- 生成物：scripts/gen-goal-achievement.mjs — 手改会被 --check 回写（改口径只改 dbt/semantics/goals.yml）',
    `-- 目标：${goal.goal}（${goal.label}） 段①：${stageOne}  actuals：${actuals.map((a) => `${a.metric}→${a.relation}.${a.column}`).join(' / ')}`,
    '-- 件② 段② **PG 原生**：段① 表 ⨝ actuals marts ⨝ 日期 spine（纯 PG join；DuckDB 语句引用不了 PG',
    '--   关系，探针 2026-11-23 实测 ⇒ 两段式是硬约束，不是风格）。',
    '-- 口径：',
    '--   · 同一 (period, 维度) 的多次提交取 submitted_at 最新（轮次内可改，D3 开放项 1：v1 无审批门）；',
    '--   · target = 0 或缺失 ⇒ 达成率 NULL（照 data-analysis outbound 族的「新店无目标」处置，D5）；',
    '--   · actual 缺失 ⇒ 0（该店该月无任何销售行 = 卖了 0，不是「不知道」）；',
    '--   · progress_rate = 已过日历日 / 当月总天数（**北京时钟日界**，{{ shanghai_today() }} 宏；未来月份 0）；',
    '--   · data_status = 当月 bizday 覆盖：complete（覆盖全部已过日）/ partial（>0）/ missing（0）。',
    '-- 数值列一律显式 `::numeric(p,s)`：PG 的无精度 numeric 在 pg_duckdb 里是 UnsupportedPostgresType，',
    '--   DuckDB 路由的语句连 sum() 都绑不上（#2750 真机 Binder Error）——数据面工件要能被 DuckDB 直接消费。',
    `-- 账套：actuals 只读 system_book='${goal.systemBook}'（目标定义钉死；两本账套门店号有重叠，见 goals.yml）。`,
    'with goal_latest as (',
    '    select distinct on (period' + dims.map((d) => `, ${d}`).join('') + ')',
    '        period,',
    ...dims.map((d) => `        ${d},`),
    ...actuals.map((a) => `        target_${a.metric},`),
    '        bizday as collected_bizday,',
    '        submitted_at,',
    '        submission_id',
    `    from {{ ref('${stageOne}') }}`,
    "    where period ~ '^[0-9]{4}-[0-9]{2}$'",
    ...dims.map((d) => `      and ${d} is not null and ${d} <> ''`),
    '    order by period' + dims.map((d) => `, ${d}`).join('') + ', submitted_at desc nulls last, submission_id desc',
    '),',
    'goal as (',
    '    select',
    "        (g.period || '-01')::date as bizday,",
    `        '${goal.systemBook}'::varchar as system_book,`,
    '        g.period,',
    ...dims.map((d) => `        g.${d},`),
    ...actuals.map((a) => `        g.target_${a.metric},`),
    '        g.collected_bizday,',
    "        (g.period || '-01')::date as first_day,",
    "        ((g.period || '-01')::date + interval '1 month - 1 day')::date as last_day",
    '    from goal_latest g',
    '),',
    actualCtes,
    'coverage as (',
    '    -- data_status 的数据完整度面：按 (period, 维度) 数当月有零售行的 bizday 数。',
    '    select',
    "        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,",
    ...dims.map((d) => `        f.${d}::text as ${d},`),
    '        count(distinct f.bizday) as covered_days',
    "    from {{ ref('fct_retail_sale') }} f",
    `    where f.system_book = '${goal.systemBook}'`,
    '      and f.bizday >= (select min(first_day) from goal)',
    '      and f.bizday <= (select max(last_day) from goal)',
    `    group by ${groupBy}`,
    '),',
    'spine as (',
    '    select',
    '        g.bizday,',
    '        g.system_book,',
    '        g.period,',
    ...dims.map((d) => `        g.${d},`),
    ...actuals.map((a) => `        g.target_${a.metric},`),
    '        g.collected_bizday,',
    '        (g.last_day - g.first_day + 1) as total_days,',
    '        greatest(least({{ shanghai_today() }}, g.last_day) - g.first_day + 1, 0) as days_elapsed',
    '    from goal g',
    ')',
    'select',
    '    {{ subject_org() }} as org,',
    '    g.bizday,',
    '    g.system_book,',
    '    g.period,',
    ...dims.map((d) => `    g.${d},`),
    '    g.collected_bizday,',
    targetCols,
    actualCols,
    '    g.days_elapsed,',
    '    g.total_days,',
    '    round(g.days_elapsed::numeric / g.total_days, 4)::numeric(10,4) as progress_rate,',
    '    case',
    '        when coalesce(c.covered_days, 0) >= g.days_elapsed then \'complete\'',
    '        when coalesce(c.covered_days, 0) > 0 then \'partial\'',
    "        else 'missing'",
    '    end as data_status',
    'from spine g',
    joins,
    `left join coverage c using (period${dims.map((d) => `, ${d}`).join('')})`,
    `order by g.period${dims.map((d) => `, g.${d}`).join('')}`,
    '',
  ].join('\n')
}

/**
 * 校验 l1_metrics.yml 里每 goal×metric 的两条指标存在且引用生成列。
 * @param {GoalSpec} goal
 * @param {Map<string, Record<string, any>>} l1
 */
export function assertGoalMetricsDeclared(goal, l1) {
  /** @type {string[]} */
  const problems = []
  for (const metric of Object.keys(goal.actuals)) {
    const achievement = goalMetricName(goal, metric, 'rate')
    const progress = goalMetricName(goal, metric, 'pace')
    const a = l1.get(achievement)
    if (a === undefined) problems.push(`缺 ${achievement}`)
    else {
      const num = String(a['ratio']?.['numerator'] ?? '')
      const den = String(a['ratio']?.['denominator'] ?? '')
      if (!num.includes(`actual_${metric}`) || !den.includes(`target_${metric}`)) {
        problems.push(`${achievement} 的 ratio 必须引用 actual_${metric} / target_${metric}`)
      }
    }
    const p = l1.get(progress)
    if (p === undefined) problems.push(`缺 ${progress}`)
    else {
      const num = String(p['ratio']?.['numerator'] ?? '')
      const den = String(p['ratio']?.['denominator'] ?? '')
      if (!num.includes('days_elapsed') || !den.includes('total_days')) {
        problems.push(`${progress} 的 ratio 必须引用 days_elapsed / total_days`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`目标 ${goal.goal} 的 L1 声明不齐（${L1_REL_PATH}）：${problems.join('；')}`)
  }
}

/**
 * 生成全部产物（文件名 → 内容）。
 * @param {string} rootDir
 * @returns {{ goals: GoalSpec[], files: Map<string, string> }}
 */
export function buildAll(rootDir) {
  const goals = readGoals(rootDir)
  const l1 = readL1Index(rootDir)
  /** @type {Map<string, string>} */
  const files = new Map()
  for (const goal of goals) {
    assertGoalMetricsDeclared(goal, l1)
    const contract = readFormContract(rootDir, goal.formDef)
    files.set(`${stageOneRelation(goal)}.sql`, buildStageOneSql(goal, contract))
    files.set(`${martRelation(goal)}.sql`, buildAchievementSql(goal, l1))
  }
  return { goals, files }
}

/**
 * 主流程。
 * @param {string} rootDir
 * @param {{ check?: boolean }} [opts]
 * @returns {number} 退出码（0 = 对齐；--check 下有漂移 = 1）
 */
export function runGenerate(rootDir, opts = {}) {
  const { files } = buildAll(rootDir)
  const dir = join(rootDir, MODEL_REL_DIR)
  const existing = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.sql')) : []
  const owned = existing.filter((n) => n.startsWith(STAGE_ONE_STEM) || n.startsWith(MART_STEM))

  /** @type {string[]} */
  const changes = []
  for (const [name, content] of files) {
    if (!existing.includes(name) || readFileSync(join(dir, name), 'utf8') !== content) changes.push(name)
  }
  const stale = owned.filter((n) => !files.has(n))

  if (opts.check) {
    for (const n of changes) console.error(`gen-goal-achievement: 生成物漂移：${MODEL_REL_DIR}/${n}`)
    for (const n of stale) console.error(`gen-goal-achievement: 孤儿生成物（声明里已无此目标）：${MODEL_REL_DIR}/${n}`)
    if (changes.length === 0 && stale.length === 0) {
      console.error(`gen-goal-achievement: --check OK（${files.size} 份产物 == committed）`)
      return 0
    }
    console.error('gen-goal-achievement: 跑 `node scripts/gen-goal-achievement.mjs` 重新生成后一并提交')
    return 1
  }

  if (changes.length === 0 && stale.length === 0) {
    console.error(`gen-goal-achievement: 已对齐（${files.size} 份产物）`)
    return 0
  }
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of files) writeFileSync(join(dir, name), content)
  for (const n of stale) rmSync(join(dir, n))
  console.error(`gen-goal-achievement: 写 ${files.size} 份产物，删 ${stale.length} 个孤儿产物`)
  return 0
}

// ── CLI 入口（被测试 import 时不执行）──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd()
  try {
    process.exit(runGenerate(root, { check: args.includes('--check') }))
  } catch (/** @type {any} */ e) {
    console.error(`gen-goal-achievement 失败: ${e?.message ?? e}`)
    process.exit(2)
  }
}
