#!/bin/sh
# recon-restate.sh — **重述窗口**驱动：对窗口内**台账不平**的 (账套, 日) 逐日跑 heal 闭环（issue #814 层 1+2+3）
#
# ── 它补的是哪一格 ────────────────────────────────────────────────────────────
# 湖里 **T-1 之后不再重采**（写者只有 tick=今天、日批=昨天），而源侧在更久之后仍可能长（#528 实证：
# 同一窗行数 472 → 476 → 482）。现行 `lemeng-recon-day-heal` 排班只覆盖 **3120**、只 heal **T-3 一天**
# ⇒ ① 64188 从未被覆盖；② 晚于 T-3 才到的东西没有第二次机会。
#
# 本脚本把「**重采哪些天**」从「固定一天」改成「**窗口内台账说不平的那些天**」：
#   · 窗口 = T-3 .. T-3-(N-1)（**只取已定稿日**；未定稿的源还在变，heal 自己也会拒）
#   · 候选 = `staging.recon_run` 里 `break_count>0`、或 `status in ('within_tol','not_evaluated')` 的日子
#     （零网关调用的粗筛；精确判别交给 heal —— 它逐小时比行数，**行齐就 HEAL_OK 不写**）
#   · 逐候选日调 `recon-day-heal.sh <日>`：判别 → 真缺口才旁路失效 checkpoint → 重采 → 复验
#
# ⚠️ **本脚本不做任何口径判定**。台账里的金额差可能来自「报表 vs 行级接口」（#814 复诊结论），
#    那是重采补不回的；heal 会在**行数**层面判真缺口，补不回的自然 `HEAL_OK` 收场（成本 = 逐小时查询）。
#
# ── 排除日（`RESTATE_EXCLUDE`）────────────────────────────────────────────────
# 已知**重采无效**的日子可显式排除（逗号分隔 `YYYY-MM-DD`），免得每晚白跑一遍逐小时判别。
# 例：#814 复诊证明 64188/2026-10-14 的行是齐的、差额来自报表口径 ⇒ 属这类。
#
# ── 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）──────────────────────
#   0 = 全部候选都 HEAL_OK / HEAL_RECOVERED（或没有候选）
#   1 = 有候选**没能自愈**（HEAL_FAILED / 复验仍不平）——需要人
#   2 = 用法错
#   3 = 依赖不可用（pg_duckdb 容器不在 / 台账读不到 / console 不可达）
#   可 grep 字面量：
#     `RESTATE_PLAN book=<B> window=<a..b> candidates=<n> days=<d1,d2,...>`
#     `RESTATE_START book=<B> day=<D>`（**逐日开跑前打一行**——单日 heal 可达数分钟，
#        没有这行就只能靠 `ps` 猜「现在跑到哪天」，实测一次 43 分钟的跑批里这条很要紧）
#     `RESTATE_SKIP reason=excluded day=<D>` / `RESTATE_SKIP reason=no_ledger`
#     `RESTATE_DAY book=<B> day=<D> verdict=<HEAL_OK|HEAL_RECOVERED|HEAL_FAILED:…|HEAL_SKIP:…>`
#     `RESTATE_OK candidates=<n> healed=<m> unchanged=<k>` / `RESTATE_PARTIAL failed=<n>`
#
# ── 依赖 env ─────────────────────────────────────────────────────────────────
#   `LEMENG_TOKEN_<账套>` / `BRANCH_NUMS` / `SYSTEM_BOOK` / `ZOS_*`：**从各账套 console 容器 env 运行时现取**
#   （本脚本自己取，不落配置、不落 argv——与既有 heal 排班同款手法）
#   `PGDUCK_CONTAINER`（默认按名字 grep）、`PGDUCK_USER`（platform）、`PGDUCK_DB`（warehouse）
#   `HEAL_BIN`（默认 /opt/lemeng-recon-day-heal.sh）、`CONSOLE_URL_<账套>`（默认 3120→:18080 / 64188→:18081）
#   `BOOKS`（默认 `3120 64188`）、`RESTATE_DAYS`（默认 7）、`SETTLE_DAYS`（默认 3）、`RESTATE_EXCLUDE`
#   `RESTATE_DRY_RUN=1` 只打计划不执行（演练）
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

BOOKS=${BOOKS:-3120 64188}
RESTATE_DAYS=${RESTATE_DAYS:-7}
SETTLE_DAYS=${SETTLE_DAYS:-3}
RESTATE_EXCLUDE=${RESTATE_EXCLUDE:-}
RESTATE_DRY_RUN=${RESTATE_DRY_RUN:-0}
HEAL_BIN=${HEAL_BIN:-/opt/lemeng-recon-day-heal.sh}
PGDUCK_USER=${PGDUCK_USER:-platform}
PGDUCK_DB=${PGDUCK_DB:-warehouse}
PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 'pg_duckdb')}

[ -n "${PGDUCK_CONTAINER}" ] || { echo "RESTATE_FAILED:deps 找不到 pg_duckdb 容器" >&2; exit 3; }
[ -f "${HEAL_BIN}" ] || { echo "RESTATE_FAILED:deps 找不到 ${HEAL_BIN}" >&2; exit 3; }

# 上海「今天」（引擎/宿主都是 UTC，用 TZ 现算）
SH_TODAY=$(TZ=Asia/Shanghai date +%Y-%m-%d)
# 窗口上界 = 今天 - SETTLE_DAYS（已定稿的最后一天）；下界 = 上界 - (N-1)
WIN_HI=$(TZ=Asia/Shanghai date -j -v-"${SETTLE_DAYS}"d +%Y-%m-%d 2>/dev/null || date -d "-${SETTLE_DAYS} day" +%Y-%m-%d)
WIN_LO_OFF=$((SETTLE_DAYS + RESTATE_DAYS - 1))
WIN_LO=$(TZ=Asia/Shanghai date -j -v-"${WIN_LO_OFF}"d +%Y-%m-%d 2>/dev/null || date -d "-${WIN_LO_OFF} day" +%Y-%m-%d)

_psql() {
  docker exec -i "${PGDUCK_CONTAINER}" psql -U "${PGDUCK_USER}" -d "${PGDUCK_DB}" -t -A -F, -c "${1}" 2>/dev/null
}

# 台账粗筛：窗口内有差异的 (账套, 日)。台账是 dbt 每日重建的派生物（materialize 之后才有当日新行）。
candidates=$(_psql "select distinct system_book || ',' || bizday from staging.recon_run where bizday between '${WIN_LO}' and '${WIN_HI}' and (coalesce(break_count,0) > 0 or status in ('within_tol','not_evaluated')) order by 1") \
  || { echo "RESTATE_FAILED:deps 台账读不到（staging.recon_run）——materialize 跑过吗？" >&2; exit 3; }

total=0; healed=0; unchanged=0; failed=0
for book in ${BOOKS}; do
  ct="openship-platform-core-shanhai-data-lemeng-console-${book}"
  if ! docker inspect "${ct}" >/dev/null 2>&1; then
    echo "RESTATE_FAILED:deps console 容器不在：${ct}" >&2; exit 3
  fi
  # 逐账套取凭据（运行时现取；不进 argv / 不进日志）
  _get() { docker inspect "${ct}" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$1=//p"; }
  case "${book}" in
    64188) url=${CONSOLE_URL_64188:-http://127.0.0.1:18081} ;;
    *)     url=${CONSOLE_URL_3120:-http://127.0.0.1:18080} ;;
  esac

  days=$(printf '%s\n' "${candidates}" | awk -F, -v b="${book}" '$1==b {print $2}')
  cnt=$(printf '%s\n' "${days}" | grep -c . || true)
  echo "RESTATE_PLAN book=${book} window=${WIN_LO}..${WIN_HI} candidates=${cnt} days=$(printf '%s' "${days}" | tr '\n' ',' | sed 's/,$//')"
  [ "${cnt}" -eq 0 ] && continue

  for d in ${days}; do
    case ",${RESTATE_EXCLUDE}," in
      *",${d},"*) echo "RESTATE_SKIP reason=excluded day=${d}"; continue ;;
    esac
    total=$((total + 1))
    if [ "${RESTATE_DRY_RUN}" = "1" ]; then
      echo "RESTATE_DRY day=${d} (would run ${HEAL_BIN})"
      continue
    fi
    echo "RESTATE_START book=${book} day=${d}"
    out=$(LEMENG_TOKEN="$(_get LEMENG_TOKEN)" \
          BRANCH_NUMS="$(_get BRANCH_NUMS)" \
          SYSTEM_BOOK="$(_get SYSTEM_BOOK)" \
          ZOS_BUCKET="$(_get ZOS_BUCKET)" \
          ZOS_REGION="$(_get ZOS_REGION)" \
          ZOS_ENDPOINT="$(_get ZOS_ENDPOINT)" \
          ZOS_ACCESS_KEY="$(_get ZOS_ACCESS_KEY)" \
          ZOS_SECRET_KEY="$(_get ZOS_SECRET_KEY)" \
          CONSOLE_CT="${ct}" CONSOLE_URL="${url}" SETTLE_DAYS="${SETTLE_DAYS}" \
          sh "${HEAL_BIN}" "${d}" 2>&1)
    verdict=$(printf '%s\n' "${out}" | grep -oE 'HEAL_(OK|RECOVERED|FAILED:[a-z_]+|REFUSED:[a-z_]+|SKIP:[a-z_]+)' | tail -1)
    [ -n "${verdict}" ] || verdict="HEAL_FAILED:no_verdict"
    echo "RESTATE_DAY book=${book} day=${d} verdict=${verdict}"
    case "${verdict}" in
      HEAL_OK) unchanged=$((unchanged + 1)) ;;
      HEAL_RECOVERED) healed=$((healed + 1)) ;;
      HEAL_SKIP:*) unchanged=$((unchanged + 1)) ;;
      *) failed=$((failed + 1)) ;;
    esac
  done
done

if [ "${failed}" -gt 0 ]; then
  echo "RESTATE_PARTIAL failed=${failed} candidates=${total} healed=${healed} unchanged=${unchanged}"
  exit 1
fi
echo "RESTATE_OK candidates=${total} healed=${healed} unchanged=${unchanged}"
