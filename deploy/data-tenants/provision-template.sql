-- ═══════════════════════════════════════════════════════════════════════════════════════
-- provision-template.sql — 每租户的数据面开通模板（issue #150 / 计划 Task 11；spec §11.2 #6）
--
-- 一封租户在数据面上是**三件**（全幂等）：① PG role ② pg_duckdb 凭据（USER MAPPING / SCOPE）
-- ③ 该租户 schema 与其授权。本文件是**模板**：它进 git，**值不进**（所有真值都由 runner 注入）。
--
-- 用法（runner 逐租户跑一次；本文件自己不做循环 —— 循环在 openship job 里，拍板 #4）：
--
--   TENANT_ROLE_PASSWORD='…' TENANT_ZOS_ACCESS_KEY='…' TENANT_ZOS_SECRET='…' \
--     psql "$DATA_WAREHOUSE_URL" \
--          -v tenant_name=tenant_acme_org \
--          -v tenant_s3_scope='s3://<桶>/<该租户前缀>' \
--          -v tenant_zos_endpoint='…' -v tenant_zos_region='…' \
--          -v dbt_role=platform \
--          -f provision-template.sql
--
-- 幂等：本文件会被**每轮全量重跑**（部署/脚本的重跑语义，与模块迁移同一条纪律）
--   ⇒ 每一句要么 `IF EXISTS` / `IF NOT EXISTS`，要么「重跑结果一致」（`ALTER` 类天然如此）。
--   `DROP USER MAPPING IF EXISTS` + `CREATE USER MAPPING` 是**故意**的形态：它让「凭据轮换」
--   与「首次开通」走同一条路（只重跑不换值 ⇒ 结果逐字一致；换了值 ⇒ 收敛到新值）。
--
-- ── ⚠️ 失败 = 无残留（整份模板单事务 —— 本不变量由修复笔 I2-a 建立）────────────────────
-- 本文件里**所有落库语句都在一个事务里**（第一句 DDL 之前的 `begin;` 与最后那句 `commit;`）：
-- 中途任何一步失败（`ON_ERROR_STOP` 会让 psql 立刻退出、连接断开）⇒ **整体回滚，什么都没落**。
-- 为什么这必须是结构性的而不是「靠自觉」：修复前 §3（凭据面）响亮失败**不回滚** §1（role）/
-- §2（schema）—— 已落库；而 `scripts/reconcile-data-tenants.mjs` 只覆盖 schema+role、对凭据面
-- **全盲** ⇒ 那个「半建」的残留恰好落在对账报绿的区间里（**半建而无人知**）。单事务把
-- 「失败 ⇒ 无残留」变成结构保证（实测查库证据见 task-11-fix-report.md）。
-- ⚠️ 三条纪律：
--   · 幂等**不受影响**：事务只改「失败时留下什么」，不改「重跑的结果」⇒ 连跑两次仍不报错、
--     结果逐字一致（README §2 的幂等口径不变）。
--   · **不许**往本文件加非事务语句（`CREATE INDEX CONCURRENTLY` / `REINDEX … CONCURRENTLY` /
--     `VACUUM` / `CREATE DATABASE` / `CREATE TABLESPACE` / `ALTER SYSTEM`）——PG 会直接拒
--     （`cannot run inside a transaction block`）。真需要时**不要**硬包进来，另起一次调用。
--     当前文件里没有这类语句（`scripts/check-data-models.test.ts` 的 T11 修复笔段有断言钉住）。
--   · 调用方**不要**再传 `psql -1/--single-transaction`：本文件自带事务，两者会叠。
--
-- ── 参数与注入（「在哪、怎么取」，**不写值**）───────────────────────────────────────────
--   · 非密参数走 `-v`（值来自 openship env / 部署 env；**本文件不存任何真值**）；
--   · 三样**密钥型**参数走 **环境变量 + `\getenv`**（PG ≥ 15），**不走 `-v`**：`-v` 会让口令
--     出现在进程 argv 里（`ps` 可见）；`\getenv` 只经进程环境，不进 argv。
--     取法：该租户的 `TENANT_STORAGE` 凭据 —— 真源是 `platform.tenant` 的
--     `storage_access_key` / `storage_secret`（M3c 迁移 `006_tenant_storage.sql`），
--     在 openship 侧以 env(isSecret) 物化（**绝不落盘、绝不进提交**）。
--     ZOS 凭据的**取法**（控制台 → 对象存储 → 访问密钥）见 dbt/profiles.example.yml 的键名登记。
--   · `tenant_s3_scope`：DuckDB 的 `SCOPE` 收窄点，形如 `s3://<桶>/<该租户的前缀>`。
--     **它是本文件里唯一一处「租户边界」的声明** —— 少了它，该租户的凭据能读整桶。
--
-- ── ⚠️ 第 ② 件（pg_duckdb 凭据）是**未实测形态**，必须这么读 ────────────────────────────
-- 「secret 可按 PG role 的 USER MAPPING 分，并有 SCOPE 可收窄到某前缀」出自 spec §9.5，
-- 但**本机没有 pg_duckdb，且 WeKnora 经验库没有这条接线的一手条目**（2026-09-22 检索：
-- 命中的是 `duckdb.create_simple_secret` 与 per-schema/`search_path` 两条，**均无 USER MAPPING**）
-- ⇒ 本节的 **DDL 形状有据、键名未验**（OPTIONS 的键以 DuckDB secret 的参数名为蓝本：
-- `KEY_ID` / `SECRET` / `SCOPE` / `ENDPOINT` / `REGION` / `URL_STYLE` / `USE_SSL`），
-- **真机核对归 T13**。故本节：
--   · 由 `expect_pg_duckdb` 开关把守（缺省 `on`）：本库没有 duckdb 扩展 ⇒ **响亮失败**，
--     不静默跳过 —— 「跳过」的结果是「租户开通了但凭据没落」，那是**假绿**；
--   · 明知本库就是没有 pg_duckdb（本地/CI 的纯 PG 环境）时显式 `-v expect_pg_duckdb=off`，
--     此时**打印一条 WARNING**（跳过是有记录的，不是无声的）。
--   若 T13 真机核对证实 pg_duckdb **不**支持用 USER MAPPING 承载 secret，则退回**同会话**
--   `duckdb.create_simple_secret(...)`（WeKnora 已证该函数支持自定义 endpoint 与 `url_style=path`），
--   代价是「DuckDB 实例按连接」⇒ 每个要用到它的会话都得重建（dbt 的接入面见 dbt/README.md gate 1）。
--   **两条路都要改的只有本节** —— ①②③ 与角色/schema/授权面无关。
-- ═══════════════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- ── 单事务：本行之后的所有落库语句要么全成、要么全回滚（见头注「失败 = 无残留」）────────
begin;

-- ── §0 参数齐备性（fail-closed：缺一个就停在这里，绝不让空值当参数用）──────────────────
\if :{?tenant_name}
\else
  do $$ begin raise exception '缺 -v tenant_name=（该租户在数据面的资源名，形如 tenant_acme_org；派生口径见 dbt/macros/generate_schema_name.sql）'; end $$;
\endif
\if :{?tenant_s3_scope}
\else
  do $$ begin raise exception '缺 -v tenant_s3_scope=（形如 s3://<桶>/<该租户前缀>）—— 它是该租户的凭据边界，不许省'; end $$;
\endif
\if :{?tenant_zos_endpoint}
\else
  do $$ begin raise exception '缺 -v tenant_zos_endpoint=（只写域名，**不带 https://**：带了会拼出畸形前缀）'; end $$;
\endif
\if :{?tenant_zos_region}
\else
  do $$ begin raise exception '缺 -v tenant_zos_region='; end $$;
\endif
-- `dbt_role` 是**选填**（缺省 = 数据面物化角色 `platform`，与 deploy/data-compose.yml 的
-- `PGDUCK_USER` 缺省同名）。选填项必须先落缺省值再用：psql 对未定义变量的 `:"x"` 不替换，
-- 会原样留在 SQL 里变成一个语法错（一条极难看出所以然的报错）。
\if :{?dbt_role}
\else
  \set dbt_role platform
\endif

-- 密钥型三样：只认环境变量（见头注「参数与注入」）
\getenv tenant_role_password TENANT_ROLE_PASSWORD
\if :{?tenant_role_password}
\else
  do $$ begin raise exception '缺环境变量 TENANT_ROLE_PASSWORD（口令只经 env 注入：-v 会让它出现在进程 argv 里）'; end $$;
\endif
\getenv tenant_zos_access_key TENANT_ZOS_ACCESS_KEY
\if :{?tenant_zos_access_key}
\else
  do $$ begin raise exception '缺环境变量 TENANT_ZOS_ACCESS_KEY（取法见本文件头注）'; end $$;
\endif
\getenv tenant_zos_secret TENANT_ZOS_SECRET
\if :{?tenant_zos_secret}
\else
  do $$ begin raise exception '缺环境变量 TENANT_ZOS_SECRET（取法见本文件头注）'; end $$;
\endif

-- 形态校验：`tenant_name` 必须就是本约定派生出来的形态（前缀 + 小写字母/数字/下划线）。
-- 为什么要校验：它是**标识符**，而标识符不像值那样有类型兜底 —— 一个带大写或连字符的名字会被
-- PG 折成别的对象（`"Tenant_X"` 与 `tenant_x` 是两个 schema），静默建到别人头上。
-- 实现：psql 变量**不能**在 `do $$ … $$` 体内插值 ⇒ 先把**非密**值搬进会话 GUC 再校验
-- （密钥型三样不搬：GUC 能被 `show` 读出来）。
select set_config('datatenants.tenant_name', :'tenant_name', false);
select set_config('datatenants.dbt_role', coalesce(nullif(:'dbt_role', ''), 'platform'), false);
do $$
declare
  n text := coalesce(current_setting('datatenants.tenant_name', true), '');
  r text := coalesce(current_setting('datatenants.dbt_role', true), '');
begin
  if n !~ '^tenant_[a-z0-9_]+$' then
    raise exception 'tenant_name 不合法（%）：必须是 tenant_<小写字母/数字/下划线>。派生口径的唯一事实源是 dbt/macros/generate_schema_name.sql（折小写 + 连字符改下划线），平台侧对账用 scripts/reconcile-data-tenants.mjs 的同名函数', n;
  end if;
  if r !~ '^[a-z_][a-z0-9_]*$' then
    raise exception 'dbt_role 不合法（%）：只允许小写字母/数字/下划线', r;
  end if;
  if not exists (select 1 from pg_roles where rolname = r) then
    raise exception '物化角色 % 不存在：schema 授权与默认权限都要挂到它身上，角色不在 ⇒ 白建', r;
  end if;
end $$;

-- ── §1 PG role（每租户一个：连接身份 = 租户边界的一半，另一半是 SCOPE）────────────────
-- 口令每次收敛到注入值（幂等：不换值 ⇒ 结果一致；换值 ⇒ 轮换）。
--
-- ⚠️ 口令会进**服务端日志** —— 暴露面比「只在 log_statement=all 下」宽，如实读这一节（评审 M3）：
--   · **缺省配置**（`log_statement=none` + `log_min_error_statement=error`，即 PG 的出厂缺省，
--     本机 `show` 实读确认）下：**这一句失败**时，PG 会把**整条语句文本（含明文口令）**写进
--     服务端日志（`log_min_error_statement` 的语义是「语句出错 ≥ error 就记语句」）。
--     触发条件很现实：跑 provision 的角色没有 CREATEROLE、连接被中途掐断、库满了。
--     实测（PG 16.15，未改任何 GUC）：一条失败语句 ⇒ 日志里 `STATEMENT: alter role … password '…'`。
--   · `log_statement=all` / `pgaudit` 一类审计配置下：**成功**的那次也一样进日志。
--   · 只收紧 `log_statement` **没用**（它的缺省已经是 `none`，管的是「成功的语句」）——
--     要动的是失败路径那一个：`alter system set log_min_error_statement = 'panic'`（reload 生效）。
--     代价：**所有** ERROR 级失败都不再附「哪条语句触发的」那行 `STATEMENT:`（报错本身照常记录）
--     ⇒ 排障能力下降，取舍由目标机决定。
--   · 「不把口令写进语句」在 PG 侧**没有**可用的 DDL 形态：`ALTER ROLE … PASSWORD` 只收字面量，
--     psql 变量是**客户端替换**（口令照样进语句文本）。客户端能算 verifier 的只有 psql 的
--     `\password`（实测：它把口令换成客户端算出的 SCRAM verifier 才发上去，明文不上服务器），
--     但它是**交互式提示**、值只能从 stdin 喂 ⇒ 与「env 注入 + 一次 psql 调用」的 runner 契约
--     相冲，且在有 tty 的环境会去读 /dev/tty 而**挂住**（对开通 job 而言挂死比日志暴露更糟）。
--     ⇒ 本轮不做，登记为 runner 契约面的候选（真要做，改的是 runner，不是本模板的 DDL）。
select exists(select 1 from pg_roles where rolname = :'tenant_name')::text as role_exists \gset
\if :role_exists
  alter role :"tenant_name" with login password :'tenant_role_password' nosuperuser nocreatedb nocreaterole;
\else
  create role :"tenant_name" with login password :'tenant_role_password' nosuperuser nocreatedb nocreaterole;
\endif

-- ── §2 每租户 schema 与其授权 ─────────────────────────────────────────────────────────
-- 归属该租户角色；物化角色拿 CREATE（dbt 在它里面建表）；`public` 一律收回（新库默认权限的历史包袱）。
create schema if not exists :"tenant_name" authorization :"tenant_name";
revoke all on schema :"tenant_name" from public;
grant create, usage on schema :"tenant_name" to :"dbt_role";
grant usage on schema :"tenant_name" to :"tenant_name";
-- 已经建出来的表/视图（幂等：grant 重复执行是 no-op）
grant select on all tables in schema :"tenant_name" to :"tenant_name";
-- 将来物化出来的表：由**物化角色**建的默认权限必须带上这条，否则每轮新物化的表都读不到
-- （`alter default privileges` 重复执行是 no-op ⇒ 幂等）
alter default privileges for role :"dbt_role" in schema :"tenant_name" grant select on tables to :"tenant_name";

-- `search_path` 钉到本租户 schema（spec §11.5 #3 的「per-schema + 切换 search_path」落点）：
-- 会话以该角色连上来时，**不带限定的名字默认解析到自己的 schema**。
-- `public` 保留在后面：pg_duckdb 的函数（`read_parquet` 一类）装在那里，去掉它模块就调不到了。
-- 顺序是刻意的：本租户 schema 在前 ⇒ 同名对象（每租户一套物化表）永远先命中自己那份。
alter role :"tenant_name" set search_path = :"tenant_name", public;

-- ── §3 pg_duckdb 凭据：每租户一份，SCOPE 收窄到该租户前缀（⚠️ 未实测，见头注）──────────
-- 开关：`-v expect_pg_duckdb=off` 只给「明知本库没有 pg_duckdb」的环境用（本地/CI 纯 PG）。
\if :{?expect_pg_duckdb}
\else
  \set expect_pg_duckdb on
\endif

select exists(select 1 from pg_extension where extname = 'duckdb')::text as has_pg_duckdb \gset
\if :has_pg_duckdb
  -- ① 外部服务器（每租户一个，承载该租户的 S3 端点/区域等**非密**面）
  select :'tenant_name' || '_zos' as zos_server_name \gset
  select exists(select 1 from pg_foreign_server where srvname = :'zos_server_name')::text as server_exists \gset
  \if :server_exists
    -- 端点/区域改了要收敛：`alter server` 是幂等的
    alter server :"zos_server_name" options (set endpoint :'tenant_zos_endpoint', set region :'tenant_zos_region', set url_style 'path', set use_ssl 'true');
  \else
    create server :"zos_server_name" type 's3' foreign data wrapper duckdb
      options (endpoint :'tenant_zos_endpoint', region :'tenant_zos_region', url_style 'path', use_ssl 'true');
  \endif

  -- ② 该租户角色的凭据映射：**这一段就是租户边界**（谁连上来，只拿得到自己桶前缀那一份）。
  --    DROP + CREATE 是故意的（见头注的幂等说明）：凭据轮换与首次开通走同一条路。
  --    SCOPE 收窄是「结构性隔离」的落点 —— 少了它，租户凭据能读整桶（= 能读别人的数据）。
  drop user mapping if exists for :"tenant_name" server :"zos_server_name";
  create user mapping for :"tenant_name" server :"zos_server_name"
    options (key_id :'tenant_zos_access_key', secret :'tenant_zos_secret', scope :'tenant_s3_scope');
\else
  \if :expect_pg_duckdb
    do $$ begin raise exception '本库没有 duckdb 扩展 ⇒ pg_duckdb 凭据这一件建不了。**不跳过**：跳过会造出「租户开通了、凭据没落」的假绿。明知环境如此请显式传 -v expect_pg_duckdb=off（那时会打一条 WARNING）'; end $$;
  \else
    -- `WARNING: ` 前缀写进**消息文本**里（不是靠 psql）：`\warn` 原样把文本写到 **stderr**、
    -- 自己**不加**任何前缀（实测：stdout 0 字节 / stderr 1 行）⇒ 不手写这个前缀，按 `WARNING`
    -- grep 的 job 会**漏掉**这条「跳过」。README §5 的措辞就是「打一条 WARNING」（评审 M2）。
    \warn 'WARNING: 跳过 §3 pg_duckdb 凭据（expect_pg_duckdb=off，且本库没有 duckdb 扩展）：该租户的 schema/role/授权已就绪，但**凭据未落** ⇒ 本租户的 read_parquet 现在还读不到桶。这不是开通完成，是「③ 面就绪、② 面待真机核」。'
  \endif
\endif

-- ── 收尾自证：把该租户的实际落点回读一遍（值都不含凭据）──────────────────────────────
\echo '────────────────────────────────────────────'
\echo '¥ provision 完成（幂等重跑结果应与本轮一致）：'
select rolname as role_name, rolcanlogin as can_login from pg_roles where rolname = :'tenant_name';
select nspname as schema_name, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = :'tenant_name';
select table_schema, privilege_type from information_schema.role_table_grants
 where grantee = :'tenant_name' order by table_schema, privilege_type;

-- 单事务的唯一出口：走到这里才落库（失败时 psql 已退出、连接已断 ⇒ 上面全部回滚）
commit;
