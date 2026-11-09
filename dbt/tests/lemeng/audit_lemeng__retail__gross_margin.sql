{{ config(store_failures=true, tags=['audit_window']) }}
-- audit_lemeng__retail__gross_margin.sql — 指标 `lemeng:retail:gross_margin` 的独立复算（对账）。
-- 毛利率 = profit_money_no_coupon / sale_money_no_coupon（零分母 → null，不适用）。
-- 独立打 parquet；容差 0.0001（万分之一）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        sum(r['profit_money_no_coupon']::decimal(38,10))::numeric(20,2) as profit,
        sum(r['sale_money_no_coupon']::decimal(38,10))::numeric(20,2)   as sale
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_profit_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and r['bizday']::date >= date '{{ window_start_date() }}'
    group by 1, 2, 3
),
materialized as (
    select
        system_book,
        bizday,
        branch_num,
        profit_money_no_coupon as profit,
        sale_money_no_coupon   as sale
    from {{ ref('fct_retail_profit') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= date '{{ window_start_date() }}'
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    case when a.sale is not null and a.sale <> 0 then round(a.profit / a.sale, 6) end as recheck_value,
    case when b.sale is not null and b.sale <> 0 then round(b.profit / b.sale, 6) end as materialized_value,
    '零售毛利率（不含券）：复算与物化结果不一致' as note,
    0.0001::numeric                        as tolerance
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.sale is not null and a.sale <> 0
  and b.sale is not null and b.sale <> 0
  and abs(a.profit / a.sale - b.profit / b.sale) > 0.0001

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）',
    null::numeric
where not exists (select 1 from materialized)
