{{
    config(materialized='view')
}}
-- stg_lemeng_inventory_movement.sql — 乐檬**库存进出明细** staging（新湖；2026-11-03 接源；一对一、只规范化不改义）
-- 【行】= 账套×bizday×一条进出流水（movement_id）。源 nhsoft.ama.ai.inventory.movement.find，单日窗 + 原生分页。
-- 【bizday】取查询窗日期（源端 movement_date 可能因跨零点与窗口不一致，分区以查询窗为准）。
-- 【前缀单点】var `lemeng_inventory_movement_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['movement_id']::varchar as movement_id,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['item_num']::bigint as item_num,
  r['item_code']::varchar as item_code,
  r['item_barcode']::varchar as item_barcode,
  r['item_name']::varchar as item_name,
  r['item_spec']::varchar as item_spec,
  r['item_unit']::varchar as item_unit,
  r['movement_type']::varchar as movement_type,
  r['movement_summary']::varchar as movement_summary,
  r['movement_date']::date as movement_date,
  r['operate_time']::timestamp as operate_time,
  r['operator']::varchar as operator,
  r['bill_no']::varchar as bill_no,
  r['lot_number']::varchar as lot_number,
  r['memo']::varchar as memo,
  r['quantity']::numeric(18,6) as quantity,
  r['assist_quantity']::numeric(18,6) as assist_quantity,
  r['unit_price']::numeric(18,8) as unit_price,
  r['money']::numeric(18,2) as money,
  r['inventory_balance']::numeric(18,6) as inventory_balance,
  r['assist_inventory_balance']::numeric(18,6) as assist_inventory_balance,
  r['out_storehouse_num']::bigint as out_storehouse_num,
  r['out_storehouse_code']::varchar as out_storehouse_code,
  r['out_storehouse_name']::varchar as out_storehouse_name,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_inventory_movement_prefix") }}/*/bizday=**/*.parquet'
) r
