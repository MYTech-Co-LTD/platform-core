-- 021_metric_drill.sql — bot 问数下钻 Phase 1（spec 2026-10-21 §2.3/§2.5）。
-- data.metrics 三列：sync 从声明 compose/dimensions/detail 物化的下钻绑定；L2 行恒 NULL
--（upsertMetric 不写它们）⇒「L2 不支持下钻」（spec §5）由存储形状自然涌现，无需运行期特判。
-- data.query_audit.drill：下钻审计面 {dimensions, rowCountTotal}；聚合审计恒 NULL——
--   「这条审计是不是下钻」必须可辨（spec §2.5：下钻审计含粒度与总数）。
alter table data.metrics     add column if not exists drill_expr   text;
alter table data.metrics     add column if not exists drill_dims   jsonb;
alter table data.metrics     add column if not exists drill_detail jsonb;
alter table data.query_audit add column if not exists drill        jsonb;
