-- 002_employee_registration.sql — M3b-1（spec §2.5）：员工登记/变更申请 + 员工↔门店多对多。
--
-- 幂等：本执行器按文件名记账、每个文件一个事务，但**部署脚本可能全量重跑** ⇒ 一律
-- `if not exists`（本仓迁移纪律）。
--
-- 两张表都是【租户数据表】：带 org text not null、唯一索引含 org、热路径索引以 org 为前缀列
-- （spec-1 §2 的三条纪律；门禁见 scripts/check-tenant-isolation.mjs）。

create schema if not exists aftersales;

-- ── 登记/变更申请 ────────────────────────────────────────────────────────────
-- 对应源侧 employee_info_approve（spec §2.1）。**不照搬**源的两个嵌套字段：源把 old/new 塞进
-- 一个 approveinfo 里（spec §0.1 记为「全区唯一的嵌套突破扁平」），这里显式两列 jsonb。
create table if not exists aftersales.employee_approval (
  id           bigserial primary key,
  org          text not null,
  -- 申请人身份锚（访客 session 的 identity.userId = openid）
  open_id      text not null,
  -- 注册 vs 变更：定死英文枚举（源侧中文「注册/变更」是展示层的事，spec §5 #9）
  approve_type text not null check (approve_type in ('register', 'change')),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  -- 服务端算出的差异（spec §2.5 纪律②）：变更时只含**实际变了的字段**
  old_info     jsonb not null default '{}'::jsonb,
  new_info     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text
);

-- ★ 防重**由库保证**（spec §2.5 纪律①）：同一个人的待审申请同时只能有一条。
-- 源侧那句「您已有待审批的申请」是提交前查一次的前端判定 —— 两个并发的提交请求都能查到 0 条
-- ⇒ 都插入 ⇒ 两条待审。部分唯一索引把这件事变成数据库层面的不可能，且**只约束 pending**
-- （已决的历史申请可以有多条，不受影响）。
create unique index if not exists aftersales_employee_approval_pending_idx
  on aftersales.employee_approval(org, open_id)
  where status = 'pending';

-- 管理端列表的热路径：where org = $1 [and status = $2] order by id desc ⇒ org 前缀列
create index if not exists aftersales_employee_approval_org_status_idx
  on aftersales.employee_approval(org, status, id desc);

-- ── 员工↔门店多对多 ──────────────────────────────────────────────────────────
-- 源侧 employee_info.store_info 是**逗号分隔的多门店串**（多选），而 employee.store_id 是单值 FK
-- ⇒ 规范化为关联表；employee.store_id 保留为「主门店」（可空），不改 M2a 已上线的列语义。
-- M2b 迁移时把串拆成行、并挑一个作主门店。
create table if not exists aftersales.employee_store (
  id          bigserial primary key,
  org         text not null,
  -- 员工被删则关联同删（on delete cascade）——关联行离开员工没有意义
  employee_id bigint not null references aftersales.employee(id) on delete cascade,
  store_id    bigint not null references aftersales.store(id)
);

-- 同一员工对同一门店只关联一次；org 在列里，兼作「按 org 查我的门店」的索引前缀
create unique index if not exists aftersales_employee_store_org_emp_store_idx
  on aftersales.employee_store(org, employee_id, store_id);
