// jobs-port.ts — 宿主对 `ctx.jobs` 的实现（W6-P4a）：系统任务（source='system'）的
// 只读面 + 手动入队。**唯一装配点**：app.ts 与测试共用这一份（照 scheduler/factory.ts
// 的「工厂可导出纯函数」纪律，避免 app.ts 内联 lambda 在测试中不可达）。
//
// 为什么需要这个端口：`jobs` 模块要展示排班与台账、并支持手动触发，但模块**不读
// `platform.*`**（B1，见 docs/architecture.md §4.3）。数据与审计都收在宿主侧：
//   · 读：`listSchedules` / `listRuns` 各自一条 SQL，返回**窄视图**（不把 params /
//     owner_* 之类的宿主内部列漏给模块）。
//   · 写：`runNow` 照 P1 手动触发路由（routes/platform-jobs.ts，**W6-P4a 已随路由退役**，
//     手动触发入口 = jobs 模块 POST /api/modules/jobs/:key/run）的语义逐条搬运——
//     事务内锁排班行 → 判 `queued|running` → insert queued 行 + 同事务审计 →
//     2s `lock_timeout`（55P03 ⇒ JOB_LOCK_TIMEOUT）。**审计在端口里写**，模块不碰
//     `platform.audit`（计划 Task 3：迁入模块后审计保留，但 B1 不允许模块直写）。
//
// 与 P1 路由的两处**有意**差异（都朝「不制造假绿」的方向）：
//   ① 锁行 SQL 增加 `deleted_at is null`：软删是「这个排班不存在了」，不是「停用」。
//      否则会入队一条 worker 永不领取的行（claimQueuedManual 排除软删），端点返回的
//      「已排队」就成了谎话，最后只能等 reapQueued 判 timeout。P1 路由当时没这层是遗留。
//   ② `enabled=false` 照旧放行（与 P1 一致，**不是**差异）：启停只约束自动排班；
//      spec §11 的切流程序正是「登记（disabled）→ 手动跑一次比对 → 再启用」。
import type { JobsPort, JobRunActor, JobRunView, SystemJobScheduleView } from '@platform/sdk'
import type { Pool } from 'pg'

export interface JobsPortDeps {
  pool: Pool
  /** 测试注入的时钟（occurrence / started_at 可逐字断言）；生产缺省真 now。 */
  now?: () => Date
}

/** `listRuns` 的硬上限：与 SchedulerPort 的台账口径同一数值（防一条 API 打爆台账表）。 */
const RUN_LIMIT_MAX = 100

/** 手动触发只认 system 排班（agent 排班的 key 在另一命名空间，唯一索引按 source 分桶）。 */
const LOCK_SCHEDULE_SQL =
  `select id from platform.job_schedule
    where key=$1 and source='system' and deleted_at is null
    for update`

const BUSY_SQL =
  `select 1 from platform.job_run where schedule_id=$1 and status in ('queued','running') limit 1`

/** 系统排班 + 最近一次运行（lateral 子查询：一条 SQL 取两表，避免 N+1）。
 *
 *  `started_at desc, id desc`：同刻多次运行（手动连发 / 重试）时以 id 定序——只按时间
 *   排序在同刻是**不确定的**，台账视图会随查询计划抖动。 */
const LIST_SCHEDULES_SQL = `
  select s.id, s.key, s.enabled, s.cron, s.timezone, s.next_run_at,
         l.status as last_status, l.started_at as last_run_at
    from platform.job_schedule s
    left join lateral (
      select r.status, r.started_at
        from platform.job_run r
       where r.schedule_id = s.id
       order by r.started_at desc, r.id desc
       limit 1
    ) l on true
   where s.source = 'system' and s.deleted_at is null
   order by s.key asc`

/** 台账按 **key + system 归属** 取：job_run 自身也有 key，但 agent 排班可以与系统 key
 *  同名（两个 source 的唯一索引分桶）⇒ 必须 join 排班表按 source 过滤，否则会把别的
 *  命名空间的运行混进来。软删排班的运行历史保留（审计要求）——这里**不**筛 deleted_at。 */
const LIST_RUNS_SQL = `
  select r.id, r.key, r.status, r.trigger, r.attempt,
         r.started_at, r.finished_at, r.exit_code, r.duration_ms, r.output_tail
    from platform.job_run r
    join platform.job_schedule s on s.id = r.schedule_id
   where r.key = $1 and s.source = 'system'
   order by r.started_at desc, r.id desc
   limit $2`

interface RunNowError extends Error {
  code: string
  detail?: string
}

function fail(code: string, detail?: string): never {
  const err = new Error(code) as RunNowError
  err.code = code
  if (detail !== undefined) err.detail = detail
  throw err
}

function iso(v: unknown): string | null {
  return v === null || v === undefined ? null : new Date(v as Date).toISOString()
}

export function buildJobsPort(deps: JobsPortDeps): JobsPort {
  const { pool } = deps
  const now = deps.now ?? (() => new Date())

  return {
    async listSchedules(): Promise<SystemJobScheduleView[]> {
      const { rows } = await pool.query<Record<string, unknown>>(LIST_SCHEDULES_SQL)
      return rows.map((r) => ({
        id: String(r.id),
        key: String(r.key),
        enabled: Boolean(r.enabled),
        cron: String(r.cron),
        timezone: String(r.timezone),
        nextRunAt: iso(r.next_run_at),
        lastStatus: r.last_status === null || r.last_status === undefined
          ? null
          : String(r.last_status),
        lastRunAt: iso(r.last_run_at),
      }))
    },

    async listRuns(key: string, limit: number): Promise<JobRunView[]> {
      const n = Math.trunc(Number(limit))
      if (!Number.isFinite(n) || n <= 0) return []
      const capped = Math.min(n, RUN_LIMIT_MAX)
      const { rows } = await pool.query<Record<string, unknown>>(LIST_RUNS_SQL, [key, capped])
      return rows.map((r) => ({
        id: String(r.id),
        key: String(r.key),
        status: String(r.status),
        trigger: String(r.trigger),
        attempt: Number(r.attempt),
        startedAt: new Date(r.started_at as Date).toISOString(),
        finishedAt: iso(r.finished_at),
        exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
        durationMs: r.duration_ms === null || r.duration_ms === undefined
          ? null
          : Number(r.duration_ms),
        outputTail: r.output_tail === null || r.output_tail === undefined
          ? null
          : String(r.output_tail),
      }))
    },

    async runNow(key: string, actor?: JobRunActor): Promise<{ runId: string }> {
      const client = await pool.connect()
      let runId: number
      try {
        await client.query('begin')
        // 锁等待上限：排班行被 worker claim / 别的触发事务持锁时，**不许把连接无限期占住**。
        // 超时由 PostgreSQL 抛 55P03（lock_not_available），下面 catch 转 JOB_LOCK_TIMEOUT。
        await client.query("set local lock_timeout = '2s'")
        // ① 锁排班行：并发触发在这里串行化（第二个事务等锁，commit 后按最新快照重判 busy）。
        //    `deleted_at is null` 与 `enabled` 的分工见文件头 ①②。
        const locked = await client.query<{ id: string }>(LOCK_SCHEDULE_SQL, [key])
        const sch = locked.rows[0]
        if (!sch) {
          await client.query('rollback')
          return fail('JOB_NOT_FOUND', key)
        }

        // ② 同锁内判 busy：queued=待执行、running=正在跑，两者都不允许再入队。
        const busy = await client.query(BUSY_SQL, [sch.id])
        if (busy.rows.length > 0) {
          await client.query('rollback')
          return fail('JOB_ALREADY_PENDING', key)
        }

        // ③ 只建 queued 行：params_snapshot 留 null，claim 时回填排班 params
        //    （store.claimQueuedManual，与 P1 路由逐字一致）。
        const ins = await client.query<{ id: string }>(
          `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
           values ($1,$2,$3,'manual','queued') returning id`,
          [sch.id, key, now()],
        )
        runId = Number(ins.rows[0].id)

        // ④ 审计与入队同事务：审计写不进去 ⇒ 整个触发回滚（不出现「入队了没账」）。
        //    action 沿用 P1 的 `admin.job.run`（切流前后审计口径不变）；归属可选——
        //    模块路由有请求身份时传入，缺省落 null（绝不伪造系统身份）。
        await client.query(
          'insert into platform.audit(tenant_id, actor, action, detail) values ($1,$2,$3,$4)',
          [actor?.tenantId ?? null, actor?.userId ?? null, 'admin.job.run', { key, runId }],
        )
        await client.query('commit')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        // 55P03 = lock_not_available（lock_timeout 到点）：排队等锁有界失败，不转 500。
        if ((e as { code?: string }).code === '55P03') return fail('JOB_LOCK_TIMEOUT', key)
        throw e
      } finally {
        client.release()
      }
      return { runId: String(runId) }
    },
  }
}
