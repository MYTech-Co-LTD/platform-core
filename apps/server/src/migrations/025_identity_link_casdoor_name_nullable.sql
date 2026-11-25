-- 025_identity_link_casdoor_name_nullable.sql — 放开 casdoor_name 的 NOT NULL（2026-11-25 人裁订正）
--
-- 背景（spec 2026-10-10-aftersales-account-unification-design §1.1 订正段）：
-- 原设计「自动匹配未命中 ⇒ 建草稿 Casdoor user」的副作用是**影子账户**——每个未匹配的微信
-- 用户都在 Casdoor 里多一个 `name=openid` 的用户（不在组织架构、无角色），真人因此有两个账户。
-- 更根本的是：它为了满足 `casdoor_name NOT NULL` 而去创建一个**真实用户**。
--
-- 订正后语义：
--   casdoor_name IS NULL  ⇒ 这条绑定**尚未指向任何人**（外部身份已识别，但没对上组织架构里的人）
--   casdoor_name IS NOT NULL ⇒ 已指向某个 Casdoor 账户（pending 时可能是机器给出的候选建议）
--
-- 幂等：`drop not null` 可重复执行。
alter table platform.identity_link
  alter column casdoor_name drop not null;
