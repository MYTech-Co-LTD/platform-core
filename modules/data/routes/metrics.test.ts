// metrics.test.ts — 指标词表路由的测试（词表裁剪 + 管理面 + T8 的 L2 定义面收紧）。
//
// 模块壳不挂宿主门卫：缺 data:manage 的拒绝归宿主门卫（T10 端到端验），
// 这里验裁剪语义（「看不见」不是报错）与管理面写路径的**新契约**——
// 写路径只收结构化 `L2Declaration`，自由 SQL 入参一律 400（全局约束 12）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { L1_ORG, upsertL1Metric, upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'

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
const L1_SALES = def({
  id: 'retail:net_sales', title: '净销售额',
  selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
  groupBy: 'system_book, bizday',
})
const L1_FINANCE = def({
  id: 'retail:margin', title: '毛利', requiredScope: 'data:finance',
  selectSql: 'select sum(fct_retail_sale.margin) as value, system_book from fct_retail_sale',
  groupBy: 'system_book',
})
/** M-① 的撞 id 探针：**先**由租户建 L2、**后**由平台物化同 id（唯一能造出撞 id 的合法时序）。 */
const L1_CLASH_PROBE = 'retail:clash_probe'

/** 合法 L2 声明（各用例只覆盖自己关心的字段）。 */
const l2Body = (over: Record<string, unknown> = {}) => ({
  id: 'l2_net_sales_xiongmao',
  baseMetric: 'retail:net_sales',
  op: { kind: 'refine' },
  ...over,
})

function app(org: string, scopes: string[]) {
  return buildTestApp(mod, makeIdentity({ orgId: org, scopes }), { pool }, { id: 1, casdoor_org: org })
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
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = any($1::text[])', [[ORG, OTHER_ORG]]).catch(() => {})
    // L1 桶跨文件共用 ⇒ 只删本文件放进去的两条（别 `where org='platform'`，会删掉并行兄弟的夹具）
    await pool.query('delete from data.metrics where org = $1 and id = any($2::text[])',
      [L1_ORG, [L1_SALES.id, L1_FINANCE.id, L1_CLASH_PROBE]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  // ── 读路径：L1 ∪ L2 合并 + scope 裁剪 ─────────────────────────────────────────
  it('GET /metrics：L1 行对本租户可见，且 data:query 身份看不到 data:finance 指标（看不见，不是报错）', async () => {
    const res = await app(ORG, ['data:query']).request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain('retail:net_sales')
    expect(ids, 'data:finance 的 L1 指标对只有 data:query 的人可见了').not.toContain('retail:margin')
    // 消费面投影：严格三字段——selectSql/subjectColumn 属实现细节，不外泄
    expect(body.metrics.find((m: { id: string }) => m.id === 'retail:net_sales'))
      .toEqual({ id: 'retail:net_sales', title: '净销售额', description: def().description })
  })

  it('GET /metrics 不掺别家 L2 行（跨租户串词表是禁止的）', async () => {
    await upsertMetric(pool, OTHER_ORG, def({ id: 'other_org_l2', title: '别家的' }))
    const body = await (await app(ORG, ['data:query']).request('/metrics')).json()
    expect(body.metrics.map((m: { id: string }) => m.id)).not.toContain('other_org_l2')
  })

  it('GET /metrics/all（管理面）带 source：L1 标 l1、本租户标 l2（管理员据此知道哪行只读）', async () => {
    const body = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    const byId = new Map(body.metrics.map((m: { id: string }) => [m.id, m]))
    expect(byId.get('retail:net_sales')).toMatchObject({ source: 'l1', subjectColumn: 'org' })
    expect(byId.get('other_org_l2')).toBeUndefined()
  })

  // ── 写路径：只收结构化声明 ───────────────────────────────────────────────────
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
    const res = await post(l2Body({ baseMetric: 'retail:not_declared' }))
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

  it('POST op.kind 不是 refine ⇒ 400 INVALID_BODY（zod 层拦下，表达力档位不私自放行）', async () => {
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
    const res = await post(l2Body({ id: 'retail:net_sales' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('ID_RESERVED_BY_L1')
    // 且**没有**写进去任何东西（不留下一条加载侧永远看不见的僵尸 L2 行）
    const raw = await pool.query('select count(*)::int as n from data.metrics where org = $1 and id = $2', [ORG, 'retail:net_sales'])
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
    const put = await app(ORG, ['data:manage']).request('/metrics/retail:net_sales', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: 'retail:net_sales' })),
    })
    expect(put.status).toBe(409)
    expect((await put.json()).error).toBe('ID_RESERVED_BY_L1')

    const del = await app(ORG, ['data:manage']).request('/metrics/retail:net_sales', { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect((await del.json()).error).toBe('READONLY_L1')

    // L1 行安然无恙（没被改名也没被删）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json()
    expect(all.metrics.find((m: { id: string }) => m.id === 'retail:net_sales')).toMatchObject({
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
    await upsertL1Metric(pool, def({ id: clashId, title: '平台同 id 版' }))

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
})
