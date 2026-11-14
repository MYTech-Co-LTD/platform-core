-- 049_report_versions_immutable.sql — 发布快照的**库级不可变**（R6）。
--
-- 为什么下沉到库：022 起 `data.report_versions` 在服务层就是「只插不改」，但服务层纪律挡不住
-- 任何直连（psql、迁移脚本、别的服务）。快照被改 = 用户看到的「当时发布的样子」是假的，
-- 而这正是报表争议时唯一的证据 ⇒ 在触发器层面拒掉 UPDATE。
--
-- ⚠️ 只拦 UPDATE，**不拦 DELETE**：022 的外键是 `on delete cascade`，回收报表要连带删版本
--    （设计如此）。若把 DELETE 也拦了，报表回收会直接失败——那是另一件事，不在本迁移的射程内。
--    真要做到「连删除也不许」，需要先改回收语义（软删 / 归档），另案。
--
-- 幂等：函数 `create or replace`；触发器先 `drop ... if exists` 再建。部署脚本每次全量重跑，
-- 重跑必须安全（团队规则 db-migration §1）。

create or replace function data.reject_report_version_update() returns trigger
language plpgsql as $$
begin
  raise exception 'REPORT_VERSION_IMMUTABLE: data.report_versions 是发布快照，只能新增，不能修改'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists report_versions_no_update on data.report_versions;
create trigger report_versions_no_update
  before update on data.report_versions
  for each row execute function data.reject_report_version_update();
