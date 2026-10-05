#!/bin/sh
# recon-preagg.sh — **独立通道对账**（正典 §1.4 第三层）：湖内明细聚合 vs 网关**预聚合端点**，逐店 diff
#
# ── 它补的是哪一格 ────────────────────────────────────────────────────────────
# §1.4 四层里，「独立通道」比的是**另一条通路**（不是同问句重拉，那是自证）；正典点名的源是
# 网关的**预聚合端点**。本脚本就是那条通道的**只读**执行面：同一账套、同一营业日，
#   湖侧 = 明细聚合（逐店 sum(sale_money)，走 pg_duckdb **免凭据**）
#   源侧 = 预聚合端点（该账套的令牌调用）
# 输出逐店 diff + 合计 + 差率，并检查**门店集合是否对齐**。
#
# ⚠️ **第一版只报数、不当闸**：两边的**口径本就不同**（预聚合不含赠品/退货那一套，
#    与湖的明细口径差是**已知族**——3120 上登记的是 +1.15%，64188 上实测正差 ~4%）。
#    ⇒ 本版只对**三件无歧义的事**判红：**源侧漏店**（湖有而源无）/ **源侧调用失败** /
#      **差率超宽阈值**（默认 50%，即灾难级）。**口径对齐（把它做成真闸）是后续一步**，
#      对齐前**别把 `PREAGG_OK` 读成"口径已确认"**。
#
# ── 为什么独立通道要"另一条通路"（别拿网关同问句重拉充数）──────────────────────
# 同问句重拉只能证明「管线忠实执行了自己的问句」，**证明不了问句本身对**。预聚合端点是
# **另一套口径、另一套实现**，它的正差才有诊断价值（指向口径而非抽取）。
#
# 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）：
#   0 = 通过（含"有差但在宽阈值内"——此时打 `PREAGG_DRIFT`）；1 = 判据破；2 = 用法错；3 = 依赖不可用
#   可 grep 字面量：
#     通过：`PREAGG_OK book=<B> bizday=<D> branches=<N> total_lake=… total_pre=… diff=… pct=…`
#     有差：`PREAGG_DRIFT`（同上字段）；失败：`PREAGG_FAILED:<reason>`
#           （usage | pre_call | branch_missing | threshold | lake_unavailable）
#
# 依赖 env：LEMENG_TOKEN_<账套>（本脚本按账套取；容器里该键存在）——缺失时回退到从容器 env 现取。
# 可选 env：BOOK（默认 64188）/ PGDUCK_CONTAINER（默认按名字找）/ PGDUCK_USER（platform）/ PGDUCK_DB（warehouse）
#           PREAGG_ABILITY（默认 nhsoft.report.ai.itemsales.find）/ PREAGG_URL_BASE（默认 https://cloud.nhsoft.cn/agi/api）
#           PREAGG_MAX_PCT（默认 50）/ PREAGG_MAX_BRANCHES（默认 100）/ LAKE_ROOT（默认 s3://<桶>/lemeng/retail_order_line）
#           CONSOLE_CT（默认 lemeng console 容器名，用于回退取令牌）
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

BOOK=${BOOK:-64188}
BIZDAY=${1:-}
PGDUCK_USER=${PGDUCK_USER:-platform}
PGDUCK_DB=${PGDUCK_DB:-warehouse}
PREAGG_ABILITY=${PREAGG_ABILITY:-nhsoft.report.ai.itemsales.find}
PREAGG_URL_BASE=${PREAGG_URL_BASE:-https://cloud.nhsoft.cn/agi/api}
PREAGG_MAX_PCT=${PREAGG_MAX_PCT:-50}
PREAGG_MAX_BRANCHES=${PREAGG_MAX_BRANCHES:-100}
CONSOLE_CT=${CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-${BOOK}}

usage() {
  cat >&2 <<'USAGE'
用法：BOOK=<账套> sh recon-preagg.sh <YYYY-MM-DD>
  逐店比对「湖内明细聚合」与「网关预聚合端点」，输出 diff 与门店集合对齐检查。
  第一版只报数（口径未对齐），仅对 源侧漏店 / 调用失败 / 差率超宽阈值 判红。
退出码：0=通过（可能带 PREAGG_DRIFT）；1=判据破；2=用法错；3=依赖不可用。
USAGE
}

case "$BIZDAY" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "PREAGG_FAILED:usage 需要 YYYY-MM-DD 营业日（收到 '${BIZDAY}'）" >&2; usage; exit 2 ;;
esac

# ── 凭据：优先 env；缺失则从容器 env **运行时**现取（不落命令行、不落文件）──
_tok_var="LEMENG_TOKEN_${BOOK}"
TOKEN=$(eval "printf %s \"\${${_tok_var}:-}\"")
if [ -z "$TOKEN" ]; then
  TOKEN=$(docker inspect "$CONSOLE_CT" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
          | sed -n "s/^${_tok_var}=//p")
fi
[ -n "$TOKEN" ] || { echo "PREAGG_FAILED:lake_unavailable 取不到 ${_tok_var}（env 没有、容器 ${CONSOLE_CT} 也读不到）" >&2; exit 3; }

# ── 湖通道：pg_duckdb（免凭据）——不可用即判红，不静默退化 ──
PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 'pg_duckdb')}
[ -n "$PGDUCK_CONTAINER" ] || { echo "PREAGG_FAILED:lake_unavailable 找不到 pg_duckdb 容器" >&2; exit 3; }
ZOS_BUCKET=${ZOS_BUCKET:-$(docker inspect "$CONSOLE_CT" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ZOS_BUCKET=//p')}
[ -n "$ZOS_BUCKET" ] || { echo "PREAGG_FAILED:lake_unavailable 取不到 ZOS_BUCKET" >&2; exit 3; }
LAKE_ROOT=${LAKE_ROOT:-s3://${ZOS_BUCKET}/lemeng/retail_order_line}

_lake_q() {
  docker exec "$PGDUCK_CONTAINER" psql -U "$PGDUCK_USER" -d "$PGDUCK_DB" -t -A -F, -c \
    "SELECT * FROM duckdb.query(\$\$$1\$\$) AS r" 2>/dev/null
}

# ⚠️ 分组键写成**真列**（不是 `GROUP BY 1`）：输出列是拼接表达式，`GROUP BY 1` 会被当成
#    「按含聚合的表达式分组」⇒ `GROUP BY clause cannot contain aggregates`（实测踩过）。
LAKE_ROWS=$(_lake_q "SELECT r['branch_num']::varchar AS b, round(sum(r['sale_money']),2) AS m FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/bizday=${BIZDAY}/**/*.parquet') r GROUP BY r['branch_num'] ORDER BY 1")
[ -n "$LAKE_ROWS" ] || { echo "PREAGG_FAILED:lake_unavailable 湖侧取数为空（该账套该营业日没有分区？）" >&2; exit 3; }

BRANCHES=$(printf '%s\n' "$LAKE_ROWS" | cut -d, -f1 | tr '\n' ' ' | sed 's/ *$//')
NC=$(printf '%s\n' "$LAKE_ROWS" | wc -l | tr -d ' ')
[ "$NC" -le "$PREAGG_MAX_BRANCHES" ] || { echo "PREAGG_FAILED:usage 湖侧门店数 ${NC} > 单次上限 ${PREAGG_MAX_BRANCHES}（需分批）" >&2; exit 2; }
JSON_BRANCHES=$(printf '%s' "$BRANCHES" | sed 's/ /,/g')

# ── 源通道：预聚合端点 ──
BODY=$(printf '{"bizday_start":"%s","bizday_end":"%s","summary_types":["branch"],"branch_nums":[%s]}' "$BIZDAY" "$BIZDAY" "$JSON_BRANCHES")
PRE_JSON=$(curl -s --max-time 90 -X POST "${PREAGG_URL_BASE}/${PREAGG_ABILITY}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "$BODY" 2>/dev/null)
[ -n "$PRE_JSON" ] || { echo "PREAGG_FAILED:pre_call 预聚合端点无响应" >&2; exit 3; }

# ── 比对（Python 只做解析与算差，网络与凭据都在上面完成了）──
printf '%s\n' "$LAKE_ROWS" > /tmp/_preagg_lake.csv
printf '%s' "$PRE_JSON" > /tmp/_preagg_resp.json
python3 - "$BOOK" "$BIZDAY" "$PREAGG_MAX_PCT" <<'PY'
import json, sys
book, day, maxpct = sys.argv[1], sys.argv[2], float(sys.argv[3])
lake={}
for ln in open('/tmp/_preagg_lake.csv'):
    ln=ln.strip()
    if not ln: continue
    b,m=ln.split(','); lake[int(b)]=float(m)
d=json.load(open('/tmp/_preagg_resp.json'))
code=d.get('code')
if code != 0:
    print('PREAGG_FAILED:pre_call 预聚合端点返回 code=%s msg=%s' % (code, str(d.get('msg'))[:80]))
    sys.exit(3)
rows=((d.get('result') or {}).get('rows')) or []
pre={int(x['branch_num']): float(x.get('sale_money') or 0) for x in rows}
miss=[b for b in lake if b not in pre]          # 湖有、源无 ⇒ **真缺口**
extra=[b for b in pre if b not in lake]
lt=sum(lake.values()); pt=sum(pre.values()); diff=lt-pt
pct=(diff/lt*100.0) if lt else 0.0
sign='+' if diff>=0 else ''
print('PREAGG book=%s bizday=%s branches=%d total_lake=%.2f total_pre=%.2f diff=%s%.2f pct=%s%.2f%%' % (
      book, day, len(lake), lt, pt, sign, diff, sign, pct))
if miss:
    print('PREAGG_FAILED:branch_missing 湖有而源无的门店 %d 家：%s' % (len(miss), sorted(miss)[:20]))
    sys.exit(1)
if extra:
    print('  注：源有而湖无的门店 %d 家（可能是湖该日无销售）：%s' % (len(extra), sorted(extra)[:20]))
if abs(pct) > maxpct:
    print('PREAGG_FAILED:threshold 差率 %s%.2f%% 超阈值 %.1f%%（灾难级，需人看）' % (sign, pct, maxpct))
    sys.exit(1)
print('PREAGG_DRIFT book=%s bizday=%s pct=%s%.2f%%（口径差：**已知族**，对齐前不当闸；见脚本头注）' % (book, day, sign, pct))
print('PREAGG_OK book=%s bizday=%s branches=%d' % (book, day, len(lake)))
PY
_rc=$?
rm -f /tmp/_preagg_lake.csv /tmp/_preagg_resp.json
exit "$_rc"
