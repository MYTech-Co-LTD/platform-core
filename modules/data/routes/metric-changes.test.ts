// metric-changes.test.ts —— 变更单端点行为 + 决策端点会话限定（P0 Task 5）。
// 壳不挂宿主门卫（沿 metrics.test.ts 惯例）：门禁由宿主按 manifest 施加，模块侧不写 requireScope。
// 隔离键与其它文件不同：org=org-p0-mc-routes；create 档的编译需要 L1 目录 ⇒ 夹具落平台桶
// （upsertL1Metric 固定写 org='platform'）⇒ 隔离靠**文件专属指标 id**，afterAll 按精确 id 回收。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL } from '@platform/sdk'
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

const identityOf = () => makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] })
/** 会话通道壳（REQUESTER_CHANNEL 不设 = session）：tenant 钉本文件的 ORG。 */
const appOf = (execute: unknown) =>
  buildTestApp(mod, identityOf(), { pool, execute } as never, { id: 1, casdoor_org: ORG })

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
