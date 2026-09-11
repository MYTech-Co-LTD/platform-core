// casdoor-client.ts — 全系统唯一访问 Casdoor HTTP API 的实现（A-Full：认证+授权唯一源）
//
// 请求形状对齐 工单系统 gateway 生产验证版（只读参考，计划全局约束：形状以旧仓为准）：
//   - verifyPassword ← sso-shell.js verifyCredentials（:129-133）：POST /api/login，
//     凭据【只走 JSON body】（query 通道会把密码泄进服务端/代理 access log，绝不采用）；
//     失败 = HTTP 200 + {"status":"error"}（真实 Casdoor 行为，不是 401/403）；
//     成功 = {"status":"ok", data:"<org>/<name>"}。
//   - getUser/getPermissions/upsertPermission ← admin-api.js（casdoorGet/casdoorPost）：
//     单数 get-user 只认 id=<org>/<name>（owner=/name= 形参会被真实 Casdoor 报
//     wrong token count）；get-permissions 认 owner=；update-permission 是【POST】
//     + ?id= query 形参（旧仓零 PUT）；载荷在 JSON body。
//   - admin 会话 ← admin-auth.js：POST /api/login 只发 casdoor_session_id cookie；
//     红线：登录失败也 200 且照发（匿名）cookie —— 必须 status==ok 才缓存。
export interface CasdoorClientOptions {
  origin: string
  /** 预留：password/code grant 换平台 JWT 时使用（当前四方法走会话式 /api/login） */
  clientId: string
  clientSecret: string
  org: string
  /** /api/login 的 application 形参：org 用户密码验证必须用其 signupApplication，
   *  否则真实 Casdoor 报 Unauthorized operation（fork 陷阱）——留配置口防真实接入即败 */
  application?: string
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
   *  既有记录的 users/roles/resources 原样保留（装载器重跑不洗配额）。
   *  单码版；批量场景用 upsertPermissions（每 org 只拉一次 get-permissions） */
  async upsertPermission(code: string, name: string): Promise<void> {
    await this.upsertPermissions([{ code, name }])
  }

  /**
   * 批量幂等 upsert 权限码：**每个 org 只拉一次** get-permissions 再逐码判定。
   *
   * 为什么需要它：upsertPermission 每调一次都全量拉一遍 `get-permissions?pageSize=100`。
   * 装载器的供给是「租户数 × 码数」双层循环，单码版下每租户每码都是一次 GET（+ 可能的
   * POST）——1 个租户 10 个模块就是几十次串行往返，且租户扩张是乘法增长。
   */
  async upsertPermissions(items: ReadonlyArray<{ code: string; name: string }>): Promise<void> {
    if (items.length === 0) return
    const existingList = await this.#permissionsRaw()
    for (const { code, name } of items) {
      const existing = existingList.find(
        (p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code),
      )
      await this.#upsertOne(code, name, existing)
      // add 成功后把该码并入本地视图：同一批里重复出现同一 code 时不至于重复 add
      if (!existing) existingList.push({ owner: this.#o.org, name: code, resources: [code] })
    }
  }

  /** 单码 upsert 的实际动作（查重结果由调用方传入，便于批量复用同一次 get-permissions） */
  async #upsertOne(
    code: string,
    name: string,
    existing: Record<string, unknown> | undefined,
  ): Promise<void> {
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
    // add/update 都是 POST（admin-api.js casdoorPost 形状；真实 Casdoor update-* 无 PUT 端点）
    const j = await this.#adminJson(path, { method: 'POST', body })
    if (j.status && j.status !== 'ok') {
      // 并发启动竞态：滚动发布/多副本下两实例可能同时判"码不存在"并双双 add，输的那个
      // 拿到 duplicate —— 码此刻确实存在（对方刚建），故视为成功。否则会凭空多一轮
      // 崩溃重启（本 PR 把 upsert 次数从「码数」扩到「租户数×码数」，竞态窗口同步放大）
      if (!existing && /duplicate/i.test(String(j.msg ?? ''))) return
      throw new Error(`casdoor: ${j.msg || 'error'}`)
    }
  }

  // ---- 内部：登录 / admin 会话 / 请求封装 ----

  async #login(username: string, password: string): Promise<LoginResult> {
    // 凭据只走 JSON body（sso-shell.js:129-133 生产形状）——query 通道会把密码泄进
    // 服务端/代理 access log；application 默认 app-built-in，可按 fork 的 signupApplication 配置
    const body = {
      type: 'login', username, password,
      application: this.#o.application ?? 'app-built-in',
    }
    const r = await this.#fetch(`${this.#o.origin}/api/login`, {
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
