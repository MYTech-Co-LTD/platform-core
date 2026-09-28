#!/bin/sh
# wire-warehouse.sh — 平台 → 仓库（pg_duckdb）两条**易失接线**的幂等重做 + 只读复查。
#
# 本文件的两条接线是 issue #303 的主体；三处断点的总账见 #297；
# 正典：`docs/data-platform-handbook.md` §1.5「下游看不见」；操作单：`deploy/data-plane-deploy-sop.md` §P7 / §P8b。
#
# ── 为什么需要它（「掉了不报错」是最坏的一类）──────────────────────────────────────
# 这两条接线**都**是运行态/库内状态，掉了之后**只有问数一条路径会显形**：
#
#   ① Gate-B 网络（平台容器 ↔ pg_duckdb 容器）
#      `docker network connect` 是**运行态**步骤 ⇒ 数据面容器重建即掉。
#      掉了 = 平台容器解析不到 `pg_duckdb` ⇒ 任何问数查询 502。
#
#   ② 仓库连接的 `search_path`
#      `ALTER ROLE … SET` 是**库内**状态 ⇒ 仓库卷重建即掉。
#      掉了 = 编译出的 SQL（关系名**不带 schema**，见
#      `modules/data/domain/semantic-compiler.ts:111-112`）报
#      `relation "<模型名>" does not exist` —— **这个报错看着像「表不存在」，其实是解析不到 schema**。
#
# 2026-09-28 实测：两条**同时**处于掉了的状态，而别处一切正常（采集绿、物化绿、CI 绿）。
# 只写在 SOP 里靠人记得，就不成立 ⇒ 这个脚本是「可重做」，配套的探活 job 是「可复查」。
#
# ── 用法 ───────────────────────────────────────────────────────────────────────
#   sh wire-warehouse.sh              # 重做两条接线（幂等，可反复跑），**末尾自动跑一遍复查**
#   sh wire-warehouse.sh --check      # **只读**复查：三条断言全过 exit 0；任一不过 exit 1
#   sh wire-warehouse.sh --help
#
#   exit 码：0 = 通过；1 = 断言不过 / 执行失败；2 = **用法错**（未知参数一律响亮拒绝——
#   静默忽略未知 flag 是 T8 踩过的坑：打了 `--check` 实际写库还 exit 0）。
#
# **在数据面机上跑**（两个容器都在那台机上）。需要 docker。
#
# ── 可覆盖的 env（默认 = shanhai 站；换站给这几个就够，改动不必进仓）───────────────
#   WIRE_PLATFORM_NET        平台侧网络名       （默认 openship-platform-core-shanhai）
#   WIRE_PG_CONTAINER        pg_duckdb 容器名   （默认 openship-platform-core-shanhai-data-pg_duckdb）
#   WIRE_PLATFORM_CONTAINER  平台 server 容器名 （默认 openship-platform-core-shanhai-server）
#   WIRE_SCHEMA              search_path 目标   （默认 staging）
#   WIRE_PROBE_TABLE         复查用的表名       （默认 fct_retail_sale；**不带 schema**，故意的）
#
# ⚠️ **为什么 role / db 不写死**：它们从平台容器的 `DATA_WAREHOUSE_URL` **现取**
#    （唯一事实源在 project env）——本脚本**只读它的 username 与 pathname**，**不碰口令、不回显值**。
#
# ⚠️ **为什么复查要打一张「不带 schema 的表名」**：那正是 #297 实测的回归形态。
#    模型改名时这条会红 —— 那是**要的行为**（说明复查面没跟上），改 `WIRE_PROBE_TABLE` 即可。

set -eu

PLATFORM_NET=${WIRE_PLATFORM_NET:-openship-platform-core-shanhai}
PG_CONTAINER=${WIRE_PG_CONTAINER:-openship-platform-core-shanhai-data-pg_duckdb}
PLATFORM_CONTAINER=${WIRE_PLATFORM_CONTAINER:-openship-platform-core-shanhai-server}
SCHEMA=${WIRE_SCHEMA:-staging}
PROBE_TABLE=${WIRE_PROBE_TABLE:-fct_retail_sale}

die() { echo "WIRE_FAILED: $*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

# 取容器 env 里某个键的值（供**内部**使用；调用方不得把它回显出去）
env_of() { # <container> <key>
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p"
}

need_container() { # <container>
  docker inspect "$1" >/dev/null 2>&1 || die "容器不存在：$1"
  [ "$(docker inspect --format '{{.State.Running}}' "$1")" = "true" ] || die "容器没在跑：$1"
}

# ── 三条断言（每条各自 exit 非零；只读，不写任何东西）────────────────────────────

assert_dns() {
  printf '① DNS：%s 内解析 pg_duckdb —— ' "$PLATFORM_CONTAINER"
  docker exec "$PLATFORM_CONTAINER" node -e \
    "require('dns').lookup('pg_duckdb',(e,a)=>{console.log(e?('ERR '+e.code):('OK '+a));process.exit(e?1:0)})"
}

assert_tcp() {
  printf '② TCP：%s → pg_duckdb:5432 —— ' "$PLATFORM_CONTAINER"
  docker exec "$PLATFORM_CONTAINER" node -e \
    "const n=require('net'),s=n.connect(5432,'pg_duckdb');s.setTimeout(5000);s.on('connect',()=>{console.log('OK');s.end()});s.on('error',e=>{console.log('ERR '+e.code);process.exit(1)});s.on('timeout',()=>{console.log('ERR timeout');process.exit(1)})"
}

# 第三条断言用**平台自己的连接串**（含凭据）打一次**不带 schema** 的真查询。
# `-w /app/apps/server`：`pg` 按 workspace 布局装在各包下，从包目录才解析得到。
assert_query() {
  printf '③ 真查询（不带 schema 的 %s）—— ' "$PROBE_TABLE"
  docker exec -w /app/apps/server "$PLATFORM_CONTAINER" node -e "
const {Client}=require('pg');
const c=new Client({connectionString:process.env.DATA_WAREHOUSE_URL});
(async()=>{try{
  await c.connect();
  const sp=(await c.query('show search_path')).rows[0].search_path;
  const r=await c.query('select count(*)::int as n from ${PROBE_TABLE}');
  console.log('OK search_path='+sp+' rows='+r.rows[0].n);
  await c.end();
}catch(e){console.log('ERR '+e.message);process.exit(1)}})()
"
}

do_check() {
  rc=0
  assert_dns || rc=1
  assert_tcp || rc=1
  assert_query || rc=1
  if [ "$rc" -eq 0 ]; then
    echo "wire-warehouse: OK（三条断言全过）"
  else
    echo "wire-warehouse: FAILED（见上）—— 重做：sh $0" >&2
  fi
  return "$rc"
}

# ── 重做（幂等）────────────────────────────────────────────────────────────────

do_wire() {
  need_container "$PG_CONTAINER"
  need_container "$PLATFORM_CONTAINER"

  echo "→ Gate-B：把 $PG_CONTAINER 接进 $PLATFORM_NET（alias pg_duckdb）"
  out=$(docker network connect --alias pg_duckdb "$PLATFORM_NET" "$PG_CONTAINER" 2>&1) && {
    echo "  接上（新建连接）"
  } || {
    case "$out" in
      *"already exists"*) echo "  已经接着（幂等，未改动）" ;;
      *) echo "$out" >&2; die "docker network connect 失败" ;;
    esac
  }

  echo "→ search_path：给 DATA_WAREHOUSE_URL 所用的 role 绑 $SCHEMA"
  # role / db 从平台容器的连接串现取（只读 username 与 pathname，**不碰口令**）
  ids=$(docker exec "$PLATFORM_CONTAINER" node -e \
    "const u=new URL(process.env.DATA_WAREHOUSE_URL);console.log([u.username,u.pathname.slice(1)].join(' '))") \
    || die "取不到 DATA_WAREHOUSE_URL 的 role/db"
  WR_ROLE=$(printf '%s' "$ids" | cut -d' ' -f1)
  WR_DB=$(printf '%s' "$ids" | cut -d' ' -f2)
  [ -n "$WR_ROLE" ] && [ -n "$WR_DB" ] || die "DATA_WAREHOUSE_URL 解析出的 role/db 为空"

  PGP=$(env_of "$PG_CONTAINER" POSTGRES_PASSWORD)
  PGU=$(env_of "$PG_CONTAINER" POSTGRES_USER)
  PGDB=$(env_of "$PG_CONTAINER" POSTGRES_DB)
  [ -n "$PGP" ] || die "取不到 $PG_CONTAINER 的 POSTGRES_PASSWORD"

  docker exec -e PGPASSWORD="$PGP" "$PG_CONTAINER" \
    psql -U "$PGU" -d "$PGDB" -q -c \
    "ALTER ROLE \"$WR_ROLE\" IN DATABASE \"$WR_DB\" SET search_path TO \"$SCHEMA\", public" \
    || die "ALTER ROLE … SET search_path 失败"
  echo "  已设（role 取自连接串，未回显）"
}

# ── 入口 ───────────────────────────────────────────────────────────────────────

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --check)
    need_container "$PG_CONTAINER"
    need_container "$PLATFORM_CONTAINER"
    do_check
    ;;
  "")
    do_wire
    echo "→ 复查（重做后必跑）"
    do_check
    ;;
  *)
    echo "wire-warehouse: 未知参数 '$1'（支持：--check / --help；**无参数 = 重做**）" >&2
    exit 2
    ;;
esac
