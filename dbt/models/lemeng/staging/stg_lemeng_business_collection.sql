{{
    config(materialized='view')
}}
-- stg_lemeng_business_collection.sql — 乐檬**营业收款报表-门店汇总** staging（新湖；2026-11-06 接源；一对一、只规范化不改义）
-- 【行】= 一行 = 账套×bizday×门店（summary_types=[branch]）。源 nhsoft.report.ai.businesscollection.find，单日窗（date_start=date_end=BIZDAY）。
-- 【缺口】当日无数据的门店不出现在响应里（total_count == len(rows) 合法）⇒ 缺行 = 无数据，不是零值。
-- 【前缀单点】var `lemeng_business_collection_prefix`（出处：契约 layout.prefix）。
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
  r['payment_receipt_money']::decimal(20,2) as payment_receipt_money,
  r['payment_receipt_total_money']::decimal(20,2) as payment_receipt_total_money,
  r['all_order_post_fee']::decimal(20,2) as all_order_post_fee,
  r['order_total_discount_money']::decimal(20,2) as order_total_discount_money,
  r['un_paid_money']::decimal(20,2) as un_paid_money,
  r['make_up_money']::decimal(20,2) as make_up_money,
  r['cash_system_money']::decimal(20,2) as cash_system_money,
  r['cash_difference_money']::decimal(20,2) as cash_difference_money,
  r['shift_table_actual_cash_money']::decimal(20,2) as shift_table_actual_cash_money,
  r['card_deposit_money']::decimal(20,2) as card_deposit_money,
  r['card_deposit_total_money']::decimal(20,2) as card_deposit_total_money,
  r['card_consume_self_money']::decimal(20,2) as card_consume_self_money,
  r['card_consume_present_money']::decimal(20,2) as card_consume_present_money,
  r['prepaid_card_money']::decimal(20,2) as prepaid_card_money,
  r['prepaid_card_total_money']::decimal(20,2) as prepaid_card_total_money,
  r['pick_up_card_money']::decimal(20,2) as pick_up_card_money,
  r['pick_up_card_total_money']::decimal(20,2) as pick_up_card_total_money,
  r['coupon_amount']::decimal(20,2) as coupon_amount,
  r['coupon_detail_sale_money']::decimal(20,2) as coupon_detail_sale_money,
  r['order_coupon_total_money']::decimal(20,2) as order_coupon_total_money,
  r['other_inout_money']::decimal(20,2) as other_inout_money,
  r['other_inout_total_money']::decimal(20,2) as other_inout_total_money,
  r['online_payment_receipt_money']::decimal(20,2) as online_payment_receipt_money,
  r['online_coupon_amount']::decimal(20,2) as online_coupon_amount,
  r['all_payment_type_moneys']::varchar as all_payment_type_moneys,
  r['computed_at']::timestamp_tz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_business_collection_prefix") }}/*/bizday=**/*.parquet'
) r
