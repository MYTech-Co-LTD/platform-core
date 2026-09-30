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
import { upsertReport } from '../domain/report-store'
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

/** 真机 `GET /api/dashboard/{id}` 里 dashcard 的形状（snake_case；`parameter_mappings` 可缺）。 */
interface FakeDashcard {
  id: number
  /** `null` = **文本/虚拟卡**（真机实测 `card_id=None`，内容在 `visualization_settings.text`）。 */
  card_id: number | null
  row: number
  col: number
  size_x: number
  size_y: number
  parameter_mappings?: unknown[]
  /** 文本卡的文字在这里 —— 桩必须能存/读它，否则「合并 PUT 不清文字」这件事在路由级测不出来。 */
  visualization_settings?: unknown
}

/** dashboard 参数（Metabase 侧形状）。平台只依赖 `slug`，其余原样流转。
 * `sectionId`：publishWithTenantBinding 声明 tenant 参数时带的真机字段（staging 段落）。 */
interface FakeDashParam {
  slug: string
  id?: string
  name?: string
  type?: string
  sectionId?: string
}

interface FakeDash {
  id: number
  name: string
  embeddable: boolean
  archived: boolean
  embedding_params?: Record<string, string>
  enable_embedding?: boolean
  /** 卡片的**全量**读侧形状：`getDashboardFull` 靠它把「不带 dashcards 的 PUT」变成非破坏性。 */
  dashcards?: FakeDashcard[]
  parameters?: FakeDashParam[]
}

/**
 * 内存版 Metabase 桩。**search 故意做成模糊**（`includes`）——真机 `/api/search` 就是模糊匹配，
 * 桩若做成全等，领域层「必须 name 全等才算命中」的判据在路由测试里就永远不被行使。
 *
 * `cards` = cardId → `dataset_query.stages[0]`（发布路径要读每张卡的模板标签，见
 * `publishWithTenantBinding`）；不在 `cards` 里的卡 404——与真机「读不出就是读不出」一致。
 *
 * ⚠️ `PUT /api/dashboard/{id}` 对 `dashcards` / `parameters` 是**替换**语义（body 里没有该键
 *    ⇒ 清空）：这正是真机上「裸 PUT 会把卡片表列整条替换掉」的机制（本计划的 bug 本体）。
 *    桩若做成「给了才改」，`putDashboardMerged` 退化成裸 PUT 时**不会有任何断言变红**——
 *    桩于是成了「怎么改都绿」的假面（`getDashboardFull` 读不出 dashcards 时抛形状错也是同理）。
 */
function fakeMetabase(seed: FakeDash[] = [], cards: Record<number, Record<string, unknown>> = {}) {
  const state = {
    dashboards: [...seed], cards, nextId: 100,
    calls: [] as { url: string; init?: RequestInit }[],
  }
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
    // `dashcards` / `parameters` 是真机会回的**全量**字段（缺了它们，`getDashboardFull` 会抛形状错）。
    if (m && method === 'GET') {
      const d = state.dashboards.find((x) => x.id === Number(m[1]))
      if (!d) return json({ message: 'not found' }, 404)
      return json({
        id: d.id, name: d.name,
        dashcards: d.dashcards ?? [], parameters: d.parameters ?? [],
        embedding_params: d.embedding_params ?? null,
      })
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
      // 替换语义（见桩头注）：body 里没有该键 ⇒ 清空。**存回去**是「不清卡」那条断言能被行使的前提。
      d.dashcards = Array.isArray(body?.dashcards) ? body.dashcards as FakeDashcard[] : []
      d.parameters = Array.isArray(body?.parameters) ? body.parameters as FakeDashParam[] : []
      return json(d)
    }
    const cm = /^\/api\/card\/(\d+)$/.exec(u.pathname)
    if (cm && method === 'GET') {
      const stage = state.cards[Number(cm[1])]
      if (stage === undefined) return json({ message: 'not found' }, 404)
      return json({ dataset_query: { stages: [stage] } })
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
  it('十个报表端点都声明了（api.internal 全模块共 21 条），且页门分档：管理动作=data:manage，观看面=data:query', () => {
    const declared = new Map(
      (mod.manifest.api?.internal ?? []).map((d) => [`${d.method} ${d.path}`, d.scope]),
    )
    // 总数钉 21（原 19 + 本任务两条 /spec 端点）：穷举口径（同 module.test.ts 的表清单）——
    // 别处加端点而漏改这里会红，逼着声明与测试一起动。
    expect(declared).toHaveLength(21)
    expect(declared.get('POST /reports')).toBe('data:manage')
    expect(declared.get('GET /reports')).toBe('data:query')
    expect(declared.get('GET /reports/:id/embed-url')).toBe('data:query')
    // 编辑入口是**管理动作**（能改报表的人才拿得到），与观看面的 embed-url 分档
    expect(declared.get('GET /reports/:id/edit-url')).toBe('data:manage')
    expect(declared.get('DELETE /reports/:id')).toBe('data:manage')
    expect(declared.get('POST /reports/reconcile')).toBe('data:manage')
    expect(declared.get('GET /reports/manage')).toBe('data:manage')
    expect(declared.get('PUT /reports/:id')).toBe('data:manage')
    // ── 自绘规格读写（#391 计划 6 Task 3）：读=观看面（行级页门照 embed-url 的 visibleTo），
    //    写=管理面（改规格就是改报表内容，与 PUT /reports/:id 同档）。
    expect(declared.get('GET /reports/:id/spec')).toBe('data:query')
    expect(declared.get('PUT /reports/:id/spec')).toBe('data:manage')
  })

  it('★ 页门负测：只有 data:query ⇒ 管理清单 / 页门改动同样 403', async () => {
    const app = gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:query'] }), null)
    // ⚠️ 断言必须带 body（`need: 'data:manage'`），不能只断 status（订正记录 2026-09-29，Task 2
    // 实施中发现）：**未声明**的路径走门卫的 `!hit` 兜底，同样给 403——只断 status 的话，这条负测
    // 在「manifest 还没加两行声明」的红跑里就是绿的，manifest 声明根本没被这测试承重。
    const list = await app.request('/reports/manage')
    expect(list.status).toBe(403)
    expect(await list.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
    const put = await app.request('/reports/whatever', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: null }),
    })
    expect(put.status).toBe(403)
    expect(await put.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
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

  it('★ 页门负测：只有 data:query ⇒ PUT /reports/:id/spec 403（带 need）；GET /reports/:id/spec 过门', async () => {
    const app = gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:query'] }), null)
    const put = await app.request('/reports/whatever/spec', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: 1 }),
    })
    // 断言带 body（need: 'data:manage'）：只断 status 的话「未声明路径」的 !hit 兜底同样 403，
    // manifest 那两行声明就没被这条负测承重（同上方管理清单负测的订正口径）。
    expect(put.status).toBe(403)
    expect(await put.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
    // GET 是观看面：data:query 恰好够 ⇒ 门卫放行（壳里 pool=null ⇒ 后续 404/500 都可能，唯独不许 403）
    const get = await app.request('/reports/whatever/spec')
    expect(get.status).not.toBe(403)
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
    // 编辑入口的 fail-closed（评审 I-3）要求会话密钥 ≥32 字符才签票据；测试里走真 env 通路，
    // 与上面 DATA_METABASE_* 同款卫生（afterEach 清理）。
    process.env.PLATFORM_SESSION_SECRET = 'test-session-secret-test-session-secret!'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DATA_METABASE_URL
    delete process.env.DATA_METABASE_API_KEY
    delete process.env.DATA_METABASE_SECRET_KEY
    delete process.env.PLATFORM_SESSION_SECRET
    // 评审 M-1：编辑入口的 origin 也收进统一清理，别只靠每个用例自己删。
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
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
  /**
   * 登记侧版本回读（管理清单 = console 的取版本通路；Task 3 起 PUT/DELETE 必须回带它）。
   * 刻意不写死数字：版本由库侧维护，测试从**消费方看到的那个值**取，才与前端同路。
   */
  const versionOf = async (app: Hono, id: string): Promise<number> => {
    const body = await (await app.request('/reports/manage')).json() as {
      reports: { id: string; version: number }[]
    }
    return body.reports.find((r) => r.id === id)!.version
  }

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
    // 内容侧写保护（Task 2）：二次 POST = **更新既有 dashboard** ⇒ 必须回带当前指纹（201 已回带它）。
    // 本用例的题意不变（同 title 连发不重复建），同时兼作「回带的指纹是当前那个 ⇒ 被接受」的直证。
    const second = await (await post(app, {
      title: '库存日报', lockedParams: { region: 'cn' }, expectedFingerprint: first.fingerprint,
    })).json()
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
    expect(mb.state.dashboards).toHaveLength(1)
    const rows = await pool.query('select id from data.reports where org = $1', [ORG])
    expect(rows.rowCount).toBe(1)
    // 第二次是覆盖（PUT），创建只发生过一次
    expect(mb.state.calls.filter((c) => (c.init?.method ?? 'GET') === 'POST')).toHaveLength(1)
  })

  it('★ 路由级回归：已有卡的 dashboard 上重跑 POST /reports ⇒ 卡不被清，且三件套成立', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '已有卡的报表' })).json()
    const dash = mb.state.dashboards.find((d) => d.id === first.metabaseId)
    if (dash === undefined) throw new Error('首次 POST 后 dashboard 应在桩里')
    // 人/agent 已往这张报表上放了卡：一张带 tenant 标签（该映射）、一张不带（不许映射）、一张文本卡
    dash.dashcards = [
      { id: 1, card_id: 101, row: 0, col: 0, size_x: 12, size_y: 6 },
      { id: 2, card_id: 102, row: 6, col: 0, size_x: 6, size_y: 4 },
      { id: 3, card_id: null, row: 6, col: 6, size_x: 6, size_y: 4, visualization_settings: { text: '备注' } },
    ]
    mb.state.cards = {
      101: { native: 'select 1 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } },
      102: { native: 'select 2' },
    }

    // 内容侧写保护（Task 2）：人往报表上加了卡 ⇒ 内容已**不是**首建那一份 ⇒ 重跑必须先取**当前**指纹。
    // 走一遍 fail-closed 的发现路径（不带 ⇒ 409 VERSION_REQUIRED 回带 currentFingerprint）再重跑——
    // 本用例考的是「重跑不清卡」，不是「不带指纹会被拒」（后者由写保护用例咬）。
    const probe = await post(app, { title: '已有卡的报表' })
    expect(probe.status).toBe(409)
    const { currentFingerprint } = await probe.json() as { currentFingerprint: string }
    const second = await (await post(app, {
      title: '已有卡的报表', expectedFingerprint: currentFingerprint,
    })).json()
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
    // 卡片没被清（三件套那次合并 PUT 也不清卡——旧 bug 的路由级形态就是这里变成 0 张）
    expect(dash.dashcards).toHaveLength(3)
    // 只映射带 tenant 标签的那张；文本卡与不带标签的卡都不动
    expect(dash.dashcards[0].parameter_mappings).toEqual([
      { parameter_id: 'tenant-param', card_id: 101, target: ['variable', ['template-tag', 'tenant']] },
    ])
    expect(dash.dashcards[1].parameter_mappings ?? []).toEqual([])
    expect(dash.dashcards[2]).toMatchObject({ card_id: null, visualization_settings: { text: '备注' } })
    expect(dash.dashcards[2].parameter_mappings ?? []).toEqual([])
    // 声明了 dashboard 级 tenant 参数 + 锁参（三件套在路由出口也成立）
    expect((dash.parameters ?? []).map((p) => p.slug)).toContain('tenant')
    expect(dash.embedding_params).toEqual({ tenant: 'locked' })
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

  it('GET /reports：只回本 org 的登记，投影 id/title/requiredScope/renderer', async () => {
    const { app } = manage()
    await post(app, { title: '销售日报' })
    await post(app, { title: '仅管理员', requiredScope: 'data:manage' })
    const body = await (await viewer().app.request('/reports')).json()
    // viewer 只有 data:query ⇒ 行级 requiredScope 把它裁掉
    expect(body.reports.map((r: { title: string }) => r.title)).toEqual(['销售日报'])
    expect(Object.keys(body.reports[0]).sort()).toEqual(['id', 'renderer', 'requiredScope', 'title'])

    const admin = await (await manage().app.request('/reports')).json()
    expect(admin.reports).toHaveLength(2)
  })

  it('GET /reports/manage：data:manage 身份看全量本 org 行（含页门未放行的）+ renderer', async () => {
    const { app, identity } = manage()
    // 插入序刻意与标题序**不一致**（platform 行先插、标题最大的反而最先落库）——见下「订正记录」
    await upsertReport(pool, identity.orgId, {
      title: '3 自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格（跨列 check）
    })
    await post(app, { title: '2 未放行报表', requiredScope: 'sales:read' })
    await post(app, { title: '1 已发布报表', requiredScope: null })

    const res = await app.request('/reports/manage')
    expect(res.status).toBe(200)
    const body = await res.json()
    // 行序 = order by title（listReports 既有口径）。⚠️ 三条订正记录（2026-09-29，Task 2 实施 +
    // 评审后由人裁定「现在修」）：
    //  ① 原稿期望值 ['公开报表','自绘大盘','未放行报表'] 与同一句声明的公式 order by title 冲突——
    //     原稿是错的（控制器已 psql 独立复核本库次序）。
    //  ② 但**照实测值硬写中文次序**等于把库的 CJK collation 钉进测试（repo 未 pin locale，
    //     `order by title` 也没写 COLLATE）⇒ 换 locale 就红。改为标题带 **ASCII 数字前缀**：
    //     次序由 ASCII 决定，与 collation 无关。
    //  ③ 且插入序必须**不等于**标题序：否则「按 title 排」与「按堆序（=插入序）返回」两种实现
    //     都绿 ⇒ 断言不承重（删掉 order by title 也发现不了）。故 platform 行先插。
    // 这条断言同时兼作「管理面不按行裁剪」的证据：若误用 visibleTo 裁行，
    // 「2 未放行报表」会消失、此处变 2 行而红。
    expect(body.reports.map((r: { title: string }) => r.title)).toEqual(
      ['1 已发布报表', '2 未放行报表', '3 自绘大盘'],
    )
    expect(body.reports.find((r: { title: string }) => r.title === '2 未放行报表'))
      .toMatchObject({ requiredScope: 'sales:read', renderer: 'metabase' })
    expect(body.reports.find((r: { title: string }) => r.title === '3 自绘大盘'))
      .toMatchObject({ renderer: 'platform' })
  })

  it('GET /reports（观看面）投影补 renderer；页门未放行的行照旧不可见', async () => {
    const { app } = manage()
    await post(app, { title: '公开报表', requiredScope: null })
    await post(app, { title: '未放行报表', requiredScope: 'data:manage' })
    const viewerApp = shell(makeIdentity({ orgId: ORG, scopes: ['data:query'] })).app
    const body = await (await viewerApp.request('/reports')).json()
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0]).toMatchObject({ title: '公开报表', renderer: 'metabase' })
  })

  it('PUT /reports/:id：改页门落库并返回整行；置 null = 发布', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报', requiredScope: 'sales:read' })).json()
    // 登记侧写保护（Task 3）：PUT 必带 expectedVersion，从管理清单读回来（console 同路）
    const v0 = await versionOf(app, id)

    const res = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'finance:read', expectedVersion: v0 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number }
    expect(body)
      .toMatchObject({ id, title: '销售日报', requiredScope: 'finance:read', renderer: 'metabase' })
    // 成功响应体回带**推进后**的版本（写保护的读侧契约——console 据此续写下一次，无需再读一遍）
    expect(body.version).toBe(v0 + 1)
    // 库里也真的推进了：响应体与落库同源，两处都得对（只断一处，另一处写错也看不见）
    expect((await pool.query('select version from data.reports where id = $1', [id])).rows[0].version)
      .toBe(v0 + 1)
    const db = await pool.query('select required_scope from data.reports where id = $1', [id])
    expect(db.rows[0].required_scope).toBe('finance:read')

    const pub = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: null, expectedVersion: v0 + 1 }),
    })
    expect(pub.status).toBe(200)
    expect((await pub.json()).requiredScope).toBeNull()
  })

  it('★ 登记侧写保护：缺版本 400 / 陈旧 409（带 currentVersion）/ 命中 200 且版本 +1', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '登记写保护' })).json()

    const listed = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    const v0 = listed.reports.find((r) => r.id === id)!.version
    expect(v0).toBe(1)

    // 缺 expectedVersion ⇒ 400（strict + 必填）
    const missing = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read' }),
    })
    expect(missing.status).toBe(400)

    // 命中 ⇒ 200 且版本推进
    const ok = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: v0 }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).version).toBe(v0 + 1)

    // 陈旧（拿 v0 再写）⇒ 409 + 当前版本
    const stale = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'finance:read', expectedVersion: v0 }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'STALE_WRITE', currentVersion: v0 + 1 })
  })

  it('★ 回收也带版本：陈旧 ⇒ 409，且**没有被归档**（Metabase 侧无调用）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '回收写保护' })).json()
    mb.state.calls.length = 0
    const stale = await app.request(`/reports/${id}?expectedVersion=99`, { method: 'DELETE' })
    expect(stale.status).toBe(409)
    expect(mb.state.calls).toHaveLength(0)     // 守卫必须先于归档
    expect((await app.request(`/reports/${id}?expectedVersion=1`, { method: 'DELETE' })).status).toBe(204)
  })

  it('★ expectedVersion 超 int4 上界 ⇒ 400 INVALID_BODY（不是 500：客户端可控的取值不许污染 5xx）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '版本上界' })).json()
    // 3000000000 能过 `.int().positive()`，但 `version` 是 int4 列、这个值会被绑进 SQL ⇒
    // 无上界时 Postgres 报 22003、被兜成 500。契约是「非法入参 ⇒ 400」，且 5xx 会污染监控。
    const over = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: 3000000000 }),
    })
    expect(over.status).toBe(400)
    expect(await over.json()).toEqual({ error: 'INVALID_BODY' })
    // 且写没落：拒的是这一次请求，不是把行改坏
    expect((await pool.query('select version from data.reports where id = $1', [id])).rows[0].version).toBe(1)
    // 反证上界是**闭区间**、不是把大值一律拒掉：int4 上界本身合法，能走到 SQL 与版本比对（陈旧 ⇒ 409）。
    // （这条同时钉住 `.max()` 没写成 `.lt()`/off-by-one——那时这里会变 400 而红。）
    const edge = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: 2147483647 }),
    })
    expect(edge.status).toBe(409)
    expect((await edge.json()).currentVersion).toBe(1)
  })

  it('★ PUT 负测：多余键 400（strict）/ 空串 400 / 跨租户 404 且写不动', async () => {
    const { app, identity } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()
    // 版本回带**必须合法**，否则三条负测都退化成「缺版本 400」而不再验各自那条（Task 3 收严）
    const v = await versionOf(app, id)

    const extra = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'a:read', title: '顺手改名', expectedVersion: v }),
    })
    expect(extra.status).toBe(400)

    const empty = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: '', expectedVersion: v }),
    })
    expect(empty.status).toBe(400)

    const other = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] })).app
    const cross = await other.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      // 带着**本 org 的当前版本**跨租户写：404 必须由 org 隔离产生，而不是版本不符
      body: JSON.stringify({ requiredScope: 'hacked:scope', expectedVersion: v }),
    })
    expect(cross.status).toBe(404)
    const db = await pool.query('select org, required_scope from data.reports where id = $1', [id])
    expect(db.rows[0]).toMatchObject({ org: identity.orgId, required_scope: null })
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
    // 带**本 org 的当前版本**跨租户删：404 必须由 org 隔离产生（版本合法 ⇒ 不准推到 409/400 上）
    const v = await versionOf(app, id)
    expect((await other.app.request(`/reports/${id}?expectedVersion=${v}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('DELETE /reports/:id：Metabase 侧归档 + 删登记行（对账差集的合法消除路径）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()
    const v = await versionOf(app, id)
    expect((await app.request(`/reports/${id}?expectedVersion=${v}`, { method: 'DELETE' })).status).toBe(204)
    expect(mb.state.dashboards[0].archived).toBe(true)
    expect((await pool.query('select 1 from data.reports where org = $1', [ORG])).rowCount).toBe(0)
    // 归档后不再出现在可嵌入集里 ⇒ 对账干净（这正是「先归档、再删行」的理由）
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, missingInMetabase: [], tenantUnlocked: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
    // 未知 id：404（不泄露存在性）
    expect((await app.request('/reports/nope?expectedVersion=1', { method: 'DELETE' })).status).toBe(404)
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

  it('★ 对账按行降级：一行回读 500 只落 contentUnreadable，其余行照常判（不再整单 502）', async () => {
    const { app, identity } = manage()
    const badId = await upsertReport(pool, identity.orgId, {
      title: '坏盘', metabaseId: 5, embedParams: {}, requiredScope: null,
    })
    const goodId = await upsertReport(pool, identity.orgId, {
      title: '未锁盘', metabaseId: 6, embedParams: {}, requiredScope: null,
    })
    // 两张都在可嵌入集（否则会先落 missingInMetabase 而不是走到回读）
    mb.state.dashboards.push(
      { id: 5, name: `${identity.orgId}/坏盘`, embeddable: true, archived: false },
      { id: 6, name: `${identity.orgId}/未锁盘`, embeddable: true, archived: false },
    )
    // dashboard 5 的 GET 回 500 ⇒ readDashboardContent 抛 MetabaseError；其余透传原桩
    const inner = mb.fetcher
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/5') return json({ message: 'boom' }, 500)
      return inner(String(url), init)
    })

    const res = await app.request('/reports/reconcile', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.contentUnreadable).toEqual([{ id: badId, title: '坏盘', metabaseId: 5 }])
    // 好盘照常判：可嵌入但 tenant 没锁 ⇒ tenantUnlocked 照报（降级不吞别的差集）
    expect(body.tenantUnlocked).toEqual([{ id: goodId, title: '未锁盘', metabaseId: 6 }])
  })

  // ── 承重补测（brief 之外，实施时变异回归发现两条**声明了但没被断言钉住**的要求）──
  //    上一条用例里 `ok:false` 由 tenantUnlocked 非空撑着 ⇒ 删掉 `&& contentUnreadable.length === 0`
  //    它照样绿（实测：变异存活）。同理 `只吞 MetabaseError` 那一支（非 MetabaseError 继续往上抛）
  //    没有任何用例咬到（实测：把 catch 改成全吞，40/40 依旧绿）。两条都是本任务的明确要求，
  //    「不被断言钉住的要求 = 下一个人删掉它不会有任何红」——各补一条。
  it('★ ok 判据承重：contentUnreadable 是**唯一**非空差集时 ok 也 false（其余四项全空，只有这一项撑着）', async () => {
    const { app, identity } = manage()
    const badId = await upsertReport(pool, identity.orgId, {
      title: '唯一坏盘', metabaseId: 7, embedParams: {}, requiredScope: null,
    })
    mb.state.dashboards.push(
      { id: 7, name: `${identity.orgId}/唯一坏盘`, embeddable: true, archived: false },
    )
    const inner = mb.fetcher
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/7') return json({ message: 'boom' }, 500)
      return inner(String(url), init)
    })

    const body = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(body.contentUnreadable).toEqual([{ id: badId, title: '唯一坏盘', metabaseId: 7 }])
    // 其余四个差集与 unregistered 都空 —— 故 ok 只可能被 contentUnreadable 那一项压成 false
    expect(body.missingInMetabase).toEqual([])
    expect(body.tenantUnlocked).toEqual([])
    expect(body.tenantUnbound).toEqual([])
    expect(body.unregistered).toEqual({ recoverable: [], needsHuman: [] })
    expect(body.ok).toBe(false)
  })

  it('★ 只吞 MetabaseError：回读抛的不是 MetabaseError（代码缺陷 / 连接层异常）⇒ 继续往上抛 500，不伪装成按行降级', async () => {
    const { app, identity } = manage()
    await upsertReport(pool, identity.orgId, {
      title: '连接炸盘', metabaseId: 8, embedParams: {}, requiredScope: null,
    })
    mb.state.dashboards.push(
      { id: 8, name: `${identity.orgId}/连接炸盘`, embeddable: true, archived: false },
    )
    const inner = mb.fetcher
    // fetch 自己抛（连不上/被中止）——metabase.ts 的 call() 不包这一层 ⇒ 原样上抛，不是 MetabaseError。
    // 全吞式 catch 会把它误报成「这一行读不出」= 把代码缺陷降级成业务状态（静默）；500 才是它的位置。
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/8') throw new Error('socket hang up')
      return inner(String(url), init)
    })

    const res = await app.request('/reports/reconcile', { method: 'POST' })
    expect(res.status).toBe(500)
  })

  // ── 对账判据加厚（spec §7 待办 2）：「锁了但绑不到」── embedding_params.tenant=locked 只说明
  //    锁了，锁值还要**绑得到东西**才生效。五条各咬一个子判据（变异确认见任务报告）：
  //    卡未映射 / 半绑定（单卡粒度，人裁 2026-09-29）/ 参数未声明 / 映射挂错参数 / 反证正常态不误伤。
  it('reconcile 报出「锁了但绑不到」：有 locked 但卡片未映射 ⇒ tenantUnbound 非空、ok=false', async () => {
    // 造一张"只锁了参、没映射"的 dashboard（桩里 parameters 为空、dashcards 无 mappings）。
    // 卡 900 带 tenant 模板标签（真机形状的 dataset_query.stages[0]）——不带标签就进不了
    // 「需要映射」这半边判据；不在 cards 里则回读直接 404 ⇒ 502，红得不是地方。
    const { state, fetcher } = fakeMetabase(
      [{
        id: 300, name: `${ORG}/未绑定`, embeddable: true, archived: false,
        enable_embedding: true, embedding_params: { tenant: 'locked' },
      }],
      { 900: { native: 'select 1 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } } },
    )
    state.dashboards[0].dashcards = [{ id: 9, card_id: 900, row: 0, col: 0, size_x: 12, size_y: 6 }]
    state.dashboards[0].parameters = []
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '未绑定', metabaseId: 300, embedParams: {}, requiredScope: null,
    })
    const { app } = manage()
    const res = await app.request('/reports/reconcile', { method: 'POST' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound.map((r: { id: string }) => r.id)).toContain(id)
  })

  it('reconcile 半绑定也报：两张 tenant 卡只映射一张 ⇒ tenantUnbound 非空（单卡粒度，人裁 2026-09-29）', async () => {
    // 参数已声明（①不触发）；两张卡都带 tenant 标签，只映射了一张 ⇒ ②单卡粒度必须报
    const { state, fetcher } = fakeMetabase(
      [{
        id: 301, name: `${ORG}/半绑定`, embeddable: true, archived: false,
        enable_embedding: true, embedding_params: { tenant: 'locked' },
      }],
      {
        901: { native: 'select 1 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } },
        902: { native: 'select 2 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } },
      },
    )
    state.dashboards[0].dashcards = [
      { id: 11, card_id: 901, row: 0, col: 0, size_x: 6, size_y: 6,
        parameter_mappings: [{ parameter_id: 'tenant-param', card_id: 901,
                               target: ['variable', ['template-tag', 'tenant']] }] },
      { id: 12, card_id: 902, row: 0, col: 6, size_x: 6, size_y: 6 },
    ]
    state.dashboards[0].parameters = [{ id: 'tenant-param', name: 'tenant', slug: 'tenant',
                                        type: 'category', sectionId: 'string' }]
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '半绑定', metabaseId: 301, embedParams: {}, requiredScope: null,
    })
    const { app } = manage()
    const res = await app.request('/reports/reconcile', { method: 'POST' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound.map((r: { id: string }) => r.id)).toContain(id)
  })

  it('★ 锁了但参数没声明 ⇒ 同样报 tenantUnbound（声明了别个参数不算——declared 比 slug=tenant）', async () => {
    const { state, fetcher } = fakeMetabase([{
      id: 301, name: `${ORG}/未声明`, embeddable: true, archived: false,
      enable_embedding: true, embedding_params: { tenant: 'locked' },
    }])
    // 无卡（needsMapping 不触发）、parameters 里只有 region ⇒ 唯一能咬到的是「tenant 没声明」
    state.dashboards[0].dashcards = []
    state.dashboards[0].parameters = [
      { id: 'region-param', name: 'region', slug: 'region', type: 'category' },
    ]
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '未声明', metabaseId: 301, embedParams: {}, requiredScope: null,
    })
    const { app } = manage()
    const body = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound).toEqual([
      expect.objectContaining({ id, title: '未声明', metabaseId: 301 }),
    ])
  })

  it('★ 锁了、也声明了，但映射挂在了别的参数上 ⇒ 报 tenantUnbound（「有任意映射就算」是假绿，不许回来）', async () => {
    const { state, fetcher } = fakeMetabase(
      [{
        id: 302, name: `${ORG}/映射错参`, embeddable: true, archived: false,
        enable_embedding: true, embedding_params: { tenant: 'locked' },
      }],
      { 901: { native: 'select 1 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } } },
    )
    // 卡 901 带 tenant 标签、tenant 参数也声明了，但卡上的映射挂的是 region 参数
    // ⇒ 锁住的 tenant 值绑不到它。判据必须比 parameter_id，不是「有没有映射」。
    state.dashboards[0].dashcards = [{
      id: 10, card_id: 901, row: 0, col: 0, size_x: 12, size_y: 6,
      parameter_mappings: [
        { parameter_id: 'region-param', card_id: 901, target: ['variable', ['template-tag', 'region']] },
      ],
    }]
    state.dashboards[0].parameters = [
      { id: 'region-param', name: 'region', slug: 'region', type: 'category' },
      { id: 'tenant-param', name: 'tenant', slug: 'tenant', type: 'category' },
    ]
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '映射错参', metabaseId: 302, embedParams: {}, requiredScope: null,
    })
    const { app } = manage()
    const body = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound).toEqual([
      expect.objectContaining({ id, title: '映射错参', metabaseId: 302 }),
    ])
  })

  it('★ 反证：锁了、声明了、tenant 标签卡也映射到 tenant 参数 ⇒ 不报（发布三件套产物不误伤）', async () => {
    // 这正是 publishWithTenantBinding 落地后的真机形状（见上方「已有卡的报表」用例的断言）
    const { state, fetcher } = fakeMetabase(
      [{
        id: 303, name: `${ORG}/绑定完好`, embeddable: true, archived: false,
        enable_embedding: true, embedding_params: { tenant: 'locked' },
      }],
      { 902: { native: 'select 1 where t = {{tenant}}', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } } },
    )
    state.dashboards[0].dashcards = [{
      id: 11, card_id: 902, row: 0, col: 0, size_x: 12, size_y: 6,
      parameter_mappings: [
        { parameter_id: 'tenant-param', card_id: 902, target: ['variable', ['template-tag', 'tenant']] },
      ],
    }]
    state.dashboards[0].parameters = [
      { id: 'tenant-param', name: 'tenant', slug: 'tenant', type: 'category' },
    ]
    vi.stubGlobal('fetch', fetcher)
    await upsertReport(pool, ORG, {
      title: '绑定完好', metabaseId: 303, embedParams: {}, requiredScope: null,
    })
    const { app } = manage()
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, missingInMetabase: [], tenantUnlocked: [], tenantUnbound: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
  })

  // ── renderer 守卫（终审修复 3，Task 2「凡读 metabaseId 前先判 renderer」的落地）──
  it('★ renderer=platform 的行不被对账报出（metabaseId=0 哨兵不进 missingInMetabase/tenantUnlocked/tenantUnbound）', async () => {
    await upsertReport(pool, ORG, {
      title: '自绘报表', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格（跨列 check）
    })
    const { app } = manage()
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    // ok 不受 platform 行影响：它没有 Metabase dashboard，对账的三个差集都不该碰它
    expect(rec).toMatchObject({
      ok: true, registered: 1, embeddable: 0,
      missingInMetabase: [], tenantUnlocked: [], tenantUnbound: [],
      unregistered: { recoverable: [], needsHuman: [] },
    })
  })

  it('★ renderer=platform 的行 DELETE 不发归档请求（没有 Metabase dashboard 可归档），登记行照删', async () => {
    const id = await upsertReport(pool, ORG, {
      title: '自绘报表', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格（跨列 check）
    })
    const { app } = manage()
    const res = await app.request(`/reports/${id}?expectedVersion=${await versionOf(app, id)}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    // 登记行照删（跳过的只是 Metabase 侧动作，不是删除本身）
    expect((await pool.query('select 1 from data.reports where org = $1', [ORG])).rowCount).toBe(0)
    // 桩上一条 PUT 都没发（不碰 Metabase——尤其不许拿 metabaseId=0 哨柄去 PUT /api/dashboard/0）
    expect(mb.state.calls.filter((c) => (c.init?.method ?? 'GET') === 'PUT')).toEqual([])
  })

  it('★ renderer=platform ⇒ embed-url 409 RENDERER_NOT_EMBEDDABLE（不签死链 token）', async () => {
    const { app, identity } = manage()
    const id = await upsertReport(pool, identity.orgId, {
      title: '自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格（跨列 check）
    })
    const res = await app.request(`/reports/${id}/embed-url`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'RENDERER_NOT_EMBEDDABLE' })
    // 守卫必须发生在任何 Metabase 调用之前（metabaseId=0 是哨兵，拿它签 token = 签死链）
    expect(mb.state.calls).toHaveLength(0)
  })

  // ── 自绘创建 + 规格读写（#391 计划 6 Task 3）────────────────────────────────────
  it('★ 自绘报表：创建完全不碰 Metabase，规格经白名单校验', async () => {
    const { app } = manage()
    mb.state.calls.length = 0
    const res = await post(app, {
      title: '自绘大盘', renderer: 'platform', spec: { panels: [] },
    })
    expect(res.status).toBe(201)
    expect(mb.state.calls).toHaveLength(0)         // 一条 Metabase 调用都没有
    expect((await res.json()).metabaseId).toBe(0)  // 哨兵

    const bad = await post(app, {
      title: '坏规格', renderer: 'platform', spec: { panels: [], selectSql: 'select 1' },
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('INVALID_SPEC')
  })

  it('★ 分支位置钉住：不设 DATA_METABASE_* 时创建自绘报表仍 201（自绘不依赖 Metabase 配置）', async () => {
    delete process.env.DATA_METABASE_URL
    delete process.env.DATA_METABASE_API_KEY
    delete process.env.DATA_METABASE_SECRET_KEY
    const { app } = manage()
    const res = await post(app, { title: '无 Metabase 的自绘', renderer: 'platform', spec: { panels: [] } })
    // platform 分支必须在 metabaseFromEnv() 那次 503 检查**之前**——顺序反了这里会误报 503
    expect(res.status).toBe(201)
    expect(mb.state.calls).toHaveLength(0)
    // 反证：同一环境下 metabase 创建照旧 503（不是「整个端点把 cfg 检查删了」）
    const mbRes = await post(app, { title: '无 Metabase 的普通报表' })
    expect(mbRes.status).toBe(503)
    expect(await mbRes.json()).toEqual({ error: 'METABASE_UNCONFIGURED' })
  })

  it('★ 自绘创建的入参正交：platform 带 lockedParams ⇒ 400；metabase 带 spec ⇒ 400（都不静默）', async () => {
    const { app } = manage()
    // platform 行没有嵌入通道可锁。拒（400）而不是静默丢：platform 分支硬编码 embedParams:{}，
    // superRefine 是唯一防线——没有它这里就静默丢参（调用方以为锁了参，TENANT_PARAM_RESERVED 同款理由）。
    const withLock = await post(app, {
      title: '带锁参的自绘', renderer: 'platform', spec: { panels: [] }, lockedParams: { region: 'cn' },
    })
    expect(withLock.status).toBe(400)
    expect(await withLock.json()).toEqual({ error: 'INVALID_BODY' })
    // metabase 行带 spec ⇒ 400（metabase 路径的 upsertReport 不传 spec，zod 层是唯一防线——
    // 没有它这里就静默丢规格；库侧跨列 check 根本看不到这条入参）
    const withSpec = await post(app, { title: '带规格的 metabase', spec: { panels: [] } })
    expect(withSpec.status).toBe(400)
    expect(await withSpec.json()).toEqual({ error: 'INVALID_BODY' })
    expect(mb.state.calls).toHaveLength(0)
    expect((await pool.query(
      'select 1 from data.reports where org = $1 and title = any($2)',
      [ORG, ['带锁参的自绘', '带规格的 metabase']],
    )).rowCount).toBe(0)
  })

  it('★ 规格读写：页门先判（403）、版本必带（409）、非自绘行 409', async () => {
    // 自绘行（requiredScope='sales:read'）+ 本 org 无该 scope 的 viewer
    const { app } = manage()
    const { id } = await (await post(app, {
      title: '页门内的自绘', renderer: 'platform', spec: { panels: [] }, requiredScope: 'sales:read',
    })).json()

    // GET /spec ⇒ 403 { error:'FORBIDDEN', need:'sales:read' }（页门先判，照 embed-url 的口径）
    const denied = await viewer().app.request(`/reports/${id}/spec`)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'FORBIDDEN', need: 'sales:read' })

    // 放行的 viewer（有 sales:read）读得到：200 且回整份规格 + 当前版本（渲染器的取数通路）
    const allowed = shell(makeIdentity({ orgId: ORG, scopes: ['data:query', 'sales:read'] })).app
    const read = await allowed.request(`/reports/${id}/spec`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ spec: { panels: [] }, version: 1 })

    // PUT /spec 缺 expectedVersion ⇒ 400（strict + 必填）；多余键同样 400（.strict()）
    const missing = await app.request(`/reports/${id}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] } }),
    })
    expect(missing.status).toBe(400)
    const extra = await app.request(`/reports/${id}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: 1, title: '顺手改名' }),
    })
    expect(extra.status).toBe(400)
    // 坏规格在 PUT 侧同样过白名单（写路径不许把垃圾规格落库——库侧 check 只判非空，不判形状）
    const badSpec = await app.request(`/reports/${id}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [{ chart: 'sankey3d' }] }, expectedVersion: 1 }),
    })
    expect(badSpec.status).toBe(400)
    expect(await badSpec.json()).toEqual({ error: 'UNKNOWN_CHART_TYPE' })

    // 命中 ⇒ 200 且 version+1（成功响应回带推进后的版本，console 据此续写）
    const v0 = await versionOf(app, id)
    const ok = await app.request(`/reports/${id}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: v0 }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ version: v0 + 1 })

    // 陈旧 ⇒ 409 STALE_WRITE + currentVersion
    const stale = await app.request(`/reports/${id}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: v0 }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'STALE_WRITE', currentVersion: v0 + 1 })

    // 对 metabase 行 PUT /spec ⇒ 409 RENDERER_NOT_SELF_DRAWN（GET 同码）
    const { id: mbId } = await (await post(app, { title: '普通 Metabase 报表' })).json()
    const putMb = await app.request(`/reports/${mbId}/spec`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: 1 }),
    })
    expect(putMb.status).toBe(409)
    expect(await putMb.json()).toEqual({ error: 'RENDERER_NOT_SELF_DRAWN' })
    const getMb = await app.request(`/reports/${mbId}/spec`)
    expect(getMb.status).toBe(409)
    expect(await getMb.json()).toEqual({ error: 'RENDERER_NOT_SELF_DRAWN' })

    // 行不存在 ⇒ 404（不给存在性探针；跨租户同形——getReport/updateSpec 都带 org）
    expect((await app.request('/reports/nope/spec')).status).toBe(404)
    expect((await app.request('/reports/nope/spec', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { panels: [] }, expectedVersion: 1 }),
    })).status).toBe(404)
  })

  it('★ GET /reports/:id/edit-url：本租户 metabase 行 → 200 + 票据可解出本 org', async () => {
    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test'
    const { app, identity } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()

    const res = await app.request(`/reports/${id}/edit-url`)
    expect(res.status).toBe(200)
    const { url } = await res.json() as { url: string }
    expect(url.startsWith('https://mb.example.test/handoff?t=')).toBe(true)
    const payload = JSON.parse(Buffer.from(url.split('t=')[1].split('.')[1], 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ org: identity.orgId })
    expect(payload.did).toBeGreaterThan(0)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
  })

  it('★ 负测：platform 行 409 / 跨租户 404 / 未配代理 origin 503', async () => {
    const { app, identity } = manage()
    const id = await upsertReport(pool, identity.orgId, {
      title: '自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格（跨列 check）
    })
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(503)

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test'
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(409)

    const other = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] })).app
    const { id: realId } = await (await post(app, { title: '别租户看不见' })).json()
    expect((await other.request(`/reports/${realId}/edit-url`)).status).toBe(404)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
  })

  it('★ 负测（评审 I-3）：origin 非 https / 带尾斜杠 的形状都 fail-closed 或归一', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '形状用例' })).json()

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'http://mb.example.test'      // 非 https ⇒ 503（不许降级）
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(503)

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test///'  // 尾斜杠 ⇒ 归一，不许出 '//handoff'
    const { url } = await (await app.request(`/reports/${id}/edit-url`)).json() as { url: string }
    expect(url.startsWith('https://mb.example.test/handoff?t=')).toBe(true)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
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
    expect((await b.app.request(`/reports/${rb.id}?expectedVersion=${await versionOf(b.app, rb.id)}`, { method: 'DELETE' })).status).toBe(204)
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

  it('★ I-2 / M-4 并发建同名：写保护串行化 ⇒ 后到者命中同名被内容守卫拒（1×201 + 1×409），不再造孤儿', async () => {
    const { app } = manage()
    // 两个请求在数组字面量里**同时发起**（不是先 await 一个再发下一个），再由 Promise.all 收齐。
    // ⚠️ 加锁后两者**不再并发跑写序列**：后到者在 `withObjectLock` 上排队，等第一个**整段写序列**
    //    跑完才进临界区。旧版本那套 `bothArrived` 装置（把两次 `/api/search` 卡在同一个窗口里
    //    人造「先 search 后写」竞态）**已随加锁失效**——第二次 search 根本不会与第一次并发，
    //    装置成了死代码、其 500ms 兜底必然触发 ⇒ 已删除。
    const pending = [post(app, { title: '并发报表' }), post(app, { title: '并发报表' })]
    const results = await Promise.all(pending)
    const observed = await Promise.all(results.map(async (r) => ({ status: r.status, body: await r.json() })))

    // ⚠️ 这条不变量由写保护改了，**不是回归**：加锁前两个请求都先 search 到空集 ⇒ 各建一张
    //    dashboard（created:true ×2），登记行只有 1 行（unique (org, title)）⇒ 必有一张是孤儿。
    //    加锁后后到者的 `upsertDashboard` 命中同名 ⇒ `created === false` ⇒ Task 2 的内容守卫
    //    （不带 expectedFingerprint 一律拒）给出 409 VERSION_REQUIRED。
    //    孤儿从「事后由对账报出」变成「结构上不再产生」。
    const accepted = observed.filter((r) => r.status === 201)
    const rejected = observed.filter((r) => r.status === 409)
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(accepted[0].body).toMatchObject({ created: true })
    expect(rejected[0].body).toMatchObject({ error: 'VERSION_REQUIRED' })
    // Metabase 侧**只有 1 张** dashboard（不再造孤儿）；登记行 1 行，且指向的就是那张
    expect(mb.state.dashboards).toHaveLength(1)
    const reg = await pool.query(
      'select metabase_id from data.reports where org = $1 and title = $2', [ORG, '并发报表'],
    )
    expect(reg.rowCount).toBe(1)
    expect(reg.rows[0].metabase_id).toBe((accepted[0].body as { metabaseId: number }).metabaseId)
    // 无孤儿 ⇒ 对账 ok（旧用例这里断言 ok:false + recoverable 一条孤儿；现在结构上不产生了）
    const rec = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(rec).toMatchObject({
      ok: true, registered: 1, embeddable: 1,
      unregistered: { recoverable: [], needsHuman: [] },
    })
  })

  it('★ 并发写：6 个同版本 PUT ⇒ 恰 1 成功 + 5 × 409（账实相符，spec §3③ 读数）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '并发写保护' })).json()
    const listed = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    const v0 = listed.reports.find((r) => r.id === id)!.version

    // 数组字面量里同时发起（真并发；本包 fileParallelism:false，串行描述块不会替我们制造并发）
    const pending = Array.from({ length: 6 }, () => app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: v0 }),
    }))
    const results = await Promise.all((await Promise.all(pending)).map((r) => r.status))
    // ⚠️ **这条不是 Task 4 锁的证据**：恰一胜者由 Task 3 的**条件 UPDATE**（`where … and version = $4`）
    //    在 **DB 层**保证——把 `withObjectLock` 换成直接 `fn()`，本用例**依然全绿**（报告「变异确认①」）。
    //    它钉的是写保护下端到端的**账实相符读数**（6 并发恰 1 落、版本只 +1），不是锁的承重；
    //    锁的承重用例是下面两条（同名串行化 / DELETE↔PUT 交错）。
    expect(results.filter((s) => s === 200)).toHaveLength(1)
    expect(results.filter((s) => s === 409)).toHaveLength(5)
    const after = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    expect(after.reports.find((r) => r.id === id)!.version).toBe(v0 + 1)   // 只落一次
  })

  it('★ 并发：DELETE 与同版本 PUT 交错 ⇒ 行锁串行化（无锁时 PUT 会写进一个随即被删掉的行 = 丢更新）', async () => {
    const { app: seed } = manage()
    const { id } = await (await post(seed, { title: '删改并发保护' })).json()
    const dashId = mb.state.dashboards[0].id
    const v0 = await versionOf(seed, id)

    // ── PUT 侧闸门（评审 ⚠️1）：给 PUT 的落库语句挂一个**完成信号**，放 DELETE 之前先等它。
    //    这让「无锁 ⇒ PUT 先落」成为**确定性读数**，而不是靠微任务调度序（旧版正是靠后者，
    //    跨环境未必稳定红）。有行锁 ⇒ DELETE 持锁期间 PUT **根本发不出**这条 UPDATE（信号永不亮）；
    //    无行锁 ⇒ 它当场发出并完成（一次本地 DB 往返）⇒ 信号必亮。
    //    ⚠️ 下面的 500ms 只是「信号永不亮」时的**兜底上限，不是判据**：断言不依赖等了多久，
    //       只依赖“信号亮没亮”（亮的条件 = PUT 真的写了库）。
    let putWrote: () => void = () => {}
    const putWriteDone = new Promise<void>((r) => { putWrote = r })
    const spyPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (text: unknown, params?: unknown) => {
            const out = await (target.query as (t: unknown, p?: unknown) => Promise<unknown>)(text, params)
            if (typeof text === 'string' && /update\s+data\.reports\s+set\s+required_scope/i.test(text)) putWrote()
            return out
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as Pool
    const app = buildTestApp(
      mod,
      makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }),
      { pool: spyPool },
      { id: TENANT, casdoor_org: ORG },
    )

    // DELETE 卡在「已读版本、已过比对、正归档」的那一刻——归档是本端点临界区内唯一的 await 窗口。
    const base = mb.fetcher
    let archiveStarted: () => void = () => {}
    const started = new Promise<void>((r) => { archiveStarted = r })
    let releaseArchive: () => void = () => {}
    const hold = new Promise<void>((r) => { releaseArchive = r })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url)
      if (u.pathname === `/api/dashboard/${dashId}` && init?.method === 'PUT'
        && String(init.body).includes('"archived"')) {
        archiveStarted()
        await hold
      }
      return base(url, init)
    })

    const del = app.request(`/reports/${id}?expectedVersion=${v0}`, { method: 'DELETE' })
    await started   // DELETE 已持锁并卡在归档
    const put = app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: v0 }),
    })
    await Promise.race([putWriteDone, new Promise((r) => setTimeout(r, 500))])   // ★ 闸门
    releaseArchive()
    const [delRes, putRes] = await Promise.all([del, put])
    // 有锁：PUT 的 UPDATE 从未发出（信号未亮）⇒ 排在 DELETE 之后 ⇒ 行已删 ⇒ 404；
    // 无锁：PUT 的 UPDATE 已**完成**（信号已亮）⇒ 写进一个**随即被 DELETE 抹掉**的行 ⇒ 200 = 丢更新。
    expect(delRes.status).toBe(204)
    expect(putRes.status).toBe(404)   // 行已被删 ⇒ 与 PUT 的 404 同形（不给存在性探针）
    expect((await pool.query('select 1 from data.reports where org = $1 and id = $2', [ORG, id])).rowCount).toBe(0)
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

    const res = await broken.request(`/reports/${id}?expectedVersion=${await versionOf(app, id)}`, { method: 'DELETE' })
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
    // `.strict()`：多余键不再被**静默丢弃**（本任务按 brief Step 3 加、计划 Constraint 5 声明它在）。
    // 承重理由：非 strict 时拼错的 `expectedFingerprint` 会被 zod 丢掉 ⇒ 守卫看到 null ⇒ 恒 409
    // 「VERSION_REQUIRED」——把「传错字段名」伪装成「你没带版本」，正是 fail-closed 要消灭的静默。
    expect((await post(app, { title: '多余键', bogus: 1 })).status).toBe(400)
    expect(mb.state.calls).toHaveLength(0)
  })

  // ── 内容侧写保护（Task 2，spec §3③；人裁 2026-09-29 fail-closed）────────────────────────
  it('★ 内容侧写保护：命中同名（更新既有）不带 expectedFingerprint ⇒ 409 VERSION_REQUIRED + 当前指纹', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '写保护报表' })).json() as { fingerprint: string }
    expect(typeof first.fingerprint).toBe('string')          // 201 回指纹（此前没有）

    const res = await post(app, { title: '写保护报表' })      // 第二次 = 更新既有 dashboard
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('VERSION_REQUIRED')
    expect(typeof body.currentFingerprint).toBe('string')

    // 带对的指纹 ⇒ 201；带过期的 ⇒ 409 STALE_WRITE
    const ok = await post(app, { title: '写保护报表', expectedFingerprint: first.fingerprint })
    expect(ok.status).toBe(201)
    const stale = await post(app, { title: '写保护报表', expectedFingerprint: 'deadbeef' })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe('STALE_WRITE')
  })

  it('★ 首次创建不需要版本（没有可覆盖的东西）', async () => {
    const { app } = manage()
    expect((await post(app, { title: '全新报表' })).status).toBe(201)
  })

  // ── 承重补测（brief 之外，实施时发现两条要求没有被 brief 的断言咬住）────────────────────
  it('★ 201 回带登记侧 version（**写后**回读；与内容侧指纹分属两条通路）+ 新建时带 expectedFingerprint 被接受并忽略', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '版本回带报表' }))
      .json() as { fingerprint: string; version: number }
    expect(typeof first.fingerprint).toBe('string')
    expect(first.version).toBe(1)          // 首建 = 列默认 1

    // 新建路径**不要求**版本：给一个（哪怕是假的）也接受——没有可覆盖的东西（`!up.created` 之外不判）
    expect((await post(app, { title: '带了指纹的新建', expectedFingerprint: 'whatever' })).status).toBe(201)

    // 更新既有 ⇒ 版本推进到 2；这同时钉住「**写后**回读」——若在 upsertReport 之前读，这里会是 1
    const second = await (await post(app, { title: '版本回带报表', expectedFingerprint: first.fingerprint }))
      .json() as { version: number }
    expect(second.version).toBe(2)
  })

  it('★ 守卫必须在**写之前**：被 409 拒掉的请求不许先改**内容**（否则「拒」是假的）', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '守卫在写前' })).json() as { fingerprint: string; created: boolean }
    expect(first.created).toBe(true)
    const dash = mb.state.dashboards[0]
    // 等价于「另一个人在 Metabase 侧把租户绑定拆了」：publishWithTenantBinding 若先跑，
    // 它会把手动状态**改写回去**（补 tenant 参数、重新锁参）——那时「拒」只是回了个 409，写已经发生了。
    // ⚠️ 断言的是「**内容**不被改」：`upsertDashboard` 那次合并 PUT 仍会发（name 同值、dashcards/
    //    parameters/embedding_params 原值回写 = 内容 no-op），那是刻意保留的（见 routes 里 guard 的注）。
    dash.parameters = []
    dash.embedding_params = {}

    const rejected = await post(app, { title: '守卫在写前' })                 // 不带指纹 ⇒ 必被拒
    expect(rejected.status).toBe(409)
    expect(dash.parameters).toEqual([])          // 参数没被补回来
    expect(dash.embedding_params).toEqual({})    // 尤其：tenant 没被重新锁上

    // 同一件事的另一面：外部改动后，旧指纹必须 STALE_WRITE（守卫若在 publish 之后，publish 会先把内容
    // 修回旧指纹那一份 ⇒ 这条会变成 201 且真的写了 —— 变异确认见任务报告）
    const stale = await post(app, { title: '守卫在写前', expectedFingerprint: first.fingerprint })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe('STALE_WRITE')
  })

  it('★ 合并 PUT **恒回写** embedding_params（不赌上游「缺键」语义）：被 409 拒的请求也不会抹掉锁参', async () => {
    const { app } = manage()
    await post(app, { title: '锁参回写' })
    const dash = mb.state.dashboards[0]
    expect(dash.embedding_params).toEqual({ tenant: 'locked' })   // 首次发布锁上的

    // 命中同名（= 更新既有）⇒ upsertDashboard 走合并 PUT。守卫在 publish 之前 ⇒ 这次被拒的请求
    // 只发了**那一次**合并 PUT：它若不带 embedding_params 而真机是替换语义，锁参当场被抹掉，
    // 而单测仍绿（桩是「缺键不改」）——正是「静默解开租户绑定」在测试里结构性看不见的形态。
    const before = mb.state.calls.length
    const rejected = await post(app, { title: '锁参回写', expectedFingerprint: 'deadbeef' })
    expect(rejected.status).toBe(409)
    const puts = mb.state.calls.slice(before).filter((c) => (c.init?.method ?? 'GET') === 'PUT')
    expect(puts).toHaveLength(1)
    const body = JSON.parse(String(puts[0].init?.body)) as Record<string, unknown>
    expect(body).toHaveProperty('embedding_params')                // 键**恒在**
    expect(body.embedding_params).toEqual({ tenant: 'locked' })    // 值 = 刚读到的当前值
    expect(dash.embedding_params).toEqual({ tenant: 'locked' })    // 锁参仍在（没被抹）
  })
})
