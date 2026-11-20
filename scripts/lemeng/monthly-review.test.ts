// scripts/lemeng/monthly-review.test.ts —— 纯函数（覆盖天数解析 / 快照存在性 / argv / 跑不成的退出码），
// 不起 python、不连网。
//
// 钉四件事：
//   ① 覆盖天数只从 baseline 首行解析；解析不到不许猜 0；
//   ② 目录为空 / 不存在 ⇒ rc=2（月度基线无从谈起，不是「覆盖 0 天」）；
//   ③ `MIN_DAYS` 判据在调用方：覆盖 < 下限 ⇒ rc=1 且投判红（这里只钉解析与 rc=2 分支）；
//   ④ baseline 的 argv 与旧 job 逐字一致（`<dir> --days 31`）。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BASELINE_SCRIPT, LOOKBACK_DAYS, baselineArgv, hasSnapshots, parseCoverageDays, runBaseline,
} from './monthly-review.mjs'

describe('monthly-review parseCoverageDays', () => {
  it('★ 从 baseline 首行解析覆盖天数', () => {
    expect(parseCoverageDays('scorecard-baseline: 31 天（2026-11-01..2026-11-30）· 1800 管线-天')).toBe(31)
    expect(parseCoverageDays('scorecard-baseline: 7 天（2026-11-14..2026-11-20）· 400 管线-天\n更多行')).toBe(7)
  })

  it('★ 解析不到 ⇒ null（不猜 0：猜 0 会把「跑不成」伪装成「覆盖不足」）', () => {
    expect(parseCoverageDays('')).toBeNull()
    expect(parseCoverageDays('scorecard-baseline: 没有历史文件（/x/*.csv）')).toBeNull()
    expect(parseCoverageDays(undefined as unknown as string)).toBeNull()
  })
})

describe('monthly-review hasSnapshots / baselineArgv', () => {
  it('只认 `<book>-YYYY-MM-DD.csv` 形状', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-baseline-'))
    expect(hasSnapshots(dir)).toBe(false)
    writeFileSync(join(dir, 'heal-3120-2026-11-20.md'), 'x')
    expect(hasSnapshots(dir)).toBe(false)
    writeFileSync(join(dir, '3120-2026-11-20.csv'), 'pipeline,level\n')
    expect(hasSnapshots(dir)).toBe(true)
  })

  it('不存在的目录 ⇒ false（不是抛）', () => {
    expect(hasSnapshots('/nonexistent-monthly-review-dir')).toBe(false)
  })

  it('argv 与旧 job 一致：<dir> --days 31', () => {
    expect(baselineArgv('/var/lib/scorecard')).toEqual([BASELINE_SCRIPT, '/var/lib/scorecard', '--days', String(LOOKBACK_DAYS)])
    expect(LOOKBACK_DAYS).toBe(31)
  })
})

describe('monthly-review runBaseline', () => {
  it('★ 没有快照 ⇒ rc=2 且点名目录（月度基线不可用时不许静默）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-empty-'))
    const r = runBaseline({ dir, env: {} })
    expect(r.days).toBeNull()
    expect(r.rc).toBe(2)
    expect(r.output).toContain('MONTHLY_NO_SNAPSHOTS')
  })

  it('★ 输出不可解析 ⇒ rc=2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-bad-'))
    writeFileSync(join(dir, '3120-2026-11-20.csv'), 'pipeline,level\n')
    const spawn = vi.fn(() => ({ status: 0, stdout: 'garbage', stderr: '' }))
    const r = runBaseline({ dir, env: {}, spawn: spawn as never })
    expect(r.days).toBeNull()
    expect(r.rc).toBe(2)
    expect(r.output).toContain('MONTHLY_PARSE_FAILED')
  })

  it('spawn 失败 ⇒ rc=2 且点名依赖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-dep-'))
    writeFileSync(join(dir, '3120-2026-11-20.csv'), 'pipeline,level\n')
    const spawn = vi.fn(() => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }))
    const r = runBaseline({ dir, env: {}, spawn: spawn as never })
    expect(r.rc).toBe(2)
    expect(r.output).toContain('MONTHLY_DEP_FAILED')
  })

  it('正常输出 ⇒ 覆盖天数解析出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-ok-'))
    writeFileSync(join(dir, '3120-2026-11-20.csv'), 'pipeline,level\n')
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'scorecard-baseline: 12 天（2026-11-09..2026-11-20）· 700 管线-天\n',
      stderr: '',
    }))
    const r = runBaseline({ dir, env: {}, spawn: spawn as never })
    expect(r.days).toBe(12)
    expect(r.rc).toBe(0)
  })
})
