import { describe, expect, it } from 'vitest'
import { buildPipelineFlow } from './flow'

const DOC = {
  id: 'lemeng.retail_order_line.l0.3120',
  name: 'lemeng.retail_order_line.l0.3120',
  nodes: [
    { id: 'src', type: 'source', data: { componentId: 'src.rest', label: '订单明细（键集游标）', properties: {
      method: 'POST', url: '${ENV:LEMENG_API_BASE}/agi/api/nhsoft.retail.ai.pos.posorder.find',
      paginationType: 'keyset', incrementalField: 'order_time',
    } } },
    { id: 'foreach', type: 'ctl', data: { componentId: 'ctl.foreach', label: '逐账套展开', properties: { items: { '3120': 1, '64188': 2 } } } },
    { id: 'shape', type: 'code', data: { componentId: 'code.sql', label: '按契约裁剪 25 列', properties: { sql: 'select 1\nfrom x' } } },
    { id: 'gate', type: 'qa', data: { componentId: 'qa.contract', label: '列集校验', properties: { assertion: 'columns' } } },
    { id: 'sink', type: 'sink', data: { componentId: 'snk.minio', label: '落湖', properties: { key: 'lemeng/retail_order_line/', format: 'parquet' } } },
  ],
  edges: [
    { source: 'src', target: 'foreach' },
    { source: 'foreach', target: 'shape' },
    { source: 'shape', target: 'gate' },
    { source: 'gate', target: 'sink' },
  ],
}

const STATS = new Map([
  ['src', { rows: 2000, durationMs: 1200 }],
  ['gate', { rows: 2000, durationMs: 40 }],
  ['sink', { rows: 2000, durationMs: 400 }],
])

describe('buildPipelineFlow', () => {
  it('按拓扑序排步骤，组件翻译成人话', () => {
    const f = buildPipelineFlow('p', DOC, STATS)
    expect(f.steps.map((s) => s.id)).toEqual(['src', 'foreach', 'shape', 'gate', 'sink'])
    expect(f.steps.map((s) => s.kind)).toEqual([
      '取数（接口）', '逐账套展开', '加工（SQL）', '校验（契约）', '落湖（对象存储）',
    ])
    expect(f.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5])
  })

  it('参数摘要可读，且不泄露环境值（${ENV:…} 只落成路径）', () => {
    const f = buildPipelineFlow('p', DOC)
    const src = f.steps[0]!
    expect(src.detail).toContain('POST')
    expect(src.detail).toContain('/agi/api/nhsoft.retail.ai.pos.posorder.find')
    expect(src.detail).toContain('分页 keyset')
    expect(src.detail).not.toContain('${ENV')
    expect(f.steps[4]!.detail).toContain('lemeng/retail_order_line/')
    expect(f.steps[1]!.detail).toBe('2 项')
  })

  it('收据里没有的节点照常列出，只是没有运行数字', () => {
    const f = buildPipelineFlow('p', DOC, STATS)
    expect(f.steps[1]!.stat).toBeUndefined()
    expect(f.unmatched).toBe(2) // foreach + shape
    expect(f.steps[0]!.stat).toEqual({ rows: 2000, durationMs: 1200 })
  })

  it('未登记组件原样显示组件名（不编类别）', () => {
    const f = buildPipelineFlow('p', { nodes: [{ id: 'x', data: { componentId: 'acme.custom' } }], edges: [] })
    expect(f.steps[0]!.kind).toBe('acme.custom')
  })

  it('连续的同型节点合并成一步（96 个 page 不逐行刷屏），行数与耗时相加', () => {
    const nodes = ['p1', 'p2', 'p3'].map((id, i) => ({
      id, data: { componentId: 'src.rest', label: `page ${i + 1}`, properties: { method: 'POST', url: '/x' } },
    }))
    const doc = {
      nodes: [...nodes, { id: 'sink', data: { componentId: 'snk.minio', label: '落湖', properties: { key: 'k' } } }],
      edges: [{ source: 'p1', target: 'p2' }, { source: 'p2', target: 'p3' }, { source: 'p3', target: 'sink' }],
    }
    const stats = new Map([['p1', { rows: 10 }], ['p2', { rows: 20 }], ['p3', { rows: 30 }]])
    const f = buildPipelineFlow('p', doc, stats)
    expect(f.steps).toHaveLength(2)
    expect(f.steps[0]!.count).toBe(3)
    expect(f.steps[0]!.stat?.rows).toBe(60)
    expect(f.steps.map((s) => s.step)).toEqual([1, 2])
  })

  it('不同落点/不同接口的节点不会被合并', () => {
    const doc = {
      nodes: [
        { id: 'a', data: { componentId: 'src.rest', label: 'A', properties: { url: '/a' } } },
        { id: 'b', data: { componentId: 'src.rest', label: 'B', properties: { url: '/b' } } },
      ],
      edges: [{ source: 'a', target: 'b' }],
    }
    const f = buildPipelineFlow('p', doc)
    expect(f.steps).toHaveLength(2)
    expect(f.steps[0]!.count).toBeUndefined()
  })

  it('参数摘要不外露占位符（${ENV:…} / ${VAR} 都落成 …）', () => {
    const f = buildPipelineFlow('p', {
      nodes: [{ id: 'sink', data: { componentId: 'snk.minio', label: '落湖', properties: {
        key: 'lemeng/wholesale_out/system_book=${ENV:SYSTEM_BOOK}/bizday=${BIZDAY}/',
      } } }],
      edges: [],
    })
    const detail = f.steps[0]!.detail ?? ''
    expect(detail).toContain('…')
    expect(detail).not.toContain('${')
    expect(detail).not.toContain('SYSTEM_BOOK')
  })

  it('裸节点 id（w0 / g3）不当 label 展示', () => {
    const f = buildPipelineFlow('p', {
      nodes: [{ id: 'w0', data: { componentId: 'code.sql' } }, { id: 'x', data: { componentId: 'qa.contract', label: '列集校验' } }],
      edges: [],
    })
    expect(f.steps[0]!.label).toBe('')
    expect(f.steps[1]!.label).toBe('列集校验')
  })

  it('拓扑序容忍环：剩下的按定义顺序补在后面', () => {
    const f = buildPipelineFlow('p', {
      nodes: [{ id: 'a', data: { componentId: 'code.sql' } }, { id: 'b', data: { componentId: 'qa.contract' } }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    })
    expect(f.steps.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
})
