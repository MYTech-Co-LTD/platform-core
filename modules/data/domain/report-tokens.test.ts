// report-tokens.test.ts — 文本内嵌 token 的服务端解析（R3 / L2）。
// 假词表池 + 假执行器：钉「值从哪来、窗口怎么换、失败怎么说人话」，不碰湖。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { Requester } from './authz'
import type { QueryDeps } from './query-service'
import { resetWarehousePool } from './warehouse'
import { resolveTextTokens } from './report-tokens'
import type { ReportSpec } from './report-spec'

const ORG = 'org_tokens'
const RANGE = { from: '2026-10-01', to: '2026-10-02' }

const METRIC_ROW: Record<string, unknown> = {
  id: 'm:sales', title: '销售额', description: '',
  required_scope: null, subject_column: 'org',
  select_sql: 'select sum(fact.amount) as value, bizday from fact group by bizday',
  group_by: 'bizday',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
  source: 'l1', source_system: 'lemeng', updated_by: null, version: 1,
  totalable: true, scope_note: '', sla_days: 1, freshness_relations: [], mask_spec: null,
  drill_expr: null, drill_dims: null, drill_detail: null,
}

function req(): Requester {
  return {
    userId: 'alice', orgId: ORG, channel: 'session', keyId: null, scopes: ['data:query'],
    hasScope: (c) => c === 'data:query',
  }
}

function fakePool(): Pool {
  const pool = {
    query: async (text: string) => {
      if (/insert\s+into\s+data\.query_audit/.test(text)) {
        return { rows: [{ id: 1, created_at: new Date('2026-10-21T10:00:00Z') }] }
      }
      if (/from\s+data\.metrics/.test(text)) return { rows: [{ ...METRIC_ROW }], rowCount: 1 }
      throw new Error(`fake pool: unexpected sql: ${text}`)
    },
  }
  return pool as unknown as Pool
}

/** 合计执行器：按调用顺序发值（当前窗口在前、对比窗口在后由解析器顺序决定）。 */
function execQueue(values: number[], sqls: string[] = []) {
  return async (sql: string) => {
    sqls.push(sql)
    return { columns: ['total'], rows: [[values.shift() ?? 0]] }
  }
}

function specOf(content: string): ReportSpec['panels'] {
  return [
    { chart: 'kpi', title: '销售额', metricId: 'm:sales', args: {}, format: 'number', compare: 'none', span: 12, timeScoped: true },
    { chart: 'text', content, span: 24, format: 'plain' },
  ] as ReportSpec['panels']
}

const depsOf = (values: number[], sqls: string[], warehouseExec?: QueryDeps['warehouseExec']): QueryDeps => ({
  pool: fakePool(),
  adoptedSources: new Set(['lemeng']),
  dimensionLookup: async () => null,
  execute: execQueue(values, sqls),
  ...(warehouseExec === undefined ? {} : { warehouseExec }),
})

const input = (content: string, over: Partial<Parameters<typeof resolveTextTokens>[3]> = {}) => ({
  content,
  panels: specOf(content),
  range: RANGE,
  filterValues: {},
  ...over,
})

describe('resolveTextTokens', () => {
  beforeEach(() => {
    // 新鲜度辅助读走真仓库池：清 env/单例，避免同 worker 先跑的文件把池留脏。
    delete process.env.DATA_WAREHOUSE_URL
    resetWarehousePool()
  })

  it('★ metric：取当前窗口合计并按 fmt 格式化（无 token 文本不动）', async () => {
    const sqls: string[] = []
    const out = await resolveTextTokens(depsOf([1234.5], sqls), ORG, req(),
      input('本期销售额 {{metric:m:sales|fmt:currency}}。'))
    expect(out).toEqual({ ok: true, text: '本期销售额 ¥1,234.50。' })

    const plain = await resolveTextTokens(depsOf([], []), ORG, req(), input('没有引用'))
    expect(plain).toEqual({ ok: true, text: '没有引用' })
  })

  it('★ delta：当前 − 对比；默认给相对变化率，percent 指标由 formatDelta 给 pp', async () => {
    const out = await resolveTextTokens(depsOf([120, 100], []), ORG, req(),
      input('环比 {{delta:m:sales|vs:prev_period}}'))
    expect(out).toEqual({ ok: true, text: '环比 +20.0%' })

    const pp = await resolveTextTokens(depsOf([0.2, 0.18], []), ORG, req(),
      input('{{delta:m:sales|fmt:percent}}'))
    expect(pp).toEqual({ ok: true, text: '+2.00pp' })
  })

  it('★ as_of：数据截止时间来自同一次合计查询；缺席 ⇒ 可读失败', async () => {
    const warehouseExec = async (): Promise<{ columns: string[]; rows: unknown[][] }> => ({
      columns: ['data_as_of'], rows: [[new Date('2026-10-24T22:00:00Z')]],
    })
    const out = await resolveTextTokens(depsOf([1], [], warehouseExec), ORG, req(),
      input('数据截至 {{as_of:m:sales}}'))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text).toMatch(/^数据截至 2026-10-(24|25)/)

    const missing = await resolveTextTokens(depsOf([1], []), ORG, req(), input('{{as_of:m:sales}}'))
    expect(missing).toEqual({ ok: false, detail: '指标 m:sales 没有数据截止时间' })
  })

  it('★ 引用报表外/不可见指标 ⇒ 可读失败（不静默成空）', async () => {
    const out = await resolveTextTokens(depsOf([], []), ORG, req(),
      input('{{metric:m:secret}}'))
    expect(out).toEqual({ ok: false, detail: '文本引用的指标不在本报表里：m:secret' })
  })

  it('窗口 token 会换 bizday 区间（上期 = 等长前移）', async () => {
    const sqls: string[] = []
    await resolveTextTokens(depsOf([1, 2], sqls), ORG, req(),
      input('{{metric:m:sales|window:prev_period}}'))
    // 主查询的 where 用的是上期窗口 2026-09-29 ~ 2026-09-30（10-01 前等长两天）
    expect(sqls.some((s) => s.includes("'2026-09-29'") && s.includes("'2026-09-30'"))).toBe(true)
  })
})
