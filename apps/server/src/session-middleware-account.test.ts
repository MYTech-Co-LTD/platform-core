// session-middleware-account.test.ts — session 中间件正式态分支（账户统一 Task 5，TDD）
//
// 真 PG（本地 platform_core_acct，同 auth.test.ts 约定；未提供 DATABASE_URL 整体跳过）
// + 对象桩 CasdoorClient / 对象桩绑定集合解析器（wechat-oa 测试 casdoorUserGone 同先例）。
// 桩形状照 casdoor-client 真机契约（AGENTS 硬约束 #11）：getUser 返 CasdoorUser|null
// （null = 真机 200+ok+data:null「明确说没这个人」）、getPermissions 返记录数组。
// 中间件只消费这两个方法，本文件不触 HTTP（MockCasdoor 是登录路的事）。
//
// 钉住的分支语义（简报核心）：wantRefresh 三路——
//   authVia==='wechat-oa' && acct 存在 → 账户分支（getUser(p.acct)/effectiveScopes(p.acct)
//     + ext 重算独立 try/catch）；authVia==='wechat-oa'（无 acct）→ 既有访客分支零改动；
//   其余 → 内部分支零改动。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import {
  SCOPES_TTL_SEC,
  signSession,
  verifySession,
  type CasdoorClient,
  type CasdoorPermission,
  type CasdoorUser,
} from '@platform/auth-core'
import { runMigrations } from './migrate'
import { seedDemo } from './seed'
import { resolveTenantMiddleware, type TenantEnv } from './tenant'
import { sessionMiddleware, type CasdoorFactory, type SessionEnv } from './session-middleware'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用
const OPENID = 'o_t5_openid'
const ACCT = 't5_acct'

/** 正式态签发形状（Task 4 同款）：sub=openid、name=acct、带 acct/ext */
async function formalToken(ext: string[] = [OPENID]): Promise<string> {
  return signSession(
    {
      sub: OPENID,
      org: 'acme',
      name: ACCT,
      scopes: ['stale:scope'],
      authVia: 'wechat-oa',
      acct: ACCT,
      ext,
    },
    SECRET,
    nowSec() - SCOPES_TTL_SEC - 60, // sfa 过期触发刷新；exp 剩 >6 天不触发续期（⑥ 同款造法）
  )
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** Casdoor 正常形状桩：getUser 按名单作答并记录入参（钉「以 acct 校验」） */
function stubCasdoor(
  user: CasdoorUser | null,
  perms: CasdoorPermission[],
): { factory: CasdoorFactory; getUserArgs: string[] } {
  const getUserArgs: string[] = []
  const client = {
    getUser: async (name: string) => {
      getUserArgs.push(name)
      return user
    },
    getPermissions: async () => perms,
  } as unknown as CasdoorClient
  return { factory: () => client, getUserArgs }
}

/** Casdoor 故障桩：getUser/getPermissions 一律抛（真机 admin 会话失效 ⇒ client 抛错同语义） */
function stubCasdoorThrow(err: Error): CasdoorFactory {
  const client = {
    getUser: async (): Promise<never> => {
      throw err
    },
    getPermissions: async (): Promise<never> => {
      throw err
    },
  } as unknown as CasdoorClient
  return () => client
}

/** 绑定集合解析器桩：记录入参；给 Error 即恒抛（同时当绊线——不该触达的路一次都不许调） */
function stubBoundIds(result: string[] | Error): {
  dep: (org: string, casdoorName: string) => Promise<string[]>
  calls: Array<{ org: string; casdoorName: string }>
} {
  const calls: Array<{ org: string; casdoorName: string }> = []
  return {
    calls,
    dep: async (org, casdoorName) => {
      calls.push({ org, casdoorName })
      if (result instanceof Error) throw result
      return result
    },
  }
}

interface MakeAppOpts {
  casdoor: CasdoorFactory
  boundExternalIds?: (org: string, casdoorName: string) => Promise<string[]>
  guestScopes?: (tenantId: number) => Promise<string[]>
}

/** 宿主形态缩样（app.ts 装配链的对应段）：租户 → 会话中间件 → 探针路由 */
function makeApp(pool: Pool, opts: MakeAppOpts) {
  return new Hono<TenantEnv & SessionEnv>()
    .use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
    .use('*', sessionMiddleware({
      casdoor: opts.casdoor,
      sessionSecret: SECRET,
      guestScopes: opts.guestScopes,
      boundExternalIds: opts.boundExternalIds,
    }))
    .get('/probe', (c) => {
      const id = c.get('identity')
      if (!id) return c.json(null)
      // hasScope 是函数不上 JSON；逐字段投影，undefined 字段经序列化即缺席（形状可断言）
      return c.json({
        userId: id.userId,
        displayName: id.displayName,
        scopes: id.scopes,
        accountName: id.accountName,
        boundExternalIds: id.boundExternalIds,
      })
    })
}

function setCookies(res: Response): string[] {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''].filter(Boolean)
}

function sessionToken(res: Response): string {
  const m = /platform_session=([^;]+)/.exec(setCookies(res).join('\n'))
  if (!m) throw new Error('response has no platform_session Set-Cookie')
  return m[1]!
}

async function probe(
  app: ReturnType<typeof makeApp>,
  token: string,
): Promise<Response> {
  return app.request('/probe', {
    headers: { host: 'acme.test', cookie: `platform_session=${token}` },
  })
}

describe.skipIf(!dbUrl)('session 中间件正式态分支（账户统一 Task 5）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
    await seedDemo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  // Casdoor 真值：直挂 + 角色两路（同 auth.test.ts ⑥ 的断言基准）
  const T5_PERMS: CasdoorPermission[] = [
    { users: [ACCT], resources: ['ticket:view'] },
    { roles: ['store_ops'], resources: ['ticket:admin'] },
  ]
  const T5_USER: CasdoorUser = { name: ACCT, roles: ['store_ops'], displayName: '门店操作员' }

  it('正式态刷新：getUser 正常 ⇒ scopes=Casdoor 有效码、ext 重算重签', async () => {
    const cas = stubCasdoor(T5_USER, T5_PERMS)
    const bound = stubBoundIds([OPENID, 'wecom_user_1'])
    const app = makeApp(pool, { casdoor: cas.factory, boundExternalIds: bound.dep })
    const stale = await formalToken()
    const res = await probe(app, stale)
    expect(res.status).toBe(200)
    const sc = setCookies(res).join('\n')
    expect(sc).toContain('platform_session=') // 重签下发新 cookie
    expect(sc).not.toContain('Max-Age=0') // 是重签不是清会话
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view']) // stale 被换为 Casdoor 真值
    expect(p?.sub).toBe(OPENID) // openid 锚不变（正典修订：sub 仍 = openid）
    expect(p?.acct).toBe(ACCT) // 账户身份保留
    expect(p?.authVia).toBe('wechat-oa')
    expect(p?.sfa).toBeGreaterThanOrEqual(nowSec()) // 刷新点已推进
    expect([...(p?.ext ?? [])].sort()).toEqual([OPENID, 'wecom_user_1'].sort()) // ext 重算（不赌 DB 序）
    expect(cas.getUserArgs).toEqual([ACCT]) // 以 acct 校验账户（简报接口）
    expect(bound.calls).toEqual([{ org: 'acme', casdoorName: ACCT }]) // 以 acct 查绑定集合
    const body = (await res.json()) as {
      accountName?: string
      boundExternalIds?: string[]
      scopes: string[]
    }
    expect(body.accountName).toBe(ACCT) // Identity 扩展字段投影（Task 9 契约面）
    expect([...(body.boundExternalIds ?? [])].sort()).toEqual([OPENID, 'wecom_user_1'].sort())
    expect(body.scopes).toEqual(['ticket:admin', 'ticket:view']) // 本请求即见新 scopes
  })

  it('正式态：getUser=null ⇒ 清会话（与内部路同唯一清会话分支）', async () => {
    const cas = stubCasdoor(null, []) // getUser 恒 null（真机 200+ok+data:null「明确说没这个人」）
    const bound = stubBoundIds(new Error('清会话路不应触达绑定集合')) // 绊线：一次都不许调
    const app = makeApp(pool, { casdoor: cas.factory, boundExternalIds: bound.dep })
    const res = await probe(app, await formalToken())
    expect(res.status).toBe(200) // 中间件只清 cookie 照常放行（公开路由可达语义不变）
    expect(setCookies(res).join('\n')).toContain('Max-Age=0') // 唯一清会话分支
    expect(await res.json()).toBeNull() // 未注 identity
    expect(bound.calls).toEqual([]) // 即将清除的会话不必再算绑定集合
  })

  it('正式态：Casdoor 抛错 ⇒ 降级旧 scopes 不重签 + warn（复用现有窗口断言形状）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const casdoor = stubCasdoorThrow(new Error('casdoor admin session expired'))
      const bound = stubBoundIds([OPENID]) // 独立通路：照算不误，不影响降级判定
      const app = makeApp(pool, { casdoor, boundExternalIds: bound.dep })
      const oldExt = [OPENID, 'wecom_user_1']
      const res = await probe(app, await formalToken(oldExt))
      expect(res.status).toBe(200) // 可用性优先：降级放行
      expect(setCookies(res)).toEqual([]) // 不重签（重签会把 sfa 抹成 now 遮蔽故障）
      const body = (await res.json()) as {
        scopes: string[]
        accountName?: string
        boundExternalIds?: string[]
      }
      expect(body.scopes).toEqual(['stale:scope']) // 旧 scopes 继续
      expect(body.accountName).toBe(ACCT) // 旧会话照注 identity（acct 仍在载荷里）
      expect([...(body.boundExternalIds ?? [])].sort()).toEqual(oldExt.sort())
      const lines = warn.mock.calls.map((a) => String(a[0] ?? ''))
      expect(lines).toHaveLength(1) // 降级留唯一信号（同 org 窗口去重）
      expect(lines[0]).toContain('acme') // 带 org：故障定位要能落到租户
      expect(lines[0]).toContain('降级') // 说清处置（既有 warn 文案形状）
    } finally {
      warn.mockRestore()
    }
  })

  it('正式态：boundExternalIds 抛错 ⇒ scopes 照刷、ext 沿用旧值', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cas = stubCasdoor(T5_USER, T5_PERMS) // Casdoor 正常
      const bound = stubBoundIds(new Error('identity_link db down'))
      const app = makeApp(pool, { casdoor: cas.factory, boundExternalIds: bound.dep })
      const oldExt = [OPENID, 'wecom_user_1']
      const res = await probe(app, await formalToken(oldExt))
      expect(res.status).toBe(200)
      expect(setCookies(res).join('\n')).toContain('platform_session=') // scopes 刷新不被牵连，照重签
      const p = await verifySession(sessionToken(res), SECRET)
      expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view']) // scopes 照刷
      expect([...(p?.ext ?? [])].sort()).toEqual(oldExt.sort()) // ext 沿用旧值（重算失败不换新）
      const lines = warn.mock.calls.map((a) => String(a[0] ?? ''))
      expect(lines).toHaveLength(1) // 绑定集合降级同样留信号、不静默
      expect(lines[0]).toContain('boundExternalIds') // 来源可辨（访客路 warn 同形状）
      expect(lines[0]).toContain('acme')
    } finally {
      warn.mockRestore()
    }
  })

  it('中间态（无 acct）不触 Casdoor：neverCasdoor 工厂下刷新照常', async () => {
    const neverCasdoor: CasdoorFactory = () => {
      throw new Error('中间态不应触达 Casdoor')
    }
    const bound = stubBoundIds(new Error('中间态不应触达绑定集合')) // 绊线
    const app = makeApp(pool, {
      casdoor: neverCasdoor,
      boundExternalIds: bound.dep,
      guestScopes: async () => ['guestmod:guest'],
    })
    // 中间态形状（Task 4）：无 acct/ext 的纯访客会话
    const stale = await signSession(
      { sub: OPENID, org: 'acme', name: OPENID, scopes: ['stale:guest'], authVia: 'wechat-oa' },
      SECRET,
      nowSec() - SCOPES_TTL_SEC - 60,
    )
    const res = await probe(app, stale)
    expect(res.status).toBe(200)
    expect(setCookies(res).join('\n')).toContain('platform_session=') // 既有访客路照常重签（零改动）
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.scopes).toEqual(['guestmod:guest']) // guestScopes 重算
    expect(p?.acct).toBeUndefined() // 中间态载荷不带 acct
    expect(bound.calls).toEqual([]) // 不触绑定集合
    const body = (await res.json()) as {
      accountName?: string
      boundExternalIds?: string[]
      userId: string
    }
    expect(body.userId).toBe(OPENID)
    expect(body.accountName).toBeUndefined() // Identity 形状：中间态不带账户字段
    expect(body.boundExternalIds).toBeUndefined()
  })
})
