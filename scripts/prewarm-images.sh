#!/usr/bin/env bash
# prewarm-images.sh — 在**构建宿主**上预拉本项目需要的基础镜像（幂等）。
#
# 为什么需要它（2026-11-19 案例）：本机 pull-through registry 缓存是构建链的唯一入口
# （mirror 优先级高于代理）。首次经缓存拉**大**镜像时，registry 代理上游的单个 blob 可能
# 超过 docker 客户端的等待预算（实测 `pgvector/pgvector:pg17` 报 `write: broken pipe` +
# `500`，部署挂在 `Docker pull failed`），而那一刻线上是空的、只能人工救。
# 预拉把这件事从「部署当事」挪到「机器就绪」：预拉失败只影响准备阶段，不会让一次发布半途挂掉。
#
# 用法（在目标机上跑，需要 docker）：
#   bash scripts/prewarm-images.sh          # 只拉缺的
#   bash scripts/prewarm-images.sh --force  # 全部重拉（极少用，排查用）
#
# 清单来源是**解析**（不是手抄）：Dockerfile 的 FROM + compose 的 image:。这样加一个服务
# 就自动进清单，不会出现「脚本里的清单和仓里漂了」。
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

force=0
[ "${1:-}" = "--force" ] && force=1

# 1) Dockerfile 的 FROM（跳过 build stage 之间也用到的 AS 别名不影响：FROM 的都是真实镜像）
# 2) compose 的 image:（跳过含 ${} 的模板——那不是确定的镜像引用）
collect() {
  {
    grep -rhE '^[[:space:]]*FROM[[:space:]]' \
      deploy/Dockerfile.server deploy/Dockerfile.openclaw \
      deploy/duckle/Dockerfile deploy/artifacts/Dockerfile 2>/dev/null \
      | awk '{print $2}'
    grep -rhE '^[[:space:]]*image:[[:space:]]' \
      deploy/docker-compose.yml deploy/data-compose.yml 2>/dev/null \
      | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/["'\'']//g' \
      | grep -v '\${' || true
  # `*:local` 是本仓**自建**的镜像（compose 里的 image: 只是给构建产物起名），拉不到也不需要拉
  } | grep -vE '^(scratch|base)$' | grep -v ':local$' | sort -u
}

# 不用 mapfile：macOS 自带的是 bash 3.2，运维随手在笔记本上跑也要能过
images=()
while IFS= read -r img; do images+=("$img"); done < <(collect)
if [ "${#images[@]}" -eq 0 ]; then
  echo "::error::没解析出任何镜像——检查 Dockerfile/compose 路径是否变了" >&2
  exit 1
fi

echo "待检查 ${#images[@]} 个基础镜像："
printf '  - %s\n' "${images[@]}"

fail=0
for img in "${images[@]}"; do
  if [ "$force" -eq 0 ] && docker image inspect "$img" >/dev/null 2>&1; then
    echo "✓ 已有 $img"
    continue
  fi
  echo "↓ 拉取 $img"
  # 重试 3 次：缓存首次穿源时偶发慢连接，重试比一次失败就放弃划算
  ok=0
  for attempt in 1 2 3; do
    if timeout 600 docker pull "$img"; then ok=1; break; fi
    echo "  第 ${attempt}/3 次失败，5s 后重试"
    sleep 5
  done
  if [ "$ok" -eq 1 ]; then
    echo "✓ $img"
  else
    echo "::error::拉取失败：$img" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "预拉有失败项（见上）。判据：同台机的 registry 缓存是否健康——" >&2
  echo "  curl -fsS -m 5 http://127.0.0.1:5000/v2/ && docker info --format '{{json .RegistryConfig.Mirrors}}'" >&2
  exit 1
fi
echo "全部就绪。"
