// health.test.ts — 健康判定（纯函数 + 真库查询）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { checkHealth, healthVerdict } from './health'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-health2'

describe('healthVerdict', () => {
  it('dead / stale / 无心跳 ⇒ 1；全清 ⇒ 0', () => {
    expect(healthVerdict({ dead: 0, stale: 0, workers: 1 })).toBe(0)
    expect(healthVerdict({ dead: 1, stale: 0, workers: 1 })).toBe(1)
    expect(healthVerdict({ dead: 0, stale: 1, workers: 1 })).toBe(1)
    expect(healthVerdict({ dead: 0, stale: 0, workers: 0 })).toBe(1)
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
    await pool.query("delete from notify.worker_heartbeat where id='test-health'")
    await pool.end()
  })

  it('统计 dead / stale / 心跳', async () => {
    await pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,created_at)
       values ($1,'h-dead','m.a.b','r1','u1','wecom_default','u1','t1',1,'{}','dead',now()-interval '20 minutes'),
              ($1,'h-stale','m.a.b','r1','u2','wecom_default','u2','t1',1,'{}','pending',now()-interval '20 minutes')`,
      [ORG])
    await pool.query(
      `insert into notify.worker_heartbeat(id,beat_at) values ('test-health',now())
       on conflict (id) do update set beat_at=now()`)

    const r = await checkHealth(pool)
    expect(r.dead).toBeGreaterThanOrEqual(1)
    expect(r.stale).toBeGreaterThanOrEqual(1)
    expect(r.workers).toBeGreaterThanOrEqual(1)
  })
})
