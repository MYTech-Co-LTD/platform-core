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
# ④ 退出码契约：0 ⇒ 末行 `MATERIALIZE_OK`；1 ⇒ `MATERIALIZE_FAILED:<missing_env|dbt_build|noop>`。
#    `noop`（2026-11-07，#1537）：dbt 退出 0 **不等于**建了东西——选择器空匹配时 dbt 只打印
#    `Nothing to do.` 就退出 0。判据落 `mat_log_has_build`：日志须含 `PASS=<n>` 汇总行且不含
#    `Nothing to do`；否则本档/本域不落账并判失败（宁可红，也不报一个没物的 MATERIALIZE_OK）。
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
# 键集 12 个：DBT_HOST 是字面量（服务名，非敏感）；AUDIT_WINDOW_START/PATTERNS 由
# hourly 档在主流程里 export（#1614 窗口对账）；MAT_CLOSED_BEFORE 由主流程 export（闭窗读，
# 2026-11-08 P0）；其余 8 个由下方 export 供值。
mat_env_args() {
  printf '%s ' \
    -e DBT_HOST=pg_duckdb \
    -e DBT_USER -e DBT_PASSWORD -e DBT_DBNAME \
    -e LEMENG_ZOS_BUCKET -e LEMENG_ZOS_REGION -e LEMENG_ZOS_ENDPOINT \
    -e LEMENG_SUBJECT_ORG \
    -e DATA_PLANE_DOMAINS \
    -e AUDIT_WINDOW_START -e AUDIT_WINDOW_PATTERNS \
    -e MAT_CLOSED_BEFORE
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
# 判「dbt 真的建了东西」（#1537）：日志必须既有 `PASS=<n>` 汇总行、又不含 `Nothing to do`。
# 只有退出码不够——选择器匹配不到任何节点时 dbt 打印 `Nothing to do.` 并退出 0，照着打
# MATERIALIZE_OK 就是假绿（模型根本没建，水位还会假前进）。$1=日志文件；0=真跑过。
mat_log_has_build() {
  [ -f "$1" ] || return 1
  if grep -q 'Nothing to do' "$1"; then return 1; fi
  grep -Eq 'PASS=[0-9]+' "$1"
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
# 逐表水位 INSERT（spec §10.7.2）：$1=tests_pass $2=tests_error，$3..=`表名=max_bizday` 成对。
# 全部语句包在一个 BEGIN..COMMIT 里：now() 取**事务起点** ⇒ 同一次物化的全部行共享同一
# materialized_at（data_as_of = max(materialized_at) 与逐行语义都靠这个一致）。
# 旧「仓级」行（relation NULL）自本版起不再新写——历史行保留，水位查询只认 relation 非空。
#
# ⚠️ **为什么水位值由调用方算好、以字面量塞进来**（2026-11-07 真机实证，issue #1624）：
#   原形态是 `INSERT … SELECT max(bizday) … FROM staging.<视图>`，现真机报
#   **`ERROR: DuckDB does not support modififying Postgres tables`** ——
#   staging 模型自 2026-11-02（#1275 明细 staging 翻直读湖视图）起是**湖视图**，
#   pg_duckdb 把 `read_parquet` 扫描交给 DuckDB 引擎执行，而 DuckDB 引擎写不了 PG 堆表。
#   实测三分对照（2026-11-07）：
#     · `select max(bizday) from staging.stg_lemeng_branch_expense` ⇒ 2026-11-06 ✅
#     · `insert … select max(bizday) … from 同一视图` ⇒ 上述 ERROR ❌
#     · `insert … values ('x', date '2026-11-07', …)` ⇒ INSERT 0 1 ✅
#   ⇒ 取最大值用**纯 SELECT**（DuckDB 执行没问题），再以**字面量** INSERT（纯 PG 路径）。
#   历史 `stg_lemeng_*` 水位停在 2026-10-29 —— 正好是这次失败的起点，别再以为它一直在写。
mat_watermark_sql() {
  _wp=$1; _we=$2; shift 2
  case "$_wp" in ''|*[!0-9]*) _wp=NULL ;; esac
  case "$_we" in ''|*[!0-9]*) _we=NULL ;; esac
  printf 'BEGIN;\n'
  for _pair in "$@"; do
    _wt=${_pair%%=*}
    _mb=${_pair#*=}
    [ "$_pair" = "$_wt" ] && _mb=''
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
    # max_bizday 只接受 `YYYY-MM-DD` 字面量形状；其余（空/异常）落 NULL，绝不拼进 SQL。
    case "$_mb" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) _mbsql="date '${_mb}'" ;;
      *) _mbsql='NULL' ;;
    esac
    printf "INSERT INTO data.load_log (relation, max_bizday, materialized_at, tests_pass, tests_error, status) VALUES ('%s', %s, now(), %s, %s, 'ok');\n" \
      "$_wt" "$_mbsql" "$_wp" "$_we"
  done
  printf 'COMMIT;\n'
}
# 取各关系当前 max(bizday)——**纯 SELECT**（DuckDB 能执行湖视图扫描），输出 `表名=YYYY-MM-DD`
# （无值则 `表名=`）。$1..=关系名（已由调用方做过形状过滤）。
#
# ⚠️ 三条都是真机实证出来的（2026-11-07，issue #1622）：
#   ① **必须带下界字面量**：裸 `max(bizday)` 会 LIST 全部分区（730 天），单表 **>2 分钟不返回**；
#      加 `where bizday >= date '<字面量>'` 后按分区裁剪，30 天窗口实测 **2.4s**（90 天 4.5s）。
#   ② **逐表 fail-soft，不拼一条大 UNION ALL**：只要有一张表报错（如 `stg_lemeng_branch`
#      没有 bizday 列、或某视图暂时读不到），整条 UNION 全灭、23 张表全部落 NULL ——
#      实测就是这样丢了整批水位。逐表跑 ⇒ 坏的那张只丢它自己。
#   ③ 下界取 today−30 天：覆盖所有按日更新的源；更老的源落 NULL = 水位未知（诚实结果，
#      不是错误）。要更宽就改这一个数，代价是线性变慢。
mat_max_bizdays() {
  [ $# -gt 0 ] || return 0
  _lb=$(date -u -d '30 days ago' +%F 2>/dev/null || date -u -v-30d +%F 2>/dev/null || echo '1970-01-01')
  for _t in "$@"; do
    _v=$(docker exec -e PGPASSWORD="$PW" "$PG_CT" \
      psql -U "$UN" -d "$DB" -tA -c \
      "select coalesce(max(bizday)::text,'') from staging.${_t} where bizday >= date '${_lb}'" 2>/dev/null \
      | tr -d ' \r\n')
    case "$_v" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
      *) _v='' ;;
    esac
    printf '%s=%s\n' "$_t" "$_v"
  done
}
# 落账执行（复用先例的 docker exec psql 通路；凭据取 pg_duckdb 容器自注入的 env）。
# 问数执行池就是仓 ⇒ data_as_of 与数据查询同池单跳（spec §10.1 为什么写在仓内）。
# psql 失败**只告警不翻车**：退出码契约维持三态（0 / missing_env / dbt_build），成功的物化
# 不因记账失败 retry 整个 build；缺账由 data_as_of 停留旧值暴露（新鲜度未知 ≠ 捏造）。
mat_write_load_log() { # $1=tests_pass $2=tests_error $3..=水位表名
  _wp=$1; _we=$2; shift 2
  # 先纯 SELECT 取回各关系 max(bizday)（湖视图只能读、不能作为 INSERT…SELECT 的源，
  # 见 mat_watermark_sql 头注），再以字面量 INSERT。
  _pairs=$(mat_max_bizdays "$@" | sed '/^$/d')
  if [ -z "$_pairs" ]; then
    # 取不到 ⇒ 退回「表名=空」形态：仍写行（relation 在场、max_bizday NULL = 水位未知），
    # 与「解析不到 PASS/ERROR ⇒ NULL」同一 fail-soft 口径（缺账不如留一条未知）。
    _pairs=$(for _t in "$@"; do printf '%s=\n' "$_t"; done)
  fi
  _wsql="$(mat_load_log_sql)
$(mat_watermark_sql "$_wp" "$_we" $_pairs)"
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
# 闭窗读（2026-11-08 P0）：tick/hourly 物化排除「今天且 hour >= 当前小时」的分区，
# 避免与 10 分钟 tick 采集抢同一个正在重写的分区（DuckDB ETag）。
export MAT_CLOSED_BEFORE=true

# 物化档位（#1520）：full = 现有逐域全量；tick = 只跑销售明细增量（每 10 分钟档）。
# tick 是**一个具名模型**（不是手抄名单）：默认 fct_retail_sale，口径变更由模型自身表达。
SCOPE=${MATERIALIZE_SCOPE:-full}
TICK_SELECT=${MATERIALIZE_TICK_SELECT:-fct_retail_sale}
TICK_DOMAIN=${MATERIALIZE_TICK_DOMAIN:-lemeng}
# tick 只跑模型 + 它自带的 schema tests；`tests/lemeng/` 下的 singular 重活（audit_*/assert_*）
# 留给全量档（它按 path:tests/lemeng 选）。否则每 10 分钟跑一遍全史对账（实测单条 >90s）。
TICK_EXCLUDE=${MATERIALIZE_TICK_EXCLUDE:-path:tests/lemeng}
# 首次切增量（新增非空代理键等）用：显式 MATERIALIZE_TICK_FULL_REFRESH=1 才 --full-refresh。
TICK_FULL_REFRESH=${MATERIALIZE_TICK_FULL_REFRESH:-}
# 全量档必须**排除** tick 拥有的模型：tick 每 10 分钟 delete+insert 同一张表，
# 与全量档的 7 天 delete+insert 并发写同一张表会冲突（#1520）。
FULL_EXCLUDE=${MATERIALIZE_FULL_EXCLUDE:-fct_retail_sale}
echo "materialize start repo=${R} network=${NETWORK} image=${IMAGE} domains=${DOMAINS} scope=${SCOPE} mode=full_build（本面域内全量，无按需名单，#679）"
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

# ── tick 档（#1520）：只跑销售明细增量，供 openship job 每 10 分钟调用 ─────────────────
# 为什么单独一档：10 分钟一次全量重建物理上不可能（单轮 45–120 分钟）；增量后单表只重算
# 最近 7 天。选择器是**一个具名模型**（fct_retail_sale），不是按域全量；上游 staging 已是 view
# （2026-11-02 #1275），无需重建。水位照写 `data.load_log`（relation=fct_retail_sale），
# 新鲜度面与全量档同源。
if [ "$SCOPE" = tick ]; then
  echo "── tick: ${TICK_SELECT}（domain=${TICK_DOMAIN}${TICK_FULL_REFRESH:+ full-refresh}）──"
  _log="$_WORK/dbt.tick.log"
  _rc="$_WORK/dbt.tick.rc"
  # 首次切增量（模型新增非空代理键等）需要一次 --full-refresh；由 env 显式开启，
  # **不设默认**——默认开会让每次 tick 都全量重建（慢且吃内存）。
  if [ -n "$TICK_FULL_REFRESH" ]; then _TFR=--full-refresh; else _TFR=''; fi
  ( if DATA_PLANE_DOMAINS="$TICK_DOMAIN" docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
      $(mat_env_args) "$IMAGE" $(mat_dbt_args) $_TFR --select "$TICK_SELECT" --exclude "$TICK_EXCLUDE" 2>&1; then
    echo 0 >"$_rc"
  else
    echo $? >"$_rc"
  fi ) | tee "$_log"
  if [ "$(cat "$_rc")" != 0 ]; then
    echo "MATERIALIZE_FAILED:dbt_build（tick ${TICK_SELECT}）；retry 由 openship job 配置承担" >&2
    exit 1
  fi
  if ! mat_log_has_build "$_log"; then
    echo "MATERIALIZE_FAILED:noop（tick ${TICK_SELECT} 的 dbt 空跑：选择器没有匹配到可建节点，或输出缺 PASS= 汇总行）" >&2
    exit 1
  fi
  mat_write_load_log \
    "$(sed -n 's/.*PASS=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
    "$(sed -n 's/.*ERROR=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
    "$TICK_SELECT"
  echo "MATERIALIZE_OK scope=tick"
  exit 0
fi

# ── audit 档（#1614/#1619）：全史对账单独每日跑，不再拖慢每轮 build ─────────────────────
# 为什么分档：`audit_*` 每条都**独立全史复算**（read_parquet 扫 730 天），30 条串行
# 占 60+ 分钟；全量档已排除 audit 两档 tag，把全史对账降为每日一次（本档），
# 每轮 build 只留 schema tests + 便宜的 assert_*（粒度/键唯一）。
# 口径不变：audit 的 SQL 一个字没改，只是换了执行频次。
# tag 语义（#1619）：`tag:audit` = 只属每日全史档的对账；`tag:audit_window` = 每小时档
# 的十条核心对账（**不带** tag:audit，否则 hourly 档没法用 `--exclude tag:audit` 把它们
# 和被 eager 间选拖进来的 46 条全史对账一起减掉——真机实测 133 节点里混进了全史档）。
# 本档用并集把两档**都**全史跑一遍（窗口对账的 env 未设 = 全史，覆盖不变）。
if [ "$SCOPE" = audit ]; then
  echo "── audit: audit_* 两档并集（全史对账；每日独立 job）──"
  _log="$_WORK/dbt.audit.log"
  _rc="$_WORK/dbt.audit.rc"
  ( if DATA_PLANE_DOMAINS="$TICK_DOMAIN" docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
      $(mat_env_args) "$IMAGE" test --profiles-dir /usr/app --threads 1 --select 'tag:audit tag:audit_window' 2>&1; then
    echo 0 >"$_rc"
  else
    echo $? >"$_rc"
  fi ) | tee "$_log"
  if [ "$(cat "$_rc")" != 0 ]; then
    echo "MATERIALIZE_FAILED:dbt_build（audit 全史对账）；retry 由 openship job 配置承担" >&2
    exit 1
  fi
  echo "MATERIALIZE_OK scope=audit"
  exit 0
fi

# ── hourly 档（#1614/#1619）：增量模型 + 核心窗口 audit（每小时）──────────────────────
# 只跑 `config.materialized:incremental`（不碰全量 table / staging 视图测试 / 全史 audit），
# 并给**核心 audit**（tag:audit_window）传「月段字符类」窗口：`2026-10-3[0-1],2026-11-0[1-6]`。
# 实测（2026-11-07）：单串字符类 day 1.07s / hour 5.66s；按天 union 32 次读 = 219s+（比全史还慢）。
# ⇒ 窗口必须体现在**路径**上，且每个月段只发一次 read_parquet。
# ⚠️ 选择器语义（2026-11-07 真机 dbt ls 实证，dbt 1.9.1）：
#   · 逗号**不是**并集——`tag:audit,tag:audit_window` 是一个字面 criterion，匹配不到
#     任何节点（select 侧直接报「selection criterion does not match any nodes」）；
#     并集 = **空格**（同 mat_dbt_select 三段式先例）或重复 flag。
#   · `--exclude fct_retail_sale` 会**级联**删掉依赖它的 test——net_sales 对账
#     （ref fct_retail_sale）在本档被一并排除 ⇒ hourly 实际跑 **9 条**窗口对账；
#     retail 域的小时级新鲜度由 net_quantity（读同一份湖）覆盖，net_sales 走每日全史档。
#   · 不加 `--exclude tag:audit` 也不行：dbt build 的 **eager 间选**会把 ref() 了被选
#     模型的 singular test 全部拖进来（实测 133/147 节点混进 46 条全史对账）。
#   · 十条窗口对账因此**不带** tag:audit（带了两挡的排除法就不成立），每日档用并集收它们。
if [ "$SCOPE" = hourly ]; then
  # 窗口 = **增量 lookback 窗口**（today−7 .. 昨天），不是月初（2026-11-07 真机实证）：
  #   增量 mart 只重建 `max(bizday)−7` 之后的分区，更老的列是**建表当时的快照**——源头若
  #   事后重述/重采，mart 不会跟着变。audit 窗口若比这更宽，那些老分区必然「湖新 mart 旧」
  #   假红（实测 transfer 2260 条差异 **全部** 落在 10-01..10-27，无一在 7 天内）。
  #   小时对账的语义就是「验本轮刚重建的那部分」，全史由每日 09:00 的全史 audit job 负责。
  #   9 张被审 mart 的 lookback 实测都是 7（见各模型 incremental_cutoff(7)）。
  # 路径 glob 仍用「上月+本月」融合字符类（粗过滤，够覆盖 7 天窗口的两个月边界）。
  _win=$(python3 - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
first_this = today.replace(day=1)
first_prev = (first_this - timedelta(days=1)).replace(day=1)
def fuse(a, b):
    out = ''
    for ca, cb in zip(a, b):
        out += ca if ca == cb else f'[{ca}{cb}]'
    return out
ym1, ym2 = first_prev.strftime('%Y-%m'), first_this.strftime('%Y-%m')
print((today - timedelta(days=7)).isoformat(), fuse(ym1, ym2) + '-*')
PY
)
  AUDIT_WINDOW_START=${_win%% *}
  AUDIT_WINDOW_PATTERNS=${_win#* }
  export AUDIT_WINDOW_START AUDIT_WINDOW_PATTERNS
  echo "── hourly: incremental + window audits（start=${AUDIT_WINDOW_START} lookback-glob=${AUDIT_WINDOW_PATTERNS}）──"
  _log="$_WORK/dbt.hourly.log"
  _rc="$_WORK/dbt.hourly.rc"
  # ── 节点级重试（2026-11-07，issue #1621）─────────────────────────────────────────
  # 物化读**活湖**：零售采集每 10 分钟重写「当前小时 + 上一小时」，DuckDB 的 ETag 校验在读取
  # 途中发现文件换版 ⇒ **整个节点** Database Error。实测单轮 107/108 通过、失败随手落在不同节点
  # （item_sale / retail_quantity / inventory audit 都中过枪）。
  # job 级重跑要重跑整轮 8 分钟；这里只从 `run_results.json` 取**失败节点**重跑，几秒收敛。
  # ⚠️ 收敛判据是「没有失败节点」而不是「退出 0」：dbt 的 warn（test 软失败）不该触发重跑。
  _attempt=1
  # `stg_lemeng_branch` 进小时档（2026-11-08 战区变更事故）：它是 **table 模型**，原先只有全量档
  # 才重建 ⇒ 源端改了门店战区后，stg 一直是旧值，而审计**直读湖**（最新 snapshot）⇒ 每轮 20 行
  # 假红，且 mart 侧继续按旧战区落行。门店维只有几百行，小时重建成本可忽略；dbt 按 DAG 先建 stg
  # 再建增量 mart，所以同一轮里 mart 就能吃到新维表。
  _select="config.materialized:incremental tag:audit_window stg_lemeng_branch"
  while :; do
    if [ "$_attempt" = 1 ]; then
      _excl="--exclude tag:audit --exclude fct_retail_sale"
    else
      _excl=''
    fi
    ( if DATA_PLANE_DOMAINS="$TICK_DOMAIN" docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
        $(mat_env_args) "$IMAGE" $(mat_dbt_args) --select "$_select" $_excl 2>&1; then
      echo 0 >"$_rc"
    else
      echo $? >"$_rc"
    fi ) | tee -a "$_log"
    _failed="$(python3 "$R/scripts/lemeng/dbt-failed-nodes.py" "$R/dbt/target/run_results.json" 2>/dev/null || true)"
    if [ -z "$_failed" ]; then
      [ "$(cat "$_rc")" = 0 ] && break
      # 退出码非 0 但解析不出失败节点（run_results 缺失/形状变了）⇒ 不猜，直接判失败
      echo "MATERIALIZE_FAILED:dbt_build（hourly：退出码非 0 且解析不出失败节点）" >&2
      exit 1
    fi
    if [ "$_attempt" -ge 3 ]; then
      echo "MATERIALIZE_FAILED:dbt_build（hourly：失败节点重试 ${_attempt} 轮仍有：${_failed}）" >&2
      exit 1
    fi
    _attempt=$((_attempt + 1))
    echo "── hourly 重试第 ${_attempt} 轮（仅失败节点）：${_failed} ──"
    _select="$_failed"
  done
  if ! mat_log_has_build "$_log"; then
    echo "MATERIALIZE_OK scope=hourly noop（选择器没有匹配到任何节点）"
    exit 0
  fi
  # ── 水位落账（2026-11-07 补漏，真机实证）─────────────────────────────────────────
  # 不落账的后果：`freshness_relations` 读的是 `stg_lemeng_*` 的 max_bizday，
  # 而 full 档停用后**只有 tick 档写过 `fct_retail_sale`** ⇒ 其余 relation 的 data_as_of
  # 停在 full 档停用那天（实测 load_log 里 12 行全是 fct_retail_sale）⇒ 新鲜度面全面失真。
  # 只在本轮**构建成功**后落账（失败不写 = 不假报新鲜）；表集与全量档同源派生。
  _tables=''
  for _m in $(mat_domain_staging_models "$R" "$TICK_DOMAIN"); do
    case " ${MAT_TABLES_ALL} " in *" ${_m} "*) _tables="${_tables} ${_m}";; esac
  done
  if [ -z "$_tables" ]; then
    echo "materialize warn: hourly 档没有可落账的表（本域 staging 无含 bizday 列的表？）" >&2
  else
    mat_write_load_log \
      "$(sed -n 's/.*PASS=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
      "$(sed -n 's/.*ERROR=\([0-9]*\).*/\1/p' "$_log" | tail -n 1)" \
      $_tables
  fi
  echo "MATERIALIZE_OK scope=hourly"
  exit 0
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
_NOOP_DOMAINS=''
_OK_DOMAINS=''
for _d in $(printf '%s' "$DOMAINS" | tr ',' ' '); do
  [ -n "$_d" ] || continue
  echo "── domain ${_d} ──"
  _log="$_WORK/dbt.${_d}.log"
  _rc="$_WORK/dbt.${_d}.rc"
  # 逐命令 env 赋值 ⇒ docker CLI 只看到这一个域，`-e DATA_PLANE_DOMAINS` 透传的就是它。
  # `--exclude`：全量档不写 tick 拥有的模型（见 FULL_EXCLUDE 注释）。
  if [ -n "$FULL_EXCLUDE" ]; then _EXC="--exclude ${FULL_EXCLUDE}"; else _EXC=''; fi
  ( if DATA_PLANE_DOMAINS="$_d" docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
      $(mat_env_args) "$IMAGE" $(mat_dbt_args) --select "$(mat_dbt_select "$_d")" ${_EXC} --exclude 'tag:audit tag:audit_window' 2>&1; then
    echo 0 >"$_rc"
  else
    echo $? >"$_rc"
  fi ) | tee "$_log"
  if [ "$(cat "$_rc")" != 0 ]; then
    _FAILED_DOMAINS="${_FAILED_DOMAINS} ${_d}"
    echo "materialize warn: 域 ${_d} 的 dbt 非零退出 ⇒ **本域不落账**（其余域继续，不被拖停）" >&2
    continue
  fi
  # #1537：退出 0 也可能是空跑（`Nothing to do.` / 无 PASS 汇总）⇒ 不落账、判 noop。
  if ! mat_log_has_build "$_log"; then
    _NOOP_DOMAINS="${_NOOP_DOMAINS} ${_d}"
    echo "materialize warn: 域 ${_d} 的 dbt 空跑（无 PASS= 汇总行或 Nothing to do）⇒ **本域不落账**，判 MATERIALIZE_FAILED:noop" >&2
    continue
  fi
  # 本域要落账的表 = 「全 bizday 表」∩「本域的 staging 模型名」。
  # 模型名从**树**派生（`mat_domain_staging_models`）而不是手写：与 `+enabled` 同源同一棵树
  # ⇒ 新增模型自动纳入，不存在「名单没跟」的静默面（#679 的病）。
  _tables=''
  for _m in $(mat_domain_staging_models "$R" "$_d"); do
    # 全量档排除了 tick 拥有的模型 ⇒ 不能给它写水位（否则 data_as_of 假前进）。
    [ -n "$FULL_EXCLUDE" ] && [ "$_m" = "$FULL_EXCLUDE" ] && continue
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
# 只有 noop 时给专属码；同时有 dbt_build 时上面已以更严重的码退出（noop 域已在逐域告警点名）。
if [ -n "$_NOOP_DOMAINS" ]; then
  echo "MATERIALIZE_FAILED:noop（域${_NOOP_DOMAINS} 的 dbt 空跑：选择器没有匹配到可建节点，或输出缺 PASS= 汇总行；不落账）" >&2
  exit 1
fi
echo "MATERIALIZE_OK"
