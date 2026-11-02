-- 029_metric_audit_certify_action.sql — metric_audit.action 放开 'certify' 动作词
--（spec 2026-11-01 §10.4 D7 可信度升降；010 的 CHECK 是三动词闭集，不放开 certifyMetric 写审计会被 CHECK 拒）
--
-- `certify` = 只动 certified 标、不动 spec/SQL 的审核动作（metric-write.certifyMetric）。
-- 独立成词而不是混进 'update'：变更史里「改了口径」与「只改了标」必须可分辨（console 的
-- 动作标签同批扩了 '可信度'）。010 的三动词闭集注释随之作废，见该文件头。
-- 幂等：drop if exists + 重建；重复执行结果一致。
alter table data.metric_audit drop constraint if exists metric_audit_action_check;
alter table data.metric_audit add constraint metric_audit_action_check
  check (action in ('create', 'update', 'delete', 'certify'));
