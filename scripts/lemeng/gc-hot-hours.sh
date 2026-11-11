#!/bin/sh
# gc-hot-hours.sh — 每日清理「已被天文件取代」的小时对象（#1905，治本见 #1906）。
#
# 为什么必须有排期：小时对象是热/冷布局的**暂存区**（`system_book=/bizday=/hour=/all.parquet`）。
# 天文件落盘后它们就不再被读侧使用，但**仍会被 glob 命中**——视图热腿
# `system_book=*/bizday=*/hour=*/all.parquet` 会把它们全部打开。不回收 ⇒ 查询成本随天数
# **线性增长**：2026-11-11 实测积了 671 个死文件，30 天 `query_detail` 47.4s 全花在热腿
# （冷腿只要 5.9s）。清理后同查询 7.8s。
#
# 安全：真正的删除判据在 `delete-supplanted-hour-partitions.py`（默认 dry-run；`--before` 必填；
# 删前必须证明「天文件 + 封版标记都在」，否则 SKIP）。本脚本只做：取凭据、算窗口、双账套循环、
# 汇总退出码。**本脚本不删除任何东西**。
#
# 用法（数据面宿主，openship job 调用）：
#   sh /opt/lemeng-gc-hot-hours.sh
# 可覆盖 env：
#   GC_DAYS_BACK=2        只删 bizday < 上海今天−2 的对象（重述窗口护栏）
#   GC_BOOKS="3120 64188" 账套清单
#   GC_CONSOLE_CT=...     取凭据的 console 容器（凭据只在容器 env 里）
#   GC_TOOL=...           删除工具路径
#
# 退出码：0 ⇒ 末行 `GC_OK deleted=<n> before=<YYYY-MM-DD>`；1 ⇒ 任一账套失败（fail loud）。
set -eu

CT=${GC_CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-3120}
BOOKS=${GC_BOOKS:-"3120 64188"}
DAYS_BACK=${GC_DAYS_BACK:-2}
TOOL=${GC_TOOL:-/opt/platform-core-data/platform-core/scripts/lemeng/delete-supplanted-hour-partitions.py}

[ -f "$TOOL" ] || { echo "GC_FAILED: 工具不存在 $TOOL" >&2; exit 1; }
docker inspect "$CT" >/dev/null 2>&1 || { echo "GC_FAILED: 容器不存在 $CT" >&2; exit 1; }

# 窗口：上海今天 − N 天。GNU date（Ubuntu 数据机）为主，BSD 形态兜底。
BEFORE=$(TZ=Asia/Shanghai date -d "-${DAYS_BACK} days" +%F 2>/dev/null \
  || TZ=Asia/Shanghai date -v-"${DAYS_BACK}"d +%F)
case "$BEFORE" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "GC_FAILED: 算不出 --before（得到 ${BEFORE:-空}）" >&2; exit 1 ;;
esac

# 凭据：从运行中的 console 容器现取（不落盘、不回显；只进本进程 env）。
for k in ZOS_ACCESS_KEY ZOS_SECRET_KEY ZOS_ENDPOINT ZOS_REGION ZOS_BUCKET; do
  v=$(docker exec "$CT" printenv "$k" 2>/dev/null || true)
  if [ -z "$v" ]; then
    echo "GC_FAILED: 取不到 ${k}（容器 ${CT}）" >&2
    exit 1
  fi
  export "$k=$v"
done

fail=0
total=0
log=$(mktemp "${TMPDIR:-/tmp}/gc-hot.XXXXXX")
for b in $BOOKS; do
  if python3 "$TOOL" --book "$b" --before "$BEFORE" --apply >"$log" 2>&1; then
    n=$(awk '/DELETE_DONE/ {for (i = 1; i <= NF; i++) if ($i ~ /^ok=/) {split($i, a, "="); s += a[2]}} END {print s + 0}' "$log")
    total=$((total + n))
    echo "GC_BOOK_OK book=$b deleted=$n before=$BEFORE"
  else
    fail=1
    echo "GC_BOOK_FAILED book=$b before=$BEFORE" >&2
    tail -5 "$log" >&2
  fi
done
rm -f "$log"

[ "$fail" -eq 0 ] || { echo "GC_FAILED before=$BEFORE" >&2; exit 1; }
echo "GC_OK deleted=$total before=$BEFORE"
