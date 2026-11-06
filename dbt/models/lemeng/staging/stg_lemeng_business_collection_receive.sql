{{
    config(materialized='view')
}}
-- stg_lemeng_business_collection_receive.sql — 乐檬**营业收款报表-门店收款构成** staging（新湖；2026-11-06 接源；一对一、只规范化不改义）
-- 【行】= 一行 = 账套×bizday×门店×支付方式（summary_types=[branch,payment_type]）。源 nhsoft.report.ai.businesscollection.receive.find，单日窗（date_start=date_end=BIZDAY）。
-- 【缺口】当日无数据的门店不出现在响应里（total_count == len(rows) 合法）⇒ 缺行 = 无数据，不是零值。
-- 【前缀单点】var `lemeng_business_collection_receive_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['payment_type']::varchar as payment_type,
  r['receive_money']::decimal(20,2) as receive_money,
  r['receive_money_rate']::decimal(20,6) as receive_money_rate,
  r['order_count']::int as order_count,
  r['order_count_rate']::decimal(20,6) as order_count_rate,
  r['pos_order_receive_money']::decimal(20,2) as pos_order_receive_money,
  r['pos_order_count']::int as pos_order_count,
  r['card_deposit_receive_money']::decimal(20,2) as card_deposit_receive_money,
  r['card_deposit_order_count']::int as card_deposit_order_count,
  r['card_relate_receive_money']::decimal(20,2) as card_relate_receive_money,
  r['card_relate_order_count']::int as card_relate_order_count,
  r['card_replace_receive_money']::decimal(20,2) as card_replace_receive_money,
  r['card_replace_order_count']::int as card_replace_order_count,
  r['exchange_card_receive_money']::decimal(20,2) as exchange_card_receive_money,
  r['exchange_card_order_count']::int as exchange_card_order_count,
  r['other_receive_money']::decimal(20,2) as other_receive_money,
  r['other_order_count']::int as other_order_count,
  r['purchase_records_receive_money']::decimal(20,2) as purchase_records_receive_money,
  r['purchase_records_order_count']::int as purchase_records_order_count,
  r['computed_at']::timestamp_tz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_business_collection_receive_prefix") }}/*/bizday=**/*.parquet'
) r
