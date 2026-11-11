import { describe, expect, it } from 'vitest'
import { anchorMatches, buildEvidencePack } from './evidence'
import type { EvidenceInput } from './evidence'

const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  metricId: 'lemeng:retail:net_sales',
  params: { bizday: { from: '2026-11-01', to: '2026-11-05' } },
  slicing: { dimensions: ['branch_num'] },
  value: 123456.78,
  sql: 'select sum(net_amount) from staging.fct_retail_sale where org = $1',
  dataAsOf: '2026-11-05',
  freshness: { status: 'normal', slaDays: 2 },
  caliber: { tier: 'certified', basis: 'l1_tree', certifiedBy: 'data-platform', version: 7 },
  reconcile: { auditFile: 'audit_lemeng__retail__net_sales.sql', status: 'ok', executedAt: '2026-11-06T03:00:00.000Z' },
  ...over,
})

describe('buildEvidencePack（W6 Task 1：证据包契约）', () => {
  it('带齐锚点 / 口径 / 数据截至 / 对账四块，sqlPreview 缺省等于 sql', () => {
    const pack = buildEvidencePack(base())
    expect(pack.anchor.metricId).toBe('lemeng:retail:net_sales')
    expect(pack.anchor.value).toBe(123456.78)
    expect(pack.caliber.tier).toBe('certified')
    expect(pack.dataAsOf).toBe('2026-11-05')
    expect(pack.reconcile.status).toBe('ok')
    expect(pack.sqlPreview).toBe(pack.sql)
  })

  it('dataAsOf 缺失 ⇒ 新鲜度强制 unknown（不冒充最新，也不冒充 SLA 正常）', () => {
    const pack = buildEvidencePack(base({ dataAsOf: null, freshness: { status: 'normal', slaDays: 2 } }))
    expect(pack.dataAsOf).toBeNull()
    expect(pack.freshness.status).toBe('unknown')
  })

  it('对账状态原样透传：missing 不会被写成 ok', () => {
    const pack = buildEvidencePack(base({ reconcile: { auditFile: null, status: 'missing', executedAt: null } }))
    expect(pack.reconcile).toEqual({ auditFile: null, status: 'missing', executedAt: null })
  })

  it('generatedAt 用注入时钟（可复算：同一输入同一输出）', () => {
    const now = new Date('2026-11-06T04:00:00.000Z')
    expect(buildEvidencePack(base({ now })).generatedAt).toBe('2026-11-06T04:00:00.000Z')
  })
})

describe('anchorMatches（锚点对账，容差 0.1%）', () => {
  it('边界：相对差恰为 0.001 通过，0.0011 不通过', () => {
    expect(anchorMatches(1000, 1001)).toBe(true)
    expect(anchorMatches(1000, 1001.1)).toBe(false)
  })

  it('负向差同样按绝对值判', () => {
    expect(anchorMatches(1000, 999)).toBe(true)
    expect(anchorMatches(1000, 998)).toBe(false)
  })

  it('基线为 0：只有 0 对得上（分母用 1e-9 兜底，不产生 NaN）', () => {
    expect(anchorMatches(0, 0)).toBe(true)
    expect(anchorMatches(0, 2)).toBe(false)
  })

  it('任一侧缺失 / 非有限数 ⇒ false（不猜、不当作通过）', () => {
    expect(anchorMatches(null, 1)).toBe(false)
    expect(anchorMatches(1, null)).toBe(false)
    expect(anchorMatches(Number.NaN, 1)).toBe(false)
    expect(anchorMatches(1, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('容差可显式放宽（验收脚本按需覆盖）', () => {
    expect(anchorMatches(1000, 1009, 0.01)).toBe(true)
  })
})
