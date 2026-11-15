-- 053_business_monitor.sql — 业务监控（Wave 7 V1，spec 2026-11-14-business-monitor-design §5）。
--
-- 纪律：
--   · 幂等：部署每次全量重跑全部迁移（团队规则 db-migration §1）⇒ 全部 if not exists。
--   · 编号：spec 写的 049 已被 `report_versions_immutable` 占用，本波用 053，**一次用尽**。
--   · 隔离键一律 org（text = Casdoor org），所有读写 SQL 必须带 `where org = $1`；
--     机器判据 scripts/check-tenant-isolation.mjs。
--   · 本表不承载「阈值 DSL」：verdict/operator 都是闭集，threshold 判据 V2 才实现。

create schema if not exists data;

create table if not exists data.monitor (
  id                bigserial primary key,
  org               text not null,
  name              text not null,
  -- 目标闭集（结构性边界，spec §3.1）：接口/进程/管线一律 OpenObserve，不在这张表里表达。
  target_kind       text not null check (target_kind in ('metric','report_panel')),
  metric_id         text,
  report_id         text,
  panel_index       integer,
  filters           jsonb not null default '{}'::jsonb,
  verdict           text not null check (verdict in ('missing','stale','threshold')),
  operator          text check (operator in ('gt','gte','lt','lte','eq')),
  threshold         numeric,
  window_days       integer not null default 1 check (window_days between 1 and 30),
  -- 下界 300s 与「必须晚于上游水位刷新一档」是两回事：后者按源在应用层警告（spec §8）。
  cadence_secs      integer not null check (cadence_secs >= 300),
  cooldown_secs     integer not null default 3600 check (cooldown_secs >= 0),
  -- 影子期硬门：默认 true，只有显式 PATCH 才关（spec §2/§7）。
  dry_run           boolean not null default true,
  recipients        jsonb not null,
  channel_policy    text not null default 'in_app' check (channel_policy in ('in_app','wecom','webhook')),
  state             text not null default 'ok' check (state in ('ok','firing','unknown')),
  state_since       timestamptz,
  last_eval_at      timestamptz,
  -- 冷却判据的时间锚：最近一次真的投递过的时刻（不是最近一次求值）。
  notified_at       timestamptz,
  consecutive_fail  integer not null default 0,
  enabled           boolean not null default true,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists monitor_due_idx on data.monitor (org, last_eval_at) where enabled;

create table if not exists data.monitor_run (
  id            bigserial primary key,
  monitor_id    bigint not null references data.monitor(id),
  org           text not null,
  evaluated_at  timestamptz not null default now(),
  verdict       text not null,                 -- 本次判定：ok/missing/stale/unknown
  value         numeric,                       -- 可空（missing/unknown 没有数）
  watermark_ref text,                          -- 上游水位/探针标识（相关性，spec §9）
  state_after   text not null,
  notified      boolean not null default false,
  dry_run       boolean not null default true,
  duration_ms   integer,
  error         text
);
create index if not exists monitor_run_monitor_idx on data.monitor_run (monitor_id, evaluated_at desc);
