-- 030_metric_meta.sql — 指标元数据（spec 2026-11-01 §10.4.3 P1）：业务描述 / 单位 / 口径说明
--
-- 背景：L2 的 description 是**编译产物**（「L2 派生自 xxx」），不是给人读的业务描述——
-- 元数据是**治理标注**，不属于编译：不经编译点（spec/SQL 不动），但要审计（变更史可分辨
-- 「改口径」与「只改标注」，动作词 'meta'，见下方 CHECK）。
--
--   · biz_description —— 业务语义（这数是怎么算出来的、该拿它看什么）；覆盖编译产出的
--     description 给管理面/看数人读，但不写掉 description 本身（派生留证仍在）。
--   · unit            —— 单位（元 / 单 / 件 / 人 / % …）；展示层用，不参与计算。
--   · caliber_note    —— 口径说明（边界：含不含优惠、含不含退货、统计窗口…）。
--
-- 三列全部 nullable：NULL = 未标注（**不编默认值**——空着比编一个错的好）。
-- 幂等：add column if not exists。
alter table data.metrics
  add column if not exists biz_description text,
  add column if not exists unit            text,
  add column if not exists caliber_note    text;

-- 🔴 **CHECK 重放火车坑（本迁移亲手撞过一次，教训立此存照）**：
--   动作词分批加 CHECK（029 四词、030 五词如上原稿）会让「全量重放」（迁移纪律要求同一批
--   SQL 可连跑）死在 029 的重加上——重放 029 的那一刻，库里可能已有 meta 动作行，四词
--   ADD 必 violated，030 永远轮不到。030 检查过 CI 才发现的：迁移 SQL 本身幂等是纪律，
--   不是可选优化。
--   修法（也是后续动作词的固定姿势）：**两个文件 ADD 同一个全量词表**；词表再扩时把词补进
--   两个列表（app 层 MetricAction 联合 + console 字典 + 单测同批），不再走「新文件独立加词」。
alter table data.metric_audit drop constraint if exists metric_audit_action_check;
alter table data.metric_audit add constraint metric_audit_action_check
  check (action in ('create', 'update', 'delete', 'certify', 'meta'));

comment on column data.metrics.biz_description is
  '业务语义（人读的描述，治理标注，不经编译点）；NULL = 未标注。L1 行恒 NULL（平台口径元数据走声明侧，另议）';
comment on column data.metrics.unit is
  '单位（元/单/件/人/%…展示层用，不参与计算）；NULL = 未标注';
comment on column data.metrics.caliber_note is
  '口径说明（边界：含不含优惠/退货、统计窗口…）；NULL = 未标注';
