#!/bin/sh
# ensure-metric-profiles.sh — 幂等建/验 W2 profiler 的落点表 `data.metric_profiles`（仓 pg_duckdb）。
#
# 为什么需要脚本（而不是 README 里一条手工 docker exec）：新环境重建（卷重建 / 换机 / 新账套）后，
# 漏跑 DDL 的症状是 snk.postgres 的 append「表不存在」——但那是**周更**，要等一周才炸，且
# 不在任何门禁里。本脚本把「建表」固化成可重复执行的一步，投递清单直接调它。
#
# 用法（在**数据面机宿主**上，经 openship MCP 服务器级 exec 执行）：
#   sh <检出根>/deploy/duckle/console/ensure-metric-profiles.sh            # 建表（幂等）
#   sh <检出根>/deploy/duckle/console/ensure-metric-profiles.sh --check    # 只验表在（不改）
#   sh <检出根>/deploy/duckle/console/ensure-metric-profiles.sh <ddl.sql>  # 指定 DDL 文件
#
# 退出码：0 = 表在（--check）/ 建表成功；1 = 找不到容器 / psql 失败 / 表不在。
# 凭据：容器内 `POSTGRES_USER` / `POSTGRES_DB`（compose 已注入），本脚本**不传口令**。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODE=apply
if [ "${1:-}" = "--check" ]; then
  MODE=check
  shift
fi
DDL="${1:-${HERE}/metric_profiles.ddl.sql}"

CT=$(docker ps --format '{{.Names}}' | grep -E 'pg_duckdb$' | head -n 1 || true)
if [ -z "${CT}" ]; then
  echo "ENSURE_METRIC_PROFILES_FAILED: 本机没有运行中的 pg_duckdb 容器（装/启单元 B 后再跑）" >&2
  exit 1
fi

if [ "${MODE}" = "apply" ]; then
  if [ ! -f "${DDL}" ]; then
    echo "ENSURE_METRIC_PROFILES_FAILED: DDL 文件不存在: ${DDL}" >&2
    exit 1
  fi
  # ON_ERROR_STOP：DDL 任何一句失败都必须让本脚本失败（不是打印后继续）。
  if ! docker exec -i "${CT}" sh -c 'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' < "${DDL}"; then
    echo "ENSURE_METRIC_PROFILES_FAILED: psql 执行 DDL 失败（容器 ${CT}）" >&2
    exit 1
  fi
fi

N=$(printf "%s\n" "select count(*) from information_schema.tables where table_schema = 'data' and table_name = 'metric_profiles';" \
  | docker exec -i "${CT}" sh -c 'psql -tAq -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' | tr -d '[:space:]')

if [ "${N}" != "1" ]; then
  echo "ENSURE_METRIC_PROFILES_FAILED: 表 data.metric_profiles 不在（count=${N}, 容器 ${CT}）" >&2
  exit 1
fi

echo "ENSURE_METRIC_PROFILES_OK: ${CT} data.metric_profiles (mode=${MODE})"
