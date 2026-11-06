# W7 跨对象与自进化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 对应路线图 §3 的 **W7**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`（§7 变更记录 2026-11-07）。
> **范围（2026-11-07 用户裁决）**：只做**已接入源**——未接入的源不在本次范围，接源仍由平台管线线（Orca `pipe-migrate`）承担。

**Goal:** 让"按客户/按商品/按门店"这类**跨对象问题**能一次查出来并带证据；让**租户自己的**需求/候选/回归自转；事件只做能证实的部分。

**Architecture:** 不新造本体层。关系是**有命中率证据的声明**（`data.semantic_relation`），事件是**从已采集明细派生的事件表**（类型 + 时间），两者都要过门禁；探索面在 `explore_query` 上扩"按已声明关系 join"。

**Tech Stack:** 既有 warehouse（pg_duckdb）+ `explore_query` 编译链 + 迁移/声明文件；不引新依赖。

## Global Constraints

- **只做已接入源**：新源接入不在本波；不写任何"探测新源"的能力。
- **关系必须有证据**：每条 `semantic_relation` 带 `evidence`（源列/目标列/命中率/抽样日）；命中率 <95% 不许 `verified`。
- **不造键**：`fct_retail_sale` 若源里没有 `client_fid`/`item_num`，就登记缺口，**不许**在关系表里假装存在。
- **事件不推断因果**：只落"类型 + 时间 + 关联单号"，不做状态迁移模型（实测 0 单多状态）。
- **明细表探索按日切片**：单条查询 `bizday` 限定到单日、`statement_timeout ≤15s`（2026-11-07 曾把仓库打进 recovery）。
- **租户隔离**：所有新增表带 `org`，SQL 恒带 `where org = $1`；租户级需求/候选/回归不得跨租户。

---

### Task 1: 建模补键（retail 的 client_fid / item_num）

**Files:**
- Modify: `dbt/models/lemeng/staging/stg_lemeng_retail_order_line*.sql`（或在 marts 聚合层补键）
- Create: `docs/superpowers/notes/2026-11-07-retail-key-gap.md`（缺口与实测）
- Test: `dbt/tests/lemeng/` 新增两列的非空率断言（或 `scripts/verify-invariants.mjs` 式校验）

**判据（写进 PR）：**
- `fct_retail_sale.client_fid` / `item_num` 的非空率、对 `dim_lemeng_client` / 商品维的命中率**都要报数**；
- 源里没有该字段 ⇒ 不补列，登记为**建模缺口**，并在关系声明里排除。

- [ ] **Step 1**: 单日切片核实源侧字段（`stg_lemeng_retail_order_line` 是否有客户/商品键；一次只查一天）
- [ ] **Step 2**: 有 ⇒ 改 dbt 聚合层带上键；无 ⇒ 写缺口笔记（含实测 SQL 与数字）
- [ ] **Step 3**: 跑一天回填验证非空率/命中率，把数字写进 PR
- [ ] **Step 4**: 提交

---

### Task 2: 关系声明 + explore join

**Files:**
- Create: `modules/data/migrations/040_semantic_relation.sql`
- Create: `dbt/semantics/relations.yml`（声明面；与 l1_metrics.yml 同风格）
- Create: `modules/data/domain/semantics/relation.ts` + 测试（校验：字段存在、命中率、证据必填）
- Modify: `modules/data/domain/analysis/explore.ts`（支持 `joins: [{relation, on:[...]}]`，走同一白名单与掩码）

**Interfaces:**
```ts
interface SemanticRelation {
  name: string
  from: { relation: string; column: string }
  to: { relation: string; column: string }
  cardinality: '1:1' | '1:N' | 'N:1'
  evidence: { matchRate: number; sampledDay: string; rowsProbed: number }
  status: 'verified' | 'candidate'
}
```
- 编译期：`joins` 只能引用 `status='verified'` 且 `matchRate ≥ 0.95` 的关系；
- 执行期：仍走 `explore-exec` 的只读池、org 注入、1000 行上限、审计。

- [ ] **Step 1**: 迁移 + 声明文件（首批只收：门店 100% 已证；客户只收出库/贡献/费用侧）
- [ ] **Step 2**: 校验器 + 单测（缺证据 / 低命中率 / 未知列 全部拒）
- [ ] **Step 3**: `explore_query` 支持 joins + 3 个跨对象用例（客户×出库、门店×销售、客户×费用）
- [ ] **Step 4**: 真机跑通并记录 SQL 与证据

---

### Task 3: 租户级自进化

**Files:**
- Modify: `scripts/demand-mining.mjs`（`PLATFORM_ORG` → 按租户遍历，或按传入 org）
- Modify: `modules/data/domain/demand/*`（候选/需求按 org）
- Modify: `scripts/verify-regression.mjs`（支持 `--org` 多租户；已有）
- Create: `docs/superpowers/notes/2026-11-07-tenant-loop.md`

**判据：** 单租户连续 30 天：需求出现→处置→回归覆盖，平台零介入。

- [ ] **Step 1**: 需求挖掘按 org 跑（job 参数化），单测覆盖
- [ ] **Step 2**: 候选池处置面按 org 隔离（复用现有 scope）
- [ ] **Step 3**: 租户评估集创建/入库/回归三件套
- [ ] **Step 4**: 真机：给一个租户跑 7 天，记录 `demand_signals`/`verified` 增长曲线

---

### Task 4: 事件表（降级版）

**Files:**
- Create: `dbt/models/lemeng/marts/fct_order_event.sql`（类型 + 时间 + 关联单号，**不做状态迁移**）
- Test: `dbt/tests/lemeng/` 单日事件类型计数断言

**判据：** 事件类型分布 = 实测值（SALE 15,157 / FULL_RETURN 69 / PARTIAL_RETURN 9 / REPAID_RETURN 32，2026-10-20）；退货关联覆盖率**如实证报数**（201/15,267 ≈ 1.3%），不粉饰。

- [ ] **Step 1**: 建事件模型（按单日验证）
- [ ] **Step 2**: 计数断言 + 覆盖率断言
- [ ] **Step 3**: 接管一张报表/一次探索用例，证明"什么时候发生了什么"能答

---

## Self-Review

- 与验证证据逐条对应：关系只收 100% 命中；事件砍掉状态迁移；补键先于关系 ✅
- 不越界：未接入源、探测新源、本体六视野 都不在本波 ✅
- 每项都有可判定出口与真机证据要求 ✅
