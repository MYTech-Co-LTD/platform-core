-- 014_integration.sql — 集成健康登记（spec 2026-10-31-integration-health-design.md §2.1）
--
-- 为什么要有这张表：出站集成（回调 / 凭据 / 通道）最致命的一类失效是「**该来的没来**」——
-- 它没有调用方，所以引擎告警（要有事件）、投递失败（要有投递）、容器健康（只证明进程活着）、
-- job 失败（要有 job）**四种既有机制全覆盖不到**。2026 年 woke 的 suite_ticket 就这样静默死了两个月。
--
-- 语义：一行 = 一个「凭什么判它活着」的登记。
--   · `sla_seconds`  允许多久没有「活着」的证据（取值依据见 spec §2.2）
--   · `last_ok_at`   最近一次活着证据的时间（探针写回；NULL = **从接入起就没活过**，按超期算）
--   · `last_probe_at` / `last_error` 探针自身的执行情况——与 last_ok_at 分开，
--     因为「探不了」和「查了确实没动静」必须能区分（排障方向完全不同）
--
-- 租户维度：同一集成不同租户各算各的 ⇒ 主键 (id, org)，非租户维度的集成 org 存空串。
--
-- 幂等：create table if not exists（迁移器按文件名记账，重复执行不报错）。
create table if not exists platform.integration (
  id            text        not null,
  org           text        not null default '',
  kind          text        not null check (kind in ('callback', 'token', 'channel')),
  -- 判据来源（探针 job 解释它）：如 `sql:select max(received_at) from ...` / `http:...` / `token:wecom-suite`
  source        text        not null,
  sla_seconds   integer     not null check (sla_seconds > 0),
  enabled       boolean     not null default true,
  last_ok_at    timestamptz,
  last_probe_at timestamptz,
  last_error    text,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id, org)
);

-- 控制台读面按「最近活跃」排序（最该看的排最前）
create index if not exists idx_integration_stale
  on platform.integration (last_ok_at nulls first)
  where enabled;
