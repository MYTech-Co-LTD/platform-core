-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：contribution_net_eq_gross_minus_expense
{{ config(severity='error') }}
select * from fct_contribution where abs(n_net - (g_gross - e_net)) > 0.01
