-- 016_probe_heartbeat.sql — 探针自身的心跳（spec 2026-10-31-integration-health-design.md §2.4）
--
-- 为什么需要：整套告警的前提是「探针在跑」。而探针自己也可能停——进程活着、定时器不再触发、
-- 每轮都在报错但没人看。那时所有集成都停在「上一次的结论」上，看起来一切正常，实际已经失明。
-- 这就是 §2.4 说的「元级看门狗是必须项，不是加分项」。
--
-- 语义：
--   · 探针**每轮都写一行**（哪怕本轮没有任何集成到期）——心跳证明的是「循环还在转」，
--     不是「有活干」；
--   · `enabled=false` 记「本实例把探针关了」（INTEGRATION_PROBE_INTERVAL_MS=0）——
--     看门狗据此报「未启用」而不是「挂了」，两种状态不能混；
--   · `interval_ms` 让看门狗按**配置的周期**算阈值（2× 周期），不写死常量。
--
-- 幂等：create table if not exists。
create table if not exists platform.probe_heartbeat (
  id          text        primary key,
  beat_at     timestamptz not null default now(),
  enabled     boolean     not null default true,
  interval_ms integer     not null default 0
);
