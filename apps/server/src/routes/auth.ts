// routes/auth.ts — 账密登录/登出/会话（登录链路五路归一的账密路；企微路在 Task 14）
//
// 所有登录路径产出同一 platform_session cookie，模块永远只见 ctx.identity（Task 9）。
// 路由挂在租户中间件（c.get('tenant')）与会话中间件（c.get('session')）之后：
//  - POST /login  body {username,password}（登录本身免 CSRF：尚未有会话，SameSite=Lax + POST 已足）
//  - POST /logout 要求 header x-csrf-token 与 csrfToken(session) 一致（防跨站强制登出）
//  - GET  /session 会话自画像（前端 csrf token 的取用口）
//
// sub 语义：CasdoorClient.getUser 不回 UUID，sub 用 org 内唯一的 name——与旧 gateway
// relay JWT（sub=String(userId)，userId 即用户名）同语义，UUID 化待客户端扩展时统一切换。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken, effectiveScopes, signSession } from '@platform/auth-core'
import type { TenantEnv } from '../tenant'
import {
  clearSessionCookie,
  serializeSessionCookie,
  type CasdoorFactory,
  type SessionEnv,
} from '../session-middleware'
import { tooManyRequests, type LoginLimiter } from '../rate-limit'

export interface AuthRoutesDeps {
  /** org 随租户变：multi 模式下各租户各自的 Casdoor org（c.get('tenant').casdoor_org） */
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /**
   * 登录限速器（M1 闭债 R2）。**必须与企微路共用同一实例**（宿主 app.ts 建一个传两处）——分
   * 实例与分桶一样会把额度按份数放大，却额外把第 1 层的 user 桶也放大，没有任何好处。
   *
   * 本路由是 `password` 门（PR#5 评审 R2）：第 2/3 层的桶按 (tenantId, door) 分，**不是**
   * 按实例分——"共用实例"与"分开的桶"这两件事同时成立，别实现成两个实例。
   *
   * 预算口径（PR#5 终轮评审 S1）：拆桶**不是**"不劈预算"——第 2/3 层的额度是每 (租户, 门)
   * 一份，故聚合预算 ×门数（失败层 300→600、全部尝试层 1000→2000），换来爆炸半径 ÷门数。
   * 口径的单一事实源在 rate-limit.ts 的 `Door` 注释。
   */
  limiter: LoginLimiter
}

/**
 * 入参长度上限：超长一律按坏凭据 401 且【不调 Casdoor、audit 不落原样长串】——
 * 防用巨型凭据刷 Casdoor 带宽 / 灌 audit 表（audit 刷量面）。Casdoor 侧用户名/密码
 * 上限远低于此，真实用户不可能触达。
 *
 * MAX_USERNAME_LEN 与 rate-limit.ts 的 MAX_KEY_LEN 是"用户名长度上限"这一个事实的两侧投影
 * （auth 侧管 audit 写入有界，限速侧管内存桶键有界）——必须相等。该约束由 rate-limit.test.ts
 * 的守卫断言强制（两侧各写死会静默漂移，故导出供断言引用）。
 */
export const MAX_USERNAME_LEN = 256
const MAX_PASSWORD_LEN = 512

/**
 * 登录请求体字节上限（Task 24 评审 R1 建议 4）。**未认证请求不得靠单请求撑爆内存**：
 * 上限内最坏情况 = 256 用户名 + 512 密码（UTF-8 每字符最多 4 字节）再加上 JSON 语法，
 * 8 KiB 对真实登录体是数量级的富余。
 *
 * 为什么不能只查 `Content-Length`：它可缺失（chunked）也可伪造（声明小、实发大），
 * 只信它等于没上限。故实现成**有界读取**（readBodyBounded）：边读边计，越界即中止读取流。
 * 上界是「上限 + 至多一个传输块」——流式读取的粒度是 chunk，**不是**逐字节：越界那一刻已经
 * 落在内存里的那一块无法退回。**这里不给具体数字**（PR#5 终轮评审 S2）：上界随传输块**线性
 * 放大**——可控块长的探针实测 1 MiB 块 ⇒ 内存 ≈1 MiB；此前括号里写的"8 KiB 上限下 `pull=9`、
 * 读了 9216 B"是 1 KiB 块长这一**最有利**情形，不能当典型值。真实 HTTP 下 undici 按块交付，
 * 量级约 8 KiB + 一个 ~64 KiB 传输块。截断本身是真的（伪造 `content-length` 也不影响：只信
 * 实际读到的字节数），"超出部分一个字节都不进内存"这种说法**过强**，已按实收窄（PR#5 评审 R2）。
 * Content-Length 只作为"连读都不读"的快速拒绝前置。
 */
export const MAX_LOGIN_BODY_BYTES = 8192

/** 有界读体 + JSON 解析：越界返 'too-large'（已中止读取），体不是合法 JSON 返 'invalid' */
async function readBodyBounded(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: 'too-large' | 'invalid' }> {
  // 前置：声明即超限的直接拒，不碰请求流（诚实客户端的快路径）
  const declared = req.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, reason: 'too-large' }
  const stream = req.body
  if (!stream) return { ok: false, reason: 'invalid' }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel() // 中止读取：**后续**字节不再进内存（本块已在内存里，上界见函数注释）
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  try {
    return { ok: true, body: JSON.parse(buf.toString('utf8')) as unknown }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** 登录审计一行（platform.audit；失败也 await——审计写不进去就不该继续发会话） */
async function writeAudit(
  pool: Pool,
  tenantId: number,
  actor: string,
  action: 'login.ok' | 'login.fail',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

export function authRoutes(deps: AuthRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()

  app.post('/login', async (c) => {
    const t = c.get('tenant')
    // 租户层前置（Task 24 评审 R1 建议 4）：只吃租户两道闸（此层拿不到用户名——体还没读），
    // 换来"已被限速的租户连请求体都不解析"。用户维度的判定仍在下面（解析出 username 之后）。
    const early = deps.limiter.check(t.id, 'password', null)
    if (!early.allowed) return tooManyRequests(c, t.id, early)

    const read = await readBodyBounded(c.req.raw, MAX_LOGIN_BODY_BYTES)
    if (!read.ok) {
      if (read.reason === 'too-large') {
        // 超限即拒：体没读进来，自然也写不了 audit（actor 无从写起）。计数照记——
        // 它是一次失败尝试，且是第 2/3 层该看见的流量
        deps.limiter.record(t.id, 'password', null, false)
        return c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413)
      }
      // 体不是合法 JSON：与"形状不对"同一处置（按坏凭据 401，不泄原因）
      deps.limiter.record(t.id, 'password', null, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
    const body = read.body as { username?: unknown; password?: unknown } | null
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    // 限速（M1 闭债 R2）：**先于任何 writeAudit**。被拦的请求不写 audit——写了等于没限速
    const decision = deps.limiter.check(t.id, 'password', username || null)
    if (!decision.allowed) return tooManyRequests(c, t.id, decision)
    // 形状不对也按坏凭据处理（401 不区分原因，不泄探查面）。
    // 计数（Task 24 评审 R1）：这条同样是"一次失败的登录尝试"，此前只 401 不 record ⇒
    // 它是个死角：不产生出站调用（危害比企微路低一档），但同样能把第 2/3 层推满的流量
    // 白送给攻击者。口径与其它失败分支一致：记计数、不写 audit（无 actor 可写）
    if (!username || !password) {
      deps.limiter.record(t.id, 'password', username || null, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
    if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
      // 超长：不调 Casdoor；audit 记 login.fail 但 actor 截断到 256（有界写入，超长串
      // 绝不原样入库）+ detail 标 reason:'oversized'——与真实坏凭据失败可区分可过滤
      await writeAudit(
        deps.pool,
        t.id,
        username.slice(0, MAX_USERNAME_LEN),
        'login.fail',
        { via: 'password', reason: 'oversized' },
      )
      deps.limiter.record(t.id, 'password', username, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }

    const casdoor = deps.casdoor(t.casdoor_org)
    let name: string | null
    try {
      name = (await casdoor.verifyPassword(username, password))?.name ?? null
    } catch {
      // 传输层故障（网络/5xx）≠ 坏凭据：502 如实暴露，不记 login.fail（非用户过错）
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
    }
    if (name === null) {
      await writeAudit(deps.pool, t.id, username, 'login.fail', { via: 'password' })
      deps.limiter.record(t.id, 'password', username, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }

    // 有效会话必须带可信 scopes：取不到就拒绝登录（fail loudly；已持有会话者的刷新降级
    // 在会话中间件做——可用性优先的边界划在那里，不在签发口）
    let scopes: string[]
    try {
      const [user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
      // 密码已验证通过却查无此人 = 上游不一致（M1 闭债 R3）：绝不发一个"没有角色派生
      // scopes"的会话——那表现为"登录成功但每个模块 API 都 403"，且无人知道为什么。
      // 与企微路同属"查无此人就不发会话"这一族，但**呈现不同**：那里 `null` 是真的无账户
      // ⇒ 走**导航呈现**（企微回调恒为浏览器导航，JSON 错误体是用户死胡同；见 auth-wecom.ts
      // 的 fail()）：iframe 内 200 + postMessage `sso-fail`，顶层 302 `/login?error=NO_ACCOUNT`
      // ——那条路**从不返回 401**（assert 见 auth-wecom.test.ts 的
      // `callback：NO_ACCOUNT → 302 /login?error=NO_ACCOUNT` 用例）。
      // 这里是密码已验过却查无此人 ⇒ 上游不一致 ⇒ 502 `CASDOOR_UNAVAILABLE`
      // （502 是对的呈现，别改成 401——那会把上游故障误报成"你没有账户"）。
      if (user === null) return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
      scopes = effectiveScopes(name, user.roles ?? [], perms)
    } catch {
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
    }

    const now = Math.floor(Date.now() / 1000)
    const token = await signSession(
      { sub: name, org: t.casdoor_org, name, scopes, authVia: 'password' },
      deps.sessionSecret,
      now,
    )
    // 审计先行（M-4）：插入抛错 → 500 且未发任何会话 cookie——审计与发证保持原子序，
    // 不留"登录已记账失败但浏览器已拿到新会话"的窗口
    await writeAudit(deps.pool, t.id, name, 'login.ok', { via: 'password' })
    // 成功清零用【提交串 username】，与 check(:69)/失败记账(:85,:99) 同键：name 是 Casdoor
    // 规范名，别名登录（邮箱/手机号）时 name !== username，用 name 清零会清错桶 ⇒ 提交串那个
    // 失败桶永不清零、正常用户被自己锁死 15 分钟。审计行仍记 name（真实身份），不受影响。
    deps.limiter.record(t.id, 'password', username, true)
    c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
    return c.json({ ok: true })
  })

  app.post('/logout', (c) => {
    const s = c.get('session')
    if (!s) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    if (c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
      // fail-closed：会话中间件可能在本次请求重签过（新 iat→新 csrf），持有旧 csrf 的客户端
      // 会 403——安全侧正确，客户端经 GET /session 重取 csrf 即恢复
      return c.json({ error: 'CSRF' }, 403)
    }
    // 与签发同属性 + Max-Age=0；若中间件本次已重签（Set-Cookie 在前），浏览器按序应用，
    // 清除 cookie 排最后生效
    c.res.headers.append('Set-Cookie', clearSessionCookie())
    return c.json({ ok: true })
  })

  app.get('/session', (c) => {
    const s = c.get('session')
    if (!s) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    return c.json({
      // 载荷无 displayName 槽位（auth-core 形状已冻结），M0 以 name 兜位
      user: { id: s.sub, name: s.name, displayName: s.name },
      org: s.org,
      scopes: s.scopes,
      csrfToken: csrfToken(s, deps.sessionSecret),
    })
  })

  return app
}
