#!/bin/sh
# run-retail-day.sh — 乐檬零售明细日采集执行器（数据面机原地运行；S1 首跑落地，Task 10 的 wrapper 雏形）
#
# 用法（job/exec 内，秘密值来自 job env——本脚本只读不写，任何输出都不回显值）：
#   sh run-retail-day.sh probe                     # 环境/桶/容器/token 闸 体检（只打印长度与状态码）
#   sh run-retail-day.sh window 07 [suffix]        # 单时窗
#   sh run-retail-day.sh windows                   # 昨日 24 时窗全量
#   sh run-retail-day.sh listing                   # 对象清单（24 个 hour=NN/all.parquet + 字面量占位符扫描）
#   sh run-retail-day.sh rb "<duckdb SQL>"         # 容器内 duckdb httpfs 回读（值由容器 env 展开）
#   sh run-retail-day.sh idem 03                   # 幂等重跑并比对 ETag/Size
#   sh run-retail-day.sh drift                     # 契约漂移门禁（先断言 data.schema 声明存在）
#   sh run-retail-day.sh envfile                   # 把 DUCKLE_TOKEN 物化成 deploy/.env（600；compose 插值用）
#
# 依赖 env: LEMENG_TOKEN / DUCKLE_TOKEN / ZOS_BUCKET / ZOS_ENDPOINT / ZOS_REGION /
#           ZOS_ACCESS_KEY / ZOS_SECRET_KEY / BRANCH_NUMS / SYSTEM_BOOK / BIZDAY
set -u
REPO=${REPO:-/opt/platform-core-data/platform-core}
COMPOSE="docker compose -f $REPO/deploy/data-compose.yml"
PIPELINE=${PIPELINE:-/pipelines/common/lemeng.retail_order_line.json}
LOG_ROOT=/workspace/logs
BIZDAY=${BIZDAY:-$(date -u -d yesterday +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)}
SYSTEM_BOOK=${SYSTEM_BOOK:-3120}
PREFIX="lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY"
RB_HELPER=$REPO/lemeng-readback.sh

duckdb_bin() { $COMPOSE run --rm --entrypoint sh duckle -c 'command -v duckdb' 2>/dev/null | tr -d '\r' | tail -1; }

s3_list() { # $1=prefix
  curl -s --max-time 25 --aws-sigv4 "aws:amz:${ZOS_REGION:-xinan1}:s3" \
    --user "$ZOS_ACCESS_KEY:$ZOS_SECRET_KEY" \
    "https://${ZOS_ENDPOINT}/${ZOS_BUCKET}?list-type=2&prefix=$1"
}

case "${1:-}" in
probe)
  echo "== env presence (names + lengths only) =="
  for v in LEMENG_TOKEN DUCKLE_TOKEN ZOS_BUCKET ZOS_ENDPOINT ZOS_REGION ZOS_ACCESS_KEY ZOS_SECRET_KEY BRANCH_NUMS SYSTEM_BOOK BIZDAY; do
    printf '%s len=%s\n' "$v" "$(printenv "$v" 2>/dev/null | tr -d '\n' | wc -c)"
  done
  echo "== bucket probe from this host =="
  for pair in "https xinan-1-internal.zos.ctyun.cn" "http xinan-1-internal.zos.ctyun.cn"; do
    set -- $pair; sch=$1; ep=$2
    code=$(curl -s -o /tmp/bp.out -w '%{http_code}' --max-time 15 --aws-sigv4 "aws:amz:${ZOS_REGION:-xinan1}:s3" --user "$ZOS_ACCESS_KEY:$ZOS_SECRET_KEY" "$sch://$ep/$ZOS_BUCKET?list-type=2&max-keys=3")
    printf '%s://%s -> %s %s\n' "$sch" "$ep" "$code" "$(grep -o '<KeyCount>[0-9]*</KeyCount>' /tmp/bp.out 2>/dev/null | head -1)"
  done
  echo "== container probe =="
  echo "duckdb_path=$(duckdb_bin)"
  $COMPOSE run --rm --entrypoint sh duckle -c 'duckdb --version; echo pipelines:; ls /pipelines/common/' 2>&1 | tail -5
  echo "== httpfs availability in duckle image =="
  $COMPOSE run --rm --entrypoint sh duckle -c 'duckdb -c "INSTALL httpfs; LOAD httpfs; SELECT 1 AS httpfs_ok;"' 2>&1 | tail -3
  echo "== pg_duckdb raw_query availability =="
  docker exec openship-platform-core-shanhai-data-pg_duckdb sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U platform -d warehouse -tAc "SELECT * FROM duckdb.raw_query(\$\$ SELECT 41+1 AS ok \$\$);"' 2>&1 | tail -3
  echo "== token gate pass-through =="
  $COMPOSE run --rm -e DUCKLE_TOKEN duckle --help 2>&1 | grep -iE 'drift|token|usage' | head -6
  rm -f /tmp/bp.out
  echo "== probe end =="
  ;;
window)
  H="${2:?hour}"; SUF="${3:-}"
  BATCH_ID="retail-${SYSTEM_BOOK}-$(date -u +%Y%m%dT%H%M%SZ)-${H}${SUF}"
  out=$($COMPOSE run --rm \
    -e LEMENG_TOKEN -e DUCKLE_TOKEN -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e BIZDAY="$BIZDAY" -e HOUR="$H" -e HOUR_FROM="$H:00:00" -e HOUR_TO="$H:59:59" \
    -e BRANCH_NUMS -e SYSTEM_BOOK -e BATCH_ID="$BATCH_ID" \
    duckle --pipeline "$PIPELINE" --workspace /workspace --duckdb "$(duckdb_bin)" --log-dir "$LOG_ROOT/${H}${SUF}" 2>&1)
  rc=$?
  status=$(printf '%s' "$out" | grep -oE 'status: [a-z]+' | head -1)
  sink=$(printf '%s' "$out" | grep -E '^sink ' | head -1)
  printf 'window hour=%s exit=%s %s sink=%s\n' "$H" "$rc" "${status:-status:none}" "${sink:-none}"
  [ "$rc" -ne 0 ] && printf '%s\n' "$out" | tail -12
  ;;
windows)
  for H in $(seq -w 0 23); do sh "$0" window "$H"; done
  ;;
listing)
  for H in $(seq -w 0 23); do
    resp=$(s3_list "$PREFIX/hour=$H/")
    key=$(printf '%s' "$resp" | grep -o '<Key>[^<]*</Key>' | head -1 | sed 's/<[^>]*>//g')
    size=$(printf '%s' "$resp" | grep -o '<Size>[0-9]*</Size>' | head -1 | sed 's/<[^>]*>//g')
    etag=$(printf '%s' "$resp" | grep -o '<ETag>[^<]*</ETag>' | head -1 | sed 's/<[^>]*>//g' | tr -d '"')
    n=$(printf '%s' "$resp" | grep -c '<Key>')
    printf 'hour=%s count=%s size=%s etag=%s key=%s\n' "$H" "$n" "${size:-none}" "${etag:-none}" "${key:-none}"
  done
  echo "== literal-placeholder scan over lemeng/ (must be empty) =="
  s3_list "lemeng/" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | grep -F '${ENV' | head -3
  echo "== scan end =="
  ;;
rb)
  shift
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e RB_QUERY="$*" -v "$RB_HELPER":/rb.sh:ro duckle -c 'sh /rb.sh' 2>&1 | tail -40
  ;;
idem)
  H="${2:-03}"
  before=$(s3_list "$PREFIX/hour=$H/" | grep -oE '<(ETag|Size)>[^<]*</(ETag|Size)>' | tr -d '\n')
  echo "before=$before"
  sh "$0" window "$H" "-idem"
  after=$(s3_list "$PREFIX/hour=$H/" | grep -oE '<(ETag|Size)>[^<]*</(ETag|Size)>' | tr -d '\n')
  echo "after=$after"
  if [ "$before" = "$after" ]; then echo "IDEMPOTENT=PASS"; else echo "IDEMPOTENT=FAIL"; fi
  ;;
drift)
  echo "== assert data.schema declaration exists (anti-false-green) =="
  grep -c '"schema"' "$REPO/duckle/common/lemeng.retail_order_line.json"
  echo "== drift --help =="
  $COMPOSE run --rm -e DUCKLE_TOKEN duckle drift --help 2>&1 | head -20
  echo "== drift run =="
  $COMPOSE run --rm -e DUCKLE_TOKEN -e LEMENG_TOKEN -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e BIZDAY="$BIZDAY" duckle --token "$DUCKLE_TOKEN" drift --pipeline "$PIPELINE" --workspace /workspace 2>&1 | tail -20
  echo "drift_done"
  ;;
envfile)
  umask 077
  printf 'DUCKLE_TOKEN=%s\n' "$DUCKLE_TOKEN" > "$REPO/deploy/.env"
  chmod 600 "$REPO/deploy/.env"
  echo "envfile keys=$(cut -d= -f1 "$REPO/deploy/.env" | tr '\n' ',') mode=$(stat -c '%a' "$REPO/deploy/.env")"
  ;;
*)
  echo "usage: $0 <probe|window H [suffix]|windows|listing|rb SQL|idem H|drift|envfile>"
  exit 2
  ;;
esac
