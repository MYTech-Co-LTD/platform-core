# 指标语义治理 P6（证据与治理收口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收掉 P1–P5 台账里攒下的治理缺口：①发布门的「判不了」要能被巡检判红（门结果分类）；②提交期就把 `NOT_METRIC_CREATOR` 拦掉（不再「绿单死采纳」）；③试算限速覆盖提交路径；④`reveal` 有写入面（别名档 + 变更单 payload）；⑤回滚与门/ACL 变更后重跑发布门。

**Architecture:** 全部是**收口**，不加新概念：门结果从 `string[] warnings` 升级为带类别的 issue；creator 预检下沉到 `submitChange` 的 precheck（P4 已有该形态）；限速谓词已有（P4），把它复用到提交；`reveal` 是 P1 已建的列，只补写入；rollback/ACL/dept-gate 变更处调用既有 `reportScopeViolations`。

**Tech Stack:** TypeScript / Hono / pg / vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §9（门/渲染闸/巡检）、§7（决策）、§18 P6。

## Global Constraints

- **不新造判定**：creator 预检复用域层同一判据（`created_by` 语义）；门重跑复用 `reportScopeViolations`；`reveal` 校验复用列 CHECK。
- 门的「判不了」（目录缺失）从 `warnings: string[]` 改为 `issues: Array<{reason, panelIndex, metricId?}>`；**巡检按 issue 判红**，但**发布不因 unknown 而阻断**（保持 P5 语义：发布放行、渲染 fail-closed、巡检告警）。
- 迁移编号：**下一可用号 049**（048 已撞号，本波只用 049 且一次用尽）。
- 测试隔离 `org-p6-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`；**新增真库用例必须自建夹具且空库可绿**（P5 的两次假绿教训）。
- Conventional Commits；feat/fix 挂 issue。

## File Structure

| 文件 | 职责 |
|---|---|
| `domain/report-scope-gate.ts` | 门结果分类（issues） |
| `scripts/report-scope-scan.mjs` | 判红判据改按 issues |
| `domain/metric-change.ts` | creator 预检 + reveal 档 + 提交限速 |
| `domain/metric-change-preview.ts` / `routes/metric-changes.ts` | 限速谓词复用 |
| `domain/report-version.ts` / `routes/reports.ts` | rollback 与 ACL/dept-gate 变更后重跑门 |
| `migrations/049_*.sql` | `reveal` 写入所需（若无 schema 变更则空） |

---

### Task 1: 门结果分类 + 巡检判红

**Files:** Modify `domain/report-scope-gate.ts`、`scripts/report-scope-scan.mjs`、`deploy/report-scope-scan-job.md` + 测试。

**语义：**
1. `reportScopeViolations` 返回 `{ panels: [...], issues: Array<{ reason: 'metric_unknown' | 'audience_unbounded' | ..., panelIndex, metricId? }> }`——把 P5 里「目录缺失只发 warning」的形态显式成 `issues`（判不了 ≠ 干净）。
2. 巡检：`violations` 与 `issues` **都判红**（exit 1），输出分两段（`✗ [violation]` / `⚠ [issue]`），文档同步改回「有漂移就 exit 1」。
3. 发布行为**不变**：门的 issue 不参与 409 判定；`scopeIssues` 是**失败路径（400/409）的诊断字段**（200 仅目录竞态可能出现）。

- [x] 失败测试：目录缺失 ⇒ 发布路径 400 且回包带 scopeIssues（诊断位）；巡检读已发布快照仍能判红 `[issue]`；干净报表 exit 0。
- [ ] RED → GREEN → Commit `feat(data): 发布门结果分类+巡检按 issue 判红（P6 Task 1）`。

---

### Task 2: creator 判据落在**采纳期**（采纳即授权）

**Files:** Modify `domain/metric-write.ts` + 测试（`domain/metric-change.ts` 的 `precheckOf` **不**判 creator）。

**语义（实现的模型）：** 采纳期写域判 **`creator ∪ data:manage`**（采纳即授权）——目标行是 L2 且
`created_by` 既非采纳人、采纳人又不持 `data:manage` ⇒ `403 NOT_METRIC_CREATOR`，写入不落；
`created_by` 为 NULL 的存量行 fail-closed，但持 manage 放行（否则孤儿行没人能修）。
create 不判（行不存在 = 谁建谁就是 creator）。

**⚠️ 提交期不判 creator（已撤回「提交期 creator 预检」，见 `bb3da0dd`）**：提交人 ≠ 采纳人
（agent 提案、人决策），真正决定写入的是**采纳人**；提交期按提交人预判必然错位（agent 的 PAT
无 manage、人采纳有 manage），且它**预测不了采纳结果**——只会把合法提案拦死在队列外。
别再「好心恢复」成提交期预检；要收紧只能在采纳期收。

- [x] 失败测试：采纳他人 L2 的 update/delete/meta ⇒ 403 `NOT_METRIC_CREATOR` 且写入不落；本人 ⇒ 通过；持 `data:manage` 的采纳人 ⇒ 通过。
- [x] RED → GREEN → Commit（`feat(data): 提交期 creator 预检` → 修复轮 `bb3da0dd` 撤回并改为采纳期 `creator ∪ data:manage`）。

---

### Task 3: 试算限速覆盖提交路径

**Files:** Modify `routes/metric-changes.ts`、`routes/mcp-metric-tools.ts` + 测试。

**语义：** 同一 org 下「提交即试算」也受限速：60s 内同 metricId 已有一张刚落单的试算 ⇒ 提交仍落单但**跳过试算**（单保持 draft，回包 `previewSkipped: 'rate_limited'`），避免 agent 反复提交烧仓库算力；不拒绝提交（提交本身是合法业务动作）。

- [ ] 失败测试：60s 内同 metricId 二次提交 ⇒ draft + previewSkipped；61s 后同 metricId ⇒ 正常试算；不同 metricId 不受限。
- [ ] RED → GREEN → Commit `feat(data): 提交试算限速（P6 Task 3）`。

---

### Task 4: reveal 写入面（变更单 payload）

**Files:** Modify `domain/metric-change.ts`（payload 允许 `reveal`）、`domain/metric-write.ts`（透传）、`migrations/049`（若需） + 测试。

**语义：** create/update/override/declaration 的 payload 可带 `reveal: 'panel' | 'report'`，采纳时落列；默认 `panel`。校验走列 CHECK。文档：哪些指标该用 `report`（成本/毛利/工资类）写进 `docs/architecture.md` §2 数据模块行注或 spec §9.3。

- [ ] 失败测试：payload 带 reveal=report ⇒ 采纳后列值 report；非法值 ⇒ 400；不传 ⇒ panel。
- [ ] RED → GREEN → Commit `feat(data): reveal 写入面——变更单 payload（P6 Task 4）`。

---

### Task 5: 回滚与门/ACL 变更后重跑发布门

**Files:** Modify `domain/report-version.ts`（`rollbackVersion`）、`routes/reports.ts`（`PUT /reports/:id/acl`、`PUT /reports/:id/dept-gate`）+ 测试。

**语义：** 三处在写入前调用 `reportScopeViolations`；违规 ⇒ `409 REPORT_METRIC_SCOPE_MISMATCH`（与发布门同码同形）。ACL 收窄/扩宽都可能造成不匹配，一律重判（宁可拒，让人显式处理）。

- [ ] 失败测试：回滚到旧快照但当前受众已漂移 ⇒ 409；ACL 加兄弟部门 viewer 而面板指标归属财务 ⇒ 409；合法变更 ⇒ 通过。
- [ ] RED → GREEN → Commit `feat(data): 回滚与门/ACL 变更重跑发布门（P6 Task 5）`。

---

### Task 6: 终审 + 部署 + 台账

1. 终审（opus）：跨任务接缝——issues 分类是否让巡检真能判红、creator 预检是否误伤候选/私有测度、限速是否误伤合法重提、reveal 写入是否绕过校验、门重跑是否与发布门同码。
2. 全量 + CI + PR + 部署 + 容器核验（脚本/门/谜 reveal 列）。
3. 台账：P6 入账并**清空 Wave 5 待办**；把「Metabase 无 metricIds 字段」单独列为**已知能力缺口（无动作，待产品需求）**。

---

## Self-Review

- **Spec 覆盖**：§9 门/巡检（T1/T5）、§7 决策（T2）、§9.3 reveal（T4）；P4/P5 缓办（creator、限速）T2/T3。
- **不做**：Metabase 整表判定（缺 metricIds 字段，需产品先声明）；迁移撞号回填（048 已上线，不动历史）；列级血缘（触发式）。
- **风险**：T2 可能误伤「候选采用建私有测度」路径——采用是 `writePrivateMeasure`，不经 `submitChange`，测试要钉住；T3 的「跳过试算」让单据停在 draft，人面需能「跑试算」补（P0 已有按钮）——确认 console 文案仍自洽。
