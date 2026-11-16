import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { callTool, toolDefs } from './mcp'

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

describe('MCP 工具面投影（read / manage）', () => {
  it('★ 不暴露任何发布/回滚/退役类工具（AI 永不发布）', () => {
    const names = toolDefs('manage').map((t) => t.name)
    expect(names).toEqual(['list_forms', 'generate_form_draft'])
    for (const n of names) expect(n).not.toMatch(/publish|rollback|retire|delete|remove/)
  })

  it('/mcp 只回 list_forms；/mcp-manage 两工具', () => {
    expect(toolDefs('read').map((t) => t.name)).toEqual(['list_forms'])
    expect(toolDefs('manage').map((t) => t.name)).toEqual(['list_forms', 'generate_form_draft'])
  })

  it('每个工具都有 name/description/inputSchema（协议必需）', () => {
    for (const t of toolDefs('manage')) {
      expect(t.name).toBeTruthy()
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('read face 拒绝写工具（工具级错误，不是抛出）', async () => {
    const r = await callTool(deps(), 'read', 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('read_only_tool_not_allowed')
  })

  it('未知工具 → 工具级错误（isError=true，不是抛出）', async () => {
    const r = await callTool(deps(), 'manage', 'publish_form', {})
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('unknown_tool')
  })

  it('generate_form_draft 缺 forms:manage → missing_scope（工具级 scope 执法）', async () => {
    const r = await callTool(deps({ hasScope: () => false }), 'manage', 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    const out = JSON.parse(r.text) as { reason: string; scope: string }
    expect(out.reason).toBe('missing_scope')
    expect(out.scope).toBe('forms:manage')
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
    // 参数序：org, userId, tool, outcome, reason, assetId, version
    expect(audits[0][0]).toBe('org-a')
    expect(audits[0][1]).toBe('u1')
    expect(audits[0][2]).toBe('generate_form_draft')
    expect(audits[0][3]).toBe('ok')
    expect(audits[0][4]).toBeNull()
    expect(audits[0][5]).toBe('inspection')
    expect(audits[0][6]).toBe(1)
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
