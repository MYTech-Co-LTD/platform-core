#!/bin/sh
# console-gc —— 乐檬 console 工作区的中间产物回收（2026-11-09，issue #1704）。
#
# 为什么存在：duckle 的中间产物**全部落在 workspace 里且没有任何 GC**：
#   · `.duckle-raw/`   —— `src.rest` 的 `rawResponseDestination`（可选开关）把每个响应体写一份；
#                         路径里带 run 变量 ⇒ **每跑一次一个新文件**（3120 实测 5 天 1.3G / 13k 文件）
#   · `.duckle-stage/` —— 分片暂存（官方叫 cache：「stage outputs kept for reuse」）
#   · `runs/receipts/` —— 运行回执，每跑一次一个文件
#   · `logs/`          —— 每轮 run 的 NDJSON / 子管线 stdout（实测 15k 文件 / 676MB）
# 而 console 的 `/api/pipelines`、`/api/runs` **递归扫 workspace** ⇒ 文件上万后单请求 >12s 不返回，
# 进一步把调度器拖成 `overdue + misfire:skip`（2026-11-09 实测：09:00/09:02 的采集被整轮跳过）。
#
# 本脚本只做**有官方依据的回收**：
#   ① `duckle cache clear` —— 官方命令，帮助原文「Clearing is safe at any time: everything here
#      can be recomputed」⇒ 直接清，不自己猜哪些 stage 文件能删；
#   ② `.duckle-raw` / `.duckle-stage` 里 **mtime > N 天** 的残留文件 —— 兜住 cache clear 没覆盖到的
#      历史文件；保留 N 天（默认 1）是为了**绝不碰正在跑的那一批**（今天 10:13 实测：把 .duckle-raw
#      整个移走撞上在跑的 inventory ⇒ 它读不到自己的 whoami ⇒ 身份未证 ⇒ 拒采）。
#   ③ 体积探针：workspace 超过阈值就往 OO `data_plane_probes` 吐一行 ERR（分工：判据在数据面）。
#
# 用法（数据面机上；openship job 每日调用）：
#   sh console-gc.sh            # 两个账套都做
#   sh console-gc.sh 3120       # 只做一个
# 退出码：0=全部成功；1=有账套失败（job 侧发企微）；3=环境问题（docker/容器不在）。
set -u

BOOKS=${1:-"3120 64188"}
RAW_KEEP_DAYS=${GC_RAW_KEEP_DAYS:-1}
STAGE_KEEP_DAYS=${GC_STAGE_KEEP_DAYS:-1}
LOG_KEEP_DAYS=${GC_LOG_KEEP_DAYS:-7}
WS_WARN_MB=${GC_WS_WARN_MB:-800}
EMIT_PROBE=${GC_EMIT_PROBE:-/opt/lemeng-emit-probe.py}
RC=0

size_mb() { # <dir> → 整数 MB（目录不存在给 0）
  [ -d "$1" ] || { echo 0; return; }
  du -sm "$1" 2>/dev/null | awk '{print $1}'
}

for B in $BOOKS; do
  CT="openship-platform-core-shanhai-data-lemeng-console-$B"
  if ! docker inspect "$CT" >/dev/null 2>&1; then
    echo "GC_FAIL:${B} 容器不存在（${CT}）"
    RC=3
    continue
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$CT")" != true ]; then
    echo "GC_FAIL:${B} 容器没在跑（${CT}）"
    RC=3
    continue
  fi

  WS=/var/lib/docker/volumes/openship-platform-core-shanhai-data-lemeng-console-$B-ws/_data
  if [ ! -d "$WS" ]; then
    echo "GC_FAIL:${B} workspace 卷不存在（${WS}）"
    RC=3
    continue
  fi

  RAW_BEFORE=$(size_mb "$WS/.duckle-raw")
  STG_BEFORE=$(size_mb "$WS/.duckle-stage")
  REC_BEFORE=$(size_mb "$WS/runs/receipts")

  # ① 官方 cache clear（清 stage 缓存；帮助明说随时可清、都能重算）
  CACHE_OUT=$(docker exec "$CT" duckle cache clear --workspace /workspace 2>&1)
  case "$CACHE_OUT" in
    *rror*|*ailed*) echo "GC_FAIL:$B cache clear 失败：$(printf '%s' "$CACHE_OUT" | head -c 200)"; RC=1 ;;
    *) echo "GC_OK:$B cache_clear $(printf '%s' "$CACHE_OUT" | head -1 | head -c 120)" ;;
  esac

  # ② 历史残留（保留 N 天：绝不碰在跑的那一批）
  RAW_DEL=$(find "$WS/.duckle-raw"   -type f -mtime +"$RAW_KEEP_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  STG_DEL=$(find "$WS/.duckle-stage" -type f -mtime +"$STAGE_KEEP_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  find "$WS/.duckle-stage" -type d -empty -delete 2>/dev/null
  # 目录本身**必须保留**（src.rest 的 raw 路径是固定目录；缺目录会让当轮采集读不到自己的文件）
  # logs/ 是**第三类**无界产物（2026-11-09 实测：15,488 文件 / 676MB，其中 14,373 个 >1 天）：
  # 每轮 run 的 NDJSON/子管线 stdout 都往里写。保留 LOG_KEEP_DAYS 天用于排障；
  # ⚠️ `duckle_metrics.prom` 是 console **持续追加**的指标文件，绝不删。
  LOG_DEL=$(find "$WS/logs" -type f -mtime +"$LOG_KEEP_DAYS" ! -name 'duckle_metrics.prom' -print -delete 2>/dev/null | wc -l | tr -d ' ')
  find "$WS/logs" -type d -empty -delete 2>/dev/null

  RAW_AFTER=$(size_mb "$WS/.duckle-raw")
  STG_AFTER=$(size_mb "$WS/.duckle-stage")
  REC_AFTER=$(size_mb "$WS/runs/receipts")
  WS_MB=$(size_mb "$WS")

  echo "GC_OK:$B raw=${RAW_BEFORE}->${RAW_AFTER}MB(del=${RAW_DEL}) stage=${STG_BEFORE}->${STG_AFTER}MB(del=${STG_DEL}) logs(del=${LOG_DEL}) receipts=${REC_BEFORE}->${REC_AFTER}MB ws=${WS_MB}MB"

  # ③ 体积探针（判据在数据面；OO 只做预警面）
  if [ "$WS_MB" -ge "$WS_WARN_MB" ]; then
    if [ -x "$EMIT_PROBE" ]; then
      python3 "$EMIT_PROBE" console_workspace_size ERR "console ${B} workspace=${WS_MB}MB ≥ ${WS_WARN_MB}MB（raw=${RAW_AFTER} stage=${STG_AFTER} receipts=${REC_AFTER}）——继续涨会把 /api/pipelines 拖死" >/dev/null 2>&1 \
        || echo "GC_WARN:$B 体积探针投递失败（不影响回收）"
    else
      echo "GC_WARN:$B workspace=${WS_MB}MB ≥ ${WS_WARN_MB}MB（探针脚本 $EMIT_PROBE 不在）"
    fi
  fi
done

exit $RC
