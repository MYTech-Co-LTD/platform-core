// scripts/verify-regression.test.ts — 回归 CLI 的参数解析（纯函数，不起进程、不连库）。
//
// 只测 `parseArgs`：退出码/池的编排需要真库，归 job 冒烟；参数面是「打错参数不该静默跑」
// 的唯一入口闸门，必须钉住。
import { describe, expect, it } from 'vitest'
import { parseArgs } from './verify-regression.mjs'

describe('verify-regression parseArgs', () => {
  it('--key value 与 --key=value 两种写法等价', () => {
    expect(parseArgs(['--org', 'acme', '--limit', '10', '--ids', '1,2,3']))
      .toEqual({ org: 'acme', limit: 10, ids: [1, 2, 3] })
    expect(parseArgs(['--org=acme', '--limit=10', '--ids=1,2,3']))
      .toEqual({ org: 'acme', limit: 10, ids: [1, 2, 3] })
    expect(parseArgs(['--org', 'acme'])).toEqual({ org: 'acme' })
  })

  it('--org 必填（空串也算缺）', () => {
    expect(() => parseArgs([])).toThrow(/--org/)
    expect(() => parseArgs(['--org', '  '])).toThrow(/--org/)
  })

  it('缺值 / 未知键 / 位置参数 ⇒ 抛错（不静默忽略拼错）', () => {
    expect(() => parseArgs(['--org'])).toThrow(/缺值/)
    expect(() => parseArgs(['--org', '--limit', '1'])).toThrow(/缺值/)
    expect(() => parseArgs(['--org', 'acme', '--bogus', '1'])).toThrow(/未知参数/)
    expect(() => parseArgs(['org=acme'])).toThrow(/无法识别/)
  })

  it('--limit 必须非负整数', () => {
    for (const bad of ['abc', '-1', '1.5', 'NaN']) {
      expect(() => parseArgs(['--org', 'acme', '--limit', bad])).toThrow(/--limit/)
    }
    expect(parseArgs(['--org', 'acme', '--limit', '0']).limit).toBe(0)
  })

  it('--ids 必须逗号分隔的正整数', () => {
    for (const bad of ['', '1,', '0', '-1', '1.5', 'a']) {
      expect(() => parseArgs(['--org', 'acme', '--ids', bad])).toThrow(/--ids/)
    }
  })
})
