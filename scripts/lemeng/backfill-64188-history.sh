#!/bin/sh
# backfill-64188-history.sh —— 64188 出库域 17 个月块有界回填驱动器（#2493）。
#
# ⚠️ 运维规矩（2026-11-20 用户定，别回退）：
#   ① 历史回填**只在 CST 00:00–09:00 窗口跑**（避开白天采集/dbt 窗口，防并发）；
#      本脚本自带窗口闸门：不在窗口内直接拒跑；CST 09:00 前未完成 ⇒ 硬停（块幂等，次晚续跑）。
#   ② 单块超 10 分钟或整段预计超 10 分钟 ⇒ 交给 @来财 盯，不要自跑。
#
# 每块：
#   - 先等平台作业空闲（job_run 无 running 行）再跑，避免与 scheduler 抢 pg_duckdb；
#   - 走 materialize.sh 的 backfill 档（profiles/日志路径都由它管，**别绕开直跑 dbt**——
#     只读工程目录里 dbt 会静默 rc=2，Wave 8 P1 已踩）；
#   - 选择器用 **path:** 形式（裸模型名在该工程匹配不到启用节点，2026-11-20 实测；
#     hourly/audit 档全用 path: 选择器）；
#   - materialize.sh 已有假绿防护（Nothing to do / PASS=0 ⇒ MATERIALIZE_FAILED）。
#
# 用法（数据单元 scheduler 容器内）：
#   setsid sh scripts/lemeng/backfill-64188-history.sh >/dev/null 2>&1 &
#   tail -f /tmp/backfill64188.log
LOG=/tmp/backfill64188.log
MODELS='path:models/lemeng/marts/fct_hq_outbound.sql path:models/lemeng/marts/fct_outbound_region.sql path:models/lemeng/marts/fct_transfer_item.sql'

cst_hour() { TZ=Asia/Shanghai date +%H; }

# 窗口闸门：只在 00–08 点起跑（09 点整之后不再起新块）
if [ "$(cst_hour)" -ge 9 ] || [ "$(cst_hour)" -lt 0 ]; then
  echo "$(date -u +%FT%TZ) 拒跑：历史回填窗口为 CST 00:00–09:00（现在 CST $(cst_hour) 点）" >&2
  exit 2
fi

: > "$LOG"
echo "driver start $(date -u +%FT%TZ)（CST $(TZ=Asia/Shanghai date +%FT%T)）" >> "$LOG"

# ── 维护锁（#2585）：回填是**长 exec**，不在 job_run 台账里 ⇒ CI 的运行中作业闸门看不见它。
# 不落这把锁，任何人在这 9 小时里合一个 PR，CI 就会重启调度器、把回填砍在一半，而且毫无征兆。
# 11 小时 = 窗口起点 + 9 小时 + 余量；正常结束/中断都会 unlock。
DRAIN_SH=/app/scripts/ops/drain.sh
[ -f "$DRAIN_SH" ] || DRAIN_SH=$(dirname "$0")/../ops/drain.sh
if sh "$DRAIN_SH" lock 660 backfill-64188 >> "$LOG" 2>&1; then
  trap 'sh "'"$DRAIN_SH"'" unlock >> "$LOG" 2>&1 || true' EXIT INT TERM
else
  # 锁不上不阻断回填（回填本身仍然有价值），但要在日志里显眼——这意味着这段时间要人工盯部署。
  echo "MAINTENANCE_LOCK_FAILED：没能落维护锁 ⇒ 回填期间**不要合并任何 PR**（部署会砍掉回填）" >> "$LOG"
fi

wait_idle() {
  i=0
  while [ "$(psql "$DATABASE_URL" -Atc "select count(*) from platform.job_run where status='running'" 2>/dev/null)" != "0" ]; do
    i=$((i+1))
    echo "$(date -u +%FT%TZ) 平台作业在跑，等 60s（第 $i 次）" >> "$LOG"
    [ $i -ge 60 ] && return 1
    sleep 60
  done
  return 0
}

chunk() {
  # 09:00 硬停：出窗即停，剩余块次晚续跑（delete+insert 幂等）
  if [ "$(cst_hour)" -ge 9 ]; then
    echo "WINDOW_STOP：已到 CST 09:00，剩余块（$1 起）次晚续跑" >> "$LOG"
    exit 3
  fi
  wait_idle || { echo "STOP: 60min 等不到空闲窗口（块 $1）" >> "$LOG"; exit 1; }
  echo "=== chunk $1 -> $2 start $(date -u +%FT%TZ)" >> "$LOG"
  ( cd /app && MATERIALIZE_SCOPE=backfill MATERIALIZE_SELECT="$MODELS" \
    MATERIALIZE_DBT_VARS="{\"bf_from\":\"$1\",\"bf_to\":\"$2\"}" \
    DATA_PLANE_DOMAINS=lemeng MATERIALIZE_MODE=container \
    sh scripts/lemeng/materialize.sh ) >> "$LOG" 2>&1
  rc=$?
  echo "=== chunk $1 rc=$rc end $(date -u +%FT%TZ)" >> "$LOG"
  if [ $rc -ne 0 ]; then echo "STOP_ON_FAIL chunk $1（看上方 MATERIALIZE_FAILED）" >> "$LOG"; exit 1; fi
}

chunk 2024-11-01 2024-12-01
chunk 2024-12-01 2025-01-01
chunk 2025-01-01 2025-02-01
chunk 2025-02-01 2025-03-01
chunk 2025-03-01 2025-04-01
chunk 2025-04-01 2025-05-01
chunk 2025-05-01 2025-06-01
chunk 2025-06-01 2025-07-01
chunk 2025-07-01 2025-08-01
chunk 2025-08-01 2025-09-01
chunk 2025-09-01 2025-10-01
chunk 2025-10-01 2025-11-01
chunk 2025-11-01 2025-12-01
chunk 2025-12-01 2026-01-01
chunk 2026-01-01 2026-02-01
chunk 2026-02-01 2026-03-01

# ── 尾块：3120 库存快照 2025-08（湖有 206,380 行、mart 缺；2026-11-20 取证）────────────
# 模型集不同，不能复用上面的 chunk 函数——单独跑一次 backfill 档。
if [ "$(cst_hour)" -ge 9 ]; then
  echo "WINDOW_STOP：库存尾块未跑（已到 CST 09:00），次晚续跑" >> "$LOG"
else
  wait_idle || { echo "STOP: 库存尾块等不到空闲窗口" >> "$LOG"; exit 1; }
  echo "=== chunk inventory-3120 2025-08-01 -> 2025-09-01 start $(date -u +%FT%TZ)" >> "$LOG"
  ( cd /app && MATERIALIZE_SCOPE=backfill \
    MATERIALIZE_SELECT='path:models/lemeng/marts/fct_inventory_snapshot.sql' \
    MATERIALIZE_DBT_VARS='{"bf_from":"2025-08-01","bf_to":"2025-09-01"}' \
    DATA_PLANE_DOMAINS=lemeng MATERIALIZE_MODE=container \
    sh scripts/lemeng/materialize.sh ) >> "$LOG" 2>&1
  echo "=== chunk inventory-3120 rc=$? end $(date -u +%FT%TZ)" >> "$LOG"
fi

echo "ALL_DONE $(date -u +%FT%TZ)" >> "$LOG"
