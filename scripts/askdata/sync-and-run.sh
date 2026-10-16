#!/bin/sh
# askdata 演进回路 P1 宿主侧入口（openship job 的 command）。
#
# 前置：两个脚本须已在 /var/lib/askdata/（交付方式见 notes 的「定时与运维」段——
#   它们是随 T1/T2 的推送落盘的；本脚本**故意不内嵌**它们，保持可读可审）。
#   **缺文件就响亮失败**（set -eu + 显式校验），不静默空转。
# 凭据：只在**本 shell 内** source /etc/openobserve-ingest.env，不回显、不进任何输出。
# 失败语义：任一步非 0 即整体退出 1（fail-fast，不用 || true 吞）。
set -eu

D=/var/lib/askdata
V=/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data
DB="$V/agents/main/agent/openclaw-agent.sqlite"

for f in "$D/export-transcript.py" "$D/attribute.py"; do
  [ -r "$f" ] || { echo "SYNC_FAIL missing $f —— 见 notes「定时与运维」段的交付步骤"; exit 1; }
done
[ -r "$DB" ] || { echo "SYNC_FAIL missing session db $DB"; exit 1; }
[ -r /etc/openobserve-ingest.env ] || { echo "SYNC_FAIL missing /etc/openobserve-ingest.env"; exit 1; }

set -a; . /etc/openobserve-ingest.env; set +a

python3 "$D/export-transcript.py" "$DB"
python3 "$D/attribute.py" "$DB"
