-- lake_compact_source.ddl.sql — 湖封版分区压缩的**源注册表**（C 设计 §6）
--
-- 幂等：可反复执行。
-- 为什么注册表在 PG 而不是 workspace JSON：父管线必须把「源清单」与「已压月份索引」做 **join**
-- 才能算出待压月；索引在 PG，而 duckle 的 workspace 文件与 PG 不能在同一个 SQL 节点里 join
-- （多输入 code.sql 不具备该语义）。一张小表换掉一次跨源编排，值与 retail 父管线的形态一致。
--
-- 用法：
--   psql "$DATA_WAREHOUSE_URL" -f deploy/duckle/console/lake_compact_source.ddl.sql
--
-- 行启用 = enabled=true（默认 false，按源灰度；关掉即回滚到单腿读原始）。

create table if not exists data.lake_compact_source (
  source        text        primary key,           -- 与湖前缀同名，如 business_collection_receive
  start_ym      text        not null,              -- 回填起点 'YYYY-MM'
  system_books  integer[]   not null default '{3120,64188}',
  contract_sha  text        not null,              -- contracts 规范 sha8（契约变 ⇒ 冷腿自动失效）
  enabled       boolean     not null default false,
  note          text,
  updated_at    timestamptz not null default now()
);

comment on table data.lake_compact_source is
  '湖封版分区压缩的源注册表（与 data.lake_compact_index 一起决定待压月份与冷腿边界）';
