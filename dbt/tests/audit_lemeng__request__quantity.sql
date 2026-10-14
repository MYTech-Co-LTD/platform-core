-- audit_lemeng__request__quantity.sql — 要货数量指标的独立复算（#677）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防假绿。
-- 复算直接打 parquet、不 ref staging（骨架同族；口径与边界见 fct_request_fulfillment.sql 头注）。
-- 本文件比较的是：requested_quantity（D15 侧；「有效要货行」= quantity > 0）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::bigint     as item_num,
        sum(r['quantity']::numeric(20,6)) as requested_quantity  -- 裸 ::numeric 默认 3 位小数（cast 即舍入）⇒ 必须带显式刻度
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_request_order_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['quantity']::numeric(20,6) > 0
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
materialized as (
    select system_book, bizday, branch_num, item_num, requested_quantity
    from {{ ref('fct_request_fulfillment') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.requested_quantity as recheck_value,
    b.requested_quantity as materialized_value,
    '要货数量：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where a.requested_quantity is distinct from b.requested_quantity

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
