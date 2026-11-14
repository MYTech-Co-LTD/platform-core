// schedules.ts — notify 的 agent 排班工具面（W6-P3 八个工具）。
//
// 三条硬边界（与 SchedulerPort 的语义逐条对齐）：
//  ① **只调 `ctx.scheduler`**，不直连 `platform.job_*`；归属 actor 由工具层从**请求身份**取，
//     绝不从工具参数读 org/namespace（端口已按 actor 绑定归属，参数里的同名键会被端口剥掉）。
//  ② **不接受任何通道参数**（channel/webhook/wecom…）：`params` 只白名单成形
//     `{eventKey, scope?, payload}`，其余键一律丢弃。排班只发站内通知；外发通道由人在控制台
//     改 notify 规则，工具面不提供。
//  ③ 端口错误**原样透出 `code`**；`QUOTA_EXCEEDED` 额外带 `kind`/`limit`，
//     `JOB_LOCK_TIMEOUT` 带 `retryable:true`（锁忙是有界等待失败，重试即可）。
//
// 本文件保持**纯**（只 `import type`）：`scripts/check-mcp-toolface.mjs` 经
// `mcp-tools.ts` 把它算进工具面预算，运行时依赖会连坐门禁。
import type { SchedulerPortFactory, SchedulerPortLike } from '@platform/sdk'

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

export const SCHEDULE_TOOLS: ScheduleToolMeta[] = [
  t('create_schedule',
    '建一条周期消息排班（按 cron 重复触发 notify.emit 事件）。只发站内通知；外发通道由人在控制台改规则，本工具不接受任何通道参数。',
    {
      cron: { type: 'string', description: '5 段 cron（分 时 日 月 周）' },
      params: {
        type: 'object',
        description: '周期消息参数',
        properties: {
          eventKey: { type: 'string', description: '事件 key；v1 只支持 notify.emit' },
          payload: { type: 'object', description: '事件 payload' },
          scope: { type: 'string', description: '事件作用域，缺省 *' },
        },
        required: ['eventKey'],
        additionalProperties: false,
      },
      timezone: { type: 'string', description: 'IANA 时区，缺省 UTC' },
      expectedIntervalSecs: { type: 'number', description: '健康判据的期望间隔（秒），缺省 86400' },
    },
    ['cron', 'params'], true, 'notify:manage'),
  t('list_schedules', '列出本租户由 agent 建的排班（含启停状态与下次触发时间）。', {}, [], false, null),
  t('pause_schedule', '暂停一条排班（保留排班与运行台账，可再 resume）。', { id: ID }, ['id'], true, 'notify:manage'),
  t('resume_schedule', '恢复一条已暂停的排班；下次触发时间按 cron 重算。', { id: ID }, ['id'], true, 'notify:manage'),
  t('delete_schedule', '删除一条排班（软删；运行台账保留，删除后不可恢复）。', { id: ID }, ['id'], true, 'notify:manage'),
  t('list_schedule_runs', '查看一条排班的运行台账（最近 limit 条，默认 50，上限 100）。',
    { id: ID, limit: { type: 'number' } }, ['id'], false, null),
  t('run_schedule_now', '立即触发一次排班：只入队，由调度 worker 执行；不会改 cron。', { id: ID }, ['id'], true, 'notify:manage'),
  t('get_schedule_quota', '查看本租户的排班配额使用（条数 50、最小间隔 300s、每日触发 200）。', {}, [], false, null),
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

/** 缺省期望间隔（秒）：与 notify.emit 的系统占位值一致（日）。显式传入优先。 */
const DEFAULT_EXPECTED_INTERVAL_SECS = 86_400

function actorPort(deps: ScheduleToolDeps): SchedulerPortLike {
  // `namespace` 缺省补 org —— 即使宿主工厂也会补，这里仍显式成形，避免依赖两处口径。
  return deps.scheduler!({
    userId: deps.actor.userId,
    org: deps.actor.org,
    namespace: deps.actor.namespace || deps.actor.org,
  })
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

  const port = actorPort(deps)

  try {
    if (name === 'create_schedule') {
      const cron = str(args.cron)
      const params = isObject(args.params) ? args.params : null
      if (!cron || !params) return fail('INVALID_PARAMS')
      const eventKey = str(params.eventKey)
      if (!eventKey) return fail('INVALID_PARAMS')

      // **只白名单成形**：通道类字段（channel/webhook/wecom…）在这里被丢弃，不可能落到排班参数。
      const jobParams: Record<string, unknown> = { eventKey }
      if (params.scope !== undefined) jobParams.scope = params.scope
      if (params.payload !== undefined) jobParams.payload = params.payload

      const timezone = str(args.timezone) || 'UTC'
      const expectedIntervalSecs = typeof args.expectedIntervalSecs === 'number'
        ? Math.trunc(args.expectedIntervalSecs)
        : DEFAULT_EXPECTED_INTERVAL_SECS

      const r = await port.createSchedule({
        key: eventKey,
        cron,
        timezone,
        params: jobParams,
        expectedIntervalSecs,
      })
      return ok({ id: r.id, nextRunAt: r.nextRunAt })
    }

    const id = str(args.id)
    const needId = (): ScheduleToolResult | null => (id ? null : fail('INVALID_PARAMS'))

    if (name === 'list_schedules') {
      const schedules = await port.listSchedules({ ownerOrg: deps.actor.org })
      return ok({ schedules })
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
