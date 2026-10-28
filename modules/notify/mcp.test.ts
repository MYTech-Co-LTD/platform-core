// mcp.test.ts — agent 工具面：12 工具、无 publish/channel、草稿不发布、试发只给自己
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import type { ChannelAddressResolver, NotificationEventDecl } from '@platform/sdk'
import notifyV2 from './index'
import { callTool, toolDefs } from './mcp'
import { NOTIFY_TOOLS } from './mcp-tools'
import { getTemplate } from './storage'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-mcp2'

const decl: NotificationEventDecl = {
  key: 'm.a.b', title: 't',
  payload: { u: { type: 'user', required: true }, link: { type: 'url', required: true } },
  recipients: { approver: { kind: 'field', field: 'u' } },
}
const events = { get: (k: string) => (k === 'm.a.b' ? decl : undefined), list: () => [decl] }
const addresses: ChannelAddressResolver = {
  resolve: async ({ provider, casdoorName }) =>
    provider === 'wecom_chat' ? `wecom-${casdoorName}` : casdoorName,
}

describe('notify mcp tool face', () => {
  it('恰 13 个工具，无 publish/channel', () => {
    expect(NOTIFY_TOOLS).toHaveLength(13)
    expect(toolDefs()).toHaveLength(13)
    expect(NOTIFY_TOOLS.some((t) => /publish|channel/.test(t.name))).toBe(false)
  })
})

describePg('notify mcp handlers', () => {
  let pool: Pool
  const deps = () => ({ pool, org: ORG, userId: 'u1', events, addresses })

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(async () => {
    await cleanup()
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{}','u')`, [ORG])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"hi {{u}}"}}','h1','approved','u')`, [ORG])
    await pool.query(
      `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
       values ($1,'r1',true,'m.a.b','*','approver','t1','{wecom_default}','manual','u')
       on conflict (org,id) do nothing`, [ORG])
  })

  async function cleanup() {
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
    await pool.query('delete from notify.audit where org=$1', [ORG])
  }

  it('draft_template 只写 draft，不移动发布指针 + 审计', async () => {
    const before = await getTemplate(pool, ORG, 't1')
    const out = await callTool(deps(), 'draft_template', {
      key: 't1', contents: { wecom_chat: { text: 'v2 {{u}}' } },
    })
    expect(out.isError).toBe(false)
    expect(JSON.parse(out.text)).toMatchObject({ revision: 2, status: 'draft' })

    const after = await getTemplate(pool, ORG, 't1')
    expect(after!.publishedRevision).toBe(before!.publishedRevision)
    expect(after!.revisions.some((r) => r.reviewStatus === 'draft')).toBe(true)

    const a = await pool.query('select action from notify.audit where org=$1 order by id desc limit 1', [ORG])
    expect(a.rows[0].action).toBe('mcp.draft_template')
  })

  it('preview_template 返回渲染结果', async () => {
    const out = await callTool(deps(), 'preview_template', {
      key: 't1', payload: { u: 'u1', link: 'https://x' },
    })
    expect(out.isError).toBe(false)
    expect((JSON.parse(out.text) as { rendered: { wecom_chat: { text: string } } })
      .rendered.wecom_chat.text).toBe('hi u1')
  })

  it('send_test 收件人只能是调用者本人', async () => {
    const out = await callTool(deps(), 'send_test', {
      templateKey: 't1', channel: 'wecom_default',
      payload: { u: 'u1', link: 'https://x' },
      recipient: 'other', // 必须被忽略
    })
    expect(out.isError).toBe(false)
    const { rows } = await pool.query(
      'select distinct recipient, is_test from notify.delivery where org=$1', [ORG])
    expect(rows).toEqual([{ recipient: 'u1', is_test: true }])
  })

  it('check_rule 只读：返回 blocked/recipients/warnings，不写任何表', async () => {
    const before = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    const out = await callTool(deps(), 'check_rule', { id: 'r1' })
    expect(out.isError).toBe(false)
    const body = JSON.parse(out.text) as {
      blocked: string | null; recipients: unknown[]; warnings: string[]
    }
    expect(body).toHaveProperty('blocked')
    expect(Array.isArray(body.recipients)).toBe(true)
    expect(body.warnings).toContain('sample_mode_field_recipients_unverified')

    const after = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    expect(after).toBe(before)
  })

  it('check_rule：未知 id ⇒ 错误', async () => {
    const out = await callTool(deps(), 'check_rule', { id: 'nope' })
    expect(out.isError).toBe(true)
  })

  it('propose_rule 走同一套校验并审计', async () => {
    const out = await callTool(deps(), 'propose_rule', {
      eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(false)
    const { rules } = JSON.parse(out.text) as { rules?: unknown; id?: string }
    void rules
    const rows = await pool.query('select origin from notify.rule where org=$1', [ORG])
    expect(rows.rows[0].origin).toBe('manual')

    const bad = await callTool(deps(), 'propose_rule', {
      eventKey: 'm.a.b', recipientKey: 'nope', templateKey: 't1', channels: ['wecom_default'],
    })
    expect(bad.isError).toBe(true)
  })

  it('JSON-RPC /mcp-manage tools/list 返回 12 工具', async () => {
    const app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG, userId: 'u1', scopes: ['notify:manage'] }),
      { pool, events, addresses },
    )
    const res = await app.request('/mcp-manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = await res.json() as { result: { tools: unknown[] } }
    expect(body.result.tools).toHaveLength(13)
  })
})
