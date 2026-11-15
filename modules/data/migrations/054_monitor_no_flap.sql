-- 054_monitor_no_flap.sql — 业务监控防抖（Wave 7 V2b，spec §7/§15）。
--
-- 语义：越界要**连续 N 次**求值都成立才跃迁 ok→firing；中途恢复即清零。
-- 默认 1 = 与 V1/V2a 行为完全一致（第一次越界就通知）。
-- 幂等：部署每次全量重跑全部迁移（团队规则 db-migration §1）。

alter table data.monitor
  add column if not exists min_breach_evals integer not null default 1;
alter table data.monitor
  add column if not exists consecutive_breach integer not null default 0;
