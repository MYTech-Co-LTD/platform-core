-- audit_lemeng__member__branch_vip_nums.sql — 会员客单的**独立复算**（直打 parquet 对 fct_member_summary）。
with recheck as (
select
r['system_book']::varchar as system_book,
r['bizday']::date         as bizday,
r['branch_num']::int      as branch_num,
r['order_sale_type_name']::varchar as order_sale_type_name,
sum(coalesce(r['customer_vip_nums']::bigint, 0))::bigint as v
from read_parquet(
's3://{{ var("zos_bucket") }}/{{ var("lemeng_member_summary_prefix") }}/system_book=*/bizday=*/all.parquet'
) r
where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
group by 1, 2, 3, 4
),
materialized as (
select system_book, bizday, branch_num, order_sale_type_name, vip_nums
from {{ ref('fct_member_summary') }}
where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
coalesce(a.system_book, b.system_book) as system_book,
coalesce(a.bizday, b.bizday)           as bizday,
coalesce(a.branch_num, b.branch_num)   as branch_num,
coalesce(a.order_sale_type_name, b.order_sale_type_name) as order_sale_type_name,
a.v as recheck_value,
b.vip_nums as materialized_value,
'会员客单：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, order_sale_type_name)
where a.v is distinct from b.vip_nums
