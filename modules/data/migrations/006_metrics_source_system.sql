-- 006_metrics_source_system.sql — L1 口径的**源系统**（spec §3⑧ 的源维度；计划 5）。
-- ⚠️ 与既有 `data.metrics.source`（取值 l1/l2 = 谁写的）**不是一回事**，故列名用 source_system。
-- 幂等：可重复执行。
alter table data.metrics add column if not exists source_system text;
