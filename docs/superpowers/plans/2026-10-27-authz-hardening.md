# 权限体系加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准的 spec 收紧四处权限缝：JIT 零授权、平台专属码隔离、禁用用户失效、订阅源默认 fail-closed。

**Architecture:** 不引入新的授权面。A 删除 JIT 的全量绑定；B 在 manifest 协议上加 `platformOnly` 并在宿主注入租户管理员权限宇宙时过滤；C 让 `getUser` 暴露 `isForbidden` 并在四条读取路径上判定；E 用一个纯函数把订阅源默认值翻到 casdoor。文档/架构订正先于代码提交。

**Tech Stack:** TypeScript、Hono、Zod、pg、Vitest、pnpm、Casdoor Admin API。

## Global Constraints

- **架构先行**：Task 1 的文档订正必须先于 Task 2–8 的代码提交（公司规则 `architecture-first`）。
- **提交纪律**：Conventional Commits；feat/fix 必须先有 issue；可见变更走 PR；PR body 含 `Closes #<issue>`。
- **CHANGELOG 禁止手写**：由 `release.mjs` 从 conventional commits 生成。
- **fail-closed**：禁用、未配置、未声明一律落在关闭侧；「未知 ≠ 失败」「不可见 ≠ 报错」的既有语义不变。
- **测试替身照真机收严**（AGENTS 硬约束 #11）：mock 的 `get-user` / `get-subscriptions` 形状以真机为准，不得放宽。
- **敏感值**：不把密码、token、AK/SK 写进日志、审计或测试断言。
- **不改历史 spec**：`docs/superpowers/specs/**` 中既有文件是历史快照；本次只新增 spec + 改 `docs/architecture.md` / `docs/module-protocol.md` / `docs/module-onboarding.md`。
- **B7 / B9 等门禁**：不新增 compose 文件；新增 env 键必须在 `.env.example` 声明。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/platform-sdk/src/manifest.ts` | manifest 协议：`permissions[].platformOnly` + 内层 strict |
| `apps/server/src/admin-permissions.ts`（新增） | 纯函数：租户可授权宇宙 / 平台专属码集合 |
| `apps/server/src/app.ts` | 装配：admin 权限宇宙注入、订阅源解析 |
| `apps/server/src/routes/admin.ts` | 租户管理员代理：显式拒绝 platformOnly 码 |
| `apps/server/src/routes/auth-wecom.ts` | JIT 零授权 + 禁用检查 |
| `apps/server/src/routes/auth-wechat-oa.ts` | 正式态禁用拒绝 |
| `apps/server/src/routes/auth.ts` | 账密路禁用防御 |
| `apps/server/src/session-middleware.ts` | 会话刷新时禁用清 cookie |
| `apps/server/src/pat-auth.ts` / `wecom-channel-auth.ts` | 禁用即时 401 |
| `packages/auth-core/src/casdoor-client.ts` | `CasdoorUser.isForbidden`；删除 `bindUserToAllPermissions` |
| `apps/server/src/subscription-source.ts` | `resolveSubscriptionSource` 纯函数 |
| `packages/auth-core/src/test-util/mock-casdoor.ts` | 订阅种子 + `get-subscriptions` |
| `scripts/smoke-load.mjs` | 默认 casdoor 的冒烟 |
| `scripts/audit-permission-holders.mjs`（新增） | 只读存量审计 |
| `docs/architecture.md` 等 | 文档订正 |

---

### Task 0: Umbrella issue

**Files:**
- Modify: GitHub issue（无仓内文件）

**Interfaces:**
- Produces: `ISSUE_N`（后续 PR body 的 `Closes #<ISSUE_N>`）

- [ ] **Step 1: 确认分支**

```bash
git status --short --branch
# 期望：## fix/authz-hardening...origin/main
```

- [ ] **Step 2: 创建 umbrella issue**

```bash
gh issue create \
  --title "fix(auth): 权限体系加固——JIT 零授权 / platformOnly 码 / 禁用失效 / 订阅源 fail-closed" \
  --body "$(cat <<'EOF'
## 背景

静态审计发现四处「代码行为与设计意图之间的缝」，设计稿：
`docs/superpowers/specs/2026-10-27-authz-hardening-design.md`

## 范围

- [ ] A：企微 JIT 自动建号改为**零授权**（不再 bindUserToAllPermissions）
- [ ] B：`manifest.permissions[].platformOnly` + 租户管理员授权宇宙过滤（`forms:global-manage`）
- [ ] C：禁用用户失效——PAT / 渠道 C 即时 401；会话 ≤5 分钟清；登录路拒绝
- [ ] E：`PLATFORM_SUBSCRIPTION_SOURCE` 未配置时默认 casdoor（fail-closed）
- [ ] 只读存量审计脚本 + 架构/协议/部署文档订正

## 不做

- 数据面直读通路 / marts org 列（#174/#175/#176）
- 应用内平台超管身份
- 自动回收存量越权
EOF
)"
```

- [ ] **Step 3: 记录 issue 编号**

把输出的 URL 里的数字记为 `ISSUE_N`，后续 PR body 用 `Closes #<ISSUE_N>`。

---

### Task 1: 文档先行（架构 / 协议 / 接入）

**Files:**
- Modify: `docs/architecture.md`（§1.5、§2.4、§4.2）
- Modify: `docs/module-protocol.md`（新增「权限码声明」小节）
- Modify: `docs/module-onboarding.md:50`（字段表）
- Test: `pnpm exec tsx scripts/check-doc-citations.mjs origin/main`

**Interfaces:**
- Produces: 文档中的新口径（后续代码任务按它实现）

- [ ] **Step 1: 改 `docs/architecture.md` §4.2 的 JIT 行**

把「③ 建号 + 挂全量码后重读成功」改为：

```markdown
③ 建号 + 重读成功（**不挂任何码**）。**自动建号 ≠ 自动授权**：新号登录后无任何模块权限，
   由管理员按角色 / 部门显式授权。
```

- [ ] **Step 2: 改 `docs/architecture.md` §2.4 的 P4 断言**

把「该码默认无任何租户角色持有，授予 = 平台运营显式动作 ⇒ 一个租户管理员改不到全局字典」
改为机制性表述：

```markdown
该码在 manifest 里标记 `platformOnly: true`：装载器仍把它供给到各租户 org（平台运营要能在
Casdoor 后台授予），但宿主注入**租户管理员**的授权宇宙时会过滤掉它 ⇒ 租户管理员看不到、
授不了；存量回收同样只能由平台运营在 Casdoor 完成。
```

- [ ] **Step 3: 在 `docs/architecture.md` §1.5 补禁用语义**

在「四条定案」表后加一段：

```markdown
**禁用账户的失效语义（2026-10-27）**：`getUser` 暴露 Casdoor 的 `isForbidden`。PAT 与渠道 C
每次请求实时判定 ⇒ 即时 401；平台会话在下一次 scopes 刷新（≤5 分钟）清 cookie；企微 / 公众号
登录路直接拒绝。禁用不是「绑定悬空」：公众号正式态被禁用时**不降级为访客**。
```

- [ ] **Step 4: 在 `docs/module-protocol.md` 增加权限码小节**

在「## 规则：没声明 = 不可达」之前插入：

```markdown
## 权限码声明（`permissions[]`）

模块的权限码声明在 `manifest.permissions[]`，每项 `{ code, name, platformOnly? }`：

- `code` 必须以 `<moduleId>:` 开头（schema 拒越界）；
- 装载器按 `platform.tenant` 的每个 `casdoor_org` 各建一套码（写读同源）；
- `platformOnly: true` 表示**平台专属码**：loader 仍供给到各 org，但宿主不会把它放进租户
  管理员的授权宇宙（`GET /permissions` 与授权端点都看不到 / 授不了）。平台运营在 Casdoor
  后台授予。它不改变端点门卫：持有该码的人仍可调用声明了该 scope 的端点。
- 权限条目的未知字段现在是 **schema 拒绝**（`.strict()`），拼错字段名会装载失败。
```

- [ ] **Step 5: 改 `docs/module-onboarding.md:50`**

把 `permissions[]` 行的形状改为：

```markdown
| `permissions[]` | 是 | `{code,name,platformOnly?}[]` | 权限码清单；`code` 必须 `<id>:` 前缀；`platformOnly` = 平台专属码（租户管理员授权宇宙不含它） | schema |
```

- [ ] **Step 6: 跑文档引用门禁**

```bash
pnpm exec tsx scripts/check-doc-citations.mjs origin/main
```

Expected: `check-doc-citations: OK（…）`。

- [ ] **Step 7: 提交**

```bash
git add docs/architecture.md docs/module-protocol.md docs/module-onboarding.md
git commit -m "docs(auth): 权限体系加固的架构与协议订正"
```

---

### Task 2: A —— 企微 JIT 建号零授权

**Files:**
- Modify: `apps/server/src/routes/auth-wecom.ts`（JIT 分支 + `login.ok` 审计）
- Modify: `packages/auth-core/src/casdoor-client.ts`（删除 `bindUserToAllPermissions`）
- Test: `apps/server/src/routes/auth-wecom.test.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: JIT 用户的 `scopes` 恒为空；`login.ok` 审计 `detail.jit === true`（仅 JIT 建号）

- [ ] **Step 1: 改 JIT 测试（先红）**

在 `apps/server/src/routes/auth-wecom.test.ts` 的 qr-corp JIT 用例里，替换断言：

```ts
      // 新号无角色；JIT 不再挂任何码 ⇒ scopes 为空
      expect(p?.scopes).toEqual([])
      // 绑定侧反证：p-view 的 users 不变（没有追加 wo_new）
      const pView = mock.permissionsIn('acme').find((x) => x.name === 'p-view')
      expect(pView?.users).toEqual(['alice', 'wo_alice'])
      const { rows } = await pool.query<{ action: string; actor: string; detail: { via?: string; jit?: boolean } }>(
        "select action, actor, detail from platform.audit where action='login.ok' and actor='wo_new' order by id desc limit 1",
      )
      expect(rows[0]).toMatchObject({
        action: 'login.ok', actor: 'wo_new', detail: { via: 'wecom-qr', jit: true },
      })
```

把用例标题改为：

```ts
it('★ JIT（qr-corp）：旗标开 + 陌生企微号 → 自动建号但**不挂任何码** → 302 / scopes=[] + audit jit:true', async () => {
```

在 silent JIT 用例里把 `expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view'])` 改为：

```ts
      expect(p?.scopes).toEqual([])
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server exec vitest run src/routes/auth-wecom.test.ts
```

Expected: FAIL（`scopes` 仍为 `['ticket:admin','ticket:view']`，`p-view.users` 仍含 `wo_new`）。

- [ ] **Step 3: 实现 JIT 零授权**

在 `apps/server/src/routes/auth-wecom.ts` 的 JIT 分支：

```ts
      let jitCreated = false
      if (user === null && wecomCode && t.wecom_auto_signup) {
        try {
          await casdoor.ensureUser(name)
          ;[user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
          jitCreated = true
        } catch {
          await writeAudit(deps.pool, t.id, name, 'login.fail', { via, reason: 'jit-create-failed' })
          deps.limiter.record(t.id, 'wecom', null, false)
          return fail('CASDOOR_UNAVAILABLE')
        }
      }
```

把最后的审计行改为：

```ts
      await writeAudit(deps.pool, t.id, name, 'login.ok', { via, ...(jitCreated ? { jit: true } : {}) })
```

**不要**再调用 `bindUserToAllPermissions`；`effectiveScopes` 照旧消费 `user.roles` 与 `perms`。

- [ ] **Step 4: 删除 `CasdoorClient.bindUserToAllPermissions`**

删除 `packages/auth-core/src/casdoor-client.ts` 中从 `/** 把用户挂到本 org 的**全部**权限码上` 到
方法结束的整段（约 `:826-857`）。

删除 `packages/auth-core/src/casdoor-client.test.ts` 中 `it('★ bindUserToAllPermissions…')` 整块；
把 describe 标题改为：

```ts
describe('ensureUser（JIT 自动建号，issue #32）', () => {
```

- [ ] **Step 5: 跑 A 的测试**

```bash
pnpm --filter @platform/server exec vitest run src/routes/auth-wecom.test.ts
pnpm --filter @platform/auth-core exec vitest run src/casdoor-client.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/auth-wecom.ts packages/auth-core/src/casdoor-client.ts \
  apps/server/src/routes/auth-wecom.test.ts packages/auth-core/src/casdoor-client.test.ts
git commit -m "fix(auth): 企微 JIT 建号改为零授权"
```

---

### Task 3: B1 —— manifest `platformOnly` 协议 + 声明

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Modify: `modules/forms/manifest.yaml`
- Test: `packages/platform-sdk/src/manifest.test.ts`
- Test: `modules/forms/module.test.ts`
- Test: `apps/server/src/loader.test.ts`

**Interfaces:**
- Produces: `ModuleManifest.permissions: Array<{ code: string; name: string; platformOnly?: boolean }>`
- Produces: `forms:global-manage` 带 `platformOnly: true`；loader 仍供给该码

- [ ] **Step 1: 写 manifest schema 测试（先红）**

在 `packages/platform-sdk/src/manifest.test.ts` 加：

```ts
  it('permissions[].platformOnly：可选布尔；非布尔 / 拼错字段名 ⇒ 校验失败', () => {
    const ok = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [
        { code: 'demo:view', name: '查看', platformOnly: true },
        { code: 'demo:edit', name: '编辑' },
      ],
    })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.permissions[0]?.platformOnly).toBe(true)

    const badType = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [{ code: 'demo:view', name: '查看', platformOnly: 'yes' }],
    })
    expect(badType.success).toBe(false)

    const typo = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [{ code: 'demo:view', name: '查看', platform_only: true }],
    })
    expect(typo.success).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/sdk exec vitest run src/manifest.test.ts
```

Expected: FAIL（`platformOnly` 被静默剥离或类型不收）。

- [ ] **Step 3: 改 schema 与接口**

`packages/platform-sdk/src/manifest.ts`：

```ts
export interface ModuleManifest {
  // ...
  permissions: Array<{ code: string; name: string; platformOnly?: boolean }>
  // ...
}
```

zod 的 `permissions` 改为：

```ts
  permissions: z.array(z.object({
    code: z.string(),
    name: z.string(),
    platformOnly: z.boolean().optional(),
  }).strict()),
```

- [ ] **Step 4: 给 forms 的全局字典码打标**

`modules/forms/manifest.yaml` 把：

```yaml
  - { code: forms:global-manage,  name: 平台全局字典管理 }
```

改为：

```yaml
  - { code: forms:global-manage,  name: 平台全局字典管理, platformOnly: true }
```

同文件顶部与「全局字典」小节的注释同步改为：

```yaml
# scope 矩阵即 P4 分档：forms:global-manage 标记 platformOnly——装载器仍供给到各租户 org，
# 但宿主的租户管理员授权宇宙会过滤掉它（平台运营在 Casdoor 后台授予）。
```

```yaml
    # ── 全局字典（P4：编辑权收平台运营——forms:global-manage platformOnly，租户管理员授不了）──
```

在 `modules/forms/module.test.ts` 加：

```ts
  it('全局字典管理码标记 platformOnly（租户管理员授权宇宙不含它）', () => {
    const p = mod.manifest.permissions.find((x) => x.code === 'forms:global-manage')
    expect(p?.platformOnly).toBe(true)
  })
```

- [ ] **Step 5: 加 loader 供给测试（平台码仍进 org）**

在 `apps/server/src/loader.test.ts` 的「权限码供给到每个租户各自的 org」附近加：

```ts
  it('platformOnly 码仍供给到每个租户 org（租户管理员授不了 ≠ 平台运营授不了）', async () => {
    cleanupModules.push('platmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'platmod', {
      'manifest.yaml': [
        'id: platmod',
        'name: platmod 模块',
        'version: 1.0.0',
        'platform: ">=0.1.0"',
        'permissions:',
        '  - code: platmod:view',
        '    name: platmod 查看',
        '  - code: platmod:global',
        '    name: platmod 平台专属',
        '    platformOnly: true',
        'api:',
        '  internal:',
        '    - { method: GET, path: /ping, scope: platmod:view }',
        '',
      ].join('\n'),
      'index.ts': indexTs('platmod', 'platmod:view'),
    })
    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    for (const org of ['acme', 'beta']) {
      const resources = mock.permissionsIn(org).flatMap((p) => p.resources ?? [])
      expect(resources).toContain('platmod:global')
    }
  })
```

- [ ] **Step 6: 跑 B1 的测试**

```bash
pnpm --filter @platform/sdk exec vitest run src/manifest.test.ts
pnpm --filter forms exec vitest run module.test.ts
pnpm --filter @platform/server exec vitest run src/loader.test.ts
```

> forms 包的 package name 是 `forms`（不是 `@platform/forms`）；loader 测试需要 `DATABASE_URL`。

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/manifest.test.ts \
  modules/forms/manifest.yaml modules/forms/module.test.ts apps/server/src/loader.test.ts
git commit -m "feat(sdk): manifest 权限码支持 platformOnly"
```

---

### Task 4: B2 —— 租户管理员授权宇宙过滤 + 显式拒绝

**Files:**
- Create: `apps/server/src/admin-permissions.ts`
- Create: `apps/server/src/admin-permissions.test.ts`
- Modify: `apps/server/src/app.ts`（admin 路由 deps）
- Modify: `apps/server/src/routes/admin.ts`（`platformOnlyPermissions` + grant/revoke 拒绝）
- Test: `apps/server/src/routes/admin.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PermissionSpec { code: string; name: string; platformOnly?: boolean }
  export function tenantGrantable(perms: readonly PermissionSpec[]): Array<{ code: string; name: string }>
  export function platformOnlyCodes(perms: readonly PermissionSpec[]): Set<string>
  ```
- Consumes: `runtime.modules[].manifest.permissions`（Task 3 的 `platformOnly`）

- [ ] **Step 1: 写纯函数测试（先红）**

`apps/server/src/admin-permissions.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { platformOnlyCodes, tenantGrantable } from './admin-permissions'

describe('admin 权限宇宙', () => {
  const all = [
    { code: 'tenant:admin', name: '租户管理员' },
    { code: 'forms:global-manage', name: '平台全局字典管理', platformOnly: true },
    { code: 'demo:view', name: '演示查看' },
  ] as const

  it('tenantGrantable：过滤 platformOnly，只回 code/name', () => {
    expect(tenantGrantable(all)).toEqual([
      { code: 'tenant:admin', name: '租户管理员' },
      { code: 'demo:view', name: '演示查看' },
    ])
  })

  it('platformOnlyCodes：只收集 platformOnly 的码', () => {
    expect([...platformOnlyCodes(all)]).toEqual(['forms:global-manage'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server exec vitest run src/admin-permissions.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现纯函数**

`apps/server/src/admin-permissions.ts`：

```ts
/**
 * 租户管理员授权面的权限宇宙。
 *
 * `platformOnly` 码只由平台运营在 Casdoor 后台授予；租户管理员的权限页与授权端点都不该看到它。
 * 过滤点收在这里，app.ts 与测试共用同一份实现。
 */
export interface PermissionSpec {
  code: string
  name: string
  platformOnly?: boolean
}

export function tenantGrantable(
  perms: readonly PermissionSpec[],
): Array<{ code: string; name: string }> {
  return perms.filter((p) => !p.platformOnly).map(({ code, name }) => ({ code, name }))
}

export function platformOnlyCodes(perms: readonly PermissionSpec[]): Set<string> {
  return new Set(perms.filter((p) => p.platformOnly).map((p) => p.code))
}
```

- [ ] **Step 4: 接进 `app.ts`**

在 `apps/server/src/app.ts` 的 admin 路由注册前：

```ts
  const adminPermissionUniverse = [
    ...PLATFORM_BUILTIN_PERMISSIONS,
    ...runtime.modules.flatMap((m) => m.manifest.permissions),
  ]
```

把 `app.route('/api/platform/admin', adminRoutes({...}))` 的 deps 改为：

```ts
  app.route('/api/platform/admin', adminRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    permissions: () => tenantGrantable(adminPermissionUniverse),
    platformOnlyPermissions: () => platformOnlyCodes(adminPermissionUniverse),
    modules: () => runtime.modules.map((m) => ({ id: m.manifest.id, name: m.manifest.name })),
  }))
```

并在文件顶部加：

```ts
import { platformOnlyCodes, tenantGrantable } from './admin-permissions'
```

- [ ] **Step 5: 在 `admin.ts` 加显式拒绝**

`AdminRoutesDeps` 加：

```ts
  /** 平台专属码（defense in depth：即使调用方误把全量宇宙传进来，授权端点也拒绝） */
  platformOnlyPermissions?: () => ReadonlySet<string>
```

在 grant 与 revoke 的「码 ∈ 宇宙」检查之前加：

```ts
    if (deps.platformOnlyPermissions?.().has(code)) {
      return c.json({ error: 'NO_SUCH_CODE' }, 404)
    }
```

（四个端点：`POST/DELETE /permissions/:code/users`、`POST/DELETE /permissions/:code/roles`。）

- [ ] **Step 6: 写路由测试**

在 `apps/server/src/routes/admin.test.ts` 的「角色与授权」describe 里加：

```ts
  it('platformOnly 码：即使宇宙误注入，grant/revoke 仍 404（defense in depth）', async () => {
    const d = deps({
      permissions: () => [
        { code: 'tenant:admin', name: '租户管理员' },
        { code: 'forms:global-manage', name: '平台全局字典管理', platformOnly: true },
      ],
      platformOnlyPermissions: () => new Set(['forms:global-manage']),
    })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/permissions/forms:global-manage/users', {
      method: 'POST',
      headers: withCsrf,
      body: JSON.stringify({ user: 'alice' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'NO_SUCH_CODE' })
    const revoke = await app.request('/api/platform/admin/permissions/forms:global-manage/users/alice', {
      method: 'DELETE',
      headers: withCsrf,
    })
    expect(revoke.status).toBe(404)
    expect(await revoke.json()).toEqual({ error: 'NO_SUCH_CODE' })
  })
```

- [ ] **Step 7: 跑 B2 的测试**

```bash
pnpm --filter @platform/server exec vitest run src/admin-permissions.test.ts src/routes/admin.test.ts
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/admin-permissions.ts apps/server/src/admin-permissions.test.ts \
  apps/server/src/app.ts apps/server/src/routes/admin.ts apps/server/src/routes/admin.test.ts
git commit -m "fix(auth): 租户管理员授权宇宙过滤 platformOnly 码"
```

---

### Task 5: C1 —— `isForbidden` 核心 + 会话/PAT/渠道 C

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`（`CasdoorUser`、`getUser`）
- Modify: `apps/server/src/session-middleware.ts`
- Modify: `apps/server/src/pat-auth.ts`
- Modify: `apps/server/src/wecom-channel-auth.ts`
- Test: `apps/server/src/pat-auth.test.ts`
- Test: `apps/server/src/wecom-channel-auth.test.ts`
- Test: `apps/server/src/session-middleware-account.test.ts`

**Interfaces:**
- Produces: `CasdoorUser.isForbidden: boolean`
- Produces: PAT / 渠道 C 的 401 `USER_DISABLED`

- [ ] **Step 1: 写禁用测试（先红）**

`apps/server/src/pat-auth.test.ts` 加：

```ts
  it('用户被禁用 → 401 USER_DISABLED（isForbidden）', async () => {
    const mock = new MockCasdoor({
      users: [{ name: 'alice', password: 'pw', owner: ORG, isForbidden: true }],
      perms: [{ owner: ORG, users: ['alice'], resources: ['data:query'] }],
    })
    await mock.start()
    const res = await post(app(mock), TOKEN)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('USER_DISABLED')
    await mock.stop()
  })
```

`apps/server/src/wecom-channel-auth.test.ts` 加：

```ts
  it('用户被禁用 → 401 USER_DISABLED（与 PAT 同口径）', async () => {
    const mock = new MockCasdoor({
      users: [{ name: 'alice', password: 'pw', owner: ORG, isForbidden: true }],
      perms: [{ owner: ORG, users: ['alice'], resources: ['data:query'] }],
    })
    await mock.start()
    const res = await call(app(mock), {
      'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'alice',
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('USER_DISABLED')
    await mock.stop()
  })
```

`apps/server/src/session-middleware-account.test.ts` 加（内部会话 + 正式态各一条）：

```ts
  it('内部会话：getUser 返 isForbidden ⇒ 清会话', async () => {
    const cas = stubCasdoor({ name: 'alice', roles: [], isForbidden: true }, [])
    const app = makeApp(pool, { casdoor: cas.factory })
    const now = nowSec()
    const token = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['stale'], authVia: 'password' },
      SECRET,
      now - SCOPES_TTL_SEC - 60,
    )
    const res = await probe(app, token)
    expect(setCookies(res).join('\n')).toContain('Max-Age=0')
    expect(await res.json()).toBeNull()
  })

  it('正式态：getUser 返 isForbidden ⇒ 清会话（不重签、不查绑定集合）', async () => {
    const cas = stubCasdoor({ name: ACCT, roles: [], isForbidden: true }, [])
    const bound = stubBoundIds(new Error('清会话路不应触达绑定集合'))
    const app = makeApp(pool, { casdoor: cas.factory, boundExternalIds: bound.dep })
    const res = await probe(app, await formalToken())
    expect(setCookies(res).join('\n')).toContain('Max-Age=0')
    expect(bound.calls).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server exec vitest run src/pat-auth.test.ts src/wecom-channel-auth.test.ts src/session-middleware-account.test.ts
```

Expected: FAIL（`isForbidden` 未被消费；PAT / 渠道 C 仍 200）。

- [ ] **Step 3: 扩展 `CasdoorUser` 与 `getUser`**

`packages/auth-core/src/casdoor-client.ts`：

```ts
export interface CasdoorUser {
  name: string
  roles?: string[]
  displayName?: string
  isAdmin?: boolean
  /** Casdoor 禁用标记（get-user 真机字段）；true = 停用 */
  isForbidden: boolean
}
```

在 `getUser` 的返回对象里加：

```ts
      isForbidden: u.isForbidden === true,
```

- [ ] **Step 4: 会话中间件清 cookie**

在 `apps/server/src/session-middleware.ts` 的两处 Casdoor 分支（正式态账户分支、内部分支）：

```ts
            const user = await casdoor.getUser(p.acct)
            if (user === null || user.isForbidden) {
              userGone = true
            } else {
              const perms = await casdoor.getPermissions()
              scopes = effectiveScopes(p.acct, user.roles ?? [], perms)
              refreshOk = true
            }
```

内部分支同理：

```ts
            const user = await casdoor.getUser(p.name)
            if (user === null || user.isForbidden) {
              userGone = true
            } else {
              const perms = await casdoor.getPermissions()
              scopes = effectiveScopes(p.name, user.roles ?? [], perms)
              refreshOk = true
            }
```

访客分支（`authVia === 'wechat-oa'` 且无 `acct`）保持不变。

- [ ] **Step 5: PAT / 渠道 C 即时 401**

`apps/server/src/pat-auth.ts`：

```ts
      const user = await casdoor.getUser(key.casdoorUser)
      if (user === null) return c.json({ error: 'USER_GONE' }, 401)
      if (user.isForbidden) return c.json({ error: 'USER_DISABLED' }, 401)
```

`apps/server/src/wecom-channel-auth.ts`：

```ts
      const user = await casdoor.getUser(userid)
      if (user === null) return c.json({ error: 'WECOM_USER_NOT_LINKED' }, 401)
      if (user.isForbidden) return c.json({ error: 'USER_DISABLED' }, 401)
```

- [ ] **Step 6: 修既有测试夹具**

`apps/server/src/session-middleware-account.test.ts` 的 `T5_USER` 加：

```ts
  const T5_USER: CasdoorUser = {
    name: ACCT, roles: ['store_ops'], displayName: '门店操作员', isForbidden: false,
  }
```

其他直接构造 `CasdoorUser` 的测试按 typecheck 提示补 `isForbidden: false`。

- [ ] **Step 7: 跑 C1 的测试**

```bash
pnpm --filter @platform/server exec vitest run src/pat-auth.test.ts src/wecom-channel-auth.test.ts src/session-middleware-account.test.ts
pnpm --filter @platform/auth-core exec vitest run src/casdoor-client.test.ts
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/auth-core/src/casdoor-client.ts apps/server/src/session-middleware.ts \
  apps/server/src/pat-auth.ts apps/server/src/wecom-channel-auth.ts \
  apps/server/src/pat-auth.test.ts apps/server/src/wecom-channel-auth.test.ts \
  apps/server/src/session-middleware-account.test.ts
git commit -m "fix(auth): 禁用用户的会话/PAT/渠道 C 失效"
```

---

### Task 6: C2 —— 登录路拒绝禁用用户

**Files:**
- Modify: `apps/server/src/routes/auth-wecom.ts`
- Modify: `apps/server/src/routes/auth-wechat-oa.ts`
- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/routes/auth-wecom.test.ts`
- Test: `apps/server/src/routes/auth-wechat-oa.test.ts`
- Test: `apps/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `CasdoorUser.isForbidden`（Task 5）
- Produces: 三条登录路对禁用账户的行为

- [ ] **Step 1: 写登录路禁用测试（先红）**

`apps/server/src/routes/auth-wecom.test.ts` 的 mock 种子加一个禁用用户：

```ts
    { name: 'wo_forbidden', password: 'pw', roles: ['ops'], owner: 'acme', isForbidden: true },
```

加用例：

```ts
  it('★ 禁用用户：企微直连回调 → 302 /login?error=NO_ACCOUNT + audit login.fail(forbidden)，不建号', async () => {
    const c = testClient(makeApp(pool, casdoorFor, createLoginLimiter(), wecomFetchFor('wo_forbidden')))
    const qr = await c.api.platform.auth.wecom.qr.$get(undefined, { headers: { host: 'acme.test' } })
    const state = stateToken(qr)
    const res = await c.api.platform.auth.wecom.callback.$get(
      { query: { code: 'forbidden-code', state, via: 'qr-corp' } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=NO_ACCOUNT')
    const { rows } = await pool.query<{ detail: { reason?: string } }>(
      "select detail from platform.audit where action='login.fail' and actor='wo_forbidden' order by id desc limit 1",
    )
    expect(rows[0]?.detail.reason).toBe('forbidden')
  })
```

`apps/server/src/routes/auth-wechat-oa.test.ts` 加：

```ts
  it('⑦ 正式态：Casdoor 用户被禁用 ⇒ 302 /login?error=NO_ACCOUNT，不降级访客', async () => {
    await seedLink('wechat-oa', 'o_t4_forbidden', 't4_forbidden_acct')
    const fake = fakeCasdoor(
      { name: 't4_forbidden_acct', roles: [], isForbidden: true },
      [{ users: ['acme/t4_forbidden_acct'], resources: ['moda:view'] }],
    )
    const client = testClient(
      makeApp(pool, { wechatFetch: wechatOpenid('o_t4_forbidden'), routeCasdoor: fake.factory }),
    )
    const state = await silentState(client)
    const res = await client.api.platform.auth['wechat-oa'].callback.$get(
      { query: { code: 'good-code', state } },
      { headers: { host: 'acme.test', cookie: `wechat_oa_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=NO_ACCOUNT')
    expect(res.headers.getSetCookie().join('\n')).not.toContain('platform_session=')
  })
```

> `fakeCasdoor` 的入参类型同步扩为 `{ name: string; roles?: string[]; isForbidden?: boolean }`，并在 `getUser` 返回处补默认值：
>
> ```ts
>     getUser: async (name: string) => {
>       names.push(name)
>       if (user === 'throw') throw new Error('casdoor unreachable')
>       return user === null ? null : { ...user, isForbidden: user.isForbidden ?? false }
>     },
> ```

`apps/server/src/routes/auth.test.ts` 加：

```ts
  it('账密路防御：verifyPassword 通过但 getUser 返 isForbidden ⇒ 401 且不发会话', async () => {
    const fake = (() => ({
      verifyPassword: async () => ({ name: 'bob' }),
      getUser: async () => ({ name: 'bob', roles: [], isForbidden: true }),
      getPermissions: async () => [],
    } as unknown as CasdoorClient)) as CasdoorFactory
    const app = makeApp(pool, fake)
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { host: 'acme.test', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'pw' }),
    })
    expect(res.status).toBe(401)
    expect(setCookies(res)).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server exec vitest run src/routes/auth-wecom.test.ts src/routes/auth-wechat-oa.test.ts src/routes/auth.test.ts
```

Expected: FAIL（禁用用户仍拿到 302 `/` 或会话）。

- [ ] **Step 3: 实现三条登录路**

`apps/server/src/routes/auth-wecom.ts` 的 `if (user === null) { ... }` 之后加：

```ts
      if (user.isForbidden) {
        await writeAudit(deps.pool, t.id, name, 'login.fail', { via, reason: 'forbidden' })
        deps.limiter.record(t.id, 'wecom', null, false)
        return fail('NO_ACCOUNT')
      }
```

`apps/server/src/routes/auth-wechat-oa.ts` 的正式态分支（`if (user !== null && degraded === null)` 内）加：

```ts
        if (user.isForbidden) {
          await writeAudit(deps.pool, t.id, openid, 'login.fail', {
            via: 'wechat-oa', reason: 'forbidden', acct: active.casdoorName,
          })
          deps.limiter.record(t.id, 'wechat-oa', null, false)
          return fail('NO_ACCOUNT')
        }
```

`apps/server/src/routes/auth.ts` 的 `if (user === null) return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)` 之后加：

```ts
        if (user.isForbidden) {
          await writeAudit(deps.pool, t.id, name, 'login.fail', { via: 'password', reason: 'forbidden' })
          return c.json({ error: 'BAD_CREDENTIALS' }, 401)
        }
```

- [ ] **Step 4: 跑 C2 的测试**

```bash
pnpm --filter @platform/server exec vitest run src/routes/auth-wecom.test.ts src/routes/auth-wechat-oa.test.ts src/routes/auth.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/auth-wecom.ts apps/server/src/routes/auth-wechat-oa.ts \
  apps/server/src/routes/auth.ts apps/server/src/routes/auth-wecom.test.ts \
  apps/server/src/routes/auth-wechat-oa.test.ts apps/server/src/routes/auth.test.ts
git commit -m "fix(auth): 禁用用户的登录路拒绝"
```

---

### Task 7: E1 —— 订阅源默认 casdoor

**Files:**
- Modify: `apps/server/src/subscription-source.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `.env.example`
- Test: `apps/server/src/subscription-source.test.ts`

**Interfaces:**
- Produces: `resolveSubscriptionSource(raw: string | undefined): 'platform' | 'casdoor'`

- [ ] **Step 1: 写纯函数测试（先红）**

`apps/server/src/subscription-source.test.ts` 加：

```ts
describe('resolveSubscriptionSource（fail-closed 默认）', () => {
  it('只有显式 platform 走旧表；未设 / 空串 / casdoor / 垃圾值一律 casdoor', () => {
    expect(resolveSubscriptionSource('platform')).toBe('platform')
    expect(resolveSubscriptionSource(undefined)).toBe('casdoor')
    expect(resolveSubscriptionSource('')).toBe('casdoor')
    expect(resolveSubscriptionSource('casdoor')).toBe('casdoor')
    expect(resolveSubscriptionSource('garbage')).toBe('casdoor')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server exec vitest run src/subscription-source.test.ts
```

Expected: FAIL（函数未导出）。

- [ ] **Step 3: 实现纯函数**

`apps/server/src/subscription-source.ts` 末尾加：

```ts
/**
 * 订阅源解析（fail-closed）：只有显式 `platform` 才读旧表；未设 / 非法值一律 casdoor。
 * 旧表语义是「无行 = 启用」——漏配时默认走它是 fail-open，故默认值必须站在 casdoor 侧。
 */
export function resolveSubscriptionSource(raw: string | undefined): 'platform' | 'casdoor' {
  return raw === 'platform' ? 'platform' : 'casdoor'
}
```

- [ ] **Step 4: 接进 `app.ts` 并加启动日志**

在 `apps/server/src/app.ts` 的 `loadModules` 调用前：

```ts
  const rawSubscriptionSource = process.env.PLATFORM_SUBSCRIPTION_SOURCE
  const subscriptionSource = resolveSubscriptionSource(rawSubscriptionSource)
  if (rawSubscriptionSource === undefined) {
    console.info('[modules] PLATFORM_SUBSCRIPTION_SOURCE 未设置，默认 casdoor（fail-closed）')
  } else if (rawSubscriptionSource === 'platform') {
    console.warn('[modules] PLATFORM_SUBSCRIPTION_SOURCE=platform：旧表是回滚档，不是生产口径')
  } else if (rawSubscriptionSource !== 'casdoor') {
    console.warn(`[modules] PLATFORM_SUBSCRIPTION_SOURCE=${JSON.stringify(rawSubscriptionSource)} 未知，按 casdoor 处理`)
  }
```

把 `subscriptionSource: process.env.PLATFORM_SUBSCRIPTION_SOURCE === 'casdoor' ? 'casdoor' : 'platform'`
改为 `subscriptionSource,`。顶部加：

```ts
import { resolveSubscriptionSource } from './subscription-source'
```

- [ ] **Step 5: 改 `.env.example`**

把 `PLATFORM_SUBSCRIPTION_SOURCE=platform` 改为：

```dotenv
# 订阅源：未设置 = casdoor（fail-closed 默认）；platform 仅回滚旧表用
PLATFORM_SUBSCRIPTION_SOURCE=casdoor
```

- [ ] **Step 6: 跑 E1 的测试**

```bash
pnpm --filter @platform/server exec vitest run src/subscription-source.test.ts
pnpm --filter @platform/server exec vitest run src/config.test.ts
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/subscription-source.ts apps/server/src/subscription-source.test.ts \
  apps/server/src/app.ts .env.example
git commit -m "fix(server): 订阅源默认改为 casdoor（fail-closed）"
```

---

### Task 8: E2 —— mock 订阅端点 + smoke 默认 casdoor

**Files:**
- Modify: `packages/auth-core/src/test-util/mock-casdoor.ts`
- Test: `packages/auth-core/src/test-util/mock-casdoor.test.ts`
- Modify: `scripts/smoke-load.mjs`

**Interfaces:**
- Produces: `MockCasdoorOptions.subscriptions?: MockCasdoorSubscription[]`
- Produces: `GET /api/get-subscriptions?owner=<org>` 返回 `{ status:'ok', data: [...] }`

- [ ] **Step 1: 写 mock 测试（先红）**

`packages/auth-core/src/test-util/mock-casdoor.test.ts` 加：

```ts
describe('MockCasdoor 订阅端点（E：订阅源默认 casdoor）', () => {
  it('get-subscriptions?owner= 按 org 返回种子；缺 owner 报错', async () => {
    const m = new MockCasdoor({
      subscriptions: [
        { owner: 'acme', name: 'sub_demo', user: 'tenantsub', plan: 'mod-demo',
          startTime: '2026-01-01T00:00:00Z', endTime: '2099-01-01T00:00:00Z', state: 'Active' },
      ],
    })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw',
      })
      const subs = await c.listSubscriptions('acme')
      expect(subs).toHaveLength(1)
      expect(subs[0]).toMatchObject({ plan: 'mod-demo', state: 'Active' })
    } finally {
      await m.stop()
    }
  })
})
```

> 文件名/导入以现有 `mock-casdoor.test.ts` 为准；该文件已 import `MockCasdoor` 与 `CasdoorClient` 时可直接用。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/auth-core exec vitest run src/test-util/mock-casdoor.test.ts
```

Expected: FAIL（`subscriptions` 选项不存在 / 端点 404）。

- [ ] **Step 3: 扩展 mock**

`packages/auth-core/src/test-util/mock-casdoor.ts`：

1. 新增类型：

```ts
export interface MockCasdoorSubscription {
  owner?: string
  name: string
  user: string
  plan: string
  startTime: string
  endTime: string
  state: string
}
```

2. `MockCasdoorOptions` 加：

```ts
  /** 订阅种子（E：订阅源默认 casdoor 的冒烟/单测） */
  subscriptions?: MockCasdoorSubscription[]
```

3. 构造函数里存：

```ts
  #subscriptions: Array<Required<MockCasdoorSubscription>> = []
  // ...
  for (const s of opts.subscriptions ?? []) {
    this.#subscriptions.push({
      owner: s.owner ?? MOCK_ORG,
      name: s.name,
      user: s.user,
      plan: s.plan,
      startTime: s.startTime,
      endTime: s.endTime,
      state: s.state,
    })
  }
```

4. 路由表加（放在 `get-permissions` 附近）：

```ts
    // GET /api/get-subscriptions?owner=<org> —— 真机形状：owner 必填、按 org 分桶
    .get('/api/get-subscriptions', (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      const owner = c.req.query('owner') ?? ''
      if (!owner) return c.json({ status: 'error', msg: 'owner required' })
      return c.json({
        status: 'ok',
        data: this.#subscriptions.filter((s) => s.owner === owner),
      })
    })
```

- [ ] **Step 4: 改 smoke 的 mock 种子**

`scripts/smoke-load.mjs` 里构造 `MockCasdoor` 的 options 加：

```js
    subscriptions: ['acme', 'beta'].map((owner) => ({
      owner,
      name: `sub_mod-demo_${owner}`,
      user: 'tenantsub',
      plan: 'mod-demo',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2099-01-01T00:00:00Z',
      state: 'Active',
    })),
```

不要给 `commonEnv` 加 `PLATFORM_SUBSCRIPTION_SOURCE`——冒烟要跑**默认 casdoor** 路径。

- [ ] **Step 5: 跑冒烟**

```bash
pnpm --filter @platform/web build
pnpm smoke
```

Expected: 双形态（multi + single）全绿；`/api/platform/config` 仍返回 demo；beta 模块 API 仍 403（授权缺失，不是模块停用）。

> 若本机没有 `DATABASE_URL`，先按 README 起本地 compose pg，或跳过本步并在 PR 中记录未跑原因。

- [ ] **Step 6: 提交**

```bash
git add packages/auth-core/src/test-util/mock-casdoor.ts \
  packages/auth-core/src/test-util/mock-casdoor.test.ts scripts/smoke-load.mjs
git commit -m "test(auth): mock 订阅端点 + smoke 默认 casdoor"
```

---

### Task 9: 存量审计脚本 + 部署文档 + 全量验收 + PR

**Files:**
- Create: `scripts/audit-permission-holders.mjs`
- Modify: `deploy/openship-adopt.md`
- Modify: `deploy/delivery-private.md`
- Test: `pnpm test`、`pnpm typecheck`、`pnpm smoke`

**Interfaces:**
- Produces: 只读 CLI `pnpm exec tsx scripts/audit-permission-holders.mjs [--org X] [--code Y]`

- [ ] **Step 1: 写审计脚本**

`scripts/audit-permission-holders.mjs`：

```js
#!/usr/bin/env node
// audit-permission-holders.mjs — 只读：列出各租户 org 中持有指定权限码的用户。
// 用途：A（JIT 全量授权）与 B（platformOnly 码）的存量复核。绝不写 Casdoor / DB。
import { parseArgs } from 'node:util'
import pg from 'pg'
import { CasdoorClient } from '../packages/auth-core/src/casdoor-client.ts'

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    code: { type: 'string', multiple: true },
  },
})

const DEFAULT_CODES = ['tenant:admin', 'forms:global-manage', 'data:cost', 'data:precise']
const codes = values.code?.length ? values.code : DEFAULT_CODES
const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL 未设置')
if (!process.env.CASDOOR_URL) throw new Error('CASDOOR_URL 未设置')
if (!process.env.CASDOOR_ADMIN_USER || !process.env.CASDOOR_ADMIN_PWD) {
  throw new Error('CASDOOR_ADMIN_USER / CASDOOR_ADMIN_PWD 未设置')
}

const pool = new pg.Pool({ connectionString: databaseUrl })
try {
  const { rows } = values.org
    ? { rows: [{ casdoor_org: values.org }] }
    : await pool.query('select distinct casdoor_org from platform.tenant order by casdoor_org')
  for (const { casdoor_org: org } of rows) {
    const c = new CasdoorClient({
      origin: process.env.CASDOOR_URL,
      clientId: process.env.CASDOOR_CLIENT_ID ?? '',
      clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
      org,
      adminUser: process.env.CASDOOR_ADMIN_USER,
      adminPwd: process.env.CASDOOR_ADMIN_PWD,
    })
    const perms = await c.getPermissions()
    console.log(`\n[${org}]`)
    for (const code of codes) {
      const users = perms.find((p) => p.resources?.includes(code))?.users ?? []
      if (users.length > 0) console.log(`  ${code}: ${users.join(', ')}`)
    }
  }
} finally {
  await pool.end()
}
```

- [ ] **Step 2: 跑脚本做冒烟（只读）**

```bash
pnpm exec tsx scripts/audit-permission-holders.mjs --org mytech --code forms:global-manage
```

Expected: 打印该 org 的持有者或空；**不修改任何数据**。

- [ ] **Step 3: 改部署文档**

`deploy/openship-adopt.md` 与 `deploy/delivery-private.md` 中 `PLATFORM_SUBSCRIPTION_SOURCE`
相关行补一句：

```markdown
未设置时默认 `casdoor`（fail-closed）；`platform` 仅用于回滚旧表，必须在项目 env 显式设置。
```

- [ ] **Step 4: 全量门禁**

```bash
pnpm test
pnpm typecheck
pnpm --filter @platform/web build
pnpm smoke
```

Expected: 全绿。记录每条命令的实际输出（PR 里贴关键行）。

- [ ] **Step 5: 手工验收（dev-stack）**

按 spec §4.4 走：

1. A：JIT 新号登录 ⇒ 无模块；授角色后重新登录 ⇒ 模块出现。
2. B：租户管理员权限页看不到 `forms:global-manage`；直接 POST ⇒ 404；Casdoor 授权后端点可用。
3. C：禁用用户 ⇒ PAT 立即 401；会话 ≤5 分钟清；重新登录被拒；重新启用后恢复。
4. E：不设变量启动 ⇒ 日志说 casdoor 默认；设 `platform` ⇒ 明确 warn。

- [ ] **Step 6: 提交脚本与部署文档**

```bash
git add scripts/audit-permission-holders.mjs deploy/openship-adopt.md deploy/delivery-private.md
git commit -m "chore(auth): 权限持有者只读审计脚本与部署口径"
```

- [ ] **Step 7: 推送并开 PR**

```bash
git push -u origin fix/authz-hardening
gh pr create \
  --title "fix(auth): 权限体系加固（JIT 零授权 / platformOnly / 禁用失效 / 订阅源 fail-closed）" \
  --body "$(cat <<'EOF'
## 概要

按 `docs/superpowers/specs/2026-10-27-authz-hardening-design.md` 收紧四处权限缝。

- A：企微 JIT 建号零授权（删除 bindUserToAllPermissions）
- B：manifest `permissions[].platformOnly` + 租户管理员授权宇宙过滤（`forms:global-manage`）
- C：`isForbidden` —— PAT/渠道 C 即时 401、会话 ≤5 分钟清、登录路拒绝
- E：`PLATFORM_SUBSCRIPTION_SOURCE` 未设置默认 casdoor
- 只读存量审计脚本 + 架构/协议/部署文档订正

## 验证

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm smoke`（默认 casdoor）
- [ ] dev-stack 手工验收（spec §4.4）

Closes #<ISSUE_N>
EOF
)"
```

- [ ] **Step 8: 记录 PR 与 CI**

```bash
gh pr view --json number,url,mergeStateStatus,statusCheckRollup
```

Expected: 等 CI 全绿；合并前确认 `mergeStateStatus` 不是 `CONFLICTING`（冲突 PR 不触发 CI）。

---

## Self-Review

**Spec coverage**

| spec 节 | 落点 |
|---|---|
| §3.1 A | Task 2 |
| §3.2 B 协议/声明 | Task 3 |
| §3.2 B 隔离 | Task 4 |
| §3.3 C 核心 | Task 5 |
| §3.3 C 登录路 | Task 6 |
| §3.4 E 纯函数/配置 | Task 7 |
| §3.4 E mock/smoke | Task 8 |
| §3.5 审计脚本 | Task 9 |
| §3.6 文档 | Task 1 + Task 9 |
| §4 测试/验收 | 各任务 + Task 9 Step 4/5 |

**Placeholder scan**

- 无 TBD / TODO / 「稍后补」。
- Task 6 的 `auth.test.ts` 用例依赖该文件既有夹具；已写明断言形状（401 + 无 cookie + audit），未留空泛步骤。
- Task 0 的 `ISSUE_N` 是运行时输出，不是计划占位。

**Type consistency**

- `CasdoorUser.isForbidden: boolean` 在 Task 5 定义；Task 6 消费。
- `PermissionSpec` / `tenantGrantable` / `platformOnlyCodes` 在 Task 4 定义并只在 Task 4 消费。
- `resolveSubscriptionSource` 在 Task 7 定义并只在 Task 7 消费。
- `MockCasdoorSubscription` 在 Task 8 定义并只在 Task 8 消费。
