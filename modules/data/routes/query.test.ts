// query.test.ts — POST /query 的路由层测试。
// 模块壳（buildTestApp）不挂宿主门卫与三通道中间件——那部分归 T10 的端到端；
// 这里验：参数面拒、requesterOf 身份归一（含 M3 守卫）、状态码映射、execute 注入透传。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertL1Metric, upsertMetric } from '../domain/metric-store'
import type { L1MetricDef } from '../domain/metric-store'
import type { SqlExecutor } from '../domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics.test.ts 互不相同，避免互相擦数据。 */
const ORG = 'org-t6-query'
/** 断言 1 的两个租户：A / B 渲染**同一个面板**（同一 metricId），只有主体值该不同。 */
const ORG_A = 'org-t6-query-a'
const ORG_B = 'org-t6-query-b'
/** 本文件的 L1 夹具 id 前缀（平台桶 `org='platform'` 跨文件共用 ⇒ 清理只按前缀删）。 */
const L1_PREFIX = 't6q:'

/**
 * 「自绘面板」的**同一套语义声明**（L1 平台行 = `sync-data-semantics` 的产物）。
 *
 * ★ 本用例的支点：A/B 两租户渲染**同一个面板**（同一 `metricId`）时，二者解析到的是
 *   **同一行声明**（spec §5「两条路共用一个口径……判据同源」的落点），故两条 SQL 除注入的
 *   主体值外**必须逐字相同**——若哪天自绘又长出第二条编译路径（第二份口径），这一条会立刻红。
 * `select_sql` 里的 `t6q_fct.panel_amount` 是它在 SQL 里的**指纹**（与 catalog-consumers.test.ts
 * 同款）：断言「这一条真被查了」认这个串，不认「200」。
 */
const PANEL_METRIC: L1MetricDef = {
  id: `${L1_PREFIX}panel_revenue`, title: '面板营收', description: '自绘面板的共用口径',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select org, day, sum(t6q_fct.panel_amount) as value from t6q_fct',
  groupBy: 'org, day', params: {},
  // L1 行恒有源（声明面必填）——本文件用 `['lemeng']` 扮演「宿主投影：本租户已接入该源」。
  sourceSystem: 'lemeng',
  slaDays: 1, freshnessRelations: [],
  // 值级掩码声明（spec 2026-10-17 §5.2）缺省形态：未声明 = null（本文件不涉掩码）
  masks: null,
}

/** 断言 2 的三个「不同面板」：同一声明形状、不同 `metricId`（= 一个报表里三个面板各查各的）。 */
const PANELS: L1MetricDef[] = ['a', 'b', 'c'].map((s) => ({
  ...PANEL_METRIC,
  id: `${L1_PREFIX}panel_${s}`,
  selectSql: `select org, day, sum(t6q_fct.panel_${s}) as value from t6q_fct`,
}))

// 词表形状照 domain/authz.ts 的 MetricDef（主体列 org，与 ORG 同值 ⇒ 主体钉死可断言）
const SALES_DAILY = {
  id: 'sales_daily', title: '销售日明细', description: '',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
  groupBy: '', params: {},
}

/**
 * 服务端分组（Task 4）的两条夹具——**粒度决定切片的两种合法/非法形态**：
 *  · `slicing_day`：粒度只有 `bizday`。选 `['bizday']` = **全选**（明细形态），合法；
 *  · `slicing_ratio`：粒度两维且**未声明可加**（`upsertMetric` 恒写 totalable=false）。
 *    选 `['bizday']` = **真子集**（外层再聚合 = 错数）⇒ 授权层必须拒（bad_param）。
 */
const SLICING_DAY = {
  id: 'slicing_day', title: '销售日汇总', description: '',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, bizday, sum(revenue) as value FROM marts.mart_sales_daily',
  groupBy: 'bizday', params: {},
}
const SLICING_RATIO = {
  id: 'slicing_ratio', title: '比率（不可加）', description: '',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, bizday, cause, avg(rate) as value FROM marts.mart_ratio',
  groupBy: 'bizday, cause', params: {},
}

/**
 * `total: true` 的夹具必须是**was declared additive**的（`totalable === true`）——
 * 只有 L1 物化路径能带这个标记（`upsertMetric`/L2 恒写 false），故这里走 `upsertL1Metric`
 * + 宿主投影「已接入 lemeng」；前缀沿用 `t6q:` 让 afterAll 的前缀清理一并覆盖本行。
 */
const SLICING_TOTALABLE: L1MetricDef = {
  ...PANEL_METRIC,
  id: `${L1_PREFIX}slicing_totalable`,
  selectSql: 'select org, bizday, sum(t6q_fct.day_amount) as value from t6q_fct',
  groupBy: 'bizday',
  totalable: true,
}

// ⚠️ 必须**先**建 app 再断言：`buildTestApp` 里的 `createRouter` 就是被测的模块装配，
// 建 app 这一步本身会跑装载期双向核对（声明集合 ≡ 注册集合）。
describe('POST /query 的参数面（不需要数据库）', () => {
  it('body 不是合法 JSON → 400 INVALID_BODY（在碰 DB 之前就拒）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })
})

describePg('POST /query（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    for (const org of [ORG, ORG_A, ORG_B]) {
      await pool.query('delete from data.query_audit where org = $1', [org]).catch(() => {})
      await pool.query('delete from data.metrics where org = $1', [org]).catch(() => {})
      await pool.query('delete from data.query_keys where org = $1', [org]).catch(() => {})
    }
    // 平台桶跨文件共用 ⇒ **只删本文件前缀**的那些夹具（`where org='platform'` 会删掉并行兄弟的）。
    await pool.query('delete from data.metrics where org = $1 and id like $2', ['platform', `${L1_PREFIX}%`])
      .catch(() => {})
    await pool.end().catch(() => {})
  })

  /** 经**真实路由**打一发 `/query`（一个面板 = 一次调用），捕获实际执行的那条 SQL。 */
  const queryPanel = async (
    org: string, metricId: string, sources: string[] | undefined, calls: string[],
  ) => {
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return { columns: ['org', 'day', 'value'], rows: [[org, '2026-08-15', 1]] }
    }
    // execute 用**变量**携带（与下方 §110 同款）：绕开 ModuleContext 字面量的多余属性检查。
    const ctx = { pool, execute }
    const app = buildTestApp(
      mod, makeIdentity({ orgId: org }), ctx, { id: 1, casdoor_org: org }, sources,
    )
    return app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId, args: {} }),
    })
  }

  /** 本 org 的审计行数（断言 2 用**前后差**计数——单条计数会被此前用例留下的行绊倒）。 */
  const countAudit = async (org: string): Promise<number> => {
    const r = await pool.query('select count(*)::int as n from data.query_audit where org = $1', [org])
    return r.rows[0].n as number
  }

  // 【已移除】`createPorts.resolvePatKey` 的端口往返测试：PAT 密钥表与端口已上移宿主
  // （issue #894，正典 §1.5）。该测试的**语义**（建 key → 解析原样转交 → fire-and-forget 触碰
  // last_used_at）现由宿主侧覆盖：`apps/server/src/api-key-store.test.ts`（解析/触碰）
  // + `apps/server/src/routes/api-keys.test.ts`（端点）+ `apps/server/src/data-query.e2e.test.ts`
  // （端到端往返，已改为「宿主建 → 宿主认」）。

  it('未声明的指标 → 403 + 可解释 reason（不是 500）', async () => {
    // 这条**需要真库**：`runQuery` 是先 loadOrgCatalog 再判声明，没有 pool 会先炸在加载词表上
    // （错误信号会变成「500 而不是 403」，看着像授权坏了）。种一条真指标，再问一个没声明的。
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool }, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'nope', args: {} }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('metric_not_declared')
  })

  it('身份 orgId 为空串 → 403 unauthenticated（M3 守卫在 requesterOf 收口，空 org 不流进 SQL）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: '' }), { pool }, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('unauthenticated')
    // 入口拒也留痕（匿名口径）：审计是失败也要留痕的地方
    const a = await pool.query(
      'select verdict, reason, user_id from data.query_audit where org = $1 order by id desc limit 1',
      [ORG],
    )
    expect(a.rows[0]).toMatchObject({ verdict: 'denied', reason: 'unauthenticated', user_id: '(anonymous)' })
  })

  it('已声明且授权 → 200；execute 注入经 RouteCtx 透传到 runQuery（不碰真仓库）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return { columns: ['org', 'day'], rows: [[ORG, '2026-08-15']] }
    }
    // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
    const ctx = { pool, execute }
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.subject).toBe(ORG)
    expect(calls.length).toBe(1)
    // 主体钉死：SQL 里的主体值来自身份解析，客户端参数指定不了
    expect(calls[0]).toContain(`WHERE org = '${ORG}'`)
  })

  it('仓库执行出错 → 502 error/warehouse_error（上游仓库不可用不是本服务的 500）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const execute: SqlExecutor = async () => {
      throw new Error('boom')
    }
    const ctx = { pool, execute }
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.status).toBe('error')
    expect(body.reason).toBe('warehouse_error')
  })

  // ── 服务端分组（月报重做计划 Task 4）────────────────────────────────────────
  // 路由只负责**形状**（zod）与**透传**：分组的合法性判定（粒度/可加/列名）全在授权核心，
  // 本组断言「body 的 dimensions/orderBy/limit/total 变成 slicing 落到那条 SQL 上」，
  // 以及「非法切片照样由授权层拒（路由不自己造第二份判定）」。

  /** 打一发带切片 body 的 /query，返回响应 + 实际执行的 SQL 列表。 */
  const querySliced = async (
    org: string, body: Record<string, unknown>, sources?: string[],
  ): Promise<{ res: Response; calls: string[] }> => {
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      // 合计计划与明细计划同一执行缝：按 SQL 形状回不同行（保证 total 断言有真值）。
      if (sql.includes('AS total')) return { columns: ['total'], rows: [[42]] }
      return { columns: ['bizday', 'value'], rows: [['2026-08-15', 1]] }
    }
    const ctx = { pool, execute }
    const app = buildTestApp(
      mod, makeIdentity({ orgId: org }), ctx, { id: 1, casdoor_org: org }, sources,
    )
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { res, calls }
  }

  it('dimensions/orderBy/limit 透传到 slicing（服务端分组）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SLICING_DAY, 'fixture')
    const { res, calls } = await querySliced(ORG, {
      metricId: SLICING_DAY.id, args: {},
      dimensions: ['bizday'], orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 10,
    })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // 分组是声明的粒度（内层 GROUP BY），排序/截断是切片给的（外层）——三者各自落地。
    expect(calls[0]).toContain('GROUP BY bizday')
    expect(calls[0]).toContain('ORDER BY bizday asc')
    expect(calls[0]).toContain('LIMIT 10')
    // 主体钉死不因切片而松动（切片只能收窄，不能换主体）
    expect(calls[0]).toContain(`WHERE org = '${ORG}'`)
  })

  it('total:true 透传为 slicing.total ⇒ 附合计计划，回包带 total', async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, SLICING_TOTALABLE)
    const { res, calls } = await querySliced(
      ORG_A, { metricId: SLICING_TOTALABLE.id, args: {}, total: true }, ['lemeng'],
    )
    expect(res.status).toBe(200)
    // 显式请求合计 ⇒ 明细之外**再**执行一次 sum 计划（截断前的全量合计）
    expect(calls.some((s) => s.includes('sum(value) AS total'))).toBe(true)
    expect((await res.json()).total).toBe(42)
  })

  it('不可加指标真子集切片 ⇒ 403 bad_param（授权层拒，不触达仓库）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SLICING_RATIO, 'fixture')
    const { res, calls } = await querySliced(ORG, {
      metricId: SLICING_RATIO.id, args: {}, dimensions: ['bizday'],
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.reason).toBe('bad_param')
    expect(body.detail).toBe('slicing_not_additive')
    expect(calls).toHaveLength(0)
  })

  it('切片形状非法（limit 非正整数 / 未知排序列）⇒ 400 INVALID_BODY 或 403 bad_param', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SLICING_DAY, 'fixture')
    // 路由形状层（zod）：limit 必须为正整数 ⇒ 0 在碰 DB 之前就拒
    const zero = await querySliced(ORG, { metricId: SLICING_DAY.id, args: {}, limit: 0 })
    expect(zero.res.status).toBe(400)
    expect((await zero.res.json()).error).toBe('INVALID_BODY')
    // 授权层：排序列必须在本次切片的维度范围内 ⇒ 未知列 403 bad_param
    const bad = await querySliced(ORG, {
      metricId: SLICING_DAY.id, args: {}, orderBy: [{ column: 'nope', dir: 'asc' }],
    })
    expect(bad.res.status).toBe(403)
    expect((await bad.res.json()).reason).toBe('bad_param')
  })

  // ── 自绘面板的数据通路（计划 6 Task 5）───────────────────────────────────────
  // 本组**不新造任何端点/编译路径**：它证明「自绘面板的数据走的就是这条既有 /query」——
  // 判据（同一行语义声明）与身份注入（主体值只来自调用者身份）与 Metabase 那条路同源。

  it('★ 自绘面板的数据走 /query：词表裁剪 + 按调用者身份注入主体值（与 Metabase 那条判据同源）', async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, PANEL_METRIC)

    // ── A 租户（宿主投影：已接入 lemeng）⇒ 同一 metricId、同一行声明 ⇒ 主体值是 A ──
    const callsA: string[] = []
    const resA = await queryPanel(ORG_A, PANEL_METRIC.id, ['lemeng'], callsA)
    expect(resA.status).toBe(200)
    expect((await resA.json()).subject).toBe(ORG_A)
    expect(callsA).toHaveLength(1)
    expect(callsA[0]).toContain("t6q_fct.panel_amount")          // 认指纹：这一条声明真被查了
    expect(callsA[0]).toContain(`WHERE org = '${ORG_A}'`)        // ★ 主体注入逐字
    expect(callsA[0]).not.toContain(ORG_B)

    // ── B 租户：同一面板、同一行声明 ⇒ 除主体值外一切同上 ──
    const callsB: string[] = []
    const resB = await queryPanel(ORG_B, PANEL_METRIC.id, ['lemeng'], callsB)
    expect(resB.status).toBe(200)
    expect((await resB.json()).subject).toBe(ORG_B)
    expect(callsB[0]).toContain(`WHERE org = '${ORG_B}'`)        // ★ 主体注入逐字
    expect(callsB[0]).not.toContain(ORG_A)

    // ★ 判据同源的**逐字**证明：把各自的主体值抹平后，两条 SQL **完全相等**——
    //   即两租户跑的是同一份口径、同一段骨架，唯一的差异就是身份注入的那个值。
    //   （若将来自绘长出第二条编译路径/第二份口径，这一条会立刻红。）
    expect(callsA[0].replace(ORG_A, '<subject>')).toBe(callsB[0].replace(ORG_B, '<subject>'))

    // ── 词表裁剪：同一 metricId，宿主**没投影**「已接入源」的租户 ⇒ 它**看不见**这个指标 ──
    //   （不是报错、不是 500；spec §5 约束 3「看不见」在自绘这条路上同样成立。）
    const callsC: string[] = []
    const resC = await queryPanel(ORG_A, PANEL_METRIC.id, [], callsC)
    expect(resC.status).toBe(403)
    expect((await resC.json()).reason).toBe('metric_not_declared')
    expect(callsC).toHaveLength(0)                               // 被裁 ⇒ 从未触达仓库
  })

  it('★ 每次面板查询都落 data.query_audit（逐查询留痕，不因"一个报表 N 个面板"而合并）', async () => {
    await applyMigrations(pool)
    for (const m of PANELS) await upsertL1Metric(pool, m)

    // 基线：本文件此前的用例也写过审计 ⇒ 用**前后差**计数，不用绝对行数
    const before = await countAudit(ORG_A)

    // 一个报表 3 个面板 = 3 次面板查询 = 3 发 /query（**不**合并成一次「整报表数据」）
    for (const m of PANELS) {
      const calls: string[] = []
      const res = await queryPanel(ORG_A, m.id, ['lemeng'], calls)
      expect(res.status, `面板 ${m.id} 未走通`).toBe(200)
      expect(calls).toHaveLength(1)
    }

    const after = await countAudit(ORG_A)
    expect(after - before, '一个报表 3 个面板应留 **3** 条审计（合并成一次就只剩 1 条）').toBe(3)

    // 逐条断言：三个面板 id 各留一行（按 metric_id 逐条，不是只数总数）
    const rows = await pool.query(
      `select metric_id from data.query_audit
        where org = $1 and metric_id = any($2::text[]) order by metric_id`,
      [ORG_A, PANELS.map((m) => m.id)],
    )
    expect(rows.rows.map((r) => r.metric_id as string)).toEqual([...PANELS.map((m) => m.id)].sort())
  })
})
