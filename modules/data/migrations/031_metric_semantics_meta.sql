-- 031_metric_semantics_meta.sql — L1 语义深化（W0）：实体与同义词
--
-- 两列都是**声明侧物化**：只有 sync 从 dbt/semantics/l1_metrics.yml 写；
-- L2 行的 insert 不写这两列 ⇒ 落库原值是 NULL（`[]` 由读取侧归一 `toMetricRow` 产出，
-- 不是列默认——本迁移不加 default）。幂等：add column if not exists。
alter table data.metrics
  add column if not exists entity    text,
  add column if not exists synonyms  jsonb;

comment on column data.metrics.entity is
  '实体名（L1 声明侧）；NULL = 未声明。L2 行 insert 不写 ⇒ 原值 NULL（读侧映射为 null）';
comment on column data.metrics.synonyms is
  '同义词数组（L1 声明侧）；未声明 = NULL；[] 是读侧归一结果，不是列默认。L2 行 insert 不写 ⇒ 原值 NULL';
