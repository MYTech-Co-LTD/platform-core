import { describe, expect, it } from 'vitest'
import { maxMtimeOf, wujiCount, wujiFetchAll, type FetchLike } from './wuji-source'

const CFG = { origin: 'https://data.wujisite.com', appid: 'app', schemaid: 'store_info', schemakey: 'k' }

/** 用真 Response 造桩（Node 22 自带）——形状与真 fetch 完全一致，不留「桩比真机松」的口子。 */
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('wuji-source（通道口径全部来自 2026-09-15 真机实测，spec §3.3）', () => {
  it('wujiCount：count=任意值 → {"data":{"total":N}}', async () => {
    const fetcher: FetchLike = async (url) => {
      expect(url).toContain('count=')
      expect(url).toContain('appid=app')
      expect(url).toContain('schemaid=store_info')
      expect(url).toContain('schemakey=k')
      return jsonResponse(200, { data: { total: 322 }, code: 200 })
    }
    expect(await wujiCount(fetcher, CFG)).toBe(322)
  })

  it('403 ⇒ WujiApiError 且报文指向双因子（错一即 403，不可枚举）', async () => {
    const fetcher: FetchLike = async () => jsonResponse(403, { })
    await expect(wujiCount(fetcher, CFG)).rejects.toThrow(/403/)
  })

  it('分页：整页继续、末页（不足 pageSize）停；page 从 1 起、size 默认 15000', async () => {
    let calls = 0
    const fetcher: FetchLike = async (url) => {
      calls += 1
      const u = new URL(url)
      expect(u.searchParams.get('page')).toBe(String(calls))
      expect(u.searchParams.get('size')).toBe('3')
      return jsonResponse(200, { data: calls === 1 ? [{ a: 1 }, { a: 2 }, { a: 3 }] : [{ a: 4 }] })
    }
    const rows = await wujiFetchAll(fetcher, CFG, { pageSize: 3 })
    expect(rows.map((r) => r.a)).toEqual([1, 2, 3, 4])
    expect(calls).toBe(2)
  })

  it('maxRows 截断（拉样模式只拉第一页）', async () => {
    const fetcher: FetchLike = async () => jsonResponse(200, { data: [{ a: 1 }, { a: 2 }, { a: 3 }] })
    const rows = await wujiFetchAll(fetcher, CFG, { pageSize: 3, maxRows: 2 })
    expect(rows).toHaveLength(2)
  })

  it('maxMtimeOf：取全部行的最大 _mtime（对账基线）', () => {
    expect(maxMtimeOf([{ _mtime: '2026-09-12 10:00:00' }, { _mtime: '2026-09-12 09:00:00' }])).toBe('2026-09-12 10:00:00')
    expect(maxMtimeOf([{}, { _mtime: '' }])).toBeNull()
  })
})
