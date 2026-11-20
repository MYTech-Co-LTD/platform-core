// scripts/lemeng/pipeline-scorecard.test.ts —— 纯函数（账套解析 / workspace 读点 / 探针行映射），
// 不起 python、不连 OO。
//
// 钉四件事：
//   ① 账套清单默认与现役两条 openship job 一致；空/非法 ⇒ 响亮失败（静默跑 0 个账套 = 假绿）；
//   ② workspace 读点必须落在 compose 挂进来的命名卷位置（`/data/ws<book>`）；
//   ③ 只有非 GREEN 才投探针，且 RED→ERR / AMBER→WARN / UNKNOWN→UNKNOWN；
//   ④ 「工作区不可达」必须返回 rc=2 且 rows=null（不能退化成「0 条管线全绿」）。
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BOOKS, parseBooks, probeRows, runBook, scorecardArgv, summarize, workspaceFor,
} from './pipeline-scorecard.mjs'

describe('pipeline-scorecard parseBooks', () => {
  it('缺省/空串 ⇒ 与现役两条 job 一致的两账套', () => {
    expect(DEFAULT_BOOKS).toEqual(['3120', '64188'])
    expect(parseBooks(undefined)).toEqual(['3120', '64188'])
    expect(parseBooks('  ')).toEqual(['3120', '64188'])
  })

  it('逗号/空白分隔；去重交给调用方（这里只保序）', () => {
    expect(parseBooks('3120, 64188')).toEqual(['3120', '64188'])
    expect(parseBooks('3120 64188')).toEqual(['3120', '64188'])
  })

  it('★ 非法账套号 ⇒ 抛错（不许把垃圾拼进 workspace 路径）', () => {
    expect(() => parseBooks('3120,../etc')).toThrow(/非法/)
    expect(() => parseBooks('3120,6a1888')).not.toThrow()
    expect(() => parseBooks(',')).toThrow(/解析为空/)
  })
})

describe('pipeline-scorecard workspaceFor', () => {
  it('读点 = /data/ws<book>（compose 命名卷的挂载点）', () => {
    expect(workspaceFor('3120', {})).toBe('/data/ws3120')
    expect(workspaceFor('64188', {})).toBe('/data/ws64188')
  })

  it('SCORECARD_WS_ROOT 可覆盖（本地调试用）', () => {
    expect(workspaceFor('3120', { SCORECARD_WS_ROOT: '/tmp/ws' })).toBe('/tmp/ws/ws3120')
  })
})

describe('pipeline-scorecard probeRows', () => {
  it('★ 只投非 GREEN；RED→ERR、AMBER→WARN、UNKNOWN→UNKNOWN', () => {
    const rows = [
      { pipeline: 'retail.order.daily', level: 'RED', status: 'failed', last_ok_at: '2026-11-17T00:00:00Z', error: 'timeout' },
      { pipeline: 'member.summary.daily', level: 'AMBER', status: 'interrupted', last_ok_at: '2026-11-20T00:00:00Z' },
      { pipeline: 'purchase.daily', level: 'GREEN', status: 'ok' },
      { pipeline: 'price.batch.daily', level: 'UNKNOWN', status: null, error: 'scheduled but never ran' },
    ]
    const out = probeRows('3120', rows)
    expect(out.map((r) => [r.check, r.verdict])).toEqual([
      ['scorecard:3120:retail.order.daily', 'ERR'],
      ['scorecard:3120:member.summary.daily', 'WARN'],
      ['scorecard:3120:price.batch.daily', 'UNKNOWN'],
    ])
    expect(out[0].detail).toContain('level=RED')
    expect(out[0].detail).toContain('error=timeout')
    expect(out.every((r) => r.probe === 'scorecard')).toBe(true)
  })

  it('空/畸形行不炸，也不产出探针', () => {
    expect(probeRows('3120', [])).toEqual([])
    expect(probeRows('3120', [null, {}, { level: 'green' }])).toEqual([])
  })
})

describe('pipeline-scorecard summarize', () => {
  it('逐档计数（台账 output_tail 用）', () => {
    const s = summarize([{ level: 'RED' }, { level: 'AMBER' }, { level: 'AMBER' }, { level: 'GREEN' }])
    expect(s).toEqual({ total: 4, red: 1, amber: 2, unknown: 0 })
  })
})

describe('pipeline-scorecard runBook', () => {
  it('★ 工作区不可达 ⇒ rc=2 且 rows=null（不能退化成「0 条全绿」）', () => {
    const r = runBook('3120', { env: { SCORECARD_WS_ROOT: '/nonexistent-scorecard-root' } })
    expect(r.rows).toBeNull()
    expect(r.rc).toBe(2)
    expect(r.output).toContain('SCORECARD_WS_MISSING')
  })

  it('判据输出不可解析 ⇒ rc=2（python 起了但吐了别的东西）', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'not json', stderr: '' }))
    // 显式给一个**存在**的工作区（ws 覆盖参数），让断言不依赖跑测机器的目录布局。
    const r = runBook('3120', { ws: process.cwd(), spawn })
    expect(r.rows).toBeNull()
    expect(r.rc).toBe(2)
    expect(r.output).toContain('SCORECARD_PARSE_FAILED')
  })

  it('正常输出 ⇒ 解析成行数组，退出码透传', () => {
    const spawn = vi.fn(() => ({
      status: 1, stdout: JSON.stringify([{ pipeline: 'a', level: 'RED' }]), stderr: '',
    }))
    const r = runBook('3120', { ws: process.cwd(), spawn })
    expect(r.rows).toEqual([{ pipeline: 'a', level: 'RED' }])
    expect(r.rc).toBe(1)
    // 判据必须拿到 DUCKLE_WORKSPACE（否则 python 读默认 /workspace ⇒ 恒 0 管线 = 假绿）。
    expect(spawn.mock.calls[0][2].env.DUCKLE_WORKSPACE).toBe(process.cwd())
  })

  it('spawn 级失败（python3 不在）⇒ rc=2 且点名依赖', () => {
    const spawn = vi.fn(() => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }))
    const r = runBook('3120', { ws: process.cwd(), spawn })
    expect(r.rows).toBeNull()
    expect(r.rc).toBe(2)
    expect(r.output).toContain('SCORECARD_DEP_FAILED')
  })

  it('argv 钉死判据本体路径与 --json', () => {
    expect(scorecardArgv()).toEqual(['deploy/duckle/console/pipeline-scorecard.py', '--json'])
  })
})
