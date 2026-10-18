// routes.test.ts — 端点：校验 fail-closed / org 钉死 / emit 边界（DB）。计划 Task 6 Step 5。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import mod from './index'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const SUF = Math.random().toString(36).slice(2, 8)
const ORG_A = `org-notify-a-${SUF}`
const ORG_B = `org-notify-b-${SUF}`

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describePg('notify routes', () => {
  let pool: Pool
  let appA: Hono
  let appB: Hono

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    const scopes = ['notify:view', 'notify:manage', 'notify:emit']
    appA = buildTestApp(mod, makeIdentity({ orgId: ORG_A, scopes }), { pool })
    appB = buildTestApp(mod, makeIdentity({ orgId: ORG_B, scopes }), { pool })
  })
  afterAll(async () => {
    for (const org of [ORG_A, ORG_B]) {
      await pool.query('delete from notify.delivery where org=$1', [org])
      await pool.query('delete from notify.rule where org=$1', [org])
    }
    await pool.end()
  })
  beforeEach(() => vi.unstubAllGlobals())

  it('负对照③：解析器 × 挂载点错配 ⇒ 400（fail-closed）', async () => {
    const res = await appA.request(
      '/rules',
      json({ eventType: 'form.due_reminder', mount: 'fd1', templateId: 'form_due_reminder', recipient: 'assignee' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('RULE_RECIPIENT_MOUNT_MISMATCH')
  })

  it('POST /rules ⇒ 201；GET /rules 回本 org 的规则', async () => {
    const res = await appA.request(
      '/rules',
      json({ eventType: 'case.awaiting_approval', mount: 'ctA', templateId: 'case_awaiting_approval', recipient: 'assignee' }),
    )
    expect(res.status).toBe(201)
    const list = await (await appA.request('/rules')).json()
    expect(list.rules.map((r: { mount: string }) => r.mount)).toContain('ctA')
  })

  it('org 钉死：A 建的规则 B 看不到', async () => {
    const listB = await (await appB.request('/rules')).json()
    expect(listB.rules.map((r: { mount: string }) => r.mount)).not.toContain('ctA')
  })

  it('POST /emit 缺必填 ⇒ 400', async () => {
    const res = await appA.request('/emit', json({ eventType: 'case.awaiting_approval' }))
    expect(res.status).toBe(400)
  })

  it('POST /emit ⇒ 202（fail-open 边界：即便无规则也 202）', async () => {
    const res = await appA.request(
      '/emit',
      json({ eventId: 'evA', eventType: 'case.awaiting_approval', mount: 'ctA', payload: { assignee: 'u1' } }),
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ matched: 1 })
  })

  it('POST /derive 派生默认规则（origin=derived）', async () => {
    const res = await appA.request('/derive', json({ kind: 'approval', mount: 'ctD' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ eventType: 'case.awaiting_approval', origin: 'derived' })
    const list = await (await appA.request('/rules')).json()
    expect(list.rules.find((r: { mount: string }) => r.mount === 'ctD')).toMatchObject({ origin: 'derived' })
  })

  it('POST /derive 幂等：同声明重算不新增行（确定性 id）', async () => {
    await appA.request('/derive', json({ kind: 'approval', mount: 'ctD2' }))
    await appA.request('/derive', json({ kind: 'approval', mount: 'ctD2' }))
    const list = await (await appA.request('/rules')).json()
    expect(list.rules.filter((r: { mount: string }) => r.mount === 'ctD2')).toHaveLength(1)
  })

  it('POST /derive 表单催办 ⇒ form.due_reminder', async () => {
    const res = await appA.request('/derive', json({ kind: 'reminder', mount: 'fdD' }))
    expect((await res.json()).eventType).toBe('form.due_reminder')
  })

  it('POST /derive 缺 mount / kind 非法 ⇒ 400', async () => {
    expect((await appA.request('/derive', json({ kind: 'approval' }))).status).toBe(400)
    expect((await appA.request('/derive', json({ kind: 'nope', mount: 'x' }))).status).toBe(400)
  })

  it('GET /deliveries 回本 org 的回执', async () => {
    const res = await appA.request('/deliveries')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deliveries)).toBe(true)
  })
})
