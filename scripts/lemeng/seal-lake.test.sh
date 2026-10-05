#!/bin/sh
# seal-lake.test.sh — 封版判定（seal-lake.sh 的 `seal_verdict`）的**判别逻辑**测试。
#
# 手法与 recon-day-heal.test.sh / diagnose.test.sh 一致：**从脚本里抽真函数来测，不复制一份实现**
# ——复制即漂移；抽不到函数名 = 脚本结构变了 ⇒ 判红（不是跳过）。
#
# 为什么只测判别：探针那一半（glob + DESCRIBE + S3）**要真机 + 凭据**，不该进 CI；
# 而「齐 / 不齐 / 探针坏了」这三条**判别**才是本脚本唯一会**拒写或放行封版**的地方 ——
# 放行错了，读者的 fail-closed 断言就会拿一个半写的湖当完整的用（那正是实测踩过的静默错）。
set -u
SRC=$(dirname "$0")/seal-lake.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 ${SRC}（工具还没落地？）"; exit 2; }

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }

# ── 抽函数 ──
_rn=0
_fb=$(awk '/^seal_verdict\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$SRC")
if [ -n "$_fb" ]; then eval "$_fb"; _rn=$((_rn+1)); else fail=$((fail+1)); echo "  FAIL: 抽不到 seal_verdict（脚本结构变了？）"; fi
ok "$_rn" "1"

# ── 齐 ⇒ SEAL_OK 且 rc=0 ──
out=$(seal_verdict lemeng.retail_order_line 3 '{"n":24,"bad":[]}'); rc=$?
ok "$rc" "0"
case "$out" in "SEAL_OK lemeng.retail_order_line v3 partitions=24") ;; *) fail=$((fail+1)); echo "  FAIL: 通过时输出不符：$out" ;; esac

# ── 不齐 ⇒ SEAL_UNEVEN 且 rc=1，且**逐条列出**差异（不能只说"不齐"）──
out=$(seal_verdict lemeng.retail_order_line 3 '{"n":24,"bad":[["a/all.parquet","COLS_DIFFERS 缺:order_total_money 多:- (24 vs 25)"],["b/all.parquet","COLS_DIFFERS 缺:order_total_money 多:- (24 vs 25)"]]}'); rc=$?
ok "$rc" "1"
case "$out" in *"SEAL_UNEVEN lemeng.retail_order_line v3 bad=2/24"*) ;; *) fail=$((fail+1)); echo "  FAIL: 未报 bad=2/24：$out" ;; esac
case "$out" in *order_total_money*) ;; *) fail=$((fail+1)); echo "  FAIL: 未列出差异原因：$out" ;; esac

# ── 探针输出坏了 ⇒ SEAL_FAILED:probe 且 rc=2（**绝不**默认为「齐」）──
out=$(seal_verdict t 1 'not json'); rc=$?
ok "$rc" "2"
case "$out" in SEAL_FAILED:probe*) ;; *) fail=$((fail+1)); echo "  FAIL: 坏输入未按依赖失败处理：$out" ;; esac

# ── 边界：只有一个分区且它是坏的 ⇒ 仍然红（0 分区由调用方在更早处拦，这里不重复）──
out=$(seal_verdict t 1 '{"n":1,"bad":[["x","READ_FAILED: 403"]]}'); rc=$?
ok "$rc" "1"

echo "seal-lake: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "seal-lake: OK"
