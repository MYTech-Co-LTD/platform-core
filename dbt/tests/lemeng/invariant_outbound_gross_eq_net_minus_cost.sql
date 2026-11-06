-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：outbound_gross_eq_net_minus_cost
{{ config(severity='error') }}
select * from fct_hq_outbound where abs(g_gross - (r_net - c_cost)) > 0.01
