#!/bin/sh
# backfill-retail-order-line.sh — 零售明细湖「分批回填」驱动（D1=B 的执行面；issue #387）
#
# ── 判据正典 ────────────────────────────────────────────────────────────────────
# `docs/superpowers/specs/2026-09-29-read-side-migration.md` §4.0（不变量）与 §4 Phase 0/1。
# 本脚本**逐字实现**那两节，不发明新判据；裁决见 spec §0.1（**D1=B** / **D2 = 把 Phase 0 探针
# 做成回填前置的 fail-closed 守卫** / D3 批次表取 §4 Phase 1）。
#
# ── 这个工具干什么 ──────────────────────────────────────────────────────────────
# 把 `retail_order_line` 的**旧形分区**（18 列）用新管线重写成契约 v2 的 **24 列**，
# 顺序 **bizday 降序**、**3120/2026-09-23 最后**（spec §4 Phase 1 的五批表）。
#
# **为什么必须降序**：spec §4.0 的不变量 —— glob 展开后**第一个文件的列集**必须是其后**每个**
# 文件列集的**子集**。第一个文件恰是 `system_book=3120/bizday=2026-09-23/hour=00/all.parquet`
# ⇒ 它一变 24 列，其后任何 18 列文件都会让整湖混读以 `schema mismatch in glob` **整挂**
# （B-3，已在生产引擎 DuckDB 1.4.3 上复现）。
#
# ⚠️ **诚实记一句**：那条不变量在「第一个文件仍是 18 列」时对**其它**分区是宽容的
#    （18 列是任何列集的子集）。所以降序**不是引擎强制的**，是本仓的**纪律**；D2 的处置就是
#    把这条纪律做成 **fail-closed 的闸**，而不是留在文档里。本脚本两道闸：
#      ① **Phase 0 前置守卫**：最老分区列数必须 = 19 行（= 18 列 + 1 行根节点），否则**拒绝执行**；
#      ② **顺序闸**：要跑的那批必须是**当前第一个未完成批**，否则拒绝 —— ②挡的正是
#         「先手动把最老分区补了」与「跳批」这两类误序（①挡不住它们：误序发生时最老分区**还是** 18 列）。
#
# ── 为什么不用引擎自带 `POST /api/backfills`（免得后人再试一次）────────────────────
# 它要求管线声明 `partition` 块，**本仓管线没有**（`plan_for` 直接报「declares no partition」）。
# 本脚本走的是**参数化 run**：回填变体父管线里的 `${BIZDAY}` 是**非内建占位符** ⇒ 等于声明了一个
# 参数（源码 `context::discover_parameters`：跳过 `workspace`/`projectroot`/日期时间族/`ENV:`/`VAULT:`），
# 而 `POST /api/run` 与 `/api/run/async` 都收 `{"file":"...","params":{"BIZDAY":"..."}}`。
#
# ── 用法（在**数据面机宿主**上跑；回填变体父管线在同一台机上 seed 进两个 console 的 workspace）──
#   sh backfill-retail-order-line.sh plan            # 五批表 + 每批当前状态（只读）
#   sh backfill-retail-order-line.sh guard           # Phase 0 前置守卫（只读；非 19 ⇒ 拒绝、退出码 3）
#   sh backfill-retail-order-line.sh verify [N]      # 批后判据（只读；默认当前第一个未完成批）
#   sh backfill-retail-order-line.sh run [--batch N] [--force]   # 守卫 → 顺序闸 → 触发 → 等批 → 批后判据
#
# **一次调用只做一批**（`run` 跑完一批即退出、**不自动续下一批**）：批次边界要人看得见，
# 每批之间重看一次读数。要续下一批 ⇒ 再调一次（`--batch N+1` 可省，默认取下一批）。
#
# ── 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）────────────────────────
#   0 = 该动作全部判据通过；1 = 判据不通过（含顺序闸拒绝）；2 = 用法错；3 = 湖通道不可用。
#   可 grep 的字面量：
#     通过：`PHASE0_GUARD=PASS` / `BATCH_SCHEMA_OK:` / `WHOLE_LAKE_OK:` / `BACKFILL_OK batch=`
#     拒绝：`BACKFILL_REFUSED:phase0` / `BACKFILL_REFUSED:out_of_order` / `BACKFILL_FAILED:`
#
# ── 依赖 env ───────────────────────────────────────────────────────────────────
#   ZOS_BUCKET            （湖桶名；生产必给）
#   DUCKLE_TOKEN          （两个 console 的 Bearer 令牌；真值在 openship env(isSecret)）
#   SYSTEM_BOOK 不读 —— 账套由 console 自己的 env 决定（一账套一 console，见 data-compose.yml）
# 可选 env：LAKE_ROOT（默认 `s3://${ZOS_BUCKET}/lemeng/retail_order_line`）/
#   OLDEST_DAY（默认 2026-09-23）/ OLDEST_BOOK（默认 3120）/ OLDEST_HOUR（默认 00）/
#   CONSOLE_3120_URL（默认 http://127.0.0.1:18080）/ CONSOLE_64188_URL（默认 http://127.0.0.1:18081）/
#   BACKFILL_PIPELINE（默认 pipelines/lemeng.retail.windows.backfill.json）/
#   BACKFILL_POLL_SECONDS（默认 30）/ BACKFILL_TIMEOUT_SECONDS（默认 3600）/
#   PGDUCK_CONTAINER / PGDUCK_USER（默认 platform）/ PGDUCK_DB（默认 warehouse）
# 可选 env（**通道切换，只给 lab 用**）：LAKE_CHANNEL=duckdb + DUCKDB_BIN + LAB_S3_*
#   —— 见下面 `lake_query` 的注释；生产一律 `pg_duckdb`（免凭据通道）。
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 `/bin/sh`（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

# ── 判据常量（**改它们 = 改判据**，改前回 spec §4）───────────────────────────────
PROBE_EXPECT=19     # 18 列 + 1 行根节点（spec §4 Phase 0 的**唯一**判据）
UNIFORM_EXPECT=25   # 24 列 + 1 行根节点（spec §4 Phase 1 批后判据）
HOURS='00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23'
FIRST_HOUR=00
LAST_HOUR=23

OLDEST_DAY=${OLDEST_DAY:-2026-09-23}
OLDEST_BOOK=${OLDEST_BOOK:-3120}
OLDEST_HOUR=${OLDEST_HOUR:-00}

BACKFILL_PIPELINE=${BACKFILL_PIPELINE:-pipelines/lemeng.retail.windows.backfill.json}
CONSOLE_3120_URL=${CONSOLE_3120_URL:-http://127.0.0.1:18080}
CONSOLE_64188_URL=${CONSOLE_64188_URL:-http://127.0.0.1:18081}
BACKFILL_POLL_SECONDS=${BACKFILL_POLL_SECONDS:-30}
BACKFILL_TIMEOUT_SECONDS=${BACKFILL_TIMEOUT_SECONDS:-3600}

LAKE_CHANNEL=${LAKE_CHANNEL:-pg_duckdb}
PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-}
PGDUCK_USER=${PGDUCK_USER:-platform}
PGDUCK_DB=${PGDUCK_DB:-warehouse}
DUCKDB_BIN=${DUCKDB_BIN:-duckdb}
LAB_S3_ENDPOINT=${LAB_S3_ENDPOINT:-}
LAB_S3_KEY_ID=${LAB_S3_KEY_ID:-}
LAB_S3_SECRET=${LAB_S3_SECRET:-}
LAB_S3_REGION=${LAB_S3_REGION:-us-east-1}
LAB_S3_USE_SSL=${LAB_S3_USE_SSL:-false}

# ══ ① 批次表（spec §4 Phase 1 **逐字**；「N day book...」）══════════════════════════
# 表内顺序**就是**执行顺序：bizday 降序，两账套同日成批，3120/09-23 最后。
batch_plan() {
  printf '%s\n' \
    '1 2026-09-27 3120 64188' \
    '2 2026-09-26 3120 64188' \
    '3 2026-09-25 3120 64188' \
    '4 2026-09-24 3120' \
    '5 2026-09-23 3120'
}
batch_count() { batch_plan | awk 'END { print NR }'; }
batch_line() { batch_plan | awk -v n="$1" '$1 == n { print; found = 1 } END { exit found ? 0 : 1 }'; }
batch_day() { batch_line "$1" | awk '{ print $2 }'; }
batch_books() { batch_line "$1" | awk '{ for (i = 3; i <= NF; i++) print $i }'; }
batch_label() { batch_line "$1"; }   # → "N day book[,book]"

# ══ ② 湖侧寻址与 SQL 构造 ════════════════════════════════════════════════════════
lake_root() { # 湖对象前缀（不含尾斜杠）
  if [ -n "${LAKE_ROOT:-}" ]; then printf '%s\n' "$LAKE_ROOT"
  else printf 's3://%s/lemeng/retail_order_line\n' "${ZOS_BUCKET:?ZOS_BUCKET 未注入——无法定位湖}"; fi
}
part_path() { # $1=book $2=day $3=hour → 单分区对象路径
  printf '%s/system_book=%s/bizday=%s/hour=%s/all.parquet\n' "$(lake_root)" "$1" "$2" "$3"
}
lake_glob() { printf '%s/system_book=*/bizday=*/hour=*/all.parquet\n' "$(lake_root)"; }

probe_sql() { # $1=book $2=day $3=hour → Phase 0 判据的 SQL（spec §4 Phase 0 **逐字**）
  # ⚠️ 必须用 `parquet_schema`（看**真实列数**），**不要**用「选新列能不能跑通」当探针：
  #    实测「新形在前但不投影任何列」是**不报错**的（spec §2.3 末条）⇒ 那种探针会给**假绿**。
  # ⚠️ **不写尾分号**：本 SQL 会被 pg_duckdb 通道嵌进 `duckdb.query($$ … $$)`，尾分号在 $$ 里是噪音。
  printf "SELECT count(*) AS schema_rows FROM parquet_schema('%s')" "$(part_path "$1" "$2" "$3")"
}

batch_schema_sql() { # $1=day $2..=books → 该批**全部分区**（每 book × 24 hour）的 parquet_schema 行数
  # 一次查询拿全批读数（`parquet_schema` 只接受**字面量**、不支持 lateral join 的列参数 ⇒
  # 只能把 24×N 个字面量调用 UNION ALL 展开；实测见报告「lab 验证」）。
  _bss_day=$1; shift
  _bss_first=1
  for _bss_book in "$@"; do
    for _bss_h in ${HOURS}; do
      [ "${_bss_first}" -eq 1 ] || printf ' UNION ALL '
      printf "SELECT '%s/hour=%s' AS part, count(*) AS rows FROM parquet_schema('%s')" \
        "${_bss_book}" "${_bss_h}" "$(part_path "${_bss_book}" "${_bss_day}" "${_bss_h}")"
      _bss_first=0
    done
  done
}

whole_lake_sql() { # 批后「整湖混读仍通」判据（spec §4 Phase 1 **逐字**，🟢 2026-09-30 订正：排除当天）
  # ⚠️ 别用 `count(*)` 当判据 —— 它对列集不敏感（spec §2.2/§4 明写）。判据是 `orders = n` + `mind`。
  # ⚠️ 形态必须留在 `from read_parquet(glob) r` + `r['列名']`：这正是门禁规则① 守的形态
  #    （`dbt/README.md` §6 / `scripts/check-data-models.mjs`），也是 D1=B「读侧不动」的全部意义。
  # 🟢 2026-09-30 生产实例订正（#328 评论）：**排除「当天及以后」的 bizday**。
  #   当天分区正被 tick 每 5 分钟覆盖写 ⇒ 整湖扫描与写并发 ⇒ ETag 校验报
  #   「file has changed」（实测原文见 #328），且当天分区恒 24 列、对不变量**没有信息量**
  #   ⇒ 排除它既消除竞态，判据语义不变（不变量关心的是「历史旧形分区」）。
  # ⚠️ 这里的 `r['bizday']` 是**载荷列**（契约 24 列之一，管线 flatten 时写入），**不是** hive 分区列
  #   ⇒ 不开 `hive_partitioning`（那条「分区列遮蔽载荷列」的禁令原样成立，见批 schema 判据的注释）。
  printf "SELECT count(*) AS n, count(r['order_no']) AS orders, min(r['bizday']::date) AS mind, max(r['bizday']::date) AS maxd FROM read_parquet('%s') r WHERE r['bizday']::date < CURRENT_DATE" \
    "$(lake_glob)"
}

# ══ ③ 湖侧通道（换通道，不换问句）════════════════════════════════════════════════
pg_duckdb_cid() { # → 容器名/ID；找不到非零（**不猜**：猜错容器名 = 拿别的东西当读数）
  if [ -n "${PGDUCK_CONTAINER}" ]; then printf '%s\n' "${PGDUCK_CONTAINER}"; return 0; fi
  _pc=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'pg_duckdb$' | head -1)
  [ -n "${_pc}" ] || return 1
  printf '%s\n' "${_pc}"
}

lab_secret_sql() { # lab 通道的 S3 secret 前导（值只在 lab；生产通道**不用**，也不该用）
  [ -n "${LAB_S3_ENDPOINT}" ] || return 0
  printf "CREATE SECRET lab_lake (TYPE S3, KEY_ID '%s', SECRET '%s', ENDPOINT '%s', URL_STYLE 'path', USE_SSL %s, REGION '%s');\n" \
    "${LAB_S3_KEY_ID}" "${LAB_S3_SECRET}" "${LAB_S3_ENDPOINT}" "${LAB_S3_USE_SSL}" "${LAB_S3_REGION}"
}

lake_query() { # $1=SQL → stdout（CSV、无表头）；非零 = 通道不可用（调用方据此判 3，**不静默退化**）
  case "${LAKE_CHANNEL}" in
    pg_duckdb)
      # 免凭据通道（spec E0/P3）：psql 走容器内 Unix socket（官方镜像的 local trust）⇒ 不经 ZOS_*。
      _lq_cid=$(pg_duckdb_cid) || { echo "LAKE_CHANNEL_UNAVAILABLE: 找不到 pg_duckdb 容器（docker ps 无匹配）" >&2; return 2; }
      docker exec "${_lq_cid}" psql -U "${PGDUCK_USER}" -d "${PGDUCK_DB}" -tA -F, \
        -c "SELECT * FROM duckdb.query(\$\$ $1 \$\$);"
      ;;
    duckdb)
      # **本机 lab 专用**：本地 duckdb + 回环 S3（minio/s3rver）。生产别用它 —— 它绕过
      # 「免凭据通道」这条裁决，且凭据会经过命令行（lab 的凭据是一次性的，无价值）。
      { lab_secret_sql; printf '%s;\n' "$1"; } | "${DUCKDB_BIN}" -csv -noheader 2>&1
      ;;
    *)
      echo "LAKE_CHANNEL_UNAVAILABLE: 未知 LAKE_CHANNEL='${LAKE_CHANNEL}'（只认 pg_duckdb / duckdb）" >&2
      return 2
      ;;
  esac
}

# ══ ④ 读数解析与判据（纯函数，逐条可单测）════════════════════════════════════════
parse_int() { # stdin → 第一个纯整数行（跳过 NOTICE/表头/空行）；找不到 ⇒ 非零
  awk 'NF >= 1 && $0 ~ /^[[:space:]]*-?[0-9]+[[:space:]]*$/ { gsub(/[[:space:]]/, ""); print; found = 1; exit } END { exit found ? 0 : 1 }'
}

probe_verdict() { # $1=parquet_schema 行数 → 0 放行 / 1 拒绝（fail-closed）
  if [ "$1" = "${PROBE_EXPECT}" ]; then
    echo "PHASE0_GUARD=PASS 最老分区（${OLDEST_BOOK}/bizday=${OLDEST_DAY}/hour=${OLDEST_HOUR}）仍是 ${PROBE_EXPECT} 行 = 18 列 ⇒ D1=B 的不变量成立（glob 首文件列集仍是最小集）"
    return 0
  fi
  echo "BACKFILL_REFUSED:phase0 最老分区（system_book=${OLDEST_BOOK}/bizday=${OLDEST_DAY}/hour=${OLDEST_HOUR}）的 parquet_schema 行数 = $1，**不是** ${PROBE_EXPECT}（18 列 + 根节点）⇒ 拒绝执行回填。"
  echo "  含义：不变量已破（最老分区已被重写）或边界判断错了。此刻湖可能已经读不通，别再往上写。"
  echo "  处置：① 若该分区确实已被重写 ⇒ 不能再按 D1=B 走，**唯一救援 = 切方案 A**（读侧 duckdb.query + union_by_name，spec §3.2 与 §4 回滚点）；"
  echo "        ② 若判断有误 ⇒ 先核对 OLDEST_DAY/OLDEST_BOOK 与湖实况（先跑「plan」子命令拿全表读数），别强行继续（spec §4 Phase 0）。"
  return 1
}

batch_schema_verdict() { # stdin=「part,rows」；$1=期望的分区数 → 0 通过 / 1 不通过
  awk -v want="${UNIFORM_EXPECT}" -v expect_n="$1" -F, '
    NF >= 2 && $2 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {
      gsub(/[[:space:]]/, "", $1); r = $2 + 0; seen++
      if (r != want) { print "    " $1 " => " r " 行（期望 " want "）"; bad++ }
    }
    END {
      if (seen != expect_n) { printf "BACKFILL_FAILED:batch_schema 期望 %d 个分区读数、实得 %d（读数不齐 = 判据不成立）\n", expect_n, seen; exit 1 }
      if (bad > 0) { printf "BACKFILL_FAILED:batch_schema %d/%d 个分区不是 %d 行（= 24 列）——该批未全部重写\n", bad, seen, want; exit 1 }
      printf "BATCH_SCHEMA_OK: %d 个分区均 %d 行（= 24 列）\n", seen, want
      exit 0
    }'
}

whole_lake_verdict() { # stdin=「n,orders,mind,maxd」；$1=期望的最老 bizday → 0 通过 / 1 不通过
  awk -v want_min="$1" -F, '
    NF >= 4 && $1 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {
      gsub(/[[:space:]]/, "", $1); gsub(/[[:space:]]/, "", $2)
      gsub(/[[:space:]]/, "", $3); gsub(/[[:space:]]/, "", $4)
      found = 1
      printf "  whole-lake: n=%s orders=%s mind=%s maxd=%s\n", $1, $2, $3, $4
      if ($2 + 0 != $1 + 0) { print "BACKFILL_FAILED:whole_lake orders != n（" $2 " != " $1 "）——列集不齐，混读已在丢列"; exit 1 }
      if ($1 + 0 <= 0)      { print "BACKFILL_FAILED:whole_lake n = 0（湖读空了？）"; exit 1 }
      if ($3 != want_min)   { print "BACKFILL_FAILED:whole_lake mind = " $3 " != " want_min "（最老分区不在 —— glob 没覆盖到它？）"; exit 1 }
      printf "WHOLE_LAKE_OK: n=%s orders=%s mind=%s maxd=%s（18 列与 24 列分区共处一个 glob，现行读法仍通）\n", $1, $2, $3, $4
      exit 0
    }
    END { if (!found) { print "BACKFILL_FAILED:whole_lake 读数缺失（查询没返回行）——判据不成立，不当通过"; exit 1 } }'
}

order_guard() { # $1=要跑的批 $2=当前第一个未完成批 $3=是否 --force(1/0) → 0 放行 / 1 拒绝
  if [ "$1" = "$2" ]; then return 0; fi
  if [ "$2" = "0" ]; then
    echo "BACKFILL_REFUSED:out_of_order 五批**全部**已是 24 列（没有未完成批）——回填已完成。"
    echo "  若确要重跑第 $1 批（幂等重写），加 --force（会**破坏**顺序纪律的可读性，只在已确认全湖均一时用）。"
    [ "$3" = "1" ] && return 0
    return 1
  fi
  if [ "$1" -lt "$2" ]; then
    echo "BACKFILL_REFUSED:out_of_order 第 $1 批**已完成**（当前第一个未完成批是第 $2 批）——顺序是降序，不该回头补。"
    echo "  若确要幂等重跑第 $1 批，加 --force。"
    [ "$3" = "1" ] && return 0
    return 1
  fi
  echo "BACKFILL_REFUSED:out_of_order 第 $1 批在**第 $2 批之后**——跳批被拒。"
  echo "  为什么危险：顺序不是引擎强制的，是本仓纪律；跳过前面几批**不会**立刻报错，但会让「第一个未完成批」之外的降序假设失去意义，"
  echo "  且一旦误把最老分区（${OLDEST_BOOK}/bizday=${OLDEST_DAY}）提前重写，glob 首文件列集会盖过其后 18 列文件 ⇒ 整湖混读**整挂**（spec §4.0 / B-3）。"
  echo "  处置：先跑第 $2 批（或显式 --batch $2），或先跑「plan」看全表读数。"
  return 1
}

console_url() { # $1=book → console 基址
  case "$1" in
    3120) printf '%s\n' "${CONSOLE_3120_URL}" ;;
    64188) printf '%s\n' "${CONSOLE_64188_URL}" ;;
    *) return 1 ;;
  esac
}

# ══ ⑤ 湖读数（薄封装：把「通道 + 解析」收在一处）════════════════════════════════
lake_probe_rows() { # $1=book $2=day $3=hour → stdout 行数（parquet_schema）；非零 = 读不到
  _lpr_raw=$(lake_query "$(probe_sql "$1" "$2" "$3")") || return 2
  printf '%s\n' "${_lpr_raw}" | parse_int
}

batch_state() { # $1=batch → done | pending | partial | unknown
  _bs_day=$(batch_day "$1") || { echo unknown; return 0; }
  _bs_all_done=1; _bs_all_old=1
  for _bs_book in $(batch_books "$1"); do
    for _bs_h in "${FIRST_HOUR}" "${LAST_HOUR}"; do
      _bs_r=$(lake_probe_rows "${_bs_book}" "${_bs_day}" "${_bs_h}") || { echo unknown; return 0; }
      [ "${_bs_r}" = "${UNIFORM_EXPECT}" ] || _bs_all_done=0
      [ "${_bs_r}" = "${PROBE_EXPECT}" ] || _bs_all_old=0
    done
  done
  if [ "${_bs_all_done}" -eq 1 ]; then echo done
  elif [ "${_bs_all_old}" -eq 1 ]; then echo pending
  else echo partial; fi
}

first_pending_batch() { # → 第一个「未完成」批号；全完成 ⇒ 0；湖读不到 ⇒ 非零
  _fpb_i=1
  while [ "${_fpb_i}" -le "$(batch_count)" ]; do
    _fpb_s=$(batch_state "${_fpb_i}") || return 1
    case "${_fpb_s}" in
      done) ;;
      unknown) return 1 ;;
      *) printf '%s\n' "${_fpb_i}"; return 0 ;;
    esac
    _fpb_i=$((_fpb_i + 1))
  done
  printf '0\n'
}

# ══ ⑥ 动作 ═══════════════════════════════════════════════════════════════════════
cmd_plan() {
  _pl_i=1
  while [ "${_pl_i}" -le "$(batch_count)" ]; do
    _pl_state=$(batch_state "${_pl_i}")
    printf 'batch %s\t%s\n' "$(batch_label "${_pl_i}")" "${_pl_state}"
    _pl_i=$((_pl_i + 1))
  done
  _pl_next=$(first_pending_batch) || { echo "BACKFILL_FAILED:plan 读不到湖（通道不可用）——先修通道"; return 3; }
  if [ "${_pl_next}" = "0" ]; then echo "next: （全完成）"
  else echo "next: batch ${_pl_next}（顺序闸只放行它）"; fi
  return 0
}

cmd_guard() {
  _gd_rows=$(lake_probe_rows "${OLDEST_BOOK}" "${OLDEST_DAY}" "${OLDEST_HOUR}")
  _gd_rc=$?
  if [ "${_gd_rc}" -ne 0 ]; then
    echo "LAKE_CHANNEL_UNAVAILABLE: Phase 0 探针读不到湖（通道失败，rc=${_gd_rc}）——**fail-closed**：读不到 ≠ 通过"
    return 3
  fi
  echo "PHASE0_PROBE oldest=${OLDEST_BOOK}/bizday=${OLDEST_DAY}/hour=${OLDEST_HOUR} parquet_schema_rows=${_gd_rows}"
  probe_verdict "${_gd_rows}" || return 1
  return 0
}

cmd_verify() { # $1=batch
  _vf_batch=$1
  _vf_day=$(batch_day "${_vf_batch}") || { echo "用法错：没有第 ${_vf_batch} 批" >&2; return 2; }
  _vf_books=$(batch_books "${_vf_batch}" | tr '\n' ' ')
  _vf_n=$(batch_books "${_vf_batch}" | awk 'END { print NR * 24 }')
  echo "verify batch ${_vf_batch}: bizday=${_vf_day} books=${_vf_books}（每 book 24 个分区，共 ${_vf_n} 个）"
  _vf_raw=$(lake_query "$(batch_schema_sql "${_vf_day}" $(batch_books "${_vf_batch}" | tr '\n' ' '))")
  _vf_rc=$?
  if [ "${_vf_rc}" -ne 0 ]; then
    echo "BACKFILL_FAILED:batch 判据通道失败（rc=${_vf_rc}）——判据不成立，不当通过"
    return 3
  fi
  printf '%s\n' "${_vf_raw}" | batch_schema_verdict "${_vf_n}" || return 1
  _vf_whole=$(lake_query "$(whole_lake_sql)")
  _vf_rc=$?
  if [ "${_vf_rc}" -ne 0 ]; then
    # 🟢 2026-09-30（#328 生产实例）：湖侧读会在「扫到正被写的对象」时报 ETag 类错误
    #   （file has changed）。排除当天后已大幅收敛，但仍可能撞上（如跨零点瞬间）。
    #   重试**一次**并在输出里留痕——这不是静默重试：两行都可见，第二次仍失败才判失败。
    echo "  whole-lake: 首次通道失败（rc=${_vf_rc}），1 次竞态重试（排除当天的订正后仍撞 ⇒ 可能是别的病，别硬跑）"
    _vf_whole=$(lake_query "$(whole_lake_sql)")
    _vf_rc=$?
  fi
  if [ "${_vf_rc}" -ne 0 ]; then
    echo "BACKFILL_FAILED:whole-lake 判据通道失败（rc=${_vf_rc}，含 1 次重试）"
    return 3
  fi
  printf '%s\n' "${_vf_whole}" | whole_lake_verdict "${OLDEST_DAY}" || return 1
  return 0
}

trigger_backfill() { # $1=book $2=day → 0 = HTTP 2xx；否则非零（把 HTTP 码/响应体打出来）
  _tb_url=$(console_url "$1") || { echo "BACKFILL_FAILED:trigger 账套 ${1} 没有对应 console 地址" >&2; return 1; }
  if [ -z "${DUCKLE_TOKEN:-}" ]; then
    echo "BACKFILL_FAILED:trigger DUCKLE_TOKEN 未注入（值在 openship env(isSecret)）——拒绝无凭据触发" >&2
    return 1
  fi
  _tb_body=$(printf '{"file":"%s","params":{"BIZDAY":"%s"}}' "${BACKFILL_PIPELINE}" "$2")
  _tb_out=$(curl -sS --max-time 60 -X POST "${_tb_url}/api/run/async" \
      -H "Authorization: Bearer ${DUCKLE_TOKEN}" -H 'Content-Type: application/json' \
      -d "${_tb_body}" -w '\n%{http_code}' 2>&1)
  _tb_rc=$?
  _tb_code=$(printf '%s\n' "${_tb_out}" | tail -1)
  _tb_payload=$(printf '%s\n' "${_tb_out}" | sed '$d' | head -c 300)
  if [ "${_tb_rc}" -ne 0 ] || [ "${_tb_code#2}" = "${_tb_code}" ]; then
    echo "BACKFILL_FAILED:trigger book=${1} day=${2} HTTP=${_tb_code} curl_rc=${_tb_rc} body=${_tb_payload}" >&2
    return 1
  fi
  echo "  trigger ok: book=${1} bizday=${2} console=${_tb_url} HTTP=${_tb_code} resp=${_tb_payload}"
  return 0
}

wait_batch_done() { # $1=batch → 0 = 该批全部分区已是 25 行；超时 ⇒ 1
  _wb_deadline=$(( $(date +%s) + BACKFILL_TIMEOUT_SECONDS ))
  while :; do
    _wb_ok=1
    _wb_day=$(batch_day "$1")
    for _wb_book in $(batch_books "$1"); do
      _wb_r=$(lake_probe_rows "${_wb_book}" "${_wb_day}" "${LAST_HOUR}") || { _wb_ok=0; _wb_r='?'; }
      [ "${_wb_r}" = "${UNIFORM_EXPECT}" ] || _wb_ok=0
    done
    if [ "${_wb_ok}" -eq 1 ]; then echo "  wait: 该批尾窗（hour=${LAST_HOUR}）全部 ${UNIFORM_EXPECT} 行，重写完成"; return 0; fi
    if [ "$(date +%s)" -ge "${_wb_deadline}" ]; then
      echo "BACKFILL_FAILED:wait 超时（${BACKFILL_TIMEOUT_SECONDS}s）——该批尾窗仍未全部 ${UNIFORM_EXPECT} 行。"
      echo "  这说明回填**没有跑完**（失败/被截尾/或引擎没起来）。**失败即停**：别跑下一批，先看该 console 的 runs/receipts 与 alerts。"
      return 1
    fi
    sleep "${BACKFILL_POLL_SECONDS}"
  done
}

cmd_run() {
  _rn_batch=''
  _rn_force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --batch) [ $# -ge 2 ] || usage_fail "--batch 需要一个批号"; _rn_batch=$2; shift 2 ;;
      --batch=*) _rn_batch=${1#--batch=}; shift ;;
      --force) _rn_force=1; shift ;;
      *) usage_fail "未知参数：$1" ;;
    esac
  done

  # ① Phase 0 前置守卫（**每批前重跑**；spec D2）
  cmd_guard || return 1

  # ② 顺序闸
  _rn_first=$(first_pending_batch) || { echo "BACKFILL_FAILED:顺序闸读不到湖（通道失败）"; return 3; }
  if [ -z "${_rn_batch}" ]; then
    _rn_batch="${_rn_first}"
    [ "${_rn_batch}" = "0" ] && { echo "BACKFILL_REFUSED:out_of_order 没有未完成批（回填已完成）；要幂等重跑请显式 --batch N --force"; return 1; }
  fi
  batch_line "${_rn_batch}" >/dev/null || usage_fail "没有第 ${_rn_batch} 批（批次表见 plan）"
  order_guard "${_rn_batch}" "${_rn_first}" "${_rn_force}" || return 1

  _rn_day=$(batch_day "${_rn_batch}")
  _rn_books=$(batch_books "${_rn_batch}" | tr '\n' ' ')
  echo "run batch ${_rn_batch}: bizday=${_rn_day} books=${_rn_books} pipeline=${BACKFILL_PIPELINE}"

  # ③ 触发（每账套一个 console —— 一账套一 console，凭据按账套绑定，见 data-console README）
  for _rn_book in $(batch_books "${_rn_batch}"); do
    trigger_backfill "${_rn_book}" "${_rn_day}" || return 1
  done

  # ④ 等批（**不用 count(*)，看列数**）
  wait_batch_done "${_rn_batch}" || return 1

  # ⑤ 批后判据（spec §4 Phase 1：该批分区 = 25 + 整湖混读仍通）
  cmd_verify "${_rn_batch}" || return 1

  # ⑥ 末批：探针必须翻成 25（= 全湖均一，spec §4 Phase 1 表末行）
  if [ "${_rn_batch}" = "$(batch_count)" ]; then
    _rn_last=$(lake_probe_rows "${OLDEST_BOOK}" "${OLDEST_DAY}" "${OLDEST_HOUR}") || { echo "BACKFILL_FAILED:末批后探针读不到"; return 3; }
    if [ "${_rn_last}" != "${UNIFORM_EXPECT}" ]; then
      echo "BACKFILL_FAILED:末批后最老分区仍是 ${_rn_last} 行（应 ${UNIFORM_EXPECT}）——全湖未均一"
      return 1
    fi
    echo "  PHASE0_PROBE 复读：最老分区 = ${_rn_last} 行（= 24 列）⇒ 全湖均一"
  fi

  echo "BACKFILL_OK batch=${_rn_batch} bizday=${_rn_day}（本批完成；**不自动续下一批**，下一批请再调一次，或先 plan 复核）"
  return 0
}

# ══ ⑦ 入口 ═══════════════════════════════════════════════════════════════════════
usage_fail() { echo "用法错：$1" >&2; usage >&2; exit 2; }
usage() {
  cat <<'EOT'
用法：sh backfill-retail-order-line.sh <动作> [参数]

  plan                     五批表 + 每批当前状态（只读）
  guard                    Phase 0 前置守卫（只读；非 19 行 ⇒ 拒绝执行、退出码 3）
  verify [N]               批后判据（只读；N 缺省 = 当前第一个未完成批）
  run [--batch N] [--force] 守卫 → 顺序闸 → 触发 → 等批 → 批后判据（**一次只做一批**）

退出码：0 通过 / 1 判据不通过或拒绝 / 2 用法错 / 3 湖通道不可用。
判据正典：docs/superpowers/specs/2026-09-29-read-side-migration.md §4.0 与 §4 Phase 0/1。
EOT
}

main() {
  [ $# -gt 0 ] || { usage; exit 2; }
  _m_cmd=$1; shift
  case "${_m_cmd}" in
    plan)   cmd_plan "$@" ;;
    guard)  cmd_guard "$@" ;;
    verify)
      _m_n=${1:-}
      if [ -z "${_m_n}" ]; then
        _m_n=$(first_pending_batch) || { echo "BACKFILL_FAILED:读不到湖"; exit 3; }
        [ "${_m_n}" = "0" ] && usage_fail "五批全完成，没有可 verify 的未完成批；显式给批号可复核历史批"
      fi
      cmd_verify "${_m_n}" ;;
    run)    cmd_run "$@" ;;
    -h|--help) usage ;;
    *) usage_fail "未知动作：${_m_cmd}" ;;
  esac
}

main "$@"
