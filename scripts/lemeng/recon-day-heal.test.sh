#!/bin/sh
# recon-day-heal.test.sh — 闭环驱动（recon-day-heal.sh）的**判别逻辑**测试。
#
# 手法与 diagnose.test.sh 一致：**从脚本里抽真函数来测，不复制一份实现**——复制即漂移。
# 抽不到函数名 = 脚本结构变了 ⇒ 判红（不是跳过）。
#
# 为什么只测判别：**回填触发本身已在真机走过**（2026-10-05，参数化 run → 24 窗 → 复验），
# 而"该不该回填"这个**判别**才是本脚本唯一会**误写生产**的地方 —— 判成缺口就要动生产分区。
# ⇒ 判别必须被穷举钉住：真缺口才 GAP；只要是"我们的通道/身份"坏了就 INFRA（不回填）。
set -u
SRC=$(dirname "$0")/recon-day-heal.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 ${SRC}（工具还没落地？）"; exit 2; }

pass=0; fail=0; skip=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }

# ── 抽函数（顶层常量带不过来 ⇒ 这里显式设成与脚本一致）──
DIAGNOSE_BIN=/bin/true; CONSOLE_CT=ct; CONSOLE_URL=http://127.0.0.1:0
BACKFILL_PIPELINE=p.json; SETTLE_DAYS=3; HEAL_WAIT_SECONDS=1; HEAL_POLL_SECONDS=1
export DIAGNOSE_BIN CONSOLE_CT CONSOLE_URL BACKFILL_PIPELINE SETTLE_DAYS
_rn=0
for _fn in heal_verdict heal_settled heal_marker; do
  _fb=$(awk -v fn="$_fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1} f{print} f&&/^}$/{exit}' "$SRC")
  if [ -n "$_fb" ]; then eval "$_fb"; _rn=$((_rn+1)); else fail=$((fail+1)); echo "  FAIL: 抽不到 ${_fn}（脚本结构变了？）"; fi
done
ok "$_rn" "3"

# ── heal_verdict：真缺口 vs 通道/身份故障（**穷举判别面**）──
gap_rows='RECON bizday=2026-10-02 hour=20 lake_rows=600 lake_batches=1 gateway_rows=1353（闭窗小时，容差 0）
RECON_FAILED:rows hour=20 湖行数(600) != 网关累计(1353)，差 753（容差 0）
RECON_FAILED:day bizday=2026-10-02 hour=20 该小时未对平'
ok "$(heal_verdict "$gap_rows" 1)" "GAP"

gap_batches='RECON bizday=2026-10-02 hour=20 lake_rows=1353 lake_batches=2 gateway_rows=1353
RECON_FAILED:batches hour=20 分区内 batch_id 不止一个（count(DISTINCT)=2）
RECON_FAILED:day bizday=2026-10-02 hour=20 该小时未对平'
ok "$(heal_verdict "$gap_batches" 1)" "GAP"

infra_cross='RECON_FAILED:cross_unavailable 免凭据通道（pg_duckdb）取数失败 exit=1
RECON_FAILED:day bizday=2026-10-02 hour=03 该小时未对平'
ok "$(heal_verdict "$infra_cross" 1)" "INFRA"

infra_lake='RECON_FAILED:lake 湖回读非零退出（rb 通道）exit=1（hour=20 对象缺失/凭据/网络）
RECON_FAILED:day bizday=2026-10-02 hour=20 该小时未对平'
ok "$(heal_verdict "$infra_lake" 1)" "INFRA"

infra_gateway='RECON_FAILED:gateway 网关翻页失败 exit=1'
ok "$(heal_verdict "$infra_gateway" 1)" "INFRA"

# 两类**同时**出现 ⇒ 必须按 INFRA（宁可不动生产）——这是本判别最要紧的一条
mixed='RECON_FAILED:rows hour=20 湖行数 != 网关累计
RECON_FAILED:cross_unavailable 免凭据通道取数失败'
ok "$(heal_verdict "$mixed" 1)" "INFRA"

# 认不出来的失败面 ⇒ 保守 INFRA（不回填）
weird='RECON_FAILED:something_new hour=20'
ok "$(heal_verdict "$weird" 1)" "INFRA"

# 通过 ⇒ OK
ok "$(heal_verdict 'RECON_OK hour=20 rows=1353 batches=1
RECON_DAY_OK bizday=2026-10-02 hours=17' 0)" "OK"

# ── heal_settled：定稿线（依赖 GNU date；本机没有就跳过，不误报）──
if date -d "2026-01-11 - 3 days" +%F >/dev/null 2>&1; then
  ok "$(heal_settled 2026-01-08 2026-01-11 3 && echo yes || echo no)" "yes"   # 恰 T-3 ⇒ 过线
  ok "$(heal_settled 2026-01-09 2026-01-11 3 && echo yes || echo no)" "no"    # T-2 ⇒ 未过线
  ok "$(heal_settled 2025-12-31 2026-01-11 3 && echo yes || echo no)" "yes"   # 很久以前 ⇒ 过线
else
  skip=$((skip+3)); echo "  SKIP: 本机 date -d 不可用（GNU only），跳过 heal_settled 三例"
fi

# ── PRUNE_SNIPPET（#528 旁路失效）：抽真变量，对**本机 tmp 夹具**直接跑（不经 docker）──
# 调用形与生产侧一致：sh -c "$PRUNE_SNIPPET" sh <state根目录> <紧凑标记> <备份目录>
_q=$(printf '\047')
PS=$(awk -v q="$_q" '$0 == "PRUNE_SNIPPET=" q {f=1;next} f && $0 == q {exit} f{print}' "$SRC")
[ -n "$PS" ] || { echo "  FAIL: 抽不到 PRUNE_SNIPPET（脚本结构变了？）"; echo "recon-day-heal: pass=$pass fail=$((fail+1)) skip=$skip"; exit 1; }

_l() { printf '%s\n' "$1"; }   # ndjson 行构造（紧凑 JSON，标记在 output 行内）
_l_del_a=$(_l '{"key":"k2","at":"2026-10-02T02:11:01.000Z","output":[{"shift_table_bizday":"20261002","order_no":"B"}]}')
_l_del_b=$(_l '{"key":"k3","at":"2026-10-02T02:11:02.000Z","output":[{"shift_table_bizday":"20261002","order_no":"C"}]}')
_l_keep=$(_l '{"key":"k1","at":"2026-10-03T02:11:03.000Z","output":[{"shift_table_bizday":"20261003","order_no":"A"}]}')

_run_prune() { # $1=root $2=marker → 打印 stdout，rc 透传
  sh -c "$PS" sh "$1" "$2" "$1/.backup"
}

# 场景①：三条目删二留一 + 备份内容 == 原文件内容
_R=$(mktemp -d)
mkdir -p "$_R/lemeng_retail_order_line_window_00/checkpoints"
_F="$_R/lemeng_retail_order_line_window_00/checkpoints/p1.ndjson"
{ _l "$_l_del_a"; _l "$_l_del_b"; _l "$_l_keep"; } > "$_F"
cp "$_F" "$_R/orig.ndjson"
_out=$(_run_prune "$_R" 20261002); rc=$?
ok "$rc" "0"
ok "$(grep -c . "$_F" | tr -d ' ')" "1"
ok "$(cat "$_F")" "$_l_keep"
_bf=$(printf '%s' "$_out" | sed -n 's/.*backup=//p')
[ -n "$_bf" ] && cmp -s "$_R/orig.ndjson" "$_bf/$(basename "$_F").1.bak"
ok "$?" "0"                                       # 备份 == 原文件（可回滚的凭据）
ok "$(printf '%s' "$_out" | sed -n 's/.*deleted=\([0-9]*\).*/\1/p')" "2"
ls "$_R/lemeng_retail_order_line_window_00/checkpoints/"*.tmp >/dev/null 2>&1
ok "$?" "1"                                       # 不留 .tmp 残骸
rm -rf "$_R"

# 场景②：全部命中 ⇒ **空 ndjson 留存**（引擎视为无缓存 ⇒ 全量重抓，合法态）、rc 0
_R=$(mktemp -d)
mkdir -p "$_R/lemeng_retail_order_line_window_23/checkpoints"
_F="$_R/lemeng_retail_order_line_window_23/checkpoints/p2.ndjson"
{ _l "$_l_del_a"; _l "$_l_del_b"; } > "$_F"
_out=$(_run_prune "$_R" 20261002); rc=$?
ok "$rc" "0"
[ -f "$_F" ]; ok "$?" "0"
ok "$(wc -c < "$_F" | tr -d ' ')" "0"
ok "$(printf '%s' "$_out" | sed -n 's/.*deleted=\([0-9]*\).*/\1/p')" "2"
rm -rf "$_R"

# 场景③：无命中 ⇒ 文件**字节不变**、deleted=0
_R=$(mktemp -d)
mkdir -p "$_R/lemeng_retail_order_line_window_07/checkpoints"
_F="$_R/lemeng_retail_order_line_window_07/checkpoints/p3.ndjson"
{ _l "$_l_keep"; _l "$_l_del_a"; } > "$_F"
cp "$_F" "$_R/orig.ndjson"
_out=$(_run_prune "$_R" 20261001)
cmp -s "$_F" "$_R/orig.ndjson"; ok "$?" "0"
ok "$(printf '%s' "$_out" | sed -n 's/.*deleted=\([0-9]*\).*/\1/p')" "0"
ls "$_R"/.backup/*.bak >/dev/null 2>&1
ok "$?" "1"                                       # 无命中 ⇒ **不产生备份**（误备份=噪音；变异哨兵）
rm -rf "$_R"

# 场景④：无窗口目录 ⇒ deleted=0 files=0、rc 0（不是错误）
_R=$(mktemp -d)
_out=$(_run_prune "$_R" 20261002); rc=$?
ok "$rc" "0"
ok "$(printf '%s' "$_out" | sed -n 's/.*deleted=\([0-9]*\) files=\([0-9]*\).*/\2/p')" "0"
rm -rf "$_R"

# 场景⑤：标记构造（YYYY-MM-DD → 紧凑 YYYYMMDD）
ok "$(heal_marker 2026-10-02)" "20261002"

echo "recon-day-heal: pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ] || exit 1
echo "recon-day-heal: OK"
