-- audit_lemeng__purchase__zero_amount_rows.sql — 指标的**独立复算**（对账；聚合面与 fct_purchase 同构，
-- 但**直接打 parquet、不 ref staging**——复算若走 staging，cast 错会同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败。空转自检防「空集上的假绿」。
-- 本文件比较的是：零金额采购行数 = COUNT(购入数量 > 0 且 购入金额 = 0)。
-- ⚠️ 用 `sum(case …)` 而不是 `count(*) filter (…)`：与声明里的表达式逐字同形，两侧只差数据源。
with src as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['purchase_item_amount']::numeric(14, 6) as purchase_amount,
        r['purchase_item_money']::numeric(14, 2)  as purchase_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet'
    ) r
),
recheck as (
    select
        system_book,
        bizday,
        sum(case when purchase_amount > 0 and purchase_money = 0 then 1 else 0 end) as zero_rows
    from src
    group by 1, 2
),
materialized as (
    select
        system_book,
        bizday,
        sum(case when purchase_item_amount > 0 and purchase_item_money = 0 then 1 else 0 end) as zero_rows
    from {{ ref('fct_purchase') }}
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.zero_rows as recheck_value,
    b.zero_rows as materialized_value,
    '零金额采购行数：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday)
where a.zero_rows is distinct from b.zero_rows

union all

select
    null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
