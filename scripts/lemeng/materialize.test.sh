#!/bin/sh
# materialize.test.sh — materialize.sh 的**判别面**测试（CI 接线见 .github/workflows/ci.yml，#679）。
# 为什么进 CI：这个脚本的承重判据全是「静默错」形态——
#   ① 名单回来：--select 悄悄长回命令里 ⇒ #677 假绿（解析数涨、执行集不变、run 照绿）结构性复发；
#   ② 值落 argv：env 从「-e VAR 透传」退化成「-e VAR=value」⇒ 密码进 ps，静默、只在被 ps 的那一刻泄漏；
#   ③ 守卫拆掉：缺值 fail-fast 变成跑到 dbt 连库才炸，晚失败难定位。
# 纯 sh（从脚本里抽真函数测，不复制实现）：不连库、不取网络、不起容器，秒级。
set -u

SRC=$(dirname "$0")/materialize.sh
[ -f "$SRC" ] || { echo "FATAL: 找不到 $SRC" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }
check() { # check <描述> <条件命令…>
  d=$1; shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}

# 从被测脚本抽真函数（抽不到 = 判红，不跳过）
extract() {
  awk -v name="$1" '$0 ~ "^"name"\\(\\) \\{" {f=1} f {print} f && /^}$/ {exit}' "$SRC"
}

# ── ① mat_dbt_args：全量 build，没有 --select（#679 核心不变式）────────────────
DBT_ARGS=$(extract mat_dbt_args)
[ -n "$DBT_ARGS" ] || bad "mat_dbt_args 抽取失败（函数不存在或格式变了）"
DBT_BODY=$(echo "$DBT_ARGS" | sed '1d;/^}/d')  # 剥掉函数定义行与闭括号行
FIRST_WORD=$(echo "$DBT_BODY" | sed "s/printf '%s ' //" | awk 'NR==1{print $1}')  # 函数体是 printf 包装，剥掉取载荷首词
check "dbt 命令首词是 build（全量 seed+model+test）" sh -c '[ "$1" = build ]' _ "$FIRST_WORD"
check "带 --profiles-dir /usr/app" sh -c 'echo "$1" | grep -F -- "--profiles-dir /usr/app" >/dev/null' _ "$DBT_ARGS"
check "不含 --select（名单回来 = #677 假绿复发）" sh -c '! echo "$1" | grep -q -- "--select"' _ "$DBT_ARGS"
check "不含任何 stg_/fct_ 模型名（按需名单的另一种长法）" sh -c '! echo "$1" | grep -Eq "stg_|fct_"' _ "$DBT_ARGS"

# ── ② mat_env_args：8 键、只透传键名、值不落 argv ─────────────────────────────
ENV_ARGS=$(extract mat_env_args)
[ -n "$ENV_ARGS" ] || bad "mat_env_args 抽取失败（函数不存在或格式变了）"
E_TOKENS=$(echo "$ENV_ARGS" | tr -s ' ' '\n' | sed '/^$/d' | grep -c '^-e$')
check "-e token 恰 8 个（键集由本函数唯一定义）" sh -c '[ "$1" = 8 ]' _ "$E_TOKENS"
E_EQ=$(echo "$ENV_ARGS" | tr -s ' ' '\n' | sed '/^$/d' | grep -c '=' || true)
check "带 = 的 token 恰 1 个（仅 DBT_HOST=pg_duckdb；值进 argv 就进 ps）" sh -c '[ "$1" = 1 ]' _ "$E_EQ"
check "带 = 的那个正是 DBT_HOST=pg_duckdb" sh -c 'echo "$1" | grep -qx "DBT_HOST=pg_duckdb"' _ "$(echo "$ENV_ARGS" | tr -s ' ' '\n' | grep '=')"
for k in DBT_USER DBT_PASSWORD DBT_DBNAME LEMENG_ZOS_BUCKET LEMENG_ZOS_REGION LEMENG_ZOS_ENDPOINT LEMENG_SUBJECT_ORG; do
  check "透传键在场：-e ${k}" sh -c 'echo "$1" | grep -F -- "-e $2" >/dev/null' _ "$ENV_ARGS" "$k"
done

# ── ③ mat_require：缺值响亮失败、有值静默放行 ────────────────────────────────
eval "$(extract mat_require)"
REQ_OUT=$(mat_require 'POSTGRES_PASSWORD(pg_duckdb)' '' 2>&1); REQ_RC=$?
check "空值 ⇒ 退出码 1" sh -c '[ "$1" = 1 ]' _ "$REQ_RC"
check "空值 ⇒ 输出含 MATERIALIZE_FAILED:missing_env 契约字面量" sh -c 'echo "$1" | grep -q "MATERIALIZE_FAILED:missing_env"' _ "$REQ_OUT"
check "空值 ⇒ 报错点名缺的是哪个键" sh -c 'echo "$1" | grep -q "POSTGRES_PASSWORD"' _ "$REQ_OUT"
REQ_OK_OUT=$(mat_require 'POSTGRES_PASSWORD(pg_duckdb)' 'some-value' 2>&1); REQ_OK_RC=$?
check "非空值 ⇒ 退出码 0" sh -c '[ "$1" = 0 ]' _ "$REQ_OK_RC"
check "非空值 ⇒ 无输出" sh -c '[ -z "$1" ]' _ "$REQ_OK_OUT"

# ── ④ 静态接线：主流程真的用这两个函数（防「函数测绿但 docker run 没走它」）────
SRC_CONTENT=$(cat "$SRC")
if printf '%s\n' "$SRC_CONTENT" | grep -Fq -- '$(mat_env_args)'; then ok "docker run 行引用 \$(mat_env_args)（字面量在场）"; else bad "docker run 行引用 \$(mat_env_args)（字面量在场）"; fi
if printf '%s\n' "$SRC_CONTENT" | grep -Fq -- '$(mat_dbt_args)'; then ok "docker run 行引用 \$(mat_dbt_args)（字面量在场）"; else bad "docker run 行引用 \$(mat_dbt_args)（字面量在场）"; fi

echo
echo "materialize.test.sh: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
