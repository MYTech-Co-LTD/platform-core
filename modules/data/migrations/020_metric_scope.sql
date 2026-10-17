-- 020_metric_scope.sql — 指标的**口径射程**声明列（消费面 spec 2026-10-17 §12.6）。
--
-- 纪律（与 003/016 同源，别按口味改）：
--   · 幂等：add column if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）。
--   · 本文件**不含** create table，故无租户隔离面新增（data.metrics 的 org not null 由 001 建立，
--     check-tenant-isolation 的判据面不变）。
--
-- ── 这一列解决什么（§12.6：答案必须自带分母与排除）──────────────────────────────────
-- 只报「5 家连续无业绩」是**错的**——看数的人会读成「全部门店都没问题」。正确形态是
-- 「在 N 家零售门店中，5 家…；M 个非零售节点已排除」：**排除项本身是结论的一部分**。
-- 而这条声明必须由**平台自动附加**：参数面 spec §8.4 已实证「SKILL 正文对 flash 级模型
-- 是弱引导」（`total` 开关写了也不照做，最后只能改成自动伴随）——射程同理。
--
-- 语义：
--   · 空串（缺省）= 未声明射程 ⇒ 响应**不带** `scope_line`（未知 ≠ 编一句）；
--   · 非空 = 该指标的口径射程与排除项（人读的一句话，进回包后由插件钉在答案末尾）。
-- 值的唯一写入口是 L1 物化路径（`upsertL1Metric`，由 scripts/sync-data-semantics.mjs 从
-- `l1_metrics.yml` 的 `scope_note` 写入）。L2 租户行不开放该概念，恒 ''（列缺省兜底）。
--
-- 存量行：全部落 default ''（无射程声明）⇒ 下一次 sync 只把**声明了 scope_note 的**指标刷成非空，
-- 那是一次预期的「更新 N」漂移，不是数据损坏。

alter table data.metrics
  add column if not exists scope_note text not null default '';
