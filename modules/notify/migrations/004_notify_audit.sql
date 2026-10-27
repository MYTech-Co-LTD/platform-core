-- 004_notify_audit.sql — 通知写操作审计（发布/通道/规则/MCP）
-- 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §10/§11
create table if not exists notify.audit (
  id         bigserial primary key,
  org        text not null,
  actor      text not null,
  action     text not null,
  target     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_notify_audit_org
  on notify.audit (org, created_at desc);
