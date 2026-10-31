// delivery-stats.test.ts — 「谁收不到」的聚合与分类（plan 2026-10-31 Phase 2 / #1225）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { classifyDeliveryError, listAddressIssues } from './delivery-stats'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-dstats'

describe('classifyDeliveryError', () => {
  it('三类分得开：未解析 / 被渠道拒收 / 其它', () => {
    expect(classifyDeliveryError('missing_channel_address')).toBe('unresolved')
    expect(classifyDeliveryError('user & party & tag all invalid, hint: [x] ... e=81013')).toBe('rejected')
    expect(classifyDeliveryError('errcode 60111 user not found')).toBe('rejected')
    expect(classifyDeliveryError('channel not found/disabled')).toBe('other')
  })
})

describePg('listAddressIssues', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.delivery where org=$1', [ORG]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.delivery where org=$1', [ORG])
  })

  const insert = (eventId: string, recipient: string, status: string, err: string | null) =>
    pool.query(
      `insert into notify.delivery(org,event_id,event_key,rule_id,recipient,channel,address,
                                   template_key,revision,rendered,status,last_error)
       values ($1,$2,'e.k','r',$3,'wecom_default','','t',1,'{}'::jsonb,$4,$5)`,
      [ORG, eventId, recipient, status, err],
    )

  it('★ 只聚合 dead，并按收件人+错误分组；sent/pending 不进来', async () => {
    await insert('d1', 'LuZhengHui', 'dead', 'user invalid ... e=81013')
    await insert('d2', 'LuZhengHui', 'dead', 'user invalid ... e=81013')
    await insert('d3', 'noguy', 'dead', 'missing_channel_address')
    await insert('d4', 'okguy', 'sent', null)

    const issues = await listAddressIssues(pool, ORG)
    expect(issues).toHaveLength(2)
    const lu = issues.find((i) => i.recipient === 'LuZhengHui')!
    expect(lu).toMatchObject({ kind: 'rejected', count: 2 })
    expect(issues.find((i) => i.recipient === 'noguy')!.kind).toBe('unresolved')
  })

  it('窗口外的不算（updated_at 超过 hours 的丢弃）', async () => {
    await insert('d5', 'oldguy', 'dead', 'missing_channel_address')
    await pool.query("update notify.delivery set updated_at = now() - interval '48 hours' where org=$1", [ORG])
    expect(await listAddressIssues(pool, ORG, 24)).toHaveLength(0)
  })
})
