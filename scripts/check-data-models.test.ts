// check-data-models.test.ts — 门禁规则 ⑤ ratio 扩展的**纯核**单测（对真仓的整仓扫描由 CI gates
// 跑脚本本身覆盖，这里只钉 `ratioShapeError` 的判定行为）。
// 契约（spec 2026-10-12 §5.3/§5.4）：率类声明走 `ratio: {numerator, denominator}`，与 expression
// 互斥；分子分母各含 ≥1 个「关系.列」引用且必须同关系（单 FROM 约束的声明面）；不许带分号。
import { describe, expect, it } from 'vitest'
import { ratioShapeError } from './check-data-models.mjs'

describe('规则 ⑤ ratio 形状（ratioShapeError 纯核）', () => {
  const base = {
    name: 'lemeng:retail:test_rate',
    definition: 'x',
    grain: ['a'],
    owner: 'o',
    tier: 'experimental',
    source: 'lemeng',
  }

  it('ratio 与 expression 互斥（两处各写一份口径 = 口径分叉）', () => {
    expect(ratioShapeError({
      ...base, expression: 'sum(f.x)',
      ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' },
    })).toMatch(/互斥/)
  })

  it('缺分子或分母 → 报缺的那一项', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)' } })).toMatch(/denominator|分母/)
    expect(ratioShapeError({ ...base, ratio: { denominator: 'sum(f.y)' } })).toMatch(/numerator|分子/)
  })

  it('分子分母必须各含「关系.列」且同关系（单 FROM）', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(x)', denominator: 'sum(f.y)' } }))
      .toMatch(/关系/)
    expect(ratioShapeError({
      ...base, ratio: { numerator: 'sum(a.x)', denominator: 'sum(b.y)' },
    })).toMatch(/多个关系|同关系/)
  })

  it('含分号 → 报错（声明只写聚合表达式）', () => {
    expect(ratioShapeError({
      ...base, ratio: { numerator: 'sum(f.x);', denominator: 'sum(f.y)' },
    })).toMatch(/分号/)
  })

  it('合法 ratio → null；纯 expression 声明 → null', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' } })).toBeNull()
    expect(ratioShapeError({ ...base, expression: 'sum(f.x)' })).toBeNull()
  })

  it('两者都不给 → 报错（必填缺口在 ratio 路径下的兜底）', () => {
    expect(ratioShapeError({ ...base })).toMatch(/expression|ratio/)
  })
})
