-- audit_lemeng__member__branch_vip_money.sql — 指标的**独立复算**（直打 parquet 对 fct_member_summary）。
with recheck as (
select
r['system_book']::varchar as system_book,
r['bizday']::date         as bizday,
r['branch_num']::int      as branch_num,
r['order_sale_type_name']::varchar as order_sale_type_name,
sum(coalesce(r['customer_vip_money']::numeric, 0))::numeric(20,2) as v
from read_parquet(
's3://{{ var("zos_bucket") }}/{{ var("lemeng_member_summary_prefix") }}/system_book=*/bizday=*/all.parquet'
) r
where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
group by 1, 2, 3, 4
),
materialized as (
select system_book, bizday, branch_num, order_sale_type_name, vip_money
from {{ ref('fct_member_summary') }}
where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
coalesce(a.system_book, b.system_book) as system_book,
coalesce(a.bizday, b.bizday)           as bizday,
coalesce(a.branch_num, b.branch_num)   as branch_num,
coalesce(a.order_sale_type_name, b.order_sale_type_name) as order_sale_type_name,
a.v as recheck_value,
b.vip_money as materialized_value,
'会员销售：复算与物化结果不一致' as note
from recheck a
full join materialized b
       -- ⚠️ **NULL 安全的 join 键**（2026-11-02）：`order_sale_type_name` 在 64188 的
       --   2025-03-06..03-19 有 257 行为 NULL（回填覆盖历史后首次出现）。原来的
       --   `using(system_book, bizday, branch_num, order_sale_type_name)` 里 NULL 永不相等
       --   ⇒ 每个 NULL 组在两侧各出一行（257×2=514 条假红）。`is not distinct from` 才把
       --   NULL 当同一个值比对。
       on  a.system_book = b.system_book
       and a.bizday      = b.bizday
       and a.branch_num  = b.branch_num
       and a.order_sale_type_name is not distinct from b.order_sale_type_name
where a.v is distinct from b.vip_money
