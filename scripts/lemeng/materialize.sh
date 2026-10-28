#!/bin/sh
# materialize.sh — 乐檬数据面 dbt 物化的命令真身（openship job `lemeng-dbt-materialize` 只调 `sh /opt/lemeng-materialize.sh`，#679）
#
# ① 为什么进仓：此前命令只活在 openship job 里（无版本、无 diff 可评审），SOP 手抄名单已经
#    漂移过（2026-10-15 停在 26 节点），且 #677 假绿（新模型漏加名单 ⇒ 解析数涨、执行集不变、
#    run 照绿）正是这套「手抄 + 无守卫」的结构性产物。
#
# ② 为什么全量 build、当初没有 --select（#679 用户裁决 + 26/26 实证）：仓内 23 模型（stg×14 + fct×9）
#    + 3 种子 = 26 节点，与去名单前的白名单**逐一对上**——全量执行与今日行为逐节点等价，
#    但新模型从此**自动纳入**，#677 假绿在结构上不可能再发生。副产收益：孤儿 singular 测试
#    `audit_lemeng__retail__hour_row_count`（无 ref()，白名单态被解析但从未执行）从今天起每天真跑——
#    它红是**真断崖信号**（同小时行数低于 14 天中位数的 0.5 倍），不是 job 故障。
#    将来若真出现「不该日物化」的模型，用该模型的 config 或 `--exclude` 表达，**不要恢复 job 级名单**。
#    ⚠️ 2026-10-17 起「全量」的含义收窄为**本数据面拥有的域内全量**（`DATA_PLANE_DOMAINS`）：
#    多个数据面共用一棵 dbt/ 树，不裁剪时**两侧互 build 对方模型**（本方侧反向泄漏／对方侧 dbt 红）。
#    裁剪落在 `dbt_project.yml` 的**按路径 `+enabled`**（即 ② 说的「用模型 config 表达」），
#    不是本脚本里的名单 —— 本脚本只负责把**域身份**（一个部署属性）透传进去。
#    ⚠️ **2026-10-18 补漏：`+enabled` 管不到 `dbt/tests/`。** `+enabled` 是按 `models:` 路径配的，
#    而 singular test 住在 `dbt/tests/` ⇒ 真机实测：forms 面上**乐檬的 singular test 照跑**，
#    去读本面并不存在的 `lemeng/` 前缀 ⇒ 该域 dbt 红 ⇒ 本域水位写不进去。故逐域 build 现在
#    带一个**派生**选择器（见 `mat_dbt_args`）：`path:models/<域>` + `config.materialized:seed`
#    + `path:tests/<域>`。**它仍不是 ② 反对的那种手抄名单** —— 三个片段全部从域身份 + 目录树
#    派生，#677/#679 的「新模型自动纳入」性质不变（新模型落在本域目录下就自动进选择集）；
#    同时**保住了孤儿哨兵** `audit_lemeng__retail__hour_row_count`（它在 `tests/lemeng/` 下，
#    被 `path:tests/lemeng` 选中；若只用 `path:models/<域>` 会把它漏掉）。
#
# ⑤ 为什么**逐域**跑（2026-10-17，爆炸半径）：`data.load_log` 是全部 relation 新鲜度的单一水位
#    来源，而 dbt 一红就整体 exit 1 ⇒ 一个模型红 = **所有** relation 的 data_as_of 一起停
#    （同日实测两次：#833、#834 各自新增的 audit 各红一次，两次都冻结全量）。逐域跑后，红的域
#    不落账、其余域照常落账 ⇒ 故障面收窄到该域。**仍不是按需名单**（#679）：命令还是 `build`、
#    无 `--select`，域裁剪仍由 `+enabled` 表达，本脚本不持模型名单 —— 只是把域身份逐次收成单个值。
#    （2026-10-18 起本脚本**确实**加了一个 `--select`，但它是**从域身份派生**的三段式，不是手抄
#     名单；理由见上一段的「补漏」与 `mat_dbt_select`。头注 ② 的「26/26 全量」性质与之不冲突：
#     选择集仍随目录树自动增长。）
#
# ③ env 舞步：值一律运行时从运行中的容器 `docker inspect` 取（不落盘、不落 job 配置），
#    再以 `docker run -e VAR`（**透传形态**，只带键名）传给 dbt 容器 ⇒ 值不进 ps。
#    AK/SK **不注入**：模型不建 S3 secret，pg_duckdb 的持久 secret 直读湖——
#    多注入反而可能覆盖持久 secret（别「修」这个）。
#
# ④ 退出码契约：0 ⇒ 末行 `MATERIALIZE_OK`；1 ⇒ `MATERIALIZE_FAILED:<missing_env|dbt_build>`。
#    retry 由 openship job 配置承担（现状 retry 2×/300s）。
#    ⚠️ 2026-10-17 起 `dbt_build` 是**逐域**判的：域是**串行跑、跑完一个域就落一次账**，
#    红的域不落账、其余域照常落账，最后统一 exit 1（见 ⑤）。⇒ 一次红不再冻结**全部**新鲜度。
#    ⚠️ 本文件里 `$VAR` 相邻中文一律写 `${VAR}`（issue #212，bash 3.2 会把多字节首字节吃进变量名）。
set -eu

R=${MATERIALIZE_REPO_DIR:-/opt/platform-core-data/platform-core}
PG_CT=${MATERIALIZE_PG_CT:-openship-platform-core-shanhai-data-pg_duckdb}
CONSOLE_CT=${MATERIALIZE_CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-3120}
PLAT_CT=${MATERIALIZE_PLAT_CT:-openship-platform-core-shanhai-postgres}
NETWORK=${MATERIALIZE_NETWORK:-openship-platform-core-shanhai-data}
IMAGE=${MATERIALIZE_DBT_IMAGE:-platform-core-dbt:local}

# ── 判别面（materialize.test.sh 从这里抽函数测；这些函数不许碰 docker）──────────
# 透传键清单：只透传**键名**（`-e VAR` 形态）——值写进 argv 就进 ps。
# 键集 9 个：DBT_HOST 是字面量（服务名，非敏感），其余 8 个由下方 export 供值。
mat_env_args() {
  printf '%s ' \
    -e DBT_HOST=pg_duckdb \
    -e DBT_USER -e DBT_PASSWORD -e DBT_DBNAME \
    -e LEMENG_ZOS_BUCKET -e LEMENG_ZOS_REGION -e LEMENG_ZOS_ENDPOINT \
    -e LEMENG_SUBJECT_ORG \
    -e DATA_PLANE_DOMAINS
}
# dbt 命令：`build`（seed+model+test 一把跑，按 DAG 依赖序）。**选择器由调用方按域追加**
# （`--select "$(mat_dbt_select <域>)"`），所以本函数只给固定前缀。
# ⚠️ `--threads 1`（2026-10-28，issue #1157）：**并发连接数直接决定 pg_duckdb 的内存峰值**
#   （每连接一个 DuckDB 实例，`duckdb.memory_limit=1536MB`/连接）。实测：默认 2 线程物化期间
#   postmaster 反复 `terminating any other active server processes; reinitializing`，该轮测试大面积
#   `Database Error`（07:27 那轮 PASS=12 ERROR=41），而空闲期零重启 ⇒ 与 dbt test 阶段严格同步。
#   串行化把峰值压到单连接；代价是物化时长约 ×1.5~2。**本函数体保持单行 printf**：
#   `materialize.test.sh` 用「剥首行与闭括号行、取载荷首词」的方式抽取命令，插注释会打挂该断言。
mat_dbt_args() {
  printf '%s ' build --profiles-dir /usr/app --threads 1
}
# **按域派生**的选择器（不是手抄名单）：三段都由「域身份 + 目录树」得出 ——
#   `path:models/<域>`           本域的模型（其 schema tests 随之间接选中）
#   `config.materialized:seed`   seed 全域共享（不按域分），照旧加载
#   `path:tests/<域>`            本域的 singular test（含无 ref() 的孤儿哨兵）
# 为什么不用 `+enabled` 一把梭：它只作用于 `models:` 路径，管不到 `dbt/tests/`（见头注 ②）。
# ⚠️ 它**必须**作为 docker run 行里的**一个带引号的实参**传下去：塞进 `$(mat_dbt_args)`
#    这种命令替换里会被词分割切成三段，dbt 只会收到 `--select path:models/<域>` 一小截。
mat_dbt_select() { # $1=域 → 打印给 --select 的**单个**值（调用方自己加引号）
  printf '%s' "path:models/$1 config.materialized:seed path:tests/$1"
}
# 守卫：关键值缺失即响亮失败（fail-fast）。$1=名字（报错定位用） $2=值
mat_require() {
  [ -n "$2" ] && return 0
  echo "MATERIALIZE_FAILED:missing_env 取不到 ${1}（容器不在，或该容器没注入这个 env？）" >&2
  return 1
}
# 物化落账 DDL（spec §10.1 + §10.7.2）：幂等建表 + 幂等补逐关系水位两列（relation/max_bizday，
# 可空、兼容旧行）。抽成纯函数是判别面——materialize.test.sh 从本脚本抽真函数断言形状，不复制实现。
# （PASS/ERROR 的落位归水位语句 mat_watermark_sql 管，这里只管 schema。）
mat_load_log_sql() {
  printf '%s\n' \
    'CREATE SCHEMA IF NOT EXISTS data;' \
    'CREATE TABLE IF NOT EXISTS data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text);' \
    'ALTER TABLE data.load_log ADD COLUMN IF NOT EXISTS relation text;' \
    'ALTER TABLE data.load_log ADD COLUMN IF NOT EXISTS max_bizday date;'
}
# 逐表水位 INSERT（spec §10.7.2）：$1=tests_pass $2=tests_error，$3..=staging schema 内含 bizday
# 列的表名（清单由主流程经 information_schema 动态点名，无 bizday 的维度表自然不在列）。
# 全部语句包在一个 BEGIN..COMMIT 里：now() 取**事务起点** ⇒ 同一次物化的全部行共享同一
# materialized_at（data_as_of = max(materialized_at) 与逐行语义都靠这个一致）。
# 旧「仓级」行（relation NULL）自本版起不再新写——历史行保留，水位查询只认 relation 非空。
mat_watermark_sql() {
  _wp=$1; _we=$2; shift 2
  case "$_wp" in ''|*[!0-9]*) _wp=NULL ;; esac
  case "$_we" in ''|*[!0-9]*) _we=NULL ;; esac
  printf 'BEGIN;\n'
  for _wt in "$@"; do
    # 表名拼进 SQL 前按标识符安全形状收口：异常名 fail-soft 跳过 + 告警点名（缺一张表的水位
    # 可由下次物化补上，不该让一个异常名炸掉整批，更不能把垃圾拼进 SQL）。
    # ⚠️ 形状判定**必须钉死 locale**（CI fix round 1）：`case "$_wt" in *[!a-z0-9_]*)` 的
    # 括号区间按**运行时 collation** 解释——glibc 的 UTF-8 locale 里 a-z 的排序跨度罩住
    # 大写字母（A 排在 a 与 b 之间），与 macOS 的 ASCII 语义相反 ⇒ 同一个名字两平台判定
    # 相反（实测：stg_OK1 本地判「安全」、CI 判「异常跳过」⇒ INSERT 缺失、门禁红）。
    # 故改用 `LC_ALL=C grep` 逐字节判「含 a-z0-9_ 之外的字符」——C locale 无 collation
    # 概念，跨平台确定。大写名判异常也是**正确语义**：PG 未加引号的标识符折叠成小写，
    # `staging.stg_OK1` 本来就指不到那张表。
    if [ -z "$_wt" ] || printf '%s' "$_wt" | LC_ALL=C grep -q '[^a-z0-9_]'; then
      echo "materialize warn: 水位跳过异常表名 ${_wt}" >&2
      continue
    fi
    printf "INSERT INTO data.load_log (relation, max_bizday, materialized_at, tests_pass, tests_error, status) SELECT '%s', max(bizday), now(), %s, %s, 'ok' FROM staging.%s;\n" \
      "$_wt" "$_wp" "$_we" "$_wt"
  done
  printf 'COMMIT;\n'
}
# 落账执行（复用先例的 docker exec psql 通路；凭据取 pg_duckdb 容器自注入的 env）。
# 问数执行池就是仓 ⇒ data_as_of 与数据查询同池单跳（spec §10.1 为什么写在仓内）。
# psql 失败**只告警不翻车**：退出码契约维持三态（0 / missing_env / dbt_build），成功的物化
# 不因记账失败 retry 整个 build；缺账由 data_as_of 停留旧值暴露（新鲜度未知 ≠ 捏造）。
mat_write_load_log() { # $1=tests_pass $2=tests_error $3..=水位表名
  _wp=$1; _we=$2; shift 2
  _wsql="$(mat_load_log_sql)
$(mat_watermark_sql "$_wp" "$_we" "$@")"
  docker exec -e PGPASSWORD="$PW" "$PG_CT" \
    psql -U "$UN" -d "$DB" -v ON_ERROR_STOP=1 -q -c "$_wsql" \
    || echo "materialize warn: load_log 落账失败（物化本身已成功；data_as_of 将停留旧值，新鲜度面降级）" >&2
}

# 本域的 staging 模型名（每行一个）——**从树派生**，不是手写名单。
# 落点两处都扫：`dbt/models/<域>/staging/*.sql` 与域内的客户分叉
# `dbt/models/<域>/customers/<客户>/staging/*.sql`（二维格子，见 dbt/models/README.md）。
# 纯函数（只吃实参、不碰 docker/全局）⇒ materialize.test.sh 抽真函数断言，不复制实现。
mat_domain_staging_models() { # $1=检出根 $2=域
  for _f in "$1/dbt/models/$2"/staging/*.sql "$1/dbt/models/$2"/customers/*/staging/*.sql; do
    [ -f "$_f" ] || continue
    _b=${_f##*/}
    printf '%s\n' "${_b%.sql}"
  done
}

# ── 运行时取值（不落盘、不落 argv；stderr 静默 ⇒ 容器不在时值取空、由 mat_require 兜）──
ct_env() {
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n "s/^$2=//p"
}
PW=$(ct_env "$PG_CT" POSTGRES_PASSWORD); UN=$(ct_env "$PG_CT" POSTGRES_USER); DB=$(ct_env "$PG_CT" POSTGRES_DB)
ZB=$(ct_env "$CONSOLE_CT" ZOS_BUCKET); ZR=$(ct_env "$CONSOLE_CT" ZOS_REGION); ZE=$(ct_env "$CONSOLE_CT" ZOS_ENDPOINT)
PPW=$(ct_env "$PLAT_CT" POSTGRES_PASSWORD); PUN=$(ct_env "$PLAT_CT" POSTGRES_USER); PDB=$(ct_env "$PLAT_CT" POSTGRES_DB)

# 守卫比旧 job 命令多 UN/DB/ZR/ZE 四项（有意收紧）：ZE 缺失会静默路由到 AWS 默认端点、
# UN/DB 缺失要等 dbt 连库才炸——四项都属于「晚失败难定位」类，进容器前就该拦下。
mat_require 'POSTGRES_PASSWORD(pg_duckdb)' "$PW" || exit 1
mat_require 'POSTGRES_USER(pg_duckdb)' "$UN" || exit 1
mat_require 'POSTGRES_DB(pg_duckdb)' "$DB" || exit 1
mat_require 'ZOS_BUCKET(console)' "$ZB" || exit 1
mat_require 'ZOS_REGION(console)' "$ZR" || exit 1
mat_require 'ZOS_ENDPOINT(console)' "$ZE" || exit 1
SO=$(docker exec -e PGPASSWORD="$PPW" "$PLAT_CT" psql -U "$PUN" -d "$PDB" -tAc \
  'select casdoor_org from platform.tenant order by id limit 1' 2>/dev/null | tr -d ' \r\n')
mat_require 'LEMENG_SUBJECT_ORG(platform.tenant 首行)' "$SO" || exit 1
# 域身份：本数据面**拥有哪些域**（逗号分隔），dbt 侧按它裁剪物化集（docs/architecture.md §2.5）。
# 值是**部署属性**，不是从容器里取的 ⇒ 由 openship job 的 env 给（job 侧键名同名 DATA_PLANE_DOMAINS）。
# ⚠️ **刻意不给默认值**：给个 `lemeng` 默认会让任何漏配的新面**静默 build 乐檬模型**
#    （反向泄漏，方向与 #729 相反）；给空串则 dbt 侧解析出 0 个模型、退出 0、照打 MATERIALIZE_OK
#    （2026-10-17 实测的假绿）。故这里**空即响亮失败**，宁可停也不猜。
DOMAINS=${DATA_PLANE_DOMAINS:-}
mat_require 'DATA_PLANE_DOMAINS(本数据面拥有的域，逗号分隔；job env 注入)' "$DOMAINS" || exit 1

# profiles.yml 机器本地（不进仓；模板 = 仓内 dbt/profiles.example.yml，纯 env_var() 引用无真值）。
# 缺失时自愈一份（首次部署/检出重建的兜底）；已人工调过的不会被覆盖。
[ -f "$R/dbt/profiles.yml" ] || {
  echo "profiles.yml 缺失，从 profiles.example.yml 派生（模板纯 env_var 引用，无真值）"
  cp "$R/dbt/profiles.example.yml" "$R/dbt/profiles.yml"
}

export DBT_HOST=pg_duckdb DBT_USER="$UN" DBT_PASSWORD="$PW" DBT_DBNAME="$DB"
export LEMENG_ZOS_BUCKET="$ZB" LEMENG_ZOS_REGION="$ZR" LEMENG_ZOS_ENDPOINT="$ZE"
export LEMENG_SUBJECT_ORG="$SO"
export DATA_PLANE_DOMAINS="$DOMAINS"

echo "materialize start repo=${R} network=${NETWORK} image=${IMAGE} domains=${DOMAINS} mode=full_build（本面域内全量，无按需名单，#679）"
# dbt 输出 tee 进临时日志：job 的实时流保持不变，同时留一份可解析的汇总行（Done. PASS=n … ERROR=m）。
# 退出码用 rc 文件带出（POSIX sh 无 pipefail/PIPESTATUS；管道末位是 tee，不能直接判 dbt）。
_WORK=$(mktemp -d "${TMPDIR:-/tmp}/materialize.XXXXXX")
trap 'rm -rf "$_WORK"' EXIT

# ── 水位表清单（全 staging 内含 bizday 列的表）────────────────────────────────────
# 与**域无关**，只点名一次；逐域落账时再按「本域的 staging 模型名」取子集（见下）。
# 点名失败/为空 ⇒ 零水位行 + 告警（新鲜度缺账 ≠ 翻车，data_as_of 停留旧值暴露）。
MAT_TABLES_ALL=$(docker exec -e PGPASSWORD="$PW" "$PG_CT" psql -U "$UN" -d "$DB" -tAc \
  "SELECT table_name FROM information_schema.columns WHERE table_schema='staging' AND column_name='bizday' GROUP BY table_name ORDER BY table_name" 2>/dev/null \
  | tr -d '\r' | sed '/^[[:space:]]*$/d' | tr '\n' ' ' || true)
if [ -z "$MAT_TABLES_ALL" ]; then
  echo "materialize warn: 水位表清单为空（staging 无含 bizday 列的表，或点名查询失败）——各域都不写逐表水位，data_as_of 将停留旧值" >&2
fi

# ── 逐域 build + 逐域落账（拆爆炸半径，2026-10-17）────────────────────────────────
# 为什么逐域：`data.load_log` 是**全部** relation 新鲜度的单一水位来源，而 dbt 一旦红就整体
# exit 1 ⇒ **一个模型红会让所有 relation 的 data_as_of 一起停**（2026-10-17 一天内实测两次：
# #833 与 #834 各自新增的 audit 各红一次，每次都冻结全量）。逐域跑之后，红的那个域不落账、
# 其余域照常落账 ⇒ 故障面收窄到该域。
# ⚠️ 仍然**不是**按需名单（#679）：命令还是 `build`，选择器三段全从域身份 + 目录树派生
#    （见 `mat_dbt_select`），域裁剪的第一道仍由
#    `dbt_project.yml` 的按路径 `+enabled` 表达，本脚本**不持任何模型名单** —— 它只是把域身份
#    从「一串」收成「一个」逐次喂进去（同一个变量，值域收窄）。
# PASS/ERROR 取该域日志的汇总行（sed 贪婪匹配取该行最后一个 PASS=/ERROR=，行级结果
# `[PASS in 0.1s]` 无等号不会误中）；解析不到 ⇒ 水位行带 NULL，照常落账。
_FAILED_DOMAINS=''
_OK_DOMAINS=''
for _d in $(printf '%s' "$DOMAINS" | tr ',' ' '); do
  [ -n "$_d" ] || continue
  echo "── domain ${_d} ──"
  _log="$_WORK/dbt.${_d}.log"
  _rc="$_WORK/dbt.${_d}.rc"
  # 逐命令 env 赋值 ⇒ docker CLI 只看到这一个域，`-e DATA_PLANE_DOMAINS` 透传的就是它。
  ( if DATA_PLANE_DOMAINS="$_d" docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
      $(mat_env_args) "$IMAGE" $(mat_dbt_args) --select "$(mat_dbt_select "$_d")" 2>&1; then
    echo 0 >"$_rc"
  else
    echo $? >"$_rc"
  fi ) | tee "$_log"
  if [ "$(cat "$_rc")" != 0 ]; then
    _FAILED_DOMAINS="${_FAILED_DOMAINS} ${_d}"
    echo "materialize warn: 域 ${_d} 的 dbt 非零退出 ⇒ **本域不落账**（其余域继续，不被拖停）" >&2
    continue
  fi
  # 本域要落账的表 = 「全 bizday 表」∩「本域的 staging 模型名」。
  # 模型名从**树**派生（`mat_domain_staging_models`）而不是手写：与 `+enabled` 同源同一棵树
  # ⇒ 新增模型自动纳入，不存在「名单没跟」的静默面（#679 的病）。
  _tables=''
  for _m in $(mat_domain_staging_models "$R" "$_d"); do
    case " ${MAT_TABLES_ALL} " in *" ${_m} "*) _tables="${_tables} ${_m}";; esac
  done
  if [ -z "$_tables" ]; then
    echo "materialize warn: 域 ${_d} 没有可落账的表（本域 staging 无含 bizday 列的表？）——本域零水位行" >&2
  fi
  mat_write_load_log \
    "$(sed -n 's/.*PASS=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
    "$(sed -n 's/.*ERROR=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
    $_tables
  _OK_DOMAINS="${_OK_DOMAINS} ${_d}"
done

if [ -n "$_FAILED_DOMAINS" ]; then
  echo "MATERIALIZE_FAILED:dbt_build（域${_FAILED_DOMAINS} 的 dbt 非零退出；已成功域${_OK_DOMAINS:-（无）} 照常落账；retry 由 openship job 配置承担）" >&2
  exit 1
fi
echo "MATERIALIZE_OK"
