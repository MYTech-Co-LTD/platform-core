-- 013_notify_event_decl.sql — 租户/agent 事件声明（N1 双平面事件目录）
--
-- 平台事件仍在 platform.event_catalog（manifest 投影，全局）；本表只放
-- `ext.<namespace>.<event>`，租户内可见、由 namespace owner 管理。
--
-- version：payload/recipients 只增不改；破坏性变更必须换新 key（应用层校验）。
-- 幂等：create ... if not exists。
create table if not exists notify.event_decl (
  org          text not null,
  namespace    text not null,
  key          text not null,
  version      integer not null default 1 check (version > 0),
  title        text not null,
  description  text,
  scope_key    text,
  payload_schema jsonb not null,
  recipients   jsonb not null,
  defaults     jsonb,
  status       text not null default 'active' check (status in ('active','disabled')),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (org, key),
  foreign key (org, namespace) references notify.agent_namespace(org, namespace),
  -- key 必须属于本行 namespace（fail-closed：不靠应用层单点）
  check (key like 'ext.' || namespace || '.%')
);
create index if not exists idx_notify_event_decl_namespace
  on notify.event_decl(org, namespace, status);
