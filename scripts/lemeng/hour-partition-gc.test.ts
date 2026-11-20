// scripts/lemeng/hour-partition-gc.test.ts —— 纯函数（窗口 + 账套解析），不起进程、不连 ZOS。
//
// 钉两件事：
//   ① 窗口与现役宿主 bash 逐字一致（UTC、before=今天、from=before−10 天）——差一天就等于
//      把重述窗口内的日子也当候选，删了源就没回退路；
//   ② 账套列表空/非法 ⇒ 响亮失败，不静默跑 0 个账套（空跑成功 = 假绿）。
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOOKS, parseBooks, utcWindow } from './hour-partition-gc.mjs'

describe('hour-partition-gc utcWindow', () => {
  it('★ 窗口按 UTC 算：before=当天、from=before−10 天（与宿主 date -d 一致）', () => {
    // 2026-11-20T02:30:00Z（= CST 10:30）——若误用本地时区（CST），from/before 会偏一天。
    expect(utcWindow(new Date('2026-11-20T02:30:00Z'))).toEqual({ from: '2026-11-10', before: '2026-11-20' })
    // 跨月也要对：3 月的 1 号减 10 天回落到 2 月末。
    expect(utcWindow(new Date('2026-03-01T23:59:00Z'))).toEqual({ from: '2026-02-19', before: '2026-03-01' })
  })

  it('UTC 与 CST 在跨日时刻必须不同（防止有人把 utcWindow 改成 toLocaleDateString）', () => {
    // 2026-11-20T20:00:00Z = CST 2026-11-21 04:00 ⇒ before 仍是 UTC 的 11-20。
    expect(utcWindow(new Date('2026-11-20T20:00:00Z')).before).toBe('2026-11-20')
  })
})

describe('hour-partition-gc parseBooks', () => {
  it('默认与现役 for 循环一致', () => {
    expect(DEFAULT_BOOKS).toEqual(['3120', '64188'])
  })

  it('逗号分隔、去空白', () => {
    expect(parseBooks('3120, 64188')).toEqual(['3120', '64188'])
    expect(parseBooks('3120')).toEqual(['3120'])
  })

  it('★ 空/非法 ⇒ 抛错（不静默空跑）', () => {
    expect(() => parseBooks('')).toThrow(/不能为空/)
    expect(() => parseBooks(' , ')).toThrow(/不能为空/)
    expect(() => parseBooks('../etc')).toThrow(/非法账套号/)
    expect(() => parseBooks('3120;rm')).toThrow(/非法账套号/)
  })
})
