-- 008_identity_link.sql — 微信/企微身份绑定表（账户统一设计 §1.2）。
-- 单行可变：一个 (provider, org, external_id) 永远一行，换绑/解绑原地改 status，
-- 历史走 platform.audit（action='identity.link.*'），不靠多行。
create table if not exists platform.identity_link(
  id bigserial primary key,
  org text not null,
  provider text not null check (provider in ('wechat-oa','wecom')),
  external_id text not null,
  casdoor_name text not null,
  status text not null default 'pending' check (status in ('pending','active','revoked','disputed')),
  phone text,
  bound_via text check (bound_via in ('auto','manual')),
  source_approval_id bigint,
  disputed_at timestamptz,
  bound_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists identity_link_external_uq
  on platform.identity_link(provider, org, external_id);
create index if not exists identity_link_account_idx
  on platform.identity_link(org, casdoor_name);
create index if not exists identity_link_phone_idx
  on platform.identity_link(org, phone) where status = 'active';
