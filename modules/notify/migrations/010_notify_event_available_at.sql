-- 010_notify_event_available_at.sql — 一次性延迟/指定时刻通知（2026-11-14）
-- 正典：docs/superpowers/specs/2026-11-14-notify-scheduler-integration-design.md §3.1
--
-- 语义：`available_at` 是事件最早可被 worker 领取的时刻。缺省 now() = 立即；
-- 未来值 = 延迟队列（不是 cron 调度器，周期排班归 platform.scheduler）。
--
-- 幂等：add column if not exists / update only null / set default / set not null。
-- 不用 `add column ... not null default now()`：now() 是 volatile default，旧版 PG 会重写整表；
-- 先加可空列、用 created_at 回填，再设 default/not null，迁移代价可控。
alter table notify.event
  add column if not exists available_at timestamptz;

update notify.event
   set available_at = created_at
 where available_at is null;

alter table notify.event
  alter column available_at set default now();

alter table notify.event
  alter column available_at set not null;

-- worker 的 claim 查询：status='new' 且已到期。部分索引把「未到期」的行挡在扫描外。
create index if not exists idx_notify_event_due
  on notify.event(available_at) where status = 'new';
