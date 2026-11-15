// routes.test.ts — jobs 模块骨架的门禁/CSRF/端口降级（Wave 6 P4a，纯单元、不连库）。
//
// 门禁**不在模块里**（宿主按 manifest.api.internal 施加），所以测试壳复刻 loader
// `applyDeclaredApiGate` 的形状：真 `declaredScopeGate` + manifest 自己的声明 + 静态在前。
// 这里刻意不把权限判断写进模块再测一遍——那会把「门卫归宿主」这条纪律测成模块私货。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { declaredScopeGate, type Identity, type JobsPort, type ModuleContext } from '@platform/sdk'
import jobsMod from './index'

const TENANT_ID = 42
const SESSION = { sub: 'u-1', org: 'org-jobs', name: 'u-1', scopes: [], iat: 0, exp: 9e9 }
const CSRF = 'csrf-good'

function makeIdentity(scopes: string[]): Identity {
  return {
    userId: 'u-1',
    orgId: 'org-jobs',
    displayName: '测试用户',
    scopes,
    hasScope: (code: string) => scopes.includes(code),
  }
}

function makeJobs(overrides: Partial<JobsPort> = {}): JobsPort {
  return {
    listSchedules: async () => [],
    listRuns: async () => [],
    runNow: async () => ({ runId: 'run-1' }),
    ...overrides,
  }
}

/** 复刻宿主装载形状：identity/tenant/session 注入 → 逐条声明挂门卫 → 挂模块 router。 */
function buildApp(opts: {
  scopes: string[]
  jobs?: JobsPort
  csrfVerify?: ModuleContext['csrfVerify']
  session?: unknown
}): Hono {
  const identity = makeIdentity(opts.scopes)
  const app = new Hono<{ Variables: { identity: Identity; tenant: { id: number }; session?: unknown } }>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    c.set('tenant', { id: TENANT_ID })
    if (opts.session !== undefined) c.set('session', opts.session)
    await next()
  })

  const declared = jobsMod.manifest.api?.internal ?? []
  const guarded = new Hono()
  // 未挂载 ⇒ 门卫比对基准是【模块相对】路径（挂载后才是宿主绝对路径）——见 declaredScopeGate 头注
  const gate = declaredScopeGate(declared)
  const paths = [...new Set(declared.map((d) => d.path))]
    .sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
  for (const p of paths) guarded.use(p, gate)
  guarded.route('/', jobsMod.createRouter({
    pool: null as never,
    jobs: opts.jobs,
    csrfVerify: opts.csrfVerify,
  }))
  app.route('/', guarded)
  return app as unknown as Hono
}

const verifyCsrf: ModuleContext['csrfVerify'] = (session, header) =>
  session === SESSION && header === CSRF

const post = (header?: string): RequestInit => ({
  method: 'POST',
  headers: header === undefined ? undefined : { 'x-csrf-token': header },
})

describe('jobs 模块声明 ↔ 注册一致', () => {
  it('api.internal 声明集合 == createRouter 注册集合（非 ALL 路由逐条相等）', () => {
    const router = jobsMod.createRouter({ pool: null as never })
    const registered = new Set(
      router.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
    )
    const declared = new Set(
      (jobsMod.manifest.api?.internal ?? []).map((d) => `${d.method} ${d.path}`),
    )
    expect(registered).toEqual(declared)
  })
})

describe('宿主门卫（declaredScopeGate）', () => {
  it('三个端点无对应码 ⇒ 403（未挂码连路由都不可达）', async () => {
    const app = buildApp({ scopes: [], jobs: makeJobs(), csrfVerify: verifyCsrf, session: SESSION })
    expect((await app.request('/schedules')).status).toBe(403)
    expect((await app.request('/runs/notify.emit')).status).toBe(403)
    expect((await app.request('/notify.emit/run', post(CSRF))).status).toBe(403)
  })

  it('只有读码 ⇒ 读 200、写 403（写需要 jobs:manage）', async () => {
    const app = buildApp({ scopes: ['jobs:read'], jobs: makeJobs(), csrfVerify: verifyCsrf, session: SESSION })
    expect((await app.request('/schedules')).status).toBe(200)
    expect((await app.request('/runs/notify.emit')).status).toBe(200)
    expect((await app.request('/notify.emit/run', post(CSRF))).status).toBe(403)
  })

  it('有码 ⇒ 200', async () => {
    const app = buildApp({
      scopes: ['jobs:read', 'jobs:manage'], jobs: makeJobs(), csrfVerify: verifyCsrf, session: SESSION,
    })
    expect((await app.request('/schedules')).status).toBe(200)
    expect((await app.request('/runs/notify.emit')).status).toBe(200)
    expect((await app.request('/notify.emit/run', post(CSRF))).status).toBe(200)
  })
})

describe('ctx.jobs 缺失（旧宿主/单测环境）', () => {
  it('三个端点都 503 JOBS_UNAVAILABLE（不当成"没有任务"）', async () => {
    const app = buildApp({
      scopes: ['jobs:read', 'jobs:manage'], jobs: undefined, csrfVerify: verifyCsrf, session: SESSION,
    })
    for (const res of [
      await app.request('/schedules'),
      await app.request('/runs/notify.emit'),
      await app.request('/notify.emit/run', post(CSRF)),
    ]) {
      expect(res.status).toBe(503)
      expect((await res.json()).error).toBe('JOBS_UNAVAILABLE')
    }
  })
})

describe('CSRF（模块子树默认没有，写操作必须自带）', () => {
  const scopes = ['jobs:read', 'jobs:manage']
  const write = () => buildApp({ scopes, jobs: makeJobs(), csrfVerify: verifyCsrf, session: SESSION })

  it('缺 x-csrf-token ⇒ 403 CSRF', async () => {
    const res = await write().request('/notify.emit/run', post())
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('CSRF')
  })

  it('头不匹配 ⇒ 403 CSRF', async () => {
    const res = await write().request('/notify.emit/run', post('csrf-bad'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('CSRF')
  })

  it('未注入 csrfVerify ⇒ fail-closed 403（不因"旧宿主"放开写操作）', async () => {
    const app = buildApp({ scopes, jobs: makeJobs(), csrfVerify: undefined, session: SESSION })
    const res = await app.request('/notify.emit/run', post(CSRF))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('CSRF')
  })

  it('会话缺失 ⇒ 403（有注入但没会话不算通过）', async () => {
    const app = buildApp({ scopes, jobs: makeJobs(), csrfVerify: verifyCsrf })
    const res = await app.request('/notify.emit/run', post(CSRF))
    expect(res.status).toBe(403)
  })

  it('正确 ⇒ 200，且只入队（响应 status=queued）', async () => {
    const res = await write().request('/notify.emit/run', post(CSRF))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ key: 'notify.emit', status: 'queued' })
  })
})

describe('runNow 必须带审计归属（身份来自会话，不读请求体）', () => {
  it('端口收到非空的 tenantId / userId', async () => {
    const seen: Array<{ tenantId?: number; userId?: string } | undefined> = []
    const jobs = makeJobs({
      runNow: async (_key, actor) => {
        seen.push(actor)
        return { runId: 'run-9' }
      },
    })
    const app = buildApp({
      scopes: ['jobs:manage'], jobs, csrfVerify: verifyCsrf, session: SESSION,
    })
    const res = await app.request('/notify.emit/run', post(CSRF))
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tenantId).toBe(TENANT_ID)
    expect(seen[0]?.userId).toBe('u-1')
  })
})

describe('listRuns 的 limit 口径', () => {
  function limitRecorder() {
    const seen: number[] = []
    const jobs = makeJobs({
      listRuns: async (_key, limit) => {
        seen.push(limit)
        return []
      },
    })
    return { seen, jobs }
  }

  it('缺省 50；超过上限截到 100', async () => {
    const { seen, jobs } = limitRecorder()
    const app = buildApp({ scopes: ['jobs:read'], jobs, csrfVerify: verifyCsrf, session: SESSION })
    expect((await app.request('/runs/notify.emit')).status).toBe(200)
    expect((await app.request('/runs/notify.emit?limit=500')).status).toBe(200)
    expect(seen).toEqual([50, 100])
  })

  it('非法 limit ⇒ 400（不静默回落）', async () => {
    const { jobs } = limitRecorder()
    const app = buildApp({ scopes: ['jobs:read'], jobs, csrfVerify: verifyCsrf, session: SESSION })
    for (const q of ['0', 'abc', '-1', '1.5']) {
      expect((await app.request(`/runs/notify.emit?limit=${q}`)).status).toBe(400)
    }
  })
})

describe('端口错误码 → HTTP（带 retryable 提示）', () => {
  function throwing(code: string) {
    return makeJobs({ runNow: async () => { throw Object.assign(new Error(code), { code }) } })
  }

  it('JOB_NOT_FOUND ⇒ 404 不可重试；JOB_ALREADY_PENDING ⇒ 409；JOB_LOCK_TIMEOUT ⇒ 503', async () => {
    const cases = [
      ['JOB_NOT_FOUND', 404, false],
      ['JOB_ALREADY_PENDING', 409, true],
      ['JOB_LOCK_TIMEOUT', 503, true],
    ] as const
    for (const [code, status, retryable] of cases) {
      const app = buildApp({
        scopes: ['jobs:manage'], jobs: throwing(code), csrfVerify: verifyCsrf, session: SESSION,
      })
      const res = await app.request('/notify.emit/run', post(CSRF))
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: code, key: 'notify.emit', retryable })
    }
  })
})
