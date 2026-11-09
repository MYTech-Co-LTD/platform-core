// declaration-compiler.test.ts — 租户声明编译/校验的纯核（W8，无 DB）。
//
// 钉的是「写前六道校验里可纯判的部分」：形状、表达式解析、relation 白名单、掩码形状、
// 实体引用、tier 不自升。列存在性/EXPLAIN 需要 warehouse，留给路由级测试与真机。
import { describe, expect, it } from 'vitest'
import { compileTenantDeclaration } from './declaration-compiler'

const CTX = {
  allowedRelations: new Set(['fct_retail_sale']),
  entities: new Set(['branch']),
}

const base = {
  name: 'tenant:retail:gross_sales',
  label: '本租户销售额',
  definition: '本租户口径的销售额',
  owner: 'data-platform',
  tier: 'experimental',
  source: 'lemeng',
  expression: 'sum(fct_retail_sale.sale_amount)',
  grain: ['system_book', 'bizday'],
  freshness_sla_days: 2,
  sources: ['s3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/all.parquet'],
}

describe('compileTenantDeclaration', () => {
  it('合法声明 → 物化形状（select_sql/params/totalable/freshness 与 L1 同源）', () => {
    const r = compileTenantDeclaration(base, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.compiled.id).toBe('tenant:retail:gross_sales')
    expect(r.compiled.selectSql).toBe('select sum(fct_retail_sale.sale_amount) as value, system_book, bizday from fct_retail_sale')
    expect(r.compiled.params).toEqual({
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
    })
    expect(r.compiled.totalable).toBe(true)
    expect(r.compiled.freshnessRelations).toEqual(['stg_lemeng_retail_order_line'])
  })

  it('缺必填 / 坏名字 / 空 grain 逐条拒', () => {
    const r = compileTenantDeclaration({ ...base, name: 'Bad Name', owner: '', grain: [] }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const paths = r.issues.map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['name', 'owner', 'grain']))
  })

  it('B11：relation 不在 L1 已用集合 → 拒', () => {
    const r = compileTenantDeclaration({ ...base, expression: 'sum(secret_table.amount)' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'expression' && i.message.includes('B11'))).toBe(true)
  })

  it('v1 不支持 ratio；tier 不许自升 certified', () => {
    const r = compileTenantDeclaration({ ...base, ratio: { numerator: 'a', denominator: 'b' }, tier: 'certified' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['ratio', 'tier']))
  })

  it('mask：granted_by 必填、column 必须在 select_sql 里、round 必须有 step', () => {
    const r = compileTenantDeclaration({
      ...base,
      mask: [
        { column: 'fct_retail_sale.sale_amount', kind: 'round' },
        { column: 'fct_retail_sale.not_in_sql', kind: 'nullify', granted_by: 'data:cost' },
      ],
    }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const paths = r.issues.map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining([
      'mask[0].granted_by', 'mask[0].step', 'mask[1].column',
    ]))
  })

  it('mask 合法 → 规范化成 MaskSpec（含 grantedBy/step）', () => {
    const r = compileTenantDeclaration({
      ...base,
      mask: [{ column: 'fct_retail_sale.sale_amount', kind: 'round', step: 2, granted_by: 'data:cost' }],
    }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.compiled.masks).toEqual([
      { column: 'fct_retail_sale.sale_amount', kind: 'round', step: 2, grantedBy: 'data:cost' },
    ])
  })

  it('entity 必须在 entities 声明里；scope_note 声明了不能为空', () => {
    const r = compileTenantDeclaration({ ...base, entity: 'unknown_obj', scope_note: '  ' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['entity', 'scope_note']))
  })

  it('列存在性（columnsOf 给出时）：不存在的列被拒', () => {
    const r = compileTenantDeclaration(base, {
      ...CTX,
      columnsOf: () => new Set(['sale_amount', 'system_book']),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('bizday'))).toBe(true)
  })
})
