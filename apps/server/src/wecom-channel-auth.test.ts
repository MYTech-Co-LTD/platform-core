// wecom-channel-auth.test.ts — 通道 C（企微渠道凭证 + X-Wecom-Userid）的鉴权契约。
//
// 与 pat-auth.test.ts 同一套装配/辅助（baseTenant / casdoorFor / withAlice / RequesterEnv）——
// 两个中间件在宿主里共用同一个 Env 求交，测试也用同一份，避免两处各写一份写歪。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { CasdoorClient } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import { WECOM_USERID_HEADER, wecomChannelIdentityMiddleware } from './wecom-channel-auth'
import type { RequesterEnv } from './pat-auth'
import type { TenantRow } from './tenant'

// 本文件不碰库（通道 C 无 key 表），故**不设 DATABASE_URL 门**：恒跑。
// 曾与 pat-auth.test.ts 同用 describePg（那时那边要真库，靠它保证「整组同生共死」）；
// 那边改走注入端口后不再需要库，这条门也就失去了唯一的理由。
const TENANT = 9003
const ORG = 'acme'
const CHANNEL_KEY = 'channel-secret-for-test'

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

describe('wecomChannelIdentityMiddleware', () => {
  /** 假 tenant 中间件 + 被测中间件 + 回显 handler（与 pat-auth.test.ts 同形）。 */
  function app(mock: MockCasdoor, channelKey: string | undefined = CHANNEL_KEY) {
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      await next()
    })
    a.use('/api/modules/*', wecomChannelIdentityMiddleware({
      casdoor: casdoorFor(mock), channelKey,
    }))
    a.post('/api/modules/data/query', (c) => c.json({
      userId: c.get('identity')?.userId ?? null,
      scopes: c.get('identity')?.scopes ?? null,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
    }))
    return a
  }

  const call = (a: Hono<RequesterEnv>, headers: Record<string, string>) =>
    a.request('/api/modules/data/query', { method: 'POST', headers })

  it('渠道凭证正确 + X-Wecom-Userid: alice → 注入身份 + channel=wecom', async () => {
    const mock = withAlice(); await mock.start()
    const res = await call(app(mock), {
      'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'alice',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ userId: 'alice', channel: 'wecom' })
    expect(body.scopes).toContain('data:query')
    await mock.stop()
  })

  it('渠道凭证错误 → 401 CHANNEL_KEY_INVALID', async () => {
    const mock = withAlice(); await mock.start()
    const res = await call(app(mock), {
      'x-channel-key': 'wrong', [WECOM_USERID_HEADER]: 'alice',
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('CHANNEL_KEY_INVALID')
    await mock.stop()
  })

  it('未配 DATA_WECOM_CHANNEL_KEY → 直接放行（该部署没开通道 C，不能把 /api/modules/* 全锁死）', async () => {
    // ⚠️ 本用例**不能**写成 `app(mock, undefined)`：那会命中形参默认值（= CHANNEL_KEY），
    // 测到的其实是"配了 key 但请求没带" ⇒ 401，而用例名说的是"没配 key"。
    // 「未配」这个部署形状由 `config.dataWecomChannelKey`（optional()）给 undefined，
    // 故这里显式手搭一个 channelKey 缺席的实例——部署形状在调用点自明。
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      await next()
    })
    a.use('/api/modules/*', wecomChannelIdentityMiddleware({
      casdoor: casdoorFor(mock),   // channelKey 缺席 = 通道 C 关闭
    }))
    a.post('/api/modules/data/query', (c) => c.json({
      userId: c.get('identity')?.userId ?? null,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
    }))
    const res = await call(a, {})
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBeNull()
    await mock.stop()
  })

  it('缺 X-Wecom-Userid 头 → 401 WECOM_USERID_REQUIRED', async () => {
    const mock = withAlice(); await mock.start()
    const res = await call(app(mock), { 'x-channel-key': CHANNEL_KEY })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('WECOM_USERID_REQUIRED')
    await mock.stop()
  })

  it('getUser 返 null（未关联）→ 401 WECOM_USER_NOT_LINKED', async () => {
    // 造法：userid 取一个 mock 里**不存在**的人（mock 没有删除方法，只能"从来没播过种"）。
    const mock = withAlice(); await mock.start()
    const res = await call(app(mock), {
      'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'ghost',
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('WECOM_USER_NOT_LINKED')
    await mock.stop()
  })

  it('Casdoor 挂 → 503 CASDOOR_UNAVAILABLE（与 PAT 同口径：fail-closed，无缓存可降级）', async () => {
    const mock = withAlice(); await mock.start()
    await mock.stop()   // 关掉 → 连接失败
    const res = await call(app(mock), {
      'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'alice',
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('CASDOOR_UNAVAILABLE')
  })

  it('已有 identity（会话通道）→ 不覆盖（first-setter-wins）', async () => {
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      c.set('identity', { userId: 'sess', orgId: ORG, displayName: 'sess', scopes: [], hasScope: () => false })
      await next()
    })
    a.use('/api/modules/*', wecomChannelIdentityMiddleware({
      casdoor: casdoorFor(mock), channelKey: CHANNEL_KEY,
    }))
    a.post('/api/modules/data/query', (c) => c.json({
      userId: c.get('identity').userId,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
    }))
    const res = await call(a, { 'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'alice' })
    const body = await res.json()
    expect(body).toMatchObject({ userId: 'sess', channel: null })
    await mock.stop()
  })
})
