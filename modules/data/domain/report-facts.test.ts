// report-facts.test.ts — 事实包（计划 2026-10-26 Task 5；设计 spec §4.3）。
//
// 判据（每条都对应设计里一句硬约束）：
//  · **只经 `runQuery` 取数**：词表加载/授权/审计走真库真链路，只有「仓库 SQL 真跑」这一步
//    换成假执行器（与 query-service.test.ts 同一姿态）——事实包里不该有第二条 SQL 通道。
//  · **KPI = 分子/分母各自合计再相除**：比率型指标绝不先除后加；对比段按 `compare` 口径重查。
//  · **事实里的数值不带货币符号**（spec §4.3 示例：currency 面板在 facts 里是 `51,273.89`，
//    `¥` 是卡片上的展示装饰）——这条是模板/模型数字一致的前提，掉了它模型会写两种形状。
//  · **日趋势取第一个 line 面板**的日最低/最高（多 line 面板时混算会造出不属于任何指标的值）。
//  · **拆解按数值降序**：模板说「报损**最大**原因」= rows[0]，顺序不能交给报表写的 orderBy。
//  · **dataAsOf 取最早**；查询失败的 panel 进 `missing` 且 KPI 写 `-` —— 不编数。
//  · **numbers 只含事实里的格式化值与期间日期**；`factsHash` 对同一事实稳定、对变值敏感。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import type { MetricDef, Requester } from './authz'
import { upsertMetric } from './metric-store'
import type { SqlExecutor } from './query-service'
import { buildFacts, earliestDataAsOf } from './report-facts'
import { parseReportSpec, type PeriodSpec, type ReportSpec } from './report-spec'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** 隔离键（text，值 = Casdoor org）：与其它测试文件不同，避免互相擦数据。 */
const ORG = 'org-report-facts'
const PERIOD: PeriodSpec = { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }
/** 对比段（`prev_period`，19 天）= 2026-09-12..2026-09-30；假执行器按 SQL 里的起始日区分本期/对比期。 */
const PREV_MARK = "'2026-09-12'"
/** runQuery 的 data_as_of 呈现是定长北京时间串（spec §10.6），事实包原样转交、不再格式化。 */
const AS_OF = '2026-10-25 06:00:00 +08:00'
const AS_OF_INSTANT = new Date('2026-10-24T22:00:00Z') // = 北京时间 2026-10-25 06:00

const PARAMS = {
  bizday: { column: 'bizday', type: 'date_range' as const },
  branch_num: { column: 'branch_num', type: 'string' as const },
  system_book: { column: 'system_book', type: 'string' as const },
}

/** 词表夹具：select_sql 里埋一个特征列名，假执行器按它区分指标（SQL 其余部分由授权核心生成）。 */
function metric(over: Partial<MetricDef> & Pick<MetricDef, 'id'>): MetricDef {
  return {
    title: over.id, description: '', requiredScope: 'data:query',
    subjectColumn: 'org', selectSql: 'SELECT org FROM marts.facts_none', groupBy: '',
    params: PARAMS, ...over,
  }
}

const METRICS: MetricDef[] = [
  // select_sql 照真实 L1 形态（`select <聚合表达式> as value, <粒度>`）：切片维度 = 粒度时
  // 授权核心直接把这条 SQL 加上 WHERE/GROUP BY/LIMIT 下发，**不**再包一层 —— 回包列名就是
  // `value` + 粒度列，事实包按列名取值。
  metric({
    id: 'rf:net_sales', title: '销售额', groupBy: 'bizday',
    selectSql: 'SELECT sum(net_amount) AS value, bizday FROM marts.facts_sales',
  }),
  metric({
    id: 'rf:order_count', title: '订单数',
    selectSql: 'SELECT sum(order_count) AS value FROM marts.facts_orders',
  }),
  metric({
    id: 'rf:vip_money', title: '会员销售',
    selectSql: 'SELECT sum(vip_money) AS value FROM marts.facts_member',
  }),
  metric({
    id: 'rf:loss_amount', title: '报损金额', groupBy: 'cause',
    selectSql: 'SELECT sum(loss_money) AS value, cause FROM marts.facts_loss',
  }),
  // 持码者才可见（`visibleMetrics` 在 authorize 之前裁掉）⇒ 事实包必须记 missing，不能编数。
  metric({
    id: 'rf:secret', title: '受限指标', requiredScope: 'data:manage',
    selectSql: 'SELECT sum(secret_metric) AS value FROM marts.facts_secret',
  }),
]

/** 报表规格：覆盖 KPI 合计/比率/对比、日趋势、拆解、受限面板、ai_text 自身。 */
function specOf(): ReportSpec {
  const parsed = parseReportSpec({
    period: PERIOD,
    panels: [
      { chart: 'kpi', title: '销售额', metricId: 'rf:net_sales', format: 'currency', compare: 'prev_period', args: { system_book: '3120', branch_num: '92' } },
      { chart: 'kpi', title: '订单数', metricId: 'rf:order_count', format: 'number', compare: 'prev_period', args: { system_book: '3120', branch_num: '92' } },
      { chart: 'kpi', title: '会员销售占比', metricId: 'rf:vip_money', denominatorMetricId: 'rf:net_sales', format: 'percent', compare: 'prev_period', args: { system_book: '3120', branch_num: '92' } },
      { chart: 'kpi', title: '受限指标', metricId: 'rf:secret', format: 'number', args: {} },
      { chart: 'line', title: '销售额日趋势', metricId: 'rf:net_sales', dims: ['bizday'], slice: { dimensions: ['bizday'] }, args: { system_book: '3120', branch_num: '92' } },
      { chart: 'bar', title: '报损金额（按原因）', metricId: 'rf:loss_amount', dims: ['cause'], slice: { dimensions: ['cause'] }, args: { system_book: '3120', branch_num: '92' } },
      { chart: 'ai_text', title: '本月结论', focus: 'overview' },
    ],
  })
  if (!parsed.ok) throw new Error(`spec 夹具不合法：${parsed.code}`)
  return parsed.spec
}

interface Values {
  net: number
  netPrev: number
  orders: number
  ordersPrev: number
  vip: number
  vipPrev: number
  /** 故意**降序颠倒**（来货损在前）：事实包必须按值降序重排，rows[0] 才是「最大原因」。 */
  loss: Array<[string, number]>
}

const VALUES: Values = {
  net: 51273.89, netPrev: 48000,
  orders: 957, ordersPrev: 900,
  vip: 24284.39, vipPrev: 20000,
  loss: [['来货损', 259.16], ['自然损', 387.64]],
}

/**
 * 假仓库执行器：按授权核心生成的 SQL 形状回数（不真跑 DuckDB）。
 * 判据两处：显式合计的外层形状 `SELECT sum(value) AS total`（KPI），以及与粒度等价的
 * 原 select_sql（line/bar 的切片）。指标再按 select_sql 里的特征列名区分；
 * **不**按调用顺序/次数匹配（脆弱且会把错配变成假绿）。
 */
function execWith(v: Values): SqlExecutor {
  const total = (n?: number) => ({ columns: ['total'], rows: [[n ?? null]] })
  return async (sql) => {
    // 辅助读先匹配：新鲜度与维度名称解析走同一个执行缝（deps.warehouseExec = deps.execute）
    if (sql.includes('data.load_log')) return { columns: ['data_as_of'], rows: [[AS_OF_INSTANT]] }
    if (sql.includes('dim_brand') || sql.includes('stg_lemeng_branch') || sql.includes('dim_region')) {
      return { columns: [], rows: [] }
    }
    const prev = sql.includes(PREV_MARK)
    if (sql.startsWith('SELECT sum(value) AS total')) {
      if (sql.includes('net_amount')) return total(prev ? v.netPrev : v.net)
      if (sql.includes('order_count')) return total(prev ? v.ordersPrev : v.orders)
      if (sql.includes('vip_money')) return total(prev ? v.vipPrev : v.vip)
    }
    if (sql.includes('marts.facts_sales')) {
      return { columns: ['bizday', 'value'], rows: [['2026-10-13', 875.59], ['2026-10-16', 3564.8]] }
    }
    if (sql.includes('marts.facts_loss')) {
      return { columns: ['cause', 'value'], rows: v.loss }
    }
    return { columns: [], rows: [] }
  }
}

function requester(): Requester {
  const scopes = ['data:query']
  return {
    userId: 'u-facts', orgId: ORG, channel: 'session', keyId: null, scopes,
    hasScope: (c) => scopes.includes(c),
  }
}

const pool = new Pool({ connectionString: dbUrl })

function depsOf(execute: SqlExecutor) {
  return {
    pool, org: ORG, requester: requester(), adoptedSources: new Set(['lemeng']), execute,
    reportTitle: '熊喵曲靖沾益2店 · 2026年10月经营月报（10-01..19）', specKey: 'published:2',
  }
}

describe('earliestDataAsOf（纯函数）', () => {
  it('取字典序最早（同格式下即时间最早）；空集 ⇒ null', () => {
    expect(earliestDataAsOf(['2026-10-25 06:00:00 +08:00', '2026-10-24 23:00:00 +08:00']))
      .toBe('2026-10-24 23:00:00 +08:00')
    expect(earliestDataAsOf([])).toBeNull()
  })
})

describePg('buildFacts（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.metrics where org = $1', [ORG])
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    for (const m of METRICS) await upsertMetric(pool, ORG, m, 'fixture')
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('KPI 合计/比率/对比、日极值、拆解、dataAsOf、numbers、missing', async () => {
    const spec = specOf()
    const aiIndex = spec.panels.findIndex((p) => p.chart === 'ai_text')
    const facts = await buildFacts(depsOf(execWith(VALUES)), spec, aiIndex, PERIOD, '92')

    // ── 骨架 ──
    expect(facts.reportTitle).toBe('熊喵曲靖沾益2店 · 2026年10月经营月报（10-01..19）')
    expect(facts.specKey).toBe('published:2')
    expect(facts.focus).toBe('overview')
    expect(facts.period).toEqual({ from: '2026-10-01', to: '2026-10-19', label: '2026-10-01 ~ 2026-10-19' })
    expect(facts.branchNum).toBe('92')
    expect(facts.dates).toEqual(['2026-10-01', '2026-10-19'])
    expect(facts.dataAsOf).toBe(AS_OF)

    // ── KPI：合计（currency 不带 ¥）/ 对比相对变化率 ──
    expect(facts.kpis.find((k) => k.panel === '销售额')).toEqual({
      panel: '销售额', metricId: 'rf:net_sales', format: 'currency',
      current: '51,273.89', previous: '48,000.00', delta: '+6.8%',
    })
    expect(facts.kpis.find((k) => k.panel === '订单数')).toEqual({
      panel: '订单数', metricId: 'rf:order_count', format: 'number',
      current: '957', previous: '900', delta: '+6.3%',
    })

    // ── KPI：比率 = 分子合计 / 分母合计；对比给百分点（pp） ──
    //    24284.39 / 51273.89 = 0.473621… → 47.36%；20000 / 48000 = 0.416666… → 41.67%
    expect(facts.kpis.find((k) => k.panel === '会员销售占比')).toEqual({
      panel: '会员销售占比', metricId: 'rf:vip_money', format: 'percent',
      current: '47.36%', previous: '41.67%', delta: '+5.70pp',
    })

    // ── 查询失败（无码）：KPI 写 `-`，面板进 missing ──
    expect(facts.kpis.find((k) => k.panel === '受限指标')).toEqual({
      panel: '受限指标', metricId: 'rf:secret', format: 'number',
      current: '-', previous: null, delta: '-',
    })
    expect(facts.missing).toEqual(['受限指标'])

    // ── 日趋势：最低/最高销售日（currency 两位小数，不带 ¥） ──
    expect(facts.daily).toEqual({
      min: { day: '2026-10-13', value: '875.59' },
      max: { day: '2026-10-16', value: '3,564.80' },
    })

    // ── 拆解：按值降序（报表给的顺序是来货损在前）；维度名与行标签取自面板声明 ──
    expect(facts.breakdowns).toEqual([{
      panel: '报损金额（按原因）',
      dimension: 'cause',
      rows: [{ label: '自然损', value: '387.64' }, { label: '来货损', value: '259.16' }],
    }])

    // ── numbers：只含事实里的格式化值与期间日期，且**不含**货币符号 ──
    for (const n of ['51,273.89', '48,000.00', '+6.8%', '47.36%', '+5.70pp', '875.59', '3,564.80', '387.64', '2026-10-01', '2026-10-19']) {
      expect(facts.numbers).toContain(n)
    }
    expect(facts.numbers.some((n) => n.startsWith('¥'))).toBe(false)
    expect(facts.numbers).not.toContain('-')

    // ── 事实只经 /query：审计真落库（没有第二条 SQL 通道） ──
    const audit = await pool.query(
      "select count(*)::int as n from data.query_audit where org = $1 and metric_id = 'rf:net_sales' and verdict = 'ok'",
      [ORG],
    )
    expect(audit.rows[0].n).toBeGreaterThan(0)
  })

  it('factsHash：同一事实稳定；数值变一位即变', async () => {
    const spec = specOf()
    const aiIndex = spec.panels.findIndex((p) => p.chart === 'ai_text')
    const a = await buildFacts(depsOf(execWith(VALUES)), spec, aiIndex, PERIOD, '92')
    const b = await buildFacts(depsOf(execWith(VALUES)), spec, aiIndex, PERIOD, '92')
    const c = await buildFacts(depsOf(execWith({ ...VALUES, net: 51273.9 })), spec, aiIndex, PERIOD, '92')

    expect(a.factsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.factsHash).toBe(a.factsHash)
    expect(c.factsHash).not.toBe(a.factsHash)
  })

  it('合计为空 ≠ 取数失败：值写 "-"，但不进 missing（"本期没有"是事实）', async () => {
    const parsed = parseReportSpec({
      panels: [
        { chart: 'kpi', title: '订单数', metricId: 'rf:order_count', format: 'number', args: { branch_num: '92' } },
        { chart: 'ai_text', title: '结论', focus: 'overview' },
      ],
    })
    if (!parsed.ok) throw new Error(parsed.code)
    const base = execWith(VALUES)
    const emptyTotal: SqlExecutor = async (sql) =>
      sql.startsWith('SELECT sum(value) AS total') && sql.includes('order_count')
        ? { columns: ['total'], rows: [[null]] }
        : base(sql)

    const facts = await buildFacts(depsOf(emptyTotal), parsed.spec, 1, PERIOD, '92')
    expect(facts.kpis[0]).toMatchObject({ current: '-', previous: null, delta: '-' })
    expect(facts.missing).toEqual([])
    expect(facts.numbers).not.toContain('-')
  })

  it('timeScoped=false 的 KPI 不做对比（固定窗口不拿报表期间的前移段去比）', async () => {
    const parsed = parseReportSpec({
      panels: [
        { chart: 'kpi', title: '会员销售', metricId: 'rf:vip_money', format: 'currency', timeScoped: false, args: { branch_num: '92' } },
        { chart: 'ai_text', title: '结论', focus: 'overview' },
      ],
    })
    if (!parsed.ok) throw new Error(parsed.code)

    const facts = await buildFacts(depsOf(execWith(VALUES)), parsed.spec, 1, PERIOD, '92')
    expect(facts.kpis[0]).toMatchObject({ current: '24,284.39', previous: null, delta: '-' })
  })

  it('panelIndex 不是 ai_text ⇒ NOT_AI_TEXT_PANEL（不查任何数）', async () => {
    const spec = specOf()
    await expect(buildFacts(depsOf(execWith(VALUES)), spec, 0, PERIOD, '92'))
      .rejects.toThrow('NOT_AI_TEXT_PANEL')
  })
})
