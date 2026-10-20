// pipeline.test.ts — 规则管道集成测试（DB + mock Novu）。计划 Task 6 Step 5。
// 覆盖 spec §11 负对照：①停用不通知 ②fail-open ③（校验在 routes.test）④幂等不双发 ⑤manual 覆盖 derived。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import { emit } from './pipeline'
import {
  novuChatWebhookEnvKeyForOrg,
  novuEnvKeyForOrg,
  novuFromEnv,
  type NovuResolver,
} from './domain/novu'
import { upsertRule, listDeliveries } from './storage'
import { applyMigrations } from './test-util'
import type { NotificationRule } from './domain/rules'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const SUF = Math.random().toString(36).slice(2, 8)
const ORG = `org-notify-${SUF}`

function rule(
  p: Partial<NotificationRule> & Pick<NotificationRule, 'id' | 'eventType' | 'mount' | 'origin'>,
): NotificationRule {
  return {
    org: ORG,
    enabled: true,
    templateId: 'case_awaiting_approval',
    recipient: 'assignee',
    recipientArg: null,
    channels: ['wechat_work', 'in_app'],
    cooldownMinutes: null,
    createdAt: '2026-10-18T00:00:00Z',
    ...p,
  }
}

const cfg = { baseUrl: 'https://novu.test', apiKey: 'k', chatWebhookUrl: null }
const okFetch = () => vi.fn(async () => new Response('{}', { status: 201 }))
const authOf = (fetchMock: ReturnType<typeof okFetch>) =>
  (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
/** 走真 env 解析的 resolver（ADR 0008 ② 的 per-org 键端到端）。 */
const novuFrom = (extra: Record<string, string>): NovuResolver => (org) =>
  novuFromEnv(
    { NOVU_BASE_URL: 'https://novu.test', NOVU_API_KEY: 'k', ...extra } as NodeJS.ProcessEnv,
    org,
  )
/** 调用序列：[url, method]。 */
const seqOf = (fetchMock: ReturnType<typeof okFetch>): [string, string][] =>
  (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
    (c): [string, string] => [String(c[0]), String(c[1].method)],
  )

describePg('pipeline.emit', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.end()
  })
  beforeEach(() => vi.unstubAllGlobals())

  it('命中规则 → 投递 → 落回执（sent）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'r1', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: () => cfg },
      { org: ORG, eventId: 'e1', eventType: 'case.awaiting_approval', mount: 'ct1', payload: { assignee: 'u9' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const ds = await listDeliveries(pool, ORG)
    expect(ds.find((d) => d.eventId === 'e1')).toMatchObject({ ruleId: 'r1', recipient: 'u9', status: 'sent' })
  })

  it('负对照④：重复 emit 不双发（幂等去重）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const res = await emit(
      { pool, novu: () => cfg },
      { org: ORG, eventId: 'e1', eventType: 'case.awaiting_approval', mount: 'ct1', payload: { assignee: 'u9' } },
    )
    expect(res.delivered).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('负对照①：停用规则后不通知', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'r2', eventType: 'case.status_changed', mount: 'ct1', origin: 'manual', enabled: false }), 'u')
    const res = await emit(
      { pool, novu: () => cfg },
      { org: ORG, eventId: 'e2', eventType: 'case.status_changed', mount: 'ct1', payload: { submitter: 'u1' } },
    )
    expect(res).toMatchObject({ matched: 0, delivered: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('负对照②：Novu 网络异常 ⇒ fail-open（不抛），回执记 failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await upsertRule(pool, ORG, rule({ id: 'r3', eventType: 'case.reassigned', mount: 'ct1', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: () => cfg },
      { org: ORG, eventId: 'e3', eventType: 'case.reassigned', mount: 'ct1', payload: { assignee: 'u2' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 0, failed: 1 })
    const ds = await listDeliveries(pool, ORG)
    expect(ds.find((d) => d.eventId === 'e3')).toMatchObject({ status: 'failed' })
  })

  it('§2.6 ③：per-org 与全局都无 ⇒ 不抛，回执 failed / novu not configured', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const novu: NovuResolver = (org) =>
      novuFromEnv({ NOVU_BASE_URL: 'https://novu.test' } as NodeJS.ProcessEnv, org)
    await upsertRule(pool, ORG, rule({ id: 'r4', eventType: 'form.assigned', mount: 'fd1', origin: 'manual', recipient: 'submitter' }), 'u')
    const res = await emit(
      { pool, novu },
      { org: ORG, eventId: 'e4', eventType: 'form.assigned', mount: 'fd1', payload: { submitter: 'u3' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 0, failed: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    const ds = await listDeliveries(pool, ORG)
    expect(ds.find((d) => d.eventId === 'e4')).toMatchObject({ status: 'failed', error: 'novu not configured' })
  })

  it('§2.6 ①：按 input.org 取 per-org key（NOVU_API_KEY__<ORG> 优先）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const novu: NovuResolver = (org) =>
      novuFromEnv(
        {
          NOVU_BASE_URL: 'https://novu.test',
          NOVU_API_KEY: 'global-key',
          [novuEnvKeyForOrg(ORG)]: 'org-key',
        } as NodeJS.ProcessEnv,
        org,
      )
    await upsertRule(pool, ORG, rule({ id: 'r6', eventType: 'case.status_changed', mount: 'ct6', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu },
      { org: ORG, eventId: 'e6', eventType: 'case.status_changed', mount: 'ct6', payload: { assignee: 'u6' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(authOf(fetchMock).Authorization).toBe('ApiKey org-key')
  })

  it('§2.6 ②：无 per-org key ⇒ 回落全局 NOVU_API_KEY', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const novu: NovuResolver = (org) =>
      novuFromEnv({ NOVU_BASE_URL: 'https://novu.test', NOVU_API_KEY: 'global-key' } as NodeJS.ProcessEnv, org)
    await upsertRule(pool, ORG, rule({ id: 'r7', eventType: 'sla.breach_warning', mount: 'ct7', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu },
      { org: ORG, eventId: 'e7', eventType: 'sla.breach_warning', mount: 'ct7', payload: { assignee: 'u7' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(authOf(fetchMock).Authorization).toBe('ApiKey global-key')
  })

  it('解析落点收 input.org（不是固定配置）', async () => {
    vi.stubGlobal('fetch', okFetch())
    const resolve = vi.fn((_org: string) => cfg)
    await upsertRule(pool, ORG, rule({ id: 'r8', eventType: 'case.reassigned', mount: 'ct8', origin: 'manual' }), 'u')
    await emit(
      { pool, novu: resolve },
      { org: ORG, eventId: 'e8', eventType: 'case.reassigned', mount: 'ct8', payload: { assignee: 'u8' } },
    )
    expect(resolve).toHaveBeenCalledWith(ORG)
  })

  it('§2.6 ④：org 为空（无 org 记录）⇒ 不炸，跳过 per-org 查找走全局回落', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const resolve = vi.fn((org: string) =>
      novuFromEnv(
        { NOVU_BASE_URL: 'https://novu.test', NOVU_API_KEY: 'global-key', NOVU_API_KEY__MYTECH: 'org-key' } as NodeJS.ProcessEnv,
        org,
      ),
    )
    const res = await emit(
      { pool, novu: resolve },
      { org: '', eventId: 'e9', eventType: 'case.reassigned', mount: 'ct9', payload: { assignee: 'u9' } },
    )
    expect(resolve).toHaveBeenCalledWith('')
    expect(resolve.mock.results[0]?.value).toEqual({
      baseUrl: 'https://novu.test',
      apiKey: 'global-key',
      chatWebhookUrl: null,
    })
    expect(res).toMatchObject({ matched: 0, delivered: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('负对照⑤：manual 覆盖 derived（derived 不重复生效）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'd5', eventType: 'case.awaiting_approval', mount: 'ct5', origin: 'derived', templateId: 'case_awaiting_approval' }), 'system')
    await upsertRule(pool, ORG, rule({ id: 'm5', eventType: 'case.awaiting_approval', mount: 'ct5', origin: 'manual', templateId: 'case_awaiting_approval' }), 'u')
    const res = await emit(
      { pool, novu: () => cfg },
      { org: ORG, eventId: 'e5', eventType: 'case.awaiting_approval', mount: 'ct5', payload: { assignee: 'u7' } },
    )
    expect(res.matched).toBe(1)
    const ds = await listDeliveries(pool, ORG)
    expect(ds.filter((d) => d.eventId === 'e5').map((d) => d.ruleId)).toEqual(['m5'])
  })

  // ── ADR 0008 ②（2026-10-20 人审）：trigger 前给订阅者挂 chat 渠道 ──────────────────
  // 闸门实测：chat 送达看 `subscriber.channels[]`；不挂 ⇒ chat 作业恒 canceled（集成在场也一样）。
  const HOOK = 'https://push.hookflow.cn/wecom/woke?t=tok'

  it('ADR 0008 ②①：本 org 配了 bridge URL ⇒ 先挂渠道（POST subscribers → PUT credentials）再 trigger', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'rc1', eventType: 'case.awaiting_approval', mount: 'ctc1', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: novuFrom({ [novuChatWebhookEnvKeyForOrg(ORG)]: HOOK }) },
      { org: ORG, eventId: 'ec1', eventType: 'case.awaiting_approval', mount: 'ctc1', payload: { assignee: 'uc1' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(seqOf(fetchMock)).toEqual([
      ['https://novu.test/v1/subscribers', 'POST'],
      ['https://novu.test/v1/subscribers/uc1/credentials', 'PUT'],
      ['https://novu.test/v1/events/trigger', 'POST'],
    ])
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      providerId: 'chat-webhook',
      credentials: { webhookUrl: `${HOOK}&to=uc1` },
    })
  })

  it('ADR 0008 ②②：本 org 无该键 ⇒ 不调 ensure，但照常 trigger（不阻断）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'rc2', eventType: 'case.status_changed', mount: 'ctc2', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: novuFrom({}) },
      { org: ORG, eventId: 'ec2', eventType: 'case.status_changed', mount: 'ctc2', payload: { assignee: 'uc2' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(seqOf(fetchMock)).toEqual([['https://novu.test/v1/events/trigger', 'POST']])
  })

  it('ADR 0008 ②③：同一 subscriber 第二次 emit ⇒ 不重复挂渠道（进程内缓存）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'rc3', eventType: 'case.reassigned', mount: 'ctc3', origin: 'manual' }), 'u')
    const deps = { pool, novu: novuFrom({ [novuChatWebhookEnvKeyForOrg(ORG)]: HOOK }) }
    for (const eventId of ['ec3a', 'ec3b']) {
      await emit(deps, { org: ORG, eventId, eventType: 'case.reassigned', mount: 'ctc3', payload: { assignee: 'uc3' } })
    }
    const calls = seqOf(fetchMock)
    expect(calls.filter((c) => c[1] === 'PUT')).toHaveLength(1)
    expect(calls.filter((c) => c[0].endsWith('/v1/events/trigger'))).toHaveLength(2)
  })

  it('ADR 0008 ②④：ensure 非 2xx ⇒ 不阻断 trigger，回执仍 sent', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/subscribers') ? new Response('nope', { status: 500 }) : new Response('{}', { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'rc4', eventType: 'sla.breach_warning', mount: 'ctc4', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: novuFrom({ [novuChatWebhookEnvKeyForOrg(ORG)]: HOOK }) },
      { org: ORG, eventId: 'ec4', eventType: 'sla.breach_warning', mount: 'ctc4', payload: { assignee: 'uc4' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(seqOf(fetchMock)).toEqual([
      ['https://novu.test/v1/subscribers', 'POST'],
      ['https://novu.test/v1/events/trigger', 'POST'],
    ])
    const ds = await listDeliveries(pool, ORG)
    expect(ds.find((d) => d.eventId === 'ec4')).toMatchObject({ status: 'sent' })
  })

  it('ADR 0008 ②④：ensure 抛网络异常 ⇒ 不阻断 trigger', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/subscribers')) throw new Error('ECONNREFUSED')
      return new Response('{}', { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'rc5', eventType: 'form.assigned', mount: 'ctc5', origin: 'manual' }), 'u')
    const res = await emit(
      { pool, novu: novuFrom({ [novuChatWebhookEnvKeyForOrg(ORG)]: HOOK }) },
      { org: ORG, eventId: 'ec5', eventType: 'form.assigned', mount: 'ctc5', payload: { assignee: 'uc5' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 1, failed: 0 })
    expect(seqOf(fetchMock)).toEqual([
      ['https://novu.test/v1/subscribers', 'POST'],
      ['https://novu.test/v1/events/trigger', 'POST'],
    ])
  })
})
