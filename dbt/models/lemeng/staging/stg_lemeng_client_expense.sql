{{
    config(materialized='view')
}}
-- stg_lemeng_client_expense.sql — 乐檬**客户费用单** staging（新湖；W2 2026-10-13；一对一、只规范化不改义）
-- 【行】= 客户费用单。【归属】client_fid（前导零字符串）；branch_num=业务机构仅落列。
-- 【方向】other_inout_flag: false=应付 / true=应收（真样本实证）；flag_name 冗余展示列。
-- 【红字】other_inout_due_money 保留。
-- 【前缀单点】var `lemeng_client_expense_prefix`。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['other_inout_bill_no']::varchar as other_inout_bill_no,
  r['branch_num']::int as branch_num,
  r['branch_name']::varchar as branch_name,
  r['client_fid']::varchar as client_fid,
  r['client_code']::varchar as client_code,
  r['client_name']::varchar as client_name,
  r['other_inout_flag']::bool as other_inout_flag,
  r['other_inout_flag_name']::varchar as other_inout_flag_name,
  r['other_inout_kind']::varchar as other_inout_kind,
  r['other_inout_kind_code']::varchar as other_inout_kind_code,
  r['other_inout_date']::varchar as other_inout_date,
  r['other_inout_money']::decimal(14,2) as other_inout_money,
  r['other_inout_due_money']::decimal(14,2) as other_inout_due_money,
  r['other_inout_ref_bill']::varchar as other_inout_ref_bill,
  r['other_inout_audit_time']::varchar as other_inout_audit_time,
  r['state_code']::int as state_code,
  r['other_inout_memo']::varchar as other_inout_memo
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_client_expense_prefix") }}/*/bizday=**/*.parquet'
) r
