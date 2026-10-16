-- 017_metric_freshness.sql — 新鲜度 SLA + 逐关系水位列（spec §10.7）。
--
-- 纪律（与 016 同源，别按口味改）：
--   · 幂等：add column if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）。
--     `if not exists` 在列已存在时**整句 no-op**（不会重写既有行的值）⇒ 重跑安全。
--   · 本文件不含 create table，故无租户隔离面新增（data.metrics 的 org not null 由 001 建立）。
--
-- ── 这四列解决什么（spec §10.7.1–10.7.3）────────────────────────────────────────────
-- data.metrics（平台库，本迁移管）：
--   · sla_days integer            —— 该指标的新鲜度承诺（承诺：水位距今天 ≤N 个业务日即「正常」）。
--     唯一写入口是 L1 物化路径（upsertL1Metric，由 scripts/sync-data-semantics.mjs 从声明
--     `freshness_sla_days` 物化；缺声明的声明会被 sync **响亮拒绝**，不许静默默认）。
--     L2 行不开放该概念，恒 NULL。
--   · freshness_relations jsonb   —— 该指标的「新鲜度关系集」：sync 从声明 sources 的存储路径段
--     机械推导（`lemeng/<资产>` ⇒ `stg_lemeng_<资产>`），物化成 jsonb 字符串数组。水位查询
--     （query-service）拿它去 load_log 上取 min(max_bizday)。空数组/NULL = 无自动水位（字段缺席）。
--
-- data.load_log（**仓库库** pg_duckdb 的表，由 scripts/lemeng/materialize.sh 建——平台库通常
-- 没有它；spec §10.7.2 给它加逐关系水位两列，与仓级行兼容）：
--   · relation text    —— 该行水位属于哪个关系（staging 表名）；NULL = 旧版「仓级」行（历史保留，
--     水位查询只取 relation 非空，spec §10.7.2 明文）。
--   · max_bizday date  —— 该关系在本次物化后的最大业务日（木桶短板：指标水位 = 各关系 min）。
-- ⚠️ 因此 load_log 半句必须 `alter table if exists`：表缺席（平台库常态）时整句 no-op，
--    迁移在全量重跑与两种部署形态（同库/分库）下都不翻车；真仓库的加列由 materialize.sh 的
--    幂等 DDL 完成（mat_load_log_sql，与这里同一组列名，两处幂等不冲突）。

alter table data.metrics
  add column if not exists sla_days integer;
alter table data.metrics
  add column if not exists freshness_relations jsonb;

alter table if exists data.load_log
  add column if not exists relation text;
alter table if exists data.load_log
  add column if not exists max_bizday date;
