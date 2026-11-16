-- 003_forms_mcp_audit_params.sql — 补齐 mcp_audit.params（spec §6.5 args 摘要）。
-- 迁移账本按**文件名 base** 记账：002 曾有「无 params」的版本被部分环境跑过，
-- 编辑 002 对它们不会重放 ⇒ 必须用新文件名补列（幂等，全新环境为 no-op）。
alter table forms.mcp_audit add column if not exists params jsonb not null default '{}'::jsonb;
