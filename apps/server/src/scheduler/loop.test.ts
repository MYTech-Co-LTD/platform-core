import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { createSchedulerLoop } from './loop'
import type { JobDef } from './registry'
import type { SpawnResult } from './runner'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

/** 夹具 key 前缀：job_run 对 job_schedule 有外键（无级联），清理必须先删运行行再删排班行。 */
const PREFIX = 'jobtest-loop:%'

function def(over: Partial<JobDef> = {}): JobDef {
  return {
    key: 'jobtest-loop:loop', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC',
    timeoutMs: 500, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't', ...over,
  }
}

const okResult = (): SpawnResult => ({ code: 0, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
const rejResult = (): SpawnResult => ({ code: 1, signal: null, timedOut: false, outputTail: '', durationMs: 1 })

describePg('scheduler loop', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await clearFixtures(); await pool.end() })

  async function clearFixtures(): Promise<void> {
    await pool.query(
      `delete from platform.job_run where schedule_id in
         (select id from platform.job_schedule where key like $1)`, [PREFIX])
    await pool.query('delete from platform.job_schedule where key like $1', [PREFIX])
  }

  async function seed(over: {
    key?: string; nextRunAt?: Date; timeoutMs?: number; maxAttempts?: number
  } = {}): Promise<number> {
    await clearFixtures()
    const { rows } = await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
       values ($1,'7 * * * *','UTC','system',true,$2,$3,$4,3600) returning id`,
      [over.key ?? 'jobtest-loop:loop', over.nextRunAt ?? new Date(Date.now() - 60_000),
        over.timeoutMs ?? 500, over.maxAttempts ?? 1],
    )
    return Number(rows[0].id)
  }

  interface RunRow { status: string; error: string | null; occurrence: Date }

  async function latestRun(scheduleId: number): Promise<RunRow | undefined> {
    const { rows } = await pool.query<RunRow>(
      `select status, error, occurrence from platform.job_run
        where schedule_id=$1 order by id desc limit 1`, [scheduleId])
    return rows[0]
  }

  /** 轮询直到 predicate 成立；tick 是「起进程即返回」，完成回调必然晚于 tick 返回。 */
  async function waitUntil<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await fn()
      if (v) return v as T
      if (Date.now() > deadline) throw new Error(`waitUntil 超时：${label}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('★ tick 不等子进程结束就返回（长任务不阻塞投递 loop）', async () => {
    const id = await seed()
    let finished = false
    const loop = createSchedulerLoop({
      pool, registry: [def()], cwd: process.cwd(), maxConcurrency: 2,
      spawn: async () => {
        await new Promise((r) => setTimeout(r, 300))
        finished = true
        return okResult()
      },
    })
    const stats = await loop.tick()
    expect(stats.started).toBe(1)
    // 关键断言：tick 已返回，而子进程还没结束。
    expect(finished).toBe(false)
    // claim 与台账同生共死：running 行在 tick 返回时已落库（不是等 spawn 结束才建）。
    const running = await pool.query<{ n: number }>(
      "select count(*)::int as n from platform.job_run where schedule_id=$1 and status='running'", [id])
    expect(running.rows[0].n).toBe(1)

    const row = await waitUntil(async () => {
      const r = await latestRun(id)
      return r && r.status !== 'running' ? r : null
    }, 'run 终态')
    expect(finished).toBe(true)
    expect(row.status).toBe('ok')
  })

  it('并发上限：maxConcurrency=1 时第二次 tick 不再起新进程', async () => {
    await seed()
    let spawnCalls = 0
    const loop = createSchedulerLoop({
      pool, registry: [def()], cwd: process.cwd(), maxConcurrency: 1,
      // 永不返回：占满唯一名额（该 Promise 不持有 timer，不会拖住测试进程）。
      spawn: () => { spawnCalls += 1; return new Promise<SpawnResult>(() => {}) },
    })
    await loop.tick()
    const second = await loop.tick()
    expect(second.started).toBe(0)
    expect(second.claimed).toBe(0)
    expect(spawnCalls).toBe(1)
    expect(loop.inFlight()).toBe(1)
  })

  it('★ 未知 registry key：已 claim 的 running 行收成 failed，不重试', async () => {
    const id = await seed({ key: 'jobtest-loop:gone' })
    const loop = createSchedulerLoop({
      pool, registry: [def({ key: 'jobtest-loop:present' })], cwd: process.cwd(), maxConcurrency: 2,
      spawn: async () => okResult(),
    })
    await loop.tick()
    const row = await waitUntil(async () => {
      const r = await latestRun(id)
      return r && r.status !== 'running' ? r : null
    }, 'unknown key 的终态')
    expect(row.status).toBe('failed')
    expect(row.error).toBe('unknown registry key')
    const { rows } = await pool.query('select retry_at from platform.job_schedule where id=$1', [id])
    expect(rows[0].retry_at).toBeNull()
  })

  it('★ spawn 同步抛错（ENAMETOOLONG）：转成 failed 终态，不冒泡打断整拍', async () => {
    const id = await seed()
    const loop = createSchedulerLoop({
      pool, registry: [def()], cwd: process.cwd(), maxConcurrency: 2,
      // 非 async 且直接 throw：模拟 nodeSpawn 在参数过长时同步抛（Task 6 遗留项）。
      spawn: () => { throw new Error('ENAMETOOLONG: bad args') },
    })
    // tick 本身不得 reject —— 同步抛错只影响这一个 run。
    const stats = await loop.tick()
    expect(stats.started).toBe(1)
    const row = await waitUntil(async () => {
      const r = await latestRun(id)
      return r && r.status !== 'running' ? r : null
    }, 'throw 的终态')
    expect(row.status).toBe('failed')
    expect(row.error).toContain('ENAMETOOLONG')
  })

  it('★ 重试差异：排班侧可重试失败落 retry 槽；手动失败不碰 retry 槽', async () => {
    // 排班侧：exit 1 可重试 + attempt(1) < maxAttempts(2) ⇒ 写 retry 槽（occurrence 原样保留）。
    const sid = await seed({ maxAttempts: 2 })
    const loop = createSchedulerLoop({
      pool, registry: [def({ maxAttempts: 2 })], cwd: process.cwd(), maxConcurrency: 2,
      spawn: async () => rejResult(),
    })
    await loop.tick()
    const sched = await waitUntil(async () => {
      const r = await latestRun(sid)
      return r && r.status === 'failed' ? r : null
    }, '排班失败终态')
    // finishRun 与重试记账是两次写：等 retry_at 落库再断言。
    const slot = await waitUntil(async () => {
      const { rows } = await pool.query(
        'select retry_at, retry_occurrence, retry_attempt from platform.job_schedule where id=$1', [sid])
      const s = rows[0]
      return s.retry_at ? s : null
    }, '排班 retry 槽')
    expect(slot.retry_attempt).toBe(1)
    expect(new Date(slot.retry_occurrence).toISOString()).toBe(sched.occurrence.toISOString())

    // 手动侧：同样的失败结果，但 manual 不参与重试 ⇒ retry 槽保持空。
    await clearFixtures()
    const mid = await seed({ nextRunAt: new Date(Date.now() + 86_400_000), maxAttempts: 2 })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,'jobtest-loop:loop',now(),'manual','queued')`, [mid])
    await loop.tick()
    const man = await waitUntil(async () => {
      const r = await latestRun(mid)
      return r && r.status === 'failed' ? r : null
    }, '手动失败终态')
    expect(man.status).toBe('failed')
    const after = await pool.query('select retry_at, retry_attempt from platform.job_schedule where id=$1', [mid])
    expect(after.rows[0].retry_at).toBeNull()
    expect(after.rows[0].retry_attempt).toBe(0)
  })
})
