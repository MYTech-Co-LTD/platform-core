// scripts/apply-eval-set.test.ts — 评估集窗口卫生（纯函数，不连库、不重放）。
//
// 2026-11-07 真机教训：`#3`「近 7 天」以 `window: default` 摄入 ⇒ 参数为空 ⇒ 指标用自身
// 缺省（相对窗口）⇒ 基线在重放日必然分叉（连续 3 天红）。这里把「只收已封板绝对窗口」钉住。
import { describe, expect, it } from 'vitest'
import { windowErrorOf } from './apply-eval-set.mjs'

const TODAY = '2026-11-07'

describe('apply-eval-set windowErrorOf', () => {
  it('default（无日期参数）⇒ window_required（唯一不稳定的形态）', () => {
    expect(windowErrorOf('default', {}, TODAY)).toBe('window_required')
  })

  it('未知/空窗口 ⇒ unknown_window（不静默当 default）', () => {
    expect(windowErrorOf('', {}, TODAY)).toBe('unknown_window')
    expect(windowErrorOf('open', {}, TODAY)).toBe('unknown_window')
  })

  it('fixed 必须带 from/to 且已封板（to < today）', () => {
    expect(windowErrorOf('fixed', {}, TODAY)).toBe('fixed_range_missing')
    expect(windowErrorOf('fixed', { from: '2026-10-01' }, TODAY)).toBe('fixed_range_missing')
    expect(windowErrorOf('fixed', { from: '2026-10-01', to: TODAY }, TODAY)).toBe('open_period_not_stable')
    expect(windowErrorOf('fixed', { from: '2026-10-01', to: '2026-10-31' }, TODAY)).toBeNull()
  })

  it('yesterday / last7 / mtd 在摄入时钉成绝对区间 ⇒ 可摄入', () => {
    expect(windowErrorOf('yesterday', {}, TODAY)).toBeNull()
    expect(windowErrorOf('last7', {}, TODAY)).toBeNull()
    expect(windowErrorOf('mtd', {}, TODAY)).toBeNull()
  })
})
