{{ config(tags=['audit'], store_failures=true) }}
-- audit_lemeng__goal__monthly_store_sale_outbound_progress_rate.sql — 指标
-- `lemeng:goal:monthly_store_sale_outbound_progress_rate` 的对账（件② #2708）。
--
-- 时间进度没有「外部真值关系」可复算（它只由日历决定）⇒ 本审计断言的是**不变量**，
-- 而不是像达成率那样重打湖与 fct 求合计：
--   · 只对**已封版月份**（period < 上海今天所在月）：时间进度恒为 1（days_elapsed = total_days）；
--   · days_elapsed ∈ [0, total_days]，且 progress_rate 与 days_elapsed / total_days 自洽；
--   · data_status 落在三态闭集（complete / partial / missing）；
--   · 达成率 null 性自洽：target ≤ 0 或 NULL ⇒ 达成率必须 NULL（新店无目标，D5）。
-- 当月（未封版）不在此判：进度随日历走，按天比对只会产出噪声（与 audit_until_date 同一取舍）。
-- 返回任何行即失败。
with closed as (
    select *
    from {{ ref('mart_goal_achievement__monthly_store_sale') }}
    where period < to_char({{ shanghai_today() }}, 'YYYY-MM')
)
select
    period,
    branch_num,
    progress_rate,
    days_elapsed,
    total_days,
    data_status,
    '时间进度不变量不成立（lemeng:goal:monthly_store_sale_outbound_progress_rate，#2708）' as note
from closed
where progress_rate is distinct from 1
   or days_elapsed <> total_days
   or days_elapsed < 0
   or days_elapsed > total_days
   or data_status not in ('complete', 'partial', 'missing')
   or ((target_outbound is null or target_outbound <= 0) and outbound_achievement_rate is not null)
