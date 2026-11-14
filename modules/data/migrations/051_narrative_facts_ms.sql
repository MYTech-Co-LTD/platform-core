-- 051_narrative_facts_ms.sql — 叙事台账记录**事实包构建耗时**（R4 p95 基线）。
--
-- 为什么：`duration_ms` 是全链路（facts + 模型 + 校验）墙钟；优化 facts 去重/缓存时
-- 没有独立的分项数字可对照。这里把 facts 构建耗时单独落一列，stats 才能给出 facts p95。
-- 旧行留 NULL（历史数据没有这个分项，不回填、不猜）。
alter table data.narrative_runs
  add column if not exists facts_ms integer;
