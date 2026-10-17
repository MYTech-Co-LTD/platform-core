-- 018_metric_mask.sql — 值级脱敏的声明面（spec 2026-10-17 §5.2）。
--
-- 纪律（与 016/017 同源）：
--   · 幂等：add column if not exists（部署脚本每次全量重跑全部迁移）。
--   · 无 create table ⇒ 无租户隔离面新增（data.metrics 的 org 由 001 建立）。
--
-- mask_spec = 该指标的掩码声明数组，形如
--   [{"column":"fct_x.net_amount","kind":"round","step":1000,"grantedBy":"data:precise"}]
-- NULL = 未声明（此时由「源列 sensitivity」推默认档，见 spec §4.1.1）。
-- ⚠️ 它**不进 select_sql**：运行期在 authorize() 里对 select_sql 做列引用定点替换
--    （spec §5.3 订正块——占位符进 select_sql 会被 L2 编译原样带出去）。

alter table data.metrics
  add column if not exists mask_spec jsonb;
