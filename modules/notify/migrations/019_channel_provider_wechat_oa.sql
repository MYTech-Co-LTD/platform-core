-- 019_channel_provider_wechat_oa.sql — 通道 provider 增加 `wechat_oa`（公众号模板消息，#2805）
--
-- 背景：员工在公众号里提交售后工单，回执/处理结果要经公众号模板消息推给他本人。
-- 架构位置：`modules/notify/domain/im/senders.ts` 预留的扩展点（写 sender + 注册 + 模板加渲染键）。
--
-- ⚠️ 本迁移与 `modules/notify/domain/providers.ts` 的 `NOTIFY_PROVIDERS` **必须同步**：
--    providers.ts 是代码侧唯一事实源（门禁 check-integrations 读它），DB 的 check 约束是
--    第二份事实；两处漂移的症状是「代码里能选、写库时报错」或反之。
--
-- 幂等：部署脚本每次全量重跑迁移 ⇒ 先按名字删旧约束再建（`add constraint if not exists`
-- 在 PG 里不存在）。
alter table notify.channel drop constraint if exists channel_provider_check;

alter table notify.channel
  add constraint channel_provider_check
  check (provider in ('wecom_chat', 'in_app', 'webhook', 'wechat_oa'));
