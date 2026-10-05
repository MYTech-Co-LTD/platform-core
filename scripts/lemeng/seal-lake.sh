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
# ⇒ 结构上不在射程内。**但这件事要自证**：写之前用**读湖 glob** 列出文件、看标记在不在里面
# （读数进标记），并把非 0 当**拒写**理由——否则哪天有人把落点挪到数据下面，当场红，
# 而不是等读者报一个看不懂的怪错。
#
# ── 探针为什么是「一条 SQL 的 UNION ALL」而不是逐个 DESCRIBE ───────────────────
# 实测（558 个分区的那张表）：逐个文件起一次 duckdb ≈ **80 s**；把每个文件的
# `parquet_schema('<file>')` 拼成一条 UNION ALL、**单进程一次跑** ≈ **5.7 s**。
# ⚠️ 两个实测坑：① SQL 里的路径必须用**单引号**字面量——用双引号会被当成**标识符**
# （报 `Referenced column "s3://…" not found in FROM clause`）；② `parquet_schema` 会多出
# **一行根节点**（`duckdb_schema`），比列集时要去掉它（回填脚本说的「19 行 = 18 列 + 1 行根节点」）。
#
# ── 退出码契约 ────────────────────────────────────────────────────────────────
#   0 = 齐（--seal 时并已落标记）   1 = 不齐（逐分区列出差异）   2 = 用法错   3 = 依赖不可用
#   可 grep 字面量：`SEAL_OK <table> v<N> partitions=<M>` /
#                   `SEAL_UNEVEN <table> v<N> bad=<K>/<M>` / `SEAL_WRITTEN <path>` /
#                   `SEAL_FAILED:<reason>`（usage | deps | no_partitions | probe | range | write）
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
# 打印 SEAL_OK / SEAL_UNEVEN 并返回 0 / 1 / 2（探针坏了）。
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

# ── 容器内探针（单进程）──
# 输出一行 JSON：{"n":分区数,"bad":[[文件,原因],…],"range_hits":读湖glob 命中标记的次数}
PROBE=$(docker exec -i -e COLS="${COLS}" -e PART_GLOB="${PART_GLOB}" -e READ_GLOB="${READ_GLOB}" \
  -e SEAL_PATH="${SEAL_PATH}" "${CONSOLE_CT}" python3 - <<'PY' 2>&1
import json, os, subprocess, sys

def lit(s):
    # SQL 字符串字面量：**必须单引号**。双引号在 DuckDB 里是标识符（实测报
    # `Referenced column "s3://…" not found in FROM clause`）。
    return "'" + str(s).replace("'", "''") + "'"

PRE = ("CREATE OR REPLACE SECRET zos (TYPE S3, KEY_ID %s, SECRET %s, ENDPOINT %s, REGION %s,"
       " URL_STYLE 'path', USE_SSL true);\n") % tuple(
    lit(os.environ[k]) for k in ('ZOS_ACCESS_KEY', 'ZOS_SECRET_KEY', 'ZOS_ENDPOINT', 'ZOS_REGION'))

def duck(sql):
    """跑一条 SQL。返回 (rows, err)；rows 是**扁平化**的字典列表（跳过 Success 行）。

    ⚠️ DuckDB `-json` 的多行输出是**两种形状混在一起**（实测，别按一种解）：
      第 1 行是 `[{...}]`（数组），其后的行是**裸对象** `{...}`，一行一个；
      另外 `CREATE SECRET` 会先吐一行 `[{"Success":true}]`。
    只取「最后一行」或只按数组解，都会**静默拿到 0 行**（本脚本第一版就是这么错的：
    探针报 `SCHEMA_PROBE_INCOMPLETE: 只拿到 0/558 个文件`，而查询本身是成功的）。
    """
    p = subprocess.run(['duckdb', '-json', '-noheader'], input=PRE + sql, capture_output=True, text=True)
    if p.returncode != 0:
        return None, (p.stderr or '').strip()
    rows = []
    for line in (p.stdout or '').split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        for it in (obj if isinstance(obj, list) else [obj]):
            if isinstance(it, dict) and 'Success' not in it:
                rows.append(it)
    return rows, ''

OUT = {'n': 0, 'bad': [], 'range_hits': -1}

# ① 射程自证：用**读湖 glob** 列文件，看封版标记在不在里面（必须 0）
arr, err = duck("SELECT count(*) AS n FROM glob(%s) AS g WHERE g.file = %s;" % (lit(os.environ['READ_GLOB']), lit(os.environ['SEAL_PATH'])))
if arr is None:
    print(json.dumps({'n': 0, 'bad': [[os.environ['SEAL_PATH'], 'RANGE_PROBE_FAILED: ' + err[:140]]], 'range_hits': -1}))
    sys.exit(0)
OUT['range_hits'] = int(arr[0]['n'])

# ② 单进程取全部文件的列集（UNION ALL of parquet_schema）
arr, err = duck("SELECT list(file) AS l FROM glob(%s);" % lit(os.environ['PART_GLOB']))
if arr is None:
    print(json.dumps({'n': 0, 'bad': [[os.environ['PART_GLOB'], 'GLOB_FAILED: ' + err[:140]]], 'range_hits': OUT['range_hits']}))
    sys.exit(0)
files = arr[0]['l'] if arr else []
OUT['n'] = len(files)
if files:
    parts = ["SELECT %s AS f, list(name) AS c FROM parquet_schema(%s)" % (lit(f), lit(f)) for f in files]
    arr, err = duck(' UNION ALL '.join(parts) + ';')
    if arr is None:
        OUT['bad'].append([os.environ['PART_GLOB'], 'SCHEMA_PROBE_FAILED: ' + err[:160]])
    else:
        cols = os.environ['COLS'].split(',')
        got = {r['f']: r['c'] for r in arr if 'f' in r and 'c' in r}
        if len(got) != len(files):
            OUT['bad'].append([os.environ['PART_GLOB'], 'SCHEMA_PROBE_INCOMPLETE: 只拿到 %d/%d 个文件' % (len(got), len(files))])
        for f in files:
            if f not in got:
                continue
            # parquet_schema 多一行根节点（duckdb_schema）——比列集前去掉
            names = [x for x in got[f] if x != 'duckdb_schema']
            if names != cols:
                miss = [c for c in cols if c not in names]
                extra = [c for c in names if c not in cols]
                OUT['bad'].append([f, 'COLS_DIFFERS 缺:%s 多:%s (%d vs %d)' % (','.join(miss) or '-', ','.join(extra) or '-', len(names), len(cols))])
print(json.dumps(OUT))
PY
)

[ -n "${PROBE}" ] || { echo "SEAL_FAILED:probe 探针无输出" >&2; exit 3; }
N=$(printf '%s' "${PROBE}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("n",0))' 2>/dev/null)
case "${N:-0}" in ''|0) echo "SEAL_FAILED:no_partitions 一条分区都没匹配：${PART_GLOB}" >&2; exit 3 ;; esac

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

OUT=$(docker exec -i -e SV="${SV}" -e FP="${FP}" -e NCOLS="${NCOLS}" -e NPART="${N}" \
  -e RANGE_HITS="${RANGE_HITS}" -e SEALED_AT="${SEALED_AT}" -e SEAL_PATH="${SEAL_PATH}" \
  "${CONSOLE_CT}" python3 - <<'PY' 2>&1
import json, os, subprocess

def lit(s):
    return "'" + str(s).replace("'", "''") + "'"

PRE = ("CREATE OR REPLACE SECRET zos (TYPE S3, KEY_ID %s, SECRET %s, ENDPOINT %s, REGION %s,"
       " URL_STYLE 'path', USE_SSL true);\n") % tuple(
    lit(os.environ[k]) for k in ('ZOS_ACCESS_KEY', 'ZOS_SECRET_KEY', 'ZOS_ENDPOINT', 'ZOS_REGION'))
sql = ("COPY (SELECT %s::INTEGER AS schema_version, %s AS column_fingerprint, %s::INTEGER AS columns,"
       " %s::INTEGER AS partitions, %s::INTEGER AS read_glob_hits, %s AS sealed_at)"
       " TO %s (FORMAT PARQUET);") % (
    os.environ['SV'], lit(os.environ['FP']), os.environ['NCOLS'], os.environ['NPART'],
    os.environ['RANGE_HITS'], lit(os.environ['SEALED_AT']), lit(os.environ['SEAL_PATH']))
p = subprocess.run(['duckdb', '-json', '-noheader'], input=PRE + sql, capture_output=True, text=True)
print((p.stdout or '').strip() or (p.stderr or '').strip())
PY
)
case "${OUT}" in
  *Success*|*true*) echo "SEAL_WRITTEN ${SEAL_PATH}"; exit 0 ;;
  *) echo "SEAL_FAILED:write 落标记失败：${OUT}" >&2; exit 1 ;;
esac
