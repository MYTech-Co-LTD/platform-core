-- 019_query_audit_masking.sql — 谁看过掩码值 / 谁看过原值（spec 2026-10-17 §4.4）。
--
-- 纪律（与 016/017/018 同源）：
--   · 幂等：add column if not exists。执行器是 apps/server/src/migrate.ts 的 runMigrations：
--     它按 platform.schema_migrations **记账去重，已记账的迁移不会重跑**。幂等是给「开发期
--     连跑」与「坏形状下重放」兜底 —— **别指望「删一列再上线能自动加回来」**（不会）。
--   · 无 create table ⇒ 无租户隔离面新增（data.query_audit 的 org 由 001 建立）。
--
-- masking = 本次查询**实际生效**的值级掩码「列 → 记号」，形如
--   {"fct_x.net_amount":"round:1000"}；整值掩码的键是字面量 <value>。
-- ⚠️ NULL 与 '{}' 是两回事（与 row_count 的 null≠0 同一把尺）：
--   NULL = 本次**没有任何掩码生效**（持有 grantedBy 豁免 / 指标未声明掩码 / 查询未执行）；
--   '{}' 在本设计里**不该出现**——applied 为空时调用方必须传 null。
--   两者的区别正是「审计能不能回答‘这个人看到的是原值还是掩码值’」。
alter table data.query_audit
  add column if not exists masking jsonb;
