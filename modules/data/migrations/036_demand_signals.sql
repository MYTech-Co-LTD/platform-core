-- 036_demand_signals.sql — Phase 2 需求台账（spec 2026-11-05-demand-mining-design.md §3）。
-- 幂等：本目录迁移每次部署全量重跑 ⇒ 全部 if not exists。
create table if not exists data.demand_signals (
  id             bigserial primary key,
  org            text        not null,
  kind           text        not null,
  target         text        not null,
  detail         jsonb       not null default '{}'::jsonb,
  occurrences    integer     not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  evidence       jsonb       not null default '[]'::jsonb,
  dismissed_at   timestamptz,
  dismissed_by   text,
  dismiss_reason text
);
create unique index if not exists demand_signals_key
  on data.demand_signals (org, kind, target);

create table if not exists data.demand_mining_state (
  org         text        not null,
  source      text        not null,
  last_cursor bigint      not null,
  updated_at  timestamptz not null default now(),
  primary key (org, source)
);
