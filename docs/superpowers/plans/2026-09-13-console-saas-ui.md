# console SaaS 化改造（Pro v6 风格落现有壳）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 console 壳改造成 Pro v6 风格——mix 顶栏形态、菜单按 spec §3 位置规则排列、概览升级为工作台、顶栏暗色切换（关联 issue #36，规划稿 `docs/superpowers/specs/2026-09-13-console-saas-ui-blueprint-design.md`）。

**Architecture:** 不换栈、不引入新依赖。改动收敛在 `apps/web`：菜单计算抽成纯函数（`console-menu.ts`，菜单与工作台共用），`Console.tsx` 壳换 `layout="mix"` + 暗色状态，概览页重写。模块聚合机制（`gen-console-registry.mjs`、manifest）零改动。

**Tech Stack:** React 19 + antd 6.6.3（`theme.darkAlgorithm` 已核实存在）+ @ant-design/pro-components 3.1.14-7（ProLayout）+ vitest + @testing-library/react。

## Global Constraints

- 菜单位置规则唯一事实源 = spec §3：概览(1) → `case-engine` 模块页(2，模块未落地则该位缺席) → 其余模块页按 manifest 声明序。
- 三重过滤（config ∩ registry ∩ scope）与去重（同 path 首个声明者胜）语义**不得改变**（沿袭 Task 18）。
- 主色/标题/logo 继续走 branding API（`getBranding` → ConfigProvider token），**不写死**。
- 明确不做（spec D4）：多标签页、通知、租户切换、平台管理/帮助组菜单与页面、模块页样式改造。
- `console-registry.gen.ts` 是生成物，**不许手改**。
- 提交走 Conventional Commits，PR 带 `Closes #36`；实施分支 `feat/console-saas-ui`（自 origin/main 切）。
- 任何偏离本计划的方向调整：先改规划稿（spec）再动码（用户铁律，2026-09-13）。

---

### Task 0: 分支就位

- [ ] **Step 1: 从 origin/main 切实施分支**

```bash
git fetch origin main
git checkout -b feat/console-saas-ui origin/main
```

---

### Task 1: 菜单计算抽纯函数 + 位置规则

**Files:**
- Create: `apps/web/src/pages/console-menu.ts`
- Test: `apps/web/src/pages/console-menu.test.ts`
- Modify: `apps/web/src/pages/Console.tsx`（`menuItems` 改为调用新函数，行为等价 + 新排序）

**Interfaces:**
- Produces: `visibleConsoleEntries(config, session, registry) → VisibleConsoleEntry[]`（Task 3 工作台直接复用）；`buildConsoleMenu(entries, iconMap) → MenuDataItem[]`
- `VisibleConsoleEntry = { moduleId: string; moduleName: string; path: string; title: string; icon?: string }`

- [ ] **Step 1: 写失败测试（纯函数，不起路由）**

```ts
// console-menu.test.ts — 菜单位置规则（spec §3）与三重过滤的纯函数测试（issue #36）
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { buildConsoleMenu, visibleConsoleEntries } from './console-menu'
import type { ConsoleRegistryEntry } from '../console-registry.gen'

const CONFIG = {
  tenant: { slug: 'acme', org: 'acme-org' },
  modules: [
    {
      id: 'first', name: '第一模块',
      console: [{ path: '/console/first/a', title: 'A 页', scope: 'first:view' }],
    },
    {
      id: 'case-engine', name: 'AI 助手',
      console: [{ path: '/console/case-engine', title: 'AI 助手', scope: 'case-engine:chat' }],
    },
    {
      id: 'ghosty', name: '幽灵模块',
      console: [
        { path: '/console/ghost/page', title: '幽灵页', scope: 'ghost:view' }, // registry 缺席
        { path: '/console/first/a', title: '重复声明', scope: 'first:view' },   // 同 path 去重
      ],
    },
  ],
}

const SESSION = { scopes: ['first:view', 'case-engine:chat', 'ghost:view'] }
const SESSION_PARTIAL = { scopes: ['first:view'] } // 无 case-engine 权限

function reg(path: string, scope: string): ConsoleRegistryEntry {
  return { path, title: path, scope, load: () => Promise.resolve({ default: (() => null) as ComponentType }) }
}
const REGISTRY = [reg('/console/first/a', 'first:view'), reg('/console/case-engine', 'case-engine:chat')]

describe('visibleConsoleEntries（三重过滤 + 去重）', () => {
  it('config∩registry∩scope 全过才可见；registry 缺席与同 path 重复声明被剔除', () => {
    const out = visibleConsoleEntries(CONFIG, SESSION, REGISTRY)
    expect(out.map((e) => e.path)).toEqual(['/console/first/a', '/console/case-engine'])
    expect(out[0]).toMatchObject({ moduleId: 'first', moduleName: '第一模块', title: 'A 页' })
  })
  it('无 scope 的项被拦下', () => {
    const out = visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY)
    expect(out.map((e) => e.path)).toEqual(['/console/first/a'])
  })
})

describe('buildConsoleMenu（spec §3 位置规则）', () => {
  it('概览恒第 1；case-engine 模块页钉第 2（即使 manifest 声明在后）；其余按声明序', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION, REGISTRY), {})
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/case-engine', '/console/first/a'])
  })
  it('case-engine 未落地/无权限时该位自然缺席，不产生空位', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY), {})
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/first/a'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- console-menu`
Expected: FAIL（`console-menu.ts` 不存在）

- [ ] **Step 3: 实现 `console-menu.ts`**

```ts
// console-menu.ts — 菜单与工作台共用的「可见模块页」计算（SaaS 化改造，issue #36）。
//
// 位置规则唯一事实源：docs/superpowers/specs/2026-09-13-console-saas-ui-blueprint-design.md §3——
// 概览(1) → pinned 模块(2) → 其余模块页按 manifest 声明序。三重过滤（config∩registry∩scope）
// 与去重（同 path 首个声明者胜）沿袭 Task 18 语义，本文件只是把它抽成纯函数供菜单与工作台共用。
import type { ReactNode } from 'react'
import type { MenuDataItem } from '@ant-design/pro-components'
import type { ConsoleRegistryEntry } from '../console-registry.gen'
import type { PlatformConfig } from '../lib/api'

/** spec §3 第 2 位：AI 助手（case-engine 模块）。模块未落地时该位自然缺席。 */
const PINNED_MODULE_IDS: readonly string[] = ['case-engine']

export interface VisibleConsoleEntry {
  moduleId: string
  moduleName: string
  path: string
  title: string
  icon?: string
}

export interface ScopeLike {
  scopes: string[]
}

/** 三重过滤 + 去重后的可见模块页（config ∩ registry ∩ scope），保持 manifest 声明序 */
export function visibleConsoleEntries(
  config: PlatformConfig,
  session: ScopeLike,
  registry: ConsoleRegistryEntry[],
): VisibleConsoleEntry[] {
  const out: VisibleConsoleEntry[] = []
  const seen = new Set<string>()
  for (const m of config.modules) {
    for (const c of m.console) {
      if (seen.has(c.path)) continue // 同 path 只出一次（首个声明者胜）
      seen.add(c.path)
      const reg = registry.find((r) => r.path === c.path)
      if (!reg) continue // config 有但构建期没挂载（新模块未发布）→ 不可见
      if (!session.scopes.includes(c.scope)) continue // 权限门禁
      out.push({ moduleId: m.id, moduleName: m.name, path: reg.path, title: c.title, icon: c.icon ?? reg.icon })
    }
  }
  return out
}

/** 顶栏菜单：概览 → pinned 模块页 → 其余模块页（manifest 序）；icon 由壳侧映射表注入 */
export function buildConsoleMenu(
  entries: VisibleConsoleEntry[],
  iconMap: Record<string, ReactNode>,
): MenuDataItem[] {
  const pinned = entries.filter((e) => PINNED_MODULE_IDS.includes(e.moduleId))
  const rest = entries.filter((e) => !PINNED_MODULE_IDS.includes(e.moduleId))
  return [
    { path: '/console', name: '概览' },
    ...[...pinned, ...rest].map((e) => ({
      path: e.path,
      name: e.title,
      icon: iconMap[e.icon ?? ''],
    })),
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @platform/web test -- console-menu`
Expected: PASS（4 条）

- [ ] **Step 5: `Console.tsx` 的 `menuItems` 改为调用新函数**

`ConsoleLayout` 内（现 `Console.tsx:139-157`）替换为：

```ts
import { buildConsoleMenu, visibleConsoleEntries } from './console-menu'
// …
const menuItems = useMemo(
  () => buildConsoleMenu(visibleConsoleEntries(config, session, consoleRegistry), CONSOLE_ICONS),
  [config, session],
)
```

原内联过滤逻辑删除（已上移纯函数）；`MenuDataItem` 类型导入如不再使用可清。

- [ ] **Step 6: 跑既有 Console 测试确认无回归**

Run: `pnpm --filter @platform/web test`
Expected: PASS（①/①b/②/②b/②c/③/★/④ 全绿——过滤语义等价）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/console-menu.ts apps/web/src/pages/console-menu.test.ts apps/web/src/pages/Console.tsx
git commit -m "feat(console): 菜单计算抽纯函数并落位置规则——概览→case-engine→manifest 序 (#36)"
```

---

### Task 2: mix 布局 + 顶栏暗色切换

**Files:**
- Modify: `apps/web/src/pages/Console.tsx`（`ConsoleShell`/`ConsoleLayout`）
- Test: `apps/web/src/pages/Console.test.tsx`（新增用例）

**Interfaces:**
- Consumes: Task 1 的 `buildConsoleMenu`（已在用）
- Produces: `ConsoleLayout` 新增 props `{ dark: boolean; onToggleDark: () => void }`；localStorage key `console-theme`（值 `light`|`dark`）

- [ ] **Step 1: 确认 SunOutlined 存在（图标名核对，30 秒）**

Run: `ls node_modules/.pnpm/@ant-design+icons*/node_modules/@ant-design/icons/es/icons/ | grep -E '^(Sun|Moon)Outlined'`
Expected: 两个都有（MoonOutlined 已核实；若 SunOutlined 缺席，按钮只用 MoonOutlined + `aria-pressed` 表状态，后续步骤的 icon 二选一随之简化）

- [ ] **Step 2: 写失败测试（追加到 `Console.test.tsx` 的 describe 内）**

```ts
  it('⑤ 暗色切换：点击写入 localStorage，再点切回；初始读取持久化值', async () => {
    setRegistry([])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })
    localStorage.setItem('console-theme', 'dark') // 初始持久化值

    renderApp()
    const btn = await screen.findByRole('button', { name: '切换暗色模式' })
    // dark 态点击 → light
    fireEvent.click(btn)
    await waitFor(() => expect(localStorage.getItem('console-theme')).toBe('light'))
    // 再点 → dark
    fireEvent.click(btn)
    await waitFor(() => expect(localStorage.getItem('console-theme')).toBe('dark'))
    localStorage.removeItem('console-theme')
  })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- Console`
Expected: ⑤ FAIL（找不到「切换暗色模式」按钮）

- [ ] **Step 4: 实现**

`ConsoleShell`（state 与 ConfigProvider 所在层）：

```tsx
import { MoonOutlined, SunOutlined } from '@ant-design/icons'
import { theme as antdTheme } from 'antd' // 与现有 antd 导入合并，避免重复 import
// …
const [dark, setDark] = useState(() => localStorage.getItem('console-theme') === 'dark')
const toggleDark = () =>
  setDark((d) => {
    const next = !d
    localStorage.setItem('console-theme', next ? 'dark' : 'light')
    return next
  })
// …ready 分支的 ConfigProvider：
<ConfigProvider
  theme={{
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: { colorPrimary: branding.primaryColor },
  }}
>
  <ConsoleLayout session={booted.session} config={booted.config} branding={branding} dark={dark} onToggleDark={toggleDark} />
</ConfigProvider>
```

`ConsoleLayout`：props 加 `{ dark, onToggleDark }`；`<ProLayout layout="mix" …>`（原 `layout="side"`）；`actionsRender` 首位插按钮：

```tsx
actionsRender={() => [
  <Button
    key="theme"
    size="small"
    aria-label="切换暗色模式"
    icon={dark ? <SunOutlined /> : <MoonOutlined />}
    onClick={onToggleDark}
  />,
  <Button key="logout" size="small" loading={loggingOut} onClick={() => void onLogout()}>
    退出登录
  </Button>,
]}
```

- [ ] **Step 5: 跑测试确认通过（含全部既有用例）**

Run: `pnpm --filter @platform/web test`
Expected: PASS（⑤ 新绿 + ①–④/★ 无回归；★ 用例的定时器收尸机制不受影响——只新增了一个 Button）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Console.tsx apps/web/src/pages/Console.test.tsx
git commit -m "feat(console): 布局 mix 化 + 顶栏暗色切换（localStorage 持久化，主色仍走 branding）(#36)"
```

---

### Task 3: 概览升级为工作台（欢迎卡 + 模块入口卡片）

**Files:**
- Modify: `apps/web/src/pages/Console.tsx`（`ConsoleOutletContext` 加 `branding`；`ConsoleOverview` 重写）
- Test: `apps/web/src/pages/Console.test.tsx`（改 ② 断言 + 新增 ⑥）

**Interfaces:**
- Consumes: Task 1 的 `visibleConsoleEntries`；既有 `useOutletContext`/`useNavigate`
- Produces: `ConsoleOutletContext = { session; config; branding }`（模块页只读 session，加字段向后兼容）

- [ ] **Step 1: 改造测试（先红）——② 断言更新 + 新增 ⑥**

`② 用例`（registry 为空）断言替换：`demo:console` scope 标签不再展示，改为工作台断言：

```ts
    // 概览页（index 路由）内容：欢迎卡（用户/租户）+ 空模块态
    expect(await screen.findByText('acme')).toBeInTheDocument()
    expect(screen.getAllByText('Alice 陈').length).toBeGreaterThan(0)
    expect(screen.getByText(/当前没有可用的模块/)).toBeInTheDocument()
```

新增 ⑥（放 ②b 之后）：

```ts
  it('⑥ 工作台：模块入口卡片按可见集合渲染，点击直达模块页', async () => {
    setRegistry([
      { path: '/console/demo/things', title: '演示工单', icon: 'AppstoreOutlined', scope: 'demo:console', load: () => Promise.resolve({ default: DemoPage }) },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()
    // 工作台出现模块入口卡片（标题 + 所属模块名）
    const card = await screen.findByText('演示工单')
    expect(card).toBeInTheDocument()
    expect(screen.getByText('演示模块')).toBeInTheDocument() // moduleName 来自 config
    // 点击卡片 → 懒加载模块页
    fireEvent.click(card)
    expect(await screen.findByText('演示模块页面内容')).toBeInTheDocument()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- Console`
Expected: ② 与 ⑥ FAIL（旧概览无卡片/无空态文案）

- [ ] **Step 3: 实现工作台概览**

`ConsoleOutletContext` 加字段并在 `<Outlet context={{ session, config, branding }}>` 注入；`ConsoleOverview` 重写：

```tsx
export function ConsoleOverview() {
  const { session, config, branding } = useOutletContext<ConsoleOutletContext>()
  const navigate = useNavigate()
  const entries = visibleConsoleEntries(config, session, consoleRegistry)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card styles={{ body: { padding: 24 } }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          你好，{session.user.displayName}
        </Typography.Title>
        <Typography.Text type="secondary">
          租户 {config.tenant.slug} · 组织 {session.org} · {branding.productName}
        </Typography.Text>
      </Card>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          模块
        </Typography.Title>
        {entries.length === 0 ? (
          <Typography.Text type="secondary">当前没有可用的模块</Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {entries.map((e) => (
              <Card
                key={e.path}
                hoverable
                style={{ width: 240, borderRadius: 12 }}
                onClick={() => navigate(e.path)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {CONSOLE_ICONS[e.icon ?? '']}
                  <Typography.Text strong>{e.title}</Typography.Text>
                </div>
                <Typography.Text type="secondary">{e.moduleName}</Typography.Text>
              </Card>
            ))}
          </div>
        )}
      </div>
      {/* 预留数据位：平台指标卡（接入后在此渲染，见 spec §3 第 1 行） */}
    </div>
  )
}
```

顶部补导入：`import { useNavigate } from 'react-router-dom'`、`import { visibleConsoleEntries } from './console-menu'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @platform/web test`
Expected: PASS（② 改后绿 + ⑥ 绿 + 其余无回归）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Console.tsx apps/web/src/pages/Console.test.tsx
git commit -m "feat(console): 概览升级为工作台——欢迎卡+模块入口卡片网格+预留数据位 (#36)"
```

---

### Task 4: 全量回归 + PR

- [ ] **Step 1: 仓级全量门禁**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（含 `test:guard`、`typecheck:scripts`）

- [ ] **Step 2: 验收对照（spec §5 五条，逐条勾）**

1. 概览在首、模块区按规则排列（Task 1 测试钉死）
2. 工作台卡片点击可达（Task 3 ⑥）
3. 暗色切换 + 持久化（Task 2 ⑤）
4. 三重过滤回归（①/①b/②c 既有用例）
5. CI 全绿（Step 1）

- [ ] **Step 3: 推分支开 PR**

```bash
git push -u origin feat/console-saas-ui
gh pr create --title "feat(console): console SaaS 化改造——Pro v6 风格落现有壳（mix 布局/菜单位置规则/工作台/暗色切换）" --body "Closes #36

规划稿：docs/superpowers/specs/2026-09-13-console-saas-ui-blueprint-design.md（PR #35）
实施计划：docs/superpowers/plans/2026-09-13-console-saas-ui.md

- 菜单位置规则抽纯函数（概览→case-engine→manifest 序），三重过滤语义不变
- layout=mix 顶栏形态 + 暗色切换（localStorage 持久化，主色仍走 branding）
- 概览升级为工作台：欢迎卡 + 模块入口卡片 + 预留数据位

验收对照 spec §5 五条全过；测试新增 5 条（console-menu 4 + Console ⑤⑥ 中新行为）。"
```

（PR body 中的测试计数按实际微调；merge 走 squash。）
