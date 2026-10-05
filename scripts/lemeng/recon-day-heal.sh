#!/bin/sh
# recon-day-heal.sh — 「定稿线对账 → 不平即回填 → 复验」的**闭环驱动**（§1.4.1 定稿线的失败动作）
#
# ── 它补的是哪一环 ────────────────────────────────────────────────────────────
# `diagnose.sh recon-day <D>`（**只读**）发现某定稿日对不平；本脚本负责**下一步**：
#   ① 判别「真缺口」vs「通道/身份类故障」（**后者不回填**，见下）
#   ② 触发该营业日的整日回填（参数化 run，**一次**，不循环）
#   ③ 等回填跑完 → **复验** recon-day
#   ④ 如实结论：HEAL_OK / HEAL_RECOVERED / HEAL_FAILED / HEAL_REFUSED:* / HEAL_SKIP:*
#
# ── 为什么判别是**必须**的（别把它当优化去掉）────────────────────────────────
# 回填是**生产写**（覆盖该营业日分区）。而 recon 失败有两种完全不同的来头：
#   · **真缺口**：湖确实少了（源在 T-1 冻湖之后又长过）⇒ 回填正是解药；
#   · **通道/身份类**：`cross_unavailable` / `lake` / `gateway` / `assert` ⇒ 是**我们的通道**坏了，
#     **与被采集的数据无关**。此时回填要么白跑、要么在错误状态下写生产 ⇒ **必须拒回填**。
# ⇒ 判据只认「行/批次与网关不符」为缺口；其余一律 `HEAL_REFUSED:`。
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
#
# 依赖 env：LEMENG_TOKEN / BRANCH_NUMS / SYSTEM_BOOK / ZOS_*（透传给 diagnose.sh；本脚本不自己读凭据）
# 可选 env：DIAGNOSE_BIN（默认 /opt/lemeng-diagnose.sh）
#           CONSOLE_CT（默认 lemeng console 容器名，用于**运行时**取令牌——不落配置）
#           CONSOLE_URL（默认 http://127.0.0.1:18080）
#           BACKFILL_PIPELINE（默认 pipelines/lemeng.retail.windows.backfill.json）
#           SETTLE_DAYS（默认 3）/ HEAL_WAIT_SECONDS（默认 900）/ HEAL_POLL_SECONDS（默认 20）
#           HEAL_DRY_RUN=1（**只判别与打印，不触发**——演练用）
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

usage() {
  cat >&2 <<'USAGE'
用法：sh recon-day-heal.sh [<YYYY-MM-DD>]
  不给营业日 ⇒ 取 **T-3**（正典 §1.4.1 定稿线）。
  流程：recon-day（只读）→ 不平则判别 → 真缺口才回填（一次）→ 复验 → 结论。
  演练：HEAL_DRY_RUN=1（只判别与打印，不触发回填）。
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

# 到这里 = 真缺口
if [ "${HEAL_DRY_RUN:-0}" = "1" ]; then
  echo "HEAL_SKIP:no_gap(dry_run) bizday=${DAY}——判别为真缺口；HEAL_DRY_RUN=1 故**不触发**回填"
  exit 0
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
