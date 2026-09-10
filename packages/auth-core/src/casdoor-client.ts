// casdoor-client.ts — 全系统唯一访问 Casdoor HTTP API 的实现（A-Full：认证+授权唯一源）
//
// 请求形状移植自 工单系统 gateway 生产验证版（只读参考）：
//   - verifyPassword ← sso-shell.js verifyCredentials：POST /api/login，
//     失败 = HTTP 200 + {"status":"error"}（真实 Casdoor 行为，不是 401/403）；
//     成功 = {"status":"ok", data:"<org>/<name>"}。
//   - getUser/getPermissions/upsertPermission ← admin-api.js：
//     单数 get-user 只认 id=<org>/<name>（owner=/name= 形参会被真实 Casdoor 报
//     wrong token count）；get-permissions 认 owner=；update 认 id=；载荷在 JSON body。
//   - admin 会话 ← admin-auth.js：POST /api/login 只发 casdoor_session_id cookie；
//     红线：登录失败也 200 且照发（匿名）cookie —— 必须 status==ok 才缓存。
//
// 形参纪律（C2）：身份/凭据形参全 query 风格；/api/login 同时带生产验证过的 JSON body
// 形状（真实 Casdoor JSON 解析路径），query 与 body 双通道字段一致，mock 与真实两端都能吃。
export interface CasdoorClientOptions {
  origin: string
  /** 预留：password/code grant 换平台 JWT 时使用（当前四方法走会话式 /api/login） */
  clientId: string
  clientSecret: string
  org: string
  adminUser?: string
  adminPwd?: string
  fetchImpl?: typeof globalThis.fetch
}

export interface CasdoorUser {
  name: string
  roles?: string[]
  displayName?: string
  isAdmin?: boolean
}

export interface CasdoorPermission {
  users?: string[]
  roles?: string[]
  resources?: string[]
}

interface LoginResult {
  r: Response
  j: Record<string, unknown>
}

export class CasdoorClient {
  readonly #o: CasdoorClientOptions
  readonly #fetch: typeof globalThis.fetch
  #adminCookie: string | null = null

  constructor(o: CasdoorClientOptions) {
    this.#o = o
    this.#fetch = o.fetchImpl ?? globalThis.fetch
  }

  /** 验用户名/密码：成功返回 {name}，密码不对返回 null（200+error 是预期分支，不抛错） */
  async verifyPassword(username: string, password: string): Promise<{ name: string } | null> {
    const { r, j } = await this.#login(username, password)
    if (!r.ok) throw new Error(`casdoor login failed: ${r.status}`) // 传输层故障 → 抛，不吞
    if (j.status !== 'ok') return null
    const data = String(j.data ?? '')
    const name = (data.includes('/') ? data.split('/').pop() : data) || username
    return { name }
  }

  /** 查单个用户（admin 会话）；查无此人/端点报错 → null（门禁层 fail-closed 转 403 用） */
  async getUser(name: string): Promise<CasdoorUser | null> {
    const path = `get-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`
    const j = await this.#adminJson(path)
    const u = j.status === 'ok' ? (j.data as Record<string, unknown> | undefined) : undefined
    if (!u || typeof u !== 'object' || !u.name) return null
    const roles = (Array.isArray(u.roles) ? u.roles : [])
      .map((x) => (typeof x === 'string' ? x : String((x as Record<string, unknown>)?.name ?? '')))
      .filter(Boolean)
    return {
      name: String(u.name),
      roles,
      displayName: typeof u.displayName === 'string' ? u.displayName : undefined,
      isAdmin: u.isAdmin === true,
    }
  }

  /** 列权限（admin 会话）——normalizeScopes 的 permissions 输入源 */
  async getPermissions(): Promise<CasdoorPermission[]> {
    return (await this.#permissionsRaw()).map((p) => ({
      users: (p.users as string[] | undefined) ?? [],
      roles: (p.roles as string[] | undefined) ?? [],
      resources: (p.resources as string[] | undefined) ?? [],
    }))
  }

  /** 幂等 upsert 权限码：查重（resources 含 code）→ 命中则 update，否则 add；
   *  既有记录的 users/roles/resources 原样保留（装载器重跑不洗配额） */
  async upsertPermission(code: string, name: string): Promise<void> {
    const existing = (await this.#permissionsRaw()).find(
      (p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code),
    )
    const body = {
      owner: this.#o.org,
      name: (existing?.name as string | undefined) ?? code,
      displayName: name,
      model: (existing?.model as string | undefined) ?? 'built-in/user-model-built-in',
      users: (existing?.users as string[] | undefined) ?? [],
      roles: (existing?.roles as string[] | undefined) ?? [],
      resources: existing ? ((existing.resources as string[] | undefined) ?? []) : [code],
      actions: (existing?.actions as string[] | undefined) ?? ['Read'],
      isEnabled: true,
    }
    const path = existing
      ? `update-permission?id=${encodeURIComponent(`${this.#o.org}/${String(existing.name)}`)}`
      : 'add-permission'
    const j = await this.#adminJson(path, { method: existing ? 'PUT' : 'POST', body })
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
  }

  // ---- 内部：登录 / admin 会话 / 请求封装 ----

  async #login(username: string, password: string): Promise<LoginResult> {
    // 全 query 形参（mock 纪律②/真实 Casdoor buy-product 同款风格）+ 生产验证过的 JSON body
    const qs = new URLSearchParams({
      type: 'login', username, password, application: 'app-built-in',
    })
    const body = { type: 'login', username, password, application: 'app-built-in' }
    const r = await this.#fetch(`${this.#o.origin}/api/login?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    return { r, j }
  }

  /** admin 会话 cookie（内存缓存）；force=true 强制重登。失败抛错，绝不缓存匿名 cookie */
  async #sessionCookie(force = false): Promise<string> {
    if (!force && this.#adminCookie) return this.#adminCookie
    if (!this.#o.adminUser || !this.#o.adminPwd) {
      throw new Error('CasdoorClient: adminUser/adminPwd not configured')
    }
    const { r, j } = await this.#login(this.#o.adminUser, this.#o.adminPwd)
    // 红线（admin-auth.js 生产教训）：登录失败也 200 且照样发匿名 session cookie，
    // 必须校验 body status==ok 才缓存，否则坏 cookie 驻留内存，管理面全线假死
    const m = /casdoor_session_id=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')
    if (!r.ok || !m || j.status !== 'ok') {
      throw new Error(`casdoor admin login failed: ${j.msg || 'no session cookie'}`)
    }
    this.#adminCookie = `casdoor_session_id=${m[1]}`
    return this.#adminCookie
  }

  /** admin GET/POST/PUT：401 → 重登一次重试（仅一次，坏凭据不会循环） */
  async #adminRequest(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    const doFetch = (cookie: string): Promise<Response> => {
      const req: RequestInit = {
        method: init?.method ?? 'GET',
        headers: {
          Cookie: cookie,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      }
      return this.#fetch(`${this.#o.origin}/api/${path}`, req)
    }
    let r = await doFetch(await this.#sessionCookie())
    if (r.status === 401) {
      r = await doFetch(await this.#sessionCookie(true))
    }
    return r
  }

  /** admin 请求 + 语义解包：非 2xx 一律抛（不吞异常）；status error 由调用方按语义处理 */
  async #adminJson(path: string, init?: { method?: string; body?: unknown }): Promise<Record<string, unknown>> {
    const r = await this.#adminRequest(path, init)
    if (!r.ok) throw new Error(`casdoor request failed: ${r.status} ${path}`)
    return (await r.json().catch(() => ({}))) as Record<string, unknown>
  }

  async #permissionsRaw(): Promise<Array<Record<string, unknown>>> {
    const path = `get-permissions?owner=${encodeURIComponent(this.#o.org)}&pageSize=100`
    const j = await this.#adminJson(path)
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    return Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : []
  }
}
