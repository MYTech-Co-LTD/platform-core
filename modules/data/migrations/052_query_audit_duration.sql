-- 052_query_audit_duration.sql — 查询审计补**耗时**（R4：全链路查询 p95 基线）。
--
-- 为什么：慢查询此前只打一行 console 日志（≥500ms），没有落库 ⇒ 无法算 p95、无法按指标排名、
-- 重启即丢。审计行本来就是「每次查询一行」，补一列即可，不新开遥测通道。
-- 旧行留 NULL（历史没有这个分项，不回填、不猜）；p95 只在有 samples 时给数。
alter table data.query_audit
  add column if not exists duration_ms integer;
