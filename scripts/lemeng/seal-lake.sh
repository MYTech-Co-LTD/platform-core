#!/bin/sh
# seal-lake.sh — 湖的「封版标记」写手 / 校验（正典 docs/architecture.md §5.2 ②③）
#
# ── 它补的是哪一格 ────────────────────────────────────────────────────────────
# 回填跑完之后，「整张表的所有分区是不是都已经是契约那一版」**此前没有任何凭据**。
# 没有凭据的后果是实测过的：**半写的湖会被读者静默读成「完整」**（392 行 vs 完整 796 行，rc=0）
# —— 那比响亮报错危险。本工具把「齐了」写成一份**可断言的凭据**：
#
#   <prefix>/_SCHEMA/v<N>.parquet   ← schema_version / column_fingerprint / columns /
#                                      partitions / read_glob_hits / sealed_at
#
# 读者的 fail-closed 断言（staging 里同 FROM 带一份 read_parquet 到它）读的就是它；
# 标记不在 ⇒ 404 ⇒ **带名字地失败**，而不是把半写的湖当完整的用。
#
# ── 🔴 硬约束：标记绝不能落在读湖 glob 的射程内 ────────────────────────────────
# 实测：标记若与数据同目录，`…/**/*.parquet` 会把它当**数据文件**读进来，结构体被解析成标记的列
# （`Could not find key "sale_money" … Candidate Entries: "sealed_at", "rows_expected"…`）。
# 本工具落点固定 `<prefix>/_SCHEMA/v<N>.parquet`，读者 glob 是 `<prefix>/system_book=*/…`
# ⇒ 结构上不在射程内。**但这一点要自证**：写之前跑一次「用读湖 glob 去 glob 标记自己」，
# 命中必须为 0（并把读数写进标记）——否则哪天有人把落点挪到数据下面，当场红，而不是等读者报怪错。
#
# ── 退出码契约 ────────────────────────────────────────────────────────────────
#   0 = 齐（--seal 时并已落标记）   1 = 不齐（逐分区列出差异）   2 = 用法错   3 = 依赖不可用
#   可 grep 字面量：`SEAL_OK <table> v<N> partitions=<M>` /
#                   `SEAL_UNEVEN <table> v<N> bad=<K>/<M>` / `SEAL_WRITTEN <path>` /
#                   `SEAL_FAILED:<reason>`（usage | deps | no_partitions | probe | write）
#
# 依赖 env：无。桶名与凭据都从 console 容器 env **运行时**现取，**不进宿主命令行、不落文件**。
# 可选 env：BOOK（默认 64188，只用来挑 console 容器）/ CONSOLE_CT / REPO / SCHEMA_ROOT
#           （SCHEMA_ROOT 默认 `s3://<桶>`；给夹具用，可指向本地目录）
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

REPO=${REPO:-/opt/platform-core-data/platform-core}
BOOK=${BOOK:-64188}
CONSOLE_CT=${CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-${BOOK}}
TABLE=${1:-}
MODE=${2:---check}

usage() {
  cat >&2 <<'USAGE'
用法：sh seal-lake.sh <domain>.<table> [--check|--seal]
  --check  只比不写（默认）
  --seal   比齐之后落封版标记 <prefix>/_SCHEMA/v<N>.parquet
退出码：0=齐；1=不齐；2=用法错；3=依赖不可用。
USAGE
}

case "${TABLE}" in
  *.*) ;;
  *) echo "SEAL_FAILED:usage 需要 <domain>.<table>（收到 '${TABLE}'）" >&2; usage; exit 2 ;;
esac
case "${MODE}" in
  --check|--seal) ;;
  *) echo "SEAL_FAILED:usage 未知模式 '${MODE}'" >&2; usage; exit 2 ;;
esac

CONTRACT="${REPO}/contracts/common/${TABLE}.json"
[ -f "${CONTRACT}" ] || { echo "SEAL_FAILED:usage 契约不在：${CONTRACT}" >&2; exit 2; }

# ── 判定（**纯函数**，可被 seal-lake.test.sh 抽出来单测）──────────────────────
# $1 = 表名  $2 = schemaVersion  $3 = 探针 JSON（{"n":分区数,"bad":[[文件,原因],…]}）
# 打印 SEAL_OK / SEAL_UNEVEN 并返回 0 / 1。
seal_verdict() {
  # ⚠️ 程序走 `-c`、数据走 stdin：用 `python3 - <<PY` 会把 heredoc 当**程序**吞掉，
  #    那条 pipe 进来的 JSON 就永远到不了 stdin（本脚本第一版就是这么错的，夹具当场抓住）。
  printf '%s' "$3" | python3 -c '
import json, sys
table, ver = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    n = int(d["n"]); bad = d["bad"]
except Exception:
    print("SEAL_FAILED:probe 探针输出无法解析：%s" % raw[:160].replace("\n", " "))
    sys.exit(2)
if bad:
    print("SEAL_UNEVEN %s v%s bad=%d/%d" % (table, ver, len(bad), n))
    for f, why in bad[:10]:
        print("   %s  %s" % (f, why))
    sys.exit(1)
print("SEAL_OK %s v%s partitions=%d" % (table, ver, n))
' "$1" "$2"
}

# ── 依赖（运行时现取，不进命令行）──
docker inspect "${CONSOLE_CT}" >/dev/null 2>&1 \
  || { echo "SEAL_FAILED:deps console 容器 ${CONSOLE_CT} 不在" >&2; exit 3; }
docker exec "${CONSOLE_CT}" sh -c 'command -v duckdb >/dev/null' 2>/dev/null \
  || { echo "SEAL_FAILED:deps 容器里没有 duckdb" >&2; exit 3; }
if [ -z "${SCHEMA_ROOT:-}" ]; then
  ZOS_BUCKET=$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ZOS_BUCKET=//p')
  [ -n "${ZOS_BUCKET}" ] || { echo "SEAL_FAILED:deps 取不到 ZOS_BUCKET" >&2; exit 3; }
  SCHEMA_ROOT="s3://${ZOS_BUCKET}"
fi

# ── 契约里我们要的：prefix / schemaVersion / 列序 ──
PREFIX=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8"))["layout"]["prefix"])' "${CONTRACT}") \
  || { echo "SEAL_FAILED:usage 契约解析失败：${CONTRACT}" >&2; exit 2; }
SV=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8"))["schemaVersion"])' "${CONTRACT}") \
  || { echo "SEAL_FAILED:usage 契约缺 schemaVersion" >&2; exit 2; }
COLS=$(python3 -c 'import json,sys;print(",".join(c["name"] for c in json.load(open(sys.argv[1],encoding="utf-8"))["columns"]))' "${CONTRACT}") \
  || { echo "SEAL_FAILED:usage 契约缺 columns" >&2; exit 2; }

SEAL_PATH="${SCHEMA_ROOT}/${PREFIX}/_SCHEMA/v${SV}.parquet"
PART_GLOB="${SCHEMA_ROOT}/${PREFIX}/system_book=*/bizday=*/hour=*/all.parquet"
READ_GLOB="${SCHEMA_ROOT}/${PREFIX}/system_book=*/**/*.parquet"

# ── 容器内探针：建 secret（凭据在容器内展开）→ 逐分区 DESCRIBE → 比列序 ────────
# 输出一行 JSON：{"n":分区数,"bad":[[文件,原因],…],"range_hits":读湖glob命中标记的次数}
PROBE=$(docker exec -i -e COLS="${COLS}" -e PART_GLOB="${PART_GLOB}" -e SEAL_PATH="${SEAL_PATH}" \
  "${CONSOLE_CT}" python3 - <<'PY' 2>&1
import json, os, subprocess, sys

def duck(sql):
    pre = ("CREATE OR REPLACE SECRET zos (TYPE S3, KEY_ID %s, SECRET %s, ENDPOINT %s, REGION %s,"
           " URL_STYLE 'path', USE_SSL true);\n") % tuple(
        json.dumps(os.environ[k]) for k in ('ZOS_ACCESS_KEY', 'ZOS_SECRET_KEY', 'ZOS_ENDPOINT', 'ZOS_REGION'))
    p = subprocess.run(['duckdb', '-json', '-noheader'], input=pre + sql, capture_output=True, text=True)
    return p.returncode, (p.stdout or '').strip(), (p.stderr or '').strip()

def rows(out):
    try:
        return json.loads(out or '[]')
    except Exception:
        return []

cols = os.environ['COLS'].split(',')
files = rows(duck("SELECT list(f) AS l FROM (SELECT unnest(glob(%s)) AS f ORDER BY 1);" % json.dumps(os.environ['PART_GLOB']))[1])
files = files[0]['l'] if files and isinstance(files[0], dict) and 'l' in files[0] else []
bad = []
for f in files:
    rc, out, err = duck("SELECT list(column_name) AS c FROM (DESCRIBE SELECT * FROM read_parquet(%s));" % json.dumps(f))
    if rc != 0:
        bad.append([f, 'READ_FAILED: ' + err[:120]]); continue
    r = rows(out)
    got = r[0]['c'] if r and isinstance(r[0], dict) and 'c' in r[0] else None
    if got is None:
        bad.append([f, 'PARSE_FAILED']); continue
    if list(got) != cols:
        miss = [c for c in cols if c not in got]
        extra = [c for c in got if c not in cols]
        bad.append([f, 'COLS_DIFFERS 缺:%s 多:%s (%d vs %d)' % (','.join(miss) or '-', ','.join(extra) or '-', len(got), len(cols))])

# ① 射程自证：用**读湖 glob** 去 glob 标记自己，命中必须为 0
rng = rows(duck("SELECT count(*) AS n FROM glob(%s);" % json.dumps(
    os.environ['SEAL_PATH'].replace('/_SCHEMA/v', '/_SCHEMA/_range_probe_v'))) [1])
hits = rng[0]['n'] if rng and isinstance(rng[0], dict) else -1
print(json.dumps({'n': len(files), 'bad': bad, 'range_hits': hits}))
PY
)

[ -n "${PROBE}" ] || { echo "SEAL_FAILED:probe 探针无输出" >&2; exit 3; }
N=$(printf '%s' "${PROBE}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("n",0))' 2>/dev/null)
[ "${N:-0}" -gt 0 ] 2>/dev/null || { echo "SEAL_FAILED:no_partitions 一条分区都没匹配" >&2; exit 3; }

# ② 判定
_JSON=$(printf '%s' "${PROBE}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps({"n":d["n"],"bad":d["bad"]},ensure_ascii=False))' 2>/dev/null)
[ -n "${_JSON}" ] || { echo "SEAL_FAILED:probe 探针 JSON 提取失败：${PROBE}" >&2; exit 3; }
seal_verdict "${TABLE}" "${SV}" "${_JSON}"
RC=$?
[ "${RC}" -eq 0 ] || exit "${RC}"

[ "${MODE}" = "--seal" ] || exit 0

# ── ③ 落封版标记（幂等覆盖写）──
RANGE_HITS=$(printf '%s' "${PROBE}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("range_hits",-1))')
case "${RANGE_HITS}" in
  0) ;;
  *) echo "SEAL_FAILED:range 标记落在读湖 glob 射程内（命中 ${RANGE_HITS}）—— 硬约束被破坏，拒写" >&2; exit 1 ;;
esac
FP=$(printf '%s' "${COLS}" | shasum -a 256 | cut -d' ' -f1)
NCOLS=$(printf '%s' "${COLS}" | awk -F, '{print NF}')
SEALED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

OUT=$(docker exec -i -e SV="${SV}" -e FP="${FP}" -e NCOLS="${NCOLS}" -e NPART="${N}" -e SEALED_AT="${SEALED_AT}" \
  -e SEAL_PATH="${SEAL_PATH}" "${CONSOLE_CT}" python3 - <<'PY' 2>&1
import json, os, subprocess
pre = ("CREATE OR REPLACE SECRET zos (TYPE S3, KEY_ID %s, SECRET %s, ENDPOINT %s, REGION %s,"
       " URL_STYLE 'path', USE_SSL true);\n") % tuple(
    json.dumps(os.environ[k]) for k in ('ZOS_ACCESS_KEY', 'ZOS_SECRET_KEY', 'ZOS_ENDPOINT', 'ZOS_REGION'))
sql = ("COPY (SELECT %s::INTEGER AS schema_version, %s AS column_fingerprint, %s::INTEGER AS columns,"
       " %s::INTEGER AS partitions, %s AS sealed_at)"
       " TO %s (FORMAT PARQUET);") % (
    os.environ['SV'], json.dumps(os.environ['FP']), os.environ['NCOLS'],
    os.environ['NPART'], json.dumps(os.environ['SEALED_AT']), json.dumps(os.environ['SEAL_PATH']))
p = subprocess.run(['duckdb', '-json', '-noheader'], input=pre + sql, capture_output=True, text=True)
print(p.stdout.strip() or p.stderr.strip())
PY
)
case "${OUT}" in
  *Success*|*true*) echo "SEAL_WRITTEN ${SEAL_PATH}"; exit 0 ;;
  *) echo "SEAL_FAILED:write 落标记失败：${OUT}" >&2; exit 1 ;;
esac
