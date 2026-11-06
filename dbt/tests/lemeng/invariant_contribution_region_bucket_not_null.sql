-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：contribution_region_bucket_not_null
{{ config(severity='error') }}
select * from fct_contribution where region_l1_bucket is null
