-- audit_lemeng__loss__branch_amount.sql — 指标的**独立复算**（对账；与 fct_loss_adjustment 逐字同构，但直接打 parquet、
-- 不 ref staging——复算走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_loss_adjustment.sql 头注（本文件比较：报损/调整金额 Σ total_money，粒度 book×bizday×店×原因×方向）。
with recheck as (
select
r['system_book']::varchar as system_book,
r['bizday']::date         as bizday,
r['branch_num']::int      as branch_num,
r['cause']::varchar       as cause,
r['direction']::varchar   as direction,
sum(coalesce(r['total_money']::numeric, 0))::numeric(20,2) as v
from read_parquet(
's3://{{ var("zos_bucket") }}/{{ var("lemeng_loss_adjustment_prefix") }}/system_book=*/bizday=*/all.parquet'
) r
where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
group by 1, 2, 3, 4, 5
),
materialized as (
select system_book, bizday, branch_num, cause, direction, loss_money
from {{ ref('fct_loss_adjustment') }}
where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
coalesce(a.system_book, b.system_book) as system_book,
coalesce(a.bizday, b.bizday)           as bizday,
coalesce(a.branch_num, b.branch_num)   as branch_num,
coalesce(a.cause, b.cause)             as cause,
coalesce(a.direction, b.direction)     as direction,
a.v as recheck_value,
b.loss_money as materialized_value,
'报损金额：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, cause, direction)
where a.v is distinct from b.loss_money
