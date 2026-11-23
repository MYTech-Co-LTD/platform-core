{{ config(materialized='table') }}
-- 生成物：scripts/gen-goal-achievement.mjs — 手改会被 --check 回写（改口径只改 dbt/semantics/goals.yml）
-- 目标：shanhai:monthly_store_sale（门店月度销售目标） 段①：stg_goal_values__monthly_store_sale  actuals：sale→fct_retail_sale.sale_amount / outbound→fct_branch_indicator.transfer_money
-- 件② 段② **PG 原生**：段① 表 ⨝ actuals marts ⨝ 日期 spine（纯 PG join；DuckDB 语句引用不了 PG
--   关系，探针 2026-11-23 实测 ⇒ 两段式是硬约束，不是风格）。
-- 口径：
--   · 同一 (period, 维度) 的多次提交取 submitted_at 最新（轮次内可改，D3 开放项 1：v1 无审批门）；
--   · target = 0 或缺失 ⇒ 达成率 NULL（照 data-analysis outbound 族的「新店无目标」处置，D5）；
--   · actual 缺失 ⇒ 0（该店该月无任何销售行 = 卖了 0，不是「不知道」）；
--   · progress_rate = 已过日历日 / 当月总天数（**北京时钟日界**；未来月份 0）；
--   · data_status = 当月 bizday 覆盖：complete（覆盖全部已过日）/ partial（>0）/ missing（0）。
-- 已知边界：actuals 按 branch_num 跨 system_book 汇总（多账套门店编号是否重叠未复核，见 goals.yml）。
with goal_latest as (
    select distinct on (period, branch_num)
        period,
        branch_num,
        target_sale,
        target_outbound,
        bizday as collected_bizday,
        submitted_at,
        submission_id
    from {{ ref('stg_goal_values__monthly_store_sale') }}
    where period ~ '^[0-9]{4}-[0-9]{2}$'
      and branch_num is not null and branch_num <> ''
    order by period, branch_num, submitted_at desc nulls last, submission_id desc
),
goal as (
    select
        (g.period || '-01')::date as bizday,
        g.period,
        g.branch_num,
        g.target_sale,
        g.target_outbound,
        g.collected_bizday,
        (g.period || '-01')::date as first_day,
        ((g.period || '-01')::date + interval '1 month - 1 day')::date as last_day
    from goal_latest g
),
actual_sale as (
    select
        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,
        f.branch_num::text as branch_num,
        sum(f.sale_amount)::numeric(20,4) as actual_sale
    from {{ ref('fct_retail_sale') }} f
    where f.bizday >= (select min(first_day) from goal)
      and f.bizday <= (select max(last_day) from goal)
    group by 1, 2
),
actual_outbound as (
    select
        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,
        f.branch_num::text as branch_num,
        sum(f.transfer_money)::numeric(20,4) as actual_outbound
    from {{ ref('fct_branch_indicator') }} f
    where f.bizday >= (select min(first_day) from goal)
      and f.bizday <= (select max(last_day) from goal)
    group by 1, 2
),
coverage as (
    -- data_status 的数据完整度面：按 (period, 维度) 数当月有零售行的 bizday 数。
    select
        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,
        f.branch_num::text as branch_num,
        count(distinct f.bizday) as covered_days
    from {{ ref('fct_retail_sale') }} f
    where f.bizday >= (select min(first_day) from goal)
      and f.bizday <= (select max(last_day) from goal)
    group by 1, 2
),
spine as (
    select
        g.bizday,
        g.period,
        g.branch_num,
        g.target_sale,
        g.target_outbound,
        g.collected_bizday,
        (g.last_day - g.first_day + 1) as total_days,
        greatest(least((now() at time zone 'Asia/Shanghai')::date, g.last_day) - g.first_day + 1, 0) as days_elapsed
    from goal g
)
select
    {{ subject_org() }} as org,
    g.bizday,
    g.period,
    g.branch_num,
    g.collected_bizday,
    g.target_sale,
    g.target_outbound,
    coalesce(a_sale.actual_sale, 0) as actual_sale,
    case when g.target_sale > 0 then round(coalesce(a_sale.actual_sale, 0) / g.target_sale, 4) end as sale_achievement_rate,
    coalesce(a_outbound.actual_outbound, 0) as actual_outbound,
    case when g.target_outbound > 0 then round(coalesce(a_outbound.actual_outbound, 0) / g.target_outbound, 4) end as outbound_achievement_rate,
    g.days_elapsed,
    g.total_days,
    round(g.days_elapsed::numeric / g.total_days, 4) as progress_rate,
    case
        when coalesce(c.covered_days, 0) >= g.days_elapsed then 'complete'
        when coalesce(c.covered_days, 0) > 0 then 'partial'
        else 'missing'
    end as data_status
from spine g
left join actual_sale a_sale using (period, branch_num)
left join actual_outbound a_outbound using (period, branch_num)
left join coverage c using (period, branch_num)
order by g.period, g.branch_num
