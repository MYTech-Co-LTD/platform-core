#!/bin/sh
# recon-preagg.sh — **独立通道对账**（正典 §1.4 第三层）：湖内明细（按**已对齐口径**净化后）vs 网关**预聚合端点**，逐店 diff
#
# ── 它比的是哪一格 ────────────────────────────────────────────────────────────
# §1.4 四层里，「独立通道」比的是**另一条通路**（同问句重拉只能自证）；正典点名的源是网关的**预聚合端点**。
#   湖侧 = 明细聚合，**先按已对齐口径净化**（见下）——全程走 pg_duckdb，**免凭据**
#   源侧 = 预聚合端点（该账套令牌调用）
# 输出逐店 diff + 合计 + 差率 + 门店集合对齐检查。
#
# ── 湖侧净额口径（唯一事实源：issue #430 的取证 + docs/architecture.md §5.2）──────
#   对**每个订单**先归并，再按「送出半边」计入：
#
#     net(店, 营业日 D) = Σ_订单 [ (Σ非赠品行额 + order_total_money) / 2 ] − Σ(order_detail_share_discount)
#     只收 state='FINISHED' 且 order_transaction_type='SALE_ORDER' 的订单
#     赠品判定：order_detail_std_price>0 AND sale_money>0 AND quantity>0
#               AND abs(discount_money − order_detail_std_price×quantity) ≤ 0.02
#
#   ⚠️ **不扣退货单**：`order_transaction_type <> 'SALE_ORDER'` 的单**本来就不进 gross**，
#      平台的 sale_money 也**不冲减**它（2026-09-30 的 spec 把这条理解反了 —— 那版规则已撤）。
#   ⚠️ **同一张 SALE_ORDER 里可能装着换货的退回行**（礼盒↔散货）：平台只算「送出半边」，
#      等价换货（总额 0）⇒ Σ/2；差价换货（总额=净补差）⇒ (Σ+总额)/2。**这就是 order_total_money 的用途**
#      （2026-10-05 起湖里已有这一列，故本脚本能**完全自算**、不必回网关取总额）。
#   ⚠️ 逐订单归并**不能省**：按行算 `(行额+总额)/2` 会把「总额 × 行数」加进去 ⇒ 系统性多算。
#
#   真机验证：4 天 × 13 店 = 52 组，差全部 **0.00**。
#
# ── 定稿线（settle line）：为什么默认只对 T-3 ─────────────────────────────────
# 退货**可能发生在定稿日之后** ⇒ 湖（快照）与平台（活数据）永远有时间差。未过线的营业日**源还在变**，
# 此时判红＝噪声。默认对 **T-3 及更早**；未过线的只**报数**（`PREAGG_UNSETTLED`，退出 0）。
# 过线后仍不平 ⇒ 真缺口 ⇒ 交既有闭环 `recon-day-heal.sh`（不平⇒回填⇒复验）。
#
# ── 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）──────────────────────
#   0 = 通过（未过定稿线的也算通过）    1 = 判据破（branch_missing / threshold）
#   2 = 用法错                          3 = 依赖不可用
#   可 grep 字面量：
#     通过：`PREAGG_OK book=<B> bizday=<D> branches=<N> total_lake=… total_pre=… diff=… pct=…`
#     未定稿：`PREAGG_UNSETTLED`（同上字段）   有极小差：`PREAGG_DRIFT`（同上字段）
#     失败：`PREAGG_FAILED:<reason>`（usage | token | lake_unavailable | pre_call | branch_missing | threshold）
#
# 依赖 env：LEMENG_TOKEN_<账套>（本脚本按账套取；缺失时从 console 容器 env **运行时**现取，不落盘）
# 可选 env：BOOK（默认 64188）/ SETTLE_DAYS（默认 3）/ PGDUCK_CONTAINER / PGDUCK_USER / PGDUCK_DB
#           PREAGG_ABILITY / PREAGG_URL_BASE / PREAGG_ABS_TOL（默认 1.00）/ PREAGG_MAX_PCT（默认 0.01）
#           PREAGG_MAX_BRANCHES（默认 100）/ LAKE_PREFIX / CONSOLE_CT
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

BOOK=${BOOK:-64188}
BIZDAY=${1:-}
SETTLE_DAYS=${SETTLE_DAYS:-3}
PGDUCK_USER=${PGDUCK_USER:-platform}
PGDUCK_DB=${PGDUCK_DB:-warehouse}
PREAGG_ABILITY=${PREAGG_ABILITY:-nhsoft.report.ai.itemsales.find}
PREAGG_URL_BASE=${PREAGG_URL_BASE:-https://cloud.nhsoft.cn/agi/api}
PREAGG_ABS_TOL=${PREAGG_ABS_TOL:-1.00}
PREAGG_MAX_PCT=${PREAGG_MAX_PCT:-0.01}
PREAGG_MAX_BRANCHES=${PREAGG_MAX_BRANCHES:-100}
LAKE_PREFIX=${LAKE_PREFIX:-lemeng/retail_order_line}
CONSOLE_CT=${CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-${BOOK}}

usage() {
  cat >&2 <<'USAGE'
用法：BOOK=<账套> [SETTLE_DAYS=3] sh recon-preagg.sh [<YYYY-MM-DD>]
  不给营业日 ⇒ 取 **T-3**（定稿线）。逐店比对「湖内明细按已对齐口径净化后的净额」与「网关预聚合端点」。
  未过定稿线的营业日只报数不判红（PREAGG_UNSETTLED，退出 0）——源还在变。
退出码：0=通过或未定稿；1=判据破；2=用法错；3=依赖不可用。
USAGE
}

if [ -z "${BIZDAY}" ]; then
  BIZDAY=$(date -d "$(date +%F) - ${SETTLE_DAYS} days" +%F 2>/dev/null) || {
    echo "PREAGG_FAILED:usage 取不到默认营业日（date -d 不可用？）" >&2; exit 2; }
fi
case "${BIZDAY}" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "PREAGG_FAILED:usage 需要 YYYY-MM-DD 营业日（收到 '${BIZDAY}'）" >&2; usage; exit 2 ;;
esac

TODAY=$(date +%F)
SETTLED=1
_CUT=$(date -d "${TODAY} - ${SETTLE_DAYS} days" +%F 2>/dev/null) || _CUT=""
if [ -n "${_CUT}" ] && [ "${BIZDAY}" \> "${_CUT}" ]; then SETTLED=0; fi

# ── 凭据：优先 env；缺失则从容器 env **运行时**现取（不落命令行、不落文件）──
# ⚠️ **两个 console 的变量名不一样**（服务 env 实测）：64188 用 `LEMENG_TOKEN_64188`、
#    3120 用**不带后缀**的 `LEMENG_TOKEN`。只认带后缀那一个 ⇒ 3120 上会报
#    「取不到令牌」而看起来像"没权限"，其实只是名字不同。
_tok_var="LEMENG_TOKEN_${BOOK}"
TOKEN=$(eval "printf %s \"\${${_tok_var}:-}\"")
if [ -z "${TOKEN}" ]; then
  TOKEN=$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
          | sed -n "s/^${_tok_var}=//p")
fi
if [ -z "${TOKEN}" ]; then
  TOKEN=$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
          | sed -n 's/^LEMENG_TOKEN=//p')
fi
[ -n "${TOKEN}" ] || { echo "PREAGG_FAILED:token 取不到 ${_tok_var} 或 LEMENG_TOKEN（env 没有、容器 ${CONSOLE_CT} 也读不到）" >&2; exit 3; }

PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 'pg_duckdb')}
[ -n "${PGDUCK_CONTAINER}" ] || { echo "PREAGG_FAILED:lake_unavailable 找不到 pg_duckdb 容器" >&2; exit 3; }
ZOS_BUCKET=${ZOS_BUCKET:-$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ZOS_BUCKET=//p')}
[ -n "${ZOS_BUCKET}" ] || { echo "PREAGG_FAILED:lake_unavailable 取不到 ZOS_BUCKET" >&2; exit 3; }
LAKE_ROOT=${LAKE_ROOT:-s3://${ZOS_BUCKET}/${LAKE_PREFIX}}

_lake_q() {
  docker exec "${PGDUCK_CONTAINER}" psql -U "${PGDUCK_USER}" -d "${PGDUCK_DB}" -t -A -F, -c \
    "SELECT * FROM duckdb.query(\$\$${1}\$\$) AS r" 2>/dev/null
}

# 赠品判别式（见头注）：折让 = 标准价全额 × 数量 ⇒ 该行分文未收。三条件护栏排除退化命中。
GIFT="r['state']='FINISHED' AND r['order_detail_std_price']>0 AND r['sale_money']>0 AND r['quantity']>0 AND abs(r['discount_money']-r['order_detail_std_price']*r['quantity'])<=0.02"

# 湖侧净额：**先逐订单归并**（不能按行算——那会把「总额 × 行数」加进去），再 (Σ非赠品 + 总额)/2 − 分摊折扣。
SQL_LAKE="WITH per_order AS (SELECT r['branch_num']::int AS b, r['order_no'] AS o, sum(CASE WHEN ${GIFT} THEN 0 ELSE r['sale_money'] END) AS ng, max(r['order_total_money']) AS tot, sum(r['order_detail_share_discount']) AS sd FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/bizday=${BIZDAY}/**/*.parquet') r WHERE r['state']='FINISHED' AND r['order_transaction_type']='SALE_ORDER' GROUP BY 1, 2) SELECT b, round(sum((ng + tot) / 2 - sd), 2) AS net FROM per_order GROUP BY b ORDER BY b"
LAKE_ROWS=$(_lake_q "${SQL_LAKE}")
[ -n "${LAKE_ROWS}" ] || { echo "PREAGG_FAILED:lake_unavailable 湖侧取数为空（该账套该营业日没有分区？）" >&2; exit 3; }

BRANCHES=$(printf '%s\n' "${LAKE_ROWS}" | cut -d, -f1 | tr '\n' ' ' | sed 's/ *$//')
NC=$(printf '%s\n' "${BRANCHES}" | tr ' ' '\n' | grep -c .)
[ "${NC}" -le "${PREAGG_MAX_BRANCHES}" ] || { echo "PREAGG_FAILED:usage 湖侧门店数 ${NC} > 单次上限 ${PREAGG_MAX_BRANCHES}（需分批）" >&2; exit 2; }
JSON_BRANCHES=$(printf '%s' "${BRANCHES}" | sed 's/ /,/g')

BODY=$(printf '{"bizday_start":"%s","bizday_end":"%s","summary_types":["branch"],"branch_nums":[%s]}' "${BIZDAY}" "${BIZDAY}" "${JSON_BRANCHES}")
PRE_JSON=$(curl -s --max-time 90 -X POST "${PREAGG_URL_BASE}/${PREAGG_ABILITY}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${BODY}" 2>/dev/null)
[ -n "${PRE_JSON}" ] || { echo "PREAGG_FAILED:pre_call 预聚合端点无响应" >&2; exit 3; }

printf '%s\n' "${LAKE_ROWS}" > /tmp/_preagg_lake.csv
printf '%s' "${PRE_JSON}" > /tmp/_preagg_resp.json
python3 - "${BOOK}" "${BIZDAY}" "${PREAGG_ABS_TOL}" "${PREAGG_MAX_PCT}" "${SETTLED}" <<'PY'
import json, sys
book, day = sys.argv[1], sys.argv[2]
abs_tol, max_pct = float(sys.argv[3]), float(sys.argv[4])
settled = sys.argv[5] == '1'

def rd(path):
    d = {}
    try:
        f = open(path)
    except OSError:
        return d
    for ln in f:
        ps = ln.strip().split(',')
        if len(ps) != 2 or not ps[0].lstrip('-').isdigit():
            continue
        d[int(ps[0])] = float(ps[1])
    return d

net = rd('/tmp/_preagg_lake.csv')
resp = json.load(open('/tmp/_preagg_resp.json'))
if resp.get('code') != 0:
    print('PREAGG_FAILED:pre_call 预聚合端点返回 code=%s msg=%s' % (resp.get('code'), str(resp.get('msg'))[:80]))
    sys.exit(3)
pre = {int(x['branch_num']): float(x.get('sale_money') or 0)
       for x in ((resp.get('result') or {}).get('rows') or [])}

miss = [b for b in net if b not in pre]
extra = [b for b in pre if b not in net]
lt = round(sum(net.values()), 2)
pt = round(sum(pre.values()), 2)
diff = round(pt - lt, 2)
pct = (diff / pt * 100.0) if pt else 0.0
sign = '+' if diff >= 0 else ''
tol = max(abs_tol, abs(pt) * max_pct / 100.0)

print('PREAGG book=%s bizday=%s branches=%d total_lake=%.2f total_pre=%.2f diff=%s%.2f pct=%s%.2f%% tol=%.2f'
      % (book, day, len(net), lt, pt, sign, diff, sign, pct, tol))

if not settled:
    print('PREAGG_UNSETTLED book=%s bizday=%s（未过定稿线：源还在变，只报数不判红）' % (book, day))
    sys.exit(0)

if miss:
    print('PREAGG_FAILED:branch_missing 湖有而源无的门店 %d 家：%s' % (len(miss), sorted(miss)[:20]))
    sys.exit(1)
if extra:
    print('  注：源有而湖无的门店 %d 家（当日无销售）：%s' % (len(extra), sorted(extra)[:20]))
if abs(diff) > tol:
    print('PREAGG_FAILED:threshold 差 %s%.2f 超容差 %.2f（total_pre=%.2f，%s%.4f%%）'
          % (sign, diff, tol, pt, sign, pct))
    sys.exit(1)
if abs(diff) >= 0.005:
    print('PREAGG_DRIFT book=%s bizday=%s diff=%s%.2f（在容差内）' % (book, day, sign, diff))
print('PREAGG_OK book=%s bizday=%s branches=%d' % (book, day, len(net)))
PY
_rc=$?
rm -f /tmp/_preagg_lake.csv /tmp/_preagg_resp.json
exit "${_rc}"
