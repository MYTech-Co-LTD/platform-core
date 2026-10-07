# 报表 agent 制作通路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把报表制作的工具面挂进已有的管理面 MCP 端点（`/mcp-manage`）：agent 能列指标/维度、看已有报表、**提**一张新报表、
改**未发布**报表的规格；而「发布」「回收」在工具集里**不存在**。

**Architecture:** 写面工具集**分片**（口径片 + 报表片），`mcp-manage.ts` 退成「合成 + 注册」；
「能提不能发」落在三条**结构**约束上（不收页门入参 + 平台强制 `data:manage` / revise 先读页门 / 发布回收无工具）。

**Tech Stack:** TypeScript / Hono / zod / pg（真 Postgres 集成测试）/ vitest。

**Spec:** `docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md`（本计划的唯一上游）

## Global Constraints

- **agent 造不出「已发布」**：`propose_report` **不收 `requiredScope`**，平台**强制**写 `data:manage`（spec §3.3①）。
- **agent 改不了既有报表**：`propose_report` 走**原子 create-only**（撞名即拒 `TITLE_TAKEN`，spec §3.3④）；
  `revise_report_spec` **先读页门**，已发布 ⇒ 拒（spec §3.3②）。
- **发布 / 回收不是工具**（spec §3.3③）。
- **复用不复制**：规格白名单只用 `parseReportSpec`；建/改只用 `domain/report-store`；
  「先读行分流」的对象锁与 HTTP 面**同 key**（`${org}/row:${id}`，`domain/object-lock.ts`）。
- **门档不变**：仍由宿主按 `/mcp-manage` 的 `data:manage` 声明施加；工具面**不写授权代码**。
- **既有测试一行不改必须全绿**（T1 是纯重构；T2 默认模式行为不变）。
- 测试库**必须空库**：`DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev'`（本仓有「并发红只在全新空库上复现」的历史）。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/routes/mcp-rpc.ts` | **改**：加 `McpToolGroup` 契约（端点内部的分片形状） |
| `modules/data/routes/mcp-metric-tools.ts` | **新**：口径三工具（从现 `mcp-manage.ts` **原样搬**） |
| `modules/data/routes/mcp-report-tools.ts` | **新**：报表三工具 + 三条结构约束 |
| `modules/data/routes/mcp-manage.ts` | **改**：退成「合成 + 注册」 |
| `modules/data/domain/report-store.ts` | **改**：`upsertReport` 加 `mode`（重载，既有调用方零改动） |
| `modules/data/manifest.yaml` | **改**：自述放宽为「管理面：口径 + 报表」（**声明本身不变**） |
| `modules/data/README.md` | **改**：报表工具面的口径 + `data:manage` 作为未发布页门值的约定 |
| `modules/data/routes/mcp-report-tools.test.ts` | **新**：7 条（含三条承重断言 + 变异确认） |

---

## Task 0: 前置

- [ ] **Step 1: 建 feat issue**（feat PR 必须 `Closes #N`）

```bash
gh issue create --title "feat(data): 报表 agent 制作通路——MCP 工具面（能提、不能发）" \
  --body "设计见 docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md（上游 spec §8 步骤 5）。"
```

记下 `#N`（分支名与 PR body 都要用）。

- [ ] **Step 2: 从更新过的 main 开分支 + 建空库**

```bash
git fetch origin --prune
git checkout -b feat/<N>-report-agent-toolface origin/main
dropdb --if-exists rt_dev; createdb rt_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' pnpm test 2>&1 | tail -5
```

Expected: 基线全绿（29 文件 / 374 用例）

---

## Task 1: 纯重构——写面工具集分片

**性质：纯重构。回归网 = 既有 `routes/mcp-manage.test.ts`，一行不改必须全绿。**

**Files:**
- Modify: `modules/data/routes/mcp-rpc.ts`（加 `McpToolGroup` 类型）
- Create: `modules/data/routes/mcp-metric-tools.ts`
- Modify: `modules/data/routes/mcp-manage.ts`（退成合成）

**Interfaces:**
- Produces:
  - `interface McpToolGroup { list(deps: McpDeps): Promise<Record<string, unknown>[]>; call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> }`
    （`call` 返回 **`null` = 「不是我的工具」**，由合成方继续问下一片）
  - `const metricTools: McpToolGroup`（口径三工具）
  - `registerMcpManage(r, ctx)` 签名不变

- [ ] **Step 1: 在 `mcp-rpc.ts` 加分片契约**

```ts
/**
 * 端点内部的**工具片**：一个端点可以由多片合成（如管理面 = 口径片 + 报表片）。
 * `call` 返回 `null` 表示「这不是我的工具」——由合成方继续问下一片；
 * 任一片认领了但业务上拒绝，则返回 `McpToolResult`（带 `isError`），不再往下问。
 */
export interface McpToolGroup {
  list(deps: McpDeps): Promise<Record<string, unknown>[]>
  call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null>
}
```

- [ ] **Step 2: 把口径三工具**原样**搬到 `mcp-metric-tools.ts`**

把现 `mcp-manage.ts` 里除 `registerMcpManage` 之外的全部内容（文件头注释、`CustomizeArgs`、`DeleteArgs`、
`ok` / `refused` / `view`、`manageToolset` 的 `list` 与 `call` 两个方法体）**逐字搬过来**，改造成：

```ts
// mcp-metric-tools.ts — 管理面 MCP 端点的**口径片**（本租户口径的定义）。
// 门禁由宿主按 manifest 的 `scope: data:manage` 施加——本文件不写 requireScope。
// 判定不自建：写/删一律经 domain/metric-write（与 HTTP 面同一份）。
// ⚠️ 本文件的内容是从 mcp-manage.ts **原样搬**过来的（2026-10-07 分片）：注释与判定一行未改。
import { z } from 'zod'
// …（其余 import 原样）
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

// …（CustomizeArgs / DeleteArgs / ok / refused / view 原样）

export const metricTools: McpToolGroup = {
  async list(deps) { /* 原 manageToolset.list 的方法体，逐字 */ },
  async call(deps, name, args) {
    // 与原 manageToolset.call 的差别**只有**：认领判定 + 不认领时返回 null
    if (name !== 'customize_metric' && name !== 'delete_custom_metric' && name !== 'list_metrics') return null
    /* 其余逐字 */
  },
}
```

⚠️ 原文里 `unknown_tool` 那条兜底（`return { text: JSON.stringify({status:'error', reason:'unknown_tool', name}), … }`）
**删掉**——它现在归合成方（Step 3）。

- [ ] **Step 3: `mcp-manage.ts` 退成合成 + 注册**

```ts
// mcp-manage.ts — 管理面端点：把各工具片**合成**成一个 McpToolSet，交给共享协议壳。
// 协议壳在 mcp-rpc.ts；各片在 mcp-metric-tools.ts（口径）/ mcp-report-tools.ts（报表）。
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpToolGroup, McpToolSet } from './mcp-rpc'
import { metricTools } from './mcp-metric-tools'
import { reportTools } from './mcp-report-tools'

/** 管理面的工具片。加新片只改这一行（协议壳与门档都不动）。 */
const GROUPS: readonly McpToolGroup[] = [metricTools, reportTools]

const manageToolset: McpToolSet = {
  serverName: 'platform-data-mcp-manage',
  async list(deps) {
    return (await Promise.all(GROUPS.map((g) => g.list(deps)))).flat()
  },
  async call(deps, name, args) {
    for (const g of GROUPS) {
      const out = await g.call(deps, name, args)
      if (out !== null) return out
    }
    // 没有任何片认领 ⇒ 工具级错误（与既有口径一致：工具级错误走 result + isError）
    return { text: JSON.stringify({ status: 'error', reason: 'unknown_tool', name }), isError: true }
  },
}

export function registerMcpManage(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-manage', ctx, manageToolset)
}
```

⚠️ Step 3 引用 `mcp-report-tools.ts` ⇒ **本步先建一个占位空片**（`export const reportTools: McpToolGroup = { async list(){return []}, async call(){return null} }`），
Task 3 再填实——否则本任务编不过。

- [ ] **Step 4: 跑既有测试（一行未改）+ typecheck**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' \
  pnpm exec vitest run routes/mcp-manage.test.ts routes/mcp.test.ts 2>&1 | tail -6
pnpm --filter data typecheck
echo "本任务是否碰过测试文件："; git status --short
```

Expected: **全绿**；`git status` 里**没有测试文件**（这是纯重构的验收核心）

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/mcp-rpc.ts modules/data/routes/mcp-metric-tools.ts \
        modules/data/routes/mcp-manage.ts modules/data/routes/mcp-report-tools.ts
git commit -m "refactor(data): 写面工具集分片——口径片独立成文件，mcp-manage 退成合成（为报表片腾位）"
```

---

## Task 2: `upsertReport` 加 create-only 模式

**Files:**
- Modify: `modules/data/domain/report-store.ts:128-158`
- Modify: `modules/data/domain/report-store.test.ts`（追加；若不存在则建）

**Interfaces:**
- Produces: 三个重载 —— `upsertReport(pool, org, input): Promise<string>` /
  `(…, 'upsert'): Promise<string>` / `(…, 'create-only'): Promise<string | null>`

- [ ] **Step 1: 写测试（先红）**

```ts
  it('★ create-only：撞名即不写、返回 null，且既有行一字未动（页门/规格/版本都不变）', async () => {
    const first = await upsertReport(pool, ORG, {
      title: '同名探针', metabaseId: 0, embedParams: {},
      requiredScope: null, renderer: 'platform', spec: { panels: [] },
    })
    const before = await getReport(pool, ORG, first)

    // 第二次：同 title + create-only ⇒ null（撞名），且**什么都不写**
    const again = await upsertReport(pool, ORG, {
      title: '同名探针', metabaseId: 0, embedParams: {},
      requiredScope: 'data:manage', renderer: 'platform', spec: { panels: [] },
    }, 'create-only')
    expect(again).toBeNull()
    const after = await getReport(pool, ORG, first)
    // ★ 三样都不能变：页门（若被写就成了「静默撤下已发布」）、规格、版本
    expect(after).toMatchObject({ requiredScope: before!.requiredScope, version: before!.version })
    expect(after!.id).toBe(first)

    // 对照：默认 upsert 会改写（这正是报表面那条「重登记重置页门」陷阱）
    await upsertReport(pool, ORG, {
      title: '同名探针', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const overwritten = await getReport(pool, ORG, first)
    expect(overwritten!.requiredScope).toBe('data:manage')     // 现象成立 ⇒ 本任务的动机可复现
    expect(overwritten!.version).toBe(before!.version + 1)
  })
```

- [ ] **Step 2: 跑（先红）**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' \
  pnpm exec vitest run domain/report-store.test.ts 2>&1 | tail -6
```

Expected: FAIL（第 4 参不被识别 ⇒ `create-only` 走成了 upsert ⇒ `again` 是 id 而不是 null）

- [ ] **Step 3: 改实现（重载 + 两种冲突子句）**

```ts
/**
 * 写一行报表。**两种模式**（2026-10-07 报表工具面引入）：
 *  · `'upsert'`（默认，**既有行为**）：冲突键是 `(org, title)` ⇒ 同名的第二次写会**改写既有行**
 *    （含 `required_scope`）——报表面那条「重登记重置页门」的陷阱就在这条分支上。
 *  · `'create-only'`：冲突⇒ **什么都不写**，返回 `null`。调用方据此把「撞名」拒掉。
 *    ⚠️ agent 的工具面**必须**用它：否则「提议一张新报表」会变成「改写既有报表」，
 *    而那张若已发布，页门被重置 ⇒ **静默从员工视野消失**（spec §3.3④）。
 *
 * 重载是为了让既有调用方**零改动**（它们只传 3 参，拿到 `string`；`null` 在类型上够不着）。
 */
export function upsertReport(pool: Pool, org: string, input: UpsertReportInput): Promise<string>
export function upsertReport(pool: Pool, org: string, input: UpsertReportInput, mode: 'upsert'): Promise<string>
export function upsertReport(pool: Pool, org: string, input: UpsertReportInput, mode: 'create-only'): Promise<string | null>
export async function upsertReport(
  pool: Pool, org: string, input: UpsertReportInput, mode: 'upsert' | 'create-only' = 'upsert',
): Promise<string | null> {
  const conflict = mode === 'create-only'
    ? 'on conflict (org, title) do nothing'
    : `on conflict (org, title) do update set
       metabase_id    = excluded.metabase_id,
       embed_params   = excluded.embed_params,
       required_scope = excluded.required_scope,
       renderer       = excluded.renderer,
       spec           = excluded.spec,
       version        = data.reports.version + 1,
       updated_at     = now()`
  const r = await pool.query(
    `insert into data.reports (org, id, title, metabase_id, embed_params, required_scope, renderer, spec)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     ${conflict}
     returning id`,
    [/* 与现文逐字相同 */],
  )
  // create-only 撞名时 `returning` 无行 ⇒ rowCount 0 ⇒ null；upsert 恒有一行
  return (r.rowCount ?? 0) === 0 ? null : (r.rows[0].id as string)
}
```

（`UpsertReportInput` = 现文那串内联对象类型，提成具名 interface 供重载签名复用；注释里那条
「`spec` 缺省必须是 **SQL null**」的注记**原样保留**。）

- [ ] **Step 4: 跑（到绿）+ 本包全量 + typecheck，然后 Commit**

```bash
dropdb --if-exists rt_dev; createdb rt_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' pnpm test 2>&1 | tail -5
pnpm --filter data typecheck
git add modules/data/domain/report-store.ts modules/data/domain/report-store.test.ts
git commit -m "feat(data): upsertReport 加 create-only 模式（撞名即不写）——为「提议≠改写既有报表」提供原子落点"
```

---

## Task 3: 报表三工具

**Files:**
- Modify: `modules/data/routes/mcp-report-tools.ts`（填实占位）
- Modify: `modules/data/manifest.yaml`（自述；**声明不变**）
- Create: `modules/data/routes/mcp-report-tools.test.ts`

**Interfaces:**
- Consumes: `McpToolGroup`（T1）、`upsertReport(…, 'create-only')`（T2）、
  `parseReportSpec` / `listReports` / `getReport` / `getReportVersion` / `updateSpec` / `withObjectLock`
- Produces: `const reportTools: McpToolGroup`

- [ ] **Step 1: 写测试（先红）**

```ts
// mcp-report-tools.test.ts — 报表工具面：能提、不能发（spec 2026-10-07 §3.3 的三条结构落点）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { getReport, upsertReport } from '../domain/report-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-mcp-report'
const LEGAL_SPEC = { panels: [
  { chart: 'line', title: '趋势', metricId: 'lemeng:retail:net_sales', dims: ['bizday'], args: {} },
] }

async function rpc(app: Hono, payload: unknown): Promise<Response> {
  return await app.request('/mcp-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}
function toolText(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describePg('报表工具面（能提、不能发）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = () => buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool }, { id: 1, casdoor_org: ORG })
  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  it('tools/list：名字集合含报表三工具；**不含**任何发布/回收工具', async () => {
    const names = (await (await rpc(app(), { jsonrpc:'2.0', id:1, method:'tools/list' })).json())
      .result.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_reports','propose_report','revise_report_spec']))
    expect(names.filter((n) => /publish|delete|recycle/i.test(n))).toEqual([])
  })

  it('★ 承重断言①：propose_report 建出来的报表**页门必然非空**（= 未发布）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:2, method:'tools/call',
      params: { name:'propose_report', arguments: { title:'承重①报表', spec: LEGAL_SPEC } } })).json())
    expect(out.status).toBe('ok')
    const row = await getReport(pool, ORG, out.id)
    expect(row!.renderer).toBe('platform')
    expect(row!.requiredScope).not.toBeNull()          // ★ 核心：agent 造不出「已发布」
  })

  it('★ 承重断言③：撞名（尤其已发布那张）⇒ 拒 TITLE_TAKEN，且既有行规格与页门一字未动', async () => {
    // 先造一张**已发布**的（页门 null）：走 store 直落（人路径的等价物）
    const publishedId = await upsertReport(pool, ORG, {
      title:'已发布的报表', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer:'platform', spec: { panels: [] },
    })
    const before = await getReport(pool, ORG, publishedId)

    const out = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:3, method:'tools/call',
      params: { name:'propose_report', arguments: { title:'已发布的报表', spec: LEGAL_SPEC } } })).json())
    expect(out.status).toBe('refused')
    expect(out.error).toBe('TITLE_TAKEN')

    const after = await getReport(pool, ORG, publishedId)
    expect(after!.requiredScope).toBeNull()                    // ★ 没被撤下
    expect(JSON.stringify(after!.spec)).toBe(JSON.stringify(before!.spec))   // ★ 规格没被换
    expect(after!.version).toBe(before!.version)
  })

  it('★ 承重断言②：改**已发布**报表的规格 ⇒ 拒 PUBLISHED_REPORT，且行未变', async () => {
    const id = await upsertReport(pool, ORG, {
      title:'已发布待改', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer:'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    const out = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:4, method:'tools/call',
      params: { name:'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(out.error).toBe('PUBLISHED_REPORT')
    expect((await getReport(pool, ORG, id))!.version).toBe(v)
  })

  it('改**未发布**报表的规格 ⇒ ok 且版本 +1；陈旧 expectedVersion ⇒ STALE_WRITE', async () => {
    const id = await upsertReport(pool, ORG, {
      title:'未发布待改', metabaseId: 0, embedParams: {}, requiredScope:'data:manage',
      renderer:'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    const okOut = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:5, method:'tools/call',
      params: { name:'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(okOut).toMatchObject({ status:'ok', version: v + 1 })

    const stale = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:6, method:'tools/call',
      params: { name:'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(stale.error).toBe('STALE_WRITE')
  })

  it('list_reports 回管理清单（含页门与版本、含未发布行）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:7, method:'tools/call',
      params: { name:'list_reports', arguments: {} } })).json())
    expect(out.status).toBe('ok')
    const titles = out.reports.map((r) => r.title)
    expect(titles).toContain('承重①报表')          // 未发布的那张也在（管理面不裁）
    expect(out.reports.every((r) => typeof r.version === 'number' && 'requiredScope' in r)).toBe(true)
  })

  it('规格白名单：白名单外图型 ⇒ 拒（沿用既有码，不是 500）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc:'2.0', id:8, method:'tools/call',
      params: { name:'propose_report', arguments: {
        title:'非法图型', spec: { panels: [{ chart:'pie', title:'x', metricId:'m', dims:[], args:{} }] } } } })).json())
    expect(out.error).toBe('UNKNOWN_CHART_TYPE')
  })
})
```

- [ ] **Step 2: 跑（先红）→ 实现**

```ts
// mcp-report-tools.ts — 管理面端点的**报表片**（制作面）。设计：
// docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md
//
// 「能提、不能发」三条**结构**落点（spec §3.3）：
//   ① 建报**不收 `requiredScope`**，平台强制写 FORCED_GATE ⇒ 造不出「已发布」；
//   ② `revise_report_spec` **先读页门**，已发布 ⇒ 拒 ⇒ 碰不到员工看得到的东西；
//   ③ 发布 / 回收**不是工具**（本片里没有它们）。
// 另加第 ④ 条（spec §3.3④，验证时挖出的洞）：`propose_report` 走**原子 create-only**
//   —— 否则同名的「提议」会改写既有报表（包括把已发布的静默撤下）。
import { z } from 'zod'
import { withObjectLock } from '../domain/object-lock'
import { parseReportSpec } from '../domain/report-spec'
import { getReport, getReportVersion, listReports, updateSpec, upsertReport } from '../domain/report-store'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

/**
 * 建出来的报表页门**恒**取它 = 「未发布」（只有持 `data:manage` 的人能在观看面看到）。
 * agent **改不了**它：工具入参里没有这个字段（spec §3.3①）。要发布，人在 console 把页门改掉或清空。
 */
const FORCED_GATE = 'data:manage'

const ProposeArgs = z.object({
  title: z.string().trim().min(1).max(200),
  spec: z.unknown(),                                  // 形状由 parseReportSpec 判（不在这里复制白名单）
}).strict()

const ReviseArgs = z.object({
  id: z.string().min(1),
  spec: z.unknown(),
  expectedVersion: z.number().int().positive(),
}).strict()

const NAMES = ['list_reports', 'propose_report', 'revise_report_spec'] as const
const ok = (o: Record<string, unknown>): McpToolResult =>
  ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })
const refused = (error: string, extra: Record<string, unknown> = {}): McpToolResult =>
  ({ text: JSON.stringify({ status: 'refused', error, ...extra }), isError: true })

export const reportTools: McpToolGroup = {
  async list(deps) {
    if (deps.requester === null) return []
    return [
      { name: 'list_reports',
        description: '列出本租户已有报表（标题 / 渲染器 / 页门 / 版本 / 面板数）。**提议新报表前先调它查重**。',
        inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'propose_report',
        description: [
          '提议一张新的平台自绘报表。**只是提议**：建出来的一定是未发布状态（页门挂在管理档），',
          '要发布得由人在控制台改页门。**不能凭空发明指标**——metricId 必须是 list_metrics 里出现的 id；',
          '图型只支持 line / bar / table。**标题不能与已有报表重名**（重名会被拒，不会覆盖）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '报表标题（不得与已有报表重名）' },
            spec: { type: 'object', description: '声明式规格：{ panels: [{ chart, title, metricId, dims, args, span }] }' },
          },
          required: ['title', 'spec'],
        } },
      { name: 'revise_report_spec',
        description: '修改**尚未发布**的报表的规格（已发布的会被拒——那要人在控制台改）。带 expectedVersion（取自 list_reports）。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '报表 id（取自 list_reports）' },
            spec: { type: 'object', description: '新的声明式规格' },
            expectedVersion: { type: 'number', description: '当前版本（取自 list_reports；陈旧会被拒）' },
          },
          required: ['id', 'spec', 'expectedVersion'],
        } },
    ]
  },

  async call(deps, name, args) {
    if (!(NAMES as readonly string[]).includes(name)) return null      // 不是我的工具 ⇒ 交给下一片
    if (deps.requester === null) {
      return { text: JSON.stringify({ status: 'error', reason: 'unauthenticated' }), isError: true }
    }
    const org = deps.org

    if (name === 'list_reports') {
      const rows = await listReports(deps.pool, org)
      return ok({ reports: rows.map((r) => ({
        id: r.id, title: r.title, renderer: r.renderer, requiredScope: r.requiredScope,
        version: r.version, panels: r.spec?.panels.length ?? null,
      })) })
    }

    if (name === 'propose_report') {
      const parsed = ProposeArgs.safeParse(args)
      if (!parsed.success) return refused('INVALID_BODY')
      const spec = parseReportSpec(parsed.data.spec)
      if (!spec.ok) return refused(spec.code)
      // ★ 原子 create-only：撞名 ⇒ 什么都不写、返回 null ⇒ 这里拒掉（§3.3④）
      const id = await upsertReport(deps.pool, org, {
        title: parsed.data.title, metabaseId: 0, embedParams: {},
        requiredScope: FORCED_GATE, renderer: 'platform', spec: spec.spec,
      }, 'create-only')
      if (id === null) return refused('TITLE_TAKEN')
      const row = await getReport(deps.pool, org, id)
      return ok({ id, version: row?.version ?? 1, requiredScope: FORCED_GATE })
    }

    // revise_report_spec
    const parsed = ReviseArgs.safeParse(args)
    if (!parsed.success) return refused('INVALID_BODY')
    const spec = parseReportSpec(parsed.data.spec)
    if (!spec.ok) return refused(spec.code)
    const { id } = parsed.data
    // 与 HTTP 面**同 key** 的对象锁：本流程是「先读行分流 → 条件 UPDATE」，
    // 必须与 PUT /reports/:id、PUT /reports/:id/spec、DELETE 互斥（spec §3.4）。
    return await withObjectLock(`${org}/row:${id}`, async (): Promise<McpToolResult> => {
      const row = await getReport(deps.pool, org, id)
      if (row === null) return refused('NOT_FOUND')
      if (row.renderer !== 'platform') return refused('RENDERER_NOT_SELF_DRAWN')
      // ★ 结构落点②：已发布（页门清空）⇒ 拒
      if (row.requiredScope === null) return refused('PUBLISHED_REPORT')
      const updated = await updateSpec(deps.pool, org, id, spec.spec, parsed.data.expectedVersion)
      if (updated === null) {
        const cur = await getReportVersion(deps.pool, org, id)
        return cur === null ? refused('NOT_FOUND') : refused('STALE_WRITE', { currentVersion: cur })
      }
      return ok({ id, version: updated.version })
    })
  },
}
```

`manifest.yaml`：把写面那段自述从「本租户口径的定义」改成「**管理面：口径 + 报表**」（**声明本身一行不改**，
端点没变 ⇒ `api.internal` 不动）。

- [ ] **Step 3: 跑到绿 → 变异确认 → 全量 → Commit**

```bash
dropdb --if-exists rt_dev; createdb rt_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' \
  pnpm exec vitest run routes/mcp-report-tools.test.ts 2>&1 | tail -8
```

**变异确认**（spec §6#6）：把 `FORCED_GATE` 临时改成 `null`，重跑 ⇒ **承重断言①必须变红**（其余仍绿）；改回。

```bash
DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' pnpm test 2>&1 | tail -5
cd ../.. && pnpm --filter data typecheck && pnpm exec tsx scripts/check-manifests.mjs
git add modules/data/routes/mcp-report-tools.ts modules/data/routes/mcp-report-tools.test.ts modules/data/manifest.yaml
git commit -m "feat(data): 报表三工具——能提不能发（强制页门 + create-only + 已发布不可改）"
```

---

## Task 4: README 记账

**Files:** `modules/data/README.md`

- [ ] **Step 1: 补「报表工具面」一节**（放在「agent 接入面」那节之后）

内容四条：① 三工具与「能提、不能发」的三条结构落点；② `data:manage` 作为「未发布」页门值是**约定不是新机制**；
③ 工具面**不含**发布/回收/删除（删除缺口另见 issue #494）；④ 未验：真 MCP 客户端在本端点工具数涨到 6 后的表现。

- [ ] **Step 2: Commit**

```bash
git add modules/data/README.md
git commit -m "docs(data): 报表工具面记账——能提不能发的三条结构落点 + 页门值的约定"
```

---

## Task 5: 收尾

- [ ] **Step 1: 全套本地门禁**

```bash
cd /Users/duo/orca/workspaces/platform-core/采集板块
dropdb --if-exists rt_dev; createdb rt_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/rt_dev' pnpm test 2>&1 | tail -5
cd ../.. && pnpm --filter data typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs
bash scripts/check-dev-discipline.sh origin/main HEAD
```

- [ ] **Step 2: 推 + PR（`Closes #N`）+ 等 CI CLEAN**

```bash
git push -u origin feat/<N>-report-agent-toolface
gh pr create --base main --head feat/<N>-report-agent-toolface \
  --title "feat(data): 报表 agent 制作通路——MCP 工具面（能提、不能发）" \
  --body "Closes #<N>。设计：docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md"
gh pr checks <PR号>
```

---

## 自检记录

- **spec 覆盖**：§3.1 端点 → T1/T3（挂管理面）；§3.2 四工具 → T3（`list_metrics` 复用，未改）；§3.3 ①②③④ → T3 的三条 + T2 的 create-only；
  §3.4 复用与同 key 锁 → T3（`withObjectLock`、`parseReportSpec`）；§3.5 文件分片 → T1；§4 不变量 → T2/T3；
  §6 七条断言 → T3 的测试（含三条承重 + Step 3 的变异确认）；§7 落地物 → T1–T4；§8 边界 → T4。
- **占位符扫描**：无 TBD。T1 Step 3 明确要求「先建占位空片」并给了它的完整代码（那是让 T1 自洽的必要步骤，不是留白）。
- **类型一致性**：`McpToolGroup`（T1 定义）→ T3 的 `reportTools` 实现；`upsertReport` 的三个重载（T2）→ T3 用 `'create-only'`
  并判 `null`；`refused/ok` 的形状在 T3 一处定义、全片复用。
