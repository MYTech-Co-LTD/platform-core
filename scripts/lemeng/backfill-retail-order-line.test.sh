#!/bin/sh
# backfill-retail-order-line.test.sh — 回填驱动脚本的**行为测试**（纯逻辑面；端到端面在 backfill-lab.sh）。
#
# 手法与 diagnose.test.sh 一致：**从脚本里抽真函数来测，不复制一份实现**——复制即漂移。
# 抽不到函数名 = 脚本结构变了 ⇒ 判红（不是跳过）。
#
# 覆盖：① 批次表逐字（spec §4 Phase 1）② Phase 0 判据字面量 ③ 顺序闸的三种判决与 --force
#       ④ 批后判据（列数 / 整湖混读）的正反例 ⑤ 湖侧 SQL 的形态（别用 union_by_name、别丢 `r['…']`）
#       ⑥ 读数解析的抗噪（psql NOTICE / 表头 / 空输出）⑦ 反引号陷阱（双引号里的 `plan` 会被当命令跑）
# 不覆盖：真湖读（duckdb/s3）——那在 backfill-lab.sh 里用回环 S3 造真湖跑。
set -u
SRC=$(dirname "$0")/backfill-retail-order-line.sh
[ -f "${SRC}" ] || { echo "FAIL 找不到 ${SRC}（脚本还没落地？）"; exit 2; }

pass=0; fail=0
ok()   { if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }
has()  { case "$1" in *"$2"*) pass=$((pass + 1));; *) fail=$((fail + 1)); echo "  FAIL: 输出里没有 [$2]：$(printf '%s' "$1" | head -c 200)";; esac; }
hasnt(){ case "$1" in *"$2"*) fail=$((fail + 1)); echo "  FAIL: 输出里不该有 [$2]：$(printf '%s' "$1" | head -c 200)";; *) pass=$((pass + 1));; esac; }

# ── 抽出被测量的函数（顶层常量抽函数带不过来 ⇒ 从脚本里读，读不到就判红）──────────
_rn=0
for _fn in batch_plan batch_count batch_line batch_day batch_books \
           lake_root part_path lake_glob probe_sql batch_schema_sql whole_lake_sql \
           parse_int probe_verdict batch_schema_verdict whole_lake_verdict \
           order_guard console_url batch_state first_pending_batch; do
  _fb=$(awk -v fn="$_fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "${SRC}")
  if [ -n "${_fb}" ]; then eval "${_fb}"; _rn=$((_rn + 1)); else fail=$((fail + 1)); echo "  FAIL: 抽不到 ${_fn}（脚本结构变了？）"; fi
done
ok "${_rn}" "19"

# 顶层常量：**从脚本里读**（复制一份 = 测试自己漂移）；读不到就判红（结构变了却静默用空值 = 把守卫关掉还报绿）
PROBE_EXPECT=$(sed -n 's/^PROBE_EXPECT=\([0-9][0-9]*\).*/\1/p' "${SRC}" | head -1)
UNIFORM_EXPECT=$(sed -n 's/^UNIFORM_EXPECT=\([0-9][0-9]*\).*/\1/p' "${SRC}" | head -1)
OLDEST_DAY=$(sed -n 's/^OLDEST_DAY=\${OLDEST_DAY:-\([0-9-]*\)}.*/\1/p' "${SRC}" | head -1)
OLDEST_BOOK=$(sed -n 's/^OLDEST_BOOK=\${OLDEST_BOOK:-\([0-9]*\)}.*/\1/p' "${SRC}" | head -1)
OLDEST_HOUR=$(sed -n 's/^OLDEST_HOUR=\${OLDEST_HOUR:-\([0-9]*\)}.*/\1/p' "${SRC}" | head -1)
FIRST_HOUR=$(sed -n 's/^FIRST_HOUR=\([0-9][0-9]*\).*/\1/p' "${SRC}" | head -1)
LAST_HOUR=$(sed -n 's/^LAST_HOUR=\([0-9][0-9]*\).*/\1/p' "${SRC}" | head -1)
for _c in PROBE_EXPECT UNIFORM_EXPECT OLDEST_DAY OLDEST_BOOK OLDEST_HOUR FIRST_HOUR LAST_HOUR; do
  eval "_v=\${$_c}"
  [ -n "${_v}" ] || { echo "  FAIL: 抽不到顶层常量 ${_c}"; exit 1; }
done
# spec §4 Phase 0「唯一判据：探针行数 = 19」与 §4 Phase 1「批后 parquet_schema 行数 = 25」逐字钉住
ok "${PROBE_EXPECT}" "19"
ok "${UNIFORM_EXPECT}" "25"
ok "${OLDEST_DAY}" "2026-09-23"
ok "${OLDEST_BOOK}" "3120"
ok "${OLDEST_HOUR}" "00"
ok "${FIRST_HOUR}" "00"
ok "${LAST_HOUR}" "23"
HOURS=$(sed -n 's/^HOURS=\(.*\)$/\1/p' "${SRC}" | head -1 | tr -d "'")

# ── ① 批次表逐字（spec §4 Phase 1 的五批）─────────────────────────────────────
ok "$(batch_count)" "5"
ok "$(batch_plan | tr '\n' '|')" "1 2026-09-27 3120 64188|2 2026-09-26 3120 64188|3 2026-09-25 3120 64188|4 2026-09-24 3120|5 2026-09-23 3120|"
ok "$(batch_day 1)" "2026-09-27"
ok "$(batch_day 5)" "2026-09-23"                      # 最老的最后
ok "$(batch_books 1 | tr '\n' ',')" "3120,64188,"      # 两账套同日成批
ok "$(batch_books 2 | tr '\n' ',')" "3120,64188,"
ok "$(batch_books 3 | tr '\n' ',')" "3120,64188,"
ok "$(batch_books 4 | tr '\n' ',')" "3120,"
ok "$(batch_books 5 | tr '\n' ',')" "3120,"
batch_line 9 >/dev/null 2>&1; ok "$?" "1"             # 越界批号 ⇒ 非零（下游据此用法错）
ok "$(batch_line 3)" "3 2026-09-25 3120 64188"

# ── ② 湖侧 SQL 的形态（判据本体：改形态 = 改判据）─────────────────────────────
LAKE_ROOT='s3://bkt/lemeng/retail_order_line'
export LAKE_ROOT
ok "$(probe_sql 3120 2026-09-23 00)" \
   "SELECT count(*) AS schema_rows FROM parquet_schema('s3://bkt/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet')"
hasnt "$(probe_sql 3120 2026-09-23 00)" ";"            # 尾分号会污染 duckdb.query($$ … $$)
ok "$(part_path 3120 2026-09-23 00)" "s3://bkt/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet"
WLS=$(whole_lake_sql)
has "${WLS}" "count(r['order_no']) AS orders"          # 门禁规则① 的形态：留 r['列名']
has "${WLS}" "min(r['bizday']::date) AS mind"
has "${WLS}" "read_parquet('s3://bkt/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet')"
hasnt "${WLS}" "union_by_name"                         # spec §3：B 方案的前提是**不启用**它
hasnt "${WLS}" "hive_partitioning"
BS=$(batch_schema_sql 2026-09-27 3120 64188)
ok "$(printf '%s' "${BS}" | grep -o "hour=00' AS part" | wc -l | tr -d ' ')" "2"   # 两账套各一个 hour=00
ok "$(printf '%s' "${BS}" | grep -o "UNION ALL" | wc -l | tr -d ' ')" "47"          # 2×24 个分区 ⇒ 47 个 UNION
ok "$(printf '%s' "${BS}" | grep -o "parquet_schema(" | wc -l | tr -d ' ')" "48"
hasnt "${BS}" ";"
unset LAKE_ROOT
ZOS_BUCKET=bkt; export ZOS_BUCKET
ok "$(lake_root)" "s3://bkt/lemeng/retail_order_line"
ok "$(part_path 3120 2026-09-23 00)" "s3://bkt/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet"
unset ZOS_BUCKET

# ── ③ 读数解析的抗噪（psql 的 NOTICE / 表头 / 空输出）──────────────────────────
ok "$(printf 'NOTICE:  hello\n42\n' | parse_int)" "42"
ok "$(printf '  7  \n' | parse_int)" "7"
printf '' | parse_int >/dev/null 2>&1; ok "$?" "1"
printf 'schema_rows\nNOTICE\n' | parse_int >/dev/null 2>&1; ok "$?" "1"

# ── ④ Phase 0 判据：19 放行 / 非 19 拒绝（fail-closed）────────────────────────
out=$(probe_verdict 19 2>&1); ok "$?" "0"
has "${out}" "PHASE0_GUARD=PASS"
for _v in 25 18 20 1 0; do
  out=$(probe_verdict "${_v}" 2>&1); ok "$?" "1"
  has "${out}" "BACKFILL_REFUSED:phase0"
done
has "$(probe_verdict 25 2>&1)" "唯一救援 = 切方案 A"     # 处置必须指向 spec §3.2 的救援路径
hasnt "$(probe_verdict 25 2>&1)" "command not found"

# ── ⑤ 批后判据：列数 ───────────────────────────────────────────────────────────
printf 'a/hour=00,25\na/hour=01,25\n' | batch_schema_verdict 2 >/dev/null 2>&1; ok "$?" "0"
has "$(printf 'a/hour=00,25\na/hour=01,25\n' | batch_schema_verdict 2)" "BATCH_SCHEMA_OK:"
out=$(printf 'a/hour=00,25\na/hour=01,19\n' | batch_schema_verdict 2 2>&1); ok "$?" "1"
has "${out}" "BACKFILL_FAILED:batch_schema"
out=$(printf 'a/hour=00,25\n' | batch_schema_verdict 3 2>&1); ok "$?" "1"     # 读数不齐 ⇒ 也不通过
has "${out}" "读数不齐"
# NOTICE 行必须被跳过、不能算进 seen
printf 'NOTICE: noise\na/hour=00,25\n' | batch_schema_verdict 1 >/dev/null 2>&1; ok "$?" "0"

# ── ⑥ 批后判据：整湖混读（orders = n 且 mind = 最老 bizday）────────────────────
printf '135917,135917,2026-09-23,2026-09-30\n' | whole_lake_verdict 2026-09-23 >/dev/null 2>&1; ok "$?" "0"
has "$(printf '135917,135917,2026-09-23,2026-09-30\n' | whole_lake_verdict 2026-09-23)" "WHOLE_LAKE_OK:"
out=$(printf '135917,135000,2026-09-23,2026-09-30\n' | whole_lake_verdict 2026-09-23 2>&1); ok "$?" "1"
has "${out}" "orders != n"
out=$(printf '135917,135917,2026-09-24,2026-09-30\n' | whole_lake_verdict 2026-09-23 2>&1); ok "$?" "1"
has "${out}" "mind = 2026-09-24"
printf '0,0,2026-09-23,2026-09-30\n' | whole_lake_verdict 2026-09-23 >/dev/null 2>&1; ok "$?" "1"
out=$(printf '' | whole_lake_verdict 2026-09-23 2>&1); ok "$?" "1"           # 空读数 = 判据不成立，**不通过**
has "${out}" "读数缺失"
hasnt "$(printf '135917,135917,2026-09-23,2026-09-30\n' | whole_lake_verdict 2026-09-23)" "BACKFILL_FAILED"

# ── ⑦ 顺序闸：三种判决 + --force ──────────────────────────────────────────────
order_guard 1 1 0 >/dev/null 2>&1; ok "$?" "0"                               # 正是下一批 ⇒ 放行
order_guard 5 1 0 >/dev/null 2>&1; ok "$?" "1"                               # 跳批 ⇒ 拒
has "$(order_guard 5 1 0 2>&1)" "BACKFILL_REFUSED:out_of_order"
has "$(order_guard 5 1 0 2>&1)" "跳批被拒"
hasnt "$(order_guard 5 1 0 2>&1)" "command not found"
order_guard 2 1 0 >/dev/null 2>&1; ok "$?" "1"
order_guard 2 5 0 >/dev/null 2>&1; ok "$?" "1"                               # 回头补已完成批 ⇒ 拒
has "$(order_guard 2 5 0 2>&1)" "已完成"
order_guard 2 5 1 >/dev/null 2>&1; ok "$?" "0"                               # --force ⇒ 放行
order_guard 1 0 0 >/dev/null 2>&1; ok "$?" "1"                               # 全完成 ⇒ 拒
has "$(order_guard 1 0 0 2>&1)" "回填已完成"
order_guard 1 0 1 >/dev/null 2>&1; ok "$?" "0"                               # --force ⇒ 放行
# 反引号陷阱：脚本正文（非注释）里一个反引号都不许有 —— 双引号里的 `plan` 会被 sh 当命令替换跑掉
# （2026-09-30 实测咬过一次：判红消息里混进「plan: command not found」）。
BT=$(printf '\140')
ok "$(grep -n "${BT}" "${SRC}" | grep -vc ':[[:space:]]*#')" "0"

# ── ⑧ console 路由（一账套一 console）──────────────────────────────────────────
CONSOLE_3120_URL=http://127.0.0.1:18080
CONSOLE_64188_URL=http://127.0.0.1:18081
export CONSOLE_3120_URL CONSOLE_64188_URL
ok "$(console_url 3120)" "http://127.0.0.1:18080"
ok "$(console_url 64188)" "http://127.0.0.1:18081"
console_url 9999 >/dev/null 2>&1; ok "$?" "1"

# ── ⑨ batch_state / first_pending_batch（stub 掉湖读数，只测判决）──────────────
# 每批探测 2 个 book × 2 个 hour；用一个常量控制返回 19 / 25 / 混合
lake_probe_rows() { printf '%s\n' "${STUB_ROWS}"; }
STUB_ROWS=19; ok "$(batch_state 1)" "pending"
STUB_ROWS=25; ok "$(batch_state 1)" "done"
STUB_ROWS=20; ok "$(batch_state 1)" "partial"
lake_probe_rows() { return 2; }                # 通道失败 ⇒ unknown（fail-closed，不能当 done）
ok "$(batch_state 1)" "unknown"
batch_state() { case "$1" in 1) echo done;; 2) echo pending;; *) echo done;; esac; }
ok "$(first_pending_batch)" "2"
batch_state() { echo done; }
ok "$(first_pending_batch)" "0"

# ── ⑩ 回填管线的 bizday 闭窗守卫（#528）───────────────────────────────────────
# 守卫是数据面**管线 JSON**（wc/dw 节点 + 三段边），shell 工具链看不见它 ⇒ 在这里结构钉住：
# 有人删守卫节点/改直连边，回填就回到「能窗内点火」的旧世界（10-05 事故面），而这个回退
# 没有任何运行时信号。SQL 谓词语义由 validate_pipeline 编译 + 真机验收兜底，这里只钉锚点。
PJ=$(dirname "$0")/../../deploy/duckle/console/pipelines
_guard_check() { python3 - "$PJ" <<'PY'
import json, os, sys
base = sys.argv[1]
p = json.load(open(os.path.join(base, 'lemeng.retail.windows.backfill.json')))
nodes = {n['id']: n for n in p['nodes']}
edges = {(e['source'], e['target']) for e in p['edges']}
def die(msg):
    print(msg); sys.exit(1)
wc = nodes.get('wc')
if wc is None: die('wc 节点缺席（#528 闭窗守卫被删？）')
sql = wc.get('data', {}).get('properties', {}).get('sql', '')
for anchor in ('WINDOW_OPEN', '${BIZDAY}', 'Asia/Shanghai', 'INTERVAL 1 DAY'):
    if anchor not in sql:
        die('wc 的 SQL 缺锚点 ' + anchor + '（守卫谓词漂移）')
dw = nodes.get('dw')
if dw is None: die('dw 节点缺席（#528 闭窗守卫被删？）')
dwp = dw.get('data', {}).get('properties', {})
if dwp.get('condition') != 'has-rows': die('dw 必须 condition=has-rows')
if 'WINDOW_OPEN' not in dwp.get('message', ''): die('dw message 缺 WINDOW_OPEN（真机验收靠它 grep）')
for pair in (('dv', 'wc'), ('wc', 'dw'), ('dw', 'w0')):
    if pair not in edges: die('边 %s→%s 缺席（守卫链断了）' % pair)
if ('dv', 'w0') in edges: die('旧直连边 dv→w0 还在（守卫被旁路 = 没修）')
for f in ('lemeng.retail.windows.l1.json', 'lemeng.retail.close.l1.json'):
    q = json.load(open(os.path.join(base, f)))
    if 'WINDOW_OPEN' in json.dumps(q, ensure_ascii=False):
        die(f + ' 不该有 WINDOW_OPEN 守卫（排班形 bizday 由 now 推导，恒真 = 死代码）')
sys.exit(0)
PY
}
_gout=$(_guard_check); _grc=$?
ok "$_grc" "0"
[ "$_grc" -eq 0 ] || echo "  FAIL: 回填管线守卫结构：${_gout}"

echo "── backfill-retail-order-line.test.sh: PASS=${pass} FAIL=${fail} ──"
[ "${fail}" -eq 0 ] || exit 1
