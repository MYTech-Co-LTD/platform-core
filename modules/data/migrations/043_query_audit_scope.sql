-- 043_query_audit_scope.sql — 数据范围判定入审计（spec 2026-11-10 §5.4；issue #1901）。
--
-- 为什么：切 shadow 后判定只进 stdout（OpenObserve），DB 里查不到「这条查询本来会被哪些
-- filter 裁」。对照期要按人/按指标聚合，运营面也需要可回放——判定必须与查询同行落账。
--
-- 形状（写侧唯一构造点 domain/audit-store.ts 的 ScopeAudit）：
--   scope_plan   = { mode: 'shadow'|'enforce', applied: ['brand','store'], filters: [...], denial: null }
--   scope_denial = 'no_store_scope' / 'range_dimension_missing:category' …（无拒绝 = NULL）
--
-- 幂等：add column if not exists。既有行 NULL = 该次查询未发生范围判定（mode=off/管理员/未认证）。
alter table data.query_audit add column if not exists scope_plan jsonb;
alter table data.query_audit add column if not exists scope_denial text;

comment on column data.query_audit.scope_plan is
  '数据范围判定（spec 2026-11-10 §5.4）：mode/applied/filters/denial；NULL = 未发生判定';
comment on column data.query_audit.scope_denial is
  '范围拒绝原因（如 no_store_scope / range_dimension_missing:category）；无拒绝 = NULL';
