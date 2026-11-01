-- 026_report_acl.sql — 资产级授权（spec 2026-11-01-mobile-first-business-surface-design.md §4）
--
-- 为什么要有它：`data.reports` 只有 `required_scope` / `required_depts`（**谁能看内容**），
-- 没有任何「谁是所有者 / 我允许哪些人看」的表达 ⇒ 任何持 `data:manage` 的人都能改任意报表的
-- 可见范围，"我创建的报表我来配" 做不到。
--
-- 两条正交维度，别混：
--   · `visibility`  —— **默认可见面**（'tenant' = 沿用旧粗门；'restricted' = 只有 ACL 里的人）
--   · ACL           —— **例外**（owner 与点名/部门/权限码三类 viewer）
--   而 `required_scope` 在本域另有语义（NULL = **已发布**，见 report-store 的 updateRequiredScope 头注），
--   它是「内容门」，**不是**"公开/私有"开关。
--
-- 历史兼容：新列默认 'tenant' ⇒ 已有行的可见性**零变化**；owner 不回填（来源未知是诚实状态）。
-- 幂等：add column if not exists / create table if not exists / 约束先查再建。
alter table data.reports
  add column if not exists visibility text not null default 'tenant';

do $$
begin
  alter table data.reports
    add constraint reports_visibility_chk check (visibility in ('tenant','restricted'));
exception when duplicate_object then null;
end $$;

create table if not exists data.asset_acl (
  org          text        not null,
  asset_id     text        not null,
  -- user = Casdoor 用户名；dept = platform.org_node.ext_id；scope = 权限码
  subject_type text        not null check (subject_type in ('user','dept','scope')),
  subject_id   text        not null,
  relation     text        not null check (relation in ('owner','viewer')),
  granted_by   text        not null,
  granted_at   timestamptz not null default now(),
  primary key (org, asset_id, subject_type, subject_id, relation)
);

-- 读面：按资产批量取 ACL（列表页）；按受让方反查（将来「共享给我的」）
create index if not exists idx_asset_acl_asset on data.asset_acl (org, asset_id);
create index if not exists idx_asset_acl_subject on data.asset_acl (org, subject_type, subject_id);

comment on table data.asset_acl is
  '资产级 ACL（spec 2026-11-01 §4.1）：owner 与 viewer（用户/部门/权限码）。与 required_scope（内容门/已发布）正交。';

-- 资产级管理动作的审计（spec §4.2：管理员代管必须留痕）
create table if not exists data.asset_audit (
  id         bigserial   primary key,
  org        text        not null,
  asset_id   text        not null,
  actor      text        not null,
  action     text        not null,          -- acl.update / owner.grant / visibility.update …
  detail     jsonb       not null default '{}'::jsonb,
  by_admin   boolean     not null default false,  -- true = 非 owner 的管理码持有者代管
  created_at timestamptz not null default now()
);
create index if not exists idx_asset_audit_asset on data.asset_audit (org, asset_id, created_at desc);
