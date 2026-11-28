-- 013_ticket_submission_quality.sql — 售后提报规范性（2026-11-28）
--
-- 处理工单时由售后人员标注这张单的提报质量；**仅管理端可读**（访客/门店侧接口不 SELECT 本列）。
-- 空串 = 未评价（存量单 + 尚未处理的单）。
--
-- 值域与 console 的 QUALITY_LABEL 一一对应；新增值要同时改 check 与前端标签。
alter table aftersales.ticket
  add column if not exists submission_quality text not null default '';

-- Postgres 没有 add constraint if not exists ⇒ 用 DO 块保证迁移幂等。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'aftersales.ticket'::regclass
       and conname = 'ticket_submission_quality_check'
  ) then
    alter table aftersales.ticket
      add constraint ticket_submission_quality_check
      check (submission_quality in ('', 'normal', 'false_claim', 'late', 'duplicate', 'incomplete'));
  end if;
end $$;
