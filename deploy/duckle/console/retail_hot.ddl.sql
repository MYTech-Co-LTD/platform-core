-- retail_hot.ddl.sql — 零售明细「热层」（Lambda 速度层）的写侧表（**数据面仓 pg_duckdb**，不是平台库）。
--
-- 背景（#2761）：采集与加工都是 10 分钟一轮，但报表滞后 1–2 小时 —— 加工用封窗谓词
--   `closed_before_predicate()` 排除当前小时（不敢读正在被覆盖写的湖文件：DuckDB 先取 ETag 再 GET，
--   文件被替换即抛错）。本表补上 Lambda 的「速度层」：当前小时走这里，历史仍走湖。
--
-- 形状与语义：
--   · **append-only 快照**：每轮采集追加一整批（`run_token` = 采集批次），**不 delete / 不 upsert**。
--     读侧只读「最新批次」：`where run_token = (select max(run_token) ... )`。
--   · 为什么不用 upsert：upsert 按唯一键覆盖只能表达「新增/修改」，**表达不了「本批少了一行」**
--     （源端撤单）—— 那行会永久残留。快照式追加 + 取最新才等价于「本批的真实状态」。
--   · 列与 `lemeng.retail_order_line.tick` 的 flatten 输出**逐列一致**（25 列）；改口径时两处同改。
--   · 期望读者：stg 的第三腿（不套封窗）；写者：采集 tick 的 `snk.postgres`（mode=append，
--     `continueOnFailure: true` —— 热层坏了最多回落 1–2 小时滞后，不能连坐采集判红）。
--   · GC：封版后按 `bizday < current_date` 清理老批次（见 spec §4.4）。
--
-- 幂等：可重复执行（create ... if not exists）。
-- 应用方式（openship MCP 服务器级 exec，不裸 SSH）：
--   sh deploy/duckle/console/ensure-retail-hot.sh
create schema if not exists staging;

create table if not exists staging.retail_hot (
  run_token                  varchar(32)  not null,
  batch_id                   varchar(64)  not null,
  system_book                varchar(64)  not null,
  bizday                     date         not null,
  hour                       integer      not null,
  order_no                   varchar(64)  not null,
  order_detail_num           varchar(64)  not null,
  branch_num                 integer,
  branch_name                varchar(256),
  order_time                 timestamp,
  order_operate_time         timestamp,
  state                      varchar(32),
  order_source               varchar(64),
  item_num                   varchar(64),
  item_code                  varchar(64),
  sale_money                 numeric(14,2),
  discount_money             numeric(14,2),
  payment_money              numeric(14,2),
  quantity                   numeric(14,3),
  order_transaction_type     varchar(64),
  order_ref_billno           varchar(64),
  order_detail_share_discount numeric(14,2),
  order_detail_std_price     numeric(14,2),
  order_detail_price         numeric(14,2),
  order_detail_online_qty    numeric(14,3),
  order_total_money          numeric(14,2)
);

-- 读侧固定形态：先按 (system_book, bizday) 取最新 run_token，再取该批全部行。
create index if not exists retail_hot_book_day on staging.retail_hot (system_book, bizday);
create index if not exists retail_hot_run_token on staging.retail_hot (run_token);
