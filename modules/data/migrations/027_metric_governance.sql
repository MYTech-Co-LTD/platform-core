-- 027_metric_governance.sql — 指标治理层（spec 2026-11-01 §10.4 P0）
--
-- 三列解决三件事：
--   · `draft_spec`  —— L2 草稿（creator 编辑暂存，确认后才走唯一编译点编译进 `spec`）；
--                      L1 恒 NULL（dbt 物化只写 spec，没有草稿概念）
--   · `certified`   —— 可信度分级：'certified' | 'draft'。
--                      L1 读侧从 source='l1' 推导恒 certified；L2 新建默认 draft，管理员可升
--   · `created_by`  —— L2 创建者（Casdoor 用户名）；L1 行 NULL（平台口径无"创建者"概念）。
--                      「只能管理自己创建的」据此判定；存量行 NULL = 来源未知（不猜，与 026 同口径）
--
-- ⚠️ 026 的教训：default 不能掩盖存量语义——certified 对存量 L2 行默认 'draft'
--   （它们本来就没经过审核），存量 L1 行由读侧从 source 推导（不写列，因为 sync 会重写行）。
-- 幂等：add column if not exists。
alter table data.metrics
  add column if not exists draft_spec jsonb,
  add column if not exists certified  text,
  add column if not exists created_by text;

-- L1 行的 certified 由读侧从 source 推导（certified 恒 'certified'），不写列；
-- 这里只给 L2 行一个显式默认（新建走 API 时写 'draft'）。
comment on column data.metrics.certified is
  '可信度分级：certified（已审核）/ draft（未审核）。L1 读侧恒 certified（从 source 推导）；L2 新建默认 draft，管理员可升';
comment on column data.metrics.created_by is
  'L2 创建者（Casdoor 用户名）；L1 行 NULL（平台口径）。「只能管理自己创建的」据此判定';
