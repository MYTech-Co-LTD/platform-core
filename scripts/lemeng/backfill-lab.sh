#!/bin/sh
# backfill-lab.sh — 回填工具链的**本机 lab**（零生产）：在回环 S3（s3rver）上造一个**混代小湖**，
# 让 `backfill-retail-order-line.sh` **原样**跑它自己的判据。
#
# 为什么要它：Phase 0 守卫 / 批后列数 / 整湖混读三条判据，如果只做「字符串相等」的假测试，
# 就证明不了它们在**真 parquet、真 S3 协议、真 glob、真 hive 分区**上会动。本 lab 验四件事：
#   ① 守卫在「最老仍 18 列」时放行、在「最老已 24 列」时**拒绝**（fail-closed）
#   ② 顺序约束被脚本强制（试乱序 ⇒ 拒绝）
#   ③ 批后判据能真的判出「该批已变 24 列」与「整湖混读仍通」
#   ④ 故意把一个分区做成**缺列** ⇒ 整湖混读**挂**（复现 spec §4.0 不变量被破）⇒ 判据不是空转
#
# ⚠️ **零生产**：只读写 127.0.0.1 上的 s3rver；不连生产网关、不 exec 生产容器、不 seed、不调生产 API。
#    湖的路径形状与生产**逐字相同**（`system_book=/bizday=/hour=` 三级 hive 分区）⇒ 判据语义与生产
#    一致。差异只在「块存储是本地 s3rver，不是天翼 ZOS」——本文件与报告都如实标注这一处。
#
# 用法：sh scripts/lemeng/backfill-lab.sh        （无需参数）
#   需要：python3（标准库）、node/npx（跑 s3rver，首次会下载）、duckdb CLI（含 httpfs）。
#   DUCKDB_BIN 未给时自动找 Duckle 桌面版自带的 duckdb。
#   端口默认 14599/18999/18180/18181（LAB_* 环境变量可覆盖）。
# 退出码：0 = 全部判据通过；1 = 有判据不通过；2 = 环境缺件（跑不起来，**不静默跳过**）。
set -u
REPO_ROOT=${REPO_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
SRC="${REPO_ROOT}/scripts/lemeng/backfill-retail-order-line.sh"
LAB_PY="${REPO_ROOT}/scripts/lemeng/backfill-lab/lab.py"

BUCKET=${LAB_BUCKET:-lab-bucket}
S3_PORT=${LAB_S3_PORT:-14599}
GW_PORT=${LAB_GW_PORT:-18999}
CONSOLE_3120_PORT=${LAB_CONSOLE_3120_PORT:-18180}
CONSOLE_64188_PORT=${LAB_CONSOLE_64188_PORT:-18181}
S3_ENDPOINT="127.0.0.1:${S3_PORT}"
MAIN_LAKE="s3://${BUCKET}/lemeng/retail_order_line"
NEG_LAKE="s3://${BUCKET}/lab-neg/retail_order_line"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/backfill-lab.XXXXXX")
S3DIR="${TMP}/s3"
LOGDIR="${TMP}/logs"
mkdir -p "${S3DIR}/${BUCKET}" "${LOGDIR}"

# ── 环境自检（缺件宁可 exit 2，**不静默跳过**）──────────────────────────────────
command -v python3 >/dev/null 2>&1 || { echo "LAB_ENV_MISSING: python3"; exit 2; }
command -v npx >/dev/null 2>&1 || { echo "LAB_ENV_MISSING: npx（跑 s3rver 用）"; exit 2; }
DUCKDB_BIN=${DUCKDB_BIN:-}
if [ -z "${DUCKDB_BIN}" ]; then
  for _cand in "/Users/duo/Library/Application Support/io.duckle.app/engines/duckdb/duckdb" \
               "$(command -v duckdb 2>/dev/null || true)"; do
    if [ -n "${_cand}" ] && [ -x "${_cand}" ]; then DUCKDB_BIN="${_cand}"; break; fi
  done
fi
[ -n "${DUCKDB_BIN}" ] && [ -x "${DUCKDB_BIN}" ] || { echo "LAB_ENV_MISSING: duckdb 二进制（给 DUCKDB_BIN=…）"; exit 2; }
[ -f "${SRC}" ] || { echo "LAB_ENV_MISSING: 找不到 ${SRC}"; exit 2; }
[ -f "${LAB_PY}" ] || { echo "LAB_ENV_MISSING: 找不到 ${LAB_PY}"; exit 2; }

PASS=0; FAIL=0
ok()   { if [ "$1" = "$2" ]; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$3"; else FAIL=$((FAIL + 1)); printf '  FAIL %s（期望 %s，实得 %s）\n' "$3" "$2" "$1"; fi; }
has()  { case "$2" in *"$3"*) PASS=$((PASS + 1)); printf '  ok   %s\n' "$1";; *) FAIL=$((FAIL + 1)); printf '  FAIL %s —— 输出里没有 [%s]\n      实得（末 3 行）：%s\n' "$1" "$3" "$(printf '%s' "$2" | tail -3 | tr '\n' ' ')";; esac; }
nonzero() { if [ "$1" -ne 0 ]; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$2"; else FAIL=$((FAIL + 1)); printf '  FAIL %s（实得 rc=0）\n' "$2"; fi; }
zero() { if [ "$1" -eq 0 ]; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$2"; else FAIL=$((FAIL + 1)); printf '  FAIL %s（实得 rc=%s）\n' "$2" "$1"; fi; }

PIDS=''
bg() { _bg_name=$1; shift; "$@" >>"${LOGDIR}/${_bg_name}.log" 2>&1 & PIDS="${PIDS} $!"; }
cleanup() {
  for _p in ${PIDS}; do kill "${_p}" 2>/dev/null; done
  sleep 0.3
  for _p in ${PIDS}; do kill -9 "${_p}" 2>/dev/null; done
  if [ "${LAB_KEEP:-0}" = "1" ]; then echo "lab 现场保留在 ${TMP}（LAB_KEEP=1）"; else rm -rf "${TMP}"; fi
}
trap cleanup EXIT INT TERM

wait_port() { # $1=port $2=名字（日志名同）
  _w_i=0
  while [ "${_w_i}" -lt 60 ]; do
    if curl -sS -m 1 -o /dev/null "http://127.0.0.1:$1/healthz" 2>/dev/null; then return 0; fi
    _w_i=$((_w_i + 1)); sleep 0.5
  done
  echo "LAB_START_FAILED: $2（127.0.0.1:$1）60×0.5s 内没起来" >&2
  tail -5 "${LOGDIR}/$2.log" 2>/dev/null >&2
  return 1
}

# ── 驱动脚本的调用封装（lab 通道：本地 duckdb + 回环 S3）────────────────────────
DRIVE() { # $@ = 子命令
  LAKE_CHANNEL=duckdb DUCKDB_BIN="${DUCKDB_BIN}" \
  LAKE_ROOT="${MAIN_LAKE}" \
  LAB_S3_ENDPOINT="${S3_ENDPOINT}" LAB_S3_KEY_ID=S3RVER LAB_S3_SECRET=S3RVER \
  CONSOLE_3120_URL="http://127.0.0.1:${CONSOLE_3120_PORT}" \
  CONSOLE_64188_URL="http://127.0.0.1:${CONSOLE_64188_PORT}" \
  DUCKLE_TOKEN=lab-token \
  BACKFILL_POLL_SECONDS=1 BACKFILL_TIMEOUT_SECONDS=60 \
  sh "${SRC}" "$@"
}
labk() { # $1=lake_root $2..=lab.py 参数（含子命令）
  _lk_root=$1; shift
  python3 "${LAB_PY}" --duckdb-bin "${DUCKDB_BIN}" --lake-root "${_lk_root}" \
    --s3-endpoint "${S3_ENDPOINT}" --key-id S3RVER --secret S3RVER "$@"
}

# 从驱动脚本里**逐字抽出** whole_lake_sql 及其依赖来跑（不复制一份实现 —— 复制即漂移）。
# 手法同 diagnose.test.sh：抽不到就判红，不静默跳过。
FN_FILE="${TMP}/whole_lake_fn.sh"
{ awk '/^lake_root\(\) \{/,/^\}$/' "${SRC}"
  awk '/^lake_glob\(\) \{/,/^\}$/' "${SRC}"
  awk '/^whole_lake_sql\(\) \{/,/^\}$/' "${SRC}"
} > "${FN_FILE}"
[ "$(wc -l < "${FN_FILE}" | tr -d ' ')" -ge 8 ] || { echo "LAB_ENV_MISSING: 抽不到 whole_lake_sql（驱动脚本结构变了？）"; exit 2; }
run_whole_lake() { # $1=lake_root → stdout duckdb 输出；非零 = 读挂了
  (
    LAKE_ROOT="$1"; export LAKE_ROOT
    # shellcheck disable=SC1090
    . "${FN_FILE}"
    printf "CREATE SECRET lab_lake (TYPE S3, KEY_ID 'S3RVER', SECRET 'S3RVER', ENDPOINT '%s', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1');\n%s;\n" \
      "${S3_ENDPOINT}" "$(whole_lake_sql)"
  ) | "${DUCKDB_BIN}" -csv -noheader 2>&1
}

echo "== 起 s3rver（回环 S3；湖根 s3://${BUCKET}/）=="
bg s3rver npx --yes s3rver -d "${S3DIR}" -a 127.0.0.1 -p "${S3_PORT}" --no-vhost-buckets -s
_i=0; while [ "${_i}" -lt 60 ]; do
  curl -sS -m 1 -o /dev/null -X PUT "http://127.0.0.1:${S3_PORT}/${BUCKET}" 2>/dev/null && break
  _i=$((_i + 1)); sleep 0.5
done
curl -sS -m 3 "http://127.0.0.1:${S3_PORT}/${BUCKET}?list-type=2" >/dev/null 2>&1 \
  || { echo "LAB_START_FAILED: s3rver 没起来（127.0.0.1:${S3_PORT}）"; echo "  npx s3rver 是首次会下载的依赖；无网就别跑这个 lab"; exit 2; }

echo "== 造混代小湖（3120 09-23..27 / 64188 09-25..27 = 18 列；两账套 09-28 = 24 列）=="
labk "${MAIN_LAKE}" build-lake || exit 2
labk "${NEG_LAKE}" build-lake || exit 2

echo "== 起 mock 网关 + 两个 mock console（一账套一 console，与生产同形）=="
bg gateway python3 "${LAB_PY}" --duckdb-bin "${DUCKDB_BIN}" --lake-root "${MAIN_LAKE}" \
   --s3-endpoint "${S3_ENDPOINT}" serve-gateway --port "${GW_PORT}" --book 3120
wait_port "${GW_PORT}" gateway || exit 2
for _spec in "3120:${CONSOLE_3120_PORT}" "64188:${CONSOLE_64188_PORT}"; do
  _b=${_spec%%:*}; _p=${_spec#*:}
  bg "console-${_b}" python3 "${LAB_PY}" --duckdb-bin "${DUCKDB_BIN}" --lake-root "${MAIN_LAKE}" \
     --s3-endpoint "${S3_ENDPOINT}" serve-console --port "${_p}" --book "${_b}" --gateway-url "http://127.0.0.1:${GW_PORT}"
  wait_port "${_p}" "console-${_b}" || exit 2
done

echo
echo "== ① Phase 0 守卫 =="
out=$(DRIVE guard); rc=$?
zero "${rc}" "守卫在「最老仍 18 列」时放行（rc=0）"
has "守卫打印探针读数" "${out}" "parquet_schema_rows=19"
has "守卫判定通过" "${out}" "PHASE0_GUARD=PASS"

echo "== ② 顺序闸（试乱序 ⇒ 拒绝）=="
out=$(DRIVE run --batch 5); rc=$?
nonzero "${rc}" "跳批（先跑第 5 批）被拒（rc≠0）"
has "拒绝字面量" "${out}" "BACKFILL_REFUSED:out_of_order"
out=$(DRIVE run --batch 2); rc=$?
nonzero "${rc}" "跳批（先跑第 2 批）被拒（rc≠0）"
has "拒绝字面量" "${out}" "BACKFILL_REFUSED:out_of_order"

echo "== ③ 批还没跑时，批后判据必须判红（判据不是空转）=="
out=$(DRIVE verify 1); rc=$?
nonzero "${rc}" "批 1 未跑 ⇒ 批后判据判红（rc≠0）"
has "判据字面量" "${out}" "BACKFILL_FAILED:batch_schema"

echo "== ④ 乱序的**后果**：最老分区先变 24 列 ⇒ 整湖混读真挂（spec §4.0 / B-3）=="
labk "${NEG_LAKE}" rewrite --book 3120 --day 2026-09-23 >/dev/null || exit 2
out=$(run_whole_lake "${NEG_LAKE}"); rc=$?
nonzero "${rc}" "最老分区先变 24 列 ⇒ 整湖混读挂（非零退出）"
has "报错是 schema mismatch in glob" "${out}" "schema mismatch in glob"
out=$(run_whole_lake "${MAIN_LAKE}"); rc=$?
zero "${rc}" "**对照**：同一查询在主湖（未误序）上仍通"
has "对照读数带最老 bizday" "${out}" "2026-09-23"

echo
echo "== ⑤ 正式回填五批（每批：守卫 → 触发 → 等批 → 批后判据）=="
for _n in 1 2 3 4 5; do
  out=$(DRIVE run --batch "${_n}"); rc=$?
  zero "${rc}" "run batch ${_n} 通过（rc=0）"
  has "batch ${_n} 批后列数判据" "${out}" "BATCH_SCHEMA_OK:"
  has "batch ${_n} 整湖混读判据" "${out}" "WHOLE_LAKE_OK:"
  has "batch ${_n} 收尾字面量" "${out}" "BACKFILL_OK batch=${_n}"
done

echo "== ⑥ 回填完成后：守卫必然拒绝（fail-closed 的设计，不是故障）=="
out=$(DRIVE guard); rc=$?
nonzero "${rc}" "最老分区已 24 列 ⇒ 守卫拒绝（rc≠0）"
has "拒绝字面量" "${out}" "BACKFILL_REFUSED:phase0"
out=$(DRIVE plan); rc=$?
zero "${rc}" "plan 可读（rc=0）"
has "plan 报全完成" "${out}" "next: （全完成）"

echo "== ⑦ 缺列反证（跑完全程后判据仍然有效）：改坏一个后置分区 ⇒ 整湖混读挂 =="
labk "${MAIN_LAKE}" break --book 3120 --day 2026-09-24 --hour 05 >/dev/null || exit 2
out=$(DRIVE verify 5); rc=$?
nonzero "${rc}" "后置分区缺列 ⇒ 批后判据判红（rc≠0）"
has "判在整湖混读面" "${out}" "whole-lake"

echo
echo "== ⑧ mock 网关/console 真的被调用（不是跑了个空壳）=="
gw=$(curl -sS "http://127.0.0.1:${GW_PORT}/stats")
cs=$(curl -sS "http://127.0.0.1:${CONSOLE_3120_PORT}/stats")
_rows=$(printf '%s' "${gw}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["order_rows"])')
_runs=$(printf '%s' "${cs}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runs"])')
ok "$([ "${_rows}" -gt 0 ] && echo yes || echo no)" yes "mock 网关被取过新列（order_rows=${_rows}）"
ok "${_runs}" 5 "3120 的 mock console 收到 5 次回填触发（实得 ${_runs}）"

echo
echo "── lab 结果：PASS=${PASS} FAIL=${FAIL} ──"
[ "${FAIL}" -eq 0 ] || { echo "LAB_FAILED: ${FAIL} 条判据不通过"; exit 1; }
echo "LAB_OK: 全部 ${PASS} 条判据通过（零生产写入）"
