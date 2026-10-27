// migrations.test.ts — 迁移幂等 + 租户列纪律（计划 Task 2 Step 3）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

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

  it('v2 表齐全且 org 列 NOT NULL', async () => {
    const r = await pool.query(
      `select table_name, is_nullable from information_schema.columns
        where table_schema = 'notify' and column_name = 'org' order by table_name`,
    )
    const names = r.rows.map((x) => x.table_name as string).sort()
    expect(names).toEqual([
      'audit', 'channel', 'delivery', 'delivery_attempt', 'event',
      'inbox', 'rule', 'template', 'template_revision',
    ])
    expect(r.rows.every((x) => x.is_nullable === 'NO')).toBe(true)

    // worker_heartbeat 是平台级（无 org），单独断言存在
    const hb = await pool.query("select to_regclass('notify.worker_heartbeat') as t")
    expect(hb.rows[0].t).not.toBeNull()
  })
})
