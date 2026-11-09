// render.test.ts — 正文渲染的纯判据。
import { describe, expect, it } from 'vitest'
import { CONTRACT } from './contract'
import { contractView, guideInvariants, renderInstructions, renderSkill } from './render'

describe('renderSkill', () => {
  it('mcp 正文包含七步工作流、四行硬约束、注入日期', () => {
    const text = renderSkill('mcp', { today: '2026-01-02' })
    expect(text).toContain('今天是 2026-01-02')
    expect(text).toContain('工作流七步')
    expect(text).toContain('硬约束')
    for (const line of guideInvariants()) expect(text).toContain(line)
  })

  it('确定性：同一输入两次逐字节一致', () => {
    expect(renderSkill('mcp', { today: '2026-01-02' })).toBe(renderSkill('mcp', { today: '2026-01-02' }))
  })

  it('渲染结果不含未解析占位符', () => {
    expect(renderSkill('mcp', { today: '2026-01-02' })).not.toContain('{{')
    expect(renderInstructions()).not.toContain('{{')
  })
})

describe('contractView', () => {
  it('mcp 视图 = 13 个分析师工具 + query_detail，不含 list_metrics', () => {
    const names = contractView('mcp').map((t) => t.channels.mcp!.name)
    expect(names).toContain('query_detail')
    expect(names).not.toContain('list_metrics')
    expect(names).toHaveLength(14)
  })

  it('openclaw 视图 = 7 个工具（含 list_metrics，不含 MCP 专属工具）', () => {
    const names = contractView('openclaw').map((t) => t.channels.openclaw!.name)
    expect(names.sort()).toEqual([
      'describe_metric', 'get_freshness', 'list_metrics', 'query_data',
      'query_detail', 'sample_dimension_values', 'search_catalog',
    ])
  })

  it('每个工具 id 在契约里唯一', () => {
    const ids = CONTRACT.tools.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
