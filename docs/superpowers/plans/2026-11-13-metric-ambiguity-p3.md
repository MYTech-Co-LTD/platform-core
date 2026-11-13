# 指标语义治理 P3（解析与澄清）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同名多候选时 agent 必须澄清而不是猜；每条数字答案自带「按哪个口径」（caliber：id/标题/部门/差异说明）。

**Architecture:** 取证结论（2026-11-13）：`searchImpl`（discovery.ts:63-102）已有匹配强度排序（精确 4 > 标题/同义词 3 > id 2 > 说明 1）但**无 tie 检测**——同名同分按 id 字典序静默取先；`buildEnvelope`（envelope.ts）已有 `metric` 段（id/version/definitionHash/tier/caliber/basis/owner/title）——P3 在此段补 dept/variantNote 而非新开段；硬约束分发的唯一事实源是 `skill/content/shared.md`（恰好 4 行「· 」前缀，render.ts:21-30 逐行读取且行数不符即炸），SKILL.md 由 `pnpm run gen:skill` 构建期生成不入库。

**Tech Stack:** TypeScript / vitest。不新增运行时依赖。**工具面预算余量仅 192B（10048/10240）——本波不得给任何工具描述加字。**

**Spec:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §10。

## Global Constraints

- 澄清规则（spec §10）：可见集合内唯一 → 直接用并标注口径；多候选**同分且 title/同义词归一后同名** → `ambiguous:true` + 候选清单；零候选 → 如实说没有。
- caliber 只从**已有数据**投影（id/title/ownerDept/variantNote），不新算不猜测。
- shared.md 4→5 行时**必须同步** render.ts 的行数断言（4→5）与 render.test 快照。
- 测试隔离 `org-p3-amb-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- 装载期双向核对、Conventional Commits、feat/fix 挂 issue。

## File Structure

| 文件 | 职责 |
|---|---|
| `domain/toolbox/discovery.ts` | tie 检测 + results 投影扩 dept/variantNote |
| `domain/toolbox/envelope.ts` + `query.ts` | metric 段补 dept/variantNote |
| `skill/content/shared.md` + `skill/render.ts` + `render.test.ts` | 第 5 条硬约束 + 行数断言 + 快照 |

---

### Task 1: search_catalog tie 检测与投影扩展

**Files:** Modify `domain/toolbox/discovery.ts` + `discovery.test.ts`。

**语义（在现有 scoreOf/排序之后、slice 之前判定）：**
- 顶分集合 = score === topScore 的条目；若其中存在 **≥2 条不同 id 且 `lower(title)` 相同**（或互为精确同义词命中：`q` 恰等于某条的 title 且恰等于另一条的 synonym——按实现成本取 title 判据即可，同义词交叉命中记 P4）⇒ `ambiguous: true`。
- 回包形状：`{ results, ambiguous?: true }`——**ambiguous 只在为真时出现**（缺省即不歧义，旧消费者零破坏）；results 照常返回（人可看全量），但**同分组不再静默取先**：保持稳定排序让候选都进 top（SEARCH_LIMIT 内）。
- results 投影加 `dept: m.ownerDept ?? null`、`variantNote: m.variantNote ?? null`（MetricRow 已有列——P1/P2 接线过）。
- **工具描述零字节变化**（预算红线）。

- [ ] 失败测试：两条同 title 不同 id（一 L1 一 L2 或两 L2 同分）⇒ ambiguous=true 且两条都在 results；同 title 但分数不同（一精确一说明命中）⇒ 无 ambiguous；单条 ⇒ 无 ambiguous 键；投影含 dept/variantNote。
- [ ] RED → 实现 → GREEN → Commit `feat(data): search_catalog 同名 tie 检测+投影带口径（P3 Task 1）`。

---

### Task 2: 答案信封 metric 段补口径

**Files:** Modify `domain/toolbox/envelope.ts`（`SECTION_ORDER` 不动——还是 metric 段内）+ `query.ts`（queryMetricImpl 构造 metric 段处）+ 对应测试。

- metric 段现有键（id/version/definitionHash/tier/caliber/basis/owner/title）追加 `dept`（ownerDept ?? null）与 `variantNote`（?? null）——caliber 的完整拼图就位：**id 钉死 + title 人话 + dept 归属 + variantNote 差异**。
- envelope.ts 里 metric 段的 schema description（第 33 行那行「id/version/.../owner/title」）**同步补 dept/variantNote 两个词**——这是 envelope 自描述，不是工具描述，不占 10KB 预算（预算只测 tools/list 静态序列化——`check-mcp-toolface` 门禁口径，改完跑门禁实证）。
- preview/explore 走同一 `buildEnvelope` ⇒ 自动继承（确认 query.ts 里构造点唯一）。
- [ ] 失败测试：query_metric 回包 metric 段含 dept/variantNote（带值与 null 两态）；envelope 快照更新。
- [ ] RED → 实现 → GREEN → `pnpm exec tsx scripts/check-mcp-toolface.mjs` 实证预算不变 → Commit `feat(data): 答案信封 metric 段带部门与差异说明（P3 Task 2）`。

---

### Task 3: 第 5 条硬约束（agent 必须澄清，不许挑第一个）

**Files:** Modify `skill/content/shared.md`（追加一行「· 」前缀）+ `skill/render.ts`（行数断言 4→5）+ `skill/render.test.ts`（快照）。

- 新约束行（措辞与既有四行同风格、一句话）：**同名指标多候选（回包 ambiguous=true 或 search 结果同名 ≥2 条）时必须向用户澄清是哪条口径，不许按顺序取第一条；给出数字时说明按哪个口径（id/标题/部门）。**
- `guideInvariants()` 行数断言 4→5；`GUIDE_TEXT_BUILDER` 快照更新（render.test）；`contract.test.ts` 若钉了 guide 输出形状一并更新。
- `pnpm run gen:skill` 本地跑一遍确认生成物合法（不入库——`.gitignore` 已挡，别提交 generated/）。
- SKILL.md 不入库（构建期生成）⇒ 部署后 agent 侧自动拿到第 5 条。
- [ ] 失败测试（render.test：5 行、含「澄清」关键词）→ 实现 → GREEN → Commit `feat(data): 硬约束第 5 条——同名必须澄清（P3 Task 3）`。

---

### Task 4: 终审 + 部署 + 台账

1. 终审（opus，整分支）：tie 判据与排序交互、envelope 变更的消费者兼容（旧消费者读 metric 段多两个键）、预算实证、guide 分发链完整性。
2. 全量本地 + CI 全绿 + PR（Closes issue）+ shanhai 部署。
3. 容器核验：guide 工具运行时输出含第 5 条（exec 调 data_agent_guide 或 grep 产物）；search 回包形状（无鉴权 401 证明路由在）；预算门禁绿。
4. 台账：P3 行入已完成；P1/P2 终审缓办条目随波评估销账（尤其「notify eventId 拼变更单 id」与「custom 分支 scope 源维度」是否顺带可销）。

---

## Self-Review

- **Spec 覆盖**：§10 四条——tie 检测（T1）、caliber 标注（T2）、澄清优先（T3）、「报表/审计/导出永远落 id」（**既有事实**——报表 spec.panels 存 metric id、query_audit 记 metric_id，无需新代码，终审核实即可）。
- **取舍**：同义词交叉同名（q 恰为 A 的 title 与 B 的 synonym）记 P4（判据复杂度 vs 收益，title 判据已覆盖主形态）；ambiguous 候选不强制截断 SEARCH_LIMIT 逻辑（保持稳定排序自然呈现）。
- **不做**：search_catalog 描述加字（预算红线）；按人解析（spec 不做）；报表 id 落点改动（已成立）。
