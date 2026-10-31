-- 017_org_member_identity.sql — 成员行带上「来源」与「渠道原生地址」（spec 2026-10-31 §3.1）
--
-- 为什么要有它：`user_name` 今天同时扮演「平台标识（Casdoor name）」和「企微 userid」两个角色，
-- 而两者的相等只是 `012_org_tables.sql` 里**一句注释的断言**——不是约束，也不是事实。
-- 一旦用 `POST /org-sync?source=casdoor` 同步过，`user_name` 就变成 Casdoor 名字，消费方
-- （部门展开、通知投递）无从分辨手里拿的是哪一个；发送时只能靠 `address_fallback=casdoor_name`
-- 把名字**猜回**地址（2026-10-31 山海 81013 排查时暴露）。
--
-- 语义（以列注释为准，不只写在 spec 里）：
--   · `source`      —— 这一行由哪个源写入：'wecom' | 'casdoor'。**NULL = 本迁移之前的旧行，来源未知**
--                      （不回填：来源未知是一个诚实状态，强填等于造假）。
--   · `external_id` —— 该源渠道的**原生地址**（wecom 源 = 企微 userid）；casdoor 源为 NULL（未知）。
-- 解析顺序（宿主 `channel-address.ts`）：source 与 provider 匹配的 external_id → identity_link
-- → 模块侧兼容兜底（带 warn）。**不跨渠道硬套、不拿 NULL 当 wecom 用。**
--
-- 幂等：add column if not exists。
alter table platform.org_membership
  add column if not exists source      text,
  add column if not exists external_id text;

comment on column platform.org_membership.source is
  '写入来源：wecom | casdoor；NULL = 017 之前的旧行（来源未知，消费方不得当作 wecom）';
comment on column platform.org_membership.external_id is
  '该源渠道的原生地址（wecom 源 = 企微 userid）；与 user_name 语义不同，今天可能同值';
