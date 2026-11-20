-- 024_scheduler_drain.sql — 部署前排空信号（#2567）
--
-- 为什么需要：发版会重启 scheduler 容器（新镜像）。CI 的运行中作业闸门只在**触发时**查一次
-- running=0，而构建要 5–10 分钟——这段窗口里新起的作业（hourly 17 分钟、审计 40–90 分钟）
-- 会在容器重启时被砍成 0s timeout。2026-11-20 实测：01:05 / 03:05 / 05:05 三条 hourly 都是这么没的。
--
-- 容器侧的「优雅停机」（SIGTERM 后等子进程收尾）**解决不了**，因为 docker stop 的宽限期由
-- 部署方决定：openship 虽然把 compose 的 `stop_grace_period` 存进了 `advanced.stopGracePeriod`，
-- 但没传给 Docker（实测新容器 `HostConfig.StopTimeout=None`，重启只等 10s 就 SIGKILL）。
--
-- 所以把「别起新作业」这件事做在**部署之前**（CI 侧）：
--   1. 闸门等到 running=0；
--   2. 写一行 `scheduler_control(key='drain')`，带 `until` 到期时间；
--   3. 触发部署（构建期间 worker 看到 drain 就**不再 claim**，自然没有作业会被砍）；
--   4. 新容器启动时**清掉**这一行（部署已落地）；部署失败则由 `until` 到期自动失效。
--
-- 幂等：`create table if not exists`。
create table if not exists platform.scheduler_control (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table platform.scheduler_control is
  '调度器控制信号（#2567）。key=''drain'' 表示「部署在即，别再 claim 新作业」，value.until 是到期时间（RFC3339）；新容器启动时清除。';
