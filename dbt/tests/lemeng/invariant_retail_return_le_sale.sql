-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：retail_return_le_sale
{{ config(severity='warn') }}
select * from fct_retail_sale where return_amount > sale_amount + 0.01
