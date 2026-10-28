// storage-v2.test.ts — 新存储层（rule_v2/delivery_v2 + 模板/通道/入队/收件箱）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import {
  audit, channelConfigured, claimDueDeliveries, countChannelSends, createTemplateRevision, deleteRule,
  enqueueEvent, getPublishedTemplate, getTemplate, isCoolingDown, listChannels,
  listRules, markDeliverySent, patchChannel, publishTemplateRevision, purgeOldNotifications,
  setChannelHealth, setRuleEnabled, upsertRule,
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
    await pool.query('delete from notify.audit where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
  }

  async function seedTemplate() {
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"v1"}}','h1','approved','u')`, [ORG])
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
    // ⚠️ claimDueDeliveries 是**全表**领取（无 org 过滤，worker 就该跨租户领）⇒
    // 别的测试文件留下的到期行也会被领到。这里只断言「本 org 的 past 被领、future 没被领」，
    // 并把自己的行过滤出来比较（跨文件污染不是本用例的断言对象）。
    await ins('past', '2020-01-01T00:00:00Z')
    await ins('future', '2999-01-01T00:00:00Z')

    const first = await claimDueDeliveries(pool, 50)
    const mine = first.filter((d) => d.org === ORG)
    expect(mine.map((d) => d.eventId)).toEqual(['past'])
    expect(mine[0]!.lockedUntil).not.toBeNull()

    const second = await claimDueDeliveries(pool, 50)
    expect(second.filter((d) => d.org === ORG)).toEqual([])
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

  it('草稿追加 revision；发布移动指针；旧版本可回滚', async () => {
    await seedTemplate()
    expect((await getTemplate(pool, ORG, 't1'))!.publishedRevision).toBe(1)

    const d1 = await createTemplateRevision(pool, ORG, 't1', { wecom_chat: { text: 'v2' } }, 'u')
    expect(d1.revision).toBe(2)
    await publishTemplateRevision(pool, ORG, 't1', 2, 'publisher')

    const t1 = await getTemplate(pool, ORG, 't1')
    expect(t1!.publishedRevision).toBe(2)
    expect(t1!.revisions.find((r) => r.revision === 2)!.reviewStatus).toBe('approved')

    await publishTemplateRevision(pool, ORG, 't1', 1, 'publisher')
    expect((await getTemplate(pool, ORG, 't1'))!.publishedRevision).toBe(1)
  })

  it('通道：list 只回 env 键名；patch 合并 config 并审计；health 写入', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{"address_fallback":"none"}',
               '{"bridge_url":"WECOM_BRIDGE_URL__X"}','u')`, [ORG])

    const list = await listChannels(pool, ORG)
    expect(list[0]).toMatchObject({ id: 'wecom_default', provider: 'wecom_chat', enabled: true })
    expect(list[0]!.secretRefs).toEqual({ bridge_url: 'WECOM_BRIDGE_URL__X' })
    expect(channelConfigured(list[0]!.secretRefs, {})).toBe(false)
    expect(channelConfigured(list[0]!.secretRefs, { WECOM_BRIDGE_URL__X: 'v' })).toBe(true)

    expect(await patchChannel(pool, ORG, 'wecom_default',
      { enabled: false, config: { rate_limit_per_min: 10 } }, 'u')).toBe(1)
    const after = (await listChannels(pool, ORG))[0]!
    expect(after.enabled).toBe(false)
    expect(after.config).toMatchObject({ address_fallback: 'none', rate_limit_per_min: 10 })

    await setChannelHealth(pool, ORG, 'wecom_default', 'ok')
    expect((await listChannels(pool, ORG))[0]!.health).toBe('ok')
    const a = await pool.query(
      'select action from notify.audit where org=$1 order by id desc limit 1', [ORG])
    expect(a.rows[0].action).toBe('channel.patch')
  })

  it('审计行落库', async () => {
    await audit(pool, ORG, 'u1', 'template.publish', 't1', { revision: 2 })
    const { rows } = await pool.query(
      'select action,target,detail from notify.audit where org=$1 order by id desc limit 1', [ORG])
    expect(rows[0]).toMatchObject({ action: 'template.publish', target: 't1', detail: { revision: 2 } })
  })

  it('purgeOldNotifications 只删过期行（delivery 只删终态）', async () => {
    // 前置清干净：本用例用固定 id，重复跑会撞 inbox_pkey
    await pool.query('delete from notify.inbox where org=$1', [ORG])
    await pool.query("delete from notify.delivery where org=$1 and event_id like 'pg-%'", [ORG])
    const insDelivery = (eventId: string, status: string, at: string) => pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,created_at)
       values ($1,$2,'m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}',$3,$4)`,
      [ORG, eventId, status, at])
    await insDelivery('pg-old-sent', 'sent', '2020-01-01T00:00:00Z')
    await insDelivery('pg-old-pending', 'pending', '2020-01-01T00:00:00Z')
    await insDelivery('pg-new-sent', 'sent', new Date().toISOString())

    await pool.query(
      `insert into notify.inbox(org,id,recipient,event_id,event_key,template_key,revision,title,body,created_at)
       values ($1,'pg-i-old','u1','e1','m.a.b','t1',1,'T','B','2020-01-01T00:00:00Z'),
              ($1,'pg-i-new','u1','e2','m.a.b','t1',1,'T','B',now())`, [ORG])

    const r = await purgeOldNotifications(pool, { inboxDays: 90, attemptDays: 180, deliveryDays: 365 })
    expect(r.inbox).toBe(1)
    expect(r.deliveries).toBe(1)

    const left = await pool.query(
      "select event_id from notify.delivery where org=$1 and event_id like 'pg-%' order by event_id", [ORG])
    expect(left.rows.map((x) => x.event_id)).toEqual(['pg-new-sent', 'pg-old-pending'])
  })

  it('countChannelSends 只数窗口内 sent', async () => {
    const ins = (eventId: string, status: string, at: string) => pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,created_at)
       values ($1,$2,'m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}',$3,$4)`,
      [ORG, eventId, status, at])

    await ins('rl-1', 'sent', '2026-01-01T00:00:00Z')
    await ins('rl-2', 'sent', '2026-01-01T00:00:00Z')
    await ins('rl-3', 'failed', '2026-01-01T00:00:00Z')
    await ins('rl-4', 'sent', '2020-01-01T00:00:00Z') // 远早于窗口

    expect(await countChannelSends(pool, ORG, 'wecom_default', 60)).toBe(0) // 夹具都在过去
    expect(await countChannelSends(pool, ORG, 'wecom_default', 60 * 60 * 24 * 365 * 10)).toBe(3)
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
