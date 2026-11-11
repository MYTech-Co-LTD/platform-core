-- lake_month_index.ddl.sql — 月度合并文件的清单表（数据面仓 pg_duckdb）。
--
-- 背景（#1905 后续 P1）：读侧 30 天明细要打开 60 个 ~300KB 日文件 × 25 列逐列 range 请求
-- （~1500 次 × 5ms ≈ 7.8s；链路实测 250–750MB/s，瓶颈是请求数）。lemeng.retail_order_line.month.compact
-- 把已封版日合并成月文件 _MONTH/system_book=<B>/month=<YM>/all.parquet，本表记录每个月文件的
-- 行数/金额/边界/构建时刻，同时是父管线「哪些月需要重建」的判定依据（built_at < 该月 max(sealed_at)）。
--
-- 幂等：可重复执行。应用方式（openship MCP 服务器级 exec）：
--   sh deploy/duckle/console/ensure-lake-month-index.sh
create table if not exists data.lake_month_index (
  system_book    varchar(64)  not null,
  ym             varchar(7)   not null,
  rows           bigint       not null,
  sale_money_sum numeric(38,2),
  min_bizday     date,
  max_bizday     date,
  built_at       timestamptz  not null default now(),
  primary key (system_book, ym)
);
