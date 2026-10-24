{{
    config(materialized='table')
}}
-- fct_branch_expense.sql — 门店费用构件（W2 2026-10-13；口径在 ④ 定义一次）。
-- 【粒度】(system_book, bizday, branch_num, expense_type)——可上卷到店日。
-- 【构件列（客户公共定义 E 的门店面）】
--   ep_payable = Σ amount where direction='应付'；er_receivable = Σ amount where direction='应收'；
--   e_net = ep − er（净费用；**符号语义待裁9 客户回签**）。金额保留红字；null 不当 0（客户统一控制）。
-- 【单据口径】全部采集行（管线请求侧已筛 state_code=3 审核态）；bill_no 去重计数作单数面。
-- 【org / 精度】同 fct_hq_outbound。
--
-- ── 影子列（聚合面组件化 P3.3 影子波 Task 2，issue #1031）────────────────────────────────
-- `agg` 的 ep/er 两列是**旧实现**（手写 case-when 判别式，逐字未动）；生成区里的
-- `ep_payable__gen` / `er_receivable__gen` 是同一口径的 measure 编译版（expr =
-- `sum(coalesce(amount, 0))`，方向过滤上移到基面 domain，由 `scripts/gen-fct-measures.mjs`
-- 生成——改声明后重跑生成器）。本阶段只**并行输出**、任何消费方都不许读；切换要等影子对账
-- `dbt/tests/lemeng/assert_fct_branch_expense_measure_shadow_parity.sql` 稳定后另开笔。
-- 单侧缺行（该费用项目当日只有应付 / 只有应收）⇒ 该侧 `coalesce(…, 0)` 归零，与旧列同形。
-- `e_net` **无影子**：净费用不属任何单一 measure（与 retail 的 net_amount 同款判例），仍由旧两列相减。
with agg as (
    select
        system_book,
        bizday,
        branch_num,
        expense_type,
        sum(case when direction = '应付' then coalesce(amount, 0) else 0 end)::numeric(20,2) as ep_payable,
        sum(case when direction = '应收' then coalesce(amount, 0) else 0 end)::numeric(20,2) as er_receivable
    from {{ ref('stg_lemeng_branch_expense') }}
    group by 1, 2, 3, 4
),
-- BEGIN GENERATED MEASURES
-- ⚠️ 本区由 scripts/gen-fct-measures.mjs 从 dbt/semantics/l1_metrics.yml 生成，**别手改**：
--    基面的 where 由组件 domain 派生、两阶段聚合由 measure 编译而来。改声明 → 重跑生成器 → 一并提交；
--    CI 的 `pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对本区，手改即红。
base_payable as (
    select * from {{ ref('stg_lemeng_branch_expense') }}
    where direction = '应付'
),
ep_payable__gen as (
    select system_book, bizday, branch_num, expense_type, sum(coalesce(amount, 0))::numeric(20,2) as ep_payable__gen from base_payable group by 1, 2, 3, 4
),
base_receivable as (
    select * from {{ ref('stg_lemeng_branch_expense') }}
    where direction = '应收'
),
er_receivable__gen as (
    select system_book, bizday, branch_num, expense_type, sum(coalesce(amount, 0))::numeric(20,2) as er_receivable__gen from base_receivable group by 1, 2, 3, 4
),
gen_agg as (
    select
        coalesce(ep_payable__gen.system_book, er_receivable__gen.system_book) as system_book,
        coalesce(ep_payable__gen.bizday, er_receivable__gen.bizday) as bizday,
        coalesce(ep_payable__gen.branch_num, er_receivable__gen.branch_num) as branch_num,
        coalesce(ep_payable__gen.expense_type, er_receivable__gen.expense_type) as expense_type,
        ep_payable__gen.ep_payable__gen,
        er_receivable__gen.er_receivable__gen
    from ep_payable__gen
    full join er_receivable__gen
        on  ep_payable__gen.system_book = er_receivable__gen.system_book
        and ep_payable__gen.bizday = er_receivable__gen.bizday
        and ep_payable__gen.branch_num = er_receivable__gen.branch_num
        and ep_payable__gen.expense_type = er_receivable__gen.expense_type
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
        branch_num,
        expense_type,
        count(distinct bill_no) as bill_count
    from {{ ref('stg_lemeng_branch_expense') }}
    group by 1, 2, 3, 4
)
select
    agg.system_book,
    {{ subject_org() }} as org,
    agg.bizday,
    agg.branch_num,
    agg.expense_type,
    agg.ep_payable,
    agg.er_receivable,
    (agg.ep_payable - agg.er_receivable)::numeric(20,2) as e_net,
    bill_count_cte.bill_count,
    coalesce(gen_agg.ep_payable__gen, 0)::numeric(20,2) as ep_payable__gen,
    coalesce(gen_agg.er_receivable__gen, 0)::numeric(20,2) as er_receivable__gen
from agg
-- 行集不变：驱动基面 `agg` = 旧实现的全量分组（行集由 `assert_fct_branch_expense_grain_unique.sql`
-- 钉住）；gen_agg 的行域是它的子集（应付/应收各占一边）⇒ 两个 left join 都不增删最终行。
left join gen_agg
    on  agg.system_book = gen_agg.system_book
    and agg.bizday = gen_agg.bizday
    and agg.branch_num = gen_agg.branch_num
    and agg.expense_type = gen_agg.expense_type
left join bill_count_cte
    on  agg.system_book = bill_count_cte.system_book
    and agg.bizday = bill_count_cte.bizday
    and agg.branch_num = bill_count_cte.branch_num
    and agg.expense_type = bill_count_cte.expense_type
