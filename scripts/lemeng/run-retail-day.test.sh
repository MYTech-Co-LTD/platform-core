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

# ── 失败告警（notify_fail + EXIT trap）─────────────────────────────────────────
# 用**真脚本**跑一个必然失败的模式（未知模式 ⇒ exit 2，无副作用），配一个假的企微端点收请求。
FAKE=$(mktemp -d)
PORT=$(( (RANDOM % 20000) + 20000 ))
python3 -c "
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        open('$FAKE/hit','a').write(self.rfile.read(n).decode('utf-8','replace')+'\n')
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(b'{\"errcode\":0,\"errmsg\":\"ok\"}')
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',$PORT),H).serve_forever()
" & SRV=$!
sleep 1

# A) 没设 LEMENG_NOTIFY ⇒ **不该**发告警（人工/诊断跑失败不刷群）
rm -f "$FAKE/hit"
sh "$SRC" nosuchmode >/dev/null 2>&1; rc=$?
ok "$rc" "2"                                   # 退出码原样
[ -f "$FAKE/hit" ] && { fail=$((fail+1)); echo "  FAIL: 未设 LEMENG_NOTIFY 却发了告警"; } || pass=$((pass+1))

# B) 设了 LEMENG_NOTIFY=1 ⇒ **该**发，且退出码仍是 2（trap 不改判红）
rm -f "$FAKE/hit"
LEMENG_NOTIFY=1 WECOM_WEBHOOK_URL="http://127.0.0.1:$PORT/send" SYSTEM_BOOK=3120 DIM_FACE=branch \
  sh "$SRC" nosuchmode >/dev/null 2>&1; rc=$?
ok "$rc" "2"
if [ -f "$FAKE/hit" ]; then
  pass=$((pass+1))
  # 容忍 JSON 里的空白（json.dumps 默认带空格）——用 grep -E 而不是字面量匹配
  if grep -qE '"msgtype"[[:space:]]*:[[:space:]]*"text"' "$FAKE/hit" && grep -q '乐檬采集失败' "$FAKE/hit"; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "  FAIL: 告警体形状不对: $(head -c 100 "$FAKE/hit")"
  fi
else
  fail=$((fail+1)); echo "  FAIL: 设了 LEMENG_NOTIFY=1 却**没**发告警"
fi

# C) 设了 NOTIFY 但缺 WECOM_WEBHOOK_URL ⇒ 明确报「没发出去」，不静默
out=$(LEMENG_NOTIFY=1 sh "$SRC" nosuchmode 2>&1 >/dev/null); rc=$?
ok "$rc" "2"
case "$out" in *NOTIFY_SKIPPED*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 缺 URL 时应打 NOTIFY_SKIPPED";; esac

kill "$SRV" 2>/dev/null; rm -rf "$FAKE"
echo "compose-shim+notify: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "compose-shim: OK"
