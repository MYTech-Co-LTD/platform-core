#!/bin/sh
# materialize.sh — 乐檬数据面 dbt 物化的命令真身（openship job `lemeng-dbt-materialize` 只调 `sh /opt/lemeng-materialize.sh`，#679）
#
# ① 为什么进仓：此前命令只活在 openship job 里（无版本、无 diff 可评审），SOP 手抄名单已经
#    漂移过（2026-10-15 停在 26 节点），且 #677 假绿（新模型漏加名单 ⇒ 解析数涨、执行集不变、
#    run 照绿）正是这套「手抄 + 无守卫」的结构性产物。
#
# ② 为什么全量 build、没有 --select（#679 用户裁决 + 26/26 实证）：仓内 23 模型（stg×14 + fct×9）
#    + 3 种子 = 26 节点，与去名单前的白名单**逐一对上**——全量执行与今日行为逐节点等价，
#    但新模型从此**自动纳入**，#677 假绿在结构上不可能再发生。副产收益：孤儿 singular 测试
#    `audit_lemeng__retail__hour_row_count`（无 ref()，白名单态被解析但从未执行）从今天起每天真跑——
#    它红是**真断崖信号**（同小时行数低于 14 天中位数的 0.5 倍），不是 job 故障。
#    将来若真出现「不该日物化」的模型，用该模型的 config 或 `--exclude` 表达，**不要恢复 job 级名单**。
#
# ③ env 舞步：值一律运行时从运行中的容器 `docker inspect` 取（不落盘、不落 job 配置），
#    再以 `docker run -e VAR`（**透传形态**，只带键名）传给 dbt 容器 ⇒ 值不进 ps。
#    AK/SK **不注入**：模型不建 S3 secret，pg_duckdb 的持久 secret 直读湖——
#    多注入反而可能覆盖持久 secret（别「修」这个）。
#
# ④ 退出码契约：0 ⇒ 末行 `MATERIALIZE_OK`；1 ⇒ `MATERIALIZE_FAILED:<missing_env|dbt_build>`。
#    retry 由 openship job 配置承担（现状 retry 2×/300s）。
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
# 键集 8 个：DBT_HOST 是字面量（服务名，非敏感），其余 7 个由下方 export 供值。
mat_env_args() {
  printf '%s ' \
    -e DBT_HOST=pg_duckdb \
    -e DBT_USER -e DBT_PASSWORD -e DBT_DBNAME \
    -e LEMENG_ZOS_BUCKET -e LEMENG_ZOS_REGION -e LEMENG_ZOS_ENDPOINT \
    -e LEMENG_SUBJECT_ORG
}
# dbt 命令：全量 build（seed+model+test 一把跑，按 DAG 依赖序）。没有 --select（#679 定案，见头注②）。
mat_dbt_args() {
  printf '%s ' build --profiles-dir /usr/app
}
# 守卫：关键值缺失即响亮失败（fail-fast）。$1=名字（报错定位用） $2=值
mat_require() {
  [ -n "$2" ] && return 0
  echo "MATERIALIZE_FAILED:missing_env 取不到 ${1}（容器不在，或该容器没注入这个 env？）" >&2
  return 1
}
# 物化落账 SQL（spec §10.1）：幂等建表 + 追加一行 status='ok'。抽成纯函数是判别面——
# materialize.test.sh 从本脚本抽真函数断言形状，不复制实现。$1=tests_pass $2=tests_error
# （dbt 汇总行的两个数；空/非数字一律落 NULL——落账不因解析失败而缺账，更不把垃圾拼进 SQL）。
mat_load_log_sql() {
  _p=$1; _e=$2
  case "$_p" in ''|*[!0-9]*) _p=NULL ;; esac
  case "$_e" in ''|*[!0-9]*) _e=NULL ;; esac
  printf '%s %s\n' \
    'CREATE SCHEMA IF NOT EXISTS data; CREATE TABLE IF NOT EXISTS data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text);' \
    "INSERT INTO data.load_log (status, tests_pass, tests_error) VALUES ('ok', ${_p}, ${_e});"
}
# 落账执行（复用 :69 先例的 docker exec psql 通路；凭据取 pg_duckdb 容器自注入的 env——:57 已取）。
# 问数执行池就是仓 ⇒ data_as_of 与数据查询同池单跳（spec §10.1 为什么写在仓内）。
# psql 失败**只告警不翻车**：退出码契约维持三态（0 / missing_env / dbt_build），成功的物化
# 不因记账失败 retry 整个 build；缺账由 data_as_of 停留旧值暴露（新鲜度未知 ≠ 捏造）。
mat_write_load_log() { # $1=tests_pass $2=tests_error
  docker exec -e PGPASSWORD="$PW" "$PG_CT" \
    psql -U "$UN" -d "$DB" -v ON_ERROR_STOP=1 -q -c "$(mat_load_log_sql "$1" "$2")" \
    || echo "materialize warn: load_log 落账失败（物化本身已成功；data_as_of 将停留旧值，新鲜度面降级）" >&2
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

# profiles.yml 机器本地（不进仓；模板 = 仓内 dbt/profiles.example.yml，纯 env_var() 引用无真值）。
# 缺失时自愈一份（首次部署/检出重建的兜底）；已人工调过的不会被覆盖。
[ -f "$R/dbt/profiles.yml" ] || {
  echo "profiles.yml 缺失，从 profiles.example.yml 派生（模板纯 env_var 引用，无真值）"
  cp "$R/dbt/profiles.example.yml" "$R/dbt/profiles.yml"
}

export DBT_HOST=pg_duckdb DBT_USER="$UN" DBT_PASSWORD="$PW" DBT_DBNAME="$DB"
export LEMENG_ZOS_BUCKET="$ZB" LEMENG_ZOS_REGION="$ZR" LEMENG_ZOS_ENDPOINT="$ZE"
export LEMENG_SUBJECT_ORG="$SO"

echo "materialize start repo=${R} network=${NETWORK} image=${IMAGE} mode=full_build（无按需名单，#679）"
# dbt 输出 tee 进临时日志：job 的实时流保持不变，同时留一份可解析的汇总行（Done. PASS=n … ERROR=m）。
# 退出码用 rc 文件带出（POSIX sh 无 pipefail/PIPESTATUS；管道末位是 tee，不能直接判 dbt）。
DBT_LOG="${TMPDIR:-/tmp}/materialize-dbt.$$.log"
DBT_RC="${TMPDIR:-/tmp}/materialize-dbt.$$.rc"
trap 'rm -f "$DBT_LOG" "$DBT_RC"' EXIT
( if docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
    $(mat_env_args) "$IMAGE" $(mat_dbt_args) 2>&1; then
  echo 0 >"$DBT_RC"
else
  echo $? >"$DBT_RC"
fi ) | tee "$DBT_LOG"
if [ "$(cat "$DBT_RC")" != 0 ]; then
  echo "MATERIALIZE_FAILED:dbt_build（dbt 非零退出，原因见上方日志；retry 由 openship job 配置承担）" >&2
  exit 1
fi
# 物化落账（spec §10.1）：PASS/ERROR 取 dbt 汇总行（sed 贪婪匹配取该行最后一个 PASS=/ERROR=，
# 行级结果 `[PASS in 0.1s]` 无等号不会误中）；解析不到 ⇒ INSERT 带 NULL，照常落账。
mat_write_load_log \
  "$(sed -n 's/.*PASS=\([0-9]*\).*/\1/p' "$DBT_LOG" | tail -n 1)" \
  "$(sed -n 's/.*ERROR=\([0-9]*\).*/\1/p' "$DBT_LOG" | tail -n 1)"
echo "MATERIALIZE_OK"
