-- 003_note_org.sql — demo.note 补租户维度（spec-1 §2：租户数据表必须带 org）。
-- 幂等：add column if not exists + 回填受 where 约束 + set not null 对已 not null 列是 no-op。
-- 回填口径：无法归属的旧行回填空串——空串不等于任何真 org，对所有租户不可见；
-- 宁可不可见，不可错归属（demo 是占位模块，存量行不可见可接受）。
-- 版本号说明：不叫 002 是因为本地开发库账本里存在一条 2026-09-11 的幽灵记录
-- (demo, 002_note_org)——早期实验加过 org_id 列后文件被删，账本留下了。同名的
-- 002 在该库会被静默跳过；003 + 下面的 drop if exists 让脏库自愈、净库无感。
alter table demo.note add column if not exists org text;
update demo.note set org = '' where org is null;
alter table demo.note alter column org set not null;
-- 热路径索引以 org 为前缀列（查询形状：where org = $1 order by id desc limit 50）
create index if not exists demo_note_org_id_idx on demo.note(org, id);
-- 自愈：清掉幽灵实验列（本库实测 0 行数据、仓内零引用；净库/生产库上是无害 no-op）
alter table demo.note drop column if exists org_id;
