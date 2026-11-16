-- 020_org_leader_and_roles.sql — OA 前置：部门负责人（企微同步）与部门管理员（平台授予）。
--
-- 编号 020：018/019 已被 platform 内置调度器占用（`018_platform_jobs.sql` /
-- `019_job_schedule_soft_delete.sql`，2026-11-14 落地），故取 main 上的下一个空号。
--
-- 为什么要有这两张表（spec 2026-11-16-ai-native-oa-design §5 / 计划 T1）：
--   审批链的 `dept_leader` / `dept_admin` 两种审批人来源必须有**平台内的可查面**——
--   模块读不到 platform schema（B1），所以对外只经宿主注入的 `OrganizationPort`（T2）。
--
-- 两个来源语义不同，别混：
--   · `org_node_leader` —— **企微是事实源**（`department/list` 的 `department_leader`，
--     顺序即企微给的顺序 → `sort`）。每次 org 同步**整组重写**（纯投影，天然幂等）；
--   · `org_role_binding` —— **平台授予**（平台超管/部门管理面写入）。org 同步**不碰**它，
--     否则一次企微同步就把人工授的部门管理员抹掉。
--
-- 幂等：create table/index if not exists；视图 `drop view if exists` + `create view`
--（不用 `create or replace view`——后续加列时会报 `cannot drop columns from view`，
-- 见 team-harness `rules/common/db-migration.md` §1）。
create table if not exists platform.org_node_leader (
  tenant_id   integer not null references platform.tenant(id),
  node_ext_id text    not null,             -- 企微部门 ext_id（与 org_node.ext_id 同口径）
  user_name   text    not null,             -- 企微 userid（= Casdoor name，与 org_membership 同口径）
  sort        integer not null default 0,   -- 企微 department_leader 数组下标：0 为主负责人
  synced_at   timestamptz not null default now(),
  primary key (tenant_id, node_ext_id, user_name)
);
create index if not exists idx_org_node_leader_user
  on platform.org_node_leader (tenant_id, user_name);

create table if not exists platform.org_role_binding (
  tenant_id   integer not null references platform.tenant(id),
  node_ext_id text    not null,             -- 作用范围：该部门（**不展开子树**，展开由 port 决定）
  user_name   text    not null,
  role        text    not null check (role in ('dept_admin')),
  granted_by  text    not null,             -- 授予人（审计归属；不写「平台」这类假身份）
  granted_at  timestamptz not null default now(),
  primary key (tenant_id, node_ext_id, user_name, role)
);
create index if not exists idx_org_role_binding_user
  on platform.org_role_binding (tenant_id, user_name, role);

-- 消费面（与 013 的 v_org_* 同款：模块/宿主只经稳定视图读，物理表 DDL 可演进）
drop view if exists platform.v_org_node_leader;
create view platform.v_org_node_leader as
  select tenant_id, node_ext_id, user_name, sort, synced_at
    from platform.org_node_leader;

drop view if exists platform.v_org_role_binding;
create view platform.v_org_role_binding as
  select tenant_id, node_ext_id, user_name, role, granted_at
    from platform.org_role_binding;
