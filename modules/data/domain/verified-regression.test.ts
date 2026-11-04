// verified-regression.test.ts — W1 Task 3：回归核心（结构 + 相对容差）与重放编排。
//
// **不连库**：summarize/compare 是纯函数；runRegression 的池与重放都注入替身（假池只应答
// 「列回归集」与「记录结果」两条 SQL，重放器是假函数）。真库/真仓的验证归 Task 6 真机验收。
// 比较口径逐条钉住计划 Task 3 的五条规则（列集与顺序 / 行数 / 数值三聚合相对容差 /
// 非数值列只比 null 计数 / 非 ok 一律 fail），任何一条放宽都必须红。
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { QueryOk, QueryOutcome } from './query-service'
import type { Baseline, VerifiedQuestion } from './verified-questions'
import { compare, runRegression, summarize } from './verified-regression'
// 平台侧装配器住在 scripts/（B1 不许 modules/** 读 platform 物理表）：回归 CLI 用它把
// 「本租户已接入源」解析出来再注入 runRegression。跨层 import 只在测试里发生。
import { loadAdoptedSources } from '../../../scripts/tenant-sources'

const ORG = 'org-regression-t3'

/** 一条成功查询的最小形状（subject/metricId 与比较无关，但 QueryOk 要求在场）。 */
function ok(columns: string[], rows: unknown[][]): QueryOk {
  return { status: 'ok', subject: ORG, metricId: 'm', columns, rows, truncated: false }
}

const baselineOf = (value: number): Baseline => ({
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum: value, min: value, max: value, nulls: 0 } },
})

// ── 纯函数：summarize ────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('数值列（含 pg 的 numeric 字符串）压成 sum/min/max + null 计数', () => {
    const s = summarize(ok(['value'], [['1000.50'], ['999.50'], [null]]))
    expect(s.columns).toEqual(['value'])
    expect(s.rowCount).toBe(3)
    // numeric 字符串必须按数值处理（node-pg 对 numeric 的默认返回形状）
    expect(s.summary.value).toEqual({ sum: 2000, min: 999.5, max: 1000.5, nulls: 1 })
  })

  it('非数值列只记 null 计数，并标 numeric:false（sum/min/max 不参与比较）', () => {
    const s = summarize(ok(['branch'], [['门店A'], [null]]))
    expect(s.summary.branch).toEqual({ sum: 0, min: 0, max: 0, nulls: 1, numeric: false })
  })

  it('混合列（有数也有文字）按非数值列处理——不猜', () => {
    const s = summarize(ok(['mixed'], [['12'], ['abc']]))
    expect(s.summary.mixed?.numeric).toBe(false)
    expect(s.summary.mixed?.nulls).toBe(0)
  })

  it('全 null 列（含 0 行）按非数值列处理', () => {
    expect(summarize(ok(['value'], [[null]])).summary.value).toEqual(
      { sum: 0, min: 0, max: 0, nulls: 1, numeric: false })
    expect(summarize(ok(['value'], [])).summary.value).toEqual(
      { sum: 0, min: 0, max: 0, nulls: 0, numeric: false })
  })
})

// ── 纯函数：compare（计划 Task 3 的五条规则） ─────────────────────────────────────

describe('compare', () => {
  it('列集变化 / 行数变化 / 数值超出容差 ⇒ fail；容差内 ⇒ pass', () => {
    const base = { columns: ['value'], rowCount: 1, summary: { value: { sum: 1000, min: 1000, max: 1000, nulls: 0 } } }
    expect(compare(base, { columns: ['value'], rowCount: 1, summary: { value: { sum: 1000.5, min: 1000.5, max: 1000.5, nulls: 0 } } }, 0.001).ok).toBe(true)
    expect(compare(base, { columns: ['value'], rowCount: 1, summary: { value: { sum: 1002, min: 1002, max: 1002, nulls: 0 } } }, 0.001).ok).toBe(false)
    expect(compare(base, { columns: ['value', 'branch'], rowCount: 1, summary: { value: { sum: 1000, min: 1000, max: 1000, nulls: 0 } } }, 0.001).ok).toBe(false)
  })

  it('列顺序变化也算结构变化（不是只看集合）', () => {
    const base: Baseline = {
      columns: ['a', 'b'], rowCount: 1,
      summary: { a: { sum: 1, min: 1, max: 1, nulls: 0 }, b: { sum: 2, min: 2, max: 2, nulls: 0 } },
    }
    const swapped: Baseline = {
      columns: ['b', 'a'], rowCount: 1,
      summary: { a: { sum: 1, min: 1, max: 1, nulls: 0 }, b: { sum: 2, min: 2, max: 2, nulls: 0 } },
    }
    const r = compare(base, swapped, 0.001)
    expect(r.ok).toBe(false)
    expect(r.diffs.join('\n')).toContain('columns')
  })

  it('行数变化 ⇒ fail，且 diff 同时点名两侧', () => {
    const r = compare(baselineOf(1000), { ...baselineOf(1000), rowCount: 2 }, 0.001)
    expect(r.ok).toBe(false)
    expect(r.diffs.join('\n')).toContain('rowCount')
  })

  it('非数值列只比 null 计数：null 计数变化 ⇒ fail', () => {
    const base: Baseline = {
      columns: ['branch'], rowCount: 2,
      summary: { branch: { sum: 0, min: 0, max: 0, nulls: 0, numeric: false } },
    }
    const cur: Baseline = {
      columns: ['branch'], rowCount: 2,
      summary: { branch: { sum: 0, min: 0, max: 0, nulls: 1, numeric: false } },
    }
    const r = compare(base, cur, 0.001)
    expect(r.ok).toBe(false)
    expect(r.diffs.join('\n')).toContain('nulls')
  })

  it('数值列的相对容差按基线绝对值算，且对 0 基线有 1e-9 下限', () => {
    const zero: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: 0, min: 0, max: 0, nulls: 0 } } }
    const tiny: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: 1e-10, min: 0, max: 1e-10, nulls: 0 } } }
    expect(compare(zero, tiny, 0.001).ok).toBe(true)
    const over: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: 2e-9, min: 0, max: 2e-9, nulls: 0 } } }
    expect(compare(zero, over, 0.001).ok).toBe(false)
  })

  it('非有限数值（NaN/Infinity）一律 fail，不静默放过', () => {
    const base: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: 1, min: 1, max: 1, nulls: 0 } } }
    const nan: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: Number.NaN, min: 1, max: 1, nulls: 0 } } }
    const inf: Baseline = { columns: ['v'], rowCount: 1, summary: { v: { sum: 1, min: Number.NEGATIVE_INFINITY, max: 1, nulls: 0 } } }
    expect(compare(base, nan, 0.001).ok).toBe(false)
    expect(compare(base, inf, 0.001).ok).toBe(false)
  })

  it('summary 缺列 / 数值性变化 ⇒ 结构 fail（不给缺省值兜底）', () => {
    const base = baselineOf(1000)
    const missing: Baseline = { columns: ['value'], rowCount: 1, summary: {} }
    expect(compare(base, missing, 0.001).ok).toBe(false)
    const flipped: Baseline = {
      columns: ['value'], rowCount: 1,
      summary: { value: { sum: 0, min: 0, max: 0, nulls: 0, numeric: false } },
    }
    expect(compare(base, flipped, 0.001).ok).toBe(false)
  })

  it('非法容差（负数/NaN）⇒ fail（异常输入不放行）', () => {
    expect(compare(baselineOf(1), baselineOf(1), -0.001).ok).toBe(false)
    expect(compare(baselineOf(1), baselineOf(1), Number.NaN).ok).toBe(false)
  })
})

// ── 重放编排：runRegression（假池 + 假重放，不连库） ─────────────────────────────

/** data.verified_questions 的库行形状（toVerifiedQuestion 要的 snake_case 列）。 */
function questionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, org: ORG, question: '上个月净销售额', metric_id: 'lemeng:retail:net_sales',
    params: {}, slicing: {}, baseline: baselineOf(1000), tolerance: 0.001,
    source: 'human', strength: 'human', status: 'verified',
    verified_by: 'alice', verified_at: '2026-11-01T00:00:00.000Z',
    decided_by: 'alice', decided_at: '2026-11-01T00:00:00.000Z',
    last_checked_at: null, last_check_result: null, session_id: null,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z',
    ...over,
  }
}

/** 假池：只应答 listVerified 的 select 与 recordCheck 的 update；其它 SQL 响亮失败。 */
function fakePool(rows: Record<string, unknown>[]) {
  const selects: { text: string; params: unknown[] }[] = []
  const updates: { text: string; params: unknown[] }[] = []
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/from\s+data\.verified_questions/.test(text)) {
        selects.push({ text, params: params ?? [] })
        return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length }
      }
      if (/update\s+data\.verified_questions/.test(text)) {
        updates.push({ text, params: params ?? [] })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`fake pool: unexpected sql: ${text}`)
    },
  }
  return { pool: pool as unknown as Pool, selects, updates }
}

const depsOf = (pool: Pool, replay: () => Promise<QueryOutcome>) => ({
  pool,
  adoptedSources: new Set<string>(),
  replay: async () => replay(),
})

describe('runRegression', () => {
  it('重放结果与基线一致 ⇒ pass，并把 pass 记回落库（同一 org）', async () => {
    const seen: { requesterUserId: string; org: string; metricId: string }[] = []
    const { pool, selects, updates } = fakePool([
      questionRow({ id: 11, metric_id: 'lemeng:retail:net_sales', params: { bizday: { from: '2026-10-01', to: '2026-10-31' } } }),
    ])
    const results = await runRegression({
      pool,
      adoptedSources: new Set(['lemeng']),
      replay: async (_deps, org, requester, metricId) => {
        seen.push({ requesterUserId: requester?.userId ?? '', org, metricId })
        return ok(['value'], [['1000.5']])
      },
    }, ORG)

    expect(results).toEqual([
      { id: 11, metricId: 'lemeng:retail:net_sales', question: '上个月净销售额', result: 'pass', diffs: [] },
    ])
    // 租户隔离：读与写都带同一个 org
    expect(selects[0]?.params[0]).toBe(ORG)
    expect(updates[0]?.params).toEqual([ORG, 11, 'pass'])
    // 平台回归特权：不走租户会话（requester 身份固定，scopes 空但 hasScope 恒 true）
    expect(seen[0]?.requesterUserId).toBe('(regression)')
    expect(seen[0]?.org).toBe(ORG)
  })

  it('数值超容差 ⇒ fail，diff 带列名与两侧值', async () => {
    const { pool, updates } = fakePool([questionRow({ id: 12 })])
    const results = await runRegression(depsOf(pool, async () => ok(['value'], [['1002']])), ORG)
    expect(results[0]?.result).toBe('fail')
    expect(results[0]?.diffs.join('\n')).toContain('value')
    expect(updates[0]?.params).toEqual([ORG, 12, 'fail'])
  })

  it('重放非 ok（denied/error）⇒ fail，reason 记入 diffs（规则 5）', async () => {
    const { pool, updates } = fakePool([questionRow({ id: 13 })])
    const results = await runRegression(depsOf(pool, async () => ({
      status: 'denied', metricId: 'lemeng:retail:net_sales', reason: 'metric_not_declared',
    })), ORG)
    expect(results[0]?.result).toBe('fail')
    expect(results[0]?.diffs.join('\n')).toContain('metric_not_declared')
    expect(updates[0]?.params).toEqual([ORG, 13, 'fail'])
  })

  it('重放抛异常 ⇒ error（异常与「比对红」可辨），仍记录结果', async () => {
    const { pool, updates } = fakePool([questionRow({ id: 14 })])
    const results = await runRegression(depsOf(pool, async () => {
      throw new Error('warehouse down')
    }), ORG)
    expect(results[0]?.result).toBe('error')
    expect(results[0]?.diffs.join('\n')).toContain('warehouse down')
    expect(updates[0]?.params).toEqual([ORG, 14, 'error'])
  })

  it('ids 过滤与 limit 在重放前生效（CLI --ids / --limit）', async () => {
    const { pool } = fakePool([
      questionRow({ id: 21 }), questionRow({ id: 22 }), questionRow({ id: 23 }),
    ])
    let calls = 0
    const replay = async (): Promise<QueryOutcome> => { calls += 1; return ok(['value'], [['1000']]) }
    const only = await runRegression(depsOf(pool, replay), ORG, { ids: [22] })
    expect(only.map((r) => r.id)).toEqual([22])
    calls = 0
    const limited = await runRegression(depsOf(pool, replay), ORG, { limit: 2 })
    expect(limited.map((r) => r.id)).toEqual([21, 22])
    expect(calls).toBe(2)
  })

  it('零条回归集 ⇒ 空结果（CLI 据此判「无账可查」，不假绿）', async () => {
    const { pool } = fakePool([])
    await expect(runRegression(depsOf(pool, async () => ok(['value'], [['1']])), ORG)).resolves.toEqual([])
  })
})

// ── 装配：loadAdoptedSources（QueryDeps.adoptedSources 必填，不能默认空集） ──────

describe('loadAdoptedSources', () => {
  function fakeExec(tenant: { id: number } | undefined, sources: string[]) {
    const calls: { text: string; params: unknown[] }[] = []
    return {
      calls,
      exec: {
        query: async (text: string, params?: unknown[]) => {
          calls.push({ text, params: params ?? [] })
          if (/from\s+platform\.tenant\b/.test(text)) {
            return { rows: tenant === undefined ? [] : [tenant] }
          }
          if (/from\s+platform\.tenant_source/.test(text)) {
            return { rows: sources.map((source) => ({ source })) }
          }
          throw new Error(`fake exec: unexpected sql: ${text}`)
        },
      },
    }
  }

  it('casdoor_org → tenant_id → 只取 enabled=true 的源', async () => {
    const { exec, calls } = fakeExec({ id: 7 }, ['ama', 'lemeng'])
    const sources = await loadAdoptedSources(exec, 'org-a')
    expect([...sources].sort()).toEqual(['ama', 'lemeng'])
    expect(calls[0]?.params).toEqual(['org-a'])
    expect(calls[1]?.params).toEqual([7])
    expect(calls[1]?.text).toContain('enabled = true')
  })

  it('未知租户 ⇒ 抛错（不明显地退化成空集，避免全量假红）', async () => {
    const { exec } = fakeExec(undefined, [])
    await expect(loadAdoptedSources(exec, 'nope')).rejects.toThrow(/unknown|未知/i)
  })
})

// 类型面自检：questionRow 里的 baseline 必须仍是合法 Baseline（防止夹具漂成别的形状）。
const _typeCheck: VerifiedQuestion['baseline'] = baselineOf(1)
void _typeCheck
