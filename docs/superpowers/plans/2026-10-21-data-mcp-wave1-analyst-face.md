# 数据面 MCP 分析师面 Wave 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通道 B（`/mcp`）落地分析师面——registry/envelope/guide + discovery/query/health 共 11 个固定工具 + `query_metric` 切片化（authz 唯一扩展点）+ warehouse 只读池 + 审计扩 `tool` 字段 + 协议整改（2025-11-25 / 命名 / 注解 / 写开关默认关）+ `scripts/check-mcp-toolface.mjs` CI 门 + 跨租户 e2e toolface 扩展。

**Architecture:** 授权核心单实现不动——`authorize` 增可选 `slicing` 参数，切片 SQL 经单函数 `buildSlicedPlan` 组装，主体钉死与现路径共享同一段 `whereAndGroup`（内层 SELECT + `WHERE subject`）代码。新增 `modules/data/domain/toolbox/`：`registry.ts` 是**纯**静态事实源（门禁与 e2e 可直接 import，不拉 pool）；工具实现分文件（guide/discovery/health/query），由 `toolbox/all.ts` 显式注册（避免循环依赖、避免门禁拉进 pg）。分析师面仓库读全部走 `analystPool()`（`default_transaction_read_only=on`）；所有 `tools/call`（含拒绝/出错）经 `registry.callTool` 单点写审计。

**Tech Stack:** TypeScript / Hono / pg + pg_duckdb（只读池）/ vitest（data 包 + scripts 守卫测试）/ tsx（门禁脚本经 `allowImportingTsExtensions` 直引 registry TS）。不新增运行时依赖。

**Spec（唯一事实源）:** `docs/superpowers/specs/2026-10-21-data-mcp-analyst-face-and-proposal-design.md`（在 explore 仓 `/Users/duo/orca/workspaces/explore/调研-datay-这个项目/` 下）§9 Wave 1。**不含** Wave 2（A/C 绑定）与 Wave 3（T1 提案面）。§11 未决项按默认执行（见「未决项默认值落点」节）。

---

## Global Constraints（spec §Global Constraints 逐字继承 + 本仓正典补齐）

- **授权核心单实现**：任何通道/工具不得自建权限判定（fork#3 约束 6）。工具级 scope 在 Wave 1 只做**声明面**（`ToolMeta.requiredScope`），执法点仍是端点门卫（冲突点见决策 D1）。
- **主体钉死**：SQL 主体值只来自身份解析；请求参数（含 `slicing.filters`）出现保留键一律拒；回包带钉死主体。
- **fail-closed**：`adoptedSources` 缺省 = 空集；空身份 = 空工具面（不是报错）。
- **工具面预算**：分析师面工具 **≤14**；`tools/list` 体积 **≤10KB**（按 registry 静态序列化计，只数分析师面固定工具——决策 D2）；工具名 `[A-Za-z0-9_.-]`。
- **行限沿用**：`MAX_QUERY_ROWS=1000`（`modules/data/domain/authz.ts:135` 已有，勿重复定义）；抽样 ≤50 行；preview 只编译不执行（0 次仓库查询）。
- **只读落库**：分析师面 warehouse 连接强制 `default_transaction_read_only=on`。
- **审计**：所有 `tools/call`（含拒绝与出错）入 `data.query_audit`（扩 `tool` 字段）。
- **写开关默认关**：mutating 工具默认拒（工具级错误 `mutating_disabled`），显式开才可用（与 DataY 默认相反）。
- **通道 C 红线**：本 Wave 不碰 `domain/agent-loop.ts`、不碰 `deploy/openclaw/`、不动授权核心既有判定与文档化的拒绝原因。
- **迁移纪律**（团队规则 db-migration §1）：DDL 一律 `add column if not exists`；本 Wave 只加列、无新表（无租户隔离面新增——`check-tenant-isolation` 判据不受影响）。
- **B9**：代码引用的 env 键必须在 `.env.example` 声明（本 Wave 新增 `DATA_MCP_ALLOW_MUTATING`、`DATA_DBT_MANIFEST_PATH` 两键）。
- **桶文件纪律**（#44）：`export` 值清单里绝不混入 interface/type（Node ESM 运行时 SyntaxError）。
- **scripts/ 是 checkJs**：新/改 `.mjs` 一律带 JSDoc 参数/返回值标注；单形状、字段恒在（团队在案的类型书写陷阱）。
- **本地测试前置**：data 包的 pg 用例需 `DATABASE_URL`（本地 compose pg；无该 env 的用例段 `describe.skip`——照 `mcp.test.ts` 的 `describePg` 模式）。
- **提交纪律**：Conventional Commits；feat/fix 需真实 issue（本计划所有 `#<ISSUE>` 均为**占位号**——开工前先建总 issue「数据面 MCP 分析师面 Wave 1」，把占位号替换成真实号，PR body 带 `Closes #N`）。合并只等 CI CLEAN。

---

## 关键决策与 spec 冲突点（实现者必读）

**D1（spec 冲突：`data:read` 端点级分离）**
spec §8 要求「`data:read`（新）与 `data:query` 分离进 manifest `api.internal`」。但正典的宿主门卫是**一端点一 scope**（`packages/platform-sdk/src/module.ts:194` `DeclaredEndpoint.scope: string`；`declaredScopeGate` 按 path+method 单值命中），同一 `/mcp` 路径无法声明两个 scope；拆两个端点会改变客户端契约（spec §6 是单 B 面）。**按正典执行 + 记录冲突**：
- Wave 1 把 `data:read` 收录进 manifest `permissions`（码可被授予、出现在 `data_harness_catalog` 的声明面输出里）；
- `/mcp` 端点门卫**维持 `data:query` 不变**（零回归）；registry 对工具**不做**第二份 scope 判定（否则违反授权单实现）；
- 「端点级 read/query 分离」（协议扩 scope 语义 或 双端点）**留人工裁决**，在 PR 描述中点名。这是 spec 冲突记录，不是悄悄降级。

**D2（工具面预算口径 + 未决 #1 默认）**
legacy「每指标一工具」与通用 `query_metric` **并存**（spec §11 #1 默认）。legacy 工具名是指标 id（含 `:`），违反 2025-11-25 命名 ⇒ 经 `sanitizeToolName`（冒号→`__`）+ registry 双向映射。工具面预算 ≤14 与 ≤10KB **只数分析师面 11 个固定工具**（`ANALYST_TOOLS`，group ∈ guide/discovery/query/health）；legacy 指标工具是过渡面（同端点共存、带注解），不计入预算——口径在 `check-mcp-toolface.mjs` 与 spec §8「用 registry 静态序列化」一致。

**D3（未决 #2 默认：血缘/健康数据源）**
默认读仓内 dbt `manifest.json`——经 seam（`ToolboxDeps.dbtManifest`，缺省实现读 env `DATA_DBT_MANIFEST_PATH`，可选）。seam 缺席/读不到 ⇒ `get_quality`/`get_lineage` 回**显式 unknown**、信封 `lineage` 字段**缺席**——「无结论必须显式未知」，绝不捏造。「manifest.json 是否真随 data-plane.lock 投递到 server 容器」**未验证**，待真机案例后沉淀（标「待沉淀」，不编）。

**D4（写开关）**
`DATA_MCP_ALLOW_MUTATING` 缺省 false（fail-closed）。`registry.callTool` 对 `mutating===true` 的工具在开关关时回工具级错误 `mutating_disabled` 并入审计。Wave 1 的 11 个工具全部 `mutating:false`（纯只读）——机制、开关、门禁断言④先立，Wave 3 提案面直接受它管。这不是权限判定（是功能总闸），不违反 D1/单实现。

**D5（只读池与辅助读）**
`analystPool()` 单例（同 `DATA_WAREHOUSE_URL`，只是会话强制只读）；`QueryDeps.warehouseExec`（缺省 = 现 `warehousePool()` 行为，**现状行为零变化**）承接 runQuery 的全部辅助读（data_as_of / 水位 / 维度名称解析）。分析师面把 `execute` 与 `warehouseExec` 都指到只读池 ⇒ 主计划与辅助读**全部**只读。dbt 物化继续走写池，互不影响。

**D6（query_metric 经 runQuery，不另起执行路径）**
分析师面 `query_metric` 调 `runQuery`（增可选 `slicing` 形参透传给 authorize），复用掩码、审计、维度名称、新鲜度、竞态重试全套既有机制——执行路径不分叉。信封在 toolbox 层包装（`buildEnvelope`），`auditId` 取自 `QueryOk.audit.id`（T5 给 `writeAudit` 加 `returning`）。

**D7（审计字段语义）**
`AuditEntry.tool?: string|null`；迁移 `021_query_audit_tool.sql` 加 `tool text`（可空——legacy HTTP/chat 行不带 tool）。非指标工具（guide 等）`metric_id=''`（空串，列 not null 不是 null），`tool='<工具名>'`；`rowCount=null`（没行数可记）。信封 `audit.ts` 用北京时间 ISO 形态 `YYYY-MM-DDTHH:mm:ss+08:00`（与 spec §4 示例同区）。

**D8（preview 的 estimatedRows 语义）**
「0 次仓库查询」⇒ `estimatedRows` **不是统计估计**，= 计划的 LIMIT 上界（`min(请求, 1000)`）；`warnings[0]` 显式说明该语义，模型不得把它读成「预计返回这么多行」。

---

## 未决项默认值落点（spec §11）

| # | 默认 | 本计划落点 |
|---|---|---|
| 1 | legacy 读面与 query_metric 并存，观察一个周期后下线 | D2；legacy 工具保留在 `/mcp`（T11） |
| 2 | 血缘/健康读 dbt manifest.json（随 lock 投递） | D3；seam + `DATA_DBT_MANIFEST_PATH`（T9） |
| 3 | OAuth：PAT 先行 | 不涉及（不引入 OAuth） |
| 4 | `data:sql` 独立 scope+池，Wave 3 后另案 | 不涉及（不实现） |
| 5 | RAG 后置 | 不涉及 |
| 6 | OpenClaw 部署窗口随例行 | 不涉及（Wave 2） |

---

## File Structure（Create/Modify 全表）

| 文件 | 动作 | 职责 |
|---|---|---|
| `modules/data/domain/toolbox/registry.ts` | Create | **纯**：ToolMeta 类型 / `TOOL_NAME_RE` / `sanitizeToolName` / `ANALYST_TOOLS`（11 条静态清单）/ `registerImpl`+`callTool`（mutating 闸 + 单点审计）/ legacy 指标工具的命名与 collision-skip |
| `modules/data/domain/toolbox/envelope.ts` | Create | **纯**：`ENVELOPE_SCHEMA`（信封 JSON Schema）+ `buildEnvelope`（缺字段可辨） |
| `modules/data/domain/toolbox/guide.ts` | Create | `data_agent_guide` / `data_harness_catalog` 实现 |
| `modules/data/domain/toolbox/discovery.ts` | Create | `search_catalog` / `describe_metric` / `describe_dataset` / `sample_dimension_values` |
| `modules/data/domain/toolbox/query.ts` | Create | `preview_query` / `query_metric`（信封） |
| `modules/data/domain/toolbox/health.ts` | Create | `get_freshness` / `get_quality` / `get_lineage` + dbt manifest seam |
| `modules/data/domain/toolbox/all.ts` | Create | 显式注册全部 impl（`/mcp` 装配唯一入口） |
| `modules/data/domain/authz.ts` | Modify | `authorize` 增可选 `slicing`；`buildSlicedPlan` 单函数组装；`authorizeCore` 暴露内层 `whereAndGroup` |
| `modules/data/domain/warehouse.ts` | Modify | `analystPool()` 只读单例 + `resetAnalystPool()` |
| `modules/data/domain/audit-store.ts` | Modify | `AuditEntry.tool` + `writeAudit` 返回 `{id, createdAt}` |
| `modules/data/domain/query-service.ts` | Modify | `QueryDeps.tool/warehouseExec/slicing` 透传；`QueryOk.audit`；`watermarkSqlFor` 导出 |
| `modules/data/migrations/021_query_audit_tool.sql` | Create | `alter table data.query_audit add column if not exists tool text` |
| `modules/data/routes/mcp.ts` | Modify | 读面 toolset 改 registry 驱动（legacy sanitized + 分析师面 11 工具） |
| `modules/data/routes/mcp-rpc.ts` | Modify | `PROTOCOL_VERSION='2025-11-25'`；`McpToolResult.structured`；tools/call 回 `structuredContent` |
| `modules/data/manifest.yaml` | Modify | `permissions` 收录 `data:read`（D1：api.internal 不动） |
| `.env.example` | Modify | 新增 `DATA_MCP_ALLOW_MUTATING` / `DATA_DBT_MANIFEST_PATH` 两键 |
| `scripts/check-mcp-toolface.mjs` | Create | CI 门：工具数/体积/命名/注解四断言（对 registry 静态清单跑） |
| `scripts/check-mcp-toolface.test.ts` | Create | 守卫单测（判据纯函数 + 对真仓清单的断言） |
| `scripts/e2e-data-cross-tenant.mjs` | Modify | 面⑤ toolface 判定 + 编排接线 + loadConfig 防假绿闸 |
| `scripts/e2e-data-cross-tenant.test.ts` | Modify | 面⑤判定单测（防假绿铁律：正面先验、同值/空集即抛、命名对齐） |
| `.github/workflows/ci.yml` | Modify | gates job 追加 toolface 门一步 |
| 各 `*.test.ts` | Create/Modify | 见各任务 |

**明确不动**（Wave 1 边界）：`domain/agent-loop.ts`、`routes/mcp-manage.ts`（GROUPS 追加是 Wave 3）、`routes/query.ts`、`routes/chat.ts`、`deploy/openclaw/**`、console 前端。

---

### Task 1: registry.ts —— 工具注册表（纯静态事实源 + 命名清洗 + callTool 单点审计）

**Files:**
- Create: `modules/data/domain/toolbox/registry.ts`
- Create: `modules/data/domain/toolbox/registry.test.ts`
- Modify: `.env.example`（追加 `DATA_MCP_ALLOW_MUTATING=`）

**Interfaces:**
- Consumes: `MetricDef/Requester/SourceTaggedMetric/visibleMetrics/MAX_QUERY_ROWS`（`../authz`，纯）；`SqlExecutor`（`../query-service`，`import type`，运行时零依赖）。
- Produces（后续任务全部依赖，逐字）:
  - `TOOL_NAME_RE: RegExp`；`ANALYST_FACE_MAX_TOOLS = 14`；`ANALYST_FACE_MAX_LIST_BYTES = 10240`；`SAMPLE_MAX_ROWS = 50`
  - `interface ToolAnnotations { readOnlyHint: boolean }`
  - `interface ToolMeta { name: string; group: 'guide'|'discovery'|'query'|'health'; title: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; requiredScope: string|null; mutating: boolean; annotations: ToolAnnotations }`
  - `interface ToolboxDeps { pool: Pool; org: string; requester: Requester|null; adoptedSources: ReadonlySet<string>; wh: SqlExecutor; allowMutating?: boolean; dbtManifest?: () => Promise<DbtManifestView|null>; now?: () => Date }`（`DbtManifestView` 在 T9 定义，此处 `import type` 自 health 会循环——**改为** `dbtManifest?: () => Promise<unknown>`，T9 收窄）
  - `interface ToolImplResult { payload: Record<string, unknown>; isError: boolean; auditMetricId?: string; auditRowCount?: number|null }`
  - `type ToolImpl = (deps: ToolboxDeps, args: Record<string, unknown>) => Promise<ToolImplResult>`
  - `registerImpl(name: string, impl: ToolImpl): void`（未知名/重复注册即抛）
  - `callTool(deps: ToolboxDeps, name: string, args: Record<string, unknown>): Promise<ToolImplResult>`——**唯一**分发点：mutating 闸、未知工具、空身份、审计（含拒绝/出错）
  - `listAnalystTools(): readonly ToolMeta[]`；`analystToolNames(): string[]`
  - `sanitizeToolName(id: string): string`（`:`→`__`，其余 `[^\w.-]`→`_`，空串抛）
  - `legacyMetricTools<T extends SourceTaggedMetric>(catalog: readonly T[], requester: Requester, adoptedSources: ReadonlySet<string>): { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[]`——可见指标 → sanitized 工具；与 `ANALYST_TOOLS` 撞名或彼此 sanitize 后撞名的**跳过**（fail-closed：撞名工具不可被冒名）
  - `mutatingAllowed(env: Record<string, string|undefined>): boolean`（`env.DATA_MCP_ALLOW_MUTATING === 'true'` 才 true）
  - ⚠️ registry.ts 及其 import 链（authz→mask）**不得** import 任何 workspace 包/pool/Hono——T12 门禁要经 tsx 直接 import 本文件。

- [ ] **Step 1: 写失败测试**（`modules/data/domain/toolbox/registry.test.ts`）

```ts
// registry.test.ts — 工具注册表：纯函数层（不连库）。
import { describe, expect, it } from 'vitest'
import {
  ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS, ANALYST_TOOLS,
  callTool, legacyMetricTools, listAnalystTools, mutatingAllowed,
  registerImpl, sanitizeToolName, TOOL_NAME_RE,
} from './registry'
import type { ToolboxDeps } from './registry'
import type { MetricDef, Requester } from '../authz'

const requester = (scopes: string[]): Requester => ({
  userId: 'u1', orgId: 'acme', channel: 'pat', keyId: 1,
  scopes, hasScope: (c) => scopes.includes(c),
})
const metric = (over: Partial<MetricDef>): MetricDef => ({
  id: 'x', title: 'X', description: '', requiredScope: null,
  subjectColumn: 'org', selectSql: 'select org from t', groupBy: '', params: {}, ...over,
})

describe('sanitizeToolName / 命名', () => {
  it('冒号 → __；其余非法字符 → _；输出必合 TOOL_NAME_RE', () => {
    expect(sanitizeToolName('lemeng:retail:net_sales')).toBe('lemeng__retail__net_sales')
    expect(sanitizeToolName('a b/c')).toMatch(TOOL_NAME_RE)
    expect(() => sanitizeToolName('')).toThrow()
  })
})

describe('ANALYST_TOOLS 静态清单自身的约束（工具面预算的实体面）', () => {
  it('11 个固定工具、名字全合法、mutating 全 false（Wave 1 纯只读）', () => {
    expect(ANALYST_TOOLS.length).toBe(11)
    for (const t of ANALYST_TOOLS) {
      expect(t.name).toMatch(TOOL_NAME_RE)
      expect(t.mutating).toBe(false)
      expect(t.annotations.readOnlyHint).toBe(true)
      // scope ∈ 声明面两码（discover/health/guide = data:read；数值 = data:query——见 Task 1 清单）
      expect(['data:read', 'data:query']).toContain(t.requiredScope)
    }
  })
  it('清单无重名；静态序列化 ≤10KB（预算在源头可见）', () => {
    const names = ANALYST_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(JSON.stringify(ANALYST_TOOLS).length).toBeLessThanOrEqual(ANALYST_FACE_MAX_LIST_BYTES)
    expect(ANALYST_TOOLS.length).toBeLessThanOrEqual(ANALYST_FACE_MAX_TOOLS)
  })
})

describe('legacyMetricTools：可见指标 → sanitized 工具，撞名跳过', () => {
  const m1 = metric({ id: 'lemeng:retail:net_sales', title: '净销', description: 'd1' })
  it('可见指标生成 sanitized 工具名并保留 metricId 映射', () => {
    const out = legacyMetricTools([m1], requester(['data:query']), new Set(['lemeng']))
    expect(out).toHaveLength(1)
    expect(out[0].tool.name).toBe('lemeng__retail__net_sales')
    expect(out[0].metricId).toBe('lemeng:retail:net_sales')
  })
  it('指标 id 撞分析师面固定工具名 ⇒ 跳过该指标（fail-closed，不可冒名 query_metric）', () => {
    const evil = metric({ id: 'query_metric', title: 'E' })
    expect(legacyMetricTools([evil], requester(['data:query']), new Set())).toHaveLength(0)
  })
  it('两个指标 sanitize 后同名 ⇒ 只留第一个（词表序）', () => {
    const a = metric({ id: 'a:b', title: 'A' })
    const b = metric({ id: 'a__b', title: 'B' })
    const out = legacyMetricTools([a, b], requester(['data:query']), new Set())
    expect(out).toHaveLength(1)
    expect(out[0].metricId).toBe('a:b')
  })
  it('scope 不够/源未接入的指标不可见（复用 visibleMetrics，不自建判定）', () => {
    const gated = metric({ id: 'g:1', requiredScope: 'data:cost' })
    const foreign = { ...metric({ id: 'f:1' }), sourceSystem: 'other' } as MetricDef & { sourceSystem: string|null }
    expect(legacyMetricTools([gated], requester(['data:query']), new Set())).toHaveLength(0)
    expect(legacyMetricTools([foreign], requester(['data:query']), new Set(['lemeng']))).toHaveLength(0)
  })
})

describe('callTool：未知工具 / 空身份 / 单点审计（拒绝也写）', () => {
  const baseDeps = (pool: unknown): ToolboxDeps => ({
    pool: pool as never, org: 'acme',
    requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1, scopes: ['data:query'], hasScope: () => true },
    adoptedSources: new Set<string>(), wh: async () => ({ columns: [], rows: [] }),
  })
  const auditPool = () => {
    const sqls: string[] = []
    return { sqls, pool: { query: async (sql: string) => { sqls.push(sql); return { rows: [{ id: 7, created_at: new Date('2026-10-21T10:00:00Z') }] } } } }
  }

  it('未知工具 ⇒ denied/unknown_tool，且审计落一笔（拒绝也入审计）', async () => {
    const { sqls, pool } = auditPool()
    const out = await callTool(baseDeps(pool), 'no_such_tool', {})
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'unknown_tool' })
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('insert into data.query_audit')
  })

  it('空身份 ⇒ denied/unauthenticated；impl 不触、审计照写', async () => {
    const { sqls, pool } = auditPool()
    const deps = baseDeps(pool)
    deps.requester = null
    const out = await callTool(deps, 'data_agent_guide', {})
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'unauthenticated' })
    expect(sqls).toHaveLength(1)
  })
  // mutating 闸的代码分支在 callTool 内（Wave 1 无 mutating 工具，运行时分支空转）：
  // 静态面由 T12 门禁断言④（mutating ⇒ 注解+scope 必在）执法，运行时路径 Wave 3 提案面启用。
})

describe('mutatingAllowed（写开关，默认关）', () => {
  it('缺省/空/非 true ⇒ false；恰为 "true" ⇒ true', () => {
    expect(mutatingAllowed({})).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: '' })).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: 'TRUE' })).toBe(false)
    expect(mutatingAllowed({ DATA_MCP_ALLOW_MUTATING: 'true' })).toBe(true)
  })
})

describe('listAnalystTools：T1 阶段 impl 未注册，清单照出（清单是静态事实源）', () => {
  it('11 条与 ANALYST_TOOLS 同引用序', () => {
    expect(listAnalystTools()).toEqual(ANALYST_TOOLS)
  })
  it('registerImpl 未知工具名抛；已知名重复注册抛', () => {
    expect(() => registerImpl('nope', async () => ({ payload: {}, isError: false }))).toThrow()
    const impl = async () => ({ payload: {}, isError: false })
    registerImpl('data_agent_guide', impl)
    expect(() => registerImpl('data_agent_guide', impl)).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/registry.test.ts`
Expected: FAIL——`Cannot find module './registry'`

- [ ] **Step 3: 实现 registry.ts**

```ts
// registry.ts —— 分析师面**唯一工具事实源**（spec 2026-10-21 §3）。
//
// ★ 本文件是**纯**的：不得 import pool / env / Hono / 任何 workspace 包——
//   CI 门（scripts/check-mcp-toolface.mjs）与跨租户 e2e 要经 tsx 直接 import 本文件，
//   import 链上若混进运行时依赖，门禁就被迫另起一套「静态清单」= 第二事实源（必漂）。
//   impl 模块（guide/discovery/health/query）也不在这里 import——注册在 toolbox/all.ts
//   显式完成（避免「import registry 拉进 pg」的循环/传染）。
//
// 不变量：
//   · 工具面预算：分析师面 ≤14 工具、静态序列化 ≤10KB（常量在此，门禁断言同一来源）。
//   · 命名：MCP 2025-11-25 `[A-Za-z0-9_.-]`；指标 id 的 `:` → `__`（双向映射在 legacyMetricTools）。
//   · 权限：工具级 requiredScope 是**声明面**（data_harness_catalog 的输出 + 门禁断言④）；
//     Wave 1 的执法点是 /mcp 端点门卫（data:query）——本文件**不做第二份 scope 判定**
//     （决策 D1：授权核心单实现）。
//   · 审计：callTool 是 tools/call 的唯一分发点，**所有结局**（ok/denied/error）都写
//     data.query_audit（spec §8「拒绝/出错也写」）。
import type { Pool } from 'pg'
import type { MetricParamDef, Requester, SourceTaggedMetric } from '../authz'
import { visibleMetrics } from '../authz'
import type { SqlExecutor } from '../query-service'
// 审计写侧：T1 先用本文件内的 writeCallAudit（列清单与 audit-store 对齐，含 tool 列；
// 本任务的两个 callTool 测试用假 pool，不会真打库，故列先于迁移存在没有运行时问题）。
// T5 给 writeAudit 加 tool 字段后，本文件**切换**到 writeAudit（单一写路径，见 Task 5 Step 3b）。

export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/
export const ANALYST_FACE_MAX_TOOLS = 14
export const ANALYST_FACE_MAX_LIST_BYTES = 10240
/** 抽样行上限（spec §5：sample_dimension_values 行数 ≤50；global constraints「抽样 ≤50 行」）。 */
export const SAMPLE_MAX_ROWS = 50
export const READ_SCOPE = 'data:read'
export const QUERY_SCOPE = 'data:query'

export interface ToolAnnotations { readOnlyHint: boolean }

export interface ToolMeta {
  name: string
  group: 'guide' | 'discovery' | 'query' | 'health'
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  /** 声明面（D1）：Wave 1 由端点门统一执法，此处不判定。 */
  requiredScope: string | null
  mutating: boolean
  annotations: ToolAnnotations
}

const readOnly = { readOnlyHint: true }
const obj = { type: 'object', properties: {}, required: [] }

/** 分析师面 11 个固定工具的静态清单（预算：11 ≤14；impl 分册，注册在 toolbox/all.ts）。 */
export const ANALYST_TOOLS: readonly ToolMeta[] = [
  {
    name: 'data_agent_guide', group: 'guide', title: '数据工作流指南',
    description: '返回数据问数工作流（七步）与硬约束（主体钉死/新鲜度脚注/截断语义），以及今天的日期。开始任何数据任务前先调它。',
    inputSchema: obj, outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'data_harness_catalog', group: 'guide', title: '工具清单',
    description: '列出本面全部工具（分组/scope/是否写）。与注册表逐条一致。',
    inputSchema: obj, outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'search_catalog', group: 'discovery', title: '搜索目录',
    description: '按关键词搜索可见指标（或数据集）。返回 id/标题/档位/归属/一句话说明，≤20 条。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（id/标题/说明的子串，大小写不敏感）' },
        kind: { type: 'string', enum: ['metric', 'dataset'], description: '缺省 = metric' },
        tier: { type: 'string', enum: ['certified', 'custom'], description: 'certified=平台口径(l1)，custom=本租户口径(l2)' },
      },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'describe_metric', group: 'discovery', title: '指标详情',
    description: '按 id 取指标详情：口径定义/粒度维度/参数/归属/档位/版本/新鲜度/上游。查数前必调（拿参数键名与维度）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '指标 id（取自 search_catalog 或 list）' } },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'describe_dataset', group: 'discovery', title: '数据集详情',
    description: '按 `schema.table` 取数据集的列/类型/归属/新鲜度。只见平台暴露的关系。',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string', description: '关系名（如 marts.fct_retail_sale）' } },
      required: ['dataset'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'sample_dimension_values', group: 'discovery', title: '维度值抽样',
    description: '取某指标某维度的取值与频次（≤50 行），用于确认过滤值的确切写法（如门店名）。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        dimension: { type: 'string', description: '维度名（须是该指标粒度维度之一）' },
        q: { type: 'string', description: '子串过滤（LIKE 包裹，转义通配）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 50' },
      },
      required: ['metricId', 'dimension'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'preview_query', group: 'query', title: '预览查询计划',
    description: '按指标+切片参数生成将执行的 SQL 与行数上限——只编译不执行（0 次仓库查询）。核对口径/过滤用。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        args: { type: 'object', description: '指标声明参数（键名以 describe_metric 为准）' },
        slicing: { type: 'object', description: '{dimensions?,filters?,orderBy?,limit?,total?}' },
      },
      required: ['metricId'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'query_metric', group: 'query', title: '受治理查询',
    description: '按指标 id 查数，回完整信任信封（口径版本/主体/数据截止/行集/审计 id）。主体由平台钉死；切片维度超出粒度即拒；行上限 1000。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        args: { type: 'object' },
        dimensions: { type: 'array', items: { type: 'string' }, description: '聚合维度（⊆ 指标粒度；缺省 = 粒度明细）' },
        filters: { type: 'object', description: '已声明参数或维度的等值/IN 过滤' },
        orderBy: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] } },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        total: { type: 'boolean', description: '切片时显式 true 才回 total（部分合计≠全局合计）' },
      },
      required: ['metricId'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_freshness', group: 'health', title: '新鲜度',
    description: '数据截止日/物化时刻/滞后秒。scope=指标 id 时回该指标链路水位与状态；缺省回全局水位。判据与发布面对齐表同源。',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: '指标 id（缺省 = 全局）' } },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_quality', group: 'health', title: '质量结论',
    description: 'dbt tests/对账的最近结论。无结论源时**显式返回 unknown**——未知 ≠ 通过。',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'dbt 模型名（缺省 = 全部已声明）' } },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_lineage', group: 'health', title: '血缘',
    description: '有界上下游（depth≤3）。血缘源不可用时显式 unknown。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'dbt 模型名或数据集名' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: '缺省 1' },
      },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
]

export function listAnalystTools(): readonly ToolMeta[] {
  return ANALYST_TOOLS
}

export function analystToolNames(): string[] {
  return ANALYST_TOOLS.map((t) => t.name)
}

/** 工具名清洗（spec §8：冒号 → __，其余非法字符 → _）。空串抛（没有「无名工具」）。 */
export function sanitizeToolName(id: string): string {
  const out = id.replaceAll(':', '__').replace(/[^\w.-]/g, '_')
  if (out === '' || !TOOL_NAME_RE.test(out)) throw new Error(`sanitizeToolName: '${id}' → '${out}' 不是合法工具名`)
  return out
}

/** 写开关（spec §8 `allow-mutating` 默认 false；与 DataY 默认相反）。恰为字面量 "true" 才开。 */
export function mutatingAllowed(env: Record<string, string | undefined>): boolean {
  return env.DATA_MCP_ALLOW_MUTATING === 'true'
}

// ── impl 注册表（all.ts 显式注册；本文件不 import impl 模块）────────────────────────────
const impls = new Map<string, ToolImpl>()

export interface ToolImplResult {
  /** MCP structuredContent 原体（信封或可解释错误体）。 */
  payload: Record<string, unknown>
  isError: boolean
  /** 审计的 metric_id（缺省 ''：非指标工具）。 */
  auditMetricId?: string
  /** 审计 row_count（缺省 null：没行数可记；0 与 null 语义不同，别 `?? 0`）。 */
  auditRowCount?: number | null
}
export type ToolImpl = (deps: ToolboxDeps, args: Record<string, unknown>) => Promise<ToolImplResult>

/** impl 注册：未知名（不在 ANALYST_TOOLS）或重复注册即抛（装载期暴露，不静默）。 */
export function registerImpl(name: string, impl: ToolImpl): void {
  if (!ANALYST_TOOLS.some((t) => t.name === name)) throw new Error(`registerImpl: 未知工具 '${name}'（须先在 ANALYST_TOOLS 声明）`)
  if (impls.has(name)) throw new Error(`registerImpl: '${name}' 重复注册`)
  impls.set(name, impl)
}

export interface ToolboxDeps {
  /** 平台库（词表/审计）。 */
  pool: Pool
  /** 隔离键（text）= 租户 Casdoor org——与 /query 同口径。 */
  org: string
  requester: Requester | null
  /** 宿主投影「本租户已接入源」。缺省语义由消费方 `?? []` 显式 fail-closed。 */
  adoptedSources: ReadonlySet<string>
  /** 仓库执行器（分析师面 = 只读池；测试注入假执行器）。 */
  wh: SqlExecutor
  /** 写开关（缺省 false=关）。 */
  allowMutating?: boolean
  /** 血缘/质量 seam（缺省 = health.ts 的 defaultDbtManifest 读 env 路径；测试注入）。 */
  dbtManifest?: () => Promise<unknown>
  /** 时钟（测试注入）。 */
  now?: () => Date
}

/**
 * tools/call 的**唯一**分发点。顺序（fail-closed 链）：
 *   未知工具 → 空身份 → mutating 闸 → 执行 → （impl 抛 = error）。
 * 每个结局都写审计（verdict=ok|denied|error，tool 恒写，metric_id 取 impl 或 ''）。
 */
export async function callTool(deps: ToolboxDeps, name: string, args: Record<string, unknown>): Promise<ToolImplResult> {
  const meta = ANALYST_TOOLS.find((t) => t.name === name)
  const finish = async (
    base: ToolImplResult, verdict: 'ok' | 'denied' | 'error', reason: string,
  ): Promise<ToolImplResult> => {
    await writeCallAudit(deps, args, {
      tool: name, metricId: base.auditMetricId ?? '', rowCount: base.auditRowCount ?? null,
      verdict, reason: reason === '' ? null : reason,
    })
    return base
  }
  if (!meta) {
    return finish({ payload: { status: 'denied', reason: 'unknown_tool', name }, isError: true }, 'denied', 'unknown_tool')
  }
  if (deps.requester === null) {
    return finish({ payload: { status: 'denied', reason: 'unauthenticated' }, isError: true }, 'denied', 'unauthenticated')
  }
  if (meta.mutating && deps.allowMutating !== true) {
    return finish(
      { payload: { status: 'denied', reason: 'mutating_disabled', name }, isError: true },
      'denied', 'mutating_disabled',
    )
  }
  const impl = impls.get(name)
  if (!impl) {
    return finish({ payload: { status: 'error', reason: 'impl_missing', name }, isError: true }, 'error', 'impl_missing')
  }
  try {
    const out = await impl(deps, args)
    return await finish(out, out.isError ? 'denied' : 'ok', out.isError ? String(out.payload.reason ?? 'tool_error') : '')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return await finish(
      { payload: { status: 'error', reason: 'tool_exception', detail }, isError: true },
      'error', detail.slice(0, 200),
    )
  }
}

/** 审计写侧（过渡形态：T5 给 writeAudit 加 tool 后切换过去——见 Task 5 Step 3b，参数语义不变）。 */
async function writeCallAudit(
  deps: ToolboxDeps,
  callArgs: Record<string, unknown>,
  e: { tool: string; metricId: string; rowCount: number | null; verdict: 'ok' | 'denied' | 'error'; reason: string | null },
): Promise<void> {
  await deps.pool.query(
    `insert into data.query_audit
       (org, user_id, channel, key_id, metric_id, params, row_count, verdict, reason, masking, tool)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)`,
    [
      deps.org, deps.requester?.userId ?? '(anonymous)', deps.requester?.channel ?? 'session',
      deps.requester?.keyId ?? null, e.metricId, JSON.stringify(callArgs), e.rowCount,
      e.verdict, e.reason, e.tool,
    ],
  )
}

// ── legacy 读面（每指标一工具）的命名与投影 ────────────────────────────────────────────
/** 指标参数 → JSON-Schema 属性（type 不透传：date/date_range 不是合法 JSON-Schema type）。 */
function paramSchema(p: MetricParamDef): Record<string, unknown> {
  if (p.type === 'date') return { type: 'string', description: '' }
  if (p.type === 'date_range') {
    return {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      description: '闭区间 YYYY-MM-DD',
    }
  }
  return { type: p.type, description: '' }
}

/**
 * 可见指标 → legacy 工具（sanitized 名 + readOnly 注解）。
 * 裁剪只走 `visibleMetrics`（授权核心单实现，此处不自建判定）。
 * 撞名跳过（fail-closed）：与分析师面固定工具同名、或两指标 sanitize 后同名的，**后面的丢**——
 * 被跳过的指标仍可经 `query_metric` 查，但绝不冒名成另一个工具。
 */
export function legacyMetricTools<T extends SourceTaggedMetric>(
  catalog: readonly T[], requester: Requester, adoptedSources: ReadonlySet<string>,
): { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] {
  const fixedNames = new Set(ANALYST_TOOLS.map((t) => t.name))
  const taken = new Set<string>(fixedNames)
  const out: { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] = []
  for (const m of visibleMetrics(catalog, requester, adoptedSources)) {
    const name = sanitizeToolName(m.id)
    if (taken.has(name)) continue
    taken.add(name)
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [pname, p] of Object.entries(m.params)) {
      properties[pname] = paramSchema(p)
      if (p.required) required.push(pname)
    }
    out.push({
      tool: {
        name,
        description: m.description || m.title,
        inputSchema: { type: 'object', properties, required },
        annotations: readOnly,
      },
      metricId: m.id,
    })
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/registry.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/registry.ts modules/data/domain/toolbox/registry.test.ts .env.example
git commit -m "feat(data): 分析师面 registry——静态工具清单/命名清洗/callTool 单点审计 (#<ISSUE>)"
```

> `.env.example` 追加（B9 门禁要求代码引用的 env 键先声明）：
> ```
> # 数据面 MCP 写开关（分析师面 mutating 工具；Wave 1 全只读，Wave 3 提案面受它管）。缺省 false=关。
> DATA_MCP_ALLOW_MUTATING=
> ```

---

### Task 2: envelope.ts —— 信任信封（纯函数 + JSON Schema，缺字段可辨）

**Files:**
- Create: `modules/data/domain/toolbox/envelope.ts`
- Create: `modules/data/domain/toolbox/envelope.test.ts`

**Interfaces:**
- Consumes: 无（纯）。
- Produces:
  - `ENVELOPE_SCHEMA: Record<string, unknown>`（spec §4 的信封 JSON Schema；`query_metric` 的 outputSchema 底座）
  - `interface EnvelopeInput { status?: 'ok'; metric?: Record<string, unknown>; subject?: Record<string, unknown>; asOf?: Record<string, unknown>; query?: Record<string, unknown>; result?: Record<string, unknown>; lineage?: Record<string, unknown>; audit?: Record<string, unknown> }`
  - `buildEnvelope(input: EnvelopeInput): Record<string, unknown>`——只保留**有值**的 section（undefined/缺省键不出现在输出 = 「缺 = 工具未升级，可辨」）；`status` 缺省 `'ok'`；强制 `status` 在首位键序（稳定性利于快照测试）。

- [ ] **Step 1: 写失败测试**

```ts
// envelope.test.ts — 信封构造：缺字段可辨（缺席 ≠ 空对象），键序稳定。
import { describe, expect, it } from 'vitest'
import { buildEnvelope, ENVELOPE_SCHEMA } from './envelope'

describe('buildEnvelope', () => {
  it('只带有值的 section；status 缺省 ok 且居首', () => {
    const env = buildEnvelope({
      metric: { id: 'm:1', version: 3 },
      audit: { id: 42, ts: '2026-10-21T18:00:00+08:00' },
    })
    expect(Object.keys(env)[0]).toBe('status')
    expect(env.status).toBe('ok')
    expect(env.metric).toEqual({ id: 'm:1', version: 3 })
    expect('subject' in env).toBe(false)
    expect('asOf' in env).toBe(false)
    expect('result' in env).toBe(false)
  })
  it('全部 section 在场时形状与 spec §4 对齐（键集合恰好）', () => {
    const env = buildEnvelope({
      metric: {}, subject: {}, asOf: {}, query: {}, result: {}, lineage: {}, audit: {},
    })
    expect(Object.keys(env)).toEqual(['status', 'metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit'])
  })
  it('ENVELOPE_SCHEMA 是 object 类型且 properties 覆盖七 section', () => {
    expect((ENVELOPE_SCHEMA as { type: string }).type).toBe('object')
    for (const k of ['metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit']) {
      expect((ENVELOPE_SCHEMA as { properties: Record<string, unknown> }).properties[k]).toBeDefined()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/envelope.test.ts`
Expected: FAIL——`Cannot find module './envelope'`

- [ ] **Step 3: 实现**

```ts
// envelope.ts —— 信任信封（spec 2026-10-21 §4）：所有数值工具回包的外层。
// 纯函数：缺 section 就**缺席**（缺席 = 工具未升级，可辨；模型不得脑补）——
// 不做 `{}` 占位，不做默认值编造。
export interface EnvelopeInput {
  status?: 'ok'
  metric?: Record<string, unknown>
  subject?: Record<string, unknown>
  asOf?: Record<string, unknown>
  query?: Record<string, unknown>
  result?: Record<string, unknown>
  lineage?: Record<string, unknown>
  audit?: Record<string, unknown>
}

const SECTION_ORDER = ['metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit'] as const

export function buildEnvelope(input: EnvelopeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { status: input.status ?? 'ok' }
  for (const key of SECTION_ORDER) {
    const v = input[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

export const ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    metric: { type: 'object', description: 'id/version/definitionHash/tier/owner/title' },
    subject: { type: 'object', description: 'org/source/adoptedSources——主体钉死的回声' },
    asOf: { type: 'object', description: 'dataThrough/freshnessLagSeconds/lastDbtRun/tests' },
    query: { type: 'object', description: 'sql/params/dimensions/rowLimit/queryId' },
    result: { type: 'object', description: 'columns/rows/rowCount/truncated/total?' },
    lineage: { type: 'object', description: 'model/upstream（源缺席时本节缺席）' },
    audit: { type: 'object', description: 'id/ts——可独立核对 data.query_audit' },
  },
  required: ['status'],
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/envelope.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/envelope.ts modules/data/domain/toolbox/envelope.test.ts
git commit -m "feat(data): 信任信封 buildEnvelope——缺字段可辨的回包外层 (#<ISSUE>)"
```

---

### Task 3: authz.ts 切片化 —— authorize 增 slicing + buildSlicedPlan（授权核心唯一扩展点）

**Files:**
- Modify: `modules/data/domain/authz.ts`
- Modify: `modules/data/domain/authz.test.ts`（追加 describe 段；**既有用例一字不改且必须全绿**）

**Interfaces:**
- Consumes: 现有 `authorize(catalog, requester, metricId, args, maskCatalog)`（签名不变，第 6 参可选）；`dimensionNamesOf` 语义（groupBy 逗号拆分——为保持 authz 纯依赖，**本文件自实现** `grainDimsOf(metric)`，不 import semantic-compiler）。
- Produces:
  - `interface SliceOrderBy { column: string; dir?: 'asc' | 'desc' }`
  - `interface SlicingSpec { dimensions?: string[]; filters?: Record<string, unknown>; orderBy?: SliceOrderBy[]; limit?: number; total?: boolean }`
  - `authorize(catalog, requester, metricId, args, maskCatalog, slicing?: SlicingSpec)`——`slicing` 缺省时输出与现状**逐字节一致**（既有测试是回归锁）。
  - `authorizeCore(catalog, requester, metricId, args, maskCatalog): { ok: true; inner: string; subject: string; metric: MetricDef; applied; exempted } | { ok: false; reason; metricId; detail? }`——内层 `whereAndGroup` 的唯一出口（T8 的 `sample_dimension_values` 用它包 distinct 计数；**与 authorize 共享同一段代码**）。
  - 切片语义（全部 fail-closed，拒因走 `bad_param` + detail）：
    - `dimensions` 每项 ∈ `grainDimsOf(metric)`，去重保请求序；缺失/未知 ⇒ `unknown_dimension:<d>`
    - 全集（与 grain 成员相同）= 明细形态（内层 + ORDER BY + LIMIT）；真子集 = 外层再聚合 `SELECT <dims>, sum(value) AS value FROM ( <inner> ) t GROUP BY <dims>`，**要求 `metric.totalable === true`**（不可加指标切片聚合 = 错数）否则 `slicing_not_additive`
    - `dimensions: []`（空数组）= 单行合计形态（同显式 total，需 totalable）
    - `filters` 键 = 已声明参数（按类型走既有 literal 校验）**或** grain 维度（等值 / 字符串数组 IN；空数组 IN 拒 `empty_in_filter`）；保留键检查覆盖 `args` ∪ `filters`
    - `orderBy` 列 ∈ 所选维度集（明细形态 = grain），dir ∈ asc|desc（缺省 desc）；越界 `unknown_order_column:<c>`
    - `limit = min(请求, MAX_QUERY_ROWS)`，须正整数否则 `invalid_limit`
    - `total`：仅在未切片（dimensions 缺省）或 `slicing.total === true` 时附 `totalSql`；切片后缺省**不带** total（部分合计≠全局合计，缺省即「未请求」）

- [ ] **Step 1: 写失败测试**（`authz.test.ts` 追加；夹具沿用本文件已有的 METRIC 构造器风格）

```ts
// authz.test.ts 追加 —— 切片化（spec 2026-10-21 §5「query_metric 切片化」）。
describe('authorize slicing：切片计划（授权核心唯一扩展点）', () => {
  const totalable = (): MetricDef => ({
    id: 'm', title: 'M', description: '', requiredScope: null, subjectColumn: 'org',
    selectSql: "select org, branch_name, bizday, sum(v) as value from fct group by org, branch_name, bizday",
    groupBy: 'org, branch_name, bizday',
    params: { day_from: { column: 'bizday', type: 'date', required: false } },
    totalable: true,
  })
  const req = (): Requester => ({ userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true })

  it('slicing 缺省 ⇒ SQL 与现状逐字节一致（含 ORDER BY bizday DESC LIMIT 1000）', () => {
    const r = authorize([totalable()], req(), 'm', {}, [totalable()])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.sql).toContain('ORDER BY bizday DESC')
      expect(r.plan.sql.endsWith('LIMIT 1000')).toBe(true)
    }
  })

  it('真子集 ⇒ 外层再聚合；GROUP BY 只含所选维度', () => {
    const r = authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: ['org'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.sql).toMatch(/^select org, sum\(value\) as value from \( .*\) t group by org/i)
      expect(r.plan.sql).toContain("WHERE org = 'acme'")
      expect(r.plan.sql).toContain('LIMIT 1000')
      expect(r.plan.totalSql).toBeUndefined()  // 切片后缺省不带 total（部分合计≠全局）
    }
  })

  it('dimensions=[] ⇒ 单行合计形态（需 totalable）', () => {
    const r = authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: [] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.sql).toMatch(/^select sum\(value\) as total from \( .*\) t$/i)
  })

  it('不可加指标做真子集切片 ⇒ 拒 slicing_not_additive', () => {
    const notAdditive = { ...totalable(), totalable: false }
    const r = authorize([notAdditive], req(), 'm', {}, [notAdditive], { dimensions: ['org'] })
    expect(r).toMatchObject({ ok: false, reason: 'bad_param', detail: 'slicing_not_additive' })
  })

  it('未知维度 / 空数组 IN / 非法 limit / 越界排序列 各自显式拒', () => {
    expect(authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: ['nope'] }))
      .toMatchObject({ ok: false, detail: 'unknown_dimension:nope' })
    expect(authorize([totalable()], req(), 'm', {}, [totalable()], { filters: { branch_name: [] } }))
      .toMatchObject({ ok: false, detail: 'empty_in_filter:branch_name' })
    expect(authorize([totalable()], req(), 'm', {}, [totalable()], { limit: 0 }))
      .toMatchObject({ ok: false, detail: 'invalid_limit' })
    expect(authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: ['org'], orderBy: [{ column: 'bizday' }] }))
      .toMatchObject({ ok: false, detail: 'unknown_order_column:bizday' })
  })

  it('filters 走声明参数与维度两条路；保留键在 filters 里也拒', () => {
    const r = authorize([totalable()], req(), 'm', { day_from: '2026-10-01' }, [totalable()],
      { dimensions: ['org'], filters: { branch_name: ['A店', "B'店"], org: 'someone-else' } })
    expect(r).toMatchObject({ ok: false, reason: 'subject_pinned_by_platform' })
    const okR = authorize([totalable()], req(), 'm', { day_from: '2026-10-01' }, [totalable()],
      { dimensions: ['org'], filters: { branch_name: ['A店', "B'店"] } })
    expect(okR.ok).toBe(true)
    if (okR.ok) {
      expect(okR.plan.sql).toContain("bizday = '2026-10-01'::date")
      expect(okR.plan.sql).toContain("branch_name in ('A店', 'B''店')")
    }
  })

  it('total=true 时切片也回 totalSql（过滤范围的部分合计）；limit=min(请求,1000)', () => {
    const r = authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: ['org'], total: true, limit: 99999 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.totalSql).toContain('sum(value) as total')
      expect(r.plan.sql).toContain('LIMIT 1000')  // min(99999, 1000) 生效
    }
  })

  it('★ 变异确认：把 buildSlicedPlan 的外层聚合改读 whereAndGroup 之外 ⇒ 子集测试必红（判定真在切片路径上）', () => {
    // 该条不是产品断言，是防假绿锚：切片 SQL 必须含外层 `from (`（包住内层），
    // 若实现把内层丢了（直接 group by 原表）则 like 断言红。
    const r = authorize([totalable()], req(), 'm', {}, [totalable()], { dimensions: ['org'] })
    expect(r.ok && r.plan.sql.includes(' from ( ')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/authz.test.ts`
Expected: 追加段 FAIL——`authorize` 第 6 参不存在（TS 报错）/ `slicing_not_additive` 缺失；**既有段 PASS**

- [ ] **Step 3: 实现**（`authz.ts`；★ 重构铁律：`whereAndGroup` 的组装代码**保持原样**， authorize 内部改为「authorizeCore 产出 inner → buildSlicedPlan 组装」；既有字符串输出逐字节不变）

```ts
// ── 切片化（spec 2026-10-21 §5）——授权核心的唯一扩展点 ─────────────────────────────
export interface SliceOrderBy { column: string; dir?: 'asc' | 'desc' }
export interface SlicingSpec {
  dimensions?: string[]
  filters?: Record<string, unknown>
  orderBy?: SliceOrderBy[]
  limit?: number
  total?: boolean
}

/** 粒度维度（与 semantic-compiler 的 dimensionNamesOf 同义；authz 零内依赖故自实现）。 */
function grainDimsOf(metric: MetricDef): string[] {
  return metric.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== '')
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 切片 filters 的**前置校验 + 字面量渲染**（authorize 里调，产物交给 authorizeCore 拼进 WHERE）。
 *  维度过滤与声明参数过滤落在**同一段** whereAndGroup 里（spec：filters = 已声明参数 + 维度等值/IN），
 *  故必须在 authorizeCore 组装 filters 数组时追加（extraFilters），而不是事后拼字符串——
 *  GROUP BY 在 inner 尾部，事后追加会拼到 GROUP BY 之后（SQL 语法错）。 */
function sliceFilterFragments(
  metric: MetricDef, slicing: SlicingSpec,
): { ok: true; fragments: string[] } | { ok: false; detail: string } {
  const grain = grainDimsOf(metric)
  const fragments: string[] = []
  for (const [key, value] of Object.entries(slicing.filters ?? {})) {
    if (metric.params[key] !== undefined) continue          // 声明参数：authorizeCore 的既有循环处理
    if (!grain.includes(key) || !IDENT_RE.test(key)) return { ok: false, detail: `unknown_dimension:${key}` }
    if (Array.isArray(value)) {
      if (value.length === 0) return { ok: false, detail: `empty_in_filter:${key}` }
      const lits = value.map((v) => (typeof v === 'string' ? sqlQuote(v) : null))
      if (lits.some((l) => l === null)) return { ok: false, detail: `invalid_value:${key}` }
      fragments.push(` AND ${key} in (${lits.join(', ')})`)
    } else if (typeof value === 'string') {
      fragments.push(` AND ${key} = ${sqlQuote(value)}`)
    } else {
      return { ok: false, detail: `invalid_value:${key}` }
    }
  }
  return { ok: true, fragments }
}

/**
 * authorize 的**内核**：声明/scope/保留键/参数校验 + 内层 whereAndGroup（掩码展开后）。
 * 实现 = 现 authorize 函数体**逐字搬入**，仅两处差异：
 *   ① 保留键检查的键集 = 调用方合并后的 args（切片 filters 已并入——见 authorize）；
 *   ② 函数末尾不再组装 detail sql，改为返回组装材料：
 *      `{ ok: true, inner: whereAndGroup, subject, metric, applied, exempted, wantTotal }`。
 *   `extraFilters` = 切片维度过滤的已渲染片段（sliceFilterFragments 产物），在既有
 *   `filters.push(...)` 循环之后、`filters.join('')` 之前 `push(...extraFilters)`——
 *   与声明参数同一位置拼装（主体钉死那行不变：`WHERE subjectColumn = subject`）。
 */
export function authorizeCore(
  catalog: MetricDef[], requester: Requester, metricId: string,
  args: Record<string, unknown>, maskCatalog: MetricDef[], extraFilters: string[],
): { ok: true; inner: string; subject: string; metric: MetricDef; applied: Record<string, string>; exempted: string[]; wantTotal: boolean }
  | { ok: false; reason: DenyReason; metricId: string; detail?: string } {
  /* ……现 authorize 304–361 行逐字搬入；末尾改为：
     return { ok: true, inner: whereAndGroup, subject, metric,
              applied: masked.applied, exempted: masked.exempted, wantTotal } */
}

/**
 * SQL 组装**单函数**（spec：切片 SQL 只在这一处组装；三形态共用同一 inner——
 * 主体值只存在于 inner 那段 WHERE，本函数不引入任何第二主体来源）。
 */
function buildSlicedPlan(p: {
  metric: MetricDef; inner: string; slicing: SlicingSpec | undefined; wantTotal: boolean
}): { sql: string; totalSql?: string } {
  const { metric, inner, slicing, wantTotal } = p
  const dims = grainDimsOf(metric)
  const limit = slicing?.limit === undefined ? MAX_QUERY_ROWS : Math.min(slicing.limit, MAX_QUERY_ROWS)
  const selDims = slicing?.dimensions === undefined ? null : [...new Set(slicing.dimensions)]
  const isFullSet = selDims === null || (selDims.length === dims.length && dims.every((d) => selDims.includes(d)))

  if (isFullSet) {
    if (wantTotal || (selDims !== null && selDims.length === 0)) {
      // 显式合计 / dimensions=[]：无外层 LIMIT（合计必须作用于全量匹配行——截断求和=错数）
      return { sql: `SELECT sum(value) AS total FROM ( ${inner} ) t` }
    }
    // 明细形态（dimensions 缺省）：与现状**逐字节一致**（含 ORDER BY bizday DESC）
    const ob = slicing?.orderBy
    const detailOrder = ob !== undefined && ob.length > 0
      ? ` ORDER BY ${ob.map((o) => `${o.column} ${o.dir === 'asc' ? 'asc' : 'desc'}`).join(', ')}`
      : (/\bbizday\b/.test(metric.groupBy) ? ' ORDER BY bizday DESC' : '')
    const sql = `${inner}${detailOrder} LIMIT ${limit}`
    // 自动合计仅「未切片」（slicing === undefined = 现状行为）；
    // 切片形态只在显式 total=true 时给 totalSql（部分合计≠全局合计，缺省即「未请求」）。
    const totalSql = !wantTotal && metric.totalable === true && (slicing === undefined || slicing.total === true)
      ? `SELECT sum(value) AS total FROM ( ${inner} ) t`
      : undefined
    return { sql, ...(totalSql !== undefined ? { totalSql } : {}) }
  }
  // 真子集 = 外层再聚合（掩码先于聚合：掩码已在内层列引用处展开）
  return {
    sql: `select ${selDims.join(', ')}, sum(value) as value from ( ${inner} ) t group by ${selDims.join(', ')} LIMIT ${limit}`,
  }
}

/**
 * 授权 + 出计划（对外签名不变，第 6 参可选）。拒绝链顺序照原型：
 * 未声明 → 未授权 → 保留键（args ∪ slicing.filters）→ 切片形状 → 参数/内核。
 */
export function authorize(
  catalog: MetricDef[], requester: Requester, metricId: string,
  args: Record<string, unknown>, maskCatalog: MetricDef[], slicing?: SlicingSpec,
): AuthzResult {
  const metric = catalog.find((m) => m.id === metricId)
  if (!metric) return { ok: false, reason: 'metric_not_declared', metricId }
  if (metric.requiredScope !== null && !requester.hasScope(metric.requiredScope)) {
    return { ok: false, reason: 'metric_not_authorized', metricId }
  }
  const mergedArgs = slicing === undefined ? args : { ...args, ...(slicing.filters ?? {}) }
  if (slicing !== undefined) {
    for (const key of Object.keys(mergedArgs)) {
      if ((SUBJECT_RESERVED_KEYS as readonly string[]).includes(key)) {
        return { ok: false, reason: 'subject_pinned_by_platform', metricId }
      }
    }
    const grain = grainDimsOf(metric)
    if (slicing.dimensions !== undefined) {
      for (const d of slicing.dimensions) {
        if (!grain.includes(d) || !IDENT_RE.test(d)) {
          return { ok: false, reason: 'bad_param', metricId, detail: `unknown_dimension:${d}` }
        }
      }
      const sel = [...new Set(slicing.dimensions)]
      if ((sel.length === 0 || sel.length < grain.length) && metric.totalable !== true) {
        return { ok: false, reason: 'bad_param', metricId, detail: 'slicing_not_additive' }
      }
    }
    const orderScope = slicing.dimensions !== undefined
      ? (slicing.dimensions.length === 0 ? grain : [...new Set(slicing.dimensions)])
      : grain
    for (const o of slicing.orderBy ?? []) {
      if (!orderScope.includes(o.column) || !IDENT_RE.test(o.column)) {
        return { ok: false, reason: 'bad_param', metricId, detail: `unknown_order_column:${o.column}` }
      }
      if (o.dir !== undefined && o.dir !== 'asc' && o.dir !== 'desc') {
        return { ok: false, reason: 'bad_param', metricId, detail: `invalid_order_dir:${o.column}` }
      }
    }
    if (slicing.limit !== undefined && (typeof slicing.limit !== 'number' || !Number.isInteger(slicing.limit) || slicing.limit <= 0)) {
      return { ok: false, reason: 'bad_param', metricId, detail: 'invalid_limit' }
    }
    const fragments = sliceFilterFragments(metric, slicing)
    if (!fragments.ok) return { ok: false, reason: 'bad_param', metricId, detail: fragments.detail }
    const core = authorizeCore(catalog, requester, metricId, mergedArgs, maskCatalog, fragments.fragments)
    if (!core.ok) return core
    return {
      ok: true,
      plan: {
        ...buildSlicedPlan({ metric, inner: core.inner, slicing, wantTotal: core.wantTotal }),
        metricId, subject: core.subject, total: core.wantTotal,
        applied: core.applied, exempted: core.exempted,
      },
    }
  }
  // slicing 缺省：与现状同一条路径（buildSlicedPlan 对 undefined 的输出 = 旧三段逐字节）
  const core = authorizeCore(catalog, requester, metricId, args, maskCatalog, [])
  if (!core.ok) return core
  return {
    ok: true,
    plan: {
      ...buildSlicedPlan({ metric, inner: core.inner, slicing: undefined, wantTotal: core.wantTotal }),
      metricId, subject: core.subject, total: core.wantTotal,
      applied: core.applied, exempted: core.exempted,
    },
  }
}
```

> 实现注记：
> 1. `authorizeCore` 搬运时**保留**既有注释与拒绝链顺序（未声明 → 未授权 → 保留键 → 参数 → required → subject → 掩码 → whereAndGroup）；「detail sql 组装段」（detailOrder/sql/totalSql 三段）整体移入 `buildSlicedPlan`。
> 2. `buildSlicedPlan` 对 `slicing === undefined` 的输出必须与搬出前逐字节相同——这是既有 authz.test.ts 全绿的判据；任何一条旧用例红 = 输出漂了，修实现而不是改测试。
> 3. plan 形状不变：`{ sql, metricId, subject, total, totalSql?, applied, exempted }`——slicing 只影响 sql/totalSql 内容，消费方（query-service 等）零改动。
> 4. 大小写按测试逐字：既有总计形态大写 `SELECT sum(value) AS total`；切片子集形态小写 `select … sum(value) as value`（新增，勿混）。

- [ ] **Step 4: 跑测试确认通过（既有段是回归锁）**

Run: `pnpm --filter data exec vitest run domain/authz.test.ts && pnpm --filter data typecheck`
Expected: PASS（既有用例 + 追加段全绿；既有用例有任何一条红 = 重构改变了现状输出，**必须修到逐字节一致**而不是改测试）

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/authz.ts modules/data/domain/authz.test.ts
git commit -m "feat(data): authorize 切片化——buildSlicedPlan 单函数组装，主体钉死共享同段代码 (#<ISSUE>)"
```

---

### Task 4: warehouse.ts 只读池 —— analystPool()

**Files:**
- Modify: `modules/data/domain/warehouse.ts`
- Modify: `modules/data/domain/warehouse.test.ts`（追加 describePg 段）

**Interfaces:**
- Consumes: 现有 `DATA_WAREHOUSE_UNCONFIGURED` / `STATEMENT_TIMEOUT_MS` / `Pool`。
- Produces:
  - `analystPool(env?: Record<string, string|undefined>): Pool`——独立单例；`default_transaction_read_only=on` 经 `pool.on('connect')` 会话级施加；未配 `DATA_WAREHOUSE_URL` 抛 `DATA_WAREHOUSE_UNCONFIGURED`（与写池同 fail 形）。
  - `resetAnalystPool(): void`（测试钩子，与 `resetWarehousePool` 对称）。
  - ⚠️ 写池 `warehousePool()` 与既有行为**零变化**。

- [ ] **Step 1: 写失败测试**（`warehouse.test.ts` 追加；沿用本文件 describePg 模式）

```ts
// warehouse.test.ts 追加 —— 分析师只读池（spec：default_transaction_read_only=on）。
const describePg = process.env.DATABASE_URL ? describe : describe.skip

describePg('analystPool：会话强制只读（需要 DATABASE_URL）', () => {
  it('show default_transaction_read_only ⇒ on；写操作 ⇒ 报 read-only', async () => {
    const { analystPool, resetAnalystPool } = await import('./warehouse')
    resetAnalystPool()
    const pool = analystPool({ DATA_WAREHOUSE_URL: process.env.DATABASE_URL! })
    try {
      const r = await pool.query('show default_transaction_read_only')
      expect(r.rows[0].default_transaction_read_only).toBe('on')
      await expect(
        pool.query('create table data.__analyst_rw_probe (id int)'),
      ).rejects.toThrow(/read-only/i)
    } finally {
      resetAnalystPool()
      await pool.end().catch(() => {})
    }
  })
  it('未配 URL ⇒ 抛 DATA_WAREHOUSE_UNCONFIGURED；单例（两次取同一实例）', async () => {
    const { analystPool, DATA_WAREHOUSE_UNCONFIGURED, resetAnalystPool } = await import('./warehouse')
    resetAnalystPool()
    expect(() => analystPool({})).toThrow(DATA_WAREHOUSE_UNCONFIGURED)
    const a = analystPool({ DATA_WAREHOUSE_URL: process.env.DATABASE_URL! })
    const b = analystPool({ DATA_WAREHOUSE_URL: process.env.DATABASE_URL! })
    expect(a).toBe(b)
    resetAnalystPool()
    await a.end().catch(() => {})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/warehouse.test.ts`
Expected: FAIL——`analystPool is not a function`（无 DATABASE_URL 时该段 skip，须在有库环境跑一次）

- [ ] **Step 3: 实现**（`warehouse.ts` 追加）

```ts
// ── 分析师只读池（spec 2026-10-21 §8：分析师面 warehouse 连接强制只读）─────────────────
// 与写池同一份 DATA_WAREHOUSE_URL、同一个部署——差别只在**会话**：每条新连接先
// `set default_transaction_read_only = on`。写池不动（dbt 物化继续走 warehousePool()），
// 分析师面（toolbox）的主计划与辅助读全走这里 ⇒ 「持 data:query 的连接对湖写必失败」。
let analystSingleton: Pool | null = null

export function analystPool(env: Record<string, string | undefined> = process.env): Pool {
  if (analystSingleton) return analystSingleton
  const url = env.DATA_WAREHOUSE_URL?.trim()
  if (!url) throw new Error(DATA_WAREHOUSE_UNCONFIGURED)
  const pool = new Pool({ connectionString: url, statement_timeout: STATEMENT_TIMEOUT_MS })
  pool.on('connect', (client) => { void client.query('set default_transaction_read_only = on') })
  analystSingleton = pool
  return analystSingleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调；与 resetWarehousePool 对称）。 */
export function resetAnalystPool(): void {
  analystSingleton = null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/warehouse.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/warehouse.ts modules/data/domain/warehouse.test.ts
git commit -m "feat(data): analystPool 只读单例——default_transaction_read_only=on (#<ISSUE>)"
```

---

### Task 5: audit-store —— tool 字段 + writeAudit 返回 id/created_at + 迁移 021

**Files:**
- Modify: `modules/data/domain/audit-store.ts`
- Modify: `modules/data/domain/audit-store.test.ts`（追加）
- Create: `modules/data/migrations/021_query_audit_tool.sql`

**Interfaces:**
- Consumes: 现 `AuditEntry` / `writeAudit`。
- Produces:
  - `AuditEntry.tool?: string | null`（可空：HTTP/chat 行不带 tool）
  - `writeAudit(pool, entry): Promise<{ id: number; createdAt: Date }>`（**返回值变化**：现签名 `Promise<void>`；既有调用方不消费返回值，类型兼容不破坏）
  - 迁移 021：`alter table data.query_audit add column if not exists tool text;`（幂等；只加列，无隔离面新增）

- [ ] **Step 1: 写失败测试**（`audit-store.test.ts` 追加 describePg 段）

```ts
// audit-store.test.ts 追加 —— tool 字段 + 返回 id/created_at。
describePg('writeAudit tool 字段与返回值（需要 DATABASE_URL）', () => {
  it('tool 带入/缺省 null 落列；返回 id 与 created_at', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    await applyMigrations(pool)   // 本文件已有的迁移脚手架
    try {
      const a = await writeAudit(pool, {
        org: 'org-audit-tool', userId: 'u', channel: 'pat', keyId: null,
        metricId: '', params: { tool: 'data_agent_guide' }, rowCount: null,
        verdict: 'ok', reason: null, masking: null, tool: 'data_agent_guide',
      })
      expect(Number.isInteger(a.id)).toBe(true)
      expect(a.createdAt).toBeInstanceOf(Date)
      const b = await writeAudit(pool, {
        org: 'org-audit-tool', userId: 'u', channel: 'session', keyId: null,
        metricId: 'm', params: {}, rowCount: 1, verdict: 'ok', reason: null, masking: null,
      })
      const r = await pool.query(
        'select metric_id, tool, row_count from data.query_audit where id = any($1) order by id', [[a.id, b.id]])
      expect(r.rows[0]).toMatchObject({ metric_id: '', tool: 'data_agent_guide', row_count: null })
      expect(r.rows[1]).toMatchObject({ metric_id: 'm', tool: null })
    } finally {
      await pool.query('delete from data.query_audit where org = $1', ['org-audit-tool'])
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/audit-store.test.ts`
Expected: FAIL——insert 列清单无 `tool` ⇒ 测试报错（列不存在或形状断言失败）

- [ ] **Step 3: 实现迁移与代码**

`modules/data/migrations/021_query_audit_tool.sql`：

```sql
-- 021_query_audit_tool.sql — MCP 工具面审计扩列（spec 2026-10-21 §8）。
--
-- tool = 触发本条审计的工具名（分析师面 11 工具 / legacy 指标工具的 sanitized 名）。
-- 可空：HTTP /query、chat 等「无 MCP 工具」的既有通路不带 tool（legacy 行可辨）。
-- 非指标工具（guide 等）metric_id 落 ''（空串 ≠ null；列 not null，语义 = 本次无指标对象）。
-- 纪律同 019：幂等 add column if not exists；无 create table ⇒ 无租户隔离面新增。
alter table data.query_audit
  add column if not exists tool text;
```

`audit-store.ts` 的 `AuditEntry` 与 `writeAudit`：

```ts
export interface AuditEntry {
  // ……既有字段一字不动……
  /**
   * 触发本条审计的 MCP 工具名（spec 2026-10-21 §8）。可空：
   *   · 分析师面 11 工具 / legacy 指标工具（/mcp）恒写工具名；
   *   · HTTP /query、chat 等无工具通路缺省（列落 null）。
   */
  tool?: string | null
}

export async function writeAudit(pool: Pool, entry: AuditEntry): Promise<{ id: number; createdAt: Date }> {
  const r = await pool.query(
    `insert into data.query_audit
       (org, user_id, channel, key_id, metric_id, params, row_count, verdict, reason, masking, tool)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, created_at`,
    [
      entry.org, entry.userId, entry.channel, entry.keyId, entry.metricId,
      JSON.stringify(entry.params), entry.rowCount, entry.verdict, entry.reason,
      entry.masking === null ? null : JSON.stringify(entry.masking),
      entry.tool ?? null,
    ],
  )
  return { id: Number(r.rows[0].id), createdAt: r.rows[0].created_at as Date }
}
```

**Step 3b（补一 diff）：registry 的审计写侧收敛到 writeAudit。** Task 1 的 `writeCallAudit`
是为了在 `AuditEntry.tool` 存在前让 registry 可提交的**过渡形态**——本步之后全仓审计写路径
只有 `writeAudit` 一条（单一事实源）：

```ts
// registry.ts —— 删除 writeCallAudit，callTool 的 finish 改为：
    await writeAudit(deps.pool, {
      org: deps.org,
      userId: deps.requester?.userId ?? '(anonymous)',
      channel: deps.requester?.channel ?? 'session',
      keyId: deps.requester?.keyId ?? null,
      metricId: base.auditMetricId ?? '',
      params: args,                       // 调用入参原样入审计（排障可重放）
      rowCount: base.auditRowCount ?? null,
      verdict, reason: reason === '' ? null : reason,
      masking: null, tool: name,
    })
```
（`import { writeAudit } from '../audit-store'`；registry → audit-store 的依赖仍是纯的——audit-store 只 import pg 的**类型**与 authz 的 `Channel`。）

- [ ] **Step 4: 跑测试确认通过（含全包回归：query-service.test.ts 等调用方不消费返回值，应全绿；registry 的两个 callTool 假池用例不改仍绿）**

Run: `pnpm --filter data exec vitest run domain/audit-store.test.ts domain/query-service.test.ts domain/toolbox/registry.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/audit-store.ts modules/data/domain/audit-store.test.ts modules/data/migrations/021_query_audit_tool.sql modules/data/domain/toolbox/registry.ts
git commit -m "feat(data): 审计扩 tool 字段——writeAudit 返回 id/created_at（迁移 021），registry 写侧收敛 (#<ISSUE>)"
```

---

### Task 6: query-service 接线 —— tool/warehouseExec/slicing 透传 + QueryOk.audit + watermarkSqlFor

**Files:**
- Modify: `modules/data/domain/query-service.ts`
- Modify: `modules/data/domain/query-service.test.ts`（追加）

**Interfaces:**
- Consumes: T3 的 `SlicingSpec`；T5 的 `writeAudit` 返回值。
- Produces（T8/T9/T10/T11 依赖）:
  - `QueryDeps` 增：`tool?: string`（审计工具名，缺省不写 tool 列）；`warehouseExec?: SqlExecutor`（辅助读执行器，缺省 = `(sql) => runWarehouseSql(warehousePool(), sql)`，现状零变化）
  - `runQuery(deps, org, requester, metricId, args, slicing?: SlicingSpec)`——第 6 参透传 authorize；`deps.execute` 与 `deps.warehouseExec` 都由调用方给（分析师面两者=只读池）
  - `QueryOk` 增：`audit?: { id: number; ts: string }`——ts = 北京时间 ISO 形态 `YYYY-MM-DDTHH:mm:ss+08:00`（新内部函数 `formatAuditTs`；审计写成功才带）；以及 `sql?: string`（ok 出口 `sql: authz.plan.sql`——T10 信封 `query.sql` 节的来源；denied/error 不带）
  - `export function watermarkSqlFor(relations: readonly string[]): string`——把现 `WATERMARK_SQL_HEAD + … + WATERMARK_SQL_TAIL` 的拼装收成**导出函数**（本文件内部调用点改用它；T9 `get_freshness` 复用同一来源）
  - `export function formatAuditTs(v: Date): string`

- [ ] **Step 1: 写失败测试**（`query-service.test.ts` 追加；夹具/假执行器沿用本文件既有模式）

```ts
// query-service.test.ts 追加 —— 分析师面接线：tool/warehouseExec/audit 回传。
describe('runQuery 分析师面接线', () => {
  // 助手（与本文件既有夹具同风格）：`req` = 带 data:query 的 Requester；`fakePool` = 审计写入假池。
  const req = (scopes: string[]): Requester => ({
    userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes, hasScope: (c) => scopes.includes(c),
  })
  const fakePool = () => ({
    query: async () => ({ rows: [{ id: 1, created_at: new Date('2026-10-21T10:00:00Z') }] }),
  }) as never

  it('warehouseExec 承接辅助读（data_as_of/水位/维度解析不再直连 warehousePool）', async () => {
    const seen: string[] = []
    const main: SqlExecutor = async (sql) => {
      seen.push(`main:${sql.slice(0, 20)}`)
      return { columns: ['org', 'bizday'], rows: [['acme', '2026-10-01']] }
    }
    const wh: SqlExecutor = async (sql) => {
      seen.push(`wh:${sql.slice(0, 24)}`)
      if (sql.includes('load_log')) return { columns: ['data_as_of'], rows: [[new Date('2026-10-21T02:10:00+08:00')]] }
      return { columns: [], rows: [] }
    }
    const out = await runQuery(
      { pool: fakePool(), execute: main, warehouseExec: wh, adoptedSources: new Set(['lemeng']), raceRetryDelayMs: 0 },
      'acme', req(['data:query']), 'm', {},
    )
    expect(out.status).toBe('ok')
    expect(seen.some((s) => s.startsWith('wh:'))).toBe(true)   // 辅助读走了注入的 wh
  })

  it('tool 透传进审计；QueryOk.audit 带 id/北京时间 ts', async () => {
    const inserts: { sql: string; values: unknown[] }[] = []
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        inserts.push({ sql, values: values ?? [] })
        if (sql.includes('insert into data.query_audit')) {
          return { rows: [{ id: 501, created_at: new Date('2026-10-21T10:00:00Z') }] }
        }
        return { rows: [] }
      },
    } as never
    const out = await runQuery(
      {
        pool, execute: async () => ({ columns: ['org'], rows: [['acme']] }),
        warehouseExec: async () => ({ columns: [], rows: [] }),
        adoptedSources: new Set<string>(), tool: 'query_metric', raceRetryDelayMs: 0,
      },
      'acme', req(['data:query']), 'm', {},
    )
    expect(out.status).toBe('ok')
    if (out.status === 'ok') {
      expect(out.audit).toMatchObject({ id: 501, ts: '2026-10-21T18:00:00+08:00' })
    }
    const auditCall = inserts.find((c) => c.sql.includes('insert into data.query_audit'))
    expect(auditCall?.sql).toContain(', tool')
    expect(auditCall?.values?.at(-1)).toBe('query_metric')
  })

  it('slicing 透传 authorize（切片 SQL 生效）', async () => {
    let executed = ''
    const out = await runQuery(
      {
        pool: fakePool(), execute: async (sql) => { executed = sql; return { columns: ['org'], rows: [['acme']] } },
        warehouseExec: async () => ({ columns: [], rows: [] }),
        adoptedSources: new Set<string>(), raceRetryDelayMs: 0,
      },
      'acme', req(['data:query']), 'm_totalable', {}, { dimensions: ['org'] },
    )
    expect(out.status).toBe('ok')
    expect(executed).toContain('sum(value) as value')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/query-service.test.ts`
Expected: 追加段 FAIL（`warehouseExec`/`tool`/`audit` 不存在）；**既有段 PASS**

- [ ] **Step 3: 实现**（改动点逐条，不重排既有逻辑）

1. `QueryDeps` 追加字段（带注释，理由=决策 D5/D7）：
```ts
  /** 审计工具名（分析师面 / MCP legacy 面 = 被调工具名；HTTP/chat 不带 ⇒ 审计 tool 列 null）。 */
  tool?: string
  /**
   * 辅助读执行器（data_as_of / 水位 / 维度名称解析）。缺省 = 仓写池（现状行为）。
   * 分析师面注入只读池执行器 ⇒ 主计划与辅助读**全部**只读（决策 D5）。
   */
  warehouseExec?: SqlExecutor
```
2. `runQuery` 签名追加 `slicing?: SlicingSpec`（`import type { SlicingSpec } from './authz'`），`authorize(catalog, requester, metricId, args, allMetrics, slicing)`。
3. 审计闭包把 `deps.tool` 带进 entry（`...(deps.tool !== undefined ? { tool: deps.tool } : {})`）；三处 `await audit(...)` 改为 `const a = await audit(...)`，ok 出口的返回对象追加：
```ts
    ...(auditRow !== undefined ? { audit: { id: auditRow.id, ts: formatAuditTs(auditRow.createdAt) } } : {}),
```
   （被拒/出错出口不追加——无行集无信封。）
4. ok 出口的返回对象加 `sql: authz.plan.sql`（QueryOk 增可选 `sql?: string`；信封要用，plan 只在此处可得）。
5. 新增导出：
```ts
/** 北京时间 ISO 形态（spec §4 audit.ts 示例同区）：`YYYY-MM-DDTHH:mm:ss+08:00`。 */
export function formatAuditTs(v: Date): string {
  const d = DATA_AS_OF_DATE_FMT.format(v)
  const t = DATA_AS_OF_TIME_FMT.format(v)
  return `${d}T${t}+08:00`
}

/** 水位 SQL（先按关系取最新一行，再跨关系取木桶短板——#844 订正语义）。唯一拼装点。 */
export function watermarkSqlFor(relations: readonly string[]): string {
  return `${WATERMARK_SQL_HEAD}${relations.map((r) => sqlQuote(r)).join(', ')}${WATERMARK_SQL_TAIL}`
}
```
5. 三个辅助读点改为经 `whExec`：
```ts
  const whExec = deps.warehouseExec ?? ((sql: string) => runWarehouseSql(warehousePool(), sql))
```
   - `const fresh = await whExec(DATA_AS_OF_SQL)`（原 `runWarehouseSql(warehousePool(), DATA_AS_OF_SQL)`）
   - 水位：`await whExec(watermarkSqlFor(relations))`
   - 维度解析：`deps.dimensionLookup ?? (() => loadDimensionLookup(whExec))()`
   ⚠️ `deps.execute`（主计划/合计的测试缝）语义不变；`whExec` 只管辅助读。

- [ ] **Step 4: 跑测试确认通过（既有段全绿 = 现状零回归）**

Run: `pnpm --filter data exec vitest run domain/query-service.test.ts domain/authz.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/query-service.ts modules/data/domain/query-service.test.ts
git commit -m "feat(data): runQuery 接线——tool/warehouseExec/slicing 透传，audit id 回传 (#<ISSUE>)"
```

---

### Task 7: guide.ts —— data_agent_guide + data_harness_catalog

**Files:**
- Create: `modules/data/domain/toolbox/guide.ts`
- Create: `modules/data/domain/toolbox/guide.test.ts`

**Interfaces:**
- Consumes: T1 的 `ToolImpl/ToolImplResult/ANALYST_TOOLS/SAMPLE_MAX_ROWS/MAX_QUERY_ROWS 语义`（行限引用 `../authz` 的常量，不复制数值）。
- Produces:
  - `export const GUIDE_TEXT_BUILDER = (today: string): string`——七步工作流 + 硬约束 + 今天日期（A/C 通道 Wave 2 从本文件同源取文案，本 Wave 只落 B 通道）
  - `export const guideImpl: ToolImpl`（auditRowCount 缺省 null；payload `{ workflow: string; today: string }`）
  - `export const harnessCatalogImpl: ToolImpl`——payload `{ tools: ANALYST_TOOLS.map(逐条 {name,group,title,description,requiredScope,mutating,annotations}) }`（清单与注册表逐条一致：直接从 `ANALYST_TOOLS` 派生，无第二份字面量）

- [ ] **Step 1: 写失败测试**

```ts
// guide.test.ts — 纯层（不连库；impl 不触 pool/wh）。
import { describe, expect, it } from 'vitest'
import { GUIDE_TEXT_BUILDER, guideImpl, harnessCatalogImpl } from './guide'
import { ANALYST_TOOLS, type ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const deps = (): ToolboxDeps => ({
  pool: { query: async () => { throw new Error('guide 不该碰库') } } as never,
  org: 'acme',
  requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true } as Requester,
  adoptedSources: new Set<string>(),
  wh: async () => { throw new Error('guide 不该碰仓库') },
})

describe('guideImpl / harnessCatalogImpl', () => {
  it('guide：七步工作流 + 硬约束 + 注入的今天日期；不触库不触仓', async () => {
    const out = await guideImpl(deps(), {})
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    const payload = out.payload as { today: string; workflow: string }
    expect(payload.today).toBe('2026-10-21')
    expect(payload.workflow).toContain('主体')
    expect(payload.workflow).toContain('新鲜度')
    expect(payload.workflow).toContain('1000')
  })
  it('catalog：清单与注册表逐条一致（同源派生，无第二份字面量）', async () => {
    const out = await harnessCatalogImpl(deps(), {})
    const tools = (out.payload as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toEqual(ANALYST_TOOLS.map((t) => t.name))
    expect(tools).toHaveLength(ANALYST_TOOLS.length)
  })
  it('GUIDE_TEXT_BUILDER 的今天日期由调用方注入（不 hidden 依赖系统时钟）', () => {
    expect(GUIDE_TEXT_BUILDER('2026-01-02')).toContain('2026-01-02')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/guide.test.ts`
Expected: FAIL——`Cannot find module './guide'`

- [ ] **Step 3: 实现**

```ts
// guide.ts —— data_agent_guide / data_harness_catalog（spec §5 前两行）。
// guide 文案是三通道同源的正典落点（Wave 2 的 A SYSTEM_PROMPT 与 C SKILL.md 从这里取）；
// Wave 1 只接 B 通道。今天日期由 deps.now 注入（Asia/Shanghai 日历日）——测试不必改时钟。
import { ANALYST_TOOLS, type ToolImpl } from './registry'

/** 硬约束（与授权核心口径逐字对齐：主体钉死 / 1000 行 / 新鲜度脚注 / total 语义）。 */
export const GUIDE_TEXT_BUILDER = (today: string): string => [
  `今天是 ${today}（Asia/Shanghai）。`,
  '工作流七步：',
  '1. 先读本指南（本工具）；',
  '2. data_harness_catalog 看有哪些工具；',
  '3. search_catalog 找指标；describe_metric 拿口径/参数/维度（查数前必做）；',
  '4. sample_dimension_values 确认过滤值的确切写法（如门店名）；',
  '5. preview_query 核对将执行的 SQL；',
  '6. query_metric 取数——回包是信任信封：口径版本/数据截止/审计 id 都在里面，照实转述；',
  '7. get_freshness/get_quality/get_lineage 回答「数据新不新/可不可信/从哪来」。',
  '硬约束：',
  '· 主体（org/租户）由平台按身份钉死，不要索要、不要猜测、参数里出现即被拒；',
  '· 行上限 1000，truncated=true 说明被截断（截断集最新优先），不得对截断集自行求和；',
  '· total 字段只在未切片或显式请求时出现——切片后的部分合计不是全局合计；',
  '· 回包的数据截止（asOf）必须如实转述成脚注；没有该字段 = 新鲜度未知，不要编。',
].join('\n')

const shanghaiToday = (now: () => Date): string => {
  // 与 query-service 的日期格式化同一口径（en-CA = YYYY-MM-DD）
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now())
}

export const guideImpl: ToolImpl = async (deps) => {
  const today = shanghaiToday(deps.now ?? (() => new Date()))
  return {
    payload: { today, workflow: GUIDE_TEXT_BUILDER(today) },
    isError: false,
    auditRowCount: null,
  }
}

export const harnessCatalogImpl: ToolImpl = async () => ({
  payload: {
    tools: ANALYST_TOOLS.map((t) => ({
      name: t.name, group: t.group, title: t.title, description: t.description,
      requiredScope: t.requiredScope, mutating: t.mutating, annotations: t.annotations,
    })),
  },
  isError: false,
  auditRowCount: null,
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/guide.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/guide.ts modules/data/domain/toolbox/guide.test.ts
git commit -m "feat(data): 分析师面 guide——工作流指南与工具清单（三通道同源落点） (#<ISSUE>)"
```

---

### Task 8: discovery.ts —— search_catalog / describe_metric / describe_dataset / sample_dimension_values

**Files:**
- Create: `modules/data/domain/toolbox/discovery.ts`
- Create: `modules/data/domain/toolbox/discovery.test.ts`

**Interfaces:**
- Consumes: T1 `ToolboxDeps/ToolImpl/SAMPLE_MAX_ROWS/sanitize 语义`；`visibleMetrics/loadMergedCatalog`；T3 的 `authorizeCore`（sample 的内层，**不自建主体过滤**）；`paramFaceOf`；`sqlQuote`；`MetricRow`。
- Produces（四个 `ToolImpl`，T11 注册）：
  - `searchImpl`：`args {q?, kind? ('metric'|'dataset'), tier?}`。metric 支：`visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), requester, adoptedSources)` 过滤（q 大小写不敏感子串于 id/title/description；tier：`certified`=l1 / `custom`=l2）→ `{results: [{id,title,tier,owner,oneLiner}]}` ≤20（owner：l1=`'data-platform'`，l2=`deps.org`；oneLiner=description 首行截 120）。dataset 支：`deps.wh` 查 `information_schema.tables`（schema 不在 `DATASET_SCHEMA_DENYLIST = ['pg_catalog','information_schema','data','platform']`），行 `{id:'<schema>.<table>', title, tier:'raw', owner:'', oneLiner}` ≤20。
  - `describeMetricImpl`：`args {id}`。可见词表找不到（含未接入源被裁剪的）⇒ `payload {status:'not_found', metricId}` isError（404 语义=源投影裁剪，spec §5）。命中 ⇒ `{status:'ok', id, title, definition, grain: string[], params: paramFaceOf, owner, tier, version, asOf?}`——`asOf` 仅当该指标声明了 freshnessRelations 且水位查得到（经 T6 `watermarkSqlFor` 走 `deps.wh`），字段 `{dataThrough, watermark, status}`，查不到**缺席**。
  - `describeDatasetImpl`：`args {dataset}`。形状校验 `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`，schema 在 DENYLIST ⇒ `{status:'not_found'}`；`deps.wh` 查 `information_schema.columns`（标识符经 sqlQuote 内联）⇒ `{status:'ok', dataset, org: deps.org, columns: [{name,dataType}], freshness?}`（freshness 同 asOf 规则，按 table_name 匹配 load_log relation）。
  - `sampleDimensionValuesImpl`：`args {metricId, dimension, q?, limit?}`。`authorizeCore` 拿内层（拒绝原样透传为 denied）→ dimension ∈ grain 否则 `bad_param/unknown_dimension` → `limit = min(limit??SAMPLE_MAX_ROWS, SAMPLE_MAX_ROWS)` → SQL：`select <dim> as value, count(*) as n from ( <inner> ) t [where value like '<esc>%'] group by value order by n desc, value limit <n>`（`q` 做 LIKE 转义：`\` `%` `_` 前加 `\`）→ `{status:'ok', metricId, dimension, values:[{value,n}], truncated: rows.length === limit}`；`auditMetricId: metricId`、`auditRowCount: values.length`。
  - 全部 impl：`requester===null` 不会到达（registry.callTool 已拒），但函数内仍按 fail-closed 先拒（防御分支，不依赖调用方纪律）。

- [ ] **Step 1: 写失败测试**（节选断言面；夹具 = 内存 MetricRow 数组 + 假 wh）

```ts
// discovery.test.ts — 四个发现工具：词表裁剪复用 visibleMetrics、样本走 authorizeCore、行限 ≤50。
import { describe, expect, it } from 'vitest'
import { describeDatasetImpl, describeMetricImpl, sampleDimensionValuesImpl, searchImpl } from './discovery'
import type { ToolboxDeps } from './registry'
import type { MetricRow } from '../metric-store'

const row = (over: Partial<MetricRow>): MetricRow => ({
  id: 'lemeng:retail:net_sales', title: '净销', description: '净销售额\n第二行',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select org, branch_name, bizday, sum(v) as value from fct group by org, branch_name, bizday',
  groupBy: 'org, branch_name, bizday', params: {}, source: 'l1', sourceSystem: 'lemeng',
  updatedBy: null, version: 1, totalable: true, scopeNote: '', slaDays: 2,
  freshnessRelations: ['stg_lemeng_retail_order_line'], masks: null, ...over,
}) as MetricRow

const requester = { userId: 'u', orgId: 'acme', channel: 'pat' as const, keyId: 1, scopes: ['data:query'], hasScope: (c: string) => c === 'data:query' }

function deps(catalog: MetricRow[], wh: ToolboxDeps['wh'] = async () => ({ columns: [], rows: [] })): ToolboxDeps {
  return {
    pool: {
      query: async () => ({ rows: catalog.map((m) => ({
        id: m.id, title: m.title, description: m.description, required_scope: m.requiredScope,
        subject_column: m.subjectColumn, select_sql: m.selectSql, group_by: m.groupBy,
        params: m.params, source: m.source, source_system: m.sourceSystem,
        updated_by: m.updatedBy, version: m.version, totalable: m.totalable, scope_note: m.scopeNote,
        sla_days: m.slaDays, freshness_relations: m.freshnessRelations, mask_spec: m.masks,
      })) }),
    } as never,
    org: 'acme', requester, adoptedSources: new Set(['lemeng']), wh,
  }
}

describe('searchImpl', () => {
  it('只列可见指标（源裁剪）；tier/owner/oneLiner 派生正确；≤20 条', async () => {
    const foreign = row({ id: 'other:x', sourceSystem: 'other', title: '别家' })
    const out = await searchImpl(deps([row({}), foreign]), { kind: 'metric' })
    const results = (out.payload as { results: { id: string; tier: string; owner: string; oneLiner: string }[] }).results
    expect(results.map((r) => r.id)).toEqual(['lemeng:retail:net_sales'])
    expect(results[0].tier).toBe('certified')
    expect(results[0].owner).toBe('data-platform')
    expect(results[0].oneLiner).toBe('净销售额')
  })
  it('q 与 tier 过滤生效', async () => {
    const custom = row({ id: 'acme:custom:1', source: 'l2' as const, sourceSystem: null, title: '自定义' })
    const d = deps([row({}), custom])
    const byQ = await searchImpl(d, { q: '自定义' })
    expect((byQ.payload as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['acme:custom:1'])
    const byTier = await searchImpl(d, { tier: 'custom' })
    expect((byTier.payload as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['acme:custom:1'])
  })
  it('kind=dataset：DENYLIST schema 不出现', async () => {
    const d = deps([], async () => ({ columns: ['table_schema', 'table_name'], rows: [['pg_catalog', 'pg_class'], ['marts', 'fct_retail_sale']] }))
    const out = await searchImpl(d, { kind: 'dataset' })
    const results = (out.payload as { results: { id: string }[] }).results
    expect(results.map((r) => r.id)).toEqual(['marts.fct_retail_sale'])
  })
})

describe('describeMetricImpl', () => {
  it('可见指标回 grain/params/version；未接入源/未声明 ⇒ not_found（404 语义）', async () => {
    const out = await describeMetricImpl(deps([row({})]), { id: 'lemeng:retail:net_sales' })
    const p = out.payload as { status: string; grain: string[]; params: Record<string, unknown> }
    expect(p.status).toBe('ok')
    expect(p.grain).toEqual(['org', 'branch_name', 'bizday'])
    const nf = await describeMetricImpl(deps([row({})]), { id: 'nope' })
    expect(nf.isError).toBe(true)
    expect(nf.payload).toMatchObject({ status: 'not_found', metricId: 'nope' })
  })
  it('asOf：声明了链路且水位可查 ⇒ 在场；查不到 ⇒ 缺席（未知≠编造）', async () => {
    const withWater = deps([row({})], async (sql) => sql.includes('load_log')
      ? { columns: ['watermark', 'materialized_at'], rows: [['2026-10-20', new Date('2026-10-21T02:10:00+08:00')]] }
      : { columns: [], rows: [] })
    const ok = await describeMetricImpl(withWater, { id: 'lemeng:retail:net_sales' })
    expect((ok.payload as { asOf?: { dataThrough: string } }).asOf?.dataThrough).toBe('2026-10-20')
    const none = await describeMetricImpl(deps([row({})]), { id: 'lemeng:retail:net_sales' })
    expect('asOf' in none.payload).toBe(false)
  })
})

describe('sampleDimensionValuesImpl', () => {
  const whOf = (rows: unknown[][]) => async () => ({ columns: ['value', 'n'], rows })
  it('行数 = min(limit, 50)；审计带 metricId 与 rowCount', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`店${i}`, 10 - i])
    const out = await sampleDimensionValuesImpl(deps([row({})], whOf(rows)), { metricId: 'lemeng:retail:net_sales', dimension: 'branch_name' })
    expect((out.payload as { values: unknown[] }).values).toHaveLength(50)
    expect(out.auditMetricId).toBe('lemeng:retail:net_sales')
    expect(out.auditRowCount).toBe(50)
    expect((out.payload as { truncated: boolean }).truncated).toBe(true)
  })
  it('未知维度 ⇒ denied（bad_param/unknown_dimension）；q 经 LIKE 转义', async () => {
    const bad = await sampleDimensionValuesImpl(deps([row({})]), { metricId: 'lemeng:retail:net_sales', dimension: 'nope' })
    expect(bad.isError).toBe(true)
    expect(bad.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'unknown_dimension:nope' })
    const seen: string[] = []
    const d = deps([row({})], async (sql) => { seen.push(sql); return { columns: ['value', 'n'], rows: [] } })
    await sampleDimensionValuesImpl(d, { metricId: 'lemeng:retail:net_sales', dimension: 'branch_name', q: '100%店' })
    expect(seen[0]).toContain("like '%100\\%店%'")
  })
  it('指标不存在 ⇒ denied 透传 authorizeCore 拒因（不自建判定）', async () => {
    const out = await sampleDimensionValuesImpl(deps([row({})]), { metricId: 'nope', dimension: 'org' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
  })
})

describe('describeDatasetImpl', () => {
  it('形状非法/DENYLIST ⇒ not_found；命中回列与类型', async () => {
    expect((await describeDatasetImpl(deps([]), { dataset: 'drop table' })).payload).toMatchObject({ status: 'not_found' })
    expect((await describeDatasetImpl(deps([]), { dataset: 'data.metrics' })).payload).toMatchObject({ status: 'not_found' })
    const d = deps([], async () => ({ columns: ['column_name', 'data_type'], rows: [['org', 'text'], ['bizday', 'date']] }))
    const out = await describeDatasetImpl(d, { dataset: 'marts.fct_retail_sale' })
    expect(out.payload).toMatchObject({ status: 'ok', dataset: 'marts.fct_retail_sale', org: 'acme' })
    expect((out.payload as { columns: unknown[] }).columns).toEqual([{ name: 'org', dataType: 'text' }, { name: 'bizday', dataType: 'date' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/discovery.test.ts`
Expected: FAIL——`Cannot find module './discovery'`

- [ ] **Step 3: 实现**（骨架；细节按测试逐字）

```ts
// discovery.ts —— 发现面四工具（spec §5 search/describe/sample 三行 + dataset 列）。
// 权限判定不自建：词表裁剪只走 visibleMetrics；sample 的主体过滤只走 authorizeCore（T3）。
// 仓库读一律 deps.wh（分析师面 = 只读池）。
import { authorizeCore, paramFaceOf, sqlQuote, visibleMetrics } from '../authz'
import type { MetricRow } from '../metric-store'
import { loadMergedCatalog } from '../metric-store'
import { watermarkSqlFor } from '../query-service'
import { SAMPLE_MAX_ROWS, type ToolImpl, type ToolImplResult, type ToolboxDeps } from './registry'

const SEARCH_LIMIT = 20
/** 数据集面不暴露的 schema（平台内部库表不属于分析师面）。 */
export const DATASET_SCHEMA_DENYLIST = ['pg_catalog', 'information_schema', 'data', 'platform']
const DATASET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/
/** 维度名 = 干净标识符（授权核心对 L1 grain 已保证；此处对**用户输入**的维度名再查一次）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const tierOf = (m: MetricRow): 'certified' | 'custom' => (m.source === 'l1' ? 'certified' : 'custom')
const ownerOf = (m: MetricRow, org: string): string => (m.source === 'l1' ? 'data-platform' : org)
const oneLinerOf = (m: MetricRow): string => (m.description.split('\n')[0] ?? '').slice(0, 120)

/** 指标链路水位（声明了 freshnessRelations 才查；查不到/未声明 ⇒ undefined，未知≠编造）。 */
async function watermarkOf(deps: ToolboxDeps, m: MetricRow): Promise<{ dataThrough: string; status: string } | undefined> {
  const relations = Array.isArray(m.freshnessRelations) ? m.freshnessRelations.filter((r) => r !== '') : []
  if (m.slaDays === null || relations.length === 0) return undefined
  try {
    const r = await deps.wh(watermarkSqlFor(relations))
    const w = r.rows[0]?.[0]
    if (typeof w !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w)) return undefined
    // status 判据与发布面对齐表同源（query-service 的 freshnessStatusOf 同一公式；此处只判
    // normal/late/alert，无 sla 判 unknown——slaDays null 已在上面短路）。
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format((deps.now ?? (() => new Date()))())
    const dayMs = (iso: string): number => { const [y, m2, d] = iso.split('-').map(Number); return Date.UTC(y, (m2 ?? 1) - 1, d ?? 1) }
    const lateBy = (dayMs(today) - dayMs(w)) / 86_400_000 - (m.slaDays ?? 0)
    const status = lateBy <= 0 ? 'normal' : lateBy <= 2 ? 'late' : 'alert'
    return { dataThrough: w, status }
  } catch {
    return undefined
  }
}

const denied = (reason: string, detail: string | undefined, metricId: string): ToolImplResult => ({
  payload: { status: 'denied', reason, ...(detail !== undefined ? { detail } : {}), metricId },
  isError: true, auditMetricId: metricId, auditRowCount: null,
})

/** 可见词表（裁剪只走 visibleMetrics；requester null 的防御分支兜底 fail-closed）。 */
const visibleRows = async (deps: ToolboxDeps): Promise<MetricRow[]> => {
  if (deps.requester === null) return []
  return visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources)
}

export const searchImpl: ToolImpl = async (deps, args) => {
  const q = typeof args.q === 'string' && args.q !== '' ? args.q.toLowerCase() : null
  const tierFilter = args.tier === 'certified' ? 'l1' : args.tier === 'custom' ? 'l2' : null
  if (args.kind !== 'dataset') {
    const results = (await visibleRows(deps))
      .filter((m) => tierFilter === null || m.source === tierFilter)
      .filter((m) => q === null || m.id.toLowerCase().includes(q)
        || m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
      .map((m) => ({ id: m.id, title: m.title, tier: tierOf(m), owner: ownerOf(m, deps.org), oneLiner: oneLinerOf(m) }))
    return { payload: { results }, isError: false, auditRowCount: null }
  }
  const r = await deps.wh('select table_schema, table_name from information_schema.tables order by table_schema, table_name')
  const results = r.rows
    .map((row) => ({ schema: String(row[0] ?? ''), name: String(row[1] ?? '') }))
    .filter((x) => !DATASET_SCHEMA_DENYLIST.includes(x.schema))
    .filter((x) => q === null || x.name.toLowerCase().includes(q))
    .slice(0, SEARCH_LIMIT)
    .map((x) => ({ id: `${x.schema}.${x.name}`, title: x.name, tier: 'raw', owner: '', oneLiner: `${x.schema} 关系` }))
  return { payload: { results }, isError: false, auditRowCount: null }
}

export const describeMetricImpl: ToolImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  const m = id === '' ? undefined : (await visibleRows(deps)).find((x) => x.id === id)
  if (m === undefined) {
    // 404 语义（spec §5：未接入源指标 = 源投影裁剪后「看不见」）——isError 供客户端可辨
    return { payload: { status: 'not_found', metricId: id }, isError: true, auditMetricId: id, auditRowCount: null }
  }
  const asOf = await watermarkOf(deps, m)
  return {
    payload: {
      status: 'ok', id, title: m.title, definition: m.description,
      grain: m.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== ''),
      params: paramFaceOf(m.params),
      owner: ownerOf(m, deps.org), tier: tierOf(m), version: m.version,
      ...(asOf !== undefined ? { asOf } : {}),
    },
    isError: false, auditMetricId: id, auditRowCount: null,
  }
}

export const describeDatasetImpl: ToolImpl = async (deps, args) => {
  const dataset = typeof args.dataset === 'string' ? args.dataset : ''
  const parts = dataset.split('.')
  if (parts.length !== 2 || !DATASET_NAME_RE.test(dataset) || DATASET_SCHEMA_DENYLIST.includes(parts[0])) {
    return { payload: { status: 'not_found', dataset }, isError: true, auditRowCount: null }
  }
  const [schema, table] = parts as [string, string]
  const r = await deps.wh(
    `select column_name, data_type from information_schema.columns`
    + ` where table_schema = ${sqlQuote(schema)} and table_name = ${sqlQuote(table)} order by ordinal_position`)
  const columns = r.rows.map((row) => ({ name: String(row[0] ?? ''), dataType: String(row[1] ?? '') }))
  if (columns.length === 0) return { payload: { status: 'not_found', dataset }, isError: true, auditRowCount: null }
  let freshness: { dataThrough: string } | undefined
  try {
    const w = await deps.wh(`select max(max_bizday)::text as watermark from data.load_log where status = 'ok' and relation = ${sqlQuote(table)}`)
    const v = w.rows[0]?.[0]
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) freshness = { dataThrough: v }
  } catch { /* 缺席：新鲜度未知（未知 ≠ 编造） */ }
  return {
    payload: { status: 'ok', dataset, org: deps.org, columns, ...(freshness !== undefined ? { freshness } : {}) },
    isError: false, auditRowCount: null,
  }
}

export const sampleDimensionValuesImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const dimension = typeof args.dimension === 'string' ? args.dimension : ''
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit <= 0)) {
    return denied('bad_param', 'invalid_limit', metricId)
  }
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : SAMPLE_MAX_ROWS, SAMPLE_MAX_ROWS)
  if (deps.requester === null) return denied('unauthenticated', undefined, metricId)
  // 词表裁剪 + 主体钉死全部出自 authorizeCore（T3）：本文件不拼任何 WHERE 主语。
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const catalog = visibleMetrics(all, deps.requester, deps.adoptedSources)
  const toolArgs = typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
    ? args.args as Record<string, unknown> : {}
  const core = authorizeCore(catalog, deps.requester, metricId, toolArgs, all, [])
  if (!core.ok) return denied(core.reason, core.detail, metricId)
  const grain = core.metric.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== '')
  if (!grain.includes(dimension) || !IDENT_RE.test(dimension)) {
    return denied('bad_param', `unknown_dimension:${dimension}`, metricId)
  }
  const q = typeof args.q === 'string' && args.q !== '' ? `%${args.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  const sql = `select ${dimension} as value, count(*) as n from ( ${core.inner} ) t`
    + (q !== null ? ` where value like ${sqlQuote(q)}` : '')
    + ` group by value order by n desc, value limit ${limit}`
  const r = await deps.wh(sql)
  const values = r.rows.map((row) => ({ value: row[0], n: Number(row[1] ?? 0) }))
  return {
    payload: { status: 'ok', metricId, dimension, values, truncated: values.length === limit, limit },
    isError: false, auditMetricId: metricId, auditRowCount: values.length,
  }
}
```

> 实现注记（每一支的判定顺序照测试，不新增分支）：
> ① `searchImpl`：`kind` 非 `'dataset'`（含缺省）走 metric 支。可见词表 = `visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), deps.requester!, deps.adoptedSources)`（requester 在 callTool 已非空；`!` 前仍有 null 防御分支）。q 为非空字符串才过滤（`includes` 小写化）。`tier` 过滤映射 `certified→'l1'` / `custom→'l2'`，其余值忽略。dataset 支直接 `deps.wh("select table_schema, table_name from information_schema.tables order by table_schema, table_name")` 后内存过滤 DENYLIST + q。
> ② `describeMetricImpl`：从同一可见词表 `find(id)`；`args.id` 非字符串 ⇒ not_found。返回 `params: paramFaceOf(m.params)`、`grain: m.groupBy.split(',').map(trim).filter(''≠)`。
> ③ `describeDatasetImpl`：先 `DATASET_NAME_RE`，再拆 schema/table（无点 = schema 缺省 `'marts'`? **不**——缺 schema 的裸表名判 not_found，数据集必须带 schema 限定，避免歧义）。列查询经 `sqlQuote` 内联 schema/table。
> ④ `sampleDimensionValuesImpl`：`args.limit` 须正整数否则 `invalid_limit`；SQL 里维度名拼前做 `IDENT_RE`（`/^[A-Za-z_][A-Za-z0-9_]*$/`）+ grain 成员双校验。`count(*)` 计的是内层 grain 组数（同一维度值在 grain 上的去重组数）——工具描述已如实写「取值与频次」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/discovery.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/discovery.ts modules/data/domain/toolbox/discovery.test.ts
git commit -m "feat(data): 发现面四工具——search/describe/样本抽样（≤50 行，走 authorizeCore） (#<ISSUE>)"
```

---

### Task 9: health.ts —— get_freshness / get_quality / get_lineage + dbt manifest seam

**Files:**
- Create: `modules/data/domain/toolbox/health.ts`
- Create: `modules/data/domain/toolbox/health.test.ts`
- Modify: `.env.example`（追加 `DATA_DBT_MANIFEST_PATH=`）

**Interfaces:**
- Consumes: T1 `ToolboxDeps`（`dbtManifest?: () => Promise<unknown>`）；T6 `watermarkSqlFor/DATA_AS_OF 语义`。
- Produces:
  - `export interface DbtManifestView { dependsOnOf(model: string): string[]; childrenOf(name: string): string[]; testCountOf(model: string): number }`
  - `export function parseDbtManifest(raw: unknown): DbtManifestView | null`（坏形状 ⇒ null；`nodes` 里取 `.model.*` 与 `*.test.*`；`child_map` 建 children）
  - `export function defaultDbtManifest(env?: Record<string,string|undefined>): () => Promise<unknown>`——读 `env.DATA_DBT_MANIFEST_PATH`；未配/读不到/解析失败 ⇒ `async () => null`（**不抛**：seam 缺席 = unknown 语义）
  - `export const freshnessImpl: ToolImpl`——`args {scope?}`：scope 为指标 id ⇒ 该指标链路水位+status+line（与 query-service 同源判据）；缺省 ⇒ 全局：`deps.wh("select max(materialized_at) as data_as_of from data.load_log where status='ok'")` + 全量水位（`watermarkSqlFor` 的关系集 = 该 SQL 无 from 关系过滤时不可用 ⇒ 全局走专用 SQL：先 `select distinct on (relation) relation, max_bizday, materialized_at from data.load_log where status='ok' and relation is not null order by relation, materialized_at desc` 再内存 min(max_bizday)/max(materialized_at)——**这条 SQL 常量定义在 health.ts**，语义与 WATERMARK 同构）。payload `{scope?, dataThrough?, freshnessLagSeconds?, lastDbtRun?, watermark?, status?, line?}`——查不到的字段缺席；`freshnessLagSeconds = (now - materializedAt)/1000` 取整。
  - `export const qualityImpl: ToolImpl`——seam null/解析 null ⇒ `{status:'unknown', reason:'dbt_manifest_unavailable'}` isError=false（「显式未知」不是工具错误）；有 manifest ⇒ `{status:'ok', model?, testsDeclared: n, note:'声明清单来自 dbt manifest；最近一次运行结论不在本数据源内'}`。
  - `export const lineageImpl: ToolImpl`——`args {id, depth?}`（depth 非正整数或 >3 ⇒ bad_param/invalid_depth）。seam null ⇒ `{status:'unknown', reason:'dbt_manifest_unavailable', id}`；有 ⇒ `{status:'ok', id, upstream: dependsOnOf 有界, downstream: childrenOf 有界}`（BFS 按 depth 层展开、去重、不含自身）。
  - ⚠️ `.env.example` 追加：`DATA_DBT_MANIFEST_PATH=`（注释：dbt manifest.json 投递路径；缺省 = 血缘/质量显式 unknown——待真机投递链验证后回填，未决 #2）。

- [ ] **Step 1: 写失败测试**

```ts
// health.test.ts — 三个健康工具：未知显式化（无结论 ≠ 通过），水位判据与发布面对齐表同源。
import { describe, expect, it } from 'vitest'
import { defaultDbtManifest, freshnessImpl, lineageImpl, parseDbtManifest, qualityImpl } from './health'
import type { ToolboxDeps } from './registry'
import type { MetricRow } from '../metric-store'

const requester = { userId: 'u', orgId: 'acme', channel: 'pat' as const, keyId: 1, scopes: [], hasScope: () => true }
const row = (over: Partial<MetricRow>): MetricRow => ({
  id: 'lemeng:retail:net_sales', title: '净销', description: '', requiredScope: null,
  subjectColumn: 'org', selectSql: 'select org from fct', groupBy: 'org, bizday', params: {},
  source: 'l1', sourceSystem: 'lemeng', updatedBy: null, version: 1, totalable: true,
  scopeNote: '', slaDays: 2, freshnessRelations: ['stg_a'], masks: null, ...over,
}) as MetricRow

function deps(over: Partial<ToolboxDeps> & { catalog?: MetricRow[] }): ToolboxDeps {
  const catalog = over.catalog ?? [row({})]
  return {
    pool: { query: async () => ({ rows: catalog.map((m) => ({ id: m.id, group_by: m.groupBy, sla_days: m.slaDays, freshness_relations: m.freshnessRelations })) }) } as never,
    org: 'acme', requester, adoptedSources: new Set(['lemeng']),
    wh: over.wh ?? (async () => ({ columns: [], rows: [] })),
    now: over.now ?? (() => new Date('2026-10-21T10:00:00+08:00')),
    dbtManifest: over.dbtManifest,
  }
}

describe('freshnessImpl', () => {
  it('scope=指标：链路水位 + status + line；滞后秒数由注入时钟计算', async () => {
    const d = deps({ wh: async (sql) => sql.includes('stg_a')
      ? { columns: ['watermark', 'materialized_at'], rows: [['2026-10-20', new Date('2026-10-21T02:10:00+08:00')]] }
      : { columns: [], rows: [] } })
    const out = await freshnessImpl(d, { scope: 'lemeng:retail:net_sales' })
    const p = out.payload as { dataThrough?: string; freshness_status?: string; line?: string; freshnessLagSeconds?: number }
    expect(p.dataThrough).toBe('2026-10-20')
    expect(p.freshness_status).toBe('normal')
    expect(p.line).toContain('10月20日')
    expect(p.freshnessLagSeconds).toBe(28_200)
  })
  it('无链路/水位缺失 ⇒ 字段缺席（不编造日期）', async () => {
    const out = await freshnessImpl(deps({ catalog: [row({ freshnessRelations: null, slaDays: null })] }), { scope: 'lemeng:retail:net_sales' })
    expect('dataThrough' in out.payload).toBe(false)
  })
  it('缺省 scope ⇒ 全局水位（内存 min/max）', async () => {
    const d = deps({ wh: async (sql) => sql.includes('distinct on')
      ? { columns: ['relation', 'max_bizday', 'materialized_at'], rows: [['a', '2026-10-19', new Date('2026-10-21T01:00:00+08:00')], ['b', '2026-10-20', new Date('2026-10-21T02:00:00+08:00')]] }
      : { columns: [], rows: [] } })
    const out = await freshnessImpl(d, {})
    expect((out.payload as { dataThrough?: string }).dataThrough).toBe('2026-10-19')  // 木桶短板
  })
})

describe('qualityImpl / lineageImpl：seam 缺席 = 显式 unknown', () => {
  it('seam 缺席 ⇒ unknown + reason，isError=false', async () => {
    const q = await qualityImpl(deps({}), { model: 'fct_x' })
    expect(q.isError).toBe(false)
    expect(q.payload).toMatchObject({ status: 'unknown', reason: 'dbt_manifest_unavailable' })
    const l = await lineageImpl(deps({}), { id: 'fct_x' })
    expect(l.payload).toMatchObject({ status: 'unknown', reason: 'dbt_manifest_unavailable', id: 'fct_x' })
  })
  it('depth 非法 ⇒ bad_param/invalid_depth；有界展开去重', async () => {
    expect((await lineageImpl(deps({}), { id: 'x', depth: 4 })).payload)
      .toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_depth' })
  })
  it('有 manifest ⇒ upstream/downstream 有界、去重、不含自身', async () => {
    const raw = {
      nodes: {
        'model.d.stg': { resource_type: 'model', depends_on: { nodes: [] }, name: 'stg' },
        'model.d.fct': { resource_type: 'model', depends_on: { nodes: ['model.d.stg'] }, name: 'fct' },
        'model.d.mart': { resource_type: 'model', depends_on: { nodes: ['model.d.fct'] }, name: 'mart' },
        'test.d.t1': { resource_type: 'test', depends_on: { nodes: ['model.d.fct'] }, name: 't1' },
      },
      child_map: { 'model.d.stg': ['model.d.fct'], 'model.d.fct': ['model.d.mart', 'test.d.t1'], 'model.d.mart': [], 'test.d.t1': [] },
    }
    const d = deps({ dbtManifest: async () => raw })
    const out = await lineageImpl(d, { id: 'fct', depth: 2 })
    const p = out.payload as { status: string; upstream: string[]; downstream: string[] }
    expect(p.status).toBe('ok')
    expect(p.upstream).toEqual(['stg'])
    expect(p.downstream).toEqual(['mart', 't1'])
    const q = await qualityImpl(d, { model: 'fct' })
    expect(q.payload).toMatchObject({ status: 'ok', model: 'fct', testsDeclared: 1 })
  })
})

describe('parseDbtManifest / defaultDbtManifest', () => {
  it('坏形状 ⇒ null；缺 env ⇒ async ()=>null', async () => {
    expect(parseDbtManifest(null)).toBeNull()
    expect(parseDbtManifest({ nodes: 42 })).toBeNull()
    const loader = defaultDbtManifest({})
    expect(await loader()).toBeNull()
    expect(typeof defaultDbtManifest({ DATA_DBT_MANIFEST_PATH: '/no/such/file.json' })()).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/health.test.ts`
Expected: FAIL——`Cannot find module './health'`

- [ ] **Step 3: 实现**

```ts
// health.ts —— 健康面三工具（spec §5 后三行；§11 未决 #2 默认：血缘/质量读 dbt manifest）。
// 「无结论必须显式未知」（spec §5 get_quality 验收锚）：seam 缺席/坏形状一律 unknown——
// 未知 ≠ 通过 ≠ 编数字。manifest 投递链（随 data-plane.lock）未验证，待真机案例沉淀。
import { visibleMetrics } from '../authz'
import { loadMergedCatalog, type MetricRow } from '../metric-store'
import { freshnessLineOf, freshnessStatusOf, watermarkSqlFor } from '../query-service'
import { readFileSync } from 'node:fs'
import type { ToolImpl, ToolImplResult, ToolboxDeps } from './registry'

export interface DbtManifestView {
  dependsOnOf(model: string): string[]
  childrenOf(name: string): string[]
  testCountOf(model: string): number
}

type ManifestNode = { resource_type?: string; name?: string; depends_on?: { nodes?: unknown } }

export function parseDbtManifest(raw: unknown): DbtManifestView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const nodesRaw = (raw as { nodes?: unknown }).nodes
  if (typeof nodesRaw !== 'object' || nodesRaw === null) return null
  const nodes = new Map<string, ManifestNode>()
  for (const [k, v] of Object.entries(nodesRaw as Record<string, unknown>)) {
    if (typeof v === 'object' && v !== null) nodes.set(k, v as ManifestNode)
  }
  const childMap = new Map<string, string[]>()
  const cm = (raw as { child_map?: unknown }).child_map
  if (typeof cm === 'object' && cm !== null) {
    for (const [k, v] of Object.entries(cm as Record<string, unknown>)) {
      if (Array.isArray(v)) childMap.set(k, v.filter((x): x is string => typeof x === 'string'))
    }
  }
  const byName = (name: string): string[] | null => {
    let key: string | undefined
    for (const [k, n] of nodes) if (n.name === name) { key = k; break }
    if (key === undefined) return null
    const depsRaw = nodes.get(key)?.depends_on?.nodes
    return Array.isArray(depsRaw) ? depsRaw.filter((x): x is string => typeof x === 'string') : []
  }
  const keyOf = (name: string): string | null => {
    for (const [k, n] of nodes) if (n.name === name) return k
    return null
  }
  return {
    dependsOnOf: (model) => byName(model) ?? [],
    childrenOf: (name) => {
      const key = keyOf(name)
      return key === null ? [] : childMap.get(key) ?? []
    },
    testCountOf: (model) => (childMap.get(keyOf(model) ?? '') ?? [])
      .filter((k) => nodes.get(k)?.resource_type === 'test').length,
  }
}

export function defaultDbtManifest(env: Record<string, string | undefined> = process.env): () => Promise<unknown> {
  const p = env.DATA_DBT_MANIFEST_PATH?.trim()
  if (!p) return async () => null
  return async () => {
    try { return parseDbtManifest(JSON.parse(readFileSync(p, 'utf8'))) } catch { return null }
  }
}

const WATERMARK_RE = /^\d{4}-\d{2}-\d{2}$/
/** 全局水位 SQL（先按关系取最新一行再聚合——#844 同语义；metrics 级走 watermarkSqlFor）。 */
const GLOBAL_LATEST_SQL = "select distinct on (relation) relation, max_bizday, materialized_at from data.load_log where status = 'ok' and relation is not null order by relation, materialized_at desc"
const dayMsOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}
const shanghaiToday = (now: () => Date): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now())

const unknownOf = (reason: string, extra: Record<string, unknown> = {}): ToolImplResult => ({
  payload: { status: 'unknown', reason, ...extra }, isError: false, auditRowCount: null,
})

export const freshnessImpl: ToolImpl = async (deps, args) => {
  const now = deps.now ?? (() => new Date())
  const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
  if (scope === null) {
    // 全局支：最新物化时刻（max materialized_at）+ 全量关系水位（木桶短板）
    try {
      const latest = await deps.wh(GLOBAL_LATEST_SQL)
      const marks: string[] = []
      let lastRun: Date | null = null
      for (const row of latest.rows) {
        if (typeof row[1] === 'string' && WATERMARK_RE.test(row[1])) marks.push(row[1])
        if (row[2] instanceof Date) lastRun = lastRun === null || row[2] > lastRun ? row[2] : lastRun
      }
      const min = [...marks].sort()[0]
      if (min === undefined) return unknownOf('no_load_log')
      const asOf: Record<string, unknown> = { scope: 'global', dataThrough: min, watermark: min }
      if (lastRun !== null) {
        asOf.lastDbtRun = lastRun
        asOf.freshnessLagSeconds = Math.max(0, Math.floor((now().getTime() - lastRun.getTime()) / 1000))
      }
      return { payload: asOf, isError: false, auditRowCount: null }
    } catch {
      return unknownOf('load_log_unavailable')
    }
  }
  // 指标支：可见词表（裁剪走 visibleMetrics）→ 链路水位 + 状态 + 固定展示行（与 query-service 同源判据）
  if (deps.requester === null) return { payload: { status: 'denied', reason: 'unauthenticated' }, isError: true, auditRowCount: null }
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const m = visibleMetrics(all, deps.requester, deps.adoptedSources).find((x) => x.id === scope)
  if (m === undefined) return unknownOf('scope_not_found', { scope })
  const relations = Array.isArray(m.freshnessRelations) ? m.freshnessRelations.filter((r) => r !== '') : []
  if (m.slaDays === null || relations.length === 0) return unknownOf('no_freshness_chain', { scope })
  try {
    const r = await deps.wh(watermarkSqlFor(relations))
    const w = r.rows[0]?.[0]
    const matAt = r.rows[0]?.[1]
    if (typeof w !== 'string' || !WATERMARK_RE.test(w) || !(matAt instanceof Date)) {
      return unknownOf('watermark_unavailable', { scope })
    }
    const today = shanghaiToday(now)
    const fs = freshnessStatusOf(w, m.slaDays, today)
    return {
      payload: {
        status: 'ok', scope, dataThrough: w, watermark: w,
        freshnessLagSeconds: Math.max(0, Math.floor((now().getTime() - matAt.getTime()) / 1000)),
        lastDbtRun: matAt, freshness_status: fs, line: freshnessLineOf(fs, w, matAt, today),
      },
      isError: false, auditRowCount: null,
    }
  } catch {
    return unknownOf('watermark_unavailable', { scope })
  }
}

/** seam 读取：注入优先；缺省走 defaultDbtManifest({})——**空 env**（确定性 null），不偷读进程 env。 */
const seamOf = async (deps: ToolboxDeps): Promise<DbtManifestView | null> => {
  const load = deps.dbtManifest ?? defaultDbtManifest({})
  let raw: unknown = null
  try { raw = await load() } catch { return null }
  return raw === null ? null : parseDbtManifest(raw)
}

export const qualityImpl: ToolImpl = async (deps, args) => {
  const model = typeof args.model === 'string' && args.model !== '' ? args.model : null
  const view = await seamOf(deps)
  if (view === null) return unknownOf('dbt_manifest_unavailable')
  return {
    payload: {
      status: 'ok', ...(model !== null ? { model, testsDeclared: view.testCountOf(model) } : {}),
      note: '声明清单来自 dbt manifest；最近一次运行的结论不在本数据源内——没有结论 ≠ 通过。',
    },
    isError: false, auditRowCount: null,
  }
}

export const lineageImpl: ToolImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  const depth = args.depth === undefined ? 1 : args.depth
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 3) {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'invalid_depth' }, isError: true, auditRowCount: null }
  }
  const view = await seamOf(deps)
  if (view === null) return unknownOf('dbt_manifest_unavailable', { id })
  const expand = (step: (name: string) => string[]): string[] => {
    let frontier = new Set([id])
    const seen = new Set([id])
    const out = new Set<string>()
    for (let i = 0; i < depth; i++) {
      const next = new Set<string>()
      for (const n of frontier) {
        for (const x of step(n)) if (!seen.has(x)) { seen.add(x); out.add(x); next.add(x) }
      }
      frontier = next
    }
    return [...out]
  }
  return {
    payload: {
      status: 'ok', id,
      upstream: expand((n) => view.dependsOnOf(n)),
      downstream: expand((n) => view.childrenOf(n)),
    },
    isError: false, auditRowCount: null,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/health.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/health.ts modules/data/domain/toolbox/health.test.ts .env.example
git commit -m "feat(data): 健康面三工具——新鲜度/质量/血缘，无结论显式未知（seam + manifest 路径） (#<ISSUE>)"
```

---

### Task 10: query.ts —— preview_query / query_metric（信封）

**Files:**
- Create: `modules/data/domain/toolbox/query.ts`
- Create: `modules/data/domain/toolbox/query.test.ts`

**Interfaces:**
- Consumes: T2 `buildEnvelope`；T3 `SlicingSpec`；T6 `runQuery`（`tool`/`warehouseExec`/`slicing`/`QueryOk.audit`）；T1 `ToolboxDeps`；`loadMergedCatalog/visibleMetrics/MetricRow`。
- Produces:
  - `export const previewImpl: ToolImpl`——`args {metricId, args?, slicing?}`。合并 `args` 与 `slicing.filters` 后**先**做保留键预检（与 authorize 同拒绝语义，提前给出信封外形态不必）——直接调 `authorize(visible 可见词表裁剪同 runQuery 口径)`? **否**：预览必须复用 runQuery 同一条裁剪+授权链。实现：`runQuery` 无「只计划不执行」模式 ⇒ preview 调 `loadMergedCatalog + visibleMetrics + authorize(..., slicing)`（与 runQuery 相同的三行调用序，拒绝链同源），ok ⇒ `{status:'ok', metricId, sql: plan.sql, params: 合并后 args, estimatedRows: LIMIT 上界解析自 sql 尾部 LIMIT n, warnings: ['estimatedRows 是行数上限（LIMIT），不是统计估计', ...(切片且 total 未请求 ? ['切片后未请求 total：部分合计≠全局合计'] : [])], subject: plan.subject}`；`auditRowCount: null`。denied ⇒ `{status:'denied', ...}` isError。**全程 0 次 `deps.wh` 调用**（测试断言）。
  - `export const queryMetricImpl: ToolImpl`——`args {metricId, args?, dimensions?, filters?, orderBy?, limit?, total?}` → 组装 `SlicingSpec`（`filters` 在 args 里时也接受平铺：`args` 键与 `filters` 键合并，重复键以 `filters` 为准）→ `runQuery(deps-ish, deps.org, deps.requester, metricId, mergedArgs, slicing)`，其中 deps 构造 `{ pool: deps.pool, execute: deps.wh, warehouseExec: deps.wh, adoptedSources: deps.adoptedSources, tool: 'query_metric' }`。ok ⇒ 信封：
    - `metric`: `{id, version, definitionHash: 'sha256:'+sha256(selectSql+JSON.stringify(params)), tier: tierOf, owner: ownerOf, title}`
    - `subject`: `{org: ok.subject, source: metricRow.sourceSystem ?? deps.org, adoptedSources: [...deps.adoptedSources]}`
    - `asOf`: `{dataThrough: ok.watermark, freshnessLagSeconds?, lastDbtRun: ok.data_as_of, tests?}`——各字段按 QueryOk 相应字段在场才带
    - `query`: `{sql: plan?}`——⚠️ runQuery 不回 plan.sql；`query.sql` 以**预览同法**再算一次计划（同参数 ⇒ 同 SQL，授权确定性），或改 QueryOk 带 sql——**决策：runQuery 的 QueryOk 增 `sql?: string`（T6 已在 ok 出口从 `authz.plan.sql` 透传——T6 交付物补充此项），queryMetricImpl 直接用 `ok.sql`**
    - `result`: `{columns, rows, rowCount: rows.length, truncated, ...(total 在场 ? {total} : {})}`
    - `lineage`: `deps.dbtManifest` 可解析且 metricRow 有对应 dbt 模型名（`selectSql` 首个 `from <schema>.<name>` 提取，正则 `/from\s+[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)/i`）⇒ `{model, upstream: dependsOnOf(model)}`；否则缺席
    - `audit`: `{id: ok.audit.id, ts: ok.audit.ts}`
    - `auditMetricId: metricId`、`auditRowCount: rows.length`
    denied/error ⇒ payload 原样（runQuery 的 QueryDenied/QueryError 即错误体）、isError=true（error 也保持 runQuery 的 reason/detail）。
  - ⚠️ T6 交付物补充一条：`QueryOk` 增 `sql?: string`（ok 出口 `sql: authz.plan.sql`）。T10 在其测试中钉住（若 T6 漏了，本任务补上并回归 query-service.test.ts）。

- [ ] **Step 1: 写失败测试**

```ts
// query.test.ts — 数值面：preview 零仓库调用；query_metric 信封逐字段；拒绝透传。
// 不 mock runQuery 本身：真 runQuery + 假 execute/warehouseExec/假平台池（query-service.test.ts 同手法）。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { previewImpl, queryMetricImpl } from './query'
import type { ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1,
  scopes: ['data:query'], hasScope: (c) => c === 'data:query',
}

const SELECT_SQL = 'select org, bizday, sum(v) as value from marts.fct_retail_sale group by org, bizday'

/** 平台库假池：词表一行 net_sales（l1/lemeng/totalable/无掩码）；其余 SQL（审计 insert 等）回固定 id=77。 */
const catalogPool = () => ({
  query: async (sql: string) => sql.includes('from data.metrics')
    ? { rows: [{
        id: 'lemeng:retail:net_sales', title: '净销', description: '净销售额', required_scope: null,
        subject_column: 'org', select_sql: SELECT_SQL, group_by: 'org, bizday', params: {},
        source: 'l1', source_system: 'lemeng', updated_by: null, version: 3, totalable: true,
        scope_note: '', sla_days: null, freshness_relations: null, mask_spec: null,
      }] }
    : { rows: [{ id: 77, created_at: new Date('2026-10-21T10:00:00Z') }] },
}) as never

function deps(wh: ToolboxDeps['wh'], dbt?: ToolboxDeps['dbtManifest']): ToolboxDeps {
  return {
    pool: catalogPool(), org: 'acme', requester, adoptedSources: new Set(['lemeng']), wh,
    ...(dbt !== undefined ? { dbtManifest: dbt } : {}),
    now: () => new Date('2026-10-21T10:00:00+08:00'),
  }
}

describe('previewImpl：只编译不执行（0 次仓库查询）', () => {
  it('回 sql/estimatedRows/warnings/subject；deps.wh 零调用', async () => {
    const whCalls: string[] = []
    const d = deps(async (sql) => { whCalls.push(sql); return { columns: [], rows: [] } })
    const out = await previewImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    const p = out.payload as { sql: string; estimatedRows: number; warnings: string[]; subject: string }
    expect(p.sql).toContain("WHERE org = 'acme'")
    expect(p.estimatedRows).toBe(1000)
    expect(p.warnings[0]).toContain('上限')
    expect(p.subject).toBe('acme')
    expect(whCalls).toHaveLength(0)
  })
  it('保留键拒（subject_pinned_by_platform）——与 runQuery 同拒绝链', async () => {
    const out = await previewImpl(
      deps(async () => ({ columns: [], rows: [] })),
      { metricId: 'lemeng:retail:net_sales', args: { org: 'x' } },
    )
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'subject_pinned_by_platform' })
  })
})

describe('queryMetricImpl：完整信任信封', () => {
  const wh = async (): Promise<{ columns: string[]; rows: unknown[][] }> => ({
    columns: ['org', 'bizday'], rows: [['acme', '2026-10-20']],
  })
  const manifestDep: ToolboxDeps['dbtManifest'] = async () => ({
    dependsOnOf: (m: string) => (m === 'fct_retail_sale' ? ['stg_lemeng_retail_order_line'] : []),
    childrenOf: () => [], testCountOf: () => 0,
  })

  it('信封七节（本例 load_log/水位缺席 ⇒ asOf 缺席——可辨不编造）', async () => {
    const d = deps(wh, manifestDep)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect(out.isError).toBe(false)
    const env = out.payload as Record<string, Record<string, unknown>>
    expect(env.status).toBe('ok')
    expect(env.metric).toMatchObject({ id: 'lemeng:retail:net_sales', version: 3, tier: 'certified', owner: 'data-platform', title: '净销' })
    expect(env.metric.definitionHash).toBe('sha256:' + createHash('sha256').update(SELECT_SQL + '{}').digest('hex'))
    expect(env.subject).toMatchObject({ org: 'acme', source: 'lemeng', adoptedSources: ['lemeng'] })
    expect('asOf' in env).toBe(false)
    expect(env.query).toMatchObject({ rowLimit: 1000, queryId: 'q_77' })
    expect(env.result).toMatchObject({ rowCount: 1, truncated: false })
    expect(env.lineage).toMatchObject({ model: 'fct_retail_sale', upstream: ['stg_lemeng_retail_order_line'] })
    expect(env.audit).toMatchObject({ id: 77 })
    expect(out.auditMetricId).toBe('lemeng:retail:net_sales')
    expect(out.auditRowCount).toBe(1)
  })

  it('切片请求生效（dimensions → 外层聚合 SQL）；未知指标 denied 透传', async () => {
    const seen: string[] = []
    const d = deps(async (sql) => { seen.push(sql); return { columns: ['org'], rows: [['acme']] } }, manifestDep)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales', dimensions: ['org'] })
    expect(out.isError).toBe(false)
    expect(seen[0]).toContain('sum(value) as value')
    const bad = await queryMetricImpl(d, { metricId: 'nope' })
    expect(bad.isError).toBe(true)
    expect(bad.payload).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
  })

  it('血缘源缺席 ⇒ 信封 lineage 节缺席（可辨，不编）', async () => {
    const d = deps(wh, async () => null)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect('lineage' in (out.payload as Record<string, unknown>)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/toolbox/query.test.ts`
Expected: FAIL——`Cannot find module './query'`

- [ ] **Step 3: 实现**（按测试逐字；两个 impl 都走「真 runQuery + deps.wh 注入」路径，不 mock runQuery 本身）

```ts
// query.ts —— 数值面：preview_query（只编译不执行）/ query_metric（完整信任信封）。
// ★ 不另起执行路径（决策 D6）：queryMetricImpl 调 runQuery（tool/warehouseExec/slicing 全透传），
//   掩码/审计/新鲜度/维度名称/竞态重试全部复用，信封只是包装；preview 复用同一条
//   「合并词表 → visibleMetrics → authorize」链（与 runQuery 同序），只算计划、零仓库调用。
import { createHash } from 'node:crypto'
import { authorize, MAX_QUERY_ROWS, visibleMetrics, type SlicingSpec } from '../authz'
import { loadMergedCatalog, type MetricRow } from '../metric-store'
import { runQuery, type QueryOk } from '../query-service'
import { buildEnvelope } from './envelope'
import type { ToolImpl, ToolboxDeps } from './registry'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const tierOf = (m: MetricRow): 'certified' | 'custom' => (m.source === 'l1' ? 'certified' : 'custom')
const ownerOf = (m: MetricRow, org: string): string => (m.source === 'l1' ? 'data-platform' : org)
/** selectSql 首个 `from <schema>.<name>` 的模型名（血缘 seam 的键）。 */
const modelOf = (selectSql: string): string | null => {
  const m = /from\s+[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)/i.exec(selectSql)
  return m?.[1] ?? null
}

/** 工具面平铺键 → SlicingSpec；filters 并入 args 由 runQuery→authorize 统一校验（保留键/类型）。 */
function slicingOf(args: Record<string, unknown>): { slicing: SlicingSpec | undefined; mergedArgs: Record<string, unknown> } {
  const rawArgs = typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
    ? args.args as Record<string, unknown> : {}
  const filters = typeof args.filters === 'object' && args.filters !== null && !Array.isArray(args.filters)
    ? args.filters as Record<string, unknown> : undefined
  const hasSlice = args.dimensions !== undefined || filters !== undefined || args.orderBy !== undefined
    || args.limit !== undefined || args.total !== undefined
  const slicing: SlicingSpec | undefined = hasSlice
    ? {
        ...(Array.isArray(args.dimensions) ? { dimensions: args.dimensions.filter((x): x is string => typeof x === 'string') } : {}),
        ...(filters !== undefined ? { filters } : {}),
        ...(args.orderBy !== undefined ? { orderBy: args.orderBy as SlicingSpec['orderBy'] } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
        ...(args.total !== undefined ? { total: args.total === true } : {}),
      }
    : undefined
  return { slicing, mergedArgs: { ...rawArgs, ...(filters ?? {}) } }
}

const visibleOf = async (deps: ToolboxDeps) => {
  if (deps.requester === null) return []
  return visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources)
}

export const previewImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const { slicing, mergedArgs } = slicingOf(args)
  if (deps.requester === null) {
    return { payload: { status: 'denied', reason: 'unauthenticated', metricId }, isError: true, auditMetricId: metricId, auditRowCount: null }
  }
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const catalog = visibleMetrics(all, deps.requester, deps.adoptedSources)
  const authz = authorize(catalog, deps.requester, metricId, mergedArgs, all, slicing)
  if (!authz.ok) {
    return {
      payload: { status: 'denied', reason: authz.reason, ...(authz.detail !== undefined ? { detail: authz.detail } : {}), metricId },
      isError: true, auditMetricId: metricId, auditRowCount: null,
    }
  }
  const capMatch = /LIMIT (\d+)$/.exec(authz.plan.sql)
  return {
    payload: {
      status: 'ok', metricId, sql: authz.plan.sql, params: mergedArgs,
      estimatedRows: capMatch === null ? MAX_QUERY_ROWS : Number(capMatch[1]),
      warnings: [
        'estimatedRows 是行数上限（LIMIT 语义），不是统计估计——实际行数以 query_metric 回包为准。',
        ...(slicing !== undefined && slicing.total !== true ? ['切片后未请求 total：部分合计≠全局合计。'] : []),
      ],
      subject: authz.plan.subject,
    },
    isError: false, auditMetricId: metricId, auditRowCount: null,
  }
}

export const queryMetricImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const { slicing, mergedArgs } = slicingOf(args)
  const outcome = await runQuery(
    { pool: deps.pool, execute: deps.wh, warehouseExec: deps.wh, adoptedSources: deps.adoptedSources, tool: 'query_metric' },
    deps.org, deps.requester, metricId, mergedArgs, slicing,
  )
  if (outcome.status !== 'ok') {
    return { payload: outcome as unknown as Record<string, unknown>, isError: true, auditMetricId: metricId, auditRowCount: null }
  }
  const ok = outcome as QueryOk & { sql?: string }
  const metricRow = (await visibleOf(deps)).find((m) => m.id === metricId)
  const model = metricRow === undefined ? null : modelOf(metricRow.selectSql)
  let lineage: Record<string, unknown> | undefined
  if (metricRow !== undefined && model !== null) {
    // seam 缺省 = 恒 null（空 env 的 defaultDbtManifest 语义）；读失败吞成 null = lineage 缺席
    const view = await (deps.dbtManifest ?? (async () => null))().catch(() => null) as { dependsOnOf(m: string): string[] } | null
    if (view !== null) lineage = { model, upstream: view.dependsOnOf(model) }
  }
  const asOf: Record<string, unknown> = {}
  if (ok.watermark !== undefined) asOf.dataThrough = ok.watermark
  if (typeof ok.data_as_of === 'string') {
    asOf.lastDbtRun = ok.data_as_of
    const t = Date.parse(ok.data_as_of.replace(' ', 'T').replace(' ', ''))
    if (!Number.isNaN(t)) {
      asOf.freshnessLagSeconds = Math.max(0, Math.floor((((deps.now ?? (() => new Date()))().getTime()) - t) / 1000))
    }
  }
  const payload = buildEnvelope({
    ...(metricRow !== undefined ? {
      metric: {
        id: metricRow.id, version: metricRow.version,
        definitionHash: `sha256:${sha256(metricRow.selectSql + JSON.stringify(metricRow.params))}`,
        tier: tierOf(metricRow), owner: ownerOf(metricRow, deps.org), title: metricRow.title,
      },
    } : {}),
    subject: { org: ok.subject, source: metricRow?.sourceSystem ?? deps.org, adoptedSources: [...deps.adoptedSources] },
    ...(Object.keys(asOf).length > 0 ? { asOf } : {}),
    query: {
      sql: ok.sql ?? '', params: mergedArgs,
      ...(slicing?.dimensions !== undefined ? { dimensions: slicing.dimensions } : {}),
      rowLimit: MAX_QUERY_ROWS,
      ...(ok.audit !== undefined ? { queryId: `q_${ok.audit.id}` } : {}),
    },
    result: {
      columns: ok.columns, rows: ok.rows, rowCount: ok.rows.length, truncated: ok.truncated,
      ...(ok.total !== undefined ? { total: ok.total } : {}),
    },
    ...(lineage !== undefined ? { lineage } : {}),
    ...(ok.audit !== undefined ? { audit: ok.audit } : {}),
  })
  return { payload, isError: false, auditMetricId: metricId, auditRowCount: ok.rows.length }
}
```

> 实现注记：`asOf.dataThrough` 语义 = 水位（业务日）；`freshnessLagSeconds` 只在 `data_as_of` 为可解析时间串时计算——`QueryOk.data_as_of` 是格式化串（`YYYY-MM-DD HH:mm:ss +08:00`），两段 replace 拼回 ISO 后 `Date.parse`，解析失败该字段缺席。`QueryOk.sql` 由 T6 交付（见 Interfaces ⚠️）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/toolbox/query.test.ts domain/query-service.test.ts && pnpm --filter data typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/query.ts modules/data/domain/toolbox/query.test.ts modules/data/domain/query-service.ts modules/data/domain/query-service.test.ts
git commit -m "feat(data): 数值面 preview/query_metric——信任信封包装 runQuery，不分叉执行路径 (#<ISSUE>)"
```

---

### Task 11: mcp.ts / mcp-rpc.ts / all.ts / manifest —— 读面 registry 驱动 + 协议整改

**Files:**
- Create: `modules/data/domain/toolbox/all.ts`
- Modify: `modules/data/routes/mcp-rpc.ts`（PROTOCOL_VERSION / structured 透传）
- Modify: `modules/data/routes/mcp.ts`（读面 toolset 重写）
- Modify: `modules/data/manifest.yaml`（permissions 收录 `data:read`；api.internal **不动**——决策 D1）
- Modify: `modules/data/routes/mcp.test.ts`（追加分析师面用例段）

**Interfaces:**
- Consumes: T1–T10 全部产出。装配：
  - `toolbox/all.ts`：
    ```ts
    // all.ts —— 分析师面 impl 的**显式注册点**（/mcp 装配唯一入口）。
    // registry.ts 保持纯（T12 门禁直接 import）；impl 在这里逐个 registerImpl——
    // 重复注册即抛（registry 的契约），模块只被 import 一次（mcp.ts）。
    import { registerImpl } from './registry'
    import { guideImpl, harnessCatalogImpl } from './guide'
    import { searchImpl, describeMetricImpl, describeDatasetImpl, sampleDimensionValuesImpl } from './discovery'
    import { freshnessImpl, qualityImpl, lineageImpl } from './health'
    import { previewImpl, queryMetricImpl } from './query'

    registerImpl('data_agent_guide', guideImpl)
    registerImpl('data_harness_catalog', harnessCatalogImpl)
    registerImpl('search_catalog', searchImpl)
    registerImpl('describe_metric', describeMetricImpl)
    registerImpl('describe_dataset', describeDatasetImpl)
    registerImpl('sample_dimension_values', sampleDimensionValuesImpl)
    registerImpl('get_freshness', freshnessImpl)
    registerImpl('get_quality', qualityImpl)
    registerImpl('get_lineage', lineageImpl)
    registerImpl('preview_query', previewImpl)
    registerImpl('query_metric', queryMetricImpl)
    ```
  - `mcp-rpc.ts`：`PROTOCOL_VERSION = '2025-11-25'`（注释保留旧值出处与「客户端自行协商降级」语义）；`McpToolResult` 增 `structured?: Record<string, unknown>`；tools/call 回包 `...(out.structured !== undefined ? { structuredContent: out.structured } : {})`；`McpDeps` 增 `wh?: SqlExecutor`（**测试缝**：装配处 `wh: ctx.execute`——生产为 undefined，消费方落到只读池；与既有 `execute` 缝同一形态）。
  - `mcp.ts` 读面 toolset 重写：
    - `list(deps)`：`deps.requester === null` ⇒ `[]`（M3 守卫，词表加载之前——既有顺序不变）；否则 `[...legacyMetricTools(合并词表, requester, adoptedSources).map(x => x.tool), ...listAnalystTools().map(tools/list 条目形态)]`。分析师面条目 = `{name,title,description,inputSchema,outputSchema,annotations}`（ToolMeta 透传，**不含** requiredScope/mutating/group——非 MCP 规范字段不外泄；`data_harness_catalog` 才是完整声明面的出口）。
    - `call(deps, name, args)`：
      1. `ANALYST_TOOLS.some(t => t.name === name)` ⇒ 走 `callTool`（ToolboxDeps 组装：`{pool, org, requester, adoptedSources, wh: ctx.execute ?? 只读池执行器, dbtManifest: defaultDbtManifest(), allowMutating: mutatingAllowed(process.env)}`）⇒ 返回 `{ text: JSON.stringify(out.payload), isError: out.isError, structured: out.isError ? undefined : out.payload }`；
      2. 否则 legacy：`/^[A-Za-z0-9_.-]+$/.test(name)` 且能从「本轮可见词表的 sanitized 映射」反解出 metricId（用 `legacyMetricTools(...)` 重建映射——与 list 同一函数，无第二份映射）⇒ `runQuery({pool, execute: ctx.execute, warehouseExec: 只读池执行器, adoptedSources, tool: name}, org, requester, metricId, args)` ⇒ `{text: JSON.stringify(out), isError: out.status !== 'ok', structured: out.status === 'ok' ? out as unknown as Record<string, unknown> : undefined}`；
      3. 反解不出 ⇒ `{ text: JSON.stringify({ status: 'denied', reason: 'unknown_tool', name }), isError: true }`（与 manage 面兜底同形）。
    - `wh` 缺省执行器：`(sql) => runWarehouseSql(analystPool(), sql)`（T4；import 自 `../domain/warehouse`）。`RouteCtx.execute` 是既有测试缝——注入时主计划与辅助读全走假执行器（现 mcp.test.ts 的测试形态不变）。
  - `manifest.yaml`：permissions 追加（api.internal 与 routes 不动 ⇒ 装载期双向核对不触发）：
    ```yaml
      # 数据探索（spec 2026-10-21 §8）：清单/描述/健康类工具的声明面码。
      # ⚠️ Wave 1 端点门仍是 data:query（/mcp）——本码先收录进清单（可授予、可审计），
      #    端点级 read/query 分离留人工裁决（计划决策 D1：一端点一 scope 的正典约束）。
      - { code: data:read,   name: 数据探索 }
    ```

- [ ] **Step 1: 写失败测试**（`mcp.test.ts` 追加）

```ts
// mcp.test.ts 追加 —— 分析师面：协议整改 + registry 驱动 + 信封 + 审计 tool。
describe('POST /mcp 分析师面（协议 2025-11-25 + registry 驱动）', () => {
  it('initialize 回 2025-11-25', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const body = await res.json()
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  itDescribePg('tools/list：11 个分析师面工具在（带 annotations/outputSchema）、legacy 指标工具名 sanitized', async () => {
    const app = await seededApp({ execute })
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (await res.json()).result.tools as { name: string; annotations?: { readOnlyHint?: boolean }; outputSchema?: unknown }[]
    const names = tools.map((t) => t.name)
    for (const t of ['data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric', 'query_metric', 'get_freshness']) {
      expect(names).toContain(t)
    }
    // legacy：sales_daily（无冒号 id 名不变）；带冒号的指标走 sanitize
    expect(names).toContain('sales_daily')
    const guide = tools.find((t) => t.name === 'data_agent_guide')!
    expect(guide.annotations?.readOnlyHint).toBe(true)
    expect(guide.outputSchema).toBeDefined()
    // M3：空身份 ⇒ 两类工具都看不见（同一 fail-closed 出口）
  })

  itDescribePg('tools/call data_agent_guide ⇒ structuredContent 在场、isError=false、审计带 tool', async () => {
    const app = await seededApp({ execute })
    const res = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'data_agent_guide', arguments: {} } })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    expect(body.result.structuredContent.status).toBe('ok')
    expect(typeof body.result.structuredContent.workflow).toBe('string')
    const audit = await pool.query("select tool, metric_id, row_count from data.query_audit where org = $1 and verdict = 'ok' order by id desc limit 1", [ORG])
    expect(audit.rows[0]).toMatchObject({ tool: 'data_agent_guide', metric_id: '', row_count: null })
  })

  itDescribePg('tools/call query_metric（切片）⇒ 信封 structuredContent；主体钉死回声', async () => {
    const app = await seededApp({ execute })
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'query_metric', arguments: { metricId: 'sales_daily', args: { day_from: '2026-08-15' } } },
    })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    const env = body.result.structuredContent as Record<string, Record<string, unknown>>
    expect(env.status).toBe('ok')
    expect(env.subject).toMatchObject({ org: ORG })
    expect(env.result).toMatchObject({ rowCount: 1 })
    expect(env.audit).toBeDefined()
  })

  itDescribePg('tools/call 未知工具 ⇒ denied/unknown_tool（并留审计）', async () => {
    const app = await seededApp({ execute })
    const res = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    expect((await res.json()).result.isError).toBe(true)
    expect(callTextOf((await res.json()) as never)).toMatchObject({ status: 'denied', reason: 'unknown_tool' })
  })

  itDescribePg('legacy 工具仍可用：sanitized 名反解回 metricId；structured 透传 runQuery 结果', async () => {
    const app = await seededApp({ execute })
    const res = await rpc(app, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sales_daily', arguments: { day_from: '2026-08-15' } } })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    expect(callTextOf(body)).toMatchObject({ status: 'ok', subject: ORG })
    expect(body.result.structuredContent.status).toBe('ok')
  })
})
```

> 测试注记：`itDescribePg` 不是新机制——直接把追加段写进既有 `describePg('POST /mcp 的方法面…')` 之内或新建一个同守卫的 `describePg` 段；`seededApp`/`rpc`/`callTextOf`/`execute` 均为本文件既有脚手架。带冒号指标的 sanitize 用例沿用 `RANGE_DAILY` 夹具（id 无冒号）不够——**新增一个带冒号 id 的夹具**（如 `acme:sales:v2`）断言 `tools/list` 出现 `acme__sales__v2` 且 `tools/call` 可用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run routes/mcp.test.ts`
Expected: 追加段 FAIL——`2025-11-25` 未回 / 分析师面工具缺席；**既有段 PASS（除 protocolVersion 字面量断言外——既有用例断言的是 `typeof === 'string'`，不受影响）**

- [ ] **Step 3: 实现**（mcp-rpc.ts / all.ts / manifest.yaml 按 Interfaces 逐条；mcp.ts 全量重写如下——头注同步改写：读面 = legacy 过渡面 + 分析师面，registry 驱动）

```ts
// mcp.ts — POST /mcp：通道 B（PAT）的**读面** MCP 端点（问数 + 分析师面）。
//
// Wave 1（spec 2026-10-21）起本面 = **registry 驱动**的两组工具：
//   · legacy 过渡面：每指标一工具（sanitized 名；与 query_metric 并存，未决 #1 观察后下线）；
//   · 分析师面：toolbox 的 11 个固定工具（guide/catalog/discovery/query/health）。
// 授权仍不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery / registry.callTool
// （保留键拒 / 未授权拒全部出自那条链——本文件不做第二份判定）。
import { loadMergedCatalog } from '../domain/metric-store'
import { runQuery } from '../domain/query-service'
import { analystPool, runWarehouseSql } from '../domain/warehouse'
import { defaultDbtManifest } from '../domain/toolbox/health'
import { callTool, legacyMetricTools, listAnalystTools, mutatingAllowed } from '../domain/toolbox/registry'
import type { ToolboxDeps } from '../domain/toolbox/registry'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpDeps, McpToolResult, McpToolSet } from './mcp-rpc'

/** 分析师面的仓库执行器：只读池（default_transaction_read_only=on）。测试经 McpDeps.wh 注入替身。 */
const readonlyWh = () => (sql: string) => runWarehouseSql(analystPool(), sql)

/**
 * 分析师面工具 → tools/list 条目。**非 MCP 规范字段不外泄**（requiredScope/mutating/group 只经
 * `data_harness_catalog` 的声明面输出）——工具面与声明面分开，前者按协议、后者按治理。
 */
function analystListEntries(): Record<string, unknown>[] {
  return listAnalystTools().map((t) => ({
    name: t.name, title: t.title, description: t.description,
    inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
  }))
}

const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',

  async list(deps) {
    // M3 守卫拒掉的请求者：词表对其「看不见」——空 tools（两类工具都空），不是报错。
    // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
    if (deps.requester === null) return []
    // 合并加载器（L1 ∪ 本 org）+ 源维度裁剪——与 /query、chat、GET /metrics 同一落点。
    const catalog = await loadMergedCatalog(deps.pool, deps.org)
    return [
      ...legacyMetricTools(catalog, deps.requester, deps.adoptedSources).map((x) => x.tool),
      ...analystListEntries(),
    ]
  },

  async call(deps, name, args): Promise<McpToolResult> {
    // ① 分析师面固定工具：registry.callTool 单点分发（mutating 闸 + 审计含拒绝/出错）。
    if (listAnalystTools().some((t) => t.name === name)) {
      const toolbox: ToolboxDeps = {
        pool: deps.pool, org: deps.org, requester: deps.requester, adoptedSources: deps.adoptedSources,
        wh: deps.wh ?? readonlyWh(),
        dbtManifest: defaultDbtManifest(),
        allowMutating: mutatingAllowed(process.env),
      }
      const out = await callTool(toolbox, name, args)
      return {
        text: JSON.stringify(out.payload), isError: out.isError,
        ...(out.isError ? {} : { structured: out.payload }),
      }
    }
    // ② legacy：sanitized 名反解回 metricId（与 list 同一 legacyMetricTools——无第二份映射）。
    if (deps.requester !== null) {
      const catalog = await loadMergedCatalog(deps.pool, deps.org)
      const hit = legacyMetricTools(catalog, deps.requester, deps.adoptedSources).find((x) => x.tool.name === name)
      if (hit !== undefined) {
        const out = await runQuery(
          {
            pool: deps.pool, execute: deps.execute, warehouseExec: deps.wh ?? readonlyWh(),
            adoptedSources: deps.adoptedSources, tool: name,
          },
          deps.org, deps.requester, hit.metricId, args,
        )
        return {
          text: JSON.stringify(out), isError: out.status !== 'ok',
          ...(out.status === 'ok' ? { structured: out as unknown as Record<string, unknown> } : {}),
        }
      }
    }
    // ③ 反解不出 ⇒ 工具级错误（与 manage 面兜底同形：工具级错误走 result + isError）
    return { text: JSON.stringify({ status: 'denied', reason: 'unknown_tool', name }), isError: true }
  },
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp', ctx, readToolset)
}
```

（配套：`mcp-rpc.ts` 的 deps 装配处补 `wh: ctx.execute` 一行——`RouteCtx.execute` 既是主计划的测试缝，也是分析师面 wh 的测试缝，两类测试注入一次即全覆盖。）

- [ ] **Step 4: 跑测试确认通过（含全包回归 + 装载期双向核对）**

Run: `pnpm --filter data test && pnpm --filter data typecheck && pnpm exec tsx scripts/check-manifests.mjs`
Expected: PASS（manifest 只加 permissions、不动 api.internal ⇒ 双向核对不触发；`pnpm --filter data test` 含 catalog-consumers/module.test 等全量回归）

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/all.ts modules/data/routes/mcp-rpc.ts modules/data/routes/mcp.ts modules/data/routes/mcp.test.ts modules/data/manifest.yaml
git commit -m "feat(data): /mcp 读面 registry 驱动——分析师面上线 + 协议 2025-11-25/structuredContent/data:read 收录 (#<ISSUE>)"
```

---

### Task 12: check-mcp-toolface.mjs —— CI 门（工具数/体积/命名/注解）

**Files:**
- Create: `scripts/check-mcp-toolface.mjs`
- Create: `scripts/check-mcp-toolface.test.ts`
- Modify: `.github/workflows/ci.yml`（gates job 追加一步）

**Interfaces:**
- Consumes: T1 的 `ANALYST_TOOLS / TOOL_NAME_RE / ANALYST_FACE_MAX_TOOLS / ANALYST_FACE_MAX_LIST_BYTES`（**显式 `.ts` 后缀 import**——本仓 tsconfig 已开 `allowImportingTsExtensions`，先例 `scripts/check-manifests.mjs` 引 SDK TS 源；脚本经 `pnpm exec tsx` 跑，tsx 解析 TS）。registry 的纯依赖约束（T1）保证这条 import 链不拉 pg。
- Produces:
  - `export function checkToolface(metas: readonly { name: string; mutating: boolean; annotations?: unknown; requiredScope: string | null }[], opts?: { maxTools?: number; maxBytes?: number }): string[]`——**判据纯函数**（违反项逐条中文说明，含 `[TOOLFACE]` 标签）：① `metas.length > maxTools`（缺省 14）⇒ 一条；② `JSON.stringify(metas).length > maxBytes`（缺省 10240）⇒ 一条；③ 名字不匹配 `/^[A-Za-z0-9_.-]+$/` ⇒ 逐个一条；④ `mutating === true` 且（`annotations` 缺席 或 `requiredScope` 为 null/空）⇒ 逐个一条。
  - `main`：对真仓 `ANALYST_TOOLS` 跑 `checkToolface`；干净 ⇒ stdout `check-mcp-toolface: OK`、exit 0；违规 ⇒ stderr 逐条、exit 1（契约同 `check-compose.mjs`）。

- [ ] **Step 1: 写失败测试**（`scripts/check-mcp-toolface.test.ts`；进 `pnpm run test:guard` 扫描面）

```ts
// scripts/check-mcp-toolface.test.ts — 门禁判据纯函数 + 对真仓清单的断言。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// .mjs 经显式路径 import（scripts 内互相引用的既有手法）；ANALYST_TOOLS 经 .ts 后缀（tsx/vitest 均可解析）
import { checkToolface } from './check-mcp-toolface.mjs'
import { ANALYST_TOOLS, ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS } from '../modules/data/domain/toolbox/registry.ts'

describe('checkToolface：四条判据', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    name: 'a_valid_name', mutating: false, annotations: { readOnlyHint: true }, requiredScope: 'data:read', ...over,
  })

  it('干净清单 ⇒ 0 条', () => {
    expect(checkToolface([meta()])).toEqual([])
  })
  it('工具数超限 ⇒ 1 条，带 [TOOLFACE]', () => {
    const out = checkToolface([meta(), meta()], { maxTools: 1 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('[TOOLFACE]')
  })
  it('体积超限 ⇒ 1 条', () => {
    const out = checkToolface([meta()], { maxBytes: 10 })
    expect(out.some((s) => s.includes('[TOOLFACE]'))).toBe(true)
  })
  it('坏名字逐个点名；mutating 无注解/无 scope 逐个点名', () => {
    const out = checkToolface([meta({ name: 'bad name!' }), meta({ mutating: true, annotations: undefined }), meta({ mutating: true, requiredScope: null })])
    expect(out.filter((s) => s.includes('bad name!'))).toHaveLength(1)
    expect(out.filter((s) => s.includes('a_valid_name') && s.includes('注解'))).toHaveLength(1)
    expect(out.filter((s) => s.includes('a_valid_name') && s.includes('scope'))).toHaveLength(1)
  })
})

describe('真仓 ANALYST_TOOLS 本身过门（防清单漂移，不等 CI 才红）', () => {
  it('11 ≤14；序列化 ≤10KB；名字全合法；mutating 全 false', () => {
    expect(checkToolface(ANALYST_TOOLS)).toEqual([])
    expect(ANALYST_TOOLS.length).toBeLessThanOrEqual(ANALYST_FACE_MAX_TOOLS)
    expect(JSON.stringify(ANALYST_TOOLS).length).toBeLessThanOrEqual(ANALYST_FACE_MAX_LIST_BYTES)
  })
  it('ci.yml 已接线本门（脚本存在但没接进 CI = 没固化，正典 §4.1 判据）', () => {
    const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('check-mcp-toolface.mjs')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/check-mcp-toolface.test.ts`
Expected: FAIL——`Cannot find module './check-mcp-toolface.mjs'`

- [ ] **Step 3: 实现**（`.mjs` 带 JSDoc——scripts/ 是 checkJs）

```js
#!/usr/bin/env node
// check-mcp-toolface.mjs — MCP 工具面门禁（spec 2026-10-21 §8；第一档门禁，跑在 gates）。
//
// 用法：pnpm exec tsx scripts/check-mcp-toolface.mjs
// 契约：干净 → exit 0 + `check-mcp-toolface: OK`；违规 → exit 1，stderr 每条一行（[TOOLFACE] 标签）。
//
// 四断言（spec §8）：① 分析师面工具数 ≤14；② tools/list 静态序列化 ≤10KB；
// ③ 工具名 [A-Za-z0-9_.-]；④ mutating 工具必须有注解与 scope。
// 事实源 = modules/data/domain/toolbox/registry.ts 的 ANALYST_TOOLS（显式 .ts import；
// registry 是纯的——这条 import 链不拉 pool/框架，否则门禁会连坐运行时依赖）。
import { ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS, ANALYST_TOOLS } from '../modules/data/domain/toolbox/registry.ts'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 判据纯函数（单测直接喂桩清单）。
 * @param {readonly { name: string, mutating: boolean, annotations?: unknown, requiredScope: string | null }[]} metas
 * @param {{ maxTools?: number, maxBytes?: number }} [opts]
 * @returns {string[]} 违规项（空 = 干净）
 */
export function checkToolface(metas, opts = {}) {
  const maxTools = opts.maxTools ?? ANALYST_FACE_MAX_TOOLS
  const maxBytes = opts.maxBytes ?? ANALYST_FACE_MAX_LIST_BYTES
  const out = []
  if (metas.length > maxTools) {
    out.push(`[TOOLFACE] 分析师面工具数 ${metas.length} > 上限 ${maxTools}（spec §8 ①）`)
  }
  const bytes = JSON.stringify(metas).length
  if (bytes > maxBytes) {
    out.push(`[TOOLFACE] tools/list 静态序列化 ${bytes} 字节 > 上限 ${maxBytes}（spec §8 ②）`)
  }
  for (const m of metas) {
    if (!TOOL_NAME_RE.test(m.name)) {
      out.push(`[TOOLFACE] 工具名 '${m.name}' 不匹配 [A-Za-z0-9_.-]（MCP 2025-11-25 命名，spec §8 ③）`)
    }
    if (m.mutating === true && (m.annotations === undefined || m.annotations === null)) {
      out.push(`[TOOLFACE] mutating 工具 '${m.name}' 缺注解（readOnlyHint 必须 显式，spec §8 ④）`)
    }
    if (m.mutating === true && (m.requiredScope === null || m.requiredScope === '')) {
      out.push(`[TOOLFACE] mutating 工具 '${m.name}' 缺 requiredScope（写工具必须声明 scope，spec §8 ④）`)
    }
  }
  return out
}

// main：真仓清单判定（argv 守卫——被单测 import 时不触发，e2e-data-cross-tenant.mjs 同款先例）
if (process.argv[1]?.endsWith('check-mcp-toolface.mjs')) {
  const violations = checkToolface(ANALYST_TOOLS)
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log('check-mcp-toolface: OK')
}
```

`.github/workflows/ci.yml` gates job 追加（放在 `check-diagnostic-tool.mjs` 一步之后、`check-recon-caliber.mjs` 之前，与「守卫脚本对真实仓跑」族同址；注释照既有条目风格）：

```yaml
      # MCP 工具面门禁（spec 2026-10-21 §8）：分析师面工具数 ≤14 / tools/list ≤10KB /
      # 命名 [A-Za-z0-9_.-] / mutating 工具必须带注解与 scope。
      # 事实源 = toolbox/registry.ts 的 ANALYST_TOOLS（显式 .ts import；registry 是纯的，
      # 这条 import 链不拉运行时依赖——registry 头注有约束）。判据单测在 test:guard（unit）。
      - run: pnpm exec tsx scripts/check-mcp-toolface.mjs
```

- [ ] **Step 4: 跑测试与门禁本体确认通过**

Run: `pnpm exec vitest run scripts/check-mcp-toolface.test.ts && pnpm exec tsx scripts/check-mcp-toolface.mjs && pnpm run typecheck:scripts`
Expected: 全 PASS / `check-mcp-toolface: OK`

- [ ] **Step 5: 提交**

```bash
git add scripts/check-mcp-toolface.mjs scripts/check-mcp-toolface.test.ts .github/workflows/ci.yml
git commit -m "feat(data): check-mcp-toolface CI 门——工具数/体积/命名/注解四断言（gates） (#<ISSUE>)"
```

---

### Task 13: 跨租户 e2e 扩 toolface（防假绿铁律）

**Files:**
- Modify: `scripts/e2e-data-cross-tenant.mjs`
- Modify: `scripts/e2e-data-cross-tenant.test.ts`

**Interfaces:**
- Consumes: 现四面判定/编排/出口码（全保留）；T1 的 `sanitizeToolName`（**对齐测试**直接 import registry TS——防 .mjs 本地副本漂移）。
- Produces:
  - `export function sanitizeToolNameForProbe(id: string): string`——.mjs 本地副本（`id.replaceAll(':', '__')`），**必须**与真实现等价（对齐测试钉住；e2e 是独立 .mjs 判定层，不 import 运行时模块，等价性靠测试守护）。
  - `export function judgeToolface({ toolsA, toolsB, foreignMetricIds, analystToolNames }): Judgement`——面⑤判定（surface=`'toolface'`）：
    - 形状坏（toolsA/toolsB 读不出，`toolNamesOf` null）⇒ violation（读不出 ≠ 没有，同面④纪律）
    - A 的 tools 出现任一 `sanitizeToolNameForProbe(fid)` ⇒ violation（串租户，sanitized 形态）
    - B 的 tools **没出现**自己某条 sanitized 外指标名 ⇒ violation（正面信号缺席——分不清「没泄」与「B 根本没上线」）
    - 任一名字违反 `[A-Za-z0-9_.-]+` ⇒ violation（命名合规在 wire 面可观测）
    - 任一侧有重名工具 ⇒ violation
    - A 的 tools 缺任一 `analystToolNames` ⇒ violation（分析师面未上线的正面信号）；全在 ⇒ note 记数量
  - `loadConfig` 新增**配置自洽闸**（防假绿铁律，spec §9「两租户探针同值即抛、空集即抛」的 toolface 落点）：`foreignMetricIds ∩ metricIds ≠ ∅` ⇒ 抛（「对侧指标 id 与本侧要问的指标 id 重叠 ⇒ 面④⑤的判据分不开两侧」）；空集闸已有（E2E_TENANT_B_METRIC_IDS 空集 exit 2），**沿用不改**。
  - `runSuite` 编排：新增面⑤ try/catch 块（`runFace('toolface', …)`）——用 A、B 两个 PAT 各发一次 `POST /mcp tools/list`（B 的这次请求新增；A 侧复用面④已取的响应，**同一响应对象传两个判定函数**，不重复请求），`judgeToolface` 结果 merge。`analystToolNames` 常量数组写死在 .mjs（11 个名字），**对齐测试**断言其与 registry `analystToolNames()` 逐字相等（防两处清单漂移）。

- [ ] **Step 1: 写失败测试**（`e2e-data-cross-tenant.test.ts` 追加）

```ts
// scripts/e2e-data-cross-tenant.test.ts 追加 —— 面⑤ toolface：防假绿铁律的同款四件套。
describe('sanitizeToolNameForProbe：与真实现等价（防本地副本漂移）', () => {
  it('本地副本 === registry.sanitizeToolName（夹具表逐字对照）', async () => {
    const { sanitizeToolNameForProbe } = await suite()
    // 跨根 import registry（纯模块，tsx/vitest 均可解析 .ts 后缀）
    const { sanitizeToolName } = await import('../modules/data/domain/toolbox/registry.ts') as { sanitizeToolName: (s: string) => string }
    for (const id of ['lemeng:retail:net_sales', 'a:b:c', 'plain', 'x__y', 'bravo:bravo_only_metric']) {
      expect(sanitizeToolNameForProbe(id)).toBe(sanitizeToolName(id))
    }
  })
})

describe('analystToolNamesForProbe：与 registry 清单逐字相等（防两处清单漂移）', () => {
  it('11 个名字逐字一致', async () => {
    const { analystToolNamesForProbe } = await suite()
    const { analystToolNames } = await import('../modules/data/domain/toolbox/registry.ts') as { analystToolNames: () => string[] }
    expect(analystToolNamesForProbe()).toEqual(analystToolNames())
  })
})

describe('loadConfig toolface 自洽闸：对侧指标 id 与本侧指标 id 重叠 ⇒ 抛', () => {
  it('E2E_METRIC_ID 与 E2E_TENANT_B_METRIC_IDS 有交集 ⇒ 抛且点名重叠 id', async () => {
    const { loadConfig } = await suite()
    expect(() => loadConfig(fullEnv({
      E2E_METRIC_ID: 'lemeng:retail:net_sales,shared:metric',
      E2E_TENANT_B_METRIC_IDS: 'bravo:bravo_only_metric,shared:metric',
    }))).toThrow(/shared:metric/)
  })
})

describe('judgeToolface：面⑤ 判定', () => {
  const FID = ['bravo:bravo_only_metric']
  const FNAMES = ['bravo__bravo_only_metric']
  const A_TOOLS = ['data_agent_guide', 'query_metric', 'lemeng__retail__net_sales']
  const B_TOOLS = ['data_agent_guide', 'query_metric', ...FNAMES]
  const ANALYST = ['data_agent_guide', 'query_metric']

  function body(...names: string[]): unknown {
    return { jsonrpc: '2.0', id: 1, result: { tools: names.map((n) => ({ name: n, inputSchema: {} })) } }
  }

  it('两租户各见各的、分析师面在 ⇒ 无 violation', async () => {
    const { judgeToolface } = await suite()
    const out = judgeToolface({ toolsA: body(...A_TOOLS), toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(out.violations).toEqual([])
    expect(out.notes.some((n: string) => /面⑤/.test(n))).toBe(true)
  })

  it('★ A 的 tools 出现 B 指标的 sanitized 名 ⇒ violation（点名该名）', async () => {
    const { judgeToolface } = await suite()
    const out = judgeToolface({ toolsA: body(...A_TOOLS, FNAMES[0]), toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(out.violations.some((v: any) => v.surface === 'toolface' && v.message.includes(FNAMES[0]))).toBe(true)
  })

  it('★ B 的 tools 缺自己的指标工具 ⇒ violation（正面信号缺席）', async () => {
    const { judgeToolface } = await suite()
    const out = judgeToolface({ toolsA: body(...A_TOOLS), toolsB: body(...A_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(out.violations.some((v: any) => /正面|缺席/.test(v.message))).toBe(true)
  })

  it('名字含非法字符 / 重名 ⇒ violation', async () => {
    const { judgeToolface } = await suite()
    const bad = judgeToolface({ toolsA: body(...A_TOOLS, 'bad name!'), toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(bad.violations.some((v: any) => v.message.includes('bad name!'))).toBe(true)
    const dup = judgeToolface({ toolsA: body(...A_TOOLS, 'query_metric'), toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(dup.violations.some((v: any) => /重名|重复/.test(v.message))).toBe(true)
  })

  it('A 缺分析师面固定工具 ⇒ violation（面未上线的正面信号）', async () => {
    const { judgeToolface } = await suite()
    const out = judgeToolface({ toolsA: body('legacy_tool_only'), toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(out.violations.some((v: any) => /data_agent_guide/.test(v.message))).toBe(true)
  })

  it('响应形状坏 ⇒ violation（读不出 ≠ 空词表）', async () => {
    const { judgeToolface } = await suite()
    const out = judgeToolface({ toolsA: { error: { code: -32601, message: 'x' } }, toolsB: body(...B_TOOLS), foreignMetricIds: FID, analystToolNames: ANALYST })
    expect(out.violations.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/e2e-data-cross-tenant.test.ts`
Expected: 追加段 FAIL——`judgeToolface`/`sanitizeToolNameForProbe` 不存在；**既有段 PASS**

- [ ] **Step 3: 实现**（.mjs 追加；编排接线；ENV_SPEC **不加新键**——面⑤复用既有 E2E_TENANT_B_METRIC_IDS/E2E_TENANT_B_PAT，`--help` 文案的「四面」改「五面」并补面⑤一行说明）

```js
// ═══ 判定：面⑤ MCP 工具面（分析师面上线 + sanitized 词表）═════════════════════════════

/** 工具名清洗的**本地副本**（与 modules/data registry 的 sanitizeToolName 等价；
 *  等价性由 e2e-data-cross-tenant.test.ts 的对齐用例钉住——那条红 = 两份实现漂了）。 */
export function sanitizeToolNameForProbe(id) {
  return String(id).replaceAll(':', '__')
}

/** 分析师面固定工具名（与 registry.analystToolNames() 等价；同样由对齐用例钉住）。 */
export function analystToolNamesForProbe() {
  return [
    'data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric',
    'describe_dataset', 'sample_dimension_values', 'preview_query', 'query_metric',
    'get_freshness', 'get_quality', 'get_lineage',
  ]
}

const PROBE_TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 面⑤ 判定（判据与防假绿纪律照本文件头注：正面先验、两侧互为断言面、读不出 ≠ 没有）。
 * @param {{ toolsA: any, toolsB: any, foreignMetricIds: string[], analystToolNames: string[] }} args
 * @returns {Judgement}
 */
export function judgeToolface({ toolsA, toolsB, foreignMetricIds, analystToolNames }) {
  const out = clean()
  const namesA = toolNamesOf(toolsA)
  const namesB = toolNamesOf(toolsB)
  if (namesA === null) {
    out.violations.push({ surface: 'toolface', message: '面⑤ 租户 A 的 tools/list 形状读不出（缺 result.tools 或协议级 error）：本面无法判定——读不出 ≠ 没有。' })
  }
  if (namesB === null) {
    out.violations.push({ surface: 'toolface', message: '面⑤ 租户 B 的 tools/list 形状读不出：同上，本面无法判定。' })
  }
  if (namesA !== null && namesB !== null) {
    const foreignNames = foreignMetricIds.map((id) => sanitizeToolNameForProbe(id))
    for (const fn of foreignNames) {
      if (namesA.includes(fn)) {
        out.violations.push({ surface: 'toolface', message: `面⑤ 串租户：租户 A 的 tools/list 出现对侧指标的工具名 '${fn}'（sanitized 形态）——词表裁剪没覆盖分析师面的 legacy 工具命名。` })
      }
      if (!namesB.includes(fn)) {
        out.violations.push({ surface: 'toolface', message: `面⑤ 正面信号缺席：租户 B 自己的 tools/list 里没有 '${fn}'——「A 没泄」与「B 根本没上线」分不开（不要据此判绿）。` })
      }
    }
    for (const [label, names] of [['A', namesA], ['B', namesB]]) {
      for (const n of names) {
        if (!PROBE_TOOL_NAME_RE.test(n)) {
          out.violations.push({ surface: 'toolface', message: `面⑤ 命名违规：租户 ${label} 的工具名 '${n}' 不匹配 [A-Za-z0-9_.-]（MCP 2025-11-25）。` })
        }
      }
      const dup = names.filter((n, i) => names.indexOf(n) !== i)
      if (dup.length > 0) {
        out.violations.push({ surface: 'toolface', message: `面⑤ 工具重名：租户 ${label} 的 tools/list 有重复名 ${JSON.stringify([...new Set(dup)])}——registry 的撞名跳过没生效或两条面叠加。` })
      }
    }
    for (const an of analystToolNames) {
      if (!namesA.includes(an)) {
        out.violations.push({ surface: 'toolface', message: `面⑤ 分析师面缺席：租户 A 的 tools/list 没有固定工具 '${an}'——分析师面未上线或 registry 驱动没接上（正面信号）。` })
      }
    }
    out.notes.push(`面⑤ A ${namesA.length} 个工具 / B ${namesB.length} 个工具；对侧 ${foreignMetricIds.length} 个指标的 sanitized 名均按判定核对；分析师面固定工具 ${analystToolNames.length} 个。`)
  }
  return out
}
```

编排（`runSuite` 内，面④ 之后追加；A 的 tools 响应从面④ 提出来共用）：

```js
  // ── 面④+⑤ L2 词表 + MCP 工具面（同一对响应喂两个判定，不重复请求）────────────────────
  await runFace('catalog', async () => {
    const metrics = await callJson(deps, 'GET', '/metrics', config.tenantA.pat)
    const toolsA = await callJson(deps, 'POST', '/mcp', config.tenantA.pat, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const toolsB = await callJson(deps, 'POST', '/mcp', config.tenantB.pat, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    merge(judgeCatalog({ foreignMetricIds: config.foreignMetricIds, metrics, tools: toolsA }))
    merge(judgeToolface({ toolsA, toolsB, foreignMetricIds: config.foreignMetricIds, analystToolNames: analystToolNamesForProbe() }))
  })
```

`loadConfig` 自洽闸（插在两租户 org/probe 校验之后）：

```js
  const overlapped = foreignMetricIds.filter((id) => metricIds.includes(id))
  if (overlapped.length > 0) {
    throw new Error(
      `对侧指标 id 与本侧指标 id 重叠（${overlapped.join(', ')}）：面①④⑤ 的判据分不开两侧`
      + '（同值探针 = 恒绿）。请给 B org 真正独有的 L2 指标 id。',
    )
  }
```

> 注意顺序：这段引用 `foreignMetricIds`/`metricIds`，须放在它们 `splitList` 之后、空集闸之前/后皆可（空集闸已先行挡掉空集）。

- [ ] **Step 4: 跑测试确认通过（含 CLI 契约段——--help 文案改五面后既有断言仍绿）**

Run: `pnpm exec vitest run scripts/e2e-data-cross-tenant.test.ts && pnpm run typecheck:scripts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/e2e-data-cross-tenant.mjs scripts/e2e-data-cross-tenant.test.ts
git commit -m "test(data): 跨租户 e2e 扩面⑤ toolface——sanitized 词表/分析师面在位/命名合规，防假绿四件套 (#<ISSUE>)"
```

---

### Task 14: 全量验证 + PR（真仓验收命令逐条跑）

**Files:**
- 无新代码；PR 汇总。

**Interfaces:**
- Consumes: Task 1–13 全部落地后的分支。
- Produces: 一个 PR（squash merge，subject 带 `(#N)`，body 带 `Closes #<ISSUE>`）。

- [ ] **Step 1: 全量门禁（本仓 CI 在本地能跑的全跑）**

```bash
pnpm test          # 全 workspace 包 + scripts 守卫（含新增 toolbox/e2e/门禁单测）
pnpm typecheck     # 全包 + scripts checkJs
pnpm exec tsx scripts/check-mcp-toolface.mjs
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/check-env-example.mjs   # 两枚新 env 键已声明
pnpm --filter @platform/web build && pnpm smoke
```
Expected: 全绿（CI CLEAN 才可合并——「合并只等 CI CLEAN」，UNSTABLE 强合出过生产 502）。

- [ ] **Step 2: 手动冒烟（spec §9 Wave 1 验收——人执行，结果回填 PR 描述）**

真实 PAT 连 MCP 客户端走完 `guide → search → describe → preview → query` 一轮，信封字段逐个核对（metric/subject/asOf/query/result/audit 有值；lineage 无 manifest 源时**缺席**）。验收点：`structuredContent` 在场、`audit` 的 id 能在 `data.query_audit` 查到且 `tool='query_metric'`。

- [ ] **Step 3: 提 PR + 收尾**

```bash
git push -u origin HEAD
gh pr create --title "feat(data): 数据面 MCP 分析师面 Wave 1 (#<ISSUE>)" --body "Closes #<ISSUE>

- 通道 B 分析师面 11 工具（registry 单一事实源，信封/审计/只读池/协议整改）
- authorize 切片化（buildSlicedPlan 单函数；主体钉死共享同段代码）
- 审计扩 tool 字段（迁移 021）；analystPool 只读单例
- check-mcp-toolface CI 门 + 跨租户 e2e 面⑤
- ⚠️ 决策点 D1：data:read 端点级分离与『一端点一 scope』正典冲突——本 PR 端点门维持 data:query，分离方案待人工裁决（见计划决策节）
- 手动冒烟结果：<回填>"
```

PR 合并 = 门禁全绿自动部署（`deploy/openship-adopt.md` §7）；部署后按团队规则 deploy-verify 验容器创建时间 > 镜像构建时间、`data.query_audit` 出现 `tool` 非空行。

---

## 验收对账（spec §10 全局验收清单 ↔ 本计划落点）

| spec §10 | 落点 |
|---|---|
| 跨租户 e2e 红Proof（同值/空集自检） | T13（重叠闸 + 空集闸沿用 + 对齐测试） |
| 数值回包 100% 带信封；缺字段可辨 | T2/T10（buildEnvelope 缺席语义；T11 structuredContent） |
| 只读断言：data:query 连接对湖写必失败 | T4（describePg：create table 被 read-only 拒） |
| 审计：零数值调用也有记录（ok, rowCount=null） | T1（callTool 单点审计）+ T5（tool 列）+ T11（guide 用例） |
| 工具面 ≤14 且 <10KB；命名 100% 合规 | T1（静态清单自检）+ T12（门禁 ①②③） |
| 未开写开关时全部 mutating 工具 403 | T1（callTool mutating 闸）+ T12（门禁 ④）——Wave 1 无 mutating 工具，机制先立 |
| 通道 C 在产行为不回归 | 本 Wave 未触 agent-loop/openclaw（文件结构「明确不动」节）；既有 agent-loop.test.ts 全绿即证 |

## 待沉淀（无案例，不编）

- dbt `manifest.json` 是否真随 data-plane.lock 投递到 server 容器（D3）——待真机部署后回填 handbook。
- 端点级 `data:read`/`data:query` 分离方案（D1）——待人工裁决后另立协议变更。
- 分析师面调用量观察一个周期后 legacy 读面的下线（未决 #1）——按审计 `tool` 字段统计。
