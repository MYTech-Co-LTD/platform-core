// routes/platform-jobs.test.ts — POST /api/platform/jobs/:key/run（Wave 6 P1，Task 10）。
//
// 组装：只注入 tenant / session / identity 三个 context 变量 + platformJobRoutes，
// 不 buildApp——本文件要验的是**本路由的判定**（scope / CSRF / 状态码 / 入队 + 审计），
// 宿主门卫链已由各自用例覆盖。
//
// 四条硬约束的用例映射：
//   ① 无 tenant:admin ⇒ 403 FORBIDDEN（中间件顺序：scope 先于 CSRF）
//   ② 写操作必须有与当前会话一致的 x-csrf-token（token 用实现同一个 csrfToken 生成，不复制算法）
//   ③ 只入队：建 queued/manual 行、**不改** next_run_at、不 spawn（status 停在 queued 即现场证据）
//   ④ TOCTOU：并发两次触发只有一个 200，库里只多一条 queued 行（排班行锁 + 同事务判定）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { csrfToken, type SessionPayload } from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import { runMigrations } from '../migrate'
import type { SessionEnv } from '../session-middleware'
import type { TenantEnv, TenantRow } from '../tenant'
import { platformJobRoutes } from './platform-jobs'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))
const SECRET = 'jobtest-route-secret'.padEnd(32, 'x')
const ORG = 'org-jobtest-route'
/** audit.tenant_id 是 int（无外键）——用不会与真租户碰撞的测试值，清理按 action+detail 收口。 */
const TENANT_ID = 990_014
const KEY = 'jobtest-route:route'
const PK = 'jobtest-route:%'

/** 夹具清理：job_run 对 job_schedule 外键无级联 ⇒ 先删运行行再删排班行。 */
async function clearFixtures(pool: Pool) {
  await pool.query(
    `delete from platform.job_run where schedule_id in
       (select id from platform.job_schedule where key like $1)`, [PK])
  await pool.query('delete from platform.job_schedule where key like $1', [PK])
  await pool.query(
    `delete from platform.audit
      where action = 'admin.job.run' and detail->>'key' like $1`, [PK])
}

describePg('platform-jobs routes（需要 DATABASE_URL）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', dir)
  })
  afterAll(async () => {
    await clearFixtures(pool)
    await pool.end().catch(() => {})
  })

  /** 身份/租户/会话注入替身：与 api-keys.test 同款形状（真实链路 = 租户解析 → 会话中间件）。 */
  function appFor(scopes: string[], target = pool) {
    const session = { sub: 'u1', org: ORG, name: 'u1', scopes, iat: 1_700_000_000, exp: 9e9 } as unknown as SessionPayload
    const identity = {
      userId: 'u1',
      orgId: ORG,
      displayName: 'u1',
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    } as Identity
    const app = new Hono<TenantEnv & SessionEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', { id: TENANT_ID, slug: 'acme', casdoor_org: ORG } as unknown as TenantRow)
      c.set('session', session)
      c.set('identity', identity)
      await next()
    })
    app.route('/jobs', platformJobRoutes({ pool: target, sessionSecret: SECRET }))
    return { app, csrf: csrfToken(session, SECRET) }
  }

  async function seed(over: { enabled?: boolean } = {}): Promise<number> {
    await clearFixtures(pool)
    const { rows } = await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
       values ($1,'7 * * * *','UTC','system',$2, now() + interval '1 hour', 1000, 1, 3600)
       returning id`, [KEY, over.enabled ?? true])
    return Number(rows[0].id)
  }

  const post = (csrf?: string): RequestInit => ({
    method: 'POST',
    headers: csrf === undefined ? {} : { 'x-csrf-token': csrf },
  })

  it('无 tenant:admin ⇒ 403 FORBIDDEN（scope 门先于 CSRF）', async () => {
    await seed()
    const { app, csrf } = appFor([])
    const res = await app.request(`/jobs/${KEY}/run`, post(csrf))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'FORBIDDEN', need: 'tenant:admin' })
  })

  it('缺 x-csrf-token ⇒ 403 CSRF', async () => {
    await seed()
    const { app } = appFor(['tenant:admin'])
    const res = await app.request(`/jobs/${KEY}/run`, post())
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'CSRF' })
  })

  it('token 与会话不符 ⇒ 403 CSRF', async () => {
    await seed()
    const { app } = appFor(['tenant:admin'])
    const res = await app.request(`/jobs/${KEY}/run`, post('deadbeef'))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'CSRF' })
  })

  it('未知 key ⇒ 404 JOB_NOT_FOUND', async () => {
    const { app, csrf } = appFor(['tenant:admin'])
    const res = await app.request('/jobs/jobtest-route:nope/run', post(csrf))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'JOB_NOT_FOUND', key: 'jobtest-route:nope' })
  })

  it('★ enabled=false 的排班也能手动触发（200 + queued + 审计）：启停只影响自动排班', async () => {
    await seed({ enabled: false })
    const before = await pool.query('select next_run_at from platform.job_schedule where key=$1', [KEY])
    const { app, csrf } = appFor(['tenant:admin'])
    const res = await app.request(`/jobs/${KEY}/run`, post(csrf))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: number; key: string; status: string }
    expect(body).toMatchObject({ key: KEY, status: 'queued' })
    const run = await pool.query('select status, trigger from platform.job_run where id=$1', [body.runId])
    expect(run.rows[0]).toMatchObject({ status: 'queued', trigger: 'manual' })
    // 切流程序第 2 步就发生在 enabled=false 的登记态 ⇒ 必须有审计
    const audit = await pool.query(
      `select detail from platform.audit where action='admin.job.run' and detail->>'runId' = $1`,
      [String(body.runId)])
    expect(audit.rows).toHaveLength(1)
    // 手动触发不改排班态：enabled 仍 false、next_run_at 原样（只入队）
    const sch = await pool.query('select enabled, next_run_at from platform.job_schedule where key=$1', [KEY])
    expect(sch.rows[0].enabled).toBe(false)
    expect(new Date(sch.rows[0].next_run_at).toISOString())
      .toBe(new Date(before.rows[0].next_run_at).toISOString())
  })

  it('★ 正常触发 ⇒ 只建 queued 行（不 spawn、不改 next_run_at）+ 审计', async () => {
    await seed()
    const before = await pool.query('select next_run_at from platform.job_schedule where key=$1', [KEY])
    const { app, csrf } = appFor(['tenant:admin'])
    const res = await app.request(`/jobs/${KEY}/run`, post(csrf))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: number; key: string; status: string }
    expect(body.key).toBe(KEY)
    expect(body.status).toBe('queued')
    expect(body.runId).toBeGreaterThan(0)

    const run = await pool.query('select status, trigger, key from platform.job_run where id=$1', [body.runId])
    expect(run.rows[0]).toMatchObject({ status: 'queued', trigger: 'manual', key: KEY })

    // 只入队：执行在 worker 进程，排班表一个字节都不该动（next_run_at 仍是 seed 时的未来时刻）
    const sch = await pool.query('select next_run_at from platform.job_schedule where key=$1', [KEY])
    expect(new Date(sch.rows[0].next_run_at).toISOString()).toBe(new Date(before.rows[0].next_run_at).toISOString())

    const audit = await pool.query(
      `select actor, tenant_id, detail from platform.audit
        where action='admin.job.run' and detail->>'runId' = $1`, [String(body.runId)])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ actor: 'u1', tenant_id: TENANT_ID, detail: { key: KEY } })
  })

  it('★ 已有 queued ⇒ 409 JOB_ALREADY_PENDING（不再插第二条）', async () => {
    await seed()
    const { app, csrf } = appFor(['tenant:admin'])
    expect((await app.request(`/jobs/${KEY}/run`, post(csrf))).status).toBe(200)
    const second = await app.request(`/jobs/${KEY}/run`, post(csrf))
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: 'JOB_ALREADY_PENDING' })
    const { rows } = await pool.query(
      `select count(*)::int as n from platform.job_run where key=$1 and status='queued'`, [KEY])
    expect(rows[0].n).toBe(1)
  })

  it('★ 已有 running ⇒ 同样 409 JOB_ALREADY_PENDING', async () => {
    const scheduleId = await seed()
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,$2,now(),'schedule','running')`, [scheduleId, KEY])
    const { app, csrf } = appFor(['tenant:admin'])
    const res = await app.request(`/jobs/${KEY}/run`, post(csrf))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'JOB_ALREADY_PENDING' })
  })

  it('★ 真并发两次触发：恰一个 200、一个 409，库里只有一条 queued（TOCTOU 原子）', async () => {
    await seed()
    // 独立 Pool = 独立会话，才真正走到排班行锁（同 pool 复用连接会让「并发」退化成串行）
    const pools = [new Pool({ connectionString: dbUrl, max: 1 }), new Pool({ connectionString: dbUrl, max: 1 })]
    try {
      const reqs = pools.map((p) => {
        const { app, csrf } = appFor(['tenant:admin'], p)
        return app.request(`/jobs/${KEY}/run`, post(csrf))
      })
      const [a, b] = await Promise.all(reqs)
      const codes = [a.status, b.status].sort()
      expect(codes).toEqual([200, 409])
      const { rows } = await pool.query(
        `select count(*)::int as n from platform.job_run where key=$1 and status='queued'`, [KEY])
      expect(rows[0].n).toBe(1)
    } finally {
      await Promise.all(pools.map((p) => p.end().catch(() => {})))
    }
  })
})
