// integration-health.test.ts — 集成活性判据（纯函数；spec 2026-10-31 §2.1）
//
// 断言的是**三态分离**这件事本身：STALE（查了，真没动静）与 PROBE_FAILED（探不了）
// 混成一个码 = 排障方向被带偏，这正是本设计要消灭的失败模式。
import { describe, it, expect } from 'vitest'
import { humanAge, judgeIntegration } from './integration-health'

const NOW = new Date('2026-10-31T12:00:00Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()

const row = (over: Partial<{ slaSeconds: number; enabled: boolean; lastOkAt: string | null }> = {}) => ({
  slaSeconds: 1800, enabled: true, lastOkAt: ago(60), ...over,
})

describe('judgeIntegration', () => {
  it('SLA 内有证据 ⇒ OK，带年龄与人话原因', () => {
    const h = judgeIntegration(row(), null, NOW)
    expect(h.verdict).toBe('OK')
    expect(h.ageSeconds).toBe(60)
    expect(h.reason).toContain('1 分钟')
  })

  it('★ 超过 SLA ⇒ STALE（边界：age == SLA 仍算 OK）', () => {
    expect(judgeIntegration(row({ slaSeconds: 60 }), null, NOW).verdict).toBe('OK')
    const stale = judgeIntegration(row({ slaSeconds: 59 }), null, NOW)
    expect(stale.verdict).toBe('STALE')
    expect(stale.reason).toContain('SLA')
  })

  it('★ 从来没有证据（null）⇒ STALE，且原因点明「从接入起就算超期」', () => {
    const h = judgeIntegration(row({ lastOkAt: null }), null, NOW)
    expect(h.verdict).toBe('STALE')
    expect(h.ageSeconds).toBeNull()
    expect(h.reason).toContain('从来没有')
  })

  it('★ 探针自己失败 ⇒ PROBE_FAILED，**不是** STALE（「探不了」≠「查了没动静」）', () => {
    const h = judgeIntegration(row({ lastOkAt: null }), { ok: false, at: NOW.toISOString(), error: 'ECONNREFUSED' }, NOW)
    expect(h.verdict).toBe('PROBE_FAILED')
    expect(h.reason).toContain('ECONNREFUSED')
  })

  it('探针成功的时间戳也能当证据（比 lastOkAt 新时以它为准）', () => {
    const h = judgeIntegration(
      row({ slaSeconds: 600, lastOkAt: ago(3600) }),
      { ok: true, at: ago(10) },
      NOW,
    )
    expect(h.verdict).toBe('OK')
    expect(h.ageSeconds).toBe(10)
  })

  it('探针成功但比 lastOkAt 旧 ⇒ 用 lastOkAt（不倒退）', () => {
    const h = judgeIntegration(row({ lastOkAt: ago(5) }), { ok: true, at: ago(900) }, NOW)
    expect(h.ageSeconds).toBe(5)
  })

  it('停用 ⇒ DISABLED（不冒充健康，也不报红）', () => {
    const h = judgeIntegration(row({ enabled: false, lastOkAt: null }), null, NOW)
    expect(h.verdict).toBe('DISABLED')
  })
})

describe('humanAge', () => {
  it('秒/分/时/天四档', () => {
    expect(humanAge(30)).toBe('30 秒')
    expect(humanAge(60 * 5)).toBe('5 分钟')
    expect(humanAge(3600 * 3)).toBe('3 小时')
    expect(humanAge(86400 * 62)).toBe('62 天')
  })
})

// ── 探针心跳（spec §2.4 元级看门狗）────────────────────────────────────────────
import { judgeProbeHeartbeat } from './integration-health'

describe('judgeProbeHeartbeat', () => {
  const now = new Date('2026-10-31T12:00:00Z')
  const beatAgo = (s: number) => new Date(now.getTime() - s * 1000).toISOString()

  it('正常跳动 ⇒ OK', () => {
    const v = judgeProbeHeartbeat({ beatAt: beatAgo(30), enabled: true, intervalMs: 60_000 }, now)
    expect(v.verdict).toBe('OK')
    expect(v.ageSeconds).toBe(30)
  })

  it('★ 太久没跳 ⇒ STALE（阈值为 max(2×周期, 5 分钟)）', () => {
    // 周期 60s ⇒ 2×=120s，但下限 5 分钟 ⇒ 4 分钟仍 OK、6 分钟才 STALE
    expect(judgeProbeHeartbeat({ beatAt: beatAgo(240), enabled: true, intervalMs: 60_000 }, now).verdict).toBe('OK')
    expect(judgeProbeHeartbeat({ beatAt: beatAgo(360), enabled: true, intervalMs: 60_000 }, now).verdict).toBe('STALE')
  })

  it('★ 未启用 ⇒ DISABLED（不算故障，但也绝不冒充健康）', () => {
    const v = judgeProbeHeartbeat({ beatAt: beatAgo(99999), enabled: false, intervalMs: 0 }, now)
    expect(v.verdict).toBe('DISABLED')
  })

  it('★ 从来没有心跳行 ⇒ NEVER（从未跑过）', () => {
    expect(judgeProbeHeartbeat(null, now).verdict).toBe('NEVER')
  })
})
