#!/usr/bin/env bash
# sync-ops-scripts.sh — 把「job 直接执行」的运维脚本投递到目标机的 /opt，并逐字节校验一致性。
#
# 为什么需要它（2026-11-19 案例）：`deploy/data-plane-manifest.txt` 是**数据面专用**清单
# （表头写明「落到数据面机」）。W4 把应用单元换机后，`lemeng-narrative-health.py` 与
# `lemeng-emit-probe.py` 需要在**应用机**上跑，却没有任何投递机制 ⇒ 只能手工 scp。
# 手工副本没有版本锚：换机、重装、别人接手时都会静默丢，job 随后以「can't open file」红掉
# ——今天就是这样被发现的（连红两小时）。
#
# 用法（在**有仓的机器**上跑，可指向远端）：
#   bash scripts/sync-ops-scripts.sh --check                      # 校验本机 /opt
#   bash scripts/sync-ops-scripts.sh --check --host root@10.0.0.3 # 校验远端（推荐）
#   bash scripts/sync-ops-scripts.sh --host root@10.0.0.3         # 投递：缺失/不一致才覆盖
#
# 判据是 **sha256 逐字节比对**，不是「文件存在」——存在但版本旧是更坏的形态
# （job 跑的是旧逻辑，日志却一切正常）。
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode="apply"
host=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode="check"; shift ;;
    --host) host=${2:?--host 需要目标} ; shift 2 ;;
    *) echo "用法: $0 [--check] [--host user@ip]" >&2; exit 2 ;;
  esac
done

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 远端 ssh 的附加参数（密钥/跳板机）：SYNC_SSH_OPTS="-i ~/.ssh/xxx.pem"
SSH_OPTS=${SYNC_SSH_OPTS:-}
ssh_run() { # <cmd>   —— 不加引号展开是有意的：让 -i 这类参数按空格拆开
  # shellcheck disable=SC2086
  # `-n`：ssh 默认会读 stdin，而本脚本在 `while read` 循环里调它——不隔离会把剩余行吃掉
  # （2026-11-19 实测：只处理了清单第一条）。
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 $SSH_OPTS "$host" "$1"
}

# 远端当前哈希；文件不存在返回空。走 ssh，目标机只需要 sha256sum/shasum。
remote_sha() { # <path>
  if [ -n "$host" ]; then
    ssh_run "if [ -f '$1' ]; then (sha256sum '$1' 2>/dev/null || shasum -a 256 '$1') | cut -d' ' -f1; fi" 2>/dev/null || true
  else
    [ -f "$1" ] && sha "$1" || true
  fi
}

# 仓内路径 → 落地路径 → 权限。**只放「job 命令里直接点到」的脚本**；
# 数据面那些仍由 deploy/data-plane.lock 管，别在这里重复登记。
# 加一条之前先问：它是不是在某条 job 命令里被 `python3 /opt/...` / `sh /opt/...` 点到？
MAPPING='
scripts/narrative-health-probe.py /opt/lemeng-narrative-health.py 0755
scripts/lemeng/emit-probe.py /opt/lemeng-emit-probe.py 0755
'

drift=0
changed=0
while read -r src dst perms; do
  [ -z "${src:-}" ] && continue
  want=$(sha "$root/$src")
  have=$(remote_sha "$dst")
  if [ "$want" = "${have:-}" ]; then
    echo "✓ ${host:+$host:}$dst"
    continue
  fi
  drift=1
  if [ "$mode" = "check" ]; then
    echo "✗ ${host:+$host:}$dst —— 与仓内不一致（want=${want:0:12} have=${have:0:12}${have:-缺失}）"
    continue
  fi
  ts=$(date +%Y%m%d%H%M%S)
  if [ -n "$host" ]; then
    ssh_run "if [ -f '$dst' ]; then cp -p '$dst' '$dst.bak-$ts'; fi"
    # shellcheck disable=SC2086
    scp -q $SSH_OPTS "$root/$src" "$host:$dst"
    ssh_run "chmod $perms '$dst'"
  else
    [ -f "$dst" ] && cp -p "$dst" "$dst.bak-$ts"
    install -m "$perms" "$root/$src" "$dst"
  fi
  echo "↑ 已投递 ${host:+$host:}${dst}（${perms}，旧副本留 .bak-${ts}）"
  changed=$((changed + 1))
done <<< "$MAPPING"

if [ "$mode" = "check" ]; then
  if [ "$drift" -eq 0 ]; then echo "全部一致。"; else echo "有漂移（缺失或不一致）。" >&2; exit 1; fi
else
  if [ "$changed" -eq 0 ]; then echo "无需投递，全部已是最新。"; else echo "投递了 $changed 个文件。"; fi
fi
