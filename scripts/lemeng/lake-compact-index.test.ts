// lake-compact-index.test.ts — 压缩记账档的纯函数（月份枚举 / key 拼接 / 上月推导）。
// 判据只钉**形状**：月份连续无洞、key 与 duckle 搬运管线逐字一致（两边不一致 ⇒ 读侧指向不存在的对象）。
import { describe, expect, it } from 'vitest'
import {
  lagMonths, lastMonth, missingMonths, monthObjectKey, monthObjectUrl, monthsBetween, rawMonthGlob,
} from './lake-compact-index.mjs'

describe('lake-compact-index · 月份枚举', () => {
  it('start_ym → until 连续递增，跨年正确', () => {
    expect(monthsBetween({ start_ym: '2025-11', until: '2026-02' })).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02',
    ])
  })

  it('单月', () => {
    expect(monthsBetween({ start_ym: '2026-10', until: '2026-10' })).toEqual(['2026-10'])
  })

  it('lastMonth：UTC 口径，跨年回到 12 月', () => {
    expect(lastMonth(new Date('2026-11-26T19:40:00Z'))).toBe('2026-10')
    expect(lastMonth(new Date('2027-01-05T00:00:00Z'))).toBe('2026-12')
  })
})

describe('lake-compact-index · key 形状', () => {
  it('月文件 key 与搬运管线逐字一致', () => {
    expect(monthObjectKey({ source: 'business_collection_receive', book: 3120, ym: '2026-10', sha: '8b6b3529' }))
      .toBe('lemeng/business_collection_receive_month/_MONTH/v=8b6b3529/system_book=3120/month=2026-10/all.parquet')
  })

  it('s3 URL 与原始 glob 都是完整路径', () => {
    expect(monthObjectUrl({ source: 'x', book: 64188, ym: '2026-09', sha: 'abcd1234' }))
      .toBe('s3://shanhai-data/lemeng/x_month/_MONTH/v=abcd1234/system_book=64188/month=2026-09/all.parquet')
    expect(rawMonthGlob({ source: 'x', book: 64188, ym: '2026-09' }))
      .toBe('s3://shanhai-data/lemeng/x/system_book=64188/bizday=2026-09-*/all.parquet')
  })
})

describe('lake-compact-index · 断言（§7 ①②）', () => {
  it('连续性：中间缺月必须被点名', () => {
    expect(missingMonths({ start_ym: '2026-06', last_ym: '2026-10', have: ['2026-06', '2026-07', '2026-09', '2026-10'] }))
      .toEqual(['2026-08'])
    expect(missingMonths({ start_ym: '2026-06', last_ym: '2026-08', have: ['2026-06', '2026-07', '2026-08'] })).toEqual([])
  })

  it('滞后：上月未压（lag=1）可接受，缺两个月才红', () => {
    const now = new Date('2026-11-26T19:40:00Z') // 上月 = 2026-10
    expect(lagMonths({ last_ok_ym: '2026-10', now })).toBe(0)
    expect(lagMonths({ last_ok_ym: '2026-09', now })).toBe(1)
    expect(lagMonths({ last_ok_ym: '2026-08', now })).toBe(2)
  })
})
