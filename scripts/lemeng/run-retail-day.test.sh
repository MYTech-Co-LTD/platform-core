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

# ── 失败窗重试（collect_windows / retry_failed_windows，2026-09-26 新增）──────────
# 抽**真函数**测；把 `run_one_window`（唯一调用点）换成 stub 来控制每窗成败——不复制实现。
COLLECT=$(awk '/^collect_windows\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SRC")
RETRY=$(awk '/^retry_failed_windows\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SRC")
if [ -n "$COLLECT" ] && [ -n "$RETRY" ]; then pass=$((pass+1)); else
  fail=$((fail+1)); echo "  FAIL: 抽不到 collect_windows / retry_failed_windows（脚本结构变了？）"
fi
WINDOWS_MAX_CONSEC=99; WINDOWS_RETRY_ATTEMPTS=2; WINDOWS_RETRY_BACKOFF=0
eval "$COLLECT"; eval "$RETRY"

CNT=$(mktemp); OUT=$(mktemp)
FAILSET=""
# stub：在 FAILSET 里的 hour 返回非零；同时数调用次数（写文件，跨子 shell 也不丢）
run_one_window() { echo "$1" >> "$CNT"; case " $FAILSET " in *" $1 "*) return 1;; *) return 0;; esac; }

# D) 全成功 ⇒ w_failed 为空，且不重试
: > "$CNT"; w_failed=""; collect_windows "01 02 03"
ok "$w_failed" ""
ok "$(wc -l < "$CNT" | tr -d ' ')" "3"

# E) 首轮 2 窗失败 ⇒ 只重试这些窗，且补齐后清空 w_failed、打 WINDOWS_RETRY_OK
FAILSET="02 03"; : > "$CNT"; w_failed=""; collect_windows "01 02 03"
ok "$w_failed" " 02 03"
ok "$(wc -l < "$CNT" | tr -d ' ')" "3"
FAILSET=""            # 次轮网关恢复
retry_failed_windows > "$OUT" 2>&1; rc=$?
ok "$rc" "0"
ok "$w_failed" ""
ok "$(wc -l < "$CNT" | tr -d ' ')" "5"          # 3 首轮 + 2 重试（只重试失败的，不整轮重跑）
grep -q 'WINDOWS_RETRY attempt=1/2 hours:02 03' "$OUT" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: 重试批次该只含失败窗并带 attempt 标记：$(head -c 120 "$OUT")"; }
grep -q 'WINDOWS_RETRY_OK' "$OUT" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: 补齐后应打 WINDOWS_RETRY_OK"; }

# F) 一直失败 ⇒ **有界**（不无限重试）+ WINDOWS_RETRY_FAILED + 返回 1
FAILSET="07"; : > "$CNT"; w_failed=""; collect_windows "07"
retry_failed_windows > "$OUT" 2>&1; rc=$?
ok "$rc" "1"
ok "$w_failed" " 07"
ok "$(wc -l < "$CNT" | tr -d ' ')" "3"          # 1 首轮 + 2 重试批次（ATTEMPTS=2）⇒ 恰好 3 次，不多
grep -q 'WINDOWS_RETRY_FAILED' "$OUT" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: 仍失败应打 WINDOWS_RETRY_FAILED"; }

# G) ATTEMPTS=0 ⇒ 整关（一次都不重试）
WINDOWS_RETRY_ATTEMPTS=0; FAILSET="08"; : > "$CNT"; w_failed=" 08"
retry_failed_windows > "$OUT" 2>&1; rc=$?
ok "$rc" "1"
ok "$(wc -l < "$CNT" | tr -d ' ')" "0"
WINDOWS_RETRY_ATTEMPTS=2
rm -f "$CNT" "$OUT"

# ── tick_windows（tick 模式的窗口推导：当日增量 + 闭窗尾款；#260）──────────────────
# 抽**真函数**测（同上：不复制实现）。传参 = 模拟的 CST 墙钟 "YYYY-MM-DD HH:MM"——
# 纯函数不依赖墙钟，这正是它可测的原因（stub date 反而把测试绑死在 date 的实现上）。
FUNC2=$(awk '/^tick_windows\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SRC")
if [ -n "$FUNC2" ]; then eval "$FUNC2"; pass=$((pass+1)); else
  fail=$((fail+1)); echo "  FAIL: 抽不到 tick_windows（脚本结构变了？）"
fi
# 用例（传参 = 模拟的 CST 墙钟 "YYYY-MM-DD HH:MM"）：
ok "$(tick_windows '2026-09-27 19:35' '')"   '2026-09-27,19 2026-09-27,18'   # 普通下午 tick
ok "$(tick_windows '2026-09-27 08:00' '')"   '2026-09-27,08 2026-09-27,07'   # 开市首 tick
ok "$(tick_windows '2026-09-27 23:55' '')"   '2026-09-27,23 2026-09-27,22'   # 末班 tick
ok "$(tick_windows '2026-09-28 00:00' close)" '2026-09-27,23'                # 闭窗：昨日 23 点档（bizday 跨日）
ok "$(tick_windows '2026-10-01 00:00' close)" '2026-09-30,23'                # 跨月

# ── recon（tick 对账，#260：湖分区 vs 网关当刻累计，闭窗小时容差 0）──────────────────
# 抽**真函数**测（同上：不复制实现）。RECON_PAGES / RECON_GW_URL / ZOS_BUCKET 是脚本顶层
# 常量/env，抽函数带不过来 ⇒ 这里显式设成与脚本一致的值（脚本改值时此处要跟着改）。
# 跑不了真网关的部分（recon_gw_page 真打网关）用假 curl 顶掉——测的是**计数与判红逻辑**。
RECON_PAGES=12
RECON_GW_URL=http://recon.test/f
ZOS_BUCKET=recon-test-bucket
export RECON_PAGES RECON_GW_URL ZOS_BUCKET
_rn=0
for _fn in recon_lake_sql recon_parse_lake_csv recon_gw_page recon_gateway_rows recon_hour_open recon_verdict; do
  _fb=$(awk -v fn="$_fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")
  if [ -n "$_fb" ]; then eval "$_fb"; _rn=$((_rn+1)); else fail=$((fail+1)); echo "  FAIL: 抽不到 ${_fn}（脚本结构变了？）"; fi
done
ok "$_rn" "6"
# 留一份**真** recon_gw_page 函数体：N 段会用 stub 顶掉它做翻页逻辑测试，P 段要还原回来测真计数逻辑
_gw_real=$(awk -v fn=recon_gw_page '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")

# H) recon_lake_sql：SQL 逐字钉住（单文件精读、不带 hive_partitioning——载荷列 hour 不得被分区列遮蔽）
ok "$(recon_lake_sql 2026-09-27 17 3120)" \
   "SELECT count(*) AS n_rows, count(DISTINCT batch_id) AS n_batches FROM read_parquet('s3://recon-test-bucket/lemeng/retail_order_line/system_book=3120/bizday=2026-09-27/hour=17/all.parquet');"

# I) recon_parse_lake_csv：表头+数据行 → "rows batches"
ok "$(recon_parse_lake_csv 'n_rows,n_batches
123,1')" "123 1"

# J) 噪声行（非数值字段跳过）+ CRLF
ok "$(recon_parse_lake_csv "$(printf 'zos_rb,s3\r\n42,1\r\n')")" "42 1"

# K) 只有表头（duckdb 没吐数据行）⇒ 非零：比空气也算过 = 红
recon_parse_lake_csv 'n_rows,n_batches' >/dev/null 2>&1; ok "$?" "1"

# L) 纯垃圾 ⇒ 非零
recon_parse_lake_csv 'oops' >/dev/null 2>&1; ok "$?" "1"

# M) recon_hour_open（墙钟可注入——同 tick_windows 的纯函数手法）
recon_hour_open 2026-09-27 23 '2026-09-28 14:05' >/dev/null; ok "$?" "1"   # bizday 非今天 ⇒ 全天已闭
recon_hour_open 2026-09-28 14 '2026-09-28 14:05' >/dev/null; ok "$?" "0"   # 当前小时未闭窗
recon_hour_open 2026-09-28 13 '2026-09-28 14:05' >/dev/null; ok "$?" "1"   # 整点已过 ⇒ 已闭
recon_hour_open 2026-09-28 00 '2026-09-28 00:30' >/dev/null; ok "$?" "0"   # 00 档在 01 点前未闭

# N) recon_gateway_rows（stub recon_gw_page 控制成败——测翻页/停止/判红逻辑，不测网关本身）
recon_gw_page() { case "$1" in 1) echo 100;; 2) echo 50;; *) echo 0;; esac; }
ok "$(recon_gateway_rows 2026-09-27 17)" "150"          # 翻到第 3 页空页止
recon_gw_page() { echo 0; }
ok "$(recon_gateway_rows 2026-09-27 03)" "0"            # 首页即空（两边 0 行 = 全等）
recon_gw_page() { echo 200; }
out=$(recon_gateway_rows 2026-09-27 19 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *RECON_FAILED:gateway*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 末页仍满应打 RECON_FAILED:gateway";; esac
recon_gw_page() { case "$1" in 1) echo 100;; *) echo "RECON_GW_SHAPE: x" >&2; return 1;; esac; }
out=$(recon_gateway_rows 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *"第 2 页"*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 中途取页失败应点名页号：$(printf '%s' "$out" | head -c 120)";; esac

# O) recon_verdict：全等 ⇒ RECON_OK；rows / batches 任一破 ⇒ 各自字面量 + 非零
out=$(recon_verdict 150 1 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "0"
ok "$(printf '%s' "$out" | tail -1)" "RECON_OK hour=17 rows=150 batches=1"
out=$(recon_verdict 149 1 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *RECON_FAILED:rows*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 行数不等应打 RECON_FAILED:rows";; esac
out=$(recon_verdict 150 2 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *RECON_FAILED:batches*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: batch 不止一个应打 RECON_FAILED:batches";; esac
out=$(recon_verdict 149 2 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
if printf '%s' "$out" | grep -q 'RECON_FAILED:rows' && printf '%s' "$out" | grep -q 'RECON_FAILED:batches'; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 两条判据都破应两条都打"; fi

# P) recon_gw_page 的真计数逻辑（订单数 → 明细行数的单位换算）：curl 用假件顶掉
eval "$_gw_real"   # 还原真函数体（N 段的 stub 已完成使命）
RBIN2=$(mktemp -d)
cat > "$RBIN2/curl" <<'EOF'
#!/bin/sh
out=''; prev=''
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
[ -n "${CURL_FIXTURE:-}" ] && cat "$CURL_FIXTURE" > "$out"
echo "${CURL_CODE:-200}"
EOF
chmod +x "$RBIN2/curl"
PATH="$RBIN2:$PATH"; export PATH
LEMENG_TOKEN=recon-tok; BRANCH_NUMS='[1,99]'; export LEMENG_TOKEN BRANCH_NUMS
FX=$(mktemp -d)
printf '%s' '{"result":[{"order_no":"a","pos_order_details":[{},{},{}]},{"order_no":"b","pos_order_details":[{},{}]}]}' > "$FX/p5.json"
printf '%s' '{"result":[{"order_no":"a","pos_order_details":"[{},{},{},{}]"}]}' > "$FX/pstr.json"
printf '%s' '{"result":[{"order_no":"a"},{"order_no":"b","pos_order_details":[{}]}]}' > "$FX/pmiss.json"
printf '%s' '{"result":[]}' > "$FX/pempty.json"
printf '%s' '{"error":"boom"}' > "$FX/pbad.json"
CURL_FIXTURE="$FX/p5.json"; export CURL_FIXTURE
ok "$(recon_gw_page 1 2026-09-27 17)" "5"                    # 3+2 条明细
CURL_FIXTURE="$FX/pstr.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "4"                    # JSON 字符串形态也按明细条数
CURL_FIXTURE="$FX/pmiss.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "1"                    # 缺明细字段贡献 0 行
CURL_FIXTURE="$FX/pempty.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "0"                    # 空页 = 翻尽信号
CURL_FIXTURE="$FX/pbad.json"
out=$(recon_gw_page 1 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *RECON_GW_SHAPE*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 形状不对应打 RECON_GW_SHAPE";; esac
CURL_CODE=500; export CURL_CODE
out=$(recon_gw_page 1 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
case "$out" in *"HTTP 500"*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: HTTP 非 200 应点名状态码";; esac
unset CURL_CODE
rm -rf "$RBIN2" "$FX"

kill "$SRV" 2>/dev/null; rm -rf "$FAKE"
echo "compose-shim+notify+retry+tick+recon: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "compose-shim: OK"
