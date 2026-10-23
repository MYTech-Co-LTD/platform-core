# 运行记录面接线（D-W3-3 / #1001）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `list_pipeline_runs` / `get_pipeline_run` 从 seam（恒回 `unknown/runs_source_not_wired`）接到真实数据源——duckle console 的 `runs/` 目录（只读文件），同时保住三条不变式：写闸、审计单点、未知 ≠ 没有。

**Architecture:** 部署期把各账套 console workspace 卷里的 `runs/` 子目录以 `:ro` bind mount 挂进 platform-core server 容器；应用内新增 `run-source.ts`（纯文件读 + 归一化），`runs.ts` 只做「来源结果 → 工具回包」的语义映射。不新增服务、不改 duckle、不碰控制面。

**Tech Stack:** TypeScript / node:fs（同步读，与 `defs.ts` 读面同规）/ vitest。

## Global Constraints

- **写总闸不动**：`DATA_MCP_ALLOW_MUTATING` 语义不变；本轮两个工具都是 `mutating:false`。
- **审计单点不动**：所有结局仍经 `mcp-pipeline-tools.ts → reply() → data.query_audit`；`unknown` 仍记 `ok`。
- **未知 ≠ 没有**：读不到/读不全时回 `unknown`（带原因与上游摘要），**禁止**回落 `ok` + 空数组。
- **用户输入永不拼路径**：`pipelineId` 过 `PIPELINE_ID_RE`；`runId` 新增 `RUN_ID_RE`（无 `/`、无前导 `.`），非法值在触盘前 `denied/bad_param`。
- **敏感值不落文档**：挂载路径是「在哪、怎么取」级别信息，不写凭据；`.env.example` 只声明键名。
- **不新增依赖**：只用 `node:fs` / `node:path`。
- **测试全绿**：`pnpm --filter @platform/server test` + 仓根 `pnpm test`（含 guard）。
- **生产配置变更单独授权**：Task 5 只写 runbook 与命令，**执行前必须再找人确认**。

---

## 事实基线（2026-10-23 实测，shanhai 控制面 exec）

| 事实 | 证据 |
|---|---|
| 运行记录在 console workspace 卷 | `...-lemeng-console-3120-ws/_data/runs/` 有 `runs/receipts/` 5137 条；64188 卷 4884 条 |
| `runs/<pipeline_id>.json` | JSON **数组**，每条：`run_id, at, status, duration_ms, rows, node_count, trigger, error, category, assets?`；每管线保留 **50** 条（`backfill` 文件恰好 50） |
| `status` 真实词汇 | `ok / error / interrupted / cancelled`（**不是** `failed`） |
| `runs/receipts/<runId>.json` | 对象：`runId, trigger, state(finished/running), at, status, pipelineName, pipelinePath, pipelineHash, engineVersion, resourcePool, startedAt, queueMs, nodes{}`；部分收据 `state != finished`（在跑） |
| 同 id 管线可同时存在于两个账套 | `lemeng.branch.json`、`lemeng.dim.item.l0.json` 在 3120 与 64188 卷各一份 ⇒ 记录必须带 `source`（账套名），不能混 |
| 宿主路径只读挂载是现成形态 | 同机 `dbt: /opt/.../dbt:/usr/app:ro`；`platform-core-shanhai-server` 自己已有一个 host-path `ro` bind |
| 收据保留上限 | README 写 200，实测 5137/4884 ⇒ **待核实**（见下方开放项） |

## 设计决策

1. **来源接口从「函数」改为「对象」**：`PipelineRunSource { list, get }`。
   `get` 直读 `receipts/<runId>.json`，避免被「最近 50 条」窗口误判；`list` 走 per-管线数组。
2. **状态归一化保留引擎词汇**：`error → failed`，其余原样；未知值 → `unknown` 且保留 `rawStatus`。不折叠 `cancelled/interrupted`。
3. **饱和判定**：任一被扫描的 per-管线文件达到 50 条 ⇒ `truncated=true`（list）/ `absenceProven=false`（get）。
   收据上限不参与「缺席可证」判定——理由：收据是明细缓存，若某次运行在所有可读证据里都不存在，
   那么「查不到」就是关于现有记录的事实；口径写进注释，不猜保留策略。
4. **未配置 = seam**：`DATA_RUN_DIRS` 缺失/空白 ⇒ `runs: null` ⇒ 现有 `runs_source_not_wired` 一字不改。
   配置**畸形** ⇒ 来源每次调用都报 `unreadable: [{workspace:'(config)', ...}]` ⇒ 工具回 `unknown`，
   不静默降级成「未接通」（配置写错必须可辨）。
5. **只挂 `runs/` 子目录**：workspace 卷里还有 `connections/`（凭据）等，不进容器。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `modules/data/domain/pipelines/types.ts` | Modify | `PipelineRunRecord` 增字段；`PipelineRunSource` 改对象；新增 `RunListResult` / `RunGetResult` |
| `modules/data/domain/pipelines/run-source.ts` | **Create** | env 解析 + 目录枚举 + 归一化 + 饱和/不可读信号 |
| `modules/data/domain/pipelines/run-source.test.ts` | **Create** | 夹具目录覆盖四态 |
| `modules/data/domain/pipelines/defs.ts` | Modify | 新增 `RUN_ID_RE` |
| `modules/data/domain/pipelines/runs.ts` | Modify | 结果映射 + `unknown` 原因细分 |
| `modules/data/domain/pipelines/runs.test.ts` | Modify | fake source 改对象形态；新增四态断言 |
| `modules/data/routes/mcp-pipeline-tools.ts` | Modify | `defaultPipelineWiring` 接 `runSourceFromEnv` |
| `.env.example` | Modify | 声明 `DATA_RUN_DIRS` |

---

## Task 1: 来源类型 + `RUN_ID_RE`

**Files:**
- Modify: `modules/data/domain/pipelines/types.ts`
- Modify: `modules/data/domain/pipelines/defs.ts`
- Test: `modules/data/domain/pipelines/run-source.test.ts`（本任务先建空壳，Task 2 填）

**Interfaces:**
- Produces: `PipelineRunRecord`（`status` 增 `cancelled|interrupted|unknown`，增 `durationMs/trigger/source/rawStatus`）、
  `RunSourceIssue`、`RunListQuery`、`RunListResult`、`RunGetResult`、`PipelineRunSource { list, get }`、`RUN_ID_RE`。

- [ ] **Step 1: 改类型**

```ts
// types.ts
export interface PipelineRunRecord {
  runId: string
  pipelineId: string
  startedAt: string
  /** 引擎真实词汇的归一：error→failed；cancelled/interrupted 原样；未知值→unknown（rawStatus 保留原值）。 */
  status: 'ok' | 'failed' | 'running' | 'cancelled' | 'interrupted' | 'unknown'
  rawStatus?: string
  endedAt?: string
  rows?: number
  error?: string
  durationMs?: number
  trigger?: string
  /** 来源账套名（同 id 管线可在多个 workspace 各有一份记录，必须可辨）。 */
  source?: string
}

export interface RunSourceIssue { workspace: string; detail: string }
export interface RunListQuery { pipelineId?: string; limit: number }
export interface RunListResult {
  runs: PipelineRunRecord[]
  /** 结果被 limit 截断，或任一被扫描管线已达保留上限（更早的记录看不到）。 */
  truncated: boolean
  /** 读不到的来源；非空 ⇒ 缺席不可证。 */
  unreadable: RunSourceIssue[]
  warnings: string[]
  /** 参与排序/筛选的记录总数（截断前）。 */
  scanned: number
}
export interface RunGetResult {
  run: PipelineRunRecord | null
  /** 缺席是否可证；false ⇒ 调用方只能回 unknown。 */
  absenceProven: boolean
  /** 命中的原始收据（有则带出，供排障看逐节点结果）。 */
  receipt?: Record<string, unknown>
  unreadable: RunSourceIssue[]
  warnings: string[]
  scanned: number
}
export interface PipelineRunSource {
  list(q: RunListQuery): Promise<RunListResult>
  get(runId: string): Promise<RunGetResult>
}
```

```ts
// defs.ts（PIPELINE_ID_RE 下方）
/** 运行 id：引擎形如 `run-manual-<管线>-<epochMs>`；**不得含 `/`、不得以 `.` 开头**（路径拼接前置校验）。 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
```

- [ ] **Step 2: 跑类型检查**

Run: `pnpm --filter @platform/server typecheck`
Expected: 只有 `runs.ts` / `mcp-pipeline-tools.ts` 的既有调用点报类型错（函数→对象），Task 2/3 修。

- [ ] **Step 3: Commit**

```bash
git add modules/data/domain/pipelines/types.ts modules/data/domain/pipelines/defs.ts modules/data/domain/pipelines/run-source.test.ts
git commit -m "feat(data): 运行记录来源类型改成 list/get 对象 + RUN_ID_RE（#1001）"
```

---

## Task 2: `run-source.ts` —— 文件来源

**Files:**
- Create: `modules/data/domain/pipelines/run-source.ts`
- Test: `modules/data/domain/pipelines/run-source.test.ts`

**Interfaces:**
- Consumes: 上一步的类型与 `RUN_ID_RE`。
- Produces: `runSourceFromEnv(env): PipelineRunSource | null`、`MAX_PER_PIPELINE = 50`、`RUN_DIRS_ENV = 'DATA_RUN_DIRS'`。

- [ ] **Step 1: 写失败测试（夹具目录）**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runSourceFromEnv } from './run-source'

const root = mkdtempSync(join(tmpdir(), 'run-src-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ws = (name: string, files: Record<string, unknown>, receipts: Record<string, unknown> = {}) => {
  const dir = join(root, name)
  mkdirSync(join(dir, 'receipts'), { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(body))
  for (const [f, body] of Object.entries(receipts)) writeFileSync(join(dir, 'receipts', f), JSON.stringify(body))
  return dir
}
const listEntry = (runId: string, at: string, status = 'ok') => ({
  run_id: runId, at, status, duration_ms: 10, rows: 3, node_count: 2, trigger: 'scheduled',
})

const a = ws('3120', {
  'lemeng.a.json': [listEntry('run-1', '2026-10-22T02:00:00Z'), listEntry('run-2', '2026-10-22T01:00:00Z', 'error')],
  'lemeng.b.json': [listEntry('run-3', '2026-10-22T03:00:00Z')],
}, {
  'run-old.json': {
    runId: 'run-old', trigger: 'manual', state: 'finished', at: '2026-09-01T00:00:00Z',
    status: 'ok', pipelineName: 'lemeng.a', startedAt: '2026-09-01T00:00:01Z', queueMs: 0,
    nodes: { sink: { status: 'ok', rows: 7 } }, durationMs: 99,
  },
})
const env = { DATA_RUN_DIRS: `3120=${a}` }
```

必测用例：

```ts
it('未配置 ⇒ null（seam 语义不变）', () => {
  expect(runSourceFromEnv({})).toBeNull()
  expect(runSourceFromEnv({ DATA_RUN_DIRS: '   ' })).toBeNull()
})

it('list：跨文件合并、按 startedAt 倒序、带 source、limit 生效', async () => {
  const r = await runSourceFromEnv(env)!.list({ limit: 2 })
  expect(r.runs.map((x) => x.runId)).toEqual(['run-3', 'run-1'])
  expect(r.runs[0].source).toBe('3120')
  expect(r.truncated).toBe(true)          // 3 > 2
  expect(r.scanned).toBe(3)
  expect(r.unreadable).toEqual([])
})

it('list：pipelineId 收窄到单文件；status 归一 error→failed 且保留 rawStatus', async () => {
  const r = await runSourceFromEnv(env)!.list({ pipelineId: 'lemeng.a', limit: 20 })
  expect(r.runs.map((x) => x.runId)).toEqual(['run-1', 'run-2'])
  expect(r.runs[1]).toMatchObject({ status: 'failed', rawStatus: 'error', pipelineId: 'lemeng.a' })
  expect(r.unreadable).toEqual([])
  expect(r.warnings).toEqual([])
})

it('饱和：任一被扫描文件达到 50 条 ⇒ truncated（即便 limit 足够）', async () => {
  const big = ws('big', {
    'p.json': Array.from({ length: 50 }, (_, i) =>
      listEntry(`run-${i}`, `2026-10-22T00:${String(i).padStart(2, '0')}:00Z`)),
  })
  const r = await runSourceFromEnv({ DATA_RUN_DIRS: `big=${big}` })!.list({ limit: 50 })
  expect(r.runs).toHaveLength(50)
  expect(r.truncated).toBe(true)
})

it('坏件不拖垮整表：warnings 点名，好文件照常返回', async () => {
  const bad = ws('bad', { 'ok.json': [listEntry('run-x', '2026-10-22T00:00:00Z')] })
  writeFileSync(join(bad, 'torn.json'), '{ not json')
  const r = await runSourceFromEnv({ DATA_RUN_DIRS: `bad=${bad}` })!.list({ limit: 20 })
  expect(r.runs.map((x) => x.runId)).toEqual(['run-x'])
  expect(r.warnings.some((w) => w.includes('torn.json'))).toBe(true)
})

it('来源目录不可读 ⇒ unreadable 点名（≠ 空结果）', async () => {
  const r = await runSourceFromEnv({ DATA_RUN_DIRS: `gone=${join(root, 'no-such')}` })!.list({ limit: 20 })
  expect(r.runs).toEqual([])
  expect(r.unreadable[0].workspace).toBe('gone')
})

it('get：直读收据命中（即便不在 50 条窗口里）', async () => {
  const r = await runSourceFromEnv(env)!.get('run-old')
  expect(r.run).toMatchObject({ runId: 'run-old', pipelineId: 'lemeng.a', status: 'ok', durationMs: 99, source: '3120' })
  expect(r.receipt).toBeDefined()
})

it('get：收据缺席但 per-管线记录在 ⇒ 仍命中（扫描回退）', async () => {
  const r = await runSourceFromEnv(env)!.get('run-2')
  expect(r.run).toMatchObject({ runId: 'run-2', status: 'failed' })
})

it('get：两处都没有且无饱和 ⇒ absenceProven', async () => {
  const r = await runSourceFromEnv(env)!.get('run-typo')
  expect(r.run).toBeNull()
  expect(r.absenceProven).toBe(true)
})

it('get：任一文件饱和 ⇒ absenceProven=false（不说成「没跑过」）', async () => {
  const big = ws('big2', {
    'p.json': Array.from({ length: 50 }, (_, i) =>
      listEntry(`run-${i}`, `2026-10-22T00:${String(i).padStart(2, '0')}:00Z`)),
  })
  const r = await runSourceFromEnv({ DATA_RUN_DIRS: `big2=${big}` })!.get('run-typo')
  expect(r.run).toBeNull()
  expect(r.absenceProven).toBe(false)
})

it('配置畸形 ⇒ 每次调用都带 unreadable(workspace=(config))，不抛', async () => {
  for (const raw of ['3120', '3120=relative/dir', '= /x', 'a=/x,a=/y']) {
    const src = runSourceFromEnv({ DATA_RUN_DIRS: raw })!
    expect(src).not.toBeNull()
    const r = await src.list({ limit: 5 })
    expect(r.unreadable.some((u) => u.workspace === '(config)')).toBe(true)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/server test -- run-source`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `run-source.ts`**

要点（完整实现按此写）：

```ts
// run-source.ts —— 运行记录的真实来源：duckle console workspace 的 runs/ 目录（只读挂载）。
//
// 目录形状（实测 2026-10-23）：
//   <dir>/<pipeline_id>.json        数组，每管线保留 50 条（status: ok/error/interrupted/cancelled）
//   <dir>/receipts/<runId>.json     单次收据（带 nodes 明细；保留量待核实，实测 >5000）
//
// 纪律：
//   · 不抛：坏文件进 warnings，目录读不到进 unreadable——读不到 ≠ 空。
//   · 用户输入永不拼路径：pipelineId 由调用方先过 PIPELINE_ID_RE，runId 过 RUN_ID_RE 且本文件再兜一次。
//   · 同一 pipeline_id 可在多个账套各有一份 ⇒ 每条记录带 source，不合并、不判重。
export const MAX_PER_PIPELINE = 50
export const RUN_DIRS_ENV = 'DATA_RUN_DIRS'

export function runSourceFromEnv(env: Record<string, string | undefined>): PipelineRunSource | null
```

实现要点：
- `parseDirs(raw)`：`split(',')` → `name=dir`；name 匹配 `/^[A-Za-z0-9_-]+$/`，dir 必须 `/` 开头，重名/畸形记 config 错误。
- `readJson(p)`：返回 `{ok:true,value}` / `{ok:false,detail}`，**不抛**。
- `normalizeStatus(s)`：`error→failed`；`ok/running/cancelled/interrupted` 原样；其余 `unknown`。
- `recordFromListEntry(e, pipelineId, source)` / `recordFromReceipt(r, source)`：缺 `run_id`/`runId` 返回 null（计 warning）。
- `list(q)`：逐 workspace `readdirSync(dir)`；`pipelineId` 给定时只读 `<id>.json`，否则只认 `PIPELINE_ID_RE.test(stem)` 的 `.json`；解析数组；`entries.length >= MAX_PER_PIPELINE ⇒ truncatedByCap`；合并、按 `startedAt` 倒序（同刻按 runId）、`slice(0, limit)`。
- `get(runId)`：先逐 workspace 直读 `receipts/<runId>.json`（命中即回，带 `receipt`）；未命中再走一次全量 list 的内部收集（`limit: Infinity` 内部用，不暴露）找 runId；`absenceProven = unreadable.length === 0 && !truncatedByCap`。
- 配置错误时返回一个 source：`list/get` 都回 `{ ...空结果, unreadable:[{workspace:'(config)', detail}] , absenceProven:false }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @platform/server test -- run-source`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/pipelines/run-source.ts modules/data/domain/pipelines/run-source.test.ts
git commit -m "feat(data): 运行记录文件来源——runs/ 只读读源 + 饱和/不可读信号（#1001）"
```

---

## Task 3: `runs.ts` 接真来源（语义映射）

**Files:**
- Modify: `modules/data/domain/pipelines/runs.ts`
- Modify: `modules/data/domain/pipelines/runs.test.ts`

**Interfaces:**
- Consumes: `deps.runs.list/get`。
- Produces: 回包新字段 `truncated` / `incomplete` / `upstream` / `warnings`；原因新增 `runs_source_unreadable`。

语义表（**唯一**映射，写进注释）：

| 来源结果 | list 回包 | get 回包 |
|---|---|---|
| `runs===null`（未配置） | `unknown/runs_source_not_wired`（不变） | 同左 |
| `unreadable` 非空且无任何结果 | `unknown/runs_source_unreadable` + `upstream` | `unknown/runs_source_unreadable` |
| `unreadable` 非空但有结果 | `ok` + `incomplete:[ws…]` + `warnings` | 命中即 `ok`；未命中 ⇒ `unknown/runs_source_unreadable` |
| 未命中且 `absenceProven=false` | —（list 用 `truncated`） | `unknown/runs_window_saturated` |
| 未命中且 `absenceProven=true` | — | `not_found`（isError） |

- [ ] **Step 1: 改测试假源 + 新增四态用例**

把 `runs: async (q) => …` 改成 `runs: { list: async (q) => ({ runs: …, truncated: false, unreadable: [], warnings: [], scanned: … }), get: … }`；
保留所有既有断言（limit 缺省 20/硬顶 50、pipelineId fail closed、get 忽略 pipelineId、饱和 ≥ 语义），
再加：

```ts
it('list：部分来源不可读 ⇒ ok + incomplete（不假装全读通）', …)
it('list：全部不可读 ⇒ unknown/runs_source_unreadable + upstream', …)
it('list：truncated 透传', …)
it('get：runId 含路径穿越形状 ⇒ denied/bad_param/invalid_run_id，且不触来源', …)
it('get：absenceProven=false ⇒ unknown/runs_window_saturated', …)
it('get：absenceProven=true ⇒ not_found', …)
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `pnpm --filter @platform/server test -- runs`
Expected: FAIL（类型/断言不匹配）。

- [ ] **Step 3: 改 `runs.ts`**

- 顶部注释重写：从「本轮无路可达」改为「两条路都通了——只读挂载 + `DATA_RUN_DIRS`；未配置仍是 seam」。
- `runId` 加 `RUN_ID_RE` 校验（`denied('invalid_run_id')`），在调用来源**之前**。
- list 按上表映射；`auditRowCount` 保持 `runs.length`（unknown 时 `null`）。
- get 按上表映射；命中时把 `receipt` 作为 `detail` 带出（有则带）。
- `SATURATED_NOTE` 文案改为「per-管线保留 50 条，窗口已打满」措辞（不再引用「本服务不可达」）。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm --filter @platform/server test -- runs && pnpm --filter @platform/server typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/pipelines/runs.ts modules/data/domain/pipelines/runs.test.ts
git commit -m "feat(data): 运行记录工具接真来源——四态可辨，unknown 不落空（#1001）"
```

---

## Task 4: 装配与文档

**Files:**
- Modify: `modules/data/routes/mcp-pipeline-tools.ts`
- Modify: `.env.example`
- Modify: `deploy/duckle/console/README.md`（「排障入口」节补一句：平台读面的挂载口径）

- [ ] **Step 1: 装配**

```ts
// mcp-pipeline-tools.ts
import { runSourceFromEnv } from '../domain/pipelines/run-source'
export function defaultPipelineWiring(env = process.env): PipelineWiring {
  return { roots: rootsOf(env), env, runs: runSourceFromEnv(env) }
}
```

- [ ] **Step 2: `.env.example`**

```
# 运行记录只读源（#1001）：`<账套名>=<runs 目录>` 逗号分隔；目录由部署期 :ro bind mount 提供，
# 内含 <pipeline_id>.json 与 receipts/<runId>.json。不设 ⇒ 两个运行记录工具回
# unknown/runs_source_not_wired（未知 ≠ 没跑过）。取法：openship 服务 volumes，见部署 runbook。
DATA_RUN_DIRS=
```

- [ ] **Step 3: 测试 + 全量**

Run: `pnpm --filter @platform/server test && pnpm test`
Expected: 全绿（含 `test:guard` 的工具面预算检查）。

- [ ] **Step 4: Commit + PR**

```bash
git add -A && git commit -m "feat(data): 运行记录面装配 DATA_RUN_DIRS + 文档（#1001）"
git push -u origin feat/data-mcp-run-wiring
gh pr create --title "feat(data): 运行记录面接线（D-W3-3 / #1001）" --body "Closes #1001 …"
```

---

## Task 5（运维，**单独授权后执行**）：shanhai 挂载与上线

**只在 `platform-core-shanhai` 做；mytech 没有 lemeng console ⇒ `DATA_RUN_DIRS` 不设，保持 seam。**

- [ ] **Step 1: 部署代码**（squash 合并后 openship 自动部署；按 deploy-verify 规则验容器内代码 marker）。
- [ ] **Step 2: 服务挂载 + env**（openship MCP，不是裸 SSH）：
  ```
  volumes += /var/lib/docker/volumes/openship-platform-core-shanhai-data-lemeng-console-3120-ws/_data/runs:/run/duckle-runs/3120:ro
  volumes += /var/lib/docker/volumes/openship-platform-core-shanhai-data-lemeng-console-64188-ws/_data/runs:/run/duckle-runs/64188:ro
  DATA_RUN_DIRS=3120=/run/duckle-runs/3120,64188=/run/duckle-runs/64188
  ```
- [ ] **Step 3: 验证（硬证据，不看时间戳）**
  - 容器内 `ls /run/duckle-runs/3120 | head` 与宿主卷一致；
  - 调 `list_pipeline_runs`（`pipelineId=lemeng.retail.tick.l1`）回 `ok` 且记录时间对得上；
  - 调 `get_pipeline_run`（取上一步某 runId）回 `ok`；
  - 体质对照：临时把 env 指到不存在目录（或先在 staging 验）⇒ `unknown/runs_source_unreadable`，不是空。
- [ ] **Step 4: 记录**：issue #1001 评论 + WeKnora 条目（挂载口径 + 卷名不稳定风险 + 收据保留实测值）。

---

## 开放项（落地前/后必须回答）

1. **收据保留策略**：README 写 200、实测 5137/4884 ⇒ 谁是准的？影响 `get` 的「缺席可证」措辞（本计划不拿它作判据）。
2. **卷名稳定性**：`openship-<project>-<service>-ws` 由 openship 生成；项目重建会改名 ⇒ 挂载配置会指向空目录。
   上线后加一条巡检（卷存在性 + 目录内文件数骤降告警），本轮先写进 runbook。
3. **mytech 的等价物**：目前没有 lemeng console；若将来上，只需加挂载 + env，代码不动。
