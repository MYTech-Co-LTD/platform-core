-- 002_audit_retention.sql — platform.audit 的保留策略（M1 闭债 R2）
--
-- 背景：001 建表时只有主键，at 无索引、全仓无清理逻辑 ⇒ 表单调增长，且增长速率由攻击者
-- 决定（登录端点此前无限速，每次失败写一行）。限速（apps/server/src/rate-limit.ts）只降低
-- 速率，**不改"无界"这件事**，故保留策略必须同时做。
--
-- 清理【不】由应用进程执行：有副作用的运维动作不该藏在一个 HTTP 服务里。这里只提供函数，
-- 由 openship job 定时调用（见 deploy/openship-adopt.md「audit 保留」）。

-- 只为 prune 的 where 子句服务：不预先造用不上的复合索引
create index if not exists audit_at_idx on platform.audit(at);

-- 删除 keep_days 之前的审计行，返回删除行数（便于 job 日志核对）
create or replace function platform.prune_audit(keep_days int default 90)
returns bigint
language sql
as $$
  with deleted as (
    delete from platform.audit
     where at < now() - make_interval(days => keep_days)
    returning 1
  )
  select count(*) from deleted;
$$;
