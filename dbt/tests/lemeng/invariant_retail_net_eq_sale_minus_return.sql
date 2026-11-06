-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：retail_net_eq_sale_minus_return
{{ config(severity='error') }}
select * from fct_retail_sale where abs(net_amount - (sale_amount - return_amount)) > 0.01
