-- audit_lemeng__inventory__coverage_days.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「库存数量 / 月日均 / 月累计」三列，不只是比率（W1 的教训：两侧同值 0 时
-- 比较 0 vs 0 等于没验）。库存真机上有值、月日均在多数 (店,商品) 上为正，都有区分度。
-- ⚠️ `avg_daily_net_quantity` **可为 NULL**（净销量≤0 时「不适用」）——用 `is distinct from`
--   比较，NULL 与 NULL 视为一致；不能用 coalesce（那会把 NULL 和 0 混为一谈）。
with inv as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::varchar    as item_num,
        sum(r['inventory_quantity']::numeric)::numeric(20, 3) as inventory_quantity
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_inventory_snapshot_prefix") }}/*/bizday=**/*.parquet'
    ) r
    group by 1, 2, 3, 4
),
qty as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::varchar    as item_num,
        sum(case when r['order_transaction_type']::varchar = 'SALE_ORDER' and r['state']::varchar = 'FINISHED'
                 then r['quantity']::numeric else 0 end
          - case when r['order_transaction_type']::varchar like '%RETURN%'
                      and r['state']::varchar in ('FINISHED', 'REPAID')
                 then r['quantity']::numeric else 0 end)::numeric(20, 3) as net_quantity
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
mtd as (
    select
        system_book, bizday, branch_num, item_num,
        sum(net_quantity) over (
            partition by system_book, branch_num, item_num, date_trunc('month', bizday)
            order by bizday
            rows between unbounded preceding and current row
        )::numeric(20, 3) as mtd_net_quantity
    from qty
),
recheck as (
    select
        i.system_book, i.bizday, i.branch_num, i.item_num,
        i.inventory_quantity,
        coalesce(m.mtd_net_quantity, 0)::numeric(20, 3) as mtd_net_quantity,
        case
            when coalesce(m.mtd_net_quantity, 0) > 0 and extract(day from i.bizday) > 0
            then (coalesce(m.mtd_net_quantity, 0) / extract(day from i.bizday))::numeric(20, 6)
            else null
        end as avg_daily_net_quantity
    from inv i
    left join mtd m
           on m.system_book = i.system_book
          and m.bizday = i.bizday
          and m.branch_num = i.branch_num
          and m.item_num = i.item_num
),
materialized as (
    select system_book, bizday, branch_num, item_num,
           sum(inventory_quantity)::numeric(20, 3)  as inventory_quantity,
           sum(mtd_net_quantity)::numeric(20, 3)    as mtd_net_quantity,
           sum(avg_daily_net_quantity)::numeric(20, 6) as avg_daily_net_quantity
    from {{ ref('fct_inventory_coverage') }}
    group by 1, 2, 3, 4
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.inventory_quantity as recheck_inv, b.inventory_quantity as materialized_inv,
    a.mtd_net_quantity as recheck_mtd, b.mtd_net_quantity as materialized_mtd,
    a.avg_daily_net_quantity as recheck_avg, b.avg_daily_net_quantity as materialized_avg,
    '库存覆盖天数：复算与物化不一致（库存/月累计/月日均三列各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where a.inventory_quantity is distinct from b.inventory_quantity
   or a.mtd_net_quantity is distinct from b.mtd_net_quantity
   or a.avg_daily_net_quantity is distinct from b.avg_daily_net_quantity

union all

select null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null,
    '物化侧库存全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where inventory_quantity <> 0)
