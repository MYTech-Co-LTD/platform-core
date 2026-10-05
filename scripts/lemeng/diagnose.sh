#!/bin/sh
# diagnose.sh — 乐檬**只读**诊断工具（替代 `run-retail-day.sh` 的只读形：`recon` / `rb` / `identity`）
#
# 用法（在**数据面机宿主**上跑；秘密值来自 job env——本脚本只读不写，任何输出都不回显值）：
#   sh diagnose.sh recon <H>          # 对账（#260 裁决口径，只读）：该 hour 湖分区 vs 网关当刻累计
#   sh diagnose.sh rb "<duckdb SQL>"  # 容器内 duckdb 只读 SQL 口（**带护栏**：写面关键字一律拒）
#   sh diagnose.sh identity           # 身份自证：凭据↔账套 / 门店清单↔账套（fail-loud；#205）
#
# ── 为什么有这个文件（它与 run-retail-day.sh 的关系）──────────────────────────────
# 采集形（window/windows/tick/dim）已由 L0/L1 管线接管，`run-retail-day.sh` 整体进入退役批；
# 但它的**只读形**是正典指定的工具（`DELIVERY.md` §3 判据 2 点名 `recon <H>`，容差 0），
# 无替代即废 = 自断手脚。本文件就是那个替代面：**只搬只读形，一行采集形都不搬**。
#
# 设计正典：`docs/superpowers/specs/2026-09-29-diagnostic-tool-replacement.md`（§5.1 的 P1–P7 裁决）。
# 落地映射见 `deploy/data-plane-manifest.txt`（`scripts/lemeng/diagnose.sh` → `/opt/lemeng-diagnose.sh`）。
#
# **故意不搬**（逐条理由见 spec §3.4，别"补全"）：
#   · window / windows / tick / dim —— 采集形，归 L0/L1；
#   · idem3 / envfile —— **它们是写形**（idem3 三跑写湖、envfile 写宿主 .env），与「只读工具」定义冲突；
#   · listing / agg / branches / probe / diag / drift —— P5 裁决「最小集」，本批不搬；
#   · `OPS_*` 观测投递 / `notify_fail` EXIT trap —— 观测与告警面归采集/引擎；顺带消掉
#     「只读工具判红会发企微通知」这个意外外向面。
#
# ── 湖侧**两条并列通道**（P3 裁决：「换通道复核」，别复用被测方的通路）────────────────
#   通道 A `rb`：`docker compose run --rm duckle` + `readback-helper.sh`，凭据 `ZOS_*`
#                ——**与采集侧同源**，故它自己不是"独立通道"；
#   通道 B `pg_duckdb`：`docker exec <pg_duckdb> psql` → `duckdb.query($$ … $$)`，**免凭据**
#                （实例内已配 S3 secret，实测 2026-09-29 与 A 逐字相等）。
#   两条跑的是**同一份 SQL**（同一个构造器 `lake_read_sql`）——换的是通道，不是问句。
#   ⚠️ 通道 B **不可用即判红**（`RECON_FAILED:cross_unavailable`）：静默退化回单通道 = 把
#      「换通道复核」这条正典要求落空。宁可红，不许静默退化（本仓一贯口径）。
#
# 退出码契约（job/巡检据此判红；「打印 FAIL 但仍 exit 0」= 假绿，等于没验）：
#   0 = 该模式全部验证项通过；非 0 = 至少一项验证失败。失败字面量可 grep：
#   recon：RECON_FAILED:lake|gateway|rows|batches|hour|hour_open|cross|cross_unavailable
#          （前六个是 #260 契约的**逐字保留**，后两个是本工具新增的「换通道复核」面）；
#          通过时打 `RECON_OK hour=<H> rows=<N> batches=<N>`（逐字保留，执行单/巡检靠它）。
#   rb：写面关键字 ⇒ `RB_REJECTED:` + exit 2；引擎非零 ⇒ `RB_FAILED:` + exit 1；
#       输出超过 `RB_MAX_ROWS` ⇒ `RB_TRUNCATED:` + exit 3（**显式**截断，绝不静默丢行）。
#   identity：`ASSERT_FAIL:` + 非零；通过打 `IDENTITY_ASSERT=PASS`。
#   usage/未知模式：exit 2。
#
# 依赖 env: LEMENG_TOKEN / ZOS_BUCKET / ZOS_ENDPOINT / ZOS_REGION / ZOS_ACCESS_KEY / ZOS_SECRET_KEY /
#           BRANCH_NUMS / SYSTEM_BOOK（默认 3120）——与 run-retail-day.sh 逐字相同（不新造凭据通路）。
#           BIZDAY 不传时按 **Asia/Shanghai 日历日的昨天** 推（显式钉 TZ，不继承系统 TZ）。
# 可选 env: REPO（检出根，默认 /opt/platform-core-data/platform-core）、
#           RB_MAX_ROWS（rb 输出行数上限，默认 200）、
#           PGDUCK_CONTAINER（pg_duckdb 容器名，默认按 `docker ps` 名字后缀自动定位）、
#           PGDUCK_USER / PGDUCK_DB（默认 platform / warehouse，非密钥，与 data-compose 默认同值）、
#           RECON_GW_URL（网关端点，默认生产网关）、LEMENG_AGI_URL（whoami 端点，默认生产网关）。
#
# ⚠️ 本脚本**只在宿主上跑**（它要起 compose 一次性容器、要 docker exec）。
#    容器内（`LEMENG_IN_CONTAINER=1`）没有对应实现——那是采集形的调度面，本工具不进去。
#    `$VAR` 紧跟中文处一律写 `${VAR}`：本机 `/bin/sh`（bash 3.2）会把全角字符吃进变量名
#    （实测，见 run-retail-day.sh 的同款注释）——全脚本按此纪律书写。
set -u
REPO=${REPO:-/opt/platform-core-data/platform-core}
COMPOSE="docker compose -f ${REPO}/deploy/data-compose.yml"
# 回读 helper 的**独立 manifest 条目**（${REPO}/lemeng-readback.sh 0755）——本工具沿用，不改它。
# ⚠️ 这行**不要**写成「带默认值展开」的形态：`check-data-plane-lock` 的 `$REPO` 引用提取器是纯文本的，
#    紧跟路径的右花括号会被一并吃进路径 ⇒ 落地路径集合里匹配不上 ⇒ 该守卫判红（本文件落地当天实测）。
RB_HELPER=$REPO/lemeng-readback.sh
SYSTEM_BOOK=${SYSTEM_BOOK:-3120}

# 营业日 = Asia/Shanghai 日历日的昨天（同 run-retail-day.sh：显式钉 TZ，不让运行环境偶然决定正确性）。
# 只有 `recon` 消费它（`rb` / `identity` 不需要）⇒ 形状断言只对 recon 生效，见分支内。
BIZDAY=${BIZDAY:-}
if [ -z "$BIZDAY" ]; then
  BIZDAY=$(TZ=Asia/Shanghai date -d yesterday +%Y-%m-%d 2>/dev/null) || BIZDAY=''
  [ -n "$BIZDAY" ] || BIZDAY=$(TZ=Asia/Shanghai date -v-1d +%Y-%m-%d 2>/dev/null) || BIZDAY=''
fi
export BIZDAY

# ── 启动自证（#205；逐字沿用 run-retail-day.sh 的判据，只把「拒绝写湖」措辞改成「拒绝采信」）──
# 「这家店本来就没单」与「账套/凭据配错了」在数据面上**都是 0 行、长得一模一样** ⇒ 开跑前自证
# 才能把二者从根上分开。对账尤其需要它：错账套的对账 = 白比。
AGI_URL=${LEMENG_AGI_URL:-https://cloud.nhsoft.cn/agi/mcp}

whoami_probe() { # 拉 whoami 到 /tmp/whoami.json；**传输层**失败（网络 / HTTP 非 200）非零
  # 不用 `-f`：`-f` 会连 body 一起丢掉，而 4xx/5xx 的 body 恰是排障要看的 —— 改用 `-w` 取状态码自己判。
  code=$(curl -sS --max-time 20 -o /tmp/whoami.json -w '%{http_code}' -X POST "$AGI_URL" \
    -H "Authorization: Bearer $LEMENG_TOKEN" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' \
    2>>/tmp/whoami.err) || return 1
  [ "$code" = "200" ] || { echo "whoami HTTP $code" >> /tmp/whoami.err; return 1; }
  return 0
}

whoami_verdict() { # 读 /tmp/whoami.json 判定；通过 exit 0，否则打印 ASSERT_FAIL: 并 exit 1
  # 判据两条（#205 定）：① 凭据账套 == SYSTEM_BOOK；② 配置门店 ⊆ 本账套可见门店。
  # ② 的方向不能反：账套可见门店里**有多余**是正常的（99 是熊喵中央店，采集清单故意排除），
  # 「配了一个本账套看不见的店」才是错配信号。
  python3 - "$SYSTEM_BOOK" "$BRANCH_NUMS" <<'PY'
import json, re, sys
sb, cfg_raw = sys.argv[1], sys.argv[2]
m = re.findall(r'^data: (.*)$', open('/tmp/whoami.json').read(), re.M)
if not m:
    print('ASSERT_FAIL: whoami 响应里没有 data: 行（网关形状变了？）'); raise SystemExit(1)
d = json.loads(m[-1])
if 'error' in d:
    print('ASSERT_FAIL: whoami RPC error: %s' % json.dumps(d['error'], ensure_ascii=False)[:200])
    raise SystemExit(1)
j = json.loads(d['result']['content'][0]['text'])
cid = str(j.get('company_id'))
if cid != sb:
    print('ASSERT_FAIL: 凭据账套(%s) != SYSTEM_BOOK(%s) ⇒ 防串账套，拒绝对账' % (cid, sb))
    raise SystemExit(1)
try:
    cfg = set(json.loads(cfg_raw))
except Exception as e:
    print('ASSERT_FAIL: BRANCH_NUMS 不是合法 JSON 数组: %s' % e); raise SystemExit(1)
who = set(j.get('branch_nums') or [])
missing = sorted(cfg - who)
if missing:
    print('ASSERT_FAIL: %d 个配置门店在本账套不可见（前 20：%s）⇒ 清单/账套错配，拒绝采信'
          % (len(missing), missing[:20]))
    raise SystemExit(1)
print('IDENTITY_OK company_id=%s visible=%d configured=%d (配置门店全部可见)'
      % (cid, len(who), len(cfg)))
PY
}

identity_assert() { # 通过 return 0；任何失败 return 非 0（调用方据此判红）
  [ -n "${LEMENG_TOKEN:-}" ] || { echo "ASSERT_FAIL: LEMENG_TOKEN 未注入 ⇒ 无法自证身份，拒绝采信"; return 1; }
  [ -n "${BRANCH_NUMS:-}" ] || { echo "ASSERT_FAIL: BRANCH_NUMS 未注入 ⇒ 无法自证清单，拒绝采信"; return 1; }
  # 两类失败**分开处理**：传输失败（网络抖动）重试 3 次；「答了、答得不对」是确定性的错配，
  # 重试同一个错答案没有意义 ⇒ whoami_verdict 里立即判红、不重试。
  i=1; ok=0
  while [ "$i" -le 3 ]; do
    : > /tmp/whoami.err
    if whoami_probe; then ok=1; break; fi
    echo "identity: whoami 第 $i 次传输失败（网络/HTTP），重试" >&2
    i=$((i+1)); sleep 2
  done
  if [ "$ok" -ne 1 ]; then
    echo "ASSERT_FAIL: whoami 传输失败 3 次（url=${AGI_URL}）⇒ 身份未证，拒绝采信"
    head -c 200 /tmp/whoami.err 2>/dev/null; echo
    return 1
  fi
  whoami_verdict > /tmp/identity.out 2>&1
  irc=$?
  cat /tmp/identity.out
  [ "$irc" -eq 0 ] || return 1
  return 0
}

# ── `rb` 的护栏（spec §3.5：今天的 rb 是**无护栏**的任意 SQL 口，能 COPY/INSTALL/写路径）──────
# 三层定位：① 内部底座（recon/agg/branches 共用的单一调用形状）；② 人的逃生舱；③ **但要加护栏**。
# 黑名单是**关键字级**（词边界，大小写不敏感）：拦的是"写面/环境面"，不是"写得不好"。
# 为什么 fail-closed 而不是白名单：一条只读查询的表达面是开放的（read_parquet/UNNEST/窗口函数…），
# 白名单会把工具关掉；黑名单漏一个关键字的代价远小于把写面放进来。
RB_FORBIDDEN_WORDS='COPY|ATTACH|DETACH|INSTALL|LOAD|EXPORT|IMPORT|CALL|PRAGMA|SET|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|VACUUM|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|SECRET'

rb_guard() { # $1=SQL → 0 放行；非零（2）= 拒（打印 RB_REJECTED + 被拒关键字）
  # 词边界用 `[^A-Za-z0-9_]`（不是 `\b`）：POSIX ERE 没有 `\b`，而 DuckDB 标识符里 `_` 是词字符。
  _rg_hit=$(printf '%s' "$1" \
    | grep -oiE "(^|[^A-Za-z0-9_])($RB_FORBIDDEN_WORDS)([^A-Za-z0-9_]|$)" \
    | grep -oiE "$RB_FORBIDDEN_WORDS" | head -1)
  if [ -n "$_rg_hit" ]; then
    echo "RB_REJECTED: SQL 里出现只读口禁止的写面/环境关键字 '$(printf '%s' "$_rg_hit" | tr 'a-z' 'A-Z')' ——本工具对湖只 SELECT；要写请走采集主链，别从这里开洞" >&2
    return 2
  fi
  return 0
}

rb_emit() { # stdin → stdout（至多 RB_MAX_ROWS 行）；超限 ⇒ 打 RB_TRUNCATED 且非零
  # 为什么必须显式：旧 `rb` 是 `| tail -40`——**静默丢行**，对「对账」是危险的（把截断当全量）。
  # 取 N+1 行来判别「恰好 N 行」与「不止 N 行」，否则刚好等于上限的查询会恒红。
  _re_tmp=$(mktemp)
  head -n "$((RB_MAX_ROWS + 1))" > "$_re_tmp"
  _re_n=$(awk 'END { print NR }' "$_re_tmp")
  head -n "$RB_MAX_ROWS" "$_re_tmp"
  rm -f "$_re_tmp"
  if [ "$_re_n" -gt "$RB_MAX_ROWS" ]; then
    echo "RB_TRUNCATED: 输出超过 RB_MAX_ROWS=${RB_MAX_ROWS} 行，只显示了前 ${RB_MAX_ROWS} 行——被截断的结果不能当全量用（加 LIMIT 或调大 RB_MAX_ROWS）" >&2
    return 3
  fi
  return 0
}

# ── 湖侧通道 A：`rb` 通路（与 run-retail-day.sh 逐字同形）──────────────────────────
rb_run() { # $1=SQL [$2=duckdb 旗标（如 -csv）] → duckdb 原始输出到 stdout；引擎非零退出原样透传
  # rb 通路的**单一调用形状**（别再抄第五份）：在 duckle 容器内跑 readback-helper.sh（RB_HELPER 挂成
  # /rb.sh）——凭据由容器 env 展开，值不进命令行、不进日志（helper 的存在理由，见其头注）。
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e RB_FLAGS="${2:-}" -e RB_QUERY="$1" -v "$RB_HELPER":/rb.sh:ro --entrypoint sh duckle -c 'sh /rb.sh'
}

lake_read_sql() { # $1=bizday $2=hour $3=system_book → 精读该 hour 单文件的 SQL
  # **两条通道共用这一份**（换通道复核 = 换通道，不换问句）。不带 hive_partitioning、点名单文件：
  # 路径里 hour=NN 与载荷列 hour 同名，hive 列会引入遮蔽歧义；单文件精读让 count(*)/count(DISTINCT
  # batch_id) 只来自载荷本身。对象不在 ⇒ duckdb IO 错 ⇒ 红（不是 0 行）。
  printf "SELECT count(*) AS n_rows, count(DISTINCT batch_id) AS n_batches FROM read_parquet('s3://%s/lemeng/retail_order_line/system_book=%s/bizday=%s/hour=%s/all.parquet');" \
    "$ZOS_BUCKET" "$3" "$1" "$2"
}

# ── 湖侧通道 B：`pg_duckdb` 免凭据回读（P3 裁决的「换通道复核」）──────────────────────
# ⚠️ SQL 里一律写 `s3://`：freshness/owners 里的 `minio://` 是引擎**标签前缀**、不是 DuckDB 认的
#    scheme，照抄进 SQL 会被静默当路径模式（报 `No files found`，没有 scheme 报错）。
pg_duckdb_lake_sql() { # $1=湖侧 SELECT → 免凭据通道的完整语句（$…$ 包裹：pg_duckdb 的 duckdb.query 要求）
  printf 'SELECT * FROM duckdb.query($$ %s $$);' "$1"
}

pg_duckdb_cid() { # → 容器名/ID；找不到非零（**不猜**：猜错容器名 = 拿别的东西当复核通道）
  if [ -n "$PGDUCK_CONTAINER" ]; then printf '%s\n' "$PGDUCK_CONTAINER"; return 0; fi
  _pc=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'pg_duckdb$' | head -1)
  [ -n "$_pc" ] || return 1
  printf '%s\n' "$_pc"
}

pg_duckdb_query() { # $1=SQL → stdout（-tA -F, 无表头 CSV）；容器不在 / psql 失败 ⇒ 非零
  # 免凭据：pg_duckdb 实例内已配 S3 secret（谁配的、换机怎么重建**未取证**——spec §6.3 待补项，
  # 本工具只消费它，不维护它）。这一步不经过任何 ZOS_* env。
  _pq_cid=$(pg_duckdb_cid) || return 2
  docker exec "$_pq_cid" psql -U "$PGDUCK_USER" -d "$PGDUCK_DB" -tA -F, -c "$1"
}

# ── recon：tick 对账（#260 裁决口径，只读）─────────────────────────────────────────
# 对照两侧：湖侧 = 该 hour 分区**单文件**精读（两条通道各自回读，见上）；网关侧 = 按「window 模式的
#   管线 src.rest」**同一调用形状**翻页查询（同 URL / 同 body 键 / page_size=200 / responsePath=/result
#   ——🔴 2026-09-29 改向：事实源是**在用的** L1 子管线
#   `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json`（原先指已退役的
#   `duckle/common/lemeng.retail_order_line.json`）；改那边要同步这里，静态门禁
#   `scripts/check-diagnostic-tool.mjs` 盯这条耦合）。
# 计数单位两侧同为**明细行**（管线 flatten 是 UNNEST(pos_order_details)，湖一行=一条明细）⇒
#   网关侧按「每单的明细条数」求和，不是数订单数。
# 判据（闭窗小时，容差 0）：两通道湖读数相等，且 == 网关当刻累计；分区内恰一个 batch_id。
RECON_GW_URL=${RECON_GW_URL:-https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.pos.posorder.find}
RECON_PAGES=12   # 与管线容量闸同数（12 页 × 200）；第 12 页仍满 = 取不全 = 判红（同末页守卫语义）
RECON_PAGE_SIZE=200  # 同「管线同数」；门禁比对 JSON 里每个 src.rest 的 page_size

recon_parse_lake_csv() { # $1=duckdb -csv 或 psql -tA 输出 → stdout "rows batches"；找不到数据行 ⇒ 非零
  # 表头/噪声行（`CREATE SECRET` 万一有输出、psql 的 NOTICE）天然不匹配数值判据 ⇒ 被跳过；
  # 一个数值行都找不到 = 比空气也算过，判红（同 list_guard 的哲学：宁可红，不许静默退化）。
  printf '%s\n' "$1" | awk -F, '{ gsub(/\r/, "") }
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1+0, $2+0; found=1; exit }
    END { exit found ? 0 : 1 }'
}

recon_gw_page() { # $1=page $2=bizday $3=hour → stdout=该页明细行数（0=空页=翻尽信号）；传输/HTTP/形状失败非零
  # curl 判 HTTP 的手法与 whoami_probe 同款：不用 -f（会丢 body），-w 取状态码自己判。
  # token 只进请求头、绝不回显（同全脚本纪律）；body 形状逐字对齐管线 src.rest 的 body 模板。
  code=$(curl -sS --max-time 25 -o /tmp/recon_gw.json -w '%{http_code}' -X POST "$RECON_GW_URL" \
    -H "Authorization: Bearer $LEMENG_TOKEN" -H "Content-Type: application/json" \
    -d "{\"branch_nums\": $BRANCH_NUMS, \"date_from\": \"$2\", \"date_to\": \"$2\", \"time_from\": \"$3:00:00\", \"time_to\": \"$3:59:59\", \"page_number\": $1, \"page_size\": $RECON_PAGE_SIZE}") || return 1
  [ "$code" = "200" ] || { echo "recon_gw_page: HTTP ${code} page=${1}（hour=${3}）" >&2; return 1; }
  python3 - "$1" <<'PY'
import json, sys
page = sys.argv[1]
try:
    d = json.load(open('/tmp/recon_gw.json'))
except Exception as e:
    print('RECON_GW_SHAPE: page=%s 响应不是 JSON：%s' % (page, str(e)[:120]), file=sys.stderr); raise SystemExit(1)
r = d.get('result') if isinstance(d, dict) else None
if not isinstance(r, list):
    print('RECON_GW_SHAPE: page=%s result 不是数组（网关形状变了？）' % page, file=sys.stderr); raise SystemExit(1)
n = 0
for o in r:
    if not isinstance(o, dict):
        print('RECON_GW_SHAPE: page=%s 订单项不是对象' % page, file=sys.stderr); raise SystemExit(1)
    det = o.get('pos_order_details')
    if isinstance(det, str):   # 允许「JSON 字符串」形态（src.rest 定型后是数组；两种都收，数错单位=白对账）
        try: det = json.loads(det)
        except Exception: det = None
    if det is None: continue   # 缺明细字段 ⇒ 贡献 0 行（与管线 UNNEST 空数组 = 0 行一致）
    if not isinstance(det, list):
        print('RECON_GW_SHAPE: page=%s pos_order_details 非数组' % page, file=sys.stderr); raise SystemExit(1)
    n += len(det)
print(n)
PY
}

recon_gateway_rows() { # $1=bizday $2=hour → stdout=网关当刻累计明细行数；翻页到空页；末页仍满 ⇒ 判红
  _rgr_total=0; _rgr_p=1
  while [ "$_rgr_p" -le "$RECON_PAGES" ]; do
    if ! _rgr_n=$(recon_gw_page "$_rgr_p" "$1" "$2"); then
      echo "RECON_FAILED:gateway 网关第 ${_rgr_p} 页取数失败（hour=${2}）——传输/HTTP/形状，见上" >&2
      return 1
    fi
    [ "$_rgr_n" -gt 0 ] || break   # 空页 = 翻尽（引擎 page 风格的停止信号）
    _rgr_total=$((_rgr_total + _rgr_n))
    _rgr_p=$((_rgr_p + 1))
  done
  if [ "$_rgr_p" -gt "$RECON_PAGES" ]; then
    echo "RECON_FAILED:gateway 第 ${RECON_PAGES} 页仍有数据 ⇒ 容量上限（${RECON_PAGES} 页×200）取不全，对账无从谈起（同管线末页守卫语义；hour=${2}）" >&2
    return 1
  fi
  echo "$_rgr_total"
}

recon_hour_open() { # $1=bizday $2=hour [$3=模拟 CST 墙钟 "YYYY-MM-DD HH:MM"（空=真 now；纯函数可测）] → 0=未闭窗；1=已闭窗
  # 未闭窗小时拒比：湖=最近一次 tick 的快照、网关=当刻累计，两者**合法不等**——比了必假红。
  # bizday 不是「今天」⇒ 全天必已闭（BIZDAY 缺省=昨日）。墙钟推导同 tick_windows 的手法。
  _rho_now=${3:-$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')}
  _rho_today=${_rho_now%% *}
  [ "$1" = "$_rho_today" ] || return 1
  _rho_h=${_rho_now##* }; _rho_h=${_rho_h%%:*}
  [ "$(( ${2#0} ))" -ge "$(( ${_rho_h#0} ))" ] && return 0
  return 1
}

recon_cross_verdict() { # $1=rb_rows $2=rb_batches $3=pd_rows $4=pd_batches → 相等 0；不等 ⇒ 1
  # P3「换通道复核」的判据本体：两条通道必须**逐字相等**。不等 ⇒ 读数可疑（同源凭据通道与免凭据
  # 通道看的是同一份 parquet，理应一模一样；不等说明其中一条读错了东西）。
  printf 'RECON_CROSS channel_rb=rows:%s,batches:%s channel_pg_duckdb=rows:%s,batches:%s（换通道复核：同一问句、两条互不依赖的通道）\n' \
    "$1" "$2" "$3" "$4"
  _rcv_rc=0
  if [ "$1" != "$3" ]; then
    echo "RECON_FAILED:cross 湖侧两通道行数不等（rb=${1} vs pg_duckdb=${3}）——同源凭据通道与免凭据通道必须逐字相等，不等则读数不可采信" >&2
    _rcv_rc=1
  fi
  if [ "$2" != "$4" ]; then
    echo "RECON_FAILED:cross 湖侧两通道 batch 数不等（rb=${2} vs pg_duckdb=${4}）——见上" >&2
    _rcv_rc=1
  fi
  [ "$_rcv_rc" -ne 0 ] && return 1
  return 0
}

recon_verdict() { # $1=lake_rows $2=lake_batches $3=gateway_rows $4=bizday $5=hour → 全等 0；任一判据破 ⇒ 1
  printf 'RECON bizday=%s hour=%s lake_rows=%s lake_batches=%s gateway_rows=%s（闭窗小时，容差 0）\n' \
    "$4" "$5" "$1" "$2" "$3"
  _rv_rc=0
  if [ "$2" != "1" ]; then
    echo "RECON_FAILED:batches hour=${5} 分区内 batch_id 不止一个（count(DISTINCT)=${2}）——#260 口径：应恰一个（最新完整快照）" >&2
    _rv_rc=1
  fi
  if [ "$1" != "$3" ]; then
    echo "RECON_FAILED:rows hour=${5} 湖行数(${1}) != 网关累计(${3})，差 $(( ${1} - ${3} ))（容差 0）" >&2
    _rv_rc=1
  fi
  [ "$_rv_rc" -ne 0 ] && return 1
  echo "RECON_OK hour=${5} rows=${3} batches=${2}"
  return 0
}

usage() {
  cat >&2 <<'USAGE'
用法：sh diagnose.sh <模式> [参数]
  recon <H>           该 hour 湖分区（双通道复核）vs 网关当刻累计，闭窗小时**容差 0**
  recon-day <YYYY-MM-DD>  该营业日**逐小时**跑 recon（00..23），任一小时不平即整体判红
                          （§1.4.1 定稿线：对象应是**已定稿**的营业日，如 T-3；未闭窗的小时跳过）
  rb "<duckdb SQL>"   容器内 duckdb 只读 SQL 口（写面关键字一律拒；输出上限 RB_MAX_ROWS）
  identity            身份自证：凭据↔账套 / 门店清单↔账套
退出码：0 = 全过；非 0 = 有失败面（字面量见脚本头注）。
USAGE
}

RB_MAX_ROWS=${RB_MAX_ROWS:-200}
PGDUCK_CONTAINER=${PGDUCK_CONTAINER:-}
PGDUCK_USER=${PGDUCK_USER:-platform}
PGDUCK_DB=${PGDUCK_DB:-warehouse}

case "${1:-}" in
identity)
  echo "== identity assert（凭据↔账套 / 门店清单↔账套；#205） =="
  identity_assert || exit 1
  echo "IDENTITY_ASSERT=PASS"
  ;;
rb)
  shift
  [ "$#" -gt 0 ] || { echo "RB_REJECTED: 未给 SQL（rb 需要一个参数）" >&2; usage; exit 2; }
  rb_guard "$*" || exit 2
  _rb_tmp=$(mktemp)
  rb_run "$*" > "$_rb_tmp" 2>&1; _rb_rc=$?
  rb_emit < "$_rb_tmp"; _rb_emit_rc=$?
  rm -f "$_rb_tmp"
  if [ "$_rb_rc" -ne 0 ]; then
    echo "RB_FAILED: 引擎非零退出 exit=${_rb_rc}（凭据/网络/对象缺失）" >&2
    exit 1
  fi
  exit "$_rb_emit_rc"
  ;;
recon)
  # tick 对账（#260 裁决口径，只读）。全程无写（湖只 SELECT、网关只 POST 查询端点）；对象不在位
  # 也是红（不是 0 行——同 hour_meta 的 NOT_FOUND 哲学）。
  H="${2:-}"
  case "$H" in
    [0-9][0-9]) ;;
    *) echo "RECON_FAILED:hour '${H}' 非 HH 两位数字——分区地址由它拼出，脏值判红" >&2; exit 2 ;;
  esac
  case "$BIZDAY" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "RECON_FAILED:hour 营业日不可用（BIZDAY='${BIZDAY}'，非 YYYY-MM-DD）——不确定营业日就不对账，判红" >&2; exit 2 ;;
  esac
  if recon_hour_open "$BIZDAY" "$H"; then
    echo "RECON_FAILED:hour_open bizday=${BIZDAY} hour=${H} 尚未闭窗——湖=最近 tick 快照、网关=当刻累计，合法不等，不对账" >&2
    exit 2
  fi
  identity_assert || exit 1   # 身份未证不碰网关（错账套的对账 = 白比）
  # 通道 A：rb（ZOS_* 同源凭据）
  _rc_csv=$(rb_run "$(lake_read_sql "$BIZDAY" "$H" "$SYSTEM_BOOK")" -csv 2>/tmp/diag_lake_rb.err)
  _rc_rc=$?
  if [ "$_rc_rc" -ne 0 ]; then
    echo "RECON_FAILED:lake 湖回读非零退出（rb 通道）exit=${_rc_rc}（hour=${H} 对象缺失/凭据/网络）" >&2
    cat /tmp/diag_lake_rb.err >&2
    exit 1
  fi
  if ! _rc_lb=$(recon_parse_lake_csv "$_rc_csv"); then
    echo "RECON_FAILED:lake 回读输出无数据行（形状变了？）——比空气也算过，判红；原始输出：" >&2
    printf '%s\n' "$_rc_csv" >&2
    exit 1
  fi
  _rc_lrows=${_rc_lb%% *}; _rc_lbatches=${_rc_lb##* }
  # 通道 B：pg_duckdb（免凭据）——**不可用即判红**，不静默退化回单通道
  _rc_pd=$(pg_duckdb_query "$(pg_duckdb_lake_sql "$(lake_read_sql "$BIZDAY" "$H" "$SYSTEM_BOOK")")" 2>/tmp/diag_lake_pd.err)
  _rc_pdrc=$?
  if [ "$_rc_pdrc" -ne 0 ]; then
    echo "RECON_FAILED:cross_unavailable 免凭据通道（pg_duckdb）取数失败 exit=${_rc_pdrc}（hour=${H}；容器不在/psql 失败）——「换通道复核」落空即判红，不静默退化回单通道" >&2
    cat /tmp/diag_lake_pd.err >&2
    exit 1
  fi
  if ! _rc_pdlb=$(recon_parse_lake_csv "$_rc_pd"); then
    echo "RECON_FAILED:cross_unavailable 免凭据通道输出无数据行（形状变了？）——原始输出：" >&2
    printf '%s\n' "$_rc_pd" >&2
    exit 1
  fi
  _rc_pdrows=${_rc_pdlb%% *}; _rc_pdbatches=${_rc_pdlb##* }
  recon_cross_verdict "$_rc_lrows" "$_rc_lbatches" "$_rc_pdrows" "$_rc_pdbatches" || exit 1
  _rc_gw=$(recon_gateway_rows "$BIZDAY" "$H") || exit 1
  recon_verdict "$_rc_lrows" "$_rc_lbatches" "$_rc_gw" "$BIZDAY" "$H"
  ;;
recon-day)
  # §1.4.1「定稿线」的常设形态（只读）：对一个**已定稿的营业日**逐小时跑同一套判据
  # （湖回读 vs 网关当刻累计，**容差 0**），任一小时不平即整体判红。
  #   · 为什么要有这一天级：湖在 T-1 两次点火后就**冻结**，而源在更久之后仍会变
  #     （实测同一窗 472 → 476 → 482）⇒ **冻住的湖可能永久短于稳态的源**；
  #     T-3 的整日对账就是发现这段差额、并触发回填的那道闸。
  #   · 0 明细单**不必特判**：它们对 `gw_rows` 的贡献是 0，行级比对天然把它们抵掉
  #     （实测 2026-10-02 全天逐小时 湖行 == 网关行，残差 0）。
  #   · 未闭窗的小时**跳过**（合法不等，与 recon 同名判据一致）；整日一个都没对到 ⇒ 判红
  #     （空转绿不是绿）。
  _rd_day="${2:-}"
  case "$_rd_day" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "RECON_FAILED:recon-day 需要一个 YYYY-MM-DD 营业日（收到 '${_rd_day}'）" >&2; exit 2 ;;
  esac
  _rd_checked=0; _rd_failed=0
  for _rd_h in 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23; do
    _rd_out=$(BIZDAY="$_rd_day" sh "$0" recon "$_rd_h" 2>&1) && _rd_rc=0 || _rd_rc=$?
    if [ "$_rd_rc" -eq 0 ]; then
      _rd_checked=$((_rd_checked + 1))
      printf '%s\n' "$_rd_out"
    else
      case "$_rd_out" in
        *RECON_FAILED:hour_open*)
          echo "RECON_SKIP hour=${_rd_h} 未闭窗（合法不等，不判）" >&2 ;;
        *RECON_FAILED:batches*)
          # **合法空窗**：网关 0 单 **且** 湖无分区 —— 两侧都 0，行数其实对平；`recon` 的 batches
          # 判据要求「分区内恰一个 batch_id」，空分区拿不到 ⇒ 单小时调用会判红。
          # ⚠️ **只在两侧都为 0 时跳过**（网关非 0 而湖为 0 = 真缺口，照旧判红）—— 否则是假绿。
          # 依据：2026-10-05 实测（bizday=2026-10-02 hour=03：lake_rows=0 / gateway_rows=0，
          # 而该日 01–07 共 7 个合法空窗 ⇒ 不跳过则整日恒红）。
          if printf '%s' "$_rd_out" | grep -qE 'lake_rows=0([^0-9]|$)' \
             && printf '%s' "$_rd_out" | grep -qE 'gateway_rows=0([^0-9]|$)'; then
            echo "RECON_SKIP hour=${_rd_h} 合法空窗（网关 0 单、湖无分区）" >&2
          else
            printf '%s\n' "$_rd_out" >&2
            echo "RECON_FAILED:day bizday=${_rd_day} hour=${_rd_h} 该小时未对平" >&2
            _rd_failed=$((_rd_failed + 1))
          fi ;;
        *)
          printf '%s\n' "$_rd_out" >&2
          echo "RECON_FAILED:day bizday=${_rd_day} hour=${_rd_h} 该小时未对平" >&2
          _rd_failed=$((_rd_failed + 1)) ;;
      esac
    fi
  done
  if [ "$_rd_failed" -ne 0 ]; then
    echo "RECON_DAY_FAILED bizday=${_rd_day} 未对平小时=${_rd_failed} 已对小时=${_rd_checked}" >&2
    exit 1
  fi
  if [ "$_rd_checked" -eq 0 ]; then
    echo "RECON_FAILED:day bizday=${_rd_day} 整日没有任何小时被对到——空转绿不是绿" >&2
    exit 1
  fi
  echo "RECON_DAY_OK bizday=${_rd_day} hours=${_rd_checked}"
  ;;
''|-h|--help|help|usage)
  usage
  exit 2
  ;;
*)
  echo "UNKNOWN_MODE: '${1}' 不是本工具的模式（recon / recon-day / rb / identity）——本工具**只读**，采集形不在其列" >&2
  usage
  exit 2
  ;;
esac
