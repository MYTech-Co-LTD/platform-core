// mcp.test.ts — 管理面 MCP 工具面（DB）。计划 Task 7。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import mod from './index'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const SUF = Math.random().toString(36).slice(2, 8)
const ORG = `org-notify-mcp-${SUF}`

const rpc = (method: string, params?: Record<string, unknown>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})

describePg('notify /mcp-manage', () => {
  let pool: Pool
  let app: Hono

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    app = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['notify:view', 'notify:manage'] }), { pool })
  })
  afterAll(async () => {
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.end()
  })

  it('tools/list：有 list_rules / propose_rule，且**无任何模板/发布类工具**', async () => {
    const res = await app.request('/mcp-manage', rpc('tools/list'))
    const body = await res.json()
    const names = body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(['list_rules', 'propose_rule'])
    expect(names.some((n: string) => /template|publish|workflow/.test(n))).toBe(false)
  })

  it('propose_rule 建规则 ⇒ 落库（origin=manual）', async () => {
    const res = await app.request(
      '/mcp-manage',
      rpc('tools/call', {
        name: 'propose_rule',
        arguments: { eventType: 'case.awaiting_approval', mount: 'ctM', templateId: 'case_awaiting_approval', recipient: 'assignee' },
      }),
    )
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    const rules = await (await app.request('/rules')).json()
    expect(rules.rules.map((r: { mount: string }) => r.mount)).toContain('ctM')
  })

  it('propose_rule 校验 fail-closed：form 挂载 + assignee ⇒ isError', async () => {
    const res = await app.request(
      '/mcp-manage',
      rpc('tools/call', {
        name: 'propose_rule',
        arguments: { eventType: 'form.due_reminder', mount: 'fdX', templateId: 'form_due_reminder', recipient: 'assignee' },
      }),
    )
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('RULE_RECIPIENT_MOUNT_MISMATCH')
  })
})
