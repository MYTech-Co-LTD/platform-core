-- audit_lemeng__purchase__return_amount.sql — 采购退货金额 的独立复算（#640）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防假绿（对账落在空集上「通过」不是对上了）。
-- 复算直读 parquet（不复用 staging/fct），粒度 = (system_book, bizday, supplier_num, item_num)。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['supplier_num']::bigint as supplier_num,
        r['item_num']::bigint     as item_num,
        sum(r['purchase_item_return_money']::numeric)::numeric(20,2) as v
    from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet') r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
materialized as (
    select
        system_book, bizday, supplier_num, item_num,
        purchase_item_return_money::numeric(20,2) as v
    from {{ ref('fct_purchase') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.supplier_num, b.supplier_num) as supplier_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.v as recheck_value,
    b.v as materialized_value,
    '采购退货金额：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, supplier_num, item_num)
where a.v is distinct from b.v

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
