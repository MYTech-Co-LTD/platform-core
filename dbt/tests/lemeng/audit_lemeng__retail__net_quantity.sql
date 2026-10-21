-- audit_lemeng__retail__net_quantity.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「销售数量 / 退货数量 / 净销量」三列，不只是净销量——W1 的教训：两侧同值 0 时
-- 比较 0 vs 0 等于没验。本指标真机上销售≈71 万、退货≈9.8 千，都有区分度。
-- ⚠️ 两侧**都**滤掉今天：今天的文件正被 5 分钟一班的 tick 重写（ETag 竞态，2026-10-06 实测）。
with base as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::varchar    as item_num,
        case when r['order_transaction_type']::varchar = 'SALE_ORDER' and r['state']::varchar = 'FINISHED'
             then r['quantity']::numeric else 0 end as sale_quantity,
        case when r['order_transaction_type']::varchar like '%RETURN%'
                  and r['state']::varchar in ('FINISHED', 'REPAID')
             then r['quantity']::numeric else 0 end as return_quantity
    from read_parquet(
        -- ⚠️ 与 staging **同路径**（通配两账套）——对账必须与受测面同口径，否则只对账了 3120（issue #250）。
        ARRAY['s3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAY_DATA/system_book=*/bizday=*/all.parquet', 's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet']::text[]
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
recheck as (
    select
        system_book, bizday, branch_num, item_num,
        sum(sale_quantity)::numeric(20, 3)                          as sale_quantity,
        sum(return_quantity)::numeric(20, 3)                        as return_quantity,
        (sum(sale_quantity) - sum(return_quantity))::numeric(20, 3) as net_quantity
    from base
    group by 1, 2, 3, 4
),
materialized as (
    select system_book, bizday, branch_num, item_num,
           sum(sale_quantity)::numeric(20, 3)  as sale_quantity,
           sum(return_quantity)::numeric(20, 3) as return_quantity,
           sum(net_quantity)::numeric(20, 3)   as net_quantity
    from {{ ref('fct_retail_quantity') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.sale_quantity as recheck_sale, b.sale_quantity as materialized_sale,
    a.return_quantity as recheck_return, b.return_quantity as materialized_return,
    a.net_quantity as recheck_net, b.net_quantity as materialized_net,
    '零售净销量：复算与物化不一致（销售/退货/净销量三列各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where a.sale_quantity is distinct from b.sale_quantity
   or a.return_quantity is distinct from b.return_quantity
   or a.net_quantity is distinct from b.net_quantity

union all

select null, null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null, null, null,
    '物化侧销售与退货全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where sale_quantity <> 0 or return_quantity <> 0)
