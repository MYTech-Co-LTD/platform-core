// in-app.test.ts — 收件箱写入幂等
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { sendInApp } from './in-app'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-inapp2'

describePg('sendInApp', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.inbox where org=$1', [ORG])
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.inbox where org=$1', [ORG])
  })

  it('写入 inbox；重复调用不新增', async () => {
    const args = {
      pool, org: ORG, recipient: 'u1', eventId: 'e1', eventKey: 'm.a.b',
      templateKey: 't1', revision: 1,
      rendered: { title: 'T', body: 'B', link: 'https://x' },
    }
    expect(await sendInApp(args)).toEqual({ ok: true })
    expect(await sendInApp(args)).toEqual({ ok: true })
    const { rows } = await pool.query('select count(*)::int n from notify.inbox where org=$1', [ORG])
    expect(rows[0].n).toBe(1)
  })
})
