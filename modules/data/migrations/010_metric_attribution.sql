-- 010_metric_attribution.sql — L2 行的「最后操作人 + 版本」+ 口径变更审计表（#489）。
--
-- 为什么另立一张审计表而不是塞进 query_audit：那张表的列是**查询语义**
-- （row_count / verdict / reason），硬塞写行会让三列全部变 nullable ——「没有 row_count」
-- 将同时表示「这是写行」与「这次查询没出数」，语义立刻模糊。设计见
-- docs/superpowers/specs/2026-10-07-metric-attribution-design.md §4④。
--
-- 幂等：本文件会被**每次部署全量重跑**（runMigrations 按记账跳过已应用的，但开发期会连跑）。

alter table data.metrics add column if not exists updated_by text;
alter table data.metrics add column if not exists version    integer not null default 1;

create table if not exists data.metric_audit (
  id          bigserial primary key,
  org         text   not null,                       -- 隔离键（= Casdoor org），口径与 query_audit 一致
  metric_id   text   not null,                       -- **删除后仍在** —— 这正是本表存在的理由
  action      text   not null check (action in ('create', 'update', 'delete')),
  user_id     text   not null,                       -- 人（不是 key）
  channel     text   not null,                       -- session | pat | wecom
  key_id      bigint,                                -- 仅 pat 通道（与 query_audit.key_id 同型）
  -- 变更**前**的行快照：create 为 NULL；变更**后**的行快照：delete 为 NULL。
  -- 两列而不是一列，是为了答「**从什么**到什么」——只存后态就答不了「从什么」。
  row_before  jsonb,
  row_after   jsonb,
  created_at  timestamptz not null default now()
);

-- 页面抽屉的查询形状（按 org + id 取最近若干条）
create index if not exists data_metric_audit_lookup_idx
  on data.metric_audit (org, metric_id, created_at desc);
