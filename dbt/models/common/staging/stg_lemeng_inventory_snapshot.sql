{{
    config(materialized='table')
}}
-- stg_lemeng_inventory_snapshot.sql — staging（新湖；W3 2026-10-13；一对一、只规范化不改义）
-- 【前缀单点】var 见 dbt_project.yml（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['storehouse_num']::bigint as storehouse_num,
  r['storehouse_code']::varchar as storehouse_code,
  r['storehouse_name']::varchar as storehouse_name,
  r['item_num']::bigint as item_num,
  r['item_code']::varchar as item_code,
  r['item_barcode']::varchar as item_barcode,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['inventory_quantity']::decimal(14,6) as inventory_quantity,
  r['inventory_assist_quantity']::decimal(14,6) as inventory_assist_quantity,
  r['inventory_use_quantity']::decimal(14,6) as inventory_use_quantity,
  r['inventory_money']::decimal(14,2) as inventory_money,
  r['carry_cost_price']::decimal(18,8) as carry_cost_price,
  r['sale_price']::decimal(18,8) as sale_price,
  r['difference_quantity']::decimal(14,6) as difference_quantity,
  r['difference_money']::decimal(14,2) as difference_money
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_inventory_snapshot_prefix") }}/*/bizday=**/*.parquet'
) r
