-- 013_org_views.sql — 组织架构的**模块消费面**（只读稳定视图）
--
-- 为什么要有这一层：组织架构是平台原语（spec 2026-10-30-org-as-platform-primitive-design §3），
-- 但**模块读别的 schema 必须有声明面**（docs/module-protocol.md「跨模块只读数据依赖」）：
-- 消费方在 manifest 的 `dataDependencies` 里声明 `<schema>.<稳定视图>`，B1 门禁据此放行 from/join。
-- 协议同时定死：**条目必须是稳定视图，不是物理表**（防腐层语义——这张视图是平台对外承诺的
-- 只读面，`org_node` / `org_membership` 的 DDL 演进不必通知每个消费方）。故这里把两张表包一层。
--
-- 只读：视图不可写（没有 INSTEAD OF 触发器），越权写会直接失败；列集变更走协议判据 2
-- 的显式登记（改这里 = 改消费方可见形状）。
--
-- 幂等：`drop view if exists` + `create view`（不用 `create or replace view`——后续加列时
-- replace 会报 `cannot drop columns from view`，见团队规则 db-migration §1）。
drop view if exists platform.v_org_node;
create view platform.v_org_node as
  select tenant_id, ext_id, name, parent_ext_id, path, status, synced_at
    from platform.org_node;

drop view if exists platform.v_org_membership;
create view platform.v_org_membership as
  select tenant_id, user_name, ext_id, is_primary, synced_at
    from platform.org_membership;
