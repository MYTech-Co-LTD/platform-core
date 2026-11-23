// gen-goal-achievement.test.mjs — 目标两段生成器（件② #2708）的纯函数与 --check 契约单测。
// 生成器本体 = scripts/gen-goal-achievement.mjs（骨架照 gen-forms-data-projection：生成物==committed）。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// 注释掩码与门禁同源（lib 单一事实源）：无 join 断言只看代码位——头注释里「无 join」不算数
import { maskSqlComments } from './lib/data-contract.mjs'
import {
  CONTRACT_REL_DIR,
  MODEL_REL_DIR,
  assertGoalMetricsDeclared,
  buildAchievementSql,
  buildAll,
  buildStageOneSql,
  goalMetricName,
  martRelation,
  normalizeGoal,
  parseActualExpression,
  readGoals,
  readL1Index,
  runGenerate,
  stageOneRelation,
} from './gen-goal-achievement.mjs'

const GOAL_YAML = `goals:
  - goal: acme:monthly_store_sale
    label: 门店月度销售目标
    org: acme-org
    system_book: '3120'
    period: month
    dimensions: [branch_num]
    target_source:
      form_def: goal-monthly-store
      period_field: period
      dimension_fields:
        branch_num: branch_num
      value_fields:
        sale: target_sale
    actuals:
      sale: lemeng:retail:sales
`

const L1_YAML = `metrics:
  - name: 'lemeng:retail:sales'
    expression: 'sum(fct_retail_sale.sale_amount)'
    grain: [bizday, branch_num]
    owner: p
    tier: experimental
    source: lemeng
    freshness_sla_days: 1
    definition: d
  - name: 'lemeng:goal:monthly_store_sale_sale_rate'
    ratio:
      numerator: 'sum(mart_goal_achievement__monthly_store_sale.actual_sale)'
      denominator: 'sum(mart_goal_achievement__monthly_store_sale.target_sale)'
    grain: [bizday, period, branch_num]
    owner: p
    tier: experimental
    source: lemeng
    freshness_sla_days: 2
    label: l
    definition: d
  - name: 'lemeng:goal:monthly_store_sale_sale_pace'
    ratio:
      numerator: 'sum(mart_goal_achievement__monthly_store_sale.days_elapsed)'
      denominator: 'sum(mart_goal_achievement__monthly_store_sale.total_days)'
    grain: [bizday, period, branch_num]
    owner: p
    tier: experimental
    source: lemeng
    freshness_sla_days: 2
    label: l
    definition: d
`

const CONTRACT = {
  form_def_id: 'goal-monthly-store',
  org: 'acme-org',
  version: 1,
  relationSlug: 'goal_monthly_store',
  columns: [
    { field: 'period', column: 'f_period', kind: 'string', sql_type: 'varchar' },
    { field: 'branch_num', column: 'f_branch_num', kind: 'string', sql_type: 'varchar' },
    { field: 'target_sale', column: 'f_target_sale', kind: 'number', sql_type: 'decimal(18,4)' },
  ],
}

/**
 * 起一个只含生成器输入的最小仓根。
 * @param {{ goals?: string, l1?: string, contract?: object | null }} [opts]
 */
function fixtureRoot(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gen-goal-'))
  mkdirSync(join(root, 'dbt/semantics'), { recursive: true })
  mkdirSync(join(root, CONTRACT_REL_DIR), { recursive: true })
  writeFileSync(join(root, 'dbt/semantics/goals.yml'), opts.goals ?? GOAL_YAML)
  writeFileSync(join(root, 'dbt/semantics/l1_metrics.yml'), opts.l1 ?? L1_YAML)
  if (opts.contract !== null) {
    writeFileSync(join(root, CONTRACT_REL_DIR, 'goal-monthly-store.json'), JSON.stringify(opts.contract ?? CONTRACT, null, 2) + '\n')
  }
  return root
}

/** @type {string[]} */
const tmps = []
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})
/** @param {{ goals?: string, l1?: string, contract?: object | null }} [opts] */
function root(opts) {
  const r = fixtureRoot(opts)
  tmps.push(r)
  return r
}

describe('parseActualExpression（v1 只收可加单关系）', () => {
  it('sum(<关系>.<列>) 解析出关系与列', () => {
    expect(parseActualExpression('sum(fct_retail_sale.sale_amount)')).toEqual({ relation: 'fct_retail_sale', column: 'sale_amount' })
    expect(parseActualExpression('sum( fct_branch_indicator.transfer_money )')).toEqual({ relation: 'fct_branch_indicator', column: 'transfer_money' })
  })
  it('复合/率类/裸列一律返回 null（第二刀才收）', () => {
    expect(parseActualExpression('sum(case when x > 0 then y else 0 end)')).toBeNull()
    expect(parseActualExpression('a / b')).toBeNull()
    expect(parseActualExpression('sum(fct.x) + sum(fct.y)')).toBeNull()
  })
})

describe('normalizeGoal（形状闸）', () => {
  const base = () => ({
    goal: 'acme:monthly_store_sale', label: 'L', org: 'acme-org', system_book: '3120', period: 'month', dimensions: ['branch_num'],
    target_source: { form_def: 'f', period_field: 'period', dimension_fields: { branch_num: 'branch_num' }, value_fields: { sale: 'target_sale' } },
    actuals: { sale: 'lemeng:retail:sales' },
  })
  it('合法声明归一：slug 取冒号后段', () => {
    expect(normalizeGoal(base()).slug).toBe('monthly_store_sale')
  })
  it('goal 不是两段命名空间 ⇒ 抛', () => {
    expect(() => normalizeGoal({ ...base(), goal: 'monthly_store_sale' })).toThrow(/两段/)
  })
  it('period 只支持 month ⇒ 抛', () => {
    expect(() => normalizeGoal({ ...base(), period: 'week' })).toThrow(/period/)
  })
  it('dimensions 不是 [branch_num] ⇒ 抛', () => {
    expect(() => normalizeGoal({ ...base(), dimensions: ['branch_num', 'category'] })).toThrow(/dimensions/)
  })
  it('value_fields 与 actuals 键集不等 ⇒ 抛', () => {
    expect(() => normalizeGoal({ ...base(), actuals: { sale: 'lemeng:retail:sales', other: 'x:y:z' } })).toThrow(/键集/)
  })
  it('scope.assessed_war_zone_only 声明即拒（v1 未实现，不许静默不生效）', () => {
    expect(() => normalizeGoal({ ...base(), scope: { assessed_war_zone_only: true } })).toThrow(/未实现/)
  })
  it('缺 system_book ⇒ 抛（两本账套门店号重叠，必须钉住）', () => {
    const { system_book: _omit, ...b } = base()
    expect(() => normalizeGoal(b)).toThrow(/system_book/)
  })
})

describe('buildStageOneSql（DuckDB 段：只碰 parquet、无 join）', () => {
  const goal = normalizeGoal(JSON.parse(JSON.stringify({
    goal: 'acme:monthly_store_sale', label: 'L', org: 'acme-org', system_book: '3120', period: 'month', dimensions: ['branch_num'],
    target_source: { form_def: 'goal-monthly-store', period_field: 'period', dimension_fields: { branch_num: 'branch_num' }, value_fields: { sale: 'target_sale' } },
    actuals: { sale: 'lemeng:retail:sales' },
  })))
  const sql = buildStageOneSql(goal, CONTRACT)

  it('按 form_def_id 过滤 + read_parquet + r[列] 取列形态', () => {
    expect(sql).toContain("r['form_def_id'] = 'goal-monthly-store'")
    expect(sql).toContain('from read_parquet(')
    expect(sql).toContain("r['payload']")
    expect(sql).toContain("r['submission_id']::bigint")
    expect(sql).toContain("{{ subject_org() }} as org")
  })
  it('payload 逐字段提取：文本直取、数值显式 cast 到契约 sql_type', () => {
    expect(sql).toContain("json_extract_string(r['payload'], '$.period') as period")
    expect(sql).toContain("json_extract_string(r['payload'], '$.branch_num') as branch_num")
    expect(sql).toContain("cast(json_extract_string(r['payload'], '$.target_sale') as decimal(18,4)) as target_sale")
  })
  it('**代码位无 join**（数据面正典 B1；注释里说「无 join」不算）', () => {
    expect(maskSqlComments(sql)).not.toMatch(/\bjoin\b/i)
  })
  it('字段不在契约里 / 类型不对 ⇒ 抛', () => {
    expect(() => buildStageOneSql(goal, { columns: [] })).toThrow(/不在契约/)
    const badContract = { columns: [{ field: 'period', column: 'f_period', kind: 'string', sql_type: 'varchar' },
      { field: 'branch_num', column: 'f_branch_num', kind: 'string', sql_type: 'varchar' },
      { field: 'target_sale', column: 'f_target_sale', kind: 'boolean', sql_type: 'boolean' }] }
    expect(() => buildStageOneSql(goal, badContract)).toThrow(/number\/integer/)
  })
})

describe('buildAchievementSql（PG 原生段）', () => {
  const setup = () => {
    const r = root()
    return { goal: readGoals(r)[0], l1: readL1Index(r) }
  }
  const { goal, l1 } = setup()
  const sql = buildAchievementSql(goal, l1)

  it('relation 名：stg_goal_values__<slug> / mart_goal_achievement__<slug>', () => {
    expect(stageOneRelation(goal)).toBe('stg_goal_values__monthly_store_sale')
    expect(martRelation(goal)).toBe('mart_goal_achievement__monthly_store_sale')
    expect(sql).toContain("{{ ref('stg_goal_values__monthly_store_sale') }}")
  })
  it('actuals 的关系来自 l1 的 expression 解析（ref 而不是手写表名）', () => {
    expect(sql).toContain("{{ ref('fct_retail_sale') }} f")
    expect(sql).toContain('sum(f.sale_amount)')
  })
  it('纯 PG join：段① ⨝ actuals ⨝ coverage，三态 data_status 与达成率/进度列齐', () => {
    expect(sql).toMatch(/left join actual_sale a_sale using \(period, branch_num\)/)
    expect(sql).toMatch(/left join coverage c using \(period, branch_num\)/)
    expect(sql).toContain("when coalesce(c.covered_days, 0) >= g.days_elapsed then 'complete'")
    expect(sql).toContain("else 'missing'")
    expect(sql).toContain('as sale_achievement_rate')
    expect(sql).toContain('as progress_rate')
    expect(sql).toContain('{{ shanghai_today() }}')
  })
  it('target=0 ⇒ 达成率 NULL（case when > 0，不留 0/0 错误）', () => {
    expect(sql).toContain('case when g.target_sale > 0 then')
  })
  it('账套钉死：actuals 与覆盖度三处都按 goal.system_book 过滤，并把 system_book 作为列输出', () => {
    // 每条 actual CTE 一处 + coverage 一处（本夹具 1 个 metric ⇒ 2 处）
    expect(sql.match(/where f\.system_book = '3120'/g) ?? []).toHaveLength(Object.keys(goal.actuals).length + 1)
    expect(sql).toContain("'3120'::varchar as system_book")
    expect(sql).toContain('g.system_book')
  })
  it('actuals 引用的指标不在 l1 ⇒ 抛；率类/复合 ⇒ 抛', () => {
    const g2 = { ...goal, actuals: { sale: 'lemeng:nope:none' } }
    expect(() => buildAchievementSql(g2, l1)).toThrow(/不在 dbt\/semantics\/l1_metrics.yml/)
    const l1ratio = new Map(l1)
    l1ratio.set('lemeng:retail:sales', { ratio: { numerator: 'a', denominator: 'b' } })
    expect(() => buildAchievementSql(goal, l1ratio)).toThrow(/率类/)
  })
})

describe('assertGoalMetricsDeclared（生成的列 ↔ 手写指标的咬合）', () => {
  const setup = () => {
    const r = root()
    return { goal: readGoals(r)[0], l1: readL1Index(r) }
  }
  it('两条指标齐且引用生成列 ⇒ 过', () => {
    const { goal, l1 } = setup()
    expect(() => assertGoalMetricsDeclared(goal, l1)).not.toThrow()
  })
  it('缺一条 ⇒ 点名（指标名规则 <源>:<域>:<slug>_<metric>_<kind>；kind 用短后缀 rate/pace）', () => {
    const { goal, l1 } = setup()
    l1.delete(goalMetricName(goal, 'sale', 'pace'))
    expect(() => assertGoalMetricsDeclared(goal, l1)).toThrow(/lemeng:goal:monthly_store_sale_sale_pace/)
  })
  it('ratio 引用了错的列 ⇒ 抛', () => {
    const { goal, l1 } = setup()
    l1.set(goalMetricName(goal, 'sale', 'rate'), {
      ratio: { numerator: 'sum(x.actual_nope)', denominator: 'sum(x.target_nope)' },
    })
    expect(() => assertGoalMetricsDeclared(goal, l1)).toThrow(/actual_sale \/ target_sale/)
  })
})

describe('runGenerate（生成物 == committed；孤儿不越界）', () => {
  it('首次生成 → --check OK → 手改产物 ⇒ --check 红 → 重新生成复原', () => {
    const r = root()
    expect(runGenerate(r)).toBe(0)
    expect(runGenerate(r, { check: true })).toBe(0)
    const p = join(r, MODEL_REL_DIR, 'mart_goal_achievement__monthly_store_sale.sql')
    writeFileSync(p, readFileSync(p, 'utf8') + '-- hand edit\n')
    expect(runGenerate(r, { check: true })).toBe(1)
    expect(runGenerate(r)).toBe(0)
    expect(runGenerate(r, { check: true })).toBe(0)
  })
  it('孤儿产物被 --check 点名、默认模式删除（只删本命名空间，别人的文件不动）', () => {
    const r = root()
    runGenerate(r)
    const orphan = join(r, MODEL_REL_DIR, 'stg_goal_values__orphan.sql')
    const foreign = join(r, MODEL_REL_DIR, 'someones_other_model.sql')
    writeFileSync(orphan, 'select 1\n')
    writeFileSync(foreign, 'select 2\n')
    expect(runGenerate(r, { check: true })).toBe(1)
    expect(runGenerate(r)).toBe(0)
    expect(() => readFileSync(orphan, 'utf8')).toThrow()
    expect(readFileSync(foreign, 'utf8')).toBe('select 2\n')
  })
})
