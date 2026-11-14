// scheduled-emit.ts — `notify.emit` job handler 的纯函数部分（2026-11-14）。
//
// 调度器只负责“到点 spawn 脚本”；本文件负责把 JOB_PARAMS 变成可入队的事件：
//   · 形状/大小校验（fail-closed，参数错了 exit 2，不重试）；
//   · 确定性 eventId（schedule:<id>:<occurrence>，重跑不双发）；
//   · 有限时间变量替换（只支持 {{occurrence}} / {{now}} / {{date}} / {{timezone}}，
//     不做通用模板引擎——避免通知底座长成工作流引擎）；
//   · namespace 归属校验（agent 只能发自己 namespace 的 ext 事件）。
//
// 不读 env / 不建连接：脚本与单测都只调这里的纯函数。
import { validatePayload, type EnqueueEventInput, type NotificationEventDecl } from '@platform/sdk'

/** JOB_PARAMS 上限。调度器侧同口径；超过必须 exit 2，不静默截断。 */
export const MAX_JOB_PARAMS_BYTES = 16 * 1024

export type ScheduledEmitParams = {
  eventKey: string
  scope?: string
  payload: Record<string, unknown>
  /** 可选模板：支持 {{scheduleId}} / {{occurrence}}；缺省 schedule:<id>:<occurrence> */
  eventId?: string
}

export type ParseScheduledEmitResult =
  | { ok: true; params: ScheduledEmitParams }
  | { ok: false; reason: 'params_too_large' | 'params_invalid_json' | 'params_invalid_shape' }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function parseScheduledEmitParams(raw: string): ParseScheduledEmitResult {
  if (new TextEncoder().encode(raw).length > MAX_JOB_PARAMS_BYTES) {
    return { ok: false, reason: 'params_too_large' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'params_invalid_json' }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'params_invalid_shape' }

  const eventKey = parsed.eventKey
  const payload = parsed.payload
  const scope = parsed.scope
  const eventId = parsed.eventId
  if (typeof eventKey !== 'string' || eventKey.trim() === '') {
    return { ok: false, reason: 'params_invalid_shape' }
  }
  if (!isPlainObject(payload)) return { ok: false, reason: 'params_invalid_shape' }
  if (scope !== undefined && typeof scope !== 'string') {
    return { ok: false, reason: 'params_invalid_shape' }
  }
  if (eventId !== undefined && (typeof eventId !== 'string' || eventId.trim() === '')) {
    return { ok: false, reason: 'params_invalid_shape' }
  }
  return {
    ok: true,
    params: {
      eventKey,
      payload,
      ...(scope === undefined ? {} : { scope }),
      ...(eventId === undefined ? {} : { eventId }),
    },
  }
}

/**
 * 确定性 eventId：缺省 `schedule:<id>:<occurrence>`。
 * 模板只支持两个占位符；不要在这里加任意模板能力。
 */
export function buildOccurrenceEventId(
  scheduleId: string,
  occurrence: string,
  template?: string,
): string {
  if (template === undefined || template === '') return `schedule:${scheduleId}:${occurrence}`
  return template
    .replaceAll('{{scheduleId}}', scheduleId)
    .replaceAll('{{occurrence}}', occurrence)
}

export type TimeSubstitutionContext = {
  occurrence: string
  now: string
  timezone: string
}

/** 有限时间变量替换：只替换四个保留 token；字符串以外的值原样保留。 */
export function substituteOccurrenceVars(
  value: unknown,
  ctx: TimeSubstitutionContext,
): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{occurrence}}', ctx.occurrence)
      .replaceAll('{{now}}', ctx.now)
      .replaceAll('{{date}}', dateInZone(ctx.occurrence, ctx.timezone))
      .replaceAll('{{timezone}}', ctx.timezone)
  }
  if (Array.isArray(value)) return value.map((v) => substituteOccurrenceVars(v, ctx))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteOccurrenceVars(v, ctx)
    return out
  }
  return value
}

function dateInZone(iso: string, timeZone: string): string {
  try {
    // en-CA 的 short date 是 YYYY-MM-DD（与我们的 {{date}} 约定一致）。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso))
  } catch {
    // 非法 timezone/时刻：退回 UTC，不因展示格式让整次 job 失败。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso))
  }
}

export type NamespaceCheck =
  | { ok: true }
  | { ok: false; reason: 'namespace_required' | 'namespace_mismatch' | 'event_key_invalid' }

/**
 * 归属校验：
 * - `ext.<namespace>.<event>` 必须由同名 namespace 发；无 namespace ⇒ 拒绝；
 * - 平台事件（非 `ext.`）只允许系统 job（无 namespace）；带 namespace ⇒ 拒绝，防止
 *   agent 借排班发平台事件。
 */
export function assertNamespace(eventKey: string, namespace: string | undefined): NamespaceCheck {
  const isExt = eventKey.startsWith('ext.')
  if (!isExt) {
    return namespace === undefined || namespace === ''
      ? { ok: true }
      : { ok: false, reason: 'namespace_mismatch' }
  }
  if (namespace === undefined || namespace === '') return { ok: false, reason: 'namespace_required' }
  const parts = eventKey.split('.')
  if (parts.length !== 3 || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'event_key_invalid' }
  }
  return parts[1] === namespace ? { ok: true } : { ok: false, reason: 'namespace_mismatch' }
}

// ── 编排（脚本与单测共用；依赖注入，无 IO）──────────────────────────────────

export type ScheduledEmitDeps = {
  /** 声明事实源：平台事件来自 platform.event_catalog；租户事件来自 notify.event_decl。 */
  getEventDecl(org: string, key: string): Promise<NotificationEventDecl | null>
  enqueue(input: EnqueueEventInput): Promise<{ accepted: boolean; reason?: string }>
  /** `{{now}}` 的取值；测试注入固定时刻。 */
  now(): Date
}

export type ScheduledEmitInput = {
  scheduleId: string
  occurrence: string
  rawParams: string
  org: string
  namespace?: string
  timezone: string
}

export type ScheduledEmitResult =
  | { ok: true; eventId: string; accepted: boolean; reason?: string }
  | { ok: false; retryable: boolean; reason: string }

/**
 * 一次 `notify.emit` job 的完整编排。
 *
 * `retryable=false` ⇒ 脚本 exit 2（参数/声明/归属错误，重试无意义）；
 * `retryable=true` ⇒ 脚本 exit 1（DB/临时故障，交给调度器按 max_attempts 重排）。
 */
export async function runScheduledEmitJob(
  deps: ScheduledEmitDeps,
  input: ScheduledEmitInput,
): Promise<ScheduledEmitResult> {
  const parsed = parseScheduledEmitParams(input.rawParams)
  if (!parsed.ok) return { ok: false, retryable: false, reason: parsed.reason }
  const params = parsed.params

  const ns = assertNamespace(params.eventKey, input.namespace)
  if (!ns.ok) return { ok: false, retryable: false, reason: ns.reason }

  let decl: NotificationEventDecl | null
  try {
    decl = await deps.getEventDecl(input.org, params.eventKey)
  } catch {
    return { ok: false, retryable: true, reason: 'decl_lookup_failed' }
  }
  if (!decl) return { ok: false, retryable: false, reason: 'event_not_declared' }

  const payload = substituteOccurrenceVars(params.payload, {
    occurrence: input.occurrence,
    now: deps.now().toISOString(),
    timezone: input.timezone,
  }) as Record<string, unknown>
  const bad = validatePayload(decl, payload)
  if (bad) return { ok: false, retryable: false, reason: `payload_invalid:${bad}` }

  const eventId = buildOccurrenceEventId(input.scheduleId, input.occurrence, params.eventId)
  try {
    const r = await deps.enqueue({
      org: input.org,
      eventId,
      eventKey: params.eventKey,
      scope: params.scope ?? '*',
      payload,
      producer: input.namespace ? `agent:${input.namespace}` : 'scheduler',
    })
    return {
      ok: true, eventId, accepted: r.accepted,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
    }
  } catch {
    return { ok: false, retryable: true, reason: 'enqueue_failed' }
  }
}
