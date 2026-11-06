{{
    config(materialized='view')
}}
-- stg_lemeng_business_collection_coupon.sql — 乐檬**营业收款报表-卡券汇总** staging（新湖；2026-11-06 接源；一对一、只规范化不改义）
-- 【行】= 一行 = 账套×bizday×门店×券类型（summary_types=[branch,coupon_type]）。源 nhsoft.report.ai.businesscollection.coupon.find，单日窗（date_start=date_end=BIZDAY）。
-- 【缺口】当日无数据的门店不出现在响应里（total_count == len(rows) 合法）⇒ 缺行 = 无数据，不是零值。
-- 【前缀单点】var `lemeng_business_collection_coupon_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['branch_region_num']::int as branch_region_num,
  r['branch_region_name']::varchar as branch_region_name,
  r['branch_type']::varchar as branch_type,
  r['coupon_type_name']::varchar as coupon_type_name,
  r['coupon_amount']::decimal(20,2) as coupon_amount,
  r['coupon_detail_sale_money']::decimal(20,2) as coupon_detail_sale_money,
  r['coupon_discount_money']::decimal(20,2) as coupon_discount_money,
  r['coupon_value']::decimal(20,2) as coupon_value,
  r['exchange_card_sale_money']::decimal(20,2) as exchange_card_sale_money,
  r['exchange_card_total_money']::decimal(20,2) as exchange_card_total_money,
  r['exchange_card_verification_count']::int as exchange_card_verification_count,
  r['computed_at']::timestamp_tz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_business_collection_coupon_prefix") }}/*/bizday=**/*.parquet'
) r
