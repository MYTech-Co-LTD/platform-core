{{
    config(materialized='table')
}}
-- stg_lemeng_item_purchase.sql — staging（新湖；W3 余项 2026-10-13；一对一、只规范化不改义）
-- 【前缀单点】var 见 dbt_project.yml（出处：契约 layout.prefix）。⚠️ 路径 glob 是 `/*/bizday=**/*.parquet`
--   （单斜杠）——W3 三个 staging 曾把这里写成 `//*/` 导致真机物化全炸（#634，案例 #28）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['supplier_num']::bigint as supplier_num,
  r['supplier_code']::varchar as supplier_code,
  r['supplier_name']::varchar as supplier_name,
  r['item_num']::bigint as item_num,
  r['item_code']::varchar as item_code,
  r['item_barcode']::varchar as item_barcode,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['base_unit']::varchar as base_unit,
  r['purchase_item_amount']::decimal(14,6) as purchase_item_amount,
  r['purchase_item_money']::decimal(14,2) as purchase_item_money,
  r['purchase_present_amount']::decimal(14,6) as purchase_present_amount,
  r['purchase_present_money']::decimal(14,2) as purchase_present_money,
  r['purchase_item_return_amount']::decimal(14,6) as purchase_item_return_amount,
  r['purchase_item_return_money']::decimal(14,2) as purchase_item_return_money,
  r['amount_total']::decimal(14,6) as amount_total,
  r['money_total']::decimal(14,2) as money_total
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet'
) r
