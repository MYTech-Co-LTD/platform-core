-- 046_metric_change.sql —— 指标变更单（spec 2026-11-12 §5.2，P0）。
-- 一张单 = agent 的一次提案；人只对它做「采纳 / 驳回」。生效路径不在本表——
-- 采纳时走既有唯一编译点，产物落 data.metrics，本表只留 adopted_snapshot 作凭据。
-- kind 按 spec 五值备全：override 档随 P1 接入，表先按 spec 备好值（P0 代码只写前四值）。
create table if not exists data.metric_change (
  id            bigserial primary key,
  org           text not null,
  metric_id     text not null,
  kind          text not null check (kind in ('create','update','meta','override','delete')),
  payload       jsonb not null,
  status        text not null default 'draft'
                check (status in ('draft','preview_ready','preview_failed','adopted','rejected','superseded','withdrawn')),
  preview       jsonb,
  submitted_by  text not null,
  submitted_channel text not null,
  submitted_at  timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  reject_reason text,
  adopted_snapshot jsonb
);

-- 同一指标同时只允许一张未决单（防两份草稿互相覆盖，评审 #1271-#7 同款问题）
create unique index if not exists metric_change_one_pending_uq
  on data.metric_change (org, metric_id)
  where status in ('draft','preview_ready','preview_failed');

create index if not exists metric_change_queue_idx
  on data.metric_change (org, status, submitted_at desc);
