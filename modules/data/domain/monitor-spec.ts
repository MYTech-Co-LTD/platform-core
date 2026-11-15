// monitor-spec.ts — 业务监控的闭集与纯函数（Wave 7 V1，spec §4/§5/§6）。
//
// 这里的每一种「可配置」都是**闭集**：target_kind / verdict / operator / channel_policy
// 都是枚举，永不接受表达式或任意 SQL。新增取值 = 改 spec + 改这里 + 改库侧 check，三处同改。
//
// 时间口径：业务日一律 **Asia/Shanghai 的日历日**（`YYYY-MM-DD`），与 query-service 的
// freshnessStatusOf / window 同一套钟点（+08:00 恒定，无夏令时）。
export type MonitorTargetKind = 'metric' | 'report_panel'
export type MonitorVerdict = 'missing' | 'stale' | 'threshold'
export type MonitorState = 'ok' | 'firing' | 'unknown'
export type MonitorChannelPolicy = 'in_app' | 'wecom' | 'webhook'

/** 收件人闭集（spec §9）：部门或人，ref 由创建期校验、投递期复判。 */
export interface MonitorRecipient {
  kind: 'dept' | 'user'
  ref: string
}

export interface NewMonitorInput {
  org: string
  name: string
  targetKind: MonitorTargetKind
  metricId?: string | null
  reportId?: string | null
  panelIndex?: number | null
  filters?: Record<string, unknown>
  verdict: MonitorVerdict
  windowDays?: number
  cadenceSecs: number
  cooldownSecs?: number
  recipients: MonitorRecipient[]
  channelPolicy?: MonitorChannelPolicy
  createdBy: string
}

export type MonitorValidationError =
  | 'MONITOR_NAME_REQUIRED'
  | 'MONITOR_TARGET_INVALID'
  | 'MONITOR_VERDICT_UNSUPPORTED'
  | 'MONITOR_WINDOW_INVALID'
  | 'MONITOR_CADENCE_TOO_SHORT'
  | 'MONITOR_RECIPIENTS_INVALID'

export type ValidationResult =
  | { ok: true; value: NewMonitorInput & { windowDays: number; cooldownSecs: number; channelPolicy: MonitorChannelPolicy; filters: Record<string, unknown> } }
  | { ok: false; code: MonitorValidationError; message: string }

export const MONITOR_MIN_CADENCE_SECS = 300
export const MONITOR_QUOTA_PER_ORG = 20
export const MONITOR_FAIL_LIMIT = 5

/**
 * 建行校验（spec §4 闭集 + §5 列约束）。**V1 只支持 missing / stale**——
 * `threshold` 直接拒绝，不「先建着以后再求值」（建了却永不求值 = 静默失约）。
 */
export function validateNewMonitor(input: NewMonitorInput): ValidationResult {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') return { ok: false, code: 'MONITOR_NAME_REQUIRED', message: '监控名不能为空' }

  if (input.targetKind === 'metric') {
    if (typeof input.metricId !== 'string' || input.metricId.trim() === '') {
      return { ok: false, code: 'MONITOR_TARGET_INVALID', message: '指标监控必须给 metricId' }
    }
  } else if (input.targetKind === 'report_panel') {
    if (typeof input.reportId !== 'string' || input.reportId.trim() === '') {
      return { ok: false, code: 'MONITOR_TARGET_INVALID', message: '报表面板监控必须给 reportId' }
    }
    if (!Number.isInteger(input.panelIndex) || (input.panelIndex ?? -1) < 0) {
      return { ok: false, code: 'MONITOR_TARGET_INVALID', message: '报表面板监控必须给非负 panelIndex' }
    }
  } else {
    return { ok: false, code: 'MONITOR_TARGET_INVALID', message: 'target_kind 只允许 metric | report_panel' }
  }

  if (input.verdict === 'threshold') {
    return { ok: false, code: 'MONITOR_VERDICT_UNSUPPORTED', message: 'threshold 判据属于 W7-V2，V1 只支持 missing / stale' }
  }
  if (input.verdict !== 'missing' && input.verdict !== 'stale') {
    return { ok: false, code: 'MONITOR_VERDICT_UNSUPPORTED', message: 'verdict 只允许 missing | stale（V1）' }
  }

  const windowDays = input.windowDays ?? 1
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    return { ok: false, code: 'MONITOR_WINDOW_INVALID', message: '窗口天数必须在 1–30' }
  }

  if (!Number.isInteger(input.cadenceSecs) || input.cadenceSecs < MONITOR_MIN_CADENCE_SECS) {
    return { ok: false, code: 'MONITOR_CADENCE_TOO_SHORT', message: `求值周期不得小于 ${MONITOR_MIN_CADENCE_SECS} 秒` }
  }

  const recipients = Array.isArray(input.recipients) ? input.recipients : []
  if (recipients.length === 0) {
    return { ok: false, code: 'MONITOR_RECIPIENTS_INVALID', message: '至少一个收件人' }
  }
  for (const r of recipients) {
    if ((r?.kind !== 'dept' && r?.kind !== 'user') || typeof r?.ref !== 'string' || r.ref.trim() === '') {
      return { ok: false, code: 'MONITOR_RECIPIENTS_INVALID', message: '收件人必须是 {kind: dept|user, ref}' }
    }
  }

  return {
    ok: true,
    value: {
      ...input,
      name,
      windowDays,
      cooldownSecs: input.cooldownSecs ?? 3600,
      channelPolicy: input.channelPolicy ?? 'in_app',
      filters: input.filters ?? {},
    },
  }
}

const BIZ_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Asia/Shanghai 的今天（`YYYY-MM-DD`）。与 query-service 的注入法一致：可显式传 now 测。 */
export function todayOf(now: Date): string {
  return BIZ_DATE_FMT.format(now)
}

/** `YYYY-MM-DD` 加减天数（UTC 毫秒运算；日期字符串本身是日历日，不受时区影响）。 */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * 求值窗口（闭区间）：`end = 今天`，`start = 今天 - (windowDays-1)`。
 * windowDays=1 ⇒ 只看今天；windowDays=7 ⇒ 近 7 个日历日。
 */
export function windowOf(m: { windowDays: number }, now: Date): { start: string; end: string } {
  const end = todayOf(now)
  return { start: addDays(end, -(Math.max(1, m.windowDays) - 1)), end }
}

/**
 * `stale` 的判定线（spec §6 逐字）：水位**早于** `today - window_days` 才算过期。
 * windowDays=1 ⇒ 水位为今天或昨天都算新鲜（允许一天迟滞）。
 */
export function staleThresholdOf(today: string, windowDays: number): string {
  return addDays(today, -Math.max(1, windowDays))
}

/** 一次求值的结论（状态机与台账共用的闭集）。 */
export type MonitorOutcome =
  | { verdict: 'ok'; watermarkRef: string | null }
  | { verdict: 'missing' | 'stale'; value: number | null; watermarkRef: string | null }
  | { verdict: 'unknown'; error: string; watermarkRef: string | null }
