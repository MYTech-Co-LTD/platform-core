-- audit_lemeng__purchase__supplier_count.sql — 采购供应商数 的独立复算（#640）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防假绿。
-- 复算直读 parquet（不复用 staging/fct），粒度 = (system_book, bizday)，distinct 供应商。
with recheck as (
    select
        t.system_book, t.bizday,
        count(distinct t.supplier_num)::numeric(20,2) as v
    from (
        select
            r['system_book']::varchar as system_book,
            r['bizday']::date         as bizday,
            r['supplier_num']::bigint        as supplier_num
        from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet') r
        where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    ) t
    group by 1, 2
),
materialized as (
    select system_book, bizday, count(distinct supplier_num)::numeric(20,2) as v
    from {{ ref('fct_purchase') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    null as supplier_num,
    null as item_num,
    a.v as recheck_value,
    b.v as materialized_value,
    '采购供应商数：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday)
where a.v is distinct from b.v

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
