{{ config(store_failures=true, tags=['audit_window']) }}
-- audit_lemeng__retail__item_profit.sql — 指标 `lemeng:retail:item_profit` 的独立复算。
--
-- 直接打 item_profit parquet（不 ref staging / 不 ref mart），按门店×日×商品复算；
-- 与 fct_retail_item_profit 各自 cast/聚合，避免同一份 cast 污染两边。
-- 容差 0.01（金额两位小数）。
with recheck as (
    select
        r['system_book']::int as system_book,
        r['bizday']::date     as bizday,
        r['branch_num']::int  as branch_num,
        r['item_num']::int    as item_num,
        sum(r['profit_money_no_coupon']::decimal(38,10))::numeric(20,2) as profit
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_profit_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and r['bizday']::date >= date '{{ window_start_date() }}'
    group by 1, 2, 3, 4
),
materialized as (
    select system_book, bizday, branch_num, item_num, profit_money_no_coupon as profit
    from {{ ref('fct_retail_item_profit') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= date '{{ window_start_date() }}'
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.profit                               as recheck_value,
    b.profit                               as materialized_value,
    '零售商品毛利（不含券）：复算与物化结果不一致' as note,
    0.01::decimal(20,2)                    as tolerance
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where abs(coalesce(a.profit, 0) - coalesce(b.profit, 0)) > 0.01

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）',
    null::numeric
where not exists (select 1 from materialized)
