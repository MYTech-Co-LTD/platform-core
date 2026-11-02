{{
    config(materialized='view')
}}
-- stg_lemeng_branch_expense.sql — 乐檬**门店费用单** staging（新湖；W2 2026-10-13；一对一、只规范化不改义）
-- 【行】= 费用单（无明细子结构）。【归属】branch_num=归属店（operate_branch_num=结算方，仅落列）。
-- 【方向】direction 是中文名（应付/应收）。【红字】due_amount 保留（真样本与 amount 反向）。
-- 【前缀单点】var `lemeng_branch_expense_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['bill_no']::varchar as bill_no,
  r['branch_num']::int as branch_num,
  r['branch_name']::varchar as branch_name,
  r['branch_code']::varchar as branch_code,
  r['store_name']::varchar as store_name,
  r['operate_branch_num']::int as operate_branch_num,
  r['operate_branch_name']::varchar as operate_branch_name,
  r['expense_type']::varchar as expense_type,
  r['direction']::varchar as direction,
  r['amount']::decimal(14,2) as amount,
  r['due_amount']::decimal(14,2) as due_amount,
  r['paid_amount']::decimal(14,2) as paid_amount,
  r['payment_date']::varchar as payment_date,
  r['tax_rate']::decimal(18,8) as tax_rate,
  r['tax_amount']::decimal(14,2) as tax_amount,
  r['audit_time']::varchar as audit_time,
  r['create_time']::varchar as create_time,
  r['reference_bill']::varchar as reference_bill,
  r['memo']::varchar as memo,
  r['settlement_state']::int as settlement_state,
  r['settlement_state_name']::varchar as settlement_state_name,
  r['last_edit_time']::varchar as last_edit_time
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
) r
