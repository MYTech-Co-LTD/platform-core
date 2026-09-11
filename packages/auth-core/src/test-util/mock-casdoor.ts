// mock-casdoor.ts — 测试/冒烟共用的 Casdoor mock（真实 HTTP，@hono/node-server）
//
// 移植自 工单系统 gateway 的生产请求形状（sso-shell.js verifyCredentials / admin-api.js
// get-user/get-permissions / admin-auth.js 会话缓存），钉死 C2 语义。
//
// mock 三纪律（源自共享 Casdoor 生产实测陷阱，改动前先读）：
//   ① API 响应不回真 secret —— 用户记录里的 password 只留 mock 内部比对，
//     任何 JSON 响应（login / get-user / get-permissions）都不含 password 字段。
//   ② 选择器形参走 query 风格 —— buy-product 类端点同款陷阱：
//     get-user 只认 id=<org>/<name> 全形（owner=/name= 或无斜杠会被真实 Casdoor 报
//     wrong token count），**且 org 段是命中条件的一部分**——真机实测 `id=shanhai/admin`
//     ⇒ ok+null，尽管 `built-in/admin` 确实存在（用户按 owner 归属；评审 S3）。
//     get-permissions 认 owner=、update-permission 认 id=。
//     **权限按 owner 分桶**：get-permissions 只回该 org 的、add 按 body.owner 归桶、
//     update 按 (owner,name) 定位。曾经的 "mock 单 org、忽略 owner=" 是 M0 门禁对
//     multi 权限供给结构性失明的原因（issue #3 第二节成因①），不得回退。
//     注意：query 形参陷阱【不适用于 /api/login】——登录凭据走 JSON body
//     （sso-shell.js:129-133 生产形状）；query 通道会把密码泄进服务端/代理
//     access log，绝不采用（query 兼容读仅为防旧脚本，新代码不得依赖）。
//     业务载荷（add/update 的正文）同样在 JSON body —— 与真实 Casdoor 一致。
//   ③ 密码验证失败返回 HTTP 200 + {"status":"error"} —— 真实 Casdoor 行为，
//     绝不能改成 401/403；且失败时照样发（匿名）session cookie，缓存端必须
//     校验 body status==ok 才认 cookie（admin-auth.js 生产教训：坏 cookie 缓存 6h）。
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'

export interface MockCasdoorUser {
  name: string
  password: string
  /**
   * 用户归属的 org。**真机语义的一部分**：`get-user?id=<org>/<name>` 只命中属于该 org 的
   * 用户——真机实测 `get-user?id=shanhai/admin` ⇒ `ok+null`，尽管 `built-in/admin` 确实存在
   * ⇒ org 段是命中条件的一部分（评审 S3）。缺省 = MOCK_ORG（旧用例的单 org 世界）。
   */
  owner?: string
  roles?: string[]
  isAdmin?: boolean
  displayName?: string
  email?: string
}

export interface MockCasdoorPerm {
  /** Casdoor 权限必有 name；种子未给时以首个 resource 兜底（装载器场景 code 即 name） */
  name?: string
  /** 权限归属 org（Casdoor 权限记录按 owner 分桶）。缺省 = MOCK_ORG，旧用例兼容 */
  owner?: string
  users?: string[]
  roles?: string[]
  resources?: string[]
  actions?: string[]
  isEnabled?: boolean
}

export interface MockCasdoorOptions {
  users?: MockCasdoorUser[]
  perms?: MockCasdoorPerm[]
}

const MOCK_ORG = 'mock-org'

interface StoredUser extends MockCasdoorUser {
  roles: string[]
  isAdmin: boolean
  /** 已解析的归属 org（缺省已填成 MOCK_ORG / built-in），get-user 的命中条件之一 */
  owner: string
}

export class MockCasdoor {
  #users: StoredUser[]
  #perms: Array<Record<string, unknown>> = []
  #sessions = new Map<string, { user: string; anonymous: boolean }>()
  #oidcCodes = new Map<string, string>() // authorization code → 用户名（单次即焚）
  #addPermissionCalls: Array<{ owner: string; name: string }> = []
  #tokenFault: 'off' | 'http502' | 'html200' = 'off'
  #getUserFault: 'off' | 'error' | 'errorOnce' = 'off'
  #httpAuthFault: 'off' | 'unauthorized401' | 'unauthorized401Once' = 'off'
  #adminLoginCount = 0
  #server: ReturnType<typeof serve> | null = null
  #port = 0
  #lastLoginApplication = ''

  constructor(opts: MockCasdoorOptions = {}) {
    // 内置 admin：真实 Casdoor 永远有 built-in admin（/api/login 管理会话用它登录）。
    // 默认口令 pw 与测试种子一致；种子里给了名为 admin 的用户则尊重种子。
    const seeded = opts.users ?? []
    // 内置 admin 归属 **built-in** org（真机实测：`get-user?id=built-in/admin` 是存在的那个，
    // `shanhai/admin` 回 ok+null）——不标 owner 会让它落进 MOCK_ORG，与真机形状不符
    const builtInAdmin: MockCasdoorUser[] = !seeded.some((u) => u.name === 'admin')
      ? [{ name: 'admin', password: 'pw', roles: [], owner: 'built-in' }]
      : []
    this.#users = [...builtInAdmin, ...seeded].map((u) => ({
      ...u,
      owner: u.owner ?? MOCK_ORG,
      roles: u.roles ?? [],
      isAdmin: u.isAdmin ?? u.name === 'admin',
    }))
    for (const [i, p] of (opts.perms ?? []).entries()) {
      const name = p.name ?? p.resources?.[0] ?? `perm-${i + 1}`
      this.#perms.push({
        owner: p.owner ?? MOCK_ORG,
        name,
        displayName: name,
        users: p.users ?? [],
        roles: p.roles ?? [],
        resources: p.resources ?? [],
        actions: p.actions ?? ['Read'],
        isEnabled: p.isEnabled ?? true,
        model: 'built-in/user-model-built-in',
      })
    }
    // 形状钉死：真实 Casdoor 的 update-* 是 POST（admin-api.js casdoorPost 形状）；
    // PUT 在本 mock 一律 405，防「客户端偷偷走 PUT」的形状分叉被遮蔽
    this.#app.put('/api/update-permission', (c: Context) =>
      c.json({ status: 'error', msg: 'method not allowed: update-permission 走 POST' }, 405))
    this.#app.post('/api/update-permission', this.#updatePermission)
  }

  get port(): number { return this.#port }
  get origin(): string { return `http://127.0.0.1:${this.#port}` }

  /** get-user 故障注入：'error' 持续、'errorOnce' 只一次（用于验证 admin 会话自愈） */
  setGetUserFault(mode: 'off' | 'error' | 'errorOnce'): void {
    this.#getUserFault = mode
  }

  /**
   * 令管理端点回 **HTTP 401**。⚠️ 这是**真机不产生的形状**（真机一律 200 + status:error），
   * 只能显式注入——用来单独钉死客户端 `#adminRequest` 的「401 ⇒ 重取会话一次」防御分支。
   * **绝不要**把它设成默认的会话失效形状：那正是"替身锁住旧形状"（评审 must-fix 2）。
   * 'unauthorized401Once' 只生效一次（等价于"被反代插了一层 401，会话本身仍在"）。
   */
  setHttpFault(mode: 'off' | 'unauthorized401' | 'unauthorized401Once'): void {
    this.#httpAuthFault = mode
  }

  /** admin 登录次数——"自愈确实重登了一次"的唯一机检证据 */
  get adminLoginCalls(): number {
    return this.#adminLoginCount
  }

  /** 最近一次 /api/login 收到的 application 形参（测试观测口；不含密码，纪律①） */
  get lastLoginApplication(): string { return this.#lastLoginApplication }

  /** 某 org 的权限记录（断言用；等价 get-permissions?owner=，但不经 HTTP） */
  permissionsIn(org: string): Array<Record<string, unknown>> {
    return this.#perms.filter((p) => p.owner === org).map((p) => ({ ...p }))
  }

  /**
   * add-permission 调用记录——「装载器真的建过码」的唯一机检证据。
   * issue #3 第二节成因②：旧冒烟预种权限码 ⇒ 装载器查重必命中 ⇒ 走 update 分支 ⇒ 此处恒空。
   */
  get addPermissionCalls(): ReadonlyArray<{ owner: string; name: string }> {
    return this.#addPermissionCalls
  }

  /**
   * 预种一枚 Casdoor authorization code（等价 authorize 页完成认证后的下发）。
   * 单次即焚：/api/login/oauth/access_token 兑换一次后作废（真实 OAuth code 语义）。
   */
  issueOidcCode(userName: string): string {
    const code = randomBytes(16).toString('hex')
    this.#oidcCodes.set(code, userName)
    return code
  }

  /**
   * 令 token 端点进入故障模式（钉死客户端传输层/解析失败分类，评审 I2）：
   * 'http502' = 502 + HTML（反代/网关错误页）；'html200' = 200 + HTML（伪装 2xx 的非 JSON）；
   * 'off' = 恢复正常。
   */
  setTokenEndpointFault(mode: 'off' | 'http502' | 'html200'): void {
    this.#tokenFault = mode
  }

  async start(): Promise<void> {
    if (this.#server) return
    this.#server = serve({ fetch: this.#app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve) => {
      if (this.#server!.listening) return resolve()
      this.#server!.once('listening', () => resolve())
    })
    this.#port = (this.#server.address() as { port: number }).port
  }

  async stop(): Promise<void> {
    const s = this.#server
    if (!s) return
    this.#server = null
    this.#port = 0
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      // ServerType 联合类型未暴露 node:http Server 的 closeAllConnections，运行时存在（Node ≥18.2）
      ;(s as unknown as import('node:http').Server).closeAllConnections?.()
    })
  }

  /** 吊销全部服务端会话（冒烟/测试用来钉「会话失效 → 自愈重登」语义；真机形状是 200+status:error） */
  expireSessions(): void {
    this.#sessions.clear()
  }

  /** 有效且非匿名的 admin 会话（管理端点门禁；无效 → #unauthorized） */
  #isAdminSession(c: Context): boolean {
    const m = /casdoor_session_id=([^;]+)/.exec(c.req.header('cookie') ?? '')
    const s = m ? this.#sessions.get(m[1]!) : undefined
    if (!s || s.anonymous) return false
    const u = this.#users.find((x) => x.name === s.user)
    return !!u && u.isAdmin
  }

  #unauthorized(c: Context) {
    // 真机形状（sso.hookflow.cn / 本机 curl 实测，无凭据）：会话失效 ⇒ **HTTP 200** +
    // {status:'error', msg:'Unauthorized operation'}，**一条 401 都没有**。
    // 旧 mock 在这里回 401，与真机不符 ⇒ 客户端 `#adminRequest` 的 401 重试在门禁里看着是活的、
    // 在真机上却是死码，而"替身锁住旧形状"让同类回归持续不可见（评审 must-fix 2）。
    // 需要机检 401 防御契约时用 setHttpFault('unauthorized401') **显式注入**——那才是它该有的位置。
    if (this.#httpAuthFault !== 'off') {
      if (this.#httpAuthFault === 'unauthorized401Once') this.#httpAuthFault = 'off'
      return c.json({ status: 'error', msg: 'Unauthorized operation' }, 401)
    }
    return c.json({ status: 'error', msg: 'Unauthorized operation' })
  }

  #updatePermission = async (c: Context) => {
    if (!this.#isAdminSession(c)) return this.#unauthorized(c)
    // 纪律 ②：id=<org>/<name> 全形 query 形参。owner 参与定位——跨 org 同名权限互不干扰
    // （旧实现只按 name 找：两个 org 各有一枚 demo:view 时会改错那一枚，而 get-permissions
    //   已按 org 分桶 ⇒ 表现为"改了 A 租户的码、B 租户的授权凭空消失"这种极难归因的症状）
    const segs = (c.req.query('id') ?? '').split('/')
    if (segs.length !== 2 || !segs[0] || !segs[1]) {
      return c.json({ status: 'error', msg: 'wrong token count, expect <org>/<name>' })
    }
    const p = this.#perms.find((x) => x.owner === segs[0] && x.name === segs[1])
    if (!p) return c.json({ status: 'error', msg: 'permission not found' })
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    Object.assign(p, {
      displayName: (b.displayName as string) ?? p.displayName,
      model: (b.model as string) ?? p.model,
      users: (b.users as string[]) ?? p.users,
      roles: (b.roles as string[]) ?? p.roles,
      resources: (b.resources as string[]) ?? p.resources,
      actions: (b.actions as string[]) ?? p.actions,
      isEnabled: (b.isEnabled as boolean) ?? p.isEnabled,
    })
    return c.json({ status: 'ok' })
  }

  #app = new Hono()
    // POST /api/login —— 纪律②修订+③：凭据走 JSON body（query 兼容读仅防旧脚本）；
    // 失败 200+{"status":"error"} 且照发匿名 cookie
    .post('/api/login', async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const username = typeof b.username === 'string' && b.username ? b.username : (c.req.query('username') ?? '')
      const password = typeof b.password === 'string' && b.password ? b.password : (c.req.query('password') ?? '')
      this.#lastLoginApplication = String(b.application ?? c.req.query('application') ?? '')
      const user = this.#users.find((u) => u.name === username && u.password === password)
      const sid = randomBytes(16).toString('hex')
      this.#sessions.set(sid, { user: user?.name ?? '', anonymous: !user })
      // 纪律 ③：登录失败也发 session cookie（匿名会话）——缓存端必须校验 body 才认
      c.header('Set-Cookie', `casdoor_session_id=${sid}; Path=/; HttpOnly`)
      if (!user) return c.json({ status: 'error', msg: '用户名或密码错误' })
      // 校验成功之后才计数（只数"真登上了"的）；admin 判定复用本文件的既有口径
      // （构造器把 built-in admin 标成 isAdmin），不另造一套
      if (user.isAdmin) this.#adminLoginCount++
      // data = <owner>/<name>（真机形状：org 段是**用户自己的归属 org**，不是请求方租户）
      return c.json({ status: 'ok', data: `${user.owner}/${user.name}` })
    })
    // POST /api/login/oauth/access_token —— 旧仓 sso-shell.js authorizationCodeToken 生产形状：
    // x-www-form-urlencoded，grant_type/client_id/client_secret/code/redirect_uri 全在 body；
    // code 必须是 issueOidcCode 预种的且单次即焚，拒绝按 RFC 6749 回 400 + error 载荷。
    .post('/api/login/oauth/access_token', async (c) => {
      if (this.#tokenFault === 'http502') {
        return c.body('<html><body>502 Bad Gateway</body></html>', 502, {
          'content-type': 'text/html',
        })
      }
      if (this.#tokenFault === 'html200') {
        return c.body('<html><body>ok?</body></html>', 200, { 'content-type': 'text/html' })
      }
      const form = new URLSearchParams(await c.req.text())
      if (form.get('grant_type') !== 'authorization_code') {
        return c.json({ error: 'unsupported_grant_type' }, 400)
      }
      const code = form.get('code') ?? ''
      const name = this.#oidcCodes.get(code)
      if (!name) return c.json({ error: 'invalid_grant', error_description: 'code 不存在或已兑换' }, 400)
      this.#oidcCodes.delete(code)
      // 未签名 JWT（末段占位）：消费方只 base64url 解 payload 不本地验签——token 的信任
      // 来自端点本身（生产由 Casdoor 签名 + TLS，mock 无需真签）；claims 形状对齐旧仓
      // gateway decodePayload 消费：owner=org、name=用户名（sub 兜位）。
      const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
      const claims = { owner: MOCK_ORG, name, sub: name }
      const accessToken = [
        b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
        b64url(JSON.stringify(claims)),
        'mock-signature',
      ].join('.')
      return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 })
    })
    // GET /api/get-user?id=<org>/<name> —— 纪律 ②：单数端点只认 id= 全形，严格两段
    .get('/api/get-user', (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      if (this.#getUserFault === 'error' || this.#getUserFault === 'errorOnce') {
        if (this.#getUserFault === 'errorOnce') this.#getUserFault = 'off'
        return c.json({ status: 'error', msg: 'Please login first' })
      }
      const parts = (c.req.query('id') ?? '').split('/')
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        // 真实 Casdoor GetOwnerAndNameFromId 同款拒绝：非 <org>/<name> 全形不合法
        return c.json({ status: 'error', msg: 'wrong token count, expect <org>/<name>' })
      }
      // **按 (owner, name) 命中**：org 段是真机命中条件的一部分（实测 `id=shanhai/admin`
      // ⇒ ok+null，尽管 built-in/admin 存在）。旧实现只按 name 命中 ⇒ "跨 org 同名用户被
      // 误命中"这类缺陷在门禁里结构性看不见（评审 S3）。
      const user = this.#users.find((u) => u.owner === parts[0] && u.name === parts[1])
      // 真机（sso.hookflow.cn 实测）：用户不存在（含**不属于该 org**）⇒ HTTP 200 +
      // {status:'ok', data:null}，**不是** status:error。旧 mock 回 error 与真机不符，正是
      // "error 被折叠成 null"这个缺陷在测试里结构性看不见的原因（M1 闭债 R3）。
      // 改动前先读本文件头注的 mock 三纪律。
      if (!user) return c.json({ status: 'ok', data: null })
      // 纪律 ①：绝不回 password
      return c.json({
        status: 'ok',
        data: {
          owner: user.owner,
          name: user.name,
          displayName: user.displayName ?? user.name,
          email: user.email ?? '',
          roles: [...user.roles],
          isAdmin: user.isAdmin,
        },
      })
    })
    // GET /api/get-permissions?owner=<org> —— 纪律 ②：owner= query 形参，**按 org 分桶**。
    // owner 缺失一律 status:error：绝不"忽略形参回全部"——那正是 M0 门禁对 multi 权限
    // 结构性失明的根因（issue #3 第二节成因①），回退成那个形状必须立刻可见
    .get('/api/get-permissions', (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      const owner = c.req.query('owner') ?? ''
      if (!owner) return c.json({ status: 'error', msg: 'owner required' })
      return c.json({ status: 'ok', data: this.permissionsIn(owner) })
    })
    // POST /api/add-permission —— 载荷在 JSON body；owner 必填并据此归桶；
    // (owner,name) 重复拒绝（钉死 upsert 必须先查重）
    .post('/api/add-permission', async (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const owner = String(b.owner ?? '')
      const name = String(b.name ?? '')
      if (!owner) return c.json({ status: 'error', msg: 'owner required' })
      if (!name) return c.json({ status: 'error', msg: 'name required' })
      if (this.#perms.some((p) => p.owner === owner && p.name === name)) {
        return c.json({ status: 'error', msg: 'duplicate permission name' })
      }
      this.#addPermissionCalls.push({ owner, name })
      this.#perms.push({
        owner,
        name,
        displayName: String(b.displayName ?? name),
        model: String(b.model ?? 'built-in/user-model-built-in'),
        users: (b.users as string[]) ?? [],
        roles: (b.roles as string[]) ?? [],
        resources: (b.resources as string[]) ?? [],
        actions: (b.actions as string[]) ?? ['Read'],
        isEnabled: (b.isEnabled as boolean) ?? true,
      })
      return c.json({ status: 'ok', data: name })
    })
}
