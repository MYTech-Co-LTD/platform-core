// migrations.test.ts — 迁移幂等 + 租户列纪律（计划 Task 2 Step 3）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-mig005'

describePg('notify 迁移', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('重复执行不报错，记账不重复（幂等）', async () => {
    const q = "select count(*)::int as n from platform.schema_migrations where module = 'notify'"
    const before = (await pool.query(q)).rows[0].n as number
    expect(before).toBeGreaterThan(0)
    await applyMigrations(pool) // 第二遍：同批重跑
    const after = (await pool.query(q)).rows[0].n as number
    expect(after).toBe(before)
  })

  it('event.status 接受新增的可送达性终态，非法值仍被拒', async () => {
    await pool.query('delete from notify.event where org=$1', [ORG])
    for (const st of ['no_recipients', 'no_channel']) {
      await pool.query(
        `insert into notify.event(org,event_id,event_key,scope,payload,producer,status)
         values ($1,$2,'m.a.b','*','{}','t',$3)
         on conflict (org,event_id) do update set status = excluded.status`,
        [ORG, `st-${st}`, st])
    }
    const { rows } = await pool.query(
      "select status from notify.event where org=$1 and event_id like 'st-%' order by event_id", [ORG])
    expect(rows.map((r) => r.status)).toEqual(['no_channel', 'no_recipients'])
    await pool.query('delete from notify.event where org=$1', [ORG])

    await expect(pool.query(
      `insert into notify.event(org,event_id,event_key,scope,payload,producer,status)
       values ($1,'st-bad','m.a.b','*','{}','t','bogus')`, [ORG])).rejects.toThrow()
  })

  it('v2 表齐全且 org 列 NOT NULL', async () => {
    const r = await pool.query(
      `select table_name, is_nullable from information_schema.columns
        where table_schema = 'notify' and column_name = 'org' order by table_name`,
    )
    const names = r.rows.map((x) => x.table_name as string).sort()
    expect(names).toEqual([
      'audit', 'channel', 'channel_credential', 'channel_probe', 'delivery', 'delivery_attempt', 'event',
      'inbox', 'rule', 'template', 'template_revision',
    ])
    expect(r.rows.every((x) => x.is_nullable === 'NO')).toBe(true)

    // worker_heartbeat 是平台级（无 org），单独断言存在
    const hb = await pool.query("select to_regclass('notify.worker_heartbeat') as t")
    expect(hb.rows[0].t).not.toBeNull()
  })
})
