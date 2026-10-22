import { describe, expect, it } from 'vitest'
import { sandboxViolations, validateContractDraft, validatePipelineDraft } from './validate'

const goodPipeline = {
  name: 'lemeng.x.y', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/x/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}
const goodContract = {
  contractVersion: 2, domain: 'lemeng', table: 'x', owner: 'data-platform',
  layout: { prefix: 'lemeng/x', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
  batch: { markerColumn: 'batch_id', type: 'varchar', unique: false },
  columns: [{ name: 'batch_id', type: 'varchar', nullable: false }],
}

describe('validatePipelineDraft', () => {
  it('合法草案零 issue', () => expect(validatePipelineDraft(goodPipeline)).toEqual([]))
  it('缺 name / nodes 非数组 / 无 source / 无 sink ⇒ 各自一条 issue', () => {
    expect(validatePipelineDraft({}).map((i) => i.path)).toContain('name')
    expect(validatePipelineDraft({ name: 'x', nodes: {}, edges: [] }).map((i) => i.path)).toContain('nodes')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio' } }], edges: [] })
      .map((i) => i.message).join()).toContain('source')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 's', type: 'source', data: { componentId: 'src.rest' } }], edges: [] })
      .map((i) => i.message).join()).toContain('sink')
  })
  it('节点 id 重复 / 边指向不存在的节点 / type 非法 ⇒ 定位到具体路径', () => {
    const dup = validatePipelineDraft({
      name: 'x',
      nodes: [{ id: 'a', type: 'source', data: { componentId: 'src.rest' } }, { id: 'a', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/sandbox/x.csv' } } }],
      edges: [],
    })
    expect(dup.some((i) => i.message.includes('重复'))).toBe(true)
    const badEdge = validatePipelineDraft({ ...goodPipeline, edges: [{ source: 's1', target: 'zzz' }] })
    expect(badEdge.some((i) => i.path === 'edges[0].target')).toBe(true)
    const badType = validatePipelineDraft({ ...goodPipeline, nodes: [{ id: 'a', type: 'weird', data: {} }] })
    expect(badType.some((i) => i.message.includes('type'))).toBe(true)
  })
})

describe('validateContractDraft', () => {
  it('合法契约零 issue', () => expect(validateContractDraft(goodContract)).toEqual([]))
  it('contractVersion ≠ 2 / 缺 domain / 非法 layout / 无列 ⇒ 各自一条', () => {
    expect(validateContractDraft({ ...goodContract, contractVersion: 1 }).map((i) => i.path)).toContain('contractVersion')
    expect(validateContractDraft({ ...goodContract, domain: 'Bad-Domain' }).map((i) => i.path)).toContain('domain')
    expect(validateContractDraft({ ...goodContract, layout: { ...goodContract.layout, fileName: 'x.parquet' } })
      .map((i) => i.path)).toContain('layout.fileName')
    expect(validateContractDraft({ ...goodContract, columns: [] }).map((i) => i.path)).toContain('columns')
  })
})

describe('sandboxViolations', () => {
  it('合法沙箱草案零违规', () => expect(sandboxViolations(goodPipeline)).toEqual([]))
  it('湖写入不在 __sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/x/all.parquet' } } }] }
    expect(sandboxViolations(bad).map((i) => i.path)).toEqual(['nodes[0].data.properties.key'])
  })
  it('本地落盘不在 /workspace/logs/sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/x.csv' } } }] }
    expect(sandboxViolations(bad)).toHaveLength(1)
  })
  it('webhook 出口 ⇒ 违规（沙箱不得对外发数据）', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'w', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect(sandboxViolations(bad)[0].message).toContain('webhook')
  })
})
