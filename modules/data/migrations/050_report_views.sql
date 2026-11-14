-- 050_report_views.sql — 报表访问台账（R6：30 天零访问归档提醒的事实来源）。
--
-- 为什么需要：报表只增不删，没人看的报表会越积越多，而「没人看」此前无从判断。
-- 记录点只有一个：`GET /published-spec`（观看面真正渲染一份已发布报表时）。列表/管理面
-- **不**算访问——打开管理清单不等于看了内容。
--
-- 存储策略：每个 (org, report_id) 一行，UPSERT 更新最后访问时间与次数；不存逐次流水
-- （那是审计面的事，`data.query_audit` 已有）。写入 best-effort，失败不反噬观看。
create table if not exists data.report_views (
  org            text        not null,
  report_id      text        not null,
  last_viewed_at timestamptz not null default now(),
  last_viewed_by text        not null,
  view_count     bigint      not null default 1,
  primary key (org, report_id),
  -- 报表删除（生命周期回收）连带清访问台账：与版本表同一口径。
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);

create index if not exists data_report_views_stale_idx
  on data.report_views (org, last_viewed_at);
