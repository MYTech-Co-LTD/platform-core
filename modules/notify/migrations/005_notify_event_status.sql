-- 005_notify_event_status.sql — 事件状态扩三种「发不出去」的终态（可送达性 D2）。
-- 正典：docs/superpowers/specs/2026-10-28-notify-deliverability-design.md §3.1
--
-- ⚠️ 约束名是 **event_status_check**（2026-10-28 生产 pg_constraint 实测），
--    不是 notify_event_status_check。写错会让 drop ... if exists 静默 no-op，
--    随后 add 撞上旧约束 ⇒ 迁移失败。
alter table notify.event drop constraint if exists event_status_check;
alter table notify.event add constraint event_status_check
  check (status in ('new','matched','no_rules','no_recipients','no_channel','invalid'));
