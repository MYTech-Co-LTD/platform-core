{{ config(tags=['audit'], store_failures=true) }}
-- audit_lemeng__goal__monthly_store_sale_sale_achievement_rate.sql — 指标
-- `lemeng:goal:monthly_store_sale_sale_achievement_rate` 的**独立复算**（对账，件② #2708）。
--
-- 契约：dbt singular test 返回任何行即失败；失败行落
--   `<目标 schema>_dbt_test_failures.audit_lemeng__goal__monthly_store_sale_sale_achievement_rate`。
--
-- 独立复算 = **不读达成模型的 join/达成率列**，而是：
--   分子（实际）= 直接打 `fct_retail_sale` 按 (period, 门店) 重加 sale_amount；
--   分母（目标）= 直接打 forms 提交湖 parquet、payload 逐字重提取 + 重 cast（错误的 cast 只有这条能抓），
--                 同 (period, 门店) 取 submitted_at 最新的那次提交。
--   两侧都只算**已封版月份**的合计，比较 Σactual 与 Σtarget（比比较比率更硬：分母错也抓得到）。
--
-- 为什么只比「已封版月份」（period < 上海今天所在月）：
--   · 当月实际值仍在被 tick 每小时重写（`audit_until_date` 的同一根因，2026-11-18 #2481 实测）；
--   · 封版 = 天然固化（spec D6）：月度目标在月结束后不再变。
--   当月的数据完整度由关系里的 `data_status` / 报表负责，不用对账兜。
--
-- ★ 已知边界（如实披露）：目标值若在 **T-3 窗口内**被更正，物化侧（取最新提交）与复算侧
--   （只读 bizday < audit_until_date 的提交）会取到不同的版本 ⇒ 判红。这是「对账滞后窗口」的
--   既有语义（同 audit_lemeng__* 全族），处置 = 等窗口滑过；不是目标件独有的缺陷。
--
-- ★ 空集是合法初态（与 forms 侧 audit 同旨，**勿照抄** lemeng「空转绿」红线）：
--   表单刚发布、提交还没采集进湖时两侧都空（聚合 NULL → coalesce 0）⇒ 静默通过；
--   非对称空（复算有值 / 物化空，或反之）会被差值判据抓住 ⇒ 仍然响亮。
--
-- ★ 中间 cast 用 `decimal(38,10)`（DuckDB 裸 numeric=DECIMAL(18,3)，#761 两轮实测）。
with recheck_goal as (
    select
        json_extract_string(r['payload'], '$.period') as period,
        json_extract_string(r['payload'], '$.branch_num') as branch_num,
        cast(json_extract_string(r['payload'], '$.target_sale') as decimal(38,10)) as target_sale,
        r['submitted_at']::timestamptz as submitted_at,
        r['submission_id']::bigint as submission_id
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
    ) r
    where r['form_def_id'] = 'goal-monthly-store'
      and r['bizday']::date < {{ audit_until_date() }}
      and json_extract_string(r['payload'], '$.period') < to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM')
),
goal_latest as (
    select distinct on (period, branch_num)
        period, branch_num, target_sale
    from recheck_goal
    where period ~ '^[0-9]{4}-[0-9]{2}$'
      and branch_num is not null
      and branch_num <> ''
    order by period, branch_num, submitted_at desc nulls last, submission_id desc
),
recheck_actual as (
    select
        to_char(date_trunc('month', f.bizday), 'YYYY-MM') as period,
        f.branch_num::text as branch_num,
        sum(f.sale_amount)::numeric(20,4) as actual_sale
    from {{ ref('fct_retail_sale') }} f
    where f.bizday >= (select min((period || '-01')::date) from goal_latest)
      and f.bizday <= (select max(((period || '-01')::date + interval '1 month - 1 day')::date) from goal_latest)
      and f.bizday < {{ audit_until_date() }}
      and to_char(date_trunc('month', f.bizday), 'YYYY-MM') < to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM')
    group by 1, 2
),
recheck as (
    select
        sum(coalesce(a.actual_sale, 0))::numeric(20,4) as actual_v,
        sum(g.target_sale)::numeric(20,4) as target_v
    from goal_latest g
    left join recheck_actual a using (period, branch_num)
),
materialized as (
    select
        sum(actual_sale)::numeric(20,4) as actual_v,
        sum(target_sale)::numeric(20,4) as target_v
    from {{ ref('mart_goal_achievement__monthly_store_sale') }}
    where collected_bizday < {{ audit_until_date() }}
      and period < to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM')
)
select
    a.actual_v as recheck_actual,
    b.actual_v as materialized_actual,
    a.target_v as recheck_target,
    b.target_v as materialized_target,
    '复算与物化不一致（lemeng:goal:monthly_store_sale_sale_achievement_rate，#2708）' as note
from recheck a
cross join materialized b
where abs(coalesce(a.actual_v, 0) - coalesce(b.actual_v, 0)) > 0.01
   or abs(coalesce(a.target_v, 0) - coalesce(b.target_v, 0)) > 0.01
