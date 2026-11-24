-- 055_report_events.sql — 报表事件遥测（N1–N4 的数据基础）。
--
-- 为什么需要：report_views 只存「最近一次访问」，回答不了「这张报表是谁建的、改过几次、
-- 多久发布、被谁导出」——N1（独立完成率）/N2（首次提案接受率）/N4（口径修正率）因此不可计算。
--
-- 事件类型（字符串闭集，由 domain 层写入；这里用 check 钉住，防手写脏值）：
--   created / spec_edited / published / viewed / exported
-- source：agent（MCP 提报）/ http（控制台或 API 调用）/ system。
-- meta：自由但只放可审计的小字段（渲染器、格式、变更摘要哈希等），**不放指标值**。
create table if not exists data.report_events (
  id         bigserial   primary key,
  org        text        not null,
  report_id  text        not null,
  actor      text,
  event      text        not null,
  source     text        not null default 'http',
  meta       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint report_events_event_check
    check (event in ('created', 'spec_edited', 'published', 'viewed', 'exported')),
  constraint report_events_source_check
    check (source in ('agent', 'http', 'system')),
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);

create index if not exists report_events_org_time_idx
  on data.report_events (org, created_at);
create index if not exists report_events_report_idx
  on data.report_events (org, report_id, created_at);
