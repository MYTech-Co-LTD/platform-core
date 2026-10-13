-- audit_lemeng__inventory__money.sql — 库存金额指标的独立复算。
-- 契约与形态同 audit_lemeng__inventory__quantity.sql（那边写透了，不复制正文）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['storehouse_num']::bigint as storehouse_num,
        r['item_num']::bigint     as item_num,
        sum(r['inventory_money']::numeric)::numeric(20,2) as inv_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_inventory_snapshot_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4, 5
),
materialized as (
    select system_book, bizday, branch_num, storehouse_num, item_num, inventory_money
    from {{ ref('fct_inventory_snapshot') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.storehouse_num, b.storehouse_num) as storehouse_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.inv_money as recheck_value,
    b.inventory_money as materialized_value,
    '库存金额：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, storehouse_num, item_num)
where a.inv_money is distinct from b.inventory_money

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
