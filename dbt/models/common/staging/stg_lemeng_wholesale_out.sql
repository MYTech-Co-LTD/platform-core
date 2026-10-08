{{
    config(materialized='table')
}}
-- stg_lemeng_wholesale_out.sql — 乐檬**批发销售单** staging（新湖；#499/R3；一对一、只规范化不改义）
-- 【R3】行 = 批发单商品行（管线内已展开）；发货方 = 3120 管理中心/批发仓，收货方 = 外部批发客户
--   （client_fid）。工单/对账取价口径（money÷quantity）落在 publish-dims（单一来源），本层只规范化。
-- 分区键推断类型不合约 ⇒ 两列显式 cast；取列必须 `from read_parquet(...) r` 函数别名形态
--   （同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/wholesale_out` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_wholesale_out_prefix`（出处：contracts/common/lemeng.wholesale_out.json 的 layout.prefix）。
-- 【覆盖范围】仅 3120 主账套（WO 单发货方在 3120；64188 不在售后范围）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['order_no']::varchar as order_no,
  r['client_fid']::varchar as client_fid,
  r['state_code']::int as state_code,
  r['state_name']::varchar as state_name,
  r['wholesale_order_date']::varchar as wholesale_order_date,
  r['create_time']::varchar as create_time,
  r['audit_time']::varchar as audit_time,
  r['last_edit_time']::varchar as last_edit_time,
  r['branch_num']::int as branch_num,
  r['storehouse_num']::bigint as storehouse_num,
  r['order_detail_num']::int as order_detail_num,
  r['item_num']::bigint as item_num,
  r['item_code']::varchar as item_code,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['quantity']::decimal(14,6) as quantity,
  r['price']::decimal(18,8) as price,
  r['money']::decimal(14,2) as money,
  r['cost']::decimal(18,8) as cost,
  r['lot_number']::varchar as lot_number,
  r['present_qty']::decimal(14,6) as present_qty,
  r['use_unit']::varchar as use_unit,
  r['use_qty']::decimal(14,6) as use_qty,
  r['use_price']::decimal(18,8) as use_price,
  r['use_rate']::decimal(18,8) as use_rate
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
) r
