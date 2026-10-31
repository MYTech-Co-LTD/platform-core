-- vw_lemeng_wholesale_out.sql — 乐檬**批发明细直读湖视图**（读面，不是 staging）（#1182，2026-10-31）。
--
-- 本文件正文与 `dbt/models/lemeng/staging/stg_lemeng_wholesale_out.sql` **逐字相同，只翻物化方式**
-- （`table` → `view`）⇒ 正文要改就回 staging 那份改再整份复制过来，**不要在这里单独改**；
-- 列区是 `scripts/gen-data-projection.mjs` 的生成物（手改会被 --check 报红）。
--
-- 【为什么需要它】`query_detail`（下钻）只认 `vw_*` 直读湖视图（门禁：relation 必须 vw_* 且文件在
-- `dbt/models/**/views/`）。批发侧此前没有任何下钻绑定（真机 43 条指标里只有 2 条零售有）。
--
-- 【与零售视图的差别】批发湖是**一天一个文件**（无 hour 分区、无冷热两段、无 `_SCHEMA` 封版断言）
-- ⇒ 只有一段 FROM，比零售那份简单。
--
-- 【退货侧不在本视图】`wholesale_return` 至今**持续 0 行**（load_log 的 max_bizday 全 NULL、status ok，
-- 2026-10-31 实测）⇒ 退货金额符号无法实证，按计划不并入；将来有数据先探针定符号再另开。
{{
    config(materialized='view')
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
  r['use_rate']::decimal(18,8) as use_rate,
  r['total_money']::decimal(14,2) as total_money,
  r['cost_money']::decimal(14,2) as cost_money
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
) r
