-- 017_notify_audit_rule_history_index.sql — 规则历史按 (org,target) 查询（2026-11-15）
--
-- 现有索引是 (org, created_at desc)；history 固定按 rule id 过滤，单租户审计行变多后
-- 会退化成扫描。补 (org, target, created_at desc)。
create index if not exists idx_notify_audit_org_target
  on notify.audit (org, target, created_at desc);
