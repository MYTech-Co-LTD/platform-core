// health.test.ts — 健康判定（纯函数 + 真库查询）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { FAILED_LAST_HOUR_LIMIT, checkHealth, healthVerdict, type Health } from './health'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-health2'

const clean = (over: Partial<Health> = {}): Health => ({
  dead: 0, stale: 0, workers: 1,
  oldestPendingSeconds: 0, failedLastHour: 0, channelErrors: 0,
  eventsNoRecipients: 0, eventsNoChannel: 0, eventsInvalid: 0,
  ...over,
})

describe('healthVerdict', () => {
  it('dead / stale / 无心跳 ⇒ 1；全清 ⇒ 0', () => {
    expect(healthVerdict(clean())).toBe(0)
    expect(healthVerdict(clean({ dead: 1 }))).toBe(1)
    expect(healthVerdict(clean({ stale: 1 }))).toBe(1)
    expect(healthVerdict(clean({ workers: 0 }))).toBe(1)
  })

  it('近 1 小时失败超阈值 ⇒ 1；等于阈值 ⇒ 0', () => {
    expect(healthVerdict(clean({ failedLastHour: FAILED_LAST_HOUR_LIMIT }))).toBe(0)
    expect(healthVerdict(clean({ failedLastHour: FAILED_LAST_HOUR_LIMIT + 1 }))).toBe(1)
  })

  it('零收件人 / 零通道 ⇒ 直接红（配置错误，不给阈值）', () => {
    expect(healthVerdict(clean({ eventsNoRecipients: 1 }))).toBe(1)
    expect(healthVerdict(clean({ eventsNoChannel: 1 }))).toBe(1)
  })

  it('eventsInvalid 超阈值才红（模板轮换期可能短暂出现）', () => {
    expect(healthVerdict(clean({ eventsInvalid: 5 }))).toBe(0)
    expect(healthVerdict(clean({ eventsInvalid: 6 }))).toBe(1)
  })

  it('channelErrors / oldestPendingSeconds 单独不判红（作为诊断面）', () => {
    expect(healthVerdict(clean({ channelErrors: 3, oldestPendingSeconds: 120 }))).toBe(0)
  })
})

describePg('checkHealth', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query("delete from notify.worker_heartbeat where id='test-health'")
    await pool.end()
  })

  it('统计 dead / stale / 心跳 / 新指标', async () => {
    await pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,created_at)
       values ($1,'h-dead','m.a.b','r1','u1','wecom_default','u1','t1',1,'{}','dead',now()-interval '20 minutes'),
              ($1,'h-stale','m.a.b','r1','u2','wecom_default','u2','t1',1,'{}','pending',now()-interval '20 minutes'),
              ($1,'h-fail','m.a.b','r1','u3','wecom_default','u3','t1',1,'{}','failed',now())`,
      [ORG])
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,health,created_by)
       values ($1,'bad_ch','in_app',true,'{}','{}','error:HTTP 500','u')`, [ORG])
    await pool.query(
      `insert into notify.worker_heartbeat(id,beat_at) values ('test-health',now())
       on conflict (id) do update set beat_at=now()`)

    const r = await checkHealth(pool)
    expect(r.dead).toBeGreaterThanOrEqual(1)
    expect(r.stale).toBeGreaterThanOrEqual(1)
    expect(r.workers).toBeGreaterThanOrEqual(1)
    expect(r.oldestPendingSeconds).toBeGreaterThanOrEqual(1200)
    expect(r.failedLastHour).toBeGreaterThanOrEqual(1)
    expect(r.channelErrors).toBeGreaterThanOrEqual(1)

    // D2：可送达性计数（插一条 no_recipients 事件）
    await pool.query(
      `insert into notify.event(org,event_id,event_key,scope,payload,producer,status)
       values ($1,'h-norecip','m.a.b','*','{}','t','no_recipients')
       on conflict (org,event_id) do update set status='no_recipients'`, [ORG])
    const r2 = await checkHealth(pool)
    expect(r2.eventsNoRecipients).toBeGreaterThanOrEqual(1)
    expect(healthVerdict(r2)).toBe(1)
    await pool.query('delete from notify.event where org=$1', [ORG])
  })
})
