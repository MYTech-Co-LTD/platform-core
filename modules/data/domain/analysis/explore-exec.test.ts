import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { executeExplore, loadExploreContext, martsWhitelist } from './explore-exec'
import type { ExploreContext } from './explore'

const context = (over: Partial<ExploreContext> = {}): ExploreContext => ({
  allowedRelations: new Set(['fct_retail_sale']),
  columns: new Map([[
    'fct_retail_sale',
    [
      { name: 'org', dataType: 'text' },
      { name: 'branch_num', dataType: 'text' },
      { name: 'sale_amount', dataType: 'numeric' },
    ],
  ]]),
  maskedColumns: new Set<string>(),
  maskedRelations: new Set<string>(),
  ...over,
})

/** 只回答审计 insert 的假平台库；记下每次写入，供断言。 */
function fakePool(): { pool: Pool; audits: Array<Record<string, unknown>> } {
  const audits: Array<Record<string, unknown>> = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (/insert into data\.query_audit/.test(sql)) {
        const p = (params ?? []) as unknown[]
        audits.push({
          metricId: p[4], params: p[5], rowCount: p[6], verdict: p[7], reason: p[8], tool: p[11],
        })
        return { rows: [{ id: audits.length, created_at: new Date('2026-11-06T00:00:00Z') }] }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  } as unknown as Pool
  return { pool, audits }
}

const baseDeps = (over: Record<string, unknown> = {}) => {
  const { pool, audits } = fakePool()
  return {
    audits,
    deps: {
      pool,
      org: 'acme',
      requesterUserId: 'u-1',
      channel: 'pat' as const,
      keyId: null,
      exec: async () => ({ columns: ['sum_sale_amount'], rows: [[42]] }),
      loadContext: async () => context(),
      ...over,
    },
  }
}

describe('executeExplore（W6 Task 2：执行 + 审计）', () => {
  it('成功：org 作为 $1 注入，返回行集与审计 id，verdict=ok', async () => {
    const seen: Array<{ sql: string; params: readonly unknown[] }> = []
    const { deps, audits } = baseDeps({
      exec: async (sql: string, params: readonly unknown[]) => {
        seen.push({ sql, params })
        return { columns: ['sum_sale_amount'], rows: [[42]] }
      },
    })
    const out = await executeExplore(deps, {
      relation: 'fct_retail_sale',
      measures: [{ agg: 'sum', column: 'sale_amount' }],
      filters: [{ column: 'branch_num', op: 'eq', value: 'B1' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.rowCount).toBe(1)
    expect(out.auditId).toBe(1)
    expect(seen[0].params).toEqual(['acme', 'B1'])
    expect(audits[0]).toMatchObject({ verdict: 'ok', tool: 'explore_query', metricId: 'explore:fct_retail_sale' })
  })

  it('编译拒绝 ⇒ 审计 denied，exec 一次都不跑', async () => {
    let called = 0
    const { deps, audits } = baseDeps({ exec: async () => { called += 1; return { columns: [], rows: [] } } })
    const out = await executeExplore(deps, { relation: 'stg_secret', measures: [{ agg: 'sum', column: 'x' }] })
    expect(out).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
    expect(called).toBe(0)
    expect(audits[0]).toMatchObject({ verdict: 'denied', reason: 'RELATION_NOT_ALLOWED' })
  })

  it('执行抛错 ⇒ 审计 error，不把错误当空结果', async () => {
    const { deps, audits } = baseDeps({ exec: async () => { throw new Error('boom') } })
    const out = await executeExplore(deps, { relation: 'fct_retail_sale', measures: [{ agg: 'sum', column: 'sale_amount' }] })
    expect(out).toMatchObject({ ok: false, code: 'EXEC_FAILED' })
    expect(audits[0]).toMatchObject({ verdict: 'error', reason: 'EXEC_FAILED' })
  })

  it('上下文装载失败 ⇒ NO_CONTEXT + error 审计（不让异常穿透）', async () => {
    const { deps, audits } = baseDeps({ loadContext: async () => { throw new Error('db down') } })
    const out = await executeExplore(deps, { relation: 'fct_retail_sale', measures: [{ agg: 'sum', column: 'sale_amount' }] })
    expect(out).toMatchObject({ ok: false, code: 'NO_CONTEXT' })
    expect(audits[0]).toMatchObject({ verdict: 'error', reason: 'NO_CONTEXT' })
  })

  it('审计里不落过滤值（只记列名与 op）', async () => {
    const { deps, audits } = baseDeps()
    await executeExplore(deps, {
      relation: 'fct_retail_sale',
      measures: [{ agg: 'count', column: 'branch_num' }],
      filters: [{ column: 'branch_num', op: 'eq', value: '13800000000' }],
    })
    const params = JSON.stringify(audits[0])
    expect(params).not.toContain('13800000000')
    expect(params).toContain('branch_num')
  })
})

describe('martsWhitelist', () => {
  it('只收 /marts/ 路径下的模型（staging 模型进不来）', () => {
    const set = martsWhitelist()
    expect(set.has('fct_retail_sale')).toBe(true)
    expect([...set].some((n) => n.startsWith('stg_') || n.startsWith('staging'))).toBe(false)
  })
})

describe('loadExploreContext（列清单必须问仓库库，不是平台库）', () => {
  it('information_schema 走注入的仓库执行器；列按表归组', async () => {
    const seen: string[] = []
    const ctx = await loadExploreContext({
      // 平台库只服务词表；一旦被查询就炸 —— 钉住「列不来自平台库」
      pool: { query: async () => { throw new Error('platform pool must not be queried for columns') } } as unknown as import('pg').Pool,
      exec: async (sql: string) => {
        seen.push(sql)
        return {
          columns: ['table_name', 'column_name', 'data_type'],
          rows: [
            ['fct_retail_sale', 'org', 'text'],
            ['fct_retail_sale', 'net_amount', 'numeric'],
          ],
        }
      },
      org: 'acme',
      // 仓根（本文件在 modules/data/domain/analysis/，往上四层）
      repoRoot: fileURLToPath(new URL('../../../..', import.meta.url)),
      loadCatalog: async () => [],
    })
    expect(seen[0]).toContain('information_schema.columns')
    expect(ctx.columns.get('fct_retail_sale')).toEqual([
      { name: 'org', dataType: 'text' },
      { name: 'net_amount', dataType: 'numeric' },
    ])
    expect(ctx.allowedRelations.has('fct_retail_sale')).toBe(true)
  })
})
