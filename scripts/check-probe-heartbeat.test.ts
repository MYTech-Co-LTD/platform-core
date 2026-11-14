// check-probe-heartbeat.test.ts — 第二看护路径（scheduler 心跳）的纯判定。
// 只钉判据；不连库（脚本主体有 process.argv 守卫，import 不会跑查询）。
import { describe, expect, it } from 'vitest'
import { judgeScheduler } from './check-probe-heartbeat.mjs'

const NOW = new Date('2026-11-14T12:00:00Z')

describe('judgeScheduler', () => {
  it('所有排班都是 enabled=false（含 SCHEDULER_ENABLED=0 只停 loop 的情形）⇒ DISABLED，不算故障', () => {
    // 心跳缺失或陈旧都无关紧要：没有 enabled 排班就不该要求引擎在跑。
    expect(judgeScheduler(null, 0, NOW).verdict).toBe('DISABLED')
    expect(judgeScheduler(new Date('2026-11-01T00:00:00Z'), 0, NOW).verdict).toBe('DISABLED')
  })

  it('有 enabled 排班但心跳行缺失 ⇒ NEVER', () => {
    const v = judgeScheduler(null, 1, NOW)
    expect(v.verdict).toBe('NEVER')
    expect(v.reason).toContain('scheduler')
  })

  it('心跳超过 2 分钟 ⇒ STALE；2 分钟内 ⇒ OK', () => {
    const stale = judgeScheduler(new Date(NOW.getTime() - 121_000), 2, NOW)
    expect(stale.verdict).toBe('STALE')
    expect(stale.ageSeconds).toBe(121)
    const ok = judgeScheduler(new Date(NOW.getTime() - 100_000), 2, NOW)
    expect(ok.verdict).toBe('OK')
    expect(ok.ageSeconds).toBe(100)
  })
})
