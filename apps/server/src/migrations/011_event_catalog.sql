-- 011_event_catalog.sql — 通知事件目录快照（manifest 是事实源，本表是投影）
-- 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §3.2
-- 幂等：create ... if not exists / upsert 由应用侧负责；重复执行不报错。
create table if not exists platform.event_catalog (
  key             text primary key,
  module_id       text not null,
  title           text not null,
  description     text,
  scope_key       text,
  payload_schema  jsonb not null default '{}'::jsonb,
  recipients      jsonb not null default '{}'::jsonb,
  defaults        jsonb,
  source          text not null check (source in ('module', 'external')),
  active          boolean not null default true,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_event_catalog_module
  on platform.event_catalog (module_id) where active;
