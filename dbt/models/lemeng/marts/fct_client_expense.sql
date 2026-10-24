{{
    config(materialized='table')
}}
-- fct_client_expense.sql — 客户费用构件（W2 2026-10-13）。粒度 (system_book, bizday, client_fid, other_inout_kind)。
-- 【构件列（E 的客户面）】ep = Σ amount where flag=false（应付）；er = Σ where flag=true（应收）；
--   e_net = ep − er（符号语义待裁9）。金额保留红字。其余同 fct_branch_expense。
--
-- ── 影子列（聚合面组件化 P3.3 影子波 Task 3，issue #1031）────────────────────────────────
-- `agg` 的 ep/er 两列是**旧实现**（手写 case-when 判别式，逐字未动）；生成区里的
-- `client_ep_payable__gen` / `client_er_receivable__gen` 是同一口径的 measure 编译版（expr =
-- `sum(coalesce(other_inout_money, 0))`，方向过滤上移到基面 domain，由 `scripts/gen-fct-measures.mjs`
-- 生成——改声明后重跑生成器）。CTE 名带 client_ 族前缀：measures 是扁平命名空间，门店费用族已占
-- `ep_payable@flat` / `er_receivable@flat`，同名键会静默覆盖其声明；前缀由最终 SELECT 的别名剥掉，
-- 影子列仍叫 `ep_payable__gen` / `er_receivable__gen`（跟旧列名走）。本阶段只**并行输出**、
-- 任何消费方都不许读；切换要等影子对账
-- `dbt/tests/lemeng/assert_fct_client_expense_measure_shadow_parity.sql` 稳定后另开笔。
-- 单侧缺行（该客户当日只有应付 / 只有应收）⇒ 该侧 `coalesce(…, 0)` 归零，与旧列同形。
-- `e_net` **无影子**：净费用不属任何单一 measure（与 retail 的 net_amount 同款判例），仍由旧两列相减。
with agg as (
    select
        system_book,
        bizday,
        client_fid,
        other_inout_kind,
        sum(case when other_inout_flag = false then coalesce(other_inout_money, 0) else 0 end)::numeric(20,2) as ep_payable,
        sum(case when other_inout_flag = true then coalesce(other_inout_money, 0) else 0 end)::numeric(20,2) as er_receivable
    from {{ ref('stg_lemeng_client_expense') }}
    group by 1, 2, 3, 4
),
-- BEGIN GENERATED MEASURES
-- ⚠️ 本区由 scripts/gen-fct-measures.mjs 从 dbt/semantics/l1_metrics.yml 生成，**别手改**：
--    基面的 where 由组件 domain 派生、两阶段聚合由 measure 编译而来。改声明 → 重跑生成器 → 一并提交；
--    CI 的 `pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对本区，手改即红。
base_payable as (
    select * from {{ ref('stg_lemeng_client_expense') }}
    where other_inout_flag = false
),
client_ep_payable__gen as (
    select system_book, bizday, client_fid, other_inout_kind, sum(coalesce(other_inout_money, 0))::numeric(20,2) as client_ep_payable__gen from base_payable group by 1, 2, 3, 4
),
base_receivable as (
    select * from {{ ref('stg_lemeng_client_expense') }}
    where other_inout_flag = true
),
client_er_receivable__gen as (
    select system_book, bizday, client_fid, other_inout_kind, sum(coalesce(other_inout_money, 0))::numeric(20,2) as client_er_receivable__gen from base_receivable group by 1, 2, 3, 4
),
gen_agg as (
    select
        coalesce(client_ep_payable__gen.system_book, client_er_receivable__gen.system_book) as system_book,
        coalesce(client_ep_payable__gen.bizday, client_er_receivable__gen.bizday) as bizday,
        coalesce(client_ep_payable__gen.client_fid, client_er_receivable__gen.client_fid) as client_fid,
        coalesce(client_ep_payable__gen.other_inout_kind, client_er_receivable__gen.other_inout_kind) as other_inout_kind,
        client_ep_payable__gen.client_ep_payable__gen,
        client_er_receivable__gen.client_er_receivable__gen
    from client_ep_payable__gen
    full join client_er_receivable__gen
        on  client_ep_payable__gen.system_book = client_er_receivable__gen.system_book
        and client_ep_payable__gen.bizday = client_er_receivable__gen.bizday
        and client_ep_payable__gen.client_fid = client_er_receivable__gen.client_fid
        and client_ep_payable__gen.other_inout_kind = client_er_receivable__gen.other_inout_kind
)
-- END GENERATED MEASURES
-- ⚠️ 逗号只能落在标记区**外**（区内逐字节受 `--check` 管），故单独起一行。
,
-- 单数面保持**手写**（不属任何 measure）：直读 staging、不过生成区基面——
-- base_payable / base_receivable 各自排掉另一方向的行，在它们上面数单数会静默少单。
bill_count_cte as (
    select
        system_book,
        bizday,
        client_fid,
        other_inout_kind,
        count(distinct other_inout_bill_no) as bill_count
    from {{ ref('stg_lemeng_client_expense') }}
    group by 1, 2, 3, 4
)
select
    agg.system_book,
    {{ subject_org() }} as org,
    agg.bizday,
    agg.client_fid,
    agg.other_inout_kind,
    agg.ep_payable,
    agg.er_receivable,
    (agg.ep_payable - agg.er_receivable)::numeric(20,2) as e_net,
    bill_count_cte.bill_count,
    coalesce(gen_agg.client_ep_payable__gen, 0)::numeric(20,2) as ep_payable__gen,
    coalesce(gen_agg.client_er_receivable__gen, 0)::numeric(20,2) as er_receivable__gen
from agg
-- 行集不变：驱动基面 `agg` = 旧实现的全量分组（行集由 `assert_fct_client_expense_grain_unique.sql`
-- 钉住）；gen_agg 的行域是它的子集（应付/应收各占一边）⇒ 两个 left join 都不增删最终行。
left join gen_agg
    on  agg.system_book = gen_agg.system_book
    and agg.bizday = gen_agg.bizday
    and agg.client_fid = gen_agg.client_fid
    and agg.other_inout_kind = gen_agg.other_inout_kind
left join bill_count_cte
    on  agg.system_book = bill_count_cte.system_book
    and agg.bizday = bill_count_cte.bizday
    and agg.client_fid = bill_count_cte.client_fid
    and agg.other_inout_kind = bill_count_cte.other_inout_kind
