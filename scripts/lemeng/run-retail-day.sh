#!/bin/sh
# run-retail-day.sh — 乐檬零售明细日采集执行器（数据面机原地运行；S1 首跑落地，Task 10 的 wrapper 雏形）
#
# 用法（job/exec 内，秘密值来自 job env——本脚本只读不写，任何输出都不回显值）：
#   sh run-retail-day.sh probe                     # 环境/桶/容器/token 闸 体检（只打印长度与状态码）
#   sh run-retail-day.sh window 07 [suffix]        # 单时窗
#   sh run-retail-day.sh windows                   # 昨日 24 时窗全量（逐窗尽力采；失败窗登记后继续，末尾统一判红）
#   sh run-retail-day.sh dim                       # 维度快照（DIM_FACE=branch|item，双账套全量）
#   sh run-retail-day.sh listing                   # 当日对象清单（bizday 前缀；断言：非空 + 未截断 + 无 ${ENV 字面量）
#   sh run-retail-day.sh rb "<duckdb SQL>"         # 容器内 duckdb httpfs 回读（值由容器 env 展开）
#   sh run-retail-day.sh idem3 03                  # 幂等强判（同 batch_id 字节一致 + 换 batch_id 因果对照）
#   sh run-retail-day.sh drift [H]                 # 契约漂移门禁（先断言 data.schema 声明存在）
#   sh run-retail-day.sh identity                  # 启动自证：凭据↔账套 / 门店清单↔账套（fail-loud；#205）
#   sh run-retail-day.sh envfile                   # 把 DUCKLE_TOKEN 物化成 deploy/.env（600；compose 插值用）
#
# 已退役模式（**不要恢复**）——`idem`：
#   原语义「重跑时窗、只换 batch_id，仍要求 ETag/Size 一致」在本设计下**前提不成立**：`batch_id` 是管线写入的
#   **载荷列**（Task 3 裁定 `batch.unique=false`；真机实测 2930B/3c9eecf5 → 3011B/740601f3），所以它必然不同 ⇒
#   该模式**恒红**、只会污染门禁。真 claim 由 `idem3` 覆盖（A/B/A2 三跑 + `BATCH_ID_EFFECT=OBSERVED` 因果对照）。
#   现 `idem` 只打印退役说明并 exit 2。**别"修"成钉固定 batch_id**：那只是 idem3 的真子集，白增冗余面。
#
# 退出码契约（job 据此判红——S1 教训：「打印 FAIL/VACUOUS 但仍 exit 0」= 假绿，等于没验）：
#   0 = 该模式全部验证项通过；非 0 = 至少一项验证失败。
#   取清单失败 / 清单被截断 / 清单为空 / key 里残留 ${ENV 字面量 / 幂等目标对象 NOT_FOUND / 0 检查（drift VACUOUS）一律非 0。
#   windows：**逐窗尽力采**——任一窗失败仍继续采后续窗（本 job 只采「昨天」且无回溯重放，
#            「一窗失败即停」= 失败点之后的窗口当天永久缺失，见 #209）；失败窗逐一登记，
#            **末尾** `WINDOWS_FAILED hours:…` + 非零退出（红灯照旧，只是不再拿覆盖率换安静）。
#            连续 `WINDOWS_MAX_CONSEC` 窗失败 ⇒ `WINDOWS_ABORT` 中止（网关不可用时不空转撞超时）。
#   identity：凭据/清单与账套错配、或 whoami 重试 3 次仍不可达 ⇒ 非零。**身份未证绝不写湖**
#             （`windows` / `window` 在开跑前自证；见 identity_assert 的注释说为什么必须有）。
#   dim：快照日不可用（`SNAPSHOT_DERIVE_FAILED:`）/ DIM_FACE 非法（`DIM_FACE_INVALID:`）/
#        启动自证未过（`DIM_FAILED`）/ 管线非零退出 / sink 行取不到（`OPS_ROWS_UNPARSED:`，只告警
#        不改退出码）⇒ 非 0。维度面分区是 **`snapshot=`**，**不消费 BIZDAY**——故它**不在**上面那张
#        「营业日不可用即硬失败」的名单里（营业日脏不该拦住维度快照）；反之 `dim` 也不校验 BIZDAY。
#   已退役模式（`idem`）恒 exit 2，不参与任何判断。
#
# 依赖 env: LEMENG_TOKEN / DUCKLE_TOKEN / ZOS_BUCKET / ZOS_ENDPOINT / ZOS_REGION /
#           ZOS_ACCESS_KEY / ZOS_SECRET_KEY / BRANCH_NUMS / SYSTEM_BOOK
#           BIZDAY 不传时按 **Asia/Shanghai 日历日的昨天** 推（显式钉 TZ，不继承系统 TZ——
#           数据面机系统 TZ 实测 CST，但 openship cron 实测按 UTC 解释；见 task-10-report.md「时区实测」）。
#           DIM_FACE / SNAPSHOT —— **仅 `dim` 模式**。DIM_FACE ∈ branch|item（选哪张维度管线）；
#           SNAPSHOT 不传时按 **Asia/Shanghai 日历日的今天** 推（同样显式钉 TZ——维度是「此刻的
#           全量」，分区日必须由 TZ 决定而不是由运行环境偶然决定）。SNAPSHOT 也可显式传入以重跑/
#           补跑某一天的快照（与 BIZDAY 同一形状：传入值同样要过 YYYY-MM-DD 断言）。
#           BRANCH_NUMS 只是**自证门**在 wrapper 自己的 shell 里读（配置门店 ⊆ 账套可见门店）；
#           维度管线不做门店扇出（快照是全账套的），故**不往容器里传**。
# 可选 env: LEMENG_LIST_MAX_KEYS —— 列举单页上限，默认 1000（= S3 ListObjectsV2 单页硬上限，安全值）。
#           只用于测试时临时给小值强制触发「截断即判红」；默认值不得为可测而放小。
#           OPS_SINK_ENV —— _ops 投递通道凭据文件，默认 /etc/openobserve-ingest.env（OO_BASE/OO_ORG/OO_AUTH）。
#           OPS_STREAM   —— OpenObserve 流名，默认 retail-day。
#           观测通道缺失/失败 ⇒ 打印 OPS_SINK=DISABLED|FAILED，**不影响本脚本退出码**（采集的判定
#           只由验证项决定），但也绝不静默——字面量可 grep（防「假装在报」）。该文件**按文本白名单解析、
#           绝不 source**（source 会让文件里一行未闭合引号把子进程打成 exit 2 ⇒ 被当成采集失败）。
#           取不到 sink 行 ⇒ 打印 OPS_ROWS_UNPARSED:（同族字面量），rows 记 null。
#           WINDOWS_MAX_CONSEC —— 逐窗尽力采时「连续失败多少窗即中止」，默认 3（#209）。
#           只用于测试时临时给小值强制触发 WINDOWS_ABORT；默认值不得为可测而放小。
#           LEMENG_AGI_URL —— whoami 自证端点，默认 `https://cloud.nhsoft.cn/agi/mcp`（#205 启动自证用）。
#           只用于换网关/本机演练；默认值即生产网关。
# 失败字面量（可 grep）：WINDOWS_FAILED hours:（末尾汇总，非零）/ WINDOWS_ABORT（连续失败中止）/
#           WINDOW_FAILED hour=（单窗失败，仍继续）/ WINDOWS_IDENTITY_FAILED（自证未过）/
#           BIZDAY_DERIVE_FAILED:（营业日不可用，exit 3）/ OPS_ROWS_UNPARSED: /
#           DIM_FAILED（dim 自证未过）/ DIM_FACE_INVALID:（DIM_FACE 非 branch|item，exit 2）/
#           SNAPSHOT_DERIVE_FAILED:（快照日不可用，exit 3）/
#           OPS_SINK=DISABLED|FAILED / LISTING_FAILED: / IDEM_RETIRED: / DRIFT_VERDICT=VACUOUS / ASSERT_FAIL:
set -u
REPO=${REPO:-/opt/platform-core-data/platform-core}
COMPOSE="docker compose -f $REPO/deploy/data-compose.yml"
PIPELINE=${PIPELINE:-/pipelines/common/lemeng.retail_order_line.json}
LOG_ROOT=/workspace/logs
# 营业日 = Asia/Shanghai 日历日的昨天。**显式钉 TZ，不继承系统 TZ**——继承等于让偶然决定正确性。
# 为什么钉死：数据面机系统 TZ 实测为 Asia/Shanghai（CST +0800），但 openship cron 实测按 **UTC** 解释
# （`17 3 * * *` 的实际 startedAt 逐日为 03:17:00Z ⇒ 11:17 CST）；两种解释下「上海日历日的昨天」
# 都是同一答案，故钉死后对 cron 语义不敏感（详见 task-10-report.md「时区实测」）。
#
# ⚠️ 父进程**只推一次**并 **export** 给每个窗口子进程：`windows` 是 `sh "$0" window "$H"` 起子进程，
# 而**未 export 的 shell 变量子进程看不见**（dash 实测：子进程拿到的是 UNSET ⇒ 各自重推一次）。
# 一次**跨上海 00:00** 的跑（全量实测 17m42s）就会把 0..k 窗写进 bizday=D、其余窗写进 D+1，
# **D 日永久残缺**（次日只盯 D+1，缺口不自愈）而退出码 0、行数正常——正是本任务要防的静默错采。
BIZDAY=${BIZDAY:-}
if [ -z "$BIZDAY" ]; then
  BIZDAY=$(TZ=Asia/Shanghai date -d yesterday +%Y-%m-%d 2>/dev/null) || BIZDAY=''
  [ -n "$BIZDAY" ] || BIZDAY=$(TZ=Asia/Shanghai date -v-1d +%Y-%m-%d 2>/dev/null) || BIZDAY=''
fi
# 推导值**与传入值**都必须真像 YYYY-MM-DD：无断言就等于放任 `bizday=` 这种空营业日静默写进湖
# （前缀会退化成 `.../bizday=/`，写到一个谁都不会再读的位置）。这是**采集侧**失败，允许硬失败。
case "$BIZDAY" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *)
    # 只在「真要写湖」的模式上硬失败：usage / idem / probe / diag / envfile 不需要营业日，
    # 保持既有退出码（idem 与未知模式 exit 2、usage exit 2）逐字不变。
    # `dim` **故意不在本名单**：维度面分区是 snapshot=，不消费 BIZDAY（脏 BIZDAY 不该拦住快照）；
    case " window windows listing agg branches rb idem3 drift " in
      *" ${1:-} "*)
        echo "BIZDAY_DERIVE_FAILED: 营业日不可用（TZ=Asia/Shanghai date 推导失败，或传入值非 YYYY-MM-DD：'${BIZDAY}'）——不确定营业日就绝不写湖，判红" >&2
        exit 3
        ;;
    esac
    ;;
esac
export BIZDAY
SYSTEM_BOOK=${SYSTEM_BOOK:-3120}
PREFIX="lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY"
# 当日对象前缀（'=' 必须 pct 编码：S3 prefix 里的裸 '=' 会被 SigV4 判无效——Task 8 实测）。
# 收窄到 bizday 一级：既避免「跨日同 hour key」被误匹配，也让清单不随天数增长（恒 ≤24 键）。
DAY_PREFIX="lemeng/retail_order_line/system_book%3D$SYSTEM_BOOK/bizday%3D$BIZDAY/"
LIST_MAX_KEYS=${LEMENG_LIST_MAX_KEYS:-1000}
# 逐窗尽力采（#209）：连续失败多少窗即判定网关不可用并停止续跑（避免空转 24 窗撞 job 超时 1h）。
WINDOWS_MAX_CONSEC=${WINDOWS_MAX_CONSEC:-3}
RB_HELPER=$REPO/lemeng-readback.sh

duckdb_bin() { $COMPOSE run --rm --entrypoint sh duckle -c 'command -v duckdb' 2>/dev/null | tr -d '\r' | tail -1; }

s3_list() { # $1=prefix → 单页清单到 stdout；HTTP/网络失败非零退出（-f）
  curl -sSf --max-time 25 --aws-sigv4 "aws:amz:${ZOS_REGION:-xinan1}:s3" \
    --user "$ZOS_ACCESS_KEY:$ZOS_SECRET_KEY" \
    "https://${ZOS_ENDPOINT}/${ZOS_BUCKET}?list-type=2&max-keys=${LIST_MAX_KEYS}&prefix=$1"
}

list_guard() { # $1=清单文件 $2=前缀(人读) → 非 ListBucketResult / IsTruncated != false ⇒ 判红
  # 为什么必须判红：截断后 prefix 下只剩前 N 个 key，任何基于它的比对都可能「两边都 NOT_FOUND ⇒
  # 比两个空串 ⇒ 报 PASS」，即比空气也算过（S1 评审 I3）。宁可红，不许静默退化。
  python3 - "$1" "$2" "$LIST_MAX_KEYS" <<'PY'
import re, sys
f, pfx, mk = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    x = open(f).read()
except OSError as e:
    print('LIST_UNREADABLE prefix=%s err=%s' % (pfx, e), file=sys.stderr)
    raise SystemExit(3)
if '<ListBucketResult' not in x:
    print('LIST_INVALID_RESPONSE prefix=%s head=%s' % (pfx, x[:200].replace('\n', ' ')), file=sys.stderr)
    raise SystemExit(4)
tr = re.search(r'<IsTruncated>(.*?)</IsTruncated>', x)
if tr is None or tr.group(1).strip() != 'false':
    print('LIST_TRUNCATED prefix=%s max_keys=%s IsTruncated=%s'
          % (pfx, mk, tr.group(1) if tr else 'MISSING'), file=sys.stderr)
    print('  ⇒ 清单被截断，基于它的比对会静默退化成「比空气也算过」。判红，不退化。', file=sys.stderr)
    raise SystemExit(5)
PY
}

count_hour() { # $1=hour → 该 hour 前缀下的对象数（清单不健康或 0 个都非零退出）
  pfx="${DAY_PREFIX}hour%3D$1/"
  if ! s3_list "$pfx" > /tmp/ch.xml; then
    echo "count_hour: 取清单失败 prefix=$pfx" >&2; return 3
  fi
  if ! list_guard /tmp/ch.xml "…/bizday=$BIZDAY/hour=$1/"; then
    echo "count_hour: 清单不健康，拒绝据此报数 prefix=$pfx" >&2; return 4
  fi
  n=$(grep -c '<Key>' /tmp/ch.xml)
  echo "$n"
  [ "$n" -gt 0 ] || echo "count_hour: 对象数为 0（hour=$1 该窗对象缺失）" >&2
  [ "$n" -gt 0 ]
}

hour_meta() { # $1=hour  -> "hour=NN size=S etag=E"（该 hour 对象的 ETag/Size，供幂等比对）
  pfx="${DAY_PREFIX}hour%3D$1/"
  if ! s3_list "$pfx" > /tmp/m.xml; then
    echo "hour_meta: 取清单失败 prefix=$pfx" >&2; return 3
  fi
  if ! list_guard /tmp/m.xml "…/bizday=$BIZDAY/hour=$1/"; then
    echo "hour_meta: 清单不健康，拒绝据此判幂等 prefix=$pfx" >&2; return 4
  fi
  python3 - "$1" "$pfx" <<'PY'
import re, sys
h, pfx = sys.argv[1], sys.argv[2]
x = open('/tmp/m.xml').read()
for b in re.findall(r'<Contents>(.*?)</Contents>', x, re.S):
    k = re.search(r'<Key>(.*?)</Key>', b).group(1)
    if k.endswith('/hour=%s/all.parquet' % h):
        print('hour=%s size=%s etag=%s' % (h, re.search(r'<Size>(\d+)</Size>', b).group(1),
              re.search(r'<ETag>(.*?)</ETag>', b).group(1).strip('"&quot;')))
        break
else:
    # NOT_FOUND 必须非零退出：否则 idem3 会把两个 NOT_FOUND 判成「相等 ⇒ 幂等 PASS」= 比空气
    print('hour=%s NOT_FOUND prefix=%s keys_seen=%d' % (h, pfx, len(re.findall(r'<Contents>', x, re.S))),
          file=sys.stderr)
    raise SystemExit(6)
PY
}

# ── _ops 观测（spec §6「观测：_ops 指标（行数/页数/窗口/耗时）」；§160「_ops 由 job wrapper 写 OpenObserve」）
# 每窗一行 JSON 到 stdout（字段：ts/job/system_book/bizday/hour/rows/status），并按 SOP 的文件日志通道
# 投递到 OpenObserve。rows **复用 window 模式已解析的 sink 输出**（同一行 sink 节点），
# 不另造一次计数——两次计数会漂移。
OPS_SINK_ENV=${OPS_SINK_ENV:-/etc/openobserve-ingest.env}
OPS_STREAM=${OPS_STREAM:-retail-day}
# sink 节点行：**行首锚定**（只有真正的 sink 节点行才会匹配），不用「整段输出 tail -1」——
# 后者会把任何同形噪声当结果。节点名与状态之间是**列对齐的多个空格**（首次真机全量跑暴露：
# 按单空格写会让每窗 rows 恒 null，指标静默消失）。
OPS_SINK_NODE_RE='^[[:space:]]*sink[[:space:]]+[a-z]+[[:space:]]*\([0-9]+ rows\)'

ops_sink_rows() { # $1=duckle 输出全文 → 该窗 sink 行数；**未唯一定位到 sink 行 ⇒ 非零**（调用方据此发独特字面量）
  n=$(printf '%s\n' "$1" | grep -cE "$OPS_SINK_NODE_RE")
  [ "$n" = "1" ] || return 1
  printf '%s\n' "$1" | grep -oE "$OPS_SINK_NODE_RE" | tr -dc '0-9'
}

ops_val() { # $1=键名 → 从通道文件取该键的值（**白名单**：只认这一个键名；**不 source**）
  # 为什么不能 source：注入文件里一行未闭合引号会让 shell 直接报语法错**退出 2**（dash 实测），
  # 而该子进程被 windows 循环判成「采集失败并停止续跑」⇒ 红的原因是**观测**，既违背本函数下方
  # 「观测不影响采集判定」的承诺，也违背本任务「_ops 不得改任何退出码」的契约。
  # 这里只把文件当**文本**读：畸形行只是「不匹配的行」，不执行、不注入本进程命名空间。
  # 同一键名出现多行取最后一条；去掉 CR（防 CRLF 文件把 \r 带进 Basic 头）。
  sed -n "s/^$1=//p" "$OPS_SINK_ENV" 2>/dev/null | tail -1 | tr -d '\r'
}

ops_ship() { # $1=一行 _ops JSON → 投递；**任何情况下都返回 0**（观测通道不影响采集的判定）
  # 凭据走服务器本地 root-only 文件，键名与既有 job `infra-health-check-to-openobserve` 同一套
  # （OO_BASE/OO_ORG/OO_AUTH）。文件缺失 / 格式不合法 / 键缺失 ⇒ 走 DISABLED 支路，**退出码不变**。
  if [ ! -r "$OPS_SINK_ENV" ]; then
    printf 'OPS_SINK=DISABLED reason=no_ingest_env file=%s\n' "$OPS_SINK_ENV"
    return 0
  fi
  # POSIX sh 无 local ⇒ 用 ooss_ 私有前缀，绝不覆盖采集侧变量（BIZDAY/SYSTEM_BOOK/ZOS_* 等）
  ooss_base=$(ops_val OO_BASE); ooss_org=$(ops_val OO_ORG); ooss_auth=$(ops_val OO_AUTH)
  # 键缺失 与 值形状不合法 分开报（都走 DISABLED，退出码不变）：前者是没配，后者是配歪了
  if [ -z "$ooss_base" ] || [ -z "$ooss_org" ] || [ -z "$ooss_auth" ]; then
    printf 'OPS_SINK=DISABLED reason=missing_key_in_ingest_env file=%s\n' "$OPS_SINK_ENV"
    return 0
  fi
  # 值形状白名单：畸形值（含引号/空白等）**不上 wire**——否则每次 POST 必失败且难查，
  # 而正确的做法是明确走 DISABLED（不假装在报，也不把观测故障混进采集判定）。
  case "$ooss_base" in
    http://*|https://*) ;;
    *) printf 'OPS_SINK=DISABLED reason=invalid_ingest_env key=OO_BASE\n'; return 0 ;;
  esac
  case "$ooss_org" in
    *[!A-Za-z0-9_-]*) printf 'OPS_SINK=DISABLED reason=invalid_ingest_env key=OO_ORG\n'; return 0 ;;
  esac
  case "$ooss_auth" in
    *[!A-Za-z0-9+/=._:-]*) printf 'OPS_SINK=DISABLED reason=invalid_ingest_env key=OO_AUTH\n'; return 0 ;;
  esac
  rm -f /tmp/ops_ship.out
  code=$(curl -s -o /tmp/ops_ship.out -w '%{http_code}' --max-time 15 \
    -H "Authorization: Basic $ooss_auth" -X POST \
    "$ooss_base/api/$ooss_org/$OPS_STREAM/_json" -H 'Content-Type: application/json' \
    -d "[$1]" 2>/dev/null) || code=000
  if [ "$code" = "200" ]; then
    printf 'OPS_SINK=OK stream=%s code=%s\n' "$OPS_STREAM" "$code"
  else
    printf 'OPS_SINK=FAILED stream=%s code=%s body=%s\n' \
      "$OPS_STREAM" "$code" "$(head -c 160 /tmp/ops_ship.out 2>/dev/null | tr -d '\n')"
  fi
  rm -f /tmp/ops_ship.out
  return 0
}

ops_emit() { # $1=hour $2=rows(number|null) $3=status → stdout 一行 + 投递
  j=$(printf '{"ts":"%s","job":"retail-day","system_book":"%s","bizday":"%s","hour":"%s","rows":%s,"status":"%s"}' \
      "$(date -u +%FT%TZ)" "$SYSTEM_BOOK" "$BIZDAY" "$1" "$2" "$3")
  printf '%s\n' "$j"
  ops_ship "$j"
}

ops_emit_dim() { # $1=face $2=snapshot $3=rows(number|null) $4=status → stdout 一行 + 投递
  # 与 ops_emit **并列**而不是把它参数化：上面那条路已被 `window` 在用，改签名等于给既有观测面
  # 引入回归风险（而这里要加的字段——`face`——只对维度面有意义）。
  # `face` 不可省：两条维度线同一天各跑一次，只凭 job 名/时间在观测面上分不开 branch 与 item。
  j=$(printf '{"ts":"%s","job":"dim","system_book":"%s","snapshot":"%s","face":"%s","rows":%s,"status":"%s"}' \
      "$(date -u +%FT%TZ)" "$SYSTEM_BOOK" "$2" "$1" "$3" "$4")
  printf '%s\n' "$j"
  ops_ship "$j"
}

# ── 启动自证（#205）─────────────────────────────────────────────────────────────
# 为什么必须有：`system_book` 是**采集侧按账套常量注入**的（契约 §columns 明写；管线里列值与 sink 路径
# 同源于同一个 `ENV:SYSTEM_BOOK`），所以**标错账套不会自己暴露**——列值和分区路径会一起错。而
# 「这家店本来就没单」与「账套/凭据配错了」在数据面上**都是 0 行、长得一模一样**（spec §4.2 G4 探针
# 方法学：64188 店 1/99 七天窗均 0 单）。多店合查只降低误判概率；**开跑前自证才能把二者从根上分开**。
AGI_URL=${LEMENG_AGI_URL:-https://cloud.nhsoft.cn/agi/mcp}

whoami_probe() { # 拉 whoami 到 /tmp/whoami.json；**传输层**失败（网络 / HTTP 非 200）非零
  # 不用 `-f`：`-f` 会连 body 一起丢掉，而 4xx/5xx 的 body 恰是排障要看的 —— 改用 `-w` 取状态码自己判。
  # 这一层判 HTTP 是必须的：不判的话，502/504 会被下游当成「答了、答得不对」而**不重试直接判红**，
  # 与「传输失败重试 3 次」的设计意图相反。
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
    print('ASSERT_FAIL: 凭据账套(%s) != SYSTEM_BOOK(%s) ⇒ 防串账套，拒绝写湖' % (cid, sb))
    raise SystemExit(1)
try:
    cfg = set(json.loads(cfg_raw))
except Exception as e:
    print('ASSERT_FAIL: BRANCH_NUMS 不是合法 JSON 数组: %s' % e); raise SystemExit(1)
who = set(j.get('branch_nums') or [])
missing = sorted(cfg - who)
if missing:
    print('ASSERT_FAIL: %d 个配置门店在本账套不可见（前 20：%s）⇒ 清单/账套错配，拒绝写湖'
          % (len(missing), missing[:20]))
    raise SystemExit(1)
print('IDENTITY_OK company_id=%s visible=%d configured=%d (配置门店全部可见)'
      % (cid, len(who), len(cfg)))
PY
}

identity_assert() { # 通过 return 0；任何失败 return 非 0（调用方据此判红）
  [ -n "${LEMENG_TOKEN:-}" ] || { echo "ASSERT_FAIL: LEMENG_TOKEN 未注入 ⇒ 无法自证身份，拒绝写湖"; return 1; }
  [ -n "${BRANCH_NUMS:-}" ] || { echo "ASSERT_FAIL: BRANCH_NUMS 未注入 ⇒ 无法自证清单，拒绝写湖"; return 1; }
  # 两类失败**分开处理**：传输失败（网络抖动）重试 3 次——不该把一天的采集中断在一次抖动上；
  # 但「答了、答得不对」是确定性的错配，重试同一个错答案没有意义 ⇒ whoami_verdict 里立即判红、不重试。
  i=1; ok=0
  while [ "$i" -le 3 ]; do
    : > /tmp/whoami.err
    if whoami_probe; then ok=1; break; fi
    echo "identity: whoami 第 $i 次传输失败（网络/HTTP），重试" >&2
    i=$((i+1)); sleep 2
  done
  if [ "$ok" -ne 1 ]; then
    # ⚠️ 这里**必须写 `${AGI_URL}`**：本机 `/bin/sh`（bash 3.2）实测会把紧跟 `$VAR` 的**全角字符**
    # （这里原本是 `）`）吃进变量名 ⇒ `AGI_URL<乱码>: unbound variable`，在传输失败这条**最需要它出声**
    # 的路径上反而不出声。全角紧邻时一律加花括号，不要赌目标机的 shell 是否 UTF-8 感知。
    echo "ASSERT_FAIL: whoami 传输失败 3 次（url=${AGI_URL}）⇒ 身份未证，拒绝写湖"
    head -c 200 /tmp/whoami.err 2>/dev/null; echo
    return 1
  fi
  whoami_verdict > /tmp/identity.out 2>&1
  irc=$?
  cat /tmp/identity.out
  [ "$irc" -eq 0 ] || return 1
  return 0
}

case "${1:-}" in
identity)
  echo "== identity assert（凭据↔账套 / 门店清单↔账套；#205） =="
  identity_assert || exit 1
  echo "IDENTITY_ASSERT=PASS"
  ;;
probe)
  echo "== env presence (names + lengths only) =="
  for v in LEMENG_TOKEN DUCKLE_TOKEN ZOS_BUCKET ZOS_ENDPOINT ZOS_REGION ZOS_ACCESS_KEY ZOS_SECRET_KEY BRANCH_NUMS SYSTEM_BOOK BIZDAY; do
    printf '%s len=%s\n' "$v" "$(printenv "$v" 2>/dev/null | tr -d '\n' | wc -c)"
  done
  echo "== bucket probe from this host =="
  for pair in "https xinan-1-internal.zos.ctyun.cn" "http xinan-1-internal.zos.ctyun.cn"; do
    set -- $pair; sch=$1; ep=$2
    code=$(curl -s -o /tmp/bp.out -w '%{http_code}' --max-time 15 --aws-sigv4 "aws:amz:${ZOS_REGION:-xinan1}:s3" --user "$ZOS_ACCESS_KEY:$ZOS_SECRET_KEY" "$sch://$ep/$ZOS_BUCKET?list-type=2&max-keys=3")
    printf '%s://%s -> %s %s\n' "$sch" "$ep" "$code" "$(grep -o '<KeyCount>[0-9]*</KeyCount>' /tmp/bp.out 2>/dev/null | head -1)"
  done
  echo "== container probe =="
  echo "duckdb_path=$(duckdb_bin)"
  $COMPOSE run --rm --entrypoint sh duckle -c 'duckdb --version; echo pipelines:; ls /pipelines/common/' 2>&1 | tail -5
  echo "== httpfs availability in duckle image =="
  $COMPOSE run --rm --entrypoint sh duckle -c 'duckdb -c "INSTALL httpfs; LOAD httpfs; SELECT 1 AS httpfs_ok;"' 2>&1 | tail -3
  echo "== pg_duckdb raw_query availability =="
  docker exec openship-platform-core-shanhai-data-pg_duckdb sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U platform -d warehouse -tAc "SELECT * FROM duckdb.raw_query(\$\$ SELECT 41+1 AS ok \$\$);"' 2>&1 | tail -3
  echo "== token gate pass-through =="
  $COMPOSE run --rm -e DUCKLE_TOKEN duckle --help 2>&1 | grep -iE 'drift|token|usage' | head -6
  rm -f /tmp/bp.out
  echo "== probe end =="
  ;;
window)
  H="${2:?hour}"; SUF="${3:-}"
  # 启动自证（#205）：独立调用（含 idem3 的逐窗调用）时也要过。`windows` 已证过会导出
  # IDENTITY_CHECKED=1 ⇒ 这里跳过，避免 24 次重复 whoami（见 windows 分支的 export 说明）。
  if [ "${IDENTITY_CHECKED:-}" != "1" ]; then
    sh "$0" identity
    irc=$?
    if [ "$irc" -ne 0 ]; then echo "WINDOW_FAILED identity 自证未过(exit=$irc)，拒绝写湖"; exit "$irc"; fi
    IDENTITY_CHECKED=1; export IDENTITY_CHECKED
  fi
  BATCH_ID="${BATCH_ID_OVERRIDE:-retail-${SYSTEM_BOOK}-$(date -u +%Y%m%dT%H%M%SZ)-${H}${SUF}}"
  out=$($COMPOSE run --rm \
    -e LEMENG_TOKEN -e DUCKLE_TOKEN -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e BIZDAY="$BIZDAY" -e HOUR="$H" -e HOUR_FROM="$H:00:00" -e HOUR_TO="$H:59:59" \
    -e BRANCH_NUMS -e SYSTEM_BOOK -e BATCH_ID="$BATCH_ID" \
    duckle --pipeline "$PIPELINE" --workspace /workspace --duckdb "$(duckdb_bin)" --log-dir "$LOG_ROOT/${H}${SUF}" 2>&1)
  rc=$?
  status=$(printf '%s' "$out" | grep -oiE 'status[: ]+[a-z]+' | head -1)
  sink=$(printf '%s' "$out" | grep -iE 'sink' | tail -1)
  printf 'window hour=%s exit=%s %s\n' "$H" "$rc" "${status:-status:NONE}"
  printf '%s\n' "$out" | tail -14
  # _ops 行**在判红之前**发出：失败窗也要在观测面留痕（rows=null 而非 0——0 会被误读成「跑了但没数据」）
  st=$(printf '%s' "$status" | sed 's/^status[: ]*//'); [ -n "$st" ] || st=NONE
  # 取不到 sink 行**必须可观测**：否则 `rows:null + status:ok` 与「该窗确实没有 sink 行」不可区分，
  # 将来 sink 节点改名 / 状态词离开 [a-z]+ / 多出一条同形行，都会让本任务唯一要交付的指标
  # 无声消失（exit 0、无独特字面量可 grep）。故失败时发一条与 LISTING_FAILED:/ASSERT_FAIL: 同族的字面量。
  if sink_rows=$(ops_sink_rows "$out"); then
    ops_emit "$H" "$sink_rows" "$st"
  else
    printf 'OPS_ROWS_UNPARSED: 未能唯一定位本窗 sink 节点行（改名/状态词变化/多条同形行）⇒ rows 记 null；此处即「指标缺失」的可见处\n'
    ops_emit "$H" "null" "$st"
  fi
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
  ;;
windows)
  # 原实现（修「假绿」那轮）只让循环状态等于**最后一个窗**：中间某个 hour 失败只在日志里一行，
  # 进程仍 exit 0。当时的修法是「任一窗失败 ⇒ 立即非零退出且不再续跑」——**红灯对了，但代价是覆盖率**。
  # 本轮的修法（issue #209，两条真实案例见下）：**逐窗尽力采 + 末尾统一判红**。
  # 为什么要改：本 job **只采「昨天」**（BIZDAY = 上海昨日）、**没有回溯重放**（属 S3，未建）
  # ⇒ 「一窗失败即停」意味着**失败点之后的窗口当天永久缺失且不会自愈**，唯一兜底是人工重跑。
  # 案例：2026-09-25 02:30Z 的 schedule 轮失败（靠 03:10Z 人工重跑才补上）；
  #       同日 07:00Z 的 hour 17 撞上游 504「page 3: REST HTTP 504」⇒ 18–23 被整段跳过。
  # 但绝不静默：失败窗逐一登记，**末尾一次性判红**（`WINDOWS_FAILED hours:…` + exit 非零），
  # 并配 job 的 retry（openship 配置）给整轮第二次机会。
  # 连续失败达 `WINDOWS_MAX_CONSEC` 即中止：网关整体不可用时不该空转 24 窗去撞 job 超时（1h）。
  # 启动自证（#205）放在**最前**：任何一窗都不该在身份未证时开跑（错账套的 24 窗全落错分区，
  # 而退出码 0、行数正常——正是本自证要防的静默错采）。
  # IDENTITY_CHECKED **必须 export**：下面是 `sh "$0" window "$H"` 起的**子进程**，未导出的 shell
  # 变量子进程看不见（本文件 BIZDAY 一处已踩过同一个坑）⇒ 不导出会让每窗各自重证一次。
  if [ "${IDENTITY_CHECKED:-}" != "1" ]; then
    sh "$0" identity
    irc=$?
    if [ "$irc" -ne 0 ]; then echo "WINDOWS_IDENTITY_FAILED 自证未过(exit=$irc)，拒绝写湖"; exit "$irc"; fi
    IDENTITY_CHECKED=1; export IDENTITY_CHECKED
  fi
  w_failed=""; w_consec=0
  for H in $(seq -w 0 23); do
    if sh "$0" window "$H"; then
      w_consec=0
    else
      wrc=$?
      w_failed="$w_failed $H"
      w_consec=$((w_consec+1))
      # ⚠️ `${wrc}` 的花括号是必须的：`$wrc` 紧跟全角 `（` 时，本机 /bin/sh（bash 3.2）会把一个
      # 字节吃进变量名 ⇒ `wrc<乱码>: unbound variable`（#208 在 AGI_URL 上已踩过同一个坑、同一条路径）。
      echo "WINDOW_FAILED hour=$H exit=${wrc}（已登记，继续采后续窗）"
      if [ "$w_consec" -ge "$WINDOWS_MAX_CONSEC" ]; then
        echo "WINDOWS_ABORT 连续 $w_consec 窗失败 ⇒ 判定网关不可用，停止续跑"
        break
      fi
    fi
  done
  if [ -n "$w_failed" ]; then
    echo "WINDOWS_FAILED hours:${w_failed# } —— 共 $(printf '%s' "$w_failed" | wc -w | tr -d ' ') 窗未采（其余窗已采；job 判红，等 retry 或人工重跑）"
    exit 1
  fi
  echo "WINDOWS_ALL_OK 24/24 windows"
  ;;
dim)
  # 维度快照（spec §5 湖布局）：一次拉全账套的门店维 / 商品维，落 `snapshot=<日期>` 分区。
  # 本分支与 window **同构**（同 `$COMPOSE run --rm` + 一串 -e + 解析 status/sink + 发 _ops + 失败非零），
  # 只把「时窗参数」（BIZDAY/HOUR/HOUR_FROM/HOUR_TO）换成「快照参数」（SNAPSHOT）——读一份就懂另一份。
  # 容量哨兵在管线**内部**（`ctl.die` 的 has-rows：branch 第 5 页 / item 第 150 页仍非空即自行中止）。
  # ⚠️ 哨兵**至今从未触发过**（Task 2/3 的采样与全量跑里哨兵页均为空）⇒「命中时长什么样」**没有实测案例**，
  # 本分支**不替它预设形状、也不另造一套判据**：只要最终不是「rc=0 且 status 非 ok」，本分支就判红——
  # 这正是复用 window 那条判定链的意义。真机首次命中时回来把本注释订正成实测形状（别照抄想象）。
  case "${DIM_FACE:-}" in
    branch|item) ;;
    *)
      echo "DIM_FACE_INVALID: DIM_FACE='${DIM_FACE:-}'（应为 branch|item）——脸别错：错了要么读到不存在的管线，要么把快照写进错的分区，判红" >&2
      exit 2
      ;;
  esac
  # 快照日 = Asia/Shanghai 日历日的**今天**（维度是「此刻的全量」，不是某个营业日）。
  # **显式钉 TZ，不继承系统 TZ**——理由同 BIZDAY：数据面机系统 TZ 实测 CST，但 openship cron 按 UTC
  # 解释，继承等于让偶然决定分区名。传入值同样要过形状断言（空 SNAPSHOT 会把快照写进 `snapshot=/`，
  # 那是谁都不会再读的位置——这是采集侧失败，允许硬失败，退出码同 BIZDAY_DERIVE_FAILED）。
  SNAPSHOT=${SNAPSHOT:-}
  [ -n "$SNAPSHOT" ] || SNAPSHOT=$(TZ=Asia/Shanghai date +%F 2>/dev/null) || SNAPSHOT=''
  case "$SNAPSHOT" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *)
      echo "SNAPSHOT_DERIVE_FAILED: 快照日不可用（TZ=Asia/Shanghai date 推导失败，或传入值非 YYYY-MM-DD：'${SNAPSHOT}'）——不确定快照日就绝不写湖，判红" >&2
      exit 3
      ;;
  esac
  # 启动自证（#205）与 window 同门：**身份未证绝不写湖**。维度面尤其要证——快照是**全账套**的，
  # 账套错配不会像零售那样表现为「某店 0 行」，而是整张维表落进错的 system_book 分区且行数正常。
  # IDENTITY_CHECKED 的 export 语义同 windows 分支：本模式将来若被某个父进程包裹调用，
  # 未导出会让每个子进程各自重证一次。
  if [ "${IDENTITY_CHECKED:-}" != "1" ]; then
    sh "$0" identity
    irc=$?
    if [ "$irc" -ne 0 ]; then echo "DIM_FAILED identity 自证未过(exit=${irc})，拒绝写湖"; exit "$irc"; fi
    IDENTITY_CHECKED=1; export IDENTITY_CHECKED
  fi
  DIM_PIPELINE="/pipelines/common/lemeng.${DIM_FACE}.json"
  # batch_id 形状同 window（`<face>-<book>-<UTC 时刻>`）：同一账套的两张维度脸互不撞名。
  # 仍留 BATCH_ID_OVERRIDE 口子（idem3 用同一手法钉固定 batch_id 做字节级对照）。
  BATCH_ID="${BATCH_ID_OVERRIDE:-dim-${SYSTEM_BOOK}-${DIM_FACE}-$(date -u +%Y%m%dT%H%M%SZ)}"
  out=$($COMPOSE run --rm \
    -e LEMENG_TOKEN -e DUCKLE_TOKEN -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e SNAPSHOT="$SNAPSHOT" -e SYSTEM_BOOK -e BATCH_ID="$BATCH_ID" \
    duckle --pipeline "$DIM_PIPELINE" --workspace /workspace --duckdb "$(duckdb_bin)" --log-dir "$LOG_ROOT/dim-${SNAPSHOT}-${DIM_FACE}" 2>&1)
  rc=$?
  status=$(printf '%s' "$out" | grep -oiE 'status[: ]+[a-z]+' | head -1)
  printf 'dim face=%s snapshot=%s exit=%s %s\n' "$DIM_FACE" "$SNAPSHOT" "$rc" "${status:-status:NONE}"
  printf '%s\n' "$out" | tail -14
  # _ops 行**在判红之前**发出（失败也要在观测面留痕；rows=null 而非 0——0 会被误读成「跑了但没数据」）。
  # 取不到 sink 行必须可观测：否则 `rows:null + status:ok` 与「确实没有 sink 行」不可区分（同 window）。
  st=$(printf '%s' "$status" | sed 's/^status[: ]*//'); [ -n "$st" ] || st=NONE
  if sink_rows=$(ops_sink_rows "$out"); then
    ops_emit_dim "$DIM_FACE" "$SNAPSHOT" "$sink_rows" "$st"
  else
    printf 'OPS_ROWS_UNPARSED: 未能唯一定位本次 sink 节点行（改名/状态词变化/多条同形行）⇒ rows 记 null；此处即「指标缺失」的可见处\n'
    ops_emit_dim "$DIM_FACE" "$SNAPSHOT" "null" "$st"
  fi
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
  ;;
listing)
  # 先清陈旧产物：取清单失败时若留着上一次的 /tmp/ls.xml，下面的扫描会拿旧清单报绿
  rm -f /tmp/ls.xml
  # 列**当日前缀**（与 hour_meta/count_hour 同一套前缀约定）：当日恒 ≤24 键 ⇒ 不会像全桶前缀
  # 「lemeng/」那样在约 42 天后 >1000 键、把硬判截断的门禁变成永久红。
  if ! s3_list "$DAY_PREFIX" > /tmp/ls.xml; then
    echo "LISTING_FAILED: 取清单失败（curl 非零）；已丢弃旧 /tmp/ls.xml，不以旧清单报绿"
    exit 1
  fi
  if ! list_guard /tmp/ls.xml "$DAY_PREFIX"; then
    echo "LISTING_FAILED: 清单校验未通过（见上）；已丢弃 /tmp/ls.xml"
    rm -f /tmp/ls.xml
    exit 1
  fi
  python3 <<'PY'
import re, sys
x=open('/tmp/ls.xml').read()
rows=re.findall(r'<Contents>(.*?)</Contents>', x, re.S)
tr=re.search(r'<IsTruncated>(.*?)</IsTruncated>', x)
print('objects=%d truncated=%s' % (len(rows), tr.group(1) if tr else '?'))
if not rows:
    # 本模式声明要核「当日的 hour=NN 对象在位」；0 个对象 = 没有可核的东西，不得报通过
    print('LIST_EMPTY_PREFIX: 该前缀下 0 个对象 ⇒ 无对象可核（不得当作通过；diag 仍可看桶根）', file=sys.stderr)
    raise SystemExit(7)
for b in sorted(rows, key=lambda b: re.search(r'<Key>(.*?)</Key>', b).group(1)):
    k=re.search(r'<Key>(.*?)</Key>', b).group(1)
    print('key=%s size=%s etag=%s' % (k, re.search(r'<Size>(\d+)</Size>', b).group(1),
          re.search(r'<ETag>(.*?)</ETag>', b).group(1).strip('"&quot;')))
PY
  lrc=$?
  if [ "$lrc" -ne 0 ]; then
    echo "LISTING_FAILED: 清单枚举未通过 exit=${lrc}（见上）；该日可能尚无对象"
    exit 1
  fi
  echo "== literal-placeholder scan in keys (must be empty) =="
  leak=$(grep -o '<Key>[^<]*</Key>' /tmp/ls.xml | grep -F '${ENV' | head -3)
  if [ -n "$leak" ]; then
    printf '%s\n' "$leak"
    echo 'LISTING_FAILED: key 里残留 ${ENV:…} 字面量占位符 ⇒ 写入用了未展开的 env（G1b 回归）'
    exit 1
  fi
  echo "(clean)"
  echo "== prefix probe: plain '=' vs pct-encoded '=' (encoding sensitivity) =="
  # 下面第一条**故意**用未编码的裸 '='（SigV4 判无效 ⇒ 403 打到 stderr）——这是预期输出，不是故障
  printf 'plain_eq_keys=%s\n' "$(s3_list "$PREFIX/hour=03/" | grep -c '<Key>')"
  printf 'pct_eq_keys=%s\n' "$(s3_list "lemeng/retail_order_line/system_book%3D3120/bizday%3D$BIZDAY/hour%3D03/" | grep -c '<Key>')"
  echo "== scan end =="
  ;;
agg)
  SQL="$(cat <<SQL
SELECT 'per_hour' AS section, CAST(hour AS VARCHAR) AS hour, count(*) AS rows, sum(sale_money) AS amt, sum(CASE WHEN state='FINISHED' THEN sale_money ELSE 0 END) AS finished_amt FROM read_parquet('s3://$ZOS_BUCKET/lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY/**/*.parquet', hive_partitioning=1) GROUP BY hour ORDER BY hour;
SELECT 'totals' AS section, count(*) AS rows, sum(sale_money) AS amt, sum(CASE WHEN state='FINISHED' THEN sale_money ELSE 0 END) AS finished_amt FROM read_parquet('s3://$ZOS_BUCKET/lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY/**/*.parquet', hive_partitioning=1);
SELECT 'hour17_finished' AS section, count(*) AS rows, sum(sale_money) AS amt FROM read_parquet('s3://$ZOS_BUCKET/lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY/**/*.parquet', hive_partitioning=1) WHERE CAST(hour AS VARCHAR)='17' AND state='FINISHED';
SELECT 'states' AS section, state, count(*) AS rows, sum(sale_money) AS amt FROM read_parquet('s3://$ZOS_BUCKET/lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY/**/*.parquet', hive_partitioning=1) GROUP BY state ORDER BY state;
SQL
)"
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e RB_QUERY="$SQL" -v "$RB_HELPER":/rb.sh:ro --entrypoint sh duckle -c 'sh /rb.sh' 2>&1 | grep -vE '^ *Container |^ *Network ' | tail -45
  echo "== agg end =="
  ;;
branches)
  SQL="SELECT branch_num, sum(sale_money) AS fin_amt, count(*) AS rows FROM read_parquet('s3://$ZOS_BUCKET/lemeng/retail_order_line/system_book=$SYSTEM_BOOK/bizday=$BIZDAY/**/*.parquet', hive_partitioning=1) WHERE state='FINISHED' GROUP BY branch_num ORDER BY branch_num;"
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e RB_FLAGS=-csv -e RB_QUERY="$SQL" -v "$RB_HELPER":/rb.sh:ro --entrypoint sh duckle -c 'sh /rb.sh' 2>&1 | grep -vE '^ *Container |^ *Network ' | tail -200
  echo "== branches end =="
  ;;
diag)
  echo "== root listing (no prefix) =="
  s3_list "" | head -c 1200
  echo
  echo "== container view of ZOS vars (lengths only) =="
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION --entrypoint sh duckle -c 'echo bucket_len=${#ZOS_BUCKET} ep_len=${#ZOS_ENDPOINT} region_len=${#ZOS_REGION}' 2>&1 | tail -2
  echo "== workspace parquet (local-write fallback check) =="
  $COMPOSE run --rm --entrypoint sh duckle -c 'find /workspace -name "*.parquet" 2>/dev/null | head -5; echo ws_listing:; ls -la /workspace 2>/dev/null | head -8; echo duckle_state:; ls -la /workspace/.duckle 2>/dev/null | head -5' 2>&1 | tail -14
  ;;
rb)
  shift
  $COMPOSE run --rm -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e RB_QUERY="$*" -v "$RB_HELPER":/rb.sh:ro --entrypoint sh duckle -c 'sh /rb.sh' 2>&1 | tail -40
  ;;
idem)
  # 已退役（修复环 2/5；理由见文件头「已退役模式」）。原语义要求「只换 batch_id、ETag/Size 仍相等」，
  # 而 batch_id 是**载荷列**（Task 3 裁定 batch.unique=false；真机 2930B/3c9eecf5 → 3011B/740601f3）⇒ 恒红。
  # 真 claim 归 idem3。不要把它"修好"（钉固定 batch_id = idem3 的真子集，只增冗余面）。
  echo "IDEM_RETIRED: 'idem' 已退役（换 batch_id 后要求 ETag 一致的前提不成立：batch_id 是载荷列）"
  echo "IDEM_RETIRED: 请用 'idem3 <hour>'：同 batch_id 三跑字节一致 + 换 batch_id 因果对照（BATCH_ID_EFFECT）"
  exit 2
  ;;
idem3)
  # 幂等强判：① 同 batch_id 重跑 ⇒ 字节一致；② 换 batch_id ⇒ 差异仅来自 batch_id 载荷列（因果对照）
  H="${2:-03}"; A="retail-${SYSTEM_BOOK}-idemA-${H}"; B="retail-${SYSTEM_BOOK}-idemB-${H}"
  BATCH_ID_OVERRIDE="$A" sh "$0" window "$H" "-iA" >/tmp/wi.log 2>&1 || { echo "window A run1 FAILED"; tail -6 /tmp/wi.log; exit 1; }
  ra=$(hour_meta "$H") || { echo "hour_meta A_run1 FAILED hour=${H}（NOT_FOUND/清单截断/取失败）"; exit 1; }
  BATCH_ID_OVERRIDE="$B" sh "$0" window "$H" "-iB" >/tmp/wi.log 2>&1 || { echo "window B run FAILED"; tail -6 /tmp/wi.log; exit 1; }
  rb=$(hour_meta "$H") || { echo "hour_meta B_run1 FAILED hour=$H"; exit 1; }
  BATCH_ID_OVERRIDE="$A" sh "$0" window "$H" "-iA2" >/tmp/wi.log 2>&1 || { echo "window A run2 FAILED"; tail -6 /tmp/wi.log; exit 1; }
  ra2=$(hour_meta "$H") || { echo "hour_meta A_run2 FAILED hour=$H"; exit 1; }
  nobj=$(count_hour "$H") || { echo "count_hour FAILED hour=${H}（对象数 0 或清单不健康）"; exit 1; }
  echo "A_run1=$ra"; echo "B_run1=$rb"; echo "A_run2=$ra2"; echo "objects_hour${H}=$nobj"
  idem_rc=0
  if [ "$ra" = "$ra2" ]; then echo "IDEMPOTENT_SAME_BATCH=PASS"; else echo "IDEMPOTENT_SAME_BATCH=FAIL"; idem_rc=1; fi
  if [ "$ra" = "$rb" ]; then echo "BATCH_ID_EFFECT=NONE"; else echo "BATCH_ID_EFFECT=OBSERVED"; fi
  if [ "$idem_rc" -ne 0 ]; then echo "IDEM_FAILED: 同 batch_id 重跑字节不一致"; exit 1; fi
  ;;
drift)
  echo "== assert data.schema declaration exists (anti-false-green) =="
  n=$(grep -c '"schema"' "$REPO/duckle/common/lemeng.retail_order_line.json")
  echo "declared_schema_nodes=$n"
  if [ "$n" -lt 8 ]; then echo "ASSERT_FAIL: schema declaration missing (drift 会假绿)"; exit 1; fi
  H="${2:-17}"
  echo "== drift run (window hour=$H, full env) =="
  out=$($COMPOSE run --rm \
    -e DUCKLE_TOKEN -e LEMENG_TOKEN -e ZOS_BUCKET -e ZOS_ENDPOINT -e ZOS_REGION -e ZOS_ACCESS_KEY -e ZOS_SECRET_KEY \
    -e BIZDAY="$BIZDAY" -e HOUR="$H" -e HOUR_FROM="$H:00:00" -e HOUR_TO="$H:59:59" \
    -e SYSTEM_BOOK="$SYSTEM_BOOK" -e BRANCH_NUMS -e BATCH_ID="drift-$H" \
    duckle drift --pipeline "$PIPELINE" --workspace /workspace 2>&1)
  rc=$?
  printf '%s\n' "$out" | tail -30
  echo "drift_exit=$rc"
  if printf '%s' "$out" | grep -qE '^  summary: [0-9]+ checked'; then
    chk=$(printf '%s' "$out" | sed -n 's/^  summary: \([0-9]*\) checked.*/\1/p')
  else
    chk=0
  fi
  echo "drift_checked_sources=$chk"
  if [ "$rc" -ne 0 ]; then echo "DRIFT_FAILED: drift 自身非零退出 exit=$rc"; exit "$rc"; fi
  if [ "$chk" -gt 0 ]; then
    echo "DRIFT_VERDICT=MEANINGFUL"
  else
    echo "DRIFT_VERDICT=VACUOUS(0 checked)"
    echo "DRIFT_FAILED: 0 检查 = 根本没比对，不得报绿（换一个有数据的时窗重跑；空时窗天然无法比对）"
    exit 1
  fi
  ;;
envfile)
  umask 077
  printf 'DUCKLE_TOKEN=%s\n' "$DUCKLE_TOKEN" > "$REPO/deploy/.env"
  chmod 600 "$REPO/deploy/.env"
  echo "envfile keys=$(cut -d= -f1 "$REPO/deploy/.env" | tr '\n' ',') mode=$(stat -c '%a' "$REPO/deploy/.env")"
  ;;
*)
  echo "usage: $0 <probe|identity|diag|window H [suffix]|windows|dim|listing|agg|branches|rb SQL|idem3 H|drift [H]|envfile>"
  echo "exit: 0=全项通过；非 0=有验证项失败（含 0 检查/清单截断/清单为空/残留 \${ENV 字面量/NOT_FOUND/取清单失败）"
  echo "dim: DIM_FACE=branch|item  sh $0 dim   （维度快照；SNAPSHOT 不传按上海今日）"
  echo "retired: 'idem' 恒 exit 2 —— 用 idem3（见文件头「已退役模式」）"
  exit 2
  ;;
esac
