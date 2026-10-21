// registry.test.ts — 工具注册表：纯函数层（不连库）。
import { describe, expect, it } from 'vitest'
import {
  ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS, ANALYST_TOOLS,
  callTool, legacyMetricTools, listAnalystTools, mutatingAllowed,
  registerImpl, sanitizeToolName, TOOL_NAME_RE,
} from './registry'
import type { ToolboxDeps } from './registry'
import type { MetricDef, Requester, SourceTaggedMetric } from '../authz'

const requester = (scopes: string[]): Requester => ({
  userId: 'u1', orgId: 'acme', channel: 'pat', keyId: 1,
  scopes, hasScope: (c) => scopes.includes(c),
})
const metric = (over: Partial<MetricDef>): MetricDef => ({
  id: 'x', title: 'X', description: '', requiredScope: null,
  subjectColumn: 'org', selectSql: 'select org from t', groupBy: '', params: {}, ...over,
})
/** 词表行的真机形状 = MetricDef + sourceSystem（legacyMetricTools 收 SourceTaggedMetric）。 */
const tagged = (over: Partial<MetricDef> & { sourceSystem?: string | null }): SourceTaggedMetric =>
  ({ ...metric(over), sourceSystem: over.sourceSystem ?? null })

describe('sanitizeToolName / 命名', () => {
  it('冒号 → __；其余非法字符 → _；输出必合 TOOL_NAME_RE', () => {
    expect(sanitizeToolName('lemeng:retail:net_sales')).toBe('lemeng__retail__net_sales')
    expect(sanitizeToolName('a b/c')).toMatch(TOOL_NAME_RE)
    expect(() => sanitizeToolName('')).toThrow()
  })
})

describe('ANALYST_TOOLS 静态清单自身的约束（工具面预算的实体面）', () => {
  it('11 个固定工具、名字全合法、mutating 全 false（Wave 1 纯只读）', () => {
    expect(ANALYST_TOOLS.length).toBe(11)
    for (const t of ANALYST_TOOLS) {
      expect(t.name).toMatch(TOOL_NAME_RE)
      expect(t.mutating).toBe(false)
      expect(t.annotations.readOnlyHint).toBe(true)
      // scope ∈ 声明面两码（discover/health/guide = data:read；数值 = data:query——见 Task 1 清单）
      expect(['data:read', 'data:query']).toContain(t.requiredScope)
    }
  })
  it('清单无重名；静态序列化 ≤10KB（预算在源头可见）', () => {
    const names = ANALYST_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(JSON.stringify(ANALYST_TOOLS).length).toBeLessThanOrEqual(ANALYST_FACE_MAX_LIST_BYTES)
    expect(ANALYST_TOOLS.length).toBeLessThanOrEqual(ANALYST_FACE_MAX_TOOLS)
  })
})

describe('legacyMetricTools：可见指标 → sanitized 工具，撞名跳过', () => {
  const m1 = tagged({ id: 'lemeng:retail:net_sales', title: '净销', description: 'd1', sourceSystem: 'lemeng' })
  it('可见指标生成 sanitized 工具名并保留 metricId 映射', () => {
    const out = legacyMetricTools([m1], requester(['data:query']), new Set(['lemeng']))
    expect(out).toHaveLength(1)
    expect(out[0].tool.name).toBe('lemeng__retail__net_sales')
    expect(out[0].metricId).toBe('lemeng:retail:net_sales')
  })
  it('指标 id 撞分析师面固定工具名 ⇒ 跳过该指标（fail-closed，不可冒名 query_metric）', () => {
    const evil = tagged({ id: 'query_metric', title: 'E' })
    expect(legacyMetricTools([evil], requester(['data:query']), new Set())).toHaveLength(0)
  })
  it('两个指标 sanitize 后同名 ⇒ 只留第一个（词表序）', () => {
    const a = tagged({ id: 'a:b', title: 'A' })
    const b = tagged({ id: 'a__b', title: 'B' })
    const out = legacyMetricTools([a, b], requester(['data:query']), new Set())
    expect(out).toHaveLength(1)
    expect(out[0].metricId).toBe('a:b')
  })
  it('scope 不够/源未接入的指标不可见（复用 visibleMetrics，不自建判定）', () => {
    const gated = tagged({ id: 'g:1', requiredScope: 'data:cost' })
    const foreign = tagged({ id: 'f:1', sourceSystem: 'other' })
    expect(legacyMetricTools([gated], requester(['data:query']), new Set())).toHaveLength(0)
    expect(legacyMetricTools([foreign], requester(['data:query']), new Set(['lemeng']))).toHaveLength(0)
  })
})

describe('callTool：未知工具 / 空身份 / 单点审计（拒绝也写）', () => {
  const baseDeps = (pool: unknown): ToolboxDeps => ({
    pool: pool as never, org: 'acme',
    requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1, scopes: ['data:query'], hasScope: () => true },
    adoptedSources: new Set<string>(), wh: async () => ({ columns: [], rows: [] }),
  })
  const auditPool = () => {
    const sqls: string[] = []
    return { sqls, pool: { query: async (sql: string) => { sqls.push(sql); return { rows: [{ id: 7, created_at: new Date('2026-10-21T10:00:00Z') }] } } } }
  }

  it('未知工具 ⇒ denied/unknown_tool，且审计落一笔（拒绝也入审计）', async () => {
    const { sqls, pool } = auditPool()
    const out = await callTool(baseDeps(pool), 'no_such_tool', {})
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'unknown_tool' })
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('insert into data.query_audit')
  })

  it('空身份 ⇒ denied/unauthenticated；impl 不触、审计照写', async () => {
    const { sqls, pool } = auditPool()
    const deps = baseDeps(pool)
    deps.requester = null
    const out = await callTool(deps, 'data_agent_guide', {})
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'unauthenticated' })
    expect(sqls).toHaveLength(1)
  })
  // mutating 闸的代码分支在 callTool 内（Wave 1 无 mutating 工具，运行时分支空转）：
  // 静态面由 T12 门禁断言④（mutating ⇒ 注解+scope 必在）执法，运行时路径 Wave 3 提案面启用。
})

describe('mutatingAllowed（写开关，默认关）', () => {
  it('缺省/空/非 true ⇒ false；恰为 "true" ⇒ true', () => {
    expect(mutatingAllowed({})).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: '' })).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: 'TRUE' })).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: 'true' })).toBe(true)
  })
})

describe('listAnalystTools：T1 阶段 impl 未注册，清单照出（清单是静态事实源）', () => {
  it('11 条与 ANALYST_TOOLS 同引用序', () => {
    expect(listAnalystTools()).toEqual(ANALYST_TOOLS)
  })
  it('registerImpl 未知工具名抛；已知名重复注册抛', () => {
    expect(() => registerImpl('nope', async () => ({ payload: {}, isError: false }))).toThrow()
    const impl = async () => ({ payload: {}, isError: false })
    registerImpl('data_agent_guide', impl)
    expect(() => registerImpl('data_agent_guide', impl)).toThrow()
  })
})
