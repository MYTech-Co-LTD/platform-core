// guide.test.ts — 纯层（不连库；impl 不触 pool/wh）。
import { describe, expect, it } from 'vitest'
import { GUIDE_INVARIANTS, GUIDE_TEXT_BUILDER, guideImpl, harnessCatalogImpl } from './guide'
import { ANALYST_TOOLS, type ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const deps = (over: Partial<ToolboxDeps> = {}): ToolboxDeps => ({
  pool: { query: async () => { throw new Error('guide 不该碰库') } } as never,
  org: 'acme',
  requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true } as Requester,
  adoptedSources: new Set<string>(),
  wh: async () => { throw new Error('guide 不该碰仓库') },
  now: () => new Date('2026-10-21T10:00:00+08:00'),
  surface: 'full',
  ...over,
})

type CatalogTool = {
  name: string
  faceScope: 'data:read' | 'data:query'
  requiredScope: string | null
  available: boolean
}

/** catalog 回包里的 tools（类型收窄，避免每条用例重复写断言体）。 */
const catalogTools = (out: { payload: Record<string, unknown> }): CatalogTool[] =>
  (out.payload as { tools: CatalogTool[] }).tools

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
    const tools = catalogTools(out)
    expect(tools.map((t) => t.name)).toEqual(ANALYST_TOOLS.map((t) => t.name))
    expect(tools).toHaveLength(ANALYST_TOOLS.length)
  })

  it('catalog：每条都带 faceScope（data:read / data:query），缺省 surface=full 全 available', async () => {
    const tools = catalogTools(await harnessCatalogImpl(deps({ surface: undefined }), {}))
    for (const t of tools) {
      expect(['data:read', 'data:query']).toContain(t.faceScope)
      expect(t.available).toBe(true)
    }
  })

  it('catalog：surface=read ⇒ query 类工具 available:false（locked 展示），read 类 true', async () => {
    const tools = catalogTools(await harnessCatalogImpl(deps({ surface: 'read' }), {}))
    const byName = new Map(tools.map((t) => [t.name, t]))
    // 查询类（faceScope=data:query）在只读面 locked
    expect(byName.get('query_metric')?.available).toBe(false)
    expect(byName.get('preview_query')?.available).toBe(false)
    for (const t of tools) expect(t.available).toBe(t.faceScope === 'data:read')
    // 只读工具仍可用（都还在目录里——locked 展示而非消失）
    expect(byName.get('search_catalog')?.available).toBe(true)
    expect(byName.get('get_freshness')?.available).toBe(true)
  })

  it('catalog：surface=curated ⇒ 全 available（curated 面含 query 工具）', async () => {
    const tools = catalogTools(await harnessCatalogImpl(deps({ surface: 'curated' }), {}))
    expect(tools.every((t) => t.available)).toBe(true)
  })

  it('catalog：requester=null 也按 surface 规则标注（不受身份影响，不触库）', async () => {
    const tools = catalogTools(await harnessCatalogImpl(deps({ surface: 'read', requester: null }), {}))
    for (const t of tools) expect(t.available).toBe(t.faceScope === 'data:read')
  })
  it('GUIDE_TEXT_BUILDER 的今天日期由调用方注入（不隐藏依赖系统时钟）', () => {
    expect(GUIDE_TEXT_BUILDER('2026-01-02')).toContain('2026-01-02')
  })
})

describe('GUIDE_INVARIANTS（三通道同源内核，Wave 2 决策 D-G1）', () => {
  it('恰五行，每行都进 GUIDE_TEXT_BUILDER 输出（B 通道同源现状不破）', () => {
    expect(GUIDE_INVARIANTS).toHaveLength(5)
    const built = GUIDE_TEXT_BUILDER('2026-10-22')
    for (const line of GUIDE_INVARIANTS) expect(built).toContain(line)
  })
  it('行文案是通道中性的：不出现 B 专属工具名（A/C 没有这些工具，引用即误导）', () => {
    for (const line of GUIDE_INVARIANTS) {
      expect(line.includes('search_catalog') || line.includes('preview_query') || line.includes('data_harness_catalog')).toBe(false)
    }
  })
  it('五行分别钉住：主体钉死 / 截断语义（含 1000）/ total 语义 / 新鲜度如实 / 同名澄清', () => {
    const all = GUIDE_INVARIANTS.join('\n')
    expect(all).toContain('钉死')
    expect(all).toContain('1000')
    expect(all).toContain('truncated')
    expect(all).toContain('total')
    expect(all).toContain('新鲜度')
    expect(all).toContain('不要编')
    expect(all).toContain('澄清')
  })
})

describe('guide 输出 golden（迁移前后逐字一致）', () => {
  it('GUIDE_TEXT_BUILDER 快照', () => {
    expect(GUIDE_TEXT_BUILDER('2026-01-02')).toMatchSnapshot()
  })
})
