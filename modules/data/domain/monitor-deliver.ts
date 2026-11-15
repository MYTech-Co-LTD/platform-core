// monitor-deliver.ts — 监控事件的**纯构造**（Wave 7 V1，spec §9）。
//
// 只回答「这条跃迁该发什么」；投递本身由调用方（tick 脚本）经 notify 的 enqueueEvent 落地。
// 三条硬约束：
//   ① payload **不带数值、不带阈值**（reveal='report' 的指标数值进通知即泄露）；
//   ② eventId = 跃迁后 state + state_since ⇒ 同一次跃迁重跑撞主键即幂等；
//   ③ 收件人是投递期解析出的名字数组（`to` 逗号串），规则只声明 `kind=field`。
import type { MonitorRow } from './monitor-store'
import type { MonitorOutcome } from './monitor-spec'
import type { NotifyKind, TransitionResult } from './monitor-state'

export type MonitorEventKey = 'data.monitor.fired' | 'data.monitor.resolved' | 'data.monitor.disabled'

export interface MonitorEvent {
  eventKey: MonitorEventKey
  eventId: string
  scope: string
  payload: Record<string, unknown>
  producer: 'data'
}

const EVENT_KEY_OF: Record<Exclude<NotifyKind, null>, MonitorEventKey> = {
  fired: 'data.monitor.fired',
  resolved: 'data.monitor.resolved',
  disabled: 'data.monitor.disabled',
}

/**
 * 构造一条监控事件。`notify` 必须非空（调用方已判跃迁与影子期）。
 * `to` 为空 ⇒ 调用方不应调用本函数（无收件人不是投递失败，是配置问题，tick 会留痕）。
 */
export function monitorEventOf(
  m: Pick<MonitorRow, 'id' | 'name' | 'windowDays'>,
  tr: Pick<TransitionResult, 'notify' | 'state' | 'stateSince'>,
  outcome: MonitorOutcome,
  to: readonly string[],
): MonitorEvent {
  if (tr.notify === null) throw new Error('monitorEventOf: notify is null')
  const payload: Record<string, unknown> = {
    // 声明是 user_list（notify 的 field 收件人只接受 user/user_list），值是名字数组。
    to: [...to],
    monitorId: m.id,
    name: m.name,
    verdict: outcome.verdict,
    link: '/console/data/reports',
  }
  // fired / resolved 都带窗口（模板要用）；水位来源只在 fired 有意义。
  if (tr.notify !== 'disabled') payload.windowDays = m.windowDays
  if (tr.notify === 'fired' && outcome.watermarkRef !== null) payload.watermarkRef = outcome.watermarkRef
  return {
    eventKey: EVENT_KEY_OF[tr.notify],
    // state + state_since = 这次跃迁的身份；重试同一轮不会重复发。
    eventId: `monitor:${m.id}:${tr.state}:${tr.stateSince.toISOString()}`,
    scope: `monitor:${m.id}`,
    payload,
    producer: 'data',
  }
}
