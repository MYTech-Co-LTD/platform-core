# 指标语义治理 P5（报表 × 指标 + 恢复 declaration 档）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 把 P4 退役掉的「新建全额租户声明」通过变更单 `declaration` 档还回来；② 报表受众不得宽于其面板指标的可见范围（发布门硬阻断）；③ 渲染时逐面板 fail-closed（`reveal='report'` 整表 404，防差额反推）；④ 每日一致性巡检。

**Architecture:** 取证（2026-11-13）：发布入口 `routes/reports.ts:916`（`POST /reports/:id/publish`，已过 `denyUnlessCanEdit`）；可见性判定已收口在 `domain/asset-auth.ts` 的 `canViewAsset`/`canViewVersionedContent`（ACL→visibility→旧粗门）；面板→指标投影已在 `report-store`（`spec.panels[].metricId`，`metricIds` 上到行）。指标侧可见性判定已存在：`metricVisibleWithDept` + `loadDeptContext`（P2）。P5 = **把两侧已有判定组合成两道闸**，不新造判定。

**Tech Stack:** TypeScript / Hono / pg / vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §9（发布门/渲染闸/reveal/Metabase 整表级）、§5.2（kind 列表含 override）、§18（P5）。

## Global Constraints

- **单一判定**：指标可见性只经 `metricVisibleWithDept` + `loadDeptContext`；报表可见性只经 `canViewAsset`/`canViewVersionedContent`。本波只做组合与阈值，不写第二份。
- 发布门是**硬阻断**（409），不是警告；渲染闸是**面板级降级**（不给数、不给 0），`reveal='report'` 则整表 404。
- Metabase 报表**做不到面板级**（平台不知其内部字段）：只能整表级——受众必须 ⊆ 声明 `metricIds` 的可见范围交集，否则拒发布。
- 变更单仍只经人采纳生效；`declaration` 档同样走「提交→试算→采纳」。
- 测试隔离 `org-p5-rp-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- 装载期双向核对；Conventional Commits；feat/fix 挂 issue。

## File Structure

| 文件 | 职责 |
|---|---|
| `domain/metric-change.ts` + `domain/tenant-declaration-write.ts` | `declaration` 档：提交/试算/采纳（复用 createTenantDeclaration） |
| `domain/report-scope-gate.ts`（新） | 发布门：受众 ⊆ 面板指标可见范围；差值报告 |
| `routes/reports.ts` | publish 挂钩；published-spec/render 的 reveal 判定 |
| `domain/asset-auth.ts` | 不改判定，只加 `reveal` 整表拒的组合函数 |
| `scripts/report-scope-scan.mjs`（新） | 每日一致性巡检 |

---

### Task 1: 恢复 declaration 档（能力归还）

**Files:** Modify `domain/metric-change.ts`（ChangeKind +'declaration'）、`domain/metric-change-preview.ts`（该档试算）、`routes/metric-changes.ts`（zod enum）、`routes/mcp-metric-tools.ts`（SubmitArgs enum）+ 测试。

**语义：**
1. `ChangeKind` 增 `'declaration'`（P4 表已备五值含 override；**需迁移 add check 值**——检查 046 的 kind CHECK 是否含 'declaration'，不含则 048 迁移扩值）。
2. submit：payload = W8 declaration entry（宽校验：name/label/definition/expression/grain 必填、name 不与 L1 撞）；metricId = entry.name。
3. 预检沿用 `submitChange` 现有 precheck 顺序 + 该档特有：`name` 撞 L1 ⇒ 400 `ID_RESERVED_BY_L1`（域层同码）。
4. 试算：复用 `compileTenantDeclaration`（与写路径同一函数，P1 Task 7 已导出 compileOverrideDeclaration；本任务需确认 declaration 编译入口是否同款导出，没有则导出，**不复制**）→ 只读求值；baseline 无（新声明无基底）。
5. 采纳：调用 `createTenantDeclaration({pool, warehouse?}, org, requester, payload)`（既有唯一写路径）；成功 ⇒ CAS adopted。
6. MCP `submit_metric_change` 与 REST 提交面的 kind 枚举同步加 `declaration`。

- [ ] 失败测试：提交合法声明 ⇒ preview_ready；采纳 ⇒ `data.metrics` 出现 `basis='declared'` 行且 `declaration` 列有值；坏声明 ⇒ 400 提交期或 preview_failed 带 issues；撞 L1 名 ⇒ 400。
- [ ] RED → 实现 → GREEN → Commit `feat(data): 变更单恢复 declaration 档（P5 Task 1，能力归还）`。

---

### Task 2: 发布门（受众 ⊆ 面板指标可见范围）

**Files:** Create `domain/report-scope-gate.ts` + `.test.ts`；Modify `routes/reports.ts` publish handler（`denyUnlessCanEdit` 之后、任何发布写入之前）。

**Interfaces:** `reportScopeViolations(deps): Promise<{ panels: Array<{ index:number; metricId:string; missingDepts?:string[]; reason:string }> } | null>`——null = 通过。

**判据：**
- 取报表行（`required_scope`/`required_depts`）+ ACL ⇒ **受众集合**（scope 码集 + dept 集 + viewer 主体）。
- 取 `spec.panels` 的 metricIds ⇒ 每个指标的 `ownerDept` 与 `visibleDepts`；用 `loadDeptContext` 的**逆运算**不现实——改为规则式判定：若指标 `owner_dept` 非空，则受众里的每个 dept 必须 ∈（归属部门链∪visible_depts）；受众里的 scope 视作全局（不带来部门）。`reveal='report'` 的指标额外要求受众⊆可见范围（同式）。
- 违规 ⇒ publish 返回 **409 `REPORT_METRIC_SCOPE_MISMATCH`** + `{panels:[...]}`。
- Metabase 行：`metricIds` 为空 ⇒ **跳过**（无法判定，记 warning 到回包 `warnings`），非空 ⇒ 同式整表判定。

- [ ] 失败测试：受众含兄弟部门 + 面板指标归属财务 ⇒ 409 且指名；受众=同部门 ⇒ 通过；平台指标（owner_dept null）⇒ 恒通过；Metabase metricIds 空 ⇒ 通过+warning。
- [ ] RED → 实现 → GREEN → Commit `feat(data): 报表发布门——受众⊆面板指标可见范围（P5 Task 2）`。

---

### Task 3: 渲染闸 + reveal

**Files:** Modify `routes/reports.ts`（`GET /reports/:id/published-spec` 与独立页取 spec 处）+ `domain/asset-auth.ts`（新增组合函数）+ 测试。

**语义：**
1. 观看者已过 `canViewVersionedContent` ⇒ 再逐面板判指标可见性（复用 P2 的 `metricVisibleWithDept` + `loadDeptContext`）；不可见面板 ⇒ 在回包的 spec 里把该面板替换为 `{ index, denied: true }`（**不带数据字段**），并计 `deniedPanels`。
2. 任一被拒面板的指标 `reveal === 'report'` ⇒ **整体 404**（防「总数−其他」反推）。
3. 平台自绘渲染器据 `denied: true` 显示「无此口径权限」（console 侧一行）。
4. 审计：denial 记一次（沿用 reports 既有 audit 或新增 `report.panel_denied` 行——取证既有审计表后决定，勿新造表）。

- [ ] 失败测试：面板指标不可见 ⇒ spec 里 denied:true 且无数据字段、其余面板正常；reveal=report 且不可见 ⇒ 404；全部可见 ⇒ spec 逐字节等于今日（回归锁）。
- [ ] RED → 实现 → GREEN → Commit `feat(data): 报表渲染闸——面板级降级+reveal 整表拒（P5 Task 3）`。

---

### Task 4: 每日一致性巡检

**Files:** Create `scripts/report-scope-scan.mjs` + `deploy/report-scope-scan-job.md`。

- 拉全部已发布报表 ⇒ 复用 Task 2 的 `reportScopeViolations` ⇒ 有违规打印清单并 exit 1（供 openship job 告警）。
- job 文档照 `deploy/notify-jobs.md` 范式写（cron、MCP 建 job 步骤、判据）；**不自动建 job**（建 job 属运维动作，交付时说清让用户点名）。
- [ ] 脚本本地 dry-run（对本地库）+ 单测（违规/干净两态）→ Commit `feat(data): 报表受众漂移巡检脚本（P5 Task 4）`。

---

### Task 5: 终审 + 部署 + 台账

1. 终审（opus）：跨面接缝——发布门与渲染闸的判定是否同源、reveal 反推论证、declaration 档与既有 W8 confirm 的语义关系（采纳=建草稿 or 直接生效？本计划取**直接生效**并与 spec 对齐，终审须确认无二义）、Metabase 跳过是否留洞。
2. 全量 + CI + PR + 部署。
3. 容器核验：declaration 档经 MCP/ HTTP 可提交（401 证明路由在）；发布门代码在位；巡检脚本可跑。
4. 台账：P5 入账；**销 P4 的能力退役条目**；缓办清单更新。

---

## Self-Review

- **Spec 覆盖**：§9 发布门（T2）、渲染闸（T3）、reveal 两档（T3）、Metabase 整表级（T2 的 metricIds 规则）、每日巡检（T4）；§5.2 kind 表（T1 补 declaration，kind 集变六值——需迁移扩 CHECK）。
- **取舍**：declaration 采纳直接生效（不经 draft）——与 create/update 档一致；Metabase 无 metricIds 时跳过并告警（无法判定，不假装通过也不误杀）。
- **不做**：列级血缘（触发式）；P6 的对账证据接入延后。
