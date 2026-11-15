// jobs-port.test.ts — `ctx.jobs` 宿主端口（W6-P4a）的黑盒用例（真库）。
//
// 覆盖面（与计划 Task 1 的失败测试清单对齐）：
//   · listSchedules 只含 `source='system'` 且排除软删；最近一次运行的状态/时间来自台账。
//   · listRuns 上限 100、`started_at desc`、不混入 agent 同名 key 的运行。
//   · runNow 只建 queued/manual 行（不 spawn）；disabled 照常放行（P1 语义）；
//     未知/软删 ⇒ JOB_NOT_FOUND；已有 queued|running ⇒ JOB_ALREADY_PENDING；
//     排班行被占锁 ⇒ JOB_LOCK_TIMEOUT；审计与入队同事务。
// 夹具前缀 `jobtest-p4a:`：本 DB 可能同时跑其它调度器用例/开发数据，断言一律先按前缀过滤。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { buildJobsPort } from './jobs-port'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const PK = 'jobtest-p4a:%'
const FIXED_NOW = new Date('2026-11-15T00:00:00.000Z')

async function clearFixtures(pool: Pool) {
  // job_run 对 job_schedule 有外键（无级联），先删运行行。
  await pool.query(
    `delete from platform.job_run where schedule_id in
       (select id from platform.job_schedule where key like $1)`, [PK])
  await pool.query('delete from platform.job_schedule where key like $1', [PK])
  await pool.query(
    `delete from platform.audit
      where action = 'admin.job.run' and detail->>'key' like $1`, [PK])
}

interface SeedOpts {
  key: string
  source?: 'system' | 'agent'
  enabled?: boolean
  cron?: string
  timezone?: string
  nextRunAt?: Date | null
  deletedAt?: Date | null
}

async function seedSchedule(pool: Pool, o: SeedOpts): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into platform.job_schedule
       (key, cron, timezone, source, enabled, next_run_at, deleted_at,
        timeout_ms, max_attempts, expected_interval_secs)
     values ($1,$2,$3,$4,$5,$6,$7,300000,1,300) returning id`,
    [
      o.key, o.cron ?? '*/5 * * * *', o.timezone ?? 'UTC', o.source ?? 'system',
      o.enabled ?? true, o.nextRunAt ?? null, o.deletedAt ?? null,
    ],
  )
  return String(rows[0].id)
}

async function seedRun(
  pool: Pool,
  opts: {
    scheduleId: string
    key: string
    status?: string
    trigger?: string
    attempt?: number
    startedAt?: Date
    finishedAt?: Date | null
    exitCode?: number | null
    durationMs?: number | null
    outputTail?: string | null
  },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into platform.job_run
       (schedule_id, key, occurrence, trigger, status, attempt,
        started_at, finished_at, exit_code, duration_ms, output_tail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      opts.scheduleId, opts.key, opts.startedAt ?? FIXED_NOW,
      opts.trigger ?? 'schedule', opts.status ?? 'ok', opts.attempt ?? 1,
      opts.startedAt ?? FIXED_NOW, opts.finishedAt ?? null,
      opts.exitCode ?? null, opts.durationMs ?? null, opts.outputTail ?? null,
    ],
  )
  return String(rows[0].id)
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code })
}

function mkPort(pool: Pool, now?: () => Date) {
  return buildJobsPort(now === undefined ? { pool } : { pool, now })
}

describePg('jobs-port（需要 DATABASE_URL）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', dir)
  })
  beforeEach(async () => { await clearFixtures(pool) })
  afterAll(async () => {
    await clearFixtures(pool)
    await pool.end().catch(() => {})
  })

  it('listSchedules：只含 system 且排除软删，带最近一次 run 的状态与时间', async () => {
    const port = mkPort(pool)
    const next = new Date('2026-11-15T00:05:00.000Z')
    const a = await seedSchedule(pool, {
      key: 'jobtest-p4a:alpha', cron: '*/5 * * * *', timezone: 'Asia/Shanghai', nextRunAt: next,
    })
    // 无运行记录的系统排班：lastStatus/lastRunAt 必须是 null（不是空串）。
    await seedSchedule(pool, { key: 'jobtest-p4a:empty' })
    // 软删 + agent 两类行都必须缺席。
    await seedSchedule(pool, { key: 'jobtest-p4a:deleted', deletedAt: FIXED_NOW })
    await seedSchedule(pool, { key: 'jobtest-p4a:agent', source: 'agent' })

    const older = await seedRun(pool, {
      scheduleId: a, key: 'jobtest-p4a:alpha', status: 'failed',
      startedAt: new Date('2026-11-14T23:55:00.000Z'),
    })
    const latest = await seedRun(pool, {
      scheduleId: a, key: 'jobtest-p4a:alpha', status: 'ok',
      startedAt: new Date('2026-11-15T00:00:00.000Z'),
      finishedAt: new Date('2026-11-15T00:00:03.000Z'), exitCode: 0, durationMs: 3000,
      outputTail: 'ok',
    })
    expect(older).not.toBe(latest)

    const all = await port.listSchedules()
    const mine = all.filter((r) => r.key.startsWith('jobtest-p4a:'))
    // 按 key 升序（"alpha" < "empty"，缺席的两条不是被排序吞掉，而是被 SQL 过滤）。
    expect(mine.map((r) => r.key)).toEqual(['jobtest-p4a:alpha', 'jobtest-p4a:empty'])

    const alpha = mine[0]
    expect(alpha).toMatchObject({
      id: a,
      key: 'jobtest-p4a:alpha',
      enabled: true,
      cron: '*/5 * * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: next.toISOString(),
      lastStatus: 'ok',
      lastRunAt: '2026-11-15T00:00:00.000Z',
    })
    expect(mine[1]).toMatchObject({ lastStatus: null, lastRunAt: null })
  })

  it('listRuns：按 key 取、started_at desc、上限 100，不混入 agent 同名 key', async () => {
    const port = mkPort(pool)
    const sys = await seedSchedule(pool, { key: 'jobtest-p4a:runs' })
    const agent = await seedSchedule(pool, { key: 'jobtest-p4a:runs', source: 'agent' })

    const base = new Date('2026-11-15T00:00:00.000Z').getTime()
    for (let i = 0; i < 105; i++) {
      await seedRun(pool, {
        scheduleId: sys,
        key: 'jobtest-p4a:runs',
        status: i % 2 === 0 ? 'ok' : 'failed',
        attempt: (i % 3) + 1,
        startedAt: new Date(base + i * 1000),
        durationMs: i,
      })
    }
    // 同 key 的 agent 运行：端口只认 system 归属，这条必须缺席。
    const agentRun = await seedRun(pool, {
      scheduleId: agent, key: 'jobtest-p4a:runs', status: 'ok',
      startedAt: new Date(base + 999_000),
    })

    const capped = await port.listRuns('jobtest-p4a:runs', 500)
    expect(capped).toHaveLength(100)
    // 最新的一条 = i=104（agent 行不在其中）。
    expect(capped[0].id).not.toBe(agentRun)
    expect(capped[0].startedAt).toBe(new Date(base + 104_000).toISOString())
    expect(capped[99].startedAt).toBe(new Date(base + 5_000).toISOString())
    for (let i = 1; i < capped.length; i++) {
      expect(capped[i - 1].startedAt >= capped[i].startedAt).toBe(true)
    }
    // 字段映射逐一到位。
    expect(capped[0]).toMatchObject({
      key: 'jobtest-p4a:runs',
      status: 'ok',
      trigger: 'schedule',
      attempt: (104 % 3) + 1,
      finishedAt: null,
      exitCode: null,
      durationMs: 104,
      outputTail: null,
    })

    const three = await port.listRuns('jobtest-p4a:runs', 3)
    expect(three.map((r) => r.durationMs)).toEqual([104, 103, 102])
    // 非法/非正 limit ⇒ 空数组（不把 0 当「不限」）。
    expect(await port.listRuns('jobtest-p4a:runs', 0)).toEqual([])
    // 未知 key ⇒ 空数组（列表类接口不抛错）。
    expect(await port.listRuns('jobtest-p4a:nope', 10)).toEqual([])
  })

  it('runNow：只入队 + 审计同事务；disabled 放行；重复/未知/软删的错误码', async () => {
    const port = mkPort(pool, () => FIXED_NOW)
    const next = new Date('2026-11-15T00:05:00.000Z')
    // enabled=false：手动触发是运维显式动作，启停只约束自动排班（P1 语义，切流程序依赖它）。
    const id = await seedSchedule(pool, {
      key: 'jobtest-p4a:manual', enabled: false, nextRunAt: next,
    })

    const { runId } = await port.runNow('jobtest-p4a:manual', {
      tenantId: 990_015, userId: 'u-p4a',
    })
    expect(runId).toMatch(/^\d+$/)

    const run = await pool.query(
      `select schedule_id, key, trigger, status, attempt, params_snapshot, occurrence
         from platform.job_run where id = $1`, [runId])
    expect(run.rows[0]).toMatchObject({
      schedule_id: id,
      key: 'jobtest-p4a:manual',
      trigger: 'manual',
      status: 'queued',
      attempt: 1,
      params_snapshot: null,
    })
    // occurrence 用注入时钟；**只入队**：没有任何 running 行被创建。
    expect(new Date(run.rows[0].occurrence).toISOString()).toBe(FIXED_NOW.toISOString())
    const running = await pool.query(
      "select 1 from platform.job_run where schedule_id=$1 and status='running'", [id])
    expect(running.rows).toHaveLength(0)
    // next_run_at 不动（手动触发不消耗格子）。
    const sch = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    expect(new Date(sch.rows[0].next_run_at).toISOString()).toBe(next.toISOString())

    // 审计与入队同事务：action/key/runId/归属都在。
    const audit = await pool.query(
      `select tenant_id, actor, action, detail from platform.audit
        where action='admin.job.run' and detail->>'runId' = $1`, [runId])
    expect(audit.rows[0]).toEqual({
      tenant_id: 990_015,
      actor: 'u-p4a',
      action: 'admin.job.run',
      detail: { key: 'jobtest-p4a:manual', runId: Number(runId) },
    })

    // 已有 queued ⇒ 409 语义（错误码；HTTP 状态由模块路由映射）。
    await expectCode(port.runNow('jobtest-p4a:manual'), 'JOB_ALREADY_PENDING')

    // 把排队行改成 running：同样不许再入队。
    await pool.query("update platform.job_run set status='running' where id=$1", [runId])
    await expectCode(port.runNow('jobtest-p4a:manual'), 'JOB_ALREADY_PENDING')

    // 未知 key / 软删 key ⇒ JOB_NOT_FOUND，且不落运行行。
    await expectCode(port.runNow('jobtest-p4a:nope'), 'JOB_NOT_FOUND')
    await seedSchedule(pool, { key: 'jobtest-p4a:gone', deletedAt: FIXED_NOW })
    await expectCode(port.runNow('jobtest-p4a:gone'), 'JOB_NOT_FOUND')
    const leaked = await pool.query(
      "select 1 from platform.job_run where key='jobtest-p4a:gone'")
    expect(leaked.rows).toHaveLength(0)

    // 缺省 actor ⇒ 审计归属落 null（绝不伪造系统身份）。
    const other = await seedSchedule(pool, { key: 'jobtest-p4a:noactor' })
    const r2 = await port.runNow('jobtest-p4a:noactor')
    const a2 = await pool.query(
      `select tenant_id, actor from platform.audit
        where action='admin.job.run' and detail->>'runId' = $1`, [r2.runId])
    expect(a2.rows[0]).toEqual({ tenant_id: null, actor: null })
    // 该排班确实只入队了一条。
    const n = await pool.query(
      'select count(*)::int as n from platform.job_run where schedule_id=$1', [other])
    expect(n.rows[0].n).toBe(1)
  }, 15_000)

  it('runNow：排班行被占锁 ⇒ 2s 后 JOB_LOCK_TIMEOUT（有界失败，不插行）', async () => {
    const port = mkPort(pool)
    const id = await seedSchedule(pool, { key: 'jobtest-p4a:locked' })

    const holder = await pool.connect()
    try {
      await holder.query('begin')
      await holder.query('select id from platform.job_schedule where id=$1 for update', [id])

      const started = Date.now()
      await expectCode(port.runNow('jobtest-p4a:locked'), 'JOB_LOCK_TIMEOUT')
      // 2s lock_timeout 的现场证据：不是瞬时拒绝，也不是无限等待。
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_800)
      // 连接归还（审阅 Important 1）：错误路径走 `return fail(...)`，`finally` 的
      // `client.release()` 必须照常执行——否则池连接泄漏，且本用例仍会全绿。
      // 此刻只有 holder 一条连接被事务占用，端口连接必须已回到池里。
      expect(pool.idleCount).toBeGreaterThanOrEqual(1)
    } finally {
      await holder.query('rollback').catch(() => {})
      holder.release()
    }

    const runs = await pool.query(
      'select 1 from platform.job_run where schedule_id=$1', [id])
    expect(runs.rows).toHaveLength(0)
    const audit = await pool.query(
      `select 1 from platform.audit
        where action='admin.job.run' and detail->>'key'='jobtest-p4a:locked'`)
    expect(audit.rows).toHaveLength(0)
  }, 15_000)

  it('runNow：真并发两次触发 ⇒ 恰一个成功一个 JOB_ALREADY_PENDING，台账/审计各一行（TOCTOU 原子）', async () => {
    // 自 P1 手动触发路由（routes/platform-jobs.test.ts，W6-P4a 退役）迁入：busy 判定与入队
    // 的原子性现在由端口负责，用例跟着语义走。独立 Pool = 独立会话，才真正走到排班行锁
    // （同 pool 复用连接会让「并发」退化成串行）——两个单连接池各起一个端口。
    await seedSchedule(pool, { key: 'jobtest-p4a:race' })
    const pools = [
      new Pool({ connectionString: dbUrl, max: 1 }),
      new Pool({ connectionString: dbUrl, max: 1 }),
    ]
    try {
      const ports = pools.map((p) => mkPort(p))
      const results = await Promise.allSettled(
        ports.map((port) => port.runNow('jobtest-p4a:race', { tenantId: 990_015, userId: 'u-race' })),
      )
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter(
        (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'JOB_ALREADY_PENDING',
      )
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      // 台账只多一条 queued（没有重复入队）。
      const runs = await pool.query(
        `select count(*)::int as n from platform.job_run
          where key='jobtest-p4a:race' and status='queued'`)
      expect(runs.rows[0].n).toBe(1)
      // 并发下审计同样只落一行（失败的那次 rollback，不写）。
      const audit = await pool.query(
        `select count(*)::int as n from platform.audit
          where action='admin.job.run' and detail->>'key'='jobtest-p4a:race'`)
      expect(audit.rows[0].n).toBe(1)
    } finally {
      await Promise.all(pools.map((p) => p.end().catch(() => {})))
    }
  }, 15_000)
})
