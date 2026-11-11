#!/bin/sh
# ensure-lake-month-index.sh — 幂等建/验月度清单表 data.lake_month_index（仓 pg_duckdb）。
# 用法：sh <检出>/deploy/duckle/console/ensure-lake-month-index.sh [--check]
# 退出码：0 = 表在/建好；1 = 没有运行中的 pg_duckdb 容器 / psql 失败。
# 凭据：容器内 POSTGRES_USER/POSTGRES_DB（compose 已注入），本脚本不传口令。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODE=apply
if [ "${1:-}" = "--check" ]; then
  MODE=check
  shift
fi
DDL="${1:-${HERE}/lake_month_index.ddl.sql}"

CT=$(docker ps --format '{{.Names}}' | grep -E 'pg_duckdb$' | head -n 1 || true)
if [ -z "${CT}" ]; then
  echo "ENSURE_LAKE_MONTH_INDEX_FAILED: 本机没有运行中的 pg_duckdb 容器" >&2
  exit 1
fi

if [ "${MODE}" = "apply" ]; then
  if ! docker exec -i "${CT}" sh -c 'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' < "${DDL}"; then
    echo "ENSURE_LAKE_MONTH_INDEX_FAILED: psql 执行 DDL 失败（容器 ${CT}）" >&2
    exit 1
  fi
fi

# 桶名落库（值来自容器 env，不回显）
BUCKET=$(docker exec "${CT}" printenv ZOS_BUCKET 2>/dev/null || true)
if [ -n "${BUCKET}" ]; then
  printf "insert into data.lake_config(key, value) values ('zos_bucket', '%s') on conflict (key) do update set value = excluded.value;\n" "${BUCKET}" \
    | docker exec -i "${CT}" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' >/dev/null
fi

N=$(printf "%s\n" "select count(*) from information_schema.tables where table_schema = 'data' and table_name = 'lake_month_index';" \
  | docker exec -i "${CT}" sh -c 'psql -tAq -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"' | tr -d '[:space:]')
if [ "${N}" != "1" ]; then
  echo "ENSURE_LAKE_MONTH_INDEX_FAILED: 表 data.lake_month_index 不在（count=${N}, 容器 ${CT}）" >&2
  exit 1
fi
echo "ENSURE_LAKE_MONTH_INDEX_OK: ${CT} data.lake_month_index (mode=${MODE})"
