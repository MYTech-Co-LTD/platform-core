-- audit_lemeng__inventory__quantity.sql — 库存数量指标的独立复算。
-- 契约：dbt singular test 返回任何行即失败；空转自检防假绿。
-- 口径见 fct_inventory_snapshot.sql 头注。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['storehouse_num']::bigint as storehouse_num,
        r['item_num']::bigint     as item_num,
        sum(r['inventory_quantity']::numeric) as qty
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_inventory_snapshot_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4, 5
),
materialized as (
    select system_book, bizday, branch_num, storehouse_num, item_num, inventory_quantity
    from {{ ref('fct_inventory_snapshot') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.storehouse_num, b.storehouse_num) as storehouse_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.qty as recheck_value,
    b.inventory_quantity as materialized_value,
    '库存数量：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, storehouse_num, item_num)
where a.qty is distinct from b.inventory_quantity

union all

select
    null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
