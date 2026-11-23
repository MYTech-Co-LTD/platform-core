#!/bin/sh
# ensure-retail-hot.sh — 幂等建/验零售热层表 `staging.retail_hot`（仓 pg_duckdb，#2761）。
#
# 为什么需要脚本（照 ensure-lemeng-daily-sealed.sh 先例）：新环境重建（卷重建 / 换机）后漏跑 DDL 的
# 症状是采集 tick 的 snk.postgres append「表不存在」——而该节点是 continueOnFailure，采集照绿，
# **热层静默失效**（报表回落到 1–2 小时滞后却没人知道）。本脚本把建表固化成可重复执行的一步。
#
# 用法（在**数据面机宿主**上，经 openship MCP 服务器级 exec 执行）：
#   sh <检出根>/deploy/duckle/console/ensure-retail-hot.sh            # 建表（幂等）
#   sh <检出根>/deploy/duckle/console/ensure-retail-hot.sh --check    # 只验表在（不改）
#
# 退出码：0 = 表在（--check）/ 建表成功；1 = 找不到容器 / psql 失败 / 表不在。
# 凭据：容器内 `POSTGRES_USER` / `POSTGRES_DB`（compose 已注入），本脚本**不传口令**。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODE=apply
if [ "${1:-}" = "--check" ]; then
  MODE=check
fi
DDL="${HERE}/retail_hot.ddl.sql"

CT=$(docker ps --format '{{.Names}}' | grep -E 'pg_duckdb$' | head -n 1 || true)
if [ -z "${CT}" ]; then
  echo "ENSURE_RETAIL_HOT_FAILED: 本机没有运行中的 pg_duckdb 容器（装/启单元 B 后再跑）" >&2
  exit 1
fi

if [ "${MODE}" = "apply" ]; then
  if [ ! -f "${DDL}" ]; then
    echo "ENSURE_RETAIL_HOT_FAILED: DDL 文件不存在: ${DDL}" >&2
    exit 1
  fi
  if ! docker exec -i "${CT}" sh -c 'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' < "${DDL}"; then
    echo "ENSURE_RETAIL_HOT_FAILED: psql 执行 DDL 失败（容器 ${CT}）" >&2
    exit 1
  fi
fi

N=$(printf "select count(*) from information_schema.tables where table_schema='staging' and table_name='retail_hot';" \
  | docker exec -i "${CT}" sh -c 'psql -tAq -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' | tr -d '[:space:]')
if [ "${N}" != "1" ]; then
  echo "ENSURE_RETAIL_HOT_FAILED: 表 staging.retail_hot 不在（count=${N}, 容器 ${CT}）" >&2
  exit 1
fi

echo "ENSURE_RETAIL_HOT_OK: ${CT} staging.retail_hot (mode=${MODE})"
