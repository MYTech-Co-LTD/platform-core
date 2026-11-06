-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。
-- 不变量：outbound_cost_nonneg
{{ config(severity='warn') }}
select * from fct_hq_outbound where c_cost < 0
