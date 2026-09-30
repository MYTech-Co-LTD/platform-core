-- 007_report_spec.sql — 平台自绘报表的**声明式规格**（spec §3⑥；计划 6）。
-- 存成一列而非另开表：这样规格写保护**免费复用**登记表版本守卫（plan 4），
-- 且与既有裁决「不为发布另开状态列」一致。
alter table data.reports add column if not exists spec jsonb;
-- 跨列约束：自绘行必须有规格（Metabase 行必须没有——两边都不许半吊子）
do $$ begin
  alter table data.reports add constraint data_reports_spec_by_renderer check (
    (renderer = 'platform' and spec is not null) or (renderer = 'metabase' and spec is null)
  );
exception when duplicate_object then null; end $$;
