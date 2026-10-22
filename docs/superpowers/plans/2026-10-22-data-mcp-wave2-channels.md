# 数据面 MCP Wave 2——三通道同享（A/C 绑定）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把通道 A（console /chat 的 agent-loop）与通道 C（企微 OpenClaw 插件）绑到 Wave 1 已落地的 toolbox registry 上：A 绑 registry 子集（describe_metric / sample_dimension_values / get_freshness），C 经新增的 registry HTTP 薄封装端点 `POST /toolbox` 加同三工具；guide 文案抽成通道中性的 `GUIDE_INVARIANTS` 实现一份内容三处分发。

**Architecture:** 工具实现零复制——A 的三把新工具与 C 的三个新工具最终都落在 `toolbox` 的 impl（discovery/health 分册）上；A 走 `registry.callTool` 进程内单点（顺带补齐审计），C 走 `POST /toolbox` HTTP 薄封装（callTool 是唯一分发点，status 映射照 /query 的 #30 口径，插件 `callPlatform` 错误文案映射零改动）。guide.ts 是三通道同源内容的事实源：A 编译期 import、B 原样（现状）、C 逐字入 SKILL.md + 新机检门禁 `check-guide-sync.mjs`。

**Tech Stack:** TypeScript / Hono / vitest（`modules/data`、`apps/server`）/ node --test（插件 JS）/ tsx 门禁脚本。不新增运行时依赖。

**设计 spec（唯一事实源）:** `docs/superpowers/specs/2026-10-21-data-mcp-analyst-face-and-proposal-design.md` §6 / §9 Wave 2 / Global Constraints / §2 非目标。

## Global Constraints（每个任务隐式继承）

- **授权核心单实现**：任何通道/工具不得自建权限判定（词表裁剪只走 `visibleMetrics`/`authorizeCore`/`authorize`；本计划不新增任何 scope 判定代码）。
- **主体钉死**：SQL 主体值只来自身份解析；请求参数保留键一律拒；fail-closed：空身份 = 空工具面（不是报错）。
- **工具实现禁止第二份**：describe_metric / sample_dimension_values / get_freshness 的实现只在 `modules/data/domain/toolbox/{discovery,health}.ts`（Wave 1 已落），本计划只做绑定与封装。
- **工具面预算**：分析师面（`ANALYST_TOOLS`）不加工具、不改名——`scripts/check-mcp-toolface.mjs` 四断言必须持续绿；通道 A 面 = 既有 3 + 新 3 = 6 把；`MAX_AGENT_TURNS = 6` 不变。
- **行限沿用**：`MAX_QUERY_ROWS=1000`；抽样 ≤50 行（`SAMPLE_MAX_ROWS`）。
- **写开关默认关**：`DATA_MCP_ALLOW_MUTATING` 不动；Wave 2 绑定的三工具全 `mutating:false`。
- **审计**：A/C 的新工具调用（含拒绝与出错）经 `registry.callTool` 单点写入 `data.query_audit`（C 通道 `channel='wecom'`，A 通道 `channel='session'`）。
- **通道 C 红线（spec）**：只加工具定义与 SKILL 文案；不动 native plugin 形态（`Dockerfile.openclaw` 构建期 COPY、安装路径 `/opt/plugins/data-query-plugin`、`openclaw plugins install -l` 命令都不变）、不动授权核心、不改部署形态（compose 零改动）。插件**零权限逻辑**不变。
- **提交纪律**：Conventional Commits `type(scope): subject`；本 wave 全部提交走一个 issue（下文 `#985` 占位，**开工前建真实 issue**）+ 一个 PR（body 含 `Closes #985`）。
- **企微目视验收是人工步骤，不自动触发企微消息**（见 Task 9 人工清单）。

## 关键决策记录（评审重点）

**D-A1 —— 通道 A 绑定子集 = describe_metric + sample_dimension_values + get_freshness（三把全绑）。**
理由：① 三把全只读、全 fail-closed、全经 callTool 入审计，零新实现；② `describe_metric` 给出粒度维度/参数权威（`sample_dimension_values` 的 `dimension` 必须是 grain 之一，没有 describe 它就是臆测）；③ `sample_dimension_values` 解决「门店名等过滤值确切写法」（通道 C 实测痛点，A 同构受益）；④ `get_freshness` 让「数据到几号」不烧一次查数 turn。**不绑**：`search_catalog`（A 的 `list_metrics` 已覆盖词表）、`describe_dataset`（A 是指标面不是 SQL 面）、`preview_query`（A 的 query_metric 无切片形状，绑了只会诱导误用）、`get_quality`/`get_lineage`（无已观测需求，最小面优先，后续可加）、`data_agent_guide`/`data_harness_catalog`（A 的 SYSTEM_PROMPT 就是 guide；catalog 是 B 的工具发现面）。绑定后 A 面 6 把，LLM 面仍最小。

**D-C1 —— 通道 C 的平台侧 HTTP 面 = 单一 `POST /toolbox`，body `{tool, args}`，registry 的 HTTP 薄封装。**
备选是三个语义端点（GET /metrics/:id、POST /query/sample、GET /freshness）。取单一端点，理由：
1. **一个 manifest 声明**（`装载期双向核对`的漂移面 ×1 而非 ×3）；
2. **callTool 仍是唯一分发点**——审计（含拒绝/出错、`tool` 字段、`channel='wecom'`）、mutating 闸、unknown-tool 拒绝全部免费继承，不写第二份；
3. **插件保持薄客户端**——三个新工具与既有两工具共用 `callPlatform`，零新逻辑；
4. **通道无关**——`/toolbox` 声明 scope `data:query`，PAT/会话/企微三类请求者经各自中间件都能调（「三通道同享」的字面落点）；we Go 中间件 first-setter-wins + 只拦企微意图（#983 形态）保证互不干扰；
5. **状态码映射照 /query 的 #30 口径**：`ok → 200`；`isError` 且 `payload.status !== 'error'`（denied/not_found/unknown_tool/unauthenticated）`→ 403`；`payload.status === 'error'`（tool_exception/impl_missing）`→ 502`——插件 `callPlatform` 的 401/403/502 文案映射**零改动**复用。
风险与边界：该端点对任意具 data:query 身份开放全部 `ANALYST_TOOLS`（不止插件注册的三个）。可接受：分析师面 Wave 2 全只读且 mutating 默认关；权限判定仍是同一授权核心按人裁决；LLM 可见面仍由插件注册的工具定义决定（端点 ≠ LLM 面）。工具级 `requiredScope` 保持**声明面**（Wave 1 决策 D1 的既定姿态，与 /mcp 一致）。

**D-G1 —— guide 同源 = 抽出通道中性 `GUIDE_INVARIANTS`（四行），guide.ts 是事实源。**
spec §5 说 data_agent_guide「文案与 A/C 提示词同源」，但七步工作流引用的是 B 专属工具名（search_catalog/preview_query/data_harness_catalog），逐字复制到 A/C 是错的。同源的**可共享内核 = 硬约束四行**（主体钉死 / 截断语义 / total 语义 / 新鲜度如实），逐字相同；工作流步骤保持通道各自本地。分发：B = `GUIDE_TEXT_BUILDER` 内嵌（现状语义不变）；A = agent-loop SYSTEM_PROMPT 编译期 import（改动即编译错）；C = SKILL.md 逐字入文 + 新门禁 `scripts/check-guide-sync.mjs` 机检（C 在 openclaw 容器里消费静态 md，无法 import TS，机检是唯一能钉住同源的手段）。通道特有措辞（如 A 的「答案末尾附 freshness_line」 vs C 的「不要自己写 📅 行，系统自动附加」）留在各通道本地文案，不进共享四行。

**D-F1 —— 通道 C 的 `get_freshness` 回包进 freshnessStore 捕获（传输层确定性附加）。**
坑：模型转述 `get_freshness` 回包里的 📅 行（`payload.line`）时，`message_sending` 钩子会把**所有** 📅 行剥掉，而剥掉后没有 query_data 捕获可重附 ⇒ 新鲜度行**静默丢失**。修法沿用本仓已拍板的传输层模式（「对 flash 级模型是弱引导 ⇒ 下沉到传输层」）：get_freshness 成功回包带 `line` 时 `freshnessStore.capture`，钩子剥旧钉新，天然去重。

**D-M1 —— mcp.ts 的 ToolboxDeps 装配切换到共享工厂 `buildToolboxDeps`（all.ts）。**
新增装配点有 /toolbox 路由与 agent-loop 两处，加上 mcp.ts 本身就是三处——各写一份 `{pool, org, requester, adoptedSources, wh, dbtManifest, allowMutating}` 必漂。工厂放 `toolbox/all.ts`（**不放 registry.ts**：registry 是 CI 门 import 的纯文件，工厂要 import warehouse/health）。mcp.ts 同步切换，其既有测试守护无回归。

## spec 冲突点记录（以正典/现状为准的裁定）

1. **spec §3 的 Wave 2 文件清单没有平台侧 HTTP 面**（只列 agent-loop.ts / 插件 / SKILL.md），但插件是 HTTP 薄客户端，三个新工具必须要有平台端点——任务书已确认此缺口并要求按仓内惯例设计。裁定：新增 `routes/toolbox.ts` + manifest 声明（= 决策 D-C1）。这不违反「通道 C 红线」：授权核心没动（端点门由 manifest 声明施加，判定仍在 callTool/授权核心），部署形态没动（模块路由随 server 镜像走，compose 零改动）。
2. **spec §5 data_agent_guide「文案与 A/C 提示词同源」**按 D-G1 解释为「硬约束内核同源、工作流通道本地」——逐字全文同源会向 A/C 引用其不具备的工具名。
3. **spec §9 Wave 2 验收「通道 A e2e（SSE 事件序列快照）」**落点为 `modules/data/routes/chat.test.ts` 的 SSE 用例扩展（脚本化假模型 + 全事件 deep-equal），不另起 e2e harness——与该文件既有 SSE 测试同法。
4. **spec §10「插件既有两工具逐字节兼容」**：`query_detail` 实为既有第三工具（README 工具表漏登，本波顺手补登）；「逐字节兼容」由 lib.test.js/scope.test.js 既有断言不动 + 全绿钉住。

---

## 前置（开工前人工完成）

1. 建真实 issue：标题 `feat(data): 数据面 MCP Wave 2——三通道同享（A/C 绑定）`，内容引用 spec §9 Wave 2 与本计划。下文所有 `#985` 替换为真实号。
2. 分支自最新 origin/main 建（多会话并行惯例：动手前先 `git fetch origin main`）。
3. 本地验证环境：`DATABASE_URL` 指向本地 compose pg（跑 modules/data 测试必需）。

---

### Task 1: GUIDE_INVARIANTS——三通道同源内容的事实源

**Files:**
- Modify: `modules/data/domain/toolbox/guide.ts`
- Test: `modules/data/domain/toolbox/guide.test.ts`

**Interfaces:**
- Consumes: 既有 `GUIDE_TEXT_BUILDER(today: string): string`（guide.ts）。
- Produces: `GUIDE_INVARIANTS: readonly string[]`（四行通道中性硬约束，逐字用于 Task 4 的 SYSTEM_PROMPT、Task 7 的 SKILL.md、Task 8 的门禁）。`GUIDE_TEXT_BUILDER` 签名不变，输出 = 今天行 + 七步工作流 + `...GUIDE_INVARIANTS`。

- [ ] **Step 1: 写失败测试**

在 `guide.test.ts` 追加（文件顶部 import 行加 `GUIDE_INVARIANTS`）：

```ts
import { GUIDE_INVARIANTS, GUIDE_TEXT_BUILDER, guideImpl, harnessCatalogImpl } from './guide'

describe('GUIDE_INVARIANTS（三通道同源内核）', () => {
  it('恰四行，每行都进 GUIDE_TEXT_BUILDER 输出（B 通道同源现状不破）', () => {
    expect(GUIDE_INVARIANTS).toHaveLength(4)
    const built = GUIDE_TEXT_BUILDER('2026-10-22')
    for (const line of GUIDE_INVARIANTS) expect(built).toContain(line)
  })
  it('行文案是通道中性的：不出现 B 专属工具名（A/C 没有这些工具，引用即误导）', () => {
    for (const line of GUIDE_INVARIANTS) {
      expect(line.includes('search_catalog') || line.includes('preview_query') || line.includes('data_harness_catalog')).toBe(false)
    }
  })
  it('四行分别钉住：主体钉死 / 截断语义（含 1000）/ total 语义 / 新鲜度如实', () => {
    const all = GUIDE_INVARIANTS.join('\n')
    expect(all).toContain('钉死')
    expect(all).toContain('1000')
    expect(all).toContain('truncated')
    expect(all).toContain('total')
    expect(all).toContain('新鲜度')
    expect(all).toContain('不要编')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data vitest run domain/toolbox/guide.test.ts`
Expected: FAIL——`GUIDE_INVARIANTS` 未导出（TS2305 或 undefined）。

- [ ] **Step 3: 最小实现**

`guide.ts`：在 `GUIDE_TEXT_BUILDER` 之前加导出，并把 builder 的硬约束四行替换为展开（工作流行与今天行不动）：

```ts
/**
 * 通道中性硬约束（Wave 2 决策 D-G1）：三通道同源内容的事实源。
 * B = 本 builder 内嵌；A = agent-loop SYSTEM_PROMPT 编译期 import；C = SKILL.md 逐字入文
 * + scripts/check-guide-sync.mjs 机检（C 消费静态 md，无法 import TS ⇒ 机检钉同源）。
 * 措辞必须通道中性：不出现任何通道专属工具名；通道特有机制（A 的 freshness_line 附行、
 * C 的 📅 传输层自动附加）留各通道本地文案，不进这里。
 */
export const GUIDE_INVARIANTS: readonly string[] = [
  '· 主体（org/租户/数据主体）由平台按身份钉死：不要索要、不要猜测，参数里出现即被拒；',
  '· 行上限 1000，truncated=true 说明被截断：不得把截断集当全量下结论，也不得对截断集自行求和；',
  '· 合计以回包的 total 字段为准：字段在场就直接引用，不要自己把行加总；切片/截断产生的部分合计不是全局合计；',
  '· 数据截止与新鲜度必须如实呈现：回包没有相应字段或正典行 = 新鲜度未知，如实说明，不要编；',
]
```

`GUIDE_TEXT_BUILDER` 整体替换为（七步工作流行**逐字保留**，仅最后四行硬约束换成展开——diff 只允许出现在这四行）：

```ts
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
  ...GUIDE_INVARIANTS,
].join('\n')
```

- [ ] **Step 4: 跑测试确认通过（含既有用例不破）**

Run: `pnpm --filter data vitest run domain/toolbox/guide.test.ts`
Expected: PASS（既有三用例断言 `主体`/`新鲜度`/`1000` 关键词，新文案仍含——全绿才算过）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/toolbox/guide.ts modules/data/domain/toolbox/guide.test.ts
git commit -m "feat(data): guide 抽出通道中性硬约束 GUIDE_INVARIANTS（三通道同源事实源）"
```

---

### Task 2: buildToolboxDeps 装配工厂（all.ts）

**Files:**
- Modify: `modules/data/domain/toolbox/all.ts`
- Modify: `modules/data/routes/mcp.ts`（装配切换到工厂）
- Create: `modules/data/domain/toolbox/all.test.ts`

**Interfaces:**
- Consumes: `ToolboxDeps`（registry.ts）、`analystPool`/`runWarehouseSql`（warehouse.ts）、`defaultDbtManifest`（health.ts）、`mutatingAllowed`（registry.ts）。
- Produces: `buildToolboxDeps(base: ToolboxBase, wiring?: ToolboxWiring): ToolboxDeps`，其中
  `ToolboxBase = { pool: Pool; org: string; requester: Requester | null; adoptedSources: ReadonlySet<string> }`、
  `ToolboxWiring = { wh?: SqlExecutor; env?: Record<string, string | undefined> }`。
  Task 3（路由）、Task 4（agent-loop）消费。**工厂必须在 all.ts**（它要 import warehouse/health；registry.ts 的纯性是 CI 门前提，不可污染）。

- [ ] **Step 1: 写失败测试**

Create `modules/data/domain/toolbox/all.test.ts`：

```ts
// all.test.ts — 装载工厂的纯断言（不连库；wh/env 可注入 ⇒ 不触 analystPool）。
import { describe, expect, it } from 'vitest'
import { buildToolboxDeps } from './all'
import type { ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const base = () => ({
  pool: { query: async () => { throw new Error('不该碰库') } } as never,
  org: 'acme',
  requester: { userId: 'u', orgId: 'acme', channel: 'pat', keyId: null, scopes: [], hasScope: () => true } as Requester,
  adoptedSources: new Set<string>(['lemeng']),
})

describe('buildToolboxDeps', () => {
  it('base 四键透传；wh 注入优先；allowMutating 随 env（缺省 process.env=关）', () => {
    const wh = async () => ({ rows: [] }) as never
    const deps = buildToolboxDeps(base(), { wh, env: {} })
    expect(deps.pool).toBe(base().pool)
    expect(deps.org).toBe('acme')
    expect(deps.requester).not.toBeNull()
    expect(deps.wh).toBe(wh)
    expect(deps.allowMutating).toBe(false) // env:{} 里没有 DATA_MCP_ALLOW_MUTATING
    expect(typeof deps.dbtManifest).toBe('function')
  })
  it('写开关显式开：env.DATA_MCP_ALLOW_MUTATING === "true" 才开（恰为字面量）', () => {
    expect(buildToolboxDeps(base(), { wh: async () => ({ rows: [] }) as never, env: { DATA_MCP_ALLOW_MUTATING: 'true' } }).allowMutating).toBe(true)
    expect(buildToolboxDeps(base(), { wh: async () => ({ rows: [] }) as never, env: { DATA_MCP_ALLOW_MUTATING: 'TRUE' } }).allowMutating).toBe(false)
  })
  it('缺省 wh 是函数（生产惰性连只读池；本用例不调用它）', () => {
    const deps: ToolboxDeps = buildToolboxDeps(base(), { env: {} })
    expect(typeof deps.wh).toBe('function')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data vitest run domain/toolbox/all.test.ts`
Expected: FAIL——`buildToolboxDeps` 未导出。

- [ ] **Step 3: 最小实现**

`all.ts` 头部加 import 与工厂（现有 11 个 `registerImpl(...)` 调用不动）：

```ts
import type { Pool } from 'pg'
import { analystPool, runWarehouseSql } from '../warehouse'
import type { SqlExecutor } from '../query-service'
import { mutatingAllowed, type ToolboxDeps } from './registry'
import type { Requester } from '../authz'
// （registerImpl 与既有 impl import 已在文件头部，勿动）

export interface ToolboxBase {
  pool: Pool
  org: string
  requester: Requester | null
  adoptedSources: ReadonlySet<string>
}
export interface ToolboxWiring {
  /** 测试注入的仓库执行器；缺省 = 只读池（analystPool，default_transaction_read_only=on）。 */
  wh?: SqlExecutor
  /** env 覆盖（测试确定性）；缺省 process.env。 */
  env?: Record<string, string | undefined>
}

/**
 * ToolboxDeps 的**唯一装配点**（Wave 2 决策 D-M1）：/mcp、POST /toolbox、agent-loop 三处共用。
 * ⚠️ 只能住在本文件——registry.ts 是 CI 门（check-mcp-toolface）的 import 对象，必须保持纯
 * （不拉 warehouse/pg）；本文件本来就是 impl 注册点，多背一个工厂不破坏任何纯性约定。
 */
export function buildToolboxDeps(base: ToolboxBase, wiring: ToolboxWiring = {}): ToolboxDeps {
  const wh: SqlExecutor = wiring.wh ?? ((sql) => runWarehouseSql(analystPool(), sql))
  return {
    pool: base.pool,
    org: base.org,
    requester: base.requester,
    adoptedSources: base.adoptedSources,
    wh,
    dbtManifest: defaultDbtManifest(),
    allowMutating: mutatingAllowed(wiring.env ?? process.env),
  }
}
```

（`defaultDbtManifest` 已在文件既有 import 里——health.ts 的导入行补上 `defaultDbtManifest` 具名导出即可。）

- [ ] **Step 4: mcp.ts 切换到工厂（回归由既有测试守护）**

`modules/data/routes/mcp.ts` 的分析师面分支（现 `const toolbox: ToolboxDeps = { … }` 手工装配处）替换为：

```ts
const toolbox = buildToolboxDeps(
  { pool: deps.pool, org: deps.org, requester: deps.requester, adoptedSources: deps.adoptedSources },
  { wh: deps.wh },
)
```

import 行：删 `defaultDbtManifest`（health 的）与 `mutatingAllowed`（registry 的）——若 `warehouse` 的 `analystPool/runWarehouseSql` 仍被 legacy 分支的 `readonlyWh` 用到则保留 warehouse import。文件头注补一句「装配走 buildToolboxDeps（all.ts 唯一装配点）」。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter data vitest run domain/toolbox/all.test.ts routes/mcp.test.ts`
Expected: PASS（工厂新用例 + mcp 既有用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/toolbox/all.ts modules/data/domain/toolbox/all.test.ts modules/data/routes/mcp.ts
git commit -m "refactor(data): buildToolboxDeps 装配工厂收敛 ToolboxDeps 构造（mcp.ts 同步切换）"
```

---

### Task 3: POST /toolbox——registry 的 HTTP 薄封装（通道 C 的平台侧 HTTP 面）

**Files:**
- Create: `modules/data/routes/toolbox.ts`
- Create: `modules/data/routes/toolbox.test.ts`
- Modify: `modules/data/manifest.yaml`（api.internal 追加一条）
- Modify: `modules/data/index.ts`（注册路由）

**Interfaces:**
- Consumes: `buildToolboxDeps`（Task 2）、`callTool`（registry.ts）、`requesterOf`/`ModuleHono`/`RouteCtx`（routes/context.ts）、`TENANT_SOURCES`（@platform/sdk）。
- Produces: `registerToolbox(r: ModuleHono, ctx: RouteCtx): void`；HTTP 契约 `POST /toolbox` body `{tool: string, args?: object}` → `ok→200 payload`；`isError && payload.status==='error' → 502 payload`；其余 isError `→ 403 payload`；body 非法 `→ 400 {error:'INVALID_BODY'}`。Task 7（插件）按此契约调用。

- [ ] **Step 1: 写失败测试**

Create `modules/data/routes/toolbox.test.ts`：

```ts
// toolbox.test.ts — POST /toolbox 的契约面。
// 状态码映射照 /query 的 #30 口径：denied/not_found → 403，error → 502，ok → 200——
// 插件 callPlatform 的错误文案映射（401/403/502 三分支）依赖这个形状，改映射先改这里再改插件。
import { afterAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
import type { ModuleVars } from './context'
import { registerToolbox } from './toolbox'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-w2-toolbox'

const M1: MetricDef = {
  id: 'w2_sales', title: 'W2 销售额', description: '测试用销售指标',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.w2_sales', groupBy: '',
  params: { day: { column: 'day', type: 'date', required: false } },
}

describe('POST /toolbox：入参门（不需要数据库）', () => {
  it('body 非法 → 400 INVALID_BODY（body 解析在取 tenant 之前，无库也能验）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/toolbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tool":}' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
  })
  it('缺 tool 字段 → 400', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/toolbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
  })
})

describePg('POST /toolbox：分发与审计（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  it('describe_metric 命中 → 200 + payload 直通；审计 verdict=ok 且 tool 字段在', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, M1, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: (async () => ({ rows: [] })) as unknown as SqlExecutor })
    const res = await app.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'describe_metric', args: { id: 'w2_sales' } }),
    })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { status: string; id: string; title: string }
    expect(payload.status).toBe('ok')
    expect(payload.id).toBe('w2_sales')
    expect(payload.title).toBe('W2 销售额')
    const audit = await pool.query(
      "select tool, channel, verdict, reason from data.query_audit where tool = 'describe_metric' order by id desc limit 1")
    expect(audit.rows[0]).toMatchObject({ tool: 'describe_metric', channel: 'session', verdict: 'ok' })
  })

  it('未知名 → 403 {status:denied, reason:unknown_tool}（fail-closed 继承 callTool，不暴露存在性）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: (async () => ({ rows: [] })) as unknown as SqlExecutor })
    const res = await app.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'no_such_tool', args: {} }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ status: 'denied', reason: 'unknown_tool' })
  })

  it('sample_dimension_values 维度不在粒度 → 403 reason=bad_param（detail 原样带出，插件文案映射靠它）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, M1, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: (async () => ({ rows: [] })) as unknown as SqlExecutor })
    const res = await app.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'sample_dimension_values', args: { metricId: 'w2_sales', dimension: 'not_a_dim' } }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { status: string; reason: string; detail: string }
    expect(body.status).toBe('denied')
    expect(body.reason).toBe('bad_param')
    expect(body.detail).toContain('not_a_dim')
  })

  it('get_freshness 全局支 → 200（execute 注入 load_log 行；status=unknown 也是 200——未知≠错误）', async () => {
    const fakeWh = (async () => ({
      rows: [['fct_x', '2026-10-20', new Date('2026-10-21T02:10:00+08:00')]],
    })) as unknown as SqlExecutor
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: fakeWh })
    const res = await app.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'get_freshness', args: {} }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', scope: 'global', dataThrough: '2026-10-20' })
  })

  it('channel=wecom 的请求者 → 审计 channel=wecom（通道 C 单点审计的钉子）', async () => {
    await applyMigrations(pool)
    // 测试壳不挂通道变量 ⇒ 手搭一个设 REQUESTER_CHANNEL 的最小 app（与 wecom-channel-auth.test.ts 同思路）。
    // TENANT_SOURCES 不设 = 宿主未投影 ⇒ adoptedSources 空集（fail-closed）；M1 是 L2 行，不受影响。
    const a = new Hono<ModuleVars>()
    a.use('*', async (c, next) => {
      c.set('identity', makeIdentity({ orgId: ORG, userId: 'wecom-user-1' }))
      c.set('tenant', { id: 1, casdoor_org: ORG })
      c.set(REQUESTER_CHANNEL, 'wecom')
      await next()
    })
    a.route('/', mod.createRouter({ pool }))
    const res = await a.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'describe_metric', args: { id: 'w2_sales' } }),
    })
    expect(res.status).toBe(200)
    const audit = await pool.query(
      "select channel, user_id from data.query_audit where tool = 'describe_metric' order by id desc limit 1")
    expect(audit.rows[0]).toMatchObject({ channel: 'wecom', user_id: 'wecom-user-1' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data vitest run routes/toolbox.test.ts`
Expected: FAIL——`./toolbox` 模块不存在（import 报错）。

- [ ] **Step 3: 实现路由**

Create `modules/data/routes/toolbox.ts`：

```ts
// toolbox.ts — POST /toolbox：registry 的 HTTP 薄封装（Wave 2 决策 D-C1，spec 2026-10-21 §6/§9）。
// 通道无关：声明 scope data:query，PAT/会话/企微三类请求者经各自中间件都能调；
// 分发与审计全部走 registry.callTool 单点（含拒绝/出错，channel 随身份）——本文件零权限逻辑。
// 状态码映射照 /query 的 #30 口径：ok → 200；denied/not_found/unknown_tool → 403；
// error（tool_exception/impl_missing）→ 502——插件 callPlatform 的文案映射零改动复用。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { callTool } from '../domain/toolbox/registry'
import { buildToolboxDeps } from '../domain/toolbox/all'

const ToolCallBody = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})

export function registerToolbox(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/toolbox', async (c) => {
    const parsed = ToolCallBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // requesterOf 的 M3 守卫在此收口：空 orgId → null → callTool 的 unauthenticated 路径（403）。
    // adoptedSources 是本路由的接线点（与 /query、/chat 同口径）：宿主没投影 ⇒ 空集 fail-closed。
    const deps = buildToolboxDeps(
      {
        pool: ctx.pool,
        org: c.get('tenant').casdoor_org,
        requester: requesterOf(c),
        adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
      },
      { wh: ctx.execute },
    )
    const out = await callTool(deps, parsed.data.tool, parsed.data.args)
    if (!out.isError) return c.json(out.payload)
    return c.json(out.payload, out.payload.status === 'error' ? 502 : 403)
  })
}
```

- [ ] **Step 4: manifest 声明 + 注册（**必须同一提交**——装载期双向核对）**

`modules/data/manifest.yaml` 的 `api.internal` 里 `/mcp` 声明之后追加：

```yaml
    # toolbox HTTP 薄封装（Wave 2，spec §6/§9：registry 的通道无关面；通道 C 插件经它调
    # 分析师面工具。与 /mcp 同档 data:query——工具级 requiredScope 仍是声明面（registry D1），
    # 执法点在本端点门；dispatch/审计单点在 registry.callTool。
    - { method: POST, path: /toolbox, scope: data:query }
```

`modules/data/index.ts`：import 区加 `import { registerToolbox } from './routes/toolbox'`；`registerMcp(r, _ctx)` 行后加 `registerToolbox(r, _ctx) // Wave 2：registry 的 HTTP 薄封装（通道 A/C 共享面）`。

- [ ] **Step 5: 跑测试与装载冒烟确认通过**

Run: `pnpm --filter data vitest run routes/toolbox.test.ts`
Expected: PASS（6 用例）。
Run: `pnpm exec tsx scripts/check-manifests.mjs`
Expected: `check-manifests: OK`（声明↔路由集合一致）。

- [ ] **Step 6: Commit**

```bash
git add modules/data/routes/toolbox.ts modules/data/routes/toolbox.test.ts modules/data/manifest.yaml modules/data/index.ts
git commit -m "feat(data): POST /toolbox——registry 的 HTTP 薄封装（通道 A/C 共享面，dispatch/审计单点 callTool）"
```

---

### Task 4: 通道 A 绑定 registry 子集（agent-loop）

**Files:**
- Modify: `modules/data/domain/agent-loop.ts`
- Test: `modules/data/domain/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ANALYST_TOOLS`/`callTool`/`ToolboxDeps`（registry.ts）、`buildToolboxDeps`（Task 2）、`GUIDE_INVARIANTS`（Task 1）、既有 `AgentDeps`/`AgentEvent`/`MAX_AGENT_TURNS`/`runAgentLoop`（agent-loop.ts）、`ToolSpec`/`ToolCall`（llm.ts）。
- Produces: `TOOLS: ToolSpec[]` = 既有三把（list_metrics/query_metric/query_detail，定义与文案不动）+ registry 子集三把（describe_metric/sample_dimension_values/get_freshness，name/description/inputSchema 从 `ANALYST_TOOLS` 同源直取）；`runTool` 返回联合新增成员 `{ status: 'toolbox'; payload: Record<string, unknown> }`。Task 5 的 SSE 快照消费事件形状（activity 的 detail 文案在 Step 3 定死）。

- [ ] **Step 1: 写失败测试**

`agent-loop.test.ts` 追加（复用文件既有 `FakeChatModel`/`collect`/`sessionRequester`/`NO_SOURCES`；`describePg` 块内可拿 `pool`）：

```ts
describe('通道 A 绑 registry 子集（Wave 2）', () => {
  it('TOOLS = 既有三把 + describe_metric/sample_dimension_values/get_freshness，且无重名', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_metrics', 'query_metric', 'query_detail']))
    expect(names).toEqual(expect.arrayContaining(['describe_metric', 'sample_dimension_values', 'get_freshness']))
    expect(new Set(names).size).toBe(names.length) // 重名会让模型对不上工具，装载即测
  })
  it('子集工具的 description/inputSchema 与 registry 同源（不得第二份文案）', () => {
    const meta = ANALYST_TOOLS.find((t) => t.name === 'describe_metric')!
    const spec = TOOLS.find((t) => t.name === 'describe_metric')!
    expect(spec.description).toBe(meta.description)
    expect(spec.inputSchema).toBe(meta.inputSchema)
  })

  it('describe_metric 经 callTool 单点：工具消息回 payload；审计 tool=describe_metric、channel=session', async () => {
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'describe_metric', arguments: { id: 'sales_daily' } }] },
      { content: 'sales_daily 是销售日明细。', toolCalls: [] },
    ])
    const events = await collect(runAgentLoop(
      { pool, org: ORG, adoptedSources: NO_SOURCES }, sessionRequester(), model, 'sales_daily 是什么口径？'))
    // 工具消息 = payload 原体（status=ok + id/title/definition/grain/params/owner/tier/version）
    const toolMsg = model.calls[1]!.messages.find((m) => m.role === 'tool')!
    const payload = JSON.parse(toolMsg.content) as { status: string; id: string }
    expect(payload.status).toBe('ok')
    expect(payload.id).toBe('sales_daily')
    expect(payload.title).toBe('销售日明细')
    // 活动事件与最终事件
    expect(events[0]).toMatchObject({ type: 'activity', tool: 'describe_metric', detail: '查指标详情 sales_daily' })
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'sales_daily 是销售日明细。' })
    // 审计（callTool 单点写入，含 tool 字段）
    const audit = await pool.query(
      "select tool, channel, verdict from data.query_audit where tool = 'describe_metric' order by id desc limit 1")
    expect(audit.rows[0]).toMatchObject({ tool: 'describe_metric', channel: 'session', verdict: 'ok' })
  })

  it('sample_dimension_values 拒绝（维度不在粒度）原样回给模型；不进 lastTable', async () => {
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture') // groupBy='' ⇒ 任何维度都不在粒度
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'sample_dimension_values', arguments: { metricId: 'sales_daily', dimension: 'store' } }] },
      { content: '该维度不存在。', toolCalls: [] },
    ])
    const events = await collect(runAgentLoop(
      { pool, org: ORG, adoptedSources: NO_SOURCES }, sessionRequester(), model, '按门店看看'))
    const toolMsg = model.calls[1]!.messages.find((m) => m.role === 'tool')!
    expect(JSON.parse(toolMsg.content)).toMatchObject({ status: 'denied', reason: 'bad_param' })
    const final = events.at(-1) as { type: string; table?: unknown }
    expect(final.type).toBe('final')
    expect(final.table).toBeUndefined() // toolbox 结果不得顶掉/伪装查询表
  })

  it('get_freshness：activity 文案带 scope；回包不进 lastTable（freshnessLagSeconds 不进事件流）', async () => {
    const fakeWh = (async () => ({
      rows: [['fct_x', '2026-10-20', new Date('2026-10-21T02:10:00+08:00')]],
    })) as unknown as SqlExecutor
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'get_freshness', arguments: {} }] },
      { content: '数据截至 2026-10-20。', toolCalls: [] },
    ])
    const events = await collect(runAgentLoop(
      { pool, org: ORG, adoptedSources: NO_SOURCES, execute: fakeWh }, sessionRequester(), model, '数据到几号'))
    expect(events[0]).toMatchObject({ type: 'activity', tool: 'get_freshness', detail: '查新鲜度 全局' })
    expect(events.at(-1)).toMatchObject({ type: 'final', text: '数据截至 2026-10-20。' })
  })

  it('SYSTEM_PROMPT 已含 GUIDE_INVARIANTS 四行（A 通道同源 = 编译期 import）', async () => {
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    const model = new FakeChatModel([{ content: '好', toolCalls: [] }])
    await collect(runAgentLoop({ pool, org: ORG, adoptedSources: NO_SOURCES }, sessionRequester(), model, 'hi'))
    const system = model.calls[0]!.messages[0]!.content
    for (const line of GUIDE_INVARIANTS) expect(system).toContain(line)
  })
})
```

文件顶部 import 增补：`import { ANALYST_TOOLS } from './toolbox/registry'` 与 `import { GUIDE_INVARIANTS } from './toolbox/guide'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data vitest run domain/agent-loop.test.ts`
Expected: FAIL——TOOLS 里没有三把新工具（arrayContaining 不满足）。

- [ ] **Step 3: 实现 agent-loop 绑定**

`agent-loop.ts` 改动（五处）：

① import 区加：

```ts
import { ANALYST_TOOLS, callTool, type ToolboxDeps } from './toolbox/registry'
import { buildToolboxDeps } from './toolbox/all'
import { GUIDE_INVARIANTS } from './toolbox/guide'
```

② SYSTEM_PROMPT：删掉主体钉死行（第 3 行「**不要向用户索要或猜测组织/主体…**」——由 GUIDE_INVARIANTS[0] 同源覆盖），追加不变量：

```ts
const SYSTEM_PROMPT = [
  '你是平台数据问数助手。只能用提供的工具回答，不要臆造指标名或数字。',
  '你看到的数据**已经按当前用户权限裁剪过**：看不到的指标就是没权限，直接说明即可。',
  '工具返回 status=denied 时，用其中 reason 向用户解释，不要重试同一个调用。',
  ...GUIDE_INVARIANTS, // 通道中性硬约束：与 guide.ts（B）、SKILL.md（C）同源（决策 D-G1）
].join('\n')
```

③ 工具面：现有 `TOOLS` 数组改名 `LEGACY_TOOLS`（内容与注释不动），其后加：

```ts
/**
 * 通道 A 绑定的 registry 子集（Wave 2 决策 D-A1）：三把全只读、实现/文案/schema 全部同源直取
 * `ANALYST_TOOLS`（零第二份）；执行走 callTool 单点（审计含拒绝/出错）。
 * 刻意不绑 search_catalog（list_metrics 已覆盖）/describe_dataset/preview_query（A 无切片形状）/
 * get_quality/get_lineage（无已观测需求）——LLM 面最小化，6 把封顶。
 */
const BOUND_TOOL_NAMES: readonly string[] = ['describe_metric', 'sample_dimension_values', 'get_freshness']
const REGISTRY_TOOLS: ToolSpec[] = ANALYST_TOOLS
  .filter((t) => BOUND_TOOL_NAMES.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

export const TOOLS: ToolSpec[] = [...LEGACY_TOOLS, ...REGISTRY_TOOLS]
```

④ `runAgentLoop`：循环前构建一次 toolbox（requester 每轮固定），循环内传给 runTool（legacy 分支仍要 `deps`/`requester`——`execute` 只在 AgentDeps 上、runQuery/runDetailQuery 要 requester，故 toolbox 是**追加**参数不是替换）：

```ts
  const toolbox = buildToolboxDeps(
    { pool: deps.pool, org: deps.org, requester, adoptedSources: deps.adoptedSources },
    { wh: deps.execute },
  )
```

循环体内两处：

```ts
      const result = await runTool(call, catalog, deps, requester, toolbox)
      if (result.status === 'ok') lastTable = { columns: result.columns, rows: result.rows }
      // toolbox 分支回 payload 原体；其余分支回整个 result（既有形态不动）
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result.status === 'toolbox' ? result.payload : result) })
```

⑤ `runTool`：签名追加第 5 参 `toolbox: ToolboxDeps`（原 `(call, catalog, deps, requester)` 四参不动）；返回联合加成员 `{ status: 'toolbox'; payload: Record<string, unknown> }`；在 `list_metrics` 分支**之前**加：

```ts
  // registry 子集（Wave 2）：走 callTool 单点——未知/未认证/mutating 闸/审计（含拒绝）全继承。
  // payload 的 status 字段保持 impl 原形（ok/denied/not_found/unknown），模型按文案自解释。
  if (BOUND_TOOL_NAMES.includes(call.name)) {
    const out = await callTool(toolbox, call.name, call.arguments)
    return { status: 'toolbox', payload: out.payload }
  }
```

`describeCall` 加三支（在 `list_metrics` 判断后；文案只含 id/维度名，非敏感）：

```ts
  const str = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : '(未指定)')
  if (call.name === 'describe_metric') return `查指标详情 ${str(call.arguments.id)}`
  if (call.name === 'sample_dimension_values') return `抽样维度值 ${str(call.arguments.metricId)}.${str(call.arguments.dimension)}`
  if (call.name === 'get_freshness') return `查新鲜度 ${str(call.arguments.scope) === '(未指定)' ? '全局' : str(call.arguments.scope)}`
```

（`metricIdOf`/既有 query 分支原样保留；`MAX_AGENT_TURNS` 不动。）

- [ ] **Step 4: 跑测试确认通过（新用例 + 既有用例）**

Run: `pnpm --filter data vitest run domain/agent-loop.test.ts`
Expected: PASS（新 6 用例 + 既有全部）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/agent-loop.ts modules/data/domain/agent-loop.test.ts
git commit -m "feat(data): 通道 A 绑定 registry 子集 describe/sample/freshness（callTool 单点，guide 同源入提示词）"
```

---

### Task 5: 通道 A SSE 事件序列快照 e2e（spec §9 Wave 2 验收项）

**Files:**
- Test: `modules/data/routes/chat.test.ts`（只加用例，不改实现）

**Interfaces:**
- Consumes: Task 4 的绑定（TOOLS 三新工具 + activity 文案）；该文件既有脚手架 `setLlmEnv`/`buildTestApp`/`applyMigrations`/`makeIdentity`/`ORG`。
- Produces: 无新接口——快照用例把「activity → final」全事件序列钉死为验收锚。

- [ ] **Step 1: 写快照用例（此用例本身就是「先红」——Task 4 未合时它对不上工具名而红；本任务在 Task 4 之后执行，落地即应绿）**

在 `chat.test.ts` 的 `describePg('POST /chat 的 SSE 形状（需要 DATABASE_URL；fetch stub 成脚本化 LLM）')` 组内追加（复用该组既有的 `parseEvents` helper 与 `afterEach(vi.unstubAllGlobals)`；快照需要**自己的** fakeWh，不复用组内那份 `execute`）：

```ts
  it('SSE 事件序列快照：activity(get_freshness) → final（无表）；LLM 工具面含 registry 子集', async () => {
    setLlmEnv(true)
    // 全局新鲜度支只读 data.load_log ⇒ execute 注入一行即确定。
    const fakeWh = (async () => ({
      rows: [['fct_retail_sale', '2026-10-20', new Date('2026-10-21T02:10:00+08:00')]],
    })) as unknown as SqlExecutor
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: fakeWh })
    const llmCalls: { tools: { function?: { name?: string } }[] }[] = []
    const turns = [
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_freshness', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: '数据截至 2026-10-20。' } }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: { function?: { name?: string } }[] }
      llmCalls.push({ tools: body.tools ?? [] })
      return new Response(JSON.stringify(turns[Math.min(llmCalls.length - 1, turns.length - 1)]), { status: 200 })
    }))
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '数据到几号了' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    // LLM 面断言：三把 registry 子集工具随请求下发（绑定的路由级证据）
    const names = llmCalls[0]!.tools.map((t) => t.function?.name)
    expect(names).toEqual(expect.arrayContaining(['describe_metric', 'sample_dimension_values', 'get_freshness']))
    // ★ 事件序列快照（spec §9 Wave 2 验收锚）：整表 deep-equal，非 toMatchObject
    const events = parseEvents(await res.text())
    expect(events).toEqual([
      { type: 'activity', tool: 'get_freshness', detail: '查新鲜度 全局' },
      { type: 'final', text: '数据截至 2026-10-20。' },
    ])
  })
```

（事件解析用组内既有 `parseEvents`；本用例不新增 helper。）

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm --filter data vitest run routes/chat.test.ts`
Expected: PASS（新快照用例 + 既有 SSE 用例全绿）。

- [ ] **Step 3: Commit**

```bash
git add modules/data/routes/chat.test.ts
git commit -m "test(data): 通道 A SSE 事件序列快照 e2e（registry 子集进 LLM 面，spec §9 Wave 2 验收锚）"
```

---

### Task 6: 多通道共存回归——/toolbox 上钉 PAT 通路（#983 形态）

**Files:**
- Test: `apps/server/src/wecom-channel-auth.test.ts`（只加用例；既有「多通道共存」用例（钉 PAT 不受通道 C 影响）**原样保留，一行不动**）

**Interfaces:**
- Consumes: 既有测试脚手架 `baseTenant`/`casdoorFor`/`withAlice`/`CHANNEL_KEY`/`patIdentityMiddleware`/`wecomChannelIdentityMiddleware`。
- Produces: 无新接口——回归锚。

- [ ] **Step 1: 在既有 describe 内追加两条用例（中间件装配照既有「多通道共存」用例逐字同法，只换 handler 路径）**

```ts
  it('多通道共存 ×/toolbox：通道 C 开启 + 合法 PAT（无企微意图头）→ pat 身份放行（Wave 2 新路由同规）', async () => {
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => { c.set('tenant', baseTenant); await next() })
    a.use('/api/modules/*', patIdentityMiddleware({
      casdoor: casdoorFor(mock),
      resolveKey: async (token) =>
        token === 'dkq_valid-pat-token' ? { keyId: 1, org: ORG, casdoorUser: 'alice' } : null,
    }))
    a.use('/api/modules/*', wecomChannelIdentityMiddleware({ casdoor: casdoorFor(mock), channelKey: CHANNEL_KEY }))
    a.post('/api/modules/data/toolbox', (c) => c.json({
      userId: c.get('identity')?.userId ?? null,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
    }))
    const res = await a.request('/api/modules/data/toolbox', {
      method: 'POST', headers: { authorization: 'Bearer dkq_valid-pat-token' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ userId: 'alice', channel: 'pat' })
    await mock.stop()
  })

  it('多通道共存 ×/toolbox：带企微意图 → wecom 身份（新路由走同一闸，fail-closed 同链）', async () => {
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => { c.set('tenant', baseTenant); await next() })
    a.use('/api/modules/*', patIdentityMiddleware({
      casdoor: casdoorFor(mock),
      resolveKey: async (token) =>
        token === 'dkq_valid-pat-token' ? { keyId: 1, org: ORG, casdoorUser: 'alice' } : null,
    }))
    a.use('/api/modules/*', wecomChannelIdentityMiddleware({ casdoor: casdoorFor(mock), channelKey: CHANNEL_KEY }))
    a.post('/api/modules/data/toolbox', (c) => c.json({
      userId: c.get('identity')?.userId ?? null,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
    }))
    const res = await a.request('/api/modules/data/toolbox', {
      method: 'POST',
      headers: { 'x-channel-key': CHANNEL_KEY, [WECOM_USERID_HEADER]: 'alice' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ userId: 'alice', channel: 'wecom' })
    await mock.stop()
  })
```

两条合起来钉：**同一新端点上，PAT 与企微意图互不干扰，通道 C 开启不影响 PAT 通路**（#983 修的形态）。

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm --filter @platform/server vitest run src/wecom-channel-auth.test.ts`
Expected: PASS（既有 10 用例 + 新 2 用例）。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/wecom-channel-auth.test.ts
git commit -m "test(server): 多通道共存回归钉 /toolbox——通道 C 开启不影响 PAT 通路（#983 形态护栏延伸）"
```

---

### Task 7: 通道 C——插件三新工具 + SKILL.md v3 + README（人工部署前的一切仓内工作）

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/index.js`
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`（v3）
- Modify: `deploy/openclaw/data-query-plugin/README.md`
- Modify: `deploy/openclaw/data-query-plugin/package.json`（test 脚本扩到全部 *.test.js）
- Test: `deploy/openclaw/data-query-plugin/lib.test.js`（只加「新工具请求形状」的纯函数用例）

**Interfaces:**
- Consumes: `callPlatform`/`normalizeParams`/`toToolResult`/`freshnessStore`/`factory`（index.js 既有）；Task 3 的 `POST /toolbox` 契约。
- Produces: 三个新 OpenClaw 工具 `describe_metric` / `sample_dimension_values` / `get_freshness`（native 形态不变：`api.registerTool(factory(def, run, onResult), { name })`，安装路径不变）。

- [ ] **Step 1: 写失败测试（lib.test.js 追加；钉「请求形状」而不钉 index.js 装配——装配由真机目视验）**

```js
// ── Wave 2：/toolbox 三新工具的请求形状（body 由 callPlatform 原样外发）─────────
const toolboxBody = (args) => ({ apiBase: "http://x/api", channelKey: "k", userId: "u1", path: "/toolbox", method: "POST", body: args });

test("toolbox：describe_metric 的 body 形状 {tool, args:{id}}", async () => {
  const f = stubFetch(200, { status: "ok", id: "lemeng:retail:net_sales" });
  await callPlatform(toolboxBody({ tool: "describe_metric", args: { id: "lemeng:retail:net_sales" } }));
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { tool: "describe_metric", args: { id: "lemeng:retail:net_sales" } });
  assert.equal(f.calls[0].url, "http://x/api/toolbox");
});
test("toolbox：not_found 走 403 → DENIED 文案（存在性不区分的既有约定不被新工具破坏）", async () => {
  const f = stubFetch(403, { status: "not_found", metricId: "x" });
  const r = await callPlatform(toolboxBody({ tool: "describe_metric", args: { id: "x" } }));
  assert.equal(r.code, "DENIED");
  assert.match(r.error, /可见范围/);
});
test("toolbox：get_freshness 的 unknown 回包 200 原样透传（未知≠错误，模型如实转述）", async () => {
  const f = stubFetch(200, { status: "unknown", reason: "no_freshness_chain", scope: "lemeng:retail:net_sales" });
  const r = await callPlatform(toolboxBody({ tool: "get_freshness", args: { scope: "lemeng:retail:net_sales" } }));
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "no_freshness_chain");
});
test("toolbox：403 bad_param → 参数文案带 detail（与 /query 同映射，零新逻辑）", async () => {
  const f = stubFetch(403, { status: "denied", reason: "bad_param", detail: "unknown_dimension:store" });
  const r = await callPlatform(toolboxBody({ tool: "sample_dimension_values", args: { metricId: "m", dimension: "store" } }));
  assert.equal(r.code, "BAD_PARAM");
  assert.match(r.error, /unknown_dimension:store/);
});
```

- [ ] **Step 2: 跑测试确认失败/通过（形状用例只钉 callPlatform 透传——callPlatform 已支持，预期直接绿；红则说明 body/path 被改，先修再走）**

Run: `cd deploy/openclaw/data-query-plugin && node --test lib.test.js`
Expected: PASS（新 4 + 既有全部）。若红：不许改 callPlatform 的既有分支来「就形状」，回查用例 body 是否笔误。

- [ ] **Step 3: index.js 注册三工具（native 形态逐字同法：factory(def, run, onResult)）**

在 `DETAIL_DEF` 注册块之后追加：

```js
// ── Wave 2（spec §9）：registry 子集三工具，经 POST /toolbox（registry 的 HTTP 薄封装）调用。
// 与既有两工具同一 callPlatform/同一错误文案映射/同一捕获机制——插件仍零权限逻辑。
const DESCRIBE_DEF = {
  name: "describe_metric",
  description:
    "按 id 取指标详情：口径定义/粒度维度/参数/归属/档位/版本/新鲜度。args 键或维度名拿不准时先调它（id 取自 list_metrics）；sample_dimension_values 的 dimension 必须是这里 grain 里的一员。",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "指标 id（来自 list_metrics）" } },
    required: ["id"],
    additionalProperties: false,
  },
};
const SAMPLE_DEF = {
  name: "sample_dimension_values",
  description:
    "取某指标某维度的取值与频次（≤50 行），用于确认过滤值/分组维度的确切写法（如门店名）。dimension 必须是该指标粒度维度之一（describe_metric 返回的 grain）；回包 truncated=true 时只说明「值太多被截断」，不是数据错误。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id" },
      dimension: { type: "string", description: "维度名（grain 之一）" },
      q: { type: "string", description: "子串过滤（可选）" },
      limit: { type: "number", description: "1–50，缺省 50" },
    },
    required: ["metricId", "dimension"],
    additionalProperties: false,
  },
};
const FRESHNESS_DEF = {
  name: "get_freshness",
  description:
    "数据截止日/物化时刻/滞后秒。scope=指标 id 查该指标链路水位；缺省查全局水位。用户问「数据到几号/新不新」用它，不要靠猜。回 status=unknown 如实说「新鲜度未知」，不要编。",
  parameters: {
    type: "object",
    properties: { scope: { type: "string", description: "指标 id（缺省 = 全局）" } },
    required: [],
    additionalProperties: false,
  },
};
api.registerTool(
  factory(DESCRIBE_DEF, (params, userId) =>
    callPlatform({
      apiBase, channelKey: CHANNEL_KEY, userId,
      path: "/toolbox", method: "POST",
      body: { tool: "describe_metric", args: { id: params.id } },
    }),
  ),
  { name: DESCRIBE_DEF.name },
);
api.registerTool(
  factory(SAMPLE_DEF, (params, userId) =>
    callPlatform({
      apiBase, channelKey: CHANNEL_KEY, userId,
      path: "/toolbox", method: "POST",
      body: {
        tool: "sample_dimension_values",
        args: {
          metricId: params.metricId,
          dimension: params.dimension,
          ...(typeof params.q === "string" && params.q ? { q: params.q } : {}),
          ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        },
      },
    }),
  ),
  { name: SAMPLE_DEF.name },
);
api.registerTool(
  factory(
    FRESHNESS_DEF,
    (params, userId) =>
      callPlatform({
        apiBase, channelKey: CHANNEL_KEY, userId,
        path: "/toolbox", method: "POST",
        body: { tool: "get_freshness", args: { ...(typeof params.scope === "string" && params.scope ? { scope: params.scope } : {}) } },
      }),
    // 捕获 get_freshness 回包的正典 📅 行（metric 支才有 line 字段）。不捕获的话：模型转述该行
    // 会被 message_sending 钩子剥掉、又没有捕获可重附 ⇒ 新鲜度行静默丢失（决策 D-F1）。
    (result, sessionKey, runId) => {
      if (!result) return;
      const line = typeof result.line === "string" && result.line ? result.line : undefined;
      if (line) freshnessStore.capture(sessionKey, { freshness: line }, runId);
    },
  ),
  { name: FRESHNESS_DEF.name },
);
```

- [ ] **Step 4: SKILL.md v3（同源硬约束逐字入文 + 三新工具入方法论）**

`SKILL.md` 四处修改：

① frontmatter 的 `description` 改为：

```yaml
description: 平台问数。用户问业务数据（销售额/订单/商品/门店/趋势等）时激活：先 list_metrics 看可见词表，describe_metric 看口径，query_data 查数，用表格/要点汇报。
```

② 「查询约定」警告块第一句改为（exec/curl 禁令原样保留）：

```markdown
> ⚠️ **问数取数只走 `list_metrics` / `query_data` / `query_detail`；口径与维度值确认走 `describe_metric` / `sample_dimension_values`；「数据到几号/新不新」走 `get_freshness`。**
```

③ 紧接警告块之后新增一节（**四行逐字取自 `modules/data/domain/toolbox/guide.ts` 的 `GUIDE_INVARIANTS`**——由 Task 8 门禁机检，改这里必须先改 guide.ts）：

```markdown
## 同源硬约束（与平台 data_agent_guide 逐字同源）

· 主体（org/租户/数据主体）由平台按身份钉死：不要索要、不要猜测，参数里出现即被拒；
· 行上限 1000，truncated=true 说明被截断：不得把截断集当全量下结论，也不得对截断集自行求和；
· 合计以回包的 total 字段为准：字段在场就直接引用，不要自己把行加总；切片/截断产生的部分合计不是全局合计；
· 数据截止与新鲜度必须如实呈现：回包没有相应字段或正典行 = 新鲜度未知，如实说明，不要编；
```

④ 「明细下钻」节之后新增：

```markdown
## 口径确认与新鲜度（Wave 2 三新工具）

- **`describe_metric({ id })`**：args 键/维度名拿不准先调它——params（键与形状）、grain（维度全集）、口径定义都在回包里。**先 describe 再查**，不要凭记忆猜键名。
- **`sample_dimension_values({ metricId, dimension, q?, limit? })`**：确认「门店名等过滤值的确切写法」用它（dimension 必须是 grain 之一）。`truncated:true` = 值太多被截断，可加 `q` 收窄——它不是数据错误。
- **`get_freshness({ scope? })`**：`scope` 缺省查全局水位。回 `status:"unknown"` = 新鲜度未知，如实说明。指标支回包的 `line`（📅 行）由系统自动附加到消息末尾——**不要自己写任何 📅 行**（写了也会被系统剥掉再统一附加）。
```

- [ ] **Step 5: README 工具表 + package.json test 脚本**

README「## 工具」表补 4 行（既有漏登的 query_detail 一并补）：

```markdown
| 工具 | 作用 |
|---|---|
| `list_metrics` | `GET {DATA_API_BASE}/metrics`——当前用户可见词表（按人裁剪） |
| `query_data` | `POST {DATA_API_BASE}/query` `{metricId,args}`——查数，回包带 subject |
| `query_detail` | `POST {DATA_API_BASE}/query/detail`——明细下钻（声明了下钻的指标） |
| `describe_metric` | `POST {DATA_API_BASE}/toolbox` `{tool,args}`——指标详情（Wave 2） |
| `sample_dimension_values` | `POST {DATA_API_BASE}/toolbox`——维度值抽样 ≤50 行（Wave 2） |
| `get_freshness` | `POST {DATA_API_BASE}/toolbox`——新鲜度/水位（Wave 2；📅 行进捕获链） |
```

`package.json` 的 scripts.test 改为 `"test": "node --test"`（发现 lib.test.js + scope.test.js 全量）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd deploy/openclaw/data-query-plugin && node --test`
Expected: PASS（lib.test.js + scope.test.js 全绿；既有断言零改动 = 「既有工具逐字节兼容」的钉子）。

- [ ] **Step 7: Commit**

```bash
git add deploy/openclaw/data-query-plugin
git commit -m "feat(openclaw): 通道 C 加 describe/sample/freshness 三工具（/toolbox 薄客户端）+ SKILL v3 同源硬约束"
```

---

### Task 8: check-guide-sync 门禁——guide↔SKILL 同源机检接进 CI

**Files:**
- Create: `scripts/check-guide-sync.mjs`
- Create: `scripts/check-guide-sync.test.ts`
- Modify: `.github/workflows/ci.yml`（gates job 加一步，紧跟 `check-mcp-toolface.mjs` 那步之后）

**Interfaces:**
- Consumes: `GUIDE_INVARIANTS`（guide.ts——纯文件，可被门禁 import，registry 同款先例）。
- Produces: `checkGuideSync(invariants: readonly string[], skillText: string): string[]`（判据纯函数）；`pnpm exec tsx scripts/check-guide-sync.mjs` 干净 exit 0、违规 exit 1。

- [ ] **Step 1: 写失败测试**

Create `scripts/check-guide-sync.test.ts`（照 check-mcp-toolface.test.ts 的双段式：纯判据 + 真仓断言 + CI 接线断言）：

```ts
// scripts/check-guide-sync.test.ts — guide↔SKILL 同源门禁的判据与真仓断言。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkGuideSync } from './check-guide-sync.mjs'
import { GUIDE_INVARIANTS } from '../modules/data/domain/toolbox/guide.ts'

describe('checkGuideSync：判据', () => {
  it('SKILL 含全部不变量行 + 三新工具名 ⇒ 0 条', () => {
    const skill = GUIDE_INVARIANTS.join('\n') + '\ndescribe_metric sample_dimension_values get_freshness'
    expect(checkGuideSync(GUIDE_INVARIANTS, skill)).toEqual([])
  })
  it('缺任一行 ⇒ 逐行点名 [GUIDE-SYNC]；缺工具名 ⇒ 点名', () => {
    const out = checkGuideSync(GUIDE_INVARIANTS, GUIDE_INVARIANTS.slice(1).join('\n'))
    expect(out).toHaveLength(4) // 缺第一行（1）+ 三个工具名全缺（3）
    expect(out[0]).toContain('[GUIDE-SYNC]')
  })
})

describe('真仓：SKILL.md v3 与 GUIDE_INVARIANTS 逐字同源；CI 已接线', () => {
  const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'openclaw', 'data-query-plugin', 'skills', 'data-query', 'SKILL.md'), 'utf8')
  it('四行硬约束逐字在场；三新工具已入文', () => {
    expect(checkGuideSync(GUIDE_INVARIANTS, skill)).toEqual([])
  })
  it('ci.yml 已接线本门', () => {
    const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('check-guide-sync.mjs')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm run test:guard -- check-guide-sync`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现门禁脚本**

Create `scripts/check-guide-sync.mjs`：

```js
#!/usr/bin/env node
// check-guide-sync.mjs — guide↔SKILL 同源门禁（Wave 2 决策 D-G1）。
// guide.ts 是三通道同源内容的事实源：A 编译期 import（改动即编译错）、B 内嵌、C 消费静态 md
// 无法 import TS ⇒ 只有这里能机检。SKILL.md 漏抄/改写同源行 ⇒ 本门红。
// 用法：pnpm exec tsx scripts/check-guide-sync.mjs；干净 exit 0，违规 exit 1（stderr 逐行 [GUIDE-SYNC]）。
import { readFileSync } from 'node:fs'
import { GUIDE_INVARIANTS } from '../modules/data/domain/toolbox/guide.ts'

const SKILL_PATH = new URL('../deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md', import.meta.url)
const REQUIRED_TOOL_NAMES = ['describe_metric', 'sample_dimension_values', 'get_freshness']

/**
 * 判据纯函数（单测直接喂桩文本）。
 * @param {readonly string[]} invariants
 * @param {string} skillText
 * @returns {string[]}
 */
export function checkGuideSync(invariants, skillText) {
  const out = []
  for (const line of invariants) {
    if (!skillText.includes(line)) out.push(`[GUIDE-SYNC] SKILL.md 缺同源硬约束行（须与 guide.ts GUIDE_INVARIANTS 逐字一致）：${line}`)
  }
  for (const t of REQUIRED_TOOL_NAMES) {
    if (!skillText.includes(t)) out.push(`[GUIDE-SYNC] SKILL.md 未提及工具 ${t}（Wave 2 三新工具必须入文）`)
  }
  return out
}

if (process.argv[1]?.endsWith('check-guide-sync.mjs')) {
  const violations = checkGuideSync(GUIDE_INVARIANTS, readFileSync(SKILL_PATH, 'utf8'))
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log('check-guide-sync: OK')
}
```

- [ ] **Step 4: ci.yml 接线**

`.github/workflows/ci.yml` gates job 中 `check-mcp-toolface.mjs` 那一步之后加：

```yaml
      # guide↔SKILL 同源（Wave 2）：SKILL.md 漏抄/改写 GUIDE_INVARIANTS 即红（D-G1 机检）
      - run: pnpm exec tsx scripts/check-guide-sync.mjs
```

- [ ] **Step 5: 跑测试与真仓门禁确认通过**

Run: `pnpm run test:guard -- check-guide-sync`
Expected: PASS。
Run: `pnpm exec tsx scripts/check-guide-sync.mjs`
Expected: `check-guide-sync: OK`。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-guide-sync.mjs scripts/check-guide-sync.test.ts .github/workflows/ci.yml
git commit -m "chore(ci): guide↔SKILL 同源门禁 check-guide-sync 接线（GUIDE_INVARIANTS 机检）"
```

---

### Task 9: 全量验证 + PR（含人工步骤清单）

**Files:** 无新文件；PR 组装与验证。

- [ ] **Step 1: 全量验证（本仓 CI 跑的全部命令，不只本 wave 相关）**

```bash
pnpm test                 # 全 workspace 测试 + scripts 守卫单测
pnpm typecheck            # tsc 全 workspace + scripts
pnpm --filter @platform/web build && pnpm smoke   # 装载冒烟（需要 DATABASE_URL）
pnpm exec tsx scripts/check-mcp-toolface.mjs      # 分析师面四断言（Wave 2 未动 ANALYST_TOOLS，必须仍 OK）
pnpm exec tsx scripts/check-guide-sync.mjs        # 新门
pnpm exec tsx scripts/check-manifests.mjs         # 声明↔路由（/toolbox 双向核对）
cd deploy/openclaw/data-query-plugin && node --test && cd -   # 插件全量
```

Expected: 全绿。任何一条红 → 修完重跑全量，不带病进 PR。

- [ ] **Step 2: 推分支开 PR**

PR 标题：`feat(data): 数据面 MCP Wave 2——三通道同享（A/C 绑定）`
PR body 首行：`Closes #985`；正文附：本计划的「关键决策记录」四条 + 「spec 冲突点记录」四条 + 下方人工步骤清单（评审人要知道哪些不自动发生）。

- [ ] **Step 3: 人工步骤清单（标注给评审人；不自动触发企微消息）**

1. **【人工】合并**：CI 全绿后 squash 合并（subject 带 `(#985)`）。合并即触发平台面（单元 A）自动部署（platform-core 已启用 merge main = 部署；但**山海生产实例不在自动部署通路**）。
2. **【人工】山海部署窗口**：按 `deploy/data-plane-deploy-sop.md` 窗口 + 记忆条目「山海一键更版 webhook + 常规节奏」执行（等 main 更版 → 手动触发山海 → 验产物，判据 `activeDeploymentStatus`）。openclaw 插件随单元 A 镜像构建期 COPY（`deploy/Dockerfile.openclaw`），部署即插件更新，安装命令与路径不变。
3. **【人工】企微目视验收（两条，真机企微发消息；绝不由任何脚本/agent 自动触发企微消息）**：
   - **成功话术**：问一记正常数（如「上周销售额多少」）⇒ 答案数值正确、末尾恰一行 📅（与 `freshness_line` 一致）且涉及射程时有 📐；
   - **截断话术**：构造大区间裸查（如「最近 30 天每天的销售额」）⇒ bot 按 SKILL 答「数据不全」/收窄或转 total，不得把截断集当全量；
   - （Wave 2 增量抽验）问「数据到几号」⇒ bot 调 `get_freshness` 回答，答案末尾恰一行 📅（D-F1 捕获链生效）；问「有哪些门店」⇒ 走 `sample_dimension_values`，值与频次如实汇报。
4. **【人工】回填验收读数**到 issue `#985`（案例沉淀；无案例不立标准的「案例」半边）。

---

## 验收对照（spec §9 Wave 2 / §10 逐条）

| spec 要求 | 落点 |
|---|---|
| agent-loop 绑 registry 子集（去重实现） | Task 4（D-A1：三把，实现/文案/schema 同源直取） |
| 插件加 describe/sample/freshness 三工具与 SKILL v3 | Task 7（经 POST /toolbox，D-C1） |
| guide 文案三处同源 | Task 1（源）+ Task 4（A import）+ Task 7（C 入文）+ Task 8（C 机检门） |
| 通道 A e2e（SSE 事件序列快照） | Task 5 |
| 插件 `node --test lib.test.js` | Task 7 Step 6（扩为 `node --test` 全量，原命令仍可跑） |
| 山海部署 + 企微目视两条 | Task 9 Step 3（**人工**，不自动触发企微消息） |
| 通道 C 开启时 PAT 通道不受影响（#983 形态回归） | Task 6（既有「多通道共存」用例保留 + /toolbox 延伸两条） |
| §10「插件既有两工具逐字节兼容」 | Task 7 Step 6（lib.test.js/scope.test.js 既有断言零改动全绿） |
| §10「审计：拒绝与出错也写」 | Task 3/4（callTool 单点；A 补齐审计，C channel='wecom' 有专测） |
| Global Constraints 全部 | ANALYST_TOOLS 零改动（toolface 门仍绿）；无新 env 键（B9 免查）；compose 零改动（B7 免查） |

## 明确不做（本 wave 边界，防执行者越界）

- 不动 `ANALYST_TOOLS`（不加/不改/不删）、不动 `scripts/check-mcp-toolface.mjs` 断言；
- 不动通道 A 既有三工具的定义、文案与执行路径（list_metrics/query_metric/query_detail 原样）；
- 不实现 `data:sql`、RAG、OAuth、T1 提案面（spec §2 非目标 / §11）；
- 不改 compose、不改 `Dockerfile.openclaw`、不改插件安装命令与路径；
- 不在仓库内做任何「自动发企微消息」的验证动作。
