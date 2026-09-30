-- 005_report_version.sql — 登记侧版本号（spec §3③ 的「登记表上的单调计数」形态）。
-- 幂等：重复执行不报错（部署脚本每次全量重跑全部迁移）。
alter table data.reports add column if not exists version integer not null default 1;
