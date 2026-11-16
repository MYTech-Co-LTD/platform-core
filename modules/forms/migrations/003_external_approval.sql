-- 003_external_approval.sql — 企微标准审批**只读镜像**表（OA P2，issue #2385）
--
-- 分工：企微审批应用是执行方与事实源；平台**不创建** forms.submission、不建 case、不存附件，
-- 只镜像回调/对账能拿到的状态、审批人、时间与可得的表单摘要（计划 §已知边界：拿不到就不假装有）。
-- 写入面：宿主的企微回调路由（经 forms 模块端口）与小时级对账脚本，二者都走同一个
-- `on conflict (org, provider, provider_ref)` 幂等 upsert（重复回调不新增行）。
--
-- 状态词表由约束兜底（与 forms.submission 同款纪律：任何通路写错值都被 DB 拒）：
--   pending / approved / rejected / canceled
-- provider 缺省 'wecom'，为将来的第二家审批源留位（跨源同 provider_ref 不算同一单）。
--
-- 幂等迁移（create ... if not exists，重复执行不报错）。
create schema if not exists forms;

create table if not exists forms.external_approval (
  id            bigserial primary key,
  org           text not null,
  provider      text not null default 'wecom',
  process_code  text not null,
  provider_ref  text not null,
  title         text,
  requester     text,
  status        text not null,
  started_at    timestamptz,
  finished_at   timestamptz,
  detail        jsonb,
  synced_at     timestamptz not null default now(),
  constraint forms_external_approval_status_check
    check (status in ('pending', 'approved', 'rejected', 'canceled')),
  constraint forms_external_approval_ref_key unique (org, provider, provider_ref)
);

-- 镜像列表/导出按租户 + 开始时间倒序（页面与数据面唯一访问姿势）
create index if not exists idx_external_approval_org_time
  on forms.external_approval (org, started_at desc);
