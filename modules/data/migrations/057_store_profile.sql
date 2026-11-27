-- 057_store_profile.sql — 门店画像：门店级品牌 + 等级（#2924）
-- 正典：docs/superpowers/specs/2026-11-27-store-profile-brand-level-design.md
--
-- 为什么把 store 级品牌从 brand_assignment 迁到这里：
--   门店页签要同时维护「品牌 + 等级」，两者是一个门店画像。如果品牌留在 brand_assignment、
--   等级放 store_profile，一次编辑跨两张表、两套事实源，页面 tag 和工单品牌会对不上。
--   ⇒ store_profile 拥有门店级品牌 + 等级；brand_assignment 只保留 product 级覆盖。
--
-- 迁移是幂等的：复制 store 行 → 审计 → 删除 store 行；重复执行时没有 store 行可迁。
-- 视图 drop + create（禁止 create or replace，后续加列重跑会报 cannot drop columns from view）。

create table if not exists data.store_level_registry (
  org        text not null,
  -- 等级 code 不可变；A/B/C、level_a 都可；`__unleveled__` 是查询保留值，不能作为 code
  code       text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  name       text not null check (name <> ''),
  sort       integer not null default 0,
  enabled    boolean not null default true,
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, code)
);

create table if not exists data.store_profile (
  org          text not null,
  store_code   text not null,
  -- 门店级品牌；null = 未标记。商品级覆盖仍在 brand_assignment(subject_type='product')
  brand_code   text,
  brand_source text not null default '',
  brand_locked boolean not null default false,
  -- 门店级等级；null = 未分级
  level_code   text,
  level_source text not null default '',
  level_locked boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (org, store_code),
  foreign key (org, brand_code) references data.brand_registry(org, code),
  foreign key (org, level_code) references data.store_level_registry(org, code)
);
create index if not exists data_store_profile_org_brand_idx
  on data.store_profile (org, brand_code);
create index if not exists data_store_profile_org_level_idx
  on data.store_profile (org, level_code);

create table if not exists data.store_profile_audit (
  id         bigserial primary key,
  org        text not null,
  actor      text not null default '',
  action     text not null,
  store_code text not null default '',
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists data_store_profile_audit_org_at_idx
  on data.store_profile_audit (org, created_at desc);

-- 一次性迁移现有 store 级品牌：只更新 brand 三列，不碰 level（幂等）。
insert into data.store_profile(org, store_code, brand_code, brand_source, brand_locked)
select org, subject_code, brand_code, source, locked
  from data.brand_assignment
 where subject_type = 'store'
on conflict (org, store_code) do update
  set brand_code = excluded.brand_code,
      brand_source = excluded.brand_source,
      brand_locked = excluded.brand_locked,
      updated_at = now();

-- 审计只在首次迁移时写一行（重复执行时 brand_assignment 已无 store 行）。
insert into data.store_profile_audit(org, actor, action, detail)
select s.org, 'migration', 'profile.migrate', jsonb_build_object('brandRows', s.n)
  from (
    select org, count(*)::int as n
      from data.brand_assignment
     where subject_type = 'store'
     group by org
  ) s
 where not exists (
   select 1 from data.store_profile_audit a
    where a.org = s.org and a.action = 'profile.migrate'
 );

-- store 级品牌已迁入 store_profile；brand_assignment 只保留 product 级覆盖。
delete from data.brand_assignment where subject_type = 'store';

drop view if exists data.v_store_level_registry;
create view data.v_store_level_registry as
select org, code, name, sort, enabled, source, updated_at
  from data.store_level_registry;

drop view if exists data.v_store_profile;
create view data.v_store_profile as
select b.org,
       b.code  as store_code,
       b.name  as store_name,
       sp.brand_code,
       br.name as brand_name,
       coalesce(sp.brand_source, '') as brand_source,
       sp.level_code,
       lr.name as level_name,
       coalesce(sp.level_source, '') as level_source,
       sp.updated_at
  from data.dim_branch b
  left join data.store_profile sp
    on sp.org = b.org and sp.store_code = b.code
  left join data.brand_registry br
    on br.org = b.org and br.code = sp.brand_code
  left join data.store_level_registry lr
    on lr.org = b.org and lr.code = sp.level_code;
