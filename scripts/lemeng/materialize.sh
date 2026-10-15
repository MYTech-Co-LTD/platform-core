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
docker run --rm --network "$NETWORK" -v "$R/dbt:/usr/app" \
  $(mat_env_args) "$IMAGE" $(mat_dbt_args) || {
  echo "MATERIALIZE_FAILED:dbt_build（dbt 非零退出，原因见上方日志；retry 由 openship job 配置承担）" >&2
  exit 1
}
echo "MATERIALIZE_OK"
