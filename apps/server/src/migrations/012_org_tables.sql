-- 012_org_tables.sql — 组织架构平台表（一等公民存储，spec 2026-10-30 §3.1）
-- 正典：docs/superpowers/specs/2026-10-30-org-as-platform-primitive-design.md
-- 幂等：create ... if not exists / 索引 if not exists；重复执行不报错。
-- 语义：企微是事实源，本表是平台内唯一组织存储（D-O1/D-O6）；
--      Casdoor groups 自本表切源后不再写入（D-O5），遗留组数据不动。
create table if not exists platform.org_node (
  tenant_id      integer not null references platform.tenant(id),
  ext_id         text    not null,             -- 企微部门 id（快照键，字符串化）
  name           text    not null,             -- 部门名（快照，展示用；改名以企微为准）
  parent_ext_id  text,                         -- 父部门 ext_id；根 = NULL（企微 parentid 0/1 归一）
  path           text    not null,             -- 物化路径（"49.57"）：子树查询唯一入口（D-O3）
  status         smallint not null default 1,  -- 1 正常 / 0 企微侧已消失（软删，不物理删）
  synced_at      timestamptz not null default now(),
  primary key (tenant_id, ext_id)
);

create index if not exists idx_org_node_parent on platform.org_node (tenant_id, parent_ext_id);
-- 子树展开走 path 前缀（`path like '49.%'`），btree 前缀即可，无需 gist
create index if not exists idx_org_node_path on platform.org_node (tenant_id, path);

create table if not exists platform.org_membership (
  tenant_id   integer not null references platform.tenant(id),
  user_name   text    not null,               -- Casdoor name（= 企微 userid）
  ext_id      text    not null,               -- 部门 ext_id
  is_primary  boolean not null default false, -- 企微 main_department
  synced_at   timestamptz not null default now(),
  primary key (tenant_id, user_name, ext_id)
);

create index if not exists idx_org_membership_node on platform.org_membership (tenant_id, ext_id);
