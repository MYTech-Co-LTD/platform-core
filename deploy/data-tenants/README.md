# `deploy/data-tenants/` — 每租户的数据面开通（P3 / T11）

> 交付面：**模板进 git、值不进**。本目录只有一份 `provision-template.sql` 与本说明，
> **没有任何凭据真值**（取法见下「参数与注入」）。

## 1 它在链条里的位置

```
平台租户（platform.tenant）
   │  ① PG role          ② S3 凭据（USER MAPPING + SCOPE 收窄到该租户桶前缀）  ③ 每租户 schema + 授权
   ▼
数据面（pg_duckdb）  ← 本目录的模板逐租户建这三件
   ▲
dbt 物化（--vars '{tenant: <键>}' ⇒ 落进 tenant_<归一后> 这个 schema）   ← dbt/macros/generate_schema_name.sql
   ▲
对账（平台启用集 ↔ 数据面已建 schema/role，双向差集）                    ← scripts/reconcile-data-tenants.mjs
```

**三件缺一不可**（缺哪件是什么症状）：

| 件 | 缺了的症状 |
|---|---|
| ① role | 该租户**没有数据面身份** —— 没有可以「只读到自己那份」的连接 |
| ② 凭据 + `SCOPE` | 有身份但**读不到自己的桶**；或**读得到整桶**（SCOPE 没收窄 ⇒ 结构上能读到别人的前缀） |
| ③ schema + 授权 | 物化没地方落、或落了租户角色读不到 |

**隔离主力在 ①②③（数据面）**，不在消费层：Metabase OSS 的逐用户隔离是零（spec §6.1），
所以「每租户一桶 + 每租户一份凭据 + 每租户一个 schema」是**结构性**的那一层。

## 2 怎么跑

逐租户跑一次（**循环在 openship job 里**，不在本文件里 —— 拍板 #4：调度 = openship jobs）：

```bash
TENANT_ROLE_PASSWORD='…' TENANT_ZOS_ACCESS_KEY='…' TENANT_ZOS_SECRET='…' \
  psql "$DATA_WAREHOUSE_URL" \
       -v tenant_name=tenant_acme_org \
       -v tenant_s3_scope='s3://<桶>/<该租户前缀>' \
       -v tenant_zos_endpoint='…' \
       -v tenant_zos_region='…' \
       -f deploy/data-tenants/provision-template.sql
```

**幂等是硬要求**（部署脚本会每轮全量重跑）：本文件两个出口都不会因重跑而报错，
且**第二次跑的结果与第一次逐字一致**（`DROP … IF EXISTS` / `… IF NOT EXISTS` / `ALTER` 三形态；
`DROP USER MAPPING IF EXISTS` + `CREATE USER MAPPING` 是**故意**的 —— 它让「凭据轮换」与
「首次开通」走同一条路）。实测证据在 `task-11-report.md`（连跑两次的输出）。

## 3 参数与注入（**「在哪、怎么取」，不写值**）

| 参数 | 必填 | 形态 | 值从哪来 |
|---|---|---|---|
| `-v tenant_name=` | ✅ | `tenant_<归一后的租户键>` | 平台侧派生（键 = `platform.tenant.casdoor_org`；派生口径唯一在 `dbt/macros/generate_schema_name.sql`） |
| `-v tenant_s3_scope=` | ✅ | `s3://<桶>/<该租户前缀>` | 该租户在数据面的落点前缀（**这一项就是租户边界**） |
| `-v tenant_zos_endpoint=` | ✅ | 域名，**不带 `https://`** | ZOS 控制台（带了协议会拼出畸形前缀，实测坑） |
| `-v tenant_zos_region=` | ✅ | 如 `xinan1` | 同上 |
| `-v dbt_role=` | 选填（缺省 `platform`） | 数据面物化角色 | 与 `deploy/data-compose.yml` 的 `PGDUCK_USER` 同名 |
| `-v expect_pg_duckdb=` | 选填（缺省 `on`） | `on` / `off` | 见 §5「开关」 |
| env `TENANT_ROLE_PASSWORD` | ✅ | — | 新建租户角色的口令（生成侧自行决定；**只经 env**） |
| env `TENANT_ZOS_ACCESS_KEY` | ✅ | — | 该租户 `TENANT_STORAGE` 凭据：真源 `platform.tenant.storage_access_key`（M3c `006_tenant_storage.sql`），openship 侧以 env(isSecret) 物化 |
| env `TENANT_ZOS_SECRET` | ✅ | — | 同上（`storage_secret`） |

**为什么三样密钥型走 env 而不是 `-v`**：`-v` 的值会出现在进程 argv 里（`ps` 可见）；
模板用 `\getenv`（psql ≥ 15；数据面镜像基于 PG 17）从进程环境读，**不进 argv**。

**已知边界**：角色口令一旦 `ALTER ROLE … PASSWORD`，在 `log_statement=all` 一类配置下会进
**服务端日志** —— 轮换口令时留意日志留存策略（这是 PG 侧的既有性质，不是本模板引入的）。

## 4 退出码与失败面（fail-closed）

本文件用 `\set ON_ERROR_STOP on`，**任何一句失败即中止**（psql 退出码 3）。故意的失败面：

| 触发 | 结果 |
|---|---|
| 缺任一必填参数 / 密钥 env | §0 停住，错误信息直接说缺哪个、去哪取 |
| `tenant_name` 形态不对（大写、连字符、非 `tenant_` 前缀） | 形态校验停住 —— **标识符没有类型兜底**，一个带大写的名字会被 PG 折成另一个对象 |
| `dbt_role` 这个角色在库里不存在 | 停住（schema 授权与默认权限都要挂到它身上，角色不在 = 白建） |
| 本库没有 `duckdb` 扩展，且没显式 `expect_pg_duckdb=off` | 停住 —— **不静默跳过**（跳过 = 「租户开通了、凭据没落」的假绿） |

## 5 `expect_pg_duckdb` 开关（唯一允许跳过 §3 的口子）

第 ② 件（pg_duckdb 凭据）目前是**未实测形态**：形状有据（spec §9.5）、键名未验
（本机没有 pg_duckdb；WeKnora 经验库 2026-09-22 检索**没有** USER MAPPING 这条接线的一手条目）。
所以：

- 缺省 `on`：扩展不在 ⇒ **响亮失败**；
- `off`：显式声明「本库就是没有 pg_duckdb」（本地/CI 的纯 PG 环境），此时**打一条 WARNING** ——
  跳过是有记录的动作，不是无声的。**真机核对归 T13**；两条候选路（USER MAPPING 承载 vs
  同会话 `duckdb.create_simple_secret`）写在 `provision-template.sql` 的 §3 头注里。

## 6 未验清单（诚实边界）

1. **§3（pg_duckdb 凭据）整节未在真机跑过**：本机没有 pg_duckdb ⇒ 外部服务器 / USER MAPPING /
   `SCOPE` 的 DDL 形状与 OPTIONS 键名**都未验**，真机核对归 T13。
2. **`SCOPE` 的真实收窄效果未验**（「拿着 A 的 role 读 B 的桶路径必须失败」是 T12 套件的凭据负测，
   真机版归 T13）—— 本文件只保证**声明**里带着 SCOPE，不保证引擎按它拦。
3. **`search_path` 绑定的实际效果**：本地纯 PG 上验过「以租户角色连上、不带限定名读到自己那张表、
   且只能看见自己的 schema + `public`」；**在 pg_duckdb 上未验**。
4. **没有 runner 本身**：本目录只交付模板，不交付调度（循环、env 注入、job 注册属 openship job 面）。
