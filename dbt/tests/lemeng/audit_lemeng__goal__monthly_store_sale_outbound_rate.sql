{{ config(tags=['audit'], store_failures=true) }}
-- audit_lemeng__goal__monthly_store_sale_outbound_rate.sql — 指标
-- `lemeng:goal:monthly_store_sale_outbound_rate` 的**独立复算**（对账，件② #2708）。
--
-- 口径与边界（封版月、T-3 窗口、空集合法）**逐字同** sale 侧那条：
--   dbt/tests/lemeng/audit_lemeng__goal__monthly_store_sale_sale_rate.sql 头注。
-- 差异只有两处：目标字段 = `target_outbound`；实际值 = `fct_branch_indicator.transfer_money`
-- （D10 门店配送金额 = 出库金额的门店级可加腿；`lemeng:outbound:amount` 无门店维，按店 join 不成立）。
with recheck_goal as (
    select
        json_extract_string(r['payload'], '$.period') as period,
        json_extract_string(r['payload'], '$.branch_num') as branch_num,
        cast(json_extract_string(r['payload'], '$.target_outbound') as decimal(38,10)) as target_outbound,
        r['submitted_at']::timestamptz as submitted_at,
        r['submission_id']::bigint as submission_id
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
    ) r
    where r['form_def_id'] = 'goal-monthly-store'
      and r['bizday']::date < {{ audit_until_date() }}
      and json_extract_string(r['payload'], '$.period') < {{ compile_time_month() }}
),
goal_latest as (
    -- 取每 (period, 门店) 最新一次提交。**不能写 DISTINCT ON**：本文件整条路由进 DuckDB
    -- （含 read_parquet），DuckDB 没有 DISTINCT ON（#2750 真机）；row_number 两引擎都支持。
    select period, branch_num, target_outbound
    from (
        select
            period, branch_num, target_outbound,
            row_number() over (
                partition by period, branch_num
                order by submitted_at desc nulls last, submission_id desc
            ) as rn
        from recheck_goal
        where period ~ '^[0-9]{4}-[0-9]{2}$'
          and branch_num is not null
          and branch_num <> ''
    ) t
    where rn = 1
),
recheck_actual as (
    select
        strftime(date_trunc('month', f.bizday), '%Y-%m') as period,
        f.branch_num::text as branch_num,
        sum(f.transfer_money)::numeric(20,4) as actual_outbound
    from {{ ref('fct_branch_indicator') }} f
    where f.system_book = '3120'
      and f.bizday >= (select min((period || '-01')::date) from goal_latest)
      and f.bizday <= (select max(((period || '-01')::date + interval '1 month' - interval '1 day')::date) from goal_latest)
      and f.bizday < {{ audit_until_date() }}
      and strftime(date_trunc('month', f.bizday), '%Y-%m') < {{ compile_time_month() }}
    group by 1, 2
),
recheck as (
    select
        sum(coalesce(a.actual_outbound, 0))::numeric(20,4) as actual_v,
        sum(g.target_outbound)::numeric(20,4) as target_v
    from goal_latest g
    left join recheck_actual a using (period, branch_num)
),
materialized as (
    select
        sum(actual_outbound)::numeric(20,4) as actual_v,
        sum(target_outbound)::numeric(20,4) as target_v
    from {{ ref('mart_goal_achievement__monthly_store_sale') }}
    where collected_bizday < {{ audit_until_date() }}
      and period < {{ compile_time_month() }}
)
select
    a.actual_v as recheck_actual,
    b.actual_v as materialized_actual,
    a.target_v as recheck_target,
    b.target_v as materialized_target,
    '复算与物化不一致（lemeng:goal:monthly_store_sale_outbound_rate，#2708）' as note
from recheck a
cross join materialized b
where abs(coalesce(a.actual_v, 0) - coalesce(b.actual_v, 0)) > 0.01
   or abs(coalesce(a.target_v, 0) - coalesce(b.target_v, 0)) > 0.01
