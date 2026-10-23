# 数据 MCP 沙箱真执行面（#1002 / D-W3-4）实施计划

> **For agentic workers:** 本计划按序执行；架构决定已落 `docs/architecture.md` §2.8（2026-10-23 拍板）。
> 每个 Task 自带测试与提交点。

**Goal:** 让 `run_pipeline_sandbox` 真正跑 duckle 管线，而不是只回 `not_executed`。

**Architecture:** 单元 A 新增 `sandbox-console`（`duckle-runner serve`，无宿主端口）+ 共享命名卷
`sandbox-workspace`；`server` 写草案 → `POST /api/run/async` → 有界轮询 `/api/runs` → 返回结果。
**默认不带任何生产凭据**；opt-in 档（按账套只读凭据）不在本次范围（标待沉淀）。

**Tech Stack:** TypeScript / vitest / docker compose / duckle-runner 0.7.x HTTP API。

## Global Constraints

- 沙箱 **绝不** 执行 `code.*`（7 个）与 `ctl.foreach`；未知组件族默认拒绝。
- 写面仍由 `sandboxViolations` 兜底（`__sandbox/` 与 `/workspace/logs/sandbox/`）。
- `DATA_SANDBOX_URL` 未配 ⇒ 保持今天的行为（`not_executed / sandbox_runner_unconfigured`），不得回归。
- 所有新 env 键必须进根 `.env.example`（B9 门禁）；真值只进 openship env。
- 失败语义严格按 `docs/architecture.md` §2.8 的表；`verdictOf` 不改语义（`failed` 记 ok）。
- 部署需**单独授权**；本计划只做到「代码 + 本地测试 + compose」。

---

### Task 1: 沙箱组件策略（validate.ts）

**Files:** Modify `modules/data/domain/pipelines/validate.ts`、`validate.test.ts`

- 新增 `sandboxComponentViolations(doc)`：
  - 组件族 allowlist：`xf` / `src` / `snk` / `qa` / `ctl`；
  - 显式拒绝 `code.*` 全部 7 个（执行任意代码）；
  - 显式拒绝 `ctl.foreach`（它把执行委托给子管线文件，沙箱不校验子管线）；
  - 未知族（不在这五个前缀里）⇒ 拒绝（默认拒绝）。
- `runPipelineSandboxImpl` 在结构校验之后、写面断言之前调用它；违规 ⇒
  `denied / component_not_allowed` + `violations`。

**测试：** `code.shell` 与 `ctl.foreach` 各一条 ⇒ denied；`src.rest + snk.minio` ⇒ 通过；
假组件 `foo.bar` ⇒ denied。

### Task 2: 沙箱执行客户端（sandbox-runner.ts）

**Files:** Create `modules/data/domain/pipelines/sandbox-runner.ts`、`sandbox-runner.test.ts`

接口：

```ts
export interface SandboxRunnerConfig {
  baseUrl: string          // DATA_SANDBOX_URL
  token: string            // DATA_SANDBOX_TOKEN
  dir: string              // DATA_SANDBOX_DIR（server 侧共享卷路径）
  timeoutMs: number        // DATA_SANDBOX_TIMEOUT_MS，默认 120000
  intervalMs?: number      // 轮询间隔，默认 1000（测试注入小值）
}
export interface SandboxOutcome {
  status: 'ok' | 'failed' | 'running'
  runId: string            // 引擎 run 标识（= 我们写入的文件名主干）
  file: string
  durationMs?: number
  rows?: number
  error?: string
  nodes?: Record<string, unknown>
}
export interface SandboxRunner { run(draft: unknown, runId: string): Promise<SandboxOutcome> }
export function sandboxRunnerFromEnv(env: Record<string, string | undefined>): SandboxRunner | null
```

实现要点：
1. `mkdir -p <dir>/sandbox`，写 `<dir>/sandbox/<runId>.json`；
2. `POST <baseUrl>/api/run/async`，头 `Authorization: Bearer <token>`，体 `{"file":"sandbox/<runId>.json"}`；
3. 轮询 `GET <baseUrl>/api/runs`，按 `file === 'sandbox/<runId>.json'` + `at >= startedAt` 取本次条目；
   终态（非 `running`）即返回；超时 ⇒ `status: 'running'`；
4. 尽力读 `<dir>/runs/receipts/` 下 `startedAt` 之后、匹配该文件的回执，带出逐节点结果（读不到就不带，
   **不因回执缺失判失败**）；
5. 非 2xx / 网络错误向上抛 `SandboxUnreachableError`（由 impl 映射成 `unknown/sandbox_unreachable`）。

**测试（注入 fetch，不连网）：** 成功路径（异步 202 + 两次轮询 → ok）、失败路径（status=error → failed +
error 文本）、超时路径（一直 running → running）、401 → 抛。

### Task 3: 工具实现（sandbox.ts）

**Files:** Modify `modules/data/domain/pipelines/sandbox.ts`、`sandbox.test.ts`

- `PipelineDeps` 增加 `sandbox: SandboxRunner | null`（`types.ts`）。
- 顺序：结构校验 → 组件策略 → 写面断言 → 执行。
- 单飞：模块级 `inFlight` 标志；第二次调用回 `denied / sandbox_busy`（`finally` 释放）。
- runId：`sbx-<timestamp>-<random>`（只含 `[a-z0-9-]`，文件名安全）。
- 未配置 ⇒ `not_executed / sandbox_runner_unconfigured`（`checked` 字段保留）。
- 不可达 ⇒ `unknown / sandbox_unreachable`，`isError: true`。
- 结果映射：`ok` ⇒ `status ok` + `runId/durationMs/rows/nodes`；`failed` ⇒ `status failed / pipeline_failed` +
  引擎错误，`isError: true`；`running` ⇒ `status running` + `runId`，`isError: false`。

**测试：** 用假 runner 覆盖上表每一条；断言审计 verdict（`verdictOf`）。

### Task 4: 装配与 env 键

**Files:** Modify `modules/data/routes/mcp-pipeline-tools.ts`、`.env.example`、工具描述（`tools.ts` 里
`run_pipeline_sandbox` 的 `description`）

- `defaultPipelineWiring` 返回 `{ roots, env, runs, sandbox: sandboxRunnerFromEnv(env) }`；
  `depsOf` 透传。
- `.env.example` 新增：`DATA_SANDBOX_URL` / `DATA_SANDBOX_TOKEN` / `DATA_SANDBOX_DIR` /
  `DATA_SANDBOX_TIMEOUT_MS`，并写「在哪取」（openship 服务 env / isSecret）。
- 工具描述从「校验闸、不执行」改为「校验 + 在沙箱 console 真跑」，并写清默认无凭据的含义。

**测试：** `mcp-pipeline-tools.test.ts` 补 `defaultPipelineWiring` 的 sandbox 分支（未配 ⇒ null）。

### Task 5: compose 与运维文档

**Files:** Modify `deploy/docker-compose.yml`、`deploy/data-plane-deploy-sop.md`（接线一节）

- 新服务 `sandbox-console`：同 `deploy/duckle/Dockerfile`；`serve --host 0.0.0.0 --port 18090
  --workspace /workspace --duckdb /usr/local/bin/duckdb`；**无 ports**；`DUCKLE_TOKEN` 走 env；
  卷 `sandbox-workspace:/workspace`。
- `server` 增挂 `sandbox-workspace:/run/duckle-sandbox`，env `DATA_SANDBOX_DIR=/run/duckle-sandbox`。
- `volumes:` 段新增 `sandbox-workspace:`。
- SOP 补：服务在哪、token 怎么取、怎么自证（`/healthz`、`/api/pipelines`）、草案/回执放哪。

### Task 6: 部署与硬验证（**需单独授权**）

- 部署 `platform-core-shanhai`（与 mytech 视需要），硬验证：
  1. 容器内 `GET sandbox-console:18090/healthz` = 200；
  2. 容器内直调真模块跑一条**无鉴权**的最小管线（`src.csv`/构造数据 → `snk.csv`），断言 `status: ok`；
  3. 断言草案落在共享卷、回执可读；
  4. 负向：`code.shell` ⇒ denied；写正式湖 ⇒ denied；`DATA_SANDBOX_URL` 清空 ⇒ not_executed。
- 所有证据进 SDD ledger，部署后按 `deploy-verify.md` 验「新行为在线上可观测」。

## Self-review

- 与 §2.8 的差异：**组件白名单**在 v1 落成「族级 allowlist + `code.*`/`ctl.foreach` 拒绝」，
  不是逐条 417 项评审 —— 这一点已写进 `validate.ts` 注释与本文档，属**有意收窄**，不得在实现中
  悄悄扩成「全放行」。
- `DATA_SANDBOX_*` 四键都进 `.env.example`，无遗漏。
