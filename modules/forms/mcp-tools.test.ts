import { describe, expect, it } from 'vitest'
import { FORMS_MAX_TOOLS, FORMS_TOOLS } from './mcp-tools'

// forms 的 MCP 工具元数据（2026-11-16 能力网关 spec §6.5）：**纯清单**——
// 供 check-mcp-toolface 静态判定；实现见 mcp.ts。这里钉两条最要紧的纪律：
// ① 元数据形状足以过门禁（命名 / mutating 必带注解与 scope）；
// ② **工具集里永不出现发布类能力**（AI 永不发布，§14.1）。

describe('FORMS_TOOLS 元数据', () => {
  it('三个工具、数量与上限一致、命名合法、mutating 带 annotations/scope', () => {
    expect(FORMS_MAX_TOOLS).toBe(3)
    expect(FORMS_TOOLS).toHaveLength(FORMS_MAX_TOOLS)
    expect(FORMS_TOOLS.map((t) => t.name).sort())
      .toEqual(['generate_form_draft', 'list_forms', 'search_standard_approvals'])

    for (const t of FORMS_TOOLS) {
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]+$/)
      expect(t.inputSchema.type).toBe('object')
      expect(t.annotations.readOnlyHint).toBe(!t.mutating)
    }

    const gen = FORMS_TOOLS.find((t) => t.name === 'generate_form_draft')!
    expect(gen.mutating).toBe(true)
    expect(gen.annotations.readOnlyHint).toBe(false)
    expect(gen.requiredScope).toBe('forms:manage')
    expect(gen.faceScope).toBe('forms:manage')

    const list = FORMS_TOOLS.find((t) => t.name === 'list_forms')!
    expect(list.mutating).toBe(false)
    expect(list.annotations.readOnlyHint).toBe(true)
    expect(list.requiredScope).toBeNull()
    expect(list.faceScope).toBe('forms:view')

    // OA P2 Task 7：选模板是读面只读工具（只回 name/deepLink/description，不写库）
    const search = FORMS_TOOLS.find((t) => t.name === 'search_standard_approvals')!
    expect(search.mutating).toBe(false)
    expect(search.annotations.readOnlyHint).toBe(true)
    expect(search.requiredScope).toBeNull()
    expect(search.faceScope).toBe('forms:view')
  })

  it('★ 不含任何发布/回滚/退役类工具（AI 永不发布）', () => {
    for (const t of FORMS_TOOLS) expect(t.name).not.toMatch(/publish|rollback|retire|delete|remove/)
  })
})
