-- 004_collection_rounds.sql — 收集轮次三表（件③ / issue #2707，目标平台件 B 期）。
-- 名单轮（targets：谁该交）与值集轮（value_grid：期望维度格子快照）共用一张轮表；
-- target/anchor 行是「期望集合」的物化——建轮时写入、开轮即冻结，进度按行状态推进
-- （pending → submitted；waived 是显式免交，不受重复提交影响）。
-- 纪律：幂等迁移（create table if not exists / add column if not exists，重复执行不报错）。

create table if not exists forms.collection_round (
  id bigserial primary key,
  org text not null,
  asset_id text not null, version int not null,
  round_key text not null,             -- 如 2026-11
  kind text not null check (kind in ('targets','value_grid')),
  name text not null,
  starts_at timestamptz, ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','open','closed')),
  created_by text not null, created_at timestamptz not null default now(),
  unique (org, asset_id, round_key)
);

create table if not exists forms.collection_target(            -- 名单轮：谁该交
  round_id bigint references forms.collection_round(id),
  org text not null, user_name text not null,
  status text not null default 'pending' check (status in ('pending','submitted','waived')),
  submission_id bigint, updated_at timestamptz not null default now(),
  primary key (round_id, user_name)
);

create table if not exists forms.collection_anchor(            -- 值集轮：期望维度格子快照（建轮时生成）
  round_id bigint references forms.collection_round(id),
  org text not null,
  anchor_key text not null,          -- 如 dim 复合键或 store 标识
  status text not null default 'pending' check (status in ('pending','submitted','waived')),
  submission_id bigint, updated_at timestamptz not null default now(),
  primary key (round_id, anchor_key)
);

-- 提交与轮次的关联列：不带 FK（提交表是热表，轮次清理走应用层；org 隔离在查询侧钉）
alter table forms.submission add column if not exists round_id bigint;
