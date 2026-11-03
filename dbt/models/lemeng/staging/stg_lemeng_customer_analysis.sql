{{
    config(materialized='view')
}}
-- stg_lemeng_customer_analysis.sql — 乐檬**时段分析** staging（新湖；2026-11-03 接源；一对一、只规范化不改义）
-- 【行】= 账套×bizday×门店×时段切片（interval_minutes=60）。源 nhsoft.report.ai.customeranalysis.find，单日窗。
-- 【缺口】当日无经营的时段不出现在响应里 ⇒ 缺行＝无数据，不是零值。
-- 【前缀单点】var `lemeng_customer_analysis_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['time_period']::varchar as time_period,
  r['customer_nums']::bigint as customer_nums,
  r['customer_vip_nums']::bigint as customer_vip_nums,
  r['customer_vip_money']::decimal(14,2) as customer_vip_money,
  r['receive_money']::decimal(14,2) as receive_money,
  r['item_sale_cost']::decimal(14,2) as item_sale_cost,
  r['item_sale_profit']::decimal(14,2) as item_sale_profit,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_customer_analysis_prefix") }}/*/bizday=**/*.parquet'
) r
