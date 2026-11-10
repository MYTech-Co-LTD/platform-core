-- 042_data_scope.sql — 数据范围 scope（spec 2026-11-10-data-scope-rbac-design.md）
--
-- 语义：角色管动作（Casdoor 平台码），本表管“能看哪一行”：
--   brand   → system_book（dim_brand：3120 熊喵鲜生 / 64188 品品甜）
--   store   → region_l1 / region_name / all（dim_region + dim_lemeng_branch）
--   category→ category_group（dim_item.category_group：水果/标品/耗材/其他）
--
-- 迁移/分配：
--   subject_type='user' → Casdoor user name（数据面会话主体）
--   subject_type='role' → Casdoor role 短名（PAT/渠道 C 已带 roles；会话角色 Phase 2 再补）
--
-- 幂等：create ... if not exists / index if not exists。
create table if not exists data.scope (
  id           bigserial primary key,
  org          text not null,
  name         text not null,
  kind         text not null check (kind in ('brand', 'store', 'category')),
  selector     jsonb not null,
  -- 旧系统标签仅作迁移溯源（如 “范围|东部一区”）；迁移后不参与判定。
  legacy_label text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org, name)
);

create table if not exists data.scope_assignment (
  org          text not null,
  subject_type text not null check (subject_type in ('role', 'user')),
  subject_id   text not null,
  scope_id     bigint not null references data.scope(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (org, subject_type, subject_id, scope_id)
);

create table if not exists data.scope_audit (
  id         bigserial primary key,
  org        text not null,
  actor      text not null,
  action     text not null,
  detail     jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_scope_assignment_subject
  on data.scope_assignment (org, subject_type, subject_id);
create index if not exists idx_scope_org_kind
  on data.scope (org, kind);
create index if not exists idx_scope_audit_org_time
  on data.scope_audit (org, created_at desc);

comment on table data.scope is
  '数据范围 scope（brand/store/category）；selector 闭集见 spec §3.2；迁移后 legacy_label 不参与判定';
comment on table data.scope_assignment is
  'scope 分配：subject_type=role/user；有效 scope = 用户直接 ∪ 角色（同维度并集、不同维度 AND）';
comment on table data.scope_audit is
  'scope 变更审计（迁移/管理面写操作）：actor + action + detail，写后回读的凭据';
