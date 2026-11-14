-- 010_event_available_at.sql — 一次性延迟队列（W6-P2）。
-- 调度器只负责 cron；「一次性延迟」进 outbox，到点才被 worker 领取。
--
-- 存量行：add column ... not null default now() 会把已存在的行回填为 now()（PG 11+ 快速默认值），
-- 即存量事件保持「立即可领」语义，不会因为本次迁移被推迟或漏发。
-- 幂等：if not exists 两处，重跑整批迁移不报错。
alter table notify.event add column if not exists available_at timestamptz not null default now();

-- 领取条件：status='new' 且 available_at <= now()。
create index if not exists idx_notify_event_due
  on notify.event (status, available_at) where status = 'new';
