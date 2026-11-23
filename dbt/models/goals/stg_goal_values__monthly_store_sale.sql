{{ config(materialized='table') }}
-- 生成物：scripts/gen-goal-achievement.mjs — 手改会被 --check 回写（改口径只改 dbt/semantics/goals.yml）
-- 目标：shanhai:monthly_store_sale（门店月度销售目标） 来源表单：goal-monthly-store（契约 contracts/forms/data-plane/goal-monthly-store.json）
-- 件② 段① DuckDB：只碰 forms 提交湖 parquet（payload 是整列 varchar JSON 的 schema-on-read 提取，
--   ADR-0005 §13.1 ①）；**无任何 join**（B1）；取列一律 r['列名'] 形态。
-- 行 = 一次提交（同一 (period, 维度) 的多次提交在段② 取 submitted_at 最新，轮次内可改）。
select
  r['batch_id']::varchar as batch_id,
  {{ subject_org() }} as org,
  r['bizday']::date as bizday,
  r['submission_id']::bigint as submission_id,
  r['submitted_at']::timestamptz as submitted_at,
  json_extract_string(r['payload'], '$.period') as period,
  json_extract_string(r['payload'], '$.branch_num') as branch_num,
  cast(json_extract_string(r['payload'], '$.target_sale') as decimal(18,4)) as target_sale,
  cast(json_extract_string(r['payload'], '$.target_outbound') as decimal(18,4)) as target_outbound
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
) r
where r['form_def_id'] = 'goal-monthly-store'
