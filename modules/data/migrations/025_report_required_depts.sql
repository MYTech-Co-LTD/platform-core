-- 025_report_required_depts.sql — 报表部门门（spec 2026-10-30 §3.4，#1173 Phase B）
-- 正典：docs/superpowers/specs/2026-10-30-org-as-platform-primitive-design.md（D-O3/D-O4）
-- 语义：NULL = 无部门门（存量行为逐字节不变）；非 NULL = ext_id 数组（部门子树继承，
--      判定侧用 platform.org_node.path 展开祖先链）。部门门叠加不替代 scope 门（D-O4）。
-- 幂等：add column if not exists；重复执行不报错。
alter table data.reports add column if not exists required_depts jsonb;

-- 发布快照同列（月报重做 Task 10 的「页门跟快照走」同构）：独立链接渲染的是那一版快照，
-- 部门门也必须钉在快照里——否则草稿预览有门、发布后的链接无门（越门窗口）。
alter table data.report_versions add column if not exists required_depts jsonb;
