-- lemeng_daily_sealed.ddl.sql — 零售封版 manifest 的读侧索引表（**数据面仓 pg_duckdb**，不是平台库）。
--
-- 背景（#1872）：读侧原先每次查询 glob `_DAILY/*.parquet`（1,541 个一行小文件）⇒ pg_duckdb >110s
-- 且会打崩后端、重置所有连接。读侧改为 join 本表；`_DAILY/` 标记仍是封版事实源，本表是它的镜像。
--
-- 为什么在仓里而不在平台库：读侧视图 `vw_lemeng_retail_order_line` 在仓（pg_duckdb）；
-- console 容器只与 `pg_duckdb` 同网络，平台库不可达（同 `data.metric_profiles` 先例）。
--
-- 幂等：可重复执行（create ... if not exists）。
-- 应用方式（openship MCP 服务器级 exec，不裸 SSH）：
--   sh deploy/duckle/console/ensure-lemeng-daily-sealed.sh
--
-- 形状：
--   · (system_book, bizday) 主键 = 封版判定的自然键；`source` 区分封版写入 (`seal`) 与对账补齐 (`reconcile`)。
--   · `_bootstrap` 哨兵（system_book='' / bizday=1970-01-01）也要入表；它不匹配任何真日子。
--   · 写入：日管线 `snk.postgres` upsert（connectionRef: pgduck, conflictColumns: system_book,bizday）。
--   · `sealed_at` = 首次封版时刻（语义不变）；`checked_at` = 最近一次对账确认（每次 reconcile upsert 刷新）。
--     拆两列的原因（2026-11-11 实测）：upstream 的 upsert 不刷新 `sealed_at`，探针 ⑯ 拿它当
--     「reconcile 还在跑吗」的判据会**误报停摆**（实测 reconcile 每 30 分钟都在成功，但 sealed_at 停在 10 小时前）。
--   · 对账：duckle console 定时 job 读 `_DAILY/*.parquet` 与表做双向 diff（不在 pg_duckdb 里读 `_DAILY`）。
create table if not exists data.lemeng_daily_sealed (
  system_book varchar(64) not null,
  bizday      date        not null,
  sealed_at   timestamptz not null default now(),
  checked_at  timestamptz not null default now(),
  source      varchar(16) not null default 'seal',
  primary key (system_book, bizday)
);

-- 读侧 anti-join 会按 system_book + bizday 关联；bizday 单列索引用于审计/窗口查询。
create index if not exists lemeng_daily_sealed_bizday_idx
  on data.lemeng_daily_sealed (bizday);

-- 存量表补列（幂等）：reconcile 每次 upsert 刷新 checked_at；老库没有这一列时探针 ⑯ 会误报。
alter table data.lemeng_daily_sealed
  add column if not exists checked_at timestamptz not null default now();
