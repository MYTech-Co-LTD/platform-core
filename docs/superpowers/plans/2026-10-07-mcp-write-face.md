# 指标口径写面（MCP）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP 上加一个声明为 `data:manage` 的写面端点 `/mcp-manage`，暴露
`list_metrics` / `customize_metric` / `delete_custom_metric` 三个工具，让持有该档位凭据的外部 agent
能基于已有口径裁剪出本租户口径。

**Architecture:** 端点门禁**由 manifest 声明施加**（写面不写授权代码）；写路径的判定链抽到
`domain/metric-write.ts` 一份，HTTP 面与 MCP 面共用；JSON-RPC 协议壳抽到 `routes/mcp-rpc.ts` 一份，
两个端点各提供一个「工具集」。

**Tech Stack:** TypeScript / Hono / zod / vitest / pg（真实 Postgres 集成测试）。

**Spec:** `docs/superpowers/specs/2026-10-07-mcp-write-face-design.md`（本计划的唯一上游，逐条对应）

## Global Constraints

- **本模块不写 `requireScope`**：门禁一律由宿主按 manifest 的 `api.internal` 施加。
- **不新开绕过清单的入口**：任何新路由都必须在 `manifest.yaml` 的 `api.internal` 里声明
  （装载期双向核对：注册了未声明 ⇒ 装载失败；声明了未注册 ⇒ 装载失败）。
- **判定只有一份**：写路径的闸门不得在 HTTP 与 MCP 两处各写一遍。
- **主体钉死**：org 取 `c.get('tenant').casdoor_org`（text），**不入工具入参**。
- **注释随代码搬**：`routes/metrics.ts` 里的闸门理由（为什么先删 L2 再判 L1、为什么写入闸在
  `resolveL1Base` 之后、为什么 `target` 必须显式拒）**必须原样带到新位置**，不许在搬迁中丢理由。
- **工具描述用中文**，且必须写明「只能基于已有口径裁剪，不能凭空造新指标」。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/domain/metric-write.ts` | **新**：L2 写/删的**唯一**判定链（判别式结果，不碰 Hono） |
| `modules/data/routes/metrics.ts` | **改**：判定链改为调域层；路由只做「结果 → HTTP」映射 |
| `modules/data/routes/mcp-rpc.ts` | **新**：MCP 协议壳（JSON-RPC 分层 + initialize/ping/通知 + 工具分发） |
| `modules/data/routes/mcp.ts` | **改**：只剩「读面工具集」+ 一行注册调用 |
| `modules/data/routes/mcp-manage.ts` | **新**：写面工具集（三工具）+ 注册 |
| `modules/data/index.ts` | **改**：注册写面路由 |
| `modules/data/manifest.yaml` | **改**：加 `/mcp-manage` 声明；删掉「预留，本轮不实现」段 |
| `modules/data/README.md` | **改**：写面说明 + 两条已知边界 |
| `modules/data/test-util.ts` | **改**：目录取值 `.pathname` → `fileURLToPath`（否则本包测试在本机跑不起来，见 Task 1） |
| `modules/data/routes/mcp-manage.test.ts` | **新**：写面测试（协议面 + 三工具 + 承重断言） |

---

## Task 0: 前置（建 issue 与分支）

**Files:** 无

- [ ] **Step 1: 建 feat issue**（纪律要求：feat 必须先有 issue）

```bash
gh issue create --title "feat(data): MCP 写面——/mcp-manage 三工具，让外部 agent 能定制本租户口径" \
  --body "设计见 docs/superpowers/specs/2026-10-07-mcp-write-face-design.md。Closes 本 issue。"
```

记下返回的编号 `#N`（后面分支名与 PR body 都要用）。

- [ ] **Step 2: 从更新过的 origin/main 开分支**（本仓多工作树，陈旧基线上的生成物会让门禁红）

```bash
git fetch origin --prune
git checkout -b feat/<N>-mcp-write-face origin/main
```

---

## Task 1: 让 data 包的测试在本机（非 ASCII 路径）能跑

**为什么先做这条**：`modules/data/test-util.ts:61` 用 `new URL('./migrations', import.meta.url).pathname`
取迁移目录，**百分号编码**让 `readdir` ENOENT，而 `runMigrations` 对 ENOENT 是**静默跳过**（本仓 #203）
⇒ 在中文路径的工作树里**一个迁移都不跑却报成功**，本包测试全红在业务断言上。
不修这条，本计划后续所有任务的验收都做不了（CI 是 ASCII 路径，不受影响——所以它一直没被发现）。

**Files:**
- Modify: `modules/data/test-util.ts:61`

**Interfaces:**
- Consumes: 无
- Produces: `applyMigrations(pool)` 在任意路径下真实生效（后续任务全靠它）

- [ ] **Step 1: 复现（空库，先看红）**

```bash
dropdb --if-exists mw_repro; createdb mw_repro
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp.test.ts 2>&1 | tail -15
```

Expected: **红**，错误形如 `relation "data.metrics" does not exist`（迁移没跑）

- [ ] **Step 2: 改取值方式**

```ts
// 文件头 import 处补：
import { fileURLToPath } from 'node:url'

// :61 改为：
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'data', fileURLToPath(new URL('./migrations', import.meta.url)))
}
```

再加一句注（照 `modules/aftersales/test-util.ts` 同款）：

```ts
/** ⚠️ 目录必须经 `fileURLToPath` 取（**不是** `url.pathname`）：后者的百分号编码在**非 ASCII
 *  路径**下会让 `readdir` ENOENT，而 `runMigrations` 对 ENOENT **静默跳过**（#203）⇒ 症状是
 *  「零迁移却报成功」，一路红到业务断言上。 */
```

- [ ] **Step 3: 空库再跑，看绿**

```bash
dropdb --if-exists mw_repro; createdb mw_repro
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp.test.ts 2>&1 | tail -8
```

Expected: PASS（本文件全部用例）

- [ ] **Step 4: 跑本包全量**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' pnpm test 2>&1 | tail -8
```

Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add modules/data/test-util.ts
git commit -m "fix(data): 测试助手目录取值改 fileURLToPath——非 ASCII 路径下 runMigrations 静默空转（#203 的又一实例）"
```

---

## Task 2: 把 L2 写/删判定链抽到域层

**性质：纯重构。回归网 = 既有 `routes/metrics.test.ts`，一行不改必须全绿。**

**Files:**
- Create: `modules/data/domain/metric-write.ts`
- Modify: `modules/data/routes/metrics.ts`（删掉内联的 `writeL2`/`isL1Id`/`compileFailure`，改为调域层）

**Interfaces:**
- Produces:
  - `writeL2Declaration(deps: MetricWriteDeps, org: string, id: string, decl: L2DeclarationBody): Promise<MetricWriteOutcome>`
  - `deleteMetricDeclaration(deps: MetricWriteDeps, org: string, id: string): Promise<MetricWriteOutcome>`
  - `interface MetricWriteDeps { pool: Pool; adoptedSources: ReadonlySet<string> }`
  - `type MetricWriteOutcome = { ok: true } | { ok: false; http: 400|403|409|500; error: string; extra?: Record<string, unknown> }`
  - `type L2DeclarationBody` = 现有 `L2BodyType` 去掉 `id`（即 `baseMetric/op/alias?/visibility?/filters?/target?`）

- [ ] **Step 1: 先跑既有测试，确认基线绿**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/metrics.test.ts 2>&1 | tail -6
```

Expected: PASS（若红，先回 Task 1 确认环境）

- [ ] **Step 2: 建域层文件（判定链原样搬，注释原样搬）**

````ts
// domain/metric-write.ts — L2 写入/删除的**唯一**判定链（HTTP 面与 MCP 写面共用）。
//
// 为什么抽出来：写路径的闸门（撞 L1 保留 / 基底必须是 L1 / 源接入 / 维度越界 / 禁 target）
// 每加一条就会分叉一次——两个入口各写一份 = 两个事实源，而分叉的其中一条通常是**漏判**的那条。
// 形态照 query-service.runQuery：域层拿显式 deps、返回判别式结果，**不碰 Hono**。
import type { Pool } from 'pg'
import { deleteMetric, loadPlatformCatalog, upsertMetric } from './metric-store'
import type { MetricRow } from './metric-store'
import { SemanticCompileError, compileL2, resolveL1Base } from './semantic-compiler'
import type { L2Declaration } from './semantic-compiler'

export interface MetricWriteDeps {
  pool: Pool
  /** 本租户已接入的源（宿主投影）。空集 = 一个都没接 ⇒ 未接入源的基底一律拒（fail-closed）。 */
  adoptedSources: ReadonlySet<string>
}

/** 判别式结果：`http` 由调用方决定怎么用（HTTP 面直出；MCP 面翻成工具级错误）。 */
export type MetricWriteOutcome =
  | { ok: true }
  | { ok: false; http: 400 | 403 | 409 | 500; error: string; extra?: Record<string, unknown> }

/** 写路径 body 的声明部分（`id` 是行的稳定句柄，不属于声明本身）。 */
export interface L2DeclarationBody {
  baseMetric: string
  op: { kind: 'refine' }
  alias?: string
  visibility?: { dims: string[] }
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
  target?: number
}

/**
 * 编译失败 → 判别式结果。分两类是**有意的**：
 *   · 调用方的问题（引用不存在的 base、维度越界、过滤子句错）⇒ 400 且回**具体 code**，让调用方能自助改；
 *   · 平台自己的问题（L1 行的 select_sql 不合形状契约）⇒ 500：不是调用方能修的，且意味着 sync
 *     物化出来的东西坏了——必须响亮（500 会被监控看见，400 不会）。
 */
function compileFailure(e: SemanticCompileError): { http: 400 | 500; error: string } {
  return e.code === 'BAD_BASE_SQL'
    ? { http: 500, error: 'L1_BASE_SQL_INVALID' }
    : { http: 400, error: e.code }
}

/** 该 id 是否是平台词表（L1）里的行（L1 行对所有租户可见，故「只读」对所有租户成立）。 */
async function isL1Id(deps: MetricWriteDeps, id: string): Promise<boolean> {
  return (await loadPlatformCatalog(deps.pool)).some((m) => m.id === id)
}

export async function writeL2Declaration(
  deps: MetricWriteDeps, org: string, id: string, decl: L2DeclarationBody,
): Promise<MetricWriteOutcome> {
  // `target` 在 data.metrics 里**没有存储列**（003 只加了 source）。显式拒绝而不是静默丢弃：
  // 静默丢弃会让调用方以为目标值生效了。见 README「L2 的已知边界」。
  if (decl.target !== undefined) return { ok: false, http: 400, error: 'TARGET_NOT_SUPPORTED' }

  // ★ L2 不能占 L1 的 id：占下之后**加载侧会丢 L2 行**（L1 赢）⇒ 这次写会**静默无效**
  //   （返回 200 而线上口径没变）。故在这里响亮拒绝，而不是让它变成一次「成功的空操作」。
  if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' }

  let base: MetricRow
  try {
    base = resolveL1Base(await loadPlatformCatalog(deps.pool), decl.baseMetric)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  // ★ 源维度的**写入闸**（spec §3⑧ 的第二道）：L1 是**逐源**的标准口径，租户只能在自己的源上裁 L2。
  //   为什么闸在 resolveL1Base 之后：那是本函数第一次拿得到 `base.sourceSystem` 的地方。
  //   为什么用**不裁源**的 loadPlatformCatalog 解析基底：先裁的话调用方只会拿到含混的
  //   L1_BASE_NOT_FOUND（400），而真相是「这条口径在，但它在别的源上」——那是 403 + 可解释体
  //   该说的话。顺序上它还必须**先于** compileL2：拒绝要拒绝得早，不留半成品。
  if (base.sourceSystem !== null && !deps.adoptedSources.has(base.sourceSystem)) {
    return {
      ok: false, http: 403, error: 'METRIC_SOURCE_NOT_ADOPTED',
      extra: { its_source: base.sourceSystem, your_sources: [...deps.adoptedSources] },
    }
  }

  let compiled: { selectSql: string; title: string; groupBy: string }
  try {
    compiled = compileL2(base, decl as L2Declaration)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  await upsertMetric(deps.pool, org, {
    id,
    title: compiled.title,
    // 派生关系写进 description：管理面要能看出「这条 L2 是从哪个平台指标裁出来的」
    description: `L2 派生自 ${base.id}`,
    requiredScope: null,
    // 主体列**继承** L1：它是主体钉死的依据，租户改不了（改了就是跨租户读别人的数据）
    subjectColumn: base.subjectColumn,
    selectSql: compiled.selectSql,
    groupBy: compiled.groupBy,
    params: {},
  })
  return { ok: true }
}

export async function deleteMetricDeclaration(
  deps: MetricWriteDeps, org: string, id: string,
): Promise<MetricWriteOutcome> {
  // ★ 顺序：**先删本租户自己的 L2 行，再判 L1**（T8 评审 M-①，勿回退）。不能反——
  //   「租户先建 L2、平台事后同 id 物化」是**合法时序**，撞 id 之后那行 L2 在合并词表里被 L1
  //   顶掉（消费面看不见它），若先判 L1 就恒 409 ⇒ **永久孤儿**。删自己的行不影响任何人：
  //   「L1 赢」是**解析**规则，不是「租户的行归平台所有」。
  const gone = await deleteMetric(deps.pool, org, id)
  if (gone) return { ok: true }
  // 没删到：若这个 id 是平台词表里的 ⇒ **显式** 409（不是含混的 404）：404 会让管理员以为
  // 「这行不存在」，真相是「它在，但只能改 dbt 声明再物化」。
  if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'READONLY_L1' }
  return { ok: false, http: 404, error: 'NOT_FOUND' }
}
````

- [ ] **Step 3: 改 `routes/metrics.ts`：删内联实现，改成映射**

删掉 `compileFailure` / `isL1Id` / `writeL2` 三个内联定义，
以及 `deleteMetric` / `upsertMetric` / `compileL2` / `resolveL1Base` / `SemanticCompileError` /
`MetricRow` / `L2Declaration` / `loadPlatformCatalog` 这些**只被它们用到**的 import
（`loadMergedCatalog` / `visibleMetrics` 仍被读面用，保留）。

加：

```ts
import { deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { MetricWriteDeps, MetricWriteOutcome } from '../domain/metric-write'

/** 域层 deps 的**唯一**组装点（org 与已接入源都从宿主投影读）。 */
function writeDeps(ctx: RouteCtx, c: Context<ModuleVars>): MetricWriteDeps {
  return { pool: ctx.pool, adoptedSources: adoptedSourcesOf(c) }
}

/** 域层判别式结果 → HTTP（唯一映射点；`okStatus` 区分建 201 / 改 200）。 */
function writeOutcome(c: Context<ModuleVars>, r: MetricWriteOutcome, okStatus: 200 | 201) {
  return r.ok ? c.json({ ok: true }, okStatus) : c.json({ error: r.error, ...(r.extra ?? {}) }, r.http)
}
```

三条路由改为：

```ts
  r.post('/metrics', async (c) => {
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, ...decl } = parsed.data
    return writeOutcome(c, await writeL2Declaration(writeDeps(ctx, c), orgOf(c), id, decl), 201)
  })

  r.put('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 路径 id 与 body id 必须同值：否则「改 A 结果写了 B」是静默的数据事故。
    if (parsed.data.id !== id) return c.json({ error: 'ID_MISMATCH' }, 400)
    const { id: _bodyId, ...decl } = parsed.data
    return writeOutcome(c, await writeL2Declaration(writeDeps(ctx, c), orgOf(c), id, decl), 200)
  })

  r.delete('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    return writeOutcome(c, await deleteMetricDeclaration(writeDeps(ctx, c), orgOf(c), id), 200)
  })
```

⚠️ `L2BodyType` 仍要留（`L2Body` 推出来的类型给 `L2DeclarationBody` 对齐用）；
若 typecheck 报「`decl` 与 `L2DeclarationBody` 不兼容」，说明 zod 推出来的 `op.kind` 不是字面量
`'refine'`——那就把 `L2DeclarationBody` 的 `op` 直接写成 `L2BodyType['op']`。

- [ ] **Step 4: 跑既有测试（一行未改）**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/metrics.test.ts routes/mcp.test.ts 2>&1 | tail -8
```

Expected: **全绿**，且 `git diff --stat` 里**没有测试文件**（这是本任务的验收核心）

- [ ] **Step 5: typecheck + commit**

```bash
pnpm --filter @platform/data typecheck
git add modules/data/domain/metric-write.ts modules/data/routes/metrics.ts
git commit -m "refactor(data): L2 写/删判定链抽到 domain/metric-write——HTTP 面与 MCP 写面共用一份"
```

---

## Task 3: 把 MCP 协议壳抽出来（两个端点共用）

**性质：纯重构。回归网 = 既有 `routes/mcp.test.ts`，一行不改必须全绿。**

**Files:**
- Create: `modules/data/routes/mcp-rpc.ts`
- Modify: `modules/data/routes/mcp.ts`（只留「读面工具集」+ 一行注册）

**Interfaces:**
- Produces:
  - `registerMcpEndpoint(r: ModuleHono, path: string, ctx: RouteCtx, toolset: McpToolSet): void`
    （**`ctx: RouteCtx` 是必需的第三个参数**：`pool` / `execute` 来自模块装配期注入的 `RouteCtx`，
    不在 Hono context 上——读面原来的 `registerMcp(r, ctx)` 就是这么拿的）
  - `interface McpToolSet { serverName: string; list(deps: McpDeps): Promise<Record<string, unknown>[]>; call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> }`
  - `interface McpDeps { pool: Pool; execute?: SqlExecutor; org: string; requester: Requester | null; adoptedSources: ReadonlySet<string> }`
  - `interface McpToolResult { text: string; isError: boolean }`
  - `const PROTOCOL_VERSION = '2025-06-18'`

- [ ] **Step 1: 建 `mcp-rpc.ts`（协议细节原样搬，含文件头那些「为什么」）**

```ts
// mcp-rpc.ts — MCP 端点的**共享协议壳**：JSON-RPC 分层 + initialize/ping/通知 + 工具分发。
// 两个端点（读面 /mcp、写面 /mcp-manage）各提供一个「工具集」，协议细节只有这一份。
//
// 为什么不用 @modelcontextprotocol/sdk：本端点只用 initialize / ping / tools/list / tools/call
// 四个方法 + 通知，协议面小且稳定；引 SDK 会把重依赖塞进模块（modules/* 的依赖面刻意保持窄）。
//
// stateless 的含义：**无会话状态、不强制握手顺序**，不是拒答 initialize——真实 MCP 客户端连接
// 必走 initialize，回 -32601 会让本端点对它们不可用。通知（无 id）按 MCP 要求回 202 空体。
//
// ⚠️ 本壳**不做身份/授权判定**（那是工具集的事，见各工具集的 M3 守卫），也不替工具集决定
//    「未知工具」怎么答（读面把它交给 runQuery 的 denied，写面自己回工具级错误）。
import type { Pool } from 'pg'
import { TENANT_SOURCES } from '@platform/sdk'
import type { Requester } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'

/** 与 MCP 规范 2025-06-18 版协议字符串对齐；客户端不匹配时自行协商降级。 */
export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

export interface McpDeps {
  pool: Pool
  execute?: SqlExecutor
  org: string
  requester: Requester | null
  /** 宿主投影的「本租户已接入源」；`?? []` 的语义见各调用点（fail-closed）。 */
  adoptedSources: ReadonlySet<string>
}

export interface McpToolResult { text: string; isError: boolean }

export interface McpToolSet {
  /** initialize 回给客户端的 serverInfo.name——两个端点各自可辨认。 */
  serverName: string
  list(deps: McpDeps): Promise<Record<string, unknown>[]>
  call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

export function registerMcpEndpoint(
  r: ModuleHono, path: string, ctx: RouteCtx, toolset: McpToolSet,
): void {
  r.post(path, async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    // 错误码按 JSON-RPC 2.0 规范拆分：body 不可解析 → -32700；可解析但形状非法（缺 jsonrpc
    // 版本 / 缺 method）→ -32600。两类都回 JSON-RPC 错误信封（HTTP 200）——协议错误不是服务端故障。
    if (msg === null) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    // 通知（无 id）：**不回**，202 空体（MCP 明确要求；stateless 下也无从异步补发）
    if (msg.id === undefined) return c.body(null, 202)

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    // deps 的**唯一**组装点：pool / execute 来自装配期注入的 RouteCtx（不在 Hono context 上）；
    // org 取租户的 Casdoor org（text，与 /query 同一口径，不是数字 id）；
    // adoptedSources 的 `?? []` 是 fail-closed（宿主没投影 ⇒ 空集，见 ModuleVars 那个键的注记）。
    const deps: McpDeps = {
      pool: ctx.pool,
      execute: ctx.execute,
      org: c.get('tenant').casdoor_org,
      requester: requesterOf(c),
      adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: toolset.serverName, version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: await toolset.list(deps) })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await toolset.call(deps, name, args)
      // 拒绝/出错也走 result + isError（MCP 的工具级错误形态），JSON-RPC error 只留给协议层
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}
```

（`Context` 这个类型 import 在壳里用不到，别带进来——本仓 #44 的教训：类型当值引 typecheck 拦不住。）

- [ ] **Step 2: `routes/mcp.ts` 瘦身**

保留 `toTool` 与读面逻辑（`visibleMetrics` / `loadMergedCatalog` / `runQuery`），改成实现 `McpToolSet`：

```ts
const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',
  async list(deps) {
    // M3 守卫拒掉的请求者（requesterOf → null）：词表对其「看不见」——空 tools，不是报错。
    // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
    if (deps.requester === null) return []
    // 合并加载器（L1 ∪ 本 org）——与 /query、chat、GET /metrics 同一落点。
    // 裁剪带源维度（计划 5 §3⑧）：未接入源的指标不出现在工具面 ⇒ agent 连它存不存在都看不到。
    return visibleMetrics(
      await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources).map(toTool)
  },
  async call(deps, name, args) {
    // execute / adoptedSources 必须透传：缺前者会让 runQuery 去建真仓库连接（断言被网络错误顶掉）。
    const out = await runQuery(
      { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
      deps.org, deps.requester, name, args)
    return { text: JSON.stringify(out), isError: out.status !== 'ok' }
  },
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp', ctx, readToolset)
}
```

- [ ] **Step 3: 跑既有测试（一行未改）**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp.test.ts 2>&1 | tail -8
```

Expected: **全绿**，且 `git diff --stat` 里没有 `mcp.test.ts`

- [ ] **Step 4: typecheck + commit**

```bash
pnpm --filter @platform/data typecheck
git add modules/data/routes/mcp-rpc.ts modules/data/routes/mcp.ts
git commit -m "refactor(data): MCP 协议壳抽到 routes/mcp-rpc——读面/写面共用，协议细节只有一份"
```

---

## Task 4: 写面端点与三个工具

**Files:**
- Create: `modules/data/routes/mcp-manage.ts`
- Create: `modules/data/routes/mcp-manage.test.ts`
- Modify: `modules/data/index.ts`（注册）
- Modify: `modules/data/manifest.yaml`（声明）

**Interfaces:**
- Consumes: `registerMcpEndpoint` / `McpToolSet` / `McpDeps`（Task 3）、
  `writeL2Declaration` / `deleteMetricDeclaration`（Task 2）
- Produces: `registerMcpManage(r: ModuleHono, ctx: RouteCtx): void`

- [ ] **Step 1: 先写失败的测试（承重断言 + 协议面 + 三工具）**

````ts
// mcp-manage.test.ts — POST /mcp-manage 的写面测试。
// 三层：① **承重断言**（声明 scope 必须是 data:manage——它是「门禁来自声明」的唯一可机检落点）；
// ② 协议面（与读面同形）；③ 三工具（list / customize / delete_custom）与判定复用。
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-mcp-manage'

/** ① 承重断言：写面的门禁来自**声明**，所以清单里那一行是本设计安全属性的唯一落点。 */
describe('写面的声明（不需要数据库）', () => {
  it('★ /mcp-manage 在 api.internal 里声明为 data:manage', () => {
    const m = parseYaml(readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8')) as {
      api: { internal: { method: string; path: string; scope: string }[] }
    }
    const entry = m.api.internal.find((e) => e.path === '/mcp-manage')
    expect(entry).toBeDefined()
    expect(entry!.method).toBe('POST')
    expect(entry!.scope).toBe('data:manage')
  })

  it('清单声明集合与注册路由集合逐条一致（装载期双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod.createRouter({ pool: null as never }).routes
        .filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))
    expect([...registered].sort()).toEqual([...declared].sort())
  })
})

/** 一次 JSON-RPC POST 到写面。 */
async function rpc(app: Hono, payload: unknown): Promise<Response> {
  return await app.request('/mcp-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}
function toolText(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describePg('写面（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  function app(): Hono {
    return buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool })
  }

  it('tools/list → 恰好三件，且 customize 的描述写明「不能凭空造新指标」', async () => {
    await applyMigrations(pool)
    const body = await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const names = (body as { result: { tools: { name: string; description: string }[] } })
      .result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['customize_metric', 'delete_custom_metric', 'list_metrics'])
    const c = (body as { result: { tools: { name: string; description: string }[] } })
      .result.tools.find((t) => t.name === 'customize_metric')!
    expect(c.description).toContain('不能凭空造新指标')
  })

  it('list_metrics → 回本租户基底与自定义（空库时基底为空、自定义为空）', async () => {
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('ok')
    expect(Array.isArray(out.bases)).toBe(true)
    expect(Array.isArray(out.custom)).toBe(true)
  })

  it('customize_metric 撞 L1 保留 id → 工具级错误 ID_RESERVED_BY_L1，isError:true', async () => {
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: 'sales_daily', baseMetric: 'sales_daily' } },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('ID_RESERVED_BY_L1')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  it('customize_metric 基底不存在 → L1_BASE_NOT_FOUND；未知维度 → 具体维度码', async () => {
    const bad = await (await rpc(app(), {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: 'x1', baseMetric: 'nope' } },
    })).json()
    expect(toolText(bad as never).error).toBe('L1_BASE_NOT_FOUND')
  })

  it('delete_custom_metric 打 L1 id → READONLY_L1（复用同一条判定）', async () => {
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'delete_custom_metric', arguments: { id: 'sales_daily' } },
    })).json()
    expect(toolText(body as never).error).toBe('READONLY_L1')
  })

  it('协议面：通知回 202；未解析 body → -32700；未知方法 → -32601', async () => {
    expect((await rpc(app(), { jsonrpc: '2.0', method: 'ping' })).status).toBe(202)
    const bad = await (await rpc(app(), 'not json')).json()
    expect((bad as { error: { code: number } }).error.code).toBe(-32700)
    const unknown = await (await rpc(app(), { jsonrpc: '2.0', id: 9, method: 'nope' })).json()
    expect((unknown as { error: { code: number } }).error.code).toBe(-32601)
  })
})
````

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp-manage.test.ts 2>&1 | tail -12
```

Expected: **失败**（声明那条找不到 `/mcp-manage`；路由 404）

- [ ] **Step 3: 实现写面**

```ts
// mcp-manage.ts — POST /mcp-manage：**写面**（本租户口径的定义）。
// 门禁由宿主按 manifest 的 `scope: data:manage` 施加——**本文件不写 requireScope**。
// 判定不自建：写/删一律经 domain/metric-write（与 HTTP 面同一份），本文件只做
// 「参数形状校验 + 域层结果 → MCP 工具级错误」。
import { z } from 'zod'
import { L2DeclarationSchema } from '../domain/semantic-compiler'
import { deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { L2DeclarationBody, MetricWriteOutcome } from '../domain/metric-write'
import { dimensionNamesOf } from '../domain/semantic-compiler'
import { loadMergedCatalog } from '../domain/metric-store'
import { visibleMetrics } from '../domain/authz'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpDeps, McpToolSet } from './mcp-rpc'

/** 工具入参 = L2 声明的**去掉 op 与 target**（op 由工具面固定为 refine；target 不受支持）。 */
const CustomizeArgs = L2DeclarationSchema.omit({ op: true, target: true })
  .extend({ id: z.string().min(1).max(64) })
  .strict()
const DeleteArgs = z.object({ id: z.string().min(1).max(64) }).strict()

const ok = (o: Record<string, unknown>) => ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })
const refused = (r: MetricWriteOutcome) => {
  const extra = r.ok ? {} : (r.extra ?? {})
  const error = r.ok ? 'UNKNOWN' : r.error
  return { text: JSON.stringify({ status: 'refused', error, ...extra }), isError: true }
}

/** 只投影口径本身：不回 selectSql（上游 spec §4.4：给人/给 agent 看的是**口径**，不是 SQL）。 */
const view = (m: { id: string; title: string; description: string } & Parameters<typeof dimensionNamesOf>[0]) =>
  ({ id: m.id, title: m.title, description: m.description, dimensions: dimensionNamesOf(m) })

const manageToolset: McpToolSet = {
  serverName: 'platform-data-mcp-manage',

  async list(deps) {
    // M3 守卫同读面：空身份 ⇒ 空工具面（守卫必须在加载词表之前）
    if (deps.requester === null) return []
    const all = await loadMergedCatalog(deps.pool, deps.org)
    // 基底（L1）走**同一条**裁剪（scope + 已接入源）——与读面同一份事实，不另立裁法
    const bases = visibleMetrics(all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
    // 本租户自己的 L2：管理面口径（与 GET /metrics/all 同——调用方持 data:manage）
    const custom = all.filter((m) => m.source === 'l2')
    return [
      {
        name: 'list_metrics',
        description: '列出可用作基底的平台口径（含可用维度），以及本租户已定义的口径。**定义前先调它**。',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'customize_metric',
        description: [
          '基于一条已有平台口径，裁剪出本租户的口径（改名 / 收窄可见维度 / 加过滤）。',
          '**只能基于已有口径裁剪，不能凭空造新指标**：baseMetric 必须是 list_metrics 里出现的',
          '平台口径 id；可用维度也以它为准（维度越界会被拒）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '本租户口径的 id（≤64 字，不能与平台口径重名）' },
            baseMetric: { type: 'string', description: '基底平台口径 id（取自 list_metrics）' },
            alias: { type: 'string', description: '展示名' },
            visibility: { type: 'object', description: '可见维度（决定外层聚合口径）' },
            filters: { type: 'array', description: '等值过滤' },
          },
          required: ['id', 'baseMetric'],
        },
      },
      {
        name: 'delete_custom_metric',
        description: '删除本租户自定义的口径。**平台口径不可删**（会被拒）。',
        inputSchema: {
          type: 'object', properties: { id: { type: 'string', description: '口径 id' } }, required: ['id'],
        },
      },
    ]
  },

  async call(deps, name, args) {
    if (deps.requester === null) {
      return { text: JSON.stringify({ status: 'error', reason: 'unauthenticated' }), isError: true }
    }
    if (name === 'list_metrics') {
      const all = await loadMergedCatalog(deps.pool, deps.org)
      const bases = visibleMetrics(all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
      return ok({ bases: bases.map(view), custom: all.filter((m) => m.source === 'l2').map(view) })
    }
    const writeDeps = { pool: deps.pool, adoptedSources: deps.adoptedSources }
    if (name === 'customize_metric') {
      const parsed = CustomizeArgs.safeParse(args)
      if (!parsed.success) {
        return { text: JSON.stringify({ status: 'refused', error: 'INVALID_BODY' }), isError: true }
      }
      const { id, ...decl } = parsed.data
      // op 由工具面固定：v1 只有 refine（上游 spec §3③ —— 工具面比 HTTP 面**窄**是有意的）
      const r = await writeL2Declaration(
        writeDeps, deps.org, id, { ...decl, op: { kind: 'refine' } } as L2DeclarationBody)
      return r.ok ? ok({ id }) : refused(r)
    }
    if (name === 'delete_custom_metric') {
      const parsed = DeleteArgs.safeParse(args)
      if (!parsed.success) {
        return { text: JSON.stringify({ status: 'refused', error: 'INVALID_BODY' }), isError: true }
      }
      const r = await deleteMetricDeclaration(writeDeps, deps.org, parsed.data.id)
      return r.ok ? ok({ id: parsed.data.id }) : refused(r)
    }
    return { text: JSON.stringify({ status: 'error', reason: 'unknown_tool', name }), isError: true }
  },
}

export function registerMcpManage(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-manage', ctx, manageToolset)
}
```

- [ ] **Step 4: 注册 + 声明**

`modules/data/index.ts`：加 `import { registerMcpManage } from './routes/mcp-manage'`，
并在 `registerMcp(r, _ctx)` 后加 `registerMcpManage(r, _ctx) // 写面（MCP）`。

`modules/data/manifest.yaml` 的 `api.internal` 里、紧跟 `- { method: POST, path: /mcp, scope: data:query }`
之后加：

```yaml
    # ── 写面（MCP；本租户口径的定义）──
    # 与 /mcp 分开成两个端点，是为了让**门禁仍由声明施加**（本模块不写 requireScope）：
    # 把写工具塞进 /mcp 会让「写所需的能力」不再出现在清单里，清单作为「声明即授权」的
    # 单一事实源就被削弱了。设计见 docs/superpowers/specs/2026-10-07-mcp-write-face-design.md。
    - { method: POST, path: /mcp-manage, scope: data:manage }
```

- [ ] **Step 5: 跑测试到绿**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp-manage.test.ts 2>&1 | tail -12
```

Expected: PASS

- [ ] **Step 6: 变异确认承重断言**

把 `manifest.yaml` 里 `/mcp-manage` 那行的 `data:manage` 临时改成 `data:query`，跑：

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' \
  pnpm exec vitest run routes/mcp-manage.test.ts 2>&1 | grep -E "FAIL|★|Test Files"
```

Expected: **恰有那条「★ /mcp-manage 声明为 data:manage」变红**。确认后改回。

- [ ] **Step 7: 跑本包全量 + typecheck + commit**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/mw_repro' pnpm test 2>&1 | tail -6
pnpm --filter @platform/data typecheck
git add modules/data/routes/mcp-manage.ts modules/data/routes/mcp-manage.test.ts \
        modules/data/index.ts modules/data/manifest.yaml
git commit -m "feat(data): MCP 写面 /mcp-manage——list/customize/delete_custom 三工具，门禁由声明施加"
```

---

## Task 5: 文档与注释收口

**Files:**
- Modify: `modules/data/manifest.yaml`（删掉「预留 agent 接入面…另题，本轮不实现」那段注释，改为指向已实现）
- Modify: `modules/data/README.md`（写面说明 + 两条已知边界）

- [ ] **Step 1: manifest 注释收口**

把「── agent 接入面（**预留，本轮不实现**）──」那段的「**未做**：MCP 工具面…另题，不在本模块本轮范围」
改成事实陈述（读面读、写面写/删各是哪些端点），并保留那句仍然成立的告诫：
「**不要**新开绕过本清单的入口（那样会绕开宿主门卫，MCP 端点评审 §11.3.1 的教训）」。

- [ ] **Step 2: README 记两条已知边界**（照 spec §6 原文）

1. 写面工具名与租户可自取的指标 id 理论上可能撞名（不保留前缀的代价；MCP 客户端按 server 隔离，
   后果是「可能用错那一个」，不是安全面）。
2. **写路径无审计**：创建/删除本租户口径不落审计行（查询有）；排查「谁改了口径」只能靠行上的时间戳。
   这是既有缺口，本次不扩。

- [ ] **Step 3: 提交**

```bash
git add modules/data/manifest.yaml modules/data/README.md
git commit -m "docs(data): 写面说明 + 两条已知边界（撞名 / 写路径无审计）"
```

---

## Task 6: 收尾（PR）

- [ ] **Step 1: 本地门禁**

```bash
cd /Users/duo/orca/workspaces/platform-core/采集板块
bash scripts/check-dev-discipline.sh origin/main HEAD
pnpm exec tsx scripts/check-manifests.mjs
pnpm --filter @platform/data typecheck
```

Expected: 全过（`check-manifests` 会校验 manifest schema；`/mcp-manage` 那行必须过）

- [ ] **Step 2: 推 + 开 PR（`feat` ⇒ body 必须 `Closes #N`）**

```bash
git push -u origin feat/<N>-mcp-write-face
gh pr create --base main --head feat/<N>-mcp-write-face \
  --title "feat(data): MCP 写面——/mcp-manage 三工具，门禁由声明施加" \
  --body "Closes #<N>。设计：docs/superpowers/specs/2026-10-07-mcp-write-face-design.md"
```

- [ ] **Step 3: 等 CI CLEAN 再合**（UNSTABLE 强合出过生产 502；不合红了的主干）

```bash
gh pr checks <PR号>
```

---

## 自检记录（写完计划后跑的）

- **spec 覆盖**：§4.1 端点 → Task 4 Step 4；§4.2 三工具 → Task 4 Step 3；§4.3 复用边界 → Task 2；
  §3⑤ 协议壳一份 → Task 3；§3① 门禁靠声明 → Task 4 Step 1 承重断言 + Step 6 变异确认；
  §6 已知边界 → Task 5 Step 2；§7 测试 7 条 → Task 4 Step 1 + Task 2/3 的「既有测试一行不改」。
  §9 未验三条不产生任务（它们本来就未验）。
- **占位符扫描**：无 TBD / 「适当处理」类空话；每个代码步骤都给了可直接落盘的完整片段。
  （初稿在 Task 3 曾留过一处「故意写错的装配占位」，已改成正确写法——占位符会让实施者照抄。）
- **类型一致性**：`MetricWriteOutcome` / `L2DeclarationBody` / `McpToolSet` / `McpDeps` /
  `McpToolResult` 在 Task 2、3、4 之间逐字一致。
