{{
    config(materialized='table')
}}
-- stg_lemeng_wholesale_return.sql — 乐檬**批发退货单** staging（新湖；W1 2026-10-12；一对一、只规范化不改义）
-- 【行】= 退货单商品行（管线内已展开）；【A 阶段边界】探针恒空集（接口可达无业务样本）——
--   明细键名按官方能力文档字段名落契约，行落盘而明细列恒 null 时先核键名（契约 description 详）。
-- 【单头冗余】total_money / cost_money 随行冗余 ⇒ 聚合前 per_order 取 max，**行级 sum 会重复计**
--   （fct_hq_outbound 的 wholesale 侧是唯一聚合实现，别处不许再写一份等价聚合）。
-- 【符号边界】return_detail_money / 单头 total_money 的符号未实证（真样本到来先核），
--   客户文档 D03 边界：不得与 D02 负金额红字重复扣减。
-- 分区键推断类型不合约 ⇒ 两列显式 cast；取列必须 `from read_parquet(...) r` 函数别名形态
--   （同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/wholesale_return` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_wholesale_return_prefix`（出处：contracts/common/lemeng.wholesale_return.json 的 layout.prefix）。
-- 【覆盖范围】仅 3120 主账套。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['wholesale_return_fid']::varchar as wholesale_return_fid,
  r['order_no']::varchar as order_no,
  r['branch_num']::int as branch_num,
  r['client_fid']::varchar as client_fid,
  r['audit_time']::varchar as audit_time,
  r['total_money']::decimal(14,2) as total_money,
  r['cost_money']::decimal(14,2) as cost_money,
  r['order_detail_num']::varchar as order_detail_num,
  r['item_num']::bigint as item_num,
  r['return_detail_money']::decimal(14,2) as return_detail_money,
  r['return_detail_cost_money']::decimal(14,2) as return_detail_cost_money
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_return_prefix") }}/*/bizday=**/*.parquet'
) r
