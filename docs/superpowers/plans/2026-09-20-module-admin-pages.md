# 模块管理页协议（frontend.admin）+ 存储页能力联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模块可通过 manifest `frontend.admin` 声明「管理」组子页（随模块启停联动）；宿主「存储配置」页按 storage 能力联动显隐；协议进正典与机器契约。

**Architecture:** 全部前端/构建期改动，零后端零 DB：SDK schema 承载校验（装载与 check-manifests 同时覆盖）→ gen 脚本聚合（registry 条目带 `group`/`moduleId`，另导出 `storageDeclarers`）→ console-menu 按「registry∩config 启用集∩scope」判定（与 console 三重过滤同构）→ Console/App 接线（菜单 + StorageGate 路由门）。spec：`docs/superpowers/specs/2026-09-20-module-admin-pages-design.md`。

**Tech Stack:** zod schema + tsx 守卫脚本 + Vite 生成物 + React Router 6 + vitest。

## Global Constraints

- 分支 `feat/module-admin-pages`（已建，spec 已提交 89c4b34）。提交 `type(scope): subject`；feat 关联 issue 走 PR body `Closes #N`。
- **零后端零 DB**：不改 config API 形状、不加后端路由、不加迁移；`/api/admin/storage` 门禁（`tenant:admin`）**不动**。
- 协议约束（SDK schema + check-manifests 双拦）：`frontend.admin[].path` 必须以 `/console/admin/` 开头；`frontend.admin[].scope` 必须 ∈ `permissions[].code`；`frontend.console[].path` **不得**以 `/console/admin/` 开头。
- 本期 aftersales/demo 的 manifest **不声明** `frontend.admin`（协议就位等第一个真实案例）。
- 联动判定：管理组子页 = registry(group='admin') ∩ config 启用集 ∩ session scope；存储配置页 = `storageDeclarers ∩ config.modules ≠ ∅`（外加组门 `tenant:admin`）。
- 管理组 children 顺序：用户管理 / 角色与授权 / 我的订阅（固定）→ 存储配置（能力联动）→ 模块 admin 页（manifest 声明序）。
- 每个 Task 收尾必须该包测试 + `pnpm typecheck` 绿再 commit。

---

### Task 1: SDK schema 扩展 `frontend.admin`

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Test: `packages/platform-sdk/src/manifest.test.ts`

**Interfaces:**
- Produces: `ModuleManifest['frontend']['admin']: Array<{ path: string; title: string; icon?: string; scope: string; entry: string }>`（可选字段）；superRefine 规则三条（admin 前缀 / admin scope ∈ codes / console 禁 admin 前缀）。Task 2 的 checks 与 Task 3 的 gen 依赖此形状。

- [ ] **Step 1: 写失败测试（manifest.test.ts 追加）**

```ts
// ---- 模块管理页协议（2026-09-20 spec）：frontend.admin 校验 ----
describe('frontend.admin（模块管理页协议）', () => {
  const BASE = {
    id: 'demo',
    name: '演示',
    version: '0.1.0',
    platform: '>=0.1',
    permissions: [{ code: 'demo:view', name: '查看' }],
  }

  it('合法声明通过：path 落 /console/admin/ 下，scope ∈ permissions', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [
          { path: '/console/admin/demo/settings', title: '演示设置', scope: 'demo:view', entry: './console/admin/settings.tsx' },
        ],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('path 不以 /console/admin/ 开头 → 拒绝并指到字段', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [{ path: '/console/demo/settings', title: 'x', scope: 'demo:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toContain('admin')
  })

  it('scope 不在 permissions[].code 内 → 拒绝（与 api.internal[].scope 同纪律）', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [{ path: '/console/admin/demo/x', title: 'x', scope: 'other:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((i) => i.message.includes('不在本模块 permissions'))).toBe(true)
  })

  it('frontend.console 不得占用 /console/admin/ 前缀（防串组）', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        console: [{ path: '/console/admin/demo/oops', title: 'x', scope: 'demo:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((i) => i.message.includes('不得以 /console/admin/ 开头'))).toBe(true)
  })
})
```

（`describe/it/expect` 若该文件尚未 import，从 vitest 引入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/sdk test`
Expected: FAIL——合法声明用例因 schema 剥离未知 `admin` 键仍可能过，但**前缀/scope/串组三条负例全过（success: true）即红**；以负例红为准。

- [ ] **Step 3: 实现（manifest.ts 三处）**

① `ModuleManifest.frontend` 类型（28 行附近）：

```ts
  frontend?: { userApp?: { mount: string; dist: string };
    console?: Array<{ path: string; title: string; icon?: string; scope: string; entry: string }>;
    /** 模块管理页协议（2026-09-20 spec）：模块自有的「管理」组子页。门禁 = tenant:admin（组门，
     *  宿主施加）+ scope（页门）。path 必须以 /console/admin/ 开头、scope 必须 ∈ permissions[].code
     *  （superRefine 承载 ⇒ 装载与 check-manifests 同时覆盖）。服务端 config 不暴露 admin 清单——
     *  前端按 registry∩config∩scope 自判（与 console 三重过滤同构）。 */
    admin?: Array<{ path: string; title: string; icon?: string; scope: string; entry: string }> }
```

② zod `frontend` 对象（63-72 行）加：

```ts
    admin: z.array(z.object({
      path: z.string(),
      title: z.string(),
      icon: z.string().optional(),
      scope: z.string(),
      entry: z.string(),
    })).optional(),
```

③ `superRefine` 末尾（`seenEndpoints` 循环之后）追加：

```ts
  // 模块管理页协议（2026-09-20 spec）：admin 页必须落在 /console/admin/ 之下（壳按组聚合）；
  // scope 与 api.internal[].scope 同纪律。console 页反向不得占用该前缀（防串组——菜单会把
  // console 条目当模块区平铺页，占住 admin 前缀会让路由与菜单分组对不上）。
  for (const [i, a] of (m.frontend?.admin ?? []).entries()) {
    if (!a.path.startsWith('/console/admin/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frontend', 'admin', i, 'path'],
        message: `frontend.admin[${i}].path 必须以 /console/admin/ 开头（管理组子页）`,
      })
    }
    if (!codes.has(a.scope)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frontend', 'admin', i, 'scope'],
        message: `frontend.admin[${i}].scope "${a.scope}" 不在本模块 permissions[].code 内（模块只能声明自己的权限码）`,
      })
    }
  }
  for (const [i, c] of (m.frontend?.console ?? []).entries()) {
    if (c.path.startsWith('/console/admin/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frontend', 'console', i, 'path'],
        message: `frontend.console[${i}].path 不得以 /console/admin/ 开头（该前缀保留给 frontend.admin）`,
      })
    }
  }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm --filter @platform/sdk test`
Expected: PASS（新增 4 用例全绿，存量不红）。

- [ ] **Step 5: Commit**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/manifest.test.ts
git commit -m "feat(sdk): manifest 协议新增 frontend.admin——管理组子页声明与三条约法"
```

---

### Task 2: check-manifests 补 admin entry 存在性校验

**Files:**
- Modify: `packages/platform-sdk/src/checks.ts`（③ 文件存在性循环旁）
- Test: `packages/platform-sdk/src/checks.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `frontend.admin` 形状（`m.frontend?.admin`，zod parse 后已有）。
- Produces: runChecks 对 `frontend.admin[i].entry` 的存在性检查（错误文案格式 `frontend.admin[i].entry 指向的文件不存在: <entry>`）。

- [ ] **Step 1: 写失败测试（checks.test.ts 追加，风格沿该文件既有 fixture 写法；若已有 mkdtemp 辅助则复用）**

```ts
it('frontend.admin[].entry 指向的文件不存在 → 报错指明', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checks-admin-'))
  await mkdir(join(root, 'modules', 'demo'), { recursive: true })
  await writeFile(
    join(root, 'modules', 'demo', 'manifest.yaml'),
    `id: demo
name: 演示
version: 0.1.0
platform: '>=0.1'
permissions: [{ code: demo:view, name: 查看 }]
frontend:
  admin:
    - { path: /console/admin/demo/x, title: x, scope: demo:view, entry: ./nope.tsx }
`,
    'utf8',
  )
  const { errors } = await runChecks(root)
  expect(errors.some((e) => e.includes('frontend.admin[0].entry 指向的文件不存在'))).toBe(true)
  await rm(root, { recursive: true, force: true })
})
```

（`mkdtemp/mkdir/writeFile/rm/tmpdir/join` 按该文件既有 import 复用或补引。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/sdk test`
Expected: FAIL——errors 不含该文案（admin 循环尚未存在）。

- [ ] **Step 3: 实现（checks.ts ③ 节，console 循环之后照抄一份改 admin）**

```ts
    for (const [i, a] of (m.frontend?.admin ?? []).entries()) {
      const target = join(dirname(file), a.entry)
      if (!(await exists(target))) {
        errors.push(`${relPath}: frontend.admin[${i}].entry 指向的文件不存在: ${a.entry}`)
      }
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm --filter @platform/sdk test && pnpm exec tsx scripts/check-manifests.mjs`
Expected: PASS + `check-manifests: OK`（现网 manifest 无 admin 声明，不受影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/platform-sdk/src/checks.ts packages/platform-sdk/src/checks.test.ts
git commit -m "feat(sdk): check-manifests 校验 frontend.admin entry 存在性"
```

---

### Task 3: gen 脚本聚合 group/moduleId/storageDeclarers

**Files:**
- Modify: `scripts/gen-console-registry.mjs`
- Regenerate: `apps/web/src/console-registry.gen.ts`
- Test: `apps/web/src/console-registry.gen.test.ts`
- Mechanical fix（类型跟随）: `apps/web/src/pages/console-menu.test.ts`、`apps/web/src/pages/Console.test.tsx` 的 registry 替身补 `group`/`moduleId` 字段

**Interfaces:**
- Consumes: manifest 的 `frontend.console` / `frontend.admin` / `storage`。
- Produces: 生成物 `ConsoleRegistryEntry` 新增 `group: 'main' | 'admin'`、`moduleId: string`（必填）；新导出 `storageDeclarers: string[]`。Task 4/5 消费这些名字。

- [ ] **Step 1: 写失败测试（console-registry.gen.test.ts 追加用例 ⑤）**

```ts
  it('⑤ admin 项与 storage 声明聚合：group/moduleId 落生成物，storageDeclarers 导出声明者', async () => {
    const root = await newFixture()
    await writeModule(
      root,
      'demo',
      `id: demo
name: 演示
version: 0.1.0
platform: '>=0.1.0'
permissions: []
storage: { kind: s3 }
frontend:
  console:
    - { path: /console/demo/things, title: 演示工单, scope: demo:console, entry: ./console/main.tsx }
  admin:
    - { path: /console/admin/demo/settings, title: 演示管理, icon: SettingOutlined, scope: demo:admin, entry: ./console/admin/settings.tsx }
`,
    )
    await writeModule(
      root,
      'bare',
      `id: bare
name: 裸模块
version: 0.1.0
platform: '>=0.1.0'
permissions: []
`,
    )

    const { stdout } = await gen(root)
    expect(stdout).toContain('2 项')

    const genFile = await readGen(root)
    expect(genFile).toContain('group: "admin"')
    expect(genFile).toContain('moduleId: "demo"')
    expect(genFile).toContain('path: "/console/admin/demo/settings"')
    // storageDeclarers 只含声明 storage 的模块
    expect(genFile).toContain('export const storageDeclarers: string[] = ["demo"]')
  })
```

（现有用例 ① 断言「3 项」不受影响——admin 计数并轨进同一 entries 数组属预期行为，用例 ⑤ 的 2 项 = 1 console + 1 admin。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- src/console-registry.gen.test.ts`
Expected: FAIL——`group:`/`storageDeclarers` 不在生成物里。

- [ ] **Step 3: 实现 gen 脚本三处**

① `entriesFor` 改为两组循环（console→'main'，admin→'admin'）：

```js
function entriesFor(moduleId, manifest) {
  const out = []
  for (const [field, group] of [['console', 'main'], ['admin', 'admin']]) {
    const items = manifest?.frontend?.[field]
    if (items === undefined) continue
    if (!Array.isArray(items)) {
      throw new Error(`modules/${moduleId}/manifest.yaml: frontend.${field} 必须是数组`)
    }
    for (const [i, item] of items.entries()) {
      const where = `modules/${moduleId}/manifest.yaml frontend.${field}[${i}]`
      for (const key of ['path', 'title', 'scope', 'entry']) {
        if (typeof item?.[key] !== 'string' || item[key] === '') {
          throw new Error(`${where}: ${key} 必须是非空字符串`)
        }
      }
      out.push({
        path: item.path,
        title: item.title,
        group,
        ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
        scope: item.scope,
        entry: item.entry.replace(/^\.\//, ''),
      })
    }
  }
  return out
}
```

② 模块循环里收集 storage 声明者（`entries.push` 那行所在循环内、id 校验之后）：

```js
  if (manifest?.storage && typeof manifest.storage === 'object') storageDeclarers.push(manifest.id)
```

（`const entries = []` 旁加 `const storageDeclarers = []`；注意脚本顶部 `const entries = []` 在模块循环之前声明。）

③ 生成物 header 与 body：

- header 模板 interface 增两字段与新导出（注释同步改「来源」行为 `frontend.console / frontend.admin`）：

```ts
export interface ConsoleRegistryEntry {
  /** 模块 console 页路由（全路径，以 /console/ 开头），与 manifest frontend.console.path 一致 */
  path: string
  title: string
  /** 'main' = 模块区平铺页（frontend.console）；'admin' = 「管理」组子页（frontend.admin） */
  group: 'main' | 'admin'
  /** 声明该页的模块 id（运行时与 config 启用集做联动判定） */
  moduleId: string
  /** AntD 图标名（字符串透传；Console 壳按名映射，未知名不渲染图标） */
  icon?: string
  /** 访问该页所需权限 scope（session.scopes 成员判定） */
  scope: string
  /** 构建期聚合的懒加载器：模块 console 页模块的 default 导出（组件） */
  load: () => Promise<{ default: ComponentType }>
}

/** 声明了 storage 能力的模块 id（manifest storage 字段，构建期事实）；
 * 「存储配置」管理页显隐 = storageDeclarers ∩ config 启用模块 ≠ ∅（2026-09-20 spec） */
export const storageDeclarers: string[] = [/* 见下方生成 */]
```

- `const file =` 拼装改为：header（含上述 interface 与导出声明）→ body → 结尾再拼 storageDeclarers 数组字面量。body 单项模板插入 `group: ${JSON.stringify(e.group)},\n    moduleId: ${JSON.stringify(e.moduleId)},`（path/title 之后、icon 之前）。storageDeclarers 输出行：

```js
const declarersLine = `\n\nexport const storageDeclarers: string[] = [${storageDeclarers
  .sort()
  .map((id) => JSON.stringify(id))
  .join(', ')}]\n`
```

拼进最终文件（interface 注释里的 `/* 见下方生成 */` 占位改为直接把声明写在 header 末尾、数组体用 declarersLine——实现时以「header 字符串以 `export const storageDeclarers: string[] = [` 结尾 + declarersLine 提供数组体 + `]`」的拼法落地，保证幂等字节级一致）。

- [ ] **Step 4: 重新生成真仓 registry 并修类型跟随**

```bash
node scripts/gen-console-registry.mjs
```

生成物变化：两条现有条目各多 `group: "main"` 与 `moduleId`；文件尾新增 `export const storageDeclarers: string[] = ["aftersales"]`。

类型跟随（机械改，不改行为）：
- `console-menu.test.ts` 的 `reg()` 助手补 `group: 'main' as const, moduleId: 'ghost'`（任意合法值）；
- `Console.test.tsx` 顶部 `fakeRegistry` 声明的条目类型与 `setRegistry([...])` 各条目补 `group: 'main'`、`moduleId: '<对应模块 id>'`。

- [ ] **Step 5: 跑测试确认绿（web 包全量 + 类型）**

Run: `pnpm --filter @platform/web test && pnpm typecheck`
Expected: PASS（生成器 5 用例 + 存量全绿；typecheck 过）。

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-console-registry.mjs apps/web/src/console-registry.gen.ts apps/web/src/console-registry.gen.test.ts apps/web/src/pages/console-menu.test.ts apps/web/src/pages/Console.test.tsx
git commit -m "feat(web): registry 聚合 group/moduleId 与 storageDeclarers——管理页联动数据面"
```

---

### Task 4: console-menu 动态管理组 + Console 壳接线

**Files:**
- Modify: `apps/web/src/pages/console-menu.ts`
- Modify: `apps/web/src/pages/Console.tsx`（菜单计算处，198 行附近）
- Test: `apps/web/src/pages/console-menu.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ConsoleRegistryEntry.group/moduleId` 与 `storageDeclarers`。
- Produces:
  - `visibleAdminEntries(config: PlatformConfig, session: ScopeLike, registry: ConsoleRegistryEntry[]): VisibleAdminEntry[]`，`VisibleAdminEntry = { moduleId: string; path: string; title: string; icon?: string }`
  - `AdminMenuInput = { adminEntries: VisibleAdminEntry[]; storageVisible: boolean }`
  - `buildConsoleMenu(entries, iconMap, session, admin: AdminMenuInput)`——**第 4 参必填**（fail-explicit：调用方必须显式表态联动状态）
  - Task 5 的 StorageGate 复用同一判定式。

- [ ] **Step 1: 写失败测试（console-menu.test.ts 追加；既有 `buildConsoleMenu` 调用统一补第 4 参 `{ adminEntries: [], storageVisible: true }` 保持原断言）**

```ts
// ---- 模块管理页协议 + 存储页能力联动（2026-09-20 spec）----
describe('管理组联动', () => {
  const ADMIN_SESSION = { scopes: ['tenant:admin', 'demo:view'] }
  const regAdmin = (over: Partial<ConsoleRegistryEntry> = {}): ConsoleRegistryEntry => ({
    path: '/console/admin/demo/x', title: '演示管理页', group: 'admin', moduleId: 'demo',
    scope: 'demo:view',
    load: () => Promise.resolve({ default: (() => null) as ComponentType }),
    ...over,
  })

  it('storageVisible=false → 管理组四项变三项（存储配置消失）', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, { adminEntries: [], storageVisible: false })
    expect(menu.at(-1)?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
    ])
  })

  it('storageVisible=true → 存储配置在第 4 位；模块 admin 页排其后', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, {
      adminEntries: [{ moduleId: 'demo', path: '/console/admin/demo/x', title: '演示管理页' }],
      storageVisible: true,
    })
    expect(menu.at(-1)?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/storage',
      '/console/admin/demo/x',
    ])
  })

  it('visibleAdminEntries：模块停用（config 缺席）或无 scope 都被拦下', () => {
    const config = { tenant: { slug: 'acme', org: 'o' }, modules: [{ id: 'demo', name: '演示', console: [] }] }
    const on = visibleAdminEntries(config, ADMIN_SESSION, [regAdmin()])
    expect(on.map((e) => e.path)).toEqual(['/console/admin/demo/x'])
    // 模块停用：config 不含 demo
    const off = visibleAdminEntries({ ...config, modules: [] }, ADMIN_SESSION, [regAdmin()])
    expect(off).toEqual([])
    // scope 缺席
    const noScope = visibleAdminEntries(config, { scopes: ['tenant:admin'] }, [regAdmin()])
    expect(noScope).toEqual([])
  })

  it('group=main 的 registry 条目不进管理组（visibleAdminEntries 只认 admin）', () => {
    const config = { tenant: { slug: 'acme', org: 'o' }, modules: [{ id: 'demo', name: '演示', console: [] }] }
    const out = visibleAdminEntries(config, ADMIN_SESSION, [
      regAdmin({ path: '/console/demo', group: 'main' }),
    ])
    expect(out).toEqual([])
  })
})
```

（import 行补 `visibleAdminEntries`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- src/pages/console-menu.test.ts`
Expected: FAIL——新 describe 三红（函数不存在/参数形状不对）。

- [ ] **Step 3: 实现 console-menu.ts**

① 新类型与函数（`visibleConsoleEntries` 之后）：

```ts
export interface VisibleAdminEntry {
  moduleId: string
  path: string
  title: string
  icon?: string
}

/** 管理组子页（frontend.admin）：registry(group='admin') ∩ config 启用集 ∩ session scope——
 *  与 console 三重过滤同构（2026-09-20 spec；config 不暴露 admin 清单，前端自判） */
export function visibleAdminEntries(
  config: PlatformConfig,
  session: ScopeLike,
  registry: ConsoleRegistryEntry[],
): VisibleAdminEntry[] {
  const enabled = new Set(config.modules.map((m) => m.id))
  return registry
    .filter((r) => r.group === 'admin' && enabled.has(r.moduleId) && session.scopes.includes(r.scope))
    .map((r) => ({ moduleId: r.moduleId, path: r.path, title: r.title, icon: r.icon }))
}

/** 管理组动态输入（2026-09-20 spec）：调用方必须显式表态——adminEntries 由 visibleAdminEntries
 *  算得；storageVisible = storageDeclarers ∩ config 启用模块 ≠ ∅（Console 壳算好传入） */
export interface AdminMenuInput {
  adminEntries: VisibleAdminEntry[]
  storageVisible: boolean
}
```

② `adminGroup` 改签并动态拼 children：

```ts
function adminGroup(iconMap: Record<string, ReactNode>, admin: AdminMenuInput): MenuDataItem {
  const children: MenuDataItem[] = [
    { path: '/console/admin/users', name: '用户管理' },
    { path: '/console/admin/permissions', name: '角色与授权' },
    { path: '/console/admin/subscriptions', name: '我的订阅' },
    // 存储配置（M3c）：能力联动——启用的模块里至少一个声明 storage 才显示；无图标约定不变
    ...(admin.storageVisible ? [{ path: '/console/admin/storage', name: '存储配置' }] : []),
    // 模块管理页（frontend.admin）：manifest 声明序平铺在管理组尾部
    ...admin.adminEntries.map((e) => ({ path: e.path, name: e.title, icon: iconMap[e.icon ?? ''] })),
  ]
  return { path: '/console/admin', name: '管理', icon: iconMap['TeamOutlined'], children }
}
```

③ `buildConsoleMenu` 加必填第 4 参，末行改 `adminGroup(iconMap, admin)`。

- [ ] **Step 4: Console.tsx 接线（198 行附近菜单计算）**

```ts
import { consoleRegistry, storageDeclarers } from '../console-registry.gen'
import { buildConsoleMenu, visibleAdminEntries, visibleConsoleEntries } from './console-menu'
```

菜单 useMemo 内（原 `buildConsoleMenu(visibleConsoleEntries(...), CONSOLE_ICONS, session)`）改为：

```ts
    () =>
      buildConsoleMenu(visibleConsoleEntries(config, session, consoleRegistry), CONSOLE_ICONS, session, {
        adminEntries: visibleAdminEntries(config, session, consoleRegistry),
        storageVisible: storageDeclarers.some((id) => config.modules.some((m) => m.id === id)),
      }),
```

（原 import 行 `consoleRegistry` 处合并；工作台 `visibleConsoleEntries` 调用不动——admin 页不进工作台。）

- [ ] **Step 5: 跑测试确认绿**

Run: `pnpm --filter @platform/web test && pnpm typecheck`
Expected: PASS（console-menu 新 4 用例 + Console 壳存量全绿；typecheck 过）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/console-menu.ts apps/web/src/pages/Console.tsx apps/web/src/pages/console-menu.test.ts
git commit -m "feat(web): 管理组动态化——模块 admin 页聚合与存储配置能力联动"
```

---

### Task 5: StorageGate 路由门 + 壳级集成测试

**Files:**
- Modify: `apps/web/src/pages/Console.tsx`（新增导出 `StorageGate`，置于 `AdminGate` 旁）
- Modify: `apps/web/src/App.tsx`（storage 路由包一层）
- Test: `apps/web/src/pages/Console.test.tsx`

**Interfaces:**
- Consumes: Task 3 `storageDeclarers`；`ConsoleOutletContext.config`；Task 4 的判定式。
- Produces: `export function StorageGate({ children }: { children: ReactNode })`——config 启用集与 storageDeclarers 无交集时渲染「模块可能未启用」Result。

- [ ] **Step 1: 写失败测试（Console.test.tsx 追加；vi.mock 工厂扩 storageDeclarers）**

① 顶部 mock 改为（`fakeRegistry` 声明保持，新增可变数组）：

```ts
vi.mock('../console-registry.gen', () => ({
  consoleRegistry: fakeRegistry,
  storageDeclarers: fakeStorageDeclarers,
}))
```

（`fakeRegistry` 声明旁加 `const fakeStorageDeclarers: string[] = []`，并加 setter：）

```ts
function setStorageDeclarers(ids: string[]): void {
  fakeStorageDeclarers.splice(0, fakeStorageDeclarers.length, ...ids)
}
```

② 新用例（放在管理组相关用例附近；`afterEach` 已 resetAllMocks，数组用例内自清）：

```ts
  it('⑧ 存储配置能力联动：config 无 storage 声明者 → 菜单不出现 + 直敲出「未启用」Result', async () => {
    setRegistry([])
    setStorageDeclarers(['aftersales'])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse({ ...SESSION, scopes: ['tenant:admin', 'demo:console'] }),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY), // demo 启用、aftersales 不在
    })

    renderApp()

    expect(await screen.findByText('概览')).toBeInTheDocument()
    // 菜单无「存储配置」（管理组内）
    expect(screen.queryByText('存储配置')).not.toBeInTheDocument()
    // 直敲 /console/admin/storage → 未启用 Result（AdminGate 先过：session 有 tenant:admin）
    window.history.pushState({}, '', '/console/admin/storage')
    expect(await screen.findByText('模块可能未启用或未发布，请联系管理员')).toBeInTheDocument()
  })

  it('⑧b 声明者启用 → 存储配置出现在管理组', async () => {
    setRegistry([])
    setStorageDeclarers(['demo']) // 与 CONFIG_DEMO_ONLY 的 demo 相交
    mockApi({
      '/api/platform/auth/session': () => jsonResponse({ ...SESSION, scopes: ['tenant:admin', 'demo:console'] }),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()

    expect(await screen.findAllByText('存储配置')).not.toHaveLength(0)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- src/pages/Console.test.tsx`
Expected: FAIL——⑧b 能过（现行为恒显示）而 ⑧ 红（当前无门：菜单仍出现存储配置/直敲渲染真页面）；以 ⑧ 红为准。

- [ ] **Step 3: 实现 StorageGate（Console.tsx，AdminGate 之后）**

```tsx
/**
 * /console/admin/storage 的能力联动门（2026-09-20 spec）：启用的模块里无任何 storage 声明者
 * → 「模块未启用」Result（与模块页 404 语义一致，不是裸 404）。外层 AdminGate 仍管 tenant:admin；
 * API 门禁不变（宿主域，spec 记录在案）。
 */
export function StorageGate({ children }: { children: ReactNode }) {
  const { config } = useOutletContext<ConsoleOutletContext>()
  const visible = storageDeclarers.some((id) => config.modules.some((m) => m.id === id))
  if (!visible) {
    return <Result status="404" title="页面不存在" subTitle="模块可能未启用或未发布，请联系管理员" />
  }
  return <>{children}</>
}
```

（`Result`/`ReactNode`/`useOutletContext` 均已在文件内 import。）

- [ ] **Step 4: App.tsx 路由包一层**

```tsx
{ path: 'admin/storage', element: <AdminGate><StorageGate><AdminStoragePage /></StorageGate></AdminGate> },
```

（import 行加 `StorageGate`。）

- [ ] **Step 5: 跑测试确认绿**

Run: `pnpm --filter @platform/web test && pnpm typecheck`
Expected: PASS（含 ⑧/⑧b）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Console.tsx apps/web/src/App.tsx apps/web/src/pages/Console.test.tsx
git commit -m "feat(web): 存储配置页能力联动路由门——模块停用即隐即拦"
```

---

### Task 6: 正典更新 + 浏览器验收 + 门禁 + issue + PR

**Files:**
- Modify: `docs/module-protocol.md`（frontend.console/frontmatter 相关章节附近新增 `frontend.admin` 节）

**Interfaces:**
- Consumes: Task 1–5 全部提交。
- Produces: 正典文本 + PR。

- [ ] **Step 1: module-protocol.md 新增正典节（放在 frontend.console 相关内容之后）**

```markdown
### frontend.admin —— 模块管理页（2026-09-20）

> 适用：`modules/<id>/manifest.yaml` 的**可选** `frontend.admin`。契约源
> `packages/platform-sdk/src/manifest.ts`。spec：`docs/superpowers/specs/2026-09-20-module-admin-pages-design.md`。

```yaml
frontend:
  admin:
    - path: /console/admin/<module>/<page>   # 必须 /console/admin/ 开头（schema 拒绝）
      title: 页面标题
      icon: SettingOutlined                  # 可选；壳侧 CONSOLE_ICONS 同规
      scope: <module>:manage                 # 必须 ∈ permissions[].code（schema 拒绝）
      entry: ./console/admin/<page>.tsx      # 模块内文件（check-manifests 验存在）
```

- **语义**：模块自有的「管理」组子页。门禁双层——组门 `tenant:admin`（宿主施加，同平台
  内置管理页）+ 页门 `scope`（同 console 条目判定）。
- **显隐联动**：菜单/路由 = registry（构建期聚合，`group:'admin'`）∩ config 启用集（运行时，
  订阅/tenant_module）∩ session scope——与 `frontend.console` 三重过滤同构。**模块停用 ⇒ 页面
  消失**（菜单不出、直敲出「模块可能未启用」Result）。
- **服务端 config 不暴露 admin 清单**：前端按 registry∩config 自判，零后端改动。
- **path 约束双向**：admin 必须落 `/console/admin/` 下；`frontend.console[].path` 不得占用该
  前缀（schema 双拦——防串组：菜单把 console 条目当模块区平铺页）。
- **管理组 children 顺序**：平台内置三项（用户/角色/我的订阅）→ 存储配置（能力联动：
  `storageDeclarers ∩ 启用模块 ≠ ∅`，见下）→ 模块 admin 页（manifest 声明序）。
- **存储配置页归属**：留宿主（管的是 `platform.tenant` 租户全局五列，非模块私有配置）；
  `/api/admin/storage` 门禁保持 `tenant:admin` 不随模块联动（宿主域，spec 记录在案）。
```

- [ ] **Step 2: 浏览器验收（dev-stack 真联动）**

```bash
pnpm --filter @platform/web build
pnpm dev:stack   # → http://127.0.0.1:13100
```

CDP 走查（web-access skill）：
1. `admin1/pw` 登录 → 管理组含「存储配置」（aftersales 启用、demo 亦在）；
2. 本机 PG 翻开关：`psql postgres://platform:platform@127.0.0.1:5432/platform -c "insert into platform.tenant_module(tenant_id, module_id, enabled) select id,'aftersales',false from platform.tenant where product_name='Acme 工单' on conflict (tenant_id, module_id) do update set enabled=false;"`
3. ≤60s 刷新：售后菜单消失，且**管理组里「存储配置」同时消失**；
4. 直敲 `/console/admin/storage` → 「模块可能未启用或未发布」Result；
5. 还原：`psql postgres://platform:platform@127.0.0.1:5432/platform -c "update platform.tenant_module set enabled=true where module_id='aftersales';"`（或 `delete from platform.tenant_module where module_id='aftersales';`——无行=启用），刷新确认恢复；
6. 375px 视口（headless 截图法）管理组折叠形态正常。

- [ ] **Step 3: 全量门禁（与 CI 同款）**

```bash
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec tsx scripts/check-tenant-isolation.mjs
pnpm --filter @platform/web build
```

Expected: 全绿；红了先修再继续。

- [ ] **Step 4: issue + push + PR**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "模块管理页协议（frontend.admin）+ 存储配置页能力联动" \
  --body "管理组四项壳侧写死、与模块启停零联动：售后停用后存储配置页仍挂管理组。目标：manifest 可声明管理组子页（frontend.admin，随模块启停联动）；存储配置页按 storage 能力联动显隐。设计：docs/superpowers/specs/2026-09-20-module-admin-pages-design.md"
git push -u origin feat/module-admin-pages
gh pr create --repo MYTech-Co-LTD/platform-core --base main \
  --title "feat(sdk): 模块管理页协议与存储配置能力联动" \
  --body "Closes #<issue 号>

## 改了什么
- SDK manifest 协议新增 frontend.admin（管理组子页声明；路径前缀/scope/防串组三条约法由 schema 承载）；check-manifests 验 entry 存在性。
- gen 脚本聚合 group/moduleId + storageDeclarers；console-menu 管理组动态化（visibleAdminEntries 三重过滤 + buildConsoleMenu 第 4 参必填）；StorageGate 路由门。
- 存储配置页：storageDeclarers ∩ 启用模块 ≠ ∅ 才显示/可达；API 门禁不动（spec 记录）。
- 零后端零 DB；本期无模块声明 frontend.admin（协议就位等首个案例）；module-protocol.md 正典更新。

## 验收
- [x] SDK/gen/menu/壳级测试全绿（含联动矩阵与直敲 Result）
- [x] 浏览器真联动走查：翻 tenant_module → 60s 内售后与存储配置同隐同现；直敲出未启用提示
- [x] 全量门禁（test/typecheck/5 守卫/build）

spec: docs/superpowers/specs/2026-09-20-module-admin-pages-design.md
plan: docs/superpowers/plans/2026-09-20-module-admin-pages.md"
```

- [ ] **Step 5: PR CI 绿后请人合并（squash）；合并后部署自动（仅 mytech 实例——山海 autoDeploy=false，需手动触发，发布清单记得）**
