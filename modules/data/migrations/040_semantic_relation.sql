-- 040_semantic_relation.sql —— 语义关系声明（W7 Task 2）。
--
-- 一条关系 = 「从哪张表的哪列 → 到哪张表的哪列」，**必须带证据**（命中率 + 抽样日）：
-- 没有命中率的关系不进 verified，避免「看起来有本体、实际查不出东西」。
--
-- 为什么必须有 dedup_rule：2026-11-07 实测 `stg_lemeng_item` ≈42 行/商品（快照流水），
-- 不走去重的 join 把 7,221 行放大成 298,709 行（金额静默放大 ~41 倍）。N:M 或维表非唯一时，
-- dedup_rule 必填（如 latest_snapshot），编译期据此生成去重子查询。
create table if not exists data.semantic_relation (
  org          text not null,
  name         text not null,
  from_relation text not null,
  from_column  text not null,
  to_relation  text not null,
  to_column    text not null,
  cardinality  text not null check (cardinality in ('1:1','1:N','N:1','N:M')),
  dedup_rule   text,
  match_rate   numeric check (match_rate >= 0 and match_rate <= 1),
  sampled_day  text,
  status       text not null default 'candidate' check (status in ('candidate','verified')),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (org, name)
);

create index if not exists semantic_relation_org_status_idx
  on data.semantic_relation (org, status);
