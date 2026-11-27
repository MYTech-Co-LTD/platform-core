-- lake_compact_index.sql — 湖封版分区压缩的索引（C 设计 §4）
--
-- 幂等：可反复执行。
-- 为什么单独一张表而不是扩 `data.lake_month_index`：零售那张的 conflict key 是
-- `(system_book, ym)`，多源压缩需要 `source` 维度（同月多源必须分行）。
--
-- 用法（数据仓库连接，DATA_WAREHOUSE_URL）：
--   psql "$DATA_WAREHOUSE_URL" -f scripts/lemeng/sql/lake_compact_index.sql
--
-- 读侧约定（视图编译期取 boundary）：
--   select max(ym) from data.lake_compact_index where source = :source and contract_sha = :sha;
-- 写侧顺序（不可颠倒）：写月文件 → parity 校验 → **最后** upsert 本表。

create table if not exists data.lake_compact_index (
  source        text        not null,   -- 源名，例如 business_collection_receive
  system_book   integer     not null,   -- 账套（3120 / 64188）
  ym            text        not null,   -- 'YYYY-MM'（只收已封月）
  rows          bigint      not null check (rows >= 0),
  bytes         bigint,
  min_bizday    date,
  max_bizday    date,
  contract_sha  text        not null,   -- contracts 的规范 sha8；契约一变则冷腿自动失效
  object_key    text        not null,   -- _MONTH 对象的完整 key（取证用）
  status        text        not null default 'ok',  -- ok | empty（空月也记一行，父管线据此不再重试）
  built_at      timestamptz not null default now(),
  primary key (source, system_book, ym)
);

-- 存量库的幂等补齐（新库上面已含）：
alter table data.lake_compact_index add column if not exists status text not null default 'ok';
-- 输入指纹（2026-11-27，推广 #2 的教训）：索引必须能回答「这一月是从**哪些文件**算出来的」。
-- 没有它，写路径一变（例如某天起改写成 chunk=segN.parquet），旧行仍然 'ok'，而月文件已经不完整
-- —— 这正是 #2666 的形状。带指纹 ⇒ 「陈旧」可判，而不是只能靠人工 parity。
alter table data.lake_compact_index add column if not exists input_pattern text;
alter table data.lake_compact_index add column if not exists input_files integer;
alter table data.lake_compact_index drop constraint if exists lake_compact_index_rows_check;
alter table data.lake_compact_index add constraint lake_compact_index_rows_check check (rows >= 0);

create index if not exists lake_compact_index_source_ym
  on data.lake_compact_index (source, ym);

-- 契约 sha 变更后，旧行不删（历史取证），但冷腿只认当前 sha；此处只保证查询走索引。
comment on table data.lake_compact_index is
  '湖封版分区压缩索引（一源×一账套×一月=一个文件）。冷腿 boundary = 本表按 (source, contract_sha) 的 max(ym)。';
