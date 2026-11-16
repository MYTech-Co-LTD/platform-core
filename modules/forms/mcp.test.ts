import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { callTool, toolDefs } from './mcp'
import { FORMS_TOOLS } from './mcp-tools'

// MCP 面（#724 → 2026-11-16 能力网关 Task 8）：两个**纯函数**入口（toolDefs / callTool）——
// 协议壳的编解码另有 routes.test 的端到端用例覆盖。这里钉：
// **工具集不得出现发布类能力**（AI 永不发布，§14.1）、读/管理两个 face 的工具投影、
// 工具级 scope（forms:manage）、以及每次调用落 forms.mcp_audit（审计失败不改变业务结果）。

/** 审计落点的默认替身（这些用例只测工具面判定，不关心审计 SQL）。 */
const auditSink = () => ({ query: async () => ({ rows: [] }) }) as unknown as Pool

const deps = (over: Partial<Parameters<typeof callTool>[0]> = {}) => ({
  pool: auditSink(),
  org: 'org-a',
  userId: 'u1',
  chatModel: null,
  hasScope: (code: string) => code === 'forms:manage',
  ...over,
})

/** 只接受预期 SQL 的假池（形状照 storage.ts 的真实查询；多余查询直接炸，防测试漂移）。 */
function fakePool(handler: (text: string, params: unknown[]) => { rows: unknown[] }) {
  return { query: async (text: string, params: unknown[] = []) => handler(text, params) } as unknown as Pool
}

/** 只接审计插入的假池（拒绝/抛错路径不会触达业务查询）+ 捕获到的审计参数行。 */
function auditPool() {
  const rows: unknown[][] = []
  const pool = fakePool((text, params) => {
    if (/insert into forms\.mcp_audit/.test(text)) { rows.push(params); return { rows: [] } }
    throw new Error(`unexpected query: ${text}`)
  })
  return { pool, rows }
}

describe('MCP 工具面投影（read / manage）', () => {
  it('★ 不暴露任何发布/回滚/退役类工具（AI 永不发布）', () => {
    const names = toolDefs('manage').map((t) => t.name)
    expect(names).toEqual(['list_forms', 'search_standard_approvals', 'generate_form_draft'])
    for (const n of names) expect(n).not.toMatch(/publish|rollback|retire|delete|remove/)
  })

  it('/mcp 回读面两工具；/mcp-manage 三工具', () => {
    expect(toolDefs('read').map((t) => t.name)).toEqual(['list_forms', 'search_standard_approvals'])
    expect(toolDefs('manage').map((t) => t.name))
      .toEqual(['list_forms', 'search_standard_approvals', 'generate_form_draft'])
  })

  it('每个工具都有 name/description/inputSchema（协议必需）', () => {
    for (const t of toolDefs('manage')) {
      expect(t.name).toBeTruthy()
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('tools/list 带 annotations.readOnlyHint（与 mutating 互补；能力网关索引依赖它）', () => {
    for (const d of toolDefs('manage')) {
      expect(d.annotations.readOnlyHint, d.name)
        .toBe(!FORMS_TOOLS.find((t) => t.name === d.name)?.mutating)
    }
    expect(toolDefs('read').map((d) => d.annotations.readOnlyHint)).toEqual([true, true])
    expect(toolDefs('manage').find((d) => d.name === 'generate_form_draft')?.annotations.readOnlyHint)
      .toBe(false)
  })

  it('★ read face 只读不变量：所有 forms:view 工具都 readOnly，读面永不出现 mutating', () => {
    const viewTools = FORMS_TOOLS.filter((t) => t.faceScope === 'forms:view')
    expect(viewTools.length).toBeGreaterThan(0)
    for (const t of viewTools) {
      expect(t.mutating, t.name).toBe(false)
      expect(t.annotations.readOnlyHint, t.name).toBe(true)
    }
    expect(toolDefs('read').map((t) => t.name)).toEqual(viewTools.map((t) => t.name))
  })

  it('read face 拒绝写工具（工具级错误）+ 审计 denied', async () => {
    const { pool, rows } = auditPool()
    const r = await callTool(deps({ pool }), 'read', 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('read_only_tool_not_allowed')
    expect(rows).toHaveLength(1)
    expect(rows[0][2]).toBe('generate_form_draft')
    expect(rows[0][3]).toBe('denied')
    expect(rows[0][4]).toBe('read_only_tool_not_allowed')
  })

  it('未知工具 → 工具级错误（isError=true，不是抛出）', async () => {
    const r = await callTool(deps(), 'manage', 'publish_form', {})
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('unknown_tool')
  })

  it('generate_form_draft 缺 forms:manage → missing_scope（工具级 scope 执法）+ 审计 denied', async () => {
    const { pool, rows } = auditPool()
    const r = await callTool(deps({ pool, hasScope: () => false }), 'manage', 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    const out = JSON.parse(r.text) as { reason: string; scope: string }
    expect(out.reason).toBe('missing_scope')
    expect(out.scope).toBe('forms:manage')
    expect(rows).toHaveLength(1)
    expect(rows[0][3]).toBe('denied')
    expect(rows[0][4]).toBe('missing_scope')
    // args 摘要照样留痕（拒绝也要能复核调用者传了什么）
    expect(JSON.parse(rows[0][5] as string)).toEqual({ description: '门店巡检' })
  })
})

describe('forms:view 读面（摘要，不含 draft body）', () => {
  it('list_forms 只回摘要字段（无 body），并落一条 ok 审计', async () => {
    const audits: unknown[][] = []
    const pool = fakePool((text, params) => {
      if (/from forms\.asset_version v/.test(text)) {
        return { rows: [{ asset_id: 'a1', head_version: null, draft_count: 1, published_count: 0, retired_count: 0, updated_at: new Date() }] }
      }
      if (/insert into forms\.mcp_audit/.test(text)) { audits.push(params); return { rows: [] } }
      throw new Error(`unexpected query: ${text}`)
    })
    const r = await callTool(deps({ pool }), 'read', 'list_forms', {})
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.text) as { forms: Record<string, unknown>[] }
    expect(out.forms[0]).toMatchObject({ assetId: 'a1', draftCount: 1 })
    expect(out.forms[0]).not.toHaveProperty('body')

    expect(audits).toHaveLength(1)
    expect(audits[0][2]).toBe('list_forms')
    expect(audits[0][3]).toBe('ok')
    // args 摘要（spec §6.5）：无参工具落空对象
    expect(JSON.parse(audits[0][5] as string)).toEqual({})
  })

  it('★ 工具执行抛错 → tool_exception（工具级错误，不 500）+ 审计 outcome=error', async () => {
    const audits: unknown[][] = []
    const pool = fakePool((text, params) => {
      if (/from forms\.asset_version v/.test(text)) throw new Error('db down')
      if (/insert into forms\.mcp_audit/.test(text)) { audits.push(params); return { rows: [] } }
      throw new Error(`unexpected query: ${text}`)
    })
    const r = await callTool(deps({ pool }), 'read', 'list_forms', {})
    expect(r.isError).toBe(true)
    const out = JSON.parse(r.text) as { reason: string; detail: string }
    expect(out.reason).toBe('tool_exception')
    expect(out.detail).toContain('db down')

    expect(audits).toHaveLength(1)
    expect(audits[0][2]).toBe('list_forms')
    expect(audits[0][3]).toBe('error')
    expect(audits[0][4]).toBe('tool_exception')
    expect(JSON.parse(audits[0][5] as string)).toEqual({})
  })
})

describe('search_standard_approvals（OA P2 Task 7：agent 选模板）', () => {
  it('★ 只回已发布绑定的 name/deepLink/description——不含标准表单字段，不预填', async () => {
    const audits: unknown[][] = []
    const sqls: Array<{ text: string; params: unknown[] }> = []
    const pool = fakePool((text, params) => {
      sqls.push({ text, params })
      if (/v\.body->>'provider' = 'wecom_native'/.test(text)) {
        return {
          rows: [
            // 正常绑定
            {
              asset_id: 'expense-bind', version: 2, name: '差旅报销',
              process_code: 'PC-EXPENSE-001', deep_link: 'https://open.work.weixin.qq.com/oa/approval?x=1',
            },
            // 脏行（深链不是 https）：不许把脏深链递给 agent
            { asset_id: 'dirty-bind', version: 1, name: '坏绑定', process_code: 'PC-BAD', deep_link: 'http://plain' },
          ],
        }
      }
      if (/insert into forms\.mcp_audit/.test(text)) { audits.push(params); return { rows: [] } }
      throw new Error(`unexpected query: ${text}`)
    })

    const r = await callTool(deps({ pool }), 'read', 'search_standard_approvals', { query: ' 报销 ' })
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.text) as { approvals: Record<string, unknown>[] }
    expect(out.approvals).toHaveLength(1)
    // 三个字段是全部输出：没有 schema / fields / payload 等标准表单字段（平台不持有）
    expect(Object.keys(out.approvals[0]).sort()).toEqual(['deepLink', 'description', 'name'])
    expect(out.approvals[0]).toMatchObject({
      name: '差旅报销',
      deepLink: 'https://open.work.weixin.qq.com/oa/approval?x=1',
    })
    expect(String(out.approvals[0].description)).toContain('PC-EXPENSE-001')

    // 只查已发布且当前 head 的绑定（草稿/退役绑定的深链不能流给 agent）
    const q = sqls.find((s) => /wecom_native/.test(s.text))!
    expect(q.text).toContain("v.status = 'published'")
    expect(q.text).toContain('h.active_version = v.version')
    // 搜索词只在参数里（空白已 trim），pattern 不外插
    expect(q.params[0]).toBe('org-a')
    expect(q.params[1]).toBe('approval_def')
    expect(q.params[2]).toBe('报销')

    // 审计照落（ok），args 原样留痕
    expect(audits).toHaveLength(1)
    expect(audits[0][2]).toBe('search_standard_approvals')
    expect(audits[0][3]).toBe('ok')
    expect(JSON.parse(audits[0][5] as string)).toEqual({ query: ' 报销 ' })
  })

  it('搜索词超长 → query_too_long（有界读，不把巨型模式串打到 DB）', async () => {
    const r = await callTool(deps(), 'read', 'search_standard_approvals', { query: 'x'.repeat(101) })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text)).toMatchObject({ reason: 'query_too_long', limit: 100 })
  })

  it('空 query = 列前 N 个（不传模式）；未命中也回空数组而不是错误', async () => {
    const pool = fakePool((text, params) => {
      if (/v\.body->>'provider' = 'wecom_native'/.test(text)) {
        expect(params[2]).toBe('')
        return { rows: [] }
      }
      if (/insert into forms\.mcp_audit/.test(text)) return { rows: [] }
      throw new Error(`unexpected query: ${text}`)
    })
    const r = await callTool(deps({ pool }), 'read', 'search_standard_approvals', {})
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.text)).toEqual({ approvals: [] })
  })
})

describe('generate_form_draft', () => {
  it('未配 LLM → llm_not_configured（可解释）', async () => {
    const r = await callTool(deps(), 'manage', 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('llm_not_configured')
  })

  it('描述缺失/超长 → 机检原因', async () => {
    const fake = { async complete() { return '{}' } }
    for (const [args, reason] of [
      [{}, 'description_required'],
      [{ description: '  ' }, 'description_required'],
      [{ description: 'x'.repeat(2001) }, 'description_too_long'],
    ] as const) {
      const r = await callTool(deps({ chatModel: fake }), 'manage', 'generate_form_draft', args)
      expect(r.isError, JSON.stringify(args).slice(0, 30)).toBe(true)
      expect(JSON.parse(r.text).reason).toBe(reason)
    }
  })

  it('★ 落 draft（不发布）+ forms.mcp_audit 一行（ok，带 assetId/version）', async () => {
    const audits: unknown[][] = []
    const pool = fakePool((text, params) => {
      if (/select 1 from forms\.asset_version where org=\$1 and kind=\$2 and asset_id=\$3 limit 1/.test(text)) {
        return { rows: [] } // 未重名
      }
      if (/select forms\.new_draft/.test(text)) return { rows: [{ v: 1 }] }
      if (/insert into forms\.mcp_audit/.test(text)) { audits.push(params); return { rows: [] } }
      throw new Error(`unexpected query: ${text}`)
    })
    const reply = JSON.stringify({
      assetId: 'inspection',
      schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] },
    })
    const model = { async complete() { return reply } }

    const r = await callTool(deps({ pool, chatModel: model }), 'manage', 'generate_form_draft', { description: '门店巡检登记' })
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.text) as { assetId: string; version: number; status: string }
    expect(out).toMatchObject({ assetId: 'inspection', version: 1, status: 'draft' })
    expect(out).not.toHaveProperty('published')

    expect(audits).toHaveLength(1)
    // 参数序：org, userId, tool, outcome, reason, params(jsonb), assetId, version
    expect(audits[0][0]).toBe('org-a')
    expect(audits[0][1]).toBe('u1')
    expect(audits[0][2]).toBe('generate_form_draft')
    expect(audits[0][3]).toBe('ok')
    expect(audits[0][4]).toBeNull()
    // args 摘要进审计（spec §6.5）：description 原样落库
    expect(JSON.parse(audits[0][5] as string)).toEqual({ description: '门店巡检登记' })
    expect(audits[0][6]).toBe('inspection')
    expect(audits[0][7]).toBe(1)
  })

  it('审计写失败不改变业务结果（吞掉 + console.warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pool = fakePool((text) => {
      if (/select 1 from forms\.asset_version/.test(text)) return { rows: [] }
      if (/select forms\.new_draft/.test(text)) return { rows: [{ v: 1 }] }
      if (/insert into forms\.mcp_audit/.test(text)) throw new Error('audit table down')
      throw new Error(`unexpected query: ${text}`)
    })
    const reply = JSON.stringify({
      assetId: 'inspection',
      schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] },
    })
    const model = { async complete() { return reply } }

    const r = await callTool(deps({ pool, chatModel: model }), 'manage', 'generate_form_draft', { description: '门店巡检登记' })
    expect(r.isError).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  afterEach(() => vi.restoreAllMocks())
})
