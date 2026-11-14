// routes/platform-jobs.ts — /api/platform/jobs：平台内置调度器的手动触发面（Wave 6 P1，Task 10）。
//
// **不变量：本端点只入队，绝不在 HTTP 进程里起子进程。** 执行发生在 worker 进程
// （loop → claimQueuedManual → runner）；HTTP 进程的唯一副作用是 platform.job_run 里的一行
// `queued`（+ 同事务的审计行）。前端/调用方拿到的 200 只表示「已排队」，不表示「已执行」。
//
// 三条结构锁（照 admin.ts ①–③，逐字复用同一套写法）：
//  ① 归属只取自 c.get('tenant') / c.get('identity')——请求参数里没有能改变归属的口子；
//  ② 整路由 requireScope('tenant:admin')——未挂码者连路由形状都探不到；
//  ③ 写操作校验 x-csrf-token 与当前会话一致（会话重签会轮换——前端每次现取 /session）。
//
// **TOCTOU**：busy 判定与入队必须在**同一事务**里，先 `select … for update` 锁排班行、
// 再判 `queued|running`、再 insert。两条独立语句的做法在并发触发时两边都会看到「不忙」，
// 各插一条重复 queued——第二个事务在行锁上等待，第一个 commit 后按最新快照重判。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken } from '@platform/auth-core'
import { requireScope } from '@platform/sdk'
import type { SessionEnv } from '../session-middleware'
import type { TenantEnv } from '../tenant'

export interface PlatformJobRoutesDeps {
  pool: Pool
  sessionSecret: string
}

/** 手动触发只认 system 排班（agent 排班的 key 在另一命名空间，唯一索引也按 source 分桶）。
 *  `enabled` **不参与判定**：它管的是「排班要不要自动跑」，手动触发是运维显式动作；
 *  spec §11 的切流程序正是「登记（disabled）→ 手动跑一次比对 → 关 openship → 再启用」。 */
const LOCK_SCHEDULE_SQL =
  `select id from platform.job_schedule where key=$1 and source='system' for update`

const BUSY_SQL =
  `select 1 from platform.job_run where schedule_id=$1 and status in ('queued','running') limit 1`

export function platformJobRoutes(deps: PlatformJobRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()

  // ② scope 门禁：整路由（未挂码 403 {error:'FORBIDDEN',need:'tenant:admin'}）
  app.use('*', requireScope('tenant:admin'))
  // ③ CSRF：写操作必须带与当前会话一致的 x-csrf-token
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const s = c.get('session')
      if (!s || c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
        return c.json({ error: 'CSRF' }, 403)
      }
    }
    await next()
  })

  app.post('/:key/run', async (c) => {
    const key = c.req.param('key')
    const who = c.get('identity')
    const tenant = c.get('tenant')

    const client = await deps.pool.connect()
    let runId: number
    try {
      await client.query('begin')
      // 锁等待上限：排班行被别的触发/claim 事务持锁时，**不许把连接无限期占住**。
      // 超时由 PostgreSQL 抛 55P03（lock_not_available），下面 catch 转 503 JOB_LOCK_TIMEOUT。
      await client.query("set local lock_timeout = '2s'")
      // ① 锁排班行：并发触发在这里串行化（第二个事务等锁，commit 后按最新快照重判 busy）。
      //    排班 disabled 也照常入队——启停只影响自动排班，不影响运维的显式手动触发。
      const locked = await client.query<{ id: string }>(LOCK_SCHEDULE_SQL, [key])
      const sch = locked.rows[0]
      if (!sch) {
        await client.query('rollback')
        return c.json({ error: 'JOB_NOT_FOUND', key }, 404)
      }

      // ② 同锁内判 busy：queued=待执行、running=正在跑，两者都不允许再入队。
      const busy = await client.query(BUSY_SQL, [sch.id])
      if (busy.rows.length > 0) {
        await client.query('rollback')
        return c.json({ error: 'JOB_ALREADY_PENDING', key }, 409)
      }

      // ③ 只建 queued 行：params_snapshot 留 null，claim 时回填排班 params（store.claimQueuedManual）。
      const ins = await client.query<{ id: string }>(
        `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
         values ($1,$2,now(),'manual','queued') returning id`,
        [sch.id, key],
      )
      runId = Number(ins.rows[0].id)

      // ④ 审计与入队同事务：审计写不进去 ⇒ 整个触发回滚（不出现「入队了没账」）。
      await client.query(
        'insert into platform.audit(tenant_id, actor, action, detail) values ($1,$2,$3,$4)',
        [tenant.id, who.userId, 'admin.job.run', { key, runId }],
      )
      await client.query('commit')
    } catch (e) {
      await client.query('rollback').catch(() => {})
      // 55P03 = lock_not_available（lock_timeout 到点）：排队等锁有界失败，不转 500。
      if ((e as { code?: string }).code === '55P03') {
        return c.json({ error: 'JOB_LOCK_TIMEOUT', key }, 503)
      }
      throw e
    } finally {
      client.release()
    }

    return c.json({ runId, key, status: 'queued' })
  })

  return app
}
