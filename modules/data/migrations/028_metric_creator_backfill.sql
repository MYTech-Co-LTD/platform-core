-- 028_metric_creator_backfill.sql — 存量 L2 行的 created_by 从 create 审计回填
--（spec 2026-11-01 §10.2 creator 闸的配套；评审 PR #1271 发现 #4）
--
-- 027 给了 `created_by` 列，但**首插才写**——存量行全部 NULL。creator 闸（metric-write）对
-- NULL 行 fail-closed（METRIC_CREATOR_UNKNOWN）：不知道谁建的就不许改。若不回填，027 之前
-- 建的每一条 L2 都会锁死，存量管理流程全断。
--
-- 事实源不是「猜」：`data.metric_audit` 的 action='create' 行记了 userId（#489 起每次创建
-- 都记，与写同事务）。回填规则：
--   · 同 (org, metric_id) 取**最新**一条 create——建了删、删了建之后，现在的行属于最后一次
--     创建（中间的 create 属于已不存在的行）；
--   · 只回填 created_by IS NULL 的行 ⇒ **幂等**（重复执行结果一致，部署脚本全量重跑不炸）；
--   · 没有 create 审计的行（#489 之前的）保持 NULL ⇒ 闸继续拒（诚实状态：真不知道就不编）。
update data.metrics m
   set created_by = a.user_id
  from (
    select distinct on (org, metric_id) org, metric_id, user_id
      from data.metric_audit
     where action = 'create'
     order by org, metric_id, created_at desc, id desc
  ) a
  where m.org = a.org
    and m.id = a.metric_id
    and m.source = 'l2'
    and m.created_by is null;

comment on column data.metrics.created_by is
  'L2 创建者（Casdoor 用户名）；L1 行 NULL（平台口径）。「只能管理自己创建的」据此判定。存量行由 028 从 create 审计回填；无 create 审计的行保持 NULL（creator 闸 fail-closed）';
