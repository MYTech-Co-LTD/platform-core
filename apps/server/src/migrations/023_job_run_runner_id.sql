-- 023_job_run_runner_id.sql — 调度实例归属（#2511，业务调度拆到数据单元）
--
-- 为什么需要：两个部署单元各跑一个调度者后，`reapLostRunners` 原来是
-- `update ... where status='running'`（**全表扫**）⇒ 数据单元启动那一刻会把应用单元
-- 正在跑的作业判成 timeout（作业本体还在跑，台账却说超时）。归属列把启动对账收窄成
-- 「只收我自己这个实例上一次化身留下的行」。
--
-- 幂等：DDL 全部 if not exists；回填只碰 runner_id is null 的行。
alter table platform.job_run add column if not exists runner_id text;

-- 历史行（迁移前跑的）没有归属。回填一个**任何实例都不会认领**的标记：
--   · 用 NULL 会让 `runner_id = $1` 永远匹配不到，语义上也可以，但显式标记便于排查；
--   · 这些行的收口交给 reapStale 的超时判定（它按 started_at 判，不看归属）。
update platform.job_run set runner_id = 'scheduler-legacy' where runner_id is null;

-- 启动对账/看护的查询都带 `status='running'` ⇒ 用部分索引，只索引在跑的那一小撮。
create index if not exists job_run_running_runner_idx
  on platform.job_run (runner_id) where status = 'running';

comment on column platform.job_run.runner_id is
  '执行该 run 的调度实例（SCHEDULER_INSTANCE_ID；单域时派生为 scheduler-platform / scheduler-data）。迁移前的历史行为 scheduler-legacy。';
