import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { jobHealth } from './health'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

/** 夹具前缀。job_run 对 job_schedule 有外键（无级联）⇒ 清理先删运行行。 */
const PREFIX = 'jobtest-health:'

describePg('jobHealth', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', dir)
  })

  afterAll(async () => {
    await clearFixtures()
    await pool.end()
  })

  beforeEach(async () => {
    await clearFixtures()
    // 默认把心跳置为新鲜；心跳类用例自己改。
    await pool.query(
      `insert into platform.job_heartbeat(id,beat_at) values ('scheduler',now())
       on conflict (id) do update set beat_at = excluded.beat_at`,
    )
  })

  async function clearFixtures(): Promise<void> {
    await pool.query(
      `delete from platform.job_run where schedule_id in
         (select id from platform.job_schedule where key like $1)`,
      [`${PREFIX}%`],
    )
    await pool.query('delete from platform.job_schedule where key like $1', [`${PREFIX}%`])
  }

  async function insertSchedule(o: {
    key: string
    enabled?: boolean
    source?: 'system' | 'agent'
    intervalSecs?: number
    updatedAt?: Date
    nextRunAt?: Date | null
  }): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into platform.job_schedule
         (key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,
          expected_interval_secs,updated_at)
       values ($1,'0 * * * *','UTC',$2,$3,$4,1000,1,$5,$6) returning id`,
      [o.key, o.source ?? 'system', o.enabled ?? true, o.nextRunAt ?? null,
        o.intervalSecs ?? 60, o.updatedAt ?? new Date()],
    )
    return Number(rows[0].id)
  }

  async function insertRun(scheduleId: number, key: string, status: string, startedAt: Date): Promise<void> {
    await pool.query(
      `insert into platform.job_run
         (schedule_id,key,occurrence,trigger,status,started_at,finished_at)
       values ($1,$2,$3,'schedule',$4,$5,$5)`,
      [scheduleId, key, startedAt, status, startedAt],
    )
  }

  const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000)

  /** 只断言本夹具自己的 reason：共享库里别的失败排班不影响本文件的「不红」用例。 */
  const prefixReasons = (h: { reasons: string[] }): string[] =>
    h.reasons.filter((r) => r.includes(PREFIX))

  it('心跳新鲜 + 本前缀无排班 ⇒ 本前缀无 reason', async () => {
    const h = await jobHealth(pool, new Date())
    expect(h.reasons.filter((r) => r.includes('心跳'))).toEqual([])
    expect(prefixReasons(h)).toEqual([])
  })

  it('★ 心跳陈旧 > 2 分钟 ⇒ 红', async () => {
    await pool.query(
      "update platform.job_heartbeat set beat_at = now() - interval '3 minutes' where id='scheduler'",
    )
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('心跳')
  })

  it('★ 从未心跳（行不存在）⇒ 红', async () => {
    await pool.query("delete from platform.job_heartbeat where id='scheduler'")
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('心跳')
    expect(h.reasons.join()).toContain('从未写入')
  })

  it('★ 从未成功且超期（无运行，updated_at 已过宽限）⇒ 红', async () => {
    await insertSchedule({
      key: `${PREFIX}overdue`, intervalSecs: 60, updatedAt: minutesAgo(60),
    })
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(prefixReasons(h).join()).toContain(`${PREFIX}overdue`)
    expect(prefixReasons(h).join()).toContain('没有成功运行')
  })

  it('★ 刚启用未超期（无运行，updated_at 是现在）⇒ 不红（宽限）', async () => {
    await insertSchedule({ key: `${PREFIX}fresh`, intervalSecs: 60 })
    const h = await jobHealth(pool, new Date())
    expect(prefixReasons(h)).toEqual([])
  })

  it('★ 连续 3 次失败 ⇒ 红', async () => {
    const id = await insertSchedule({ key: `${PREFIX}failing`, intervalSecs: 3600 })
    // 间隔 2h 内、刚跑过几次 ⇒ 判据 ② 不触发，红的唯一来源是 ③。
    await insertRun(id, `${PREFIX}failing`, 'failed', minutesAgo(3))
    await insertRun(id, `${PREFIX}failing`, 'timeout', minutesAgo(2))
    await insertRun(id, `${PREFIX}failing`, 'failed', minutesAgo(1))
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(prefixReasons(h).join()).toContain(`${PREFIX}failing`)
    expect(prefixReasons(h).join()).toContain('最近 3 次')
  })

  it('★ 最近 3 次里有 ok ⇒ 不红', async () => {
    const id = await insertSchedule({ key: `${PREFIX}flaky`, intervalSecs: 3600 })
    await insertRun(id, `${PREFIX}flaky`, 'failed', minutesAgo(4))
    await insertRun(id, `${PREFIX}flaky`, 'failed', minutesAgo(3))
    await insertRun(id, `${PREFIX}flaky`, 'ok', minutesAgo(2))
    const h = await jobHealth(pool, new Date())
    expect(prefixReasons(h)).toEqual([])
  })

  it('★ 最近 3 次含 running/queued ⇒ 稀释连败、不红（非终态不参与连败）', async () => {
    const id = await insertSchedule({ key: `${PREFIX}diluted`, intervalSecs: 3600 })
    await insertRun(id, `${PREFIX}diluted`, 'failed', minutesAgo(3))
    await insertRun(id, `${PREFIX}diluted`, 'failed', minutesAgo(2))
    await insertRun(id, `${PREFIX}diluted`, 'running', minutesAgo(1))
    const h = await jobHealth(pool, new Date())
    expect(prefixReasons(h)).toEqual([])
  })

  it('★ 曾成功但最后一次 ok 已超窗，最近刚失败过也红（不给「从未成功」宽限）', async () => {
    const id = await insertSchedule({ key: `${PREFIX}stale-ok`, intervalSecs: 60, updatedAt: minutesAgo(120) })
    await insertRun(id, `${PREFIX}stale-ok`, 'ok', minutesAgo(60)) // 2×60s 早已过
    await insertRun(id, `${PREFIX}stale-ok`, 'failed', minutesAgo(1)) // 最近有运行，但不是 ok
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(prefixReasons(h).join()).toContain(`${PREFIX}stale-ok`)
    expect(prefixReasons(h).join()).toContain('没有成功运行')
  })

  it('★ 未启用的排班不参与判定（即便超期 + 连续失败）', async () => {
    const id = await insertSchedule({
      key: `${PREFIX}disabled`, enabled: false, intervalSecs: 60, updatedAt: minutesAgo(120),
    })
    await insertRun(id, `${PREFIX}disabled`, 'failed', minutesAgo(3))
    await insertRun(id, `${PREFIX}disabled`, 'failed', minutesAgo(2))
    await insertRun(id, `${PREFIX}disabled`, 'failed', minutesAgo(1))
    const h = await jobHealth(pool, new Date())
    expect(prefixReasons(h)).toEqual([])
  })

  it('★ source=agent 的 enabled 排班超期同样判红（判据②覆盖所有 enabled）', async () => {
    await insertSchedule({
      key: `${PREFIX}agent-overdue`, source: 'agent', intervalSecs: 60, updatedAt: minutesAgo(60),
    })
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(prefixReasons(h).join()).toContain(`${PREFIX}agent-overdue`)
    expect(prefixReasons(h).join()).toContain('没有成功运行')
  })
})
