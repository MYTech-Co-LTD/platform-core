// explore.test.ts — `explore_query` 的结果来源（S1）：provenance 只做标注，不改执行链。
import { describe, expect, it, vi } from 'vitest'
import type { Requester } from '../authz'
import type { ToolboxDeps } from './registry'

const mocks = vi.hoisted(() => ({ executeExplore: vi.fn() }))
vi.mock('../analysis/explore-exec', () => ({ executeExplore: mocks.executeExplore }))

import { exploreQueryImpl } from './explore'

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'session', keyId: null,
  scopes: ['data:query'], hasScope: () => true,
}

function deps(): ToolboxDeps {
  return {
    pool: {} as never,
    org: 'acme',
    requester,
    adoptedSources: new Set(['lemeng']),
    wh: async () => ({ columns: [], rows: [] }),
    exploreExec: async () => ({ columns: [], rows: [] }),
    now: () => new Date('2026-11-10T00:00:00Z'),
  }
}

describe('exploreQueryImpl：provenance（S1）', () => {
  it('ok ⇒ source/relation/executedAt + 本层审计 id', async () => {
    mocks.executeExplore.mockResolvedValue({
      ok: true, columns: ['a'], rows: [[1]], rowCount: 1, truncated: false,
      sql: 'select 1', preview: 'select 1', auditId: 42,
    })
    const out = await exploreQueryImpl(deps(), { relation: 'fct_retail_sale' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'ok',
      relation: 'fct_retail_sale',
      provenance: {
        source: 'explore',
        relation: 'fct_retail_sale',
        executedAt: '2026-11-10T00:00:00.000Z',
        auditId: 42,
      },
    })
  })

  it('MCP 路径 auditId=null ⇒ provenance 不带 auditId（不伪造）', async () => {
    mocks.executeExplore.mockResolvedValue({
      ok: true, columns: ['a'], rows: [[1]], rowCount: 1, truncated: false,
      sql: 'select 1', preview: 'select 1', auditId: null,
    })
    const out = await exploreQueryImpl(deps(), { relation: 'fct_retail_sale' })
    const payload = out.payload as { provenance: Record<string, unknown> }
    expect(payload.provenance).toEqual({
      source: 'explore',
      relation: 'fct_retail_sale',
      executedAt: '2026-11-10T00:00:00.000Z',
    })
    expect('auditId' in payload.provenance).toBe(false)
  })
})

describe('exploreQueryImpl：数据范围 enforce（#1957）', () => {
  it('enforce 下非管理员 ⇒ range_denied:explore_not_scoped（任意 SQL 无法编译范围谓词）', async () => {
    process.env.DATA_SCOPE_MODE = 'enforce'
    const noAdmin: Requester = { ...requester, scopes: ['data:query'], hasScope: (s) => s === 'data:query' }
    const out = await exploreQueryImpl({ ...deps(), requester: noAdmin }, { relation: 'fct_retail_sale' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'range_denied', detail: 'explore_not_scoped' })
    delete process.env.DATA_SCOPE_MODE
  })

  it('enforce 下管理员放行（不受范围限制的主体）', async () => {
    process.env.DATA_SCOPE_MODE = 'enforce'
    mocks.executeExplore.mockResolvedValue({
      ok: true, columns: ['a'], rows: [[1]], rowCount: 1, truncated: false,
      sql: 'select 1', preview: 'select 1', auditId: null,
    })
    const admin: Requester = { ...requester, scopes: ['data:query', 'data:manage'], hasScope: () => true }
    const out = await exploreQueryImpl({ ...deps(), requester: admin }, { relation: 'fct_retail_sale' })
    expect(out.payload).toMatchObject({ status: 'ok' })
    delete process.env.DATA_SCOPE_MODE
  })
})
