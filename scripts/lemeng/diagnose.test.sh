#!/bin/sh
# diagnose.test.sh —— 只读诊断工具（diagnose.sh）的行为测试。
#
# 手法与 run-retail-day.test.sh 一致：**从脚本里抽真函数来测，不复制一份实现**——复制即漂移。
# 抽不到函数名 = 脚本结构变了 ⇒ 判红（不是跳过）。
#
# 覆盖面（对应 spec 的 E1–E8 与 P3/P5/P7）：
#   · E1 湖侧单文件精读 SQL（不带 hive_partitioning）——两通道共用同一 SQL 构造器
#   · E3/E4/E5/E6 recon 判据与字面量契约
#   · P3 「换通道复核」：pg_duckdb 免凭据通道的 SQL 包裹 + 两通道不等即判红
#   · P5 `rb` 的**护栏**（只读黑名单）与**显式行数上限**（不许静默丢行）
# 跑不了真网关/真容器的部分用假 curl / 假 docker 顶掉——测的是**判红与计数逻辑**。
set -u
SRC=$(dirname "$0")/diagnose.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 ${SRC}（工具还没落地？）"; exit 2; }

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }
has() { case "$1" in *"$2"*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 输出里没有 [$2]：$(printf '%s' "$1" | head -c 160)";; esac; }
hasnt() { case "$1" in *"$2"*) fail=$((fail+1)); echo "  FAIL: 输出里不该有 [$2]：$(printf '%s' "$1" | head -c 160)";; *) pass=$((pass+1));; esac; }

# ── 抽出被测量的函数（顶层常量在脚本里，抽函数带不过来 ⇒ 这里显式设成与脚本一致的值）──
RECON_GW_URL=http://recon.test/f
ZOS_BUCKET=recon-test-bucket
RB_MAX_ROWS=2
export RECON_GW_URL ZOS_BUCKET RB_MAX_ROWS

_rn=0
for _fn in lake_read_sql pg_duckdb_lake_sql pg_duckdb_query rb_guard rb_emit \
           recon_parse_lake_csv recon_gw_page recon_gateway_rows recon_hour_open \
           recon_cross_verdict recon_verdict; do
  _fb=$(awk -v fn="$_fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")
  if [ -n "$_fb" ]; then eval "$_fb"; _rn=$((_rn+1)); else fail=$((fail+1)); echo "  FAIL: 抽不到 ${_fn}（脚本结构变了？）"; fi
done
ok "$_rn" "11"
# 顶层常量（容量闸 / 护栏黑名单）抽函数带不过来 ⇒ **从脚本里读**（复制一份 = 测试自己漂移）。
# 读不到就判红：脚本结构变了却静默用空值，等于把守卫关掉还报绿。
RECON_PAGES=$(sed -n 's/^RECON_PAGES=\([0-9][0-9]*\).*/\1/p' "$SRC" | head -1)
RECON_PAGE_SIZE=$(sed -n 's/^RECON_PAGE_SIZE=\([0-9][0-9]*\).*/\1/p' "$SRC" | head -1)
RB_FORBIDDEN_WORDS=$(sed -n "s/^RB_FORBIDDEN_WORDS='\(.*\)'\$/\\1/p" "$SRC" | head -1)
[ -n "$RECON_PAGES" ] && [ -n "$RECON_PAGE_SIZE" ] && [ -n "$RB_FORBIDDEN_WORDS" ] \
  || { echo "  FAIL: 抽不到顶层常量 RECON_PAGES / RECON_PAGE_SIZE / RB_FORBIDDEN_WORDS"; exit 1; }
ok "$RECON_PAGE_SIZE" "200"   # 与管线 src.rest 的 page_size 同数（耦合由 check-diagnostic-tool.mjs 判）

# ── E1：湖侧 SQL 逐字钉住（单文件精读、不带 hive_partitioning——载荷列 hour 不得被分区列遮蔽）──
ok "$(lake_read_sql 2026-09-27 17 3120)" \
   "SELECT count(*) AS n_rows, count(DISTINCT batch_id) AS n_batches FROM read_parquet('s3://recon-test-bucket/lemeng/retail_order_line/system_book=3120/bizday=2026-09-27/hour=17/all.parquet');"
hasnt "$(lake_read_sql 2026-09-27 17 3120)" "hive_partitioning"

# ── P3：免凭据通道必须**包裹同一份 SQL**（换通道而不换问句——否则比的不是同一件事）──
_LS=$(lake_read_sql 2026-09-27 17 3120)
ok "$(pg_duckdb_lake_sql "$_LS")" "SELECT * FROM duckdb.query(\$\$ $_LS \$\$);"

# ── recon_parse_lake_csv：表头+数据行 → "rows batches"；噪声行跳过；比空气也算过 ⇒ 红 ──
ok "$(recon_parse_lake_csv 'n_rows,n_batches
123,1')" "123 1"
ok "$(recon_parse_lake_csv "$(printf 'zos_rb,s3\r\n42,1\r\n')")" "42 1"
recon_parse_lake_csv 'n_rows,n_batches' >/dev/null 2>&1; ok "$?" "1"
recon_parse_lake_csv 'oops' >/dev/null 2>&1; ok "$?" "1"
# psql -tA -F, 的形态（无表头）也必须被同一条解析器吃下
ok "$(recon_parse_lake_csv '8534,1')" "8534 1"

# ── recon_hour_open（墙钟可注入——纯函数，不 stub date）──
recon_hour_open 2026-09-27 23 '2026-09-28 14:05' >/dev/null; ok "$?" "1"
recon_hour_open 2026-09-28 14 '2026-09-28 14:05' >/dev/null; ok "$?" "0"
recon_hour_open 2026-09-28 13 '2026-09-28 14:05' >/dev/null; ok "$?" "1"
recon_hour_open 2026-09-28 00 '2026-09-28 00:30' >/dev/null; ok "$?" "0"

# ── recon_gateway_rows（stub recon_gw_page 控制成败——测翻页/停止/判红逻辑）──
recon_gw_page() { case "$1" in 1) echo 100;; 2) echo 50;; *) echo 0;; esac; }
ok "$(recon_gateway_rows 2026-09-27 17)" "150"
recon_gw_page() { echo 0; }
ok "$(recon_gateway_rows 2026-09-27 03)" "0"
recon_gw_page() { echo 200; }
out=$(recon_gateway_rows 2026-09-27 19 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_FAILED:gateway"
recon_gw_page() { case "$1" in 1) echo 100;; *) echo "RECON_GW_SHAPE: x" >&2; return 1;; esac; }
out=$(recon_gateway_rows 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
has "$out" "第 2 页"

# ── P3：「换通道复核」必须进判据——两通道**不相等即判红**，不可只留一条 ──
recon_cross_verdict 150 1 150 1 >/dev/null 2>&1; ok "$?" "0"
out=$(recon_cross_verdict 150 1 149 1 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_FAILED:cross"
out=$(recon_cross_verdict 150 1 150 2 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_FAILED:cross"

# ── recon_verdict：全等 ⇒ RECON_OK；rows / batches 任一破 ⇒ 各自字面量 + 非零 ──
out=$(recon_verdict 150 1 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "0"
ok "$(printf '%s' "$out" | tail -1)" "RECON_OK hour=17 rows=150 batches=1"
out=$(recon_verdict 149 1 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_FAILED:rows"
out=$(recon_verdict 150 2 150 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_FAILED:batches"

# ── recon_gw_page 的真计数逻辑（订单数 → 明细行数的单位换算）：curl 用假件顶掉 ──
_gw_real=$(awk -v fn=recon_gw_page '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")
eval "$_gw_real"
RBIN=$(mktemp -d)
cat > "$RBIN/curl" <<'EOF'
#!/bin/sh
out=''; prev=''
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
[ -n "${CURL_FIXTURE:-}" ] && cat "$CURL_FIXTURE" > "$out"
echo "${CURL_CODE:-200}"
EOF
chmod +x "$RBIN/curl"
PATH="$RBIN:$PATH"; export PATH
LEMENG_TOKEN=recon-tok; BRANCH_NUMS='[1,99]'; export LEMENG_TOKEN BRANCH_NUMS
FX=$(mktemp -d)
printf '%s' '{"result":[{"order_no":"a","pos_order_details":[{},{},{}]},{"order_no":"b","pos_order_details":[{},{}]}]}' > "$FX/p5.json"
printf '%s' '{"result":[{"order_no":"a","pos_order_details":"[{},{},{},{}]"}]}' > "$FX/pstr.json"
printf '%s' '{"result":[{"order_no":"a"},{"order_no":"b","pos_order_details":[{}]}]}' > "$FX/pmiss.json"
printf '%s' '{"result":[]}' > "$FX/pempty.json"
printf '%s' '{"error":"boom"}' > "$FX/pbad.json"
CURL_FIXTURE="$FX/p5.json"; export CURL_FIXTURE
ok "$(recon_gw_page 1 2026-09-27 17)" "5"
CURL_FIXTURE="$FX/pstr.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "4"
CURL_FIXTURE="$FX/pmiss.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "1"
CURL_FIXTURE="$FX/pempty.json"
ok "$(recon_gw_page 1 2026-09-27 17)" "0"
CURL_FIXTURE="$FX/pbad.json"
out=$(recon_gw_page 1 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
has "$out" "RECON_GW_SHAPE"
CURL_CODE=500; export CURL_CODE
out=$(recon_gw_page 1 2026-09-27 17 2>&1); rc=$?
ok "$rc" "1"
has "$out" "HTTP 500"
unset CURL_CODE

# ── P5：「rb 是只读口」这句必须被**执行**，不能只是注释——写面关键字一律拒 ──
for bad in "COPY (SELECT 1) TO 's3://x/y.parquet'" \
           "ATTACH 'x.db'" \
           "INSTALL httpfs" \
           "SET memory_limit='1GB'" \
           "CREATE TABLE t AS SELECT 1" \
           "DROP TABLE t" \
           "INSERT INTO t VALUES (1)" ; do
  rb_guard "$bad" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 写面 SQL 未被拦下：$bad"; fi
done
out=$(rb_guard "COPY (SELECT 1) TO 's3://x/y.parquet'" 2>&1); rc=$?
has "$out" "RB_REJECTED"
has "$out" "COPY"
# 正常只读 SQL 必须放行（否则护栏 = 把工具关掉）
for good in "SELECT count(*) FROM read_parquet('s3://b/x.parquet')" \
            "select hour, count(*) from read_parquet('s3://b/**/*.parquet') group by hour order by hour" \
            "SELECT * FROM read_parquet('s3://b/x.parquet') WHERE state='FINISHED'" ; do
  rb_guard "$good" >/dev/null 2>&1; ok "$?" "0"
done

# ── P5：输出行数上限必须**显式**（今天 tail -40 静默丢行，对「对账」是危险的）──
out=$(printf 'a\nb\nc\nd\n' | rb_emit 2>/dev/null); rc=$?
ok "$rc" "3"
ok "$out" "a
b"
out=$(printf 'a\nb\nc\nd\n' | rb_emit 2>&1 >/dev/null)
has "$out" "RB_TRUNCATED"
# 恰好等于上限 ⇒ 不算截断（否则「刚好 N 行」永远红）
out=$(printf 'a\nb\n' | rb_emit 2>&1); rc=$?
ok "$rc" "0"
ok "$out" "a
b"
# 空结果 ⇒ 不算截断
out=$(printf '' | rb_emit 2>&1); rc=$?
ok "$rc" "0"
ok "$out" ""

rm -rf "$RBIN" "$FX"
echo "diagnose: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "diagnose: OK"
