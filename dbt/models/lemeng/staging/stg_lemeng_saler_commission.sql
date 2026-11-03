{{
    config(materialized='view')
}}
-- stg_lemeng_saler_commission.sql — 乐檬**销售员提成汇总** staging（新湖；2026-11-03 接源；一对一、只规范化不改义）
-- 【行】= 账套×bizday×门店×销售员。源 nhsoft.report.ai.salercommission.find，单日窗；无 summary_types 参数。
-- 【缺口】当日无销售的销售员不出现在响应里 ⇒ 缺行＝无数据，不是零值。
-- 【前缀单点】var `lemeng_saler_commission_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_name']::varchar as branch_name,
  r['saler']::varchar as saler,
  r['sale_commission']::decimal(14,2) as sale_commission,
  r['turnover_with_coupon_price']::decimal(14,2) as turnover_with_coupon_price,
  r['sale_money_no_coupon']::decimal(14,2) as sale_money_no_coupon,
  r['sale_cost']::decimal(14,2) as sale_cost,
  r['commission_rate']::decimal(14,8) as commission_rate,
  r['sale_order_count']::bigint as sale_order_count,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_saler_commission_prefix") }}/*/bizday=**/*.parquet'
) r
