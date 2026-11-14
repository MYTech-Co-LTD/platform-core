# 指标下线提案（使用统计 → 变更单）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 候选池项「使用统计→下线候选接评审」：零使用的租户 L2 指标由 job 自动提** delete 档变更单**（agent 只提案），人在待核对页决定采纳/驳回——下线永远经人手。

**Architecture:** 读面已存在（`domain/metric-usage.ts` 的 `retireCandidatesOf`：L2 + 窗口 0 次，L1 永不）。本波加三样：① delete 档 payload 允许可选 `reason`（执行器忽略、人面展示）；② `domain/metric-retire.ts`（候选安全过滤 + 提单）；③ `scripts/metric-retire-job.mjs`（定时驱动，照 `metric-candidates-job.mjs` 形态）。

**Tech Stack:** TypeScript / pg / zod / vitest。不新增依赖。

## Global Constraints

- **job 只提案不删行**：生效唯一路径仍是人采纳（会话 + data:manage）。job 的提交身份 = `{userId: 'metric-retire-job', channel: 'job'}`。
- **安全过滤四条（缺一不提单）**：仅 L2；窗口 0 次（读面已筛）；**行龄** ≥ 窗口（`updated_at` 早于 now−days——新采纳/新改的口径给满一个窗口）；**不被任何报表引用**（草稿 `data.reports.spec` 与已发布快照 `report_versions.spec` 都查，面板 `metricId` + KPI `denominatorMetricId`）。
- 已有未决单 ⇒ 跳过（`metric_change_one_pending_uq` 兜底，job 侧先查再提，避免无谓 409）。
- 窗口默认 90 天（env `METRIC_RETIRE_DAYS` / `--days` 覆盖）；**0 候选不是失败**；orgs=0 要可见。
- 退出码 0/1/2 照 job 惯例（2=缺 env/查不成账；1=有 org 失败）。
- 测试隔离 `org-retire-*`；真库用例自建夹具、空库可绿；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- Conventional Commits；feat 挂 issue。**job 不自动建**（openship job 由人点名，文档给命令）。

## File Structure

| 文件 | 职责 |
|---|---|
| `domain/metric-change.ts` | delete 档 payload 允许 `{reason?}`（strict，超长 400） |
| `domain/metric-retire.ts`（新） | 候选安全过滤 + `submitRetireProposals` |
| `scripts/metric-retire-job.mjs`（新） | org 枚举 + 逐 org 提单 + 汇总 |
| `console/changes/index.tsx` | delete 单默认层展示 `payload.reason` |
| `deploy/metric-retire-job.md`（新） | job 文档（cron/命令/判据） |

---

### Task 1: delete 档 reason + 安全过滤 + 提单（域层）

**Files:** Modify `domain/metric-change.ts`（DeletePayload zod）；Create `domain/metric-retire.ts` + `.test.ts`。

**语义：**
1. `DeletePayload = z.object({ reason: z.string().min(1).max(500).optional() }).strict()`——delete 档 payload 为空对象或只含 reason；其余键仍 400。执行器不读 reason（`deleteMetricDeclaration` 不变）。
2. `retireEligibleOf(pool, org, days)`：读面 `retireCandidatesOf` + 行龄（`data.metrics.updated_at < now()-days`，取 org 桶行）+ 报表引用排除（JS 侧走 `spec.panels`：`metricId` 与 `denominatorMetricId`；数据源 = `select spec from data.reports where org=$1` ∪ `select spec from data.report_versions where org=$1`）+ 已有未决单排除（`data.metric_change` org+metric_id+pending）。返回候选清单（带 title/lastUsedAt/referenced=false）。
3. `submitRetireProposals(pool, org, days, submitter)`：对每候选 `submitChange(..., 'delete', { reason: '连续 N 天 0 次使用（报表引用已排除）' })`；返回 `{proposed, skipped, failed}`。**不跑试算**（delete 档试算 = 删前口径快照，P0 已有；job 提单走 submitChange 即可，试算由提交路径自动跑——delete 档试算读当前行，行为正确）。

**测试（真库，自建夹具）**：四条安全过滤各自一正一反（L2 零用+够龄+无引用+无未决 ⇒ 提单；被报表引用 ⇒ 跳过；窗口内有使用 ⇒ 跳过；行太新 ⇒ 跳过）；L1 行永不进候选；重复跑 ⇒ 第二次 proposed=0；delete payload 带 reason 落单且采纳后行被删（reason 不阻断执行）。

- [ ] TDD RED→GREEN→Commit `feat(data): 下线提案域层——安全过滤+delete 档 reason（指标治理尾波）`。

---

### Task 2: job 脚本 + console 展示 + 文档

**Files:** Create `scripts/metric-retire-job.mjs` + `deploy/metric-retire-job.md`；Modify `console/changes/index.tsx` + `changes/index.test.tsx`。

1. 脚本照 `metric-candidates-job.mjs`：`import { submitRetireProposals, retireOrgs } from '../modules/data/domain/metric-retire.ts'`；`retireOrgs(pool)` = `select distinct org from data.metrics where source='l2'`；days 取 `--days` 或 `METRIC_RETIRE_DAYS` 或 90；逐 org 提单打一行汇总；退出码 0/1/2。`node --check` + 空库 dry-run（记录输出）。
2. console 待核对：kind=delete 且 `payload.reason` 存在 ⇒ 默认层加一行引用文案（`提议原因：{reason}`）；无 reason 不渲染。测试一条。
3. `deploy/metric-retire-job.md`：cron 建议（周一次即可，如 `23 3 * * 1`）、openship MCP 建 job 命令体（照 notify-jobs 形态）、成功/失败判据、「0 候选正常」「orgs=0 要查」。

- [ ] TDD/验证→Commit `feat(data): 下线提案 job+待核对展示原因+文档（指标治理尾波）`。

---

### Task 3: 终审 + PR + 部署 + 台账

1. 终审（opus，整分支）：安全过滤完备性（还有没有绕过面——例如移动端/独立页引用、AI 文本面板）、job 幂等与并提、reason 是否会进执行路径。
2. 全量 + CI + PR + 部署 + 容器核验（脚本在位、`node --check`、真库 dry-run exit 0）。
3. 台账：候选池该项销账；**job 建不建由你点名**。

---

## Self-Review

- **候选池覆盖**：「使用统计→下线候选接评审」全链落地（读面→安全过滤→提案→人决策）。
- **不做**：自动删除（永不）；L1 下线（永不）；「声明类对账证据接入采纳」（候选池另一项，另议——它需要先定义「对账证据」对租户声明意味着什么，属产品决策）。
- **风险**：报表引用排除若漏形态（如 AI 文本面板引用指标）会把在用指标提删——人在采纳侧可驳回，但过滤面要尽量全；终审专项核。
