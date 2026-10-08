{{
    config(materialized='table')
}}
-- stg_lemeng_transfer_out.sql — 乐檬**配送调出单** staging（新湖；#499/R2；一对一、只规范化不改义）
-- 【R2】行 = 配送单商品行（管线内已展开）；「单头列」随行冗余透传。工单取价口径
--   （out_money÷quantity）落在 publish-dims（单一来源），本层只规范化。
-- 分区键推断类型不合约 ⇒ 两列显式 cast（system_book::varchar / bizday::date）；取列必须
--   `from read_parquet(...) r` 函数别名形态（同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/transfer_out` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_transfer_out_prefix`（出处：contracts/common/lemeng.transfer_out.json 的 layout.prefix）。
-- 【覆盖范围】仅 3120 主账套（64188=外部批发客户，不在售后范围——R2 拍板）；
--   路径段仍写 `*/bizday=**/`（账套由 system_book= 段表达，单账套时通配亦安全）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['order_no']::varchar as order_no,
  r['order_type']::varchar as order_type,
  r['state_code']::int as state_code,
  r['business_date']::varchar as business_date,
  r['create_time']::varchar as create_time,
  r['audit_time']::varchar as audit_time,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['out_branch_num']::int as out_branch_num,
  r['out_branch_name']::varchar as out_branch_name,
  r['total_money']::decimal(14,2) as total_money,
  r['item_num']::bigint as item_num,
  r['item_grade_num']::bigint as item_grade_num,
  r['item_code']::varchar as item_code,
  r['bar_code']::varchar as bar_code,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['lot_number']::varchar as lot_number,
  r['quantity']::decimal(14,6) as quantity,
  r['use_quantity']::decimal(14,6) as use_quantity,
  r['use_unit']::varchar as use_unit,
  r['use_rate']::decimal(18,8) as use_rate,
  r['present_quantity']::decimal(14,6) as present_quantity,
  r['production_date']::varchar as production_date,
  r['unit_price']::decimal(18,8) as unit_price,
  r['subtotal']::decimal(14,2) as subtotal,
  r['out_money']::decimal(14,2) as out_money,
  r['in_money']::decimal(14,2) as in_money,
  r['cost']::decimal(18,8) as cost
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
) r
