// report-query.test.ts — 报表 args / query body / 对比段装配的单元测试（计划 2026-10-26 Task 2）。
//
// 判据（与 ReportView 的既有行为逐条对齐，抽函数不改语义）：
//  · 期间窗口**最后**写入（规格级当前期间优先于面板自带 bizday）；`timeScoped === false` 不注入；
//  · 门店覆盖只作用于**声明过** `branch_num` 的面板（不静默给其余面板加参）；
//  · 无 slice ⇒ body 只有 `{metricId, args}`（旧规格逐字节一致，不凭空补 `dimensions: []`）；
//  · slice 的 dimensions 回退顺序 = `slice.dimensions` → 面板 dims；两者都空时**不发**；
//  · kpi ⇒ 显式合计（`args.total = true`，前端不对明细行求和）；
//  · 对比段：auto 依期间模式（月 → 上月同日期段；其余 → 等长前移），none / 无期间 ⇒ null。
import { describe, expect, it } from 'vitest'
import type { DataPanel } from './report-query'
import {
  compareRangeOf, comparisonCovered, coverageArgsOf, coverageOfQueryResult, coverageQueryBodyOf,
  panelArgsOf, panelQueryBodyOf,
} from './report-query'
import type { KpiPanel } from './report-spec'

const RANGE = { from: '2026-10-01', to: '2026-10-19' }

const line: DataPanel = {
  chart: 'line', title: '趋势', metricId: 'm', dims: ['bizday'],
  args: { branch_num: '92' }, span: 24, timeScoped: true,
}

describe('panelArgsOf', () => {
  it('期间窗口最后写入；timeScoped=false 不注入', () => {
    expect(panelArgsOf(line, RANGE, '93')).toEqual({
      branch_num: '93',
      bizday: { from: '2026-10-01', to: '2026-10-19' },
    })
    const fixed: DataPanel = { ...line, timeScoped: false }
    expect(panelArgsOf(fixed, RANGE, '93')).toEqual({ branch_num: '93' })
  })

  it('branch 只覆盖声明过的面板；无期间 ⇒ 不动 bizday', () => {
    // 未声明 branch_num 的面板：branchNum 不注入（筛选栏只在规格 args 声明过的键上覆盖）
    const noBranch: DataPanel = { ...line, args: { system_book: '3120' } }
    expect(panelArgsOf(noBranch, null, '93')).toEqual({ system_book: '3120' })
    // 无期间 ⇒ 不注入 bizday（面板自带 bizday 原样保留）
    const own: DataPanel = {
      ...line,
      args: { bizday: { from: '2026-01-01', to: '2026-01-31' } },
    }
    expect(panelArgsOf(own, null)).toEqual({ bizday: { from: '2026-01-01', to: '2026-01-31' } })
  })
})

describe('panelQueryBodyOf', () => {
  it('无 slice ⇒ 只有 {metricId, args}（旧规格逐字节一致）', () => {
    expect(panelQueryBodyOf(line, { system_book: '3120' })).toEqual({
      metricId: 'm',
      args: { system_book: '3120' },
    })
  })

  it('slice ⇒ 追加 dimensions/orderBy/limit；dimensions 回落到面板 dims', () => {
    const bar: DataPanel = {
      chart: 'bar', title: 't', metricId: 'm', dims: ['cause'], args: {}, span: 24, timeScoped: true,
      slice: { dimensions: ['cause'], orderBy: [{ column: 'cause', dir: 'asc' }], limit: 10 },
    }
    expect(panelQueryBodyOf(bar, {})).toEqual({
      metricId: 'm',
      args: {},
      dimensions: ['cause'],
      orderBy: [{ column: 'cause', dir: 'asc' }],
      limit: 10,
    })
    // slice 未声明 dimensions ⇒ 回落到面板 dims（否则静默变成「不分组的单行合计」）
    const fallback: DataPanel = { ...bar, slice: { limit: 5 } }
    expect(panelQueryBodyOf(fallback, {})).toEqual({
      metricId: 'm', args: {}, dimensions: ['cause'], limit: 5,
    })
    // 两者都空 ⇒ 不发 dimensions（空数组 = 显式合计，与「没声明分组」语义不同）
    const empty: DataPanel = { ...bar, dims: [], slice: { limit: 5 } }
    expect(panelQueryBodyOf(empty, {})).toEqual({ metricId: 'm', args: {}, limit: 5 })
  })

  it('kpi ⇒ 显式合计（args.total = true）', () => {
    const kpi: KpiPanel = {
      chart: 'kpi', title: 't', metricId: 'm', format: 'number', span: 12,
      timeScoped: true, compare: 'auto', goodDirection: 'none', args: {},
    }
    expect(panelQueryBodyOf(kpi, { branch_num: '92' })).toEqual({
      metricId: 'm',
      args: { branch_num: '92', total: true },
    })
  })
})

describe('compareRangeOf', () => {
  const kpi: KpiPanel = {
    chart: 'kpi', title: '客单价', metricId: 'sales', format: 'currency', span: 12,
    timeScoped: true, compare: 'auto', goodDirection: 'up', args: {},
  }

  it('auto 依期间模式：month → prev_month；其余 → prev_period', () => {
    expect(compareRangeOf(kpi, 'month', RANGE)).toEqual({ from: '2026-09-01', to: '2026-09-19' })
    expect(compareRangeOf(kpi, 'custom', RANGE)).toEqual({ from: '2026-09-12', to: '2026-09-30' })
    expect(compareRangeOf(kpi, 'last_7_days', RANGE)).toEqual({ from: '2026-09-12', to: '2026-09-30' })
  })

  it('指定口径原样生效；none / 无期间 ⇒ null', () => {
    expect(compareRangeOf({ ...kpi, compare: 'prev_month' }, 'custom', RANGE))
      .toEqual({ from: '2026-09-01', to: '2026-09-19' })
    expect(compareRangeOf({ ...kpi, compare: 'none' }, 'month', RANGE)).toBeNull()
    expect(compareRangeOf(kpi, 'month', null)).toBeNull()
  })
})

// 对比可用性 = 数据覆盖度（issue #1078）：判据是「对比期整段落在指标已有数据范围内」，
// 不是「对比期查询得数」——后者在只覆盖了一部分时也会得数，于是产出假环比。
describe('coverageArgsOf / coverageQueryBodyOf', () => {
  it('覆盖探测去掉期间窗口与 total，保留其余过滤参数', () => {
    const args = { system_book: '3120', branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-19' }, total: true }
    expect(coverageArgsOf(args)).toEqual({ system_book: '3120', branch_num: '92' })
  })

  it('body 走**明细形态**（不发 dimensions）：子集聚合的 orderBy 会被组装器丢掉，earliest 就不可靠', () => {
    const body = coverageQueryBodyOf('m', { branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-19' } })
    expect(body).toEqual({
      metricId: 'm',
      args: { branch_num: '92' },
      orderBy: [{ column: 'bizday', dir: 'asc' }],
      limit: 1,
    })
    expect(body).not.toHaveProperty('dimensions')
  })
})

describe('coverageOfQueryResult', () => {
  it('取最早 bizday 与水位 watermark；水位缺席 ⇒ to=null（只判起点）', () => {
    expect(coverageOfQueryResult({
      status: 'ok',
      columns: ['value', 'business_day', 'bizday'],
      rows: [['15938.60', 'x', '2026-09-23T00:00:00.000Z']],
      watermark: '2026-10-26',
    })).toEqual({ from: '2026-09-23', to: '2026-10-26' })
    expect(coverageOfQueryResult({
      status: 'ok', columns: ['bizday'], rows: [['2026-09-23']],
    })).toEqual({ from: '2026-09-23', to: null })
  })

  it('失败 / 空集 / 没有 bizday 列 / 坏形状 ⇒ null（宁可不出对比，不出假数）', () => {
    expect(coverageOfQueryResult({ status: 'denied', columns: ['bizday'], rows: [['2026-09-23']] })).toBeNull()
    expect(coverageOfQueryResult({ status: 'ok', columns: ['bizday'], rows: [] })).toBeNull()
    expect(coverageOfQueryResult({ status: 'ok', columns: ['value'], rows: [[1]] })).toBeNull()
    expect(coverageOfQueryResult({ status: 'ok', columns: ['bizday'], rows: [['not-a-day']] })).toBeNull()
    expect(coverageOfQueryResult(null)).toBeNull()
  })
})

describe('comparisonCovered', () => {
  const PREV = { from: '2026-09-12', to: '2026-09-30' }

  it('对比期起点早于数据起点 ⇒ 不完整（本 issue 的现场：9-12 < 9-23）', () => {
    expect(comparisonCovered(PREV, { from: '2026-09-23', to: '2026-10-26' })).toBe(false)
  })

  it('整段落在覆盖范围内 ⇒ 可用（含边界日）', () => {
    expect(comparisonCovered(PREV, { from: '2026-09-01', to: '2026-10-26' })).toBe(true)
    expect(comparisonCovered(PREV, { from: '2026-09-12', to: '2026-09-30' })).toBe(true)
  })

  it('对比期末尾超过水位 ⇒ 不完整（尾段没物化完）', () => {
    expect(comparisonCovered(PREV, { from: '2026-09-01', to: '2026-09-20' })).toBe(false)
  })

  it('覆盖未知（探测失败）⇒ 不出对比', () => {
    expect(comparisonCovered(PREV, null)).toBe(false)
  })
})
