-- 045_scope_dept_self.sql — 部门主体支持「仅直属成员 / 含下级部门」（2026-11-12）
--
-- 起因（真机验收暴露）：范围合并是并集、部门闭包含祖先 ⇒ 把「战区」范围挂到战区部门，
-- 该战区下**所有区的人**都会看到整个战区，分级被吞掉。业务要求战区内仍分级：
--   战区总（直属挂战区部门）→ 看全战区；区长/门店（挂在区/店）→ 只看本区。
--
-- 语义：
--   include_children = true（默认）→ 匹配用户部门**闭包**（本人 + 全部祖先）
--   include_children = false      → 只匹配用户**直属部门**（不继承祖先）
-- 只对 subject_type='dept' 有意义；user/role 行忽略此列（恒 true）。
--
-- 幂等：add column if not exists；默认 true 保持既有行为不变。
alter table data.scope_assignment
  add column if not exists include_children boolean not null default true;

comment on column data.scope_assignment.include_children is
  'dept 主体是否含下级部门：true=按部门闭包（本人+祖先）匹配；false=只匹配直属成员。user/role 行忽略';
