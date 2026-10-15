-- 016_metric_totalable.sql — 问数合计**自动伴随**的可加标记列（spec §8.4）。
--
-- 纪律（与 003 同源，别按口味改）：
--   · 幂等：add column if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）。
--     `if not exists` 在列已存在时**整句 no-op**（含 default 与 not null 子句），不会重新求值
--     default、也不会重写既有行的值 ⇒ 重跑安全。
--   · 本文件**不含** create table，故无租户隔离面新增（data.metrics 的 org not null 由 001
--     建立，check-tenant-isolation 的判据面不变）。
--
-- ── 这一列解决什么（spec §8.4 修订二：total 自动伴随）────────────────────────────────
-- 复测实测：SKILL 正文对 flash 级模型是弱引导——「对的路」必须由平台自动发生。
-- `totalable` = 该指标口径**可加**（expression 以 `sum(` 开头）的物化标记：
--   · true  ⇒ 任何查询的响应自动附 `total` 字段 = 该过滤范围合计（query-service 执行
--     authz 计划上的 totalSql）——模型无论如何问，答案里都有那个数；
--   · false ⇒ 不给自动合计。比率（毛利率/达成率）、去重计数（跨行求和 = 供应商·天数，错）
--     一律 false；模型也不得跨行求和（工具文案明示）。
-- 值的唯一写入口是 L1 物化路径（`upsertL1Metric`，由 scripts/sync-data-semantics.mjs 从
-- expression 推导写入）；L2 租户行不开放该概念，恒 false（列缺省兜底，写侧也写死 false）。
--
-- 存量行：全部落 default false ⇒ 首次 sync 物化（comparableOf 纳入 totalable）会把可加
-- 指标刷成 true——那是一次预期的「更新 N」漂移，不是数据损坏。

alter table data.metrics
  add column if not exists totalable boolean not null default false;
