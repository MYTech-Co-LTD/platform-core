// monitor-state.ts — 监控状态机（Wave 7 V1，spec §7/§11）。纯函数，时钟由调用方注入。
//
// 三条纪律（都直接对应 spec 原文）：
//   ① 只在**跃迁**时发一条；同状态重复求值不发。
//   ② `unknown` **不改 state**（判不了 ≠ 没问题），只累计 consecutive_fail。
//   ③ 冷却只压「重复跃迁的投递」，**不压状态本身**——状态照改，防止看板长期显示错状态。
import type { MonitorOutcome, MonitorState } from './monitor-spec'
import { MONITOR_FAIL_LIMIT } from './monitor-spec'

export interface TransitionInput {
  prev: MonitorState
  outcome: MonitorOutcome
  prevStateSince: Date | null
  notifiedAt: Date | null
  cooldownSecs: number
  consecutiveFail: number
  /** 已连续越界次数（落库值；每次求值前读取）。 */
  breakStreak: number
  /** 连续多少次越界才跃迁（1 = 第一次就触发）。 */
  minBreachEvals: number
  now: Date
}

export type NotifyKind = 'fired' | 'resolved' | 'disabled'

export interface TransitionResult {
  state: MonitorState
  stateSince: Date
  consecutiveFail: number
  consecutiveBreach: number
  notify: NotifyKind | null
  disable: boolean
}

export function transitionOf(i: TransitionInput): TransitionResult {
  const { prev, outcome, now } = i

  // ── 判不了：状态不动，失败计数 +1；达到阈值熔断（fail-visible，spec §11） ──
  if (outcome.verdict === 'unknown') {
    const consecutiveFail = i.consecutiveFail + 1
    const disable = consecutiveFail >= MONITOR_FAIL_LIMIT
    return {
      state: prev,
      stateSince: i.prevStateSince ?? now,
      consecutiveFail,
      // 判不了不是「没越界」：streak 原样保留，恢复后再越界不必从头数。
      consecutiveBreach: i.breakStreak,
      notify: disable ? 'disabled' : null,
      disable,
    }
  }

  const breached = outcome.verdict !== 'ok'
  const streak = breached ? i.breakStreak + 1 : 0

  // 防抖（spec §7，V2b）：越界要连续 minBreachEvals 次才 ok→firing。
  // 已在 firing 就不再「跃迁」，也不重复通知。
  if (breached && prev !== 'firing' && streak < Math.max(1, i.minBreachEvals)) {
    return {
      state: prev,
      stateSince: i.prevStateSince ?? now,
      consecutiveFail: 0,
      consecutiveBreach: streak,
      notify: null,
      disable: false,
    }
  }

  const next: MonitorState = breached ? 'firing' : 'ok'
  const changed = next !== prev
  const stateSince = changed ? now : (i.prevStateSince ?? now)

  if (!changed) {
    return { state: next, stateSince, consecutiveFail: 0, consecutiveBreach: streak, notify: null, disable: false }
  }

  // 跃迁：冷却窗内的重复跃迁只改状态、不投递（spec §7）。
  const cooldownElapsed = i.notifiedAt === null
    || now.getTime() - i.notifiedAt.getTime() >= i.cooldownSecs * 1000
  const notify: NotifyKind | null = cooldownElapsed
    ? (next === 'firing' ? 'fired' : 'resolved')
    : null

  return { state: next, stateSince, consecutiveFail: 0, consecutiveBreach: streak, notify, disable: false }
}
