{{ config(materialized='table') }}
-- 生成物：scripts/gen-forms-data-projection.mjs — 手改会被 --check 回写（改列集只改契约/声明源）
-- 契约：contracts/forms/data-plane/goal-monthly-store.json
-- 件① 字段级摊平（#2706）：relation 名 = stg_forms_submission__goal_monthly_store（连字符转下划线；
--   L1 expression 按此引用）。DuckDB 段只碰 parquet（无 join，B1）；取列一律 r['列名'] 形态；
--   payload 是整列 varchar JSON（ADR-0005 §13.1 ①），逐字段 schema-on-read 提取。
select
  r['batch_id']::varchar as batch_id,
  {{ subject_org() }} as org,
  r['bizday']::date as bizday,
  r['submission_id']::bigint as submission_id,
  r['form_def_id']::varchar as form_def_id,
  r['submitted_at']::timestamptz as submitted_at,
  json_extract_string(r['payload'], '$.period') as f_period,
  json_extract_string(r['payload'], '$.branch_num') as f_branch_num,
  json_extract_string(r['payload'], '$.store_name') as f_store_name,
  cast(json_extract_string(r['payload'], '$.target_sale') as decimal(18,4)) as f_target_sale,
  cast(json_extract_string(r['payload'], '$.target_outbound') as decimal(18,4)) as f_target_outbound
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
) r
where r['form_def_id'] = 'goal-monthly-store'
