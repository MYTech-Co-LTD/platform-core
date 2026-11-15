import { describe, expect, it } from 'vitest'
import {
  applyLayoutToPanels, applyLayoutToRaw, layoutItemsOf, layoutKeysOf, validateLayoutItems,
} from './report-layout'

const p = (title: string, chart = 'line', page?: number, span = 12) =>
  ({ chart, title, span, ...(page === undefined ? {} : { page }) })

describe('layoutKeysOf（面板身份键）', () => {
  it('page|chart|title；重复同键按出现次序加 #n', () => {
    expect(layoutKeysOf([p('销售'), p('销售', 'bar'), p('销售'), p('明细', 'table', 2)]))
      .toEqual(['1|line|销售', '1|bar|销售', '1|line|销售#2', '2|table|明细'])
  })

  it('缺省 page 视为 1（与渲染口径一致）', () => {
    expect(layoutKeysOf([p('A', 'kpi', undefined)])).toEqual(['1|kpi|A'])
  })
})

describe('validateLayoutItems', () => {
  it('接受 1..24 的整数 span', () => {
    expect(validateLayoutItems([{ key: 'k', span: 24 }])).toEqual([{ key: 'k', span: 24 }])
  })
  it('拒绝空、越界、小数、重复键、超长键', () => {
    for (const bad of [
      [], [{ key: 'k', span: 0 }], [{ key: 'k', span: 25 }], [{ key: 'k', span: 1.5 }],
      [{ key: '', span: 1 }], [{ key: 'x'.repeat(201), span: 1 }],
      [{ key: 'k', span: 1 }, { key: 'k', span: 2 }],
    ]) expect(validateLayoutItems(bad)).toBeNull()
  })
})

describe('applyLayoutToPanels（观看面合并）', () => {
  const panels = [p('A'), p('B'), p('C')]
  const items = layoutItemsOf(panels)

  it('换顺序 + 改宽度', () => {
    const out = applyLayoutToPanels(panels, [
      { key: items[2].key, span: 24 }, { key: items[0].key, span: 8 }, { key: items[1].key, span: 8 },
    ])
    expect(out.stale).toBe(false)
    expect(out.panels.map((x) => x.title)).toEqual(['C', 'A', 'B'])
    expect(out.panels.map((x) => x.span)).toEqual([24, 8, 8])
  })

  it('键集合不一致 ⇒ 原样 + stale（不改数据）', () => {
    const out = applyLayoutToPanels(panels, [{ key: '1|line|X', span: 12 }])
    expect(out).toEqual({ panels, stale: true })
  })

  it('无个人版式 ⇒ 原样且不标 stale', () => {
    expect(applyLayoutToPanels(panels, null)).toEqual({ panels, stale: false })
  })

  it('跨页条目只影响同页次序（页间相对次序不变）', () => {
    const multi = [p('A', 'line', 1), p('B', 'line', 2), p('C', 'line', 1)]
    const out = applyLayoutToPanels(multi, [
      { key: '1|line|C', span: 12 }, { key: '2|line|B', span: 12 }, { key: '1|line|A', span: 12 },
    ])
    expect(out.panels.map((x) => x.title)).toEqual(['C', 'B', 'A'])
    expect(out.stale).toBe(false)
  })
})

describe('applyLayoutToRaw（服务端默认版式）', () => {
  const v1 = {
    panels: [
      { chart: 'line', title: 'A', metricId: 'm1', dims: [], args: {}, span: 12, timeScoped: true },
      { chart: 'kpi', title: 'B', metricId: 'm1', args: {}, span: 12, format: 'number', compare: 'auto', goodDirection: 'none', timeScoped: true },
    ],
  }

  it('v1：只换顺序/改 span，其它字段逐字保留', () => {
    const out = applyLayoutToRaw(v1, [
      { key: '1|kpi|B', span: 6 }, { key: '1|line|A', span: 18 },
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const panels = (out.raw as { panels: Array<Record<string, unknown>> }).panels
    expect(panels.map((x) => x.title)).toEqual(['B', 'A'])
    expect(panels.map((x) => x.span)).toEqual([6, 18])
    expect(panels[1]).toMatchObject({ metricId: 'm1', dims: [], timeScoped: true })
  })

  it('v2：在 blocks 上原地换序，datasets / ir 原样保留', () => {
    const v2 = {
      ir: 2 as const,
      datasets: [{ key: 'd1', metricId: 'm1', dims: [], args: {}, timeScoped: true }],
      blocks: [
        { type: 'kpi' as const, dataset: 'd1', title: 'A', format: 'number' as const, compare: 'auto' as const, goodDirection: 'none' as const, span: 12 },
        { type: 'chart' as const, chart: 'line' as const, dataset: 'd1', title: 'B', span: 12 },
      ],
    }
    const out = applyLayoutToRaw(v2, [
      { key: '1|line|B', span: 24 }, { key: '1|kpi|A', span: 12 },
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const raw = out.raw as typeof v2
    expect(raw.ir).toBe(2)
    expect(raw.datasets).toEqual(v2.datasets)
    expect(raw.blocks.map((b) => b.title)).toEqual(['B', 'A'])
    expect(raw.blocks[0]).toMatchObject({ type: 'chart', chart: 'line', dataset: 'd1', span: 24 })
  })

  it('键集合不一致 ⇒ LAYOUT_STALE', () => {
    expect(applyLayoutToRaw(v1, [{ key: '1|line|X', span: 12 }])).toEqual({ ok: false, code: 'LAYOUT_STALE' })
  })

  it('形状不合法 ⇒ LAYOUT_INVALID / INVALID_SPEC', () => {
    expect(applyLayoutToRaw(v1, [{ key: '1|line|A', span: 0 }])).toEqual({ ok: false, code: 'LAYOUT_INVALID' })
    expect(applyLayoutToRaw({ nope: true }, [{ key: 'k', span: 12 }])).toEqual({ ok: false, code: 'INVALID_SPEC' })
  })
})
