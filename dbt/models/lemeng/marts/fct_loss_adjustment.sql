{{
config(materialized='table')
}}
-- fct_loss_adjustment.sql — 报损/调整构件（#1047 P1；口径在此定义一次）。
-- 【粒度】(system_book, bizday, branch_num, cause, direction)——可上卷到店日/店日因。
-- 【构件列】loss_money = Σ total_money（报损语义 = direction='出库' 的行；入库盘盈同列保留方向维）。
-- 【单据口径】全部采集行；order_no 去重计数作单数面。
-- 【org / 精度】同 fct_branch_expense。
with agg as (
select
system_book,
bizday,
branch_num,
cause,
direction,
sum(coalesce(total_money, 0))::numeric(20,2) as loss_money
from {{ ref('stg_lemeng_loss_adjustment') }}
group by 1, 2, 3, 4, 5
),
counts as (
select
system_book,
bizday,
branch_num,
cause,
direction,
count(distinct order_no)::bigint as order_count
from {{ ref('stg_lemeng_loss_adjustment') }}
group by 1, 2, 3, 4, 5
)
select
agg.system_book,
agg.bizday,
{{ subject_org() }} as org,
agg.branch_num,
agg.cause,
agg.direction,
agg.loss_money,
counts.order_count
from agg
join counts
on  agg.system_book = counts.system_book
and agg.bizday = counts.bizday
and agg.branch_num = counts.branch_num
and agg.cause = counts.cause
and agg.direction = counts.direction
