-- 011_notify_delivery_sent_at.sql — 投递的“实际发送时刻”（2026-11-14，N0.2）
--
-- 为什么需要它：每通道限流与 cooldown 现在用 `delivery.created_at` 计数。但 delivery 行
-- 在**入队时**创建，可能因重试/退避/积压晚几分钟甚至更久才真正发出去：
--   · 早创建、晚发送 ⇒ 不会计入窗口（限流失效）；
--   · 早创建、晚重试成功 ⇒ 同样漏计。
-- `sent_at` 由 markDeliverySent 写入；窗口/冷却一律按它算。
--
-- 迁移编号用 011：010 是并行的 `notify.event.available_at`（PR #2169），避免同名冲突；
-- 迁移执行器按文件名记账，跳号无影响。
alter table notify.delivery
  add column if not exists sent_at timestamptz;

-- 历史 sent 行的实际发送时刻近似为 updated_at（markDeliverySent 当时写的就是 now()）。
update notify.delivery
   set sent_at = updated_at
 where status = 'sent' and sent_at is null;

create index if not exists idx_notify_delivery_channel_sent
  on notify.delivery(org, channel, sent_at) where status = 'sent';
