# 数据面 MCP Wave 3 —— T1 提案面 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 platform-core 的 `/mcp-manage`（scope `data:manage`）上挂出 spec §7 的 7 个 T1 提案面工具：4 个只读（管线清单/详情、运行记录清单/详情）+ 3 个写（沙箱试跑、管线草案、契约草案），全部入审计、写工具受 `DATA_MCP_ALLOW_MUTATING` 总闸管。

**Architecture:** 复用既有「管理面 = 多工具片合成」扩展点（`mcp-manage.ts` 的 `GROUPS`，加一片只改一行），**不碰分析师面**（`ANALYST_TOOLS` 仍是 11 个，≤14 预算不动）。领域层新增 `modules/data/domain/pipelines/`：磁盘定义读取（`defs.ts`）、纯校验（`validate.ts`）、草案生成（`propose.ts`）、运行记录 seam（`runs.ts`）。所有判定/审计落在路由片的单点。

**Tech Stack:** TypeScript / Hono（既有协议壳 `mcp-rpc.ts`）/ `node:fs`（只读仓内文件）/ 既有 vitest 门禁体系；**不新增运行时依赖**。

## Global Constraints（继承 spec 2026-10-21 §Global Constraints，逐条适用本 Wave）

- **授权核心单实现**：任何通道/工具不得自建权限判定。本 Wave 的工具**不查询业务数据**，故不涉及 `authorizeCore`；页面门由 manifest 的 `POST /mcp-manage → data:manage` 施加，本模块**不写 requireScope**。
- **fail-closed**：空身份（`deps.requester === null`）⇒ 空工具面（`list` 返回 `[]`）+ 调用一律 `denied/unauthenticated`。
- **写开关默认关**：3 个 mutating 工具在 `DATA_MCP_ALLOW_MUTATING !== 'true'` 时回 `denied/mutating_disabled`（复用 `registry.ts` 的 `mutatingAllowed`，纯函数）。
- **审计**：7 个工具的**所有结局**（ok/denied/error）写 `data.query_audit`（`tool` 字段 = 工具名）。
- **红线**：不直写 `contracts/`、`duckle/`、`deploy/duckle/console/` 任何**仓内/镜像内**正式目录；试跑不进调度；每步入审计。
- **不新增运行时依赖**；不新增 `process.env.KEY` 而不在根 `.env.example` 声明（B9 门禁）。
- **工具名**守 MCP 2025-11-25 `[A-Za-z0-9_.-]`；mutating 工具必须带 `annotations` 与 `requiredScope`。
- **无案例不立标准**：任何「未验证的运行时能力」一律回**显式 unknown/not_executed**，不得编造成功。

---

## 0. 开工前必须知道的两条设计决定（**已按推荐值写死本计划；人有异议则改计划再动工**）

### D-W3-1 工具面落点 = `/mcp-manage` 的新工具片（不是 `/mcp`）

spec §7 自己写明「通道 B，`data:manage`」，而 `POST /mcp-manage` 已声明 `scope: data:manage`（`modules/data/manifest.yaml`），且 `mcp-manage.ts` 的头注写着**「加新片只改这一行（协议壳与门档都不动）」**。

- 好处：① 分析师面预算（11/14）与 `tools/list ≤10KB` 门**完全不动**；② 7 个工具天然只对持 `data:manage` 的 Key 可见 ⇒ 提案面不会泄给普通问数 Key；③ manifest 无需新增端点（想新开端点必得动 `api.internal`，装载期双向核对要求同提交对齐，纯增风险）。
- 代价：7 个工具与「口径片 / 报表片」共用一个 `serverInfo.name`（`platform-data-mcp-manage`）。可接受。

### D-W3-2 读面的数据源 = **镜像内的仓内文件**；工具**绝不联网、绝不连 openship**

真机实测（2026-10-22，shanhai 生产 `server` 容器）：

```
/app/duckle            → No such file or directory
/app/contracts         → No such file or directory
duckle / duckle-runner → 未安装
```

而管线/调度/契约在仓内的实际位置是：

| 资产 | 仓内路径 | 是否已在镜像 | 依据 |
|---|---|---|---|
| 管线 JSON（28 个） | `deploy/duckle/console/pipelines/*.json` | ✅ 已在（`COPY deploy ./deploy`） | `deploy/Dockerfile.server:86,128` |
| 调度定义 | `deploy/duckle/console/schedules/<账套>.json` | ✅ 已在 | 同上 |
| 数据契约（19 个） | `contracts/common/*.json` | ❌ **不在** | `Dockerfile.server` 的 COPY 清单无 `contracts` |

⇒ 本 Wave **新增 `COPY contracts ./contracts`**（与 `dbt/` 同性质：运行时只读的仓内事实源），并通过两个 env 缝定位：`DATA_PIPELINES_ROOT`（缺省 `<cwd>/deploy/duckle/console`）、`DATA_CONTRACTS_ROOT`（缺省 `<cwd>/contracts`）。容器 WORKDIR 是 `/app`，缺省值天然正确。

**不采用的方案（各有硬阻塞，写在这里免得后来者重走）：**
- **走 OpenShip API**（spec §7 原文）：platform-core **没有任何 openship 客户端**，容器内也没有 openship token；把自己平台的 API 变成问数面运行时依赖，等于把「读一份 JSON」升级成「跨系统认证链」，本轮无案例支撑。
- **读 duckle console HTTP**：两个 console（`lemeng-console-3120/64188`）只绑 `127.0.0.1:18080/18081`，且与 platform-core 在**不同 compose 项目/不同网络**；openship 明确不建模 `extra_hosts`、硬拒 `network_mode: host`（2026-10-21 实测）⇒ 容器到宿主回环无路。
- **GitHub API 运行时读**：引入 token + 网络 + 速率限制，读面不再 hermetic。

### D-W3-3 运行记录（`list_pipeline_runs` / `get_pipeline_run`）本轮**只建 seam，不接数据**

真实运行记录在 **duckle console 的 workspace 卷**里（`/workspace/runs/<pipeline_id>.json`，留 50 条；`/workspace/runs/receipts/`，留 200 条 —— 见 `deploy/duckle/console/README.md` §排障入口）。那是 **per-账套 的 Docker 命名卷**（`<project>-lemeng-console-<账套>-ws`），platform-core 的 server 容器**既看不到卷、也够不到那个回环端口**（理由同 D-W3-2）。

⇒ 两个工具实现为 **seam**：装配期 `runs` 为 `null` 时回

```json
{ "status": "unknown", "reason": "runs_source_not_wired", "note": "…（真机阻塞事实 + 待沉淀标记）" }
```

这与 `get_quality` 的「无结论必须显式未知」同一条纪律：**未知 ≠ 没有失败**。等哪天 console 有了可企及的 API（或 runs 落到平台库），只需实现 `PipelineRunSource` 并注入，两个工具即刻转真 —— 工具面与审计不用改。

### D-W3-4 `run_pipeline_sandbox` 本轮是**校验闸**，不是执行器

容器内没有 duckle 二进制（实测），也没有跑 duckle 的容器入口。而 spec 的红线是「产物写 `__sandbox` 前缀，不入正式湖」。

⇒ 本轮该工具做三件**能验证**的事，并**明说没跑**：

1. 结构校验草案（`validatePipelineDraft`）；
2. **沙箱前缀断言**（`sandboxViolations`）：所有 `snk.minio` 的 `properties.key` 必须以 `__sandbox/` 开头；所有 `snk.csv` 的 `path` 必须以 `/workspace/logs/sandbox/` 开头；**出现 `snk.webhook` 即违规**（沙箱试跑不得对外发数据）；任一违规 ⇒ `denied/sandbox_prefix_violation`；
3. 通过则回 `{ "status": "not_executed", "reason": "sandbox_runner_unavailable", … }`。

**执行侧标「待沉淀」**：需要一个「能在隔离前缀上真跑 duckle」的运行面（镜像里装 duckle → 或由数据面项目起一次性 runner → 或 openship job），且 CLI 调用形态须真机验证。**在验证之前不写任何 CLI 参数**（编一套 `duckle run --xyz` 就是假标准）。

### D-W3-5 草案产物 = **内存中的三件套草案**，不落盘、不开 PR

spec §7 写「落 PR 分支」。本轮**不做**分支写入，理由：platform-core 无 GitHub 客户端、无 token 管道，从生产容器推分支是新的信任面（且需要人另行授权）。本轮的 `propose_*` 只产出：

- `pieces[]`：仓内相对路径 + 完整文件内容（管线片 / 契约片），**只在响应里**；
- `downstream[]`：还差哪些件（dbt staging 模型等）+ 为什么；
- `branch`：建议分支名 `proposal/<slug>`（仅建议值，不创建）。

**红线因此天然满足**：进程内没有任何 `writeFile` 到仓内路径。开 PR 作为独立后续项（新 issue），不混进本 Wave。

---

## 执行顺序（**不是编号顺序**）

两条依赖决定派发顺序：

1. `Task 3`（read.ts）import `Task 5`（validate.ts）的 `validatePipelineDraft`。
2. `Task 3`（read.ts）与 `Task 4`（runs.ts）**互相需要对方的类型**：read 的 `PipelineDeps.runs` 是运行时 seam 类型 `PipelineRunSource`，而 runs 的两个实现是 `PipelineImpl` 类型。这构成**类型级循环**——哪个先做都无法编译。
   **解法**：把四个共享类型收进新的 `types.ts`（`PipelineRunRecord` / `PipelineRunSource` / `PipelineDeps` / `PipelineImpl`），由 `Task 4` 先建；`read.ts` 与 `runs.ts` 各自 `import type` 再对外**转出**自己那份，下游仍可照旧从 `./read` 或 `./runs` 取。

故实际派发顺序：

**1 → 2 → 5 → 4 → 3 → 6 → 7 → 8 → 9 → 10**

（编号保持文档结构不变；只在派发时换序。）

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `modules/data/domain/pipelines/tools.ts` | **纯**：7 个工具的静态元数据（名字/描述/inputSchema/scope/mutating/annotations）+ 常量。CI 门与本文件是唯一事实源。 |
| `modules/data/domain/pipelines/tools.test.ts` | 元数据断言（7 个、命名、mutating 三件套、无重名）。 |
| `modules/data/domain/pipelines/defs.ts` | 磁盘只读：管线 / 调度 / 契约的枚举与解析、契约↔管线匹配、路径解析（`rootsOf`）。 |
| `modules/data/domain/pipelines/defs.test.ts` | 临时目录夹具：正常/坏 JSON/`_` 前缀/路径穿越/契约匹配。 |
| `modules/data/domain/pipelines/types.ts` | 领域层共享类型（`PipelineRunRecord` / `PipelineRunSource` / `PipelineDeps` / `PipelineImpl`）——避开 read↔runs 的类型循环。 |
| `modules/data/domain/pipelines/read.ts` | `list_pipelines` / `get_pipeline` 两个实现。 |
| `modules/data/domain/pipelines/read.test.ts` | 回包形状、未知名、调度合并、契约附带。 |
| `modules/data/domain/pipelines/runs.ts` | `PipelineRunSource` seam + 两个工具实现（缺省 unknown）。 |
| `modules/data/domain/pipelines/runs.test.ts` | unknown 形状、seam 注入后转真、越界 limit。 |
| `modules/data/domain/pipelines/validate.ts` | 纯校验：管线草案 / 契约草案 / 沙箱前缀断言。 |
| `modules/data/domain/pipelines/validate.test.ts` | 每类违规一条用例（含「合法草案零 issue」）。 |
| `modules/data/domain/pipelines/propose.ts` | `propose_pipeline_change` / `propose_contract_change` 两实现（内存草案）。 |
| `modules/data/domain/pipelines/propose.test.ts` | 路径正确、内容可回读解析、不落盘、非法草案被拒。 |
| `modules/data/domain/pipelines/sandbox.ts` | `run_pipeline_sandbox` 实现（校验 + 前缀断言 + `not_executed`）。 |
| `modules/data/domain/pipelines/sandbox.test.ts` | 违规拒绝、合法但未执行、绝不写盘。 |
| `modules/data/routes/mcp-pipeline-tools.ts` | MCP 工具片：`list`/`call` 分派、空身份守卫、mutating 闸、**单点审计**。 |
| `modules/data/routes/mcp-pipeline-tools.test.ts` | 分派 / 不认领返回 null / mutating_disabled / 审计落库。 |
| `modules/data/routes/mcp-manage.ts` | **改 1 行**：`GROUPS` 追加 `pipelineTools`。 |
| `modules/data/routes/mcp-manage.test.ts` | 追加：管理面全片工具名无重名。 |
| `scripts/check-mcp-toolface.mjs` | 扩一条：提案面 7 个工具单独过同一套判据（工具数/命名/注解/scope）。 |
| `deploy/Dockerfile.server` | 两处 `COPY contracts ./contracts`（build + runtime 阶段）。 |
| `.env.example` | 追加 `DATA_PIPELINES_ROOT` / `DATA_CONTRACTS_ROOT`。 |

---

## Task 1: 工具元数据（纯）+ 门禁扩展

**Files:**
- Create: `modules/data/domain/pipelines/tools.ts`
- Create: `modules/data/domain/pipelines/tools.test.ts`
- Modify: `scripts/check-mcp-toolface.mjs`

**Interfaces:**
- Consumes: `modules/data/domain/toolbox/registry.ts` 的 `mutatingAllowed`（纯函数，供后续任务用）。
- Produces:
  - `PIPELINE_FACE_MAX_TOOLS = 7`、`MANAGE_SCOPE = 'data:manage'`
  - `interface PipelineToolMeta { name; group: 'pipeline'; title; description; inputSchema; outputSchema; requiredScope; mutating; annotations: {readOnlyHint: boolean} }`
  - `PIPELINE_TOOLS: readonly PipelineToolMeta[]`（7 项，名字见下）
  - `pipelineToolMeta(name: string): PipelineToolMeta | undefined`
  - `pipelineToolNames(): string[]`

七个工具名（与 spec §7 逐字一致）：`list_pipelines`、`get_pipeline`、`list_pipeline_runs`、`get_pipeline_run`、`run_pipeline_sandbox`、`propose_pipeline_change`、`propose_contract_change`。前四个 `mutating: false / readOnlyHint: true`；后三个 `mutating: true / readOnlyHint: false`。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/tools.test.ts
import { describe, expect, it } from 'vitest'
import { PIPELINE_FACE_MAX_TOOLS, PIPELINE_TOOLS, pipelineToolMeta, pipelineToolNames } from './tools'
import { analystToolNames } from '../toolbox/registry'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

describe('PIPELINE_TOOLS（提案面元数据）', () => {
  it('恰 7 个工具，名与 spec §7 逐字一致', () => {
    expect(pipelineToolNames()).toEqual([
      'list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'get_pipeline_run',
      'run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change',
    ])
    expect(PIPELINE_TOOLS.length).toBe(PIPELINE_FACE_MAX_TOOLS)
  })
  it('命名合规、无内部重名、不与分析师面重名', () => {
    const names = pipelineToolNames()
    for (const n of names) expect(TOOL_NAME_RE.test(n)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((n) => analystToolNames().includes(n))).toEqual([])
  })
  it('写工具三件套齐备（annotations / requiredScope / mutating），读工具 readOnlyHint=true', () => {
    for (const t of PIPELINE_TOOLS) {
      expect(t.requiredScope).toBe('data:manage')
      expect(t.annotations).toBeDefined()
      if (t.mutating) {
        expect(t.annotations.readOnlyHint).toBe(false)
      } else {
        expect(t.annotations.readOnlyHint).toBe(true)
      }
    }
    expect(PIPELINE_TOOLS.filter((t) => t.mutating).map((t) => t.name)).toEqual([
      'run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change',
    ])
  })
  it('每个工具都有非空 title/description 与 object 型 inputSchema', () => {
    for (const t of PIPELINE_TOOLS) {
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
    }
  })
  it('pipelineToolMeta：命中回元数据、未知回 undefined', () => {
    expect(pipelineToolMeta('get_pipeline')?.mutating).toBe(false)
    expect(pipelineToolMeta('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/tools.test.ts`
Expected: FAIL —— `Failed to resolve import "./tools"`。

- [ ] **Step 3: 写实现**

```ts
// modules/data/domain/pipelines/tools.ts
// tools.ts —— T1 提案面 7 个工具的**静态元数据**（spec 2026-10-21 §7）。
//
// ★ 本文件是**纯**的：不得 import pg / Hono / zod / warehouse。CI 门
//   （scripts/check-mcp-toolface.mjs）与路由片共用本清单——两处各写一份必漂。
//
// 落点是 POST /mcp-manage（scope data:manage），不是 /mcp：提案面天然属于管理面，
// 且分析师面的工具预算（≤14，现用 11）与 tools/list ≤10KB 预算**不动**。
import type { ToolAnnotations } from '../toolbox/registry'

export const PIPELINE_FACE_MAX_TOOLS = 7
export const MANAGE_SCOPE = 'data:manage'

export interface PipelineToolMeta {
  name: string
  group: 'pipeline'
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  requiredScope: string | null
  mutating: boolean
  annotations: ToolAnnotations
}

const readOnly: ToolAnnotations = { readOnlyHint: true }
const writeable: ToolAnnotations = { readOnlyHint: false }
const anyObject = { type: 'object' }

export const PIPELINE_TOOLS: readonly PipelineToolMeta[] = [
  {
    name: 'list_pipelines', group: 'pipeline', title: '采集管线清单',
    description: '列出仓内已登记的采集管线（deploy/duckle/console/pipelines）与各自的调度条目。做采集提案前先调它，确认现有管线的 id 与粒度。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（id/name 子串，大小写不敏感）' },
        source: { type: 'string', description: '调度来源（账套或源系统：3120 / 64188 / forms）' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_pipeline', group: 'pipeline', title: '采集管线详情',
    description: '按 id 取单条管线的完整定义（节点/边）、调度条目、关联的数据契约与静态校验结论。管线 JSON 的原始内容在 definition 字段里。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '管线 id（如 lemeng.retail.tick.l1；取自 list_pipelines）' } },
      required: ['id'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'list_pipeline_runs', group: 'pipeline', title: '管线运行记录清单',
    description: '列管线近期运行记录。数据源未接通时**显式返回 unknown**（未知 ≠ 没有失败）——不要把它当成「没跑过」。',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: '缺省 = 全部管线' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 20' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_pipeline_run', group: 'pipeline', title: '管线运行详情',
    description: '按 runId 取单次运行记录。数据源未接通时**显式返回 unknown**。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'run_pipeline_sandbox', group: 'pipeline', title: '沙箱试跑（校验闸）',
    description: '对一份管线草案做结构校验与沙箱前缀断言：所有湖写入的 key 必须以 __sandbox/ 开头、本地落盘必须在 /workspace/logs/sandbox/ 下、不得含 webhook 出口。通过后**并不执行**——执行面未接通（见 D-W3-4），回 not_executed。',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'object', description: 'duckle 管线 JSON：{name,nodes,edges}' },
        note: { type: 'string', description: '可选：这次试跑想验证什么（入审计，便于复盘）' },
      },
      required: ['pipeline'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
  {
    name: 'propose_pipeline_change', group: 'pipeline', title: '提案：管线变更',
    description: '把一份管线草案连同（可选）契约草案，渲染成**三件套提案**：仓内相对路径 + 完整文件内容 + 还差哪些件 + 静态校验结论。只产出、不落盘、不开 PR——应用由人/后续流程决定。',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'object', description: 'duckle 管线 JSON' },
        contract: { type: 'object', description: '可选：配套数据契约 JSON（缺省时下游清单里会点名「契约未提供」）' },
        title: { type: 'string', description: '提案标题（≤120 字）' },
        rationale: { type: 'string', description: '为什么改（入审计与提案摘要）' },
      },
      required: ['pipeline', 'title', 'rationale'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
  {
    name: 'propose_contract_change', group: 'pipeline', title: '提案：契约变更',
    description: '把一份数据契约草案渲染成提案：仓内相对路径 + 完整文件内容 + 受影响的下游清单（管线/模型/语义）+ 静态校验结论。只产出、不落盘、不开 PR。',
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'object', description: '数据契约 JSON（contractVersion=2）' },
        title: { type: 'string', description: '提案标题（≤120 字）' },
        rationale: { type: 'string', description: '为什么改' },
      },
      required: ['contract', 'title', 'rationale'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
]

export function pipelineToolNames(): string[] {
  return PIPELINE_TOOLS.map((t) => t.name)
}

export function pipelineToolMeta(name: string): PipelineToolMeta | undefined {
  return PIPELINE_TOOLS.find((t) => t.name === name)
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/tools.test.ts`
Expected: PASS（5 条）。

- [ ] **Step 5: 扩门禁（先写失败断言）**

在 `scripts/check-mcp-toolface.mjs` 的 import 段后追加：

```js
import { PIPELINE_FACE_MAX_TOOLS, PIPELINE_TOOLS } from '../modules/data/domain/pipelines/tools.ts'
```

在 main 段（`if (process.argv[1]?.endsWith('check-mcp-toolface.mjs'))`）里，把口径从「只判 ANALYST_TOOLS」扩成两面都判：

```js
  const violations = [
    ...checkToolface(ANALYST_TOOLS),
    ...checkToolface(PIPELINE_TOOLS, { maxTools: PIPELINE_FACE_MAX_TOOLS }),
  ]
```

同时把 `checkToolface` 的报错前缀文案里的「分析师面」改成不含面的措辞（否则提案面报错会写成分析师面，误导排障）：

```js
    out.push(`[TOOLFACE] 工具面 ${metas.length} 个 > 上限 ${maxTools}（spec §8 ①）`)
```

- [ ] **Step 6: 跑门禁**

Run: `pnpm exec tsx scripts/check-mcp-toolface.mjs`
Expected: 输出 `check-mcp-toolface: OK`。

- [ ] **Step 7: 提交**

```bash
git add modules/data/domain/pipelines/tools.ts modules/data/domain/pipelines/tools.test.ts scripts/check-mcp-toolface.mjs
git commit -m "feat(data-mcp): T1 提案面 7 工具元数据 + 工具面门禁扩面（Wave 3）"
```

---

## Task 2: 磁盘定义读取（管线 / 调度 / 契约）

**Files:**
- Create: `modules/data/domain/pipelines/defs.ts`
- Create: `modules/data/domain/pipelines/defs.test.ts`

**Interfaces:**
- Produces:
  - `interface PipelineRoots { pipelinesRoot: string; contractsRoot: string }`
  - `rootsOf(env: Record<string,string|undefined>, cwd?: string): PipelineRoots`
  - `PIPELINE_ID_RE = /^[A-Za-z0-9_.-]+$/`
  - `interface ScheduleEntry { source: string; pipelineId: string; enabled: boolean; cron: string | null; timezone: string | null }`
  - `interface PipelineDef { id: string; name: string; version: unknown; doc: Record<string, unknown>; counts: { source: number; transform: number; sink: number; control: number }; lakeKeys: string[] }`
  - `interface ContractRef { id: string; domain: string; table: string; path: string; columns: number; doc: Record<string, unknown> }`
  - `loadPipelines(roots): { defs: Map<string, PipelineDef>; warnings: string[] }`
  - `loadSchedules(roots): { byPipeline: Map<string, ScheduleEntry[]>; warnings: string[] }`
  - `loadContracts(roots): { contracts: ContractRef[]; warnings: string[] }`
  - `contractFor(pipelineId: string, contracts: readonly ContractRef[]): ContractRef | null`

**关键口径（写进代码注释，别让后人猜）：**
- 管线只看 `<pipelinesRoot>/pipelines/*.json`；**文件名 = 管线 id**（与 `deploy/duckle/console/README.md` 的「console 只认自己 workspace 里的 pipelines/」一致）。
- 调度文件是**数组**（不是字典），每条带 `pipeline_id`：`{id, pipeline_id, name, enabled, kind:{type:'cron',expr}, timezone, …}`。
- 契约在 `<contractsRoot>/*/*.json`，**`_` 开头的文件是基础设施，必须跳过**（`contracts/README.md` 明文）。
- 一切坏 JSON / 读失败 ⇒ 进 `warnings`，**不抛**（读面不能因为一个坏文件整体 500）。
- **用户输入永不拼进路径**：只按 id 在已枚举的 Map 里查。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/defs.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { contractFor, loadContracts, loadPipelines, loadSchedules, rootsOf } from './defs'

const root = mkdtempSync(join(tmpdir(), 'pl-defs-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function seed(rel: string, body: unknown): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
seed('deploy/duckle/console/pipelines/lemeng.a.b.json', {
  name: 'lemeng.a.b', version: 1,
  nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 't1', type: 'transform', data: { componentId: 'tr.sql', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a/system_book=1/all.parquet' } } },
    { id: 'k2', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/a.csv' } } },
  ],
  edges: [],
})
seed('deploy/duckle/console/pipelines/broken.json', '{ not json')
seed('deploy/duckle/console/schedules/3120.json', [
  { id: 'panel-1', pipeline_id: 'lemeng.a.b', name: 'lemeng.a.b', enabled: true, kind: { type: 'cron', expr: '*/5 * * * *' }, timezone: 'Asia/Shanghai' },
  { id: 'panel-2', pipeline_id: 'gone.away', name: 'gone.away', enabled: false, kind: { type: 'interval', seconds: 60 } },
])
seed('contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
seed('contracts/common/_schema.schema.json', { title: 'infra' })

const roots = rootsOf({}, root)

describe('rootsOf', () => {
  it('缺省落在 cwd 下的仓内路径；env 可覆盖', () => {
    expect(rootsOf({}, '/repo')).toEqual({ pipelinesRoot: '/repo/deploy/duckle/console', contractsRoot: '/repo/contracts' })
    expect(rootsOf({ DATA_PIPELINES_ROOT: '/p', DATA_CONTRACTS_ROOT: '/c' }, '/repo')).toEqual({ pipelinesRoot: '/p', contractsRoot: '/c' })
  })
})

describe('loadPipelines', () => {
  it('按文件名取 id、统计节点类型、收集湖写入 key；坏 JSON 进 warnings 不抛', () => {
    const { defs, warnings } = loadPipelines(roots)
    expect([...defs.keys()]).toEqual(['lemeng.a.b'])
    const d = defs.get('lemeng.a.b')!
    expect(d.name).toBe('lemeng.a.b')
    expect(d.counts).toEqual({ source: 1, transform: 1, sink: 2, control: 0 })
    expect(d.lakeKeys).toEqual(['lemeng/a/system_book=1/all.parquet'])
    expect(warnings.some((w) => w.includes('broken.json'))).toBe(true)
  })
  it('目录不存在 ⇒ 空 + warning（不抛）', () => {
    expect(loadPipelines(rootsOf({}, '/definitely/not/here'))).toEqual({ defs: new Map(), warnings: [expect.stringContaining('pipelines')] })
  })
})

describe('loadSchedules', () => {
  it('按 pipeline_id 归并，cron 抽平，interval 型 cron=null', () => {
    const { byPipeline } = loadSchedules(roots)
    expect(byPipeline.get('lemeng.a.b')).toEqual([
      { source: '3120', pipelineId: 'lemeng.a.b', enabled: true, cron: '*/5 * * * *', timezone: 'Asia/Shanghai' },
    ])
    expect(byPipeline.get('gone.away')?.[0]).toMatchObject({ enabled: false, cron: null, timezone: null })
  })
})

describe('loadContracts / contractFor', () => {
  it('跳过 _ 前缀基础设施文件', () => {
    const { contracts } = loadContracts(roots)
    expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
    expect(contracts[0]).toMatchObject({ domain: 'lemeng', table: 'a', columns: 1 })
  })
  it('contractFor：最长 domain.table 前缀命中；无命中回 null', () => {
    const { contracts } = loadContracts(roots)
    expect(contractFor('lemeng.a.tick', contracts)?.id).toBe('lemeng.a')
    expect(contractFor('lemeng.zzz', contracts)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/defs.test.ts`
Expected: FAIL —— `Failed to resolve import "./defs"`。

- [ ] **Step 3: 写实现**

```ts
// modules/data/domain/pipelines/defs.ts
// defs.ts —— 提案面的**只读**定义源：仓内管线 / 调度 / 契约（全部同步读文件）。
//
// 为什么读文件而不是走 OpenShip / duckle console HTTP：见计划 D-W3-2（真机实测：
// 容器内无 duckle、无 contracts；consoles 只绑回环且跨 compose 项目不可达）。
//
// 铁律：
//   · **不抛**。读面不能因为一个坏文件整体失败——坏项进 warnings，工具回包里带出去。
//   · **用户输入永不拼进路径**：只按 id 在已枚举的结果里查（path traversal 结构性不可能）。
//   · 契约里 `_` 开头的文件是基础设施（_schema/_template），必须跳过（contracts/README.md）。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PIPELINE_ID_RE = /^[A-Za-z0-9_.-]+$/

export interface PipelineRoots { pipelinesRoot: string; contractsRoot: string }

/** env 缝（B9：两键必须在根 .env.example 声明）。缺省值对「仓根 cwd」与「镜像 /app」都正确。 */
export function rootsOf(
  env: Record<string, string | undefined> = process.env, cwd: string = process.cwd(),
): PipelineRoots {
  return {
    pipelinesRoot: env.DATA_PIPELINES_ROOT?.trim() || join(cwd, 'deploy/duckle/console'),
    contractsRoot: env.DATA_CONTRACTS_ROOT?.trim() || join(cwd, 'contracts'),
  }
}

export interface ScheduleEntry {
  source: string; pipelineId: string; enabled: boolean; cron: string | null; timezone: string | null
}

export interface PipelineDef {
  id: string
  name: string
  version: unknown
  doc: Record<string, unknown>
  counts: { source: number; transform: number; sink: number; control: number }
  /** 所有 snk.minio sink 的 key（湖写入面的事实清单；沙箱断言与契约匹配都用它）。 */
  lakeKeys: string[]
}

export interface ContractRef {
  id: string; domain: string; table: string; path: string; columns: number
  doc: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const readJson = (p: string): Record<string, unknown> | unknown[] | null => {
  try {
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'))
    return isObj(v) || Array.isArray(v) ? (v as Record<string, unknown> | unknown[]) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function loadPipelines(
  roots: PipelineRoots,
): { defs: Map<string, PipelineDef>; warnings: string[] } {
  const defs = new Map<string, PipelineDef>()
  const warnings: string[] = []
  let files: string[]
  try {
    // join 必须在 try 内：roots 若被传成非字符串，join 自己会抛（本层铁律是「不抛」）。
    const dir = join(roots.pipelinesRoot, 'pipelines')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    warnings.push(`pipelines 目录不可读：${roots.pipelinesRoot}（${err instanceof Error ? err.message : String(err)}）`)
    return { defs, warnings }
  }
  for (const f of files) {
    const id = f.slice(0, -'.json'.length)
    if (!PIPELINE_ID_RE.test(id)) { warnings.push(`跳过非法管线名：${f}`); continue }
    const raw = readJson(join(dir, f))
    if (!isObj(raw)) { warnings.push(`跳过不可解析的管线：${f}`); continue }
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isObj) : []
    const counts = { source: 0, transform: 0, sink: 0, control: 0 }
    const lakeKeys: string[] = []
    for (const n of nodes) {
      const t = str(n.type)
      if (t === 'source' || t === 'transform' || t === 'sink' || t === 'control') counts[t] += 1
      const data = isObj(n.data) ? n.data : {}
      if (t === 'sink' && str(data.componentId) === 'snk.minio') {
        const props = isObj(data.properties) ? data.properties : {}
        if (str(props.key) !== '') lakeKeys.push(str(props.key))
      }
    }
    defs.set(id, {
      id, name: str(raw.name) || id, version: raw.version ?? null, doc: raw, counts, lakeKeys,
    })
  }
  return { defs, warnings }
}

export function loadSchedules(
  roots: PipelineRoots,
): { byPipeline: Map<string, ScheduleEntry[]>; warnings: string[] } {
  const byPipeline = new Map<string, ScheduleEntry[]>()
  const warnings: string[] = []
  let files: string[]
  try {
    // 同 loadPipelines：join 在 try 内（非字符串 root 也不能抛）。
    const dir = join(roots.pipelinesRoot, 'schedules')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    warnings.push(`schedules 目录不可读：${roots.pipelinesRoot}（${err instanceof Error ? err.message : String(err)}）`)
    return { byPipeline, warnings }
  }
  for (const f of files) {
    const source = f.slice(0, -'.json'.length)
    const raw = readJson(join(dir, f))
    // 调度文件是**数组**（每条带 pipeline_id），不是字典——见 deploy/duckle/console/README.md。
    if (!Array.isArray(raw)) { warnings.push(`跳过不可解析的调度：${f}`); continue }
    for (const e of raw) {
      if (!isObj(e)) continue
      const pid = str(e.pipeline_id)
      if (pid === '') { warnings.push(`调度条目缺 pipeline_id：${f}`); continue }
      const kind = isObj(e.kind) ? e.kind : {}
      const entry: ScheduleEntry = {
        source, pipelineId: pid, enabled: e.enabled === true,
        cron: str(kind.expr) || null, timezone: str(e.timezone) || null,
      }
      byPipeline.set(pid, [...(byPipeline.get(pid) ?? []), entry])
    }
  }
  return { byPipeline, warnings }
}

export function loadContracts(
  roots: PipelineRoots,
): { contracts: ContractRef[]; warnings: string[] } {
  const contracts: ContractRef[] = []
  const warnings: string[] = []
  let domains: string[]
  try {
    domains = readdirSync(roots.contractsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    warnings.push(`contracts 目录不可读：${roots.contractsRoot}`)
    return { contracts, warnings }
  }
  for (const domain of domains) {
    let files: string[]
    try {
      files = readdirSync(join(roots.contractsRoot, domain)).filter((f) => f.endsWith('.json')).sort()
    } catch {
      // 不能静默跳过：整个域消失会被下游读成「没有契约」，那是另一种谎。
      warnings.push(`契约目录不可读：${domain}`)
      continue
    }
    for (const f of files) {
      // `_` 前缀 = 基础设施（_schema/_template），跳过（contracts/README.md 明文）。
      if (f.startsWith('_')) continue
      const raw = readJson(join(roots.contractsRoot, domain, f))
      if (!isObj(raw)) { warnings.push(`跳过不可解析的契约：${domain}/${f}`); continue }
      const table = str(raw.table)
      const dom = str(raw.domain) || domain
      const cols = Array.isArray(raw.columns) ? raw.columns.length : 0
      contracts.push({
        id: table === '' ? f.slice(0, -'.json'.length) : `${dom}.${table}`,
        domain: dom, table, path: `contracts/${domain}/${f}`, columns: cols, doc: raw,
      })
    }
  }
  return { contracts, warnings }
}

/**
 * 管线 ↔ 契约匹配：契约 id（`<domain>.<table>`）是管线 id 的**最长前缀**者胜。
 * 例：`lemeng.retail_order_line.tick` → `lemeng.retail_order_line`；
 *     `lemeng.retail.tick.l1` → 无命中（`lemeng.retail` 不存在）⇒ null。
 * 这是**命名约定**（仓内既有事实），不是契约格式的一部分——匹配不上不算错。
 */
export function contractFor(pipelineId: string, contracts: readonly ContractRef[]): ContractRef | null {
  let best: ContractRef | null = null
  for (const c of contracts) {
    if (pipelineId === c.id || pipelineId.startsWith(`${c.id}.`)) {
      if (best === null || c.id.length > best.id.length) best = c
    }
  }
  return best
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/defs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/defs.ts modules/data/domain/pipelines/defs.test.ts
git commit -m "feat(data-mcp): 提案面只读定义源（管线/调度/契约）读取层"
```

---

## Task 3: `list_pipelines` / `get_pipeline` 两个只读工具

**Files:**
- Create: `modules/data/domain/pipelines/read.ts`
- Create: `modules/data/domain/pipelines/read.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadPipelines/loadSchedules/loadContracts/contractFor/rootsOf`；Task 5 的 `validatePipelineDraft`（**已在分支上，直接 import，不要写桩**）；Task 4 的 `types.ts` 里的 `PipelineDeps`/`PipelineImpl`。
- Produces:
  - `listPipelinesImpl: PipelineImpl`、`getPipelineImpl: PipelineImpl`
  - `readAll(deps): { defs; schedules; contracts; warnings }`（一次读三份，供两个工具共用）
  - **转出**（`export type { PipelineDeps, PipelineImpl } from './types'`）——下游 Task 6/7/8 照旧从 `./read` 取这两个类型。

**注意**：`PipelineDeps` / `PipelineImpl` 定义在 `types.ts`（Task 4 建），**不要在本文件里重新声明**——重复声明会让 `PipelineDeps` 变成两个不兼容的结构类型。本文件只需 `import type` + `export type` 转出。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/read.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getPipelineImpl, listPipelinesImpl } from './read'
import type { PipelineDeps } from './read'

const root = mkdtempSync(join(tmpdir(), 'pl-read-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (rel: string, body: unknown): void => {
  const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(body))
}
put('pipelines/lemeng.a.b.json', {
  name: 'lemeng.a.b', version: 2,
  nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a/all.parquet' } } },
  ],
  edges: [{ id: 'e1', source: 's1', target: 'k1' }],
})
put('schedules/3120.json', [{ pipeline_id: 'lemeng.a.b', pipelineId: 'x', enabled: true, kind: { type: 'cron', expr: '*/5 * * * *' }, timezone: 'Asia/Shanghai' }])
put('../contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
const deps: PipelineDeps = {
  roots: { pipelinesRoot: root, contractsRoot: join(root, '..', 'contracts') },
  runs: null, env: {},
}

describe('listPipelinesImpl', () => {
  it('回清单：id/name/版本/节点统计/调度/契约', async () => {
    const out = await listPipelinesImpl(deps, {})
    expect(out.isError).toBe(false)
    const p = out.payload as { status: string; count: number; pipelines: Record<string, unknown>[] }
    expect(p.status).toBe('ok')
    expect(p.count).toBe(1)
    expect(p.pipelines[0]).toMatchObject({
      id: 'lemeng.a.b', name: 'lemeng.a.b', version: 2,
      nodes: { source: 1, transform: 0, sink: 1, control: 0 },
      contractId: 'lemeng.a',
    })
    expect((p.pipelines[0].schedules as unknown[]).length).toBe(1)
  })
  it('q 过滤 + source 过滤', async () => {
    const none = await listPipelinesImpl(deps, { q: 'zzz' })
    expect((none.payload as { count: number }).count).toBe(0)
    const bySource = await listPipelinesImpl(deps, { source: '3120' })
    expect((bySource.payload as { count: number }).count).toBe(1)
    const otherSource = await listPipelinesImpl(deps, { source: '64188' })
    expect((otherSource.payload as { count: number }).count).toBe(0)
  })
})

describe('getPipelineImpl', () => {
  it('命中：带 definition / 调度 / 契约 / 校验结论', async () => {
    const out = await getPipelineImpl(deps, { id: 'lemeng.a.b' })
    expect(out.isError).toBe(false)
    const p = out.payload as Record<string, unknown>
    expect(p).toMatchObject({ status: 'ok', id: 'lemeng.a.b', name: 'lemeng.a.b' })
    expect((p.definition as { name: string }).name).toBe('lemeng.a.b')
    expect((p.contract as { id: string }).id).toBe('lemeng.a')
    expect(Array.isArray(p.validation)).toBe(true)
  })
  it('未知名 ⇒ not_found（isError）', async () => {
    const out = await getPipelineImpl(deps, { id: 'nope' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', id: 'nope' })
  })
  it('路径穿越形态一律 not_found（不拼路径）', async () => {
    for (const id of ['../../etc/passwd', 'a/b', '']) {
      const out = await getPipelineImpl(deps, { id })
      expect(out.payload).toMatchObject({ status: 'not_found' })
    }
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/read.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

> 先落 Task 5 的 `validate.ts`（见该任务 Step 3 的完整代码），再写本文件。

```ts
// modules/data/domain/pipelines/read.ts
// read.ts —— 提案面两个只读工具的实现（清单 / 详情）。纯读：不写盘、不联网。
import {
  contractFor, loadContracts, loadPipelines, loadSchedules, PIPELINE_ID_RE,
} from './defs'
import type { ContractRef, PipelineDef, ScheduleEntry } from './defs'
import { validatePipelineDraft } from './validate'
// 共享类型住在 types.ts（Task 4 建），此处只取用并对外转出，避免与 runs.ts 形成类型循环。
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineDeps, PipelineImpl } from './types'

export interface ReadAll {
  defs: Map<string, PipelineDef>
  schedules: Map<string, ScheduleEntry[]>
  contracts: ContractRef[]
  warnings: string[]
}

/** 三份定义一次读完（两个工具共用；每份都自带 warnings 汇总）。 */
export function readAll(deps: PipelineDeps): ReadAll {
  const p = loadPipelines(deps.roots)
  const s = loadSchedules(deps.roots)
  const c = loadContracts(deps.roots)
  return {
    defs: p.defs, schedules: s.byPipeline, contracts: c.contracts,
    warnings: [...p.warnings, ...s.warnings, ...c.warnings],
  }
}

const schedulesOf = (all: ReadAll, id: string, source: string | null): ScheduleEntry[] =>
  (all.schedules.get(id) ?? []).filter((e) => source === null || e.source === source)

export const listPipelinesImpl: PipelineImpl = async (deps, args) => {
  const all = readAll(deps)
  const q = typeof args.q === 'string' && args.q !== '' ? args.q.toLowerCase() : null
  const source = typeof args.source === 'string' && args.source !== '' ? args.source : null
  const pipelines = [...all.defs.values()]
    .filter((d) => q === null || d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
    .filter((d) => source === null || schedulesOf(all, d.id, source).length > 0)
    .map((d) => ({
      id: d.id, name: d.name, version: d.version, nodes: d.counts,
      lakeKeys: d.lakeKeys.length,
      schedules: schedulesOf(all, d.id, null),
      contractId: contractFor(d.id, all.contracts)?.id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    payload: {
      status: 'ok', count: pipelines.length, pipelines,
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: pipelines.length,
  }
}

export const getPipelineImpl: PipelineImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  const all = readAll(deps)
  const def = PIPELINE_ID_RE.test(id) ? all.defs.get(id) : undefined
  if (def === undefined) {
    return { payload: { status: 'not_found', id }, isError: true, auditRowCount: null }
  }
  const contract = contractFor(def.id, all.contracts)
  return {
    payload: {
      status: 'ok', id: def.id, name: def.name, version: def.version,
      nodes: def.counts, lakeKeys: def.lakeKeys,
      schedules: schedulesOf(all, def.id, null),
      contract: contract === null ? null : {
        id: contract.id, path: contract.path, columns: contract.columns,
      },
      validation: validatePipelineDraft(def.doc),
      definition: def.doc,
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: null,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/read.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/read.ts modules/data/domain/pipelines/read.test.ts
git commit -m "feat(data-mcp): 提案面 list_pipelines / get_pipeline"
```

---

## Task 4: 运行记录 seam + 两个工具

**Files:**
- Create: `modules/data/domain/pipelines/types.ts`
- Create: `modules/data/domain/pipelines/runs.ts`
- Create: `modules/data/domain/pipelines/runs.test.ts`

**Interfaces:**
- Produces（`types.ts`，**本任务先建，Task 3 依赖它**）：
  - `interface PipelineRunRecord { runId: string; pipelineId: string; startedAt: string; status: 'ok' | 'failed' | 'running'; endedAt?: string; rows?: number; error?: string }`
  - `type PipelineRunSource = (q: { pipelineId?: string; limit: number }) => Promise<PipelineRunRecord[]>`
  - `interface PipelineDeps { roots: PipelineRoots; runs: PipelineRunSource | null; env: Record<string, string | undefined> }`
  - `type PipelineImpl = (deps: PipelineDeps, args: Record<string, unknown>) => Promise<ToolImplResult>`
- Produces（`runs.ts`）：`listPipelineRunsImpl: PipelineImpl`、`getPipelineRunImpl: PipelineImpl`；并**转出** `export type { PipelineRunRecord, PipelineRunSource } from './types'`（Task 8 从 `./runs` 取 `PipelineRunSource`）。
- **为什么要有 `types.ts`**：`read.ts` 的 `PipelineDeps` 含 `PipelineRunSource`，`runs.ts` 的实现标注是 `PipelineImpl` —— 两边互相 import 会成**类型循环**，哪个先写都编译不过。共享类型放中立文件，read.ts / runs.ts 各自 `import type` 后对外转出，下游 import 路径不变。

**口径：** seam 为 `null` 时**只回 unknown**，不猜、不构造空数组（空数组会被读成「跑过且都成功/一条没有」）。`limit` 上限 50（与控制面既有「抽样 ≤50」同一档）。

> **补记（2026-10-22，已交付后订正）**：本任务实际交付的 `runs.ts` **以 `84af2b03` 的代码为准**，下面 Step 3 的样例在三点上已被评审订正，**照抄样例会把已修的缺陷写回去**：
> 1. **`pipelineId` 形状门**：样例直接 `typeof === 'string'` ⇒ 非字符串静默放宽成「全部管线」。已改为过 `PIPELINE_ID_RE`（源自 `defs.ts`），非法值 `denied/bad_param/invalid_pipeline_id` 且**不调 seam**；`''` 视同不筛。
> 2. **窗口饱和 ≠ 不存在**：`get_pipeline_run` 恒以 `{ limit: MAX_LIMIT }` 全局扫（不看 `pipelineId`——那是 `list` 的参数，`get` 的 `inputSchema` 只声明 `runId`）。`scanned >= MAX_LIMIT` 且未命中 ⇒ `unknown / runs_window_saturated`（`isError:false`、回包带 `scanned`）；**只有窗口未饱和才允许 `not_found`**。
> 3. **`not_found` 必须带 `reason:'not_found'`**：否则审计把它记成 `denied/tool_error`，与真异常不可分。
>
> 另：`get_pipeline_run` 的实现**不得**读取 `args.pipelineId`（未在 `tools.ts` 声明 ⇒ 契约外能力，且 CI 无门禁可比对），四个分支一律回显 `pipelineId: null`。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/runs.test.ts
import { describe, expect, it } from 'vitest'
import { getPipelineRunImpl, listPipelineRunsImpl } from './runs'
import type { PipelineDeps } from './types'

const roots = { pipelinesRoot: '/nope', contractsRoot: '/nope' }
const noSeam: PipelineDeps = { roots, runs: null, env: {} }

describe('运行记录（seam 未接通）', () => {
  it('list_pipeline_runs ⇒ 显式 unknown + 原因 + 说明；不是空数组', async () => {
    const out = await listPipelineRunsImpl(noSeam, {})
    expect(out.isError).toBe(false)
    const p = out.payload as Record<string, unknown>
    expect(p.status).toBe('unknown')
    expect(p.reason).toBe('runs_source_not_wired')
    expect(String(p.note)).toContain('console')
    expect('runs' in p).toBe(false)
    expect(out.auditRowCount).toBeNull()
  })
  it('get_pipeline_run ⇒ 同样 unknown', async () => {
    const out = await getPipelineRunImpl(noSeam, { runId: 'run-1' })
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'runs_source_not_wired' })
  })
})

describe('运行记录（seam 接通后转真）', () => {
  const rows = [
    { runId: 'r2', pipelineId: 'p', startedAt: '2026-10-22T01:00:00Z', status: 'failed' as const, error: 'boom' },
    { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-21T01:00:00Z', status: 'ok' as const, rows: 12 },
  ]
  const deps: PipelineDeps = {
    roots, env: {},
    runs: async (q) => rows.filter((r) => q.pipelineId === undefined || r.pipelineId === q.pipelineId).slice(0, q.limit),
  }
  it('list：透传过滤与 limit', async () => {
    const out = await listPipelineRunsImpl(deps, { pipelineId: 'p', limit: 1 })
    expect(out.payload).toMatchObject({ status: 'ok', count: 1 })
    expect((out.payload as { runs: { runId: string }[] }).runs[0].runId).toBe('r2')
  })
  it('get：命中回 run，未命中 not_found', async () => {
    expect((await getPipelineRunImpl(deps, { runId: 'r1' })).payload).toMatchObject({ status: 'ok', run: { runId: 'r1' } })
    expect((await getPipelineRunImpl(deps, { runId: 'zz' })).payload).toMatchObject({ status: 'not_found', runId: 'zz' })
  })
  it('limit 越界/非法 ⇒ 缺省 20，硬顶 50', async () => {
    let seen = 0
    const spy: PipelineDeps = { roots, env: {}, runs: async (q) => { seen = q.limit; return [] } }
    await listPipelineRunsImpl(spy, { limit: 999 })
    expect(seen).toBe(50)
    await listPipelineRunsImpl(spy, { limit: 0 })
    expect(seen).toBe(20)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/runs.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

**先建 `types.ts`**（Task 3 依赖它，必须先落盘）：

```ts
// modules/data/domain/pipelines/types.ts
// types.ts —— 提案面领域层的共享类型。
// 单独成文件只为破 read.ts ↔ runs.ts 的类型循环：read 的 PipelineDeps 要 PipelineRunSource，
// runs 的实现标注要 PipelineImpl。两边各自 import type 本文件，再对外转出，下游路径不变。
import type { ToolImplResult } from '../toolbox/registry'
import type { PipelineRoots } from './defs'

export interface PipelineRunRecord {
  runId: string
  pipelineId: string
  startedAt: string
  status: 'ok' | 'failed' | 'running'
  endedAt?: string
  rows?: number
  error?: string
}

export type PipelineRunSource = (q: { pipelineId?: string; limit: number }) => Promise<PipelineRunRecord[]>

export interface PipelineDeps {
  roots: PipelineRoots
  runs: PipelineRunSource | null
  env: Record<string, string | undefined>
}

export type PipelineImpl = (deps: PipelineDeps, args: Record<string, unknown>) => Promise<ToolImplResult>
```

**再写 `runs.ts`**：

```ts
// modules/data/domain/pipelines/runs.ts
// runs.ts —— 管线运行记录的**只读 seam**（D-W3-3）。
//
// 为什么本轮只有 seam：真实运行记录住在 duckle console 的 **per-账套 Docker 命名卷**
// （/workspace/runs/<pipeline_id>.json，留 50 条；/workspace/runs/receipts/ 留 200 条，
// 见 deploy/duckle/console/README.md §排障入口）。platform-core 的 server 容器既看不到那个卷，
// 也够不到 consoles 的回环端口（127.0.0.1:18080/18081，跨 compose 项目、openship 不建模
// extra_hosts 且硬拒 host 网络）⇒ 本轮无路可达。
//
// seam 为 null ⇒ 回 **显式 unknown**，绝不回空数组：空数组会被读成
// 「跑过、且一条都没问题」——这跟「读不到」是两件事（同 get_quality 的纪律）。
import type { ToolImplResult } from '../toolbox/registry'
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineRunRecord, PipelineRunSource } from './types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const NOT_WIRED = 'runs_source_not_wired'
const NOTE = '运行记录住在 duckle console 的 per-账套 workspace 卷（/workspace/runs/），'
  + '本服务容器不可达（跨 compose 项目 + 回环端口）。未知 ≠ 没有失败——不要当成「没跑过」。'

const limitOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return DEFAULT_LIMIT
  return Math.min(v, MAX_LIMIT)
}

const notWired = (extra: Record<string, unknown> = {}): ToolImplResult => ({
  payload: { status: 'unknown', reason: NOT_WIRED, note: NOTE, ...extra },
  isError: false, auditRowCount: null,
})

export const listPipelineRunsImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const limit = limitOf(args.limit)
  const pipelineId = typeof args.pipelineId === 'string' && args.pipelineId !== '' ? args.pipelineId : undefined
  if (deps.runs === null) return notWired({ pipelineId: pipelineId ?? null, limit })
  const runs = await deps.runs({ pipelineId, limit })
  return {
    payload: { status: 'ok', count: runs.length, limit, runs },
    isError: false, auditRowCount: runs.length,
  }
}

export const getPipelineRunImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (runId === '') {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'runId_required' }, isError: true, auditRowCount: null }
  }
  if (deps.runs === null) return notWired({ runId })
  const hits = await deps.runs({ limit: MAX_LIMIT })
  const run = hits.find((r) => r.runId === runId)
  if (run === undefined) return { payload: { status: 'not_found', runId }, isError: true, auditRowCount: null }
  return { payload: { status: 'ok', run }, isError: false, auditRowCount: null }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/runs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/runs.ts modules/data/domain/pipelines/runs.test.ts
git commit -m "feat(data-mcp): 运行记录只读 seam（缺省显式 unknown）"
```

---

## Task 5: 纯校验器（管线 / 契约 / 沙箱前缀）

**Files:**
- Create: `modules/data/domain/pipelines/validate.ts`
- Create: `modules/data/domain/pipelines/validate.test.ts`

> **本任务应最先执行**（Task 3 依赖 `validatePipelineDraft`）。

**Interfaces:**
- Produces:
  - `interface Issue { path: string; message: string }`
  - `validatePipelineDraft(doc: unknown): Issue[]`
  - `validateContractDraft(doc: unknown): Issue[]`
  - `sandboxViolations(doc: unknown): Issue[]`
- 语义：**空数组 = 通过**。所有 issue 定位到 JSON 路径（`nodes[2].data.componentId`），便于人改。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/validate.test.ts
import { describe, expect, it } from 'vitest'
import { sandboxViolations, validateContractDraft, validatePipelineDraft } from './validate'

const goodPipeline = {
  name: 'lemeng.x.y', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/x/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}
const goodContract = {
  contractVersion: 2, domain: 'lemeng', table: 'x', owner: 'data-platform',
  layout: { prefix: 'lemeng/x', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
  batch: { markerColumn: 'batch_id', type: 'varchar', unique: false },
  columns: [{ name: 'batch_id', type: 'varchar', nullable: false }],
}

describe('validatePipelineDraft', () => {
  it('合法草案零 issue', () => expect(validatePipelineDraft(goodPipeline)).toEqual([]))
  it('缺 name / nodes 非数组 / 无 source / 无 sink ⇒ 各自一条 issue', () => {
    expect(validatePipelineDraft({}).map((i) => i.path)).toContain('name')
    expect(validatePipelineDraft({ name: 'x', nodes: {}, edges: [] }).map((i) => i.path)).toContain('nodes')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio' } }], edges: [] })
      .map((i) => i.message).join()).toContain('source')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 's', type: 'source', data: { componentId: 'src.rest' } }], edges: [] })
      .map((i) => i.message).join()).toContain('sink')
  })
  it('节点 id 重复 / 边指向不存在的节点 / type 非法 ⇒ 定位到具体路径', () => {
    const dup = validatePipelineDraft({
      name: 'x',
      nodes: [{ id: 'a', type: 'source', data: { componentId: 'src.rest' } }, { id: 'a', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/sandbox/x.csv' } } }],
      edges: [],
    })
    expect(dup.some((i) => i.message.includes('重复'))).toBe(true)
    const badEdge = validatePipelineDraft({ ...goodPipeline, edges: [{ source: 's1', target: 'zzz' }] })
    expect(badEdge.some((i) => i.path === 'edges[0].target')).toBe(true)
    const badType = validatePipelineDraft({ ...goodPipeline, nodes: [{ id: 'a', type: 'weird', data: {} }] })
    expect(badType.some((i) => i.message.includes('type'))).toBe(true)
  })
})

describe('validateContractDraft', () => {
  it('合法契约零 issue', () => expect(validateContractDraft(goodContract)).toEqual([]))
  it('contractVersion ≠ 2 / 缺 domain / 非法 layout / 无列 ⇒ 各自一条', () => {
    expect(validateContractDraft({ ...goodContract, contractVersion: 1 }).map((i) => i.path)).toContain('contractVersion')
    expect(validateContractDraft({ ...goodContract, domain: 'Bad-Domain' }).map((i) => i.path)).toContain('domain')
    expect(validateContractDraft({ ...goodContract, layout: { ...goodContract.layout, fileName: 'x.parquet' } })
      .map((i) => i.path)).toContain('layout.fileName')
    expect(validateContractDraft({ ...goodContract, columns: [] }).map((i) => i.path)).toContain('columns')
  })
})

describe('sandboxViolations', () => {
  it('合法沙箱草案零违规', () => expect(sandboxViolations(goodPipeline)).toEqual([]))
  it('湖写入不在 __sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/x/all.parquet' } } }] }
    expect(sandboxViolations(bad).map((i) => i.path)).toEqual(['nodes[0].data.properties.key'])
  })
  it('本地落盘不在 /workspace/logs/sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/x.csv' } } }] }
    expect(sandboxViolations(bad)).toHaveLength(1)
  })
  it('webhook 出口 ⇒ 违规（沙箱不得对外发数据）', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'w', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect(sandboxViolations(bad)[0].message).toContain('webhook')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/validate.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// modules/data/domain/pipelines/validate.ts
// validate.ts —— 提案面的**纯**校验器（不读盘、不联网、不抛）。
// 空数组 = 通过。issue 的 path 定位到 JSON 路径，便于人照着改。
//
// ⚠️ 这里校验的是**结构**，不是业务口径：列类型对不对、口径算得对不对，
//    只能靠 dbt tests / 对账（本层不越权宣称「草案正确」）。
import type { Issue } from './validate-types'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const NODE_TYPES = ['source', 'transform', 'sink', 'control']
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const SANDBOX_LAKE_PREFIX = '__sandbox/'
const SANDBOX_LOCAL_PREFIX = '/workspace/logs/sandbox/'
export const CONTRACT_VERSION = 2

export function validatePipelineDraft(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc)) return [{ path: '', message: '草案必须是对象' }]
  if (str(doc.name) === '') out.push({ path: 'name', message: 'name 必填（非空字符串）' })
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : null
  if (nodes === null || nodes.length === 0) {
    out.push({ path: 'nodes', message: 'nodes 必须是非空数组' })
    return out
  }
  const ids = new Set<string>()
  let sources = 0
  let sinks = 0
  nodes.forEach((n, i) => {
    if (!isObj(n)) { out.push({ path: `nodes[${i}]`, message: '节点必须是对象' }); return }
    const id = str(n.id)
    if (id === '') out.push({ path: `nodes[${i}].id`, message: 'id 必填' })
    else if (ids.has(id)) out.push({ path: `nodes[${i}].id`, message: `id 重复：${id}` })
    else ids.add(id)
    const t = str(n.type)
    if (!NODE_TYPES.includes(t)) out.push({ path: `nodes[${i}].type`, message: `type 必须是 ${NODE_TYPES.join('/')} 之一` })
    if (t === 'source') sources += 1
    if (t === 'sink') sinks += 1
    const data = isObj(n.data) ? n.data : null
    if (data === null) out.push({ path: `nodes[${i}].data`, message: 'data 必填' })
    else if (str(data.componentId) === '') out.push({ path: `nodes[${i}].data.componentId`, message: 'componentId 必填' })
  })
  if (sources === 0) out.push({ path: 'nodes', message: '至少需要一个 source 节点' })
  if (sinks === 0) out.push({ path: 'nodes', message: '至少需要一个 sink 节点（薄管线必须以 sink 收尾）' })
  const edges = Array.isArray(doc.edges) ? doc.edges : null
  if (edges === null) out.push({ path: 'edges', message: 'edges 必须是数组（可为空）' })
  else edges.forEach((e, i) => {
    if (!isObj(e)) { out.push({ path: `edges[${i}]`, message: '边必须是对象' }); return }
    for (const end of ['source', 'target'] as const) {
      const v = str(e[end])
      if (v === '') out.push({ path: `edges[${i}].${end}`, message: `${end} 必填` })
      else if (!ids.has(v)) out.push({ path: `edges[${i}].${end}`, message: `${end} 指向不存在的节点：${v}` })
    }
  })
  return out
}

export function validateContractDraft(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc)) return [{ path: '', message: '草案必须是对象' }]
  if (doc.contractVersion !== CONTRACT_VERSION) {
    out.push({ path: 'contractVersion', message: `必须是 ${CONTRACT_VERSION}` })
  }
  for (const k of ['domain', 'table'] as const) {
    if (!DOMAIN_RE.test(str(doc[k]))) out.push({ path: k, message: '必须是 [a-z][a-z0-9_]*' })
  }
  if (str(doc.owner) === '') out.push({ path: 'owner', message: 'owner 必填' })
  const layout = isObj(doc.layout) ? doc.layout : null
  if (layout === null) out.push({ path: 'layout', message: 'layout 必填' })
  else {
    if (str(layout.prefix) === '') out.push({ path: 'layout.prefix', message: 'prefix 必填' })
    if (layout.partitionStyle !== 'hive') out.push({ path: 'layout.partitionStyle', message: '只支持 hive 分区' })
    if (!Array.isArray(layout.partitionBy) || layout.partitionBy.length === 0) {
      out.push({ path: 'layout.partitionBy', message: 'partitionBy 必须是非空数组' })
    }
    if (layout.fileName !== 'all.parquet') out.push({ path: 'layout.fileName', message: '必须是 all.parquet' })
  }
  if (!isObj(doc.batch)) out.push({ path: 'batch', message: 'batch 必填' })
  const cols = Array.isArray(doc.columns) ? doc.columns : null
  if (cols === null || cols.length === 0) out.push({ path: 'columns', message: 'columns 必须是非空数组' })
  else cols.forEach((c, i) => {
    if (!isObj(c)) { out.push({ path: `columns[${i}]`, message: '列必须是对象' }); return }
    if (str(c.name) === '') out.push({ path: `columns[${i}].name`, message: 'name 必填' })
    if (str(c.type) === '') out.push({ path: `columns[${i}].type`, message: 'type 必填' })
  })
  return out
}

/**
 * 沙箱试跑的**写入面**断言（spec §7 红线：产物写 __sandbox 前缀，不入正式湖）：
 *   · 每个 snk.minio 的 properties.key 必须 `__sandbox/` 开头；
 *   · 每个 snk.csv 的 properties.path 必须 `/workspace/logs/sandbox/` 开头；
 *   · 出现 snk.webhook ⇒ 违规（沙箱试跑不得对外发数据）。
 * 源节点不在这里限制：读生产 API 是试跑的题中之义（只读）。
 */
export function sandboxViolations(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc) || !Array.isArray(doc.nodes)) {
    return [{ path: 'nodes', message: 'nodes 缺失，无法断言沙箱前缀' }]
  }
  doc.nodes.forEach((n, i) => {
    if (!isObj(n) || str(n.type) !== 'sink') return
    const data = isObj(n.data) ? n.data : {}
    const comp = str(data.componentId)
    const props = isObj(data.properties) ? data.properties : {}
    if (comp === 'snk.minio') {
      const key = str(props.key)
      if (!key.startsWith(SANDBOX_LAKE_PREFIX)) {
        out.push({ path: `nodes[${i}].data.properties.key`, message: `湖写入必须以 ${SANDBOX_LAKE_PREFIX} 开头，实际：${key || '(空)'}` })
      }
    } else if (comp === 'snk.csv') {
      const path = str(props.path)
      if (!path.startsWith(SANDBOX_LOCAL_PREFIX)) {
        out.push({ path: `nodes[${i}].data.properties.path`, message: `本地落盘必须在 ${SANDBOX_LOCAL_PREFIX} 下，实际：${path || '(空)'}` })
      }
    } else if (comp === 'snk.webhook') {
      out.push({ path: `nodes[${i}].data.componentId`, message: '沙箱试跑不得含 webhook 出口（会对外发数据）' })
    }
  })
  return out
}
```

同文件顶部（或单独 `validate-types.ts` —— 二选一，**本计划取单独文件**，避免 `read.ts` 与 `validate.ts` 的循环感）：

```ts
// modules/data/domain/pipelines/validate-types.ts
export interface Issue { path: string; message: string }
```

并把 `validate.ts` 第一行的 import 改成 `import type { Issue } from './validate-types'`（如上）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/validate.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/validate.ts modules/data/domain/pipelines/validate-types.ts modules/data/domain/pipelines/validate.test.ts
git commit -m "feat(data-mcp): 提案面纯校验器（管线/契约/沙箱前缀）"
```

---

## Task 6: 草案生成（`propose_pipeline_change` / `propose_contract_change`）

**Files:**
- Create: `modules/data/domain/pipelines/propose.ts`
- Create: `modules/data/domain/pipelines/propose.test.ts`

**Interfaces:**
- Consumes: `validatePipelineDraft` / `validateContractDraft`（Task 5）、`loadPipelines/loadContracts/contractFor`（Task 2）。
- Produces:
  - `interface ProposedFile { path: string; bytes: number; content: string }`
  - `interface PipelineProposal { title: string; rationale: string; branch: string; pieces: ProposedFile[]; downstream: { path: string; why: string }[]; validation: Issue[] }`
  - `buildPipelineProposal(deps, {pipeline, contract, title, rationale}): PipelineProposal`
  - `buildContractProposal(deps, {contract, title, rationale}): PipelineProposal`
  - `proposePipelineChangeImpl: PipelineImpl`、`proposeContractChangeImpl: PipelineImpl`

**硬口径：**
- **零写入**：函数体内不得出现任何写文件调用（测试用 `readdirSync` 前后比对目录树 + 断言路径字符串不落在仓内真实目录）。
- 建议分支名 `proposal/<slug>`，slug = 标题转 `[a-z0-9-]`、截 40 字；**只建议，不创建**。
- `downstream` 必须**具体**：管线提案至少要列出「dbt staging 模型」「契约」两项（缺则标 `missing` 理由），契约提案要列出受影响管线（按 `contractFor` 反查）。
- 非法草案 ⇒ 由路由片上抛成 `refused/invalid_draft`（本文件返回 `validation`，路由片判空）。

> **补记（2026-10-22，实施后订正）：下面 Step 1/3 的样例在四处与**已交付**代码不一致，以交付代码为准（`5fbd3fd1`..`9b2c68e5`）。**
>
> 1. **契约落点**：样例的 `contracts/<domain>/<domain>.<table>.json` **不是**仓内真实布局。canon 是
>    `contracts/common/<源>.<表>.json`（`contracts/README.md`），客户覆盖在
>    `contracts/customers/<客户>/<源>.<表>.json`（`contracts/customers/README.md`）。
>    交付口径：**基线里已有同 id 契约 ⇒ 复用它的真实 `path`**；否则才 `contracts/common/<domain>.<table>.json`。
>    （样例若照抄，人工新建会落进 `contracts/<domain>/` 这个不存在的目录，且被 `contractFor` 的最长前缀规则静默遮蔽。）
> 2. **契约反查**：样例的 `startsWith('<domain>.<table>.')` 对其自身 fixture（基线 `lemeng.a.b`、草案 `lemeng.a_c`）**永不命中**，
>    与同一段测试的断言自相矛盾 ⇒ 改为两级反查（精确 id → 同域前缀）。
> 3. **下游档位**：`DownstreamItem` 由 `{path, why}` 扩为 `{path, why, kind}`，`kind ∈ required|affected|candidate|unknown`，
>    另加可选 `targets` 承载**全量**可枚举事实（candidate ⇒ 管线 id；歧义 unknown ⇒ 契约 path）。
>    聚合项**不得**只把可枚举事实写在散文里。
> 4. **loader 支持客户级契约**：`loadContracts` 下探 `contracts/customers/<客户>/` 两层（`_` 前缀与非 `.json` 跳过；
>    客户目录不可读 ⇒ 告警 + `incomplete`；`customers/` 整个缺失 ⇒ 静默），同 id 多份**只告警、点名两个真实 path、
>    不裁决优先级**（优先级未定案，要问 owner），并返回 `incomplete: boolean`。
>
> **已知遗留（转终审裁决）**：`read.ts` 的 `ReadAll` 未透出 `contractsIncomplete`（读面仍只能靠 warning 文本判断基线不完）；
> `propose` 的「契约面读不全」理由把同 id 重复告警一并拼进散文。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/propose.test.ts
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildContractProposal, buildPipelineProposal } from './propose'
import type { PipelineDeps } from './read'

const root = mkdtempSync(join(tmpdir(), 'pl-propose-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'pipelines'), { recursive: true })
writeFileSync(join(root, 'pipelines', 'lemeng.a.b.json'), JSON.stringify({ name: 'lemeng.a.b', nodes: [], edges: [] }))
mkdirSync(join(root, 'contracts', 'lemeng'), { recursive: true })
writeFileSync(join(root, 'contracts', 'lemeng', 'lemeng.a.json'), JSON.stringify({
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  batch: { markerColumn: 'b', type: 'varchar', unique: false },
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
}))
const deps: PipelineDeps = { roots: { pipelinesRoot: root, contractsRoot: join(root, 'contracts') }, runs: null, env: {} }

const pipeline = {
  name: 'lemeng.a.c', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a_c/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}
const contract = {
  contractVersion: 2, domain: 'lemeng', table: 'a_c', owner: 'data-platform',
  layout: { prefix: 'lemeng/a_c', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
  batch: { markerColumn: 'batch_id', type: 'varchar', unique: false },
  columns: [{ name: 'batch_id', type: 'varchar', nullable: false }],
}

describe('buildPipelineProposal', () => {
  it('两件套路径正确、内容可回读、slug 化分支名', () => {
    const p = buildPipelineProposal(deps, { pipeline, contract, title: '新增 A_C 采集: v1!', rationale: '因为要' })
    expect(p.branch).toBe('proposal/a-c-v1')
    expect(p.pieces.map((x) => x.path)).toEqual([
      'deploy/duckle/console/pipelines/lemeng.a.c.json',
      'contracts/lemeng/lemeng.a_c.json',
    ])
    expect(JSON.parse(p.pieces[0].content).name).toBe('lemeng.a.c')
    expect(JSON.parse(p.pieces[1].content).table).toBe('a_c')
    expect(p.validation).toEqual([])
  })
  it('管线名非法 ⇒ validation 有 issue（路由片据此拒）', () => {
    const p = buildPipelineProposal(deps, { pipeline: { name: '../x', nodes: [], edges: [] }, title: 't', rationale: 'r' })
    expect(p.validation.length).toBeGreaterThan(0)
  })
  it('未提供契约 ⇒ downstream 点名缺契约；未提供时下游仍有 dbt staging 项', () => {
    const p = buildPipelineProposal(deps, { pipeline, title: 't', rationale: 'r' })
    expect(p.pieces.map((x) => x.path)).toEqual(['deploy/duckle/console/pipelines/lemeng.a.c.json'])
    expect(p.downstream.map((d) => d.why).join()).toContain('契约')
    expect(p.downstream.map((d) => d.path).join()).toContain('dbt/models/')
  })
  it('★ 零写入：调用前后目录树字节级不变', () => {
    const before = readdirSync(root, { recursive: true }).sort()
    buildPipelineProposal(deps, { pipeline, contract, title: 't', rationale: 'r' })
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
  })
})

describe('buildContractProposal', () => {
  it('路径按 domain 落 contracts/<domain>/<domain>.<table>.json；受影响管线反查出来', () => {
    const p = buildContractProposal(deps, { contract, title: '改 A', rationale: 'r' })
    expect(p.pieces[0].path).toBe('contracts/lemeng/lemeng.a_c.json')
    expect(p.downstream.map((d) => d.path).join()).toContain('lemeng.a.b')
  })
  it('非法契约 ⇒ validation 非空', () => {
    expect(buildContractProposal(deps, { contract: { ...contract, contractVersion: 1 }, title: 't', rationale: 'r' })
      .validation.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/propose.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// modules/data/domain/pipelines/propose.ts
// propose.ts —— 三件套**草案生成**（D-W3-5）。
//
// ★ 本文件**零写入**：只拼字符串、只读仓内事实，绝不写任何文件、绝不建分支、绝不调网络。
//   红线（spec §7「不直写 contracts/ duckle/ 正式目录」）因此是**结构性成立**的——
//   不是靠「记得别写」。
//
// 三件套纪律（contracts/README.md + duckle/README.md）：契约 + 管线 + dbt staging 必须同 PR。
// 本文件生成前两件；第三件（dbt staging 模型）**不机械生成**——它要 var() 前缀、subject_org()、
// read_parquet 的位置参数形态等域内知识（见 dbt/models/lemeng/staging/stg_lemeng_item.sql 头注），
// 机械产出必是错的。故它只进 downstream 清单，由人/后续流程补。
import type { Issue } from './validate-types'
import { validateContractDraft, validatePipelineDraft } from './validate'
import { contractFor, loadContracts, loadPipelines, PIPELINE_ID_RE } from './defs'
import type { PipelineDeps } from './read'

export interface ProposedFile { path: string; bytes: number; content: string }
export interface DownstreamItem { path: string; why: string }
export interface PipelineProposal {
  title: string
  rationale: string
  branch: string
  pieces: ProposedFile[]
  downstream: DownstreamItem[]
  validation: Issue[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/

/** 标题 → 分支 slug（只建议，不创建）：小写、非字母数字折成 '-'、折叠、截 40。 */
export function slugOf(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s === '' ? 'change' : s.replace(/-+$/, '')
}

const file = (path: string, content: string): ProposedFile =>
  ({ path, bytes: Buffer.byteLength(content, 'utf8'), content })

export function buildPipelineProposal(
  deps: PipelineDeps,
  input: { pipeline: unknown; contract?: unknown; title: string; rationale: string },
): PipelineProposal {
  const pipelineId = str((input.pipeline as { name?: unknown } | null)?.name)
  const validation = [
    ...(PIPELINE_ID_RE.test(pipelineId) ? [] : [{ path: 'pipeline.name', message: '管线名必须是 [A-Za-z0-9_.-] 且非空' }]),
    ...validatePipelineDraft(input.pipeline),
  ]
  const pieces: ProposedFile[] = [file(
    `deploy/duckle/console/pipelines/${PIPELINE_ID_RE.test(pipelineId) ? pipelineId : '<invalid>'}.json`,
    `${JSON.stringify(input.pipeline, null, 2)}\n`,
  )]
  if (input.contract !== undefined) {
    const c = input.contract as { domain?: unknown; table?: unknown } | null
    const domain = str(c?.domain)
    const table = str(c?.table)
    validation.push(...validateContractDraft(input.contract))
    const path = DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
      ? `contracts/${domain}/${domain}.${table}.json`
      : 'contracts/<invalid>/<invalid>.json'
    pieces.push(file(path, `${JSON.stringify(input.contract, null, 2)}\n`))
  }
  const downstream: DownstreamItem[] = []
  if (input.contract === undefined) {
    const existing = contractFor(pipelineId, loadContracts(deps.roots).contracts)
    downstream.push(existing === null
      ? { path: 'contracts/<domain>/<domain>.<table>.json', why: '契约未提供：新表必须先有契约（三件套之一）' }
      : { path: existing.path, why: '契约未提供：请确认沿用现有契约；若列集变了必须同 PR 改它' })
  }
  downstream.push({ path: `dbt/models/<域>/staging/stg_${'<domain>_<table>'}.sql`, why: 'dbt staging 模型（三件套之一）：需按域内既有形态手写，不机械生成' })
  return {
    title: input.title, rationale: input.rationale,
    branch: `proposal/${slugOf(input.title)}`, pieces, downstream, validation,
  }
}

export function buildContractProposal(
  deps: PipelineDeps,
  input: { contract: unknown; title: string; rationale: string },
): PipelineProposal {
  const c = input.contract as { domain?: unknown; table?: unknown } | null
  const domain = str(c?.domain)
  const table = str(c?.table)
  const validation = validateContractDraft(input.contract)
  const path = DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
    ? `contracts/${domain}/${domain}.${table}.json`
    : 'contracts/<invalid>/<invalid>.json'
  const id = `${domain}.${table}`
  // 受影响管线：id 以 `<domain>.<table>` 为前缀者（与 contractFor 同一命名约定，反向用）。
  const affected = [...loadPipelines(deps.roots).defs.values()]
    .filter((d) => d.id === id || d.id.startsWith(`${id}.`))
    .map((d) => ({ path: `deploy/duckle/console/pipelines/${d.id}.json`, why: '该管线写这张表：列集/类型变更需同步核对' }))
  return {
    title: input.title, rationale: input.rationale,
    branch: `proposal/${slugOf(input.title)}`,
    pieces: [file(path, `${JSON.stringify(input.contract, null, 2)}\n`)],
    downstream: [
      ...affected,
      { path: `dbt/models/<域>/staging/stg_${domain}_${table}.sql`, why: 'staging 模型按契约列集取列：契约变了要同步' },
      { path: 'dbt/semantics/l1_metrics.yml', why: '若该表参与了 L1 口径，语义声明可能要跟着改' },
    ],
    validation,
  }
}

// ── 两个工具实现（路由片把 validation 非空翻译成 refused/invalid_draft）──────────────────
export const proposePipelineChangeImpl: import('./read').PipelineImpl = async (deps, args) => {
  const title = typeof args.title === 'string' && args.title !== '' ? args.title.slice(0, 120) : ''
  const rationale = typeof args.rationale === 'string' ? args.rationale : ''
  if (title === '' || rationale === '') {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'title/rationale 必填' }, isError: true, auditRowCount: null }
  }
  const p = buildPipelineProposal(deps, { pipeline: args.pipeline, contract: args.contract, title, rationale })
  if (p.validation.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: p.validation }, isError: true, auditRowCount: null }
  }
  return {
    payload: {
      status: 'ok', title: p.title, rationale: p.rationale, branch: p.branch,
      pieces: p.pieces.map((x) => ({ path: x.path, bytes: x.bytes, content: x.content })),
      downstream: p.downstream,
      note: '草案只在本回包里：本服务不落盘、不开 PR。应用方式由人决定（红线：不直写正式目录）。',
    },
    isError: false, auditRowCount: null,
  }
}

export const proposeContractChangeImpl: import('./read').PipelineImpl = async (deps, args) => {
  const title = typeof args.title === 'string' && args.title !== '' ? args.title.slice(0, 120) : ''
  const rationale = typeof args.rationale === 'string' ? args.rationale : ''
  if (title === '' || rationale === '') {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'title/rationale 必填' }, isError: true, auditRowCount: null }
  }
  const p = buildContractProposal(deps, { contract: args.contract, title, rationale })
  if (p.validation.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: p.validation }, isError: true, auditRowCount: null }
  }
  return {
    payload: {
      status: 'ok', title: p.title, rationale: p.rationale, branch: p.branch,
      pieces: p.pieces.map((x) => ({ path: x.path, bytes: x.bytes, content: x.content })),
      downstream: p.downstream,
      note: '草案只在本回包里：本服务不落盘、不开 PR。应用方式由人决定（红线：不直写正式目录）。',
    },
    isError: false, auditRowCount: null,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/propose.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/propose.ts modules/data/domain/pipelines/propose.test.ts
git commit -m "feat(data-mcp): 提案面草案生成（零写入，三件套下游清单）"
```

---

## Task 7: `run_pipeline_sandbox`（校验闸，不执行）

**Files:**
- Create: `modules/data/domain/pipelines/sandbox.ts`
- Create: `modules/data/domain/pipelines/sandbox.test.ts`

**Interfaces:**
- Consumes: `validatePipelineDraft`、`sandboxViolations`（Task 5）。
- Produces: `runPipelineSandboxImpl: PipelineImpl`。

**回包口径（三段，缺一不可）：**
1. 结构非法 ⇒ `{status:'refused', reason:'invalid_draft', issues}`，`isError: true`
2. 沙箱断言违规 ⇒ `{status:'denied', reason:'sandbox_prefix_violation', violations}`，`isError: true`
3. 两项都过 ⇒ `{status:'not_executed', reason:'sandbox_runner_unavailable', note, checked:{structure:true,sandboxPrefix:true}}`，`isError: false`
   —— `isError: false` 是刻意的：**校验过了、只是没跑**，不是调用失败；但 `status` 绝不会是 `ok`。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/pipelines/sandbox.test.ts
import { describe, expect, it } from 'vitest'
import { runPipelineSandboxImpl } from './sandbox'
import type { PipelineDeps } from './read'

const deps: PipelineDeps = { roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {} }
const good = {
  name: 'lemeng.sbx', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/sbx/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}

describe('runPipelineSandboxImpl', () => {
  it('合法草案 ⇒ not_executed（校验通过但没跑），绝不给 ok', async () => {
    const out = await runPipelineSandboxImpl(deps, { pipeline: good })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'not_executed', reason: 'sandbox_runner_unavailable',
      checked: { structure: true, sandboxPrefix: true },
    })
    expect(String((out.payload as { note: string }).note)).toContain('待沉淀')
  })
  it('结构非法 ⇒ refused/invalid_draft', async () => {
    const out = await runPipelineSandboxImpl(deps, { pipeline: { name: '' } })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
  it('写正式湖 ⇒ denied/sandbox_prefix_violation（先于 not_executed）', async () => {
    const bad = { ...good, nodes: [good.nodes[0], { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/sbx/all.parquet' } } }] }
    const out = await runPipelineSandboxImpl(deps, { pipeline: bad })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'sandbox_prefix_violation' })
  })
  it('webhook 出口 ⇒ 同样被拒', async () => {
    const bad = { ...good, nodes: [good.nodes[0], { id: 'w', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect((await runPipelineSandboxImpl(deps, { pipeline: bad })).payload).toMatchObject({ status: 'denied' })
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/sandbox.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// modules/data/domain/pipelines/sandbox.ts
// sandbox.ts —— run_pipeline_sandbox：**校验闸**，本轮不执行（D-W3-4）。
//
// 为什么不执行：真机实测 server 容器内既无 duckle 二进制也无 runner 入口；而 spec 红线是
// 「产物写 __sandbox 前缀、不入正式湖」——没有「确实只写 __sandbox」的执行面，宁可不跑，
// 也不给一个看起来成功的结果。执行侧待沉淀（需要一条真机验证过的运行通道 + CLI 形态）。
import type { PipelineImpl } from './read'
import { sandboxViolations, validatePipelineDraft } from './validate'

const NOTE = '待沉淀：本服务容器内没有 duckle 运行面（实测无 duckle / duckle-runner 二进制），'
  + '故只做结构校验与沙箱前缀断言，**没有执行任何管线**。执行通道需真机验证后另案接入。'

export const runPipelineSandboxImpl: PipelineImpl = async (_deps, args) => {
  const structure = validatePipelineDraft(args.pipeline)
  if (structure.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: structure }, isError: true, auditRowCount: null }
  }
  const violations = sandboxViolations(args.pipeline)
  if (violations.length > 0) {
    return {
      payload: {
        status: 'denied', reason: 'sandbox_prefix_violation',
        violations,
        note: '沙箱试跑不得写正式湖、不得对外发数据——改了再试。',
      },
      isError: true, auditRowCount: null,
    }
  }
  return {
    payload: {
      status: 'not_executed', reason: 'sandbox_runner_unavailable',
      checked: { structure: true, sandboxPrefix: true }, note: NOTE,
    },
    isError: false, auditRowCount: null,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/sandbox.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/pipelines/sandbox.ts modules/data/domain/pipelines/sandbox.test.ts
git commit -m "feat(data-mcp): run_pipeline_sandbox 校验闸（沙箱前缀断言 + 显式未执行）"
```

---

## Task 8: MCP 工具片 + 挂进 `/mcp-manage`（审计与写闸单点）

**Files:**
- Create: `modules/data/routes/mcp-pipeline-tools.ts`
- Create: `modules/data/routes/mcp-pipeline-tools.test.ts`
- Modify: `modules/data/routes/mcp-manage.ts`（仅 `GROUPS` 一行）
- Modify: `modules/data/routes/mcp-manage.test.ts`（追加一条管理面重名断言）

**Interfaces:**
- Consumes: Task 1 的 `PIPELINE_TOOLS/pipelineToolMeta`；Task 3/4/6/7 的五个 impl；`registry.mutatingAllowed`；`audit-store.writeAudit`。
- Produces:
  - `interface PipelineWiring { roots: PipelineRoots; env: Record<string,string|undefined>; runs: PipelineRunSource | null }`
  - `defaultPipelineWiring(): PipelineWiring`
  - `makePipelineTools(wiring?: PipelineWiring): McpToolGroup`
  - `pipelineTools: McpToolGroup`（= `makePipelineTools()`，给 `mcp-manage.ts` 用）

**分派表（工具名 → impl）与三条硬约束：**
- `list()`：`deps.requester === null` ⇒ `[]`（M3 守卫，与两面一致）。
- `call()`：非本片工具 ⇒ **返回 `null`**（交合成方继续问下一片）；本片工具在写闸关时 ⇒ `denied/mutating_disabled`。
- **审计单点**：所有结局（ok/denied/error）经 `writeAudit` 写 `tool` 字段；未知/异常也写。

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/routes/mcp-pipeline-tools.test.ts
// 审计落库用真 PG（DATABASE_URL）；其余项不需要库。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { makePipelineTools } from './mcp-pipeline-tools'
import type { McpDeps } from './mcp-rpc'
import type { Requester } from '../domain/authz'

const root = mkdtempSync(join(tmpdir(), 'pl-tools-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'pipelines'), { recursive: true })
writeFileSync(join(root, 'pipelines', 'lemeng.a.b.json'), JSON.stringify({
  name: 'lemeng.a.b', nodes: [{ id: 's', type: 'source', data: { componentId: 'src.rest' } }, { id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/a.csv' } } }], edges: [],
}))

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'pat', keyId: 7, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
}
const depsOf = (over: Partial<McpDeps> = {}): McpDeps => ({
  pool: { query: async () => ({ rows: [] }) } as never,
  org: 'acme', requester, adoptedSources: new Set(), ...over,
})
const wiring = (env: Record<string, string | undefined> = {}) => ({
  roots: { pipelinesRoot: root, contractsRoot: join(root, 'contracts') }, env, runs: null,
})

describe('makePipelineTools.list', () => {
  it('空身份 ⇒ 空工具面', async () => {
    expect(await makePipelineTools(wiring()).list(depsOf({ requester: null }))).toEqual([])
  })
  it('持身份 ⇒ 7 个工具，且不外泄 requiredScope/mutating 等治理字段', async () => {
    const list = await makePipelineTools(wiring()).list(depsOf())
    expect(list.map((t) => t.name)).toHaveLength(7)
    for (const t of list) {
      expect('requiredScope' in t).toBe(false)
      expect('mutating' in t).toBe(false)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
    }
  })
})

describe('makePipelineTools.call', () => {
  it('非本片工具 ⇒ null（交下一片）', async () => {
    const g = makePipelineTools(wiring())
    expect(await g.call(depsOf(), 'list_metrics', {})).toBeNull()
  })
  it('读工具正常派发', async () => {
    const g = makePipelineTools(wiring())
    const out = await g.call(depsOf(), 'list_pipelines', {})
    expect(out!.isError).toBe(false)
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'ok', count: 1 })
  })
  it('写工具在总闸关时 denied/mutating_disabled（默认 false）', async () => {
    const g = makePipelineTools(wiring({ DATA_MCP_ALLOW_MUTATING: '' }))
    for (const name of ['run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change']) {
      const out = await g.call(depsOf(), name, {})
      expect(out!.isError).toBe(true)
      expect(JSON.parse(out!.text)).toMatchObject({ status: 'denied', reason: 'mutating_disabled', name })
    }
  })
  it('总闸开 ⇒ 写工具真正执行（非法入参仍是工具级错误）', async () => {
    const g = makePipelineTools(wiring({ DATA_MCP_ALLOW_MUTATING: 'true' }))
    const out = await g.call(depsOf(), 'propose_contract_change', { contract: {}, title: 't', rationale: 'r' })
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
  it('空身份调用任何工具 ⇒ denied/unauthenticated', async () => {
    const g = makePipelineTools(wiring())
    const out = await g.call(depsOf({ requester: null }), 'list_pipelines', {})
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'denied', reason: 'unauthenticated' })
  })
})

// ── 审计：真库（写 data.query_audit）────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
describePg('审计单点（需要 DATABASE_URL）', () => {
  const ORG = 'org-wave3-audit'
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await pool.end()
  })
  it('每条调用（ok / not_found / unknown / denied）都落一行，verdict 不把「空」当「拒」', async () => {
    const g = makePipelineTools(wiring())
    const deps = depsOf({ pool, org: ORG })
    await g.call(deps, 'list_pipelines', {})
    await g.call(deps, 'get_pipeline', { id: 'nope' })
    await g.call(deps, 'list_pipeline_runs', {})
    await g.call(deps, 'propose_pipeline_change', { id: 'x' })
    const { rows } = await pool.query<{ tool: string; verdict: string; reason: string | null }>(
      'select tool, verdict, reason from data.query_audit where org = $1 order by id', [ORG])
    expect(rows.map((r) => r.tool)).toEqual([
      'list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'propose_pipeline_change'])
    // not_found（问的客体不存在）与 unknown（读不到）都是 **ok**；只有真被拒（写闸关）才是 denied。
    expect(rows.map((r) => r.verdict)).toEqual(['ok', 'ok', 'ok', 'denied'])
    // reason 是区分三种「空」的唯一抓手：'' 落 null，其余透传。
    expect(rows.map((r) => r.reason)).toEqual([null, 'not_found', 'runs_source_not_wired', 'mutating_disabled'])
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd modules/data && DATABASE_URL="$(cat /tmp/pc_test_url 2>/dev/null)" pnpm exec vitest run routes/mcp-pipeline-tools.test.ts`
（`/tmp/pc_test_url` 是本地真 PG 的 DSN；无库时该文件仍能跑，真库段 skip）
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// mcp-pipeline-tools.ts —— 管理面 MCP 端点的**管线提案片**（Wave 3 / spec §7 的 7 个工具）。
//
// 门禁由宿主按 manifest 的 `POST /mcp-manage → data:manage` 施加——**本文件不写 requireScope**
// （与 mcp-metric-tools.ts 同规：声明即授权）。空身份守卫与读面/口径片同形（M3）。
//
// 三条不变式（本文件是它们的唯一落点）：
//   ① **写总闸**：mutating 工具在 DATA_MCP_ALLOW_MUTATING !== 'true' 时一律 mutating_disabled；
//   ② **审计单点**：所有结局（ok/denied/error）都写 data.query_audit（tool = 工具名）；
//   ③ **不认领返回 null**：mcp-manage.ts 的合成方据此继续问下一片。
import { writeAudit } from '../domain/audit-store'
import { mutatingAllowed } from '../domain/toolbox/registry'
import { PIPELINE_TOOLS, pipelineToolMeta } from '../domain/pipelines/tools'
import { rootsOf } from '../domain/pipelines/defs'
import type { PipelineRoots } from '../domain/pipelines/defs'
import { getPipelineImpl, listPipelinesImpl } from '../domain/pipelines/read'
import type { PipelineDeps, PipelineImpl } from '../domain/pipelines/read'
import { getPipelineRunImpl, listPipelineRunsImpl } from '../domain/pipelines/runs'
import type { PipelineRunSource } from '../domain/pipelines/runs'
import { proposeContractChangeImpl, proposePipelineChangeImpl } from '../domain/pipelines/propose'
import { runPipelineSandboxImpl } from '../domain/pipelines/sandbox'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

export interface PipelineWiring {
  roots: PipelineRoots
  env: Record<string, string | undefined>
  runs: PipelineRunSource | null
}

/** 缺省装配：仓内路径（镜像 /app 与本地 cwd 都成立）+ process.env + 运行记录 seam 未接通。 */
export function defaultPipelineWiring(env: Record<string, string | undefined> = process.env): PipelineWiring {
  return { roots: rootsOf(env), env, runs: null }
}

const IMPLS: Record<string, PipelineImpl> = {
  list_pipelines: listPipelinesImpl,
  get_pipeline: getPipelineImpl,
  list_pipeline_runs: listPipelineRunsImpl,
  get_pipeline_run: getPipelineRunImpl,
  run_pipeline_sandbox: runPipelineSandboxImpl,
  propose_pipeline_change: proposePipelineChangeImpl,
  propose_contract_change: proposeContractChangeImpl,
}

const entryOf = (t: (typeof PIPELINE_TOOLS)[number]): Record<string, unknown> => ({
  name: t.name, title: t.title, description: t.description,
  inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
})

export function makePipelineTools(wiring: PipelineWiring = defaultPipelineWiring()): McpToolGroup {
  const depsOf = (d: McpDeps): PipelineDeps => ({ roots: wiring.roots, env: wiring.env, runs: wiring.runs })

  /** 单点审计：工具名恒写；metricId 恒 ''（管线工具不是指标工具）。 */
  const audit = async (
    d: McpDeps, name: string, args: Record<string, unknown>,
    verdict: 'ok' | 'denied' | 'error', reason: string, rowCount: number | null,
  ): Promise<void> => {
    await writeAudit(d.pool, {
      org: d.org, userId: d.requester?.userId ?? '(anonymous)',
      channel: d.requester?.channel ?? 'session', keyId: d.requester?.keyId ?? null,
      metricId: '', params: args, rowCount, verdict,
      reason: reason === '' ? null : reason, masking: null, tool: name,
    })
  }

  const reply = async (
    d: McpDeps, name: string, args: Record<string, unknown>,
    payload: Record<string, unknown>, isError: boolean, rowCount: number | null,
  ): Promise<McpToolResult> => {
    // 审计三态只有 ok / denied / error。**`not_found` 与 `unknown` 都不是 denied**：
    // 前者是「被问的客体不存在」、后者是「读不到」，都不是「调用被拒」——把它们记成 denied
    // 会让安全复核分不清「判了拒」和「查了个空」。reason 一律透传 payload.reason（含 ok 行），
    // 这样 `select tool, verdict, reason, count(*) … group by 1,2,3` 能区分三种空。
    const status = typeof payload.status === 'string' ? payload.status : null
    const verdict = status === 'error' ? 'error' : isError && status !== 'not_found' ? 'denied' : 'ok'
    const reason = typeof payload.reason === 'string' ? payload.reason : (status !== null && status !== 'ok' ? status : '')
    await audit(d, name, args, verdict, reason, rowCount)
    return {
      text: JSON.stringify(payload), isError,
      ...(isError ? {} : { structured: payload }),
    }
  }

  return {
    async list(d: McpDeps) {
      if (d.requester === null) return []
      return PIPELINE_TOOLS.map(entryOf)
    },

    async call(d: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
      const meta = pipelineToolMeta(name)
      if (meta === undefined) return null
      if (d.requester === null) {
        return reply(d, name, args, { status: 'denied', reason: 'unauthenticated' }, true, null)
      }
      if (meta.mutating && !mutatingAllowed(wiring.env)) {
        return reply(d, name, args, { status: 'denied', reason: 'mutating_disabled', name }, true, null)
      }
      try {
        const out = await IMPLS[name]!(depsOf(d), args)
        return await reply(d, name, args, out.payload, out.isError, out.auditRowCount ?? null)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return await reply(d, name, args, { status: 'error', reason: 'tool_exception', detail }, true, null)
      }
    },
  }
}

/** 给 mcp-manage.ts 的现成实例（缺省装配）。 */
export const pipelineTools: McpToolGroup = makePipelineTools()
```

- [ ] **Step 4: 改 `mcp-manage.ts`（一行 + 一行 import）**

```ts
import { pipelineTools } from './mcp-pipeline-tools'
```

```ts
/** 管理面的工具片。加新片只改这一行（协议壳与门档都不动）。 */
const GROUPS: readonly McpToolGroup[] = [metricTools, reportTools, pipelineTools]
```

- [ ] **Step 5a: 改既有「恰六件」断言（加片必红，但**不许**放宽）**

`mcp-manage.test.ts` 里有一条 `tools/list → 恰好六件（口径三 + 报表三，#496）`。加片后它必然红。**不要改成 `≥6` 或只断言包含**——那会丢掉 #496 的结构约束（「能提不能发」）。替换成两条字面量清单各自恰好：

```ts
  /** 口径片 + 报表片：设计稿 §6#7 的结构约束（多出发布/回收类 = 「能提不能发」被破坏）。 */
  const METRIC_REPORT_TOOL_NAMES = ['customize_metric', 'delete_custom_metric', 'list_metrics',
    'list_reports', 'propose_report', 'revise_report_spec']
  /** Wave 3 提案面（spec §7）：七个，缺一或多一都算漂。 */
  const PIPELINE_TOOL_NAMES = ['get_pipeline', 'get_pipeline_run', 'list_pipeline_runs', 'list_pipelines',
    'propose_contract_change', 'propose_pipeline_change', 'run_pipeline_sandbox']

  it('tools/list → 口径三 + 报表三（#496）与提案七件（Wave 3）各自恰好', async () => {
    await seedL1()
    const body = await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const tools = (body as { result: { tools: { name: string; description: string }[] } }).result.tools
    expect(tools.map((t) => t.name).sort()).toEqual([...METRIC_REPORT_TOOL_NAMES, ...PIPELINE_TOOL_NAMES].sort())
    expect(tools.find((t) => t.name === 'customize_metric')!.description).toContain('不能凭空造新指标')
  })
```

> ⚠️ 两张清单必须是**字面量**。从 `GROUPS`/各片自己推出期望值 = 拿被测对象证明自己（同义反复），门禁失效。

- [ ] **Step 5b: 追加管理面重名断言**

在 `modules/data/routes/mcp-manage.test.ts` 末尾追加：

```ts
describe('管理面工具片：跨片名字不重（新增片必过）', () => {
  it('三片合成后工具名唯一', async () => {
    const { GROUPS } = await import('./mcp-manage')
    const fake = {
      pool: { query: async () => ({ rows: [] }) } as never,
      org: 'acme', adoptedSources: new Set<string>(),
      requester: { userId: 'u', orgId: 'acme', channel: 'pat' as const, keyId: 1, scopes: ['data:manage'], hasScope: () => true },
    }
    const names = (await Promise.all(GROUPS.map((g) => g.list(fake as never)))).flat().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
```

> 若 `GROUPS` 未导出，同文件把它改成 `export const GROUPS`（最小改动）。

- [ ] **Step 6: 跑测试**

Run: `cd modules/data && pnpm exec vitest run routes/mcp-pipeline-tools.test.ts routes/mcp-manage.test.ts`
Expected: PASS（真库段在有 `DATABASE_URL` 时跑，无库时 skip）。

- [ ] **Step 7: 提交**

```bash
git add modules/data/routes/mcp-pipeline-tools.ts modules/data/routes/mcp-pipeline-tools.test.ts modules/data/routes/mcp-manage.ts modules/data/routes/mcp-manage.test.ts
git commit -m "feat(data-mcp): 提案面工具片挂进 /mcp-manage（写闸 + 审计单点）"
```

---

## Task 9: 镜像与配置（`contracts` 进镜像、env 声明、部署文档）

**Files:**
- Modify: `deploy/Dockerfile.server`（build 阶段 + runtime 阶段各一行）
- Modify: `.env.example`
- Modify: `deploy/data-plane-deploy-sop.md`（一段：提案面读面的事实来源与不可达项）

- [ ] **Step 1: 镜像加 `contracts`**

在 `deploy/Dockerfile.server` 里，`COPY dbt ./dbt` 之后各加一行（两个阶段都要，runtime 阶段是 `COPY --from=build`）：

```dockerfile
# 提案面（Wave 3）读面的事实源之一：契约 JSON 是运行时只读资产（与 dbt/ 同性质）。
# 注意：管线与调度已在 `COPY deploy ./deploy` 里（deploy/duckle/console/）。
COPY contracts ./contracts
```

```dockerfile
COPY --from=build /app/contracts ./contracts
```

- [ ] **Step 2: `.env.example` 追加两键**

```bash
# 提案面（Wave 3）只读定义源：管线与调度目录（缺省 <cwd>/deploy/duckle/console；镜像内 = /app/deploy/duckle/console）。
DATA_PIPELINES_ROOT=
# 提案面只读定义源：数据契约目录（缺省 <cwd>/contracts；镜像内 = /app/contracts）。
DATA_CONTRACTS_ROOT=
```

- [ ] **Step 3: 跑 B9 门禁**

Run: `pnpm exec tsx scripts/check-env-example.mjs`
Expected: `check-env-example: OK`（若正文另外引用了新 env，按报错补声明）。

- [ ] **Step 4: SOP 补一段（写清事实，不写推测）**

在 `deploy/data-plane-deploy-sop.md` 的运维口径区追加：

```markdown
### 提案面（Wave 3）读面的事实来源

- **可达且已在镜像内**：管线 `deploy/duckle/console/pipelines/*.json`、调度
  `deploy/duckle/console/schedules/*.json`（`COPY deploy`）、契约 `contracts/**`（Wave 3 新增 COPY）。
- **不可达（待沉淀）**：运行记录在 console 的 per-账套 workspace 卷（`/workspace/runs/`）；
  platform-core 容器既看不到卷、也够不到 `127.0.0.1:18080/18081`（跨 compose 项目 + 回环）。
  故 `list_pipeline_runs`/`get_pipeline_run` 回**显式 unknown**，不是「没跑过」。
- **不执行**：`run_pipeline_sandbox` 只做结构校验与 `__sandbox/` 前缀断言，回 `not_executed`
  （容器内无 duckle / duckle-runner）。执行通道需真机验证后另案。
```

- [ ] **Step 5: 提交**

```bash
git add deploy/Dockerfile.server .env.example deploy/data-plane-deploy-sop.md
git commit -m "build(data-mcp): 提案面把 contracts 打进镜像 + env 声明 + SOP 事实来源"
```

---

## Task 10: 全量验证与部署交接

- [ ] **Step 1: 模块测试**

Run: `pnpm test`
Expected: 全绿（含新增 `domain/pipelines/*`、`routes/mcp-pipeline-tools.test.ts`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: CI 门禁（本 Wave 触及的两条 + 全量）**

Run:
```bash
pnpm exec tsx scripts/check-mcp-toolface.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/check-data-contract.mjs
pnpm exec tsx scripts/check-console-schedules.mjs
pnpm exec tsx scripts/check-console-alerts.mjs
```
Expected: 每条 `… : OK`。

- [ ] **Step 4: 镜像内路径自证（**部署后**，生产容器）**

用 openship exec 在 mytech `server` 容器里验三件事（把输出贴进 PR 评论）：

```sh
ls /app/contracts/common | head -3
ls /app/deploy/duckle/console/pipelines | wc -l
ls /app/deploy/duckle/console/schedules
```

Expected: 契约目录有文件；管线数 = 仓内 28（±本 Wave 新增）；schedules 三个文件。

- [ ] **Step 5: MCP 冒烟（mytech，`data:manage` 临时 Key；用完即删）**

1. `tools/list` ⇒ 出现 `platform-data-mcp-manage` 下 7 个新工具。
2. `list_pipelines`（`{}`）⇒ `status: ok`，`count` 与第 4 步的管线数一致。
3. `get_pipeline`（`{"id":"lemeng.retail.tick.l1"}`）⇒ `definition` 在、`schedules` 非空、`contract: null`（该 id 无对应契约，属预期）。
4. `list_pipeline_runs`（`{}`）⇒ `status: unknown / runs_source_not_wired`。
5. `run_pipeline_sandbox` / `propose_*` ⇒ **403/mutating_disabled**（生产总闸默认关）。
6. 审计：`select tool, verdict from data.query_audit where org='<mytech>' order by id desc limit 10` ⇒ 上述每步一行。

- [ ] **Step 6: 关闸状态确认（防误开）**

Run（openship 项目 env 读取）：确认 mytech / shanhai 的 `DATA_MCP_ALLOW_MUTATING` **未设为 `true`**。
Expected: 空或不存在。**本 Wave 的写面默认保持关**；开启需人单独决定（并在开启前先接好运行记录与执行面）。

- [ ] **Step 7: 提交收尾（计划文件随分支）**

```bash
git add docs/superpowers/plans/2026-10-22-data-mcp-wave3-proposal-face.md
git commit -m "docs(data-mcp): Wave 3 提案面实现计划"
```

---

## 自审（写完后按 spec §7 / §9 复核）

**spec 覆盖**

| spec 要求 | 落在 |
|---|---|
| `list_pipelines` / `get_pipeline` | Task 2/3 |
| `list_pipeline_runs` / `get_pipeline_run` | Task 4（seam，显式 unknown） |
| `run_pipeline_sandbox`（`__sandbox` 前缀、不入正式湖） | Task 5（断言）+ Task 7 |
| `propose_pipeline_change` / `propose_contract_change` | Task 6 |
| 「不直写 `contracts/`/`duckle/` 正式目录」 | 结构性成立：无写盘代码（Task 6 测试钉住） |
| 「试跑不进调度」 | 无任何调度写入路径；`sandboxViolations` 禁 webhook |
| 「每步入审计」 | Task 8 单点 `writeAudit`（含拒绝/异常） |
| 「`data:manage`」 | 复用 `POST /mcp-manage` 既有声明（`manifest.yaml`），本 Wave 不改 manifest |
| 「toolface 门扩展」 | Task 1 Step 5 |
| Wave 3 验收：路径断言测试 / 前缀断言 / **runs 走 OpenShip API 的契约测试** | 路径与前缀断言有（Task 6/5）。**runs 一项未达成**：改为 seam + unknown，理由见 D-W3-3 —— 这是本计划**唯一的 spec 偏离**，需人确认 |

**已知偏离清单（需人确认）**

1. **runs 读面**：spec 写「走 OpenShip API」；本轮改为 seam + 显式 unknown（platform-core 无 openship 客户端，容器内无 token；真机不可达事实见 D-W3-3）。
2. **开 PR**：spec 写「落 PR 分支」；本轮只产出内存草案 + 建议分支名（D-W3-5）。开 PR 另立 issue。
3. **沙箱真执行**：本轮只做校验闸 + 前缀断言（D-W3-4），执行通道标待沉淀。

**类型/命名一致性**：`PipelineDeps` / `PipelineImpl`（均在 Task 4 的 `types.ts` 定义，read.ts 转出，Task 3/6/7/8 使用）、`PipelineRunRecord` / `PipelineRunSource`（Task 4 的 `types.ts`，runs.ts 转出）、`Issue`（Task 5 的 `validate-types.ts`）、`PipelineWiring`（Task 8）在两个以上任务间出现，命名已统一。
