# 指标语义治理 P4（写面收口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `customize_metric` / `delete_custom_metric` 不再直接写生效行（改落变更单，P0 已建）；console 指标页删掉全部人面写入口（编辑/元数据/删除/覆盖口径创建）；回滚开关 `DATA_METRIC_REVIEW_MODE` 护一个发布周期；顺带销三笔缓办。

**Architecture:** 取证（2026-11-13）：agent 写面两把工具在 `mcp-metric-tools.ts:187-210` 直调 `writeL2Declaration`/`deleteMetricDeclaration`；console 指标页剩四个写入口（编辑:305/元数据:306/删除:307/覆盖口径:638）+ 覆盖清单的确认/删除按钮（W8 流，**保留**——见取舍）；REST 直写端点 11 条。P0 的变更单已支持 create/update/meta/delete/override 五档全链（P1 Task 7 接通 override）——**本波只是把旧脸切到新通路并拆旧脸**。

**Tech Stack:** TypeScript / Hono / vitest。不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §11（工具表：customize_metric 语义改为提交变更单）/ §12（人面收口）/ §14（回滚开关，只保留一个发布周期）。

## Global Constraints

- **域层写函数不动**（`writeL2Declaration`/`updateMetricMeta`/`deleteMetricDeclaration`/`createOverrideDeclaration`）——它们是 adoptChange 的执行层，删的是**脸**不是引擎。
- 回滚开关 `DATA_METRIC_REVIEW_MODE`：缺省 `on`（落变更单）；`off` ⇒ 工具走旧直写路径（应急回滚，一个发布周期后删）。console 人面入口**不设开关**（删了就是删了——回滚靠重新部署旧镜像）。
- **W8 覆盖确认流保留**（spec P0 定案：采纳=建覆盖草稿，确认启用走既有 confirm——两步都是人的决策动作，不是实现）。
- 工具面预算：删/改描述后**跑门禁实测**，释放的余量顺手补 search_catalog 投影词（P3 缓办①）。
- 测试隔离 `org-p4-wf-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- 装载期双向核对（manifest 与路由同提交对齐）；Conventional Commits；feat/fix 挂 issue。

## File Structure

| 文件 | 职责 |
|---|---|
| `routes/mcp-metric-tools.ts` | customize/delete 两工具改落变更单 + 开关 + 描述更新 |
| `console/metrics/index.tsx` (+test) | 删四个写入口与相关弹窗/状态 |
| `manifest.yaml` | 删 REST 直写端点声明（与路由同提交） |
| `routes/metrics.ts` (+test) | 删对应路由处理器（保留读面/草稿流/认证/W8 confirm/usage/audit） |
| `domain/metric-change.ts` | preview 重跑限速（缓办②） |
| `domain/notify 或 adopt 路径` | eventId 拼变更单 id（缓办③） |

---

### Task 1: MCP 两把写工具切到变更单 + 回滚开关

**Files:** Modify `routes/mcp-metric-tools.ts` + `mcp-manage.test.ts` + `mcp-manage-face.ts`（描述）。

**语义：**
1. `customize_metric`：`DATA_METRIC_REVIEW_MODE !== 'off'`（缺省）⇒ 走 `submitChange(kind = 已有 id 且非 override ? 'update' : 'create')` + 提交即试算（照 P0 Task 7 修复轮的 MCP 内嵌形态——复用 `submit_metric_change` 分支已有的试算段，抽公共小函数避免复制）+ 回 `{status:'ok', changeId, state}`；`off` ⇒ 旧直写路径原样保留（注释标「应急回滚，一个发布周期后删」）。
2. `delete_custom_metric` 同款：on ⇒ `submitChange(kind:'delete')`；off ⇒ 旧路径。
3. **描述更新**（预算操作）：两把工具的 description 改写为「提案版」语义——「提交指标变更提案（**不直接生效**，等待人工采纳；状态与驳回原因见 list_metric_changes）」+ 各自入参一句话。**删**旧描述里重复的入参细节（refine/expr 双档说明——入参 schema 自描述，正文可短）。改完跑 `check-mcp-toolface` 实测字节数并记录；若净释放 ≥ 40B，**顺手把 search_catalog 描述补上 dept/variantNote/ambiguous 投影词**（P3 缓办①，同 commit）。
4. 测试：on 模式——customize_metric 落单（preview_ready/preview_failed）且 `data.metrics` 无新行；off 模式——直写生效（env 注入）；list_metric_changes 能看到这两把工具落的单。

- [ ] 失败测试 → 实现 → GREEN → 门禁实测字节（写进报告）→ Commit `feat(data): 写工具落变更单+回滚开关（P4 Task 1）`。

---

### Task 2: console 指标页删人面写入口

**Files:** Modify `console/metrics/index.tsx` + `index.test.tsx`。

**删**：行内「编辑/元数据/删除指标」三动作（:305-307）+ 编辑 Card（:498 起）+ 元数据弹窗 + confirmRemove + L1 行「覆盖口径」入口（:638）+ 相关 state/handler（draft/metaDraft/openEdit/openMeta/submit/remove）。
**保留**：只读表格与详情抽屉、变更历史、使用统计、认证升降（治理决策——spec §10.4 D7 管理员动作，且「采纳即生效 certified=draft、升级走这里」正是两步决策的后半步）、W8 覆盖清单的「确认启用/删除覆盖」（两步决策流的确认步）、草稿流端点按钮（若页面上有 confirm-draft 入口——**检查**：草稿现在只能由变更单采纳产生，页面上若有「草稿→确认」按钮则保留，它是采纳后的生效动作）。
**文案**：删入口后，指标页顶部说明改为「指标变更一律由 agent 提案（企微/MCP），在这里的『待核对』页采纳」。
**测试**：删除的入口 `queryByText` 为 null（编辑/元数据/删除/覆盖口径四词的动作按钮不再存在——注意「编辑」可能出现在别处如「编辑草稿」文案，断言按按钮 role+name 精确匹配）；保留的按钮仍在（认证/确认启用/删除覆盖）。

- [ ] 失败测试 → 实现 → GREEN → Commit `feat(data): console 指标页删全部人面写入口（P4 Task 2）`。

---

### Task 3: REST 直写端点退役（开关同款）

**Files:** Modify `routes/metrics.ts` + `manifest.yaml` + `metrics.test.ts`。

**退役**（`DATA_METRIC_REVIEW_MODE !== 'off'` ⇒ **410 GONE**（带 `{error:'USE_METRIC_CHANGES', changeEndpoint:'/metric-changes'}` 指路文案）；`off` ⇒ 原行为）：
- `POST /metrics`、`PUT /metrics/:id`、`DELETE /metrics/:id`、`PUT /metrics/:id/meta`、`POST /metrics/:id/override`
- **保留**（读面或决策流）：GET 全家、`POST /metrics/:id/override/confirm`、`DELETE /metrics/:id/override`（W8 确认流）、draft/confirm-draft（采纳后续流）、`PUT /metrics/:id/certified`（治理决策）、declarations/private/candidates/verified/usage/audit 按现状。
- **为什么 410 不删**：一个发布周期后（下波）真删；现在 410+指路让旧调用方（若有脚本/agent 缓存）拿到可读迁移信号而不是 404 猜。manifest 声明**保留**（路由还在，只是行为变了——双向核对不破）。
- 测试：on 模式五端点 410 + 指路体；off 模式原行为一条代表（POST /metrics 落行）；confirm/certified 不受影响。

- [ ] 失败测试 → 实现 → GREEN → `check-manifests` → Commit `feat(data): REST 直写端点 410 退役+开关（P4 Task 3）`。

---

### Task 4: 顺带销两笔缓办（限速 + eventId）

1. **preview 重跑限速（P0 缓办）**：`domain/metric-change-preview.ts` `applyPreview` 或路由 preview 端点——同单 60s 内重跑 ⇒ 409 `PREVIEW_RATE_LIMITED`（判 `preview->>'ranAt'` 距今 <60s）。测试：连打两次第二次 409；61s 后（注入时钟或直接改 ranAt）可重跑。
2. **notify eventId 拼变更单 id（P1 缓办⑤）**：adopt 的 eventId 从 `...:{metricId}:{version}` 改为 `...:{metricId}:{changeId}`——同 metricId 重建不再被 event 去重吞（P1 终审实证的缺陷）。测试：同 metricId 一删一建两单 ⇒ 两条 event 都在。
3. **preview_failed 回包带 issues（P1 缓办⑥）**：`applyPreview` 失败分支已存 `{error, ranAt}`——`runPreview` 的 DECLARATION_INVALID 类失败把 `issues` 数组一并存进 preview（`compileOverrideDeclaration` 等编译函数的返回里已有）。测试：override 档坏声明 ⇒ preview.error 带 issues。

**Files:** `domain/metric-change-preview.ts` / `routes/metric-changes.ts`（eventId）/ 对应测试。

- [ ] 失败测试 → 实现 → GREEN → Commit `feat(data): preview 限速+eventId 拼单号+失败带明细（P4 Task 4，销缓办三笔）`。

---

### Task 5: 终审 + 部署 + 台账

1. 终审（opus，整分支）：跨面接缝——两把工具 on/off 两态的返回形状、410 端点与 manifest 双向核对、console 删入口后「待核对」是唯一写通路（grep 无残留写调用）、预算实测数字、开关默认值与文档（spec §14 语义）。
2. 全量本地 + CI 全绿 + PR（Closes issue）+ shanhai 部署。
3. 容器核验：两工具落单不落行（可验 `data.metric_change` 计数与 `data.metrics` 计数）、410 指路、指标页产物无「编辑/元数据/删除指标/覆盖口径」动作（grep 产物）、guide 5 条不变。
4. 台账：P4 行入已完成；缓办清单对账（P3①若 Task 1 释放预算则已销；P0 限速、P1⑤⑥已销；**更新待办表**——P4 后剩余缓办应只有 P2 的策略类）。

---

## Self-Review

- **Spec 覆盖**：§11 工具表（customize_metric 语义改提交——Task 1；采纳/驳回不提供工具——P0 已成立）；§12 人面收口（Task 2/3）；§14 回滚开关一个发布周期（Task 1/3 的 off 路径 + 下波删除注记）。
- **取舍**：REST 用 410+指路而非直接删（迁移信号 + 双向核对不破 + 一个周期后删）；认证升降与 W8 confirm 保留（决策动作非实现动作——spec 两步决策流）；console 不设开关（回滚=redeploy）。
- **不做**：report 工具 mutating 不对称（P1 缓办④——涉 DATA_MCP_ALLOW_MUTATING 总闸语义，单独立裁决）；org-tree 逃逸类判据（spec 变更）；regressionRequester 策略（同前）。
