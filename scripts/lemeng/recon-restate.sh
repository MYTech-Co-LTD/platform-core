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
#     ＋（#2894）窗口内**整天没有台账行**、且平台侧当天有营业的日子（`kind=gap`）——
#     这类日子以前根本长不出候选（候选是从台账里挑的），只能等次日断言 ⑪ 红
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
#     `RESTATE_SKIP reason=excluded day=<D>` / `RESTATE_SKIP reason=no_business day=<D>`
#     `RESTATE_GAP book=<B> day=<D> reason=no_ledger`（这一天整天没台账，本次按「缺一天」重采）
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
# 2026-11-21（#2630）：跳过「全日已具名记账」的日子——该日无 over_tol/not_evaluated 行，
# 且所有**非零 diff** 的 break 都带未过期的 reason_code（如 late_return_restatement，重采无效的
# 口径差类）。⚠️ diff=0 的 break 行是台账逐店记行噪音（caliber_sale 两账套恒 0.00 也各落一行、
# 无 reason_code），不算待分类。这类日子 heal 每晚重采也只会 still_a_gap 白烧 ~2.8h；真要人看的
# （over_tol / 源侧零返回 / 非零 diff 未具名 / 容差已过期）仍然进候选。RESTATE_EXCLUDE 保留作人工兜底。
#
# 2026-11-26（#2894）**再加一类候选：整天没有台账行**（`kind=gap`）。
#   为什么必须加：本脚本的候选**只从 `staging.recon_run` 里挑** ⇒ 「这一天根本没进台账」它天生长不出
#   候选，只能等次日断言 ⑪ 变红（2026-11-26 实测：`recon_run` 停在 11-21 而 `recon_break` 已到 11-23）。
#   成因两类：① 台账没重建（重建那份活归平台 job `data.recon_ledger_guard`）② **源快照当天没落** ——
#   后者重采能补，正是本脚本的活。
#   条件里带「平台侧当天有行」：两侧全空的日子是**真的没营业**（如春节闭店），那种日子进 heal 只会
#   每晚报 FAILED ⇒ 假红。没有营业就不该有台账，明确跳过并打 `RESTATE_SKIP reason=no_business`。
candidates=$(_psql "
with w as (select '${WIN_LO}'::date as lo, '${WIN_HI}'::date as hi),
books as (select distinct system_book from staging.recon_run where bizday > current_date - 30),
d as (select b.system_book, g::date as bizday
        from books b, w, generate_series(w.lo::timestamp, w.hi::timestamp, interval '1 day') g),
pd as (select cast(f.system_book as varchar) as system_book, f.bizday
         from staging.fct_retail_sale f, w
        where f.bizday between w.lo and w.hi
        group by 1, 2),
diff as (select distinct r.system_book, r.bizday, 'diff' as kind
           from staging.recon_run r, w
          where r.bizday between w.lo and w.hi
            and (coalesce(r.break_count,0) > 0 or r.status in ('within_tol','not_evaluated'))
            and not (not exists (select 1 from staging.recon_run r2 where r2.system_book = r.system_book and r2.bizday = r.bizday and r2.status in ('over_tol','not_evaluated'))
                     and not exists (select 1 from staging.recon_break b where b.system_book = r.system_book and b.bizday = r.bizday and coalesce(b.diff,0) <> 0 and (coalesce(b.reason_code,'') = '' or b.expires_on is null or b.expires_on < current_date)))),
gap as (select d.system_book, d.bizday,
               case
                 when not exists (select 1 from pd where pd.system_book = d.system_book and pd.bizday = d.bizday)
                   then 'nobiz'          -- 两侧都没营业：不该有台账
                 when exists (select 1 from staging.recon_break b
                               where b.system_book = d.system_book and b.bizday = d.bizday)
                   then 'ledger_stale'   -- 差/台账数据都在，只是 recon_run 没重建 ⇒ 归 data.recon_ledger_guard
                 else 'gap'              -- recon_break 里也没有 ⇒ 源快照当天没落，重采能补
               end as kind
          from d
         where not exists (select 1 from staging.recon_run r where r.system_book = d.system_book and r.bizday = d.bizday))
select system_book || ',' || bizday || ',' || kind from diff
union all
select system_book || ',' || bizday || ',' || kind from gap
order by 1") \
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

  # kind=nobiz / ledger_stale 先从候选里摘出去（都不该由 heal 处理），但要**各打一行**：
  # 「窗口里有一天没进计划」必须能一眼看出原因，不能像漏派。
  for d in $(printf '%s\n' "${candidates}" | awk -F, -v b="${book}" '$1==b && $3=="nobiz" {print $2}'); do
    echo "RESTATE_SKIP reason=no_business day=${d}"
  done
  for d in $(printf '%s\n' "${candidates}" | awk -F, -v b="${book}" '$1==b && $3=="ledger_stale" {print $2}'); do
    echo "RESTATE_SKIP reason=ledger_stale day=${d}（数据在、台账没重建 → data.recon_ledger_guard）"
  done
  days=$(printf '%s\n' "${candidates}" | awk -F, -v b="${book}" '$1==b && $3!="nobiz" && $3!="ledger_stale" {print $2"|"$3}')
  cnt=$(printf '%s\n' "${days}" | grep -c . || true)
  echo "RESTATE_PLAN book=${book} window=${WIN_LO}..${WIN_HI} candidates=${cnt} days=$(printf '%s' "${days}" | cut -d'|' -f1 | tr '\n' ',' | sed 's/,$//')"
  [ "${cnt}" -eq 0 ] && continue

  for entry in ${days}; do
    d=${entry%%|*}
    kind=${entry##*|}
    case ",${RESTATE_EXCLUDE}," in
      *",${d},"*) echo "RESTATE_SKIP reason=excluded day=${d}"; continue ;;
    esac
    # gap = 这一天**根本没进台账**（而非台账不平）：先打一行，让人一眼看出这次不是「差多少」而是「缺一天」。
    [ "${kind}" = "gap" ] && echo "RESTATE_GAP book=${book} day=${d} reason=no_ledger"
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
