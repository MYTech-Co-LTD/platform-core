# 售后模块 M3a（console 管理端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 wuji-1 的售后管理端（工单/规则/员工/商品/门店 5 页）重写进 platform-core 的 console，收进 `modules/aftersales/console/` 的**一个 console 条目 + 模块内 tabs**。

**Architecture:** 纯前端移植，**不扩后端**——页面只调 M2a 已上线的模块 API。模块 console 页在构建期由 `gen-console-registry.mjs` 从 `manifest.yaml` 的 `frontend.console` 聚合成 `apps/web/src/console-registry.gen.ts`，Console 壳懒加载并把 `session/config/branding` 经 Outlet 注入。模块 → 宿主**零反向依赖**。

**Tech Stack:** React 19 + antd 6 + react-router-dom 6 + `@platform/sdk/web` 的 `platformFetch`；测试用 vitest + happy-dom + `@testing-library/react`。

## Global Constraints

以下逐字取自 spec（`docs/superpowers/specs/2026-09-15-aftersales-module-design.md`），每个任务的要求都隐含包含本节。

- **落点**：`modules/aftersales/console/`；入口 `index.tsx` 默认导出组件；照 `modules/demo/console/` 范式。
- **HTTP 只走 `platformFetch`**（`@platform/sdk/web`）——它是模块前端唯一 API 客户端（管会话 cookie 与 401 跳登录）。
- **零反向依赖 `apps/web`**：不 import 宿主应用的任何类型；用到的 Outlet context 结构**本地声明子集**。
- **权限只读 Outlet 注入的 `session.scopes`**，模块侧**不写** `requireScope`（门禁由宿主按 manifest 声明施加）。
- **§0.3「迁移即重构」**：不搬运「前端算金额 / 全量拉取 + 前端过滤 / 多步 await 编排」——这些在 M2a 已收敛成服务端单端点。
- **处理弹窗不显示预估金额**：`ratio` 路只选/填比例、盲提交；**前端不引入第二份金额公式**。
- **砍掉项**（端点不存在，一个都不做）：批量删除 / 导出 / 员工导入 / 品牌筛选 / 状态计数。
- **无 `total` 的端点不摆假页码**：`GET /rules`、`GET /employees`、`GET /stores` 回 `{items}` 无 `total` ⇒ 单页展示。
- **测试纪律（AGENTS.md #11）**：测试替身必须收严到真机形状 ⇒ 响应类型从 `api-types.ts` 取，不手抄形状。
- **门禁**：`pnpm typecheck` / `pnpm test` / `pnpm --filter @platform/web build` / 四道守卫脚本 / `smoke-load` 全绿。
- ⚠️ **模块 console 代码受 `apps/web` 那套更严的 tsconfig 约束**（实测发现，不是推测）：
  `apps/web/tsconfig.app.json` 虽是 `include: ["src"]`，但 TypeScript **会跟随 import** 把
  `modules/*/console/**` 拉进自己的 program（`apps/web/src/console-registry.gen.ts` 里那句
  `import("../../../modules/…/console/index.tsx")` 就是入口）⇒ 下面两条**对模块 console 代码同样生效**：
  - `noUnusedLocals` / `noUnusedParameters` —— **不许留未使用的导入或参数**（`_` 前缀参数除外）
  - `verbatimModuleSyntax` —— **类型导入必须写 `import type { … }`**，不能与值导入混在一句里
- ⚠️ **antd 6 的弃用 prop（实施中实测撞到，已写进下面的代码）**：本项目 antd 是 **^6.0.0**，
  与 antd 5 的写法有几处不同，而**本仓约定不留弃用告警**（见 `modules/demo/console/index.tsx`
  里 antd `List` 那行注释）。实测撞到并已修的三条：
  - `Alert` 的 `message=` ⇒ **`title=`**（`description=` 仍可用）
  - `Modal` 的 `destroyOnClose` ⇒ **`destroyOnHidden`**
  - `Space` 的 `direction=` ⇒ **`orientation=`**
  **每写完一个页面跑一次 `pnpm --filter aftersales test` 并 grep `deprecat`**，
  还有别的弃用会以 `Warning: [antd: 组件] …` 打出来。
- ⚠️ **antd 对「两个汉字」的按钮会自动插空格**：`okText="提交"` 实际渲染成 `提 交`，
  于是 `getByRole('button', { name: '提交' })` **找不到**。测试里用正则 **`/提\s*交/`**。
- ⚠️ **模块页的按钮文案必须显式写，不依赖宿主 locale**：antd 的 `Modal`/`Popconfirm` 默认按钮
  文案跟随 **locale**——测试里没有 `ConfigProvider` ⇒ 默认英文 `OK`，而真实 app（apps/web 壳里）
  是中文。同一份代码在两种环境下的可访问名不同，测试就会假红。
  ⇒ 本模块的 `Modal`/`Popconfirm` **一律显式给 `okText` / `cancelText`**（本模块其余文案本来就
  全是硬编码中文，本就不该受宿主 locale 影响）。

## 波次划分（派发用）

| 波 | 任务 | 并行性 |
|---|---|---|
| **Wave 1** | Task 1 骨架 → Task 2 console 公共库 → Task 3 共享类型 | **串行**（T2 用 T1 的目录与构建配置；T3 是 Wave 2 各页的类型来源） |
| **Wave 2** | Task 4 工单列表 · Task 5 工单详情+处理弹窗 · Task 6 规则 · Task 7 员工 · Task 8 商品+门店 | **可并行**——Task 1 已建好每个页面的骨架文件，本波每个任务**只改自己那一个目录**，文件集合互不相交 |
| **Wave 3** | Task 9 收口 | 串行（波末全量门禁） |

> Wave 2 的并行前提是**文件集合互不相交**（`dispatch-and-visibility.md` §1）。Task 1 因此必须把
> 5 个页面文件与 tabs 路由**一次性建好**；Task 2 必须把公共库建好——否则某页任务顺手创建它们，
> 就把并行变成了串行。

## 文件结构

```
modules/aftersales/
  manifest.yaml              改：加 1 条 frontend.console
  package.json               改：加 react/antd/react-router-dom + 测试依赖
  tsconfig.json              改：jsx + DOM lib + 排除 *.test.tsx
  vitest.config.ts           改：node（后端）+ happy-dom（console）两个 project
  api-types.ts               新：服务端与 console 共用的响应类型（单一事实源）
  routes/*.ts                改：响应用 api-types.ts 的类型标注（**不改行为**）
  console/
    index.tsx                新：tabs 路由壳（5 个子路由）
    lib/api.ts               新：platformFetch 薄封装 + 错误码→文案
    lib/useList.ts           新：列表加载/筛选（分页可选）
    lib/api.test.ts          新
    tickets/index.tsx        新：工单列表（status 筛选 + 真分页）
    tickets/index.test.tsx   新
    tickets/ProcessDialog.tsx    新：处理弹窗（三形状）
    tickets/ProcessDialog.test.tsx 新
    rules/index.tsx          新：规则 CRUD
    rules/index.test.tsx     新
    employees/index.tsx      新：员工列表 + 新建 + 审批
    employees/index.test.tsx 新
    products/index.tsx       新：商品只读（有 total，真分页）
    products/index.test.tsx  新
    stores/index.tsx         新：门店只读（无 total，单页）
    stores/index.test.tsx    新
apps/web/src/console-registry.gen.ts   改：build 时重生成（进 git）
```

---

## Wave 1

### Task 1: 模块 console 骨架（依赖 / 构建配置 / manifest 声明 / tabs 路由）

**Files:**
- Modify: `modules/aftersales/package.json`
- Modify: `modules/aftersales/tsconfig.json`
- Modify: `modules/aftersales/vitest.config.ts`
- Modify: `modules/aftersales/manifest.yaml`
- Modify: `apps/web/src/console-registry.gen.ts`（生成物，由 build 重生成）
- Create: `modules/aftersales/console/index.tsx`
- Create: `modules/aftersales/console/index.test.tsx`
- Create: 5 个页面骨架：`console/{tickets,rules,employees,products,stores}/index.tsx`

**Interfaces:**
- Consumes: `platformFetch` from `@platform/sdk/web`；`useOutletContext` from `react-router-dom`
- Produces: 路由路径 `/console/aftersales/{tickets,rules,employees,products,stores}`；每页组件 `export default function XxxPage()`

- [ ] **Step 1: 加依赖**（照 `modules/demo/package.json` 的同一组）

`modules/aftersales/package.json` 的 `dependencies` 加：

```json
    "antd": "^6.0.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^6.30.0",
```

`devDependencies` 加：

```json
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.2.0",
    "happy-dom": "^20.14.0",
```

然后 `pnpm install`。

- [ ] **Step 2: 配 tsconfig**（`modules/aftersales/tsconfig.json` 整体替换）

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  },
  // 测试文件归 vitest 管（同 apps/server、packages/auth-core、modules/demo 惯例）
  "exclude": ["**/*.test.ts", "**/*.test.tsx"]
}
```

- [ ] **Step 3: 配 vitest 的**两个 project**（`modules/aftersales/vitest.config.ts` 整体替换）

⚠️ **不要用 `environmentMatchGlobs`** —— 实测 vitest 3.2.7 会对它打
`DEPRECATED` 告警，而本仓有约定「不给后来者留弃用告警」（见 `modules/demo/console/index.tsx` 里
antd `List` 那行注释）。用 `test.projects`。

⚠️ **backend 的 `include` 写精确目录、不要写 `**/*.test.ts` 再配 `exclude`** —— 实测：
显式 `exclude` 会**覆盖默认排除项**（含 `**/node_modules/**`），把 `node_modules/@platform/sdk/**`
的测试也扫进来（98 → 149 条）。

```ts
import { defineConfig } from 'vitest/config'

// 本模块**混合**两种测试：后端（node 环境，域/路由/存储）+ console 组件（happy-dom + jsx）。
// 用 test.projects 而非 environmentMatchGlobs —— 后者实测会打 DEPRECATED 告警。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', '*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'console',
          environment: 'happy-dom',
          include: ['console/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
```

- [ ] **Step 4: manifest 声明 console 条目**

`modules/aftersales/manifest.yaml` 加 `frontend` 段（**一条**，不是五条——见 spec §3.1）：

```yaml
frontend:
  console:
    - { path: /console/aftersales, title: 售后管理, icon: ToolOutlined, scope: aftersales:manage, entry: ./console/index.tsx }
```

- [ ] **Step 5: 写 tabs 路由壳 `console/index.tsx`**

```tsx
// console/index.tsx — 售后管理端入口（M3a）。
//
// **一个 console 条目 + 模块内 tabs**（spec §3.1）：manifest 的前端条目在 console 菜单里是
// 平铺的（`apps/web/src/pages/console-menu.ts` 只给平台「管理」组做了 children），而
// `frontend.console` 是扁平数组、协议不支持嵌套。⇒ 声明一个条目，页内用**真子路由**分区，
// 这样每个页签仍可深链、浏览器后退可用。
import { Layout, Menu } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import TicketsPage from './tickets'
import RulesPage from './rules'
import EmployeesPage from './employees'
import ProductsPage from './products'
import StoresPage from './stores'

const TABS = [
  { key: 'tickets', label: '工单' },
  { key: 'rules', label: '规则' },
  { key: 'employees', label: '员工' },
  { key: 'products', label: '商品' },
  { key: 'stores', label: '门店' },
] as const

export default function AftersalesConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // 末段即当前页签；未选中时默认工单
  const active = TABS.find((t) => pathname.endsWith(`/${t.key}`))?.key ?? 'tickets'

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(key)}
        style={{ marginBottom: 16 }}
      />
      <Routes>
        <Route index element={<Navigate to="tickets" replace />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="stores" element={<StoresPage />} />
      </Routes>
    </Layout>
  )
}
```

- [ ] **Step 6: 写 5 个页面骨架**

每个文件形如（以 `console/rules/index.tsx` 为例，其余四个同样形状、只换标题）：

```tsx
// console/rules/index.tsx — 规则管理（M3a）
import { Card } from 'antd'

export default function RulesPage() {
  return <Card title="售后规则">待实现</Card>
}
```

五个文件与标题：`tickets/index.tsx` → `工单`、`rules/index.tsx` → `售后规则`、
`employees/index.tsx` → `员工`、`products/index.tsx` → `商品`、`stores/index.tsx` → `门店`。

- [ ] **Step 7: 写路由壳的失败测试**（`console/index.test.tsx`）

```tsx
// console/index.test.tsx — tabs 路由壳：五个页签可切换、可深链
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import AftersalesConsolePage from './index'

afterEach(cleanup)

/** 还原 Console 壳的挂载形态：Outlet context 注入 session（模块页只读 scopes） */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes: ['aftersales:manage'] } }} />,
        children: [{ path: '/console/aftersales/*', element: <AftersalesConsolePage /> }],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('售后 console 路由壳', () => {
  // ⚠️ 本任务的测试**只断言路由与菜单标签**，不断言页面内容——Wave 2 会把下面 5 个骨架页
  //    逐个替换成真页面，任何对页面正文的断言都会在那一波变红。
  //    同理用 getAllByText：'门店' 既是菜单标签也是页面标题，getByText 会因命中两处而抛错。
  it('五个页签都在菜单里', () => {
    renderAt('/console/aftersales/tickets')
    for (const label of ['工单', '规则', '员工', '商品', '门店']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('深链到 /stores 时路由停在 stores（不被重定向走）', async () => {
    const router = renderAt('/console/aftersales/stores')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/stores'))
  })

  it('裸 /console/aftersales 重定向到工单', async () => {
    const router = renderAt('/console/aftersales')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/tickets'))
  })
})
```

- [ ] **Step 8: 跑测试，确认通过**

Run: `pnpm --filter aftersales test`
Expected: **PASS**，输出里能看到 `|console|` 前缀的用例，且 backend 仍是 8 文件 / 98 测试。

- [ ] **Step 9: 重生成 registry 并确认它进了 git**

Run:
```bash
pnpm --filter @platform/web build
git diff --stat apps/web/src/console-registry.gen.ts
```
Expected: build 成功；registry diff 里出现 `/console/aftersales` 那一条。

- [ ] **Step 10: 跑门禁**

Run:
```bash
pnpm typecheck && pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs
```
Expected: 全绿（`lint-architecture` 会核「模块不许跨 schema」——console 是前端，不涉 SQL）。

- [ ] **Step 11: 提交**

```bash
git add modules/aftersales apps/web/src/console-registry.gen.ts pnpm-lock.yaml
git commit -m "feat(aftersales): M3a console 骨架——依赖/双 project vitest/manifest 声明/tabs 路由 (#79)"
```

---

### Task 2: console 公共库 `lib/`（HTTP 薄封装 + 列表 hook）

**为什么单独一个任务**：5 个页面都要用它，若由某个页面任务创建，Wave 2 就不再并行了。
**为什么需要它**：demo 页只有一处 useEffect，5 个列表页则会重复同一套「加载/错误/重载」样板
——抽到一处，且**错误码→文案只有一份**。

**Files:**
- Create: `modules/aftersales/console/lib/api.ts`
- Create: `modules/aftersales/console/lib/api.test.ts`
- Create: `modules/aftersales/console/lib/useList.ts`
- Create: `modules/aftersales/console/lib/useList.test.tsx`

**Interfaces:**
- Consumes: `platformFetch`（`@platform/sdk/web`）；`api-types.ts` 的类型（Task 3 产出，本任务不依赖）
- Produces:
  - `apiGet<T>(path: string): Promise<T>`
  - `apiSend<T>(path: string, method: 'POST'|'PUT'|'DELETE', body?: unknown): Promise<T>`
  - `class ApiError extends Error { status: number; code: string }`
  - `messageOf(e: unknown): string`
  - `useList<T>(load: () => Promise<T[]>): { items: T[]; loading: boolean; error: string|null; reload: () => void }`

- [ ] **Step 1: 写失败测试 `console/lib/api.test.ts`**

```ts
// lib/api.test.ts — 模块 API 薄封装：前缀拼接、错误体翻译、非 JSON 回落
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ApiError, apiGet, apiSend, messageOf } from './api'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; init?: RequestInit }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return json({ ok: true })
  })
})

describe('apiGet / apiSend', () => {
  it('拼上模块前缀（三同纪律：id = schema = API 前缀）', async () => {
    await apiGet('/tickets?page=1')
    expect(calls[0]!.url).toBe('/api/modules/aftersales/tickets?page=1')
  })

  it('apiSend 带 JSON body 与 Content-Type；DELETE 无 body 时不带', async () => {
    await apiSend('/rules/1', 'PUT', { name: 'x' })
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: 'x' }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    await apiSend('/rules/1', 'DELETE')
    expect(calls[1]!.init?.body).toBeUndefined()
    expect(calls[1]!.init?.headers).toBeUndefined()
  })

  it('非 2xx → 抛 ApiError，code 取自响应体的 error 字段', async () => {
    m.mockImplementation(async () => json({ error: 'ALREADY_PROCESSED' }, 409))
    await expect(apiGet('/tickets/1')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGet('/tickets/1')).rejects.toMatchObject({ status: 409, code: 'ALREADY_PROCESSED' })
  })

  it('响应体不是 JSON 时回落成 HTTP_<status>（不因解析失败吞掉错误）', async () => {
    m.mockImplementation(async () => new Response('<html>502</html>', { status: 502 }))
    await expect(apiGet('/tickets')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' })
  })
})

describe('messageOf', () => {
  it('已知码给中文文案；未知码回落成码本身（便于排障）', () => {
    expect(messageOf(new ApiError(409, 'ALREADY_PROCESSED'))).toContain('已被他人处理')
    expect(messageOf(new ApiError(400, 'SOMETHING_NEW'))).toBe('SOMETHING_NEW')
  })

  it('非 ApiError（网络异常等）给统一文案', () => {
    expect(messageOf(new TypeError('fetch failed'))).toContain('网络')
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— `Failed to resolve import "./api"`。

- [ ] **Step 3: 写 `console/lib/api.ts`**

```ts
// console/lib/api.ts — 模块 console 页的 HTTP 薄封装。
// 只做两件事：拼模块 API 前缀、把非 2xx 的错误体（{error}，模块 API 约定）翻成可展示文案。
// 不做重试/缓存/全局状态——那些属于调用方或壳。
import { platformFetch } from '@platform/sdk/web'

/** 模块 API 前缀（三同纪律：模块 id = DB schema = API 前缀） */
const BASE = '/api/modules/aftersales'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  // 体可能不是 JSON（反代 502 之类）——解析失败不能把状态码也吞掉
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  return new ApiError(res.status, code)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(BASE + path)
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

export async function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const res = await platformFetch(BASE + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** 错误码 → 中文文案。只列端点真会回的；其余回落成码本身（排障时更有用） */
const MESSAGES: Record<string, string> = {
  NOT_FOUND: '记录不存在（可能已被他人删除）',
  ALREADY_PROCESSED: '该工单已被他人处理，请刷新列表',
  INVALID_BODY: '提交内容不合法',
  INVALID_AMOUNT: '金额或比例不合法',
  INVALID_ID: 'ID 不合法',
  FORBIDDEN: '没有权限执行该操作',
  UNAUTHENTICATED: '登录已失效，请重新登录',
}
export function messageOf(e: unknown): string {
  return e instanceof ApiError ? (MESSAGES[e.code] ?? e.code) : '网络异常，请重试'
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|console|` 下 6 条）。

- [ ] **Step 5: 写失败测试 `console/lib/useList.test.tsx`**

```tsx
// lib/useList.test.tsx — 列表 hook：加载态 → 数据；失败 → 错误文案；reload 重取
import '@testing-library/jest-dom/vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { useList } from './useList'

describe('useList', () => {
  it('成功：loading 从 true 落到 false，items 就位', async () => {
    const load = vi.fn().mockResolvedValue([{ id: 1 }])
    const { result } = renderHook(() => useList(load))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([{ id: 1 }])
    expect(result.current.error).toBeNull()
  })

  it('失败：items 清空 + error 是中文文案（不是裸错误对象）', async () => {
    const load = vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN'))
    const { result } = renderHook(() => useList(load))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
    expect(result.current.error).toBe('没有权限执行该操作')
  })

  it('reload 重新调用 load', async () => {
    const load = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => useList(load))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(load).toHaveBeenCalledTimes(1)
    act(() => result.current.reload())
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })
})
```

- [ ] **Step 6: 写 `console/lib/useList.ts`**

```ts
// console/lib/useList.ts — 列表页的加载/错误/重载（5 个列表页共用）。
//
// 只管这三件事：有些端点不回 total（GET /rules /employees /stores）⇒ 分页能力由**各页**
// 按端点能力决定，不塞进本 hook（免得摆出一个假的页码）。
import { useCallback, useEffect, useState } from 'react'
import { messageOf } from './api'

export interface ListState<T> {
  items: T[]
  loading: boolean
  error: string | null
  reload: () => void
}

/** ⚠️ `load` 必须是 `useCallback` 固定的（否则每次渲染都是新函数 ⇒ 无限重取）；
 *  依赖变化请用返回的 `reload()` 触发，不要靠换 `load` 身份。 */
export function useList<T>(load: () => Promise<T[]>): ListState<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    load()
      .then((rows) => { if (alive) setItems(rows) })
      .catch((e: unknown) => { if (alive) { setItems([]); setError(messageOf(e)) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [load, nonce])

  return { items, loading, error, reload }
}
```

- [ ] **Step 7: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|console|` 下 9 条：api 6 + useList 3）。

- [ ] **Step 8: 写 `console/lib/format.ts` + 测试（分→元的**展示**格式化）**

> ⚠️ 这是**格式化**，不是 §0.3 禁止的「前端算金额」——它只把服务端已经算好的整数分
> 显示成元，不参与任何金额推导。

`console/lib/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { formatMinor } from './format'

describe('formatMinor', () => {
  it('整数分 → 元，保留两位', () => {
    expect(formatMinor(0)).toBe('¥0.00')
    expect(formatMinor(1)).toBe('¥0.01')
    expect(formatMinor(12345)).toBe('¥123.45')
  })
  it('null / undefined → 占位（端点未处理时该字段就是 null）', () => {
    expect(formatMinor(null)).toBe('—')
    expect(formatMinor(undefined)).toBe('—')
  })
})
```

`console/lib/format.ts`：

```ts
// console/lib/format.ts — 展示层格式化。**不做任何金额推导**（§0.3：金额一律服务端算）。
/** 整数分 → `¥x.xx`；未处理（null）时给占位符 */
export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—'
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
```

- [ ] **Step 9: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|console|` 下 11 条）。

- [ ] **Step 10: 提交**

```bash
git add modules/aftersales/console/lib
git commit -m "feat(aftersales): console 公共库——HTTP 薄封装 + 列表 hook + 展示格式化 (#79)"
```

---

### Task 3: `api-types.ts` —— 服务端与 console 共用的响应类型

**为什么**：前端测试要 mock `platformFetch`，而 AGENTS.md #11「测试替身必须收严到真机形状」正
警告替身漂移。让**服务端路由的响应**与**console 的预期**共用同一份类型 ⇒ 替身天然钉在真类型上。
**只加类型标注，不改任何接口行为。**

**Files:**
- Create: `modules/aftersales/api-types.ts`
- Modify: `modules/aftersales/routes/ticket-manage.ts`（给响应加类型标注）
- Modify: `modules/aftersales/routes/rule.ts`、`routes/masterdata.ts`（同上）

**Interfaces:**
- Produces（console 侧要用到的全部形状）：

```ts
export type TicketStatus = 'pending' | 'completed' | 'cancelled'
export type AmountType = 'ratio' | 'fixed'

/** GET /tickets 的列表行（字段逐字对齐 `routes/ticket-manage.ts` 的 select） */
export interface TicketListItem {
  id: number; code: string
  product_id: number; product_name: string
  store_id: number; store_name: string
  damage_quantity: number
  status: TicketStatus
  amount_type: AmountType | null
  amount_minor: number | null
  refund_ratio: number | null
  operator: string | null
  remark: string | null
  related_order: string | null
  created_at: string; processed_at: string | null
}

/** GET /tickets 与 GET /products 的响应（这两个端点回 total） */
export interface Paged<T> { items: T[]; total: number; page: number; size: number }
/** GET /rules GET /employees GET /stores 的响应（**无 total** ⇒ 单页） */
export interface Unpaged<T> { items: T[] }

export interface TicketDetail extends TicketListItem {
  submitter_openid: string
  basic_quantity: number
  basic_unit_price_minor: number
  attachments: Array<{ id: number; objectKey: string; contentType: string; sizeBytes: number; url: string | null }>
}

export interface RuleItem { id: number; name: string; refund_ratio: number; remark: string | null; created_at: string }
export interface EmployeeItem { id: number; name: string; phone: string; store_id: number; open_id: string; approve_status: string }
export interface StoreItem { id: number; name: string; region_id: number | null; address: string; phone: string }
export interface ProductItem { id: number; name: string; basic_unit_price_minor: number }

/** POST /tickets/:id/process 的请求体（与路由的 ProcessBody 判别联合同形） */
export type ProcessBody =
  | { amountType: 'ratio'; refundRatio: number; remark?: string }
  | { amountType: 'fixed'; amountMinor: number; remark?: string }
  | { amountType: 'reject'; remark?: string }
/** 成功响应；失败形如 { error: string }（模块 API 约定） */
export interface ProcessResult { ok: true; id: number; status: TicketStatus; amountType: AmountType; amountMinor: number }
```

> ⚠️ 上面的字段名**必须与路由里实际的 `select` 列表逐字一致**——写这一步时**打开
> `routes/ticket-manage.ts` / `rule.ts` / `masterdata.ts` 对照**，不要照抄本计划的记忆。
> 差异处**以路由的实现为准**（本计划写于 2026-09-16，路由若已变更以代码为真）。

- [ ] **Step 1: 写 `api-types.ts`**（内容见上）

- [ ] **Step 2: 给路由的响应加类型标注**

在 `routes/ticket-manage.ts` 里把列表响应的构造改为带类型，例如：

```ts
// 顶部
import type { Paged, TicketListItem } from '../api-types'

// r.get('/tickets', ...) 的 return 处
const body: Paged<TicketListItem> = { items: listRes.rows.map(normalizeTicketRow), total: totalRes.rows[0].n, page, size }
return c.json(body)
```

`rule.ts` 的 `GET /rules` → `Unpaged<RuleItem>`；`masterdata.ts` 的 `GET /employees` / `GET /stores`
→ `Unpaged<EmployeeItem>` / `Unpaged<StoreItem>`；`GET /products` → `Paged<ProductItem>`。

> **只加标注**。若某处标注与实现冲突 ⇒ **以实现为准改类型**，并在报告里记下差在哪
> （这正是这份类型存在的意义：把「我以为的形状」与「真的形状」的差异**在编译期**暴露出来）。

- [ ] **Step 3: 跑后端测试 + typecheck，确认零行为变化**

Run: `pnpm --filter aftersales typecheck && pnpm --filter aftersales test`
Expected: typecheck exit 0；测试仍 **98 通过**（标注不改行为）。

- [ ] **Step 4: 提交**

```bash
git add modules/aftersales/api-types.ts modules/aftersales/routes
git commit -m "feat(aftersales): 导出服务端/console 共用的响应类型 api-types.ts（只加标注，不改行为） (#79)"
```

---

## Wave 2（五页可并行：各任务只改自己那一个目录）

> 本波每个任务的测试都**mock `@platform/sdk/web` 的 `platformFetch`**（与 demo 的
> `note.test.tsx` 同一手法）——页面业务行为全走它，替身点只有一个。

### Task 4: 工单列表（`status` 筛选 + **服务端真分页**）

**Files:**
- Modify: `modules/aftersales/console/tickets/index.tsx`（替换 Task 1 的骨架）
- Create: `modules/aftersales/console/tickets/index.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `messageOf`（Task 2）；`formatMinor`（Task 2）；`Paged<TicketListItem>`（Task 3）
- Produces: `export default function TicketsPage()`；`status` 取值 `'' | TicketStatus`

- [ ] **Step 1: 写失败测试 `console/tickets/index.test.tsx`**

```tsx
// tickets/index.test.tsx — 工单列表：渲染、status 筛选、服务端分页（用响应里的 total）
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import TicketsPage from './index'

const m = vi.mocked(platformFetch)
const urls: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一页两条；total=5 ⇒ 分页控件应出现「共 5 条」 */
function page(items: unknown[]): Response {
  return json({ items, total: 5, page: 1, size: 2 })
}

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, code: `T-${id}`, product_id: 1, product_name: '苹果', store_id: 1, store_name: '一号店',
  damage_quantity: 2, status: 'pending', amount_type: null, amount_minor: null, refund_ratio: null,
  operator: null, remark: null, related_order: null, created_at: '2026-09-16T00:00:00Z', processed_at: null,
  ...over,
})

beforeEach(() => {
  urls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    urls.push(url)
    return page([row(1), row(2)])
  })
})
afterEach(cleanup)

describe('工单列表', () => {
  it('渲染列表行与「共 N 条」（total 来自服务端）', async () => {
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-1')).toBeInTheDocument())
    expect(screen.getByText('T-2')).toBeInTheDocument()
    expect(screen.getByText(/共 5 条/)).toBeInTheDocument()
  })

  it('首次请求不带 status；已处理工单显示金额（分→元）', async () => {
    m.mockImplementation(async (url: string) => {
      urls.push(url)
      return page([row(3, { status: 'completed', amount_type: 'ratio', amount_minor: 12345 })])
    })
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-3')).toBeInTheDocument())
    expect(urls[0]).toBe('/api/modules/aftersales/tickets?page=1&size=20')
    expect(screen.getByText('¥123.45')).toBeInTheDocument()
  })

  it('未处理工单的金额列是占位符（不是 ¥0.00 —— 没算过就是没算过）', async () => {
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-1')).toBeInTheDocument())
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('接口失败时显示可展示的错误文案，不白屏', async () => {
    m.mockImplementation(async () => json({ error: 'FORBIDDEN' }, 403))
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('没有权限执行该操作')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— 找不到 `T-1`（骨架页没有列表）。

- [ ] **Step 3: 写 `console/tickets/index.tsx`**

```tsx
// tickets/index.tsx — 售后工单列表（M3a）。
//
// 服务端真分页：GET /tickets 回 { items, total, page, size } ⇒ 用 total 驱动分页控件，
// **不在前端全量拉取再切页**（§0.3：那正是要消灭的模式）。
// 金额一律来自服务端：未处理的工单 amount_minor 就是 null，显示占位符。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Select, Spin, Table, Tag, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { Paged, TicketListItem, TicketStatus } from '../../api-types'

const SIZE = 20
const STATUS_LABEL: Record<TicketStatus, string> = {
  pending: '待处理',
  completed: '已处理',
  cancelled: '已驳回',
}
const STATUS_COLOR: Record<TicketStatus, string> = {
  pending: 'orange',
  completed: 'green',
  cancelled: 'red',
}

export default function TicketsPage() {
  const [items, setItems] = useState<TicketListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | TicketStatus>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), size: String(SIZE) })
      if (status) qs.set('status', status)
      const body = await apiGet<Paged<TicketListItem>>(`/tickets?${qs.toString()}`)
      setItems(body.items)
      setTotal(body.total)
    } catch (e: unknown) {
      setItems([])
      setTotal(0)
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          value={status}
          style={{ width: 160 }}
          onChange={(v: '' | TicketStatus) => { setStatus(v); setPage(1) }}
          options={[
            { value: '', label: '全部状态' },
            ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Typography.Text type="secondary">共 {total} 条</Typography.Text>
      </div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<TicketListItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={{
          current: page,
          pageSize: SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: '编号', dataIndex: 'code', width: 140 },
          { title: '商品', dataIndex: 'product_name' },
          { title: '门店', dataIndex: 'store_name' },
          { title: '数量', dataIndex: 'damage_quantity', width: 80 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: TicketStatus) => <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>,
          },
          {
            title: '退款额',
            dataIndex: 'amount_minor',
            width: 120,
            // 未处理 ⇒ null ⇒ 占位符（不显示 ¥0.00，那会让人以为算过且是 0）
            render: (v: number | null) => formatMinor(v),
          },
          { title: '处理人', dataIndex: 'operator', width: 120, render: (v: string | null) => v ?? '—' },
          { title: '创建时间', dataIndex: 'created_at', width: 200, render: (v: string) => v.replace('T', ' ').slice(0, 19) },
        ]}
      />
      {loading && items.length === 0 ? <Spin /> : null}
    </div>
  )
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|console|` 多 4 条）。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/console/tickets/index.tsx modules/aftersales/console/tickets/index.test.tsx
git commit -m "feat(aftersales): console 工单列表——status 筛选 + 服务端真分页 (#79)"
```

---

### Task 5: 工单详情 + 处理弹窗（三形状；**不显示预估金额**）

**Files:**
- Create: `modules/aftersales/console/tickets/ProcessDialog.tsx`
- Create: `modules/aftersales/console/tickets/ProcessDialog.test.tsx`
- Modify: `modules/aftersales/console/tickets/index.tsx`（加「详情/处理」入口与抽屉）

**Interfaces:**
- Consumes: `apiGet` / `apiSend` / `messageOf`（Task 2）；`Paged` 等类型（Task 3）
- Produces: `export function ProcessDialog(props: { ticketId: number; open: boolean; onClose: () => void; onDone: () => void })`

- [ ] **Step 1: 写失败测试 `console/tickets/ProcessDialog.test.tsx`**

```tsx
// ProcessDialog.test.tsx — 三种 amountType 的提交体形状 + 409/400 分支
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ProcessDialog } from './ProcessDialog'

const m = vi.mocked(platformFetch)
const sends: Array<{ url: string; body: unknown }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  sends.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sends.push({ url, body: JSON.parse(String(init.body)) })
      return json({ ok: true, id: 7, status: 'completed', amountType: 'ratio', amountMinor: 12345 })
    }
    return json({ error: 'NOT_FOUND' }, 404)
  })
})
afterEach(cleanup)

function open() {
  render(<ProcessDialog ticketId={7} open onClose={() => {}} onDone={() => {}} />)
}

describe('ProcessDialog', () => {
  it('ratio：提交体是 { amountType: ratio, refundRatio }', async () => {
    open()
    fireEvent.mouseDown(screen.getByLabelText('处理方式'))
    fireEvent.click(await screen.findByText('按比例退款'))
    fireEvent.change(screen.getByLabelText('退款比例'), { target: { value: '0.5' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.url).toBe('/api/modules/aftersales/tickets/7/process')
    expect(sends[0]!.body).toEqual({ amountType: 'ratio', refundRatio: 0.5 })
  })

  it('★ 提交前【不出现】任何金额预览；提交后展示的是服务端返回的金额', async () => {
    open()
    fireEvent.mouseDown(screen.getByLabelText('处理方式'))
    fireEvent.click(await screen.findByText('按比例退款'))
    // 填了比例之后、提交之前：页面上不该有任何 ¥ 金额
    fireEvent.change(screen.getByLabelText('退款比例'), { target: { value: '0.5' } })
    expect(screen.queryByText(/¥/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    // 服务端返回 12345 分 ⇒ 展示 ¥123.45
    await waitFor(() => expect(screen.getByText(/¥123\.45/)).toBeInTheDocument())
  })

  it('fixed：提交体是 { amountType: fixed, amountMinor }（金额由操作员填，单位分）', async () => {
    open()
    fireEvent.mouseDown(screen.getByLabelText('处理方式'))
    fireEvent.click(await screen.findByText('固定金额退款'))
    fireEvent.change(screen.getByLabelText('退款金额（元）'), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.body).toEqual({ amountType: 'fixed', amountMinor: 1234 })
  })

  it('409 ALREADY_PROCESSED → 明确提示「已被他人处理」，不是笼统报错', async () => {
    m.mockImplementation(async () => json({ error: 'ALREADY_PROCESSED' }, 409))
    open()
    fireEvent.mouseDown(screen.getByLabelText('处理方式'))
    fireEvent.click(await screen.findByText('驳回'))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(screen.getByText(/已被他人处理/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `console/tickets/ProcessDialog.tsx`**

```tsx
// ProcessDialog.tsx — 工单处理弹窗。
//
// ★ **不显示预估金额**（spec §3.1）：POST /tickets/:id/process 只在**提交之后**返回服务端算出
//   的 amountMinor，没有预览端点；而 §0.3 把「前端算金额」列为要消灭的模式
//   ⇒ ratio 路盲提交，**前端不引入第二份金额公式**。
//   fixed 路的金额是操作员自己填的（服务端把它当输入），所以那一栏要显示。
import { useState } from 'react'
import { Alert, InputNumber, Modal, Radio, Space, Typography } from 'antd'
import { apiSend, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { ProcessBody, ProcessResult } from '../../api-types'

export function ProcessDialog(props: { ticketId: number; open: boolean; onClose: () => void; onDone: () => void }) {
  const [amountType, setAmountType] = useState<ProcessBody['amountType']>('ratio')
  const [ratio, setRatio] = useState<number | null>(null)
  const [yuan, setYuan] = useState<number | null>(null)
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ProcessResult | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const body: ProcessBody =
      amountType === 'ratio'
        ? { amountType: 'ratio', refundRatio: ratio ?? 0, ...(remark ? { remark } : {}) }
        : amountType === 'fixed'
          ? { amountType: 'fixed', amountMinor: Math.round((yuan ?? 0) * 100), ...(remark ? { remark } : {}) }
          : { amountType: 'reject', ...(remark ? { remark } : {}) }
    try {
      const res = await apiSend<ProcessResult>(`/tickets/${props.ticketId}/process`, 'POST', body)
      setDone(res)
    } catch (e: unknown) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`处理工单 #${props.ticketId}`}
      open={props.open}
      onCancel={props.onClose}
      onOk={() => { if (done) { props.onDone(); props.onClose() } else void submit() }}
      okText={done ? '完成' : '提交'}
      confirmLoading={busy}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {done ? (
          <Alert
            type="success"
            showIcon
            message={`处理完成：${done.status}`}
            description={`服务端核定退款额 ${formatMinor(done.amountMinor)}`}
          />
        ) : (
          <>
            <Radio.Group
              value={amountType}
              onChange={(e) => setAmountType(e.target.value as ProcessBody['amountType'])}
            >
              <Radio.Button value="ratio">按比例退款</Radio.Button>
              <Radio.Button value="fixed">固定金额退款</Radio.Button>
              <Radio.Button value="reject">驳回</Radio.Button>
            </Radio.Group>

            {amountType === 'ratio' ? (
              <>
                <label htmlFor="ratio">退款比例</label>
                <InputNumber id="ratio" min={0} max={1} step={0.01} value={ratio} onChange={setRatio} style={{ width: '100%' }} />
                <Typography.Text type="secondary">
                  退款金额由服务端按比例计算，提交后显示。
                </Typography.Text>
              </>
            ) : null}

            {amountType === 'fixed' ? (
              <>
                <label htmlFor="yuan">退款金额（元）</label>
                <InputNumber id="yuan" min={0} step={0.01} value={yuan} onChange={setYuan} style={{ width: '100%' }} />
              </>
            ) : null}

            <label htmlFor="remark">备注</label>
            <Input.TextArea id="remark" rows={2} maxLength={2000} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </>
        )}
      </Space>
    </Modal>
  )
}
```

- [ ] **Step 4: 在列表页接入入口**（`console/tickets/index.tsx`）

加一个状态与一列操作按钮：

```tsx
// 顶部 import 补：import { ProcessDialog } from './ProcessDialog'
const [processing, setProcessing] = useState<number | null>(null)
// columns 末尾加：
  {
    title: '操作', width: 100,
    render: (_: unknown, r: TicketListItem) =>
      r.status === 'pending'
        ? <Button size="small" onClick={() => setProcessing(r.id)}>处理</Button>
        : <Button size="small" type="link" onClick={() => setProcessing(r.id)}>查看</Button>,
  },
// Table 之后（同一层）加：
{processing !== null ? (
  <ProcessDialog
    ticketId={processing}
    open
    onClose={() => setProcessing(null)}
    onDone={() => { void load() }}
  />
) : null}
```

- [ ] **Step 5: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|console|` 多 4 条 = Task 4 的 4 + 本任务 4）。

- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/console/tickets
git commit -m "feat(aftersales): console 工单处理弹窗——三形状、无预估金额、409 明确提示 (#79)"
```

---

### Task 6: 规则页（CRUD；端点完整）

**Files:**
- Modify: `modules/aftersales/console/rules/index.tsx`
- Create: `modules/aftersales/console/rules/index.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `apiSend` / `messageOf`；`useList`；`Unpaged<RuleItem>`、`RuleItem`（Task 3）
- Produces: `export default function RulesPage()`

- [ ] **Step 1: 写失败测试 `console/rules/index.test.tsx`**

```tsx
// rules/index.test.tsx — 规则 CRUD：列表、新建、删除；无 total ⇒ 不出分页控件
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import RulesPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string }> = []
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method })
    if (init?.method === 'POST') return json({ id: 2 })
    if (init?.method === 'DELETE') return json({ ok: true })
    return json({ items: [{ id: 1, name: '标准比例', refund_ratio: 0.5, remark: null, created_at: '2026-09-16T00:00:00Z' }] })
  })
})
afterEach(cleanup)

describe('规则页', () => {
  it('渲染规则行', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
  })

  it('★ 无 total ⇒ 页面不出现分页控件（不摆假页码）', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })

  it('删除要经确认，确认后发 DELETE /rules/:id 并刷新', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确定' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/modules/aftersales/rules/1')).toBe(true))
  })
})
```

- [ ] **Step 2: 跑，确认失败** → `pnpm --filter aftersales test`，FAIL（骨架页无「标准比例」）。

- [ ] **Step 3: 写 `console/rules/index.tsx`**

```tsx
// rules/index.tsx — 售后规则 CRUD（M3a）。
// GET /rules 回 { items } **无 total** ⇒ 单页展示、不放分页控件（spec §3.1 已知边界）。
import { useCallback, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Table } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { RuleItem, Unpaged } from '../../api-types'

export default function RulesPage() {
  const load = useCallback(async () => (await apiGet<Unpaged<RuleItem>>('/rules')).items, [])
  const { items, loading, error, reload } = useList(load)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ name: string; refundRatio: number; remark?: string }>()

  const create = async () => {
    const v = await form.validateFields()
    try {
      await apiSend('/rules', 'POST', { name: v.name, refundRatio: v.refundRatio, ...(v.remark ? { remark: v.remark } : {}) })
      setCreating(false)
      form.resetFields()
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '新建失败', content: messageOf(e) })
    }
  }

  const remove = async (id: number) => {
    try {
      await apiSend(`/rules/${id}`, 'DELETE')
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '删除失败', content: messageOf(e) })
    }
  }

  return (
    <div>
      <Button type="primary" onClick={() => setCreating(true)} style={{ marginBottom: 12 }}>新建规则</Button>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<RuleItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '退款比例', dataIndex: 'refund_ratio', width: 120, render: (v: number) => `${(v * 100).toFixed(2)}%` },
          { title: '说明', dataIndex: 'remark', render: (v: string | null) => v ?? '—' },
          {
            title: '操作', width: 100,
            render: (_: unknown, r: RuleItem) => (
              <Popconfirm title={`删除规则「${r.name}」？`} onConfirm={() => void remove(r.id)}>
                <Button danger size="small">删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Modal title="新建规则" open={creating} onCancel={() => setCreating(false)} onOk={() => void create()}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 100 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="refundRatio" label="退款比例（0–1）" rules={[{ required: true }]}>
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="说明">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 4: 跑，确认通过** → PASS（`|console|` 多 3 条）。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/console/rules
git commit -m "feat(aftersales): console 规则页——CRUD（无 total ⇒ 单页） (#79)"
```

---

### Task 7: 员工页（列表 + 新建 + 审批）

**Files:**
- Modify: `modules/aftersales/console/employees/index.tsx`
- Create: `modules/aftersales/console/employees/index.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `apiSend` / `messageOf`；`useList`；`Unpaged<EmployeeItem>`、`EmployeeItem`
- Produces: `export default function EmployeesPage()`

- [ ] **Step 1: 写失败测试 `console/employees/index.test.tsx`**

```tsx
// employees/index.test.tsx — 员工列表 + 审批（POST /employees/:id/approve）；无 total ⇒ 无分页
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import EmployeesPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    return json({ items: [{ id: 1, name: '张三', phone: '13800000000', store_id: 1, open_id: 'o1', approve_status: 'pending' }] })
  })
})
afterEach(cleanup)

describe('员工页', () => {
  it('列表渲染 + 待审批显示审批按钮', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
  })

  it('审批打 POST /employees/:id/approve，且 body 带审批结果', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/modules/aftersales/employees/1/approve')).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ approve: true })
  })

  it('无 total ⇒ 不出现分页控件', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
```

> ⚠️ **`approve` 请求体的字段名以 `routes/masterdata.ts` 的实现为准**——写这一步时打开那个文件
> 的 `POST /employees/:id/approve` handler 对照。若实现收的不是 `{ approve: boolean }`，
> **改测试与实现对齐**，并在报告里记下差异。

- [ ] **Step 2: 跑，确认失败** → FAIL。

- [ ] **Step 3: 写 `console/employees/index.tsx`**

```tsx
// employees/index.tsx — 员工信息 + 注册审批（M3a）。
// GET /employees 回 { items } **无 total** ⇒ 单页（spec §3.1 已知边界）。
import { useCallback, useState } from 'react'
import { Alert, Button, Form, Input, Modal, Table, Tag } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { EmployeeItem, Unpaged } from '../../api-types'

const STATUS_LABEL: Record<string, string> = { pending: '待审批', approved: '已通过', rejected: '已驳回' }

export default function EmployeesPage() {
  const load = useCallback(async () => (await apiGet<Unpaged<EmployeeItem>>('/employees')).items, [])
  const { items, loading, error, reload } = useList(load)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ name: string; phone: string; storeId: number }>()

  const approve = async (id: number, ok: boolean) => {
    try {
      await apiSend(`/employees/${id}/approve`, 'POST', { approve: ok })
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '审批失败', content: messageOf(e) })
    }
  }

  const create = async () => {
    const v = await form.validateFields()
    try {
      await apiSend('/employees', 'POST', { name: v.name, phone: v.phone, storeId: v.storeId })
      setCreating(false)
      form.resetFields()
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '新建失败', content: messageOf(e) })
    }
  }

  return (
    <div>
      <Button type="primary" onClick={() => setCreating(true)} style={{ marginBottom: 12 }}>新建员工</Button>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<EmployeeItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '手机号', dataIndex: 'phone', width: 140 },
          { title: '门店 ID', dataIndex: 'store_id', width: 100 },
          { title: 'openid', dataIndex: 'open_id', render: (v: string) => v || '—' },
          { title: '审批状态', dataIndex: 'approve_status', width: 110, render: (v: string) => <Tag>{STATUS_LABEL[v] ?? v}</Tag> },
          {
            title: '操作', width: 160,
            render: (_: unknown, r: EmployeeItem) =>
              r.approve_status === 'pending' ? (
                <>
                  <Button size="small" type="primary" onClick={() => void approve(r.id, true)}>通过</Button>{' '}
                  <Button size="small" danger onClick={() => void approve(r.id, false)}>驳回</Button>
                </>
              ) : null,
          },
        ]}
      />
      <Modal title="新建员工" open={creating} onCancel={() => setCreating(false)} onOk={() => void create()}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="姓名" rules={[{ required: true, max: 50 }]}><Input /></Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, max: 20 }]}><Input /></Form.Item>
          <Form.Item name="storeId" label="门店 ID" rules={[{ required: true }]}><Input type="number" /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 4: 跑，确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/console/employees
git commit -m "feat(aftersales): console 员工页——列表/新建/审批（无 total ⇒ 单页） (#79)"
```

---

### Task 8: 商品页（只读 + **真分页**）与门店页（只读 + 单页）

**Files:**
- Modify: `modules/aftersales/console/products/index.tsx`
- Create: `modules/aftersales/console/products/index.test.tsx`
- Modify: `modules/aftersales/console/stores/index.tsx`
- Create: `modules/aftersales/console/stores/index.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `messageOf`；`useList`；`formatMinor`；`Paged<ProductItem>`、`Unpaged<StoreItem>`
- Produces: `export default function ProductsPage()`、`export default function StoresPage()`

> **两页合一个任务**：都是只读列表、差别只在「商品有 `total` 所以真分页，门店没有所以单页」。
> 一个评审者不会只否掉其中一个而放行另一个。

- [ ] **Step 1: 写失败测试 `console/products/index.test.tsx`**

```tsx
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ProductsPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async () => json({ items: [{ id: 1, name: '苹果', basic_unit_price_minor: 1234 }], total: 42, page: 1, size: 20 }))
})
afterEach(cleanup)

describe('商品页（只读）', () => {
  it('渲染商品与单价（分→元）', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText('苹果')).toBeInTheDocument())
    expect(screen.getByText('¥12.34')).toBeInTheDocument()
  })

  it('★ 有 total ⇒ 出现分页控件，且显示共 42 条', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText(/共 42 条/)).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).not.toBeNull()
  })
})
```

- [ ] **Step 2: 写失败测试 `console/stores/index.test.tsx`**

```tsx
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import StoresPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async () => json({ items: [{ id: 1, name: '一号店', region_id: 3, address: '某路 1 号', phone: '010-1' }] }))
})
afterEach(cleanup)

describe('门店页（只读）', () => {
  it('渲染门店', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(screen.getByText('某路 1 号')).toBeInTheDocument()
  })

  it('★ 无 total ⇒ 不出现分页控件（不摆假页码）', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
```

- [ ] **Step 3: 跑，确认两个都失败** → FAIL。

- [ ] **Step 4: 写 `console/products/index.tsx`**

```tsx
// products/index.tsx — 商品档案（只读起步，spec §3.1）。
// GET /products 回 { items, total, ... } ⇒ 可真分页。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Table, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { Paged, ProductItem } from '../../api-types'

const SIZE = 20

export default function ProductsPage() {
  const [items, setItems] = useState<ProductItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const body = await apiGet<Paged<ProductItem>>(`/products?page=${page}&size=${SIZE}`)
      setItems(body.items); setTotal(body.total)
    } catch (e: unknown) { setItems([]); setTotal(0); setError(messageOf(e)) } finally { setLoading(false) }
  }, [page])

  useEffect(() => { void load() }, [load])

  return (
    <div>
      <Typography.Text type="secondary">共 {total} 条</Typography.Text>
      {error ? <Alert type="error" showIcon title={error} style={{ margin: '12px 0' }} /> : null}
      <Table<ProductItem>
        rowKey="id" dataSource={items} loading={loading}
        pagination={{ current: page, pageSize: SIZE, total, showSizeChanger: false, onChange: setPage }}
        columns={[
          { title: '商品', dataIndex: 'name' },
          { title: '基础单价', dataIndex: 'basic_unit_price_minor', width: 140, render: (v: number) => formatMinor(v) },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 5: 写 `console/stores/index.tsx`**

```tsx
// stores/index.tsx — 门店档案（只读起步，spec §3.1）。
// GET /stores 回 { items } **无 total** ⇒ 单页展示、不放分页控件。
import { useCallback } from 'react'
import { Alert, Table } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { StoreItem, Unpaged } from '../../api-types'

export default function StoresPage() {
  const load = useCallback(async () => (await apiGet<Unpaged<StoreItem>>('/stores')).items, [])
  const { items, loading, error } = useList(load)

  return (
    <div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<StoreItem>
        rowKey="id" dataSource={items} loading={loading} pagination={false}
        columns={[
          { title: '门店', dataIndex: 'name' },
          { title: '地址', dataIndex: 'address' },
          { title: '电话', dataIndex: 'phone', width: 160 },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 6: 跑，确认通过** → PASS（`|console|` 多 4 条）。

- [ ] **Step 7: 提交**

```bash
git add modules/aftersales/console/products modules/aftersales/console/stores
git commit -m "feat(aftersales): console 商品页（真分页）与门店页（单页）——只读起步 (#79)"
```

---

## Wave 3

### Task 9: 收口（全量门禁 + 手工验收）

**Files:**
- 无新增（只跑验证 + 重生成 registry）

- [ ] **Step 1: 重生成 registry 并确认它是最新的**

```bash
pnpm --filter @platform/web build
git diff --exit-code apps/web/src/console-registry.gen.ts && echo "registry 已是最新"
```
Expected: 无 diff（Task 1 已生成过；此后没人改 manifest）。

- [ ] **Step 2: 跑**该仓 CI 跑的全部命令**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
pnpm typecheck
pnpm test
pnpm --filter @platform/web build
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-tenant-isolation.mjs   # 紧跟 smoke 之后
pnpm exec tsx scripts/smoke-load.mjs
```
Expected: 全绿。

- [ ] **Step 3: 手工验收（spec §3.4 的 e2e 后半段，在本地 dev 起服务）**

逐条走一遍并记下实际结果：

- [ ] `/console/aftersales` 菜单里**只有一个**「售后管理」条目（不是五个）
- [ ] 五个页签可切换；**每个页签的 URL 可直接粘贴打开**（深链）
- [ ] 工单页：改 `status` 筛选后**回到第 1 页**；分页控件显示的是服务端 `total`
- [ ] 工单处理：`ratio` 路**提交前页面上没有任何金额**；提交后显示服务端返回的金额
- [ ] 工单处理：对同一条工单用两个浏览器标签各提交一次 → 第二个拿到「已被他人处理」
- [ ] 规则 / 员工 / 门店三页**没有分页控件**；商品页**有**
- [ ] 页面上**找不到**批量删除 / 导出 / 导入 / 品牌筛选（这些已按 spec 砍掉）

- [ ] **Step 4: 确认没有引入弃用告警**

Run: `pnpm --filter aftersales test 2>&1 | grep -i deprecat`
Expected: **无输出**（vitest 的 `environmentMatchGlobs` 弃用告警已在 Task 1 用 `projects` 规避）。

- [ ] **Step 5: 提交（若 Step 1 有 diff）**

```bash
git add -A && git commit -m "chore(aftersales): M3a 收口——registry 重生成 (#79)"
```

