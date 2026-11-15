// routes.ts — jobs 模块的域面（Wave 6 P4a）。
//
// 模块零认证：权限门禁由宿主按 manifest.api.internal 施加（未声明 = 不可达），这里**不写**
// `requireScope`（与 notify/data 同纪律）。数据也不直连 `platform.job_*`（B1）：一切经宿主
// 注入的 `ctx.jobs`，未注入是旧宿主/单测环境 ⇒ 显式降级 503 `JOBS_UNAVAILABLE`。
//
// 写操作的 CSRF：模块子树**默认没有** CSRF（宿主只在自己的路由上挂了中间件），所以本模块
// 必须自带。宿主把「会话 + 头 → 是否通过」做成 `ctx.csrfVerify` 注入（模块拿不到
// sessionSecret，也不需要知道算法）；**未注入 = fail-closed**，写操作一律 403 `CSRF`。
import { Hono } from 'hono'
import type { Identity, JobsPort, ModuleContext } from '@platform/sdk'

export interface JobsRouterDeps {
  /** 宿主注入的系统任务端口；未注入 ⇒ 三个端点都 503（旧宿主/单测环境）。 */
  jobs?: JobsPort
  /** 宿主注入的 CSRF 校验（`csrfToken(session, sessionSecret)` 的宿主封装）；未注入 ⇒ 写操作 403。 */
  csrfVerify?: ModuleContext['csrfVerify']
}

/**
 * 模块路由的 Hono Env。`identity` / `tenant` 由宿主注入（与 data 模块同款收窄：
 * 这里只用到 tenant.id 做审计归属）；`session` 原样交给 `csrfVerify` 校验，模块不解释其形状。
 */
export type JobsVars = {
  Variables: {
    identity: Identity
    tenant: { id: number; casdoor_org?: string }
    session?: unknown
  }
}

/** `limit` 的默认值与硬上限（端口自己也会截 100，这里是 HTTP 面同一条口径）。 */
const DEFAULT_RUNS_LIMIT = 50
const MAX_RUNS_LIMIT = 100

/** 端口错误码 → HTTP。`retryable` 是给调用方/前端的提示，不参与重试决策（决策在 worker）。 */
const PORT_ERRORS: Record<string, { status: 404 | 409 | 503; retryable: boolean }> = {
  JOB_NOT_FOUND: { status: 404, retryable: false },
  JOB_ALREADY_PENDING: { status: 409, retryable: true },
  JOB_LOCK_TIMEOUT: { status: 503, retryable: true },
}

export function createJobsRouter(deps: JobsRouterDeps): Hono<JobsVars> {
  const r = new Hono<JobsVars>()

  // CSRF：写操作必须通过宿主注入的校验；未注入 / 会话缺失 / 头不匹配一律 403。
  // GET/HEAD 不改状态，不要求（照 routes/api-keys.ts 的先例）。
  r.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const verify = deps.csrfVerify
      const ok = verify !== undefined && verify(c.get('session'), c.req.header('x-csrf-token'))
      if (!ok) return c.json({ error: 'CSRF' }, 403)
    }
    await next()
  })

  r.get('/schedules', async (c) => {
    if (!deps.jobs) return c.json({ error: 'JOBS_UNAVAILABLE' }, 503)
    return c.json({ schedules: await deps.jobs.listSchedules() })
  })

  r.get('/runs/:key', async (c) => {
    const key = c.req.param('key')
    const raw = c.req.query('limit')
    let limit = DEFAULT_RUNS_LIMIT
    if (raw !== undefined) {
      const n = Number(raw)
      // 显式拒绝非法 limit：静默回落会让「我要看最近 500 条」与「只给了 100 条」不可区分。
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
        return c.json({ error: 'BAD_LIMIT', max: MAX_RUNS_LIMIT }, 400)
      }
      limit = Math.min(n, MAX_RUNS_LIMIT)
    }
    if (!deps.jobs) return c.json({ error: 'JOBS_UNAVAILABLE' }, 503)
    return c.json({ key, runs: await deps.jobs.listRuns(key, limit) })
  })

  r.post('/:key/run', async (c) => {
    if (!deps.jobs) return c.json({ error: 'JOBS_UNAVAILABLE' }, 503)
    const key = c.req.param('key')
    // 审计归属只来自身份（不读请求体）：tenantId 给宿主端口写 platform.audit，
    // userId 是会话用户；两者都不由调用方传参决定。
    const identity = c.get('identity')
    const tenantId = c.get('tenant')?.id
    try {
      const { runId } = await deps.jobs.runNow(key, { tenantId, userId: identity?.userId })
      return c.json({ runId, key, status: 'queued' })
    } catch (e) {
      const code = (e as { code?: string }).code
      const mapped = code === undefined ? undefined : PORT_ERRORS[code]
      if (mapped === undefined) throw e
      return c.json({ error: code, key, retryable: mapped.retryable }, mapped.status)
    }
  })

  return r
}
