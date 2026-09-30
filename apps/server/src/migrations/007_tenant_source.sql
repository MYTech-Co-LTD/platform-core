-- 007_tenant_source.sql — 「某租户接了哪些源」（spec §3⑧ 的前提，计划 5）。
-- 与 platform.tenant_module 同构（tenant_id + 标识 + enabled + config）：接入是平台侧动作，
-- 登记必须落在 platform schema —— 架构 lint B1 不许 modules/** 读 platform、也不许 apps/** 读 data。
-- 幂等：部署每次全量重跑迁移（migrate.ts 按 platform.schema_migrations 记账去重），文件本身仍写成可重复。
create table if not exists platform.tenant_source(
  tenant_id int not null references platform.tenant(id),
  source text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  primary key(tenant_id, source)
);
