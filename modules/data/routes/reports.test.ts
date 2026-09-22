// reports.test.ts — 报表路由（T7）的路由层测试 + 权限双门证据。
//
// 两套壳，各证一件事：
//  ① `buildTestApp`（模块壳，不挂门卫）——验业务面：幂等、双重门里的数据门（嵌入 token 里的
//     tenant 恒 = 调用者 org）、行级 requiredScope、对账差集、归档式删除。
//  ② `gatedApp`（**复刻宿主** loader.applyDeclaredApiGate 的注册形状）——验页门：无 `data:manage`
//     建报表 ⇒ **真** 403（由 SDK 的 `declaredScopeGate` 施加，模块自己不写 requireScope）。
//     为什么可以复刻：用的是**同一个** SDK 门卫 + 同一个声明来源（模块自己的 manifest）+
//     同一条注册序规则（静态在前、param 在后，#145）。模块壳里没有门卫，不复刻就只能断言
//     「manifest 声明了 scope」这种间接证据，而「无权限 ⇒ 403」是安全论断的一部分，要有直证。
//
// Metabase 侧走**真 env 通路**（`DATA_METABASE_URL/API_KEY/SECRET_KEY` + 全局 fetch 打桩）：
// 生产代码里不留测试专用注入口，且顺带验到「键读到没读到」这件事本身。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { declaredScopeGate } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import type { ModuleVars } from './context'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与既有测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-t7-reports'
const OTHER_ORG = 'org-t7-reports-other'
const TENANT = 9107
const SECRET = 'aaaa1111-bbbb-2222-cccc-333344445555'

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

interface FakeDash {
  id: number
  name: string
  embeddable: boolean
  archived: boolean
  embedding_params?: Record<string, string>
  enable_embedding?: boolean
}

/**
 * 内存版 Metabase 桩。**search 故意做成模糊**（`includes`）——真机 `/api/search` 就是模糊匹配，
 * 桩若做成全等，领域层「必须 name 全等才算命中」的判据在路由测试里就永远不被行使。
 */
function fakeMetabase(seed: FakeDash[] = []) {
  const state = { dashboards: [...seed], nextId: 100, calls: [] as { url: string; init?: RequestInit }[] }
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    state.calls.push({ url, init })
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const u = new URL(url)
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') ?? ''
      return json({
        data: state.dashboards
          .filter((d) => !d.archived && d.name.includes(q))
          .map((d) => ({ id: d.id, name: d.name, model: 'dashboard' })),
      })
    }
    if (u.pathname === '/api/dashboard/embeddable') {
      return json(state.dashboards.filter((d) => d.embeddable && !d.archived).map((d) => ({ id: d.id, name: d.name })))
    }
    if (u.pathname === '/api/dashboard' && method === 'POST') {
      const d: FakeDash = { id: state.nextId++, name: String(body?.name), embeddable: false, archived: false }
      state.dashboards.push(d)
      return json(d)
    }
    const m = /^\/api\/dashboard\/(\d+)$/.exec(u.pathname)
    // 对账回读（RR9②）：`GET /api/dashboard/{id}`。未发布过的 dashboard 真机回 `embedding_params: null`。
    if (m && method === 'GET') {
      const d = state.dashboards.find((x) => x.id === Number(m[1]))
      if (!d) return json({ message: 'not found' }, 404)
      return json({ id: d.id, name: d.name, embedding_params: d.embedding_params ?? null })
    }
    if (m && method === 'PUT') {
      const d = state.dashboards.find((x) => x.id === Number(m[1]))
      if (!d) return json({ message: 'not found' }, 404)
      if (typeof body?.archived === 'boolean') d.archived = body.archived
      if (typeof body?.enable_embedding === 'boolean') {
        d.enable_embedding = body.enable_embedding
        d.embeddable = body.enable_embedding
      }
      if (body?.embedding_params) d.embedding_params = body.embedding_params as Record<string, string>
      return json(d)
    }
    return json({ message: 'not found' }, 404)
  }
  return { state, fetcher }
}

/**
 * 让「删登记行」那一条语句失败（M-1：钉住 DELETE 的「**先归档、后删行**」顺序）。
 * 其余语句原样透传给真池子。顺序倒过来时本包装会让该用例转红（归档根本没发生）。
 */
function poolFailingReportDelete(base: Pool): Pool {
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (text: unknown, params?: unknown) => {
          if (typeof text === 'string' && /delete\s+from\s+data\.reports/i.test(text)) {
            throw new Error('simulated failure: delete from data.reports')
          }
          return (target.query as unknown as (t: unknown, p?: unknown) => Promise<unknown>)(text, params)
        }
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
  return proxy as unknown as Pool
}

/** 从返回的嵌入 URL 里取出 JWT 的 payload（断言「锁定的租户值到底写成了谁」的直证）。 */
function payloadOf(url: string): Record<string, unknown> {
  const token = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

/** 复刻 loader.applyDeclaredApiGate：真 SDK 门卫 + manifest 自己的声明 + 静态在前的注册序。 */
function gatedApp(identity: ReturnType<typeof makeIdentity>, pool: Pool | null) {
  const declared = mod.manifest.api?.internal ?? []
  const app = new Hono<ModuleVars>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    c.set('tenant', { id: TENANT, casdoor_org: identity.orgId })
    await next()
  })
  const guarded = new Hono()
  // 未挂载 ⇒ 门卫比对基准是【模块相对】路径（挂载后才是宿主绝对路径）——见 declaredScopeGate 头注
  const gate = declaredScopeGate(declared)
  const paths = [...new Set(declared.map((d) => d.path))]
    .sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
  for (const p of paths) guarded.use(p, gate)
  guarded.route('/', mod.createRouter({ pool: pool as never }))
  app.route('/', guarded)
  return app
}

describe('报表面声明（不需要数据库）', () => {
  it('五个端点都声明了，且页门分档：制作/登记/对账=data:manage，观看面=data:query', () => {
    const declared = new Map(
      (mod.manifest.api?.internal ?? []).map((d) => [`${d.method} ${d.path}`, d.scope]),
    )
    expect(declared.get('POST /reports')).toBe('data:manage')
    expect(declared.get('GET /reports')).toBe('data:query')
    expect(declared.get('GET /reports/:id/embed-url')).toBe('data:query')
    expect(declared.get('DELETE /reports/:id')).toBe('data:manage')
    expect(declared.get('POST /reports/reconcile')).toBe('data:manage')
  })

  it('★ 页门负测：只有 data:query ⇒ 建报表被门卫 403（模块自己不写 requireScope）', async () => {
    const res = await gatedApp(makeIdentity({ orgId: ORG }), null).request('/reports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '越权报表' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
  })

  it('★ 页门负测：只有 data:query ⇒ 对账 / 删除同样 403', async () => {
    const app = gatedApp(makeIdentity({ orgId: ORG }), null)
    expect((await app.request('/reports/reconcile', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/reports/whatever', { method: 'DELETE' })).status).toBe(403)
  })

  it('★ 静态兄弟路径不被 param 门卫误杀（#145）：POST /reports/reconcile 带 manage 可达（不是 403）', async () => {
    const app = gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), null)
    const res = await app.request('/reports/reconcile', { method: 'POST' })
    // 该壳未配 Metabase env（本 describe 不设）⇒ 应落到 503，而不是门卫的 403
    expect(res.status).not.toBe(403)
  })
})

describePg('报表路由（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let mb = fakeMetabase()

  // `applyMigrations` 放 beforeAll（**只在文件开头跑一次**）：迁移本身是幂等的，但每个用例都
  // 跑一次会让本文件成为 advisory lock 争用的主要来源（issue #169 的既知抖动：迁移持锁 2s 重试
  // vs vitest 5s 超时，表现为「每次命中的用例不同」）。用例间只需要清数据，不需要重跑迁移。
  beforeAll(async () => { await applyMigrations(pool) })

  beforeEach(async () => {
    await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER_ORG]])
    mb = fakeMetabase()
    vi.stubGlobal('fetch', mb.fetcher)
    process.env.DATA_METABASE_URL = 'https://mb.test/'
    process.env.DATA_METABASE_API_KEY = 'mb-api-key'
    process.env.DATA_METABASE_SECRET_KEY = SECRET
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DATA_METABASE_URL
    delete process.env.DATA_METABASE_API_KEY
    delete process.env.DATA_METABASE_SECRET_KEY
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  const shell = (identity: ReturnType<typeof makeIdentity>) => ({
    app: buildTestApp(mod, identity, { pool }, { id: TENANT, casdoor_org: identity.orgId }),
    identity,
  })
  const manage = () => shell(makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }))
  const viewer = () => shell(makeIdentity({ orgId: ORG, scopes: ['data:query'] }))
  const post = (app: Hono, body: unknown) => app.request('/reports', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('环境未配置 Metabase ⇒ 503 METABASE_UNCONFIGURED（配置状态，不是 500）', async () => {
    delete process.env.DATA_METABASE_URL
    const { app } = manage()
    const res = await post(app, { title: '未配置' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'METABASE_UNCONFIGURED' })
  })

  it('POST /reports：建 Metabase dashboard + 发布嵌入（tenant 锁死）+ 登记行', async () => {
    const { app } = manage()
    const res = await post(app, { title: '销售日报', lockedParams: { region: 'cn' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.created).toBe(true)
    expect(typeof body.id).toBe('string')

    // Metabase 侧：创建一次，且 embedding_params 里 **tenant 一定是 locked**——
    // 这是「看哪个租户的数据」在 Metabase 侧的落点（不写死它，租户绑定在真机上不成立）
    expect(mb.state.dashboards).toHaveLength(1)
    // name = **含 org 的规范名**（I-1）：Metabase 是单实例多租户共用，名字不带 org 会让两个租户
    // 的同名报表落到同一张 dashboard 上。用户可见的原标题只在 `data.reports.title` 里。
    expect(mb.state.dashboards[0]).toMatchObject({
      name: `${ORG}/销售日报`, embeddable: true, archived: false,
      embedding_params: { tenant: 'locked', region: 'locked' },
    })
    // 登记行
    const rows = await pool.query('select id, title, metabase_id, embed_params, required_scope from data.reports where org = $1', [ORG])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({
      id: body.id, title: '销售日报', metabase_id: mb.state.dashboards[0].id,
      embed_params: { region: 'cn' }, required_scope: null,
    })
  })

  it('★ 幂等：同 title 连发两次 ⇒ 不重复建（同一 id、库里 1 行、Metabase 只创建一次）', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '库存日报' })).json()
    const second = await (await post(app, { title: '库存日报', lockedParams: { region: 'cn' } })).json()
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
    expect(mb.state.dashboards).toHaveLength(1)
    const rows = await pool.query('select id from data.reports where org = $1', [ORG])
    expect(rows.rowCount).toBe(1)
    // 第二次是覆盖（PUT），创建只发生过一次
    expect(mb.state.calls.filter((c) => (c.init?.method ?? 'GET') === 'POST')).toHaveLength(1)
  })

  it('★ 保留参数 tenant 不许外部给：POST /reports 带 lockedParams.tenant ⇒ 400，且不碰 Metabase', async () => {
    const { app } = manage()
    const res = await post(app, { title: '越权', lockedParams: { tenant: OTHER_ORG } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'TENANT_PARAM_RESERVED' })
    expect(mb.state.calls).toHaveLength(0)
    const rows = await pool.query('select 1 from data.reports where org = $1', [ORG])
    expect(rows.rowCount).toBe(0)
  })

  it('GET /reports：只回本 org 的登记，投影 id/title/requiredScope', async () => {
    const { app } = manage()
    await post(app, { title: '销售日报' })
    await post(app, { title: '仅管理员', requiredScope: 'data:manage' })
    const body = await (await viewer().app.request('/reports')).json()
    // viewer 只有 data:query ⇒ 行级 requiredScope 把它裁掉
    expect(body.reports.map((r: { title: string }) => r.title)).toEqual(['销售日报'])
    expect(Object.keys(body.reports[0]).sort()).toEqual(['id', 'requiredScope', 'title'])

    const admin = await (await manage().app.request('/reports')).json()
    expect(admin.reports).toHaveLength(2)
  })

  it('★ 数据门：embed-url 的 locked tenant 恒 = 调用者 org（入参带 tenant 一律忽略）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报', lockedParams: { region: 'cn' } })).json()

    const res = await app.request(`/reports/${id}/embed-url?tenant=${OTHER_ORG}`)
    expect(res.status).toBe(200)
    const { url } = await res.json()
    expect(payloadOf(url)).toMatchObject({
      resource: {}, params: { tenant: ORG, region: 'cn' },
    })
    // 入参覆盖不了：tenant 是平台写死的那一个（上面 ?tenant=org-t7-reports-other 被忽略）
    expect(payloadOf(url).params).not.toMatchObject({ tenant: OTHER_ORG })
    const p = payloadOf(url)
    expect((p.resource as { dashboard: number }).dashboard).toBe(mb.state.dashboards[0].id)
    expect(p.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('★ 双重门分开：行上 requiredScope=data:manage ⇒ 只有 data:query 的人拿不到嵌入 URL（403）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '仅管理员', requiredScope: 'data:manage' })).json()
    const res = await viewer().app.request(`/reports/${id}/embed-url`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
    // 反证：有 data:manage 的人拿得到（不是「谁都拿不到」）
    expect((await app.request(`/reports/${id}/embed-url`)).status).toBe(200)
  })

  it('★ 跨租户：另一个 org 看不到本 org 的登记，也拿不到嵌入 URL（404，不泄露存在性）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()
    const other = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] }))
    expect((await (await other.app.request('/reports')).json()).reports).toEqual([])
    expect((await other.app.request(`/reports/${id}/embed-url`)).status).toBe(404)
    expect((await other.app.request(`/reports/${id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('DELETE /reports/:id：Metabase 侧归档 + 删登记行（对账差集的合法消除路径）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()
    expect((await app.request(`/reports/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(mb.state.dashboards[0].archived).toBe(true)
    expect((await pool.query('select 1 from data.reports where org = $1', [ORG])).rowCount).toBe(0)
    // 归档后不再出现在可嵌入集里 ⇒ 对账干净（这正是「先归档、再删行」的理由）
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, missingInMetabase: [], tenantUnlocked: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
    // 未知 id：404（不泄露存在性）
    expect((await app.request('/reports/nope', { method: 'DELETE' })).status).toBe(404)
  })

  it('★ 对账：双向差集**显式返回**，不静默（登记指向已消失的 dashboard / Metabase 有未登记的报表）', async () => {
    const { app } = manage()
    await post(app, { title: '已登记' })
    // 漂移①：登记行的 dashboard 在 Metabase 侧被手工删掉（本桩直接移除）
    mb.state.dashboards.splice(0, 1)
    // 漂移②：Metabase 侧手工建了一张可嵌入报表，平台没登记
    mb.state.dashboards.push({ id: 900, name: '手工建的报表', embeddable: true, archived: false })

    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec.ok).toBe(false)
    expect(rec.missingInMetabase).toEqual([
      expect.objectContaining({ title: '已登记', metabaseId: 100 }),
    ])
    // 人手建的（名字没有 org 命名空间前缀）⇒ 归属解不出 ⇒ 「需人看」那一类
    expect(rec.unregistered).toEqual({
      recoverable: [],
      needsHuman: [{ metabaseId: 900, name: '手工建的报表' }],
    })
  })

  it('对账无漂移 ⇒ ok:true 且两侧差集都空', async () => {
    const { app } = manage()
    await post(app, { title: '甲' })
    await post(app, { title: '乙' })
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, missingInMetabase: [], tenantUnlocked: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
    expect(rec.registered).toBe(2)
    expect(rec.embeddable).toBe(2)
  })

  it('★ RR9② 对账回读 embedding_params：tenant 未锁 ⇒ 显式报出（机械判据替代「靠人记得」的 README 约定）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '未锁报表' })).json()
    const dash = mb.state.dashboards[0]
    // Metabase 侧被手工改掉——等价于「dashboard 的租户参数不叫 tenant」那种静默失效
    dash.embedding_params = { region: 'locked' }

    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec.ok).toBe(false)
    expect(rec.tenantUnlocked).toEqual([
      expect.objectContaining({ id, title: '未锁报表', metabaseId: dash.id }),
    ])
    // 反证：锁回去 ⇒ 干净（不是「永远报未锁」）
    dash.embedding_params = { tenant: 'locked' }
    const clean = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(clean).toMatchObject({ ok: true, tenantUnlocked: [] })
  })

  it('★ I-1 两个 org 同 title ⇒ Metabase 侧两张不同 dashboard；B 的写 / 删都不碰 A 的', async () => {
    const a = shell(makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }))
    const b = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] }))
    const ra = await (await post(a.app, { title: '销售日报' })).json()
    const rb = await (await post(b.app, { title: '销售日报', lockedParams: { region: 'cn' } })).json()

    // ① Metabase 侧收到**两次** create，两张不同 id 的 dashboard，名字各带自己的 org 前缀
    const creates = mb.state.calls.filter(
      (c) => c.init?.method === 'POST' && new URL(c.url).pathname === '/api/dashboard',
    )
    expect(creates).toHaveLength(2)
    expect(ra.metabaseId).not.toBe(rb.metabaseId)
    expect(mb.state.dashboards.find((d) => d.id === ra.metabaseId)?.name).toBe(`${ORG}/销售日报`)
    expect(mb.state.dashboards.find((d) => d.id === rb.metabaseId)?.name).toBe(`${OTHER_ORG}/销售日报`)
    // 登记侧：各 org 一行，title 仍是**用户可见的原标题**（命名空间只在 Metabase 侧）
    const reg = await pool.query(
      'select org, title from data.reports where org = any($1) order by org', [[ORG, OTHER_ORG]],
    )
    expect(reg.rows).toEqual([
      { org: ORG, title: '销售日报' }, { org: OTHER_ORG, title: '销售日报' },
    ])

    // ② B 的 setEmbedding 只打到 B 那张：region 只有 B 声明过 ⇒ A 那张的 embedding_params 里不该有它
    const putsWithRegion = mb.state.calls.filter(
      (c) => c.init?.method === 'PUT' && String(c.init.body).includes('"region"'),
    )
    expect(putsWithRegion).toHaveLength(1)
    expect(putsWithRegion[0].url).toContain(`/api/dashboard/${rb.metabaseId}`)
    expect(mb.state.dashboards.find((d) => d.id === ra.metabaseId)?.embedding_params)
      .toEqual({ tenant: 'locked' })

    // ③ B 的 DELETE 只归档 B 那张；A 的报表照旧可取嵌入 URL（跨租户归档被结构上消除）
    expect((await b.app.request(`/reports/${rb.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(mb.state.dashboards.find((d) => d.id === rb.metabaseId)?.archived).toBe(true)
    expect(mb.state.dashboards.find((d) => d.id === ra.metabaseId)?.archived).toBe(false)
    expect((await a.app.request(`/reports/${ra.id}/embed-url`)).status).toBe(200)
    expect((await (await a.app.request('/reports')).json()).reports).toHaveLength(1)
  })

  it('★ I-2 同名孤儿 ⇒ 显式报出（旧判据下恒 ok:true 的假绿点）', async () => {
    const { app } = manage()
    await post(app, { title: '孤儿报表' })
    // 「先 search 后写」窗口的产物：Metabase 侧多出一张**同名同命名空间**的重复 dashboard
    mb.state.dashboards.push({ id: 901, name: `${ORG}/孤儿报表`, embeddable: true, archived: false })

    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec.ok).toBe(false)
    expect(rec.unregistered).toEqual({
      recoverable: [{ metabaseId: 901, name: `${ORG}/孤儿报表` }],
      needsHuman: [],
    })
    expect(rec.missingInMetabase).toEqual([])
  })

  it('★ I-2 多租户正常态：各 org 各自登记 ⇒ 无噪声（别人的 dashboard 不被报成本租户未登记）', async () => {
    const a = shell(makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }))
    const b = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] }))
    await post(a.app, { title: 'A 的报表' })
    await post(b.app, { title: 'B 的报表' })

    const rec = await (await a.app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, registered: 1, embeddable: 2,
      missingInMetabase: [], tenantUnlocked: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
  })

  it('★ I-2 / M-4 并发建同名（search 竞态）也会造孤儿 ⇒ 同样显式报出', async () => {
    const { app } = manage()
    // 把「先 search 后写」的窗口**卡死**成确定性的竞态：两个请求都先做完 search（都看到空集），
    // 再各自 POST。sleep 做不到这件事——Node 会在两个 timer 之间排空微任务，先到的请求会一路跑完。
    const base = mb.fetcher
    let arrived = 0
    let open: () => void = () => {}
    const bothArrived = new Promise<void>((resolve) => { open = resolve })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === '/api/search') {
        arrived += 1
        if (arrived >= 2) open()
        // 兜底 500ms：万一只有一方到（不该发生）也只是断言失败，不是挂死
        await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 500))])
      }
      return base(url, init)
    })
    // 两个请求在数组字面量里**同时发起**（不是先 await 一个再发下一个），再由 Promise.all 收齐
    const pending = [post(app, { title: '并发报表' }), post(app, { title: '并发报表' })]
    const [x, y] = await Promise.all(pending.map(async (r) => (await r).json()))
    expect(x.created).toBe(true)
    expect(y.created).toBe(true)
    // Metabase 侧两张 dashboard，登记行仍 1 行（unique (org, title) 挡着）⇒ 必有一张是孤儿
    expect(mb.state.dashboards).toHaveLength(2)
    const reg = await pool.query(
      'select metabase_id from data.reports where org = $1 and title = $2', [ORG, '并发报表'],
    )
    expect(reg.rowCount).toBe(1)
    const registeredId = reg.rows[0].metabase_id as number
    const orphanId = [x.metabaseId as number, y.metabaseId as number].find((i) => i !== registeredId)

    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec.ok).toBe(false)
    expect(rec.unregistered).toEqual({
      recoverable: [{ metabaseId: orphanId, name: `${ORG}/并发报表` }],
      needsHuman: [],
    })
  })

  it('★ M-1 删除顺序钉死：先归档、后删行（删行失败 ⇒ 归档**已经**发生，报 missingInMetabase 而非未登记噪声）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '顺序报表' })).json()
    const dashId = mb.state.dashboards[0].id
    const broken = buildTestApp(
      mod,
      makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }),
      { pool: poolFailingReportDelete(pool) },
      { id: TENANT, casdoor_org: ORG },
    )

    const res = await broken.request(`/reports/${id}`, { method: 'DELETE' })
    expect(res.status).not.toBe(204) // 删行失败 ⇒ 不许回「删成功」
    expect(res.status).toBeGreaterThanOrEqual(500)
    // ★ 顺序的落点：归档**在前**，所以此刻它已经发生（顺序倒过来这条必红，见报告「变异回归」）
    expect(mb.state.dashboards.find((d) => d.id === dashId)?.archived).toBe(true)

    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec.ok).toBe(false)
    expect(rec.missingInMetabase).toEqual([
      expect.objectContaining({ title: '顺序报表', metabaseId: dashId }),
    ])
    expect(rec.unregistered).toEqual({ recoverable: [], needsHuman: [] })
  })

  it('★ M-2 租户值来源钉死：casdoor_org 与 identity.orgId 分叉时，锁值仍取 requester.orgId', async () => {
    // 分叉形态（宿主当前三通道硬门拦着 ⇒ 真机不可达）：宿主租户 = OTHER_ORG，调用者身份 = ORG
    const forked = buildTestApp(
      mod,
      makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }),
      { pool },
      { id: TENANT, casdoor_org: OTHER_ORG },
    )
    const { id } = await (await post(forked, { title: '分叉报表' })).json()
    const res = await forked.request(`/reports/${id}/embed-url`)
    expect(res.status).toBe(200)
    const payload = payloadOf((await res.json()).url)
    expect(payload).toMatchObject({ params: { tenant: ORG } })
    expect(payload.params).not.toMatchObject({ tenant: OTHER_ORG })
    // 另一件事分开表态：登记行的隔离键（= Metabase 命名空间同源）仍取**宿主租户**
    const row = await pool.query('select org from data.reports where id = $1', [id])
    expect(row.rows[0].org).toBe(OTHER_ORG)
  })

  it('Metabase 侧 401 ⇒ 502（上游失败与「没配」分开表达），且不留半条登记行', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'Invalid API key: mb-api-key' }, 401))
    const { app } = manage()
    const res = await post(app, { title: '失败报表' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'METABASE_ERROR' })
    expect((await pool.query('select 1 from data.reports where org = $1', [ORG])).rowCount).toBe(0)
  })

  it('M3 守卫（orgId 为空串）⇒ GET 空列表 / POST 403 UNAUTHENTICATED（fail-closed）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: '' }), { pool }, { id: TENANT, casdoor_org: '' })
    expect(await (await app.request('/reports')).json()).toEqual({ reports: [] })
    expect((await post(app, { title: 'x' })).status).toBe(403)
  })

  it('body 不合法 ⇒ 400 INVALID_BODY（不碰 Metabase）', async () => {
    const { app } = manage()
    expect((await post(app, {})).status).toBe(400)
    expect((await post(app, { title: '' })).status).toBe(400)
    expect(mb.state.calls).toHaveLength(0)
  })
})
