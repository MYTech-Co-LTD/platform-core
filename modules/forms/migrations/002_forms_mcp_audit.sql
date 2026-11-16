-- 002_forms_mcp_audit.sql — forms MCP 调用审计（2026-11-16 能力网关 spec §6.5）。
-- 每次 tools/call 一行：org / 调用者 / 工具 / outcome / 机检原因 / 涉及资产版本。
-- 审计失败**不得改变业务结果**（应用层 try/catch 吞掉并告警）；因此本表不做外键、不做必填外键校验。
-- 幂等迁移（重复执行不报错）。
create table if not exists forms.mcp_audit (
  id         bigserial primary key,
  org        text not null,
  user_id    text not null,
  tool       text not null,
  outcome    text not null check (outcome in ('ok', 'denied', 'error')),
  reason     text,
  asset_id   text,
  version    integer,
  created_at timestamptz not null default now()
);
create index if not exists forms_mcp_audit_org_idx on forms.mcp_audit (org, created_at desc);
