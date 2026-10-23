# P3.2 正式列切换实施计划（fct_retail_sale）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `fct_retail_sale` 的 `sale_amount` / `return_amount` / `net_amount` 从手写 CTE 切到 P3.0 已对账通过的生成物（`gen_agg`），删除旧计算链与影子列，保留 `order_count` 手写。

**Architecture:** 生成区（`-- BEGIN/END GENERATED MEASURES`）不动；只改区外：删 4 个旧 CTE、加一个手写 `order_count` CTE、重写最终 SELECT。**无 DDL、无迁移**（列名/类型不变）。

**Tech Stack:** dbt 1.9.1 / pg_duckdb；`scripts/gen-fct-measures.mjs`；dbt singular tests。

## Global Constraints

- 列名与类型不变：`sale_amount numeric(20,2)` / `return_amount numeric(20,2)` / `net_amount numeric(20,2)` / `order_count bigint`（与切换前逐列一致）。
- 生成区（BEGIN/END 之间）**一个字节都不许手改**；`gen-fct-measures --check` 必须绿。
- 单侧店日归零语义保持：缺侧 = 0，不是 NULL。
- `order_count` 保持 `count(distinct order_no)` over 销售基面（`base_sale`）。
- 回滚 = revert 本 PR + 重跑 materialize；**不许调容差**。
- 提交规范 `type(scope): subject`；lock 由脚本重生成。

---

### Task 1: 切换最终 SELECT 并删除旧 CTE

**Files:**
- Modify: `dbt/models/lemeng/marts/fct_retail_sale.sql`（只动标记区外）

**Interfaces:**
- Consumes: 生成区的 `gen_agg(system_book, bizday, branch_num, sale_amount__gen, return_amount__gen)` 与 `base_sale`
- Produces: 同名列 `sale_amount` / `return_amount` / `net_amount` / `order_count`（值 = P3.0 影子列已对账的值）

- [ ] **Step 1: 删除旧计算链**

删掉 `sale_base`、`per_order`、`sale_side`、`return_side` 四个 CTE（从 `with sale_base as (` 到 `return_side` 结束的 `)`，**不要**碰 `-- BEGIN GENERATED MEASURES` 区）。同时删除它们上方只描述旧实现的行内注释；口径说明（头注）保留。

- [ ] **Step 2: 加手写 `order_count` CTE（放在 END GENERATED 之后）**

```sql
-- 订单数保持**手写**（不属任何 measure）：销售基面上的去重订单笔数。
-- 基面 `base_sale` 来自生成区（domain = FINISHED ∧ SALE_ORDER），与旧实现同基面。
order_count_cte as (
    select system_book, bizday, branch_num,
           count(distinct order_no) as order_count
    from base_sale
    group by 1, 2, 3
)
```

- [ ] **Step 3: 重写最终 SELECT**

```sql
select
    gen_agg.system_book,
    {{ subject_org() }}                                as org,
    gen_agg.bizday,
    gen_agg.branch_num,
    coalesce(gen_agg.sale_amount__gen, 0)::numeric(20,2)   as sale_amount,
    coalesce(gen_agg.return_amount__gen, 0)::numeric(20,2) as return_amount,
    (coalesce(gen_agg.sale_amount__gen, 0)
     - coalesce(gen_agg.return_amount__gen, 0))::numeric(20,2) as net_amount,
    coalesce(order_count_cte.order_count, 0)               as order_count
from gen_agg
left join order_count_cte
    on  gen_agg.system_book = order_count_cte.system_book
    and gen_agg.bizday      = order_count_cte.bizday
    and gen_agg.branch_num  = order_count_cte.branch_num
```

- [ ] **Step 4: 删除 `*__gen` 输出列与影子注释**

最终 SELECT 不再输出 `sale_amount__gen` / `return_amount__gen` / `net_amount__gen`；删除「影子列」注释段（190-197 行一带）。

- [ ] **Step 5: 静态自检**

Run: `pnpm exec tsx scripts/gen-fct-measures.mjs --check`（生成区未动 ⇒ 绿）；`grep -n 'sale_side\|return_side\|per_order\|sale_base\b' dbt/models/lemeng/marts/fct_retail_sale.sql`（应无残留，`base_sale` 除外）。

- [ ] **Step 6: 提交**

```bash
git add dbt/models/lemeng/marts/fct_retail_sale.sql
git commit -m "feat(data): fct_retail_sale 度量列切换为生成物（#1020）"
```

---

### Task 2: 测试与 schema 收口

**Files:**
- Delete: `dbt/tests/lemeng/assert_fct_retail_sale_measure_shadow_parity.sql`
- Modify: `dbt/models/lemeng/marts/schema.yml`（删 `*__gen` 的 not_null；确认正式列 not_null）

- [ ] **Step 1: 删影子对账测试**

`git rm dbt/tests/lemeng/assert_fct_retail_sale_measure_shadow_parity.sql`——切换后它失去参照物；独立复算的 `audit_lemeng__retail__sales.sql` / `audit_lemeng__retail__net_sales.sql` 仍是持久守卫。

- [ ] **Step 2: schema.yml 收口**

删三个 `__gen` 列的 `not_null`；确认 `sale_amount` / `return_amount` / `net_amount` / `order_count` 均有 `not_null`（`order_count` 缺则补）。

- [ ] **Step 3: 重生成 lock**

Run: `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs`

- [ ] **Step 4: 提交**

```bash
git add -A dbt/ deploy/data-plane.lock
git commit -m "test(data): 切换后收口——删影子对账与 __gen not_null（#1020）"
```

---

### Task 3: 门禁与文档收口

**Files:**
- Modify: `docs/superpowers/specs/2026-10-23-aggregate-face-componentization-design.md`（§5 P3.2 行补「已实施」证据指针）

- [ ] **Step 1: 跑全量门禁**

Run: `pnpm run typecheck:scripts && pnpm run test:guard && pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs && pnpm exec tsx scripts/gen-fct-measures.mjs --check && pnpm exec tsx scripts/gen-data-projection.mjs --check`

- [ ] **Step 2: 文档**

在 spec §5 的 P3.2 行后补一行：实施证据（PR 号、切换前后 3087 店日逐分零差异的出处）。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-10-23-aggregate-face-componentization-design.md
git commit -m "docs(data): P3.2 实施记录（#1020）"
```

---

## 真机验收（合并后）

1. `lemeng-sync.sh <merge-sha>` → `SYNC_OK`
2. 山海主项目部署（dbt 进镜像）
3. materialize → `PASS=全部` / `MATERIALIZE_OK`；`audit_lemeng__retail__sales` / `__net_sales` PASS
4. 切换前后**快照比对**：合并前后各取一次 `fct_retail_sale` 的 `(system_book,bizday,branch_num)` 三列，`diffs=0 / nulls=0`
5. 问数回归：`query_data(lemeng:retail:sales, 2026-10-20)` 与切换前逐分一致（certified 签核）

## PR 必须带签核节

> **certified 口径变更签核**：Who（审批人）/ Why（P3.2 单一事实源）/ 期望数值变化 **0**（3087 店日已证）/ 对账窗口 14 天。
