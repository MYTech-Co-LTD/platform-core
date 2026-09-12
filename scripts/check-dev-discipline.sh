#!/usr/bin/env bash
# check-dev-discipline.sh — 开发纪律自动检查（CI 强制执行，人绕不过）
# 检查：① commit message 是否符合 conventional commits ② CHANGELOG 是否被手改（禁止手写）
# 用法：
#   bash scripts/check-dev-discipline.sh                # 检查当前分支最近提交（相对 origin/main 或 HEAD~5）
#   bash scripts/check-dev-discipline.sh <base> <head>  # 显式范围（CI 用，如 origin/main HEAD）
# 返回：违反任一规则 exit 1（阻断合并）
set -uo pipefail

# 从 commit message 第一行解析 type(scope)
parse_type() {
  echo "$1" | sed -E 's/^([a-z]+)(\([^)]*\))?(!)?:.*/\1/'
}

# 判断该 commit 是否 docs-only（docs: 前缀）
is_docs_only() {
  local msg="$1"
  [[ "$(parse_type "$msg")" == "docs" ]]
}

echo "▶ 开发纪律检查（commit 规范 + CHANGELOG）"
issues=0

# 确定检查范围
if [ $# -ge 2 ]; then
  BASE="$1"; HEAD="$2"
else
  # 默认：相对远端 main 的分支提交；无远端则最近 10 个
  if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    BASE="origin/main"
  else
    BASE="HEAD~10"
  fi
  HEAD="HEAD"
fi

echo "  范围: $BASE..$HEAD"
COMMITS=$(git log --no-merges --format="%H|%s" "$BASE..$HEAD" 2>/dev/null)  # --no-merges: merge commit 由 git 生成,不适用 conventional commits
if [ -z "$COMMITS" ]; then echo "  ✓ 无提交需要检查"; exit 0; fi

# 1) commit message 格式检查
echo ""
echo "── ① commit message（conventional commits）──"
ALLOWED_TYPES="feat|fix|docs|refactor|perf|test|chore|build|ci|style"
# herestring(<<<)是 bash 专属语法,CI shell check 对 .sh 一律 sh -n(POSIX)会拒;
# 改临时文件喂 while——保住循环内 issues 计数(管道写法会把 while 关进子壳)
DISCIPLINE_COMMITS_FILE=$(mktemp)
trap 'rm -f "$DISCIPLINE_COMMITS_FILE"' EXIT
printf '%s\n' "$COMMITS" > "$DISCIPLINE_COMMITS_FILE"
while IFS='|' read -r hash msg; do
  [ -z "$msg" ] && continue
  type=$(parse_type "$msg")
  if ! echo "$msg" | grep -qE "^($ALLOWED_TYPES)(\([a-z0-9-]+\))?(!)?: .+"; then
    echo "  ❌ $hash: 格式不符 → $msg"
    echo "     应为: <type>(<scope>): <一句话>  type∈(${ALLOWED_TYPES//|/\/})"
    issues=$((issues+1))
  elif [ -z "$type" ]; then
    echo "  ❌ $hash: 无法解析 type → $msg"
    issues=$((issues+1))
  else
    echo "  ✓ $hash: $type"
  fi
done < "$DISCIPLINE_COMMITS_FILE"

# 2) CHANGELOG 手改守卫：CHANGELOG.md 由 release.mjs 独占维护，禁止手写
echo ""
echo "── ② CHANGELOG（禁止手写；由 release.mjs 生成）──"
CHANGED_FILES=$(git diff --name-only "$BASE..$HEAD" 2>/dev/null)
if echo "$CHANGED_FILES" | grep -qE '^CHANGELOG\.md$'; then
  # 豁免：release bot 自己的发版提交
  IS_RELEASE_ONLY=$(git log --no-merges --format=%s "$BASE..$HEAD" 2>/dev/null \
                    | grep -vcE '^chore\(release\):')
  if [ "$IS_RELEASE_ONLY" -eq 0 ]; then
    echo "  ✓ CHANGELOG.md 有变更（chore(release) 提交，放行）"
  else
    echo "  ❌ CHANGELOG.md 被手改 —— 它由 release.mjs 独占维护，禁止手写"
    echo "     回退该文件后重提：git checkout ${BASE} -- CHANGELOG.md"
    echo "     （标准 §1.4：CHANGELOG 由脚本从 conventional commits 生成）"
    issues=$((issues+1))
  fi
fi

echo ""
if [ "$issues" -gt 0 ]; then
  echo "❌ 开发纪律检查失败（${issues} 处违反）"
  exit 1
fi
echo "✅ 开发纪律检查通过"
exit 0