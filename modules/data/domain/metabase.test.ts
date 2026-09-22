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
  getDashboardEmbeddingParams,
  listEmbeddableDashboards,
  metabaseFromEnv,
  parseDashboardName,
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

describe('upsertDashboard：幂等（幂等要自实现——API 无按名 upsert，spec §6.5）', () => {
  it('search 命中同名 dashboard ⇒ PUT 覆盖，**不** POST（两次调用只产生一次创建）', async () => {
    const { calls, fetcher } = stub([
      { body: { data: [{ id: 7, name: '销售日报', model: 'dashboard' }], total: 1 } },
      { body: { id: 7, name: '销售日报' } },
    ])
    const out = await upsertDashboard(depsOf(fetcher), '销售日报')
    expect(out).toEqual({ id: 7, created: false })
    expect(calls).toHaveLength(2)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(calls[0].url).toContain('/api/search?')
    // q 必须带上（否则搜不出来）+ models 收窄到 dashboard（否则 card/collection 混进来）
    expect(calls[0].url).toContain(`q=${encodeURIComponent('销售日报')}`)
    expect(calls[0].url).toContain('models=dashboard')
    expect(calls[1].init?.method).toBe('PUT')
    expect(calls[1].url).toBe('https://mb.test/api/dashboard/7')
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: '销售日报' })
    // 每个请求都带 API key（否则真机 401，而单测里若桩不校验就结构性看不见）
    for (const c of calls) expect(headerOf(c, 'x-api-key')).toBe('mb-api-key')
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
      { body: { id: 8 } },
    ])
    expect(await upsertDashboard(depsOf(fetcher), '日报')).toEqual({ id: 8, created: false })
    expect(calls[1].url).toBe('https://mb.test/api/dashboard/8')
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
  it('PUT /api/dashboard/{id} 载荷含 enable_embedding + embedding_type=signed + embedding_params 映射', async () => {
    const { calls, fetcher } = stub([{ body: { id: 7 } }])
    await setEmbedding(depsOf(fetcher), 7, [
      { name: 'tenant', mode: 'locked' },
      { name: 'region', mode: 'enabled' },
      { name: 'internal', mode: 'disabled' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].url).toBe('https://mb.test/api/dashboard/7')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      enable_embedding: true,
      embedding_type: 'signed',
      embedding_params: { tenant: 'locked', region: 'enabled', internal: 'disabled' },
    })
  })

  it('零参数 ⇒ embedding_params 是空映射（不是 undefined/缺键）', async () => {
    const { calls, fetcher } = stub([{ body: {} }])
    await setEmbedding(depsOf(fetcher), 7, [])
    expect(JSON.parse(String(calls[0].init?.body)).embedding_params).toEqual({})
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
