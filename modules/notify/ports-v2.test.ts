// ports-v2.test.ts — notify 供给宿主的 enqueueEvent 端口
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { createPortsV2 } from './ports-v2'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-ports2'

describePg('ports v2', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.event where org=$1', [ORG])
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.event where org=$1', [ORG])
  })

  it('enqueueEvent 直达 storage 且幂等', async () => {
    const p = createPortsV2({ pool })
    const input = {
      org: ORG, eventId: 'p1', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 'm',
    }
    expect(await p.enqueueEvent(input)).toEqual({ accepted: true })
    expect(await p.enqueueEvent(input)).toEqual({ accepted: false, reason: 'duplicate' })
  })
})
