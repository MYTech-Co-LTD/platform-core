-- 002_item_platform.sql — 事项平台：审批模板 kind、提交状态列、审计（issue #2363，OA P0）。
-- 内核不动：审批模板与表单定义共用同一套 draft/publish/head/rollback 生命周期（001_kernel.sql），
-- 差异只在 forms.kind 的策略行与 body 形状（approval_def 的 body 是审批 DSL，不是 JSON Schema）。
-- 纪律：幂等迁移（create ... if not exists / drop ... if exists / DML on conflict，重复执行不报错）。

-- ── 1) 审批模板 kind：与 form_def 同策略（发布是人唯一 gate） ──
insert into forms.kind (kind, publish_policy, note)
values ('approval_def', 'human_gate', '审批模板：inapp 链 DSL / wecom_native 绑定')
on conflict (kind) do update set publish_policy = excluded.publish_policy, note = excluded.note;

-- ── 2) 提交状态机列：状态与引擎镜像（case_ref）分开落，回调只改状态不碰 body ──
-- status 缺省 'submitted'：既有收集类提交（无审批链）语义不变。
alter table forms.submission add column if not exists status text not null default 'submitted';
alter table forms.submission add column if not exists provider text;
alter table forms.submission add column if not exists root_submission_id bigint;
alter table forms.submission add column if not exists supersedes_id bigint;
alter table forms.submission add column if not exists case_ref text;
alter table forms.submission add column if not exists approval_plan jsonb;
alter table forms.submission add column if not exists decided_at timestamptz;
alter table forms.submission add column if not exists decision_action text;
alter table forms.submission add column if not exists decision_comment text;
alter table forms.submission add column if not exists withdrawn_at timestamptz;

-- 状态词表由约束兜底（不是应用层自觉）：回调/撤回/补偿任何一条通路写错值都被 DB 拒。
alter table forms.submission drop constraint if exists forms_submission_status_check;
alter table forms.submission add constraint forms_submission_status_check
  check (status in ('submitted','pending_approval','approved','rejected','withdrawn'));

-- 待办面（审批人的「待我审批」列表）：只索引在途行，行量与全表无关。
create index if not exists idx_forms_submission_pending
  on forms.submission (org, status, submitted_at desc)
  where status = 'pending_approval';

-- ── 3) 事项审计：谁在什么时候动了什么（模板发布/撤回/决策回写都记一条） ──
-- 租户数据表（org not null）；不分 kind——同一租户的表单与审批写同一本账。
create table if not exists forms.audit (
  id     bigserial primary key,
  org    text not null,
  actor  text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  at     timestamptz not null default now()
);
create index if not exists idx_forms_audit_org_at on forms.audit (org, at desc);
