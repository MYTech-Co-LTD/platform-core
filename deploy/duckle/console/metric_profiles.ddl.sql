-- metric_profiles.ddl.sql — W2 duckle profiler 的落点表（**数据面仓 pg_duckdb / warehouse**，不是平台库）。
--
-- 为什么在仓里而不在平台库（迁移 036 的差异，2026-11-04 实测 + 报备）：
--   · profiler 是 duckle console 的管线，console 容器与单元 A 的 `postgres` **不在同一 docker 网络**
--     （console → 172.18.0.5:5432 超时；仅有 `pg_duckdb` 可达）；
--   · 仓内 `data` schema 已有同形先例：`data.load_log`（`scripts/lemeng/materialize.sh` 幂等建表）。
--   ⇒ 平台侧（候选生成 / Task 5）经 `DATA_WAREHOUSE_URL`（warehousePool）读本表。
--
-- 幂等：本文件与 `data.load_log` 同口径——可重复执行（create ... if not exists）。
-- 应用方式（openship MCP 服务器级 exec，不裸 SSH）：
--   docker exec <pg_duckdb 容器> psql -U platform -d warehouse -v ON_ERROR_STOP=1 -f <本文件>
--
-- 形状说明：
--   · "column" 是 PG 保留字，**必须带双引号**（DROP/查询/DDL 一律引）。
--   · stats = qa.profile 的原始逐列统计（column_type/min/max/approx_unique/avg/std/q25/q50/q75/count/null_percentage）——
--     只存证据，不定义口径（B11）。
--   · profiled_at 进主键 ⇒ 每轮画像留历史（周更），append 写不覆盖。
create table if not exists data.metric_profiles (
  org         text        not null,
  relation    text        not null,
  "column"    text        not null,
  stats       jsonb       not null,
  profiled_at timestamptz not null default now(),
  primary key (org, relation, "column", profiled_at)
);

-- 读面主用「本租户某个关系的最新一份画像」：org + relation + profiled_at desc。
create index if not exists metric_profiles_org_rel_idx
  on data.metric_profiles (org, relation, profiled_at desc);
