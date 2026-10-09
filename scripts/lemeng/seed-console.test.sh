#!/bin/sh
# seed-console.test.sh — console 卷 seed 工具的**期望集**测试（#531：共享族 + 本账套后缀族）。
#
# 手法与同族一致：**从脚本里抽真函数来测，不复制一份实现**——复制即漂移。
# 抽不到函数 = 脚本结构变了 ⇒ 判红（不是跳过）。
#
# 为什么只测期望集（_pairs 的过滤/映射）：sha256 比对与 docker exec 面需要真机；
# 「该 seed 哪些件」才是本工具唯一会**写错生产卷**的决策面 ⇒ 穷举钉住。
set -u
SRC=$(dirname "$0")/seed-console.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 ${SRC}（工具还没落地？）"; exit 2; }

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }
has()  { case "$1" in *"$2"*) pass=$((pass + 1));; *) fail=$((fail + 1)); echo "  FAIL: 输出里没有 [$2]";; esac; }
hasnt(){ case "$1" in *"$2"*) fail=$((fail + 1)); echo "  FAIL: 输出里不该有 [$2]";; *) pass=$((pass + 1));; esac; }

# ── 抽 _pairs（顶层常量带不过来 ⇒ 测试里显式设成与脚本一致）────────────────────
_rn=0
for _fn in _pairs; do
  _fb=$(awk -v fn="$_fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")
  if [ -n "$_fb" ]; then eval "$_fb"; _rn=$((_rn + 1)); else fail=$((fail + 1)); echo "  FAIL: 抽不到 ${_fn}（脚本结构变了？）"; fi
done
ok "$_rn" "1"
CONSOLE_REL='deploy/duckle/console/'

# ── 夹具锁文件（真 lock 行形：`<sha> <仓内路径> <落地路径> <模式>`）──────────────
_FIX=$(mktemp -d)
cat > "${_FIX}/lock" <<EOF
sha256-of-rest fakefake
a1 deploy/duckle/console/pipelines/lemeng.dim.branch.l0.json \fx-target 0644
a2 deploy/duckle/console/pipelines/lemeng.retail.tick.l1.json \fx-target 0644
a3 deploy/duckle/console/pipelines/lemeng.client.l0.3120.json \fx-target 0644
a4 deploy/duckle/console/pipelines/lemeng.client.l0.64188.json \fx-target 0644
a5 deploy/duckle/console/schedules/3120.json \fx-target 0644
a6 deploy/duckle/console/schedules/64188.json \fx-target 0644
a7 deploy/duckle/console/alerts.lemeng.json \fx-target 0644
a8 deploy/duckle/console/owners.lemeng.json \fx-target 0644
EOF
LOCK="${_FIX}/lock"

# ── ① 3120：共享 2 + 本账套 .3120 1，**不含** .64188 ─────────────────────────
BOOK=3120 ONLY=pipelines
_out=$(_pairs)
ok "$(printf '%s' "$_out" | grep -c .)" "3"
hasnt "$_out" "64188"
ok "$(printf '%s' "$_out" | grep -c 'client.l0.3120.json')" "1"
ok "$(printf '%s' "$_out" | grep -c 'lemeng.retail.tick.l1.json')" "1"
ok "$(printf '%s' "$_out" | grep -c 'lemeng.dim.branch.l0.json')" "1"

# ── ② 64188：镜像对称（本账套 .64188 在、.3120 不在）─────────────────────────
BOOK=64188 ONLY=pipelines
_out=$(_pairs)
ok "$(printf '%s' "$_out" | grep -c .)" "3"
hasnt "$_out" "client.l0.3120"
ok "$(printf '%s' "$_out" | grep -c 'client.l0.64188.json')" "1"

# ── ③ --only all：排班只映射**本账套**的，alerts/owners 照旧 ─────────────────
BOOK=3120 ONLY=all
_out=$(_pairs)
ok "$(printf '%s' "$_out" | grep -c '/workspace/schedules.json')" "1"     # 恰映射一份排班
hasnt "$_out" "schedules/64188"                                           # 他账套排班不进
has "$(printf '%s' "$_out" | grep 'schedules.json')" "schedules/3120.json"  # 且是本账套那份
ok "$(printf '%s' "$_out" | grep -c '/workspace/alerts.json')" "1"
ok "$(printf '%s' "$_out" | grep -c '/workspace/owners.json')" "1"

# ── ④ 落地路径都以 /workspace/ 开头（映射不变的形状哨兵）─────────────────────
BOOK=3120 ONLY=all
ok "$(printf '%s' "$_out" | grep -vc '/workspace/')" "0"

# ── ⑤ 变异确认：删掉后缀过滤 ⇒ 恰有断言变红（.64188 混进 3120 的期望集）──────
_MUT=$(mktemp -d)
cp "$SRC" "${_MUT}/seed-console.sh"
sed 's/if (suf != book) next//' "${_MUT}/seed-console.sh" > "${_MUT}/m.sh" && mv "${_MUT}/m.sh" "${_MUT}/seed-console.sh"
grep -q 'suf != book' "${_MUT}/seed-console.sh" && { echo "  FAIL: 变异没生效"; fail=$((fail + 1)); }
_mfb=$(awk -v fn="_pairs" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "${_MUT}/seed-console.sh")
eval "$_mfb"
BOOK=3120 ONLY=pipelines
ok "$(_pairs | grep -c .)" "4"          # 变异后 .64188 混入 ⇒ 期望集多一件（本行在未变异脚本上必红）
rm -rf "${_FIX}" "${_MUT}"

echo "── seed-console.test.sh: PASS=${pass} FAIL=${fail} ──"
[ "${fail}" -eq 0 ] || exit 1
echo "seed-console.test.sh: OK"
