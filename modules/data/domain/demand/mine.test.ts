import { describe, expect, it } from 'vitest'
import { mineOnce } from './mine'
import type { MineIo } from './mine'
import type { ConvRow } from './classify'

/** OO 命中带 `_timestamp`（入库微秒）；它是 `ConvRow` 的必需字段（水位推导依赖它）。 */
const convRow = (over: Partial<ConvRow> = {}): ConvRow => ({
  session_id: 's1', seq: 1, tool_name: 'query_data', tool_args: null, _timestamp: 0, ...over,
})

const fakeIo = (over: Partial<MineIo> = {}) => {
  const upserts: unknown[] = []
  const cursors = new Map<string, number>()
  const io: MineIo = {
    readCursor: async (_o, s) => cursors.get(s) ?? 0,
    writeCursor: async (_o, s, v) => { cursors.set(s, v) },
    readAudit: async () => [],
    readConv: async () => [],
    readStuck: async () => new Map(),
    catalogIds: async () => [],
    upsert: async (_o, d) => { upserts.push(d) },
    ...over,
  }
  return { io, upserts, cursors }
}

describe('mineOnce', () => {
  it('审计行分类后 upsert，并推进两个水位', async () => {
    const { io, upserts, cursors } = fakeIo({
      readAudit: async () => [
        { id: 10, metric_id: 'net_sales', reason: 'metric_not_declared', params: {} },
        { id: 11, metric_id: 'm:a:b', reason: 'bad_param', params: {} },
      ],
      readConv: async () => [{ session_id: 's1', seq: 1, tool_name: 'query_data', tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}', _timestamp: 0 }],
      catalogIds: async () => ['lemeng:retail:net_sales'],
    })
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out).toMatchObject({ scanned: 2, alias: 1, newMetric: 0, drill: 0, hunt: 0, cursorAudit: 11 })
    expect(upserts).toHaveLength(1)
    expect(cursors.get('query_audit')).toBe(11)
  })

  it('同批重复运行不重复计数（水位已推进 ⇒ 审计源无新行）', async () => {
    let calls = 0
    const { io, upserts } = fakeIo({
      readAudit: async (_o, since) => {
        calls += 1
        return since === 0
          ? [{ id: 5, metric_id: 'm:a:b', reason: 'metric_not_declared', params: {} }]
          : []
      },
    })
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(calls).toBe(2)
    expect(upserts).toHaveLength(1)
  })

  it('审计水位只由本批行推导（不越过 limit 之外的未读行）', async () => {
    const { io, cursors } = fakeIo({
      readAudit: async (_o, since) => (since === 0
        ? [{ id: 7, metric_id: 'm:a:b', reason: 'metric_not_declared', params: {} }]
        : []),
    })
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(cursors.get('query_audit')).toBe(7)
  })

  it('空数据 ⇒ 全 0 且不报错', async () => {
    const { io } = fakeIo()
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out).toMatchObject({ scanned: 0, alias: 0, newMetric: 0, drill: 0, hunt: 0 })
  })

  it('任一源抛错 ⇒ 向上抛（fail-fast，不吞）', async () => {
    const { io } = fakeIo({ readConv: async () => { throw new Error('OO _search HTTP 503') } })
    await expect(mineOnce(io, 'org1', 1_800_000_000_000_000)).rejects.toThrow('OO _search HTTP 503')
  })

  it('conv 水位 = 本批 _timestamp 最大值（排他游标，不 +1）', async () => {
    const { io, cursors } = fakeIo({
      readConv: async () => [
        convRow({ seq: 1, tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}', _timestamp: 1000 }),
        convRow({ seq: 2, tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}', _timestamp: 2000 }),
      ],
    })
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out.cursorConv).toBe(2000)
    expect(cursors.get('askdata_conv')).toBe(2000)
  })

  it('同一批 conv 连跑两轮不重复计数（第二轮按排他游标读到空）', async () => {
    const rows = [
      convRow({ seq: 1, tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}', _timestamp: 1000 }),
      convRow({ seq: 2, tool_args: '{"metricId":"m:c:d","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}', _timestamp: 2000 }),
    ]
    const seen: number[] = []
    const { io, upserts } = fakeIo({
      // 排他游标：`since > 0` 时只返回严格更大的行；这里模拟「没有更新行」。
      readConv: async (_o, since) => {
        seen.push(since)
        return since === 0 ? rows : []
      },
    })
    const first = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    const second = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(first.hunt).toBe(1)
    expect(second.hunt).toBe(0)
    expect(seen).toEqual([0, 2000])
    expect(upserts).toHaveLength(1)
  })

  it('hunt 计数：同会话同 bizday 两个 metricId ⇒ 1 条 metric_hunt', async () => {
    const { io, upserts } = fakeIo({
      readConv: async () => [
        convRow({ seq: 1, tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}' }),
        convRow({ seq: 2, tool_args: '{"metricId":"m:c:d","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}' }),
      ],
    })
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out.hunt).toBe(1)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ kind: 'metric_hunt', target: 's1|2026-10-10..2026-10-16' })
  })

  it('skippedProbe：探针前缀的需求行被挡掉并单独计数', async () => {
    const { io, upserts } = fakeIo({
      readAudit: async () => [
        { id: 1, metric_id: 'verify-abc', reason: 'metric_not_declared', params: {} },
        { id: 2, metric_id: 'w1:test:by_branch', reason: 'no_detail_binding', params: {} },
        { id: 3, metric_id: 'm:a:b', reason: 'bad_param', params: {} },
      ],
    })
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out).toMatchObject({ scanned: 3, skippedProbe: 2, alias: 0, newMetric: 0, drill: 0 })
    expect(upserts).toHaveLength(0)
  })

  it('审计源先落水位：conv 抛错时审计水位已推进（不拖累已写入的计数）', async () => {
    const { io, cursors } = fakeIo({
      readAudit: async () => [{ id: 9, metric_id: 'm:a:b', reason: 'metric_not_declared', params: {} }],
      readConv: async () => { throw new Error('OO down') },
    })
    await expect(mineOnce(io, 'org1', 1_800_000_000_000_000)).rejects.toThrow('OO down')
    expect(cursors.get('query_audit')).toBe(9)
  })
})
