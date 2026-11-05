# W3 L1 提案自动化 Implementation Plan

> **本计划对应路线图 §3 的 W3**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`
> 开工前先读该文件 §1/§3/§5，并**用命令核实代码现状**（不信任台账文本）。
>
> 前置已验（2026-11-05）：`dbt/` 整树 COPY 进 server 镜像（`deploy/Dockerfile.server:94`）⇒ 容器内可读
> `/app/dbt/semantics/l1_metrics.yml`；`scripts/check-data-models.mjs` 导出纯校验函数（ratioShapeError /
> freshnessSlaError / metricToAuditFileName），可被域层 import（同一把尺）；`apply.ts` 白名单现只有
> `contracts/` + `deploy/duckle/console/pipelines/`（均 .json）。

**Goal:** 让「私有测度 / 候选」能升级为 L1 声明草案（`l1_metrics.yml`）并走既有 `apply_pipeline_proposal`
开 draft PR；B11 门禁（gate ⑦ audit test）不因自动化而旁路。

**Architecture:** 新增零写入工具 `propose_metric_declaration`（产出**全量 YAML 文件 piece** + 可选 audit SQL piece）；
apply 白名单扩两个落点（`dbt/semantics/l1_metrics.yml` 精确单文件 + `dbt/tests/**.sql`）+ YAML 内容重校验
（解析 + 增量限定 + 逐条 entry 形状校验，复用 check-data-models 纯函数）；候选升级链（`origin='profile'` 候选 →
`promotion` 组装 → 提案）。**不自动生成 audit test**（手工复算测试不可模板化，生成空壳=假绿）——audit SQL 由
提案输入携带或列为 downstream required，PR 合并前 gate ⑦ 会红，**这是特性不是缺陷**（人写复算才是口径对账的真身）。

**Tech Stack:** TypeScript 域层 / YAML 解析（`yaml` 包，sync 脚本已在用）/ vitest。

## Global Constraints

- **B11 口径单一定义**：L1 声明只进 `dbt/semantics/l1_metrics.yml`；expression 必须过 `parseL1Select` 形状与
  relation 白名单（复用 W2 的 `validatePrivateMeasure` 闸①逻辑形态）。
- **gate ⑦ 不旁路**：新 L1 必有 `dbt/tests/<域>/audit_<指标>.sql`（`:`→`__`，映射唯一事实源
  `metricToAuditFileName`）。propose 不生成它——输入带 `auditSql` 则成 piece，不带则 downstream `required` +
  validation 注明「PR 将红直到补 audit test」。
- **apply 零网络前置不变**：白名单 + 内容重校验仍是纯函数、不过就 `refused/invalid_draft`。
- **propose 零写入不变**：草案只进回包。
- **全量文件 piece 的增量限定**：YAML piece 与容器内现行文件的 diff 必须**只**落在 `metrics[]`（新增/修改声明条目），
  动 `domains:`/`entities:` 或其它条目 ⇒ 拒。
- 工具面：`PIPELINE_FACE_MAX_TOOLS` 8→9；工具清单/装载期双表断言同步。

---

### Task 1: 声明草案组装器（propose 侧，零写入）

**Files:**
- Create: `modules/data/domain/pipelines/propose-metric.ts`
- Modify: `modules/data/domain/pipelines/tools.ts`（新工具 `propose_metric_declaration`，`PIPELINE_FACE_MAX_TOOLS` 8→9）
- Test: `modules/data/domain/pipelines/propose-metric.test.ts`

**Interfaces:**
- `MetricDeclarationInput`：`{ name, label, definition, expression | ratio, grain, owner, tier, source, freshnessSlaDays, entity?, synonyms?, auditSql?, rationale }`
- `composeMetricDeclaration(roots, input, currentYaml)` → `{ ok: true, pieces, downstream, validation } | { ok: false, issues }`
- piece 1：`dbt/semantics/l1_metrics.yml` 全量文件（entry 按 name 字典序插入 `metrics[]`；保留文件其余结构逐字）
- piece 2（仅当 `auditSql` 在场）：`dbt/tests/lemeng/audit_<name 映射>.sql`

**组装规则（全部机检）**：
- name 过 `RESERVED_METRIC_ID_PREFIXES` 与命名空间三段式正则（与 gate ⑥ 同形）。
- 同名指标已存在 ⇒ 修改模式（diff 限定在该条目）且 `definition` 必须变（防无意义重提）。
- expression 形态 `sum|avg|min|max|count(distinct)? <relation>.<column>` + 过 `parseL1Select`。
- ratio 在场 ⇒ 过 `ratioShapeError`；sla 过 `freshnessSlaError`（同名同姓的领域 ⑤⑥ 判据）。
- relation ∈ L1 已用集合（从 currentYaml 反解）。
- 新条目缺 `auditSql` ⇒ validation 注明 + downstream required（**不拒**——draft PR 允许带红）。

---

### Task 2: apply 白名单扩展 + YAML 重校验

**Files:**
- Modify: `modules/data/domain/pipelines/apply.ts`
- Test: `modules/data/domain/pipelines/apply.test.ts`

**规则**：
- `pathViolations` 扩两档：精确 `dbt/semantics/l1_metrics.yml`（单文件，非目录）与 `dbt/tests/` 前缀 + `.sql` 后缀。
- YAML piece 校验（纯函数，容器内现行文件为比对基准，roots 可注入以便测试）：
  1. YAML 可解析、顶层结构含 `version`/`metrics`。
  2. 与现行 diff 只在 `metrics[]`（逐条 name 键比对；新增集 ∪ 修改集，其它数组/键逐字相等）。
  3. 每个新增/修改条目过 Task 1 同一套形状校验。
- SQL piece 校验：非空、不含 `FORBIDDEN_SQL_RE` 词（复用 semantic-compiler 导出）、路径在 `dbt/tests/` 下。
- 其余（冲突预检/分支/PR draft）机制不动。

---

### Task 3: 候选升级链（origin='profile' 候选 → L1 提案）

**Files:**
- Modify: `modules/data/routes/private-measures.ts` + `manifest.yaml`
- Test: `modules/data/routes/private-measures.test.ts`

- `POST /metrics/candidates/:id/propose-l1`（scope `data:manage`）：读候选（须 `origin` 任意、`status ∈ {pending, promoted}`），
  组装 `MetricDeclarationInput`（expr.agg/column/dims → expression + grain；`rationale` 带候选 evidence 摘要），
  调 Task 1 组装器，回 `{ pieces, downstream, validation }`（**零写盘**——apply 仍走 MCP 工具面）。
- 候选 expr 的 `relation` 若不在 L1 已用集合（私有测度白名单是 marts 集，L1 集是其子集的情况不存在——
  W2 白名单本身就是 L1 已用集，此处只复核）⇒ 400。

---

### Task 4: 收口

- 全量验证 + 台账 W3 → 进行中（实现完成，待 PR）；部署清单：合并后走既有自动部署 + sync（无新步骤——
  sync 是部署链一部分，已物化 L1 行）；真机验收：`origin='profile'` 候选 → propose-l1 → apply → draft PR 可达。

## Self-Review

- Spec 覆盖（roadmap W3：apply 扩展到语义声明 + dbt model）✅——**dbt model 不在 v1**（升级对象是
  已有 marts 列聚合，不需要新 model；新 model 需求出现时再议，登记到计划头）。
- 不自动生成 audit test（gate ⑦ 不旁路 + 不编）✅
- 无占位符；阈值/词表引用既有常量（不新造第二把尺）。
