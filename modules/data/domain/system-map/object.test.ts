// object.test.ts — 对象详情（#2691）：1/2 跳血缘口径与列表计数。
import { describe, expect, it } from 'vitest'
import { buildObjectDetail, listObjects } from './object'

const nodes = [
  { id: 'src:a', kind: 'source', label: 'a' },
  { id: 'pipe:p', kind: 'pipeline', label: 'p' },
  { id: 'lake:l', kind: 'lake', label: 'l' },
  { id: 'stg:s', kind: 'staging', label: 's' },
  { id: 'mart:m', kind: 'mart', label: 'm' },
  { id: 'met:e', kind: 'metric', label: 'e' },
  { id: 'use:report', kind: 'consumer', label: '报表' },
]
const edges = [
  { source: 'src:a', target: 'pipe:p' },
  { source: 'pipe:p', target: 'lake:l' },
  { source: 'lake:l', target: 'stg:s' },
  { source: 'stg:s', target: 'mart:m' },
  { source: 'mart:m', target: 'met:e' },
  { source: 'met:e', target: 'use:report' },
]

describe('buildObjectDetail', () => {
  it('以对象为中心：上游 1 跳 / 下游 1 跳 / 2 跳（排除 1 跳与自身）', () => {
    const d = buildObjectDetail({ kind: 'mart', name: 'm', domain: null, columns: [], nodes, edges })
    expect(d.upstream).toEqual([{ kind: 'staging', name: 's' }])
    expect(d.downstream).toEqual([{ kind: 'metric', name: 'e' }])
    expect(d.upstream2).toEqual([{ kind: 'lake', name: 'l' }])
    expect(d.downstream2).toEqual([])
  })

  it('不在图上的对象：notes 明说（未知 ≠ 没有）', () => {
    const d = buildObjectDetail({ kind: 'mart', name: 'ghost', domain: null, columns: [], nodes, edges })
    expect(d.upstream).toEqual([])
    expect(d.notes.some((n) => n.includes('没有识别到上下游'))).toBe(true)
  })
})

describe('listObjects', () => {
  it('只列可下钻的类型，带上下游计数，按类型序排列', () => {
    const rows = listObjects({ nodes, edges, domainOf: (k) => (k === 'lake' ? 'l' : null) })
    expect(rows.map((r) => r.kind)).toEqual(['pipeline', 'lake', 'staging', 'mart', 'metric'])
    const lake = rows.find((r) => r.name === 'l')!
    expect(lake.upstreamCount).toBe(1)
    expect(lake.downstreamCount).toBe(1)
    expect(lake.domain).toBe('l')
  })
})
