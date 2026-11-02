-- 029_metric_audit_certify_action.sql — metric_audit.action 放开 'certify' 动作词
--（spec 2026-11-01 §10.4 D7 可信度升降；010 的 CHECK 是三动词闭集，不放开 certifyMetric 写审计会被 CHECK 拒）
--
-- `certify` = 只动 certified 标、不动 spec/SQL 的审核动作（metric-write.certifyMetric）。
-- 独立成词而不是混进 'update'：变更史里「改了口径」与「只改了标」必须可分辨（console 的
-- 动作标签同批扩了 '可信度'）。010 的三动词闭集注释随之作废，见该文件头。
--
-- ⚠️⚠️ **2026-11-02 修订 CHECK 词表 = 全量终版（含 030 的 'meta'）**——教训在 030 文件头：
--   动作词分两次加 CHECK（029 四词、030 五词）会把「全量重放」炸死在 029 的重放上
--   （重放 029 时库里已有 meta 行 ⇒ 用四词 ADD 必 violated）。本文件虽只对应 certify 的
--   入场，但 ADD 列表必须始终是**全部动作词的并集**；词表后续再扩也沿用此法（见 030 加注）。
-- 幂等：drop if exists + 重建；重复执行结果一致，且与已存在的历史行永不冲突。
alter table data.metric_audit drop constraint if exists metric_audit_action_check;
-- ⚠️ 下面的列表 = metric_audit 动作词的**全量终版**（新动作词若再需 CHECK 放行，
--    直接把词补进这个列表，两个文件保持一致；别再走「新文件加一个词」的独立迁移）。
alter table data.metric_audit add constraint metric_audit_action_check
  check (action in ('create', 'update', 'delete', 'certify', 'meta'));
