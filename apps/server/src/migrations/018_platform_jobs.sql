-- 018_platform_jobs.sql — 平台内置调度器的排班、运行台账与心跳（Wave 6 P1）
-- spec: docs/superpowers/specs/2026-11-14-business-scheduler-design.md §7
-- 三处实现细节（spec 未写、实现需要）：
--   · retry_at / retry_attempt：重试不改动 cadence（重试与下一格是两件事）
--   · retry_occurrence：重试槽属于**排班侧**，原格 occurrence 必须随槽一起存
--     （反查 job_run 会被并发/手动行劫持；claim 时与 retry_at 一起清空）
--   · job_run.status 增加 'queued'：手动触发只入队，执行发生在 worker 进程
-- 幂等：全部 if not exists。
create table if not exists platform.job_schedule (
  id                     bigserial primary key,
  key                    text not null,
  cron                   text not null,
  timezone               text not null default 'Asia/Shanghai',
  params                 jsonb not null default '{}'::jsonb,
  owner_org              text,
  owner_namespace        text,
  source                 text not null default 'system' check (source in ('system','agent')),
  created_by             text,
  enabled                boolean not null default false,
  next_run_at            timestamptz,
  timeout_ms             integer not null default 300000,
  max_attempts           integer not null default 1,
  expected_interval_secs integer not null,
  retry_at               timestamptz,
  retry_occurrence       timestamptz,
  retry_attempt          integer not null default 0,
  updated_at             timestamptz not null default now()
);
-- 已建过表的库（本迁移曾以旧 DDL 应用过）走 add column 幂等补齐。
alter table platform.job_schedule add column if not exists retry_occurrence timestamptz;

create unique index if not exists uq_job_schedule_system_key
  on platform.job_schedule(key) where source = 'system';
create index if not exists idx_job_schedule_owner
  on platform.job_schedule(owner_org, owner_namespace);
create index if not exists idx_job_schedule_due
  on platform.job_schedule(next_run_at) where enabled;

create table if not exists platform.job_run (
  id              bigserial primary key,
  schedule_id     bigint not null references platform.job_schedule(id),
  key             text not null,
  occurrence      timestamptz not null,
  owner_org       text,
  owner_namespace text,
  params_snapshot jsonb,
  trigger         text not null check (trigger in ('schedule','manual')),
  status          text not null check (status in ('queued','running','ok','failed','timeout','skipped')),
  attempt         integer not null default 1,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  exit_code       integer,
  duration_ms     integer,
  output_tail     text,
  error           text
);
create index if not exists job_run_schedule_started_idx
  on platform.job_run (schedule_id, started_at desc);
create index if not exists job_run_queued_idx
  on platform.job_run (id) where status = 'queued';

create table if not exists platform.job_heartbeat (
  id      text primary key,
  beat_at timestamptz not null
);
