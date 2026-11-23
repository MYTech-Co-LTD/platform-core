-- 007_audit.sql — 售后写操作审计（评审 P0-2：写钱/删物必须有痕）。
--
-- 为什么是模块自有表而不是 platform.audit：宿主审计表在 platform schema，模块按 B1 只能写
-- 自己的 schema（写侧无豁免，声明面也不开放写）。与 notify.audit 同构——模块审计面归模块。
--
-- 纪律：
--   · org not null（租户隔离门禁）；action 命名 `<entity>.<verb>`；
--   · detail 只记业务事实（状态/金额/比例/计数/被删内容摘要），**不记手机号明文、不记密钥**；
--   · 与业务写**同事务**：事务回滚 ⇒ 审计不留行（审计记录的是「已发生的写」，不是「尝试」）。
create table if not exists aftersales.audit (
  id         bigserial primary key,
  org        text        not null,
  actor      text        not null,
  action     text        not null,
  target     text        not null default '',
  detail     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_org_created_idx on aftersales.audit (org, created_at desc);
