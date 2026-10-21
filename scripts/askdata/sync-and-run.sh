#!/bin/sh
# askdata 演进回路 P1 宿主侧入口（openship job 的 command）。
#
# 前置：两个脚本须已在 /var/lib/askdata/（交付方式见 notes 的「定时与运维」段）。
#   **缺文件就响亮失败**（set -eu + 显式校验），不静默空转。
# 凭据：只在**本 shell 内** source /etc/openobserve-ingest.env，不回显、不进任何输出。
# 失败语义：任一步非 0 即整体退出 1（fail-fast，不用 || true 吞）。
set -eu

D=/var/lib/askdata
V=/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data
# 2026-10-21：不再写死 main。**每个 agent 一份水位**——否则新 agent 的 seq 从 1 开始、
# 全都小于全局水位 ⇒ 永久静默跳过（不报错、不告警、trace 里就是没有）。
# export-transcript.py 已支持 ASK_TRACE_WM 覆盖，故只改本文件。
AGENTS_GLOB="$V"/agents/*/agent/openclaw-agent.sqlite

for f in "$D/export-transcript.py" "$D/attribute.py"; do
  [ -r "$f" ] || { echo "SYNC_FAIL missing $f"; exit 1; }
done
set -- $AGENTS_GLOB
[ -r "$1" ] || { echo "SYNC_FAIL 找不到任何 agent 的 session db（${AGENTS_GLOB}）"; exit 1; }
[ -r /etc/openobserve-ingest.env ] || { echo "SYNC_FAIL missing /etc/openobserve-ingest.env"; exit 1; }

set -a; . /etc/openobserve-ingest.env; set +a

for db in $AGENTS_GLOB; do
  [ -r "$db" ] || continue
  a=$(basename "$(dirname "$(dirname "$db")")")
  echo "AGENT $a"
  ASK_TRACE_WM="$D/export.watermark.$a" python3 "$D/export-transcript.py" "$db"
  python3 "$D/attribute.py" "$db"
done
