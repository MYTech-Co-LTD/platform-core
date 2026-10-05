#!/bin/sh
# recon-preagg.sh — **独立通道对账**（正典 §1.4 第三层）：湖内明细（按**已对齐口径**净化后）vs 网关**预聚合端点**，逐店 diff
#
# ── 它比的是哪一格 ────────────────────────────────────────────────────────────
# §1.4 四层里，「独立通道」比的是**另一条通路**（不是同问句重拉，那是自证）；正典点名的源是
# 网关的**预聚合端点**。本脚本就是那条通道的执行面：同一账套、同一营业日，
#   湖侧 = 明细聚合，**先按已对齐口径净化**（见下）
#   源侧 = 预聚合端点（该账套令牌调用）
# 输出逐店 diff + 合计 + 差率 + **门店集合对齐检查**。
#
# ── 湖侧净额口径（唯一事实源：docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md）──
#   net = Σ(sale_money, state='FINISHED')
#       − 赠品行    |discount_money − order_detail_std_price×quantity| ≤ 0.02（+ 三条件护栏，见下面 GIFT 谓词）
#       − 退货行    order_transaction_type <> 'SALE_ORDER'，且**按原单销售日**归属（order_ref_billno join 回湖）
#       − Σ(order_detail_share_discount)
#
# ⚠️ **2026-10-05 订正**：本脚本**第一版没有这个净化** —— 它直接 `sum(sale_money)` 且**不过滤 state**，
#    于是在 64188 上报出 **+4.15% 的假缺口**。那 4.15% 里约 2/3 是「非 FINISHED 行（CANCELED/REPAID）」，
#    其余是赠品 / 退货 / 分摊折扣。按上面口径净化后，真机 11 天残差落到 **0.0004% ~ 0.001%**（多日实测）。
#    ⇒ 教训：口径早有定案（2026-09-30 spec），**没接上就是自己造了一个假缺口**。
#
# ── 为什么「退货按原单销售日归属」─────────────────────────────────────────────
# 平台报表日 D 的 `return_money` = **原单销售日为 D** 的退货（与退货**何时发生**无关，spec §0）。
# 用**发生日**归属会让晚到的退货落到错的营业日（D 少了、退货日多了）⇒ 必须用 order_ref_billno join 回原单。
# ⚠️ 边界：原单必须也**在湖里**（join 回湖）；原单落在湖的覆盖范围之外的退货会被漏掉（见 spec §3 诚实清单）。
#
# ── 定稿线（settle line）：为什么默认只对 T-3 ─────────────────────────────────
# **退货可能发生在定稿日之后** ⇒ 湖（快照）与平台（活数据）在产线上**永远有时间差**：
# 平台把退货记到原销售日，而那一刻我们的分区早已落盘。所以「今天对昨天的账」天生对不平——那不是缺陷。
#   · 未过定稿线（T-2 及更近）⇒ 源还在变 ⇒ **只报数，不判红**（打 `PREAGG_UNSETTLED`，退出 0）；
#   · 已过定稿线（T-3 及更早）⇒ 残差属**真缺口** ⇒ 判红，交既有闭环 `recon-day-heal.sh`（不平 ⇒ 回填 ⇒ 复验）。
# ⇒ **对 T-3 的数据（且随时可重复）对账是必要的**，本脚本默认就是这个日子。
#
# ── 边界（已实测，2026-10-05）：退货通道有「平台报得出、我们取不到」的部分 ──────────
# 残差恒等于：`diff = −(平台 return_money − 湖可取到的退货) + 未解释项`。实测 64188：
#   · 09-27 / 10-02：平台 1308.00 vs 湖 1309.25；785.40 vs 787.61 ⇒ 两段几乎相消，残差 1~2 元；
#   · 09-26：平台退货比湖**多 +1,560.06** ⇒ 全天残差 −1,568.66 基本全由它构成。
# 那些「多出来的退货」**在本通道取不到**（四条实证）：
#   ① `posorder.find` 官方定义 = 「已结账单查询」（**销售单**）；该店该日只返回 39 单、**全是 SALE_ORDER**，
#      与湖里该店该日的 39 个 order_no **逐一相同**（故排除 time 窗 confound）；
#   ② 跨 09-26~10-05 全量拉取，**没有任何 `order_ref_billno` 指向那几笔被退的销售**；
#   ③ 参数化回填该营业日（24 个窗口全跑、status=ok）后，湖**逐行未变**（4673 行、残差一字不差）；
#   ④ RETAIL 的 AGI 能力面（15 个）**没有零售退货单查询**。
# ⇒ 本脚本**如实打出** `PREAGG_RETGAP`（platform_return / lake_return / gap / unexplained）：
#   残差 100% 有名字，`unexplained` 才是属于我们的面。
#   ⚠️ **别把 `gap` 当我们的缺口去回填**——回填治不了它（③ 已证）；要归零只能拿**退货单的取数途径**
#      （这正是《对账口径确认清单-致乐檬》要的东西，别把它读成"已自主归零"）。
#
# ── 退出码契约（判红靠它；「打印 FAIL 但仍 exit 0」= 假绿）──────────────────────
#   0 = 通过（含「有极小差但在容差内」打 `PREAGG_DRIFT`；含未过定稿线的 `PREAGG_UNSETTLED`）
#   1 = 判据破（`branch_missing` / `threshold`）      2 = 用法错      3 = 依赖不可用
#   可 grep 字面量：
#     通过：`PREAGG_OK book=<B> bizday=<D> branches=<N> total_lake=… total_pre=… diff=… pct=…`
#     未定稿：`PREAGG_UNSETTLED`（同上字段）
#     有极小差：`PREAGG_DRIFT`（同上字段）
#     失败：`PREAGG_FAILED:<reason>`（usage | token | lake_unavailable | pre_call | branch_missing | threshold）
#
# 依赖 env：LEMENG_TOKEN_<账套>（本脚本按账套取；缺失时从 console 容器 env **运行时**现取，不落盘）
# 可选 env：BOOK（默认 64188）/ SETTLE_DAYS（默认 3）
#           PGDUCK_CONTAINER（默认按名字找）/ PGDUCK_USER（platform）/ PGDUCK_DB（warehouse）
#           PREAGG_ABILITY（默认 nhsoft.report.ai.itemsales.find）/ PREAGG_URL_BASE（默认 https://cloud.nhsoft.cn/agi/api）
#           PREAGG_ABS_TOL（默认 1.00 元）/ PREAGG_MAX_PCT（默认 0.01%）/ PREAGG_MAX_BRANCHES（默认 100）
#           LAKE_PREFIX（默认 lemeng/retail_order_line）
#           CONSOLE_CT（默认 lemeng console 容器名，用于回退取令牌 / 桶名）
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
  不给营业日 ⇒ 取 **T-3**（定稿线；正典 §1.4.1）。
  逐店比对「湖内明细按已对齐口径净化后的净额」与「网关预聚合端点」，输出 diff 与门店集合对齐检查。
  未过定稿线的营业日**只报数不判红**（PREAGG_UNSETTLED，退出 0）——源还在变。
退出码：0=通过或未定稿；1=判据破；2=用法错；3=依赖不可用。
USAGE
}

# ── 营业日：默认 T-3（定稿线）──
if [ -z "${BIZDAY}" ]; then
  BIZDAY=$(date -d "$(date +%F) - ${SETTLE_DAYS} days" +%F 2>/dev/null) || {
    echo "PREAGG_FAILED:usage 取不到默认营业日（date -d 不可用？）" >&2; exit 2; }
fi
case "${BIZDAY}" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "PREAGG_FAILED:usage 需要 YYYY-MM-DD 营业日（收到 '${BIZDAY}'）" >&2; usage; exit 2 ;;
esac

# ── 定稿线判定：未过线 ⇒ 只报数（源还在变，判红是噪声）──
TODAY=$(date +%F)
SETTLED=1
_CUT=$(date -d "${TODAY} - ${SETTLE_DAYS} days" +%F 2>/dev/null) || _CUT=""
if [ -n "${_CUT}" ] && [ "${BIZDAY}" \> "${_CUT}" ]; then SETTLED=0; fi

# ── 凭据：优先 env；缺失则从容器 env **运行时**现取（不落命令行、不落文件）──
_tok_var="LEMENG_TOKEN_${BOOK}"
TOKEN=$(eval "printf %s \"\${${_tok_var}:-}\"")
if [ -z "${TOKEN}" ]; then
  TOKEN=$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
          | sed -n "s/^${_tok_var}=//p")
fi
[ -n "${TOKEN}" ] || { echo "PREAGG_FAILED:token 取不到 ${_tok_var}（env 没有、容器 ${CONSOLE_CT} 也读不到）" >&2; exit 3; }

# ── 湖通道：pg_duckdb（免凭据）——不可用即判红，不静默退化 ──
PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 'pg_duckdb')}
[ -n "${PGDUCK_CONTAINER}" ] || { echo "PREAGG_FAILED:lake_unavailable 找不到 pg_duckdb 容器" >&2; exit 3; }
ZOS_BUCKET=${ZOS_BUCKET:-$(docker inspect "${CONSOLE_CT}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ZOS_BUCKET=//p')}
[ -n "${ZOS_BUCKET}" ] || { echo "PREAGG_FAILED:lake_unavailable 取不到 ZOS_BUCKET" >&2; exit 3; }
LAKE_ROOT=${LAKE_ROOT:-s3://${ZOS_BUCKET}/${LAKE_PREFIX}}

_lake_q() {
  docker exec "${PGDUCK_CONTAINER}" psql -U "${PGDUCK_USER}" -d "${PGDUCK_DB}" -t -A -F, -c \
    "SELECT * FROM duckdb.query(\$\$${1}\$\$) AS r" 2>/dev/null
}

# 赠品判别式（spec §0）：折让 = 标准价全额 × 数量 ⇒ 该行分文未收。三条件护栏排除退化命中（std≤0/sale≤0/qty≤0）。
GIFT="r['state']='FINISHED' AND r['order_detail_std_price']>0 AND r['sale_money']>0 AND r['quantity']>0 AND abs(r['discount_money']-r['order_detail_std_price']*r['quantity'])<=0.02"

# ① 当日分区：毛额 / 赠品 / 分摊折扣（逐店）
SQL_DAY="SELECT r['branch_num']::int AS b, round(sum(CASE WHEN r['state']='FINISHED' THEN r['sale_money'] ELSE 0 END),2) AS gross, round(sum(CASE WHEN ${GIFT} THEN r['sale_money'] ELSE 0 END),2) AS gift, round(sum(CASE WHEN r['state']='FINISHED' THEN r['order_detail_share_discount'] ELSE 0 END),2) AS sd FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/bizday=${BIZDAY}/**/*.parquet') r GROUP BY r['branch_num'] ORDER BY 1"
LAKE_DAY=$(_lake_q "${SQL_DAY}")
[ -n "${LAKE_DAY}" ] || { echo "PREAGG_FAILED:lake_unavailable 湖侧取数为空（该账套该营业日没有分区？）" >&2; exit 3; }

# ② 退货：**按原单销售日**归属（order_ref_billno join 回湖，扫全账套分区）——发生日会落错营业日，故必须 join 原单。
SQL_RET="SELECT r.branch_num::int AS b, round(sum(r.sale_money),2) AS ret, count(*) AS n FROM (SELECT x['order_ref_billno'] AS ref, x['sale_money'] AS sale_money, x['branch_num'] AS branch_num FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/**/*.parquet') x WHERE x['state']='FINISHED' AND x['order_transaction_type'] <> 'SALE_ORDER') r JOIN (SELECT DISTINCT y['order_no'] AS ono, y['bizday'] AS bd FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/**/*.parquet') y) o ON r.ref = o.ono WHERE o.bd = DATE '${BIZDAY}' GROUP BY r.branch_num ORDER BY 1"
LAKE_RET=$(_lake_q "${SQL_RET}")

# ③ 门店集合 = 当日有销售 ∪ 当日有退货（退货店可能当日无销售）
BRANCHES=$( { printf '%s\n' "${LAKE_DAY}" | cut -d, -f1; printf '%s\n' "${LAKE_RET}" | cut -d, -f1; } \
            | grep -E '^[0-9]+$' | sort -n -u | tr '\n' ' ' | sed 's/ *$//')
NC=$(printf '%s\n' "${BRANCHES}" | tr ' ' '\n' | grep -c .)
[ "${NC}" -le "${PREAGG_MAX_BRANCHES}" ] || { echo "PREAGG_FAILED:usage 湖侧门店数 ${NC} > 单次上限 ${PREAGG_MAX_BRANCHES}（需分批）" >&2; exit 2; }
JSON_BRANCHES=$(printf '%s' "${BRANCHES}" | sed 's/ /,/g')

# ── 源通道：预聚合端点 ──
BODY=$(printf '{"bizday_start":"%s","bizday_end":"%s","summary_types":["branch"],"branch_nums":[%s]}' "${BIZDAY}" "${BIZDAY}" "${JSON_BRANCHES}")
PRE_JSON=$(curl -s --max-time 90 -X POST "${PREAGG_URL_BASE}/${PREAGG_ABILITY}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${BODY}" 2>/dev/null)
[ -n "${PRE_JSON}" ] || { echo "PREAGG_FAILED:pre_call 预聚合端点无响应" >&2; exit 3; }

# ── 比对（Python 只做解析与算差，网络与凭据都在上面完成了）──
printf '%s\n' "${LAKE_DAY}" > /tmp/_preagg_day.csv
printf '%s\n' "${LAKE_RET}" > /tmp/_preagg_ret.csv
printf '%s' "${PRE_JSON}" > /tmp/_preagg_resp.json
python3 - "${BOOK}" "${BIZDAY}" "${PREAGG_ABS_TOL}" "${PREAGG_MAX_PCT}" "${SETTLED}" <<'PY'
import json, sys
book, day = sys.argv[1], sys.argv[2]
abs_tol, max_pct = float(sys.argv[3]), float(sys.argv[4])
settled = sys.argv[5] == '1'

def rd(path, n):
    d = {}
    try:
        f = open(path)
    except OSError:
        return d
    for ln in f:
        ps = ln.strip().split(',')
        if len(ps) != n or not ps[0].isdigit():
            continue
        d[int(ps[0])] = [float(x) for x in ps[1:]]
    return d

day_rows = rd('/tmp/_preagg_day.csv', 4)   # b, gross, gift, sd
ret_rows = rd('/tmp/_preagg_ret.csv', 3)   # b, ret, n
net = {}
for b in set(list(day_rows) + list(ret_rows)):
    g, gi, sd = day_rows.get(b, [0.0, 0.0, 0.0])
    rt = ret_rows.get(b, [0.0, 0.0])[0]
    net[b] = round(g - gi - sd - rt, 2)

resp = json.load(open('/tmp/_preagg_resp.json'))
if resp.get('code') != 0:
    print('PREAGG_FAILED:pre_call 预聚合端点返回 code=%s msg=%s' % (resp.get('code'), str(resp.get('msg'))[:80]))
    sys.exit(3)
rows = (resp.get('result') or {}).get('rows') or []
pre = {int(x['branch_num']): float(x.get('sale_money') or 0) for x in rows}
pre_ret = round(sum(float(x.get('return_money') or 0) for x in rows), 2)

miss = [b for b in net if b not in pre]        # 湖有、源无 ⇒ **真缺口**
extra = [b for b in pre if b not in net]
lt = round(sum(net.values()), 2)
pt = round(sum(pre.values()), 2)
diff = round(pt - lt, 2)                       # gap = 源 − 湖
pct = (diff / pt * 100.0) if pt else 0.0
sign = '+' if diff >= 0 else ''
tol = max(abs_tol, abs(pt) * max_pct / 100.0)

print('PREAGG book=%s bizday=%s branches=%d total_lake=%.2f total_pre=%.2f diff=%s%.2f pct=%s%.2f%% tol=%.2f'
      % (book, day, len(net), lt, pt, sign, diff, sign, pct, tol))

# ── 残差归因：把「平台的 return_money」与「湖可取到的退货」之差摆出来 ──────────────
# 恒等式：diff = −(平台 return_money − 湖退货) + 未解释项。⇒ 未解释项才是**属于我们的**残差。
# ⚠️ 已实测（2026-10-05）：这些「平台有、取不到」的退货**不在订单通道里** ——
#    posorder.find 对该店该日只返回 39 单、**全是 SALE_ORDER**（与湖的 39 个 order_no 逐一相同，
#    无 time 窗 confound）；跨 10 天无任何 order_ref_billno 指向它；回填 24 窗重跑湖**逐行未变**；
#    RETAIL 的 AGI 面 15 个能力里**没有零售退货单查询**（posorder.find 官方定义 = 「已结账单」= 销售单）。
#    ⇒ 这一段是**源侧通道边界**，不是我们的缺口、也不是口径错。
lake_ret = round(sum(v[0] for v in ret_rows.values()), 2)
ret_gap = round(pre_ret - lake_ret, 2)
unexplained = round(diff + ret_gap, 2)
print('PREAGG_RETGAP book=%s bizday=%s platform_return=%.2f lake_return=%.2f gap=%.2f unexplained=%s%.2f'
      % (book, day, pre_ret, lake_ret, ret_gap, '+' if unexplained >= 0 else '', unexplained))

# 未过定稿线 ⇒ 源仍在变，只报数（判红是噪声；对账必要性见脚本头注「定稿线」）
if not settled:
    print('PREAGG_UNSETTLED book=%s bizday=%s（未过定稿线：源还在变，只报数不判红）' % (book, day))
    sys.exit(0)

if miss:
    print('PREAGG_FAILED:branch_missing 湖有而源无的门店 %d 家：%s' % (len(miss), sorted(miss)[:20]))
    sys.exit(1)
if extra:
    print('  注：源有而湖无的门店 %d 家（当日无销售也无退货）：%s' % (len(extra), sorted(extra)[:20]))
if abs(diff) > tol:
    print('PREAGG_FAILED:threshold 差 %s%.2f 超容差 %.2f（total_pre=%.2f，%s%.4f%%）'
          % (sign, diff, tol, pt, sign, pct))
    sys.exit(1)
if abs(diff) >= 0.005:
    print('PREAGG_DRIFT book=%s bizday=%s diff=%s%.2f（在容差内）' % (book, day, sign, diff))
print('PREAGG_OK book=%s bizday=%s branches=%d' % (book, day, len(net)))
PY
_rc=$?
rm -f /tmp/_preagg_day.csv /tmp/_preagg_ret.csv /tmp/_preagg_resp.json
exit "${_rc}"
