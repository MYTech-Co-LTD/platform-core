// storage-v2.test.ts — 新存储层（rule_v2/delivery_v2 + 模板/通道/入队/收件箱）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import type { NotificationEventDecl } from '@platform/sdk'
import { applyMigrations } from './test-util'
import {
  audit, channelConfigured, claimDueDeliveries, claimEvents, countChannelSends,
  createAgentNamespace, createTemplateRevision, deferDelivery, deleteRule,
  ensureAgentMessageDefaults, enqueueEvent, getAgentNamespace, getEventDecl,
  getPublishedTemplate, getTemplate, insertDelivery, isCoolingDown, listAgentNamespaces,
  listChannels, listDeliveries, listEventDecls, listRules, markDeliverySent, namespaceStats,
  patchChannel, publishTemplateRevision, purgeOldNotifications, setChannelHealth,
  setRuleEnabled, upsertEventDecl, upsertRule,
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
    await pool.query('delete from notify.approval where org=$1', [ORG])
    await pool.query('delete from notify.event_decl where org=$1', [ORG])
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.event where org=$1', [ORG])
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
    await pool.query('delete from notify.agent_namespace where org=$1', [ORG])
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
      recipientLiteral: null, recipientDepts: null, templateKey: 't1', channels: ['wecom_default'],
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

  it('租户发布 builtin 模板 ⇒ 模板 fork 成 origin=tenant', async () => {
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t-fork','T','m.a.b','published','builtin',1,'system')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t-fork',1,'{"wecom_chat":{"text":"builtin"}}','h1','approved','system')`, [ORG])

    const d = await createTemplateRevision(pool, ORG, 't-fork', { wecom_chat: { text: 'tenant' } }, 'u')
    expect((await getTemplate(pool, ORG, 't-fork'))!.origin).toBe('builtin') // 草稿不 fork
    await publishTemplateRevision(pool, ORG, 't-fork', d.revision, 'publisher')
    expect((await getTemplate(pool, ORG, 't-fork'))!.origin).toBe('tenant') // 发布即 fork
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

    // 终态 event 按 eventDays 删；`new` 永不因保留期被删（含延迟未到期）。
    await pool.query(
      `insert into notify.event(org,event_id,event_key,scope,payload,producer,status,created_at)
       values ($1,'pg-e-old','m.a.b','*','{}','t','matched','2020-01-01T00:00:00Z'),
              ($1,'pg-e-new','m.a.b','*','{}','t','new','2020-01-01T00:00:00Z'),
              ($1,'pg-e-now','m.a.b','*','{}','t','matched',now())`, [ORG])
    // audit 按 auditDays 删。
    await pool.query(
      `insert into notify.audit(org,actor,action,target,created_at)
       values ($1,'u','old','t','2020-01-01T00:00:00Z'), ($1,'u','new','t',now())`, [ORG])

    const r = await purgeOldNotifications(pool, {
      inboxDays: 90, attemptDays: 180, deliveryDays: 365, eventDays: 90, auditDays: 365,
    })
    expect(r.inbox).toBe(1)
    expect(r.deliveries).toBe(1)
    expect(r.events).toBe(1)
    expect(r.audit).toBe(1)

    const left = await pool.query(
      "select event_id from notify.delivery where org=$1 and event_id like 'pg-%' order by event_id", [ORG])
    expect(left.rows.map((x) => x.event_id)).toEqual(['pg-new-sent', 'pg-old-pending'])
    const events = await pool.query(
      "select event_id from notify.event where org=$1 and event_id like 'pg-e-%' order by event_id", [ORG])
    expect(events.rows.map((x) => x.event_id)).toEqual(['pg-e-new', 'pg-e-now'])
  })

  it('countChannelSends 只数窗口内 sent（按 sent_at，不按 created_at）', async () => {
    const ins = (eventId: string, status: string, at: string) => pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,created_at,sent_at)
       values ($1,$2,'m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}',$3,$4,
               case when $3='sent' then $4::timestamptz else null end)`,
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
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,sent_at)
       values ($1,'e-cool','m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}','sent',now())`, [ORG])
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: 10 }, 'u1', new Date())).toBe(true)
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: null }, 'u1', new Date())).toBe(false)
    expect(await isCoolingDown(pool, ORG, { id: 'r1', cooldownMinutes: 10 }, 'u2', new Date())).toBe(false)
    // 清理 sent 行，避免影响其它用例
    await markDeliverySent(pool, { org: ORG, eventId: 'e-cool', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default' })
  })

  it('agent namespace：创建幂等 + owner 保留', async () => {
    const a = await createAgentNamespace(pool, ORG, {
      namespace: 'agent_a', displayName: 'A', ownerUserId: 'u1',
    })
    expect(a.created).toBe(true)
    const b = await createAgentNamespace(pool, ORG, {
      namespace: 'agent_a', displayName: 'A2', ownerUserId: 'u2',
    })
    expect(b.created).toBe(false)
    expect(b.row.ownerUserId).toBe('u1')
    expect(await getAgentNamespace(pool, ORG, 'agent_a')).toMatchObject({
      namespace: 'agent_a', ownerUserId: 'u1',
    })
    expect((await listAgentNamespaces(pool, ORG)).map((x) => x.namespace)).toEqual(['agent_a'])
  })

  it('event_decl：v1 → 增量 v2；破坏性变更拒绝；get/list 只回 active', async () => {
    await createAgentNamespace(pool, ORG, {
      namespace: 'agent_a', displayName: 'A', ownerUserId: 'u1',
    })
    const decl: NotificationEventDecl = {
      key: 'ext.agent_a.daily',
      title: 'Daily',
      scope: { key: 'day' },
      payload: {
        user: { type: 'user', required: true },
        day: { type: 'string', required: true },
        n: { type: 'number' },
      },
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    expect(await upsertEventDecl(pool, ORG, 'agent_a', decl, 'u1'))
      .toEqual({ ok: true, created: true, version: 1 })

    const v2 = await upsertEventDecl(pool, ORG, 'agent_a', {
      ...decl, payload: { ...decl.payload, extra: { type: 'string' } },
    }, 'u1')
    expect(v2).toEqual({ ok: true, created: false, version: 2 })

    const bad = await upsertEventDecl(pool, ORG, 'agent_a', {
      ...decl,
      payload: { user: decl.payload.user!, day: decl.payload.day! },
    }, 'u1')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues).toContain('payload.n: removed')

    expect(await getEventDecl(pool, ORG, decl.key)).toMatchObject({
      key: decl.key, title: 'Daily',
    })
    expect((await listEventDecls(pool, ORG, 'agent_a')).map((e) => e.key)).toEqual([decl.key])
  })

  it('ensureAgentMessageDefaults：幂等 seed 声明/模板/规则', async () => {
    await createAgentNamespace(pool, ORG, {
      namespace: 'agent_a', displayName: 'A', ownerUserId: 'u1',
    })
    expect(await ensureAgentMessageDefaults(pool, ORG, 'agent_a', 'u1'))
      .toEqual({ decl: true, template: true, rule: true })
    expect(await ensureAgentMessageDefaults(pool, ORG, 'agent_a', 'u1'))
      .toEqual({ decl: false, template: false, rule: false })

    expect(await getEventDecl(pool, ORG, 'ext.agent_a.message')).toMatchObject({
      key: 'ext.agent_a.message',
    })
    expect(await getTemplate(pool, ORG, 'agent_generic_message__agent_a')).toMatchObject({
      ownerNamespace: 'agent_a', status: 'published',
    })
    const rule = (await listRules(pool, ORG)).find(
      (r) => r.id === 'derived:ext:agent_a.message:*')
    expect(rule).toMatchObject({
      ownerNamespace: 'agent_a', recipientKey: 'to', templateKey: 'agent_generic_message__agent_a',
    })
  })
})

// W6-P2：一次性延迟队列（notify.event.available_at）。夹具前缀 org-p2-。
describePg('notify storage 一次性延迟', () => {
  const ORG_P2 = 'org-p2-delay'
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
    await pool.query('delete from notify.event where org=$1', [ORG_P2])
  }

  it('★ 未来事件不被领取；到点后可领', async () => {
    const future = new Date(Date.now() + 3600_000)
    await enqueueEvent(pool, {
      org: ORG_P2, eventId: 'delay-1', eventKey: 'test.event', scope: '*',
      payload: {}, producer: 'test', availableAt: future,
    })
    // ⚠️ 本用例会租用全库事件（claimEvents 无 org 过滤，租约 60s）——只断言本 org 的行。
    //    现有其它用例都自清且不领事件，50 足够。
    expect((await claimEvents(pool, 50)).some((e) => e.org === ORG_P2 && e.eventId === 'delay-1')).toBe(false)

    // 缺省 availableAt = 立即
    await enqueueEvent(pool, {
      org: ORG_P2, eventId: 'delay-2', eventKey: 'test.event', scope: '*',
      payload: {}, producer: 'test',
    })
    expect((await claimEvents(pool, 50)).some((e) => e.org === ORG_P2 && e.eventId === 'delay-2')).toBe(true)

    await pool.query("update notify.event set available_at = now() - interval '1 second' where org=$1 and event_id='delay-1'", [ORG_P2])
    expect((await claimEvents(pool, 50)).some((e) => e.org === ORG_P2 && e.eventId === 'delay-1')).toBe(true)
  })
})

describePg('notify storage N0 可靠性（deferDelivery）', () => {
  const ORG_D = 'org-n0-defer'
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
    await pool.query('delete from notify.delivery where org=$1', [ORG_D])
  }

  it('deferDelivery 顺延但不消耗 attempts', async () => {
    await pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,attempts)
       values ($1,'e-defer','m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}','pending',2)`, [ORG_D])
    const at = new Date(Date.now() + 60_000)
    await deferDelivery(pool, {
      org: ORG_D, eventId: 'e-defer', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
    }, 'channel_rate_limited', at)
    const row = await pool.query(
      `select status, attempts, last_error, next_attempt_at
         from notify.delivery where org=$1 and event_id='e-defer'`, [ORG_D])
    expect(row.rows[0]).toMatchObject({
      status: 'failed', attempts: 2, last_error: 'channel_rate_limited',
    })
    expect(new Date(row.rows[0].next_attempt_at).getTime()).toBe(at.getTime())
  })
})

// N5：per-namespace 归属冻结 + 指标 + claim 公平性（真库）。夹具前缀 org-n5。
describePg('notify N5 运营收口', () => {
  const ORG_A = 'org-n5-a'
  const ORG_B = 'org-n5-b'
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
    await pool.query("delete from notify.delivery where org in ($1,$2)", [ORG_A, ORG_B])
    await pool.query("delete from notify.event where org in ($1,$2)", [ORG_A, ORG_B])
  }

  const delivery = (org: string, eventId: string, ownerNamespace: string | null) => ({
    org, eventId, eventKey: ownerNamespace ? `ext.${ownerNamespace}.daily` : 'm.a.b',
    ruleId: 'r1', recipient: 'u1', channel: 'inapp_default', address: 'u1',
    templateKey: 't1', revision: 1, rendered: {}, status: 'pending' as const, ownerNamespace,
  })

  it('投递冻结 owner_namespace；listDeliveries 可按 namespace 过滤', async () => {
    await insertDelivery(pool, delivery(ORG_A, 'e-agent', 'agent_a'))
    await insertDelivery(pool, delivery(ORG_A, 'e-platform', null))

    const all = await listDeliveries(pool, ORG_A)
    expect(all.map((d) => [d.eventId, d.ownerNamespace]).sort()).toEqual([
      ['e-agent', 'agent_a'], ['e-platform', null],
    ])
    const only = await listDeliveries(pool, ORG_A, 100, { namespace: 'agent_a' })
    expect(only.map((d) => d.eventId)).toEqual(['e-agent'])
  })

  it('namespaceStats：事件按 ext.<ns> 推导，投递按冻结列聚合', async () => {
    await enqueueEvent(pool, {
      org: ORG_A, eventId: 'ev-a', eventKey: 'ext.agent_a.daily', scope: '*',
      payload: {}, producer: 'ext:agent_a',
    })
    await enqueueEvent(pool, {
      org: ORG_A, eventId: 'ev-p', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 't',
    })
    await insertDelivery(pool, delivery(ORG_A, 'd1', 'agent_a'))
    await insertDelivery(pool, { ...delivery(ORG_A, 'd2', 'agent_a'), status: 'dead' })
    await insertDelivery(pool, delivery(ORG_A, 'd3', null))
    await pool.query(
      "update notify.delivery set status='sent' where org=$1 and event_id in ('d1','d3')", [ORG_A])

    const stats = await namespaceStats(pool, ORG_A, { sinceHours: 24 })
    const byNs = new Map(stats.map((s) => [s.namespace, s]))
    expect(byNs.get('agent_a')).toMatchObject({
      events: 1, deliveries: 2, sent: 1, dead: 1, stalePending: 0,
    })
    expect(byNs.get(null)).toMatchObject({ events: 1, deliveries: 1, sent: 1 })
  })

  it('claimEvents：按 org 交错，单租户积压不占满整批', async () => {
    for (const [org, n] of [[ORG_A, 2], [ORG_B, 2]] as const) {
      for (let i = 0; i < n; i++) {
        await enqueueEvent(pool, {
          org, eventId: `fair-${i}`, eventKey: 'm.a.b', scope: '*', payload: {}, producer: 't',
        })
      }
    }
    // A 的两条都比 B 老：朴素 order by created_at 会连拿 A0,A1；公平领取应先各拿一条。
    await pool.query(
      "update notify.event set created_at=case org when $1 then now()-interval '4 minutes' else now()-interval '2 minutes' end where org in ($1,$2) and event_id='fair-0'",
      [ORG_A, ORG_B])
    await pool.query(
      "update notify.event set created_at=case org when $1 then now()-interval '3 minutes' else now()-interval '1 minute' end where org in ($1,$2) and event_id='fair-1'",
      [ORG_A, ORG_B])
    const claimed = (await claimEvents(pool, 2))
      .filter((e) => e.org === ORG_A || e.org === ORG_B)
      .map((e) => `${e.org}:${e.eventId}`)
      .sort()
    expect(claimed).toEqual([`${ORG_A}:fair-0`, `${ORG_B}:fair-0`].sort())
  })

  it('claimDueDeliveries：同样按 org 交错', async () => {
    for (const [org, n] of [[ORG_A, 2], [ORG_B, 2]] as const) {
      for (let i = 0; i < n; i++) {
        await insertDelivery(pool, { ...delivery(org, `due-${i}`, null), status: 'pending' })
      }
    }
    // A 的两条都更早到期：朴素 order by next_attempt_at 会连拿 A0,A1；公平领取应各拿一条。
    await pool.query(
      "update notify.delivery set next_attempt_at=case org when $1 then now()-interval '4 minutes' else now()-interval '2 minutes' end where org in ($1,$2) and event_id='due-0'",
      [ORG_A, ORG_B])
    await pool.query(
      "update notify.delivery set next_attempt_at=case org when $1 then now()-interval '3 minutes' else now()-interval '1 minute' end where org in ($1,$2) and event_id='due-1'",
      [ORG_A, ORG_B])
    const rows = (await claimDueDeliveries(pool, 2))
      .filter((d) => d.org === ORG_A || d.org === ORG_B)
      .map((d) => `${d.org}:${d.eventId}`)
      .sort()
    expect(rows).toEqual([`${ORG_A}:due-0`, `${ORG_B}:due-0`].sort())
  })
})
