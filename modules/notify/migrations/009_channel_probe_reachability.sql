-- 009_channel_probe_reachability.sql — 渠道探针的「个人级可达性」抽样（plan 2026-10-31 Phase 2 / #1225）
--
-- 为什么要它：`last_ok_at` 证的是「应用凭据能换 token」，证不到「这批人收得到」。
-- `81013`（收件人不在应用可见范围）与 `missing_channel_address`（地址解析不出）今天只躺在
-- delivery.last_error 里——没有业务消息时就看不见，等真消息发出去已经晚了。
--
-- 语义：探针每轮顺带抽 N 个成员调 `user/get`（幂等、不发消息），把结论记在这三列。
--   · `reachable`   —— 本轮抽样中企微认得的地址数
--   · `unreachable` —— 本轮抽样中被企微拒的地址数（60111/81013 等）
--   · `sampled_at`  —— 哪一轮抽的（与 `checked_at` 分开：凭据探活与抽样频率不同）
-- **不进 SLA**：这些计数只用于读面与日志，不改变 `last_ok_at` / 判据 verdict（plan D1）。
--
-- 幂等：add column if not exists。
alter table notify.channel_probe
  add column if not exists reachable   integer,
  add column if not exists unreachable integer,
  add column if not exists sampled_at  timestamptz;
