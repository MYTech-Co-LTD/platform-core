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

describe('openclaw 渲染', () => {
  it('包含四行硬约束、租户指标 id，且工具名已按 openclaw 通道替换', () => {
    const text = renderSkill('openclaw')
    for (const line of guideInvariants()) expect(text).toContain(line)
    expect(text).toContain('lemeng:retail:sales')
    expect(text).toContain('query_data')
    expect(text).not.toContain('query_metric')
  })

  it('平台 MCP 渲染不包含租户 local 内容', () => {
    const text = renderSkill('mcp', { today: '2026-01-02' })
    expect(text).not.toContain('lemeng:retail:sales')
  })

  // 从 openclaw lib.test.js 迁来的「文案即契约」断言：它们原先读 index.js / SKILL.md 源文本，
  // 现在改读正典渲染结果。行为判据逐字保留，只是事实源换了位置。
  it('query_data 工具描述含 total 语义与「不要自己加总」', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query')!.channels.openclaw!.description
    expect(desc).toContain('total 字段')
    expect(desc).toContain('不要自己把明细行加总')
    expect(desc).toContain('不要跨行求和')
    expect(desc).toContain('args.total=true')
    expect(desc).not.toContain('明细与合计互斥')
  })

  it('query_data 工具描述锁定「系统自动附加」口径', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query')!.channels.openclaw!.description
    expect(desc).toContain('新鲜度与口径射程由系统自动附加')
    expect(desc).toContain('不要自己写任何 📅 / 📐 行')
    expect(desc).toContain('不要复述或拼接 freshness_line / scope_line')
    expect(desc).not.toContain('答案末尾必须原样单独一行附')
    expect(desc).toContain('data_as_of')
    expect(desc).toContain('数据截止')
    expect(desc).toContain('新鲜度未知')
    expect(desc).toContain('部分天')
    expect(desc).toContain('北京时间')
    expect(desc).toContain('UTC+8')
  })

  it('SKILL 正文保留新鲜度口径与既有判据句', () => {
    const skill = renderSkill('openclaw')
    expect(skill).toContain('新鲜度声明由系统自动附加')
    expect(skill).toContain('不要自己写任何 📅 行')
    expect(skill).toContain('不要复述数据更新时间')
    expect(skill).not.toContain('原样**附回包的')
    expect(skill).toContain('data_as_of')
    expect(skill).toContain('新鲜度未知')
    expect(skill).toContain('部分天')
    expect(skill).toContain('北京时间')
    expect(skill).toContain('UTC+8')
    expect(skill).toContain('truncated:true')
    expect(skill).toContain('BAD_PARAM')
    expect(skill).toContain('区间超过 4 天必用')
  })

  it('SKILL 正文保留 query_detail 明细下钻节与条件列话术', () => {
    const skill = renderSkill('openclaw')
    expect(skill).toContain('query_detail')
    expect(skill).toContain('明细下钻')
    expect(skill).toContain('rowCountTotal')
    expect(skill).toContain('bizday')
    expect(skill).toContain('能力边界')
    expect(skill).toContain('不要重试')
    expect(skill).toContain('未授权')
    expect(skill).toContain('该列需授权')
    expect(skill).toContain('lemeng:retail:order_line')
    expect(skill).toContain('metricId=lemeng:retail:order_line')
  })

  it('query_detail 工具描述保留双时钟与条件列口径', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query_detail')!.channels.openclaw!.description
    expect(desc).toContain('bizday 必传')
    expect(desc).toContain('rowCountTotal')
    expect(desc).toContain('不要拿返回行数当全量')
    expect(desc).toContain('no_detail_binding')
    expect(desc).toContain('不要重试')
    expect(desc).toContain('clock_note')
    expect(desc).toContain('scope_line')
    expect(desc).toContain('原样转述')
    expect(desc).toContain('少一列')
    expect(desc).toContain('该列需授权')
  })

  it('openclaw 渲染逐字快照（迁移基线）', () => {
    expect(renderSkill('openclaw')).toMatchSnapshot()
  })
})
