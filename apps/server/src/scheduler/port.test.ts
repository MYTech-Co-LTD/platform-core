// port.test.ts — SchedulerPort 的黑盒用例（真库）。
//
// 覆盖的**安全边界**比功能更多：归属只能来自 actor（params 伪造无效）、跨归属一律 NOT_FOUND、
// runNow 只入队不 spawn、软删后两条 claim 路径都看不见。
// 夹具前缀 `jobtest-port:`：排班的 key 恒为 `notify.emit`（白名单），所以清理按 owner 前缀，
// 不按 key（否则会误删别的用例/环境里同 key 的 agent 排班）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { nextRunAt } from './cron'
import { claimDue, claimQueuedManual } from './store'
import { buildSchedulerPort, type SchedulerActor } from './port'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const ORG_A = 'jobtest-port:org-a'
const NS_A = 'jobtest-port:ns-a'
const actorA: SchedulerActor = { userId: 'jobtest-port:user-a', org: ORG_A, namespace: NS_A }
const actorB: SchedulerActor = {
  userId: 'jobtest-port:user-b',
  org: 'jobtest-port:org-b',
  namespace: 'jobtest-port:ns-b',
}

/** 固定 now 让 nextRunAt 可逐字断言（cron `*​/5 * * * *` @ UTC 的下一次 = 00:05）。 */
const FIXED_NOW = new Date('2026-11-14T00:00:00.000Z')

async function clearFixtures(pool: Pool) {
  // job_run 对 job_schedule 有外键（无级联），先删运行行。
  await pool.query(
    `delete from platform.job_run where schedule_id in
       (select id from platform.job_schedule
         where owner_org like 'jobtest-port:%' or owner_namespace like 'jobtest-port:%')`,
  )
  await pool.query(
    `delete from platform.job_schedule
      where owner_org like 'jobtest-port:%' or owner_namespace like 'jobtest-port:%'`,
  )
}

function mkPort(pool: Pool, actor: SchedulerActor = actorA, now: () => Date = () => FIXED_NOW) {
  return buildSchedulerPort({ pool, actor, now })
}

function baseInput() {
  return {
    key: 'notify.emit',
    cron: '*/5 * * * *',
    timezone: 'UTC',
    params: { channel: 'jobtest-port', title: 'hi' } as Record<string, unknown>,
    expectedIntervalSecs: 300,
  }
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code })
}

describePg('SchedulerPort', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', dir)
  })
  beforeEach(async () => { await clearFixtures(pool) })
  afterAll(async () => { await clearFixtures(pool); await pool.end() })

  it('★ 白名单：非 notify.emit 的 key 一律 UNKNOWN_JOB_KEY，且不落库', async () => {
    const port = mkPort(pool)
    // 在 registry 里但不在 agent 白名单 → 同样拒绝。
    await expectCode(port.createSchedule({ ...baseInput(), key: 'notify.reconcile' }), 'UNKNOWN_JOB_KEY')
    await expectCode(port.createSchedule({ ...baseInput(), key: 'jobtest-port:nope' }), 'UNKNOWN_JOB_KEY')
    const { rows } = await pool.query(
      'select count(*)::int as n from platform.job_schedule where owner_org=$1', [ORG_A])
    expect(rows[0].n).toBe(0)
  })

  it('★ 归属只来自 actor：params 里伪造的 ownerOrg/ownerNamespace 被忽略', async () => {
    const port = mkPort(pool)
    const r = await port.createSchedule({
      ...baseInput(),
      params: {
        ownerOrg: 'jobtest-port:evil-org',
        ownerNamespace: 'jobtest-port:evil-ns',
        channel: 'jobtest-port',
      },
    })
    expect(r.nextRunAt).toBe('2026-11-14T00:05:00.000Z')

    const { rows } = await pool.query('select * from platform.job_schedule where id=$1', [r.id])
    const row = rows[0]
    expect(row.owner_org).toBe(ORG_A)
    expect(row.owner_namespace).toBe(NS_A)
    expect(row.created_by).toBe(actorA.userId)
    expect(row.source).toBe('agent')
    expect(row.enabled).toBe(true)
    expect(new Date(row.next_run_at).toISOString()).toBe(r.nextRunAt)
    // 保留字不落进 params（否则下游可能把它们当归属读）。
    expect(row.params).toEqual({ channel: 'jobtest-port' })
  })

  it('createSchedule 校验 cron / expectedIntervalSecs / params 大小', async () => {
    const port = mkPort(pool)
    await expectCode(port.createSchedule({ ...baseInput(), cron: '0 0 * * MON' }), 'INVALID_CRON')
    await expectCode(port.createSchedule({ ...baseInput(), expectedIntervalSecs: 0 }), 'INVALID_INTERVAL')
    // int4 上界（2147483647）之外：不能让 PG 抛 22003。
    await expectCode(port.createSchedule({ ...baseInput(), expectedIntervalSecs: 1e12 }), 'INVALID_INTERVAL')
    await expectCode(
      port.createSchedule({ ...baseInput(), params: { blob: 'x'.repeat(17 * 1024) } }),
      'PARAMS_TOO_LARGE',
    )
  })

  it('★ 配额：每 namespace 最多 50 条 agent 排班，第 51 条 QUOTA_EXCEEDED', async () => {
    const port = mkPort(pool)
    // 上限 = 50：建满 50 条都合法（第 50 条仍在额度内）。
    for (let i = 0; i < 50; i++) await port.createSchedule(baseInput())
    const used = await pool.query(
      `select count(*)::int as n from platform.job_schedule
        where owner_org=$1 and owner_namespace=$2 and deleted_at is null and source='agent'`,
      [ORG_A, NS_A])
    expect(used.rows[0].n).toBe(50)

    await expect(port.createSchedule(baseInput())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED', kind: 'schedules', limit: 50,
    })
    // 拒绝必须发生在插入前：库里仍是 50 条。
    const after = await pool.query(
      `select count(*)::int as n from platform.job_schedule
        where owner_org=$1 and owner_namespace=$2 and deleted_at is null and source='agent'`,
      [ORG_A, NS_A])
    expect(after.rows[0].n).toBe(50)
  })

  it('★ 配额并发：49 条时两次同时建，只成功一条（事务内计数 + 配额锁）', async () => {
    const port = mkPort(pool)
    for (let i = 0; i < 49; i++) await port.createSchedule(baseInput())

    const results = await Promise.allSettled([port.createSchedule(baseInput()), port.createSchedule(baseInput())])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ code: 'QUOTA_EXCEEDED', kind: 'schedules', limit: 50 })

    // 没有串行化时两条事务都会读到 49 并各自插入 ⇒ 51。
    const { rows } = await pool.query(
      `select count(*)::int as n from platform.job_schedule
        where owner_org=$1 and owner_namespace=$2 and deleted_at is null and source='agent'`,
      [ORG_A, NS_A])
    expect(rows[0].n).toBe(50)
  })

  it('★ 配额：最小 cron 间隔 5 分钟（*/5 可建、*/4 拒）', async () => {
    const port = mkPort(pool)
    await expect(port.createSchedule({ ...baseInput(), cron: '*/4 * * * *' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED', kind: 'min_interval', limit: 300,
    })
    const ok = await port.createSchedule({ ...baseInput(), cron: '*/5 * * * *' })
    expect(ok.nextRunAt).toBe('2026-11-14T00:05:00.000Z')
  })

  it('★ 配额：每 namespace 每日最多 200 条 firing，到 200 拒建', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       select $1,'notify.emit',now(),'schedule','ok', now() - (g * interval '1 second')
         from generate_series(1,200) g`, [id])

    await expect(port.createSchedule(baseInput())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED', kind: 'daily_firings', limit: 200,
    })

    // 边界：199 条时仍可建（额度是「最多 200」，不是「到 200 前一条」）。
    await pool.query(
      `delete from platform.job_run
        where id = (select max(id) from platform.job_run where schedule_id=$1)`, [id])
    await expect(port.createSchedule(baseInput())).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('quotaOf：返回 used/limit（schedules 50 / dailyFirings 200 / minIntervalSecs 300）', async () => {
    const port = mkPort(pool)
    expect(await port.quotaOf()).toEqual({
      schedules: { used: 0, limit: 50 },
      dailyFirings: { used: 0, limit: 200 },
      minIntervalSecs: 300,
    })

    const { id } = await port.createSchedule(baseInput())
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       select $1,'notify.emit',now(),'schedule','ok', now() - (g * interval '1 minute')
         from generate_series(1,3) g`, [id])
    expect(await port.quotaOf()).toEqual({
      schedules: { used: 1, limit: 50 },
      dailyFirings: { used: 3, limit: 200 },
      minIntervalSecs: 300,
    })
  })

  it('★ 跨归属：四个 id 方法一律 NOT_FOUND（不用 403，避免枚举）', async () => {
    const a = mkPort(pool)
    const { id } = await a.createSchedule(baseInput())
    const b = mkPort(pool, actorB)
    await expectCode(b.setScheduleEnabled(id, false), 'NOT_FOUND')
    await expectCode(b.deleteSchedule(id), 'NOT_FOUND')
    await expectCode(b.listRuns(id, 10), 'NOT_FOUND')
    await expectCode(b.runNow(id), 'NOT_FOUND')

    // namespace 也是归属的一部分：同 org 不同 namespace 同样 NOT_FOUND。
    const sameOrgOtherNs = mkPort(pool, { ...actorA, namespace: 'jobtest-port:ns-other' })
    await expectCode(sameOrgOtherNs.runNow(id), 'NOT_FOUND')

    // int8 域外 id（30 位）：必须在端口判 NOT_FOUND，不能下发 PG 抛 22003。
    await expectCode(a.runNow('1' + '0'.repeat(29)), 'NOT_FOUND')

    // 越权尝试不得改动原行。
    const { rows } = await pool.query(
      'select enabled, deleted_at from platform.job_schedule where id=$1', [id])
    expect(rows[0].enabled).toBe(true)
    expect(rows[0].deleted_at).toBeNull()
  })

  it('★ runNow 只入队：queued/manual、不建 running；已有排队时 JOB_ALREADY_PENDING', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    const { runId } = await port.runNow(id)
    expect(typeof runId).toBe('string')

    const { rows } = await pool.query(
      'select schedule_id, key, trigger, status, owner_org, owner_namespace from platform.job_run where id=$1',
      [runId])
    // 运行行带归属（与 createSchedule 同源）：agent 触发的运行在台账里可区分。
    expect(rows[0]).toEqual({
      schedule_id: id, key: 'notify.emit', trigger: 'manual', status: 'queued',
      owner_org: ORG_A, owner_namespace: NS_A,
    })
    const running = await pool.query(
      "select count(*)::int as n from platform.job_run where schedule_id=$1 and status='running'", [id])
    expect(running.rows[0].n).toBe(0)

    await expectCode(port.runNow(id), 'JOB_ALREADY_PENDING')
  })

  it('★ runNow 并发：两次同时触发只入队一次，另一个 JOB_ALREADY_PENDING', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    const results = await Promise.allSettled([port.runNow(id), port.runNow(id)])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ code: 'JOB_ALREADY_PENDING' })

    const { rows } = await pool.query(
      "select count(*)::int as n from platform.job_run where schedule_id=$1 and status='queued'", [id])
    expect(rows[0].n).toBe(1)
  })

  it('★ runNow 行锁等待有界：另一会话持锁 ⇒ ~2s 内 JOB_LOCK_TIMEOUT，且不插行', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    const holder = await pool.connect()
    try {
      await holder.query('begin')
      await holder.query('select id from platform.job_schedule where id=$1 for update', [id])
      const t0 = Date.now()
      await expectCode(port.runNow(id), 'JOB_LOCK_TIMEOUT')
      const elapsed = Date.now() - t0
      // lock_timeout='2s'：不能立刻失败（说明确实在等锁），也不能无限期占连接。
      expect(elapsed).toBeGreaterThanOrEqual(1500)
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await holder.query('rollback').catch(() => {})
      holder.release()
    }
    const { rows } = await pool.query(
      "select count(*)::int as n from platform.job_run where schedule_id=$1 and status in ('queued','running')",
      [id])
    expect(rows[0].n).toBe(0)
  })

  it('★ deleteSchedule 软删后：listSchedules 不含、两条 claim 路径都领不到', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    // 造出「极度逾期（1980）+ 一条 manual queued」：若软删失效，limit=1 时它必是第一个候选
    // （beforeEach 已清掉本前缀的全部 due/queued 行，避免被自己上一轮的残留占位）。
    await pool.query(
      "update platform.job_schedule set next_run_at = '1980-01-01T00:00:00Z' where id=$1", [id])
    const queued = await pool.query<{ id: string }>(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,'notify.emit',now(),'manual','queued') returning id`, [id])
    const queuedRunId = String(queued.rows[0].id)

    await port.deleteSchedule(id)

    const list = await port.listSchedules({ ownerOrg: ORG_A })
    expect(list.map((s) => s.id)).not.toContain(id)
    const claimed = await claimDue(pool, 1, new Date(), nextRunAt)
    expect(claimed.some((j) => String(j.scheduleId) === id)).toBe(false)
    const manual = await claimQueuedManual(pool, 1, new Date())
    expect(manual.some((j) => String(j.scheduleId) === id)).toBe(false)
    // 直接断言那条 queued 行未被消费：共享库上只断言「结果不含」在 limit=1 时可能空转。
    const consumed = await pool.query('select status from platform.job_run where id=$1', [queuedRunId])
    expect(consumed.rows[0].status).toBe('queued')

    const { rows } = await pool.query(
      'select deleted_at, enabled, next_run_at from platform.job_schedule where id=$1', [id])
    expect(rows[0].deleted_at).not.toBeNull()
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_run_at).toBeNull()
  })

  it('listSchedules：ownerOrg 取 actor、可选 namespace 收窄、排除软删、id 升序', async () => {
    const a = mkPort(pool)
    const a2 = mkPort(pool, { ...actorA, namespace: 'jobtest-port:ns-a2' })
    const s1 = await a.createSchedule(baseInput())
    const s2 = await a2.createSchedule({ ...baseInput(), cron: '*/7 * * * *' })

    const all = await a.listSchedules({ ownerOrg: ORG_A })
    expect(all.map((s) => s.id)).toEqual([s1.id, s2.id])
    expect(all.every((s) => s.deletedAt === null)).toBe(true)

    const only = await a.listSchedules({ ownerOrg: ORG_A, ownerNamespace: NS_A })
    expect(only.map((s) => s.id)).toEqual([s1.id])
  })

  it('★ listSchedules 的 filter.ownerOrg 被忽略：归属恒取 actor（跨租户列举不可能）', async () => {
    const a = mkPort(pool)
    const { id } = await a.createSchedule(baseInput())
    // 传别的租户也不改变结果：仍只含 actor 自己的排班。
    const evil = await a.listSchedules({ ownerOrg: 'jobtest-port:other-org' })
    expect(evil.map((s) => s.id)).toEqual([id])
    // 反过来：租户 B 传 ORG_A 也看不到 A 的排班。
    const b = mkPort(pool, actorB)
    expect(await b.listSchedules({ ownerOrg: ORG_A })).toEqual([])
  })

  it('★ listSchedules 的 ownerNamespace 只能收窄：传别的值 ⇒ 空数组', async () => {
    const a = mkPort(pool)
    const { id } = await a.createSchedule(baseInput())
    expect(await a.listSchedules({ ownerOrg: ORG_A, ownerNamespace: 'jobtest-port:other-ns' })).toEqual([])
    expect((await a.listSchedules({ ownerOrg: ORG_A, ownerNamespace: NS_A })).map((s) => s.id))
      .toEqual([id])
  })

  it('setScheduleEnabled：归属内可启停', async () => {
    const a = mkPort(pool)
    const { id } = await a.createSchedule(baseInput())
    await a.setScheduleEnabled(id, false)
    expect((await a.listSchedules({ ownerOrg: ORG_A }))[0].enabled).toBe(false)
    await a.setScheduleEnabled(id, true)
    expect((await a.listSchedules({ ownerOrg: ORG_A }))[0].enabled).toBe(true)
  })

  it('★ listRuns：按 started_at desc 排序、上限 100、字段形状正确', async () => {
    const port = mkPort(pool)
    const { id } = await port.createSchedule(baseInput())
    const base = new Date('2026-11-14T00:00:00.000Z').getTime()
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `insert into platform.job_run
           (schedule_id,key,occurrence,trigger,status,started_at,finished_at,exit_code,output_tail)
         values ($1,'notify.emit',now(),'schedule',$2,$3,$4,$5,$6)`,
        [
          id, i % 2 ? 'failed' : 'ok',
          new Date(base + i * 60_000), new Date(base + i * 60_000 + 30_000),
          i % 2 ? 1 : 0, `tail-${i}`,
        ],
      )
    }

    const runs = await port.listRuns(id, 3)
    expect(runs.map((r) => r.outputTail)).toEqual(['tail-4', 'tail-3', 'tail-2'])
    expect(runs[0]).toEqual({
      id: expect.any(String),
      status: 'ok',
      startedAt: '2026-11-14T00:04:00.000Z',
      finishedAt: '2026-11-14T00:04:30.000Z',
      exitCode: 0,
      outputTail: 'tail-4',
    })

    // 上限 100：库里 110 条，传 500 也只回 100。
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       select $1,'notify.emit',now(),'schedule','ok', now() - (g * interval '1 second')
         from generate_series(1,105) g`, [id])
    const capped = await port.listRuns(id, 500)
    expect(capped).toHaveLength(100)
    for (let i = 1; i < capped.length; i++) {
      expect(new Date(capped[i - 1].startedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(capped[i].startedAt).getTime())
    }
  })
})
