{{
    config(materialized='view')
}}
-- stg_lemeng_request_order.sql — staging（新湖；W3 2026-10-13；一对一、只规范化不改义）
-- 【前缀单点】var 见 dbt_project.yml（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['order_no']::varchar as order_no,
  r['order_type']::varchar as order_type,
  r['transfer_state']::varchar as transfer_state,
  r['purchase_date']::varchar as purchase_date,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['out_branch_num']::int as out_branch_num,
  r['out_branch_name']::varchar as out_branch_name,
  r['item_num']::bigint as item_num,
  r['item_code']::varchar as item_code,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['quantity']::decimal(14,6) as quantity,
  r['use_quantity']::decimal(14,6) as use_quantity,
  r['use_unit']::varchar as use_unit,
  r['subtotal']::decimal(14,2) as subtotal,
  r['use_rate']::decimal(18,8) as use_rate,
  r['present_quantity']::decimal(14,6) as present_quantity,
  r['present_use_quantity']::decimal(14,6) as present_use_quantity
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_request_order_prefix") }}/*/bizday=**/*.parquet'
) r
