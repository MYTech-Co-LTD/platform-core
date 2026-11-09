-- 041_tenant_declarations.sql — 租户语义自治（W8，2026-11-09，issue #1716）
--
-- 两列，全部可空、全部幂等（部署脚本每次全量重跑迁移，见 dev-discipline 数据库迁移纪律）：
--   · declaration  jsonb：租户声明的**原文**（YAML 条目等价物）。L1 sync 行该列为 NULL；
--     租户声明必填。用途 = 编辑回显 / 审计快照 / 重建，不用从投影列反推（投影有损）。
--   · override_of  text ：非空 = 本行是该 org 对 `<id>` 的平台口径**覆盖**（值 = 被覆盖的 L1 id，
--     与 id 相同）。只可能出现在租户行（source='l2'、org<>'platform'）；L1 行恒 NULL。
-- 读侧优先级见 modules/data/domain/metric-store.ts 的 loadMergedCatalog。
--
-- 不加 CHECK 约束：覆盖的合法性同时依赖 source/org，而存量行与 sync 路径都不写这两列；
-- 用「写侧校验 + 读侧 fail-closed（override_of 不指向真实 L1 就不构成覆盖）」比一条会挡住
-- 历史行的表级约束更稳（约束在部署重跑时也要幂等，代价大于收益）。
alter table data.metrics add column if not exists declaration jsonb;
alter table data.metrics add column if not exists override_of text;

-- basis 白名单放宽（034 的 CHECK 只允许 l1_tree / column_agg）：
-- 租户全额声明 = basis='declared'。DROP + ADD 幂等（部署脚本每次重跑迁移）。
alter table data.metrics drop constraint if exists metrics_basis_check;
alter table data.metrics add constraint metrics_basis_check
  check (basis in ('l1_tree', 'column_agg', 'declared'));

-- 读侧按 (org, override_of) 查找覆盖行；partial index 只索引非空行，成本与行数无关。
create index if not exists data_metrics_override_idx
  on data.metrics (org, override_of) where override_of is not null;
