// all.test.ts — 装载工厂的纯断言（不连库；wh/env 可注入 ⇒ 不触 analystPool）。
// buildToolboxDeps 是 ToolboxDeps 的唯一装配点（Wave 2 决策 D-M1）：/mcp、POST /toolbox、
// agent-loop 三处共用。⚠️ 工厂只能住 all.ts——registry.ts 是 CI 门（check-mcp-toolface）
// 的 import 对象，必须保持纯（不拉 warehouse/pg）。
import { describe, expect, it } from 'vitest'
import { buildToolboxDeps } from './all'
import type { ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const base = () => ({
  pool: { query: async () => { throw new Error('不该碰库') } } as never,
  org: 'acme',
  requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true } as Requester,
  adoptedSources: new Set<string>(['lemeng']),
})
const whStub = async () => ({ rows: [] }) as never

describe('buildToolboxDeps', () => {
  it('base 四键透传；wh 注入优先；allowMutating 随 env（缺省 process.env=关）', () => {
    const b = base()
    const deps = buildToolboxDeps(b, { wh: whStub, env: {} })
    expect(deps.pool).toBe(b.pool)
    expect(deps.org).toBe('acme')
    expect(deps.requester).not.toBeNull()
    expect(deps.adoptedSources).toBe(b.adoptedSources)
    expect(deps.wh).toBe(whStub)
    expect(deps.allowMutating).toBe(false) // env:{} 里没有 DATA_MCP_ALLOW_MUTATING
    expect(typeof deps.dbtManifest).toBe('function')
  })
  it('写开关显式开：env.DATA_MCP_ALLOW_MUTATING === "true" 才开（恰为字面量，TRUE 不算）', () => {
    expect(buildToolboxDeps(base(), { wh: whStub, env: { DATA_MCP_ALLOW_MUTATING: 'true' } }).allowMutating).toBe(true)
    expect(buildToolboxDeps(base(), { wh: whStub, env: { DATA_MCP_ALLOW_MUTATING: 'TRUE' } }).allowMutating).toBe(false)
  })
  it('缺省 wh 是函数（生产惰性连只读池；本用例不调用它）', () => {
    const deps: ToolboxDeps = buildToolboxDeps(base(), { env: {} })
    expect(typeof deps.wh).toBe('function')
  })
})
