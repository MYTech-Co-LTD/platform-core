// metric-changes.test.ts —— 变更单端点行为 + 决策端点会话限定（P0 Task 5）。
// 壳不挂宿主门卫（沿 metrics.test.ts 惯例）：门禁由宿主按 manifest 施加，模块侧不写 requireScope。
// 隔离键与其它文件不同：org=org-p0-mc-routes；create 档的编译需要 L1 目录 ⇒ 夹具落平台桶
// （upsertL1Metric 固定写 org='platform'）⇒ 隔离靠**文件专属指标 id**，afterAll 按精确 id 回收。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL, TENANT_SOURCES, declaredScopeGate } from '@platform/sdk'
import type { NotifyPort } from '@platform/sdk'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import type { ModuleVars } from './context'
import mod from '../index'
import { submitChange } from '../domain/metric-change'
import { upsertL1Metric } from '../domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-mc-routes'
const L1_ID = 'b:p0mc_route_sales'
/** L1 夹具：字段以 metric-store.ts 的 L1MetricDef 为准（Task 3/4 同款形状）。 */
const L1_FIXTURE = {
  id: L1_ID,
  title: '销售(路由夹具)',
  description: 'metric-changes 路由测试夹具',
  requiredScope: null,
  subjectColumn: 'org',
  // 形状契约（parseL1Select）：恰好终结于关系名，不带 FROM 别名。
  selectSql: 'select sum(t.amt) as value, org, bizday from marts.f',
  groupBy: 'org, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}

/**
 * declaration 档的**关系白名单夹具**（P5 CI 修复）：B11 白名单来自平台桶 L1 行的 selectSql
 * 关系（`compileNewDeclaration` 的 `allowedRelations`）。空库里没有真实物化的
 * `fct_retail_sale` ⇒ declaration 的 expression 会被判「未纳管关系」。本地曾因其它测试文件
 * 残留的 L1 行假绿——这里自建一条同关系的 L1，让白名单自足，不依赖执行顺序/残留数据。
 * id 与 title 均文件专属（平台桶跨文件共用；文件并行时各删各的）。
 */
const DECL_REL_L1_ID = 'p5mc:l1:route_sales_fixture'
const DECL_REL_L1 = {
  id: DECL_REL_L1_ID,
  title: '声明关系白名单·routes',
  description: 'declaration 档 B11 关系白名单夹具',
  requiredScope: null,
  subjectColumn: 'org',
  selectSql: 'select sum(fct_retail_sale.sale_amount) as value, system_book, bizday from fct_retail_sale',
  groupBy: 'system_book, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}

const identityOf = () => makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] })
/** 会话通道壳（REQUESTER_CHANNEL 不设 = session）：tenant 钉本文件的 ORG。 */
const appOf = (execute: unknown) =>
  buildTestApp(mod, identityOf(), { pool, execute } as never, { id: 1, casdoor_org: ORG })

/** 把单据 preview.ranAt 拨到 N 毫秒前（模拟时间流逝，绕开 60s 重跑限速；P4 Task 4）。 */
const agePreview = (id: number, msAgo: number): Promise<unknown> =>
  pool.query(
    `update data.metric_change set preview = jsonb_set(preview, '{ranAt}', to_jsonb($2::text)) where id = $1`,
    [id, new Date(Date.now() - msAgo).toISOString()],
  )

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（Task 2/3/4 约定）：只删本文件专属 org。
  await pool.query('delete from data.metric_change where org = $1', [ORG])
  await pool.query('delete from data.metrics where org = $1', [ORG])
  // create 档自动试算要编译 L2 ⇒ 平台桶放一条文件专属 L1（resolveL1Base 按 id 找基底）。
  await upsertL1Metric(pool, L1_FIXTURE)
})
afterAll(async () => {
  // 平台桶只回收本文件的夹具行（精确 id；不碰其它真实 L1）。org 行按精确 org 回收
  // （org-elsewhere 是跨租户 404 用例的临时租户，一并清）。
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID])
  await pool.query('delete from data.metric_change where org = any($1)', [[ORG, 'org-elsewhere']])
  await pool.query('delete from data.metrics where org = $1', [ORG])
  await pool.end()
})

describePg('POST /metric-changes（提交即试算）', () => {
  it('提交 create 档 → 自动试算 → preview_ready（execute 注入，不碰真仓库）', async () => {
    const app = appOf(async () => ({ rows: [{ rows: 5, value: 100 }] }))
    const res = await app.request('/metric-changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:auto', kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' } } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { status: string; preview: { rows: number; value: number } } }
    expect(body.change.status).toBe('preview_ready')
    expect(body.change.preview.rows).toBe(5)
    expect(body.change.preview.value).toBe(100)
  })

  it('create 档无效基底 ⇒ 试算失败如实落 preview_failed（error 必有；issues 视异常档位而定）', async () => {
    const app = appOf(async () => ({ rows: [] }))
    const res = await app.request('/metric-changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:badbase', kind: 'create', payload: { baseMetric: 'b:ghost', op: { kind: 'refine' } } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { status: string; preview: { error?: string; issues?: unknown[] } } }
    expect(body.change.status).toBe('preview_failed')
    expect(typeof body.change.preview.error).toBe('string')
    expect(body.change.preview.error!.length).toBeGreaterThan(0)
    // L1_BASE_NOT_FOUND 是 SemanticCompileError 档 ⇒ 明细一并回写（P4 Task 4 修复轮补测）
    expect(Array.isArray(body.change.preview.issues)).toBe(true)
    expect(body.change.preview.issues!.length).toBeGreaterThan(0)
  })

  it('声明带自由 SQL 字段 ⇒ 400 INVALID_DECLARATION（结构化声明纪律，提交不落库）', async () => {
    const app = appOf(async () => ({ rows: [] }))
    const res = await app.request('/metric-changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:bad', kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' }, selectSql: 'select 1' } }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'INVALID_DECLARATION' })
  })
})

// ── P5 Task 1（2026-11-13）：declaration 档经 REST 提交（能力归还）──────────────────
// 枚举加值只是入口；语义闸（撞名/宽校验）与试算仍走域层同一份（不复制）。
describePg('P5 Task 1：POST /metric-changes 的 declaration 档', () => {
  const ENTRY = {
    name: 'p5mc:retail:route_decl',
    label: 'P5 路由·声明销售额',
    definition: 'P5 Task 1 declaration 路由夹具',
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
    expression: 'sum(fct_retail_sale.sale_amount)',
    grain: ['system_book', 'bizday'],
    freshness_sla_days: 1,
    reads: [],
  }
  const post = (body: unknown) => appOf(async () => ({ rows: [{ rows: 3, value: 30 }] })).request('/metric-changes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  beforeAll(async () => {
    // 编译尺的 B11 关系白名单（空库自足；见 DECL_REL_L1 注释）
    await upsertL1Metric(pool, DECL_REL_L1)
  })
  afterAll(async () => {
    await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1",
      [DECL_REL_L1_ID])
  })

  it('提交合法声明 ⇒ 自动试算 preview_ready；kind/metricId 落在单上', async () => {
    const res = await post({ metricId: ENTRY.name, kind: 'declaration', payload: ENTRY })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { kind: string; metricId: string; status: string; preview: { rows: number } } }
    expect(body.change.kind).toBe('declaration')
    expect(body.change.metricId).toBe(ENTRY.name)
    expect(body.change.status).toBe('preview_ready')
    expect(body.change.preview.rows).toBe(3)
  })

  it('撞 L1 名 ⇒ 400 ID_RESERVED_BY_L1，且不落单', async () => {
    const res = await post({ metricId: L1_ID, kind: 'declaration', payload: { ...ENTRY, name: L1_ID } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'ID_RESERVED_BY_L1' })
    const n = await pool.query(
      'select count(*)::int as n from data.metric_change where org = $1 and metric_id = $2', [ORG, L1_ID])
    expect(n.rows[0]?.n).toBe(0)
  })
})

// ── P4 收口（2026-11-13）：提交期预检下沉 submitChange —— **所有提交面共用一份** ──────
// 原先只有 MCP 两把旧工具内联这套判据，REST /metric-changes 与 submit_metric_change 可绕过；
// 放过的单会在试算里得到 preview_ready 的「绿单」，采纳期才死在同一个码上（白点一次）。
describePg('P4 收口：提交期预检（id 级 / 档级 / 不存在）', () => {
  const post = (body: unknown) => appOf(async () => ({ rows: [{ rows: 1, value: 1 }] })).request('/metric-changes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const ticketsOf = async (metricId: string): Promise<number> => {
    const r = await pool.query('select count(*)::int as n from data.metric_change where org = $1 and metric_id = $2', [ORG, metricId])
    return r.rows[0].n as number
  }
  /** 本租户一条指定 basis 的行（列清单照 insertTenantDeclaration / mcp-manage 夹具最小集）。 */
  const seedBasisRow = async (id: string, basis: 'declared' | 'column_agg'): Promise<void> => {
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by, params,
          source, updated_by, version, totalable, sla_days, freshness_relations, basis, certified, created_by)
       values ($1, $2, $3, '', null, 'org',
               'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
               'bizday', '{}'::jsonb, 'l2', 'u', 1, true, 1, '[]'::jsonb, $4, 'draft', 'u')`,
      [ORG, id, `档位夹具·${basis}`, basis])
  }

  it('★ REST submit 打 L1 保留 id ⇒ 400 ID_RESERVED_BY_L1，且不落单', async () => {
    const res = await post({ metricId: L1_ID, kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' } } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'ID_RESERVED_BY_L1' })
    expect(await ticketsOf(L1_ID)).toBe(0)
  })

  it('★ delete 平台口径 ⇒ 400 READONLY_L1，且不落单', async () => {
    const res = await post({ metricId: L1_ID, kind: 'delete' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'READONLY_L1' })
    expect(await ticketsOf(L1_ID)).toBe(0)
  })

  it('★ delete 不存在的 id ⇒ 提交期 404 METRIC_NOT_FOUND（不再落 preview_failed 死单）', async () => {
    const res = await post({ metricId: 'x:p4_no_such_metric', kind: 'delete' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'METRIC_NOT_FOUND' })
    expect(await ticketsOf('x:p4_no_such_metric')).toBe(0)
  })

  it('★ update 打 declared 行 ⇒ 400 DECLARED_NOT_EDITABLE；打 column_agg 行 ⇒ 400 BASIS_CONFLICT', async () => {
    const declaredId = 'x:p4_declared'
    const columnAggId = 'x:p4_column_agg'
    await seedBasisRow(declaredId, 'declared')
    await seedBasisRow(columnAggId, 'column_agg')
    try {
      const declared = await post({ metricId: declaredId, kind: 'update', payload: { baseMetric: L1_ID, op: { kind: 'refine' } } })
      expect(declared.status).toBe(400)
      expect(await declared.json()).toEqual({ error: 'DECLARED_NOT_EDITABLE' })
      expect(await ticketsOf(declaredId)).toBe(0)

      const columnAgg = await post({ metricId: columnAggId, kind: 'update', payload: { baseMetric: L1_ID, op: { kind: 'refine' } } })
      expect(columnAgg.status).toBe(400)
      expect(await columnAgg.json()).toEqual({ error: 'BASIS_CONFLICT' })
      expect(await ticketsOf(columnAggId)).toBe(0)
    } finally {
      await pool.query('delete from data.metrics where org = $1 and id = any($2)', [ORG, [declaredId, columnAggId]])
    }
  })
})

describePg('POST /metric-changes/:id/adopt（决策端点只认会话）', () => {
  it('PAT 通道 ⇒ 403 DECISION_REQUIRES_SESSION；会话通道（缺省）⇒ 过闸进域层（404=指标不存在，链路真）', async () => {
    const app = appOf(async () => ({ rows: [{ rows: 1, value: 1 }] }))
    const s = await submitChange(pool, ORG, { userId: 'agent', channel: 'pat' }, 'x:decide', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    await pool.query(`update data.metric_change set status='preview_ready', preview='{"rows":1}'::jsonb where id=$1`, [s.change.id])

    // PAT 通道：channel 中间件先于模块路由（宿主真实装配中该值由 pat-auth 设置；
    // 与 toolbox.test.ts「手搭设通道变量的壳」同思路——buildTestApp 的壳不设通道变量）。
    const patApp = new Hono<ModuleVars>()
    patApp.use('*', async (c, next) => { c.set(REQUESTER_CHANNEL, 'pat'); await next() })
    patApp.route('/', app as unknown as Hono<ModuleVars>)
    const refused = await patApp.request(`/metric-changes/${s.change.id}/adopt`, { method: 'POST' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'DECISION_REQUIRES_SESSION' })

    // 会话通道（壳不设 REQUESTER_CHANNEL = 缺省 session）：过闸进域层。
    // 采纳的目标指标 'x:decide' 不在 data.metrics ⇒ 域层如实 404 NOT_FOUND
    // （断言点是「不是 403 / 不是 5xx」：通道闸放行、分发到唯一编译点）。
    const okRes = await app.request(`/metric-changes/${s.change.id}/adopt`, { method: 'POST' })
    expect(okRes.status).toBe(404)
    expect(await okRes.json()).toMatchObject({ error: 'NOT_FOUND' })
    // 单据未被动过（状态机只认写成功后的 CAS 翻转）
    const still = await pool.query('select status from data.metric_change where id = $1', [s.change.id])
    expect(still.rows[0]?.status).toBe('preview_ready')
  })

  it('驳回缺 reason ⇒ 400 REASON_REQUIRED；list 按 pending 过滤', async () => {
    const app = appOf(async () => ({ rows: [] }))
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rej2', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    const noReason = await app.request(`/metric-changes/${s.change.id}/reject`, { method: 'POST' })
    expect(noReason.status).toBe(400)
    expect(await noReason.json()).toMatchObject({ error: 'REASON_REQUIRED' })
    const list = await app.request('/metric-changes?status=pending')
    expect(list.status).toBe(200)
    const body = await list.json() as { changes: Array<{ id: number }> }
    expect(body.changes.some((c) => c.id === s.change.id)).toBe(true)
  })
})

describePg('POST /metric-changes/:id/preview（重跑试算的租户与状态闸）', () => {
  it('已决单（adopted）⇒ 409 CHANGE_STATE_CHANGED（applyPreview 无自守，闸在路由）', async () => {
    const app = appOf(async () => ({ rows: [] }))
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:done', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    await pool.query(`update data.metric_change set status='adopted', decided_by='r', decided_at=now() where id=$1`, [s.change.id])
    const res = await app.request(`/metric-changes/${s.change.id}/preview`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'CHANGE_STATE_CHANGED' })
  })

  it('别人租户的单 / 不存在的 id / 非法 id ⇒ 404（租户闸 + 不给存在性探针）', async () => {
    const app = appOf(async () => ({ rows: [] }))
    const s = await submitChange(pool, 'org-elsewhere', { userId: 'a', channel: 'pat' }, 'x:other', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    const cross = await app.request(`/metric-changes/${s.change.id}/preview`, { method: 'POST' })
    expect(cross.status).toBe(404)
    const missing = await app.request('/metric-changes/999999/preview', { method: 'POST' })
    expect(missing.status).toBe(404)
    const malformed = await app.request('/metric-changes/not-a-number/preview', { method: 'POST' })
    expect(malformed.status).toBe(404)
  })

  it('提交后 60s 内重跑 ⇒ 409 PREVIEW_RATE_LIMITED（不改单）；preview.ranAt 拨到 2 分钟前 ⇒ 200（限速只挡连打）', async () => {
    const app = appOf(async () => ({ rows: [{ rows: 2, value: 20 }] }))
    const created = await app.request('/metric-changes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:rate', kind: 'meta', payload: { unit: '元' } }),
    })
    expect(created.status).toBe(200)
    const body = await created.json() as { change: { id: number; status: string } }
    // 首跑（提交即试算）刚落地 ranAt ⇒ 立刻重跑被限速
    const ranAtOf = async (): Promise<string | undefined> => {
      const q = await pool.query("select preview->>'ranAt' as ran_at from data.metric_change where id = $1", [body.change.id])
      return q.rows[0]?.ran_at as string | undefined
    }
    const ranAtBefore = await ranAtOf()
    expect(typeof ranAtBefore).toBe('string')
    const tooSoon = await app.request(`/metric-changes/${body.change.id}/preview`, { method: 'POST' })
    expect(tooSoon.status).toBe(409)
    expect(await tooSoon.json()).toMatchObject({ error: 'PREVIEW_RATE_LIMITED' })
    // 单据不被限速改动（仍是首跑落地的 preview_failed：meta 档目标指标不存在；ranAt 原样）
    const still = await pool.query('select status from data.metric_change where id = $1', [body.change.id])
    expect(still.rows[0]?.status).toBe('preview_failed')
    expect(await ranAtOf()).toBe(ranAtBefore)
    // 时间流逝（拨旧 ranAt）⇒ 解除限速，正常重跑
    await agePreview(body.change.id, 120_000)
    const ok = await app.request(`/metric-changes/${body.change.id}/preview`, { method: 'POST' })
    expect(ok.status).toBe(200)
  })

  it('pending 单重跑试算 ⇒ 200；目标指标不存在 ⇒ preview_failed 如实落库（meta 档读 data.metrics 当前口径）', async () => {
    const app = appOf(async () => ({ rows: [{ rows: 7, value: 42 }] }))
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rerun', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    const res = await app.request(`/metric-changes/${s.change.id}/preview`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { status: string; preview: { rows: number } } }
    expect(body.change.status).toBe('preview_failed')
    expect(body.change.preview).toMatchObject({ error: 'METRIC_NOT_FOUND' })
  })
})

describePg('GET /metric-changes（读面带 previewHistory，P1 Task 5）', () => {
  it('列表与详情回包都带 previewHistory 数组；提交即试算 + 补跑 ⇒ 历史恰 1 条', async () => {
    const app = appOf(async () => ({ rows: [{ rows: 7, value: 42 }] }))
    // 走路由提交（提交即试算：meta 档目标指标不存在 ⇒ 首枚失败快照落 preview）
    const post = await app.request('/metric-changes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:rh', kind: 'meta', payload: { unit: '元' } }),
    })
    expect(post.status).toBe(200)
    const submitted = await post.json() as { change: { id: number; previewHistory: unknown[] } }
    expect(submitted.change.previewHistory).toEqual([]) // 首跑无历史
    // 补跑一次 ⇒ 首枚快照进历史，history 恰 1 条（先把 ranAt 拨旧：60s 内重跑被限速，P4 Task 4）
    await agePreview(submitted.change.id, 120_000)
    const rerun = await app.request(`/metric-changes/${submitted.change.id}/preview`, { method: 'POST' })
    expect(rerun.status).toBe(200)
    const list = await app.request('/metric-changes?status=preview_failed')
    expect(list.status).toBe(200)
    const body = await list.json() as { changes: Array<{ id: number; previewHistory: unknown[] }> }
    const row = body.changes.find((c) => c.id === submitted.change.id)
    expect(row).toBeDefined()
    expect(Array.isArray(row?.previewHistory)).toBe(true)
    expect(row?.previewHistory).toHaveLength(1)
    expect(row?.previewHistory?.[0]).toMatchObject({ error: 'METRIC_NOT_FOUND' })
    const detail = await app.request(`/metric-changes/${submitted.change.id}`)
    const dbody = await detail.json() as { change: { previewHistory: unknown[] } }
    expect(dbody.change.previewHistory).toEqual(row?.previewHistory)
  })
})

describePg('★ 采纳 happy path 全链（P0 终审 F4）：提交即试算 → 会话采纳 → meta 变更 → 再采纳', () => {
  it('两条单全走路由 ⇒ 200；data.metrics 落行且 unit 写入；每次采纳 emit 一枚变更通知', async () => {
    const emitted: Array<{ eventKey?: string; payload?: Record<string, unknown> }> = []
    const notify: NotifyPort = { emit: async (_i, e) => { emitted.push(e); return { accepted: true } } }
    // 会话通道壳（REQUESTER_CHANNEL 不设 = session ⇒ 决策闸放行）；execute 注入让提交即试算
    // 不碰真仓库；sources=['lemeng'] 投影宿主的已接入源（L1 夹具 sourceSystem='lemeng'，写闸放行）。
    const app = buildTestApp(mod, identityOf(),
      { pool, execute: async () => ({ rows: [{ rows: 3, value: 9 }] }), notify } as never,
      { id: 1, casdoor_org: ORG }, ['lemeng'])
    const post = (path: string, body?: unknown) => app.request(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
    // ① create 提案：提交即试算（注入执行器）→ preview_ready → 会话采纳 ⇒ 200
    const c1 = await post('/metric-changes',
      { metricId: 'x:e2e', kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '端到端夹具' } })
    expect(c1.status).toBe(200)
    const b1 = await c1.json() as { change: { id: number; status: string } }
    expect(b1.change.status).toBe('preview_ready')
    const a1 = await post(`/metric-changes/${b1.change.id}/adopt`)
    expect(a1.status).toBe(200)
    // ② meta 变更单：同链再来一遍（meta 试算读已生效行的当前口径）⇒ 200
    const c2 = await post('/metric-changes', { metricId: 'x:e2e', kind: 'meta', payload: { unit: '元' } })
    expect(c2.status).toBe(200)
    const b2 = await c2.json() as { change: { id: number; status: string } }
    expect(b2.change.status).toBe('preview_ready')
    const a2 = await post(`/metric-changes/${b2.change.id}/adopt`)
    expect(a2.status).toBe(200)
    // 落库事实（不采信路由自述）：行在、unit 已写
    const row = await pool.query(`select unit from data.metrics where org = $1 and id = 'x:e2e'`, [ORG])
    expect(row.rows[0]?.unit).toBe('元')
    // 变更通知：每次采纳一枚（fail-open；事件已在 manifest 声明）
    expect(emitted.filter((e) => e.eventKey === 'data.metric.definition.changed')).toHaveLength(2)
    // P1 Task 4（销缓办③）：title 取**采纳动作之前**的快照——meta 档采纳前行已在 ⇒ 快照 title；
    // create 档采纳前行不存在 ⇒ 回退 metricId（快照语义的代价，计划写明）。
    expect(emitted[0]?.payload).toMatchObject({ metricId: 'x:e2e', title: 'x:e2e' })
    expect(emitted[1]?.payload).toMatchObject({ metricId: 'x:e2e', title: '端到端夹具' })
  })
})

describePg('★ delete 档采纳也发通知（P1 Task 4，销缓办③）', () => {
  it('delete 采纳 ⇒ emit 一枚，title 用**删前**快照（P0 时代采纳后 join 落空 ⇒ 永远无通知）', async () => {
    const emitted: Array<{ eventKey?: string; payload?: Record<string, unknown> }> = []
    const notify: NotifyPort = { emit: async (_i, e) => { emitted.push(e); return { accepted: true } } }
    const app = buildTestApp(mod, identityOf(),
      { pool, execute: async () => ({ rows: [{ rows: 3, value: 9 }] }), notify } as never,
      { id: 1, casdoor_org: ORG }, ['lemeng'])
    const post = (path: string, body?: unknown) => app.request(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
    // ① create 全链生效（行 title = 端到端删除夹具）
    const c1 = await post('/metric-changes',
      { metricId: 'x:e2e_del', kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '端到端删除夹具' } })
    expect(c1.status).toBe(200)
    const b1 = await c1.json() as { change: { id: number } }
    expect((await post(`/metric-changes/${b1.change.id}/adopt`)).status).toBe(200)
    // ② delete 单全链采纳 ⇒ 200
    const d = await post('/metric-changes', { metricId: 'x:e2e_del', kind: 'delete' })
    expect(d.status).toBe(200)
    const bd = await d.json() as { change: { id: number; status: string } }
    expect(bd.change.status).toBe('preview_ready')
    expect((await post(`/metric-changes/${bd.change.id}/adopt`)).status).toBe(200)
    // 落库事实：行已删
    const live = await pool.query(`select 1 from data.metrics where org = $1 and id = 'x:e2e_del'`, [ORG])
    expect(live.rows).toHaveLength(0)
    // create 一枚 + delete 一枚；delete 那枚的 title 是**删前**快照（行在时快照必非空，不吃 metricId 回退）
    const evts = emitted.filter((e) => e.eventKey === 'data.metric.definition.changed')
    expect(evts).toHaveLength(2)
    expect(evts[1]?.payload).toMatchObject({ metricId: 'x:e2e_del', title: '端到端删除夹具' })
  })
})

describePg('★ adopt eventId 拼变更单 id（P4 Task 4，销缓办⑤：同 metricId 重建不被事件去重吞）', () => {
  it('同 metricId 的 create / delete / 重建三张单 ⇒ 三条 eventId 彼此不同，且各自以本单 id 结尾', async () => {
    const emitted: Array<{ eventKey?: string; eventId?: string; payload?: Record<string, unknown> }> = []
    const notify: NotifyPort = { emit: async (_i, e) => { emitted.push(e); return { accepted: true } } }
    const app = buildTestApp(mod, identityOf(),
      { pool, execute: async () => ({ rows: [{ rows: 3, value: 9 }] }), notify } as never,
      { id: 1, casdoor_org: ORG }, ['lemeng'])
    const post = (path: string, body?: unknown) => app.request(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
    const submit = async (body: unknown): Promise<number> => {
      const res = await post('/metric-changes', body)
      expect(res.status).toBe(200)
      return ((await res.json()) as { change: { id: number } }).change.id
    }
    const adopt = async (id: number): Promise<void> => {
      expect((await post(`/metric-changes/${id}/adopt`)).status).toBe(200)
    }
    const MID = 'x:e2e_evt'
    // ① create 生效 → ② delete 删掉 → ③ 重建（delete→re-create 正是 P1 实证被去重吞的形状）
    const cId = await submit({ metricId: MID, kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '单号夹具' } })
    await adopt(cId)
    const dId = await submit({ metricId: MID, kind: 'delete' })
    await adopt(dId)
    const rId = await submit({ metricId: MID, kind: 'create', payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '单号夹具·重建' } })
    await adopt(rId)

    const evts = emitted.filter((e) => e.eventKey === 'data.metric.definition.changed')
    expect(evts).toHaveLength(3)
    const eventIds = evts.map((e) => e.eventId)
    // 去重键 = eventId：三条必须互不相同（同一 metricId 不再复用 version 段）
    expect(new Set(eventIds).size).toBe(3)
    // 末段是 `ch:<变更单 id>`（`ch:` 前缀让命名空间与 confirm-draft 的 `<metricId>:<version>`
    // 永不相交：同 org+metric 下整数撞车不会造成永久去重）
    expect(eventIds).toEqual([
      `data.metric.definition.changed:${ORG}:${MID}:ch:${cId}`,
      `data.metric.definition.changed:${ORG}:${MID}:ch:${dId}`,
      `data.metric.definition.changed:${ORG}:${MID}:ch:${rId}`,
    ])
  })
})

// ── P1 Task 7：override 档接入变更单 ────────────────────────────────────────────
// 隔离键 org-p1-mo-ovr（任务约定 org-p1-mo-*）。夹具 L1 的 id 必须是**三段蛇形**
//（entry.name = L1 id，而 compileTenantDeclaration 的名字白名单是 `<源>:<域>:<指标>` 三段），
// 且带本文件专用前缀（平台桶是跨文件共用桶，afterAll 按 id 精确回收，见 metrics.test.ts 的教训）。
describePg('P1 Task 7：override 档', () => {
  const OORG = 'org-p1-mo-ovr'
  const L1_OVR_A = 'p1mo:t7:sales_a'
  const L1_OVR_B = 'p1mo:t7:sales_b'
  const l1OvrFixture = (id: string) => ({
    id, title: `覆盖单夹具·${id}`, description: 'metric-changes Task 7 夹具',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
    groupBy: 'system_book, bizday', params: {}, sourceSystem: 'lemeng',
    slaDays: 1, freshnessRelations: [], masks: null,
  })
  /** W8 声明 entry（与 POST /metrics/:id/override 的 declaration 同形同源）。label 各用例错开。 */
  const ovrEntry = (over: Record<string, unknown> = {}) => ({
    name: L1_OVR_A, label: '本租户销售口径（变更单）', definition: '覆盖单测试', owner: 'data-platform',
    tier: 'experimental', source: 'lemeng', expression: 'sum(fct_retail_sale.sale_amount)',
    grain: ['system_book', 'bizday'], freshness_sla_days: 1, reads: [], ...over,
  })
  /** 本块专属壳：tenant 钉 OORG（文件级 appOf 钉的是本文件的 ORG，租户桶会落错 org）。 */
  const oappOf = (execute: unknown) =>
    buildTestApp(mod, identityOf(), { pool, execute } as never, { id: 1, casdoor_org: OORG })
  const post = (app: { request: (p: string, o?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
    app.request('/metric-changes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

  beforeAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [OORG])
    await pool.query('delete from data.metrics where org = $1', [OORG])
    await upsertL1Metric(pool, l1OvrFixture(L1_OVR_A))
    await upsertL1Metric(pool, l1OvrFixture(L1_OVR_B))
  })
  afterAll(async () => {
    // 平台桶按精确 id 回收（不碰真实物化 L1）；租户桶按本文件专属 org 清。
    await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = any($1)",
      [[L1_OVR_A, L1_OVR_B]])
    await pool.query('delete from data.metric_change where org = $1', [OORG])
    await pool.query('delete from data.metrics where org = $1', [OORG])
  })

  it('提交 → 试算（注入 execute，baseline=被覆盖 L1）→ 会话采纳 ⇒ 租户桶 override_of 草稿行，L1 不动', async () => {
    const app = oappOf(async () => ({ rows: [{ rows: 4, value: 77 }] }))
    const res = await post(app, { metricId: L1_OVR_A, kind: 'override', payload: ovrEntry() })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { id: number; status: string; preview: { value: number; baseline: { id: string } | null } } }
    expect(body.change.status).toBe('preview_ready')
    expect(body.change.preview.value).toBe(77)
    // baseline = 被 override 的 L1 同窗值（P1 Task 7 的试算语义）
    expect(body.change.preview.baseline?.id).toBe(L1_OVR_A)

    const adopt = await app.request(`/metric-changes/${body.change.id}/adopt`, { method: 'POST' })
    expect(adopt.status).toBe(200)
    // 落库事实：租户桶出现覆盖**草稿**行（确认启用仍走既有 W8 confirm 流）；单据翻 adopted
    const row = await pool.query(
      'select source, override_of, certified, select_sql from data.metrics where org = $1 and id = $2',
      [OORG, L1_OVR_A])
    expect(row.rows[0]).toMatchObject({
      source: 'l2', override_of: L1_OVR_A, certified: 'draft',
      select_sql: 'select sum(fct_retail_sale.sale_amount) as value, system_book, bizday from fct_retail_sale',
    })
    const ticket = await pool.query('select status from data.metric_change where id = $1', [body.change.id])
    expect(ticket.rows[0]?.status).toBe('adopted')
    // L1 平台行原样（口径没被顶掉——草稿不生效，D6）
    const l1 = await pool.query(
      "select source, select_sql from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_OVR_A])
    expect(l1.rows).toHaveLength(1)
    expect(l1.rows[0]).toMatchObject({ source: 'l1', select_sql: l1OvrFixture(L1_OVR_A).selectSql })
  })

  it('坏声明（引用未纳管关系）⇒ preview_failed 且 preview.issues 非空（P4 Task 4，销缓办⑥）', async () => {
    const app = oappOf(async () => ({ rows: [] }))
    const res = await post(app, {
      metricId: L1_OVR_A, kind: 'override',
      payload: ovrEntry({ label: '本租户销售口径·坏关系', expression: 'sum(no_such_relation.amount)' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      change: { status: string; preview: { error?: string; issues?: unknown[] } }
    }
    expect(body.change.status).toBe('preview_failed')
    expect(body.change.preview.error).toBe('DECLARATION_INVALID')
    // 编译失败带的可机检明细一并落 preview（不只是错误码）
    expect(Array.isArray(body.change.preview.issues)).toBe(true)
    expect(body.change.preview.issues!.length).toBeGreaterThan(0)
  })

  it('grain 不同形 ⇒ 提交/试算照走，采纳 400 透传写路径判据（GRAIN_MISMATCH），单据不被 CAS 翻转', async () => {
    const app = oappOf(async () => ({ rows: [{ rows: 1, value: 1 }] }))
    const res = await post(app, {
      metricId: L1_OVR_A, kind: 'override',
      payload: ovrEntry({ label: '本租户销售口径·异形粒度', grain: ['system_book'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { id: number; status: string } }
    // 编译尺不含「对行」判据 ⇒ 试算能出快照；grain 同形是采纳期的裁决
    expect(body.change.status).toBe('preview_ready')
    const adopt = await app.request(`/metric-changes/${body.change.id}/adopt`, { method: 'POST' })
    expect(adopt.status).toBe(400)
    expect(await adopt.json()).toMatchObject({ error: 'GRAIN_MISMATCH' })
    const still = await pool.query('select status from data.metric_change where id = $1', [body.change.id])
    expect(still.rows[0]?.status).toBe('preview_ready')
  })

  it('L1 不存在 ⇒ 提交即 404 NOT_FOUND（fail-early，深校验前的廉价闸）', async () => {
    const app = oappOf(async () => ({ rows: [] }))
    const res = await post(app, {
      metricId: 'p1mo:t7:ghost', kind: 'override',
      payload: ovrEntry({ name: 'p1mo:t7:ghost', label: '本租户销售口径·幽灵' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' })
  })

  it('宽预检：payload 缺 label / name≠metricId ⇒ 400；同名互斥**自夹具**（不跨用例依赖）＋桶恒 null 裁定', async () => {
    const app = oappOf(async () => ({ rows: [] }))
    const noLabel = await post(app, { metricId: L1_OVR_A, kind: 'override', payload: ovrEntry({ label: undefined }) })
    expect(noLabel.status).toBe(400)
    expect(await noLabel.json()).toMatchObject({ error: 'INVALID_DECLARATION' })
    const nameMismatch = await post(app, {
      metricId: L1_OVR_A, kind: 'override',
      payload: ovrEntry({ label: '本租户销售口径·名错', name: 'p1mo:t7:other' }),
    })
    expect(nameMismatch.status).toBe(400)
    expect(await nameMismatch.json()).toMatchObject({ error: 'INVALID_DECLARATION' })

    // ── 同名互斥（P1 Task 7 fix2 起自夹具，删跨用例依赖）：预置同租户 **null 桶**同名行 ⇒ 409
    //（预置行清理交 afterAll 的 org 级整桶清）
    const dupTitle = '本租户销售口径·自夹具撞名'
    await pool.query(
      `insert into data.metrics (org, id, title, subject_column, select_sql)
       values ($1, 'p1mo:t7:dup_probe', $2, 'org', 'select 1 as value from probe')`,
      [OORG, dupTitle])
    const dup = await post(app, {
      metricId: L1_OVR_B, kind: 'override',
      payload: ovrEntry({ name: L1_OVR_B, label: dupTitle }),
    })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ error: 'TITLE_EXISTS_IN_DEPT' })

    // ── 桶恒 null 裁定（P1 Task 7 fix2）：覆盖行经 insertTenantDeclaration 落库 owner_dept 恒
    // null ⇒ 判据桶必须恒 null（payload.ownerDept 不作桶参数）。预置行在「财务部」桶、payload
    // 带同桶 ownerDept——判据若吃 payload.ownerDept 就假拒 409；裁定下放行（200 落单）。
    const probeTitle = '本租户销售口径·桶对齐探针'
    await pool.query(
      `insert into data.metrics (org, id, title, subject_column, select_sql, owner_dept)
       values ($1, 'p1mo:t7:dept_probe', $2, 'org', 'select 1 as value from probe', '财务部')`,
      [OORG, probeTitle])
    const ignored = await post(app, {
      metricId: L1_OVR_B, kind: 'override',
      payload: ovrEntry({ name: L1_OVR_B, label: probeTitle, ownerDept: '财务部' }),
    })
    expect(ignored.status).toBe(200)
  })

  it('采纳撞 metrics_title_per_dept_uq ⇒ 409 TITLE_EXISTS_IN_DEPT（fix2：submit→adopt 并发占名窗口不裸 500）', async () => {
    const app = oappOf(async () => ({ rows: [{ rows: 1, value: 1 }] }))
    const winTitle = '本租户销售口径·并发窗口'
    // 先提单（此刻无同名行 ⇒ 提交期同名判据放行），再预置 null 桶同名行模拟 submit→adopt
    // 窗口里的并发占名——采纳期 insertTenantDeclaration 撞 title 唯一索引的 23505。
    const res = await post(app, {
      metricId: L1_OVR_B, kind: 'override',
      payload: ovrEntry({ name: L1_OVR_B, label: winTitle }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { id: number; status: string } }
    expect(body.change.status).toBe('preview_ready')
    await pool.query(
      `insert into data.metrics (org, id, title, subject_column, select_sql)
       values ($1, 'p1mo:t7:win_probe', $2, 'org', 'select 1 as value from probe')`,
      [OORG, winTitle])
    const adopt = await app.request(`/metric-changes/${body.change.id}/adopt`, { method: 'POST' })
    expect(adopt.status).toBe(409)
    expect(await adopt.json()).toMatchObject({ error: 'TITLE_EXISTS_IN_DEPT' })
    // 写失败 ⇒ CAS 未到，单据停在 preview_ready（终态未动，可驳回可重提）
    const still = await pool.query('select status from data.metric_change where id = $1', [body.change.id])
    expect(still.rows[0]?.status).toBe('preview_ready')
  })
})

// ── P6 Task 2 修复轮（2026-11-14）：采纳即授权 —— 决策端点两层 ─────────────────────
// ① 宿主门：manifest `POST /metric-changes/:id/adopt ⇒ data:manage`（declaredScopeGate 施加）；
// ② 域层门：creator ∪ data:manage（metric-write.ts，采纳期按**采纳人**判）。
// 两层缺一不可：只靠域层 = 非 manage 也能进域层；只靠宿主 = agent 提单后无 manage 管理员可采纳
// 但域层仍 403（P4 以来的错位，本修复轮钉住）。
describePg('P6 Task 2 修复轮：采纳授权（宿主门 + 域层 creator 门）', () => {
  const AID = 'x:p6_adopt_authz'
  /** 与 manifest 声明逐字同形的门卫壳（identity/tenant/sources 注入同 buildTestApp）。 */
  const gatedApp = (identity: ReturnType<typeof makeIdentity>) => {
    const shell = new Hono<ModuleVars>()
    shell.use('*', async (c, next) => {
      c.set('identity', identity)
      c.set('tenant', { id: 1, casdoor_org: ORG })
      c.set(TENANT_SOURCES, ['lemeng'])
      await next()
    })
    shell.use('/metric-changes/:id/adopt', declaredScopeGate([
      { method: 'POST', path: '/metric-changes/:id/adopt', scope: 'data:manage' },
    ]))
    shell.route('/', mod.createRouter({ pool } as never))
    return shell
  }
  const seedOwnedL2 = async (): Promise<void> => {
    await pool.query('delete from data.metric_change where org = $1 and metric_id = $2', [ORG, AID])
    await pool.query('delete from data.metrics where org = $1 and id = $2', [ORG, AID])
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by, params,
          source, updated_by, version, totalable, sla_days, freshness_relations, basis, certified, created_by)
       values ($1, $2, '采纳授权·路由夹具', '', null, 'org',
               'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
               'bizday', '{}'::jsonb, 'l2', 'u-owner', 1, true, 1, '[]'::jsonb, 'l1_tree', 'draft', 'u-owner')`,
      [ORG, AID])
  }
  /** agent（PAT、无 manage）提单 update → 直接推到 preview_ready（决策端点只关心快照在位）。 */
  const submitUpdateAsAgent = async (): Promise<number> => {
    const s = await submitChange(pool, ORG, { userId: 'u-agent', channel: 'pat' }, AID, 'update',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '采纳授权·路由' })
    if (!s.ok) throw new Error(`agent 提单被拒: ${s.error}`)
    await pool.query(
      `update data.metric_change set status='preview_ready', preview='{"rows":1}'::jsonb where id=$1`,
      [s.change.id])
    return s.change.id
  }

  it('★ 非 manage 第三人采纳 ⇒ 宿主门 403 need data:manage；admin 采纳同一单 ⇒ 200（域层 manage 豁免）', async () => {
    await seedOwnedL2()
    const id = await submitUpdateAsAgent()
    const third = await gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:query'], userId: 'u-third' }))
      .request(`/metric-changes/${id}/adopt`, { method: 'POST' })
    expect(third.status).toBe(403)
    expect(await third.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
    // 门卫拒在路由之前：单据未被消耗
    const still = await pool.query('select status from data.metric_change where id = $1', [id])
    expect(still.rows[0]?.status).toBe('preview_ready')
    // admin（持 manage）过宿主门 → 域层 creator ∪ data:manage 放行 ⇒ 200，行按提案改写
    const admin = await gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'], userId: 'u-admin' }))
      .request(`/metric-changes/${id}/adopt`, { method: 'POST' })
    expect(admin.status).toBe(200)
    const row = await pool.query('select title from data.metrics where org = $1 and id = $2', [ORG, AID])
    expect(row.rows[0]?.title).toBe('采纳授权·路由')
  })
})

describePg('POST /metric-changes/:id/withdraw（提交者本人）', () => {
  it('本人撤回 ⇒ 200 withdrawn；别人 ⇒ 403 FORBIDDEN', async () => {
    // 壳身份 = 提交者本人（withdrawChange 按 submitted_by = requester.userId 判）
    const me = makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'], userId: 'u-route-wd' })
    const app = buildTestApp(mod, me, { pool, execute: async () => ({ rows: [] }) } as never, { id: 1, casdoor_org: ORG })
    const s = await submitChange(pool, ORG, { userId: 'u-route-wd', channel: 'pat' }, 'x:wd', 'meta', { unit: '元' })
    if (!s.ok) throw new Error('unreachable')
    const good = await app.request(`/metric-changes/${s.change.id}/withdraw`, { method: 'POST' })
    expect(good.status).toBe(200)
    const after = await pool.query('select status from data.metric_change where id = $1', [s.change.id])
    expect(after.rows[0]?.status).toBe('withdrawn')
    const again = await app.request(`/metric-changes/${s.change.id}/withdraw`, { method: 'POST' })
    expect(again.status).toBe(403)
  })
})
