// schedules.test.ts — notify agent 排班工具面（W6-P3，真库）。
//
// 走**生产装配**（makeSchedulerFactory → buildSchedulerPort），不造假端口：配额、归属、
// 软删、runNow 只入队都是端口层的行为，mock 掉就等于测试自己的假设。
// 夹具前缀 `jobtest-p3tool:`：排班 key 恒为 notify.emit（白名单），清理按 owner 前缀，
// 不按 key（避免误删别的用例/环境里同 key 的 agent 排班）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { SchedulerPortFactory } from '@platform/sdk'
import { runMigrations } from '../../../apps/server/src/migrate'
import { makeSchedulerFactory } from '../../../apps/server/src/scheduler/factory'
import { SCHEDULE_TOOLS, callScheduleTool, type ScheduleActor } from './schedules'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const here = dirname(fileURLToPath(import.meta.url))

const ORG_A = 'jobtest-p3tool:org-a'
const ORG_B = 'jobtest-p3tool:org-b'
const actorA: ScheduleActor = { userId: 'jobtest-p3tool:user-a', org: ORG_A }
const actorB: ScheduleActor = { userId: 'jobtest-p3tool:user-b', org: ORG_B }

describe('schedules tool face (static)', () => {
  it('八个排班工具，名字与 brief 一致；create 不接受通道参数', () => {
    expect(SCHEDULE_TOOLS.map((t) => t.name)).toEqual([
      'create_schedule', 'list_schedules', 'pause_schedule', 'resume_schedule',
      'delete_schedule', 'list_schedule_runs', 'run_schedule_now', 'get_schedule_quota',
    ])
    const create = SCHEDULE_TOOLS.find((t) => t.name === 'create_schedule')!
    const props = (create.inputSchema.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['cron', 'expectedIntervalSecs', 'params', 'timezone'])
    // 排班只发站内通知：create 的一级入参里没有任何通道/地址字段。
    expect(Object.keys(props).some((k) => /channel|webhook|wecom|mail|url/i.test(k))).toBe(false)
  })
})

describePg('schedules tool face (db)', () => {
  let pool: Pool
  let factory: SchedulerPortFactory

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // 排班/台账在 platform schema（端口层的表）——模块测试也要把它迁到位。
    await runMigrations(pool, 'platform', join(here, '../../../apps/server/src/migrations'))
    factory = makeSchedulerFactory(pool)
    // **冷扫描预热**：`*/5` 的 min 扫描首次约 1–3s（CI 慢机更久），叠加默认 5s 用例超时
    // 会超时。先走一次公开路径建/删一条，让后续用例命中 gapCache（max 同理）。
    const warmOrg = 'jobtest-p3tool:warm'
    const warm = await factory({ userId: 'jobtest-p3tool:warm-user', org: warmOrg }).createSchedule({
      key: 'notify.emit', cron: '*/5 * * * *', timezone: 'UTC', params: {}, expectedIntervalSecs: 300,
    })
    await pool.query('delete from platform.job_schedule where id=$1', [warm.id])
  }, 30_000)
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(async () => { await cleanup() })

  async function cleanup() {
    await pool.query(
      `delete from platform.job_run where schedule_id in
         (select id from platform.job_schedule where owner_org like 'jobtest-p3tool:%')`,
    )
    await pool.query("delete from platform.job_schedule where owner_org like 'jobtest-p3tool:%'")
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {},
    actor: ScheduleActor = actorA,
    scheduler: SchedulerPortFactory | undefined = factory,
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const r = await callScheduleTool({ scheduler, actor }, name, args)
    if (!r) throw new Error(`${name} 不是排班工具`)
    return { isError: r.isError, body: JSON.parse(r.text) as Record<string, unknown> }
  }

  function createArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      cron: '*/5 * * * *',
      timezone: 'UTC',
      params: { eventKey: 'notify.emit', payload: { title: 'hi' }, scope: 'test' },
      expectedIntervalSecs: 300,
      ...over,
    }
  }

  async function createOne(over: Record<string, unknown> = {}): Promise<string> {
    const { isError, body } = await call('create_schedule', createArgs(over))
    expect(isError).toBe(false)
    return String(body.id)
  }

  async function intervalOf(id: string): Promise<number> {
    const { rows } = await pool.query(
      'select expected_interval_secs from platform.job_schedule where id=$1', [id])
    return rows[0].expected_interval_secs as number
  }

  // 冷缓存首跳：扫描耗时由 cron 与机器决定（CI 慢机可穿 5s 默认超时），显式放宽。
  it('create_schedule：落库 source=agent、归属来自 actor、丢弃通道类参数', { timeout: 30_000 }, async () => {
    const { isError, body } = await call('create_schedule', createArgs({
      params: {
        eventKey: 'notify.emit',
        payload: { title: 'hi' },
        scope: 'test',
        channel: 'wecom_direct', // 伪造：必须被工具层白名单丢弃
        webhook: 'http://evil.example/hook',
      },
    }))
    expect(isError).toBe(false)
    expect(typeof body.id).toBe('string')
    expect(typeof body.nextRunAt).toBe('string')

    const { rows } = await pool.query(
      `select key, cron, timezone, params, source, owner_org, owner_namespace, created_by,
              enabled, expected_interval_secs
         from platform.job_schedule where id=$1`, [body.id])
    expect(rows[0]).toMatchObject({
      key: 'notify.emit',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      source: 'agent',
      owner_org: ORG_A,
      owner_namespace: ORG_A, // 缺省补 org
      created_by: actorA.userId,
      enabled: true,
      expected_interval_secs: 300,
    })
    expect(rows[0].params).toEqual({
      eventKey: 'notify.emit',
      scope: 'test',
      payload: { title: 'hi' },
    })
  })

  // 三个新 cron 的 max 扫描都是冷缓存首跳（虽然迭代少，CI 慢机仍放宽）。
  it('expectedIntervalSecs：缺省取扫描周期内最大间隔（工作日常规 259200），显式值仍优先', { timeout: 30_000 }, async () => {
    const base = { timezone: 'UTC', params: { eventKey: 'notify.emit' } }
    const hourly = await call('create_schedule', { ...base, cron: '0 * * * *' })
    const daily = await call('create_schedule', { ...base, cron: '0 3 * * *' })
    // 工作日 cron：相邻两格是 86400，但周五→周一是 259200；只看向邻两格 ⇒ 周日假红。
    const weekdays = await call('create_schedule', { ...base, cron: '0 0 * * 1-5' })
    const explicit = await call('create_schedule', { ...base, cron: '0 * * * *', expectedIntervalSecs: 1234 })
    expect(hourly.isError || daily.isError || weekdays.isError || explicit.isError).toBe(false)

    expect(await intervalOf(String(hourly.body.id))).toBe(3600)
    expect(await intervalOf(String(daily.body.id))).toBe(86_400)
    expect(await intervalOf(String(weekdays.body.id))).toBeGreaterThanOrEqual(259_200)
    expect(await intervalOf(String(explicit.body.id))).toBe(1234)
  })

  it('list_schedules：只列本 actor 的排班', async () => {
    const idA = await createOne()
    const a = await call('list_schedules')
    expect(a.isError).toBe(false)
    expect((a.body.schedules as Array<{ id: string }>).map((x) => x.id)).toEqual([idA])

    const b = await call('list_schedules', {}, actorB)
    expect(b.body.schedules).toEqual([])

    // 列举按 source 收口：system 行即使带了本 org 的 owner_org 也不该出现（M2）。
    const sys = await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,owner_org,enabled,expected_interval_secs)
       values ('jobtest-p3tool:system','7 * * * *','UTC','system',$1,false,3600) returning id`,
      [ORG_A])
    const aAgain = await call('list_schedules')
    expect((aAgain.body.schedules as Array<{ id: string }>).some((x) => x.id === String(sys.rows[0].id))).toBe(false)
  })

  it('pause_schedule / resume_schedule：enabled 翻转', async () => {
    const id = await createOne()
    const paused = await call('pause_schedule', { id })
    expect(paused.isError).toBe(false)
    expect(paused.body).toMatchObject({ ok: true, id, enabled: false })
    let row = await pool.query('select enabled from platform.job_schedule where id=$1', [id])
    expect(row.rows[0].enabled).toBe(false)

    const resumed = await call('resume_schedule', { id })
    expect(resumed.body).toMatchObject({ ok: true, id, enabled: true })
    row = await pool.query('select enabled from platform.job_schedule where id=$1', [id])
    expect(row.rows[0].enabled).toBe(true)
  })

  it('delete_schedule：软删后 list 不含，台账保留', async () => {
    const id = await createOne()
    await call('run_schedule_now', { id }) // 先留一条台账
    const del = await call('delete_schedule', { id })
    expect(del.isError).toBe(false)
    expect(del.body).toMatchObject({ ok: true, id })

    const row = await pool.query(
      'select deleted_at from platform.job_schedule where id=$1', [id])
    expect(row.rows[0].deleted_at).not.toBeNull()

    const list = await call('list_schedules')
    expect((list.body.schedules as Array<{ id: string }>).some((x) => x.id === id)).toBe(false)

    const runs = await pool.query(
      'select count(*)::int n from platform.job_run where schedule_id=$1', [id])
    expect(runs.rows[0].n).toBe(1) // 软删不删台账
  })

  it('run_schedule_now：只入队（queued / manual），不 spawn', async () => {
    const id = await createOne()
    const out = await call('run_schedule_now', { id })
    expect(out.isError).toBe(false)
    expect(typeof out.body.runId).toBe('string')

    const { rows } = await pool.query(
      `select status, trigger, finished_at, exit_code
         from platform.job_run where id=$1`, [out.body.runId])
    expect(rows[0]).toEqual({
      status: 'queued', trigger: 'manual', finished_at: null, exit_code: null,
    })
    // 「只入队」：不存在第二条 running/ok 行（端口绝不 spawn）。
    const all = await pool.query(
      `select status from platform.job_run where schedule_id=$1 order by id`, [id])
    expect(all.rows.map((r) => r.status)).toEqual(['queued'])
  })

  it('list_schedule_runs：返回该排班的台账，limit 生效', async () => {
    const id = await createOne()
    await call('run_schedule_now', { id })
    const out = await call('list_schedule_runs', { id, limit: 10 })
    expect(out.isError).toBe(false)
    const runs = out.body.runs as Array<{ id: string; status: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('queued')

    const empty = await call('list_schedule_runs', { id, limit: 0 }) // 端口 cap 到 1..100
    expect((empty.body.runs as unknown[])).toHaveLength(1)
  })

  it('get_schedule_quota：与端口同源（50 / 300s / 200）', async () => {
    await createOne({ cron: '7 * * * *' })
    const out = await call('get_schedule_quota')
    expect(out.isError).toBe(false)
    expect(out.body).toMatchObject({
      schedules: { used: 1, limit: 50 },
      dailyFirings: { used: 0, limit: 200 },
      minIntervalSecs: 300,
    })
  })

  it('配额超限：QUOTA_EXCEEDED 原样透出 kind/limit（*/4 的整周期最小间隔 240s）', async () => {
    const out = await call('create_schedule', createArgs({ cron: '*/4 * * * *' }))
    expect(out.isError).toBe(true)
    expect(out.body).toMatchObject({ ok: false, code: 'QUOTA_EXCEEDED', kind: 'min_interval', limit: 300 })
    const n = await pool.query(
      'select count(*)::int n from platform.job_schedule where owner_org=$1', [ORG_A])
    expect(n.rows[0].n).toBe(0) // 被拒即不落库
  })

  it('宽 cron 在最小间隔闸门早退：* * * * * 被拒时不做 max 完整扫描（<1s）', async () => {
    // **不能带 expectedIntervalSecs**：带了端口就根本不推导 max，用例会空转。
    const args = { cron: '* * * * *', timezone: 'UTC', params: { eventKey: 'notify.emit' } }
    const t0 = Date.now()
    const out = await call('create_schedule', args)
    const elapsed = Date.now() - t0
    expect(out.body).toMatchObject({
      ok: false, code: 'QUOTA_EXCEEDED', kind: 'min_interval', limit: 300,
    })
    // 完整 max 扫描在 * * * * * 上会撞 5000 迭代上限（冷启动可到十几秒）；闸门先拒 ⇒ 毫秒级。
    expect(elapsed).toBeLessThan(1000)
  })

  it('非法 cron：INVALID_CRON 透出', async () => {
    const out = await call('create_schedule', createArgs({ cron: 'not a cron' }))
    expect(out.isError).toBe(true)
    expect(out.body).toMatchObject({ ok: false, code: 'INVALID_CRON' })
  })

  it('归属隔离：另一个 actor 看不到 / 改不了 / 删不了', async () => {
    const id = await createOne()
    const pause = await call('pause_schedule', { id }, actorB)
    expect(pause.body).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const del = await call('delete_schedule', { id }, actorB)
    expect(del.body).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const runs = await call('list_schedule_runs', { id }, actorB)
    expect(runs.body).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('ctx.scheduler 缺失：八个工具一律 SCHEDULER_UNAVAILABLE，不抛', async () => {
    for (const tool of SCHEDULE_TOOLS) {
      // 直接调（helper 的默认参数会把 undefined 换回 factory）。
      const r = await callScheduleTool(
        { actor: actorA },
        tool.name,
        { id: '1', cron: '*/5 * * * *', params: { eventKey: 'notify.emit' } },
      )
      expect(r?.isError).toBe(true)
      expect(JSON.parse(r!.text)).toMatchObject({ ok: false, code: 'SCHEDULER_UNAVAILABLE' })
    }
  })

  it('非排班工具返回 null（调用方可继续走自己的分支）', async () => {
    expect(await callScheduleTool({ scheduler: factory, actor: actorA }, 'list_events', {})).toBeNull()
  })
})
