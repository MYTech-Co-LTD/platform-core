# 指标语义治理 P1（概念与归属 + P0 缓办销账 + override 档）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 指标获得概念与部门归属（`owner_dept`/`variant_note`/entity 对 L2 开放、部门内同名互斥），P0 的 6 条终审缓办逐条销账，override 档接入变更单。

**Architecture:** 全部沿用 P0 的变更单闭环（submit→preview→人采纳）；本波只加列、加校验、加档位、修缓办——不改评审模型本身。唯一索引按生产取证（零同名冲突）直接建。

**Tech Stack:** TypeScript / Hono / pg / zod / vitest（modules/data）。不新增运行时依赖。

**Spec（唯一事实源）:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §5.1 §5.3 §5.4 §10 §13。
**P0 已落地（本波的地基，先读）:** `domain/metric-change.ts`、`domain/metric-change-preview.ts`、`routes/metric-changes.ts`、`routes/mcp-metric-tools.ts`、`console/changes/`。

## Global Constraints（每个任务隐式继承）

- 生效只有一条路：人采纳（P0 不变量）；本波所有新能力都经变更单。
- **改路由必须与 `manifest.yaml` api.internal 同提交对齐**（装载期双向核对）。
- 迁移幂等；对既有数据**不制造静默收缩**（回填规则见 §5.4：`owner_dept` 全空起步、entity 只在可解出基底时继承）。
- 决策端点仍只认会话；本波不新增决策端点。
- `tools/list` 合并面 ≤10KB（当前 9997——**本波不得增加工具或描述字节数**；若必须加，先扩门禁再落地）。
- 测试隔离键用本文件专属前缀 `org-p1-mo-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。

## 前置（开工前人工完成）

1. 建 issue：`feat(data): 指标语义治理 P1——概念归属+同名互斥+缓办销账+override 档`，正文引 spec §5.1/§5.3 与本计划。
2. 从最新 `origin/main` 拉分支 `feat/metric-ownership-p1`，worktree 用 ASCII 路径（如 `/private/tmp/pc-p1`）。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/migrations/047_metric_ownership.sql` | metrics 增列 + 唯一索引 + 概念表 |
| `domain/metric-ownership.ts`（新） | 概念校验（平台 YAML 实体 ∪ 租户概念表）+ 同名互斥判据 |
| `domain/metric-store.ts` | MetricRow/COLS/upsertMetric/insertTenantDeclaration 扩新列 |
| `domain/metric-change.ts` | payload 扩展（entity/ownerDept/variantNote）、create 撞 id 拒收、meta 空串判据订正、override 档 |
| `domain/metric-change-preview.ts` | override 档试算；preview_history |
| `domain/tenant-declaration-write.ts` | 只读复用（不改） |
| `scripts/check-mcp-toolface.mjs` | 门禁扩面：测合并工具面 |
| `console/changes/index.tsx`、`console/metrics/index.tsx` | 归属字段只读展示 |

---

### Task 1: 迁移 047 —— 归属列 + 唯一索引 + 概念表

**Files:** Create `modules/data/migrations/047_metric_ownership.sql`；Modify `modules/data/module.test.ts`（表清单 25→26 态）。

生产取证（2026-11-12，shanhai prod）：`data.metrics` 共 57 行（l1=56 全在 platform 桶、l2=1），**同 org 同 lower(title) 冲突组 = 0** ⇒ 唯一索引可直接建。

- [ ] Step 1: 写迁移（完整 SQL）

```sql
-- 047_metric_ownership.sql —— 指标概念与部门归属（spec §5.1/§5.3，Wave 5 P1）。
-- 归属列 P1 落地、P2 执法（canViewMetric）；唯一索引 P1 即生效（写入侧拒收，见 metric-ownership.ts）。
alter table data.metrics
  add column if not exists owner_dept    text,
  add column if not exists visible_depts text[],
  add column if not exists variant_note  text,
  add column if not exists reveal        text;

alter table data.metrics drop constraint if exists metrics_reveal_check;
alter table data.metrics add constraint metrics_reveal_check
  check (reveal is null or reveal in ('panel','report'));

-- 部门内同名互斥（spec §5.1）。生产已取证零冲突，可直接建；
-- coalesce 把「平台通用」（owner_dept 为空）也纳入互斥（平台桶内同名同样拒绝）。
create unique index if not exists metrics_title_per_dept_uq
  on data.metrics (org, coalesce(owner_dept, ''), lower(title));

-- 回填（§5.4）：L2 的 entity 只在能解出基底时继承——不按 description 文本猜。
-- 现网唯一 L2（shanhaiyiguo-org）无 declaration.baseMetric 可解 ⇒ 留空，符合规则。

-- 租户概念表（spec §5.3）：L1 概念在 dbt/semantics/l1_metrics.yml 顶层 entities（031 物化），
-- 本表只放**租户新增**概念；平台概念只读（写侧校验见 metric-ownership.ts）。
create table if not exists data.metric_concept (
  org        text not null,
  name       text not null,
  label      text not null,
  synonyms   jsonb not null default '[]'::jsonb,
  owner_dept text,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (org, name)
);

create index if not exists metric_change_preview_hist_idx
  on data.metric_change (org, id);  -- 顺带为 Task 5 的 preview_history 读写铺路（幂等）
```

- [ ] Step 2: 迁移 046 同款验证（跑任一 pg 域测试重放迁移；双跑幂等）。
- [ ] Step 3: `module.test.ts` 表清单补 `metric_concept`（26 张）。
- [ ] Step 4: Commit `feat(data): 归属列+同名唯一索引+概念表（P1 Task 1）`。

---

### Task 2: 概念校验与同名判据（domain/metric-ownership.ts）

**Files:** Create `domain/metric-ownership.ts` + `domain/metric-ownership.test.ts`。

**Interfaces（Produces，后续任务按名消费）:**
- `platformConcepts(): ReadonlySet<string>` —— 解析 `dbt/semantics/l1_metrics.yml` 顶层 `entities` 键（复用 `pipelines/propose-metric.ts` 的 `readCurrentSemanticsYaml` + 现有 yaml 解析工具；**文件不可读 ⇒ 返回空集并 console.warn，不抛**——生产镜像内有该文件，测试注入 baseDir）。
- `tenantConcepts(pool, org): Promise<ReadonlySet<string>>`
- `assertConcept(pool, org, entity: string | null): Promise<void>` —— entity 非空时不在并集 ⇒ 抛 `OwnershipError('UNKNOWN_CONCEPT')`
- `assertTitleFree(pool, org, ownerDept: string | null, title: string, excludeMetricId?: string): Promise<void>` —— 查 `(org, coalesce(owner_dept,''), lower(title))` 命中且 id ≠ exclude ⇒ 抛 `OwnershipError('TITLE_EXISTS_IN_DEPT', { existingId })`（与唯一索引同判据；索引兜并发，本判据给可读错误）
- `class OwnershipError extends Error { code: string; extra?: Record<string, unknown> }`

- [ ] Step 1: 失败测试：概念并集（平台 3 个 + 租户 1 个）、未知概念拒、同名拒（同部门/平台桶各一例）、excludeMetricId 放行改名自身、平台 YAML 不可读 ⇒ 空集不炸。
- [ ] Step 2: 跑 RED → 实现 → GREEN → Commit `feat(data): 概念校验与同名判据（P1 Task 2）`。

---

### Task 3: 变更单扩展 —— payload 带归属 + create 撞 id + meta 判据订正

**Files:** Modify `domain/metric-change.ts` + `domain/metric-change.test.ts`；Modify `domain/metric-store.ts`（COLS/MetricRow/upsertMetric 落 `owner_dept/variant_note`；entity/synonyms 已有列，L2 写路径开放）；Modify `domain/metric-write.ts`（`writeL2Declaration` 透传新字段——`L2DeclarationBody` 不动，新字段走 `opts.meta?: { entity?, synonyms?, ownerDept?, variantNote? }`，避免破坏既有调用方）。

**语义（全部经变更单，不新增直接写面）：**
1. `submitChange` 的 create/update 档 payload 可带顶层 `entity/synonyms/ownerDept/variantNote`（zod：entity ≤128、synonyms ≤16×32、ownerDept ≤128、variantNote ≤500）。submit 时即校验：`assertConcept` + `assertTitleFree`（title 取 alias ?? 基底 title——refine 档无 alias 时继承基底 title，同名判据用**生效 title**）。违规 ⇒ `SubmitOutcome` 新错误 `UNKNOWN_CONCEPT` / `TITLE_EXISTS_IN_DEPT`（http 400/409）。
2. **缓办②销账**：kind=create 且 `data.metrics` 已有 `(org, id)` 行 ⇒ 400 `METRIC_ID_EXISTS`（upsert 语义保留给 update）。
3. **缓办④销账**：meta 档判据从「无实质内容」改为「**三键全缺**」——`{unit:''}`（显式清空）合法；`{}` 拒 `INVALID_META`。同步订正 P0 注释里错误的 EMPTY_META_PATCH 理由。
4. `adoptChange` 的 create/update 分支把归属字段透传 `upsertMetric`（upsert SQL 增列；`on conflict do update` 一并更新）。

- [ ] Step 1: 失败测试（每语义至少一条）：带归属提交→采纳后 `data.metrics` 行带 owner_dept/variant_note/entity；未知概念 400；同部门同名 409；create 撞已有 id 400；`{unit:''}` 提交+采纳后 unit 置 null（显式清空契约）；`{}` 仍拒。
- [ ] Step 2: RED → 实现 → GREEN；跑 `routes/metric-changes.test.ts` 邻居确认无回归。
- [ ] Step 3: Commit `feat(data): 变更单带概念归属+同名互斥+撞id拒收+meta判据订正（P1 Task 3，销缓办②④）`。

---

### Task 4: delete 采纳发通知（销缓办③）+ adopt/reject 竞态收口（销缓办⑥）

**Files:** Modify `routes/metric-changes.ts`（adopt 的 notify 块）+ `domain/metric-change.ts`（adopt 加 advisory lock）+ 对应测试。

1. **缓办③**：delete 采纳后，notify 的 title 查询在删除后落空——改为**采纳前**先取 `{title, version}` 快照，delete 档也发 `data.metric.definition.changed`（title 用快照，无快照回退 metricId）。
2. **缓办⑥**：`adoptChange` 全程包 `select pg_advisory_xact_lock(hashtext($org || ':' || $id))`（与写、CAS 翻状态同事务/同连接）；`rejectChange` 同锁。效果：adopt 与 reject 串行化，消除「写已生效但单据 rejected」的审计混淆。测试：两个连接并发 adopt+reject，终态必为一胜一 `CHANGE_STATE_CHANGED`，无双成功。

- [ ] Step 1: 失败测试（notify 快照含 delete 档；并发锁语义用两个 Pool 客户端真并发）。
- [ ] Step 2: RED → 实现 → GREEN → Commit `fix(data): delete 采纳发通知+决策竞态串行化（P1 Task 4，销缓办③⑥）`。

---

### Task 5: 预览快照历史（销缓办①）

**Files:** Modify `migrations/047_metric_ownership.sql`（追加 `alter table data.metric_change add column if not exists preview_history jsonb`——放 047 而非新迁移，因 047 尚未部署）；`domain/metric-change-preview.ts`（`applyPreview` 重跑时把旧 `preview` unshift 进 `preview_history`，封顶 5 条 FIFO）；`routes/metric-changes.ts`（GET 回包带 `previewHistory`）；console 待核对页 TechDetails 展示历史（「之前试过 N 次」折叠）。

- [ ] Step 1: 失败测试：重跑两次后 `preview_history` 长 1、最新在前、第 6 次丢最旧；采纳的 `adopted_snapshot` 仍是**采纳时刻的 preview**（不被后续重跑污染——采纳后状态已终态，本就不可重跑，钉住这一点）。
- [ ] Step 2: RED → 实现 → GREEN → Commit `feat(data): 试算快照历史（P1 Task 5，销缓办①）`。

---

### Task 6: toolface 门禁扩面（销缓办⑤）

**Files:** Modify `scripts/check-mcp-toolface.mjs` + 其单测（`scripts/` 下 vitest）。

现状：门禁只测 `MANAGE_TOOLS`（pipeline+demand=11）代理；合并 20 工具面无门禁（P0 实证漏过 10308）。扩法：
1. `modules/data/routes/mcp-manage.ts` 导出 `GROUPS`（已导出）；门禁**直接 import GROUPS 会拉 Hono/pg**——违背「门禁事实源是纯文件」。改为：把三片的**静态工具元数据**（name/mutating/requiredScope/annotations + 序列化尺寸）抽到纯文件 `modules/data/routes/mcp-manage-face.ts`（只 import 类型，不 import 实现），三片 list() 从它取定义（单一事实源），门禁 import 它测**合并面 ≤10240**。
2. 预算断言按合并面计；代理清单断言保留。
- [ ] Step 1: 失败测试（喂超限桩清单 ⇒ 红）。
- [ ] Step 2: RED → 实现（含三片改从纯文件取定义 + mcp-manage.test 回归）→ GREEN → Commit `ci(data): toolface 门禁测合并工具面（P1 Task 6，销缓办⑤）`。

---

### Task 7: override 档接入变更单

**Files:** Modify `domain/metric-change.ts`（ChangeKind + 'override'；payload=完整声明 entry 的 zod 宽校验（name==metricId、label/expression/grain 必填，交给 `createOverrideDeclaration` 深校验）；adopt 分支 → `createOverrideDeclaration({pool, warehouse?}, org, requester, metricId, payload)`）、`domain/metric-change-preview.ts`（override 档试算：`compileTenantDeclaration`（与写路径同一函数，从 `tenant-declaration-write.ts` 抽出或导出复用其内部编译段——**不复制校验逻辑**；warehouse 缺省跳列校验）→ 只读求值；baseline = 被 override 的 L1 同窗值）、`console/changes/index.tsx`（KIND_LABEL 加「覆盖平台口径」）。

已知边界（如实进 PR body）：override 落库行 id = L1 id（租户桶），同部门同名判据按 `(org, owner_dept, title)`——override 行的 title 来自 entry.label；**不得**用它顶掉同名 L2（不同 id 天然不撞）。

- [ ] Step 1: 失败测试：override 提交→试算（注入 execute）→采纳后租户桶出现 `override_of` 行且 L1 不动；grain 不同形 400（透传 DECLARATION_INVALID）；L1 不存在 404。
- [ ] Step 2: RED → 实现 → GREEN（若发现编译段抽取超载，报 DONE_WITH_CONCERNS 拆 Task 7b，不许复制粘贴校验逻辑充数）。
- [ ] Step 3: Commit `feat(data): override 档接入变更单（P1 Task 7）`。

---

### Task 8: 读面展示 + 全量验证 + PR + 部署

1. 指标页口径展开（TechDetails）与待核对页加「归属部门/概念/差异说明」只读行（默认层不加词——归属信息进展开层）。
2. 全量：`pnpm test` + `pnpm typecheck` + `test:guard` + `check-manifests` + `check-mcp-toolface`（新扩面）。
3. PR（Closes issue）；CI 全绿后合；shanhai 手动部署；容器验证：迁移 047 在位、`metrics_title_per_dept_uq` 与 `metric_concept` 在生产库、`preview_history` 列在、产物含「归属部门」；台账回填（P1 行 + 缓办清单 6 条全销）。

---

## Self-Review

- **Spec 覆盖**：§5.1 列+索引（T1/T3）、§5.3 概念（T1/T2）、§5.4 回填（T1 注释+不猜原则）、§10 解析（**P3 波次**，本波不做 tie 检测）、§13 错误码（UNKNOWN_CONCEPT/TITLE_EXISTS_IN_DEPT/METRIC_ID_EXISTS 新增）。
- **缓办清单对账**：①T5 ②T3 ③T4 ④T3 ⑤T6 ⑥T4——六条全销。
- **不做**：`visible_depts` 执法与 `reveal` 消费（P2）；`search_catalog` tie 检测（P3）；试算限速（P4）。
- **取舍**：override 试算的列校验在 warehouse 缺省时跳过（与写路径同语义）；`preview_history` 封顶 5 条（YAGNI）。
