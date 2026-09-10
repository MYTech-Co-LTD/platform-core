-- 001_platform.sql — platform schema 四张表（与计划「平台 DB」总览逐字对齐）
-- 消费方：租户解析/branding/config(T12)、登录审计(T13)、模块装载器 tenant_module(T15)。
-- 记账表 platform.schema_migrations 由迁移执行器自建（migrate.ts），不归本文件管。
create schema if not exists platform;

create table platform.tenant(
  id serial primary key,
  slug text unique not null,
  casdoor_org text unique not null,
  product_name text not null default 'Platform',
  logo text,
  primary_color text not null default '#1890ff',
  background text not null default 'default',
  login_methods text[] not null default '{password}',
  wecom_corp_id text,
  wecom_agent_id text,
  wecom_secret text,
  created_at timestamptz not null default now()
);

create table platform.tenant_domain(
  tenant_id int not null references platform.tenant(id),
  domain text unique not null
);

create table platform.tenant_module(
  tenant_id int not null references platform.tenant(id),
  module_id text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  primary key(tenant_id, module_id)
);

create table platform.audit(
  id bigserial primary key,
  tenant_id int,
  actor text,
  action text,
  detail jsonb,
  at timestamptz not null default now()
);
