-- 021_query_audit_tool.sql — MCP 工具面审计扩列（spec 2026-10-21 §8）。
--
-- tool = 触发本条审计的工具名（分析师面 11 工具 / legacy 指标工具的 sanitized 名）。
-- 可空：HTTP /query、chat 等「无 MCP 工具」的既有通路不带 tool（legacy 行可辨）。
-- 非指标工具（guide 等）metric_id 落 ''（空串 ≠ null；列 not null，语义 = 本次无指标对象）。
-- 纪律同 019：幂等 add column if not exists；无 create table ⇒ 无租户隔离面新增。
alter table data.query_audit
  add column if not exists tool text;
