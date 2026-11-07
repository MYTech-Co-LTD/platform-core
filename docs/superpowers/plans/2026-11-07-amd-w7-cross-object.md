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
- 实际落点：`modules/data/domain/analysis/relations.ts`（解析/闸门/join 编译）+ `explore.ts`（`joins: 关系名[]`、列可写 `<关系名>.<列>`）
- Modify: `modules/data/domain/toolbox/registry.ts`（工具 schema 暴露 `joins`）

**Interfaces（实际实现，比初稿多 `keys`）:**
```ts
interface RelationDecl {
  name: string
  from: { relation: string; column: string }
  to: { relation: string; column: string }
  keys: Array<{ from: string; to: string }>   // 附加等值键（system_book）—— 见下方实测
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M'
  dedupRule?: 'latest_snapshot'
  evidence: { matchRate: number | null; sampledDay?: string | null }
  status: 'verified' | 'candidate'
}
```
- 编译期：`joins` 只能引用 `status='verified'` 且 `matchRate ≥ 0.95`、from 侧就是基表的关系；
  未通过 ⇒ `JOIN_NOT_ALLOWED`，未声明的别名引用 ⇒ `COLUMN_NOT_FOUND`；
- 执行期：仍走 `explore-exec` 的只读池、org 注入、1000 行上限、审计。

**★ 实测订正（2026-11-07，join 接线时发现）**：单列键会跨账套串表——事实表与维表都含
3120/64188 两账套，`branch_num` / `item_num` 跨账套重号。
- 门店：`fct_retail_sale` 单日 202 行 → 单键 join **14,292 行（70×）**；去重 + `system_book` 后 202 行；
- 商品：`fct_retail_item_sale` 单日 7,867 行 → 单键 join **8,785 行（+11.7%）**；去重 + `system_book` 后 7,867 行。
⇒ 声明必须有 `keys: [{from: system_book, to: system_book}]`，维表非唯一必须 `dedupRule: latest_snapshot`。

- [x] **Step 1**: 迁移 + 声明文件（三条关系全部带 `evidence`；门店/商品补 `keys` + 去重）
- [x] **Step 2**: 校验器 + 单测（缺证据 / 低命中率 / 未知列 / 未知 dedupRule 全部拒）
- [x] **Step 3**: `explore_query` 支持 joins + 3 个跨对象用例（客户×出库、门店×销售、**商品×销售**）
      ※ 第三条由「客户×费用」改为商品×销售：商品关系已有真机证据，客户费用侧关系尚未测命中率
- [x] **Step 4**: 真机跑通并记录 SQL 与证据（见下）

**Step 4 真机证据（在 `shanhai` 数据面 pg_duckdb 上跑编译后同形 SQL）**

| 用例 | 结果 | 行数/金额守恒 |
|---|---|---|
| 门店 × 销售（最新日） | 13 个战区，西部二区 21,820.90 居首 | base 89,559.50 = joined 89,559.50 |
| 商品 × 销售（最新日） | 江苏大闸蟹2.0母蟹 46,320.63 居首 | base 551,477.12 = joined 551,477.12 |
| 客户 × 出库（全量） | 体系内门店/外部客户各占前二（809.5 万 / 790.5 万） | base 146,681,225.46 = joined 146,681,225.46 |
| 客户关系命中率 | 有键行 44,793/44,793 = **100%** | 44,793/131,151 行有 `client_fid`（transfer 行恒 NULL） |

---

### Task 3: 租户级自进化（**2026-11-07 验证后重写**）

**设计**：`docs/superpowers/specs/2026-11-07-tenant-selfdriving-design.md`（验证证据 V1–V8 与四件范围）。

**为什么重写**：开工前真机验证发现——多 org 只是小改动，真正堵住 30 天判据的是
① 回归腿连续 3 天红且原因不是口径变化（#3 滚动窗口基线；#1723 标识列 sum 漂移）；
② `value` 缺失/标识列求和让判据不可执行；③ job failed 通知不进站内 feed。故本 Task 拆成四件。

**Files:**
- Modify: `scripts/demand-mining.mjs`（`--org` / `--all-tenants`；逐 org 失败隔离）
- Modify: `modules/data/domain/demand/mine.ts`（`skipConv` + `convSkipped`；单测）
- Modify: `modules/data/domain/verified-regression.ts`（`compare` 增 `warns`；`runRegression` 透传）
- Modify: `scripts/verify-regression.mjs`（打印 warn / 汇总 warn=N；退出码只看 fail）
- Modify: `scripts/apply-eval-set.mjs`（拒 `window: 'default'`）
- Modify: `scripts/refresh-baseline.mjs`（已存在 #1494；修 dry-run 仍写库 → `write:false` 只计算）
- Create: `scripts/lemeng/emit-probe.sh`（→ `/opt/lemeng-emit-probe.sh`，进 data-plane 清单）
- Create: `docs/superpowers/notes/2026-11-07-tenant-loop.md`
- 数据处置：#3 → `stale`；#1723 → 用 refresh CLI 刷新一次

**判据：** 单租户连续 30 天：需求出现→处置→回归覆盖，平台零介入（本轮做到「环路可信可见 + 首日基线」，30 天标观察中）。

- [x] **Step 1（多 org）**：`--org` / `--all-tenants` 互斥；空租户 exit 1；单 org 失败隔离；conv/stuck 仅单租户部署时挖。**真机**：`--all-tenants` → `org=shanhaiyiguo-org … conv=ok`，rc=0
- [x] **Step 2（评估集卫生）**：`apply-eval-set` 拒 `default`；#3 置 `stale`（回归集 50→49）；`refresh-baseline` dry-run 修好（domain `write?: boolean`）。**#1723 未刷新**——它已降为 warn；且上线后出现 10 条源数据修订导致的 value 漂移，刷新待数据 owner 裁决
- [x] **Step 3（判定分级）**：`compare` 的 `warns`；value/结构=fail、维度列=warn、无 value 列 fail-closed。**真机**：`#1723` fail→pass+warn；value 漂移仍 fail（10 条，源数据修订）
- [x] **Step 4（可见性）**：`emit-probe.py` → `/opt`；job 命令已改「跑回归→按退出码发 OK/RED→保留退出码」。**真机**：手动 run `jrun_pWUwtgh_y8cKU51T` 末行投递成功，OO `data_plane_probes` 有 `verdict=RED` 行
- [ ] **Step 5（观察）**：`notes/2026-11-07-tenant-loop.md` 已记首日基线与上线实测 + 7/30 天 SQL；**30 天曲线观察中**（到期按 §3 取数）

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
