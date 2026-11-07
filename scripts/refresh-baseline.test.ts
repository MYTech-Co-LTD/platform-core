// scripts/refresh-baseline.test.ts — 刷新基线 CLI 的参数面（纯函数；重放/写库归真机）。
import { describe, expect, it } from 'vitest'
import { parseArgs } from './refresh-baseline.mjs'

describe('refresh-baseline parseArgs', () => {
  it('--key value 与 --key=value 等价；--write 是开关；--ids 支持逗号列表', () => {
    expect(parseArgs(['--org', 'acme', '--ids', '7,12', '--by', 'alice', '--reason', '数据回填', '--write']))
      .toEqual({ org: 'acme', ids: [7, 12], by: 'alice', reason: '数据回填', write: true })
    expect(parseArgs(['--org=acme', '--ids=7', '--by=b', '--reason=r']))
      .toEqual({ org: 'acme', ids: [7], by: 'b', reason: 'r', write: false })
  })

  it('--org / --ids / --by / --reason 全必填；ids 必须是正整数', () => {
    expect(() => parseArgs([])).toThrow(/--org/)
    expect(() => parseArgs(['--org', 'acme', '--by', 'b', '--reason', 'r'])).toThrow(/--ids/)
    for (const bad of ['0', '-1', '1.5', 'a', '1,,2', '1,']) {
      expect(() => parseArgs(['--org', 'acme', '--ids', bad, '--by', 'b', '--reason', 'r'])).toThrow(/--ids/)
    }
    expect(() => parseArgs(['--org', 'acme', '--ids', '7', '--reason', 'r'])).toThrow(/--by/)
    expect(() => parseArgs(['--org', 'acme', '--ids', '7', '--by', 'b'])).toThrow(/--reason/)
  })

  it('未知键 / 缺值 / 位置参数 ⇒ 抛错（不静默忽略拼错）', () => {
    expect(() => parseArgs(['--org', 'acme', '--ids', '7', '--by', 'b', '--reason', 'r', '--bogus', 'x']))
      .toThrow(/未知参数/)
    expect(() => parseArgs(['--org', 'acme', '--ids'])).toThrow(/缺值/)
    expect(() => parseArgs(['org=acme'])).toThrow(/无法识别/)
  })
})
