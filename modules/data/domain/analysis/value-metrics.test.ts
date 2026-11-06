import { describe, expect, it } from 'vitest'
import { valueMetricsOf } from './value-metrics'

describe('valueMetricsOf（W6 Task 5：三个价值指标）', () => {
  it('样本不足（<20）⇒ 中位耗时为 null 且标 insufficient（不拿 5 个样本算中位数）', () => {
    const out = valueMetricsOf({ answerDurationsMs: [1000, 2000, 3000], decided: 3, verifiedTotal: 10, incidents: 2 })
    expect(out.defensibleAnswerSeconds).toBeNull()
    expect(out.answerTimeState).toBe('insufficient')
    expect(out.answerTimeSamples).toBe(3)
  })

  it('样本足够 ⇒ 中位耗时（秒，1 位小数）', () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000)
    const out = valueMetricsOf({ answerDurationsMs: samples, decided: 0, verifiedTotal: 0, incidents: 0 })
    expect(out.answerTimeState).toBe('ok')
    expect(out.defensibleAnswerSeconds).toBe(10.5)
    expect(out.answerTimeSamples).toBe(20)
  })

  it('未接入（null）与「零样本」不同：未接入 ⇒ not_connected', () => {
    const out = valueMetricsOf({ answerDurationsMs: null, decided: 1, verifiedTotal: 2, incidents: null })
    expect(out.answerTimeState).toBe('not_connected')
    expect(out.answerTimeSamples).toBe(0)
    expect(out.defensibleAnswerSeconds).toBeNull()
    expect(out.incidents).toBeNull()
  })

  it('接受率：已裁决 / 全部；空集为 null 而不是 0%', () => {
    expect(valueMetricsOf({ decided: 4, verifiedTotal: 16, incidents: 0 }).acceptancePct).toBe(25)
    expect(valueMetricsOf({ decided: 0, verifiedTotal: 0, incidents: 0 }).acceptancePct).toBeNull()
  })

  it('脏输入收严：decided 超过 total 时按 total 截断（不出现 >100%）', () => {
    const out = valueMetricsOf({ decided: 99, verifiedTotal: 10, incidents: 0 })
    expect(out.acceptancePct).toBe(100)
    expect(out.decided).toBe(10)
  })
})
