{{
    config(materialized='view')
}}
-- stg_lemeng_item_profit.sql — 乐檬**商品毛利分析** staging（新湖；2026-11-02 接源；一对一、只规范化不改义）
-- 【行】= 账套×bizday×门店×商品（summary_types=[branch,item]）。源 nhsoft.report.ai.itemprofitanalysis.find，单日窗。
-- 【毛利口径】sale_cost / profit_* 需成本查询权限；缺权限列可能为空或整行缺失 ⇒ 消费面聚合别拿它当分母。
-- 【与 item_sales】同粒度不同表，商品集合不保证一致 ⇒ join 在消费面做，湖层不合表。
-- 【前缀单点】var `lemeng_item_profit_prefix`（出处：契约 layout.prefix）。
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
  r['item_barcode']::varchar as item_barcode,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['sale_num']::decimal(20,4) as sale_num,
  r['sale_count']::decimal(20,4) as sale_count,
  r['customer_nums']::decimal(20,4) as customer_nums,
  r['sale_money']::decimal(20,2) as sale_money,
  r['sale_money_no_coupon']::decimal(20,2) as sale_money_no_coupon,
  r['sale_cost']::decimal(20,2) as sale_cost,
  r['profit_money']::decimal(20,2) as profit_money,
  r['profit_rate']::decimal(20,6) as profit_rate,
  r['profit_money_no_coupon']::decimal(20,2) as profit_money_no_coupon,
  r['profit_rate_no_coupon']::decimal(20,6) as profit_rate_no_coupon,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_profit_prefix") }}/*/bizday=**/*.parquet'
) r
