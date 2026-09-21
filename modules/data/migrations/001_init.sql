-- 001_init.sql — 数据问数域建表（modules/data）。
--
-- 纪律（每条都有出处，别按口味改）：
--   · 幂等：全部 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 外部系统来的字段（指标 id / 名称）一律 text，不用 varchar（团队规则 db-migration §2）
--   · 隔离键一律 **org text not null**，值 = identity.orgId（= 本模块 DataTenant.casdoor_org），
--     读写一律 where org = $1——正典 docs/module-protocol.md「租户数据隔离」写死这个口径
--     （并写明为什么是 org 文本而不是 tenant_id 外键）。机器判据见
--     scripts/check-tenant-isolation.mjs（ci.yml 的 gates job）：模块 schema 下每张表都必须有
--     not null 的 org 列，**没有一个例外**——2026-09-21 裁决（本计划原稿用 tenant_id bigint，
--     会被该门禁判 3 处违规，已按正典订正）。
--   · token_hash 唯一索引：同一个 token 不可能落两行（也挡住重复写入）
--   · casdoor_user 列存的是 **Casdoor 用户名**（不是 sub）——getUser 只按 name 取，
--     见 apps/server/src/session-middleware.ts 的 casdoor.getUser(p.name) 用法。

create schema if not exists data;

-- ── 指标词表（语义层声明在平台库里的投影）──
create table if not exists data.metrics (
  org            text        not null,                  -- 租户隔离键，= identity.orgId
  id             text        not null,
  title          text        not null,
  description    text        not null default '',
  required_scope text,                                  -- NULL = 所有拿到本模块的人可见
  subject_column text        not null,                  -- 主体列名（如 org），授权核心据此拼 WHERE
  select_sql     text        not null,                  -- 不含 WHERE/GROUP BY/LIMIT 的 SELECT
  group_by       text        not null default '',       -- 不含前导空格，如 'org' 或 'org, day'
  params         jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (org, id)
);

-- ── 个人 Key（通道 B）──
-- 只存哈希：明文 token 只在创建响应里出现一次，永不落库/落日志。
create table if not exists data.query_keys (
  id           bigserial   primary key,
  org          text        not null,                    -- 租户隔离键，= identity.orgId
  casdoor_user text        not null,                    -- Casdoor 用户名（不是 sub）
  name         text        not null,
  token_hash   text        not null unique,             -- sha256 hex
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists data_query_keys_org_user_idx
  on data.query_keys(org, casdoor_user);

-- ── 统一审计（三通道一张表）──
create table if not exists data.query_audit (
  id         bigserial   primary key,
  org        text        not null,                      -- 钉死的主体值（= 授权核心写进 SQL 的那个值）兼租户隔离键
  user_id    text        not null,                      -- 通道报告的身份标识（会话=sub，PAT/企微=Casdoor 用户名）
  channel    text        not null,                      -- session | pat | wecom
  key_id     bigint,                                    -- 仅 pat 通道
  metric_id  text        not null,
  params     jsonb       not null default '{}'::jsonb,
  row_count  integer,
  verdict    text        not null,                      -- ok | denied | error
  reason     text,                                      -- 仅 denied/error
  created_at timestamptz not null default now()
);
create index if not exists data_query_audit_org_time_idx
  on data.query_audit(org, created_at desc);
