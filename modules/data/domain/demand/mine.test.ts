import { describe, expect, it } from 'vitest'
import { mineOnce } from './mine'
import type { MineIo } from './mine'

const fakeIo = (over: Partial<MineIo> = {}) => {
  const upserts: unknown[] = []
  const cursors = new Map<string, number>()
  const io: MineIo = {
    readCursor: async (_o, s) => cursors.get(s) ?? 0,
    writeCursor: async (_o, s, v) => { cursors.set(s, v) },
    readAudit: async () => ({ rows: [], maxId: 0 }),
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
      readAudit: async () => ({
        rows: [
          { id: 10, metric_id: 'net_sales', reason: 'metric_not_declared', params: {} },
          { id: 11, metric_id: 'm:a:b', reason: 'bad_param', params: {} },
        ],
        maxId: 11,
      }),
      readConv: async () => [{ session_id: 's1', seq: 1, tool_name: 'query_data', tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}' }],
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
          ? { rows: [{ id: 5, metric_id: 'm:a:b', reason: 'metric_not_declared', params: {} }], maxId: 5 }
          : { rows: [], maxId: since }
      },
    })
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(calls).toBe(2)
    expect(upserts).toHaveLength(1)
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
})
