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

# ── ⑤ 物化落账（spec §10.1）：load_log SQL 构造的判别面 ────────────────────────
LOG_SQL_FN=$(extract mat_load_log_sql)
[ -n "$LOG_SQL_FN" ] || bad "mat_load_log_sql 抽取失败（函数不存在或格式变了）"
eval "$LOG_SQL_FN"
LOG_SQL_NUM=$(mat_load_log_sql 26 0)
check "load_log SQL 幂等建表（CREATE TABLE IF NOT EXISTS，列形照 spec §10.1）" \
  sh -c 'echo "$1" | grep -Fq "CREATE TABLE IF NOT EXISTS data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text);"' _ "$LOG_SQL_NUM"
INS_NUM="VALUES ('ok', 26, 0);"
check "load_log SQL 追加一行 status=ok 且 PASS/ERROR 数字落位" \
  sh -c 'echo "$1" | grep -Fq "$2"' _ "$LOG_SQL_NUM" "$INS_NUM"
LOG_SQL_NULL=$(mat_load_log_sql '' '')
check "解析不到 PASS/ERROR ⇒ 插 NULL（落账不因解析失败缺账/失败）" \
  sh -c 'echo "$1" | grep -Fq "$2"' _ "$LOG_SQL_NULL" "VALUES ('ok', NULL, NULL);"
LOG_SQL_JUNK=$(mat_load_log_sql '2x' '-1')
check "非数字 PASS/ERROR ⇒ 同样 NULL（fail-soft，不把垃圾拼进 SQL）" \
  sh -c 'echo "$1" | grep -Fq "$2"' _ "$LOG_SQL_JUNK" "VALUES ('ok', NULL, NULL);"

# ── ⑥ 全流程（假 docker，手法照 sync-data-plane.test.sh）：成功写账 / 失败不写 ──
STUB_E2E=$(mktemp -d)
mkdir -p "$STUB_E2E/bin"
cat > "$STUB_E2E/bin/docker" <<'STUB'
#!/bin/sh
# 假 docker：只认 materialize.sh 用到的三个子命令；全部调用原样记进 $STUB_STATE/calls.log
# （形状断言的取证面）。env 夹具按容器名放 $STUB_ENV_DIR/env.<名>。
mkdir -p "$STUB_STATE"
printf '%s\n' "docker $*" >> "$STUB_STATE/calls.log"
if [ "$1" = inspect ]; then
  cat "$STUB_ENV_DIR/env.$2" 2>/dev/null
elif [ "$1" = exec ]; then
  echo stub-org
  [ "${STUB_EXEC_FAIL:-0}" = 1 ] && exit 1
elif [ "$1" = run ]; then
  if [ "${STUB_DBT_FAIL:-0}" = 1 ]; then
    printf 'Completed with errors\nDone. PASS=20 WARN=0 ERROR=6 SKIP=0 TOTAL=26\n'
    exit 1
  fi
  if [ "${STUB_DBT_NO_SUMMARY:-0}" = 1 ]; then
    printf 'Completed successfully\n'
    exit 0
  fi
  printf 'Completed successfully\nDone. PASS=26 WARN=0 ERROR=0 SKIP=0 TOTAL=26\n'
fi
exit 0
STUB
chmod 0755 "$STUB_E2E/bin/docker"
mkdir -p "$STUB_E2E/repo/dbt"
: > "$STUB_E2E/repo/dbt/profiles.yml"   # profiles.yml 在场 ⇒ 不触发自愈分支（生产常态）
mkdir -p "$STUB_E2E/envdir"
printf 'POSTGRES_PASSWORD=stub-pw\nPOSTGRES_USER=stub-user\nPOSTGRES_DB=stub-db\n' > "$STUB_E2E/envdir/env.pg"
printf 'ZOS_BUCKET=b\nZOS_REGION=r\nZOS_ENDPOINT=http://e\n'                      > "$STUB_E2E/envdir/env.console"
printf 'POSTGRES_PASSWORD=pw2\nPOSTGRES_USER=user2\nPOSTGRES_DB=db2\n'           > "$STUB_E2E/envdir/env.plat"

run_mat() { # $1=用例名 → 假 docker 跑 materialize.sh，stdout/stderr 落 $STUB_E2E/<名>/，回显退出码
  _w="$STUB_E2E/$1"; mkdir -p "$_w"
  MATERIALIZE_REPO_DIR="$STUB_E2E/repo" \
  MATERIALIZE_PG_CT=pg MATERIALIZE_CONSOLE_CT=console MATERIALIZE_PLAT_CT=plat \
  MATERIALIZE_NETWORK=stub-net MATERIALIZE_DBT_IMAGE=stub-dbt:stub \
  STUB_STATE="$_w/state" STUB_ENV_DIR="$STUB_E2E/envdir" \
  STUB_DBT_FAIL="${STUB_DBT_FAIL:-0}" STUB_DBT_NO_SUMMARY="${STUB_DBT_NO_SUMMARY:-0}" \
  STUB_EXEC_FAIL="${STUB_EXEC_FAIL:-0}" \
  PATH="$STUB_E2E/bin:$PATH" \
  sh "$SRC" >"$_w/out" 2>"$_w/err"
  printf '%s' "$?"
}
LOG_GREP() { # LOG_GREP <用例名> <字面量>：该跑的 calls.log 里找得到该字面量吗（check 直接调本函数）
  grep -Fq "$2" "$STUB_E2E/$1/state/calls.log" 2>/dev/null
}

# 成功路径：dbt 绿 ⇒ 退出 0、末行 MATERIALIZE_OK、向仓写 load_log 一行（PASS/ERROR 从 dbt 输出解析）
st=$(run_mat ok)
check "落账：dbt 成功 ⇒ 退出码 0" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：dbt 成功 ⇒ 末行 MATERIALIZE_OK" sh -c 'tail -n 1 "$1" | grep -qx "MATERIALIZE_OK"' _ "$STUB_E2E/ok/out"
check "落账：向仓 exec psql 写 load_log（幂等建表在场）" LOG_GREP ok "CREATE TABLE IF NOT EXISTS data.load_log("
check "落账：INSERT 一行 ok，PASS/ERROR=26/0 来自 dbt 汇总行（不是硬编码）" LOG_GREP ok "VALUES ('ok', 26, 0);"

# 失败路径：dbt 非零 ⇒ 仍 MATERIALIZE_FAILED:dbt_build，且**零落账**（status 只有 'ok'，失败不写行）
STUB_DBT_FAIL=1
st=$(run_mat fail)
STUB_DBT_FAIL=0
check "落账：dbt 非零 ⇒ 退出码 1" sh -c '[ "$1" = 1 ]' _ "$st"
check "落账：dbt 非零 ⇒ MATERIALIZE_FAILED:dbt_build 契约字面量不变" sh -c 'grep -q "MATERIALIZE_FAILED:dbt_build" "$1"' _ "$STUB_E2E/fail/err"
check "落账：dbt 非零 ⇒ 不向仓写任何 load_log（INSERT 不在场）" sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/fail/state/calls.log" "INSERT INTO data.load_log"
check "落账：dbt 非零 ⇒ 连建表也不做（一行都不写）" sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/fail/state/calls.log" "CREATE TABLE IF NOT EXISTS data.load_log"

# 解析不到汇总行：物化照常成功，落账插 NULL（新鲜度缺数 ≠ 整个 job 翻车）
STUB_DBT_NO_SUMMARY=1
st=$(run_mat nosum)
STUB_DBT_NO_SUMMARY=0
check "落账：dbt 无汇总行 ⇒ 仍退出 0" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：dbt 无汇总行 ⇒ 插 NULL 不失败" LOG_GREP nosum "VALUES ('ok', NULL, NULL);"

# 落账本身失败（psql 非零）：告警不翻车——退出码契约维持三态（0/missing_env/dbt_build）
STUB_EXEC_FAIL=1
st=$(run_mat warn)
STUB_EXEC_FAIL=0
check "落账：psql 失败 ⇒ 物化仍退出 0（记账失败不 retry 整个 build）" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：psql 失败 ⇒ stderr 有告警（降级可见，不是静默）" sh -c 'grep -q "load_log 落账失败" "$1"' _ "$STUB_E2E/warn/err"
check "落账：psql 失败 ⇒ 末行仍 MATERIALIZE_OK" sh -c 'tail -n 1 "$1" | grep -qx "MATERIALIZE_OK"' _ "$STUB_E2E/warn/out"

rm -rf "$STUB_E2E"

echo
echo "materialize.test.sh: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
