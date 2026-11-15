// jobs-module.e2e.test.ts — jobs 模块端到端（W6-P4a Task 3 审阅 Important 1）。
//
// 为什么必须真装配：手动触发的端到端断言此前拆在两半——端口 DB 半边（scheduler/jobs-port.test.ts）
// 与路由单测半边（modules/jobs/routes.test.ts），**接缝**（app.ts 把 `jobs` 端口与 `sessionSecret`
// 注入真装载的 jobs 模块）零覆盖。将来漏传 `jobs` ⇒ 三端点静默 503 JOBS_UNAVAILABLE、漏传
// `sessionSecret` ⇒ csrfVerify 不注入 ⇒ 写操作 fail-closed 403——两种坏法全套件照样绿
// （P2「生产装配零覆盖」同款教训）。本文件走真 buildApp + 真 modules/ 装载锁住这条缝。
//
// 装配配方照 data-query.e2e.test.ts（**不是** app.test.ts）：MockCasdoor 种 admin（口令对不上
// ⇒ 装载器权限码供给登不上 ⇒ buildApp 直接抛）；订阅源显式钉旧表 `platform`（无行 = 启用；
// mock 不实现 get-subscriptions，casdoor 默认路径归 smoke 覆盖）。会话直接 signSession 签发
// （sfa=now ⇒ 中间件不触发 Casdoor scopes 刷新），CSRF 用实现同一个 csrfToken 现算。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE, SESSION_TTL_SEC, csrfToken, signSession } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-secret-test-secret-test-secret!'
// 夹具前缀 `jobtest-p4a-e2e:`：与 jobs-port.test.ts 的 `jobtest-p4a:` 错开，互不误删。
const KEY = 'jobtest-p4a-e2e:manual'
const PK = 'jobtest-p4a-e2e:%'
const USER_ID = 'u-e2e-jobs'

function configWith(casdoorUrl: string, adminPwd: string): AppConfig {
  return {
    port: 13004, // 别与其他 e2e 文件撞（13000-13002 已占）
    databaseUrl: dbUrl!,
    tenantMode: 'single',
    platformOrg: 'acme',
    sessionSecret: SECRET,
    casdoor: {
      url: casdoorUrl,
      clientId: 'test-client',
      clientSecret: '',
      application: 'app-built-in',
      adminUser: 'admin',
      adminPwd,
    },
    publicOrigin: 'http://127.0.0.1:13004',
    // 必需：platform.tenant 种下 acme 租户（single 模式按 casdoor_org='acme' 解析，无行即抛）
    seedDemo: true,
    dataQueryRatePerMin: 60,
  }
}

/** describe.skipIf 只挡运行时，TS 不据此收窄 dbUrl——取池统一走这里（不 narrow 就显式抛）。 */
function mustPool(): ReturnType<typeof getPool> {
  if (!dbUrl) throw new Error('jobs e2e 需要 DATABASE_URL')
  return getPool({ databaseUrl: dbUrl })
}

async function clearFixtures(pool: ReturnType<typeof getPool>) {
  // job_run 对 job_schedule 外键无级联 ⇒ 先删运行行再删排班行；审计按 action+detail 收口。
  await pool.query(
    `delete from platform.job_run where schedule_id in
       (select id from platform.job_schedule where key like $1)`, [PK])
  await pool.query('delete from platform.job_schedule where key like $1', [PK])
  await pool.query(
    `delete from platform.audit
      where action = 'admin.job.run' and detail->>'key' like $1`, [PK])
}

describe.skipIf(!dbUrl)('jobs 模块端到端：宿主注入接缝（jobs 端口 + sessionSecret）', () => {
  const mock = new MockCasdoor()
  let app: Awaited<ReturnType<typeof buildApp>>['app']
  let tenantId = 0
  let org = ''

  beforeAll(async () => {
    await mock.start()
    // 订阅源钉旧表（data-query.e2e 同款理由）：本文件验注入接缝，与订阅源正交——
    // 无行 = 启用，jobs 模块对 acme 可见，不依赖 mock 没有的 get-subscriptions。
    process.env.PLATFORM_SUBSCRIPTION_SOURCE = 'platform'
    app = (await buildApp({ config: configWith(mock.origin, 'pw') })).app

    const pool = mustPool()
    const t = await pool.query<{ id: string; casdoor_org: string }>(
      `select id, casdoor_org from platform.tenant where slug = 'acme'`)
    tenantId = Number(t.rows[0]!.id)
    org = t.rows[0]!.casdoor_org
    await clearFixtures(pool)
    // seed 一条 system 排班（enabled=true 也好 false 也好手动触发都放行，这里取常态 true）
    await pool.query(
      `insert into platform.job_schedule
         (key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
       values ($1,'7 * * * *','UTC','system',true, now() + interval '1 hour', 1000, 1, 3600)`, [KEY])
  })

  afterAll(async () => {
    if (!dbUrl) return
    const pool = mustPool()
    await clearFixtures(pool)
    delete process.env.PLATFORM_SUBSCRIPTION_SOURCE
    await mock.stop()
    // 文件级关池守卫（app.test.ts 同款）：谁在 describe 里私自 end 池，这条断言先红并指名。
    expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查各处是否私自关池').toBe(false)
    await pool.end().catch(() => {})
  })

  it('★ jobs:manage 会话 + 正确 CSRF ⇒ 200；DB 有 queued/manual 行；审计 tenant_id/actor 非空', async () => {
    // 漏传 `jobs` ⇒ 这里 503 JOBS_UNAVAILABLE；漏传 `sessionSecret` ⇒ 这里 403 CSRF。
    // 两种坏法都让本用例红——这正是它存在的目的（变异验证见任务报告）。
    const iat = Math.floor(Date.now() / 1000)
    const base = { sub: USER_ID, org, name: USER_ID, scopes: ['jobs:read', 'jobs:manage'], authVia: 'password' as const }
    const token = await signSession(base, SECRET, iat)
    const csrf = csrfToken({ ...base, iat, exp: iat + SESSION_TTL_SEC, sfa: iat }, SECRET)

    const res = await app.request(`/api/modules/jobs/${KEY}/run`, {
      method: 'POST',
      headers: {
        host: 'acme.test',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${token}`,
        'x-csrf-token': csrf,
      },
      body: '{}',
    })
    // 先读原始体再断言（expect 的 message 里 await res.text() 会把体吃掉——Body already read）
    const raw = await res.text()
    expect(res.status, `应 200（实际 ${res.status}：${raw}）`).toBe(200)
    const body = JSON.parse(raw) as { runId: string; key: string; status: string }
    expect(body).toMatchObject({ key: KEY, status: 'queued' })

    const pool = mustPool()
    const run = await pool.query(
      'select status, trigger, key from platform.job_run where id = $1', [Number(body.runId)])
    expect(run.rows[0]).toMatchObject({ status: 'queued', trigger: 'manual', key: KEY })

    // 审计归属非空：tenantId 取自租户上下文、actor 取自会话身份——两者都不得落 null
    // （端口对缺省 actor 才落 null；真装配链路上两者恒在，落 null = 接缝断了）。
    const audit = await pool.query(
      `select tenant_id, actor, action, detail from platform.audit
        where action='admin.job.run' and detail->>'runId' = $1`, [String(body.runId)])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({
      tenant_id: tenantId,
      actor: USER_ID,
      action: 'admin.job.run',
      detail: { key: KEY },
    })
  })
})
