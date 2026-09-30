import { describe, expect, it } from 'vitest'
import {
  MAX_QUERY_ROWS, authorize, sqlQuote, visibleMetrics,
  type MetricDef, type MetricParamType, type Requester, type SourceTaggedMetric,
} from './authz'

/** 本文件默认租户**已接入的源**（当前唯一已接入源 = lemeng；`lemeng` 之外的源都没接）。 */
const LEMENG = new Set(['lemeng'])

// 词表形状照 /tmp/iam-lab/mcp_authz_server.py 的 CATALOG（原型实测 11/11 的那份）。
// 每行带 `sourceSystem`：裁剪（visibleMetrics）的第三参读它，故这里的类型是
// `SourceTaggedMetric`（= MetricDef + 源维度）；`authorize` 仍只认 MetricDef（子类型可传）。
const CATALOG: SourceTaggedMetric[] = [
  {
    id: 'mart_sales_daily',
    title: '销售日明细',
    description: '按主体分日的销售明细',
    requiredScope: 'data:query',
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, category, revenue, orders FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date' }, day_to: { column: 'day', type: 'date' } },
    sourceSystem: 'lemeng',
  },
  {
    id: 'metrics_revenue_mom',
    title: '主体收入汇总',
    description: '主体收入汇总',
    requiredScope: 'data:query',
    subjectColumn: 'org',
    selectSql: 'SELECT org, round(sum(revenue)) AS revenue, count(*) AS rows FROM marts.mart_sales_daily',
    groupBy: 'org',
    params: {},
    sourceSystem: 'lemeng',
  },
  {
    id: 'finance_margin',
    title: '毛利',
    description: '仅财务可见',
    requiredScope: 'data:finance',
    subjectColumn: 'org',
    selectSql: 'SELECT org, margin FROM marts.mart_margin',
    groupBy: 'org',
    params: {},
    sourceSystem: 'lemeng',
  },
]

function req(over: Partial<Requester> = {}): Requester {
  const scopes = over.scopes ?? ['data:query']
  return {
    userId: 'alice',
    orgId: 'org_a_lemeng',
    channel: 'session',
    keyId: null,
    scopes,
    hasScope: (code) => scopes.includes(code),
    ...over,
  }
}

describe('visibleMetrics —— 词表裁剪（看不见，不是报错）', () => {
  it('A1 有 data:query → 见两条 query 指标，看不见 finance 那条', () => {
    expect(visibleMetrics(CATALOG, req(), LEMENG).map((m) => m.id))
      .toEqual(['mart_sales_daily', 'metrics_revenue_mom'])
  })

  it('B1 只有部分码 → 只见到对应子集', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: ['data:finance'] }), LEMENG).map((m) => m.id))
      .toEqual(['finance_margin'])
  })

  it('C1 无任何码 → 词表为空（fail-closed）', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: [] }), LEMENG)).toEqual([])
  })
})

describe('visibleMetrics —— 源维度裁剪（spec §3⑧：未接入源的指标看不见）', () => {
  /**
   * 三行词表，正是「源维度」的三种行形状：
   *   · 已接入源（lemeng）的 L1 —— 本租户接了 ⇒ 可见；
   *   · 未接入源（shanhai）的 L1 —— 存在、但本租户没接 ⇒ **不可见**（是「看不见」不是报错）；
   *   · L2 行（`sourceSystem: null`）—— 本租户自己写的、没有源维度 ⇒ **恒可见**。
   * 这三条是 Task 2 转办来的断言要求（此前「三态」只有类型把守、没有消费方）：
   * 每条各断言一次，任何一条语义漂掉都必须在这里红。
   */
  const SOURCED: SourceTaggedMetric[] = [
    { ...CATALOG[0]!, id: 'l1_lemeng', sourceSystem: 'lemeng' },
    { ...CATALOG[0]!, id: 'l1_shanhai', sourceSystem: 'shanhai' },
    { ...CATALOG[1]!, id: 'l2_mine', sourceSystem: null },
  ]

  it('★ 三态：已接入源的 L1 可见 / 未接入源的 L1 不可见 / L2 行恒可见', () => {
    const ids = visibleMetrics(SOURCED, req(), LEMENG).map((m) => m.id)
    // (a) 已接入源（lemeng）的 L1 行 ⇒ 可见
    expect(ids, '已接入源的 L1 行不可见 ⇒ 平台指标对租户整条消失').toContain('l1_lemeng')
    // (b) 未接入源（shanhai）的 L1 行 ⇒ 不可见（裁剪，不是报错）
    expect(ids, '未接入源的 L1 行可见 ⇒ 源维度没被裁（agent 会看到别的源的指标）').not.toContain('l1_shanhai')
    // (c) L2 行（sourceSystem === null）⇒ 恒可见（它是本租户自己写的，没有源维度）
    expect(ids, 'L2 行被按源裁掉了 ⇒ 租户自己声明过的指标把自己裁没了').toContain('l2_mine')
  })

  it('一个源都没接（空集）⇒ 只剩 L2 行（L1 一律裁掉，不是报错）', () => {
    expect(visibleMetrics(SOURCED, req(), new Set()).map((m) => m.id)).toEqual(['l2_mine'])
  })

  it('裁源与裁 scope 是**同一条** filter（两个条件都要满足才可见）', () => {
    // 已接入源但有 data:finance 门槛的行：只有 data:query ⇒ 依然不可见（源接了不等于越权）
    const both: SourceTaggedMetric[] = [
      { ...CATALOG[2]!, id: 'l1_lemeng_finance', sourceSystem: 'lemeng' },
    ]
    expect(visibleMetrics(both, req(), LEMENG)).toEqual([])
  })
})

describe('authorize —— 主体钉死', () => {
  it('A2 正常查：SQL 只含本主体，且带 LIMIT', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.subject).toBe('org_a_lemeng')
    expect(r.plan.sql).toContain("WHERE org = 'org_a_lemeng'")
    expect(r.plan.sql).toContain('GROUP BY org')
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
  })

  it('A3 带日期参数：拼成参数化过滤，且值被引号包裹', () => {
    const r = authorize(CATALOG, req(), 'mart_sales_daily', {
      day_from: '2026-08-15', day_to: '2026-08-20',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // ⚠️ 谓词是 `=` 不是 `>=`/`<=`：本计划只支持等值参数（见下方注记）。
    //    这条用例断言的是「参数落到正确的列 + 值被字面量转义」，不是区间语义。
    //    ⚠️ 副作用要知道：同一列上两个 `=`（day = A AND day = B）恒为空集——
    //    所以 `day_from` / `day_to` **不要同时传**（本计划范围内不提供区间能力）。
    expect(r.plan.sql).toContain("AND day = '2026-08-15'::date")
    expect(r.plan.sql).toContain("AND day = '2026-08-20'::date")
  })

  it('A4 注入他人主体参数 → subject_pinned_by_platform（值只来自身份）', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { org: 'org_b_demo' })
    expect(r).toEqual({ ok: false, reason: 'subject_pinned_by_platform', metricId: 'metrics_revenue_mom' })
  })

  it('A5 六个保留键逐个都拒（不是只挡 org 一个）', () => {
    for (const k of ['org', 'subject', 'tenant', 'tenant_id', 'org_id', 'casdoor_org']) {
      const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { [k]: 'org_b_demo' })
      expect(r.ok, `保留键 ${k} 必须被拒`).toBe(false)
      if (!r.ok) expect(r.reason).toBe('subject_pinned_by_platform')
    }
  })

  it('B3 未声明指标 → metric_not_declared（先于授权判定）', () => {
    const r = authorize(CATALOG, req(), 'nope', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_declared', metricId: 'nope' })
  })

  it('C2 scope 不足 → metric_not_authorized', () => {
    const r = authorize(CATALOG, req({ scopes: [] }), 'metrics_revenue_mom', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_authorized', metricId: 'metrics_revenue_mom' })
  })

  it('未声明的参数键 → bad_param（客户端不能塞任意列名进 SQL）', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { evil: '1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('非法日期字面量 → bad_param（引号是拼的，格式必须先验）', () => {
    const r = authorize(CATALOG, req(), 'mart_sales_daily', { day_from: "2026-08-15' OR 1=1 --" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('越界 type（词表里的 DATE）→ bad_param —— 这条锁的是 fail-closed，不是锁异常', () => {
    // 锁的是**语义**：任何 literal() 无法安全转义的参数值都必须被拒（reason: bad_param），
    // **不是**「别抛异常」。因为最坏的形态恰恰是不抛也不拒——
    // 越界 type 穿透 switch 会返回 `undefined`，而调用方判据是 `lit === null`，
    // `undefined === null` 为 false ⇒ 被当合法值放行 ⇒ ok:true + `AND day = undefined`（SQL 必炸）。
    // 故断言必须落在「被拒 + reason 可解释」上；只断言「没抛错」会漏掉这个缺陷。
    // `as unknown as` 是**故意**越过闭合 union 的类型约束：类型层挡得住编译期字面量，
    // 挡不住运行时数据（可达路径：T3 loadOrgCatalog 未校验 DB 里的 type 值就放进词表）。
    const cat: MetricDef[] = [{
      ...CATALOG[1],
      params: { day: { column: 'day', type: 'DATE' as unknown as MetricParamType } },
    }]
    const r = authorize(cat, req(), 'metrics_revenue_mom', { day: '2026-08-15' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('单引号被转义（sqlQuote 双写）', () => {
    expect(sqlQuote("a'b")).toBe("'a''b'")
  })
})

describe('maxTurns/上限类不变量', () => {
  it('未知参数类型也走 bad_param 而不是静默忽略', () => {
    const cat: MetricDef[] = [{
      ...CATALOG[1], params: { n: { column: 'n', type: 'number' } },
    }]
    expect(authorize(cat, req(), 'metrics_revenue_mom', { n: 'abc' }).ok).toBe(false)
    expect(authorize(cat, req(), 'metrics_revenue_mom', { n: 3 }).ok).toBe(true)
  })
})
