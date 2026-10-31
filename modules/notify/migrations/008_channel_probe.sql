-- 008_channel_probe.sql — 出站渠道的**活性证据**（spec 2026-10-31-multi-channel-im-provider-design.md §3.4）
--
-- 为什么要有它：直连的判据是「能取到 token」。取 token 这件事只有本模块做得到
-- （凭据在本模块的加密表里），而集成探针跑在宿主 server 里、**不许读 notify schema**（B1）。
-- 桥的办法是让宿主探 `{origin}/healthz`——那只能证明**桥进程**活着（租户没注册照样 200 = 假绿）。
--
-- 分工：本模块的 worker 每 ≥300s 对每条 `transport: 'direct'` 的通道做一次 gettoken（幂等、不发消息），
-- 把结论落本表；`deploy/integration-registry.json` 用 `sql:` 判据读本表（条目的 SQL 是**数据**，
-- 不是宿主代码里的 schema 依赖；`notify-worker-heartbeat` 已有同样先例）。
--
-- 一条 `(org, provider)` 一行 = 该渠道当前的最新证据：
--   · `last_ok_at` 只在**成功**时前进（失败不倒退，让「沉默多久」这个量保持真实）；
--   · `last_error` 非空 ⇒ 探针**判为失败**（判据据此落 PROBE_FAILED 并点名原因，
--     而不是笼统地 STALE——「凭据死了」与「没人用」处置完全不同）。
--
-- 幂等：create table if not exists。
create table if not exists notify.channel_probe (
  org        text        not null,
  provider   text        not null,
  -- 最近一次真去探的时间（无论成败）
  checked_at timestamptz not null default now(),
  -- 最近一次「凭据活着」的证据时间；NULL = 从未成功过
  last_ok_at timestamptz,
  last_error text,
  primary key (org, provider)
);
