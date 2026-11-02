{{
    config(materialized='view')
}}
-- stg_lemeng_item_sales.sql — 乐檬**商品销售分析** staging（新湖；2026-11-02 接源；一对一、只规范化不改义）
-- 【行】= 账套×bizday×门店×商品（summary_types=[branch,item]）。源 nhsoft.report.ai.itemsales.find，单日窗。
-- 【缺口】当日无销售的门店/商品不出现在响应里 ⇒ 缺行＝无数据，不是零值；消费面求和按「有行即计入」。
-- 【与 item_profit】同粒度不同表，商品集合不保证一致 ⇒ join 在消费面做，湖层不合表。
-- 【前缀单点】var `lemeng_item_sales_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['item_num']::int as item_num,
  r['item_code']::varchar as item_code,
  r['item_name']::varchar as item_name,
  r['spec']::varchar as spec,
  r['unit']::varchar as unit,
  r['sale_count']::decimal(20,4) as sale_count,
  r['sale_num']::decimal(20,4) as sale_num,
  r['total_num']::decimal(20,4) as total_num,
  r['sale_money']::decimal(20,2) as sale_money,
  r['item_price']::decimal(20,6) as item_price,
  r['return_num']::decimal(20,4) as return_num,
  r['return_money']::decimal(20,2) as return_money,
  r['present_num']::decimal(20,4) as present_num,
  r['discount_money']::decimal(20,2) as discount_money,
  r['order_detail_share_discount']::decimal(20,2) as order_detail_share_discount,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_sales_prefix") }}/*/bizday=**/*.parquet'
) r
