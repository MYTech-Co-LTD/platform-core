// pat-auth.test.ts — 通道 B 中间件的鉴权契约。
//
// ⚠️ 本文件**不需要真库**：中间件不再查表——凭证解析是**注入的端口**（`deps.resolveKey`，
//    由 modules/data 供给）。于是「命中 / 未命中 / 端口缺失 / 端口抛错」这些分支可以**直接构造**，
//    不用造库、不用 DROP/CREATE。真正的「模块建 key → 宿主认下来」端到端链归 T10 的 e2e
//    （那边有真库与真装配）——宿主测试不再需要 `data.query_keys` 一个字（B1 下它也不该有）。
//    因此本文件从 describePg（无 DATABASE_URL 即整体跳过）降为普通 describe：恒跑。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { CasdoorClient } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { ResolvedPatKey } from '@platform/sdk'
import { patIdentityMiddleware, type PatAuthDeps, type RequesterEnv } from './pat-auth'
import type { TenantRow } from './tenant'

const TENANT = 9003
const ORG = 'acme'
/** alice 的有效 PAT 明文（桩端口只认这一枚）。 */
const TOKEN = 'dkq_stub-alice'
/** 端口命中时返回的凭证主体。keyId 是限速的桶键，用例里到处引用它。 */
const ALICE_KEY: ResolvedPatKey = { keyId: 7, org: ORG, casdoorUser: 'alice' }

/** 租户字面量必须写全——缺一个字段就 TS2741，而且**后加的列最容易漏**，
 *  漏了就成了「测试替身比真机窄」。照 apps/server/src/routes/admin.test.ts:67 的写法。 */
const baseTenant: TenantRow = {
  id: TENANT, slug: 'acme', casdoor_org: ORG, product_name: 'P', logo: null,
  primary_color: '#1677ff', background: '', login_methods: ['password'],
  wecom_corp_id: null, wecom_agent_id: null, wecom_secret: null, wecom_provider: null,
  wecom_auto_signup: false,
  wechat_oa_app_id: null, wechat_oa_secret: null,
  storage_endpoint: null, storage_region: null, storage_bucket: null,
  storage_access_key: null, storage_secret: null,
  created_at: new Date(),
}

/**
 * ⚠️ MockCasdoor 的用户/权限是**构造时播种**的（`MockCasdoorOptions`），**没有**
 * addUser / addPerm / removeUser / client(org) 这些方法。要几个人就在构造时给几个，
 * 想加人只能新建实例 ⇒ 每个用例各自 `new` 一个，不要指望跨用例复用。
 *
 * ⚠️ `get-permissions` 认 `owner=`，且**权限按 owner 分桶**：客户端 org 必须与被测租户的
 * `casdoor_org` 一致，否则拿到的是空权限（症状：`scopes: []`，看着像"权限配错了"）。
 */
function casdoorFor(mock: MockCasdoor) {
  return (org: string) =>
    new CasdoorClient({
      origin: mock.origin, clientId: 'test-client', clientSecret: '', org,
      adminUser: 'admin', adminPwd: 'pw',
    })
}

/** 一个「alice 在 acme、有 data:query」的 mock。绝大多数用例要的就是它。 */
const withAlice = () =>
  new MockCasdoor({
    users: [{ name: 'alice', password: 'pw', owner: ORG }],
    perms: [{ owner: ORG, users: ['alice'], resources: ['data:query'] }],
  })

/**
 * 假 tenant 中间件 + 被测中间件 + 回显 handler。
 *  Env 泛型**必须**是 `RequesterEnv`（= TenantEnv & SessionEnv & { Variables: RequesterVars }）：
 *  `c.set('tenant', …)` 与 `c.get(REQUESTER_CHANNEL)` 都靠它，裸 `new Hono()` 会得到 BlankEnv。
 *
 *  默认端口：只认 TOKEN → ALICE_KEY，其余返 null（= 真机上「未命中」的形状）。
 *  `over` 里给 `resolveKey: undefined` 即模拟**端口缺失**（装配时 runtime.port 返 undefined）。
 */
function app(mock: MockCasdoor, over: Partial<PatAuthDeps> = {}) {
  const a = new Hono<RequesterEnv>()
  a.use('*', async (c, next) => {
    c.set('tenant', baseTenant)
    await next()
  })
  a.use('/api/modules/*', patIdentityMiddleware({
    casdoor: casdoorFor(mock),
    resolveKey: async (token: string) => (token === TOKEN ? ALICE_KEY : null),
    ...over,
  }))
  a.post('/api/modules/data/query', (c) => c.json({
    userId: c.get('identity')?.userId ?? null,
    scopes: c.get('identity')?.scopes ?? null,
    channel: c.get(REQUESTER_CHANNEL) ?? null,
    keyId: c.get(REQUESTER_KEY_ID) ?? null,
  }))
  return a
}

/** 带 PAT 头的请求。 */
const post = (a: Hono<RequesterEnv>, token: string) =>
  a.request('/api/modules/data/query', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  })

describe('patIdentityMiddleware', () => {
  it('有效 PAT → 注入 live scopes + 通道 / keyId', async () => {
    const mock = withAlice()
    await mock.start()

    const res = await post(app(mock), TOKEN)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ userId: 'alice', channel: 'pat', keyId: ALICE_KEY.keyId })
    expect(body.scopes).toContain('data:query')
    await mock.stop()
  })

  it('端口未命中（未知 / 已吊销 token）→ 401 INVALID_KEY（不落到下一层）', async () => {
    const mock = withAlice(); await mock.start()
    const res = await post(app(mock), 'dkq_nope')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('INVALID_KEY')
    await mock.stop()
  })

  it('跨租户 key（端口主体 org ≠ 租户 org）→ 401 INVALID_KEY', async () => {
    const mock = withAlice(); await mock.start()
    // 同码不同因：不泄露「这枚 token 存在，只是不属于你」
    const res = await post(app(mock, {
      resolveKey: async () => ({ keyId: 8, org: 'other-org', casdoorUser: 'alice' }),
    }), TOKEN)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('INVALID_KEY')
    await mock.stop()
  })

  it('端口缺失（模块未声明 createPorts）→ 503 PAT_UNAVAILABLE，**不是放行**', async () => {
    const mock = withAlice(); await mock.start()
    // 关键：调用方带着 PAT 形状的凭证，放行等于把它当匿名请求处理——fail-closed 才是正解
    // （与企微/访客码「没开这个能力 ⇒ 放行」刻意不同，见正典「模块端口」安全性质第 3 条）。
    const res = await post(app(mock, { resolveKey: undefined }), TOKEN)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('PAT_UNAVAILABLE')
    await mock.stop()
  })

  it('端口抛错（模块侧不可用）→ 503 PAT_UNAVAILABLE（无主体即无授权，不降级）', async () => {
    const mock = withAlice(); await mock.start()
    const res = await post(app(mock, {
      resolveKey: async () => { throw new Error('key store unavailable') },
    }), TOKEN)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('PAT_UNAVAILABLE')
    await mock.stop()
  })

  it('Casdoor 挂 → 503 CASDOOR_UNAVAILABLE（**不**降级用旧权限——PAT 没有旧权限可降）', async () => {
    const mock = withAlice(); await mock.start()
    await mock.stop()   // 关掉 → 连接失败
    const res = await post(app(mock), TOKEN)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('CASDOOR_UNAVAILABLE')
  })

  it('用户已被删 → 401 USER_GONE（getUser 返 null，不是抛错）', async () => {
    // 端口命中的是 ghost，但 mock 里**没有** ghost 这个人（构造时就不播种他）。
    // 真机口径：查无此人 ⇒ 200 + `{status:'ok', data:null}` ⇒ client 返 null；
    // 而 `{status:'error'}` 是另一堆情形（admin 会话失效等），client 会**抛**（走 503 分支）。
    // 想造后者用 `mock.setGetUserFault('error')`，别指望"删人"——mock 没有删除方法。
    const mock = withAlice(); await mock.start()
    const res = await post(app(mock, {
      resolveKey: async () => ({ keyId: 9, org: ORG, casdoorUser: 'ghost' }),
    }), TOKEN)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('USER_GONE')
    await mock.stop()
  })

  it('已有 identity（会话通道）→ 不覆盖（first-setter-wins）', async () => {
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      c.set('identity', { userId: 'sess', orgId: ORG, displayName: 'sess', scopes: [], hasScope: () => false })
      await next()
    })
    a.use('/api/modules/*', patIdentityMiddleware({
      casdoor: casdoorFor(mock),
      resolveKey: async () => ALICE_KEY,
    }))
    a.post('/api/modules/data/query', (c) => c.json({ userId: c.get('identity').userId }))
    const res = await post(a, TOKEN)
    expect((await res.json()).userId).toBe('sess')
    await mock.stop()
  })

  it('非 dkq_ 的 Bearer → 放行（不是 PAT 的地盘，交给下游门卫）', async () => {
    const mock = withAlice(); await mock.start()
    // 端口缺失也照样放行——先按前缀分流，再谈端口（否则会把整条 /api/modules/* 锁死）
    const res = await post(app(mock, { resolveKey: undefined }), 'some-oauth-token')
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBeNull()
    await mock.stop()
  })

  it('超过 per-key 限速 → 429 RATE_LIMITED', async () => {
    const mock = withAlice(); await mock.start()
    const a = app(mock, { ratePerMin: 2 })   // 2 次/分钟
    const hit = () => post(a, TOKEN)
    expect((await hit()).status).toBe(200)
    expect((await hit()).status).toBe(200)
    const third = await hit()
    expect(third.status).toBe(429)
    expect((await third.json()).error).toBe('RATE_LIMITED')
    await mock.stop()
  })
})
