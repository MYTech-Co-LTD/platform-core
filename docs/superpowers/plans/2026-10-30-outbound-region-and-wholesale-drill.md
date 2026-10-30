# 战区出库面 + 批发明细下钻 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务执行。步骤用 `- [ ]` 跟踪。

**Goal:** 让「各战区出库金额」可出（配送 + 体系内批发 + 外部批三分列），并让问数 bot 能对批发打行级明细。

**Architecture:** ① 新建客户维 `dim_lemeng_client`（体系内门店自动按「另一账套门店名唯一命中」匹配，别名/人工指定走受控 seed）；② 新建战区出库面 `fct_outbound_region`（在 `fct_hq_outbound` 之上换战区口径并分通道，不改原 mart）；③ 新建批发直读湖视图 `vw_lemeng_wholesale_order_line` + 行级 measure + 指标三键。

**Tech Stack:** dbt 1.9.1（pg_duckdb）+ `dbt/seeds` 受控维 + `dbt/semantics/l1_metrics.yml` + 仓内守卫脚本。

**Issues:** #1181（战区出库面）、#1182（批发明细下钻）

## Global Constraints

- **不改已声明指标**：`fct_hq_outbound` 既有列与 certified 指标（`outbound:*`、`transfer:*`）逐字不动。
- **外部客户不摊战区**（2026-10-30 用户裁决）：未匹配客户 `region_l1_bucket = '未归属'`，`channel_type = '外部批发'`。
- **单头列不得进度量**：`total_money` / `cost_money` 是随行冗余列，任何 `sum()` 都禁止（契约 description 已写明）。
- **主体列**：所有 mart/视图必带 `{{ subject_org() }} as org`（门禁规则 ⑩）。
- **受控维**：别名/人工映射进 `dbt/seeds/*.csv`（git 受控、PR 可审），不写死在 SQL；**无客户数据就不造数据**（0 行 seed 是合规态，见 `dbt/seeds/schema.yml` 头注）。
- **对账判据**：数值 1 分容差；守恒测试必须能让「漏行/双计」变红（变异确认）。
- **数据面链**：任何 `dbt/`、`deploy/` 改动后重生成 `deploy/data-plane.lock`（`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`）。

---

## Phase A — 战区出库面（#1181）

### Task 1: 客户维 `dim_lemeng_client` + 受控 seed

**Files:**
- Create: `dbt/seeds/x01_client_region_overrides.csv`（header: `source_system_book,client_fid,client_name,home_system_book,home_branch_num,region_id,note`；**0 行**）
- Modify: `dbt/seeds/schema.yml`（新增 seed 的 description，同 `x01_branch_calendar` 体例）
- Create: `dbt/models/lemeng/marts/dim_lemeng_client.sql`
- Create: `dbt/tests/lemeng/assert_dim_client_region_unique.sql`（同一 client 只能有一条映射）
- Create: `dbt/models/lemeng/marts/schema.yml` 追加该模型列断言（not_null: system_book/client_fid/client_kind）

**Interfaces:**
- Produces（供 Task 2 消费）: `dim_lemeng_client(system_book, org, client_fid, client_name, client_kind, home_system_book, home_branch_num, region_id, region_l1, match_rule)`
  - `client_kind ∈ {'体系内门店','外部客户'}`
  - `match_rule ∈ {'name_unique','override','none'}`

**判定规则（写进模型头注）：**
1. 客户名在**另一个账套**的门店名里**唯一命中** ⇒ 体系内门店；命中 ≥2 家或 0 家 ⇒ 不匹配（歧义不猜）；
2. seed 覆盖优先（`match_rule='override'`）；
3. 未命中 ⇒ `client_kind='外部客户'`、`region_id is null`、`match_rule='none'`。

- [ ] **Step 1: 写失败测试**（`assert_dim_client_region_unique.sql`：`group by system_book, client_fid having count(*)>1`）
- [ ] **Step 2: 建 seed（0 行）+ schema.yml 登记**；`dbt seed -s x01_client_region_overrides`
- [ ] **Step 3: 写模型**（骨架见下），列区手写、`left join dim_region`（seed）取 `region_l1`
```sql
-- 客户维：体系内门店按「另一账套门店名唯一命中」识别，别名/人工走 seed 覆盖。
with cli as (
    select distinct on (system_book, client_fid)
           system_book, client_fid, client_name
    from {{ ref('stg_lemeng_client') }}
    order by system_book, client_fid, snapshot desc
),
br as (
    select distinct on (system_book, branch_num)
           system_book, branch_num, name, region_id
    from {{ ref('stg_lemeng_branch') }}
    order by system_book, branch_num, snapshot desc
),
hit as (   -- 唯一命中才算；同名多家 = 歧义，不猜
    select c.system_book, c.client_fid,
           min(b.system_book) as home_system_book,
           min(b.branch_num)  as home_branch_num,
           min(b.region_id)   as home_region_id
    from cli c
    join br b on b.system_book <> c.system_book and b.name = c.client_name
    group by 1, 2
    having count(*) = 1
),
ovr as (select * from {{ ref('x01_client_region_overrides') }})
select
    c.system_book,
    {{ subject_org() }} as org,
    c.client_fid,
    c.client_name,
    case when o.client_fid is not null or h.client_fid is not null
         then '体系内门店' else '外部客户' end::varchar as client_kind,
    coalesce(o.home_system_book, h.home_system_book) as home_system_book,
    coalesce(o.home_branch_num,  h.home_branch_num)  as home_branch_num,
    coalesce(o.region_id, h.home_region_id)::int     as region_id,
    r.region_l1::varchar as region_l1,
    case when o.client_fid is not null then 'override'
         when h.client_fid is not null then 'name_unique'
         else 'none' end::varchar as match_rule
from cli c
left join hit h on h.system_book = c.system_book and h.client_fid = c.client_fid
left join ovr o on o.source_system_book = c.system_book and o.client_fid = c.client_fid
left join {{ ref('dim_region') }} r
       on r.system_book = coalesce(o.home_system_book, h.home_system_book)
      and r.region_id  = coalesce(o.region_id, h.home_region_id)
```
- [ ] **Step 4: 本地跑** `dbt build -s dim_lemeng_client+`（本地无湖时至少 `dbt parse` + 干跑 seed）
- [ ] **Step 5: 提交** `feat(data): 客户维 dim_lemeng_client——体系内门店自动匹配 + 受控覆盖（#1181）`

### Task 2: 战区出库面 `fct_outbound_region`

**Files:**
- Create: `dbt/models/lemeng/marts/fct_outbound_region.sql`
- Create: `dbt/tests/lemeng/audit_lemeng__outbound__region_conservation.sql`（守恒）
- Create: `dbt/tests/lemeng/assert_fct_outbound_region_grain_unique.sql`
- Modify: `dbt/models/lemeng/marts/schema.yml`

**Interfaces:**
- Produces: `fct_outbound_region(system_book, org, bizday, channel_type, region_l1_bucket, r_net, order_count, line_count)`
  - `channel_type ∈ {'自有门店配送','体系内批发','外部批发'}`
  - 粒度 = `(system_book, bizday, channel_type, region_l1_bucket)`

**要点：**
- 战区取法：`transfer` 用 `fct_hq_outbound.region_id`（门店战区）；`wholesale` 用 `dim_lemeng_client` 的 `home_system_book/home_region_id`（客户所在门店战区）；未匹配 ⇒ `region_l1_bucket='未归属'`。
- **不重算金额**：`r_net/order_count/line_count` 直接取自 `fct_hq_outbound` 后按新维度 sum。
- 空桶显式落 `未归属`（`coalesce(...,'未归属')`，同 `fct_contribution` 写法）。

- [ ] **Step 1: 守恒测试先写**（`Σ(fct_outbound_region.r_net)` 按 `system_book,bizday` == `Σ(fct_hq_outbound.r_net)`，1 分容差）
- [ ] **Step 2: 写模型**；整窗 `left join`，禁止 `inner`（丢行会静默少数）
- [ ] **Step 3: 粒度唯一性测试**
- [ ] **Step 4: 本地 `dbt build -s fct_outbound_region+`**
- [ ] **Step 5: 提交** `feat(data): 战区出库面 fct_outbound_region——配送/体系内批发/外部批发三分列（#1181）`

### Task 3: 指标声明 + 冒烟

**Files:** Modify `dbt/semantics/l1_metrics.yml`

- [ ] **Step 1:** 声明 `lemeng:outbound:region_net`（`expression: 'sum(fct_outbound_region.r_net)'`，grain `[system_book, bizday, region_l1_bucket, channel_type]`，`tier: experimental`，definition 写明「外部客户不摊战区」口径）
- [ ] **Step 2:** `pnpm exec tsx scripts/check-data-models.mjs` + `sync-data-semantics` 门禁
- [ ] **Step 3:** 真机 `query_metric` 冒烟（山海 `dep` 后）
- [ ] **Step 4: 提交** `feat(data): 战区出库指标声明（#1181）`

---

## Phase B — 批发明细下钻（#1182）

### Task 4: 直读湖视图 `vw_lemeng_wholesale_order_line`

**Files:** Create `dbt/models/lemeng/views/vw_lemeng_wholesale_order_line.sql`

- [ ] **Step 1:** 正文逐字取自 `stg_lemeng_wholesale_out.sql`（路径 `system_book=*/bizday=*/all.parquet`，**无 hour 分区、无封版断言**），只翻 `materialized='view'`
- [ ] **Step 2:** 列区由 `gen-data-projection.mjs` 按 `contracts/common/lemeng.wholesale_out.json` 生成（禁手写）
- [ ] **Step 3:** 两个 assert：视图 ↔ staging 闭窗日行数同源；空集空转绿守卫（照 `assert_vw_retail_order_line_matches_stg` 体例）
- [ ] **Step 4: 提交** `feat(data): 批发直读湖视图（#1182）`

### Task 5: 行级 measure + 指标三键 + 探针

- [ ] **Step 1（先做）: 退货符号探针**——取一天 `wholesale_return`，确认 `return_detail_money` / `total_money` 的正负号；结论写进 issue #1182（**未实证前不写退货侧声明**）
- [ ] **Step 2:** `measures` 增 `wholesale_line_amount@line`（`expr: 'sum(money)'`，`domain` 新增 `wholesale_out_line`，谓词取自现 fct 的行域：`state_code = 3`）
- [ ] **Step 3:** 声明 `lemeng:wholesale:order_line`（compose / dimensions 到 `order_no, order_detail_num, item_num` / `detail.relation: vw_lemeng_wholesale_order_line` / `detail.columns: cost, price → data:cost`）
- [ ] **Step 4:** `assert_drill_wholesale_order_line_matches_metric.sql`（下钻 ↔ 聚合同量，闭窗日，1 分容差）
- [ ] **Step 5: 提交** `feat(data): 批发明细下钻声明（#1182）`

### Task 6: 数据面链 + 冒烟

- [ ] `lemeng-sync.sh <全SHA>`（查 `# extra N`）→ 山海 manual deploy → 词表 job → materialize（**只认末行 `MATERIALIZE_OK`**）
- [ ] 真机 `query_detail` 冒烟：批发指标 + 明细列 + `data:cost` 有无两向
- [ ] 战区表冒烟：`query_metric` 按 `region_l1_bucket × channel_type`

## Verification

- `pnpm exec tsx scripts/check-data-models.mjs`、`check-data-plane-lock.mjs`、`gen-fct-measures.mjs --check` 全绿
- 守恒测试变异确认：手工改一行金额 ⇒ 红
- 真机：`Σ(战区) == Σ(出库)`、未映射金额 == 外部批发金额
