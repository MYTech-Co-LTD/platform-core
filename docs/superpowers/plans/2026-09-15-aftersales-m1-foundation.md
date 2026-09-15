# 售后模块 M1 底座三件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地售后模块 spec（`docs/superpowers/specs/2026-09-15-aftersales-module-design.md`）的 M1 期：manifest `guest` 协议字段、auth-core 公众号 OAuth、`wechat-oa` 访客登录路、租户行公众号配置、userApp 停用闸门补缺。

**Architecture:** 访客身份不建 Casdoor 账号——公众号静默授权换 openid 后由宿主签访客 session，scopes = 该租户**已启用模块**经 manifest `guest:{scope}` 声明的码集合（声明即授权的延伸）；userApp 静态复用模块 API 同款启用闸门（匿名放行壳、已登录停用 404 同形）。

**Tech Stack:** TypeScript / Hono / zod / pg / vitest（真 PG + MockCasdoor 既有约定）。

## Global Constraints

- **分支**：`docs/aftersales-module-spec`（spec 提交 942a4b6→f693fb6）。
- **feat/fix 必须先有 issue**：Task 1 建 issue，PR body `Closes #N`；提交 `type(scope): 中文一句话`。
- **B2**：认证代码只进 `packages/auth-core`；**桶文件（public.ts）export 值清单绝不混 interface/type**（硬约束 #10，护栏测试在 CI 兜底）。
- **迁移幂等**：`add column if not exists`；平台迁移下一个序号 **005**。
- **微信 API 形状**：HTTP 200 + body `errcode`（非 4xx 语义）——`errcode!==0` 或无 `openid` ⇒ 返回 null（被拒）；传输层（网络/5xx/非 JSON）⇒ throw（路由层 502 类，不吞成 BAD_CODE，同 auth-wecom 评审 I2 口径）。
- **限速拆桶**：wechat-oa 门与 wecom/账密分桶键（`'wechat-oa'`），共用同一 limiter 实例。
- **测试约定**：apps/server 真 PG 测试无 `DATABASE_URL` 整体跳过；本地 `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（5432 可能被原生 pg 遮蔽，连不上先查这个）。
- **波末验证**：`pnpm test && pnpm typecheck && pnpm build && pnpm --filter @platform/web build && pnpm smoke`。

---

### Task 1: 建 issue

**Interfaces:** Produces: issue 编号 `#N`（Task 8 PR 引用）。

- [ ] **Step 1:**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "售后模块 M1 底座三件：wechat-oa 访客登录路 + userApp 停用闸门 + manifest guest 声明（spec 2026-09-15 §1.3/§3.4-M1）" \
  --body "$(cat <<'EOF'
## 背景

售后域模块（wuji 迁移）spec 的 M1 期。移动端是外部客户：公众号 openid 签访客 session
（不建 Casdoor 号），业务资格由模块判定；wechat-oa 非 console 登录 tab。

## 要做

- [ ] manifest 增 guest:{scope} 协议字段（scope 必须 ∈ permissions[].code）
- [ ] auth-core 公众号 OAuth（buildWechatOaSilentUrl + wechatOaOpenidForCode）
- [ ] 租户行 wechat_oa_app_id/secret 两列（005 迁移）
- [ ] routes/auth-wechat-oa.ts 访客登录路（state cookie + 回调换 openid + 访客 session 按已启用模块发 guest 码）
- [ ] userApp 静态挂启用闸门（module-protocol 休眠缺口补上）+ 文档回写

## 验收

访客 e2e（MockCasdoor/假微信）：silent 跳授权 URL → callback 换 openid → session 带
已启用模块的 guest 码；停用模块 ⇒ API 404 且 userApp 静态 404 同形；匿名可载 userApp 壳。
EOF
)"
```

- [ ] **Step 2: 记下 `#N`。**

---

### Task 2: manifest `guest` 协议字段

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Test: `packages/platform-sdk/src/manifest.test.ts`

**Interfaces:**
- Produces: `ModuleManifest` 增 `guest?: { scope: string }`；zod schema 同步；**约束：`guest.scope` 必须 ∈ `permissions[].code`**（ZodError 拒绝，与 `api.internal[].scope` 同一纪律）。

- [ ] **Step 1: 失败测试（manifest.test.ts 追加）**

```ts
describe('guest 字段（售后 spec §1.3 协议小扩展）', () => {
  const base = {
    id: 'guestmod', name: 'g', version: '0.1.0', platform: '>=0.1',
    permissions: [{ code: 'guestmod:view', name: 'v' }, { code: 'guestmod:guest', name: '访客' }],
  }
  it('合法：guest.scope ∈ permissions codes', () => {
    const r = ManifestSchema.safeParse({ ...base, guest: { scope: 'guestmod:guest' } })
    expect(r.success).toBe(true)
  })
  it('非法：guest.scope 不在 permissions ⇒ ZodError（与 api scope 同纪律）', () => {
    const r = ManifestSchema.safeParse({ ...base, guest: { scope: 'other:guest' } })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: 红**：`pnpm --filter @platform/sdk test -- manifest` → 新用例 FAIL（schema 无 guest，success:false 但两条都断言错位——第一条应 FAIL）。

- [ ] **Step 3: 实现**：manifest.ts 的 TS 接口加 `guest?: { scope: string }`（与 `frontend?` 同级）；zod schema 加 `guest: z.object({ scope: z.string() }).optional()`；在 schema 上（api.internal[].scope 校验所在的同一 `.superRefine`/校验处；若当前是独立 check 函数则加在同一处）追加：

```ts
if (data.guest) {
  const codes = new Set((data.permissions ?? []).map((p) => p.code))
  if (!codes.has(data.guest.scope)) {
    ctx.addIssue({
      code: 'custom',
      path: ['guest', 'scope'],
      message: `guest.scope "${data.guest.scope}" 必须是本模块 permissions[].code 里的码`,
    })
  }
}
```

（`ctx` 为 superRefine 第二参；若既有校验不是 superRefine 形态，按同语义改写进现有机制——先读文件再动手，勿新建第二套校验通道。）

- [ ] **Step 4: 绿**：`pnpm --filter @platform/sdk test` 全绿（既有用例不回归——guest 是 optional）。

- [ ] **Step 5: Commit**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/manifest.test.ts
git commit -m "feat(sdk): manifest 增 guest:{scope} 声明——访客码入协议，scope 必须∈permissions 码（售后 spec §1.3）"
```

---

### Task 3: auth-core 公众号 OAuth 客户端

**Files:**
- Create: `packages/auth-core/src/wechat-oa.ts`
- Create: `packages/auth-core/src/wechat-oa.test.ts`
- Modify: `packages/auth-core/src/public.ts`（barrel：**只加值导出，绝不加 type**）

**Interfaces:**
- Produces:
  - `buildWechatOaSilentUrl(appId: string, redirectUri: string, state: string): string`
  - `wechatOaOpenidForCode(cfg: { appId: string; secret: string }, code: string, fetchImpl?: typeof globalThis.fetch): Promise<string | null>`（null=上游拒；throw=传输层故障）
- Consumes: 无（纯新增，零仓内依赖——auth-core 无仓内依赖的既有纪律）。

- [ ] **Step 1: 失败测试（wechat-oa.test.ts，风格照 wecom.test.ts）**

```ts
import { describe, expect, it } from 'vitest'
import { buildWechatOaSilentUrl, wechatOaOpenidForCode } from './wechat-oa'

describe('buildWechatOaSilentUrl', () => {
  it('snsapi_base 静默授权：appid/redirect_uri/state 正确编码，尾带 #wechat_redirect', () => {
    const url = buildWechatOaSilentUrl('wx123', 'https://x.example.com/cb?via=silent', 'st-1')
    expect(url).toContain('https://open.weixin.qq.com/connect/oauth2/authorize')
    expect(url).toContain('appid=wx123')
    expect(url).toContain('redirect_uri=' + encodeURIComponent('https://x.example.com/cb?via=silent'))
    expect(url).toContain('scope=snsapi_base')
    expect(url).toContain('state=st-1')
    expect(url.endsWith('#wechat_redirect')).toBe(true)
  })
})

describe('wechatOaOpenidForCode', () => {
  const ok = (openid: string) => (input: string | URL | Request) =>
    Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 7200, openid }), { status: 200 }))

  it('200 + openid ⇒ 返回 openid', async () => {
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', ok('oX1') as typeof fetch)).toBe('oX1')
  })
  it('200 + errcode≠0（微信以 200 回错误）⇒ null（被拒，非传输）', async () => {
    const f = () => Promise.resolve(new Response(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }), { status: 200 }))
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f as typeof fetch)).toBeNull()
  })
  it('200 无 openid ⇒ null', async () => {
    const f = () => Promise.resolve(new Response(JSON.stringify({ access_token: 't' }), { status: 200 }))
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f as typeof fetch)).toBeNull()
  })
  it('5xx / 非 JSON ⇒ throw（传输层，路由按 502 类，不吞成 BAD_CODE）', async () => {
    const f5 = () => Promise.resolve(new Response('bad gateway', { status: 502 }))
    await expect(wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f5 as typeof fetch)).rejects.toThrow()
    const fHtml = () => Promise.resolve(new Response('<html>', { status: 200 }))
    await expect(wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', fHtml as typeof fetch)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 红**：`pnpm --filter @platform/auth-core test -- wechat-oa` → 模块不存在 FAIL。

- [ ] **Step 3: 实现（wechat-oa.ts）**

```ts
// wechat-oa.ts — 微信公众号网页授权（snsapi_base 静默）：售后 spec §1.3 外部客户身份。
// 形状纪律照 wecom.ts：URL 构造纯函数 + code 换身份（null=上游拒 / throw=传输层故障）。
// 微信 API 特殊形状：**HTTP 200 + body errcode 表错**（不是 4xx）——errcode≠0 或无 openid
// 归「被拒」返 null；网络错/5xx/非 JSON 归传输层 throw（路由层 502 类 fail-loudly）。
export function buildWechatOaSilentUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_base',
    state,
  })
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`
}

export async function wechatOaOpenidForCode(
  cfg: { appId: string; secret: string },
  code: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  const q = new URLSearchParams({
    appid: cfg.appId,
    secret: cfg.secret,
    code,
    grant_type: 'authorization_code',
  })
  const r = await fetchImpl(`https://api.weixin.qq.com/sns/oauth2/access_token?${q.toString()}`)
  if (r.status >= 500) throw new Error(`wechat oauth endpoint http ${r.status}`)
  let j: { errcode?: number; openid?: string }
  try {
    j = (await r.json()) as { errcode?: number; openid?: string }
  } catch {
    throw new Error('wechat oauth endpoint returned non-json body')
  }
  if (typeof j.errcode === 'number' && j.errcode !== 0) return null
  return j.openid ?? null
}
```

- [ ] **Step 4: barrel**：`public.ts` 的值导出清单加两行（`buildWechatOaSilentUrl`、`wechatOaOpenidForCode`）——**不加任何 type/interface**。

- [ ] **Step 5: 绿 + barrel 护栏**：`pnpm --filter @platform/auth-core test`（含 public.test.ts 运行时加载护栏）。

- [ ] **Step 6: Commit**

```bash
git add packages/auth-core/src/wechat-oa.ts packages/auth-core/src/wechat-oa.test.ts packages/auth-core/src/public.ts
git commit -m "feat(auth-core): 公众号网页授权客户端——静默 URL 构造 + code 换 openid（200+errcode 形状钉死）"
```

---

### Task 4: 租户行公众号配置两列

**Files:**
- Create: `apps/server/src/migrations/005_tenant_wechat_oa.sql`
- Modify: `apps/server/src/tenant.ts:13-31`（TenantRow）

**Interfaces:**
- Produces: `TenantRow` 增 `wechat_oa_app_id: string | null`、`wechat_oa_secret: string | null`（`select *` 自动带出，查询零改动）。

- [ ] **Step 1: 迁移文件**

```sql
-- 005_tenant_wechat_oa.sql — 租户级微信公众号 provider（售后 spec §1.3 外部客户身份）
--
-- 与 wecom 三参（003/004 同族）同桶：multi 下每个租户自己的公众号。允许 NULL：
-- 不配 ⇒ wechat-oa 路由对该租户 404 WECHAT_OA_NOT_CONFIGURED（配置存在即启用，非 login_methods）。
-- 幂等：部署每次全量重跑迁移。
alter table platform.tenant add column if not exists wechat_oa_app_id text;
alter table platform.tenant add column if not exists wechat_oa_secret text;
```

- [ ] **Step 2: TenantRow 接口加两字段**（wecom_corp_id 同款位置与注释风格）。

- [ ] **Step 3: 验证**：`DATABASE_URL=… pnpm --filter @platform/server exec vitest run src/tenant.test.ts src/migrate.test.ts` → 绿（启动期迁移自动应用；既有用例不回归）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/migrations/005_tenant_wechat_oa.sql apps/server/src/tenant.ts
git commit -m "feat(server): 租户行公众号配置两列 wechat_oa_app_id/secret（005 迁移，幂等）"
```

---

### Task 5: loader——guest 码收集 + userApp 停用闸门

**Files:**
- Modify: `apps/server/src/loader.ts`（loadModules 返回的 runtime：`mount()` userApp 段 + 新 `enabledGuestScopes`）
- Test: `apps/server/src/loader.test.ts`（fixture 机制：`writeModule`/`manifestYaml`/cleanupModules 既有助手）

**Interfaces:**
- Produces: runtime 增 `enabledGuestScopes(tenantId: number): Promise<string[]>`——`enabledFor(tenantId)` 已启用模块的 `manifest.guest?.scope`（无声明滤除）。
- Consumes: Task 2 的 `manifest.guest`。

- [ ] **Step 1: 失败测试（loader.test.ts 追加，fixture 模块带 userApp + guest）**

```ts
// ---- 售后 M1：userApp 停用闸门 + guest 码发放 ----
it('userApp 静态吃启用闸门：停用 ⇒ 404（与 API 面同形）；启用 ⇒ 200（匿名可载壳）', async () => {
  cleanupModules.push('userappmod')
  cleanupSqls.push('drop schema if exists userappmod cascade')
  await writeModule(modulesDir, 'userappmod', {
    'manifest.yaml': manifestYaml('userappmod', [
      'permissions:',
      '  - { code: userappmod:guest, name: 访客 }',
      'guest: { scope: userappmod:guest }',
      'frontend:',
      '  userApp: { mount: /m-userappmod, dist: dist }',
    ].join('\n')),
    'index.ts': FIXTURE_MODULE_TS, // 既有 fixture 的模块入口常量/写法——按本文件已有用例照抄
    'dist/index.html': '<html>shell</html>',
  })
  // 装载 + 造租户 + tenant_module 行的写法照本文件既有用例（enabled=false 行 / 无行=启用）
  // 断言①：enabled=false ⇒ GET /m-userappmod/ 与 GET /api/modules/userappmod/* 均 404 同形
  // 断言②：启用 ⇒ GET /m-userappmod/ 200（**匿名不带 cookie**——SPA 壳必须可载）
  // 断言③：enabledGuestScopes(tenantId) 停用 ⇒ []；启用 ⇒ ['userappmod:guest']
})
```

（fixture 具体 API 以 loader.test.ts 现有 helper 为准——`manifestYaml` 的参数形状若不同，照现有用例改写**调用方式**，断言三件不变。）

- [ ] **Step 2: 红**：跑 loader.test → userApp 404 断言 FAIL（现状静态无闸门，enabled=false 仍 200）；enabledGuestScopes 不存在 TS 报错。

- [ ] **Step 3: 实现（loader.ts）**

① `mount()` 里 userApp 段，serveStatic **之前**挂同一闭包 `gate`（Hono：use 先注册先生效；`gate` 变量在同一循环作用域已存在）：

```ts
        const mountPath = userApp.mount.replace(/\/+$/, '')
        // 售后 M1（module-protocol「停用语义」休眠缺口收口）：userApp 静态吃同一道启用闸门——
        // 匿名放行（SPA 壳登录前可载，业务 API 自会 401/404），已登录+停用 ⇒ 404 与 API 面同形。
        app.use(mountPath + '/*', gate)
        app.use(
```

（其余 serveStatic 原样；紧随其后的「⚠️ 上面那道启用闸门不覆盖这里」大注释**改写**为「已收口：静态挂同一 gate（售后 M1）」。）

② runtime 返回对象增（与 `enabledFor` 并列）：

```ts
    /** 该租户已启用模块声明的访客码（manifest guest.scope，售后 spec §1.3：wechat-oa 签访客 session 用） */
    enabledGuestScopes: async (tenantId: number): Promise<string[]> => {
      const enabled = await enabledForImpl(tenantId)
      return loaded
        .filter((m) => enabled.has(m.manifest.id) && m.manifest.guest)
        .map((m) => m.manifest.guest!.scope)
    },
```

- [ ] **Step 4: 绿**：`DATABASE_URL=… pnpm --filter @platform/server exec vitest run src/loader.test.ts` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts
git commit -m "feat(loader): userApp 静态挂启用闸门（休眠缺口收口）+ enabledGuestScopes 按已启用模块收集访客码"
```

---

### Task 6: wechat-oa 访客登录路

**Files:**
- Create: `apps/server/src/routes/auth-wechat-oa.ts`
- Create: `apps/server/src/routes/auth-wechat-oa.test.ts`
- Modify: `apps/server/src/app.ts:228-239`（wecom 挂载块后并列接线）

**Interfaces:**
- Consumes: Task 3 的两个函数；Task 4 的 TenantRow 字段；Task 5 的 `enabledGuestScopes`；既有 `signSession/serializeSessionCookie/serializeSessionCookie 的 SessionEnv`、`LoginLimiter`、`writeAudit` 同款 SQL。
- Produces: `wechatOaRoutes(deps): Hono`，路由 `GET /silent`、`GET /callback`；deps：

```ts
export interface WechatOaRoutesDeps {
  sessionSecret: string
  pool: Pool
  limiter: LoginLimiter
  publicOrigin: string
  enabledGuestScopes: (tenantId: number) => Promise<string[]>
  wechatFetch?: typeof globalThis.fetch // 测试注入假微信 API
}
```

- [ ] **Step 1: 失败测试（auth-wechat-oa.test.ts，装配/断言风格照 auth-wecom.test.ts）**

覆盖六件（每件一 it）：

```ts
// ① 未配置公众号（租户行无 wechat_oa_app_id/secret）⇒ GET /silent 404 WECHAT_OA_NOT_CONFIGURED
// ② 微信内 UA（MicroMessenger）⇒ 302 到 open.weixin.qq.com，Set-Cookie 带 wechat_oa_state（HttpOnly, Max-Age=300, SameSite=Lax）
//    非微信 UA ⇒ 302 /login（照 wecom /silent 的降级）
// ③ callback state 不匹配 ⇒ fail 呈现（302 /login?error=BAD_STATE）且 limiter 计数
// ④ code 被拒（假微信 200+errcode）⇒ 302 /login?error=BAD_CODE，audit login.fail reason=no-openid
// ⑤ 成功：假微信回 openid ⇒ Set-Cookie platform_session；解 JWT 断言
//    sub=openid、authVia='wechat-oa'、scopes=['<已启用 fixture 模块的 guest 码>']（enabledGuestScopes 注入 stub 返回 ['guestmod:guest']）
// ⑥ 传输层（假微信 5xx）⇒ 302 /login?error=WECHAT_UNAVAILABLE（不吞成 BAD_CODE）
```

（租户 fixture：走既有测试对 platform.tenant 的写法，插一行带 `wechat_oa_app_id/secret` 的租户 + Host 头路由到它。）

- [ ] **Step 2: 红**：路由文件不存在。

- [ ] **Step 3: 实现（auth-wechat-oa.ts，骨架逐段照 auth-wecom.ts 的同位结构——state cookie/readStateCookie/trimSlash/writeAudit/限速 record 全套口径照抄改门键）**

```ts
// routes/auth-wechat-oa.ts — 公众号访客登录路（售后 spec §1.3）：外部客户，openid 即身份。
// 与企微路的本质差异：**不落 Casdoor 账号**——openid 直接签访客 session（sub=openid，
// scopes=已启用模块的 guest 码），业务资格由模块按绑定/审批状态判定（fail-closed 在模块侧）。
// 启用判定 = 租户行公众号配置存在（非 login_methods，非 console 登录 tab）。
const CALLBACK_PATH = '/api/platform/auth/wechat-oa/callback'
const STATE_COOKIE = 'wechat_oa_state'
const STATE_TTL_SEC = 300

export function wechatOaRoutes(deps: WechatOaRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH
  const fail = (err: string) => c_html_redirect(`/login?error=${encodeURIComponent(err)}`) // 顶层导航路：恒 302 回登录页（无 iframe 分支——外部客户 H5 不经 console 登录页）

  // GET /silent — 微信内浏览器整页静默授权
  app.get('/silent', (c) => {
    const ua = c.req.header('user-agent') ?? ''
    if (!ua.toLowerCase().includes('micromessenger')) return c.redirect('/login')
    const t = c.get('tenant')
    if (!t.wechat_oa_app_id || !t.wechat_oa_secret) {
      return c.json({ error: 'WECHAT_OA_NOT_CONFIGURED' }, 404)
    }
    const state = randomUUID()
    c.res.headers.append('Set-Cookie', `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_SEC}; HttpOnly; SameSite=Lax`)
    return c.redirect(buildWechatOaSilentUrl(t.wechat_oa_app_id, `${callbackUri}`, state))
  })

  // GET /callback?code&state — 换 openid → 访客 session
  app.get('/callback', async (c) => {
    const t = c.get('tenant')
    // 限速（照 auth-wecom 口径：check 早于 audit；每条失败路径必须 record；门键 'wechat-oa' 独立桶）
    // state 校验（cookie wechat_oa_state === query state，不符 ⇒ BAD_STATE + record）
    // 换 openid：wechatOaOpenidForCode({appId,secret}, code, deps.wechatFetch ?? fetch)
    //   throw ⇒ WECHAT_UNAVAILABLE + record（不写 login.fail——非用户过错）
    //   null  ⇒ BAD_CODE + record + audit login.fail {via:'wechat-oa', reason:'no-openid'}
    // 访客 session：scopes = await deps.enabledGuestScopes(t.id)
    //   token = signSession({ sub: openid, org: t.casdoor_org, name: openid, scopes, authVia: 'wechat-oa' }, deps.sessionSecret, now)
    //   审计先行：audit login.ok {via:'wechat-oa'} → Set-Cookie → 302 '/'
    …按上述骨架补全每个分支的实现（口径逐条对照 auth-wecom.ts 同位代码）
  })
  return app
}
```

（`c_html_redirect` 等示意名替换为真实 Hono 调用——`c.redirect`。骨架注释里的每个分支都是**必须实现**的清单，不是可选。）

- [ ] **Step 4: app.ts 接线**（wecom 块后并列；runtime 变量名以 app.ts 装载段实际名为准——模块装载产物在 ⑨ `runtime.mount` 附近）：

```ts
  // ⑧c 公众号访客登录路（售后 spec §1.3）：外部客户 openid 访客 session，配置存在即启用
  app.route('/api/platform/auth/wechat-oa', wechatOaRoutes({
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
    publicOrigin: config.publicOrigin,
    enabledGuestScopes: runtime.enabledGuestScopes,
  }))
```

（若 `runtime` 在登录路由挂载点尚未产出（装配顺序 ⑧ 先于 ⑨），则把本块**下移到 runtime 产出之后**挂载——Hono 路由注册序不影响路径不重叠的路由；在块内注释标明这一顺序约束。）

- [ ] **Step 5: 绿**：`DATABASE_URL=… pnpm --filter @platform/server test` 全绿（含既有 auth-wecom/auth 用例零回归）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/auth-wechat-oa.ts apps/server/src/routes/auth-wechat-oa.test.ts apps/server/src/app.ts
git commit -m "feat(server): wechat-oa 访客登录路——openid 签访客 session（guest 码按已启用模块发放，不建 Casdoor 号）"
```

---

### Task 7: module-protocol.md 回写

**Files:**
- Modify: `docs/module-protocol.md`（「停用语义」节的 userApp ⚠️ 段）

- [ ] **Step 1:** 把「⚠️ 闸门只覆盖模块 API 半边：frontend.userApp 静态未落（存量缺口，本轮不改行为）…休眠中」段替换为：

```markdown
- **userApp 静态已吃同一道启用闸门**（售后 M1，2026-09-15 收口）：`frontend.userApp` 的
  静态目录在 `mountPath + '/*'` 上先挂模块 API 同款 `gate` 再 serveStatic——匿名放行
  （SPA 壳登录前必须可载，业务 API 自会 401/404），**已登录 + 停用 ⇒ 404 与 API 面同形**。
  「停用 = 看不到这个模块」现在在 API 面与 userApp 面两侧同时成立（`/api/platform/config`
  披露面的既有口径不变，见上节 ⚠️）。

- **`guest: { scope }` 声明（售后 spec §1.3 协议小扩展）**：模块可声明自己的访客码
  （`scope` 必须 ∈ `permissions[].code`，schema 拒绝越界）；宿主 `wechat-oa` 访客登录路
  签 session 时按**该租户已启用模块**发放这些码——停用模块的移动端 API 由闸门 404 +
  门卫 403 自然闭合。访客身份不落 Casdoor（外部用户不进内部 IdP）。
```

- [ ] **Step 2: Commit**

```bash
git add docs/module-protocol.md
git commit -m "docs(module-protocol): userApp 停用闸门收口 + guest:{scope} 访客码声明成文（售后 M1 回写）"
```

---

### Task 8: 全量验证 + push + PR

- [ ] **Step 1:** `pnpm test && pnpm typecheck && pnpm build && pnpm --filter @platform/web build && pnpm smoke`（全绿）。
- [ ] **Step 2:** `git push -u origin docs/aftersales-module-spec`。
- [ ] **Step 3:** 开 PR（`#N` = Task 1 编号；title `feat(auth): wechat-oa 访客登录路 + userApp 停用闸门 + guest 码协议（售后 M1） (#N)`；body：内容五点 + 验证清单——真微信往返**没有**测试环境，注明「真机公众号回调待试点配置公众号后补验」，不编）。
- [ ] **Step 4:** 等 CI CLEAN 再请求合并（UNSTABLE 不合；合并后自动部署 + 部署后验证照例）。
