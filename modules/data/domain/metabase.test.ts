// metabase.test.ts — Metabase 客户端纯核的单元测试（TDD 第一步：先落盘、先红）。
//
// 纪律（brief 硬约束 4 / #51 教训）：**桩必须收严到真机形状**，不许为了好写而放宽。
// 每条桩的响应体都照 spec §6.5 的一手取证来：
//   · `GET /api/search` 的响应是 `{ data: [ {id,name,model,…} ] }`，且 **q 是模糊匹配**——
//     「命中」的判据必须是 name 全等（放宽成 includes ⇒ 幂等缺陷结构性不可见）。
//   · `GET /api/dashboard/embeddable` 是**裸数组**（不是 `{data:…}`）。
//   · 任何非 2xx 一律抛（fail-closed），不把错误体回显（供应商侧常回显请求原文，可能含凭证）。
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MetabaseError,
  dashboardName,
  embedDashboardUrl,
  getCard,
  getCardTemplateTags,
  getDashboardEmbeddingParams,
  getDashboardFull,
  listEmbeddableDashboards,
  metabaseFromEnv,
  parseDashboardName,
  putDashboardMerged,
  setEmbedding,
  signEmbedToken,
  upsertDashboard,
  type FetchLike,
  type MetabaseDeps,
} from './metabase'

interface Rec { url: string; init?: RequestInit }
interface Stub { status?: number; body?: unknown; raw?: string }

/** 记录全部请求 + 按序回放响应（越界后重复最后一条）。`Error` 项 = fetch 本身 reject。 */
function stub(responses: Array<Stub | Error>): { calls: Rec[]; fetcher: FetchLike } {
  const calls: Rec[] = []
  let i = 0
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    if (r instanceof Error) throw r
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetcher }
}

const depsOf = (fetcher: FetchLike): MetabaseDeps =>
  ({ fetcher, baseUrl: 'https://mb.test', apiKey: 'mb-api-key' })

const headerOf = (c: Rec, name: string): string | undefined =>
  (c.init?.headers as Record<string, string> | undefined)?.[name]

/** 真机 `GET /api/dashboard/{id}` 里 dashcard 的形状（snake_case；`parameter_mappings` 可缺）。 */
interface MbDashcardSeed {
  id: number
  /** `null` = **文本/虚拟卡**（真机实测：人手动加的文本卡就是 `card_id=None`）。 */
  card_id: number | null
  row: number
  col: number
  size_x: number
  size_y: number
  parameter_mappings?: unknown[]
  /** 文本卡的文字在 `visualization_settings.text` 里；其它卡的 viz 配置也走这里。 */
  visualization_settings?: unknown
}

/** 一张 dashboard 的种子。同一个 `id` 出现多次 ⇒ 卡片**累加**（见 `fakeMetabaseWithCards`）。 */
interface MbDashboardSeed {
  id: number
  name: string
  dashcards?: MbDashcardSeed[]
  /** dashboard 参数：**原样**存取（真机对 PUT 的 `parameters` 有 schema 校验，桩不许替它收窄）。 */
  parameters?: Record<string, unknown>[]
}

interface FakeDashboardState {
  id: number
  name: string
  dashcards: MbDashcardSeed[]
  parameters: Record<string, unknown>[]
  embedding_params: Record<string, string> | null
}

/**
 * **有状态**的 Metabase 桩（只做本任务用到的面：`GET /api/search` 与 `GET` / `PUT /api/dashboard/{id}`）。
 *
 * 与上面的 `stub()` 分工不同：那个是**按序回放**的无状态桩（「一次调用 ⇒ 一串响应」够用），
 * 而「裸 PUT 会不会把卡片清掉」这件事**必须有状态**才测得出——PUT 得真的改到 GET 之后读得出来的状态。
 *
 * ⚠️ 三条形状口径照**真机行为**（不是照好写）：
 *  ① `GET /api/search` 是**模糊**匹配（`includes`），且命中与否由**领域层**判 `name` 全等——
 *     桩做成全等的话，那条判据就永远不被行使（口径同 routes/reports.test.ts 的 fakeMetabase）。
 *  ② 同一个 `id` 的种子合并成**一张** dashboard、`dashcards` 按出现顺序累加：测试用两次同 id
 *     种子的写法表达「这张 dashboard 上已经躺着 2 张卡」。
 *  ③ `PUT` 对 `dashcards` / `parameters` 是**替换语义**（body 里没有该键 ⇒ 清空）——这正是真机上
 *     「不带 dashcards 的 PUT 会替换卡片表列」的机制（本文件要修的 bug）。桩若做成「给了才改」，
 *     把实现退化回裸 PUT 的变异体就**不会**变红 ⇒ 那条断言等于没测。
 */
function fakeMetabaseWithCards(
  seed: MbDashboardSeed[],
): { state: { dashboards: FakeDashboardState[]; calls: Rec[] }; fetcher: FetchLike } {
  const dashboards: FakeDashboardState[] = []
  for (const s of seed) {
    let d = dashboards.find((x) => x.id === s.id)
    if (d === undefined) {
      d = { id: s.id, name: s.name, dashcards: [], parameters: [], embedding_params: null }
      dashboards.push(d)
    }
    d.dashcards.push(...(s.dashcards ?? []))
    if (s.parameters !== undefined) d.parameters = s.parameters
  }
  const state = { dashboards, calls: [] as Rec[] }
  const respond = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

  const fetcher: FetchLike = async (url, init) => {
    state.calls.push({ url, init })
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined
      ? undefined
      : (JSON.parse(String(init.body)) as Record<string, unknown>)
    const u = new URL(url)
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') ?? ''
      return respond({
        data: state.dashboards
          .filter((d) => d.name.includes(q))
          .map((d) => ({ id: d.id, name: d.name, model: 'dashboard' })),
      })
    }
    const m = /^\/api\/dashboard\/(\d+)$/.exec(u.pathname)
    const d = m === null ? undefined : state.dashboards.find((x) => x.id === Number(m[1]))
    // 未知路径 / 未知 id 一律 404（真机形状；不回落成 200 空体——那会让形状断言永远成立）
    if (d === undefined) return respond({ message: 'not found' }, 404)

    if (method === 'GET') {
      return respond({
        id: d.id, name: d.name, dashcards: d.dashcards, parameters: d.parameters,
        embedding_params: d.embedding_params,
      })
    }
    if (method === 'PUT') {
      if (typeof body?.name === 'string') d.name = body.name
      // 替换语义（口径②）：缺键 ⇒ 清空
      d.dashcards = Array.isArray(body?.dashcards) ? (body.dashcards as MbDashcardSeed[]) : []
      d.parameters = Array.isArray(body?.parameters) ? (body.parameters as Record<string, unknown>[]) : []
      if (body !== undefined && 'embedding_params' in body) {
        d.embedding_params = (body.embedding_params ?? null) as Record<string, string> | null
      }
      return respond({ id: d.id, name: d.name })
    }
    return respond({ message: 'not found' }, 404)
  }
  return { state, fetcher }
}

describe('upsertDashboard：幂等（幂等要自实现——API 无按名 upsert，spec §6.5）', () => {
  it('★ 已存在的 dashboard 上重跑 upsert ⇒ dashcards **不变**（Goal 判据：幂等更新不得破坏已有内容）', async () => {
    // 这条是 Goal 的判据本身：`POST /reports` 的路径是 upsertDashboard → setEmbedding，而 upsert 排在
    // 前面；它若发裸 PUT {name}，等 setEmbedding 去 GET 时卡片**已经被清掉了**（合并也救不回来）。
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }] },
      { id: 7, name: 'o/a', dashcards: [{ id: 2, card_id: 12, row: 6, col: 0, size_x: 6, size_y: 4 }] },
    ])
    // search 命中同名 ⇒ 走「已存在」那条分支
    expect(await upsertDashboard(depsOf(fetcher), 'o/a')).toEqual({ id: 7, created: false })
    expect(state.dashboards[0].name).toBe('o/a')
    expect(state.dashboards[0].dashcards).toHaveLength(2)  // ← 关键断言：裸 PUT 会把它清成 0
  })

  it('search 命中同名 dashboard ⇒ PUT 覆盖，**不** POST（只产生一次创建）', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [{ id: 7, name: '销售日报', model: 'dashboard' }], total: 1 } },
      // 命中后的更新走 putDashboardMerged ⇒ 多一次「读全量」（真机形状：dashcards 是数组）
      { body: { id: 7, name: '销售日报', dashcards: [], parameters: [] } },
      { body: { id: 7, name: '销售日报' } },
    ])
    const out = await upsertDashboard(depsOf(fetcher), '销售日报')
    expect(out).toEqual({ id: 7, created: false })
    expect(calls).toHaveLength(3)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(calls[0].url).toContain('/api/search?')
    // q 必须带上（否则搜不出来）+ models 收窄到 dashboard（否则 card/collection 混进来）
    expect(calls[0].url).toContain(`q=${encodeURIComponent('销售日报')}`)
    expect(calls[0].url).toContain('models=dashboard')
    // ① 读全量（合并的输入）② 合并写回。载荷里 name/parameters/dashcards/embedding_params 四键齐
    // —— 不再是有啥发啥的裸 PUT。⚠️ `embedding_params` **恒在**（本轮修复）：GET 侧缺键归一成 `{}`，
    // 此处同样回写 `{}`；缺键语义无实测，缺了它「一次只改 name 的合并 PUT」可能就抹掉
    // `{tenant:'locked'}`（静默解开租户绑定）。
    expect(calls[1].init?.method ?? 'GET').toBe('GET')
    expect(calls[1].url).toBe('https://mb.test/api/dashboard/7')
    expect(calls[2].init?.method).toBe('PUT')
    expect(calls[2].url).toBe('https://mb.test/api/dashboard/7')
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      name: '销售日报', parameters: [], dashcards: [], embedding_params: {},
    })
    // 每个请求都带 API key（否则真机 401，而单测里若桩不校验就结构性看不见）
    for (const c of calls) expect(headerOf(c, 'x-api-key')).toBe('mb-api-key')
  })

  it('已存在 + 给了 collectionId ⇒ 合并 PUT 仍带上 collection_id（不许静默丢掉「移进集合」这个语义）', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [{ id: 7, name: 'o/a', model: 'dashboard' }] } },
      { body: { id: 7, name: 'o/a', dashcards: [], parameters: [] } },
      { body: { id: 7 } },
    ])
    await upsertDashboard(depsOf(fetcher), 'o/a', 3)
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ name: 'o/a', collection_id: 3 })
  })

  it('search 未命中 ⇒ POST 创建，返回体里的 id', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [], total: 0 } },
      { body: { id: 41, name: '门店库存', collection_id: 3 } },
    ])
    const out = await upsertDashboard(depsOf(fetcher), '门店库存', 3)
    expect(out).toEqual({ id: 41, created: true })
    expect(calls[1].init?.method).toBe('POST')
    expect(calls[1].url).toBe('https://mb.test/api/dashboard')
    // collectionId 给了才带（不给就不带 —— 别塞 undefined 进 body）
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: '门店库存', collection_id: 3 })
  })

  it('不带 collectionId ⇒ POST body 里没有 collection_id 这个键', async () => {
    const { calls, fetcher } = stub([{ body: { data: [] } }, { body: { id: 5 } }])
    await upsertDashboard(depsOf(fetcher), '无集合')
    expect('collection_id' in JSON.parse(String(calls[1].init?.body))).toBe(false)
  })

  it('★ 模糊命中不算命中：search 只回了「销售日报（副本）」⇒ 必须 POST 新建，不许 PUT 它', async () => {
    // 这是幂等缺陷的高发点：`includes`/`startsWith` 写法会把它当同名 ⇒ 第二次 POST 会改到别人的报表
    const { calls, fetcher } = stub([
      { body: { data: [{ id: 9, name: '销售日报（副本）', model: 'dashboard' }] } },
      { body: { id: 12, name: '销售日报' } },
    ])
    expect(await upsertDashboard(depsOf(fetcher), '销售日报')).toEqual({ id: 12, created: true })
    expect(calls[1].init?.method).toBe('POST')
  })

  it('★ 同名但 model 不是 dashboard（如 question）⇒ 不算命中（别去 PUT 一张卡片）', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [{ id: 3, name: '销售日报', model: 'card' }] } },
      { body: { id: 15, name: '销售日报' } },
    ])
    expect(await upsertDashboard(depsOf(fetcher), '销售日报')).toEqual({ id: 15, created: true })
    expect(calls[1].init?.method).toBe('POST')
  })

  it('真机出现重复同名时取最小 id（顺序确定，不靠 search 的排序）', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [
        { id: 30, name: '日报', model: 'dashboard' },
        { id: 8, name: '日报', model: 'dashboard' },
      ] } },
      { body: { id: 8, name: '日报', dashcards: [], parameters: [] } },
      { body: { id: 8 } },
    ])
    expect(await upsertDashboard(depsOf(fetcher), '日报')).toEqual({ id: 8, created: false })
    expect(calls[2].url).toBe('https://mb.test/api/dashboard/8')
  })
})

describe('dashboardName / parseDashboardName：Metabase 侧身份按 org 命名空间化（I-1）', () => {
  it('★ 两个 org 的同名报表 ⇒ Metabase 侧名字不同（跨租户串味从结构上消除）', () => {
    expect(dashboardName('org-a', '销售日报')).toBe('org-a/销售日报')
    // 这一条就是 I-1 的根因面：名字若相同，`GET /api/search` 按名命中 ⇒ 两租户共用一张 dashboard
    expect(dashboardName('org-a', '销售日报')).not.toBe(dashboardName('org-b', '销售日报'))
  })

  it('title 里的 / 不破坏解析（按**第一个** / 切，org 恒取前缀）', () => {
    expect(parseDashboardName(dashboardName('org-a', '2026/09 月报')))
      .toEqual({ org: 'org-a', title: '2026/09 月报' })
  })

  it('往返：parse(dashboardName(org, title)) 还原 org 与 title', () => {
    const cases: Array<[string, string]> = [
      ['org-a', '日报'], ['org-b', '带 空格 的'], ['org-c', '带/斜杠/多段'], ['org-d', ''],
    ]
    for (const [org, title] of cases) {
      expect(parseDashboardName(dashboardName(org, title))).toEqual({ org, title })
    }
  })

  it('★ 没有命名空间前缀（人在 Metabase 侧直接建的）⇒ null（对账归到「需人看」）', () => {
    expect(parseDashboardName('手工建的报表')).toBeNull()
    expect(parseDashboardName('/销售日报')).toBeNull() // 空前缀：解不出 org
    expect(parseDashboardName('')).toBeNull()
  })
})

describe('setEmbedding：发布 + 锁参数（只有未版本化老 API 能做，spec §6.4）', () => {
  /**
   * 一次 `setEmbedding` 的**第一条**响应：真机形状的 `GET /api/dashboard/{id}`。
   * 实现改成「先 GET 全量 → 合并 → 再 PUT」后，这三个 embedding 字段是**合并**进全量里的，
   * 所以队列首条必须是 `dashcards` 为数组的那份读侧响应（否则 `getDashboardFull` 抛形状错——
   * 那是**有意的** fail-closed：读不出就是读不出）。
   */
  const dashOf = (dashcards: unknown[] = []) =>
    ({ body: { id: 7, name: 'org-a/日报', dashcards, parameters: [] } })

  it('PUT /api/dashboard/{id} 载荷含 enable_embedding + embedding_type=signed + embedding_params 映射', async () => {
    const { calls, fetcher } = stub([
      dashOf([{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }]),
      { body: { id: 7 } },
    ])
    await setEmbedding(depsOf(fetcher), 7, [
      { name: 'tenant', mode: 'locked' },
      { name: 'region', mode: 'enabled' },
      { name: 'internal', mode: 'disabled' },
    ])
    // 走 putDashboardMerged ⇒ 一次 setEmbedding = GET（读全量）+ PUT（合并写回）两次调用
    expect(calls).toHaveLength(2)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(calls[0].url).toBe('https://mb.test/api/dashboard/7')
    expect(calls[1].init?.method).toBe('PUT')
    expect(calls[1].url).toBe('https://mb.test/api/dashboard/7')
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      // 全量里的 name / parameters / dashcards 一个都不能丢
      name: 'org-a/日报',
      parameters: [],
      // ★ 已有的卡**必须写回去**：这一条就是本文件要修的 bug 本体的断言（裸 PUT 会把它清成 []）
      dashcards: [{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }],
      enable_embedding: true,
      embedding_type: 'signed',
      embedding_params: { tenant: 'locked', region: 'enabled', internal: 'disabled' },
    })
  })

  it('零参数 ⇒ embedding_params 是空映射（不是 undefined/缺键）', async () => {
    const { calls, fetcher } = stub([dashOf(), { body: {} }])
    await setEmbedding(depsOf(fetcher), 7, [])
    expect(JSON.parse(String(calls[1].init?.body)).embedding_params).toEqual({})
  })
})

describe('putDashboardMerged：PUT 不得清掉已存在的卡片', () => {
  it('对已有 2 张卡的 dashboard 只改 name，卡片仍为 2', async () => {
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }] },
      { id: 7, name: 'o/a', dashcards: [{ id: 2, card_id: 12, row: 6, col: 0, size_x: 6, size_y: 4 }] },
    ])
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    await putDashboardMerged(deps, 7, { name: 'o/a-renamed' })
    expect(state.dashboards[0].name).toBe('o/a-renamed')
    expect(state.dashboards[0].dashcards).toHaveLength(2)  // ← 关键断言
  })

  it('patch 里给了 dashcards ⇒ 用 patch 的；没给 ⇒ 保留 GET 回来的', async () => {
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 8, name: 'o/b', dashcards: [{ id: 1, card_id: 21, row: 0, col: 0, size_x: 12, size_y: 6 }] },
    ])
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    await putDashboardMerged(deps, 8, { dashcards: [{ id: 1, cardId: 21, row: 0, col: 0, sizeX: 6, sizeY: 6 }] })
    expect(state.dashboards[0].dashcards[0].size_x).toBe(6)
  })

  it('★ 合并 PUT 恒回写 embedding_params（键恒在；值 = 刚 GET 到的当前值）——不赌上游「缺键」的语义', async () => {
    const { state, fetcher } = fakeMetabaseWithCards([{ id: 9, name: 'o/c' }])
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    state.dashboards[0].embedding_params = { tenant: 'locked' }
    await putDashboardMerged(deps, 9, { name: 'o/c-renamed' })
    const body = JSON.parse(String(state.calls[state.calls.length - 1].init?.body)) as Record<string, unknown>
    expect(body).toHaveProperty('embedding_params')            // 缺键语义无实测 ⇒ 键恒在
    expect(body.embedding_params).toEqual({ tenant: 'locked' }) // 同值回写 = 语义 no-op

    // 未发布过（读侧 `embedding_params: null` 归一成 `{}`）时也带键：`{}` 是既有合法载荷
    // （`setEmbedding` 零参数那条路已在发它，见上一条 describe），真正**没实测**的是「缺键」。
    state.dashboards[0].embedding_params = null
    await putDashboardMerged(deps, 9, { name: 'o/c-again' })
    const again = JSON.parse(String(state.calls[state.calls.length - 1].init?.body)) as Record<string, unknown>
    expect(again.embedding_params).toEqual({})
  })
})

describe('读全量/合并写回：真机形状的三条硬约束（站内同版本镜像实测）', () => {
  const mbDeps = (fetcher: FetchLike): MetabaseDeps =>
    ({ fetcher, baseUrl: 'http://mb', apiKey: 'k' })

  it('★ 参数**不许窄化**：窄化成 [{slug}] 回写会被真机 400（实测 parameters[0].id: missing required key）', async () => {
    // 窄化的后果不是"静默丢字段"而是**恒 400**：只要 dashboard 上有参数，发布就永远失败。
    // 而 Task 5 干的正是"给 dashboard 建 tenant 参数" ⇒ 这条是那条主路径的前提。
    const param = { id: 'p-tenant', name: 'tenant', slug: 'tenant', type: 'category', sectionId: 'string' }
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [], parameters: [param] },
    ])
    const deps = mbDeps(fetcher)
    // 读侧：原样保留（要 slug 的人自己读 `.slug`）
    expect((await getDashboardFull(deps, 7)).parameters).toEqual([param])
    // 写侧：patch 没给 parameters ⇒ 把读回来的**原值**写回
    await putDashboardMerged(deps, 7, { name: 'o/a-renamed' })
    expect(state.dashboards[0].parameters).toEqual([param])
  })

  it('★ hasParameterMappings 如实报「挂了任意参数」——挂 region 的卡也是 true（判 tenant 不在这里）', async () => {
    // 名字若叫 mappedToTenant，Task 6 就会把「挂了别个参数的卡」判成合格 ⇒ 对账假绿。
    // metabase.ts 是纯 HTTP 客户端，不认平台侧的参数命名；判 tenant 归消费者（它手里有 parameterMappings）。
    const mapping = { parameter_id: 'p-region', card_id: 11, target: ['variable', ['template-tag', 'region']] }
    const { fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [
        { id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6, parameter_mappings: [mapping] },
      ] },
      { id: 7, name: 'o/a', dashcards: [
        { id: 2, card_id: 12, row: 6, col: 0, size_x: 6, size_y: 4 },
      ] },
    ])
    const full = await getDashboardFull(mbDeps(fetcher), 7)
    expect(full.dashcards.map((d) => d.hasParameterMappings)).toEqual([true, false])
    expect(full.dashcards[0].parameterMappings).toEqual([mapping])
  })

  it('★ 文本卡（card_id: null）不抛形状错，且文字逐字回写（否则加过文本卡的报表发布恒 502）', async () => {
    const textCard = {
      id: 2, card_id: null, row: 6, col: 0, size_x: 6, size_y: 4,
      visualization_settings: { text: '这是人手动加的文本卡' },
    }
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }, textCard] },
    ])
    const deps = mbDeps(fetcher)
    expect((await getDashboardFull(deps, 7)).dashcards[1].cardId).toBeNull()
    await putDashboardMerged(deps, 7, { name: 'o/a-renamed' })
    // 逐字：card_id 仍是 null，且 visualization_settings.text **还在**（不回写它 = 把人的文字清掉）
    expect(state.dashboards[0].dashcards[1]).toEqual(textCard)
  })

  it('★ 但真正读不出的形状照旧抛（fail-closed 的边界没被放宽）', async () => {
    // dashcards 不是数组
    await expect(getDashboardFull(mbDeps(stub([{ body: { id: 7, name: 'o/a' } }]).fetcher), 7))
      .rejects.toThrow(MetabaseError)
    // card_id 既不是数字也不是显式 null：真机上不存在这个形状 ⇒ 读不出就是读不出
    await expect(getDashboardFull(mbDeps(stub([
      { body: { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 'x' }] } },
    ]).fetcher), 7)).rejects.toThrow(MetabaseError)
    // 缺键（`card_id` 整个不在）同样算读不出
    await expect(getDashboardFull(mbDeps(stub([
      { body: { id: 7, name: 'o/a', dashcards: [{ id: 1 }] } },
    ]).fetcher), 7)).rejects.toThrow(MetabaseError)
    // dashcard 自己的 id 非数字
    await expect(getDashboardFull(mbDeps(stub([
      { body: { id: 7, name: 'o/a', dashcards: [{ card_id: 11 }] } },
    ]).fetcher), 7)).rejects.toThrow(MetabaseError)
  })

  it('★ 畸形 parameter_mappings（truthy 非数组）⇒ throw，不静默丢（终审修复：静默丢 = 该卡映射下次发布被清）', async () => {
    // 读侧把畸形映射静默归 undefined 的话，合并写路径（putDashboardMerged）回写时该卡就不带
    // parameter_mappings 键 ⇒ 真机替换语义下，这条卡的现有映射在**下一次发布**时被清掉——
    // 正是本支要防的失效类。口径同畸形 card_id：读不出就是读不出，不猜、不静默降级。
    for (const bad of ['oops', { parameter_id: 'p-region' }]) {
      await expect(getDashboardFull(mbDeps(stub([
        { body: { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 11, parameter_mappings: bad }] } },
      ]).fetcher), 7)).rejects.toThrow(MetabaseError)
    }
  })
})

describe('getCard / getCardTemplateTags：卡片原生查询的读侧产物（v0.63 的 MBQL stages 形态）', () => {
  /** 一次 `GET /api/card/{id}` 的真机响应形状（阶段数组里才有 native 与 template-tags）。 */
  const cardOf = (stage: Record<string, unknown>) => ({ body: { dataset_query: { stages: [stage] } } })

  it('数组形态的 template-tags（我们编译产的）⇒ 取每项的 name', async () => {
    const { calls, fetcher } = stub([
      cardOf({ native: 'select 1', 'template-tags': [{ name: 'tenant' }, { name: 'region' }] }),
    ])
    expect(await getCardTemplateTags(depsOf(fetcher), 11)).toEqual(['tenant', 'region'])
    expect(calls[0].url).toBe('https://mb.test/api/card/11')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(headerOf(calls[0], 'x-api-key')).toBe('mb-api-key')
  })

  it('字典形态的 template-tags（人直接在 Metabase UI 里建的）⇒ 取键名', async () => {
    const { fetcher } = stub([
      cardOf({ native: 'select 1', 'template-tags': { tenant: { name: 'tenant', type: 'text' } } }),
    ])
    expect(await getCardTemplateTags(depsOf(fetcher), 11)).toEqual(['tenant'])
  })

  it('template-tags 为 null ⇒ 空数组（**不是抛**：这只是"该卡没挂标签"这个结论本身）', async () => {
    const { fetcher } = stub([cardOf({ native: 'select 1', 'template-tags': null })])
    expect(await getCardTemplateTags(depsOf(fetcher), 11)).toEqual([])
  })

  it('★ getCard **一次** GET 同时给出标签与**整个查询定义**；MBQL 卡（无 native）也在 queryJson 里', async () => {
    // 一次 GET 是「1 次 dashboard 读 + N 次卡片读」这条成本口径的落点：分两次调用会翻倍。
    // ⚠️ queryJson 取的是**整个 `dataset_query`**（不是 native SQL 字符串）：UI 建的卡默认是 MBQL
    //    （阶段里没有 native），只取 SQL 的话这类卡的摘要恒为空 ⇒ 人改它的查询指纹不动。
    const nativeStage = { native: 'select * from item', 'template-tags': { tenant: { name: 'tenant' } } }
    const mbqlStage = { 'source-table': 3, 'template-tags': { tenant: { name: 'tenant' } } }
    const { calls, fetcher } = stub([cardOf(nativeStage), cardOf(mbqlStage)])
    const deps = depsOf(fetcher)
    const native = await getCard(deps, 11)
    expect(native.tags).toEqual(['tenant'])
    expect(JSON.parse(native.queryJson)).toEqual({ stages: [nativeStage] })
    const mbql = await getCard(deps, 12)
    expect(mbql.tags).toEqual(['tenant'])
    // MBQL 卡**不是空摘要**：它的查询定义（source-table 等）逐字在里面，且与 native 卡不同
    expect(JSON.parse(mbql.queryJson)).toEqual({ stages: [mbqlStage] })
    expect(mbql.queryJson).not.toBe(native.queryJson)
    expect(calls).toHaveLength(2)
  })

  it('★ stages 不是数组 ⇒ 抛（读不出就是读不出，不许回落成"没标签、没 SQL"）', async () => {
    await expect(getCard(depsOf(stub([{ body: { dataset_query: {} } }]).fetcher), 11))
      .rejects.toThrow(MetabaseError)
  })
})

describe('listEmbeddableDashboards：对账的正规可观测面（spec §6.5——别看 iframe）', () => {
  it('GET /api/dashboard/embeddable 裸数组 → 归一成 {id,name}', async () => {
    const { calls, fetcher } = stub([
      { body: [{ id: 7, name: '销售日报', extra: 'ignored' }, { id: 8, name: '库存' }] },
    ])
    expect(await listEmbeddableDashboards(depsOf(fetcher))).toEqual([
      { id: 7, name: '销售日报' }, { id: 8, name: '库存' },
    ])
    expect(calls[0].url).toBe('https://mb.test/api/dashboard/embeddable')
    expect(headerOf(calls[0], 'x-api-key')).toBe('mb-api-key')
  })

  it('★ 形状不是数组 ⇒ 抛（fail-closed）：宁可显式失败，也不把对账跑成「零差集」', async () => {
    // 若这里回落成 []，对账会报告「无差集」——把「读不到」伪装成「对得上」，正是对账机制最怕的假绿
    const { fetcher } = stub([{ body: { data: [{ id: 7 }] } }])
    await expect(listEmbeddableDashboards(depsOf(fetcher))).rejects.toThrow(MetabaseError)
  })
})

describe('getDashboardEmbeddingParams：对账回读（RR9②——把「靠人记得」变成机械判据）', () => {
  it('回读 GET /api/dashboard/{id} ⇒ embedding_params 映射（带 API key）', async () => {
    const { calls, fetcher } = stub([
      { body: { id: 7, name: 'org-a/日报', embedding_params: { tenant: 'locked', region: 'locked' } } },
    ])
    expect(await getDashboardEmbeddingParams(depsOf(fetcher), 7))
      .toEqual({ tenant: 'locked', region: 'locked' })
    expect(calls[0].url).toBe('https://mb.test/api/dashboard/7')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(headerOf(calls[0], 'x-api-key')).toBe('mb-api-key')
  })

  it('★ 未发布过（embedding_params 为 null）⇒ {}，**不是抛**：那是「未锁」这个结论本身，交给上层显式报出', async () => {
    const { fetcher } = stub([{ body: { id: 7, embedding_params: null } }])
    expect(await getDashboardEmbeddingParams(depsOf(fetcher), 7)).toEqual({})
  })

  it('★ 形状既不是对象也不是 null（字符串 / 数组）⇒ 抛（读不出就是读不出，不许回落成 {} 伪装成「没问题」）', async () => {
    await expect(
      getDashboardEmbeddingParams(depsOf(stub([{ body: { id: 7, embedding_params: 'locked' } }]).fetcher), 7),
    ).rejects.toThrow(MetabaseError)
    await expect(
      getDashboardEmbeddingParams(depsOf(stub([{ body: { id: 7, embedding_params: [] } }]).fetcher), 7),
    ).rejects.toThrow(MetabaseError)
  })

  it('404（dashboard 已消失）⇒ 抛 MetabaseError(404)', async () => {
    const { fetcher } = stub([{ status: 404, body: { message: 'not found' } }])
    await expect(getDashboardEmbeddingParams(depsOf(fetcher), 7)).rejects.toThrow(MetabaseError)
  })
})

describe('fail-closed：非 2xx 与网络错一律抛，不静默成功', () => {
  it('401 ⇒ 抛 MetabaseError(401)，且不回显响应体（凭证可能被回显）', async () => {
    const { fetcher } = stub([{ status: 401, body: { message: 'Invalid API key: mb-api-key' } }])
    const err = await listEmbeddableDashboards(depsOf(fetcher)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MetabaseError)
    expect((err as MetabaseError).status).toBe(401)
    // 只带状态码，不带 body 片段
    expect((err as MetabaseError).message).not.toContain('mb-api-key')
  })

  it('500 也抛（不是 4xx 才抛）', async () => {
    const { fetcher } = stub([{ status: 500, body: { message: 'boom' } }])
    await expect(listEmbeddableDashboards(depsOf(fetcher))).rejects.toThrow(MetabaseError)
  })

  it('网络错原样上抛（不是在客户端里吞成 undefined）', async () => {
    const { fetcher } = stub([new Error('ECONNREFUSED')])
    await expect(listEmbeddableDashboards(depsOf(fetcher))).rejects.toThrow('ECONNREFUSED')
  })
})

describe('signEmbedToken：HS256 嵌入 JWT', () => {
  const SECRET = '11111111-2222-3333-4444-555555555555'

  it('★ 可验签：三段结构正确 + 用同一密钥重算 HMAC 得同一签名（alg/typ 在头里）', () => {
    const token = signEmbedToken(SECRET, { type: 'dashboard', id: 7 }, { tenant: 'org-a' })
    const [h, p, s] = token.split('.')
    expect(s).toBe(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'))
    expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  it('★ payload：resource.dashboard = id，locked 值在 params 里，exp = now + ttl', () => {
    const before = Math.floor(Date.now() / 1000)
    const token = signEmbedToken(SECRET, { type: 'dashboard', id: 7 }, { tenant: 'org-a' }, 600)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    expect(payload.resource).toEqual({ dashboard: 7 })
    expect(payload.params).toEqual({ tenant: 'org-a' })
    expect(payload.exp).toBeGreaterThanOrEqual(before + 600)
    expect(payload.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600)
  })

  it('默认 ttl 600 秒', () => {
    const p = JSON.parse(Buffer.from(signEmbedToken(SECRET, { type: 'dashboard', id: 1 }, {}).split('.')[1], 'base64url').toString('utf8'))
    expect(p.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590)
  })

  it('★ 换密钥 ⇒ 签名不同（锁定的租户值对观看者不可伪造，spec §6.3）', () => {
    const a = signEmbedToken(SECRET, { type: 'dashboard', id: 7 }, { tenant: 'org-a' })
    const b = signEmbedToken('other-secret', { type: 'dashboard', id: 7 }, { tenant: 'org-a' })
    expect(a.split('.')[2]).not.toBe(b.split('.')[2])
  })
})

describe('embedDashboardUrl：嵌入页径必须是 signed embedding 那条（#412）', () => {
  it('★ 拼的是 /embed/dashboard/<token>，且**不是**公开分享页径 /public/dashboard/', () => {
    const url = embedDashboardUrl('https://mb.example.com', 'tok.abc.def')
    expect(url).toBe('https://mb.example.com/embed/dashboard/tok.abc.def')
    // 反向断言才是本用例的价值所在：`/public/dashboard/` 是 public sharing 的页径（认 public_uuid、不认 JWT）。
    // 拼错时页壳照开、页内数据请求打到 /api/public/embed/... 那个前后端都不存在的杂交端点 ⇒
    // **服务端四条链全绿而每张卡报「There was a problem displaying this chart」**（2026-10-03 真机实测）。
    // 写死这条负例，免得日后被「看着更像公开地址」改回去。
    expect(url).not.toContain('/public/dashboard/')
  })

  it('尾斜杠归一：baseUrl 带不带 / 都拼出同一条', () => {
    expect(embedDashboardUrl('https://mb.example.com/', 't')).toBe(embedDashboardUrl('https://mb.example.com', 't'))
  })
})

describe('metabaseFromEnv：三键缺一 ⇒ null（部署没配是配置状态，应回可解释的 503）', () => {
  it('三键齐 ⇒ 配置对象（tail 斜杠归一）', () => {
    expect(metabaseFromEnv({
      DATA_METABASE_URL: 'https://mb.example.test/',
      DATA_METABASE_API_KEY: 'k',
      DATA_METABASE_SECRET_KEY: 's',
    })).toEqual({ baseUrl: 'https://mb.example.test', apiKey: 'k', secretKey: 's' })
  })

  it('缺任一键 / 纯空白 ⇒ null', () => {
    expect(metabaseFromEnv({})).toBeNull()
    expect(metabaseFromEnv({
      DATA_METABASE_URL: 'https://mb.test', DATA_METABASE_API_KEY: 'k',
    })).toBeNull()
    expect(metabaseFromEnv({
      DATA_METABASE_URL: 'https://mb.test', DATA_METABASE_API_KEY: 'k', DATA_METABASE_SECRET_KEY: '  ',
    })).toBeNull()
  })
})
