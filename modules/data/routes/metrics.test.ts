// metrics.test.ts — 指标词表路由的测试（词表裁剪 + 管理面 + T8 的 L2 定义面收紧）。
//
// 模块壳不挂宿主门卫：缺 data:manage 的拒绝归宿主门卫（T10 端到端验），
// 这里验裁剪语义（「看不见」不是报错）与管理面写路径的**新契约**——
// 写路径只收结构化 `L2Declaration`，自由 SQL 入参一律 400（全局约束 12）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { TENANT_SOURCES, declaredScopeGate } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { L1_ORG, upsertL1Metric, upsertMetric } from '../domain/metric-store'
import type { L1MetricDef, MetricRow } from '../domain/metric-store'
import { L2ExprDeclarationSchema, L2RefineDeclarationSchema, compileL2 } from '../domain/semantic-compiler'
import type { L2Declaration } from '../domain/semantic-compiler'
import type { MetricDef } from '../domain/authz'
import type { ModuleVars } from './context'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text）——与其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-t6-metrics'
const OTHER_ORG = 'org-t6-metrics-other'

function def(over: Partial<MetricDef> = {}): MetricDef {
  return {
    id: 'sales_daily', title: '销售日明细', description: '按日销售',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.mart_sales_daily',
    groupBy: '', params: {},
    ...over,
  }
}

// ── L1 夹具（平台词表）───────────────────────────────────────────────────────────
// 必须满足 select_sql 的**形状契约**（`select <表达式> as value[, <维度>] from <关系>`），
// 否则 L2 编译点会抛 BAD_BASE_SQL —— 那正是它该做的（形状不合契约就不许当 base）。
/**
 * ⚠️ **L1 夹具 id 一律带本文件专用前缀 `t6test:`**（与 `catalog-consumers.test.ts` 的 `t8c:`、
 * `metric-store.test.ts` 的 `t8test:` 同一手法，互不相同）。
 *
 * 为什么必须加前缀：平台桶（`data.metrics` 的 `org='platform'`）是**跨测试文件共用**的固定桶，
 * 而清理只能按 id 删 —— 夹具 id 一旦与**真实声明**（`dbt/semantics/l1_metrics.yml` 的 `name`）同名，
 * 本文件的 `afterAll` 就会删掉平台桶里那条**真行**。实测（2026-09-30，本文件曾用 `retail:net_sales`）：
 * 跑完本文件后 `sync-data-semantics.mjs --check` 报「新增 1（retail:net_sales）」——真声明与库里的
 * 物化行被一个测试的清理步骤打掉了。加了前缀之后，「测试跑完」与「库和声明分叉」不再有关系。
 */
const L1_ID_PREFIX = 't6test:'
/**
 * L1 物化路径的入参 = `MetricDef` + **源系统**（源维度：L1 声明里 `source` 必填 ⇒ L1 行恒有源）。
 * 本文件的 L1 夹具都是 sync 的产物，故与声明同形（`lemeng` = 当前唯一已接入源）；
 * 不给源的 L1 行在 Task 5 的裁剪里会被判成「未接入源」而**没人看得见**——那是不该出现在夹具里的形状。
 */
const l1Def = (over: Partial<MetricDef> = {}): L1MetricDef =>
  ({ ...def(over), sourceSystem: 'lemeng', slaDays: 1, freshnessRelations: [] })
const L1_SALES = l1Def({
  id: `${L1_ID_PREFIX}net_sales`, title: '净销售额',
  selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
  groupBy: 'system_book, bizday',
})
const L1_FINANCE = l1Def({
  id: `${L1_ID_PREFIX}margin`, title: '毛利', requiredScope: 'data:finance',
  selectSql: 'select sum(fct_retail_sale.margin) as value, system_book from fct_retail_sale',
  groupBy: 'system_book',
})
/**
 * 存在、但本租户**未接入**的源（`shanhai`）的 L1 行 —— 写入闸的探针（计划 5 Task 5）。
 * 它与 L1_SALES 的唯一差别是源维度 ⇒ 「403 是不是真按源判的」只有它能验。
 * `l1Def` 默认把 sourceSystem 写成 lemeng，故这里**后覆盖**（不是传参——传参会被默认值顶掉）。
 */
const L1_FOREIGN = { ...l1Def({
  id: `${L1_ID_PREFIX}shanhai_margin`, title: '山海毛利',
  selectSql: 'select sum(fct_retail_sale.foreign) as value, system_book from fct_retail_sale',
  groupBy: 'system_book',
}), sourceSystem: 'shanhai' }
/** M-① 的撞 id 探针：**先**由租户建 L2、**后**由平台物化同 id（唯一能造出撞 id 的合法时序）。 */
const L1_CLASH_PROBE = `${L1_ID_PREFIX}clash_probe`
/** 本租户已接入的源（宿主投影 TENANT_SOURCES 的测试替身）——未接入的源就是 `lemeng` 之外的。 */
const ADOPTED = ['lemeng']

/** 合法 L2 声明（各用例只覆盖自己关心的字段）。 */
const l2Body = (over: Record<string, unknown> = {}) => ({
  id: 'l2_net_sales_xiongmao',
  baseMetric: L1_SALES.id,
  op: { kind: 'refine' },
  ...over,
})

/**
 * B 中档（expr）的合法声明。**另写一个字面量**而不是复用 `l2Body`：后者恒塞一个真值
 * `baseMetric`，而 expr 支是 `.strict()` ⇒ 带着它进 expr 支会被判 `BAD_DECL`（不是 201）。
 * 「不许 `baseMetric` 与 `op.kind:'expr'` 同现」这条形状约束，由这个构造器本身守住。
 */
const exprBody = (over: Record<string, unknown> = {}) => ({
  id: 'l2_avg_price',
  op: {
    kind: 'expr',
    expr: { kind: 'div', left: { kind: 'ref', id: L1_SALES.id }, right: { kind: 'num', value: 2 } },
  },
  ...over,
})

function app(org: string, scopes: string[], sources: string[] | undefined = ADOPTED) {
  return buildTestApp(mod, makeIdentity({ orgId: org, scopes }), { pool },
    { id: 1, casdoor_org: org }, sources)
}

async function post(body: unknown, org = ORG, scopes = ['data:manage', 'data:query']) {
  return app(org, scopes).request('/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let pool: Pool

describePg('指标路由（需要 DATABASE_URL：词表读写）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    // L1 行只能经 sync 脚本物化——测试里用 upsertL1Metric 直落，等价于 sync 的产物
    // （管理 API 侧没有任何途径写出 l1 行，见 metric-store 的两个写入口）。
    await upsertL1Metric(pool, L1_SALES)
    await upsertL1Metric(pool, L1_FINANCE)
    await upsertL1Metric(pool, L1_FOREIGN)
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = any($1::text[])', [[ORG, OTHER_ORG]]).catch(() => {})
    // L1 桶跨文件共用 ⇒ 只删**本文件前缀**的那些（别 `where org='platform'`，会删掉并行兄弟的夹具）。
    // 按前缀收口（而不是逐个列 id）是第二道保险：将来新增夹具却忘了登记 id，清理也不会越界——
    // 而越界正是「测试删掉平台桶里的真声明行」那个缺陷的成因（见上面 L1_ID_PREFIX 的说明）。
    await pool.query('delete from data.metrics where org = $1 and id like $2',
      [L1_ORG, `${L1_ID_PREFIX}%`]).catch(() => {})
    await pool.end().catch(() => {})
  })

  // ── 读路径：L1 ∪ L2 合并 + scope 裁剪 ─────────────────────────────────────────
  it('GET /metrics：L1 行对本租户可见，且 data:query 身份看不到 data:finance 指标（看不见，不是报错）', async () => {
    const res = await app(ORG, ['data:query']).request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain(L1_SALES.id)
    expect(ids, 'data:finance 的 L1 指标对只有 data:query 的人可见了').not.toContain(L1_FINANCE.id)
    // 消费面投影：三字段 + 参数面形状——selectSql/subjectColumn/column 属实现细节，不外泄
    expect(body.metrics.find((m: { id: string }) => m.id === L1_SALES.id))
      .toEqual({ id: L1_SALES.id, title: '净销售额', description: def().description, params: {} })
  })

  it('GET /metrics 不掺别家 L2 行（跨租户串词表是禁止的）', async () => {
    await upsertMetric(pool, OTHER_ORG, def({ id: 'other_org_l2', title: '别家的' }), 'fixture')
    const body = await (await app(ORG, ['data:query']).request('/metrics')).json()
    expect(body.metrics.map((m: { id: string }) => m.id)).not.toContain('other_org_l2')
  })

  it('GET /metrics/all（管理面）带 source：L1 标 l1、本租户标 l2（管理员据此知道哪行只读）', async () => {
    const body = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    const byId = new Map(body.metrics.map((m: { id: string }) => [m.id, m]))
    expect(byId.get(L1_SALES.id)).toMatchObject({ source: 'l1', subjectColumn: 'org' })
    expect(byId.get('other_org_l2')).toBeUndefined()
  })

  // ── 写路径：只收结构化声明 ───────────────────────────────────────────────────
  it('★ 病态超深 expr ⇒ 干净 400（不是 500）：线性预检须先于递归 schema（#593）', async () => {
    // 递归 z.lazy 的校验**先于**迭代深度闸执行 ⇒ 超深输入在 zod 里爆栈（实测 1600 层过、3200 层
    // RangeError）冒成 500。判据：与其它非法形状同一契约 ⇒ 400。
    let deep: unknown = { kind: 'num', value: 1 }
    for (let i = 0; i < 3200; i++) deep = { kind: 'div', left: { kind: 'num', value: 1 }, right: deep }
    const res = await post({ id: 'l2_too_deep', op: { kind: 'expr', expr: deep } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })

  it('POST /metrics 合法 L2 声明 → 201，且立刻在词表里可见（source=l2）', async () => {
    const res = await post(l2Body())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })

    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    const row = all.metrics.find((m: { id: string }) => m.id === 'l2_net_sales_xiongmao')
    expect(row).toMatchObject({ source: 'l2', title: '净销售额', groupBy: 'system_book, bizday' })
    // 编译产物落库：值表达式来自 L1（L2 改不了口径）
    expect(row.selectSql).toContain('sum(fct_retail_sale.net_amount) as value')
    // 主体列继承 L1（租户改不了它）
    expect(row.subjectColumn).toBe('org')
  })

  it('POST expr 声明 ⇒ 201，selectSql 是内联表达式且带编译器注入的除零守卫', async () => {
    const res = await post(exprBody())
    expect(res.status).toBe(201)

    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    const row = all.metrics.find((m: { id: string }) => m.id === 'l2_avg_price')
    // 除零守卫由编译器注入（租户看不到也控制不了）
    expect(row.selectSql).toContain('NULLIF((2), 0)')
    // 产物形状与 refine 同形：`select <表达式> as value[, <可见维度>] from <关系>`
    expect(row.selectSql).toContain(' as value')
    // 可见维度与主体列都继承**共享基**（expr 支没有单条 base，故由编译产物给出）
    expect(row.groupBy).toBe('system_book, bizday')
    expect(row.subjectColumn).toBe('org')
  })

  it('★ POST body 里带 selectSql / subjectColumn / groupBy / source ⇒ 400 INVALID_BODY（不是静默忽略）', async () => {
    for (const bad of [
      { selectSql: 'select 1 as value from t' },
      { subjectColumn: 'evil' },
      { groupBy: 'x' },
      { source: 'l1' },
      { params: {} },
    ]) {
      const res = await post(l2Body({ ...bad }))
      expect(res.status, `body 带 ${Object.keys(bad)[0]} 竟被接受`).toBe(400)
      expect((await res.json()).error).toBe('INVALID_BODY')
    }
  })

  it('POST baseMetric 不在 L1 词表 ⇒ 400 L1_BASE_NOT_FOUND', async () => {
    const res = await post(l2Body({ baseMetric: `${L1_ID_PREFIX}not_declared` }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('L1_BASE_NOT_FOUND')
  })

  it('POST filters 的维度不在 L1 的 grain ⇒ 400 UNKNOWN_DIM', async () => {
    const res = await post(l2Body({ filters: [{ dim: 'store_id', op: '=', values: ['S1'] }] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('UNKNOWN_DIM')
  })

  it('POST visibility 的维度不在 L1 的 grain ⇒ 400 UNKNOWN_DIM', async () => {
    const res = await post(l2Body({ visibility: { dims: ['nope'] } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('UNKNOWN_DIM')
  })

  it('POST op.kind 既不是 refine 也不是 expr ⇒ 400 INVALID_BODY（union 两支都不匹配）', async () => {
    const res = await post(l2Body({ op: { kind: 'expression' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })

  it('POST 带 target ⇒ 400 TARGET_NOT_SUPPORTED（无存储列 ⇒ 显式拒绝，不静默丢弃）', async () => {
    const res = await post(l2Body({ target: 100 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('TARGET_NOT_SUPPORTED')
  })

  it('★ POST 用 L1 的 id ⇒ 409 ID_RESERVED_BY_L1（占下会静默无效：加载侧 L1 赢）', async () => {
    const res = await post(l2Body({ id: L1_SALES.id }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('ID_RESERVED_BY_L1')
    // 且**没有**写进去任何东西（不留下一条加载侧永远看不见的僵尸 L2 行）
    const raw = await pool.query('select count(*)::int as n from data.metrics where org = $1 and id = $2', [ORG, L1_SALES.id])
    expect(raw.rows[0].n).toBe(0)
  })

  it('PUT /metrics/:id 路径 id 与 body id 不一致 → 400 ID_MISMATCH（改 A 不能写 B）', async () => {
    const res = await app(ORG, ['data:manage']).request('/metrics/l2_net_sales_xiongmao', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: 'trying_to_rename' })),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('ID_MISMATCH')
  })

  it('PUT /metrics/:id 同 id → 200 且内容被覆盖（text 主键不是数字解析：下划线 id 合法）', async () => {
    const res = await app(ORG, ['data:manage']).request('/metrics/l2_net_sales_xiongmao', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ alias: '熊喵净销售', visibility: { dims: ['system_book'] } })),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    expect(all.metrics.find((m: { id: string }) => m.id === 'l2_net_sales_xiongmao'))
      .toMatchObject({ title: '熊喵净销售', groupBy: 'system_book', source: 'l2' })
  })

  it('★ PUT / DELETE 打到 L1 的 id ⇒ 409 READONLY_L1（平台词表经 API 只读）', async () => {
    const put = await app(ORG, ['data:manage']).request(`/metrics/${L1_SALES.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: L1_SALES.id })),
    })
    expect(put.status).toBe(409)
    expect((await put.json()).error).toBe('ID_RESERVED_BY_L1')

    const del = await app(ORG, ['data:manage']).request(`/metrics/${L1_SALES.id}`, { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect((await del.json()).error).toBe('READONLY_L1')

    // L1 行安然无恙（没被改名也没被删）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    expect(all.metrics.find((m: { id: string }) => m.id === L1_SALES.id)).toMatchObject({
      title: '净销售额', source: 'l1',
    })
  })

  it('DELETE /metrics/:id 打 L2：命中 → ok；再删 → 404（text id 走 metricIdOf，不是数字解析）', async () => {
    const first = await app(ORG, ['data:manage']).request('/metrics/l2_net_sales_xiongmao', { method: 'DELETE' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })
    const second = await app(ORG, ['data:manage']).request('/metrics/l2_net_sales_xiongmao', { method: 'DELETE' })
    expect(second.status).toBe(404)
    expect((await second.json()).error).toBe('NOT_FOUND')
  })

  it('★ 撞 id 的租户 L2 行**删得掉**（T8 评审 M-①：改前先判 L1 ⇒ DELETE 恒 409 ⇒ 永久孤儿）', async () => {
    // 合法时序：租户**先**建 L2，平台**事后**把同 id 物化成 L1。
    // （反方向建不出来——写侧闸门以 409 ID_RESERVED_BY_L1 拦下，见上一条用例。）
    const clashId = L1_CLASH_PROBE
    const post1 = await post(l2Body({ id: clashId }))
    expect(post1.status, '撞 id 的 L2 行没建起来（夹具前提不成立）').toBe(201)
    await upsertL1Metric(pool, l1Def({ id: clashId, title: '平台同 id 版' }))

    // 前提核对：合并词表里这条 id 由 **L1 赢**（租户那行在消费面上看不见）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    expect(all.metrics.find((m: { id: string }) => m.id === clashId))
      .toMatchObject({ title: '平台同 id 版', source: 'l1' })

    // 但它仍是**租户自己的**行 ⇒ 必须删得掉（改前这里恒 409 READONLY_L1）
    const del = await app(ORG, ['data:manage']).request(`/metrics/${clashId}`, { method: 'DELETE' })
    expect(del.status, 'DELETE 恒 409 ⇒ 租户清不掉自己声明过的行（永久孤儿）').toBe(200)
    expect(await del.json()).toEqual({ ok: true })

    // 删的是**租户那行**：本 org 桶里没了，平台桶那行安然无恙
    const mine = await pool.query('select source from data.metrics where org = $1 and id = $2', [ORG, clashId])
    expect(mine.rowCount).toBe(0)
    const plat = await pool.query('select source from data.metrics where org = $1 and id = $2', [L1_ORG, clashId])
    expect(plat.rows[0]).toMatchObject({ source: 'l1' })

    // 再删一次：这次才轮到 L1 那道闸（它在，但只能改 dbt 声明再物化）
    const again = await app(ORG, ['data:manage']).request(`/metrics/${clashId}`, { method: 'DELETE' })
    expect(again.status).toBe(409)
    expect((await again.json()).error).toBe('READONLY_L1')
  })

  // ── 写入闸：未接入源的 L1 不许当 L2 的基底（计划 5 Task 5，spec §3⑧）──────────────
  it('★ POST 用未接入源的 L1 当 baseMetric ⇒ 403 METRIC_SOURCE_NOT_ADOPTED（带 its_source / your_sources）', async () => {
    // 前提核对：这条 L1 存在（否则会先撞 L1_BASE_NOT_FOUND，本用例就名不副实）
    expect(L1_FOREIGN.sourceSystem).toBe('shanhai')
    const res = await post(l2Body({ id: 'l2_from_foreign', baseMetric: L1_FOREIGN.id }))
    expect(res.status, '未接入源的 L1 当基底被放行了（应在 resolveL1Base 之后按源拒）').toBe(403)
    expect(await res.json()).toEqual({
      error: 'METRIC_SOURCE_NOT_ADOPTED',
      its_source: 'shanhai',        // 这条 L1 的源
      your_sources: ['lemeng'],     // 本租户已接入的源
    })
    // 拒绝不是「先写后拒」：本租户桶里不留任何痕迹
    const raw = await pool.query(
      'select count(*)::int as n from data.metrics where org = $1 and id = $2', [ORG, 'l2_from_foreign'])
    expect(raw.rows[0].n).toBe(0)
  })

  it('★ POST expr 的第二个 ref 指向未接入源的 L1 ⇒ 403 METRIC_SOURCE_NOT_ADOPTED（闸从 1 个 base 扩到 N 个 ref）', async () => {
    const res = await post(exprBody({
      id: 'l2_from_foreign_expr',
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: L1_SALES.id }, right: { kind: 'ref', id: L1_FOREIGN.id } },
      },
    }))
    expect(res.status, '第二个 ref 在未接入源上却被放行（闸只看第一个 ref？）').toBe(403)
    // extra 的形状**逐字沿用** refine 那条用例：成功/拒绝的可解释体不许因档位而异
    expect(await res.json()).toEqual({
      error: 'METRIC_SOURCE_NOT_ADOPTED',
      its_source: 'shanhai',        // 未接入那条 ref 的源
      your_sources: ['lemeng'],     // 本租户已接入的源
    })
    // 拒绝不是「先写后拒」：本租户桶里不留任何痕迹
    const raw = await pool.query(
      'select count(*)::int as n from data.metrics where org = $1 and id = $2', [ORG, 'l2_from_foreign_expr'])
    expect(raw.rows[0].n).toBe(0)
  })

  it('PUT 打同一条未接入源的基底 ⇒ 同样 403（写路径两条路由的源闸必须同形）', async () => {
    const res = await app(ORG, ['data:manage']).request('/metrics/l2_from_foreign', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: 'l2_from_foreign', baseMetric: L1_FOREIGN.id })),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('METRIC_SOURCE_NOT_ADOPTED')
  })

  it('已接入源的 L1 当基底照常 201（源闸不是「一律拒」——别把整条写路径锁死）', async () => {
    const res = await post(l2Body({ id: 'l2_from_adopted', baseMetric: L1_SALES.id }))
    expect(res.status).toBe(201)
    // 清理：本用例自己造的行（避免污染后续断言「词表里有什么」）
    await pool.query('delete from data.metrics where org = $1 and id = $2', [ORG, 'l2_from_adopted'])
  })

  it('未接入源的 L1 不可见：GET /metrics 里没有它（但它**在**平台词表里——裁剪 ≠ 不存在）', async () => {
    const ids = (await (await app(ORG, ['data:query']).request('/metrics')).json())
      .metrics.map((m: { id: string }) => m.id)
    expect(ids, '未接入源的 L1 出现在消费面词表里').not.toContain(L1_FOREIGN.id)
    // 管理面（/metrics/all，不经裁剪）仍看得到它 ⇒ 上面那条不是「夹具没落库」
    const all = (await (await app(ORG, ['data:manage']).request('/metrics/all')).json())
      .metrics.map((m: { id: string }) => m.id)
    expect(all).toContain(L1_FOREIGN.id)
  })

  // ── fail-open 复核（spec §3⑧ 的「无身份 vs 没接源」）──────────────────────────
  // ⚠️ 无身份的 **401 是宿主门卫给的**（`declaredScopeGate`：`packages/platform-sdk/src/module.ts`
  //    里 `if (!identity) return c.json({ error: 'UNAUTHENTICATED' }, 401)`）——**不是**模块判的。
  //    模块自己**没有**任何鉴权代码（manifest 的 api.internal 由宿主施加），它内部那条
  //    「requester === null ⇒ 空词表」分支只有 `identity.orgId === ''`（门卫放行之后）才够得着。
  //    本组两条断言把这两个状态**分开**钉住：门卫在 ⇒ 401；门卫放行但 org 为空 ⇒ 空列表。
  //    （spec 原文的 fail-open 是「无身份与没接入源长得一样，都回空列表」——修法就是这一条 401。）
  it('★ 无身份（不经模块自身判定）的 GET /metrics ⇒ 宿主门卫给 401，不是空词表', async () => {
    // 照宿主 loader 的包裹层挂法：门卫先于模块路由，声明路径用模块相对路径（挂载前同基准）
    const shell = new Hono<ModuleVars>()
    shell.use('/metrics', declaredScopeGate([{ method: 'GET', path: '/metrics', scope: 'data:query' }]))
    shell.route('/', mod.createRouter({ pool }))
    const res = await (shell as unknown as Hono).request('/metrics')
    expect(res.status, '无身份请求没被门卫挡下（模块侧没有第二道鉴权）').toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('门卫放行但 orgId 为空串（模块侧唯一够得着「空词表」分支的形态）⇒ 200 空列表，不是报错', async () => {
    const res = await app('', ['data:query']).request('/metrics')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metrics: [] })
  })

  // ── 宿主投影的「已接入源」（计划 5）────────────────────────────────────────────
  // 宿主（apps/server/src/loader.ts）对声明 `tenantSources` 的模块按请求 set
  // `TENANT_SOURCES`；本模块只是**读**方。这里验两件事：
  //   ① 键进没进模块的 Env（`ModuleVars`）—— 读点写在 `Context<ModuleVars>` 上，
  //      键缺席就是 **typecheck 红**（不是运行期 undefined），这正是模块侧唯一的接线证据；
  //   ② 运行期读得到宿主 set 的值（设了是数组，没设是 undefined ⇒ 模块得按「宿主没投影」处置）。
  it('★ 模块变量表能读到宿主投影的已接入源（TENANT_SOURCES）：宿主 set 了就是数组，没 set 是 undefined', async () => {
    // 契约值钉死：键名是**宿主 set / 模块 get 的约定**（编译器不连线 ⇒ 改名是破坏性变更）。
    // 两边都引 SDK 常量 ⇒ 常量写错（或压根没导出，vitest 会把缺失的具名导出当 undefined 放行）
    // 时两边**一起错**，只有把字面量钉在断言里才拦得住——本用例的第一条红就是它。
    expect(TENANT_SOURCES).toBe('platform.tenantSources')

    const seen: Array<string[] | undefined> = []
    const shell = new Hono<ModuleVars>()
    shell.use('*', async (c, next) => {
      c.set('identity', makeIdentity({ orgId: ORG, scopes: ['data:query'] }))
      c.set('tenant', { id: 1, casdoor_org: ORG })
      c.set(TENANT_SOURCES, ['lemeng', 'shanhai'])
      await next()
    })
    // 读点（宿主投影 → 模块消费的接线）；`seen` 的元素类型由 c.get 推出 ⇒ 类型不符即编译红
    shell.use('*', async (c, next) => {
      seen.push(c.get(TENANT_SOURCES))
      await next()
    })
    shell.route('/', mod.createRouter({ pool }))

    const res = await (shell as unknown as Hono).request('/metrics')
    expect(res.status, '模块路由在被投影的请求上照常工作').toBe(200)
    expect(seen, '模块侧读不到宿主投影的值（键没进 ModuleVars？）').toEqual([['lemeng', 'shanhai']])

    // 宿主没投影（未声明 tenantSources 的部署形态）⇒ undefined：模块必须把它与「空集」分开处置
    const bare = new Hono<ModuleVars>()
    const bareSeen: Array<string[] | undefined> = []
    bare.use('*', async (c, next) => {
      c.set('identity', makeIdentity({ orgId: ORG, scopes: ['data:query'] }))
      c.set('tenant', { id: 1, casdoor_org: ORG })
      await next()
    })
    bare.use('*', async (c, next) => {
      bareSeen.push(c.get(TENANT_SOURCES))
      await next()
    })
    bare.route('/', mod.createRouter({ pool }))
    expect((await (bare as unknown as Hono).request('/metrics')).status).toBe(200)
    expect(bareSeen).toEqual([undefined])
  })

  // ── #489 语义追溯：无身份拒写 / 两列 / 审计端点 ────────────────────────────────
  it('★ 写路径无身份（orgId 空串）⇒ 403 UNAUTHENTICATED（不写「无主」审计）', async () => {
    const res = await app('', ['data:manage', 'data:query']).request('/metrics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: 'ma_noauth' })),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHENTICATED')
  })

  it('★ 建 → 改 → 删：/metrics/all 带 updatedBy/version（删前回读），audit 回三行倒序', async () => {
    const id = 'ma_flow'
    // 夹具自愈：审计行按 id 会**跨次累积**（不清就变成「跑第二次必红」——而这不是被测行为）
    await pool.query('delete from data.metric_audit where org = $1 and metric_id = $2', [ORG, id])
    expect((await post(l2Body({ id }))).status).toBe(201)                     // 建（POST）
    const put = await app(ORG, ['data:manage']).request(`/metrics/${id}`, {    // 改（PUT）
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id, alias: '改过的' })),
    })
    expect(put.status).toBe(200)

    // 删**之前**验证两列（删了就查不到了）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json() as {
      metrics: { id: string; updatedBy: string | null; version: number }[] }
    expect(all.metrics.find((m) => m.id === id)).toMatchObject({ updatedBy: 'u-test', version: 2 })

    expect((await app(ORG, ['data:manage']).request(`/metrics/${id}`, { method: 'DELETE' })).status).toBe(200)

    const audit = await (await app(ORG, ['data:manage']).request(`/metrics/${id}/audit`)).json() as {
      audit: { action: string; userId: string; channel: string }[] }
    expect(audit.audit.map((a) => a.action)).toEqual(['delete', 'update', 'create'])
    expect(audit.audit.every((a) => a.userId === 'u-test')).toBe(true)   // 记的是**人**（夹具默认 userId）
  })

  // ── B 中档：schema ↔ compiler 对偶（增补 §6.2 的**行为侧**）────────────────────────
  // 见文件末尾的顶层 describe《纯逻辑 · 无需库》——那一组（schema 直调 / 域层编译器 /
  // refine 缺 base）只碰纯逻辑、不触库，故**不能**挂在本 describePg（`dbUrl ? describe : describe.skip`）
  // 的门下：挂进库门会让无 DATABASE_URL 的环境把它们整个 skip ⇒ 本 Task 的交付物本身休眠
  // （本仓 CI 头注把这种绿称作假绿）。这里只留**走后端**的那一条（发 HTTP ⇒ 需要真库）。
  it('面级 HTTP：同一批形状 ⇒ 400 INVALID_BODY（不是静默 strip —— strip 是最坏的失败形态）', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['expr 多带 baseMetric', exprBody({ id: 'l2_duplex_x1', baseMetric: L1_SALES.id })],
      ['expr 多带 target', exprBody({ id: 'l2_duplex_x2', target: 1 })],
      ['expr 节点多带 fn', {
        id: 'l2_duplex_x3',
        op: { kind: 'expr', expr: { kind: 'ref', id: L1_SALES.id, fn: 'sum' } },
      }],
      ['refine 缺 baseMetric', { id: 'l2_duplex_x4', op: { kind: 'refine' } }],
      // ⚠️ HTTP 面走 JSON，而 JSON **表达不了** NaN（`JSON.stringify(NaN) === 'null'`）⇒
      //    这一条面级收到的其实是 null（同样落在 INVALID_BODY）。
      //    `.finite()` 拒 NaN 的**真正**证据在**纯逻辑块**那条 schema 直调用例里（绕开 JSON）。
      ['expr 的 num 是 NaN（过 JSON 后退化成 null）', {
        id: 'l2_duplex_x5',
        op: { kind: 'expr', expr: { kind: 'num', value: Number.NaN } },
      }],
    ]
    for (const [name, body] of bodies) {
      const res = await post(body)
      expect(res.status, `${name}：面级竟接受（400 才对）`).toBe(400)
      expect((await res.json()).error, name).toBe('INVALID_BODY')
    }
    // 正例对照：去掉多余键就 201（对偶不是「一律拒」；否则上面那批 400 一文不值）
    expect((await post(exprBody({ id: 'l2_duplex_ok' }))).status).toBe(201)
  })

  // ── 病态深度：深到量纲闸**之前**的解析/校验栈 ───────────────────────────────────
  // 已知边界（见 `modules/data/README.md`「L2 的已知边界」）：`EXPR_MAX_DEPTH` / `EXPR_MAX_REFS`
  // 在 zod 解析**之后**才生效 ⇒ 超深输入的拒绝路径**不保证**是 400。这条用例只钉住那唯一一条保证：
  // **绝不能被建成合法声明**。
  // 实测的失败点：zod 的 `z.lazy` 递归校验先爆栈（`RangeError: Maximum call stack size exceeded`），
  // 早于 `scanExpr` 的迭代走法 —— 这正是「先解析、后量纲」的实证。⚠️ 实跑状态码**不写进断言**
  // （把实际输出抄成期望值 = 恒真断言），只记进 README 的实测值。
  it('★ 病态深度的裸 JSON 体：不会被接受为合法声明（深度闸之前还有一层解析/校验栈）', async () => {
    // 手工拼串：`JSON.stringify` 自己会先爆栈，故逐层拼字符串
    let node = '{"kind":"num","value":1}'
    for (let i = 0; i < 5000; i++) node = `{"kind":"add","left":${node},"right":{"kind":"num","value":1}}`
    const raw = `{"id":"deep:probe","op":{"kind":"expr","expr":${node}}}`
    const res = await app(ORG, ['data:manage', 'data:query']).request('/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
    // 判据只有一条：**绝不能被当成合法声明建出来**（具体状态码是实测值，不在此写死）
    expect(res.status, '超深输入竟被建成合法声明').not.toBe(201)
    // 也**不该**留在词表里（防「主路径拒了、却留了半条行」）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json() as {
      metrics: { id: string }[] }
    expect(all.metrics.map((m) => m.id)).not.toContain('deep:probe')
  })

  // ── 词表参数面投影（spec 2026-10-15 §2.4）─────────────────────────────────────
  // 模型要靠词表才知道「这条指标能填什么参数键」——响应必须带 `{<名>: {type, required}}`。
  // `column` 是 SQL 内部面（参数名 ≠ 列名是常态），与 selectSql/subjectColumn 同口径不外泄。
  describePg('GET /metrics —— 参数面投影（spec 2026-10-15 §2.4）', () => {
    it('P1 params 只含 {type, required}；column 与 SQL 形状不出词表响应', async () => {
      // 夹具：L1 行带两个参数（date_range + string）；L1 只能经物化路径落库 ⇒
      // upsertL1Metric 直落（与 beforeAll 同源）。id 带 L1_ID_PREFIX ⇒
      // 清理由主 afterAll 的前缀删除收口。
      await upsertL1Metric(pool, l1Def({
        id: `${L1_ID_PREFIX}params_face`,
        params: {
          bizday: { column: 'bizday', type: 'date_range' },
          system_book: { column: 'system_book', type: 'string' },
        },
      }))
      // request 写法照本文件上一个 GET /metrics 用例（data:query 身份 + 模块相对路径）
      const res = await app(ORG, ['data:query']).request('/metrics')
      expect(res.status).toBe(200)
      const { metrics } = await res.json()
      const row = metrics.find((m: { id: string }) => m.id === `${L1_ID_PREFIX}params_face`)
      expect(row.params).toEqual({
        bizday: { type: 'date_range', required: false },
        system_book: { type: 'string', required: false },
      })
      // 口径不外泄：`column` / SQL 形状都不出词表响应
      expect(JSON.stringify(row)).not.toContain('"column"')
      expect(JSON.stringify(row)).not.toContain('select_sql')
      expect(JSON.stringify(row)).not.toContain('group_by')
    })
  })
})

// ── B 中档 · schema ↔ compiler 对偶（增补 §6.2 的**行为侧**）· 纯逻辑三条 ──────────
// 门禁⑧ 保的是**形状面**（字段名/字面量集在静态上一致）；这一组保的是**行为面**：
// 真正把同一批输入喂进去时，两边各自放不放行。两处漂移的典型症状是「面级放行、编译器拒」
// （用户拿到 500）或反过来（静默 strip ⇒ 写进去的东西与用户以为的不同）。
// ⚠️ 刻意**放在 describePg 之外**（顶层）：这三条只碰纯逻辑（zod schema / compileL2 / 内存
//    catalog），不触库；挂进 describePg 则无 DATABASE_URL 时全 skip ⇒ 交付物在无库环境下休眠。
//    同组第 4 条（面级 HTTP）确实要走真库，留在上面那个 describePg 内。
describe('L2 · B 中档 · schema ↔ compiler 对偶（纯逻辑 · 无需库）', () => {
  /** 域层基底：必须是 `source:'l1'` 的行（resolveL1Base 只认 L1 词表）。 */
  const l1Row = (over: Partial<MetricRow> = {}): MetricRow =>
    ({ ...L1_SALES, source: 'l1', updatedBy: null, version: 1, totalable: false, ...over })
  const catalog: MetricRow[] = [l1Row()]

  /** 域层编译结果：抛错 ⇒ 回它的 code；不抛 ⇒ null（期望抛时它会让断言自然红）。 */
  const codeOf = (decl: unknown): string | null => {
    try {
      compileL2(catalog, decl as L2Declaration)
      return null
    } catch (e) {
      return (e as { code?: string }).code ?? `非 SemanticCompileError：${String(e)}`
    }
  }

  it('节点形状坏 ⇒ **两侧都拒**：面级 schema 拒 且 域层 compileL2 抛 BAD_DECL', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      // ★ NaN 这条必须**两侧都出现**：面级靠 `z.number().finite()`，域层靠 scanExpr 的
      //   `!Number.isFinite` —— 只钉一侧的话，「.finite() 是装饰」这种漂移看不出来。
      ['num 是 NaN', { op: { kind: 'expr', expr: { kind: 'num', value: Number.NaN } } }],
      ['num 是 Infinity', { op: { kind: 'expr', expr: { kind: 'num', value: Number.POSITIVE_INFINITY } } }],
      ['ref 的 id 是空串', { op: { kind: 'expr', expr: { kind: 'ref', id: '' } } }],
      ['节点 kind 不在闭集', {
        op: {
          kind: 'expr',
          expr: { kind: 'pow', left: { kind: 'ref', id: L1_SALES.id }, right: { kind: 'num', value: 2 } },
        },
      }],
    ]
    for (const [name, decl] of bad) {
      expect(L2ExprDeclarationSchema.safeParse(decl).success, `${name}：面级 schema 竟放行`).toBe(false)
      expect(codeOf(decl), `${name}：域层编译器竟放行`).toBe('BAD_DECL')
    }
    // 正例对照：把 NaN 换成有限数就两侧都过 —— 证明上面拒的是「有限性」，不是「数字一概拒」
    const ok = { op: { kind: 'expr', expr: { kind: 'num', value: 3 } } }
    expect(L2ExprDeclarationSchema.safeParse(ok).success).toBe(true)
  })

  /**
   * 信封/节点上多带**未知键**：**面级拒，域层不读**。
   *
   * ⚠️ 这里刻意**不**断言「域层也拒」——实测（本用例同时把它钉住）：`compileL2` 对
   *    `baseMetric` / `target` / 节点上的 `fn` 既不读也不拒（`scanExpr` 只看 kind 与其必填字段，
   *    `compileExpr` 只看 `filters`）。把它们写成「两侧都拒」只会让用例因为**别的原因**
   *    变绿（把 ref 指到词表外 ⇒ 拿到的其实是 L1_BASE_NOT_FOUND）——那正是假绿。
   * 真正成立、且更该钉的对偶是：**这些键改不了产物**。面级把它们拦在门外，域层无视它们，
   * 两条路都不会让它们进 SQL ⇒ 判据是「带键与不带键的编译产物**逐字**相等」。
   */
  it('信封/节点多带未知键：面级 schema 拒（.strict()）；域层不读 ⇒ 产物逐字不变', () => {
    const clean = compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'ref', id: L1_SALES.id } },
    } as unknown as L2Declaration)
    const extras: Array<[string, Record<string, unknown>]> = [
      ['多带 baseMetric', { op: { kind: 'expr', expr: { kind: 'ref', id: L1_SALES.id } }, baseMetric: 'y' }],
      ['多带 target', { op: { kind: 'expr', expr: { kind: 'ref', id: L1_SALES.id } }, target: 1 }],
      ['节点多带 fn', { op: { kind: 'expr', expr: { kind: 'ref', id: L1_SALES.id, fn: 'sum' } } }],
    ]
    for (const [name, decl] of extras) {
      expect(L2ExprDeclarationSchema.safeParse(decl).success, `${name}：面级 schema 竟放行`).toBe(false)
      expect(codeOf(decl), `${name}：域层拒了它 —— 说明它读了不该读的键`).toBeNull()
      expect(compileL2(catalog, decl as unknown as L2Declaration).selectSql, `${name}：未知键改动了产物`)
        .toBe(clean.selectSql)
    }
  })

  it('refine 缺 baseMetric：面级 schema 拒（必填）且域层也拒（空 base ⇒ L1 词表里找不到）', () => {
    const decl = { op: { kind: 'refine' } }
    expect(L2RefineDeclarationSchema.safeParse(decl).success).toBe(false)
    // 码是 L1_BASE_NOT_FOUND 而不是 BAD_DECL：域层不单独校验「baseMetric 在不在」，
    // 它直接拿这个空值去 L1 词表里找 ⇒ 找不到就抛「该 id 不在词表」。拒是真的，只是码不同。
    expect(codeOf(decl)).toBe('L1_BASE_NOT_FOUND')
  })
})
