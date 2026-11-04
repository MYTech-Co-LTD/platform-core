-- 031_metric_semantics_meta.sql — L1 语义深化（W0）：实体与同义词
--
-- 两列都是**声明侧物化**：只有 sync 从 dbt/semantics/l1_metrics.yml 写；
-- L2 行恒 NULL / '[]'::jsonb（没有声明面）。幂等：add column if not exists。
alter table data.metrics
  add column if not exists entity    text,
  add column if not exists synonyms  jsonb;

comment on column data.metrics.entity is
  '实体名（L1 声明侧）；NULL = 未声明。L2 行恒 NULL';
comment on column data.metrics.synonyms is
  '同义词数组（L1 声明侧）；缺省空数组。L2 行恒空';
