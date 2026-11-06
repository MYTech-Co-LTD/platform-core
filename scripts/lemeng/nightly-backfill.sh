#!/bin/sh
# nightly-backfill.sh — 夜间回填窗口驱动（CST 00:05 起，09:00 停）
#
# 为什么有这个：有一批「不着急、但不能不做」的补齐工作（历史漏采 + 新接源回填），
# 白天做会跟物化/日常采集抢资源。把它们挤到夜里，且**与物化天然不重叠**：
#   · 物化 job `lemeng-dbt-materialize` cron `27 3,7,9,11,13,15 * * *` UTC
#     = **CST 11:27 / 15:27 / 17:27 / 19:27 / 21:27 / 23:27** —— 全在窗口之外
#   · 日常采集里只有 03:00–05:00 CST 那批落在窗口内 ⇒ 本脚本用 `--yield-cst 03:00-05:30` 让路
#   · 长队列用 `--continue-on-fail`：错日不中断整段，失败清单落 fail-<CST日>.jsonl 待次日补
#
# 队列文件（`#` 注释；每行四个字段）：
#     <dataset> <book> <from YYYY-MM-DD> <to YYYY-MM-DD>      # to 为排他上界
# 例：
#     transfer_in 64188 2024-11-01 2026-11-01
#
# 队列文件默认 /opt/lemeng-backfill-queue.txt（由 ops 维护，不入仓）。
# 每条任务的执行体是 scripts/lemeng/backfill-history.py（它自带 preflight / 逐日回读 / 台账）。
#
# 台账：/tmp/lemeng-nightly/<CST 日期>.log
set -u

QUEUE=${QUEUE:-/opt/lemeng-backfill-queue.txt}
REPO=${REPO:-/opt/platform-core-data/platform-core}
LEDGER_DIR=${LEDGER_DIR:-/tmp/lemeng-nightly}
UNTIL_CST=${UNTIL_CST:-9}
YIELD_CST=${YIELD_CST:-03:00-05:30}   # 日常采集 03:00~05:00 那批 + 半小时余量

mkdir -p "$LEDGER_DIR"
DAY=$(TZ=Asia/Shanghai date +%Y-%m-%d)
LEDGER="$LEDGER_DIR/$DAY.log"
: >> "$LEDGER"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LEDGER"; }

if [ ! -f "$QUEUE" ]; then
  log "NO_QUEUE $QUEUE 不存在 —— 无事可做"
  echo "NIGHTLY_DONE ok=0 fail=0 reason=no-queue"
  exit 0
fi

ok=0; fail=0
# 队列逐条执行；每条是「一个数据集 × 一个账套 × 一段日期」，
# backfill-history 自己会按 --until-cst 收窗、按 --skip-existing 跳过已有日。
while read -r ds book from to _; do
  case "${ds:-}" in ''|\#*) continue ;; esac
  if [ -z "${book:-}" ] || [ -z "${from:-}" ] || [ -z "${to:-}" ]; then
    log "QUEUE_BAD_LINE ds=$ds book=${book:-} from=${from:-} to=${to:-}"
    continue
  fi
  log "RUN ds=$ds book=$book from=$from to=$to"
  if python3 "$REPO/scripts/lemeng/backfill-history.py" \
       --dataset "$ds" --books "$book" --from "$from" --to "$to" \
       --apply --skip-existing --continue-on-fail \
       --fail-log "$LEDGER_DIR/fail-$DAY.jsonl" \
       --until-cst "$UNTIL_CST" --yield-cst "$YIELD_CST" \
       >>"$LEDGER" 2>&1; then
    ok=$((ok+1)); log "OK ds=$ds book=$book"
  else
    fail=$((fail+1)); log "FAIL ds=${ds} book=${book}（详见台账上下文）"
  fi
done < "$QUEUE"

log "NIGHTLY_DONE ok=$ok fail=$fail"
echo "NIGHTLY_DONE ok=$ok fail=$fail"
