{{
config(materialized='table')
}}
-- stg_lemeng_loss_adjustment.sql — 乐檬**库存调整单** staging（#1047 P1 2026-10-25 接源；一对一、只规范化不改义）
-- 【行】= 调整单（明细仅在 memo 文本，未结构化）。【归属】branch_num=归属店。【报损】direction='出库' 按 cause 分组。
-- 【窗口】采集窗 = 制单日期族（纯 yyyy-MM-dd）；bizday 即查询窗口日。管线内 qa.contract 已有六列 not_null 闸。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['order_no']::varchar as order_no,
  r['order_type']::varchar as order_type,
  r['branch_num']::int as branch_num,
  r['business_date']::varchar as business_date,
  r['state_code']::int as state_code,
  r['state_name']::varchar as state_name,
  r['total_money']::decimal(14,2) as total_money,
  r['operator']::varchar as operator,
  r['memo']::varchar as memo,
  r['department']::varchar as department,
  r['creator']::varchar as creator,
  r['create_time']::varchar as create_time,
  r['auditor']::varchar as auditor,
  r['audit_time']::varchar as audit_time,
  r['storehouse_num']::bigint as storehouse_num,
  r['direction']::varchar as direction,
  r['cause']::varchar as cause,
  r['cause_code']::varchar as cause_code,
  r['related_order_no']::varchar as related_order_no
from read_parquet(
's3://{{ var("zos_bucket") }}/{{ var("lemeng_loss_adjustment_prefix") }}/system_book=*/bizday=*/all.parquet'
) r
