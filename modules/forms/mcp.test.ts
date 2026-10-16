import { describe, expect, it } from 'vitest'
import { callTool, toolDefs } from './mcp'

// MCP 管理面（#724）：两个**纯函数**入口（toolDefs / callTool）——协议壳的编解码另有
// routes.test 的端到端用例覆盖。这里钉的是本端点最要紧的那条纪律：
// **工具集里不得出现任何发布类能力**（AI 永不发布，§14.1），以及工具级错误的形状。

const deps = (over: Partial<Parameters<typeof callTool>[0]> = {}) => ({
  pool: null as never,
  org: 'org-a',
  userId: 'u1',
  chatModel: null,
  ...over,
})

describe('MCP 管理面工具集', () => {
  it('★ 不暴露任何发布/回滚/退役类工具（AI 永不发布）', () => {
    const names = toolDefs().map((t) => t.name)
    expect(names).toEqual(['list_forms', 'generate_form_draft'])
    for (const n of names) expect(n).not.toMatch(/publish|rollback|retire|delete|remove/)
  })

  it('每个工具都有 name/description/inputSchema（协议必需）', () => {
    for (const t of toolDefs()) {
      expect(t.name).toBeTruthy()
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('未知工具 → 工具级错误（isError=true，不是抛出）', async () => {
    const r = await callTool(deps(), 'publish_form', {})
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('unknown_tool')
  })

  it('generate_form_draft：未配 LLM → llm_not_configured（可解释）', async () => {
    const r = await callTool(deps(), 'generate_form_draft', { description: '门店巡检' })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.text).reason).toBe('llm_not_configured')
  })

  it('generate_form_draft：描述缺失/超长 → 机检原因', async () => {
    const fake = { async complete() { return '{}' } }
    for (const [args, reason] of [
      [{}, 'description_required'],
      [{ description: '  ' }, 'description_required'],
      [{ description: 'x'.repeat(2001) }, 'description_too_long'],
    ] as const) {
      const r = await callTool(deps({ chatModel: fake }), 'generate_form_draft', args)
      expect(r.isError, JSON.stringify(args).slice(0, 30)).toBe(true)
      expect(JSON.parse(r.text).reason).toBe(reason)
    }
  })
})
