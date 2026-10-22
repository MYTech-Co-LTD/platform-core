// guide.test.ts — 纯层（不连库；impl 不触 pool/wh）。
import { describe, expect, it } from 'vitest'
import { GUIDE_INVARIANTS, GUIDE_TEXT_BUILDER, guideImpl, harnessCatalogImpl } from './guide'
import { ANALYST_TOOLS, type ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const deps = (): ToolboxDeps => ({
  pool: { query: async () => { throw new Error('guide 不该碰库') } } as never,
  org: 'acme',
  requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true } as Requester,
  adoptedSources: new Set<string>(),
  wh: async () => { throw new Error('guide 不该碰仓库') },
  now: () => new Date('2026-10-21T10:00:00+08:00'),
})

describe('guideImpl / harnessCatalogImpl', () => {
  it('guide：七步工作流 + 硬约束 + 注入的今天日期；不触库不触仓', async () => {
    const out = await guideImpl(deps(), {})
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    const payload = out.payload as { today: string; workflow: string }
    expect(payload.today).toBe('2026-10-21')
    expect(payload.workflow).toContain('主体')
    expect(payload.workflow).toContain('新鲜度')
    expect(payload.workflow).toContain('1000')
  })
  it('catalog：清单与注册表逐条一致（同源派生，无第二份字面量）', async () => {
    const out = await harnessCatalogImpl(deps(), {})
    const tools = (out.payload as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toEqual(ANALYST_TOOLS.map((t) => t.name))
    expect(tools).toHaveLength(ANALYST_TOOLS.length)
  })
  it('GUIDE_TEXT_BUILDER 的今天日期由调用方注入（不隐藏依赖系统时钟）', () => {
    expect(GUIDE_TEXT_BUILDER('2026-01-02')).toContain('2026-01-02')
  })
})

describe('GUIDE_INVARIANTS（三通道同源内核，Wave 2 决策 D-G1）', () => {
  it('恰四行，每行都进 GUIDE_TEXT_BUILDER 输出（B 通道同源现状不破）', () => {
    expect(GUIDE_INVARIANTS).toHaveLength(4)
    const built = GUIDE_TEXT_BUILDER('2026-10-22')
    for (const line of GUIDE_INVARIANTS) expect(built).toContain(line)
  })
  it('行文案是通道中性的：不出现 B 专属工具名（A/C 没有这些工具，引用即误导）', () => {
    for (const line of GUIDE_INVARIANTS) {
      expect(line.includes('search_catalog') || line.includes('preview_query') || line.includes('data_harness_catalog')).toBe(false)
    }
  })
  it('四行分别钉住：主体钉死 / 截断语义（含 1000）/ total 语义 / 新鲜度如实', () => {
    const all = GUIDE_INVARIANTS.join('\n')
    expect(all).toContain('钉死')
    expect(all).toContain('1000')
    expect(all).toContain('truncated')
    expect(all).toContain('total')
    expect(all).toContain('新鲜度')
    expect(all).toContain('不要编')
  })
})
