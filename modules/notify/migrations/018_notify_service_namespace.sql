-- 018_notify_service_namespace.sql — C（企微/openclaw）的 service-owned 命名空间
--
-- 背景（2026-11-16 能力网关 spec §5.2 / D14）：C 的 agent namespace 由**部署钉死**，
-- 不由模型或调用者选。它属于部署（system:openclaw），不属于某个终端用户；因此：
--   · service_owned=true 的 namespace 只接受 `allowServiceNamespace` 的写入（C 通道）；
--   · 人拥有的 namespace 绝不能被静默改写成 service-owned（冲突时 fail loudly）。
-- 幂等：add column if not exists。
alter table notify.agent_namespace
  add column if not exists service_owned boolean not null default false;
