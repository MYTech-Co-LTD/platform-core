-- 015_notify_approval.sql — agent 自助动作的爆炸半径审批（N3）
--
-- 外发通道（企微/webhook）的 agent 规则默认不生效：先落 pending，人工批准后才 enabled。
-- 低风险通道（in-app）不产生审批；policy 预授权的外发动作落一条 approved 记录（可审计）。
-- 幂等：create ... if not exists。
create table if not exists notify.approval (
  id           bigserial primary key,
  org          text not null,
  namespace    text not null,
  kind         text not null check (kind in ('template','rule','schedule')),
  target_id    text not null,
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected')),
  requested_by text not null,
  decided_by   text,
  reason       text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  foreign key (org, namespace) references notify.agent_namespace(org, namespace)
);
create index if not exists idx_notify_approval_pending
  on notify.approval(org, status, created_at desc);
