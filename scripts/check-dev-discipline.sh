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

# 两个范围各司其职：① 提交清单用两点（本分支多出来的提交）；② 变更集用三点（比 merge-base）。
echo "  范围: 提交 $BASE..$HEAD ／ 变更集 $BASE...$HEAD"
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
# 变更集必须用**三点** diff（$BASE...$HEAD = merge-base..HEAD）：那才是「**这个分支**改了什么」。
# 两点（$BASE..$HEAD）比的是「两棵树」：分支只要落后于 main，main 上的改动就会显示成
# 「这个分支改了它」—— 而 main 每次发版都有 chore(release) 改 CHANGELOG.md ⇒ 落后即误报（#99）。
#
# ⚠️ 别把这里的「三点」类推到下面的 `git log`：`diff A...B` 与 `log A...B` **名字像、语义不同**——
#    `diff A...B` = 拿 merge-base 与 B 比（本分支的改动）；`log A...B` = **对称差**（两边独有的
#    提交**都**算，会把 main 上分支没有的提交一并卷进来）。下面那处要的恰恰是「本分支自己的提交」，
#    所以必须留在两点（见该处注释）。
CHANGED_FILES=$(git diff --name-only "$BASE...$HEAD" 2>/dev/null)
if echo "$CHANGED_FILES" | grep -qE '^CHANGELOG\.md$'; then
  # 豁免：release bot 自己的发版提交。
  # 这里用**两点** `git log "$BASE..$HEAD"`（= 本分支自己的提交）。**不要**改成三点：
  # 三点是对称差，分支落后于 main 时会把 main 上的 fix/feat 提交算成「本分支的非 release 提交」
  # ⇒ 豁免失效，一个只含 chore(release) 的分支反被误拦（#99 实测：两点计 0/放行，三点计 1/误报）。
  IS_RELEASE_ONLY=$(git log --no-merges --format=%s "$BASE..$HEAD" 2>/dev/null \
                    | grep -vcE '^chore\(release\):')
  if [ "$IS_RELEASE_ONLY" -eq 0 ]; then
    echo "  ✓ CHANGELOG.md 有变更（chore(release) 提交，放行）"
  else
    # 文案要求：把两种情形分开说，且各自给**正确**的动作。
    # 旧文案只认「你手改了」并且建议 `git checkout <base> -- CHANGELOG.md` —— 那条**有害**：
    # 照做会把 main 的发版提交带进本分支，从「只是落后」变成真违规。故已删除。
    echo "  ❌ CHANGELOG.md 被改 —— 它由 release.mjs 独占维护，禁止手写"
    echo "     · 情形① 本分支确实改了它：撤销**本分支这一处**改动后重提"
    echo "       （git restore CHANGELOG.md，或在你自己的提交里还原该文件）"
    echo "       ⚠️ 不要用 git checkout origin/main -- CHANGELOG.md：那会把 main 的发版提交"
    echo "          提交进本分支，从「只是落后」变成真违规。"
    echo "     · 情形② 你确信自己没动过 CHANGELOG（只是落后于 main）：那是**旧口径**的误报"
    echo "       —— 2026-09-17 前的版本用两点 diff 取变更集，会把 main 的发版改动算到你头上"
    echo "       （issue #99）。升级本脚本，或 git rebase origin/main 即可；"
    echo "       **不要** checkout CHANGELOG.md。"
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