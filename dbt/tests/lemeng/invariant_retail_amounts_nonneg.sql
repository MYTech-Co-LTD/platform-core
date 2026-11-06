-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：retail_amounts_nonneg
{{ config(severity='error') }}
select * from fct_retail_sale where sale_amount < 0 or return_amount < 0 or order_count < 0
