# 平台底座欠账批处理（M1 闭债 R4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉三笔有据可查的底座欠账——已声明 GET 端点在 HEAD 下恒 403、全仓无请求体上限、停用模块的 API 仍可达——并把 R3 终审的 4 条测试保真建议改收口。

**Architecture:** 四处彼此独立的小改动：① 门卫比对把 `HEAD` 归一到 `GET`；② 用现成的 `hono/body-limit` 在 `/api/*` 挂全局上限（登录路保留其更严的有界读取）；③ `mount()` 在挂载模块前挂一道**按租户的启用闸门**，未启用返 404（与既有 404 兜底同形状）；④ 测试替身/注释/用例的保真收口。

**Tech Stack:** TypeScript / Hono 4.13 / PostgreSQL(pg) / vitest / tsx；PG 真跑（非 skip）

## Global Constraints

- Node `>=22`；包管理器 `pnpm@11.22.0`（`package.json` 的 `packageManager`，不要在别处写第二份）
- 本地 PG：`docker compose -f deploy/docker-compose.yml up -d postgres`
  → `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`
- **守卫脚本必须经 `tsx`**：`pnpm exec tsx scripts/<x>.mjs`
- **验收命令必须覆盖本仓 CI 跑的全部命令**——尤其 `pnpm typecheck`（R2 的教训：只跑 smoke 会把 CI 的 gates job 打红）
- ⚠️ **Hono 的两条实测约束**（R2 血泪，别踩）：
  1. **handler 先注册、`use` 后注册 ⇒ 该中间件永不执行**。给模块挂闸门必须在 `app.route(模块)` **之前** `app.use(...)`。
  2. `use('*', mw)` 里 `c.req.routePath` 恒为 `/*`；`use('/x/*', mw)` 能按子树命中。
- **每个新断言必须先跑红**再修（含"删掉修复即变红"的咬合力自检）
- ⚠️ **还原变异别用 `git checkout <file>`**（会冲掉未提交的正当改动）；用精确还原或先 commit
- 提交纪律：可见变更必须在 `CHANGELOG.md` 行内标 **【修复】/【新增】/【优化】**
- 只动各任务 Files 段列出的文件；需要越界 → escalation
- ⚠️ **`CHANGELOG.md` 是共享热文件：T1–T4 一律不动它**（四个并行 worker 都往 `## [Unreleased]`
  顶部插条目必然冲突）。所有 CHANGELOG 条目由 **T5 统一收口**（波次 2，串行在四者之后）。
  T1–T4 的 Files 段里若出现 `CHANGELOG.md`，以本条为准——**不要动它**。

---

### Task 1: `HEAD` 打已声明 GET 端点恒 403（platform-core#7）

**Files:**
- Modify: `packages/platform-sdk/src/module.ts`（`declaredScopeGate`）
- Modify: `packages/platform-sdk/src/test-util/anonymous-probe.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `declaredScopeGate` 的比对语义变更——`HEAD` 按 `GET` 的声明放行

- [ ] **Step 1: 写失败测试**

`packages/platform-sdk/src/test-util/anonymous-probe.test.ts` 追加：

```ts
  it('★ 负例：已声明的 GET 端点，HEAD 请求应同样放行（Hono 按 GET 派发，但 c.req.method 仍是 HEAD）', async () => {
    // 只声明了 GET /ping 的场景见文件顶部 declared
    const anon = await appWith(null).request('/ping', { method: 'HEAD' })
    expect(anon.status).toBe(401) // 匿名仍 401（身份门在 scope 之前）
    const ok = await appWith(['demo:view']).request('/ping', { method: 'HEAD' })
    expect(ok.status).not.toBe(403) // 关键：不得再是 403
  })

  it('★ 负例：归一不得变成"放行一切 HEAD"——未声明 GET 的路径上 HEAD 仍 403', async () => {
    // /notes/:id 只声明了 GET；用一个未声明的路径验证
    const res = await appWith(['demo:view', 'demo:note']).request('/not-declared', { method: 'HEAD' })
    expect(res.status).toBe(403)
  })
```

（若文件顶部的 `declared` 表里 `/ping` 只声明了 GET，则上面第一条成立；否则按实际声明调整路径，但**语义不变**：已声明 GET 的路径 HEAD 放行、未声明的仍 403。）

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/sdk test -- anonymous-probe
```
预期：第一条红在 `expected 403 to be 401`（或第二条的 `not.toBe(403)` 失败）——即 HEAD 现在落进 `!hit` 分支。

- [ ] **Step 3: 门卫归一**

`packages/platform-sdk/src/module.ts` 的 `declaredScopeGate` 里，把查表那一行改掉：

```ts
    // Hono 把 HEAD 当 GET 派发（路由匹配用 GET），但 c.req.method 仍是 'HEAD' ⇒ 不归一会
    // 查不到 (HEAD, path) 而落进 !hit 分支返回 403（已声明 GET 的端点用 HEAD 探活会莫名被拒）。
    // 只把 HEAD 归一到 GET 去**查表**——未声明 GET 的路径照样 !hit ⇒ 403，
    // 绝不等于"放行一切 HEAD"。
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
    const hit = declared.find((d) => d.path === c.req.routePath && d.method === method)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @platform/sdk test
```
预期：全绿，且既有断言强度未变。

- [ ] **Step 5: Commit**

```bash
git add packages/platform-sdk/src/module.ts packages/platform-sdk/src/test-util/anonymous-probe.test.ts
git commit -m "fix(sdk): 已声明 GET 端点的 HEAD 请求不再恒 403（method 归一到 GET 查表）"
```

---

### Task 2: 全仓请求体上限（`hono/body-limit`）

**Files:**
- Modify: `apps/server/src/app.ts`（挂全局中间件）
- Modify: `apps/server/src/routes/auth.ts`（仅在必要时：让 413 形状与全局一致；其 `readBodyBounded` 保留）
- Modify: `apps/server/src/app.test.ts`
（CHANGELOG 由 T5 收口，本任务**不要动**）

**Interfaces:**
- Consumes: `hono/body-limit`（已随 hono 4.13 安装，**不要手搓**）
- Produces: 常量 `MAX_API_BODY_BYTES`（导出，便于测试与将来按路由细化）

- [ ] **Step 1: 写失败测试**

⚠️ **落点注意**：`apps/server/src/app.test.ts` 现在**只测启动期 fail-fast**——它只在失败分支调 `buildApp`，**没有可发请求的 app 实例**，所以不能"沿用它的装配"。本任务需要**真 `buildApp` 出来的 app**（全局中间件挂在 `buildApp` 里，`auth.test.ts` 那种手搭 `makeApp` 不含它）。

在 `apps/server/src/app.test.ts` 里**新增一个 describe**（复用该文件既有的 `mock` 与 `configWith`；mock 的 admin 是 `admin`/`pw`，故 `configWith(mock.origin, 'pw')` 能成功建 app）：

```ts
describe.skipIf(!dbUrl)('buildApp：/api/* 请求体上限', () => {
  const mock2 = new MockCasdoor()
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  beforeAll(async () => {
    await mock2.start()
    const built = await buildApp({ config: { ...configWith(mock2.origin, 'pw'), seedDemo: true } })
    app = built.app
  })
  afterAll(async () => {
    await mock2.stop()
    await getPool({ databaseUrl: dbUrl! }).end().catch(() => {})
  })

  it('★ 负例：超过上限的请求体 ⇒ 413（此前只有登录路有上限，其余 /api/* 全无）', async () => {
    const huge = 'x'.repeat(MAX_API_BODY_BYTES + 1024)
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: JSON.stringify({ username: 'a', password: huge }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('对照：上限内的请求体照常走到业务（证明上一条不是"把 /api 全拒了"）', async () => {
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: JSON.stringify({ username: 'nobody', password: 'x' }),
    })
    expect(res.status).toBe(401) // 坏凭据：证明已进到业务层
  })
})
```

（`MAX_API_BODY_BYTES` 从 `./app` 导入；`getPool` 已在该文件导入。若 `buildApp` 的签名或 `Awaited<…>` 取法与该文件实际不符，以实际为准。）

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- app.test
```
预期：红在 `expected 401 to be 413`（或 500）——超大体被一路读进来，没有上限。

- [ ] **Step 3: 挂全局上限**

`apps/server/src/app.ts`：

```ts
import { bodyLimit } from 'hono/body-limit'

/**
 * 全仓请求体上限（M1 闭债 R4）。此前只有登录路做了有界读取（routes/auth.ts 的
 * readBodyBounded，上限 8192），其余 `/api/*` 端点无任何上限 —— 未认证请求即可用大 body
 * 撑内存。用 hono 自带的 body-limit（不手搓）。
 *
 * 取值理由：本仓已知的最大正当载荷是便签正文 2000 字符（modules/demo 的 MAX_NOTE_LEN），
 * 1 MiB 留出两个数量级余量；将来若出现上传类端点，应**按路由**单列而非抬这个全局值。
 * 登录路自己的 8192 上限更严，仍然生效（它读 body 时走 readBodyBounded）。
 */
export const MAX_API_BODY_BYTES = 1024 * 1024
```

挂载位置：**在租户中间件之前**（拒绝超大载荷不该先花 DB 查询），但在安全头之后：

```ts
  // ④.5 请求体上限：早于租户解析（拒绝超大载荷不应先做 DB 查询）
  app.use('/api/*', bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413),
  }))
```

- [ ] **Step 4: 跑测试确认通过 + 复跑登录路的既有断言**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
```
预期：全绿。**特别核对**：登录路那两条「超长 username/password ⇒ 401 且不调 Casdoor」的既有用例**仍须成立**（它们用的是 300/513 字符，远小于 8 KiB 与 1 MiB，不受影响）；登录路自己的 413（`readBodyBounded`）也仍须成立。

- [ ] **Step 5: Commit**（CHANGELOG 由 T5 收口，本任务不动）

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "fix(server): /api/* 全局请求体上限 1 MiB（登录路更严的上限保留）"
```

---

### Task 3: 停用模块的 API 在请求期返 404（`enabledFor` 语义落地）

**Files:**
- Modify: `apps/server/src/loader.ts`（`mount()` 里挂启用闸门）
- Modify: `apps/server/src/loader.test.ts`
- Modify: `docs/module-protocol.md`（写清该语义）
（CHANGELOG 由 T5 收口，本任务**不要动**）

**Interfaces:**
- Consumes: 既有的 `ModulesRuntime.enabledFor(tenantId): Promise<Set<string>>`
- Produces: 无新导出；`mount()` 行为变更——未启用模块的 API 返 404

**语义（用户已裁决）**：停用 = **该租户看不到这个模块**（路由不存在，404）。不返 403——403 会泄露"模块存在但被停用"。

- [ ] **Step 1: 写失败测试**

`apps/server/src/loader.test.ts` 追加：

```ts
  it('★ 负例：租户停用了某模块 ⇒ 该模块 API 返 404（此前只影响 /config 清单，API 照常可达）', async () => {
    cleanupModules.push('disabledmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'disabledmod', {
      'manifest.yaml': manifestYaml('disabledmod'),
      'index.ts': indexTs('disabledmod', 'disabledmod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const acme = (await pool.query<{ id: number }>("select id from platform.tenant where slug='acme'")).rows[0]!.id
    // 显式停用（enabled=false 行）
    await pool.query(
      'insert into platform.tenant_module(tenant_id, module_id, enabled) values ($1,$2,false)'
      + ' on conflict (tenant_id, module_id) do update set enabled=false',
      [acme, 'disabledmod'],
    )
    cleanupSqls.push(`delete from platform.tenant_module where module_id='disabledmod'`)

    const app = new Hono()
    app.use('*', injectIdentity(['disabledmod:view']))
    runtime.mount(app)
    const res = await app.request('/api/modules/disabledmod/ping')
    expect(res.status).toBe(404)
  })

  it('对照：未停用的模块照常 200（证明上一条不是"闸门把所有模块都关了"）', async () => {
    cleanupModules.push('enabledmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'enabledmod', {
      'manifest.yaml': manifestYaml('enabledmod'),
      'index.ts': indexTs('enabledmod', 'enabledmod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const app = new Hono()
    app.use('*', injectIdentity(['enabledmod:view']))
    runtime.mount(app)
    expect((await app.request('/api/modules/enabledmod/ping')).status).toBe(200)
  })
```

⚠️ 注意：`injectIdentity` 注入的 identity 不带 tenant——启用闸门需要**租户**。若既有 `injectIdentity` 不设 tenant，你需要**另加一个注入租户的中间件**（`c.set('tenant', ...)`）或改造 helper；**先读该文件既有的 `TestEnv` 与 helper 再动手**，并把本任务新增的 helper 与既有风格保持一致。

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @server test -- loader
```
预期：第一条红在 `expected 200 to be 404`（现在停用不影响 API）。

- [ ] **Step 3: 挂启用闸门**

`apps/server/src/loader.ts`：

**① 先把 `enabledFor` 提成 `return` 之前可见的局部函数**（现在它是返回对象字面量里的一个方法，`mount` 里取不到）：

```ts
  // 供 mount 内的启用闸门与返回对象的 enabledFor 共用（同一份语义，别写两遍）
  const enabledForImpl = async (tenantId: number): Promise<Set<string>> => {
    const { rows } = await deps.pool.query<{ module_id: string; enabled: boolean }>(
      'select module_id, enabled from platform.tenant_module where tenant_id = $1',
      [tenantId],
    )
    const explicit = new Map(rows.map((r) => [r.module_id, r.enabled]))
    const enabled = new Set<string>()
    for (const m of loaded) {
      if (explicit.get(m.manifest.id) ?? true) enabled.add(m.manifest.id)
    }
    return enabled
  }
```

返回对象里改成 `enabledFor: enabledForImpl,`（原方法体删除，语义不变）。

**② `mount(app)` 内，在 `app.route(...)` 之前**挂闸门——**顺序是关键**（Hono 里 handler 先注册会让后加的中间件**永不执行**，R2 实证过）：

```ts
    mount(app: Hono): void {
      for (const m of loaded) {
        const base = moduleApiBasePath(m.manifest.id)

        // ⑦.5 启用闸门（M1 闭债 R4）：停用 = 该租户看不到这个模块 ⇒ **404**（不是 403，
        //      403 会泄露"模块存在但被停用"）。**必须 use 在 app.route 之前**（见上）。
        //      代价：每请求一次 enabledFor 查询（+1 次 DB 往返）。**刻意不做缓存**——
        //      「停用后多久生效」不该有一个隐式窗口；将来若测出瓶颈要加 TTL，
        //      必须同时把窗口语义写进本注释与 docs/module-protocol.md。
        const gate = async (c: Context, next: Next) => {
          const t = c.get('tenant') as { id: number } | undefined
          // 无租户上下文（未过租户中间件，如 /healthz 一类）不在本闸门职责内，放行给后续层
          if (!t) return next()
          const enabled = await enabledForImpl(t.id)
          if (!enabled.has(m.manifest.id)) {
            return c.json({ error: 'NOT_FOUND' }, 404) // 与既有 /api 未命中兜底同形状（动手前先核对面形状）
          }
          await next()
        }
        app.use(base + '/*', gate)   // **只挂这一条**：`/*` 吞空段，同时命中 /api/modules/<id>、
                                     // /api/modules/<id>/、/api/modules/<id>/ping（R4 评审 S4 实测）。
                                     // 旧稿另挂一条精确 `use(base)`——那是**冗余**（只让裸 base 的请求
                                     // 多跑一次 enabledFor = 多一次 DB 往返），已删，见 loader.ts ⑥.5。

        app.route(base, m.router)
        /* 其余（userApp 静态等）原样不动 */
      }
    },
```

（`Context` / `Next` 从 `hono` 导入；若该文件已有等价类型别名则复用。`c.get('tenant')` 的实际形状以 `apps/server/src/tenant.ts` 的 `TenantEnv` 为准——**动手前先读它**，别照抄这里的 `{ id: number }`。）

⚠️ **实测要件（R4 评审 S4 后收敛为一条）**：~~①~~ **只挂 `use(base + '/*')` 一条就够**——`/*` 吞空段，`/api/modules/x`、`/api/modules/x/`、`/api/modules/x/ping` 三种请求**都被闸住**（实测；旧稿要求"精确路径与子树**都**生效"并据此加一条精确注册，那是**冗余**，已按实测订正）。仍需用探针钉住的只剩一件：**闸门先于模块路由执行**（即上面那个注册顺序是真的）——顺序错了闸门**永不执行**。

- [ ] **Step 4: 跑测试确认通过**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
pnpm smoke   # 需先 pnpm --filter @platform/web build；seed 的 acme/beta 都未显式停用 ⇒ 应仍全绿
```
预期：全绿（既有模块用例都不停用模块 ⇒ 行为不变）。

- [ ] **Step 5: 文档 + Commit**（CHANGELOG 由 T5 收口，本任务不动）

`docs/module-protocol.md` 的规则段补一条：

```markdown
## 停用语义：停用 = 该租户看不到这个模块

`platform.tenant_module.enabled=false` ⇒ **该租户的这条模块 API 一律 404**（不是 403：
403 会泄露"模块存在但被停用"）。闸门按**租户**在请求期判定，与 `/config` 的清单闸门同源。
```

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts docs/module-protocol.md
git commit -m "fix(loader): 停用模块的 API 在请求期返 404（enabledFor 语义落地）"
```

---

### Task 4: R3 终审的 4 条测试保真建议改

**Files:**
- Modify: `packages/auth-core/src/test-util/mock-casdoor.ts`
- Modify: `packages/auth-core/src/casdoor-client.ts`（仅注释）
- Modify: `packages/auth-core/src/test-util/mock-casdoor.test.ts`
- Modify: `packages/auth-core/src/casdoor-client.test.ts`
- Modify: `apps/server/src/routes/auth.test.ts`
- Modify: `apps/server/src/session-middleware.ts`（**仅加可选的 `now?: () => number` 测试缝**，默认 `Date.now`，零行为变更——协调者裁定：与 `createLoginLimiter({ now })` 同款先例；**不用** `vi.useFakeTimers()`，因为该用例要跑真 PG + 真 HTTP，全局假时钟与真实 I/O 混用是 flaky/挂起来源）

**Interfaces:** 无对外接口变更（除 mock 的行为修正）

- [ ] **Step 1: mock 的 id 校验对齐真机（含空段的**两段** id 真机也接受）**

R3 终审 + R4 评审实测真机：`id=/admin`、`id=built-in/`、`id=/` 全回 `200 {status:'ok',data:null}`；**空 id 同样是 `200 {status:'ok',data:null}`**（R4 评审探针：`--data-urlencode "id="` / 不带 id 形参 / 裸 `?id=` 三态同形）；只有**段数≠2**（`noSlashId`、`built-in/admin/extra`）才回 `wrong token count`。
⇒ mock 现在把含空段的两段也判非法，**方向与真机相反**；且空 id 在旧实现里走 split ⇒ `['']` ⇒ `len!==2` ⇒ 报错，**也是相反**（只改 `!parts[0] || !parts[1]` 会漏掉这一格，因为它在旧实现里本就是 error、看起来"没变过"——R4 评审 must-fix 1）。

改 `mock-casdoor.ts` 的 get-user 全形校验为：

```ts
      const rawId = c.req.query('id') ?? ''
      // 真机规则（sso.hookflow.cn 实测）：空 id 短路成 ok+null；**段数≠2** 才报
      // wrong token count；两段（哪怕含空段）一律进查找。旧实现把含空段的两段也判非法，
      // 方向与真机相反（R3 终审指出，客户端不可触达但属同一族"替身与真身不一致"）。
      if (rawId === '') return c.json({ status: 'ok', data: null })
      const parts = rawId.split('/')
      if (parts.length !== 2) {
        return c.json({ status: 'error', msg: 'wrong token count, expect <org>/<name>' })
      }
```

配一条断言（`mock-casdoor.test.ts`）：`id=/admin` → `ok+null`；`id=built-in/admin/extra` → `wrong token count`。

- [ ] **Step 2: `setGetUserFault` 的注释收窄**

它现在只在"用户存在"时生效（因为命中序在会话门之前，与真机一致）。把 `mock-casdoor.ts` 里该 API 与其使用点的注释改成**只声称它模拟"会话失效/未授权"这一种口味**，不再暗示它能模拟上游内部错。

- [ ] **Step 3: 未授权文案按端点区分**

真机：`get-user` 会话失效回 `Please login first`；`get-permissions` 回 `Unauthorized operation`。mock 现在共用一句。⇒ 按端点分文案（客户端不按文案分支，纯保真）。

- [ ] **Step 4: 两条窗口用例去墙钟依赖**

`apps/server/src/routes/auth.test.ts` 与 `packages/auth-core/src/casdoor-client.test.ts` 里那两条"窗口随时间重开"的用例现在靠真实 `setTimeout(250ms)`。给 `sessionMiddleware` / `CasdoorClient` 加可注入的 `now?: () => number`，用例改为手动推进时间；**保留**原有的两条"窗口=0 ⇒ 不是闩"的用例（它们证明的是另一件事）。

- [ ] **Step 5: 全量验收 + Commit**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs \
  && pnpm exec tsx scripts/check-compose.mjs && pnpm exec tsx scripts/check-env-example.mjs
```
预期：全绿。

```bash
git add -A && git commit -m "test(auth-core): R3 终审建议改——mock 空段 id 对齐真机 + 文案分端点 + 窗口用例去墙钟依赖"
```

---

### Task 5: CHANGELOG 统一收口（波次 2，deps = T1–T4）

**Files:**
- Modify: `CHANGELOG.md`

**为什么单独一条**：`CHANGELOG.md` 是四个并行任务都要碰的共享热文件（都往 `## [Unreleased]`
顶部插条目 ⇒ 必然冲突）。按纪律可见变更必须行内标注，故不能不做——只能**串行收口**。

- [ ] **Step 1: 逐条对照实现写条目**

先 `git log --oneline <本轮的集成分支> ^origin/main` 看清本轮实际落了哪些提交，**逐条对照实现**
（不是对照本计划——R2/R3 的教训：计划与实现在 7 处以上不符，以实现为准）。

```markdown
### Fixed - M1 闭债 R4：平台底座欠账批处理

- 【修复】**已声明的 GET 端点在 HEAD 请求下恒 403**：Hono 把 HEAD 当 GET 派发（路由匹配用 GET），
  但 `c.req.method` 仍是 `'HEAD'` ⇒ 门卫查不到 `(HEAD, path)` 而落进 fail-closed 分支返 403。
  改为查表前把 HEAD 归一到 GET（**未声明 GET 的路径照样 403**，不等于放行一切 HEAD）
- 【修复】**全仓请求体上限缺失**：此前只有登录路做了有界读取（8192），其余 `/api/*` 端点无任何
  上限，未认证请求即可用大 body 撑内存。改用 hono 自带的 `body-limit` 在 `/api/*` 挂 1 MiB
  （登录路更严的 8192 仍生效），超限返 `413 {error:'PAYLOAD_TOO_LARGE'}`
- 【修复】**停用模块的 API 此前照常可达**：`loader.mount()` 从不查 `enabledFor` ⇒ 租户停用某模块后
  其接口仍可用（只受 scope 约束），而 `/config` 里已把它摘掉。改为在挂载时按租户挂**启用闸门**，
  未启用返 **404**（停用 = 该租户看不到这个模块；不用 403 以免泄露其存在）
- 【优化】**测试替身保真**（R3 终审建议改）：mock 的 `get-user` 不再把含空段的两段 id 判非法
  （真机只按段数拒）、未授权文案按端点区分、两条限流窗口用例去掉真实墙钟依赖
```

- [ ] **Step 2: 全量门禁 + Commit**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs \
  && pnpm exec tsx scripts/check-compose.mjs && pnpm exec tsx scripts/check-env-example.mjs
pnpm --filter @platform/web build && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 收口 M1 闭债 R4（HEAD/请求体上限/停用模块语义/替身保真）"
```

---

## 完成判据

1. `pnpm test` 全绿且 PG 用例真跑（非 skip）；`pnpm typecheck` EXIT 0；四个守卫绿；`pnpm smoke` 绿
2. 四个任务各自的新断言**先在改动前跑红**，红态原文进报告
3. Task 2/3 的实测探针输出（body 上限生效、闸门两种路径都命中、闸门先于模块路由）进报告
4. 每个任务一条 commit，均带 `X-Issue: 3` trailer

## 本计划不做（下一轮）

- issue #3 第四节剩的 3 条：`branding.background` 渲染语义（要定 default 视觉与 URL 的 cover/contain）、`/healthz` vs `/readyz` 拆分口径、`getPermissions` 翻页
- dev-workflow-infra#80（trailer 取值，属另一仓）
- issue #3 第五节其余工程 Minor
