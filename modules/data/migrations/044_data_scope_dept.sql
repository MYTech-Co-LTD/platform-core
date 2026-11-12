-- 044_data_scope_dept.sql — 数据范围支持「组织节点」为主体（2026-11-12，#1953 四期）
--
-- 起因：范围挂人是最脆弱的一种（调岗/离职后没人记得收）；组织才是稳定主体——
-- 人属于哪个部门是一个事实，范围跟着部门走，调岗自动生效。
--
-- 语义：
--   subject_type='dept' → `platform.org_node.ext_id`（企微部门 id，与部门门同键）
--   有效 scope = 用户直接 ∪ 角色 ∪ **用户部门闭包（本人部门 + 全部祖先）**
--   闭包语义与 dept-gate 一致（org_node.path 物化路径拆段），复用 userDeptClosure。
--
-- 约束变更必须写全量（PG 的 check 不能就地改）：先删旧约束再建新的，
-- 旧库与新库都落到同一终态（幂等）。
alter table data.scope_assignment
  drop constraint if exists scope_assignment_subject_type_check;

alter table data.scope_assignment
  add constraint scope_assignment_subject_type_check
  check (subject_type in ('role', 'user', 'dept'));

comment on table data.scope_assignment is
  'scope 分配：subject_type=dept/role/user；有效 scope = 用户直接 ∪ 角色 ∪ 部门闭包（同维度并集、不同维度 AND）';
