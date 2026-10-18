// pipeline.test.ts — 规则管道集成测试（DB + mock Novu）。计划 Task 6 Step 5。
// 覆盖 spec §11 负对照：①停用不通知 ②fail-open ③（校验在 routes.test）④幂等不双发 ⑤manual 覆盖 derived。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import { emit } from './pipeline'
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

const cfg = { baseUrl: 'https://novu.test', apiKey: 'k' }
const okFetch = () => vi.fn(async () => new Response('{}', { status: 201 }))

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
      { pool, novu: cfg },
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
      { pool, novu: cfg },
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
      { pool, novu: cfg },
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
      { pool, novu: cfg },
      { org: ORG, eventId: 'e3', eventType: 'case.reassigned', mount: 'ct1', payload: { assignee: 'u2' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 0, failed: 1 })
    const ds = await listDeliveries(pool, ORG)
    expect(ds.find((d) => d.eventId === 'e3')).toMatchObject({ status: 'failed' })
  })

  it('novu 为 null（缺 env）⇒ 记 failed 不抛', async () => {
    await upsertRule(pool, ORG, rule({ id: 'r4', eventType: 'form.assigned', mount: 'fd1', origin: 'manual', recipient: 'submitter' }), 'u')
    const res = await emit(
      { pool, novu: null },
      { org: ORG, eventId: 'e4', eventType: 'form.assigned', mount: 'fd1', payload: { submitter: 'u3' } },
    )
    expect(res).toMatchObject({ matched: 1, delivered: 0, failed: 1 })
  })

  it('负对照⑤：manual 覆盖 derived（derived 不重复生效）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await upsertRule(pool, ORG, rule({ id: 'd5', eventType: 'case.awaiting_approval', mount: 'ct5', origin: 'derived', templateId: 'case_awaiting_approval' }), 'system')
    await upsertRule(pool, ORG, rule({ id: 'm5', eventType: 'case.awaiting_approval', mount: 'ct5', origin: 'manual', templateId: 'case_awaiting_approval' }), 'u')
    const res = await emit(
      { pool, novu: cfg },
      { org: ORG, eventId: 'e5', eventType: 'case.awaiting_approval', mount: 'ct5', payload: { assignee: 'u7' } },
    )
    expect(res.matched).toBe(1)
    const ds = await listDeliveries(pool, ORG)
    expect(ds.filter((d) => d.eventId === 'e5').map((d) => d.ruleId)).toEqual(['m5'])
  })
})
