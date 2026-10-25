{{
config(materialized='table')
}}
-- fct_member_summary.sql — 会员汇总构件（#1047 P5；口径在此定义一次）。
-- 【粒度】(system_book, bizday, branch_num, order_sale_type_name)——可上卷到店日。
-- 【构件列】vip_money=Σ customer_vip_money（会员销售）；vip_nums=Σ customer_vip_nums（会员客单）；
--   receive_money=Σ receive_money（全型收款，占比分母）；customer_nums=Σ customer_nums（全型客单）。
-- 【会员口径】全部 order_sale_type 的 vip 字段合计（「拼团」型别漏）。
with agg as (
select
system_book,
bizday,
branch_num,
order_sale_type_name,
sum(coalesce(receive_money, 0))::numeric(20,2) as receive_money,
sum(coalesce(customer_nums, 0))::bigint as customer_nums,
sum(coalesce(customer_vip_money, 0))::numeric(20,2) as vip_money,
sum(coalesce(customer_vip_nums, 0))::bigint as vip_nums
from {{ ref('stg_lemeng_member_summary') }}
group by 1, 2, 3, 4
)
select
agg.system_book,
agg.bizday,
{{ subject_org() }} as org,
agg.branch_num,
agg.order_sale_type_name,
agg.receive_money,
agg.customer_nums,
agg.vip_money,
agg.vip_nums
from agg
