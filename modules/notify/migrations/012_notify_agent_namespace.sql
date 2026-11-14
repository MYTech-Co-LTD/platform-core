-- 012_notify_agent_namespace.sql — 租户/agent 命名空间（N1 双平面事件目录）
--
-- 为什么需要它：平台事件由 manifest 声明（全局）；agent 运行时声明的事件必须
-- **租户内按 agent 命名空间隔离**，否则命名冲突、越权修改和审计都无法收敛。
--
-- namespace 段用 snake_case（与事件 key 的段字符集一致）：`ext.<namespace>.<event>`。
-- 幂等：create ... if not exists。
create table if not exists notify.agent_namespace (
  org           text not null,
  namespace     text not null,
  display_name  text not null,
  owner_user_id text not null,
  status        text not null default 'active' check (status in ('active','disabled')),
  policy        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (org, namespace),
  check (namespace ~ '^[a-z][a-z0-9_]{1,31}$')
);
create index if not exists idx_notify_agent_namespace_owner
  on notify.agent_namespace(org, owner_user_id);
