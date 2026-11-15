// schedules.ts — notify 的 agent 排班工具面（W6-P3 八个工具；N4 起 namespace-aware）。
//
// 四条硬边界（与 SchedulerPort 的语义逐条对齐）：
//  ① **只调 `ctx.scheduler`**，不直连 `platform.job_*`；归属 actor 由工具层从**请求身份**取。
//     N4 起接受可选 `namespace` 参数，但它只是**选择**落在哪个自己拥有的 namespace
//     （`namespaces.owns` 校验 owner），改变不了 `owner_org/created_by`——那些仍由端口按
//     actor 绑定，params 里的同名键会被端口剥掉。
//  ② **不接受任何通道参数**（channel/webhook/wecom…）：`params` 只白名单成形
//     `{eventKey, scope?, payload}`，其余键一律丢弃。排班只发站内通知；外发通道由人在控制台
//     改 notify 规则，工具面不提供。
//  ③ 端口错误**原样透出 `code`**；`QUOTA_EXCEEDED` 额外带 `kind`/`limit`，
//     `JOB_LOCK_TIMEOUT` 带 `retryable:true`（锁忙是有界等待失败，重试即可）。
//  ④ **job key ≠ 事件 key**：排班的 job key 恒为 `notify.emit`（registry 白名单），
//     通知事件 key 在 `params.eventKey` 里、由执行期 `scripts/notify-emit-job.mjs` 消费。
//
// 本文件保持**纯**（只 `import type`）：`scripts/check-mcp-toolface.mjs` 经
// `mcp-tools.ts` 把它算进工具面预算，运行时依赖会连坐门禁。
import type {
  NotificationEventDecl, SchedulerPortFactory, SchedulerPortLike,
} from '@platform/sdk'

/** 与 `mcp-tools.ts` 的 `NotifyToolMeta` 结构相同（此处不 import，避免运行时环）。 */
export interface ScheduleToolMeta {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutating: boolean
  annotations: Record<string, unknown>
  requiredScope: string | null
}

/** 工具层从请求身份取到的 actor；`namespace` 缺省补 org（v1 一个 org 一个 namespace）。 */
export interface ScheduleActor {
  userId: string
  org: string
  namespace?: string
}

export interface ScheduleToolDeps {
  /** 未注入 = 旧宿主/单测环境：所有工具返回 `SCHEDULER_UNAVAILABLE`，不抛。 */
  scheduler?: SchedulerPortFactory
  actor: ScheduleActor
  /**
   * N4：agent namespace 归属（由 `mcp.ts` 从 `notify.agent_namespace` 注入）。
   * **未注入 = 旧宿主/P3 单测**：不校验归属，namespace 回退 org（向后兼容）。
   */
  namespaces?: {
    /** 调用者在本 org 拥有的 active namespace 列表。 */
    owned(): Promise<string[]>
    /** namespace 是否存在、active 且 owner = 调用者。 */
    owns(namespace: string): Promise<boolean>
  }
  /** 事件声明解析（ext.* 走 notify.event_decl，其余走 manifest 目录）。 */
  resolveEventDecl?: (org: string, key: string) => Promise<NotificationEventDecl | null>
  /** payload 按事件声明校验（SDK validatePayload 的注入形态，保持本文件纯）。 */
  validatePayload?: (
    decl: NotificationEventDecl,
    payload: Record<string, unknown>,
  ) => string | null
}

export type ScheduleToolResult = { text: string; isError: boolean }

const t = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  mutating: boolean,
  requiredScope: string | null,
): ScheduleToolMeta => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  mutating,
  annotations: { readOnlyHint: !mutating },
  requiredScope,
})

const ID = { type: 'string', description: '排班 id（list_schedules 返回）' }
const NS = {
  type: 'string',
  description: 'agent namespace；缺省从事件 key 的 ext.<ns> 段推导（多 namespace 时必须显式）',
}

export const SCHEDULE_TOOLS: ScheduleToolMeta[] = [
  t('create_schedule',
    '建一条周期消息排班（按 cron 重复触发 notify.emit 事件）。只发站内通知；外发通道由人在控制台改规则，本工具不接受任何通道参数。',
    {
      cron: { type: 'string', description: '5 段 cron（分 时 日 月 周）' },
      params: {
        type: 'object',
        description: '周期消息参数',
        properties: {
          eventKey: { type: 'string', description: '通知事件 key（ext.<namespace>.<event>；agent 只能排自己 namespace 的事件）' },
          payload: { type: 'object', description: '事件 payload' },
          scope: { type: 'string', description: '事件作用域，缺省 *' },
        },
        required: ['eventKey'],
        additionalProperties: false,
      },
      namespace: NS,
      timezone: { type: 'string', description: 'IANA 时区，缺省 UTC' },
      expectedIntervalSecs: { type: 'number', description: '期望间隔（秒）；缺省由端口从 cron 推导扫描周期内的最大相邻间隔' },
    },
    ['cron', 'params'], true, 'notify:manage'),
  t('list_schedules', '列出本 namespace 由 agent 建的排班（含启停状态与下次触发时间）。',
    { namespace: NS }, [], false, null),
  t('pause_schedule', '暂停一条排班（保留排班与运行台账，可再 resume）。',
    { id: ID, namespace: NS }, ['id'], true, 'notify:manage'),
  t('resume_schedule', '恢复一条已暂停的排班；下次触发时间按 cron 重算。',
    { id: ID, namespace: NS }, ['id'], true, 'notify:manage'),
  t('delete_schedule', '删除一条排班（软删；运行台账保留，删除后不可恢复）。',
    { id: ID, namespace: NS }, ['id'], true, 'notify:manage'),
  t('list_schedule_runs', '查看一条排班的运行台账（最近 limit 条，默认 50，上限 100）。',
    { id: ID, namespace: NS, limit: { type: 'number' } }, ['id'], false, null),
  t('run_schedule_now', '立即触发一次排班：只入队，由调度 worker 执行；不会改 cron。',
    { id: ID, namespace: NS }, ['id'], true, 'notify:manage'),
  t('get_schedule_quota', '查看本 namespace 的排班配额使用（条数 50、最小间隔 300s、每日触发 200）。',
    { namespace: NS }, [], false, null),
]

const SCHEDULE_TOOL_NAMES = new Set(SCHEDULE_TOOLS.map((x) => x.name))

/** `mcp.ts` 用它判断是否把调用转给本文件（非排班工具返回 null）。 */
export function isScheduleTool(name: string): boolean {
  return SCHEDULE_TOOL_NAMES.has(name)
}

const ok = (payload: unknown): ScheduleToolResult => ({ text: JSON.stringify(payload), isError: false })
const fail = (code: string, extra: Record<string, unknown> = {}): ScheduleToolResult => ({
  text: JSON.stringify({ ok: false, code, ...extra }),
  isError: true,
})

/** 端口错误 → 工具结果：code 原样透出；配额带 kind/limit；锁忙标可重试。 */
function portError(e: unknown): ScheduleToolResult {
  const x = e as { code?: unknown; detail?: unknown; kind?: unknown; limit?: unknown; message?: unknown }
  if (typeof x.code !== 'string') {
    return fail('SCHEDULER_ERROR', {
      detail: e instanceof Error ? e.message : String(e),
    })
  }
  const extra: Record<string, unknown> = {}
  if (x.code === 'QUOTA_EXCEEDED') {
    if (typeof x.kind === 'string') extra.kind = x.kind
    if (typeof x.limit === 'number') extra.limit = x.limit
  }
  if (x.code === 'JOB_LOCK_TIMEOUT') extra.retryable = true
  if (typeof x.detail === 'string') extra.detail = x.detail
  return fail(x.code, extra)
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function actorPort(deps: ScheduleToolDeps, namespace: string): SchedulerPortLike {
  return deps.scheduler!({
    userId: deps.actor.userId,
    org: deps.actor.org,
    namespace,
  })
}

type NsResolution =
  | { ok: true; namespace: string }
  | { ok: false; result: ScheduleToolResult }

/**
 * N4：解析本次操作落在哪个 namespace。
 *
 * 优先级：显式 `args.namespace`（须 owner）→ 事件 key 的 `ext.<ns>` 段（须 owner）
 * → 调用者唯一 active namespace → **org 兜底**（向后兼容 P3 的「一个 org 一个 namespace」）。
 * 拥有多个 namespace 且未显式指定 ⇒ `NAMESPACE_REQUIRED`（拒绝猜测，不静默选错人）。
 * `deps.namespaces` 未注入（旧宿主/单测）⇒ 一律 org，行为与 P3 逐字一致。
 */
async function resolveNamespace(
  deps: ScheduleToolDeps,
  args: Record<string, unknown>,
  eventKey?: string,
): Promise<NsResolution> {
  const explicit = str(args.namespace)
  const fromEvent = eventKey !== undefined && eventKey.startsWith('ext.')
    ? eventKey.split('.')[1] ?? ''
    : ''

  if (explicit && fromEvent && explicit !== fromEvent) {
    return { ok: false, result: fail('NAMESPACE_MISMATCH', { namespace: explicit, eventKey }) }
  }

  const candidate = explicit || fromEvent
  if (candidate) {
    if (deps.namespaces && !await deps.namespaces.owns(candidate)) {
      return { ok: false, result: fail('NAMESPACE_FORBIDDEN', { namespace: candidate }) }
    }
    return { ok: true, namespace: candidate }
  }

  const owned = deps.namespaces ? await deps.namespaces.owned() : []
  if (owned.length === 1) return { ok: true, namespace: owned[0]! }
  if (owned.length === 0) return { ok: true, namespace: deps.actor.org }
  return { ok: false, result: fail('NAMESPACE_REQUIRED', { owned: owned.length }) }
}

/**
 * 调一个排班工具。返回 `null` = 不是排班工具（调用方继续走自己的分支）。
 * 未注入 scheduler 时**不抛**，返回 `{ok:false,code:'SCHEDULER_UNAVAILABLE'}`。
 */
export async function callScheduleTool(
  deps: ScheduleToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ScheduleToolResult | null> {
  if (!isScheduleTool(name)) return null
  if (!deps.scheduler) return fail('SCHEDULER_UNAVAILABLE')

  try {
    if (name === 'create_schedule') {
      const cron = str(args.cron)
      const params = isObject(args.params) ? args.params : null
      if (!cron || !params) return fail('INVALID_PARAMS')
      const eventKey = str(params.eventKey)
      if (!eventKey) return fail('INVALID_PARAMS')

      // N4：注入了 namespace 依赖 ⇒ 只能排 ext.<namespace>.<event>（自己的事件），
      // 平台事件由系统排班/人负责，不给 agent 定时触发平台事件的口子。
      if (deps.namespaces && !eventKey.startsWith('ext.')) {
        return fail('EVENT_NOT_OWNED', {
          detail: 'agent 排班只能排自己 namespace 的 ext.<namespace>.<event>',
        })
      }

      const ns = await resolveNamespace(deps, args, eventKey)
      if (!ns.ok) return ns.result

      // N4：事件声明与 payload 在建排班时就校验，别等到第一次触发才 exit 2。
      if (deps.resolveEventDecl) {
        const decl = await deps.resolveEventDecl(deps.actor.org, eventKey)
        if (!decl) return fail('EVENT_NOT_DECLARED', { eventKey })
        const payload = isObject(params.payload) ? params.payload : {}
        const bad = deps.validatePayload?.(decl, payload) ?? null
        if (bad) return fail('PAYLOAD_INVALID', { detail: bad })
      }

      // **只白名单成形**：通道类字段（channel/webhook/wecom…）在这里被丢弃，不可能落到排班参数。
      const jobParams: Record<string, unknown> = { eventKey }
      if (params.scope !== undefined) jobParams.scope = params.scope
      if (params.payload !== undefined) jobParams.payload = params.payload

      const timezone = str(args.timezone) || 'UTC'
      // 不传就不传：端口从 cron 推导扫描周期内的最大相邻间隔（health 的 2× 判据才不会假红）。
      const expectedIntervalSecs = typeof args.expectedIntervalSecs === 'number'
        ? Math.trunc(args.expectedIntervalSecs)
        : undefined

      const port = actorPort(deps, ns.namespace)
      // ⚠️ job key 恒为 notify.emit（registry 白名单）；事件 key 在 params 里，
      // 由 scripts/notify-emit-job.mjs 在执行期消费——两者不是一回事，别再混用。
      const r = await port.createSchedule({
        key: 'notify.emit',
        cron,
        timezone,
        params: jobParams,
        ...(expectedIntervalSecs === undefined ? {} : { expectedIntervalSecs }),
      })
      return ok({ id: r.id, nextRunAt: r.nextRunAt, namespace: ns.namespace })
    }

    const id = str(args.id)
    const needId = (): ScheduleToolResult | null => (id ? null : fail('INVALID_PARAMS'))
    const ns = await resolveNamespace(deps, args)
    if (!ns.ok) return ns.result
    const port = actorPort(deps, ns.namespace)

    if (name === 'list_schedules') {
      const schedules = await port.listSchedules({ ownerOrg: deps.actor.org })
      return ok({ namespace: ns.namespace, schedules })
    }

    if (name === 'pause_schedule' || name === 'resume_schedule') {
      const bad = needId()
      if (bad) return bad
      const enabled = name === 'resume_schedule'
      await port.setScheduleEnabled(id, enabled)
      return ok({ ok: true, id, enabled })
    }

    if (name === 'delete_schedule') {
      const bad = needId()
      if (bad) return bad
      await port.deleteSchedule(id)
      return ok({ ok: true, id })
    }

    if (name === 'list_schedule_runs') {
      const bad = needId()
      if (bad) return bad
      const raw = typeof args.limit === 'number' ? Math.trunc(args.limit) : 50
      const limit = Math.min(Math.max(raw, 1), 100)
      const runs = await port.listRuns(id, limit)
      return ok({ runs })
    }

    if (name === 'run_schedule_now') {
      const bad = needId()
      if (bad) return bad
      const { runId } = await port.runNow(id)
      return ok({ runId })
    }

    if (name === 'get_schedule_quota') {
      const quota = await port.quotaOf()
      return ok(quota)
    }

    // isScheduleTool 已拦住未知名；走到这里是清单与分支漂移（扩展时忘记加分支）。
    return fail('UNKNOWN_TOOL', { name })
  } catch (e) {
    return portError(e)
  }
}
