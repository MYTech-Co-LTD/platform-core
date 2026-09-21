import { describe, expect, it } from 'vitest'
import {
  MAX_QUERY_ROWS, authorize, sqlQuote, visibleMetrics,
  type MetricDef, type MetricParamType, type Requester,
} from './authz'

// 词表形状照 /tmp/iam-lab/mcp_authz_server.py 的 CATALOG（原型实测 11/11 的那份）
const CATALOG: MetricDef[] = [
  {
    id: 'mart_sales_daily',
    title: '销售日明细',
    description: '按主体分日的销售明细',
    requiredScope: 'data:query',
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, category, revenue, orders FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date' }, day_to: { column: 'day', type: 'date' } },
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
    expect(visibleMetrics(CATALOG, req()).map((m) => m.id))
      .toEqual(['mart_sales_daily', 'metrics_revenue_mom'])
  })

  it('B1 只有部分码 → 只见到对应子集', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: ['data:finance'] })).map((m) => m.id))
      .toEqual(['finance_margin'])
  })

  it('C1 无任何码 → 词表为空（fail-closed）', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: [] }))).toEqual([])
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
    // 挡不住运行时数据（可达路径：T3 loadCatalog 未校验 DB 里的 type 值就放进词表）。
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
