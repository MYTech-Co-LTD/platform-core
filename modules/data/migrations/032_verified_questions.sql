-- 032_verified_questions.sql — W1 可信度地基：已验证问答（回归集）
-- 幂等：create table if not exists / create index if not exists。
create table if not exists data.verified_questions (
  id            bigserial   primary key,
  org           text        not null,
  question      text        not null,
  metric_id     text        not null,
  params        jsonb       not null default '{}'::jsonb,
  slicing       jsonb       not null default '{}'::jsonb,
  baseline      jsonb       not null,
  tolerance     numeric     not null default 0.001,
  source        text        not null,                 -- human | auto
  strength      text        not null default 'human', -- human | strong | weak
  status        text        not null default 'candidate', -- candidate | verified | rejected | stale
  verified_by   text,
  verified_at   timestamptz,
  last_checked_at timestamptz,
  last_check_result text,                              -- pass | fail | error
  session_id    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (source in ('human','auto')),
  check (strength in ('human','strong','weak')),
  check (status in ('candidate','verified','rejected','stale'))
);
-- 唯一键含 slicing：同题同参但**切面不同**就是不同结果基线，不能合行（2026-11-04 评审定案）。
-- ⚠️ 本迁移尚未随任何版本发布；若某 DB 已按评审前的 4 列版本建过索引，迁移记账表不会重跑
-- 本文件 ⇒ 需手工 `drop index data.verified_questions_org_metric_q_idx` 后重跑本文件。
create unique index if not exists verified_questions_org_metric_q_idx
  on data.verified_questions (org, metric_id, md5(question), md5(params::text), md5(slicing::text));
create index if not exists verified_questions_org_status_idx
  on data.verified_questions (org, status);
