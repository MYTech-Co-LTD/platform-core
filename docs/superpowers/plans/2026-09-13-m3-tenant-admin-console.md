# M3 租户管理员后台（console 三张页 + 代理锁 org + tenant:admin 门禁）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租户管理员在 platform-core console 自建页管理本租户用户、权限码授权、查看订阅——后端代理 Casdoor Admin API 并**锁死 org=本租户**，全部门禁 `tenant:admin`（spec D4/D9）。

**Architecture:** 后端新增 `routes/admin.ts`（挂 `/api/platform/admin`，`requireScope('tenant:admin')` 整路由门禁 + 写操作 CSRF 校验，org 永远取自 `c.get('tenant').casdoor_org`、不接受请求参数）；auth-core CasdoorClient 扩用户与授权方法（沿用 `#adminJson` 通道与既有铁律：写后回读、delete 走 JSON body）；loader 把平台内置码 `tenant:admin` 并入权限码扇出。前端不动 registry 聚合机制，在 `console-menu.ts` 位置规则上加「管理」组（scope 门禁），`App.tsx` 加三条固定子路由 + 403 门禁。

**Tech Stack:** Hono 4 / pg / @platform/auth-core（CasdoorClient）/ @platform/sdk（requireScope）/ React 19 + antd 6 + @ant-design/pro-components 3 / vitest。

**Spec:** `docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md`（D4 双层、D9 tenant:admin、§5 M3 行）。**本计划 Task 1 先落一条 spec 修订**（授权口径=权限码↔用户直挂，Casdoor Role 组管理不在 M3）。

## Global Constraints

- 提交规范：Conventional Commits `type(scope): subject`；feat/fix 必须挂 issue；一切可见变更走 PR、squash 合并。
- 全部测试绿 + `pnpm typecheck` 绿才算任务完成；波末跑**全量**（`pnpm test` + `pnpm typecheck` + `pnpm -C apps/web build`）。
- Casdoor 三条铁律（spec §4.1，实测）：① 时间一律 RFC3339 UTC；② delete 类端点一律 JSON body `{owner,name}`；③ 每次写后回读验证。
- 用户名仅字母数字（`^[A-Za-z0-9]+$`，实测 Casdoor 拒绝 `_`）。
- 锚用户 `tenantsub` 对租户管理员**不可见、不可改、不可删、不可授权**（spec §6.2）。
- 敏感值不落日志/audit：初始密码、重置密码**不写** audit detail、不打 console.log。
- 前端零新增依赖；表格用 antd `Table`（仓内首个用例，勿引 ProTable）；图标名必须登记进 `Console.tsx` 的 `CONSOLE_ICONS` 才会渲染。
- 执行分支：`feat/m3-tenant-admin-console`，基于**最新 origin/main**（先 `git fetch origin main` 再切，多 worktree 教训）。

## 波次（并行派发时遵守；波内不得改同一文件）

- **Wave 1**（三路互不相碰）：Task 1（spec 文档）、Task 2（auth-core listUsers）、Task 5（loader D9）。
- **Wave 2**（串行链 A：同一对 auth-core 文件）：Task 3 → Task 4。可与 Task 9（前端菜单/路由，不同文件集）并行。
- **Wave 3**（串行链 B：同一对 admin 路由文件）：Task 6 → Task 7 → Task 8；可与 Task 10 前置的 lib/api.ts 改动错峰（Task 10 整体在 Task 9 后串行最稳）。
- **Wave 4**：Task 11 全量验证；Task 12 部署验收（合并后）。

> 单会话顺序执行时按 Task 编号 1→10 线性走即可，上面的波次只在多 worker 派发时生效。

---

### Task 1: M3 跟踪 issue + spec 修订（授权口径）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md`

**Interfaces:**
- Produces: M3 跟踪 issue 号（后续所有 feat 提交的 `(#N)` 引用）；spec §6/§8 修订行。

- [ ] **Step 1: 建 M3 跟踪 issue**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "M3 租户管理员后台：console 三张页 + Casdoor 代理锁 org + tenant:admin 门禁" \
  --body "spec D4/D9（2026-09-13 双层修订）。范围：auth-core 用户/授权方法扩展、loader 内置码扇出、/api/platform/admin/* 代理路由、console「管理」组三张页（用户管理/角色与授权/我的订阅只读）。验收见 spec §5 M3 行。"
```

记下 issue 号（下文记为 `#N`）。

- [ ] **Step 2: spec 修订**

`docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md` 的 §6 已知边界追加一条（编号顺延）：

```markdown
7. M3「角色与授权」页口径（2026-09-13 补）：授权 = **权限码 ↔ 用户直挂**（与
   effectiveScopes 的 matchUser 语义一致，含 `tenant:admin` 自身的授予/回收 = 管理员交接）。
   Casdoor Role 组管理不在 M3（那是平台超管在 Casdoor 后台的事）；将来要做角色组再扩。
```

§8 修订记录追加：

```markdown
- 2026-09-13（夜）：M3 计划落盘（`plans/2026-09-13-m3-tenant-admin-console.md`），补 M3
  授权页口径（码↔用户直挂，角色组不做）。
```

- [ ] **Step 3: Commit**

```bash
git checkout -b feat/m3-tenant-admin-console origin/main
git add docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md
git commit -m "docs(specs): M3 授权页口径——权限码与用户直挂，角色组不做 (#N)"
```

---

### Task 2: auth-core `listUsers`

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`（`listSubscriptions` 方法之后插入）
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Produces: `CasdoorClient.listUsers(): Promise<CasdoorListedUser[]>`；`export interface CasdoorListedUser { name: string; displayName: string; isForbidden: boolean }`（只列本 client 的 org）。

- [ ] **Step 1: 写失败测试**（追加到 casdoor-client.test.ts；mock fetch 的既有夹具照抄同文件其他用例——`ok()` 辅助按本文件既有写法）

```ts
test('listUsers 返回本 org 用户并解析三个字段', async () => {
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'GET /api/get-users?owner=myorg': ok({
      status: 'ok',
      data: [
        { name: 'alice', displayName: 'Alice', isForbidden: false },
        { name: 'bob', displayName: 'Bob', isForbidden: true },
      ],
    }),
  })
  const users = await client.listUsers()
  expect(users).toEqual([
    { name: 'alice', displayName: 'Alice', isForbidden: false },
    { name: 'bob', displayName: 'Bob', isForbidden: true },
  ])
})

test('listUsers 上游 error 抛错不静默空表', async () => {
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'GET /api/get-users?owner=myorg': ok({ status: 'error', msg: 'bad row' }),
  })
  await expect(client.listUsers()).rejects.toThrow('casdoor get-users')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: FAIL（`listUsers is not a function`）。`makeClient` 夹具不存在时先照同文件既有 mock fetch 模式补一个最小版（org 固定 `myorg`）。

- [ ] **Step 3: 实现**

```ts
/** listUsers 的返回形状（M3 spec D4：租户管理员用户管理页数据源） */
export interface CasdoorListedUser {
  name: string
  displayName: string
  isForbidden: boolean
}

// CasdoorClient 类内：
/** 列本 org 全量用户（admin 会话）。error 一律抛（与 listSubscriptions 同口径）。 */
async listUsers(): Promise<CasdoorListedUser[]> {
  const j = await this.#adminJson(`get-users?owner=${encodeURIComponent(this.#o.org)}`)
  if (j.status !== 'ok') throw new Error(`casdoor get-users: ${j.msg || 'error'}`)
  if (!Array.isArray(j.data)) return []
  return (j.data as Array<Record<string, unknown>>).map((u) => ({
    name: String(u.name ?? ''),
    displayName: typeof u.displayName === 'string' && u.displayName ? u.displayName : String(u.name ?? ''),
    isForbidden: u.isForbidden === true,
  })).filter((u) => u.name !== '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/auth-core/src/casdoor-client.ts packages/auth-core/src/casdoor-client.test.ts
git commit -m "feat(auth-core): CasdoorClient.listUsers 列本 org 用户 (#N)"
```

---

### Task 3: auth-core 用户生命周期（建/禁启/重置密码/删）

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Consumes: `#adminJson`、`getUser`（add 竞态回读，ensureUser 同款）。
- Produces:
  - `createManagedUser(input: { name: string; displayName?: string; password: string }): Promise<void>`
  - `setUserForbidden(name: string, forbidden: boolean): Promise<void>`
  - `resetUserPassword(name: string, password: string): Promise<void>`
  - `deleteUser(name: string): Promise<void>`
  - 私有 `#getRawUser(name): Promise<Record<string, unknown> | null>`（get-user 原始记录，update 前取全量防字段被洗）

- [ ] **Step 1: 写失败测试**

```ts
test('createManagedUser 建号后回读验证（铁律③）', async () => {
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'POST /api/add-user': ok({ status: 'ok' }),
    'GET /api/get-user?id=myorg%2Fcarol': ok({ status: 'ok', data: { name: 'carol' } }),
  })
  await client.createManagedUser({ name: 'carol', displayName: 'Carol', password: 'InitPass123' })
})

test('deleteUser 走 JSON body {owner,name}（铁律②）并回读验证', async () => {
  const seen: unknown[] = []
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'POST /api/delete-user': async (_req: Request, body: unknown) => {
      seen.push(body)
      return ok({ status: 'ok' })
    },
    'GET /api/get-user?id=myorg%2Fdave': ok({ status: 'ok', data: null }),
  })
  await client.deleteUser('dave')
  expect(seen).toEqual([{ owner: 'myorg', name: 'dave' }])
})

// ⚠️ 订正（issue #119，2026-09-22）：本 Step 里 `resetUserPassword 取全量记录改密再 update`
// 的那段**测试与实现都已作废**——真机 update-user 的列白名单不含 password（object.UpdateUser，
// v1.0.0→master 8 版一致）⇒ 那样改密是**静默空操作**（回 ok、旧密码照旧可用）。现行口径：
// `POST /api/set-password`（form-urlencoded，服务端哈希、不删号）+ 前置校验 org 的 passwordType
// + 写后回读 user 的 passwordType。**以 `packages/auth-core/src/casdoor-client.ts` 的现行实现与
// `.superpowers/sdd/issue-119-research.md` 为准，不要照抄下面的范文块**（本仓原则：计划订正只落
// 边界注记，不改写历史范文——照抄就会原地复发缺陷）。
test('resetUserPassword 取全量记录改密再 update（防字段被洗）', async () => {
  const bodies: unknown[] = []
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'GET /api/get-user?id=myorg%2Feve': ok({
      status: 'ok',
      data: { name: 'eve', displayName: 'Eve', type: 'normal-user', signupApplication: 'app-built-in' },
    }),
    'POST /api/update-user': async (_req: Request, body: unknown) => {
      bodies.push(body)
      return ok({ status: 'ok' })
    },
    // 回读（铁律③）走同一 get-user（密码字段 mock 里无意义，只验流程通）
  })
  await client.resetUserPassword('eve', 'NewPass456')
  const b = bodies[0] as Record<string, unknown>
  expect(b.password).toBe('NewPass456')
  expect(b.displayName).toBe('Eve') // 既有字段原样带回
})
```

（`setUserForbidden` 同款两条：置 true / 置 false，断言 update body 的 `isForbidden`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**（类内新增；注释口径照抄 ensureUser / #upsertOne 的既有写法）

```ts
/** 取单用户原始记录（admin 会话）。update-* 是整记录替换——改一个字段必须先取全量带回。 */
async #getRawUser(name: string): Promise<Record<string, unknown> | null> {
  const j = await this.#adminJson(`get-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`)
  if (j.status !== 'ok') throw new Error(`casdoor get-user: ${j.msg || 'error'}`)
  const u = j.data as Record<string, unknown> | null | undefined
  return u && typeof u === 'object' && u.name ? u : null
}

/** 建可登录用户（M3 用户管理页）。add 竞态与 ensureUser 同口径：失败重读，人在即成功。 */
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

/** 禁用/启用（isForbidden）。整记录替换：先取全量，只改 isForbidden 再 update，写后回读。 */
async setUserForbidden(name: string, forbidden: boolean): Promise<void> {
  const raw = await this.#requireRawUser(name)
  const j = await this.#adminJson(`update-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`, {
    method: 'POST',
    body: { ...raw, isForbidden: forbidden },
  })
  if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
}

/** 重置密码。同整记录替换口径；密码不进任何日志。 */
// ⚠️ 订正（issue #119）：此实现已作废——见上一条注记（update-user 改不动 password，改走 set-password）。
async resetUserPassword(name: string, password: string): Promise<void> {
  const raw = await this.#requireRawUser(name)
  const j = await this.#adminJson(`update-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`, {
    method: 'POST',
    body: { ...raw, password },
  })
  if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
}

/** 删用户（铁律②：delete 一律 JSON body {owner,name}；铁律③：删后回读应不存在）。 */
async deleteUser(name: string): Promise<void> {
  const j = await this.#adminJson('delete-user', {
    method: 'POST',
    body: { owner: this.#o.org, name },
  })
  if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
  const back = await this.#getRawUser(name)
  if (back !== null) throw new Error(`casdoor delete-user: 删后回读仍存在 ${this.#o.org}/${name}`)
}

async #requireRawUser(name: string): Promise<Record<string, unknown>> {
  const raw = await this.#getRawUser(name)
  if (!raw) throw new Error(`casdoor: 用户不存在 ${this.#o.org}/${name}`)
  return raw
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/auth-core/src/casdoor-client.ts packages/auth-core/src/casdoor-client.test.ts
git commit -m "feat(auth-core): 用户生命周期方法——建/禁启/重置密码/删（铁律②③内建）(#N)"
```

---

### Task 4: auth-code 权限码授权（grant/revoke）

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Consumes: `#permissionsRaw()`（查重判据 resources 含 code，与 #upsertOne 同源）、`bindUserToAllPermissions` 的 update body 形状。
- Produces:
  - `grantPermissionToUser(code: string, userName: string): Promise<void>`（幂等：已挂直接返回）
  - `revokePermissionFromUser(code: string, userName: string): Promise<void>`（幂等：本就没挂直接返回；短名/全形都清）

- [ ] **Step 1: 写失败测试**

```ts
test('grantPermissionToUser 追加全形 org/user 并保留既有配额', async () => {
  const bodies: unknown[] = []
  const client = makeClient({
    'POST /api/login': ok({ status: 'ok', data: 'org-admin' }),
    'GET /api/get-permissions?owner=myorg&pageSize=100': ok({
      status: 'ok',
      data: [{ name: 'demo-view', displayName: '演示查看', resources: ['demo:view'], users: ['myorg/bob'], roles: [], model: 'built-in/user-model-built-in', actions: ['Read'], isEnabled: true }],
    }),
    'POST /api/update-permission': async (_req: Request, body: unknown) => {
      bodies.push(body)
      return ok({ status: 'ok' })
    },
    // 写后回读（铁律③）：users 已含新成员
    'GET /api/get-permissions?owner=myorg&pageSize=100#2': ok({
      status: 'ok',
      data: [{ name: 'demo-view', resources: ['demo:view'], users: ['myorg/bob', 'myorg/alice'] }],
    }),
  })
  await client.grantPermissionToUser('demo:view', 'alice')
  const b = bodies[0] as Record<string, unknown>
  expect(b.users).toEqual(['myorg/bob', 'myorg/alice']) // 全形追加、既有保留
  expect(b.resources).toEqual(['demo:view'])
})

test('revokePermissionFromUser 短名与全形都清、幂等', async () => {
  // 第一轮：users=['myorg/bob','myorg/alice'] revoke('demo:view','alice') → 剩 ['myorg/bob']
  // 第二轮：对不存在挂载 revoke → 不发 update、直接返回（断言 update 调用次数=1）
})
```

（第二条测试补全 mock 与断言，形状同上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
/** 按 resources 含 code 找权限原始记录（判据与 #upsertOne / 读侧 normalizeScopes 同源） */
async #findPermissionByCode(code: string): Promise<Record<string, unknown>> {
  const list = await this.#permissionsRaw()
  const hit = list.find((p) => Array.isArray(p.resources) && (p.resources as string[]).includes(code))
  if (!hit) throw new Error(`casdoor: org ${this.#o.org} 不存在权限码 ${code}（先跑装载器供给）`)
  return hit
}

/** 授权：把用户挂到权限码（users 追加 `org/user` 全形——effectiveScopes matchUser 双形态可命中） */
async grantPermissionToUser(code: string, userName: string): Promise<void> {
  const p = await this.#findPermissionByCode(code)
  const users = (p.users as string[] | undefined) ?? []
  const full = `${this.#o.org}/${userName}`
  if (users.includes(userName) || users.includes(full)) return // 幂等
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
  const back = await this.#findPermissionByCode(code) // 铁律③
  const bu = (back.users as string[] | undefined) ?? []
  if (!bu.includes(userName) && !bu.includes(full)) {
    throw new Error(`casdoor: 授权写后回读未命中 ${code} ← ${userName}`)
  }
}

/** 回收：短名与 `org/user` 全形一并清（历史数据两种形态都可能存在） */
async revokePermissionFromUser(code: string, userName: string): Promise<void> {
  const p = await this.#findPermissionByCode(code)
  const users = (p.users as string[] | undefined) ?? []
  const kept = users.filter((u) => u !== userName && u !== `${this.#o.org}/${userName}`)
  if (kept.length === users.length) return // 幂等：本就没挂
  const body = { /* 与 grant 同形状，users: kept */ }
  const j = await this.#adminJson(
    `update-permission?id=${encodeURIComponent(`${this.#o.org}/${String(p.name)}`)}`,
    { method: 'POST', body },
  )
  if (j.status && j.status !== 'ok') throw new Error(`casdoor: ${j.msg || 'error'}`)
}
```

（body 字面量按 grant 同款补全，勿抽公共函数跨语义复用——两处各 12 行，读起来比间接层清楚。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C packages/auth-core test -- casdoor-client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/auth-core/src/casdoor-client.ts packages/auth-core/src/casdoor-client.test.ts
git commit -m "feat(auth-core): 权限码 grant/revoke——users 全形挂载、双形态回收、写后回读 (#N)"
```

---

### Task 5: loader 平台内置码 `tenant:admin` 扇出（D9）

**Files:**
- Modify: `apps/server/src/loader.ts`（⑤ 权限码供给处，~L288）
- Test: `apps/server/src/loader.test.ts`

**Interfaces:**
- Produces: `export const PLATFORM_BUILTIN_PERMISSIONS: ReadonlyArray<{ code: string; name: string }>`（含 `{ code: 'tenant:admin', name: '租户管理员' }`）；装载时并入 `allPermissions` **最前**（零模块也要供给）。

- [ ] **Step 1: 写失败测试**（loader.test.ts 既有 provision 用例旁追加；fake casdoorFor 照同文件既有夹具）

```ts
test('零模块也供给平台内置码 tenant:admin（D9）', async () => {
  const { casdoorFor, granted } = makeFakeCasdoor() // granted: Map<org, {code,name}[]>
  await loadModules(emptyModulesDir, { pool: fakePool, casdoorFor })
  expect(granted.get('myorg')).toContainEqual({ code: 'tenant:admin', name: '租户管理员' })
})

test('模块码与内置码一起扇出到每个租户 org', async () => {
  const { casdoorFor, granted } = makeFakeCasdoor()
  await loadModules(demoModulesDir, { pool: fakePool, casdoorFor })
  expect(granted.get('myorg')).toContainEqual({ code: 'demo:view', name: '演示查看' })
  expect(granted.get('myorg')).toContainEqual({ code: 'tenant:admin', name: '租户管理员' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- loader`
Expected: FAIL

- [ ] **Step 3: 实现**

loader.ts 顶部（provisionModulePermissions 定义之前）：

```ts
/**
 * 平台内置权限码（spec D9）：不来自任何模块 manifest，随装载器按租户 org 扇出供给。
 * `tenant:admin` = 租户管理员识别——console「管理」菜单组与 /api/platform/admin/* 的门禁。
 * 授权动作在 Casdoor 完成（给用户挂码）；授予/回收的 UI 在 M3 授权页。
 */
export const PLATFORM_BUILTIN_PERMISSIONS = [
  { code: 'tenant:admin', name: '租户管理员' },
] as const
```

⑤ 处改为：

```ts
// ⑤ 权限码供给：平台内置码（D9）+ 全部模块码，一起供给到每个租户各自的 org。
//    内置码在前：即使零模块（modules/ 空）tenant:admin 也要供给——管理员门禁不依赖业务模块。
const allPermissions: ReadonlyArray<ProvisionPermission> = [
  ...PLATFORM_BUILTIN_PERMISSIONS,
  ...loaded.flatMap((m) => m.manifest.permissions),
]
```

（`if (permissions.length === 0) return []` 的早退保持不动——现在只有零租户才会走到。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- loader`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts
git commit -m "feat(loader): 平台内置码 tenant:admin 随装载扇出到每个租户 org（D9）(#N)"
```

---

### Task 6: `routes/admin.ts` 骨架 + 门禁 + 用户端点

**Files:**
- Create: `apps/server/src/routes/admin.ts`
- Test: `apps/server/src/routes/admin.test.ts`

**Interfaces:**
- Consumes: `requireScope`（@platform/sdk）、`CasdoorFactory`/`SessionEnv`（session-middleware）、`TenantEnv`、`csrfToken`（@platform/auth-core）、Task 2/3 客户端方法。
- Produces: `adminRoutes(deps: AdminRoutesDeps): Hono<TenantEnv & SessionEnv>`；`export interface AdminRoutesDeps { casdoor: CasdoorFactory; sessionSecret: string; pool: Pool; permissions: () => ReadonlyArray<{ code: string; name: string }> }`。端点契约（Task 7/9/10 消费）：
  - `GET /users` → `{ users: Array<{ name: string; displayName: string; isForbidden: boolean }> }`（`tenantsub` 已滤除）
  - `POST /users` body `{ username, displayName?, password }` → 201 `{ name }`；用户名非字母数字或密码 <8 位 → 400 `{error:'INVALID'}`
  - `PATCH /users/:name` body `{ isForbidden: boolean }` → 200 `{ name }`
  - `PATCH /users/:name/password` body `{ password }` → 200 `{ name }`
  - `DELETE /users/:name` → 200 `{ name }`；删自己/删 `tenantsub` → 400 `{error:'FORBIDDEN_TARGET'}`

- [ ] **Step 1: 写失败测试**（新文件 admin.test.ts；Hono app 用 `app.route('/api/platform/admin', adminRoutes(deps))` 挂载，fake casdoor 记录调用；identity 中间件用测试内 `createMiddleware` 直塞——照 app.test.ts 既有注入式写法）

```ts
const base = { sessionSecret: 'x'.repeat(32), pool: fakePool, permissions: () => [{ code: 'tenant:admin', name: '租户管理员' }, { code: 'demo:view', name: '演示查看' }] }

test('无 tenant:admin scope → 403 FORBIDDEN need=tenant:admin', async () => {
  const app = mount(adminRoutes({ ...base, casdoor: fakeCasdoor }), { scopes: ['demo:view'] })
  const res = await app.request('/api/platform/admin/users')
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'tenant:admin' })
})

test('GET /users 过滤锚用户 tenantsub', async () => {
  const casdoor = fakeCasdoorWithUsers([
    { name: 'tenantsub', displayName: 'Tenant Subscription Anchor', isForbidden: true },
    { name: 'alice', displayName: 'Alice', isForbidden: false },
  ])
  const app = mount(adminRoutes({ ...base, casdoor }), { scopes: ['tenant:admin'] })
  const res = await app.request('/api/platform/admin/users')
  expect(await res.json()).toEqual({ users: [{ name: 'alice', displayName: 'Alice', isForbidden: false }] })
})

test('POST /users 校验：用户名仅字母数字、密码≥8', async () => {
  const app = mount(adminRoutes({ ...base, casdoor: fakeCasdoor() }), { scopes: ['tenant:admin'] })
  expect((await app.request('/api/platform/admin/users', { method: 'POST', body: JSON.stringify({ username: 'bad_name', password: 'LongEnough1' }), headers: json() })).status).toBe(400)
  expect((await app.request('/api/platform/admin/users', { method: 'POST', body: JSON.stringify({ username: 'okname', password: 'short' }), headers: json() })).status).toBe(400)
})

test('写操作缺 x-csrf-token → 403 CSRF', async () => { /* DELETE /users/bob 无 header → 403 {error:'CSRF'} */ })

test('DELETE /users/tenantsub 与删自己 → 400 FORBIDDEN_TARGET', async () => { /* 两条断言 */ })

test('成功路径写 audit（action=admin.user.create 等，detail 无密码明文）', async () => { /* fakePool 记录 insert 语句参数断言 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- admin`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 admin.ts**

```ts
// routes/admin.ts — /api/platform/admin/*：租户管理员代理（spec D4/D9，M3）
//
// 三条结构锁死，不靠约定：
//  ① org 永远取自 c.get('tenant').casdoor_org——请求参数里没有任何能改变 org 的口子；
//  ② 整路由 requireScope('tenant:admin')——未挂码者连路由形状都探不到；
//  ③ 写操作（POST/PATCH/DELETE）校验 x-csrf-token（与 /logout 同款，防跨站强制管理）。
// 锚用户 tenantsub 不可见/不可改/不可删/不可授权（spec §6.2）。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken } from '@platform/auth-core'
import { requireScope } from '@platform/sdk'
import type { TenantEnv } from '../tenant'
import type { CasdoorFactory, SessionEnv } from '../session-middleware'

/** 订阅锚用户名（casdoor-client ensureAnchorUser 同款；单处定义防漂移） */
export const ANCHOR_USER = 'tenantsub'

export interface AdminRoutesDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /** 权限码全集（内置 + 已装载模块）——授权页的可见宇宙 */
  permissions: () => ReadonlyArray<{ code: string; name: string }>
}

async function writeAudit(
  pool: Pool, tenantId: number, actor: string,
  action: 'admin.user.create' | 'admin.user.update' | 'admin.user.delete' | 'admin.grant' | 'admin.revoke',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

export function adminRoutes(deps: AdminRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', requireScope('tenant:admin'))
  // CSRF：写操作必须带与当前会话一致的 x-csrf-token（鉴权放行后、handler 前判定）
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const s = c.get('session')
      if (!s || c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
        return c.json({ error: 'CSRF' }, 403)
      }
    }
    await next()
  })

  app.get('/users', async (c) => {
    const org = c.get('tenant').casdoor_org
    const users = (await deps.casdoor(org).listUsers()).filter((u) => u.name !== ANCHOR_USER)
    return c.json({ users })
  })

  app.post('/users', async (c) => {
    const body = await c.req.json< { username?: unknown; displayName?: unknown; password?: unknown }>().catch(() => null)
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const displayName = typeof body?.displayName === 'string' && body.displayName ? body.displayName : undefined
    if (!/^[A-Za-z0-9]+$/.test(username) || username === ANCHOR_USER || password.length < 8) {
      return c.json({ error: 'INVALID' }, 400)
    }
    const org = c.get('tenant').casdoor_org
    await deps.casdoor(org).createManagedUser({ name: username, displayName, password })
    const t = c.get('tenant')
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.create', { user: username })
    return c.json({ name: username }, 201)
  })

  app.patch('/users/:name', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ isForbidden?: unknown }>().catch(() => null)
    if (!body || typeof body.isForbidden !== 'boolean') return c.json({ error: 'INVALID' }, 400)
    const org = c.get('tenant').casdoor_org
    await deps.casdoor(org).setUserForbidden(name, body.isForbidden)
    const t = c.get('tenant')
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, isForbidden: body.isForbidden })
    return c.json({ name })
  })

  app.patch('/users/:name/password', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ password?: unknown }>().catch(() => null)
    const password = typeof body?.password === 'string' ? body.password : ''
    if (password.length < 8) return c.json({ error: 'INVALID' }, 400)
    const org = c.get('tenant').casdoor_org
    await deps.casdoor(org).resetUserPassword(name, password)
    const t = c.get('tenant')
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, reset: true }) // 密码不进 detail
    return c.json({ name })
  })

  app.delete('/users/:name', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER || name === c.get('identity').userId) {
      return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    }
    const org = c.get('tenant').casdoor_org
    await deps.casdoor(org).deleteUser(name)
    const t = c.get('tenant')
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.delete', { user: name })
    return c.json({ name })
  })

  return app
}
```

（测试夹具 `mount`/`fakeCasdoor`/`json()` 在 admin.test.ts 顶部定义：`mount` 组 tenant→session→identity 注入中间件；`fakeCasdoor` 返回带记录数组的 CasdoorClient 形状替身。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- admin`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/admin.ts apps/server/src/routes/admin.test.ts
git commit -m "feat(server): /api/platform/admin 用户端点——scope 门禁+CSRF+锁 org+锚用户保护 (#N)"
```

---

### Task 7: admin 授权端点 + 我的订阅端点

**Files:**
- Modify: `apps/server/src/routes/admin.ts`
- Test: `apps/server/src/routes/admin.test.ts`

**Interfaces:**
- Consumes: Task 4 `grantPermissionToUser`/`revokePermissionFromUser`、`getPermissions()`、`listSubscriptions(owner)`、`deps.permissions()`、Task 6 的 `AdminRoutesDeps`（新增 `modules: () => Array<{ id: string; name: string }>` 字段）。
- Produces（Task 10 前端消费）：
  - `GET /permissions` → `{ permissions: Array<{ code: string; name: string; users: string[] }> }`（users 为短名；只出 `deps.permissions()` 宇宙内的码；`tenantsub` 从 users 滤除）
  - `POST /permissions/:code/users` body `{ user }` → 200 `{ ok: true }`；码不在宇宙 → 404 `{error:'NO_SUCH_CODE'}`；user 是锚用户 → 400
  - `DELETE /permissions/:code/users/:user` → 200 `{ ok: true }`
  - `GET /subscriptions` → `{ subscriptions: Array<{ moduleId: string; moduleName: string | null; state: string; startTime: string | null; endTime: string | null }> }`（plan 非 `mod-` 前缀的外来订阅忽略——spec §1.2；只读）

- [ ] **Step 1: 写失败测试**

```ts
test('GET /permissions 只出宇宙内的码并映射短名', async () => {
  const casdoor = fakeCasdoorWithPermissions([
    { name: 'tenant-admin', resources: ['tenant:admin'], users: ['myorg/alice'] },
    { name: 'demo-view', resources: ['demo:view'], users: ['myorg/alice', 'myorg/tenantsub'] },
    { name: 'foreign', resources: ['other:sys'], users: ['myorg/alice'] }, // 宇宙外→不出现
  ])
  const app = mount(adminRoutes({ ...base, casdoor, modules: () => [{ id: 'demo', name: '演示模块' }] }), { scopes: ['tenant:admin'] })
  const res = await app.request('/api/platform/admin/permissions')
  const j = await res.json()
  expect(j.permissions.map((p: { code: string }) => p.code)).toEqual(['tenant:admin', 'demo:view'])
  expect(j.permissions[1].users).toEqual(['alice']) // tenantsub 滤除、全形剥短名
})

test('POST /permissions/:code/users 未知码 404、锚用户 400、成功写 audit admin.grant', async () => { /* 三段断言 */ })

test('DELETE /permissions/:code/users/:user 成功写 audit admin.revoke', async () => { /* 断言 */ })

test('GET /subscriptions 映射 mod- 前缀并忽略外来订阅', async () => {
  const casdoor = fakeCasdoorWithSubscriptions([
    { plan: 'myorg/mod-demo', state: 'Active', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z' },
    { plan: 'myorg/sub_6a6def', state: 'Active', startTime: '2026-08-29T00:00:00Z', endTime: null }, // 外来→忽略
  ])
  const app = mount(adminRoutes({ ...base, casdoor, modules: () => [{ id: 'demo', name: '演示模块' }] }), { scopes: ['tenant:admin'] })
  const j = await (await app.request('/api/platform/admin/subscriptions')).json()
  expect(j.subscriptions).toEqual([
    { moduleId: 'demo', moduleName: '演示模块', state: 'Active', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z' },
  ])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- admin`
Expected: FAIL

- [ ] **Step 3: 实现**（admin.ts 追加；`AdminRoutesDeps` 加 `modules: () => Array<{ id: string; name: string }>`）

```ts
/** Casdoor 权限 users 全形（`org/name`）→ 短名；锚用户剔除 */
function shortNames(users: string[], org: string): string[] {
  return users
    .map((u) => (u.includes('/') ? u.split('/').pop()! : u))
    .filter((u) => u !== ANCHOR_USER)
}

app.get('/permissions', async (c) => {
  const org = c.get('tenant').casdoor_org
  const universe = deps.permissions()
  const raw = await deps.casdoor(org).getPermissions()
  // getPermissions 不回 name/resources 之外的元数据——code→name 用宇宙表，raw 按 resources 反查
  const permissions = universe.map((u) => ({
    code: u.code,
    name: u.name,
    users: shortNames(raw.find((p) => p.resources?.includes(u.code))?.users ?? [], org),
  }))
  return c.json({ permissions })
})

app.post('/permissions/:code/users', async (c) => {
  const code = c.req.param('code')
  if (!deps.permissions().some((p) => p.code === code)) return c.json({ error: 'NO_SUCH_CODE' }, 404)
  const body = await c.req.json<{ user?: unknown }>().catch(() => null)
  const user = typeof body?.user === 'string' ? body.user : ''
  if (!/^[A-Za-z0-9]+$/.test(user) || user === ANCHOR_USER) return c.json({ error: 'INVALID' }, 400)
  const org = c.get('tenant').casdoor_org
  await deps.casdoor(org).grantPermissionToUser(code, user)
  const t = c.get('tenant')
  await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.grant', { code, user })
  return c.json({ ok: true })
})

app.delete('/permissions/:code/users/:user', async (c) => {
  const code = c.req.param('code')
  if (!deps.permissions().some((p) => p.code === code)) return c.json({ error: 'NO_SUCH_CODE' }, 404)
  const user = c.req.param('user')
  if (user === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
  const org = c.get('tenant').casdoor_org
  await deps.casdoor(org).revokePermissionFromUser(code, user)
  const t = c.get('tenant')
  await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.revoke', { code, user })
  return c.json({ ok: true })
})

app.get('/subscriptions', async (c) => {
  const org = c.get('tenant').casdoor_org
  const subs = await deps.casdoor(org).listSubscriptions(org)
  const modules = new Map(deps.modules().map((m) => [m.id, m.name]))
  const subscriptions = subs
    .map((s) => {
      const plan = String(s.plan ?? '')
      const m = /^mod-(.+)$/.exec(plan) // plan 形如 `<org>/mod-<moduleId>` 或裸 `mod-<id>`：取最后一段判前缀
        ? /^mod-(.+)$/.exec(plan.split('/').pop() ?? '')!
        : null
      return m ? { moduleId: m[1], moduleName: modules.get(m[1]) ?? null, state: String(s.state ?? ''), startTime: s.startTime ?? null, endTime: s.endTime ?? null } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  return c.json({ subscriptions })
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- admin`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/admin.ts apps/server/src/routes/admin.test.ts
git commit -m "feat(server): admin 授权端点（码↔用户 grant/revoke）与我的订阅只读端点 (#N)"
```

---

### Task 8: app.ts 接线

**Files:**
- Modify: `apps/server/src/app.ts`（platformRoutes 挂载处之后、authRoutes 之前或之后——同前缀不冲突）
- Test: `apps/server/src/app.test.ts`（轻量：app 能构造即冒烟）

**Interfaces:**
- Consumes: Task 6/7 `adminRoutes`、loader `PLATFORM_BUILTIN_PERMISSIONS`、runtime.modules 的 manifest.permissions、casdoorFactory。
- Produces: `/api/platform/admin/*` 在生产装配中生效。

- [ ] **Step 1: 实现**（app.ts，platformRoutes 挂载之后）

```ts
import { adminRoutes } from './routes/admin'
import { PLATFORM_BUILTIN_PERMISSIONS } from './loader'

  // ⑨ 租户管理域（spec D4/D9，M3）：/api/platform/admin/*——org 锁本租户，scope 门禁在路由内部
  app.route('/api/platform/admin', adminRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    permissions: () => [
      ...PLATFORM_BUILTIN_PERMISSIONS,
      ...runtime.modules.flatMap((m) => m.manifest.permissions),
    ],
    modules: () => runtime.modules.map((m) => ({ id: m.manifest.id, name: m.manifest.name })),
  }))
```

- [ ] **Step 2: 验证**

Run: `pnpm -C apps/server test && pnpm -C apps/server typecheck`（或仓库对应脚本名——按 package.json 实际为准）
Expected: PASS（app.test.ts 既有用例不回归）

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/app.ts
git commit -m "feat(server): 装配 /api/platform/admin 路由（权限码宇宙=内置+模块）(#N)"
```

---

### Task 9: console「管理」菜单组 + 路由 + 403 门禁

**Files:**
- Modify: `apps/web/src/pages/console-menu.ts`、`apps/web/src/pages/Console.tsx`（CONSOLE_ICONS 登记 + 菜单调用传参）、`apps/web/src/App.tsx`
- Test: `apps/web/src/pages/console-menu.test.ts`

**Interfaces:**
- Consumes: `session.scopes`（`ScopeLike`）、`buildConsoleMenu`、`CONSOLE_ICONS`。
- Produces:
  - `buildConsoleMenu(entries, iconMap, session)`（**第三参**，ScopeLike）——有 `tenant:admin` 时尾部追加「管理」组；`TENANT_ADMIN_SCOPE = 'tenant:admin'` 常量导出（App.tsx 门禁复用，防漂移）。
  - `App.tsx` 三条固定子路由：`/console/admin/users`→UsersPage、`/console/admin/permissions`→PermissionsPage、`/console/admin/subscriptions`→SubscriptionsPage（组件在 Task 10 创建；本任务先建最小占位文件并 export，Task 10 填充——**占位仅指 UI 内容，路由与门禁本任务完成**）。
  - `AdminGate`（Console.tsx 内导出）：读 outlet context，无 `tenant:admin` → `<Result status="403">`，有则渲染 children。

- [ ] **Step 1: 写失败测试**（console-menu.test.ts 追加）

```ts
test('有 tenant:admin → 尾部追加「管理」组（三项子菜单）', () => {
  const menu = buildConsoleMenu([], {}, { scopes: ['tenant:admin'] })
  const group = menu.at(-1)
  expect(group?.name).toBe('管理')
  expect(group?.children?.map((c) => c.path)).toEqual([
    '/console/admin/users', '/console/admin/permissions', '/console/admin/subscriptions',
  ])
})

test('无 tenant:admin → 不出现管理组（模块页照旧）', () => {
  const menu = buildConsoleMenu([], {}, { scopes: ['demo:view'] })
  expect(menu.some((m) => m.name === '管理')).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web test -- console-menu`
Expected: FAIL

- [ ] **Step 3: 实现**

console-menu.ts：

```ts
/** spec D9：租户管理员识别码——「管理」组与 /console/admin/* 的门禁（与服务端 requireScope 同串） */
export const TENANT_ADMIN_SCOPE = 'tenant:admin'

/** buildConsoleMenu 尾部的管理组（spec §3 第 4 位「平台管理」的 M3 落地子集；帮助▾仍留白） */
function adminGroup(iconMap: Record<string, ReactNode>): MenuDataItem {
  return {
    path: '/console/admin',
    name: '管理',
    icon: iconMap['TeamOutlined'],
    children: [
      { path: '/console/admin/users', name: '用户管理' },
      { path: '/console/admin/permissions', name: '角色与授权' },
      { path: '/console/admin/subscriptions', name: '我的订阅' },
    ],
  }
}
```

`buildConsoleMenu` 签名加第三参 `session: ScopeLike`，返回数组改：

```ts
  const items = [
    { path: '/console', name: '概览' },
    ...[...pinned, ...rest].map((e) => ({ path: e.path, name: e.title, icon: iconMap[e.icon ?? ''] })),
  ]
  return session.scopes.includes(TENANT_ADMIN_SCOPE) ? [...items, adminGroup(iconMap)] : items
```

Console.tsx：`CONSOLE_ICONS` 登记 `'TeamOutlined': <TeamOutlined />`（import 补）；L166-169 调用改 `buildConsoleMenu(visibleConsoleEntries(config, session, consoleRegistry), CONSOLE_ICONS, session)`。ConsoleOutletContext 不变（session 已在）。

App.tsx（children 数组、`*` 通配之前插入——react-router 静态路由按特异性排序，安全）：

```tsx
{ path: 'admin/users', element: <AdminGate><AdminUsersPage /></AdminGate> },
{ path: 'admin/permissions', element: <AdminGate><AdminPermissionsPage /></AdminGate> },
{ path: 'admin/subscriptions', element: <AdminGate><AdminSubscriptionsPage /></AdminGate> },
```

（`AdminGate` 从 Console.tsx 导出；三个页面文件 `apps/web/src/pages/admin/{Users,Permissions,Subscriptions}.tsx` 本任务先放最小占位组件 `export default function X() { return <Card title="…" /> }`，Task 10 重写。）

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `pnpm -C apps/web test && pnpm -C apps/web typecheck`
Expected: PASS（含既有 console-menu / Console 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/console-menu.ts apps/web/src/pages/console-menu.test.ts apps/web/src/pages/Console.tsx apps/web/src/App.tsx apps/web/src/pages/admin/
git commit -m "feat(console): 「管理」菜单组（tenant:admin 门禁）+ 三条固定路由 + 403 守卫 (#N)"
```

---

### Task 10: 三张管理页

**Files:**
- Modify: `apps/web/src/pages/admin/Users.tsx`、`apps/web/src/pages/admin/Permissions.tsx`、`apps/web/src/pages/admin/Subscriptions.tsx`
- Modify: `apps/web/src/lib/api.ts`（新增请求函数）
- Test: `apps/web/src/pages/admin/Users.test.tsx`（最小渲染冒烟）

**Interfaces:**
- Consumes: Task 6/7 端点契约、`lib/api.ts` 的 `request<T>`/`getSession`、antd（Table/Form/Input/Button/Modal/Tag/message）、`useOutletContext<ConsoleOutletContext>`。
- Produces: 三张页。写操作统一模式：现取 `getSession()` 拿 csrfToken → 带 `x-csrf-token` 头（Task 13 契约：不缓存旧值）。

- [ ] **Step 1: lib/api.ts 追加类型与函数**

```ts
export interface AdminUser { name: string; displayName: string; isForbidden: boolean }
export interface AdminPermission { code: string; name: string; users: string[] }
export interface AdminSubscription { moduleId: string; moduleName: string | null; state: string; startTime: string | null; endTime: string | null }

export const listAdminUsers = () => request<{ users: AdminUser[] }>('/api/platform/admin/users')
export const listAdminPermissions = () => request<{ permissions: AdminPermission[] }>('/api/platform/admin/permissions')
export const listAdminSubscriptions = () => request<{ subscriptions: AdminSubscription[] }>('/api/platform/admin/subscriptions')

/** 写操作：现取 csrf（会话重签会轮换）→ 带头调用。 */
async function adminWrite<T>(path: string, method: string, body?: unknown): Promise<T> {
  const s = await getSession()
  return request<T>(path, {
    method,
    headers: { 'x-csrf-token': s.csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
export const createAdminUser = (v: { username: string; displayName?: string; password: string }) =>
  adminWrite<{ name: string }>('/api/platform/admin/users', 'POST', v)
export const setAdminUserForbidden = (name: string, isForbidden: boolean) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'PATCH', { isForbidden })
export const resetAdminUserPassword = (name: string, password: string) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}/password`, 'PATCH', { password })
export const deleteAdminUser = (name: string) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'DELETE')
export const grantAdminPermission = (code: string, user: string) =>
  adminWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/users`, 'POST', { user })
export const revokeAdminPermission = (code: string, user: string) =>
  adminWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/users/${encodeURIComponent(user)}`, 'DELETE')
```

（`request` 若不支持第二参 options，按其现有签名最小扩展——参照 `logout(token)` 的实现形状。）

- [ ] **Step 2: Users.tsx**——antd `Table`（列：用户名/显示名/状态 Tag/操作）+ 顶部「新建用户」Modal（Form：username 规则 `/^[A-Za-z0-9]+$/`、displayName 可选、password 规则 ≥8）+ 行操作：禁用/启用（switch 或按钮）、重置密码（Modal）、删除（Popconfirm，`alice === session.user.id` 时禁用按钮）。加载态 `loading`；操作成功 `message.success` + 重新拉列表；失败 `message.error(err.message)`。

- [ ] **Step 3: Permissions.tsx**——Table 列：权限码 code / 名称 / 已授权用户（`Tag` 列表）。每行「授权」按钮弹 Modal（Input 用户名，规则字母数字）；每个用户 Tag 带 close 图标 → revoke。**`tenant:admin` 行加提示文案**「授予此码 = 租户管理员；谨慎交接」。

- [ ] **Step 4: Subscriptions.tsx**——只读 Table：模块/状态（Active → green Tag，其他 → default）/起止时间；数据为空 `Typography.Text type="secondary"` 空态「暂无订阅」。

- [ ] **Step 5: 写 Users 页最小渲染测试**

```tsx
import { render, screen } from '@testing-library/react'
import UsersPage from './Users'

test('用户管理页渲染表头与新建入口', async () => {
  // mock lib/api：listAdminUsers 返回一个用户（vi.mock，照 Console.test.tsx 的 mock 模式）
  render(<UsersPage />)
  expect(await screen.findByText('alice')).toBeTruthy()
  expect(screen.getByRole('button', { name: '新建用户' })).toBeTruthy()
})
```

- [ ] **Step 6: 验证**

Run: `pnpm -C apps/web test && pnpm -C apps/web typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/admin/ apps/web/src/lib/api.ts
git commit -m "feat(console): 租户管理员三张页——用户管理/角色与授权/我的订阅 (#N)"
```

---

### Task 11: 波末全量验证

- [ ] `pnpm test`（全仓 + scripts 守卫）——Expected: 全绿
- [ ] `pnpm typecheck`——Expected: 全绿
- [ ] `pnpm -C apps/web build`（含 registry 生成）——Expected: 无错误
- [ ] `bash scripts/check-dev-discipline.sh`（若 CI 有对应 job）——Expected: 通过
- [ ] 推分支开 PR（title: `feat: M3 租户管理员后台——console 三张页 + Casdoor 代理锁 org + tenant:admin 门禁 (#N)`，body 关联 issue + spec 链接），**等 CI CLEAN** 再请人合并（UNSTABLE 强合的教训，issue #44）。

### Task 12: 合并后部署与真机验收（spec §5 M3 行）

部署走 openship（`POST /api/deployments`，与既有流程一致——本仓 deploy job 未启用自动触发，手动发）。验收清单：

- [ ] Casdoor 后台（sso.hookflow.cn）给某测试用户挂 `tenant:admin` 权限码（平台超管动作）→ 该用户登录 console → **「管理」菜单组出现**（scopes 刷新窗口 ≤5 分钟，或重登录）
- [ ] 无码账号登录 → 菜单组不出现；直敲 `/console/admin/users` → 403 Result
- [ ] 用户管理：新建用户（字母数字名）→ Casdoor 后台可见；禁用 → 该用户登录被拒；重置密码 → 新密码可登录；删除 → Casdoor 后台消失
- [ ] 角色与授权：把 `demo:view` 授给新用户 → 该用户菜单出现「演示」（scopes 刷新窗口内）；回收 → 消失
- [ ] 把 `tenant:admin` 授给另一用户（管理员交接）→ 对方见管理组；回收自己 → 自己管理组消失
- [ ] 我的订阅：显示 Casdoor 里该 org 的 `mod-*` 订阅（state/起止时间正确）；外来订阅不出现
- [ ] `tenantsub` 在用户列表/授权用户中不可见；直接 DELETE `/api/platform/admin/users/tenantsub` → 400
- [ ] 验收结果回填 issue #N 评论；踩坑沉淀 WeKnora（先查重）

---

## Self-Review 记录

- **Spec 覆盖**：D4 三张页（Task 9/10）、锁 org（Task 6 结构锁①）、D9 门禁+扇出（Task 5/6/9）、锚用户保护（Task 6/7 边界）、§5 验收（Task 12）、订阅只读+mod- 过滤（Task 7）。M2（平台超管页）不在本计划——spec 维持砍。
- **占位符扫描**：Task 7 Step 1 第二/三条测试、Task 3 setUserForbidden 测试、Task 6 CSRF/FORBIDDEN_TARGET/audit 测试以「/* 断言 */」标注补全点——形状均已给出，执行时按同款 mock 写全，不得留空提交。
- **类型一致性**：`AdminRoutesDeps` 在 Task 6 定义、Task 7 增加 `modules` 字段（Task 7 Step 3 已注明）；`TENANT_ADMIN_SCOPE` Task 9 定义、仅前端消费（服务端门禁走 `requireScope('tenant:admin')` 字面量，与 loader `PLATFORM_BUILTIN_PERMISSIONS` 的 code 同串——漂移由 Task 5 的供给测试兜住）。
