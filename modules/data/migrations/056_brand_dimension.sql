-- 056_brand_dimension.sql — 租户品牌维度（品牌筛选通用化，issue #2892）
-- 正典：docs/superpowers/specs/2026-11-26-tenant-brand-dimension-design.md
--
-- 为什么在 data 层而不是平台/模块：
--   · 品牌映射是租户主数据，会被售后、报表/BI、未来的其他模块共用；
--   · 本仓 B1：modules/** 不许读 platform，platform 配置面也不能被数据面/报表读；
--   · data 的稳定视图是唯一跨模块只读通路（module-protocol「跨模块只读数据依赖」）。
--
-- 与现有 `dim_brand` 的区别（**别混用**）：
--   `dim_brand` 是账套品牌（3120 熊喵鲜生 / 64188 品品甜，数据范围/问数用）；
--   本文件的 brand_registry / brand_assignment 是**租户品牌字典 + 门店/商品归属**，
--   用于售后筛选与展示。两者语义不同，join 前先看来源。
--
-- 为什么不是给 data.dim_branch 加一列：
--   乐檬门店源没有品牌字段；dim_brand 是账套级，而 dim_branch 跨账套去重是 system_book asc
--   （3120 优先），品品甜门店同时是 3120 批发客户 ⇒ 会被判成熊喵；单列也表达不了商品级品牌。
--
-- 幂等：create table/index if not exists；视图 drop if exists + create（禁止 create or replace，
-- 否则后续加列重跑会报 cannot drop columns from view）。

create table if not exists data.brand_registry (
  org        text not null,
  -- 品牌 code 是不可变标识；保留 __ 前缀（__unclassified__ 是查询保留值）
  code       text not null check (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name       text not null check (name <> ''),
  sort       integer not null default 0,
  enabled    boolean not null default true,
  source     text not null default 'manual'
             check (source in ('source_field','book','mapping','prefix','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, code)
);

-- 主体 → 品牌：一主体一品牌（product 优先于 store）；多品牌请把品牌解析放在商品/订单行。
create table if not exists data.brand_assignment (
  org          text not null,
  subject_type text not null check (subject_type in ('store','product')),
  subject_code text not null,
  brand_code   text not null,
  source       text not null
               check (source in ('source_field','book','mapping','prefix','manual','backfill')),
  -- manual 行锁定：源同步不得覆盖人工映射（人工优先于源）
  locked       boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (org, subject_type, subject_code),
  foreign key (org, brand_code) references data.brand_registry(org, code)
);
create index if not exists data_brand_assignment_org_brand_idx
  on data.brand_assignment (org, brand_code);

-- 品牌字典/归属是租户主数据，变更必须有痕。
create table if not exists data.brand_audit (
  id           bigserial primary key,
  org          text not null,
  actor        text not null default '',
  action       text not null,          -- brand.create / brand.update / assignment.upsert / assignment.import / assignment.backfill
  subject_type text,
  subject_code text,
  brand_code   text,
  detail       jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index if not exists data_brand_audit_org_at_idx on data.brand_audit (org, at desc);

-- 稳定视图：消费者只读这里，不读基表（基表 DDL 可演进）。
-- `brand_enabled=false` 的历史品牌仍保留在视图里，供历史工单筛选；新提单解析时跳过。
drop view if exists data.v_brand_registry;
create view data.v_brand_registry as
select org, code, name, sort, enabled, source, updated_at
  from data.brand_registry;

drop view if exists data.v_brand_assignment;
create view data.v_brand_assignment as
select a.org,
       a.subject_type,
       a.subject_code,
       a.brand_code,
       r.name as brand_name,
       a.source,
       coalesce(r.enabled, false) as brand_enabled,
       a.updated_at
  from data.brand_assignment a
  left join data.brand_registry r
    on r.org = a.org and r.code = a.brand_code;
