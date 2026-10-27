// storage-v2.test.ts — 新存储层（rule_v2/delivery_v2 + 模板/通道/入队/收件箱）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import {
  claimDueDeliveries, deleteRule, enqueueEvent, getPublishedTemplate, isCoolingDown,
  listRules, markDeliverySent, setRuleEnabled, upsertRule,
} from './storage'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-sv2'

describePg('notify storage v2', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(cleanup)

  async function cleanup() {
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.event where org=$1', [ORG])
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
  }

  it('enqueueEvent 幂等（同 org+event_id 第二次 duplicate）', async () => {
    const e = { org: ORG, eventId: 'e1', eventKey: 'm.a.b', scope: '*', payload: { u: 'u1' }, producer: 'm' }
    expect(await enqueueEvent(pool, e)).toEqual({ accepted: true })
    expect(await enqueueEvent(pool, e)).toEqual({ accepted: false, reason: 'duplicate' })
    const { rows } = await pool.query('select count(*)::int n from notify.event where org=$1', [ORG])
    expect(rows[0].n).toBe(1)
  })

  it('规则 upsert 保留 created_at；启停/删除', async () => {
    const rule = {
      id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      recipientLiteral: null, templateKey: 't1', channels: ['wecom_default'],
      cooldownMinutes: null, origin: 'manual' as const,
    }
    await upsertRule(pool, ORG, rule, 'u')
    const first = (await listRules(pool, ORG))[0]!
    await new Promise((r) => setTimeout(r, 10))
    await upsertRule(pool, ORG, { ...rule, templateKey: 't2' }, 'u')
    const after = (await listRules(pool, ORG))[0]!
    expect(after.templateKey).toBe('t2')
    expect(after.createdAt).toBe(first.createdAt)

    expect(await setRuleEnabled(pool, ORG, 'r1', false)).toBe(1)
    expect((await listRules(pool, ORG))[0]!.enabled).toBe(false)
    expect(await deleteRule(pool, ORG, 'r1')).toBe(1)
    expect(await listRules(pool, ORG)).toEqual([])
  })

  it('claimDueDeliveries 只领到期行并加租约', async () => {
    const ins = (eventId: string, at: string) => pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,next_attempt_at)
       values ($1,$2,'m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}','pending',$3)`,
      [ORG, eventId, at],
    )
    await ins('past', '2020-01-01T00:00:00Z')
    await ins('future', '2999-01-01T00:00:00Z')

    const first = await claimDueDeliveries(pool, 10)
    expect(first.map((d) => d.eventId)).toEqual(['past'])
    expect(first[0]!.lockedUntil).not.toBeNull()
    expect(await claimDueDeliveries(pool, 10)).toEqual([])
  })

  it('getPublishedTemplate 只认 published 指针', async () => {
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"hi"}}','h1','approved','u')`, [ORG])
    expect(await getPublishedTemplate(pool, ORG, 't1')).toEqual({
      revision: 1, contents: { wecom_chat: { text: 'hi' } },
    })

    await pool.query("update notify.template set status='draft' where org=$1 and key='t1'", [ORG])
    expect(await getPublishedTemplate(pool, ORG, 't1')).toBeNull()
  })

  it('冷却：窗口内有 sent 才抑制；无 cooldown 恒 false', async () => {
    await pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status)
       values ($1,'e-cool','m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}','sent')`, [ORG])
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: 10 }, 'u1', new Date())).toBe(true)
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: null }, 'u1', new Date())).toBe(false)
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: 10 }, 'u2', new Date())).toBe(false)
    // 清理 sent 行，避免影响其它用例
    await markDeliverySent(pool, { org: ORG, eventId: 'e-cool', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default' })
  })
})
