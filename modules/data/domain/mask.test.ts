import { describe, expect, it } from 'vitest'
import { maskedSelectSql } from './mask'

const SEL = 'select sum(fct_x.net_amount) as value, bizday from fct_x'
const R = (spec: string) => ({ column: 'fct_x.net_amount', kind: 'round' as const, step: 1000, grantedBy: 'data:precise', ...JSON.parse(spec) })

describe('maskedSelectSql（spec §5.3）', () => {
  it('有 grantedBy ⇒ 原样返回、applied 为空', () => {
    const r = maskedSelectSql(SEL, [R('{}')], () => true)
    expect(r.sql).toBe(SEL)
    expect(r.applied).toEqual({})
  })

  it('无 grantedBy ⇒ 列引用被包成 round(…, -step)（掩码在聚合内部）', () => {
    const r = maskedSelectSql(SEL, [R('{}')], () => false)
    expect(r.sql).toBe('select sum(round(fct_x.net_amount, -1000)) as value, bizday from fct_x')
    expect(r.applied).toEqual({ 'fct_x.net_amount': 'round:1000' })
  })

  it('nullify ⇒ 列引用换成 typed NULL（sum(NULL) 会报错，必须带类型）', () => {
    const r = maskedSelectSql(SEL, [R('{"kind":"nullify"}')], () => false)
    expect(r.sql).toBe('select sum(cast(null as numeric)) as value, bizday from fct_x')
    expect(r.applied).toEqual({ 'fct_x.net_amount': 'nullify' })
  })

  it('词边界：cost 不许命中 cost_money（子串误伤 = 把没声明的列也掩了）', () => {
    const sql = 'select sum(a.cost) + sum(a.cost_money) as value from a'
    const r = maskedSelectSql(sql, [{ column: 'a.cost', kind: 'round', step: 1000, grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select sum(round(a.cost, -1000)) + sum(a.cost_money) as value from a')
  })

  it('列引用不在 selectSql 里 ⇒ 不改、applied 为空（L2 编译已展开的情形）', () => {
    const r = maskedSelectSql('select sum(a.other) as value from a', [{ column: 'a.cost', kind: 'round', step: 1000, grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select sum(a.other) as value from a')
    expect(r.applied).toEqual({})
  })

  it('★ 整值掩码（column=null）⇒ 把 `… as value` 的表达式整个换掉（默认档用它）', () => {
    const r = maskedSelectSql(SEL, [{ column: null, kind: 'nullify', grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select cast(null as numeric) as value, bizday from fct_x')
    expect(r.applied).toEqual({ '<value>': 'nullify' })
  })

  it('整值掩码在有 grantedBy 时也不改', () => {
    expect(maskedSelectSql(SEL, [{ column: null, kind: 'nullify', grantedBy: 'p' }], () => true).sql).toBe(SEL)
  })

  it('多条掩码各自独立生效（两个不同列、不同 step）', () => {
    const sql = 'select sum(a.cost) as value, sum(a.price) as extra, bizday from a'
    const r = maskedSelectSql(sql, [
      { column: 'a.cost', kind: 'round', step: 100, grantedBy: 'p' },
      { column: 'a.price', kind: 'round', step: 5000, grantedBy: 'p' },
    ], () => false)
    expect(r.sql).toBe('select sum(round(a.cost, -100)) as value, sum(round(a.price, -5000)) as extra, bizday from a')
    expect(r.applied).toEqual({ 'a.cost': 'round:100', 'a.price': 'round:5000' })
  })
})
