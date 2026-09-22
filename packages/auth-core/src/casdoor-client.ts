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
/**
 * Casdoor 的 `name` 字段**禁用字符集**（真 Casdoor 实测：`"/?:#&%=+;"`）。
 *
 * 本仓的权限码是 `<模块>:<动作>` 形如 `demo:view` —— **冒号正好在禁用集里**，把码直接当
 * `name` 会被拒（`Field 'name' contains forbidden characters`）；供给不上去 ⇒ `loadModules`
 * 抛 ⇒ **进程起不来**（issue #25：首发站点 502、容器无限重启）。
 *
 * **只换 `name` 这一个标识字段**：码本身仍原样进 `resources`，而读侧（normalizeScopes）与
 * 供给的查重判据都是 `resources.includes(code)` ⇒ 换名**零语义变化**。
 *
 * 为什么长期没被发现：开发/CI 全程 MockCasdoor，它不校验字符集 —— 这条路径直到 2026-09-13
 * 首次对着真 Casdoor 部署才暴露。
 */
export function safePermissionName(code: string): string {
  return code.replace(/[/?:#&%=+;]/g, '-')
}

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
   * （每次失败各重登一次），设小正数 + **注入时钟手动推进过窗口**证"窗口会随时间重开"
   * （casdoor-client.test.ts 的两条冷却用例；只留前者的话，按次数计的闩照样全绿，评审 S2）。
   */
  reloginCooldownMs?: number
  /**
   * 注入时钟（ms，默认 `Date.now`）。**只**供 `#allowForcedRelogin` / `#inReloginCooldown`
   * 这两个冷却窗口取值——测试用它手动推进窗口，去掉真实墙钟等待（`setTimeout`）的慢与 flaky。
   * 缺省路径与改动前逐值一致，无行为变更。先例：`createLoginLimiter({ now })`（rate-limit.ts）。
   */
  now?: () => number
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

/** listUsers 的返回形状（M3 spec D4：租户管理员用户管理页数据源） */
export interface CasdoorListedUser {
  name: string
  displayName: string
  isForbidden: boolean
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
      // 新建时**不能**拿码当 name（码含 `:`，真 Casdoor 拒收）——见 safePermissionName。
      // update 路径沿用既有 name：兼容此前由别的系统建出的（无冒号的）记录。
      name: (existing?.name as string | undefined) ?? safePermissionName(code),
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

  /**
   * JIT 自动建号（issue #32）：org 内确无此人时经 add-user 建一个最小账号。
   * 幂等语义由调用方保证（先 getUser 判存在再调用）；本方法自身只处理 add 竞态。
   * 载荷形状：2026-09-13 生产手工解卡（mytech/ZhangDuo）在真 Casdoor 验证过的最小集——
   * type=normal-user + signupApplication 缺省 app-built-in（与 #login 同口径，可配）。
   */
  async ensureUser(name: string): Promise<void> {
    const body = {
      owner: this.#o.org,
      name,
      displayName: name,
      type: 'normal-user',
      signupApplication: this.#o.application ?? 'app-built-in',
    }
    try {
      const j = await this.#adminJson('add-user', { method: 'POST', body })
      if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    } catch (err) {
      // add 竞态：与 #upsertOne 同口径——**不按错误文案分支**（duplicate 文案随版本变），
      // 重读验证目标状态：人确实已在 org 里 ⇒ 建号目的已达成，视为成功；仍查无此人 ⇒ 抛
      // （fail loudly：绝不静默放行一个没建出来的号）
      const existing = await this.getUser(name).catch(() => null)
      if (existing !== null) return
      throw new Error(
        `casdoor: add-user 建号 ${name} 到 org ${this.#o.org} 失败：${(err as Error).message}`,
        { cause: err },
      )
    }
  }

    /**
   * 按 org 列订阅（admin 会话，spec 2026-09-13 SaaS 管理域）。
   * 真机实测（尖刺）：数据坏行（非 RFC3339 时间）会让该 org 的此接口整体 error——
   * error 一律抛，不静默空表（静默空表 = 全租户失能，响亮失败才可排障）。
   * 容忍外来订阅：原样透传，mod- 前缀过滤是调用方（subscription-source）的职责。
   */
  async listSubscriptions(owner: string): Promise<CasdoorSubscription[]> {
    const j = await this.#adminJson(`get-subscriptions?owner=${encodeURIComponent(owner)}`)
    if (j.status !== 'ok') throw new Error(`casdoor get-subscriptions: ${j.msg || 'error'}`)
    return Array.isArray(j.data) ? (j.data as CasdoorSubscription[]) : []
  }

  /**
   * 列**本 client org** 的全量用户（M3 用户管理页）。error 一律抛、绝不静默空表
   * （与 listSubscriptions 同口径：静默空表 = 管理页白屏，响亮失败才可排障）。
   * 锚用户过滤是调用方（admin 路由）的职责——客户端原样透传。
   */
  async listUsers(): Promise<CasdoorListedUser[]> {
    const j = await this.#adminJson(`get-users?owner=${encodeURIComponent(this.#o.org)}`)
    if (j.status !== 'ok') throw new Error(`casdoor get-users: ${j.msg || 'error'}`)
    if (!Array.isArray(j.data)) return []
    return (j.data as Array<Record<string, unknown>>)
      .map((u) => ({
        name: String(u.name ?? ''),
        displayName: typeof u.displayName === 'string' && u.displayName ? u.displayName : String(u.name ?? ''),
        isForbidden: u.isForbidden === true,
      }))
      .filter((u) => u.name !== '')
  }

  /** 取单用户**原始记录**（get-user 全量）。update-* 是整记录替换——改一个字段必须先取全量带回，防其余字段被洗。 */
  async #getRawUser(name: string): Promise<Record<string, unknown> | null> {
    const j = await this.#adminJson(`get-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`)
    if (j.status !== 'ok') throw new Error(`casdoor get-user: ${j.msg || 'error'}`)
    const u = j.data as Record<string, unknown> | null | undefined
    return u && typeof u === 'object' && u.name ? u : null
  }

  async #requireRawUser(name: string): Promise<Record<string, unknown>> {
    const raw = await this.#getRawUser(name)
    if (!raw) throw new Error(`casdoor: 用户不存在 ${this.#o.org}/${name}`)
    return raw
  }

  /**
   * 建可登录用户（M3 用户管理页）。add 竞态与 ensureUser 同口径：失败**重读验证**目标状态，
   * 人已在即视为成功；仍无此人 ⇒ 抛（fail loudly）。写后回读（铁律③）。
   */
  async createManagedUser(input: { name: string; displayName?: string; password: string }): Promise<void> {
    const body = {
      owner: this.#o.org,
      name: input.name,
      displayName: input.displayName || input.name,
      password: input.password,
      type: 'normal-user',
      signupApplication: this.#o.application ?? 'app-built-in',
    }
    try {
      const j = await this.#adminJson('add-user', { method: 'POST', body })
      if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    } catch (err) {
      const existing = await this.getUser(input.name).catch(() => null)
      if (existing !== null) return
      throw new Error(
        `casdoor: add-user 建号 ${input.name} 到 org ${this.#o.org} 失败：${(err as Error).message}`,
        { cause: err },
      )
    }
    const back = await this.#getRawUser(input.name) // 铁律③
    if (!back) throw new Error(`casdoor create-managed-user: 写后回读失败 ${this.#o.org}/${input.name}`)
  }

  /** 禁用/启用（isForbidden）。整记录替换：先取全量、只改目标字段再带回；密码不落日志。 */
  async setUserForbidden(name: string, forbidden: boolean): Promise<void> {
    const raw = await this.#requireRawUser(name)
    const j = await this.#adminJson(`update-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`, {
      method: 'POST',
      body: { ...raw, isForbidden: forbidden },
    })
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
  }

  /**
   * 目标 org 的 `passwordType`（改密前置；空/读不到一律抛，见 `resetUserPassword` ③）
   */
  async #requireOrgPasswordType(): Promise<string> {
    // id 形参同 ensureOrg：平台 org 的 owner 恒 'admin'（#117 真机实测：UI/正规途径建的 org
    // owner='admin'；owner≠'admin' 的畸形记录单查失明 ⇒ 也落进下面的响错分支）
    const id = `admin/${this.#o.org}`
    const j = await this.#adminJson(`get-organization?id=${encodeURIComponent(id)}`)
    const g = j.status === 'ok' ? (j.data as { passwordType?: string } | null) : null
    const t = String(g?.passwordType ?? '')
    if (t) return t
    throw new Error(
      `casdoor set-password: org ${this.#o.org} 读不到 passwordType（get-organization?id=${id} ⇒ `
      + `${j.status === 'ok' ? (g ? `passwordType='${t}'` : 'data=null') : `status=error: ${j.msg || 'error'}`}）`
      + '。该 org 下密码登录本就会报 unsupported password type（#117 同款），改密也只会静默不生效'
      + '（Casdoor cred.GetCredManager 对空类型回 nil ⇒ 不哈希），故**拒绝执行**而不是回一个假的成功；'
      + '先给该 org 配 passwordType（如 bcrypt——见 ensureOrg）再来',
    )
  }

  /**
   * 重置密码（M3 用户管理）。走 Casdoor **专用改密端点** `POST /api/set-password`：服务端哈希
   * （controllers/user.go SetPassword → `object.User.UpdateUserPassword` → `cred.GetCredManager`），
   * 只写 user 行的 password/password_salt/password_type/... 四列 ⇒ **不删号**，第三方绑定
   * （`thirdPartyLinks`，企微/钉钉/飞书…）与 roles/createdTime 全部原样保留。
   *
   * **为什么不用 update-user（#119 的病根，2026-09-22 调研定论）**：`object.UpdateUser` 在
   * update-user 不带 `?columns=` 时走列白名单，而那份白名单**根本没有 password**（v1.0.0 → master
   * 共 8 个版本逐版抽查一致）⇒ 拿它改密码是**静默空操作**：回 ok，新旧密码行为都不变。现场把
   * "新密码登录失败"反推成"写入了明文/账号被锁"，与源码不符——订正见 issue #119 评论 +
   * `.superpowers/sdd/issue-119-research.md` §3.2。
   *
   * 四个形状要点（源码 + 真机只读探针，调研 §5.1）：
   *  ① 本端点**只认 form-urlencoded**（controllers/user.go:522 逐字段读 `Request.Form`；官方前端
   *     UserBackend.ts 也发 formData）。传 JSON ⇒ 四个参数全空、id 退化成 `/`，真机探针复现为
   *     `The user: / doesn't exist` ⇒ 必须走 #adminForm，不能走 #adminJson。
   *  ② 管理员路径传 `oldPassword: ''` 即跳过旧密码校验（controllers/user.go:620-625：仅非管理员、
   *     或显式给了 oldPassword 时才比对）——这正是"管理端重置"的定义。
   *  ③ **前置**：目标 org 必须配了 passwordType，否则 `cred.GetCredManager` 回 nil ⇒ **不哈希**
   *     （真机此时把明文写进 password 列）且照样回 ok ⇒ 静默失败，正是本 issue 的病根换个位置
   *     （#117 §4 同款）。故**前置校验拒绝执行** + 写后回读验目标状态（铁律③）双保险。
   *  ④ 后置**不**用 verifyPassword 钉：真机 `HandleLoggedIn` 对 **isForbidden** 用户一律拒登
   *     （controllers/auth.go:61 'The user is forbidden to sign in'）⇒ 拿登录当后置条件会把
   *     "给已禁用用户重置密码"变成假失败；且登录失败会累加 `signin_wrong_times`
   *     （object/check.go CheckPassword → checkSigninErrorTimes）。改为回读 user 记录的
   *     `passwordType`：真机 set-password 成功时恒 `user.PasswordType = organization.PasswordType`。
   *  ⑤ 改密**不踢会话**（真机 `isUserAccessRevoked` 只与 is_forbidden/is_deleted 有关，与
   *     password 无关）⇒ 既有 cookie/token 继续有效。产品若要"重置即下线"，得平台侧另做。
   *
   * 口令**不进**日志/错误文案（本方法任何 throw 都不带 password）。
   */
  async resetUserPassword(name: string, password: string): Promise<void> {
    const orgType = await this.#requireOrgPasswordType() // ③
    const j = await this.#adminForm('set-password', {  // ①
      userOwner: this.#o.org,
      userName: name,
      oldPassword: '', // ② 管理员路径：空 ⇒ 跳过旧密码校验
      newPassword: password,
    })
    // 失败时把服务端 msg 原样透出（真机复杂度/复用校验不过也走这里，msg 可读——不能吞）
    if (j.status !== 'ok') throw new Error(`casdoor set-password: ${j.msg || 'error'}`)
    // 铁律③ 写后回读验**目标状态**：真机 updateUserPassword 成功时恒把 user.PasswordType 置成
    // org.PasswordType；写入被吞 / 未哈希时该字段保持原值 ⇒ 不等即抛（回读为 null 也算失败：
    // 用户不该在改密后消失）。比"回读属性树"更贴目标，且不依赖登录（见 ④）。
    const back = await this.#getRawUser(name)
    const backType = String(back?.passwordType ?? '')
    if (!back || backType !== orgType) {
      throw new Error(
        `casdoor set-password: 写后回读 passwordType 不符 ${this.#o.org}/${name}`
        + `（期望=${orgType}、实际=${back ? (backType || '空') : '用户不存在'}）——改密疑似未生效`,
      )
    }
  }

  /**
   * 删用户。铁律②：delete 类端点一律 JSON body `{owner,name}`（query 形式真机静默无效）；
   * 铁律③：删后回读，仍存在 ⇒ 抛（mock 幂等形状下不存在者也 ok，回读 null 即幂等成功）。
   */
  async deleteUser(name: string): Promise<void> {
    const j = await this.#adminJson('delete-user', { method: 'POST', body: { owner: this.#o.org, name } })
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    const back = await this.#getRawUser(name)
    if (back !== null) throw new Error(`casdoor delete-user: 删后回读仍存在 ${this.#o.org}/${name}`)
  }

  /** 按 resources 含 code 找权限原始记录（判据与 #upsertOne 查重、读侧 normalizeScopes 同源） */
  async #findPermissionByCode(code: string): Promise<Record<string, unknown>> {
    const list = await this.#permissionsRaw()
    const hit = list.find((p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code))
    if (!hit) throw new Error(`casdoor: org ${this.#o.org} 不存在权限码 ${code}（先跑装载器供给）`)
    return hit
  }

  /**
   * 授权：把用户挂到权限码（M3 授权页）。users 追加 `org/user` **全形**（Casdoor UI 同款写法；
   * effectiveScopes 的 matchUser 对短名/全形都可命中）。幂等：已挂（任一形态）直接返回。
   * 整记录替换（bindUserToAllPermissions 同形状），写后回读验证（铁律③）。
   */
  async grantPermissionToUser(code: string, userName: string): Promise<void> {
    const p = await this.#findPermissionByCode(code)
    const users = (p.users as string[] | undefined) ?? []
    const full = `${this.#o.org}/${userName}`
    if (users.includes(userName) || users.includes(full)) return
    const body = {
      owner: this.#o.org,
      name: String(p.name),
      displayName: String(p.displayName ?? p.name),
      model: String(p.model ?? 'built-in/user-model-built-in'),
      users: [...users, full],
      roles: (p.roles as string[] | undefined) ?? [],
      resources: (p.resources as string[] | undefined) ?? [],
      actions: (p.actions as string[] | undefined) ?? ['Read'],
      isEnabled: p.isEnabled === undefined ? true : p.isEnabled,
    }
    const j = await this.#adminJson(
      `update-permission?id=${encodeURIComponent(`${this.#o.org}/${String(p.name)}`)}`,
      { method: 'POST', body },
    )
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    const back = await this.#findPermissionByCode(code)
    const bu = (back.users as string[] | undefined) ?? []
    if (!bu.includes(userName) && !bu.includes(full)) {
      throw new Error(`casdoor: 授权写后回读未命中 ${code} ← ${userName}`)
    }
  }

  /**
   * 回收：把用户从权限码摘下。短名与 `org/user` 全形**一并清**（历史数据两种形态都可能存在）。
   * 幂等：本就没挂直接返回（不发 update）。
   */
  async revokePermissionFromUser(code: string, userName: string): Promise<void> {
    const p = await this.#findPermissionByCode(code)
    const users = (p.users as string[] | undefined) ?? []
    const kept = users.filter((u) => u !== userName && u !== `${this.#o.org}/${userName}`)
    if (kept.length === users.length) return
    const body = {
      owner: this.#o.org,
      name: String(p.name),
      displayName: String(p.displayName ?? p.name),
      model: String(p.model ?? 'built-in/user-model-built-in'),
      users: kept,
      roles: (p.roles as string[] | undefined) ?? [],
      resources: (p.resources as string[] | undefined) ?? [],
      actions: (p.actions as string[] | undefined) ?? ['Read'],
      isEnabled: p.isEnabled === undefined ? true : p.isEnabled,
    }
    const j = await this.#adminJson(
      `update-permission?id=${encodeURIComponent(`${this.#o.org}/${String(p.name)}`)}`,
      { method: 'POST', body },
    )
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
  }

  /**
   * 建 org（幂等）。#117 真机三陷阱（2026-09-19 山海交付实测）：
   *   ① add-organization 缺 `owner` ⇒ 建出 owner="" 的畸形 org——get-organizations 列表可见、
   *     get-organization 单查失明（GetOrganization 按 (owner,name) 查询），后续 add-user 报
   *     `The organization: <org> does not exist`；
   *   ② 缺 `passwordType` ⇒ 空串 ⇒ 该 org 用户密码登录报 `unsupported password type: `；
   *   ③ 200+status:error 被吞 ⇒ 「✓ org」假绿。
   * 故：存在性判定与回读**同口径**（单查 `?id=admin/<name>`，不查列表——列表不过滤 owner，
   * 畸形 org 会被当存在而放行）；body 恒带 owner='admin' + passwordType='bcrypt'（UI 建 org
   * 的默认值）；写操作逐一验 status；建后回读验 owner/name/passwordType（铁律③）。
   */
  async ensureOrg(name: string): Promise<void> {
    const id = `admin/${name}`
    const exists = await this.#adminJson(`get-organization?id=${encodeURIComponent(id)}`)
    if (exists.status === 'ok' && exists.data
      && (exists.data as { owner?: string }).owner === 'admin'
      && (exists.data as { name?: string }).name === name) return
    const add = await this.#adminJson('add-organization', {
      method: 'POST',
      body: { owner: 'admin', name, displayName: name, passwordType: 'bcrypt', isEnabled: true },
    })
    if (add.status && add.status !== 'ok') {
      // 同名被拒不按文案分支，重读列表判定（同 #upsertOne 口径）：列表有此名而单查无 ⇒ 畸形记录
      const list = await this.#adminJson('get-organizations')
      const listed = list.status === 'ok' && Array.isArray(list.data)
        && list.data.some((o) => (o as { name: string }).name === name)
      throw new Error(listed
        ? `casdoor ensure-org: 同名 org 已存在但单查失明（疑似 owner≠admin 的畸形记录，旧版 CLI 建出；`
          + `需人工删建——delete-organization 走 JSON body {owner,name} 后带 owner='admin' 重建，#117）: ${name}`
        : `casdoor: ${add.msg || 'error'}`)
    }
    const back = await this.#adminJson(`get-organization?id=${encodeURIComponent(id)}`) // 铁律③ 写后回读
    const g = back.status === 'ok' ? back.data as { owner?: string; name?: string; passwordType?: string } | null : null
    if (!g || g.owner !== 'admin' || g.name !== name || g.passwordType !== 'bcrypt') {
      throw new Error(`casdoor ensure-org: 写后回读失败/形状不符 ${id}（owner=${g?.owner ?? '无'} passwordType=${g?.passwordType ?? '无'}）`)
    }
  }

  /**
   * 租户订阅锚用户（禁登、随机密码、幂等）。Casdoor UI 按用户管理订阅——空 user 不可运营。
   * #117 真机：add-user 缺 `signupApplication` / org 零 application ⇒ 200+status:error
   * `The organization: <org> should have one application at least`——共享 Casdoor 正典 =
   * 每客户 org 一个 application（交付 runbook 先建 application 再跑 provision CLI）。
   * signupApplication 与 #login/ensureUser 同口径：可配，缺省 app-built-in。
   */
  async ensureAnchorUser(org: string): Promise<void> {
    const id = `${org}/tenantsub`
    const j = await this.#adminJson(`get-user?id=${encodeURIComponent(id)}`)
    if (j.status === 'ok' && j.data) return
    const add = await this.#adminJson('add-user', {
      method: 'POST',
      body: {
        owner: org, name: 'tenantsub', displayName: 'Tenant Subscription Anchor',
        password: crypto.randomUUID() + '!Aa1', email: 'tenantsub@subscription.invalid',
        isForbidden: true, type: 'normal-user',
        signupApplication: this.#o.application ?? 'app-built-in',
      },
    })
    if (add.status && add.status !== 'ok') throw new Error(`casdoor ensure-anchor-user: ${add.msg || 'error'}`)
    const back = await this.#adminJson(`get-user?id=${encodeURIComponent(id)}`) // 铁律③ 写后回读
    if (back.status !== 'ok' || !back.data) throw new Error(`casdoor ensure-anchor-user: 写后回读失败 ${id}`)
  }

  /** 模块 plan（owner=租户 org、Role 留空——订阅管租户能用什么，授权管谁能用，两层不混）。幂等。 */
  async ensureModulePlan(org: string, moduleId: string): Promise<void> {
    const plan = `mod-${moduleId}`
    const id = `${org}/${plan}`
    const j = await this.#adminJson(`get-plan?id=${encodeURIComponent(id)}`)
    if (j.status === 'ok' && j.data) return
    await this.#adminJson('add-plan', {
      method: 'POST',
      body: { owner: org, name: plan, displayName: plan, price: 0, currency: 'CNY', isEnabled: true },
    })
  }

  /** 订阅/退订（幂等 upsert）。铁律①：时间一律 RFC3339 UTC——写错会毒化整个 org 的列表读取。 */
  async upsertSubscription(org: string, moduleId: string, opts: { state: 'Active' | 'Terminated'; days?: number }): Promise<void> {
    const name = `sub-mod-${moduleId}`
    const id = `${org}/${name}`
    const existing = await this.#adminJson(`get-subscription?id=${encodeURIComponent(id)}`)
    const days = opts.days ?? 3650
    const next = {
      owner: org, name, displayName: name, user: `${org}/tenantsub`, plan: `mod-${moduleId}`,
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + days * 864e5).toISOString(),
      state: opts.state,
    }
    // update 必须带 ?id=<org>/<name>（issue #50：真机 update-* 一律按 id 定位，缺 id 静默 no-op
    // ——与 update-permission 同规；M1 替身按 body 定位比真机宽松，把这条形状漂移遮蔽到了 D6 验收才现形）
    const path = existing.status === 'ok' && existing.data
      ? `update-subscription?id=${encodeURIComponent(id)}`
      : 'add-subscription'
    await this.#adminJson(path, { method: 'POST', body: next })
    const back = await this.#adminJson(`get-subscription?id=${encodeURIComponent(id)}`) // 铁律③
    if (back.status !== 'ok' || !back.data) throw new Error(`casdoor upsert-subscription: 写后回读失败 ${id}`)
    // 铁律③收严（issue #50）：回读验**目标状态**，不只存在性——state 写丢是假绿
    const backState = String((back.data as { state?: string }).state ?? '')
    if (backState !== opts.state) {
      throw new Error(`casdoor upsert-subscription: 写后回读 state 不符 ${id} 期望=${opts.state} 实际=${backState}`)
    }
  }

/**
   * 把用户挂到本 org 的**全部**权限码上（issue #32 JIT 建号后的授权步）：
   * 逐条 update-permission 把 name 追加进 users 数组，其余字段（roles/resources/
   * actions/isEnabled）原样保留。已挂的跳过（幂等，重复 bind 不产生写调用）。
   * 口径与装载器一致：模块码 upsert 时不带用户，JIT 建的号没有任何角色 ⇒
   * 不挂 users 则 effectiveScopes 恒空、登录即空权限。**逐条**而非合并成一次
   * update：Casdoor 的 update-permission 是整记录替换，逐条=最小破坏面。
   */
  async bindUserToAllPermissions(user: string): Promise<void> {
    const list = await this.#permissionsRaw()
    for (const p of list) {
      const users = (p.users as string[] | undefined) ?? []
      if (users.includes(user)) continue
      const body = {
        owner: this.#o.org,
        name: String(p.name),
        displayName: String(p.displayName ?? p.name),
        model: String(p.model ?? 'built-in/user-model-built-in'),
        users: [...users, user],
        roles: (p.roles as string[] | undefined) ?? [],
        resources: (p.resources as string[] | undefined) ?? [],
        actions: (p.actions as string[] | undefined) ?? ['Read'],
        isEnabled: p.isEnabled === undefined ? true : p.isEnabled,
      }
      const path = `update-permission?id=${encodeURIComponent(`${this.#o.org}/${String(p.name)}`)}`
      const j = await this.#adminJson(path, { method: 'POST', body })
      if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
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
    const now = this.#nowMs()
    if (now - this.#lastForcedReloginAt < this.#reloginCooldownMs()) return false
    this.#lastForcedReloginAt = now
    return true
  }

  /** 冷却是否生效中（**不消费**配额）——供 #adminJson 判断"重试必然空转" */
  #inReloginCooldown(): boolean {
    return this.#nowMs() - this.#lastForcedReloginAt < this.#reloginCooldownMs()
  }

  /** 冷却窗口用的时钟（可注入；见 options.now）——**只**这两个冷却判断经它取值 */
  #nowMs(): number {
    return this.#o.now ? this.#o.now() : Date.now()
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
   *  forceSession=true 强制重取会话（供 #adminExchange 的响应体层自愈调用）。
   *
   *  实体编码二选一（**互斥**，`form` 优先）：`form` ⇒ `x-www-form-urlencoded`（set-password
   *  只认它，见 resetUserPassword ①）；`body` ⇒ JSON（本文件其余调用方一律走这条）。 */
  async #adminRequest(
    path: string,
    init?: { method?: string; body?: unknown; form?: Record<string, string> },
    forceSession = false,
  ): Promise<Response> {
    const doFetch = (cookie: string): Promise<Response> => {
      const headers: Record<string, string> = { Cookie: cookie }
      let body: string | undefined
      if (init?.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        body = new URLSearchParams(init.form).toString()
      } else if (init?.body) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(init.body)
      }
      const req: RequestInit = {
        method: init?.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
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
   *  **响应体 status:error 时强制重登并重试一次**（见下，M1 闭债 R3 的 admin 会话自愈）。
   *
   *  JSON 与 form 两个入口（#adminJson / #adminForm）**共用本内核**：编码只体现在 init 上，
   * 会话自愈与冷却闸只有一套——#119 加 form 口时不复制这段（复制就会长出第二份冷却语义）。 */
  async #adminExchange(path: string, init?: { method?: string; body?: unknown; form?: Record<string, string> }): Promise<Record<string, unknown>> {
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

  /** #adminExchange 的 **JSON 形**（既有调用方全部走它；签名与改动前逐字一致） */
  async #adminJson(path: string, init?: { method?: string; body?: unknown }): Promise<Record<string, unknown>> {
    return this.#adminExchange(path, init)
  }

  /** #adminExchange 的 **form 形**（`POST` + x-www-form-urlencoded）。set-password 只认 form：见
   *  resetUserPassword ① —— 走 JSON 会让服务端把参数读成空（真机探针复现，调研 §5.1）。 */
  async #adminForm(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    return this.#adminExchange(path, { method: 'POST', form })
  }

  async #permissionsRaw(): Promise<Array<Record<string, unknown>>> {
    const path = `get-permissions?owner=${encodeURIComponent(this.#o.org)}&pageSize=100`
    const j = await this.#adminJson(path)
    if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
    return Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : []
  }
}

/** Casdoor 订阅（字段见 object/subscription.go；时间 RFC3339 UTC——写侧由 upsertSubscription 保证） */
export interface CasdoorSubscription {
  owner: string
  name: string
  user: string
  plan: string
  startTime: string
  endTime: string
  state: string
}
