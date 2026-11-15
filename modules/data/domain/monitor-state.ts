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
  now: Date
}

export type NotifyKind = 'fired' | 'resolved' | 'disabled'

export interface TransitionResult {
  state: MonitorState
  stateSince: Date
  consecutiveFail: number
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
      notify: disable ? 'disabled' : null,
      disable,
    }
  }

  const next: MonitorState = outcome.verdict === 'ok' ? 'ok' : 'firing'
  const changed = next !== prev
  const stateSince = changed ? now : (i.prevStateSince ?? now)

  if (!changed) {
    return { state: next, stateSince, consecutiveFail: 0, notify: null, disable: false }
  }

  // 跃迁：冷却窗内的重复跃迁只改状态、不投递（spec §7）。
  const cooldownElapsed = i.notifiedAt === null
    || now.getTime() - i.notifiedAt.getTime() >= i.cooldownSecs * 1000
  const notify: NotifyKind | null = cooldownElapsed
    ? (next === 'firing' ? 'fired' : 'resolved')
    : null

  return { state: next, stateSince, consecutiveFail: 0, notify, disable: false }
}
