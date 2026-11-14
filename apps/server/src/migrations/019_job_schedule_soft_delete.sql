-- 019_job_schedule_soft_delete.sql — 删排班一律软删（job_run 是审计，不能被级联带走）
-- 幂等：if not exists（重跑全量迁移不报错，存量行 deleted_at 保持 null）。
alter table platform.job_schedule add column if not exists deleted_at timestamptz;
