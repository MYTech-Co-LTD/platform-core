#!/bin/sh
# run-retail-day.test.sh —— 只测「容器内调用模式」的 shim（lemeng_compose_shim）。
#
# 为什么要测它：调度改由 duckle 自带调度器承担后，console **容器内**会以
# `LEMENG_IN_CONTAINER=1` 调本脚本；此时 `$COMPOSE` 被换成这个 shim，
# **11 处调用点一行不改**。shim 一旦认错旗标，那 11 处会一起静默少参数 ⇒ 必须钉住。
#
# 本测试**从脚本里抽出真函数**来测（不复制一份实现）——复制即漂移。
set -u
SRC=$(dirname "$0")/run-retail-day.sh
[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 2; }

# 抽出 lemeng_compose_shim 函数体（从定义行到列 0 的闭合 '}'）
FUNC=$(awk '/^lemeng_compose_shim\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SRC")
[ -n "$FUNC" ] || { echo "FAIL 抽不到 lemeng_compose_shim（脚本结构变了？）"; exit 1; }
eval "$FUNC"

# 假的 duckle / sh：把「被谁调用、带什么参数、哪些环境变量」写出来
BIN=$(mktemp -d)
cat > "$BIN/duckle" <<'EOF'
#!/bin/sh
echo "duckle argv: $*"
echo "duckle env : ${SHIM_PROBE:-<unset>}"
EOF
chmod +x "$BIN/duckle"
PATH="$BIN:$PATH"; export PATH

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }

# 1) 基本形态：参数原样透传给 duckle
out=$(lemeng_compose_shim run --rm duckle --pipeline /x.json --workspace /w 2>&1)
ok "$(printf '%s' "$out" | head -1)" "duckle argv: --pipeline /x.json --workspace /w"

# 2) -e K=V ⇒ 注入子进程环境
out=$(lemeng_compose_shim run --rm -e SHIM_PROBE=hello duckle --help 2>&1)
ok "$(printf '%s' "$out" | sed -n 2p)" "duckle env : hello"

# 3) -e K（透传形态）⇒ 不报错、不注入（容器内本就继承）
out=$(lemeng_compose_shim run --rm -e SHIM_PROBE duckle --help 2>&1; echo "rc=$?")
ok "$(printf '%s' "$out" | tail -1)" "rc=0"

# 4) --entrypoint sh ⇒ 跑 sh 而不是 duckle
out=$(lemeng_compose_shim run --rm --entrypoint sh duckle -c 'echo from-sh' 2>&1)
ok "$out" "from-sh"

# 5) --entrypoint + -e 同时
out=$(lemeng_compose_shim run --rm -e SHIM_PROBE=v --entrypoint sh duckle -c 'echo "sh env: $SHIM_PROBE"' 2>&1)
ok "$out" "sh env: v"

# 6) 不认识的旗标 ⇒ 判红（exit 2），不许静默吞
out=$(lemeng_compose_shim run --rm --cap-add=SYS_ADMIN duckle x 2>&1; echo "rc=$?")
ok "$(printf '%s' "$out" | tail -1)" "rc=2"
case "$out" in *SHIM_UNSUPPORTED*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 未输出 SHIM_UNSUPPORTED";; esac

# 7) 非 run 子命令 ⇒ 判红
out=$(lemeng_compose_shim logs duckle 2>&1; echo "rc=$?")
ok "$(printf '%s' "$out" | tail -1)" "rc=2"

rm -rf "$BIN"
echo "compose-shim: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "compose-shim: OK"
