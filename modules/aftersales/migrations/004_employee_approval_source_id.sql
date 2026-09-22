-- 004_employee_approval_source_id.sql — M2b：employee_approval 补 source_id 幂等位。
--
-- 002 建 employee_approval 时没带 source_id（M3b-1 只服务线上新申请，没有重跑导入的需求）。
-- M2b 要把源 employee_info_approve（214 行）迁进来并要求「--apply 可重跑」⇒ 照 001 的幂等模式补：
--   source_id text not null default '' + (org, source_id) 部分唯一索引（空串互撞被 WHERE 排除）。
-- 线上新申请行 source_id 保持 ''，不受影响。
alter table aftersales.employee_approval
  add column if not exists source_id text not null default '';

create unique index if not exists aftersales_employee_approval_org_source_idx
  on aftersales.employee_approval(org, source_id) where source_id <> '';
