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

# ── ① mat_dbt_args：固定前缀；选择器**按域派生**且不在本函数里（#679 核心不变式）──────
DBT_ARGS=$(extract mat_dbt_args)
[ -n "$DBT_ARGS" ] || bad "mat_dbt_args 抽取失败（函数不存在或格式变了）"
DBT_BODY=$(echo "$DBT_ARGS" | sed '1d;/^}/d')  # 剥掉函数定义行与闭括号行
FIRST_WORD=$(echo "$DBT_BODY" | sed "s/printf '%s ' //" | awk 'NR==1{print $1}')  # 函数体是 printf 包装，剥掉取载荷首词
check "dbt 命令首词是 build（全量 seed+model+test）" sh -c '[ "$1" = build ]' _ "$FIRST_WORD"
check "带 --profiles-dir /usr/app" sh -c 'echo "$1" | grep -F -- "--profiles-dir /usr/app" >/dev/null' _ "$DBT_ARGS"
check "不含 --select（名单回来 = #677 假绿复发）" sh -c '! echo "$1" | grep -q -- "--select"' _ "$DBT_ARGS"
check "不含任何 stg_/fct_ 模型名（按需名单的另一种长法）" sh -c '! echo "$1" | grep -Eq "stg_|fct_"' _ "$DBT_ARGS"

# ── ② mat_env_args：9 键、只透传键名、值不落 argv ─────────────────────────────
ENV_ARGS=$(extract mat_env_args)
[ -n "$ENV_ARGS" ] || bad "mat_env_args 抽取失败（函数不存在或格式变了）"
E_TOKENS=$(echo "$ENV_ARGS" | tr -s ' ' '\n' | sed '/^$/d' | grep -c '^-e$')
check "-e token 恰 9 个（键集由本函数唯一定义）" sh -c '[ "$1" = 9 ]' _ "$E_TOKENS"
E_EQ=$(echo "$ENV_ARGS" | tr -s ' ' '\n' | sed '/^$/d' | grep -c '=' || true)
check "带 = 的 token 恰 1 个（仅 DBT_HOST=pg_duckdb；值进 argv 就进 ps）" sh -c '[ "$1" = 1 ]' _ "$E_EQ"
check "带 = 的那个正是 DBT_HOST=pg_duckdb" sh -c 'echo "$1" | grep -qx "DBT_HOST=pg_duckdb"' _ "$(echo "$ENV_ARGS" | tr -s ' ' '\n' | grep '=')"
for k in DBT_USER DBT_PASSWORD DBT_DBNAME LEMENG_ZOS_BUCKET LEMENG_ZOS_REGION LEMENG_ZOS_ENDPOINT LEMENG_SUBJECT_ORG DATA_PLANE_DOMAINS; do
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
if printf '%s\n' "$SRC_CONTENT" | grep -Fq -- '--select "$(mat_dbt_select "$_d")"'; then ok "docker run 行把选择器作为**带引号的单个实参**传下去（词分割会切坏它）"; else bad "docker run 行把选择器作为**带引号的单个实参**传下去（词分割会切坏它）"; fi

# ── ④-b 选择器是**派生三段式**（2026-10-18 补漏：+enabled 管不到 dbt/tests/）────────
SEL_FN=$(extract mat_dbt_select)
[ -n "$SEL_FN" ] || bad "mat_dbt_select 抽取失败（函数不存在或格式变了）"
eval "$SEL_FN"
SEL_OUT=$(mat_dbt_select forms)
check "选择器只含**派生**三段：path:models/<域> + config.materialized:seed + path:tests/<域>" \
  sh -c '[ "$1" = "path:models/$2 config.materialized:seed path:tests/$2" ]' _ "$SEL_OUT" forms
check "选择器里没有任何具体模型名（手抄名单的形态：stg_/fct_）" \
  sh -c '! echo "$1" | grep -Eq "stg_|fct_"' _ "$SEL_OUT"

# ── ⑤ 物化落账（spec §10.1 + §10.7.2）：load_log DDL 与水位 SQL 的判别面 ──────────
LOG_SQL_FN=$(extract mat_load_log_sql)
[ -n "$LOG_SQL_FN" ] || bad "mat_load_log_sql 抽取失败（函数不存在或格式变了）"
eval "$LOG_SQL_FN"
LOG_SQL=$(mat_load_log_sql)
check "load_log SQL 幂等建表（CREATE TABLE IF NOT EXISTS，列形照 spec §10.1）" \
  sh -c 'echo "$1" | grep -Fq "CREATE TABLE IF NOT EXISTS data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text);"' _ "$LOG_SQL"
check "load_log SQL 幂等补水位列 relation（spec §10.7.2；旧表加列，新表 CREATE 后跟上）" \
  sh -c 'echo "$1" | grep -Fq "ALTER TABLE data.load_log ADD COLUMN IF NOT EXISTS relation text;"' _ "$LOG_SQL"
check "load_log SQL 幂等补水位列 max_bizday（spec §10.7.2）" \
  sh -c 'echo "$1" | grep -Fq "ALTER TABLE data.load_log ADD COLUMN IF NOT EXISTS max_bizday date;"' _ "$LOG_SQL"

# ── ⑤-b 逐表水位（spec §10.7.2）：INSERT 形状判别面 ─────────────────────────────
WM_FN=$(extract mat_watermark_sql)
[ -n "$WM_FN" ] || bad "mat_watermark_sql 抽取失败（函数不存在或格式变了）"
eval "$WM_FN"
WM_SQL=$(mat_watermark_sql 26 0 stg_lemeng_a stg_lemeng_b)
check "水位 SQL 事务包裹（BEGIN..COMMIT ⇒ now() 是事务起点，同次物化各行同一 materialized_at）" \
  sh -c 'echo "$1" | head -n 1 | grep -qx "BEGIN;" && echo "$1" | tail -n 1 | grep -qx "COMMIT;"' _ "$WM_SQL"
INS_SHAPE="INSERT INTO data.load_log (relation, max_bizday, materialized_at, tests_pass, tests_error, status) SELECT 'stg_lemeng_a', max(bizday), now(), 26, 0, 'ok' FROM staging.stg_lemeng_a;"
check "逐表 INSERT 形状逐字（relation 非空点名到表、max(bizday)、PASS/ERROR 落位）" \
  sh -c 'echo "$1" | grep -Fq "$2"' _ "$WM_SQL" "$INS_SHAPE"
check "多表逐表一行（第二张表也在场）" \
  sh -c 'echo "$1" | grep -Fq "SELECT '"'"'stg_lemeng_b'"'"', max(bizday), now(), 26, 0, '"'"'ok'"'"' FROM staging.stg_lemeng_b;"' _ "$WM_SQL"
WM_NULL=$(mat_watermark_sql '' '' stg_lemeng_a)
check "解析不到 PASS/ERROR ⇒ 插 NULL（落账不因解析失败缺账/失败）" \
  sh -c 'echo "$1" | grep -Fq "max(bizday), now(), NULL, NULL, '"'"'ok'"'"'"' _ "$WM_NULL"
WM_JUNK=$(mat_watermark_sql '2x' '-1' stg_lemeng_a)
check "非数字 PASS/ERROR ⇒ 同样 NULL（fail-soft，不把垃圾拼进 SQL）" \
  sh -c 'echo "$1" | grep -Fq "max(bizday), now(), NULL, NULL, '"'"'ok'"'"'"' _ "$WM_JUNK"

# ── ⑤-c 表名形状判定跨 locale 确定（CI fix round 1）──────────────────────────────
# 现象：`case "$_wt" in *[!a-z0-9_]*)` 的括号区间按**运行时 collation** 解释——glibc 的
# UTF-8 locale 里 a-z 的排序跨度罩住大写字母（A 排在 a 与 b 之间），与 macOS 的 ASCII
# 语义相反 ⇒ 同一个名字两平台判定相反（stg_OK1 本地判「安全」、CI 判「异常」⇒ INSERT
# 缺失、断言红）。实现钉 LC_ALL=C 后，这里钉「**两个 locale 同一个答案**」。
# 语义同时钉死：标识符只认小写蛇形——PG 未加引号的标识符折叠成小写，`staging.stg_OK1`
# 本来就指不到那张表 ⇒ 「含大写 = 异常跳过」是正确语义，不是误伤。
WM_LOC_OK='stg_ok1'                    # 安全形状（全小写）⇒ 必须拼进 INSERT
WM_LOC_BAD1='stg_OK1'                  # 含大写 ⇒ 异常（折叠后指不到表）
WM_LOC_BAD2='stg_x; drop table y'      # 注入形状 ⇒ 异常
wm_check_at() { # wm_check_at <locale 标签>：当前 locale 环境下调**真函数**断言三态
  _wm_sql=$(mat_watermark_sql 26 0 "$WM_LOC_OK" "$WM_LOC_BAD1" "$WM_LOC_BAD2" 2>/dev/null)
  _wm_err=$( (mat_watermark_sql 26 0 "$WM_LOC_OK" "$WM_LOC_BAD1" "$WM_LOC_BAD2") 2>&1 >/dev/null)
  check "表名形状判定@$1：安全名 stg_ok1 拼 INSERT" \
    sh -c 'echo "$1" | grep -Fq "FROM staging.stg_ok1;"' _ "$_wm_sql"
  check "表名形状判定@$1：大写名 stg_OK1 判异常跳过（不拼进 SQL）" \
    sh -c '! echo "$1" | grep -Fq "stg_OK1"' _ "$_wm_sql"
  check "表名形状判定@$1：注入形状不拼进 SQL" \
    sh -c '! echo "$1" | grep -Fq "drop table"' _ "$_wm_sql"
  check "表名形状判定@$1：两个异常名都有告警点名（fail-soft 可见）" \
    sh -c '[ "$(echo "$1" | grep -c "异常表名")" = 2 ]' _ "$_wm_err"
}
WM_SAVED_LC=${LC_ALL-}; WM_SAVED_LANG=${LANG-}
# a) LC_ALL=C 下必过（形状判定的锚定 locale）
LC_ALL=C; LANG=C; export LC_ALL LANG
wm_check_at 'LC_ALL=C'
# b) runner 有 en_US.UTF-8 ⇒ 同断言重跑（没有则跳过——钉的是「两 locale 同答案」；
#    CI 的 glibc 常有它，本机 macOS 也常驻，故这条在两平台通常都真跑）
if locale -a 2>/dev/null | grep -qiE 'en_US\.utf-?8'; then
  LC_ALL=en_US.UTF-8; LANG=en_US.UTF-8; export LC_ALL LANG
  wm_check_at 'en_US.UTF-8'
else
  ok "本机 locale -a 无 en_US.UTF-8 ⇒ 跨 locale 重跑跳过（CI/Linux 常有，钉子不空转）"
fi
LC_ALL=$WM_SAVED_LC; LANG=$WM_SAVED_LANG; export LC_ALL LANG

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
  # $4 = 容器名（docker exec -e K=V <容器> psql …）。按容器分角色回话：
  #   plat → 主体 org 查询的应答；pg → 水位表清单查询的应答（spec §10.7.2 的
  #   information_schema 点名——两条 psql 调用在 calls.log 里各留原样取证）。
  if [ "$4" = plat ]; then
    echo stub-org
  elif [ "$4" = pg ]; then
    # 全 staging 内含 bizday 的表（含**别的域**的：域裁剪由脚本按本域模型名取子集，
    # 不是靠这条 SQL 过滤 —— 断言「别的域的表没被落账」才有意义）
    printf 'stg_lemeng_a\nstg_lemeng_b\nstg_forms_submission\n'
  fi
  [ "${STUB_EXEC_FAIL:-0}" = 1 ] && exit 1
elif [ "$1" = run ]; then
  # 按域失败（拆爆炸半径的用例）：脚本逐域跑时用「逐命令 env 赋值」把单个域给 docker CLI
  # ⇒ 本桩读得到 ${DATA_PLANE_DOMAINS}（**不是**从 argv —— 域值刻意只走 env、不进 ps）。
  # ⚠️ 按**域集合**匹配（逗号拆开逐项），不是整串子串：这样「一次全量跑 lemeng,forms」
  # 也会因 forms 而红 ⇒ 下面「绿域照常落账」那条在**改动前**会红（用例真有判别力）。
  if [ -n "${STUB_DBT_FAIL_DOMAINS:-}" ]; then
    case " $(printf '%s' "${DATA_PLANE_DOMAINS:-}" | tr ',' ' ') " in
      *" ${STUB_DBT_FAIL_DOMAINS} "*)
        printf 'Completed with errors\nDone. PASS=20 WARN=0 ERROR=6 SKIP=0 TOTAL=26\n'; exit 1;;
    esac
  fi
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
mkdir -p "$STUB_E2E/repo/dbt/models/lemeng/staging" "$STUB_E2E/repo/dbt/models/forms/staging"
: > "$STUB_E2E/repo/dbt/profiles.yml"   # profiles.yml 在场 ⇒ 不触发自愈分支（生产常态）
# 逐域落账的模型名从**树**派生（mat_domain_staging_models）⇒ 桩检出必须有真实的域目录，
# 否则本域的落账表集会空掉（这正是「树派生」与「手写名单」的差别所在）。
: > "$STUB_E2E/repo/dbt/models/lemeng/staging/stg_lemeng_a.sql"
: > "$STUB_E2E/repo/dbt/models/lemeng/staging/stg_lemeng_b.sql"
: > "$STUB_E2E/repo/dbt/models/forms/staging/stg_forms_submission.sql"
mkdir -p "$STUB_E2E/envdir"
printf 'POSTGRES_PASSWORD=stub-pw\nPOSTGRES_USER=stub-user\nPOSTGRES_DB=stub-db\n' > "$STUB_E2E/envdir/env.pg"
printf 'ZOS_BUCKET=b\nZOS_REGION=r\nZOS_ENDPOINT=http://e\n'                      > "$STUB_E2E/envdir/env.console"
printf 'POSTGRES_PASSWORD=pw2\nPOSTGRES_USER=user2\nPOSTGRES_DB=db2\n'           > "$STUB_E2E/envdir/env.plat"

run_mat() { # $1=用例名 → 假 docker 跑 materialize.sh，stdout/stderr 落 $STUB_E2E/<名>/，回显退出码
  _w="$STUB_E2E/$1"; mkdir -p "$_w"
  MATERIALIZE_REPO_DIR="$STUB_E2E/repo" \
  MATERIALIZE_PG_CT=pg MATERIALIZE_CONSOLE_CT=console MATERIALIZE_PLAT_CT=plat \
  MATERIALIZE_NETWORK=stub-net MATERIALIZE_DBT_IMAGE=stub-dbt:stub \
  DATA_PLANE_DOMAINS="${DOMAINS_FIXTURE-lemeng}" \
  STUB_STATE="$_w/state" STUB_ENV_DIR="$STUB_E2E/envdir" \
  STUB_DBT_FAIL="${STUB_DBT_FAIL:-0}" STUB_DBT_NO_SUMMARY="${STUB_DBT_NO_SUMMARY:-0}" \
  STUB_DBT_FAIL_DOMAINS="${STUB_DBT_FAIL_DOMAINS:-}" \
  STUB_EXEC_FAIL="${STUB_EXEC_FAIL:-0}" \
  PATH="$STUB_E2E/bin:$PATH" \
  sh "$SRC" >"$_w/out" 2>"$_w/err"
  printf '%s' "$?"
}
LOG_GREP() { # LOG_GREP <用例名> <字面量>：该跑的 calls.log 里找得到该字面量吗（check 直接调本函数）
  grep -Fq "$2" "$STUB_E2E/$1/state/calls.log" 2>/dev/null
}

# 成功路径：dbt 绿 ⇒ 退出 0、末行 MATERIALIZE_OK、向仓写逐表水位行（PASS/ERROR 从 dbt 输出解析）
st=$(run_mat ok)
check "落账：dbt 成功 ⇒ 退出码 0" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：dbt 成功 ⇒ 末行 MATERIALIZE_OK" sh -c 'tail -n 1 "$1" | grep -qx "MATERIALIZE_OK"' _ "$STUB_E2E/ok/out"
check "落账：向仓 exec psql 写 load_log（幂等建表在场）" LOG_GREP ok "CREATE TABLE IF NOT EXISTS data.load_log("
check "水位：先向仓查水位表清单（information_schema 点名 staging 内含 bizday 列的表，spec §10.7.2）" \
  LOG_GREP ok "SELECT table_name FROM information_schema.columns WHERE table_schema='staging' AND column_name='bizday'"
check "水位：清单里的每张表各一行（relation 非空点名到表，PASS/ERROR=26/0 来自 dbt 汇总行）" \
  LOG_GREP ok "SELECT 'stg_lemeng_a', max(bizday), now(), 26, 0, 'ok' FROM staging.stg_lemeng_a;"
check "水位：第二张表同样落位（逐表，不是一行汇总）" \
  LOG_GREP ok "SELECT 'stg_lemeng_b', max(bizday), now(), 26, 0, 'ok' FROM staging.stg_lemeng_b;"
check "水位：旧「仓级」行（relation NULL）不再新写（VALUES 形态的仓级 INSERT 不在场）" \
  sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/ok/state/calls.log" "INSERT INTO data.load_log (status, tests_pass, tests_error) VALUES"
check "水位：**别的域**的表不落账（域裁剪生效——本面只有 lemeng，forms 的表不在水位行里）" \
  sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/ok/state/calls.log" "stg_forms_submission"

# 失败路径：dbt 非零 ⇒ 仍 MATERIALIZE_FAILED:dbt_build，且**零落账**（status 只有 'ok'，失败不写行）
STUB_DBT_FAIL=1
st=$(run_mat fail)
STUB_DBT_FAIL=0
check "落账：dbt 非零 ⇒ 退出码 1" sh -c '[ "$1" = 1 ]' _ "$st"
check "落账：dbt 非零 ⇒ MATERIALIZE_FAILED:dbt_build 契约字面量不变" sh -c 'grep -q "MATERIALIZE_FAILED:dbt_build" "$1"' _ "$STUB_E2E/fail/err"
check "落账：dbt 非零 ⇒ 不向仓写任何 load_log（INSERT 不在场）" sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/fail/state/calls.log" "INSERT INTO data.load_log"
check "落账：dbt 非零 ⇒ 连建表也不做（一行都不写）" sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/fail/state/calls.log" "CREATE TABLE IF NOT EXISTS data.load_log"

# 解析不到汇总行：物化照常成功，水位行插 NULL（新鲜度缺数 ≠ 整个 job 翻车）
STUB_DBT_NO_SUMMARY=1
st=$(run_mat nosum)
STUB_DBT_NO_SUMMARY=0
check "落账：dbt 无汇总行 ⇒ 仍退出 0" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：dbt 无汇总行 ⇒ 水位行插 NULL 不失败" LOG_GREP nosum "max(bizday), now(), NULL, NULL, 'ok' FROM staging.stg_lemeng_a;"

# 落账本身失败（psql 非零）：告警不翻车——退出码契约维持三态（0/missing_env/dbt_build）
STUB_EXEC_FAIL=1
st=$(run_mat warn)
STUB_EXEC_FAIL=0
check "落账：psql 失败 ⇒ 物化仍退出 0（记账失败不 retry 整个 build）" sh -c '[ "$1" = 0 ]' _ "$st"
check "落账：psql 失败 ⇒ stderr 有告警（降级可见，不是静默）" sh -c 'grep -q "load_log 落账失败" "$1"' _ "$STUB_E2E/warn/err"
check "落账：psql 失败 ⇒ 末行仍 MATERIALIZE_OK" sh -c 'tail -n 1 "$1" | grep -qx "MATERIALIZE_OK"' _ "$STUB_E2E/warn/out"

# 域身份（DATA_PLANE_DOMAINS）缺配 ⇒ **响亮失败**，不许猜一个默认域：
# 猜 `lemeng` 会让漏配的新面静默 build 乐檬模型（反向泄漏）；空串则 dbt 侧解析出 0 个模型、
# 退出 0、照打 MATERIALIZE_OK（2026-10-17 实测的假绿）⇒ 空即停（docs/architecture.md §2.5）。
DOMAINS_FIXTURE=''
st=$(run_mat nodom)
check "域身份：DATA_PLANE_DOMAINS 缺配 ⇒ 退出码 1（fail-closed，不猜默认域）" sh -c '[ "$1" = 1 ]' _ "$st"
check "域身份：缺配 ⇒ MATERIALIZE_FAILED:missing_env 且点名该键" \
  sh -c 'grep -q "MATERIALIZE_FAILED:missing_env" "$1" && grep -q "DATA_PLANE_DOMAINS" "$1"' _ "$STUB_E2E/nodom/err"
check "域身份：缺配 ⇒ 不起 dbt 容器（守卫在 docker run 之前）" \
  sh -c '! grep -Fq "run --rm" "$1"' _ "$STUB_E2E/nodom/state/calls.log"
check "域身份：值经 -e 透传进 dbt 容器（键名形态，值不进 argv）" LOG_GREP ok "-e DATA_PLANE_DOMAINS"
unset DOMAINS_FIXTURE

# 多域 + 其中一个域红：**红的域不落账、绿的域照常落账、整体仍 exit 1**。
# 这是本条改动存在的**全部理由**：`data.load_log` 是全部 relation 新鲜度的单一水位来源，
# 改动前一个模型红 = 所有 relation 的 data_as_of 一起停（2026-10-17 一天内实测两次）。
DOMAINS_FIXTURE='lemeng,forms'
STUB_DBT_FAIL_DOMAINS=forms
st=$(run_mat partial)
STUB_DBT_FAIL_DOMAINS=''
check "拆半径：一个域红 ⇒ 整体仍退出 1（响亮，不被静默吞掉）" sh -c '[ "$1" = 1 ]' _ "$st"
check "拆半径：失败字面量仍是 MATERIALIZE_FAILED:dbt_build 且点名红域" \
  sh -c 'grep -q "MATERIALIZE_FAILED:dbt_build" "$1" && grep -q "forms" "$1"' _ "$STUB_E2E/partial/err"
check "拆半径：**绿域照常落账**（lemeng 的表有水位行 —— 改动前这里会是零行）" \
  LOG_GREP partial "SELECT 'stg_lemeng_a', max(bizday), now(), 26, 0, 'ok' FROM staging.stg_lemeng_a;"
check "拆半径：**红域不落账**（forms 的表没有水位行）" \
  sh -c '! grep -Fq "$2" "$1"' _ "$STUB_E2E/partial/state/calls.log" "stg_forms_submission"
check "拆半径：末行不是 MATERIALIZE_OK（失败不被末行掩盖）" \
  sh -c '! tail -n 1 "$1" | grep -qx "MATERIALIZE_OK"' _ "$STUB_E2E/partial/out"
check "拆半径：两个域各起一次 dbt 容器（逐域跑，不是一次全量）" \
  sh -c '[ "$(grep -c "run --rm" "$1")" = 2 ]' _ "$STUB_E2E/partial/state/calls.log"
unset DOMAINS_FIXTURE

rm -rf "$STUB_E2E"

echo
echo "materialize.test.sh: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
