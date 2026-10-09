#!/bin/sh
# recon-day-heal.sh — 「定稿线对账 → 判别 → 旁路失效 → 回填 → 复验」的**闭环驱动**（§1.4.1 定稿线的失败动作）
#
# ── 它补的是哪一环 ────────────────────────────────────────────────────────────
# `diagnose.sh recon-day <D>`（**只读**）发现某定稿日对不平；本脚本负责**下一步**：
#   ① 判别「真缺口」vs「通道/身份类故障」（**后者不回填**，见下）
#   ② **旁路失效**：删掉目标营业日被 checkpoint 冻结的条目（备份先行；HEAL_BYPASS=0 可关）
#   ③ 触发该营业日的整日回填（参数化 run，**一次**，不循环）
#   ④ 等回填跑完 → **复验** recon-day
#   ⑤ 如实结论：HEAL_OK / HEAL_RECOVERED / HEAL_FAILED / HEAL_REFUSED:* / HEAL_SKIP:*
#
# ── 为什么判别是**必须**的（别把它当优化去掉）────────────────────────────────
# 回填是**生产写**（覆盖该营业日分区）。而 recon 失败有两种完全不同的来头：
#   · **真缺口**：湖确实少了（源在 T-1 冻湖之后又长过）⇒ 回填正是解药；
#   · **通道/身份类**：`cross_unavailable` / `lake` / `gateway` / `assert` ⇒ 是**我们的通道**坏了，
#     **与被采集的数据无关**。此时回填要么白跑、要么在错误状态下写生产 ⇒ **必须拒回填**。
# ⇒ 判据只认「行/批次与网关不符」为缺口；其余一律 `HEAL_REFUSED:`。
#
# ── 为什么回填前必须**旁路失效**（#528，2026-10-09 定案）──────────────────────
# window 子管线的 12 个 page 节点全 `checkpoint: true`，而 checkpoint 的 key = 节点配置指纹 + 父行，
# **不含 run_token** ⇒ 回填命中旧条目只会**重放**（不重抓）——「不平 ⇒ 回填 ⇒ 复验」对冻结缺口
# 结构性无效，这正是 10-01/04/05 四天五轮回填逐行不变的机制。⇒ 触发前先把目标营业日的冻结条目
# 删掉（备份到 `state/.backup-heal-*`），回填才会真正重抓。删除判据用**内容标记**
# `"shift_table_bizday":"<紧凑 YYYYMMDD>"`（修数实测 0 跨日误伤），不用 `at` 推断。
# `HEAL_FORCE=1`：跳过 recon 复核直入修数（**无条件**口子）；定稿线闸门**仍生效**——
# 未定稿日的源还在变，重抓抓到的仍是半截快照。
#
# ── 为什么**只回填定稿线以外的日子**（settle line）────────────────────────────
# 未定稿的日子源还在变，回填是白填（正典 §1.4.1）。默认只接 **T-3 及更早**；更新的直接拒。
#
# ── 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）──────────────────────
#   0 = 已对平（**无需动作**）或**回填后复验通过**
#   1 = 不平，且**没能自愈**（含回填后仍不平）——需要人
#   2 = 用法错 / 拒回填（定稿线未到、判别为通道类、参数脏）
#   3 = 依赖不可用（对账工具不在、console 不可达、取不到令牌）
#   可 grep 字面量：
#     通过：`HEAL_OK bizday=` / `HEAL_RECOVERED bizday=`
#     拒绝：`HEAL_REFUSED:<reason>`（not_settled | infra_failure | bad_args）
#     跳过：`HEAL_SKIP:<reason>`（no_gap）
#     失败：`HEAL_FAILED:<reason>`（trigger_failed | wait_timeout | still_a_gap）
#     旁路：`HEAL_BYPASS_DELETED deleted=N files=N backup=<dir>`（删了几条、备份在哪）
#           `HEAL_BYPASS_FAILED:<reason>`（exec | unexpected）⇒ exit 3，**不触发回填**
#     强制：`HEAL_FORCED bizday=`（跳过复核直入修数）
#     关闭：`HEAL_BYPASS_OFF bizday=`（HEAL_BYPASS=0；此态回填只会重放）
#
# 依赖 env：LEMENG_TOKEN / BRANCH_NUMS / SYSTEM_BOOK / ZOS_*（透传给 diagnose.sh；本脚本不自己读凭据）
# 可选 env：DIAGNOSE_BIN（默认 /opt/lemeng-diagnose.sh）
#           CONSOLE_CT（默认 lemeng console 容器名，用于**运行时**取令牌——不落配置）
#           CONSOLE_URL（默认 http://127.0.0.1:18080）
#           BACKFILL_PIPELINE（默认 pipelines/lemeng.retail.windows.backfill.json）
#           SETTLE_DAYS（默认 3）/ HEAL_WAIT_SECONDS（默认 900）/ HEAL_POLL_SECONDS（默认 20）
#           HEAL_DRY_RUN=1（**只判别与打印，不触发**——演练用）
#           HEAL_BYPASS=0（**关旁路**：不删冻结条目直接回填——只会重放，仅确知无冻结条目时用）
#           HEAL_FORCE=1（**跳过 recon 复核**直入修数——无条件口子；定稿线闸门仍生效）
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

DIAGNOSE_BIN=${DIAGNOSE_BIN:-/opt/lemeng-diagnose.sh}
CONSOLE_CT=${CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-3120}
CONSOLE_URL=${CONSOLE_URL:-http://127.0.0.1:18080}
BACKFILL_PIPELINE=${BACKFILL_PIPELINE:-pipelines/lemeng.retail.windows.backfill.json}
SETTLE_DAYS=${SETTLE_DAYS:-3}
HEAL_WAIT_SECONDS=${HEAL_WAIT_SECONDS:-900}
HEAL_POLL_SECONDS=${HEAL_POLL_SECONDS:-20}
HEAL_BYPASS=${HEAL_BYPASS:-1}
HEAL_FORCE=${HEAL_FORCE:-0}

usage() {
  cat >&2 <<'USAGE'
用法：sh recon-day-heal.sh [<YYYY-MM-DD>]
  不给营业日 ⇒ 取 **T-3**（正典 §1.4.1 定稿线）。
  流程：recon-day（只读）→ 不平则判别 → **旁路失效冻结条目**（备份先行）→ 回填（一次）→ 复验 → 结论。
  演练：HEAL_DRY_RUN=1（只判别与打印，不触发回填）。
  强制：HEAL_FORCE=1（跳过判别直入修数；定稿线闸门仍生效）。
  关闭：HEAL_BYPASS=0（不删冻结条目——回填只会重放，仅确知无冻结条目时用）。
退出码：0=已对平或自愈成功；1=不平且未自愈；2=用法/拒回填；3=依赖不可用。
USAGE
}

# ── 判别：把 recon-day 的输出分类为 OK / GAP / INFRA ──────────────────────────
# $1 = recon-day 的合并输出（stdout+stderr）；$2 = 其退出码
# 输出：OK | GAP | INFRA
#   INFRA 优先：只要出现通道/身份/用法类字面量，就是**我们的面**坏了，不回填。
heal_verdict() {
  _hv_out=$1; _hv_rc=$2
  if [ "$_hv_rc" -eq 0 ]; then echo OK; return 0; fi
  # 通道/身份/用法类 ⇒ 一律 INFRA（**先于**缺口判定：两类同时出现时按"我们的面坏了"处理）
  case "$_hv_out" in
    *RECON_FAILED:cross_unavailable*|*RECON_FAILED:lake*|*RECON_FAILED:gateway*|\
    *RECON_FAILED:hour*|*RECON_FAILED:cross*|*ASSERT_FAIL*|*UNKNOWN_MODE*)
      echo INFRA; return 0 ;;
  esac
  # 行/批次与网关不符 ⇒ 真缺口
  case "$_hv_out" in
    *RECON_FAILED:rows*|*RECON_FAILED:batches*|*RECON_FAILED:day*)
      echo GAP; return 0 ;;
  esac
  echo INFRA   # 认不出来的失败面，保守按"我们的面"处理（**不回填**）
}

# ── 定稿线判定：该营业日是否已过定稿线 ────────────────────────────────────────
# $1 = YYYY-MM-DD；$2 = 今天 YYYY-MM-DD；$3 = SETTLE_DAYS
# 0 = 已过线（可回填）；1 = 未过线（拒）
heal_settled() {
  _hs_day=$1; _hs_today=$2; _hs_days=$3
  _hs_cut=$(date -d "$_hs_today - ${_hs_days} days" +%F 2>/dev/null) || return 1
  # 字符串比较对 YYYY-MM-DD 成立
  [ "$_hs_day" \< "$_hs_cut" ] || [ "$_hs_day" = "$_hs_cut" ]
}

# ── 旁路失效（#528）───────────────────────────────────────────────────────────
# 删除判据 = 行内内容标记 `"shift_table_bizday":"<紧凑 YYYYMMDD>"`（flatten 产物自带，
# 修数实测 0 跨日误伤；对任意 `at` 形状稳健）。备份先行（原文件 cp 进 backup 目录）；
# 全删光时残留**空 ndjson** 是合法态（引擎视为无缓存条目 ⇒ 全量重抓）。
heal_marker() {
  printf '%s' "$1" | tr -d '-'
}

# 在容器内执行的删除片段（单引号变量，**内部禁用单引号**）。
# 调用形：docker exec … sh -c "$PRUNE_SNIPPET" sh <state根目录> <紧凑标记> <备份目录>
# 本机测试不经 docker，直接 `sh -c "$PRUNE_SNIPPET" sh <tmp夹具> …`——同一段实现两边跑，不复制。
PRUNE_SNIPPET='
root=$1; marker=$2; bdir=$3
mkdir -p "$bdir"
deleted=0; files=0
for f in "$root"/lemeng_retail_order_line_window_*/checkpoints/*.ndjson; do
  [ -f "$f" ] || continue
  files=$((files+1))
  n=$(grep -cF "\"shift_table_bizday\":\"$marker\"" "$f" 2>/dev/null) || :
  [ "${n:-0}" -gt 0 ] || continue
  cp "$f" "$bdir/$(basename "$f").$files.bak"
  grep -vF "\"shift_table_bizday\":\"$marker\"" "$f" > "$f.tmp" || :
  mv "$f.tmp" "$f"
  deleted=$((deleted+n))
done
echo "HEAL_BYPASS_DELETED deleted=$deleted files=$files backup=$bdir"
'

heal_bypass() {
  _hb_day=$1
  _hb_marker=$(heal_marker "$_hb_day")
  _hb_bdir="/workspace/state/.backup-heal-$(date -u +%Y%m%dT%H%M%SZ)"
  docker exec "$CONSOLE_CT" sh -c "$PRUNE_SNIPPET" sh /workspace/state "$_hb_marker" "$_hb_bdir"
}

# ── 触发整日回填（参数化 run，异步）────────────────────────────────────────────
# 凭据**运行时**从容器 env 现取（不落本脚本、不落 argv、不落 job 配置）
_console_token() {
  docker inspect "$CONSOLE_CT" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^DUCKLE_TOKEN=//p'
}

heal_trigger() {
  _ht_day=$1; _ht_tok=$2
  curl -s --max-time 30 -X POST "${CONSOLE_URL}/api/run/async" \
    -H "Authorization: Bearer ${_ht_tok}" -H "Content-Type: application/json" \
    -d "{\"file\":\"${BACKFILL_PIPELINE}\",\"params\":{\"BIZDAY\":\"${_ht_day}\"}}" 2>&1
}

# ── main ─────────────────────────────────────────────────────────────────────
DAY=${1:-}
if [ -z "$DAY" ]; then
  DAY=$(date -d "$(date +%F) - ${SETTLE_DAYS} days" +%F 2>/dev/null) || {
    echo "HEAL_REFUSED:bad_args 取不到默认营业日（date -d 不可用？）" >&2; exit 2; }
fi
case "$DAY" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "HEAL_REFUSED:bad_args 营业日 '${DAY}' 非 YYYY-MM-DD" >&2; exit 2 ;;
esac

TODAY=$(date +%F)
if ! heal_settled "$DAY" "$TODAY" "$SETTLE_DAYS"; then
  echo "HEAL_REFUSED:not_settled bizday=${DAY} today=${TODAY} settle_days=${SETTLE_DAYS}——未过定稿线不回填（源还在变，填了也白填；§1.4.1）" >&2
  exit 2
fi

[ -f "$DIAGNOSE_BIN" ] || { echo "HEAL_REFUSED:bad_args 对账工具不在：${DIAGNOSE_BIN}" >&2; exit 3; }

if [ "${HEAL_FORCE}" = "1" ]; then
  echo "HEAL_FORCED bizday=${DAY}——跳过 recon 复核直入修数（无条件口子）；定稿线闸门仍生效"
else
  echo "heal bizday=${DAY} settle_days=${SETTLE_DAYS}"
  _OUT=$(BIZDAY="$DAY" sh "$DIAGNOSE_BIN" recon-day "$DAY" 2>&1); _RC=$?
  printf '%s\n' "$_OUT"
  V=$(heal_verdict "$_OUT" "$_RC")
  echo "HEAL_VERDICT=${V} (recon exit=${_RC})"

  case "$V" in
    OK)
      echo "HEAL_OK bizday=${DAY}"
      exit 0 ;;
    INFRA)
      echo "HEAL_REFUSED:infra_failure bizday=${DAY}——失败面属**我们的通道/身份**（湖回读 / 免凭据通道 / 网关 / 身份），与被采数据无关 ⇒ 不回填（回填会在错误状态下写生产）" >&2
      exit 2 ;;
  esac
fi

# 到这里 = 真缺口（或 HEAL_FORCE）
if [ "${HEAL_DRY_RUN:-0}" = "1" ]; then
  echo "HEAL_SKIP:no_gap(dry_run) bizday=${DAY}——判别为真缺口；HEAL_DRY_RUN=1 故**不触发**回填"
  exit 0
fi

# ── 旁路失效（#528）：不删冻结条目，回填只会重放 ⇒ 删失败就**不触发**回填 ──────
if [ "${HEAL_BYPASS}" = "1" ]; then
  echo "HEAL_BYPASS bizday=${DAY}（先失效冻结 checkpoint 条目再回填，备份到 state/.backup-heal-*）"
  if ! _BY=$(heal_bypass "$DAY"); then
    echo "HEAL_BYPASS_FAILED:exec bizday=${DAY}（容器 ${CONSOLE_CT} 内旁路删除失败）⇒ 不触发回填（否则=白跑重放）" >&2
    exit 3
  fi
  echo "  ${_BY}"
  case "$_BY" in
    *HEAL_BYPASS_DELETED*) ;;
    *) echo "HEAL_BYPASS_FAILED:unexpected bizday=${DAY}（旁路输出缺 HEAL_BYPASS_DELETED，见上）" >&2; exit 3 ;;
  esac
else
  echo "HEAL_BYPASS_OFF bizday=${DAY}（HEAL_BYPASS=0：不删冻结条目，回填只会重放——仅确知无冻结条目时才这么用）"
fi

_TOK=$(_console_token)
[ -n "$_TOK" ] || { echo "HEAL_REFUSED:bad_args 取不到 DUCKLE_TOKEN（容器 ${CONSOLE_CT} 不在？）" >&2; exit 3; }

echo "HEAL_TRIGGERED bizday=${DAY}（参数化 run：${BACKFILL_PIPELINE}）"
_RESP=$(heal_trigger "$DAY" "$_TOK")
echo "  trigger resp: ${_RESP}"
case "$_RESP" in
  *runId*) ;;
  *) echo "HEAL_FAILED:trigger_failed bizday=${DAY}（run 端点未受理，响应见上）" >&2; exit 1 ;;
esac

# 等回填跑完（轮询运行记录，直到该次 run 不再是 running；超时即失败——**不无限等**）
_waited=0
while [ "$_waited" -lt "$HEAL_WAIT_SECONDS" ]; do
  sleep "$HEAL_POLL_SECONDS"; _waited=$((_waited + HEAL_POLL_SECONDS))
  _st=$(docker exec "$CONSOLE_CT" sh -c 'python3 -c "
import json,glob,os
fs=glob.glob(\"/workspace/runs/receipts/run-lemeng_retail_windows_backfill-*.json\")
fs.sort(key=os.path.getmtime)
print(json.load(open(fs[-1])).get(\"status\")) if fs else print(\"none\")
"' 2>/dev/null)
  echo "  wait ${_waited}s: status=${_st}"
  case "$_st" in
    ok|error|failed|finished) break ;;
  esac
done
if [ "$_waited" -ge "$HEAL_WAIT_SECONDS" ]; then
  echo "HEAL_FAILED:wait_timeout bizday=${DAY} 等了 ${_waited}s 仍未跑完" >&2; exit 1
fi

# 复验
_OUT2=$(BIZDAY="$DAY" sh "$DIAGNOSE_BIN" recon-day "$DAY" 2>&1); _RC2=$?
printf '%s\n' "$_OUT2"
V2=$(heal_verdict "$_OUT2" "$_RC2")
if [ "$V2" = "OK" ]; then
  echo "HEAL_RECOVERED bizday=${DAY}（回填后复验通过）"
  exit 0
fi
echo "HEAL_FAILED:still_a_gap bizday=${DAY}（回填后复验仍不平：${V2}）——需要人看" >&2
exit 1
