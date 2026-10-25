{{
config(materialized='table')
}}
-- stg_lemeng_member_summary.sql — 乐檬**会员销售汇总** staging（#1047 P5 2026-10-25 接源；一对一、只规范化不改义）
-- 【行】= 门店×营业日×订单类型的汇总行（report 端点，无明细）。【会员口径】customer_vip_* 字段；
--   全部 order_sale_type 的 vip 合计才是报表口径（漏「拼团」型差 82.19——2026-10-25 网关锚）。
-- 【店维】shape 常量注入（branch_nums=[92] 单店批次；全量待 foreach 父子管线）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['order_sale_type']::int as order_sale_type,
  r['order_sale_type_name']::varchar as order_sale_type_name,
  r['receive_money']::decimal(14,2) as receive_money,
  r['receipt_coupon_share_money']::decimal(14,2) as receipt_coupon_share_money,
  r['customer_nums']::bigint as customer_nums,
  r['customer_ave_price_no_coupon']::decimal(14,2) as customer_ave_price_no_coupon,
  r['customer_ave_price']::decimal(14,2) as customer_ave_price,
  r['customer_vip_money']::decimal(14,2) as customer_vip_money,
  r['customer_vip_nums']::bigint as customer_vip_nums,
  r['customer_vip_ave_price']::decimal(14,2) as customer_vip_ave_price,
  r['member_customer_price']::decimal(14,2) as member_customer_price,
  r['relat_rate']::decimal(18,8) as relat_rate,
  r['relat_rate_vip']::decimal(18,8) as relat_rate_vip,
  r['buy_rate']::decimal(18,8) as buy_rate,
  r['item_sale_cost']::decimal(14,2) as item_sale_cost,
  r['item_sale_profit']::decimal(14,2) as item_sale_profit,
  r['item_sale_profit_rate']::decimal(18,8) as item_sale_profit_rate,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name
from read_parquet(
's3://{{{{ var("zos_bucket") }}}}/{{{{ var("lemeng_member_summary_prefix") }}}}/system_book=*/bizday=*/all.parquet'
) r
