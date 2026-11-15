-- 016_notify_delivery_owner_namespace.sql — 投递冻结 agent namespace 归属（N5）
--
-- 为什么在 delivery 上冗余一列，而不是查询时 join rule：
--   ① delivery 是**历史**，rule 可被删除；join 会让已发生投递的归属凭空消失。
--   ② per-namespace 指标要按 owner_namespace 聚合/过滤，走索引比 join 稳。
-- 语义：null = 平台/租户人管（builtin/derived/manual/人工规则或历史行）；
--       非空 = 该 agent namespace 所有。
--
-- 历史回填只补还能从 rule 找到归属的行；rule 已删的历史行保持 null（不猜）。
alter table notify.delivery
  add column if not exists owner_namespace text;

update notify.delivery d
   set owner_namespace = r.owner_namespace
  from notify.rule r
 where d.org = r.org
   and d.rule_id = r.id
   and d.owner_namespace is null
   and r.owner_namespace is not null;

create index if not exists idx_notify_delivery_owner_namespace
  on notify.delivery(org, owner_namespace, created_at desc);
