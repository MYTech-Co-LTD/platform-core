// gen-forms-data-projection.test.mjs — 件① 生成器（#2706）的纯函数与 CLI 契约单测。
// 生成器本体 = scripts/gen-forms-data-projection.mjs（骨架照 gen-data-projection：生成物==committed）。
import { describe, expect, it } from 'vitest'

// 注释掩码与门禁同源（lib 单一事实源）：无 join 断言只看代码位——头注释里「无 join」三个字不算数
import { maskSqlComments } from './lib/data-contract.mjs'
import {
  CONTRACT_REL_DIR,
  DATA_PLANE_KINDS,
  EXTRACT,
  MODEL_REL_DIR,
  SQL_TYPE,
  buildContract,
  buildModelSql,
  fieldsOfBody,
  kindOf,
  relationSlug,
} from './gen-forms-data-projection.mjs'

const form = {
  org: 'acme',
  assetId: 'goal-monthly-store',
  version: 1,
  slug: 'goal-monthly-store',
  fields: [
    { field: 'branch_num', column: 'f_branch_num', kind: 'string' },
    { field: 'period', column: 'f_period', kind: 'string' },
    { field: 'target_sale', column: 'f_target_sale', kind: 'number' },
    { field: 'target_outbound', column: 'f_target_outbound', kind: 'number' },
  ],
}

describe('relationSlug / kindOf / fieldsOfBody（映射与 storage.listDataPlaneForms 同构）', () => {
  it('relationSlug：assetId 的 - 转 _（relation 名与 L1 引用同一规则）', () => {
    expect(relationSlug('goal-monthly-store')).toBe('goal_monthly_store')
    expect(relationSlug('ops-round-2026-11')).toBe('ops_round_2026_11')
    expect(relationSlug('plain')).toBe('plain')
  })

  it('kindOf：date/enum 优先，其余四类型直映，白名单外给 null', () => {
    expect(kindOf({ type: 'string', format: 'date' })).toBe('date')
    expect(kindOf({ type: 'string', enum: ['a', 'b'] })).toBe('enum')
    expect(kindOf({ type: 'string' })).toBe('string')
    expect(kindOf({ type: 'number' })).toBe('number')
    expect(kindOf({ type: 'integer' })).toBe('integer')
    expect(kindOf({ type: 'boolean' })).toBe('boolean')
    // int 枚举按基础类型提取（闸侧同判：枚举只挂 string）
    expect(kindOf({ type: 'integer', enum: [1, 2] })).toBe('integer')
    expect(kindOf({ type: 'array', items: { type: 'string' } })).toBeNull()
    expect(kindOf({ enum: ['a'] })).toBeNull()
    expect(kindOf({})).toBeNull()
  })

  it('DATA_PLANE_KINDS / SQL_TYPE / EXTRACT 键集一致（漂开 ⇒ 生成器静默缺列）', () => {
    const basic = Object.keys(DATA_PLANE_KINDS)
    for (const k of basic) expect(SQL_TYPE[/** @type {keyof typeof SQL_TYPE} */ (k)], `SQL_TYPE[${k}]`).toBeTruthy()
    for (const k of Object.keys(SQL_TYPE)) {
      expect(EXTRACT[/** @type {keyof typeof EXTRACT} */ (k)], `EXTRACT[${k}]`).toBeTypeOf('function')
    }
  })

  it('fieldsOfBody：schema.properties → fields（f_ 前缀列名）；映不出 kind 的字段剔除', () => {
    const fields = fieldsOfBody({
      schema: {
        type: 'object',
        properties: {
          store_name: { type: 'string' },
          biz_date: { type: 'string', format: 'date' },
          grade: { type: 'string', enum: ['a', 'b'] },
          ghost: { type: 'array', items: { type: 'string' } },
        },
      },
    })
    expect(fields).toEqual([
      { field: 'store_name', column: 'f_store_name', kind: 'string' },
      { field: 'biz_date', column: 'f_biz_date', kind: 'date' },
      { field: 'grade', column: 'f_grade', kind: 'enum' },
    ])
    expect(fieldsOfBody({ schema: { type: 'object' } })).toEqual([])
    expect(fieldsOfBody({})).toEqual([])
  })
})

describe('buildContract（字段→列/类型映射；生成物 == committed 的事实源）', () => {
  it('字段→列/类型映射（含 relationSlug：- 转 _ 锁定 relation 名规则）', () => {
    expect(buildContract(form)).toEqual({
      form_def_id: 'goal-monthly-store',
      org: 'acme',
      version: 1,
      relationSlug: 'goal_monthly_store',
      columns: [
        { field: 'branch_num', column: 'f_branch_num', kind: 'string', sql_type: 'varchar' },
        { field: 'period', column: 'f_period', kind: 'string', sql_type: 'varchar' },
        { field: 'target_sale', column: 'f_target_sale', kind: 'number', sql_type: 'decimal(18,4)' },
        { field: 'target_outbound', column: 'f_target_outbound', kind: 'number', sql_type: 'decimal(18,4)' },
      ],
    })
  })

  it('全 kind 的 sql_type 映射（date=date / integer=bigint / boolean=boolean / enum=varchar）', () => {
    const c = buildContract({
      org: 'o', assetId: 'f', version: 2, slug: 'f',
      fields: [
        { field: 'd', column: 'f_d', kind: 'date' },
        { field: 'i', column: 'f_i', kind: 'integer' },
        { field: 'b', column: 'f_b', kind: 'boolean' },
        { field: 'e', column: 'f_e', kind: 'enum' },
      ],
    })
    expect(/** @type {{ columns: Array<{ sql_type: string }> }} */ (c).columns.map((x) => x.sql_type))
      .toEqual(['date', 'bigint', 'boolean', 'varchar'])
  })
})

describe('buildModelSql（DuckDB 段只碰 parquet；r[列] 形态；无 join）', () => {
  it('read_parquet + form_def_id 过滤 + json_extract_string + r[列] 形态', () => {
    const sql = buildModelSql(form)
    expect(sql).toContain("r['form_def_id'] = 'goal-monthly-store'")
    expect(sql).toContain("json_extract_string(r['payload'], '$.branch_num')")
    expect(sql).toContain("cast(json_extract_string(r['payload'], '$.target_sale') as decimal(18,4)) as f_target_sale")
    expect(sql).toContain('from read_parquet(')
    // 头列六件套 + org 注入（主体列；authz 谓词着力点）
    expect(sql).toContain("r['batch_id']::varchar as batch_id")
    expect(sql).toContain('{{ subject_org() }} as org')
    expect(sql).toContain("r['bizday']::date as bizday")
    expect(sql).toContain("r['submission_id']::bigint as submission_id")
    expect(sql).toContain("r['form_def_id']::varchar as form_def_id")
    expect(sql).toContain("r['submitted_at']::timestamptz as submitted_at")
  })

  it('路径走 dbt var（不写死 bucket/前缀）；模型名归一（- 转 _）', () => {
    const sql = buildModelSql(form)
    expect(sql).toContain('s3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}')
    expect(sql).toContain('stg_forms_submission__goal_monthly_store')
  })

  it('无 join（B1：DuckDB 段只碰 parquet，join 拆 PG 原生模型）', () => {
    const sql = maskSqlComments(buildModelSql(form)).toLowerCase()
    expect(sql).not.toMatch(/\bjoin\b/)
  })

  it('boolean 提取 = json_extract_string in (true,1)；integer/enum 各用其形态', () => {
    const sql = buildModelSql({
      org: 'o', assetId: 'f', version: 1, slug: 'f',
      fields: [
        { field: 'done', column: 'f_done', kind: 'boolean' },
        { field: 'qty', column: 'f_qty', kind: 'integer' },
        { field: 'grade', column: 'f_grade', kind: 'enum' },
        { field: 'biz_date', column: 'f_biz_date', kind: 'date' },
      ],
    })
    expect(sql).toContain("(json_extract_string(r['payload'], '$.done') in ('true','1')) as f_done")
    expect(sql).toContain("cast(json_extract_string(r['payload'], '$.qty') as bigint) as f_qty")
    expect(sql).toContain("json_extract_string(r['payload'], '$.grade') as f_grade")
    expect(sql).toContain("cast(json_extract_string(r['payload'], '$.biz_date') as date) as f_biz_date")
  })
})
