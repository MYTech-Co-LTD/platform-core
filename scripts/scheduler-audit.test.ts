// scripts/scheduler-audit.test.ts —— 纯逻辑（汇总 → 探针行 / SQL 文本），不连库、不投递。
//
// 钉两件事：
//   ① **≥1 条 runner_lost 就判红**（这条存在的唯一目的就是逼人回来复评 #2602，少了就是摆设）；
//   ② SQL 的回看窗口来自参数、且按 runner 维度分组（`(none)` 也要有名有姓，不能静默丢）。
import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_DAYS, RUNNER_LOST_PREFIX, auditRows, auditSql } from './scheduler-audit.mjs'

describe('scheduler-audit auditRows', () => {
  it('★ 有 runner_lost ⇒ ERR，且 detail 带四项计数', () => {
    const [p] = auditRows([{ runner_id: 'scheduler-platform', lost: 2, ok: 10, failed: 1, timeout: 2 }], 30)
    expect(p).toMatchObject({ check: 'scheduler_runner_lost:scheduler-platform', verdict: 'ERR' })
    expect(p.detail).toContain('runner_lost=2')
    expect(p.detail).toContain('近 30 天')
  })

  it('★ 0 条 ⇒ OK（不制造噪声），但行照发（周度台账要有记录）', () => {
    const [p] = auditRows([{ runner_id: 'executor', lost: 0, ok: 5, failed: 0, timeout: 0 }], 30)
    expect(p.verdict).toBe('OK')
    expect(p.check).toBe('scheduler_runner_lost:executor')
  })

  it('runner_id 为空 ⇒ 用 (none) 具名，不丢这一行', () => {
    const [p] = auditRows([{ runner_id: null, lost: 1 }])
    expect(p.check).toBe('scheduler_runner_lost:(none)')
    expect(p.verdict).toBe('ERR')
  })

  it('字符串计数（pg 返回 bigint 文本）也要能算', () => {
    const [p] = auditRows([{ runner_id: 'x', lost: '1', ok: '0', failed: '0', timeout: '0' }])
    expect(p.verdict).toBe('ERR')
  })
})

describe('scheduler-audit auditSql', () => {
  it('窗口来自参数，且按 runner 分组', () => {
    const sql = auditSql(7)
    expect(sql).toContain('make_interval(days => 7)')
    expect(sql).toContain('group by 1')
    expect(sql).toContain(RUNNER_LOST_PREFIX)
    expect(DEFAULT_WINDOW_DAYS).toBe(30)
  })
})
