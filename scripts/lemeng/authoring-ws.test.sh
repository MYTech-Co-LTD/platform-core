#!/bin/sh
# authoring-ws.test.sh — 用假仓根（REPO_ROOT 覆盖）测 assemble/collect 双向映射，不碰真仓。
set -u
SRC=$(dirname "$0")/authoring-ws.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 $SRC"; exit 2; }
FR=$(mktemp -d); WS=$(mktemp -d); pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }
mkdir -p "$FR/deploy/duckle/console/pipelines" "$FR/deploy/duckle/console/schedules" "$FR/duckle/common"
echo A > "$FR/deploy/duckle/console/pipelines/p1.json"
echo B > "$FR/duckle/common/heavy.json"
echo S > "$FR/deploy/duckle/console/schedules/3120.json"
echo AL > "$FR/deploy/duckle/console/alerts.json"
echo OW > "$FR/deploy/duckle/console/owners.json"

# 1) assemble：文件落位且逐字节一致
out=$(REPO_ROOT="$FR" sh "$SRC" assemble 3120 "$WS/ws" 2>&1); rc=$?
ok "$rc" "0"
ok "$(cat "$WS/ws/pipelines/p1.json" 2>/dev/null)" "A"
ok "$(cat "$WS/ws/pipelines/heavy.json" 2>/dev/null)" "B"
ok "$(cat "$WS/ws/schedules.json" 2>/dev/null)" "S"

# 1b) 重管线平铺后位于 pipelines/ 根（桌面按 pipelines/<id>.json 根目录解析，不得进子目录）
[ -f "$WS/ws/pipelines/heavy.json" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: 重管线未平铺到 pipelines/ 根"; }
[ ! -e "$WS/ws/pipelines/common" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: 不应创建 pipelines/common 子目录"; }

# 2) 重复 assemble 无覆盖旗标 ⇒ 拒绝 exit 2
out=$(REPO_ROOT="$FR" sh "$SRC" assemble 3120 "$WS/ws" 2>&1; echo "rc=$?")
ok "$(printf '%s' "$out" | tail -1)" "rc=2"

# 3) 未知账套 ⇒ exit 2
out=$(REPO_ROOT="$FR" sh "$SRC" assemble 9999 "$WS/ws2" 2>&1; echo "rc=$?")
ok "$(printf '%s' "$out" | tail -1)" "rc=2"

# 4) collect：工作区改动回收 + 新文件跳过
echo B2 > "$WS/ws/pipelines/heavy.json"
echo NEW > "$WS/ws/pipelines/brand.new.json"
out=$(REPO_ROOT="$FR" sh "$SRC" collect 3120 "$WS/ws" 2>&1)
ok "$(cat "$FR/duckle/common/heavy.json")" "B2"
ok "$(cat "$FR/deploy/duckle/console/pipelines/p1.json")" "A"
case "$out" in *SKIP*brand.new.json*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 新文件未被 SKIP 点名";; esac
[ -f "$FR/deploy/duckle/console/pipelines/brand.new.json" ] && { fail=$((fail+1)); echo "  FAIL: 新文件被误收进仓"; } || pass=$((pass+1))

# 5) ASSEMBLE_OVERWRITE=1：一致文件覆盖、手改保留
echo B > "$FR/duckle/common/heavy.json"   # 重置正本（第 4 步 collect 把 B2 收进去了）
echo HAND > "$WS/ws/pipelines/p1.json"
out=$(REPO_ROOT="$FR" ASSEMBLE_OVERWRITE=1 sh "$SRC" assemble 3120 "$WS/ws" 2>&1)
ok "$(cat "$WS/ws/pipelines/p1.json")" "HAND"
case "$out" in *KEEP*p1.json*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 手改文件未点名 KEEP";; esac
ok "$(cat "$WS/ws/pipelines/heavy.json")" "B2"  # 与新正本一致 ⇒ KEEP 保持（第 4 步已收回仓）

# 6) assemble 生成桌面元数据：duckle.json jobs 数 = 正本管线数（p1 + heavy = 2）
ok "$(grep -c '"dirty":false' "$WS/ws/duckle.json")" "2"

# 7) repository.json：每条 pipeline 的 parentId 都在树里有对应 id
pids=$(sed -n 's/.*"type":"pipeline","parentId":"\([^"]*\)".*/\1/p' "$WS/ws/repository.json")
tree_ok=1; [ -n "$pids" ] || tree_ok=0
for pid in $pids; do
  grep -q "\"id\":\"${pid}\"" "$WS/ws/repository.json" || tree_ok=0
done
ok "$tree_ok" "1"

# 8) 已有元数据不被覆盖（ASSEMBLE_OVERWRITE=1 重跑也只 keep 不覆盖）
echo HANDTREE > "$WS/ws/repository.json"
echo HANDJOBS > "$WS/ws/duckle.json"
out=$(REPO_ROOT="$FR" ASSEMBLE_OVERWRITE=1 sh "$SRC" assemble 3120 "$WS/ws" 2>&1)
ok "$(cat "$WS/ws/repository.json")" "HANDTREE"
ok "$(cat "$WS/ws/duckle.json")" "HANDJOBS"
case "$out" in *keep\ metadata*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 已有元数据未点名 keep metadata";; esac

# 9) collect 不碰桌面元数据（不属于映射表）
out=$(REPO_ROOT="$FR" sh "$SRC" collect 3120 "$WS/ws" 2>&1)
ok "$(cat "$WS/ws/repository.json")" "HANDTREE"
ok "$(cat "$WS/ws/duckle.json")" "HANDJOBS"

rm -rf "$FR" "$WS"
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
