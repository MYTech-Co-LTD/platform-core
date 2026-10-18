import { describe, expect, it } from 'vitest'
import {
  MAX_QUERY_ROWS, authorize, sqlQuote, visibleMetrics,
  type MaskSpec, type MetricDef, type MetricParamType, type Requester, type SourceTaggedMetric,
} from './authz'

/**
 * 本文件里**没有可见性裁剪**的用例：掩码词表 = 可见词表。
 *
 * ⚠️ 显式表达，**不靠默认值**——`authorize` 的第 5 参已改为**必填**（默认成 `catalog` 会让
 *    「忘了传」= 拿裁剪过的词表解析掩码 ⇒ L2 洞静默重开，且编译与测试都不报）。
 *    真要造「两份词表不同」的场景，**直接调 `authorize`**，别用这个 helper。
 */
const authorizeVisible = (
  catalog: MetricDef[],
  requester: Requester,
  metricId: string,
  args: Record<string, unknown>,
) => authorize(catalog, requester, metricId, args, catalog)

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
    const r = authorizeVisible(CATALOG, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.subject).toBe('org_a_lemeng')
    expect(r.plan.sql).toContain("WHERE org = 'org_a_lemeng'")
    expect(r.plan.sql).toContain('GROUP BY org')
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
  })

  it('A3 带日期参数：拼成参数化过滤，且值被引号包裹', () => {
    const r = authorizeVisible(CATALOG, req(), 'mart_sales_daily', {
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
    const r = authorizeVisible(CATALOG, req(), 'metrics_revenue_mom', { org: 'org_b_demo' })
    expect(r).toEqual({ ok: false, reason: 'subject_pinned_by_platform', metricId: 'metrics_revenue_mom' })
  })

  it('A5 六个保留键逐个都拒（不是只挡 org 一个）', () => {
    for (const k of ['org', 'subject', 'tenant', 'tenant_id', 'org_id', 'casdoor_org']) {
      const r = authorizeVisible(CATALOG, req(), 'metrics_revenue_mom', { [k]: 'org_b_demo' })
      expect(r.ok, `保留键 ${k} 必须被拒`).toBe(false)
      if (!r.ok) expect(r.reason).toBe('subject_pinned_by_platform')
    }
  })

  it('B3 未声明指标 → metric_not_declared（先于授权判定）', () => {
    const r = authorizeVisible(CATALOG, req(), 'nope', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_declared', metricId: 'nope' })
  })

  it('C2 scope 不足 → metric_not_authorized', () => {
    const r = authorizeVisible(CATALOG, req({ scopes: [] }), 'metrics_revenue_mom', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_authorized', metricId: 'metrics_revenue_mom' })
  })

  it('未声明的参数键 → bad_param（客户端不能塞任意列名进 SQL）', () => {
    const r = authorizeVisible(CATALOG, req(), 'metrics_revenue_mom', { evil: '1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('非法日期字面量 → bad_param（引号是拼的，格式必须先验）', () => {
    const r = authorizeVisible(CATALOG, req(), 'mart_sales_daily', { day_from: "2026-08-15' OR 1=1 --" })
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
    const r = authorizeVisible(cat, req(), 'metrics_revenue_mom', { day: '2026-08-15' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('单引号被转义（sqlQuote 双写）', () => {
    expect(sqlQuote("a'b")).toBe("'a''b'")
  })
})

describe('authorize —— date_range 区间参数（spec 2026-10-15 §2.3）', () => {
  // 夹具构造照上方「越界 type」用例的现成形状（CATALOG[1] + params 覆写），仅 params 不同：
  const rangeMetric = { params: { bizday: { column: 'bizday', type: 'date_range' as const } } }
  const cat: MetricDef[] = [{ ...CATALOG[1], ...rangeMetric }]

  it('R1 合法区间 → BETWEEN 闭区间 SQL', () => {
    const r = authorizeVisible(cat, req(), 'metrics_revenue_mom', {
      bizday: { from: '2026-10-08', to: '2026-10-14' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain(`bizday BETWEEN '2026-10-08'::date AND '2026-10-14'::date`)
  })

  it('R2 from>to → bad_param + range_invalid（T2 恒空集坑的结构化报错）', () => {
    const r = authorizeVisible(cat, req(), 'metrics_revenue_mom', {
      bizday: { from: '2026-10-14', to: '2026-10-08' },
    })
    expect(r).toMatchObject({ ok: false, reason: 'bad_param', detail: 'range_invalid:bizday' })
  })

  it('R3 缺键/非对象/非日期串 → bad_param + invalid_value', () => {
    for (const v of [{ from: '2026-10-08' }, '2026-10-08', { from: '20261008', to: '2026-10-09' }]) {
      const r = authorizeVisible(cat, req(), 'metrics_revenue_mom', { bizday: v })
      expect(r).toMatchObject({ ok: false, reason: 'bad_param', detail: 'invalid_value:bizday' })
    }
  })

  it('R4 空串值仍视为「不传」（与既有空参语义一致）', () => {
    const r = authorizeVisible(cat, req(), 'metrics_revenue_mom', { bizday: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).not.toContain('BETWEEN')
  })

  it('R5 既有 date 等值路径回归不变（A3 原断言原样通过）', () => {
    const eqCat: MetricDef[] = [{
      ...CATALOG[1], params: { day: { column: 'day', type: 'date' as const } },
    }]
    const r = authorizeVisible(eqCat, req(), 'metrics_revenue_mom', { day: '2026-10-08' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain(`day = '2026-10-08'::date`)
  })
})

describe('authorize —— 合计形态（spec §8：args.total 服务端单行聚合）', () => {
  // 夹具照 date_range 块的现成形状（CATALOG[1] + 覆写），selectSql/groupBy 照真实 L1 形态
  // （sync-data-semantics.buildSelectSql：`select <expr> as value, <grain> from <rel>`）——
  // `sum(value)` 依赖这一别名契约。
  const totalCat: MetricDef[] = [{
    ...CATALOG[1],
    selectSql: 'SELECT org, bizday, revenue AS value FROM marts.mart_sales_daily',
    groupBy: 'org, bizday',
    params: { bizday: { column: 'bizday', type: 'date_range' as const } },
  }]

  it('T1 total:true → 计划 SQL 内层 sum(value) 聚合，且**不含**外层 LIMIT；plan.total 在场', () => {
    const r = authorizeVisible(totalCat, req(), 'metrics_revenue_mom', { total: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.total).toBe(true)
    expect(r.plan.sql).toMatch(/^SELECT sum\(value\) AS total FROM \( .*\) t$/)
    // 合计必须作用于**全量匹配行**——截断求和 = 错数（spec §8.1），外层 LIMIT 不得在场
    expect(r.plan.sql).not.toContain('LIMIT')
  })

  it('T2 subject 钉死不变：主体谓词仍来自身份（total 不能伪造主体）', () => {
    const r = authorizeVisible(totalCat, req(), 'metrics_revenue_mom', { total: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.subject).toBe('org_a_lemeng')
    expect(r.plan.sql).toContain("WHERE org = 'org_a_lemeng'")
  })

  it('T3 filters 参与内层：区间条件进子查询，合计仍无外层 LIMIT', () => {
    const r = authorizeVisible(totalCat, req(), 'metrics_revenue_mom', {
      total: true, bizday: { from: '2026-10-08', to: '2026-10-14' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain(`bizday BETWEEN '2026-10-08'::date AND '2026-10-14'::date`)
    expect(r.plan.sql).not.toContain('LIMIT')
  })

  it('T4 保留键 fail-closed：total 非布尔 true 一律不消费 → unknown_param:total', () => {
    for (const v of ['true', 1, 'yes', null, [true]]) {
      const r = authorizeVisible(totalCat, req(), 'metrics_revenue_mom', { total: v })
      expect(r, `total=${JSON.stringify(v)} 必须被拒`).toMatchObject({
        ok: false, reason: 'bad_param', detail: 'unknown_param:total',
      })
    }
  })

  it('T5 非合计路径回归：plan.total=false、SQL 照旧带 LIMIT 且无 sum()（等值/区间一字不动）', () => {
    const r = authorizeVisible(totalCat, req(), 'metrics_revenue_mom', {
      bizday: { from: '2026-10-08', to: '2026-10-14' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.total).toBe(false)
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
    expect(r.plan.sql).not.toContain('sum(value)')
  })
})

describe('authorize —— total 自动伴随（spec §8.4：totalable 指标 plan 附 totalSql）', () => {
  // 夹具照 §8 块的 totalCat（真实 L1 形态：buildSelectSql 的 `select <expr> as value, <grain>`），
  // 加 totalable: true —— sync 从 sum( 开头的 expression 推导出的就是它。
  const addable: MetricDef[] = [{
    ...CATALOG[1],
    totalable: true,
    selectSql: 'SELECT org, bizday, revenue AS value FROM marts.mart_sales_daily',
    groupBy: 'org, bizday',
    params: { bizday: { column: 'bizday', type: 'date_range' as const } },
  }]

  it('T1 totalable 指标：等值/区间查询附 totalSql（sum(value)、无 LIMIT、filters 在内层），主 sql 字节行为不变', () => {
    const r = authorizeVisible(addable, req(), 'metrics_revenue_mom', {
      bizday: { from: '2026-10-08', to: '2026-10-14' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 明细路径不变：主 sql 仍是 LIMIT 形态、total 仍是 false
    expect(r.plan.total).toBe(false)
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
    // 自动伴随：totalSql 与显式合计同一形状（spec §8.4），无外层 LIMIT（截断求和 = 错数）
    expect(r.plan.totalSql).toMatch(/^SELECT sum\(value\) AS total FROM \( .*\) t$/)
    expect(r.plan.totalSql).not.toContain('LIMIT')
    expect(r.plan.totalSql).toContain(`bizday BETWEEN '2026-10-08'::date AND '2026-10-14'::date`)
  })

  it('T2 subject 钉死同样约束 totalSql（自动合计不能变成跨主体合计）', () => {
    const r = authorizeVisible(addable, req({ orgId: 'org_other' }), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.totalSql).toContain("WHERE org = 'org_other'")
    expect(r.plan.totalSql, '别人的主体值不得出现').not.toContain('org_a_lemeng')
  })

  it('T3 非 totalable（显式 false 或缺省）⇒ 无 totalSql（比率/去重计数不给自动合计）', () => {
    for (const [label, cat] of [
      ['缺省（合成契约不带 totalable）', CATALOG],
      ['显式 false', [{ ...CATALOG[1], totalable: false }]],
    ] as const) {
      // CATALOG[1] 未声明参数 ⇒ 空参（带区间参数会落 bad_param，与本判定无关）
      const r = authorizeVisible([...cat], req(), 'metrics_revenue_mom', {})
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.plan.totalSql, `${label} 不得附合计计划`).toBeUndefined()
    }
  })

  it('T4 显式 args.total=true ⇒ 仍是合计单行计划（plan.total=true），且**不**再附 totalSql（plan.sql 本身就是合计，避免重复执行）', () => {
    const r = authorizeVisible(addable, req(), 'metrics_revenue_mom', { total: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.total).toBe(true)
    expect(r.plan.sql).toMatch(/^SELECT sum\(value\) AS total FROM \( .*\) t$/)
    expect(r.plan.sql).not.toContain('LIMIT')
    expect(r.plan.totalSql).toBeUndefined()
  })
})

describe('maxTurns/上限类不变量', () => {
  it('未知参数类型也走 bad_param 而不是静默忽略', () => {
    const cat: MetricDef[] = [{
      ...CATALOG[1], params: { n: { column: 'n', type: 'number' } },
    }]
    expect(authorizeVisible(cat, req(), 'metrics_revenue_mom', { n: 'abc' }).ok).toBe(false)
    expect(authorizeVisible(cat, req(), 'metrics_revenue_mom', { n: 3 }).ok).toBe(true)
  })
})

describe('authorize —— 确定性截断（spec §10.3：明细 GROUP BY 与 LIMIT 之间补 ORDER BY bizday DESC）', () => {
  // 夹具照 §8 块的形状（真实 L1 形态：groupBy 含 bizday——现行 27 条全部命中）
  const bizdayCat: MetricDef[] = [{
    ...CATALOG[1],
    selectSql: 'SELECT org, bizday, revenue AS value FROM marts.mart_sales_daily',
    groupBy: 'org, bizday',
    params: {},
  }]

  it('O1 groupBy 含 bizday → 明细 SQL 在 GROUP BY 与 LIMIT 之间补 ORDER BY bizday DESC', () => {
    const r = authorizeVisible(bizdayCat, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 位置判据用**连续片段**钉死：GROUP BY → ORDER BY → LIMIT 三者紧邻有序，
    // 不是三个 toContain（那验不出顺序——ORDER BY 跑到 LIMIT 后面是语法错，必须在这里红）
    expect(r.plan.sql).toContain('GROUP BY org, bizday ORDER BY bizday DESC LIMIT')
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
  })

  it('O2 groupBy 恰为 bizday → 同样补（现行 27 条里有按 bizday 单列分组的形态）', () => {
    const r = authorizeVisible([{ ...bizdayCat[0], groupBy: 'bizday' }], req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain('GROUP BY bizday ORDER BY bizday DESC LIMIT')
  })

  it('O3 groupBy 不含 bizday → 不补（A2 的 GROUP BY org 形态逐字节不变）', () => {
    // CATALOG[1] 的 groupBy='org'：词根同形（bizday 是 bizday_utc 的前缀）也不许误伤
    const r = authorizeVisible(CATALOG, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).not.toContain('ORDER BY')
    expect(r.plan.sql).toContain('GROUP BY org LIMIT')
  })

  it('O4 groupBy=bizday_utc（前缀同形不同词）→ 不补（\\b 词边界，不认子串）', () => {
    const r = authorizeVisible([{ ...bizdayCat[0], groupBy: 'org, bizday_utc' }], req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).not.toContain('ORDER BY')
  })

  it('O5 显式合计（args.total=true）→ 不补：plan.sql 是聚合，排序无意义', () => {
    const r = authorizeVisible(bizdayCat, req(), 'metrics_revenue_mom', { total: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.total).toBe(true)
    expect(r.plan.sql).not.toContain('ORDER BY')
    expect(r.plan.sql).toMatch(/^SELECT sum\(value\) AS total FROM \( .*\) t$/)
  })

  it('O6 自动伴随（totalable）→ totalSql 不补、主 sql 照补（截断集最新优先只属明细）', () => {
    const r = authorizeVisible([{ ...bizdayCat[0], totalable: true }], req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain('ORDER BY bizday DESC')
    expect(r.plan.totalSql).toBeDefined()
    expect(r.plan.totalSql).not.toContain('ORDER BY')
  })
})

describe('authorize —— 值级掩码定点展开（spec §5.3，P2 T2）', () => {
  // L1 形状夹具：列引用带关系限定（掩码目标须**逐字**出现在 selectSql 里）
  const maskedCat: MetricDef[] = [{
    ...CATALOG[1],
    selectSql: 'select sum(mart_sales_daily.revenue) as value, day from mart_sales_daily',
    totalable: true,
    masks: [{ column: 'mart_sales_daily.revenue', kind: 'round', step: 1000, grantedBy: 'data:precise' }],
  }]

  it('无豁免码 ⇒ 掩码包在聚合内部（sum(round(列，-step))），plan.applied 记录生效项', () => {
    const r = authorizeVisible(maskedCat, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain('sum(round(mart_sales_daily.revenue, -1000)) as value')
    expect(r.plan.applied).toEqual({ 'mart_sales_daily.revenue': 'round:1000' })
    expect(r.plan.exempted).toEqual([])
  })

  it('自动合计与明细同源（同一 whereAndGroup）⇒ totalSql 用同一套掩码值（spec §3.2 不变量 2）', () => {
    const r = authorizeVisible(maskedCat, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.totalSql).toContain('sum(round(mart_sales_daily.revenue, -1000))')
  })

  it('持有豁免码（grantedBy）⇒ sql 原样、applied 为空', () => {
    const r = authorizeVisible(maskedCat, req({ scopes: ['data:query', 'data:precise'] }), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain('sum(mart_sales_daily.revenue) as value')
    expect(r.plan.sql).not.toContain('round(mart_sales_daily.revenue')
    expect(r.plan.applied).toEqual({})
    expect(r.plan.exempted).toEqual(['mart_sales_daily.revenue'])
  })

  it('masks 缺省/null/空 ⇒ applied 空、sql 一字不变（既有指标零影响）', () => {
    const baseline = authorizeVisible([{ ...CATALOG[1] }], req(), 'metrics_revenue_mom', {})
    expect(baseline.ok).toBe(true)
    if (!baseline.ok) return
    for (const masks of [undefined, null, []] as (MaskSpec[] | null | undefined)[]) {
      const r = authorizeVisible([{ ...CATALOG[1], masks }], req(), 'metrics_revenue_mom', {})
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.plan.applied).toEqual({})
      expect(r.plan.sql).toBe(baseline.plan.sql)
    }
  })

  // ★ 第 5 参（maskCatalog，spec §5.3.1 R10）：掩码按列从**全量** catalog 解析，堵 #820。
  //   可见集里只有 L2 行（masks 恒 null），但掩码目录传全量（含被裁掉的 L1 行）⇒ L2 仍被掩。
  it('★ 掩码从全量 catalog 取（第 5 参）：不可见 L1 行的掩码仍掩住可见 L2 行（#820）', () => {
    const l1: MetricDef = { ...maskedCat[0] }                        // L1 行：带掩码（被裁掉，不在可见集）
    const l2: MetricDef = { ...maskedCat[0], id: 'l2_metric', masks: null }  // L2 行：masks 恒 null

    // 反证：把可见集当掩码词表（= 已移除的那个 fail-open 默认值的行为）
    //       ⇒ L2 行 masks 恒 null ⇒ 掩码不生效（正是 #820 的洞）
    const before = authorize([l2], req(), 'l2_metric', {}, [l2])
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.plan.applied).toEqual({})

    // 传全量掩码目录 ⇒ L2 的 selectSql 逐字保留了 L1 的列引用 ⇒ 命中 L1 的掩码（fail-closed）
    const after = authorize([l2], req(), 'l2_metric', {}, [l1, l2])
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.plan.applied).toEqual({ 'mart_sales_daily.revenue': 'round:1000' })
    expect(after.plan.sql).toContain('sum(round(mart_sales_daily.revenue, -1000)) as value')
  })
})
