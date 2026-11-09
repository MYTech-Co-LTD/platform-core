// render.test.ts — 正文渲染的纯判据。
import { describe, expect, it } from 'vitest'
import { CONTRACT } from './contract'
import {
  contractView, guideInvariants, renderInstructions, renderSkill, renderText,
  type ContentReader,
} from './render'

/** 注入式 content 读取器：测试可给任意桩文本，不碰真实文件。 */
const readerOf = (files: Record<string, string>): ContentReader => (rel) => {
  const text = files[rel]
  if (text === undefined) throw new Error(`test reader: 缺文件 ${rel}`)
  return text
}
const emptyReader = readerOf({})

describe('renderText（纯函数，注入 reader）', () => {
  it('{{today}} 允许出现并被替换', () => {
    expect(renderText('今天是 {{today}}', 'mcp', { today: '2026-01-02' }, emptyReader))
      .toBe('今天是 2026-01-02')
  })

  it('正文含 {{today}} 但缺 today → 抛错（不静默渲染成空日期）', () => {
    expect(() => renderText('今天是 {{today}}', 'mcp', {}, emptyReader))
      .toThrow(/未注入 opts\.today/)
  })

  it('未知工具占位符 → 抛错', () => {
    expect(() => renderText('{{tool:nope}}', 'mcp', {}, emptyReader))
      .toThrow(/没有工具 nope/)
  })

  it('非法 include → 抛错（不读文件）', () => {
    expect(() => renderText('{{include:../secret.md}}', 'mcp', {}, emptyReader))
      .toThrow(/非法 include \.\.\/secret\.md/)
  })

  it('include 深度超限 → 抛错', () => {
    const self: ContentReader = () => '{{include:a.md}}'
    expect(() => renderText('{{include:a.md}}', 'mcp', {}, self))
      .toThrow(/include 深度超限/)
  })

  it('未闭合占位符 {{tool:query → 抛错', () => {
    expect(() => renderText('{{tool:query', 'mcp', {}, emptyReader))
      .toThrow(/未解析占位符/)
  })

  it('空占位符 {{}} → 抛错', () => {
    expect(() => renderText('{{}}', 'mcp', {}, emptyReader))
      .toThrow(/未解析占位符/)
  })
})

describe('renderSkill（真实 content/*.md）', () => {
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

describe('guideInvariants', () => {
  it('恰 4 行', () => {
    expect(guideInvariants()).toHaveLength(4)
  })
})

describe('renderInstructions', () => {
  it('含契约里的 guide 工具名（不硬编码）', () => {
    const guideName = CONTRACT.tools.find((t) => t.id === 'guide')?.channels.mcp?.name
    expect(guideName).toBeDefined()
    expect(renderInstructions()).toContain(guideName!)
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
