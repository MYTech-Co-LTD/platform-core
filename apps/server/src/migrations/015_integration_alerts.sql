-- 015_integration_alerts.sql — 集成健康 Phase 2b：STALE 告警的状态位（spec §2.4，#1189 续）
--
-- 职责切分（与探针解耦）：
--   · **探针（server 进程）**写 `last_verdict` + 依据迁移语义对 `stale_notified` 置位（装填）；
--   · **notify worker（独立容器）**扫「装填了但未通知」的行 → 入队 `notify.integration.stale`
--     事件 → 落 `stale_notified = true`。worker 死了标志位还在，重启后照发（至少一次语义）。
--
-- 为什么需要 `last_verdict`：**进入 STALE 才告警一次**（transition），持续 STALE 不重复轰炸
-- ——否则一条集成长期红会让企微每分钟收一条（山海 bridge 现状就是长期 PROBE_FAILED，
-- 若按「每轮红就发」会变成预警风暴，OO/桥的 #1198 同款教训）。
--
-- 幂等：add column if not exists。
alter table platform.integration add column if not exists last_verdict text;
alter table platform.integration add column if not exists stale_notified boolean not null default true;
