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
  /**
   * 强制重登的最短间隔（ms）——**故障期登录压力的唯一闸门**，取值理由见 `#allowForcedRelogin`。
   * 默认 5000。闸的是**窗口**、不是"只重登一次"的闩——两条断言分工钉死：设 0 证"不是闩"
   * （每次失败各重登一次），设小正数 + 真的等过窗口证"窗口会随时间重开"
   * （casdoor-client.test.ts 的两条冷却用例；只留前者的话，按次数计的闩照样全绿，评审 S2）。
   */
  reloginCooldownMs?: number
}

/** 强制重登的默认最短间隔（ms）——取值理由见 `CasdoorClient#allowForcedRelogin` */
const DEFAULT_RELOGIN_COOLDOWN_MS = 5_000

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
  /** 上次**强制**重登的时刻（ms）；冷却窗口的基准，见 #allowForcedRelogin */
  #lastForcedReloginAt = 0

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

  /** 查单个用户（admin 会话）；**仅"真·不存在"返回 null**，端点/上游报错一律抛（见下） */
  async getUser(name: string): Promise<CasdoorUser | null> {
    const path = `get-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`
    const j = await this.#adminJson(path)
    // 口径与 #permissionsRaw 一致（M1 闭债 R3）：**只有 ok 才是应答**。
    // 真机（sso.hookflow.cn 实测）：用户不存在 ⇒ 200 + {status:'ok', data:null}；
    // 而 status:'error' 覆盖的是与"不存在"无关的一堆情形——id 非 <org>/<name> 两段
    // （wrong token count）、admin 会话失效（'Please login first'）、org 不存在、
    // org 非公开且权限不过、DB/角色扩展/脱敏出错。
    // 把 error 折叠成 null 会让调用方误判"用户不存在"：会话中间件据此清 cookie（静默登出）、
    // 登录路据此发出"没有角色派生 scopes"的会话（表现为登录了但每个模块 API 都 403）。
    // 不匹配错误文案——形状就够区分（文案随 Casdoor 版本变，见本文件 upsertPermission 的注释）。
    if (j.status !== 'ok') throw new Error(`casdoor get-user: ${j.msg || 'error'}`)
    const u = j.data as Record<string, unknown> | null | undefined
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
    // 同批内去重：同一 code 出现第二次时目标状态已达成，直接跳过。
    // 【不要】用"把刚建的码拼一条假记录塞进 existingList"来实现去重——那种占位记录缺
    // users/roles/model 字段，会被 #upsertOne 当成真记录消费（existing?.users ?? []），
    // 于是走 update 把服务端的 users 清空。旧单码版每次都重取服务端、拿到的是真记录，
    // 那样写是语义退化
    const seen = new Set<string>()
    for (const { code, name } of items) {
      if (seen.has(code)) continue
      seen.add(code)
      const existing = existingList.find(
        (p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code),
      )
      await this.#upsertOne(code, name, existing)
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
    try {
      const j = await this.#adminJson(path, { method: 'POST', body })
      if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    } catch (err) {
      if (existing) throw err // update 路径的失败照抛，无竞态可言
      // add 路径失败：滚动发布/多副本下两实例可能同时判"码不存在"并双双 add，输的那个
      // 报错。**不按错误文案判断**（文案随 Casdoor 版本/分支变，正则匹配等于把正确性
      // 押在一条 mock 自造的字符串上），改为重读验证目标状态是否已达成：码确实在
      // resources 里 ⇒ 供给目的已达成，视为成功；不在 ⇒ 抛（真失败必须响）。
      //
      // 判据与查重同源（都是 resources 含 code），也正与读侧一致：normalizeScopes 只消费
      // resources（users/roles 由调用方过滤）。
      //
      // 分辨力受 get-permissions 的 pageSize 窗口限制（当前 100，见 #permissionsRaw）：
      // 窗口内能分开"并发刚建"与"同名撞码"，超出窗口的码两次读都不可见 ⇒ 会保守地抛。
      // 保守方向是对的（宁可响亮失败，不可静默不供给）；翻页能力本 PR 已列范围外
      let readErr: unknown
      const now = await this.#permissionsRaw().catch((e: unknown) => {
        readErr = e
        return null
      })
      const arrived = now?.some(
        (p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code),
      )
      if (arrived) return
      // 错误里带上 org/code 与处置线索：撞码时 add 会**永久**失败（平台起不来，不只是某个
      // 租户 403），而 Casdoor 原文只有一句 duplicate，运维无从反推出"共享 Casdoor 里有一条
      // 同名异物记录"。二级故障（重读也失败）的原因一并挂上，别让它凭空消失
      throw new Error(
        `casdoor: 供给权限码 ${code} 到 org ${this.#o.org} 失败：${(err as Error).message}`
          + '。失败后重读 get-permissions 未在 resources 里找到该码——若确有一条 name 撞上该码、'
          + 'resources 却不含它的既有记录（共享 Casdoor 里可能由别的系统建出），需人工处置'
          + (readErr ? `；且重读本身也出错：${(readErr as Error).message}` : ''),
        { cause: err },
      )
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

  /** 冷却闸（M1 闭债 R3 评审 S1）：允许本次强制重登就记账并返回 true，冷却中返回 false。 */
  #allowForcedRelogin(): boolean {
    const now = Date.now()
    if (now - this.#lastForcedReloginAt < this.#reloginCooldownMs()) return false
    this.#lastForcedReloginAt = now
    return true
  }

  /** 冷却是否生效中（**不消费**配额）——供 #adminJson 判断"重试必然空转" */
  #inReloginCooldown(): boolean {
    return Date.now() - this.#lastForcedReloginAt < this.#reloginCooldownMs()
  }

  #reloginCooldownMs(): number {
    return this.#o.reloginCooldownMs ?? DEFAULT_RELOGIN_COOLDOWN_MS
  }

  /**
   * admin 会话 cookie（内存缓存）；force=true 强制重登。失败抛错，绝不缓存匿名 cookie。
   *
   * **冷却闸**（评审 S1）：`force` 在冷却窗口内退化为"复用现有 cookie"，即**不重登**——
   * 调用方随后拿到的仍是本次 error，按既有口径抛/降级，语义不变。
   *
   * 取值理由（默认 5s）：重登的唯一目的是修复"服务端把我们的 admin 会话清了"这一类
   * **全局、一次性**的状态错位——第一次就该修好。同一窗口内仍然失败，说明不是会话错位，
   * 而是持续性故障（上游 5xx / DB 慢 / 凭据不对），甚至可能是**非会话类**错误（如 id 非两段）。
   * 此时每次都重登只会在**共享 SSO** 上把登录压力按请求数放大（评审实测：持续 error 下
   * 3 次失败 getUser = 3 次额外登录；8 个并发失败 = 8 次登录）。这里不按错误文案区分
   * （文案随 Casdoor 版本变，本仓明确反对把正确性押在字符串上），一律按窗口限流。
   * 5s 覆盖一次真实会话修复所需的往返，把"每请求一次重登"压成"每 5s 最多一次"。
   * **不做 single-flight**：那要引入在途 Promise 共享与失败传播语义，复杂度不划算。
   */
  async #sessionCookie(force = false): Promise<string> {
    if (!force && this.#adminCookie) return this.#adminCookie
    if (force && this.#adminCookie && !this.#allowForcedRelogin()) return this.#adminCookie
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

  /** admin GET/POST/PUT：401 → 重登一次重试（仅一次，坏凭据不会循环）；
   *  forceSession=true 强制重取会话（供 #adminJson 的响应体层自愈调用） */
  async #adminRequest(
    path: string,
    init?: { method?: string; body?: unknown },
    forceSession = false,
  ): Promise<Response> {
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
    const first = await this.#sessionCookie(forceSession)
    let r = await doFetch(first)
    if (r.status === 401) {
      // 401 是**真机不产生**的形状（真机把会话失效回成 200 + status:error），保留它是因为
      // 它仍是合法的防御面（被反代/网关插一层 401 时能自愈）。冷却闸生效时 #sessionCookie
      // 会复用同一个 cookie ⇒ 重打必然同样 401，直接不重试（否则就是空转请求）
      const retry = await this.#sessionCookie(true)
      if (retry !== first) r = await doFetch(retry)
    }
    return r
  }

  /** admin 请求 + 语义解包：非 2xx 一律抛（不吞异常）；status error 由调用方按语义处理。
   *  **响应体 status:error 时强制重登并重试一次**（见下，M1 闭债 R3 的 admin 会话自愈） */
  async #adminJson(path: string, init?: { method?: string; body?: unknown }): Promise<Record<string, unknown>> {
    const readOnce = async (forceSession: boolean): Promise<Record<string, unknown>> => {
      const r = await this.#adminRequest(path, init, forceSession)
      if (!r.ok) throw new Error(`casdoor request failed: ${r.status} ${path}`)
      return (await r.json().catch(() => ({}))) as Record<string, unknown>
    }
    const j = await readOnce(false)
    if (j.status !== 'error') return j
    // 真机把"admin 会话失效"回成 **HTTP 200 + status:error**（'Please login first'），
    // 而 **不是 401** ⇒ 上面那个 401 重试永不触发，缓存的死 cookie 也永不刷新。
    // 这里补一次强制重登 + 重试：不匹配文案（任何 error 都重试一次；真错的第二次照样错，
    // 由调用方按既有口径抛/降级）。
    //
    // 冷却闸（评审 S1）：窗口内重试只会复用同一个已知失效的 cookie 再打一次空转请求 ⇒
    // 直接返回本次 error，把"每请求一次重登"压成"每窗口最多一次"（语义不变，调用方照旧降级）
    if (this.#inReloginCooldown()) return j
    return readOnce(true)
  }

  async #permissionsRaw(): Promise<Array<Record<string, unknown>>> {
    const path = `get-permissions?owner=${encodeURIComponent(this.#o.org)}&pageSize=100`
    const j = await this.#adminJson(path)
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    return Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : []
  }
}
