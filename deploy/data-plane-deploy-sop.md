# SOP：数据面部署（openship services 模式，`deploy/data-compose.yml`）

## A 定位与案例

> **适用**：数据面 project（`platform-core-<客户>-data` 类，composePath=`deploy/data-compose.yml`）。
> 平台面（部署单元 A）的接入走 `deploy/openship-adopt.md` / `deploy/customer-onboarding.md`，
> 本文只管**数据面这一侧**从零到验收的全序列。

**案例来源**（无案例不立标准——本 SOP 的每条都有真机出处）：

- **shanhai 全量站**（2026-09-23）：含 etl（duckle/dbt）的完整数据面；
- **mytech 对比站**（2026-09-24）：不带 etl 的三服务裁剪站，并实测了首部署 env 重写、
  Casdoor Upcoming、回环 vs edge 三类新坑。

**三道安全阀**（贯穿全程，先记住再往下走）：

1. **P2 预置门：不过不部署**——镜像没逐个 inspect 到位、检出没钉全 SHA，就不许触发部署；
2. **P4 首部署：允许 partial**——首部署 etl 构建挂属**预期**，partial_failure 选 keep，别回滚重来；
3. **P10 验收：逐项打勾，不做「看起来绿」**——部署绿 ≠ 数据面可用，七项验收一条条过。

---

## B Phase 0-10 操作单

> 每个 Phase 三件套：**动作 / 命令 / 过门条件**。过门条件不满足就停在那一步，别带病进下一 Phase。

### P0 盘点

| 动作 | 命令（openship MCP server exec） | 过门条件 |
|---|---|---|
| 确认目标机 serverId | 控制面 servers 列表 | serverId 在手、机器在线 |
| 端口空闲：`15432`（pg_duckdb）、`13030`（metabase） | `ss -lnt \| grep -E '15432\|13030'` | 无输出（撞了先挪再谈） |
| 是否要 etl（duckle/dbt） | ——（对比站/纯 BI 站不要） | 拍板记下：etl 有无决定 P2 镜像清单与 P5 服务面 |

### P1 体检

| 动作 | 命令 | 过门条件 |
|---|---|---|
| 磁盘余量 | `df -h` | 余量 ≥ 15%（数据面镜像 + 卷 + build cache 三层都要吃盘） |
| build cache 隐形大户 | `docker system df` | mytech 实测 build cache 一项 **26GB**；不够先 `docker builder prune -a -f` 再回来重验 |

### P2 预置【安全阀 1：不过不部署】

| 动作 | 命令 | 过门条件 |
|---|---|---|
| 仓库检出 | tarball 解到 `/opt/platform-core-data/platform-core`，**钉全 SHA**（全 SHA 只能从命令输出逐字复制，绝不手工补） | `git rev-parse HEAD` 与钉的 SHA 逐字一致 |
| 镜像预拉 | `docker pull pgduckdb/pgduckdb:18-v1.1.1`、`metabase/metabase:v0.63.18.1`、`postgres:16-alpine`；**etl 站加** `python:3.12-slim` | **每个** `docker image inspect <ref>` 到位才算过——少一个都不许部署 |

> 为什么钉死这条：**BuildKit 解析 base 镜像元数据要走网**（不走 dockerd 代理），本地没缓存过的新基镜像
> 首次构建必挂，且日志只留 `Pulling image` 一句就断（极难排障）。`docker pull` 本身走代理没问题
> ——所以永远是「先 pull 后部署」，别让构建期替你做第一次拉取。

### P3 密钥

| 动作 | 过门条件 |
|---|---|
| 生成三套强口令：`PGDUCK_PASSWORD` / `MBDB_PASSWORD` / `DUCKLE_TOKEN`（在哪生成、怎么存：openship project env，**不进 git、不进本文**） | 三键 `isSecret` upsert **全部完成**才许触发首部署 |
| 明文键同批落：`PGDUCK_USER=platform`、`PGDUCK_DB=warehouse`、`MBDB_USER=metabase`、`MBDB_DB=metabase` | 与密钥同一次 PATCH 落齐 |

> shanhai 实测教训：密钥没先落就首启 ⇒ **metabase-db 首轮落在 compose 默认口令上**，后来只能
> `ALTER USER` 对齐——先密钥后首启是顺序纪律，不是风格偏好。

### P4 首部署【安全阀 2：允许 partial】

| 动作 | 说明 |
|---|---|
| 触发 openship 部署（显式传 serverId） | **openship 首部署无视先前 services_sync、原样吃 compose**——etl 服务（duckle/dbt，`profiles: ["etl"]`）的构建在此阶段必挂，**属预期** |
| partial_failure → **keep** | 保住已成功的三常驻服务；别选 reject 回滚重来（白烧一轮 P2 预拉） |

### P5 服务面修正（services_sync）

只做四件事，做完服务面就**定型为 3 常驻服务**：

1. **只留 `pg_duckdb` / `metabase-db` / `metabase`** 三个常驻；duckle/dbt 是 etl 执行器，
   **零常驻语义**（按需 job 跑），不进服务面；
2. **PG18 挂载改 `pgduckdata:/var/lib/postgresql`**（服务级覆盖）：官方 18 镜像改了数据目录约定
   （版本子目录），compose 里的旧 `/var/lib/postgresql/data` 形态被入口脚本直接拒（报 unused mount）；
3. **env 全部写字面真值**：services_sync 写入的 environment 是**终值，不解析 `${VAR:-default}` 模板**
   ——模板字符串以字面量进容器，PG 报 `invalid character in extension owner`；
4. **metabase 的 `MB_DB_CONNECTION_URI` 带真口令**（P3 生成的那套）。

### P6 重部署 + 数据面自验收

| 验收项 | 过门条件 |
|---|---|
| PG | `pg_isready` → accepting connections |
| Metabase | `/api/health` → `{"status":"ok"}` |

### P7 Gate-B 接线（数据面 → 平台网络）

```sh
docker network connect --alias pg_duckdb <平台网络名> <数据面 pg_duckdb 容器>
```

- **这是运行态步骤**：容器/网络重建后要**重做**（P8 平台侧重部署重建容器后记得回来补）；
- 平台侧 `DATA_WAREHOUSE_URL` 用**服务名**形态 `pg_duckdb:5432`（不是宿主回环 `127.0.0.1:15432`——
  容器里的 127.0.0.1 是自己的 netns）；
- 验收：从**平台 server 容器**内 `nc -zv pg_duckdb 5432` 通。

⚠️ **2026-09-28 实测：这条真的会掉，而掉的时候只有问数 502，别处没有任何报错。**
当时现场 = 平台容器只在 `openship-platform-core-shanhai`、pg_duckdb 只在 `…-shanhai-data`，
容器内 `dns.lookup('pg_duckdb')` 回 **ENOTFOUND**（而 `DATA_WAREHOUSE_URL` 形状是对的）。

⇒ **重做后必跑这两条断言**。注意 DNS 与 TCP **分开判**——`nc` 在平台镜像里**没有**（node:22），
且它报 `bad address` 是**解析失败**、不是「连不上」：

```sh
S=openship-platform-core-shanhai-server
docker exec "$S" node -e "require('dns').lookup('pg_duckdb',(e,a)=>console.log(e?('ERR '+e.code):('DNS_OK '+a)))"
docker exec "$S" node -e "const n=require('net'),s=n.connect(5432,'pg_duckdb');s.on('connect',()=>{console.log('TCP_OK');s.end()});s.on('error',e=>console.log('TCP_ERR '+e.code))"
```

预期 `DNS_OK 172.18.0.x` + `TCP_OK`。

⇒ **上面这两步（重做 + 断言）已固化成脚本，别再照本文手敲**（issue #303）：
`scripts/lemeng/wire-warehouse.sh` → 投递到 `/opt/lemeng-wire-warehouse.sh`。

```sh
sh /opt/lemeng-wire-warehouse.sh            # 重做两条接线（幂等），末尾自动复查
sh /opt/lemeng-wire-warehouse.sh --check    # **只读**复查：八条断言全过 exit 0，任一不过 exit 1
```

它把 P7 与 P8b **一起**做掉（两条都是「掉了不报错」，分开治理只会漏一条），
并且参数不硬编：role / db 从平台容器的 `DATA_WAREHOUSE_URL` 现取（**不碰口令**）。

### P8 平台侧接线

| 动作 | 过门条件 |
|---|---|
| 平台 project env 加 `DATA_WAREHOUSE_URL`（isSecret）→ 重部署 | 部署后**必验服务 env 形状**（逐键看物化结果，不是看配置面） |

> mytech 实测：部署把 `DATABASE_URL` **重写成无口令形态** ⇒ `client password must be a string`
> crash loop。修法：从 postgres 容器读真口令 → **服务级 PATCH 写回** → 重部署。同类问题一律
> 「读真值 → 服务级写回 → 重部署 → 再验形状」。

### P8b 仓库连接的 `search_path`（**2026-09-28 新增**）

**为什么需要它**：dbt 物化落在 schema **`staging`**，而
`modules/data/domain/semantic-compiler.ts` 产出的 SQL **关系名不带 schema**
（该文件 111-112 行明写「关系名可带 schema…多租户下 schema 由会话 search_path 绑」）。
仓库连接的默认 `search_path` 是 `"$user", public` ⇒ 问数会以
**`relation "<模型名>" does not exist`** 收场。**这个报错看着像「表不存在」，其实是解析不到 schema**——
2026-09-28 实测：同一条 SQL 补上 `staging.` 或先 `set search_path` 就出数。

```sh
# 在数据面 pg_duckdb 容器内跑一次；role / db 取自 DATA_WAREHOUSE_URL（本部署 = platform / warehouse）
ALTER ROLE <DATA_WAREHOUSE_URL 的 user> IN DATABASE <DATA_WAREHOUSE_URL 的 db>
  SET search_path TO staging, public;
```

- **为什么不用 URL 参数**（`?options=-csearch_path%3Dstaging`）：两者等效，但那个形态要把仓库口令
  读出来再写回 project env；角色级设置**同一层生效、免重部署、不碰凭据**。代价见下一条。
- ⚠️ **这是库内隐藏状态**：仓库卷重建即失效，**且没有任何东西会报** ⇒ 它是新机 provision 的必经一步。
- 验收（用**真连接**、且**不带 schema**）：`select count(*) from fct_retail_sale` 应出数。

**本条与 P7 合在一起已固化成脚本**：`sh /opt/lemeng-wire-warehouse.sh`（重做，幂等）/
`sh /opt/lemeng-wire-warehouse.sh --check`（只读复查**七条**断言：DNS / TCP / 真查询 /
**④ PG 新鲜度**（fct 的 max(bizday) ≥ 上海今天−2，抓「dbt 绿但读湖读短了」的静默变短）/
**⑤ 词表非空**（`data.metrics` ≥ 1 行，抓「词表被清空」）/
**⑥ 发布维表**（`data.dim_item` 非空且 max(snapshot) ≥ 上海今天−3，#476）/
**⑦ 工单取价面**（`dim_settlement_order_line` 非空且 max(order_bizday) ≥ 上海今天**−3/−2（上海 13 点前/后）**，#520/#534）——④⑤ 是「下游看得见」探测的落地
（2026-10-06，#297 最后一格 + handbook §7 #4 转正），且与前三条共用「平台容器 + 平台自己的
连接串」通路 ⇒ 顺带持续 exercising Gate-B 与 search_path）。

**配套探活 job**：openship job 定时跑 `--check`，**失败即告警**（不许 `continue-on-error`——
静默漂移 = 回到「没有复查」的状态）。

> ⚠️ **⑦ 的容差是时段感知的（#534 教训）**：取价面由维表发布 job（上海 11:43）整批替换、
> 读的是 L0 昨晚 23:35 采的 T-1 单据 ⇒ **每天零点时面必然停在 T-3**。给发布面/物化面写
> 新鲜度判据，容差必须 ≥「采集滞后 + 发布周期」，或按当前时刻分段（⑦：上海 13 点前 −3、
> 之后 −2）——固定拍天数必踩「零点起结构性红到中午发布完成」（2026-10-10 首夜实测 ~200 条
> 企微误报；采集/湖全程健康，纯判据 vs 节奏错位）。

**反向测试已做（别把「探针绿」读成「探针有用」）**：两种形态都**确实 exit 1**，不是恒绿——
① 探针表名指错（`WIRE_PROBE_TABLE=no_such_table_zzz`）⇒ 断言③红；
② **真断开 Gate-B**（`docker network disconnect`）⇒ 三条断言全红 `ENOTFOUND`，复接后回绿。

### P9 Casdoor 订阅

| 动作 | 过门条件 |
|---|---|
| plan（`mod-data`）→ subscription | **`start_time` 必须是过去时刻**：写成未来 ⇒ Casdoor 自动标 Upcoming ⇒ `enabledFromSubscriptions` 不认（mytech 实测） |
| `state=Active`、`end_time` 未来 | **写后回读三件套**（plan/subscription/state——Casdoor 三铁律：写后回读验目标状态） |
| 验收前等一分钟 | 订阅缓存 TTL 60s，写完立刻验会假红 |

### P10 验收【安全阀 3：逐项打勾，不做「看起来绿」】

- [ ] 容器全 Up（三常驻服务）
- [ ] `pg_isready` accepting
- [ ] metabase `/api/health` `{"status":"ok"}`
- [ ] 平台容器 → `pg_duckdb:5432` open（P7 的 nc 验收复跑一次）
- [ ] `/api/platform/config` 模块集 = 预期（mod-data 在列）
- [ ] **edge healthz 200**——别走宿主回环（mytech 实测：宿主回环 curl 000 而 edge 200，回环形态会误判「挂了」）
- [ ] 端口全回环（`docker port` 或 `ss -lnt` 复核 15432/13030 只绑 127.0.0.1）
- [ ] **Gate-B 断言过**（P7 那两条：`DNS_OK` + `TCP_OK`）——**每次重建容器后都要重跑**
- [ ] **`search_path` 已绑且真查询出数**（P8b：不带 schema 的 `select count(*) from fct_retail_sale`）
- [ ] **L1 词表已物化且 `source_system` 非空**（命令见 §F.6 末的订正注）——job 已注册（2026-10-03：
  `L1 词表物化`，cron `33 4 * * *` UTC；「词表被清空」另有探活 job 的 ⑤ 断言盯着，#297）。
  ⚠️ 判据是「**L1 行的 `source_system` 非空**」，**不是「`data.metrics` 非空」**：`006` 加的列
  **可空**，迁移时库里**已存在**的旧 L1 行在重跑一次 `sync-data-semantics.mjs` 之前
  `source_system` 是 `NULL`，而 `visibleMetrics` 把 `null` 判为「恒可见」（L2 语义）
  ⇒ 这些行对**所有**租户可见、写闸也不触发 —— 即「**没登记的源反而全可见**」。
  此时「`data.metrics` 非空」是**假绿**（旧行本来就非空）。故：物化后**必须**按 source_system
  复核一遍（示例：`select count(*) filter (where source_system is null) as nulls, count(*) from data.metrics`，
  `nulls` 应为 **0**）；非 0 ⇒ 说明存量行还没被 sync 刷新，补跑一次再验。
- [ ] **源维度对账过**（P11：`reconcile-tenant-sources.mjs` **exit 0**，四桶全空）——exit 1（漂移）
  与 exit 2（对不成账）都算**不过**，处置不同、都要人看

### P11 源维度接线与对账（console 声明 ↔ 平台登记）

> 依据：spec §3⑧ 与 §7 待办 6（2026-09-30 人裁）；对账脚本 = `scripts/reconcile-tenant-sources.mjs`。
> 它是「**声明 ↔ 事实**」的对账：平台侧登记（`platform.tenant_source`）是**裁决用的事实**——词表
> 按租户已接入源裁剪、未接入源的写入闸 403，都在**请求路径**上读它；而 console 侧
> `ADOPTED_SOURCES_<账套>` 只是一句**声明**。两侧一旦分叉，症状是**静默**的（从任何一条请求的
> 返回里都看不出来）⇒ 必须显式打差集、用退出码让 job 变红，不靠人读日志。

**① 接线：console 的「已接入源」声明键**

键 = **`ADOPTED_SOURCES_<账套>`**（如 `ADOPTED_SOURCES_3120`），值 = 逗号分隔的源（如 `lemeng`）。
两个形态**别混**：

| 形态 | 在哪 | 谁读 |
|---|---|---|
| `ADOPTED_SOURCES_<账套>`（**带账套后缀**）——真正的事实源 | **openship 项目 env** | 宿主侧对账（运行方传入脚本） |
| `ADOPTED_SOURCES`（**裸**） | 容器内（`deploy/data-compose.yml` 注入的形态 `${ADOPTED_SOURCES_3120:-}`） | **当前无消费方**——它是给镜像/运维看的**声明**，不是运行时被读的键 |

- 一账套一 console（ADR-0014）；**键在而值为空** = 「该 console 一个源都没声明」（合法，不是缺配）。

**② 对账命令**（在能连平台库的地方跑；**声明的值从 openship 项目 env 取——别去 SSH 读 console 的 env**，那违反唯一通道）：

```sh
DATABASE_URL=<平台库连接串> \
  ADOPTED_SOURCES_3120=lemeng ADOPTED_SOURCES_64188=lemeng \
  pnpm exec tsx scripts/reconcile-tenant-sources.mjs [--json]
```

- **出口码**就是 job 的信号面：**0 = 干净**（四桶全空）；**1 = 有差集**（逐条打印，job 变红）；
  **2 = 对不成账**（缺 `DATABASE_URL` / 查库失败 / **一个前缀键都没有**）。⚠️ **exit 1 与 exit 2
  必须可区分**：2 是脚本/环境坏了，1 是被观测的系统漂移了，处置完全不同。
- **四桶**（双向差集，判据写死在脚本头注，别在别处复述）：`missingInConsole`（平台启用了、没 console
  声明）/ `missingInPlatform`（console 声明了、平台一行都没有）/ `disabledButDeclared`（平台该行
  `enabled=false`、仍被声明）/ `declaredButDisabled`（整源停用、仍被声明）。
- ⚠️ **「对不成账」（exit 2）≠「漂移为空」**：空声明侧会把平台侧每一行都误报成 `missingInConsole`
  ⇒ 脚本对「一个前缀键都没有」**响亮失败**（exit 2），不给假读数。

**③ 三条已知边界（都是接口边界，补桶也补不上——别当漏检）**

1. **无「账套 ↔ org」映射** ⇒ 「B 的 console 声明了只在 A 启用的源」会被读成 **clean（静默 clean）**。
   两侧键空间不同（平台侧按 **org**、声明侧按 **账套**），脚本只按**源名**做集合差 ⇒ 跨租户的归属
   错配看不出来。这是**接口边界**——**补桶补不上**（缺的是映射本身）。
2. **新键不受 B9 管**（`.env.example` 门禁的扫描面 = `apps/`、`packages/`、`modules/`，**不含**
   `deploy/`、`scripts/`）⇒ compose 里的键名与脚本读的前缀**仅靠命名约定**：compose 出现
   `ADOPTED_SOURCES:` 时，其 `${ADOPTED_SOURCES_<x>}` 变量名**必须**以脚本的 `ADOPTED_SOURCES_PREFIX`
   （`ADOPTED_SOURCES_`）打头。**没有机检**，改键名时人守着。
3. **改 env 键后必须 refresh 重建容器才吃到**——openship 在**容器创建时**注入 env，光重启进程不够；
   按 §F.2 的实测口径**用 `serviceIds` 定向部署**（**别单传 `refreshServiceIds`**：2026-09-26 实测它
   触发了全量重建，把 `pg_duckdb` / `metabase-db` 一并重启）。且**宿主侧对账读的是 project env 里
   带账套后缀的键**，不是容器内那个裸键（见 ① 的表）。

---

## C 23 坑三层分类表

> 三层的处置语义不同：**A 层已根治**（再撞说明回退了修复，查 git）；**B 层结构性**（openship
> services 模式的固有行为，防法=按 B 节固定序列走）；**C 层环境前置**（防法=检查项+判定，P0-P2/P9/P10 已内置）。

### A 层：已根治 8（修复已进仓/控制面）

| # | 坑 | 根治处 |
|---|---|---|
| 1 | dbt-postgres 1.9.8 配对不存在（1.9 线只到 1.9.1） | #187 钉 `1.9.1`（`deploy/dbt/Dockerfile`） |
| 2 | dbt Jinja 块内 SQL 注释编译错 | #187（模型改写规避） |
| 3 | 构建容器内 corepack/pnpm 直连 npmjs 超时 | #192 corepack 腿（env `COREPACK_NPM_REGISTRY`）+ #492 pnpm 腿（`/app/.npmrc` + 构建内自证断言）。**两腿配置方式不同**：pnpm 实测**不读 env**（大小写两式皆无效），只认 `.npmrc` |
| 4 | 真库测试锁竞态族（超时抖动） | #190 `fileParallelism` 根级串行 |
| 5 | 智能代理大镜像分块拉取缺陷 | 控制面代码+配置双修（首块 4MB / 块超时 600s / 并行 6——细节见 WeKnora《智能代理大镜像拉取根治》） |
| 6 | openship services 模式三坑（相对 bind / PG18 数据目录 / env 终值） | #187 入档 + 本 SOP P5 固化 |
| 7 | checkpoint 首抓永久化：窗内点火抓截断快照被永久冻结、闭窗后源侧补录进不来，**回填=重放修不了**（#528 三天对账红） | 回填父管线 bizday 闭窗守卫（fail-closed）+ `recon-day-heal.sh` 常设旁路（#529；方法论 §1.3.4） |
| 8 | seed 全量期望集：他账套管线在 `--check` 恒报 DRIFT（信号被淹）、全量 seed 误灌他账套管线进卷（#531） | 期望集 = 共享族 + 本账套后缀族（#532）+ 排班↔能力源头闸 `check-console-schedules.mjs` |

### B 层：结构性 5（靠固定序列防）

| # | 坑 | 防法 |
|---|---|---|
| 7 | 首部署无视 services_sync、原样吃 compose（etl 构建必挂） | 首部署**预期 partial → keep → sync → 重部署**（P4→P5→P6） |
| 8 | services_sync 的 env 不解析 `${VAR:-default}` 模板 | 服务面 env **一律字面值**（P5 第 3 条） |
| 9 | 相对路径 bind 被当卷名（`../duckle`、`../dbt`） | 服务器放**绝对路径持久检出**（P2 的 `/opt/platform-core-data/`），服务级挂载写绝对路径 |
| 10 | 部署可能重写服务 env（丢口令 ⇒ crash loop） | **部署后必验 env 形状**；修法=读真值→服务级 PATCH 写回→重部署（P8） |
| 11 | etl 零常驻 vs services 守护语义冲突 | 服务面**只留 3 常驻**，etl 按 job 跑（P5 第 1 条） |

### C 层：环境前置 10（检查项 + 判定）

| # | 检查项 | 判定 |
|---|---|---|
| 12 | 磁盘余量 + build cache | `df -h` ≥15%；`docker system df` 看 cache 大户，不够先 `docker builder prune -a -f` |
| 13 | 镜像预拉先于部署 | 每个 `docker image inspect` 到位才算过（P2） |
| 14 | 密钥先于首启 | 三套 isSecret 全 upsert 完才首部署（P3） |
| 15 | Casdoor `start_time` 过去时刻 | 未来 ⇒ Upcoming ⇒ 订阅不生效（P9） |
| 16 | 订阅缓存 TTL | 写后等 60s 再验收（P9） |
| 17 | Gate-B network connect 是运行态步骤 | 容器/网络重建后重做（P7） |
| 18 | 验收走 edge 不走宿主回环 | 回环 000 ≠ 挂了，edge 200 才是判据（P10） |
| 19 | ZOS endpoint 不带 `https://` 前缀 + 内网 `use_ssl=false` | 见附录 D |
| 20 | dbt 容器挂载可写（target/logs） | 容器挂载**不带 `:ro`**（dbt 要写 target/logs） |
| 21 | dbt/duckle Dockerfile 的 pip 镜像源**未进仓** | #192 只修了 server 的 npm——etl 站要么**预构建镜像**（P2 拉好 `platform-core-dbt:local` 等）要么先落 pip 镜像 PR 再部署 |

---

## D 附录速查

**ZOS `create_simple_secret` 签名**（11 参，全 text）：
`type, key_id, secret, session_token, region, url_style, provider, endpoint, scope, validation, use_ssl`
——endpoint 去 `https://` 前缀；内网走 `use_ssl=false`。

**pg_duckdb / DuckDB 能力边界**：pg_duckdb 不暴露 `glob()`，但 `duckdb.query()` 内可用。

**dbt**：容器挂载不带 `:ro`（要写 target/logs）；`--profiles-dir` 指向**含 profiles.yml 的目录**；
dbt-postgres 1.9 线只到 `1.9.1`。

---

## E 数据面工件投递程序（仓 → 数据面机）

> **适用**：仓里的**数据面工件**要落到**数据面机**（`ecm-7d66` / 内网 `10.0.0.5`）上跑。
> **不是一个脚本**——机器实际消费的是一份**清单**（E.2 的表）。⚠️ **这里的条目数刻意不写死**：
> 它随接新工件增长，写死的数字一定会漂（本仓已有先例）⇒ **以 `deploy/data-plane-manifest.txt` 为准**。
> ⚠️ 这**不是部署的一部分**：部署不会把它们送过去（E.1），必须按 E.3 的程序**显式投递**。
> 案例（无案例不立标准）：2026-09-24 / 2026-09-25 两次**手工**投递（`69ca1e5`、`7ec67bf`，
> 逐次读数见 S1 的 `task-10-report.md`「投递」两节）；**清单化同步**首次落地见 issue #199。

### E.1 为什么 `merge main` 送不到生产（先理解这条，再谈投递）

数据面机的检出 `/opt/platform-core-data/platform-core` 是 **tarball 解包**（P2 的「钉全 SHA 检出」），
**没有 `.git`** ⇒ `git pull` / `merge main` 这条通路在数据面机上**根本不存在**。
⇒ 仓里那份工件与 `/opt/` 那份是**两份副本、无任何自动同步机制**：改了仓 ≠ 改了生产。
**每次改工件都要显式投递一次**，并把投递读数记下来（E.3 末）。

### E.2 消费面：机器实际读的是这些（不是「一个脚本」）

| 仓内路径 | 机器落地 | 谁读 |
|---|---|---|
| `deploy/data-compose.yml` | 同名 | openship 部署数据面项目（`proj_AFbJvyb0onaX7LVr`）按它起服务（**构建被跳过**，见下方定案）；etl 两个 runner 由 job 用 `docker run` 按需跑 |
| `duckle/**` | 同名 | compose bind `../duckle:/pipelines:ro`；宿主侧另有直读（drift 前置断言） |
| `dbt/**` | 同名 | compose bind `../dbt:/usr/app` |
| `deploy/duckle/entrypoint.sh` | 同名 | 仅作构建上下文（`deploy/duckle/Dockerfile` 的 COPY） |
| `scripts/lemeng/wire-warehouse.sh` | `/opt/lemeng-wire-warehouse.sh`（**改名**） | 探活 job 直调（`--check`）；接线重做时手调 |
| `scripts/lemeng/readback-helper.sh` | `<checkout>/lemeng-readback.sh`（**改名**） | 挂进容器跑回读 |
| `deploy/duckle/console/**` | 同名 | seed 进各账套 workspace 卷（`schedules/` / `pipelines/`） |
| `deploy/duckle/Dockerfile` | 同名 | **被投递的 `data-compose.yml` 引用它**（`build.dockerfile`）——见下方**定案**（**不是**「机器本机构建」） |
| `deploy/dbt/Dockerfile` | 同名 | 同上（`data-compose.yml:93` 引用；**#688 补登** 2026-10-15） |

> ℹ️ **已退役、故不在本表**：`scripts/lemeng/run-retail-day.sh`（落地名 `/opt/lemeng-run.sh`）——
> 2026-09-29 换工具后退役（`console/DELIVERY.md` §换工具），仓内已无此文件、清单里也没有它，
> 无 job、无现役管线引用（2026-10-15 核实）。E.5 那句「只投了 `run-retail-day.sh`」是**历史引语**，
> 说的是当年的漏法，别当成现役文件找。

**消费面怎么定的**（**四条**，缺一会漏）：① 机器侧脚本里对 `$REPO/<路径>` 的**每一处引用**
（原例 `run-retail-day.sh` 已退役；现役如 `materialize.sh` / `seed-console.sh` / `oo-*.sh`）；
② `data-compose.yml` 里的**每一处 bind**（源路径即仓内路径）；③ 各 Dockerfile 的 **COPY 来源**；
④ **机器上被 job/`exec` 直接执行**的脚本（job 命令里点到它）——判据 ①②③ 都是「谁读这个文件」，
漏掉了「谁**执行**这个文件」：`/opt/lemeng-*.sh` 那一类。它同样必须与仓内那份逐字节一致，
否则「job 跑的是哪个版本」无据可查。
⇒ **改了其中任一目录/文件，都要重投**——「只投了 `run-retail-day.sh`」正是本节要根治的漏法。

**✅ 定案（2026-10-15，同日**二次订正**）：Dockerfile 该留在清单里——但理由**不是**「机器本机构建」。
第一版定案（`#692`）断言「数据面机的镜像就是拿检出里那份构建的」，**当日晚些时候被自己的实测推翻**，
此处按实况重写。原文留在下面 `<details>` 里以留可追溯性。**

**实测四条（2026-10-15）**：

1. **openship 部署数据面项目从不构建**：`proj_AFbJvyb0onaX7LVr` 的部署 build 步骤恒打
   `Compose services use pre-built images - skipping build phase`——**连最早那次**（09-26 07:10）也是，
   23 次全无例外；
2. **镜像也不是拿机器上那份 Dockerfile 构建的**：`platform-core-dbt:local` 的构建命令原文（`docker history`）
   是 `DBT_VERSION=1.9.1` + `-i https://mirrors.aliyun.com/pypi/simple/`，而机器检出里那份是 **`#166` 版**
   （`DBT_VERSION=1.9.8`、**无**镜像源、`54e8ad65…`）——**对不上**；
3. **时间也排除了部署构建**：该镜像建于 **09-23 22:26**，**早于第一次数据面部署**（09-26 07:10）；
4. 层 C 第 13/21 条本来就写「**镜像预拉**先于部署」「**预构建**镜像（P2 拉好 `platform-core-dbt:local` 等）」
   ——但 P2 那张表的 `docker pull` 清单里**只有上游镜像**（pgduckdb/metabase/postgres/python:3.12-slim），
   `platform-core-*-:local` 不在其中。

⇒ **`platform-core-*-:local` 不是部署通路产出的**（镜像名无 registry 前缀 ⇒ 只有两条可能：
本机手工构建，或 `docker save`/`load` 送入；**下节取证把答案定为前者**）。

**那 Dockerfile 为什么仍该在清单里？**——改归**判据 ②/③「被投递文件引用的路径」**：
**`deploy/data-compose.yml` 本身在清单里、会被投递**，而它拿 `deploy/dbt/Dockerfile`（与 duckle 那份）
当 `build.dockerfile` ⇒ 只要有人在机器上跑 `docker compose --profile etl build`，读的就是检出那份。
**留表 = 让那条万一的路径读到当前版**（代价一个文件、无副作用），也让 `#688` 查出的**真实漂移**
（机器那份冻结在 `#166`）被 sync 抹平。

**单元 A 与单元 B 仍是两种路径**（这条没被推翻，是上面推翻的**只是**「B = 本机构建」的归因）：

| 部署单元 | openship 部署时 | Dockerfile 要不要进**本**清单 |
|---|---|---|
| **A**（`deploy/docker-compose.yml`，山海平台） | **会构建**（日志：`Building compose service "server" from build context . using deploy/Dockerfile.server`）⇒ 上下文由部署送上去，读的是**部署传的那份** | **不要** |
| **B**（`deploy/data-compose.yml`，数据面） | **跳过构建** ⇒ 镜像来自别处；但 compose 文件本身**被投递**且**引用** Dockerfile | **要**（归判据 ②/③，见上） |

**✅ 已查明（2026-10-16，`#694` 取证；全部一手）**：两个 `:local` 镜像**都是在数据面机上手工构建的**，
不经 registry、也没有任何自动化承载。

1. **无 registry**：数据面机**没有任何 registry 容器**；镜像名又不带 registry 前缀 ⇒ 排除 push/pull 送件；
2. **duckle 那次 = `docker compose build`**：镜像带 compose 章（`com.docker.compose.project=platform-core-data`、
   `service=duckle`、compose `5.5.0`）；且 `docker history` 与检出里 `deploy/duckle/Dockerfile` **逐步吻合**
   （pip 源 tsinghua、`COPY deploy/duckle/entrypoint.sh`、`chmod 0755`、`WORKDIR /workspace`）——
   构建上下文 = **仓根** ⇒ 那次就是拿**检出那份**建的；
3. **dbt 那次 = 裸 `docker build`**：镜像**无任何标签**（compose 建的会盖章；没有 ⇒ 不是 compose）；
4. **两次都不在任何 job 里**：该机 job 无一涉及；openship 部署 23/23 恒 `skipping build phase`。

**⚠️ 但那次构建不可复现**（这才是本节的实质缺口）：`platform-core-dbt:local` 建于 **09-23 22:26**，
而它 history 里的 `DBT_VERSION=1.9.1` + aliyun pip 源是 **09-24 才进仓**（`#187`/`#194`）⇒ 当时是拿
**工作副本**（当天 PyPI 实测后未提交的编辑）建的，**git 里没有与之对应的版本**。想复现同一镜像 ⇒ 无据可依。

**重建口径（候选做法，⚠️ 尚未实操验证——按「无案例不立标准」只登记不标定）**：在数据面机、检出根下
`docker compose -f deploy/data-compose.yml build duckle dbt`（compose 会打上项目名标签，属装饰性，不影响
`image:` 名）；随后**必须重建用到它们的容器**（`duckle` / `lemeng-console-3120|64188` / `dbt`）——镜像是
容器**创建时**钉死的，不重建则仍跑旧镜像。**重建前先核消费方**：`deploy/dbt/Dockerfile` 的
`ARG DBT_VERSION` 要与 `dbt/profiles.yml` 等使用方一致。

<details><summary>第一版定案（`#692`，已被推翻，留可追溯性）</summary>

**✅ 定案（2026-10-15）：Dockerfile **必须**进清单——数据面机的镜像就是拿**检出里那份**构建的。**

原「待核实」问的是「`deploy/duckle/Dockerfile` 在清单里是冗余投递，还是有人在部署通路之外跑构建」。
答案是**后者**，三条实证：

1. **部署通路不构建**：openship 部署数据面项目（`proj_AFbJvyb0onaX7LVr`）的构建步骤日志原文 =
   `Compose services use pre-built images - skipping build phase` ⇒ 它只 pull/run 现成镜像，
   `platform-core-*-:local` 得**先在机器上建好**（层 C 第 13 条「镜像预拉先于部署」正是这个）；
2. **构建读的是检出**：`platform-core-duckle:local` 创建于 `2026-09-28 00:42:31`，而检出里
   `deploy/duckle/Dockerfile` 的 mtime 是 `2026-09-28 00:41`——**相差 1 分钟**（本机手工构建）；
3. **对照自证**：`deploy/duckle/Dockerfile` 在清单里 ⇒ 检出那份与仓内**逐字节一致**（`8679ed09…`）。

> ⚠️ 第 2 条是**相关性当因果**的典型误读：duckle 那份在清单里 ⇒ 它与仓内恒等，**镜像与它一致
> 是必然的**（与「在哪构建」无关），根本不构成证据。真正的反证在第 2 条 dbt：**不在清单**的那份
> 对不上镜像 ⇒ 镜像不来自检出。

**分水岭：单元 A 与单元 B 的构建路径不同**——

| 部署单元 | 谁构建 | Dockerfile 要不要进本清单 |
|---|---|---|
| **A**（`deploy/docker-compose.yml`，山海平台） | **openship 部署时构建**（日志：`Building compose service "server" from build context . using deploy/Dockerfile.server`）⇒ 上下文由部署送上去 | **不要** |
| **B**（`deploy/data-compose.yml`，数据面） | **机器本机手工构建**（见上三条）⇒ 读的就是检出那份 | **要，一个都不能漏** |

⇒ 所以 `deploy/Dockerfile.server` / `deploy/Dockerfile.openclaw`（单元 A）不进表是**对的**；
而单元 B 用到的 Dockerfile 漏一个就是「机器拿冻结的旧版构建」。**实例（#688）**：
`deploy/dbt/Dockerfile` 曾漏——机器那份冻结在 `#166`（2026-09-22 初版），
**缺 #187 的 dbt 版本钉与 #194 的 pip 国内镜像**，而 `platform-core-dbt:local` 就是拿它建的；
2026-10-15 已补登（`a3fc0976…`）。

</details>

<details><summary>原文（保留以留可追溯性）</summary>

判据 ③ 只取它们的 **COPY 来源**（= `deploy/duckle/entrypoint.sh`，已在表内），Dockerfile 本身**不在
消费面**，两条依据：① 它们只在**镜像构建期**被读，而构建走 openship 部署通路（部署会把构建上下文
送上去），不经本投递程序；② 实测佐证——S1 的 24 窗口全量跑 + probe 均通过，而这两个文件**从未投递过**。
⇒ 反过来，**若哪天把构建搬到数据面机上本机跑**，这条就不成立，届时要连 Dockerfile 一起登记。

</details>


**机器本地物（不在仓里，投递永不触及）**：`deploy/.env`（运行时写，mode 600）、`dbt/profiles.yml`、
`dbt/target/`、`dbt/logs/`、`dbt/.user.yml`。这是「就地同步」相对「整目录换版」的关键优势：投递只按
**仓里那份**的清单下行，机器上的本地状态原地保留。

### E.3 投递程序：清单 + 就地核验同步 + 版本标记

**① 清单** `deploy/data-plane-manifest.txt`（人维护，改消费面才动）。三列，`#` 注释、空行忽略：

```
# 仓内路径(文件或目录)                落地路径                              模式
deploy/data-compose.yml               ${REPO}/deploy/data-compose.yml      0644
deploy/duckle/entrypoint.sh           ${REPO}/deploy/duckle/entrypoint.sh  0644
duckle/                               ${REPO}/duckle/                      0644
dbt/                                  ${REPO}/dbt/                         0644
scripts/lemeng/wire-warehouse.sh      /opt/lemeng-wire-warehouse.sh        0755
scripts/lemeng/readback-helper.sh     ${REPO}/lemeng-readback.sh           0755
```

`${REPO}` = 检出根。**目录条目 = 递归**（生成侧按 `git ls-files` 展开成**受版本控制 + 未被 .gitignore
忽略**的文件清单），⇒ 仓内新增文件自动被覆盖，**清单不必跟着改**。

> **为什么是 `git ls-files`（索引 + 未跟踪未忽略）而不是 `git ls-tree -r <commit>`**：生成器锁的是
> **工作区**，不是某个 commit。用法是「改动清单覆盖的任一文件 → 重跑生成器 → 提交」；若内容取自
> `<commit>:<path>`，改完文件后重跑取到的仍是**旧内容** ⇒ 守卫恒红、这条路永远追不上工作区，于是
> 那个 `[全SHA]` 参数**没有存在意义**——所以**不带**（位置参数是 `rootDir`，仅供单测的夹具用）。
> 顺带这也把 `dbt/target/`、`dbt/logs/` 这类**本地产物**挡在门外：它们在 `.gitignore` 里，而它们
> 正是机器上的本地状态，绝不能被登记。

**② lock** `deploy/data-plane.lock`（派生，随 PR 提交）。首行是**其余部分**的 sha256（自校验）：

```
sha256-of-rest <全表 sha256>
<文件 sha256> <仓内路径> <落地路径> <模式>
...
```

生成：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（**锁工作区**，不带 SHA —— 见 ① 的注）。
**⚠️ 有意的摩擦**：改动清单覆盖的**任一文件**后必须重跑上面这条，否则 `gates` 红（守卫会直接给出该命令）。
守卫 = `scripts/check-data-plane-lock.mjs`（CI 的 `gates` job 里跑），三条判据见该文件头注。

**③ 同步**（在**机器上**跑，POSIX sh —— 该机无 node）：

```
sh /opt/lemeng-sync.sh <全SHA>             # 同步
sh /opt/lemeng-sync.sh <全SHA> --check     # 只比不写
sh /opt/lemeng-sync.sh <全SHA> --prune     # 同步 + 清点删除检出孤儿（**常规链路用这条**）
```

五步：**取 lock**（按全 SHA 经 smart-proxy **公网 EIP** `113.250.177.229:4878`；控制面内网
`10.0.0.8:4878` 被云安全组拦、**直连不通**，实测 code=000）→ **验 lock 自校验** → **逐条取件**
（同目录临时文件 → sha256 断言 → 补模式 → 原子 `mv -f`；跨目录 rename 不原子）→ **最后**写
`<checkout>/.data-plane-revision` → **清点/清理**（#683：枚举检出树 vs lock 落地路径集，机器本地
物 allowlist 豁免。默认报 `EXTRA`；`--prune` 删孤儿——**仓内删除的文件由此自动从检出退场**）。

**清点作用域 = 清单里「目录型条目」的落地子树**（`duckle/`、`dbt/`、`contracts/`、
`deploy/duckle/console/`；写死脚本内那行 `PRUNE_ROOTS`）。**不收窄不行**：数据面机的检出按设计就是
「整仓 tarball 引导 + 清单覆盖」⇒ 真机 `--check` 实测全检出作用域报 **394** 个多余件，其中只有
**10 个**是本节要治的孤儿（旧名退役后永生、被 dbt 当僵尸 seed 加载），另 **384 个是引导残留**
（`modules/`170 `apps/`75 `docs/`45 …）——全树判死就是拿 384 个设计外文件赌命。作用域外的件
（含检出根文件）**只计数不删**，打 `# outside-scope M` 信息行；它与 `PRUNE_ROOTS` 的一致性由
`scripts/check-prune-roots.mjs` 在 CI 机械比对（**别只改一处**）。已知边界：作用域外的孤儿不被清
（有意）——某个**文件型**条目退役时其旧件不在任何子树里；落在检出**根**的崩溃残留
`..data-plane-revision.tmp.*`（标记本体的临时件）同理，`# outside-scope` 跳变即是可见信号。

**版本标记语义**：**标记在 = 这套文件是全的**。单文件 `mv` 是原子的，但**整套不是**——中途失败会停在
半应用状态，靠「标记缺失 / 与 `--check` 不符」把它显性化，而不是静默。

**输出契约**：每文件一行 `<状态> <落地路径> <期望 sha256> <实际 sha256>`（状态 `OK`/`DRIFT`）；
末尾 `SYNC_OK <n>/<n>` 或 `SYNC_DRIFT <n> mismatched`。失败字面量：`LOCK_FETCH_FAILED:` /
`LOCK_SELFTEST_FAILED:` / `FETCH_FAILED: <path>` / `REVISION_WRITE_FAILED:`。取件失败**重试至多
10 次**（E.4 ② 的跨境断流是间歇的 ⇒ 重试有意义；E.4 ① 的元数据说谎是确定性的 ⇒ 重试无用）。

清点输出（#683，三态都有）：孤儿逐行 `EXTRA <绝对路径>`（报告态）；`--prune` 态删掉的打
`PRUNED <绝对路径>`、删失败打 `PRUNE_FAILED: <路径>`（非零退出）；摘要行 `# extra N`（N =
**作用域内**清点/清理**后**残余孤儿数）打在 `SYNC_OK`/`SYNC_DRIFT` 之前，紧邻一行
`# outside-scope M`（M = 作用域外多余件数，**纯信息行**、不进 N、不影响退出码）。
`--check` 的退出码仍只看 DRIFT。

**#683 首跑实录（2026-10-15，真机两步门）**——治本上线的验收序列与判据，照此复核：

1. **更新 `/opt/lemeng-sync.sh`**：该件**不在清单里**（自举依赖，清单不能含同步器自己）⇒ 它的更新是
   **手工**的（E.5 ①：取件 → sha256 断言 → **同目录**临时文件 → 原子 `mv -f` → 补模式）。**三连
   sha256 逐字节相等**（仓内 = 取件 = 落地 = `933d7764a3decf339d3a2b665fb6ae5ecd59932b9a108378a82c8648386e1189`），
   大小 19626、模式 0755。
2. **`--check` 核对门**（**过了才许 prune**）：`# extra 10`（= 本节要治的孤儿：`deploy/duckle/console/`
   7 件 + `duckle/common/` 3 件）+ `# outside-scope 384`（引导残留，只计数）+ `SYNC_DRIFT 2 mismatched`
   （两件内容漂移，与孤儿无关；下条 `--prune` 的**完整同步**把它们一并重取回来）。
   ⚠️ **设计稿与评审预览写的「预期 `# extra 0`」是笔误**：394 = **10**（作用域内孤儿）+ **384**（作用域外
   引导残留），`# extra 0` 是 **prune 之后**的判据（下条），**不是** prune 之前。收窄**只**把 384 挡在
   门外，10 个孤儿仍在——它们正是 prune 要删的东西。全检出作用域那版实测是 `# extra 394`（无
   `# outside-scope` 行），可见「收窄」这一步的效果就是把 394 拆成 10 + 384。
3. **`--prune` 首跑**：rc 0，恰好 **10** 行 `PRUNED`（清单见下），复核 `# extra 0` +
   `# outside-scope 384`（作用域外计数**不因 prune 而变**）+ `SYNC_OK 160/160`。
4. **收敛复核**：再跑一次 `--check` = rc 0 / 160 `OK` / **0 DRIFT** / **0 EXTRA** / `# extra 0` /
   `# outside-scope 384` / `SYNC_OK 160/160`。落在检出**根**的 `..data-plane-revision.tmp.*` 残留
   glob 实测为空（已知边界，本就没残留）。
5. **dbt 判据（僵尸 seed 真的退场）**：materialize 全量 `dbt build` 报 `Found 23 models, 157 data tests,
   3 seeds, 14 sources, 436 macros`，末尾 `PASS=183 WARN=0 ERROR=0 SKIP=0 TOTAL=183` + `MATERIALIZE_OK`；
   三个 seed = `x01_branch_calendar`(0 行) / `x01_region_names`(27 行) / `x08_thresholds`(0 行)——
   （**2026-10-18 注**：该次跑数如实保留；`x01_region_names` 已改名 **`dim_region`** 并升格为维，见 #883）
   **`x01_branch_region` 不在其中**（它正是被 prune 掉的退役 seed，此前被当僵尸 seed 天天加载）。

首跑删掉的 10 个孤儿（`PRUNED` 逐行，2026-10-15，target `5ee6d5535c6be70ef2c405a6baf88a511af075ab`；
路径相对检出根 `/opt/platform-core-data/platform-core`）：

```
deploy/duckle/console/alerts.json
deploy/duckle/console/owners.json
deploy/duckle/console/pipelines/lemeng.dim.branch.run.json
deploy/duckle/console/pipelines/lemeng.dim.item.run.json
deploy/duckle/console/pipelines/lemeng.retail.close.run.json
deploy/duckle/console/pipelines/lemeng.retail.tick.run.json
deploy/duckle/console/pipelines/lemeng.retail.windows.run.json
duckle/common/lemeng.branch.json
duckle/common/lemeng.item.json
duckle/common/lemeng.retail_order_line.json
```

> ⚠️ **同名不同物，别把 prune 读成没退干净**：上面退场的 `deploy/duckle/console/alerts.json` /
> `owners.json` 是**检出里**的**声明文件**（仓内已改名成 `alerts.lemeng.json` / `owners.lemeng.json`，
> 旧名的副本由此被 prune 清掉）。console **卷**（`...-lemeng-console-<账套>-ws`）里的
> `/workspace/alerts.json` 与 `/workspace/owners.json` 是**另一侧的名字**——`seed-console.sh` 明写
> 「检出 `alerts.lemeng.json` → 卷 `/workspace/alerts.json`」（`owners` 同理，均在 `only=all` 分支）
> ⇒ **改名只发生在检出侧**，卷侧一直用短名，那份同名件正是**当前期望的落地名**、不是旧名遗留。
> 两者同名、不同物、不同落点。卷内件由 `seed-console.sh` 播种（#531），**与本节 prune 无关**；
> 判「检出退干净没」只看检出树（`--check` 的 `# extra`）。卷内件的 mtime 只是**上次播种**的时刻，
> 不表示陈旧（`schedules.json` 另会被引擎回写，见 `seed-console.sh` 头注）。

**全 SHA 从命令输出逐字复制，绝不手工补**（分支名会漂移，投递物必须与 commit 逐字节对应）。

### E.4 为什么 sha256 断言是必须的（不是「保险起见」）

**这条链路上有两种「静默坏数据」，都会以 `rc=0` 的 `HTTP 200` 出现、客户端都看不出异常** ——
而**逐文件 sha256 断言是唯一能拦住它们的东西**。

#### ① Range 元数据说谎：上游把 Range 套在「压缩表示」上（2026-09-26 定案）

上游（`raw.githubusercontent.com` / `cdn.jsdelivr.net`，经 `proxy.hookflow.top`）对**可压缩内容**
把 Range 作用在对象的 **gzip 压缩表示**上：`content-range` 的分母是**压缩后长度**，返回体却是
解压后的切片 ⇒ **元数据与内容自相矛盾**。

| 文件 | 真实大小 | `gzip -6`（同 commit） | 上游自称总长 |
|---|---|---|---|
| `duckle/common/lemeng.item.json` | 1,436,947 | **22,733** | **22,733** |
| `pnpm-lock.yaml` | 190,672 | **57,258** | **57,258** |
| `CHANGELOG.md` | 80,046 | **34,354** | **34,354** |

> 注：`duckle/common/lemeng.item.json` 已于 **#683 退役**（**不在当前检出里**）。复算要用它
> **当时的 commit SHA**（`git cat-file blob <SHA>:<path>`），仓史里那份仍在——别去当前检出里找它。

三个对象**逐字节完全吻合** ⇒ 那串「自称总长」**就是该对象在该 commit 上的 gzip 长度**。
复算方法：`git cat-file blob <SHA>:<path> | gzip -6 -c | wc -c`。
配套行为：`Range: bytes=0-1023` 回 **4,826 字节**（不是 1,024）、`Range: bytes=0-99` 回 **0 字节**、
超出自称总长的区间回 **416**。

**代理据这个错数声明 `content-length`** ⇒ 客户端收到的字节数被截到该值。**早期记的「79 KB 文件
只拿到 34,354 B」「190 KB 只拿到 57,258 B」就是这一条** —— 不是「随体积恶化」，也**不是**间歇。

**已实测排除的解释（别再照抄）**：

- **不是 CF 边缘缓存**：每个响应 `cf-cache-status: DYNAMIC`；换缓存键重取复现同样的数；
- **不是代理 / Worker**：从 Worker 内部回显上游响应，看到的是上游自己回的
  `content-range: bytes 0-1023/22733`，带 `via: 1.1 varnish` / `x-cache: HIT` / `x-served-by: cache-rtm-…`；
- **改上游请求头无效**：`identity` / 不发 `accept-encoding` / `*` / `Cache-Control: no-transform`
  四种**结果完全相同** ⇒ 编码由 Cloudflare 决定，Worker 干预不了；
- **完整 GET（不带 Range）始终正确**（sha256 = 真值）—— 这就是可用的杠杆。

#### ② 跨境链路把流掐断（与 ① 无关的另一个故障）

纯流式 GET 会被中途掐断，**间歇**且与体积相关：数据面机**直连** `cdn.jsdelivr.net` 取同一份
1.44 MB 工件，三轮里一轮完整、一轮断在 **699,875 B**。这是链路层，不是 CDN 的元数据问题 ——
它才是「间歇、随体积恶化」那条旧记录的**真正**来源。

#### 现行口径（2026-09-26 起）

- **别把 ① 当间歇问题重试**：它确定性复现，重试无用（② 该重试，`MAX_TRIES` 保留）；
- **不要**去 purge Cloudflare 缓存（`DYNAMIC`，没有可清的东西）；**不要**在 Worker 里加 `no-store`
  （对 `DYNAMIC` 无效）；
- **不要**在 Worker 里做「取全量再切片」的接管：实测可行，但会让声明 ≤16MB 的对象**每次拉两遍**
  （一次探测就拉满整个对象）、并在 Worker 侧缓冲最多 16MB ⇒ **流量翻倍 + OOM 面**，判定「起瓢」；
- **不要为了绕过它换投递通道**（换 CDN）：两个 CDN 是同一类问题，换了不解决；
- **修法**：改**代理**（`openship-platform/scripts/smart-proxy/smart-proxy.mjs`）两行 ——
  `useChunks` 去掉 `|| mitm`、单请求路径的 `content-length` 只采信上游响应的值。
  **已落地（2026-09-26）**：PR `openship-platform#16`（base `docs/manual-skeleton-local`）合并为 `62d31c3`，
  生产代理已换镜像 `e7b3011fd32c`；回滚点 = 镜像 tag `smart-proxy:pre-range-fix-20260926`
  + 源码 `smart-proxy.mjs.bak-20260926`。**Worker 无需改动**（生产本就放行两个来源）。
  部署案例与调用序列见 `openship-platform#17`。跟踪：**`MYTech-Co-LTD/openship-platform#15`**。
- **代理的构建/运维陷阱**（本次实地踩到，写下来省下一次）：
  `docker compose build smart-proxy` 是**空操作**且 `rc=0`（该服务只有 `image:` 没有 `build:` 段）
  ⇒ 必须手工 `docker build -t <tag> /opt/smart-proxy`；
  `docker compose config` 会把 env **明文**打出来（含对象存储 AK/SK）⇒ 看配置只取键名；
  现有的缓存清理工具是**清空整桶**，缺「按 key 精准失效」⇒ 别拿它当精准删除用。

### E.5 自举：同步程序自己怎么上去（循环依赖，明写）

`/opt/lemeng-sync.sh` **不在清单里**——它若在，就得先有它才能投它（循环）。它的更新仍是**手工**：
按 E.3 ③ 的落地法做一次（取件 / sha256 断言 / **同目录**临时文件 / 原子 `mv -f` / 补模式），并留档
**三连 sha256**（仓内 / 取件 / 落地）+ 大小 + 模式。首次落它见 issue #199 的真机步骤。

⇒ 结论：**它是这套机制里唯一需要手工的环节**，所以它的逻辑改动要**尽量少**——能靠清单/lock 表达
的差异，都不要写进脚本。

（#683 注：此原则约束的是**每投递差异**——会变的内容归清单/lock，不写进脚本；清点/`--prune`
与其 allowlist 是**架构事实**（机器本地物清单，见 manifest 头注），不在约束范围。）

### E.6 为什么不是 `releases/<全SHA>/` + `current` 软链（本次裁决留档）

**更「正确」的方案是有的**：每次同步解到 `releases/<全SHA>/`，再把 `current` 软链一指——真·整套原子、
回滚瞬时。**本次不取**，三条理由：

1. **机器上有 5 处目录内本地状态**（E.2 末那张表）——整目录换版会把它们连同目录一起换掉/打断。
   要保留就得先把它们搬进独立卷，那是**另一个变更**。
2. **软链方案要改 `deploy/data-compose.yml` 的两处 bind**（源从 `<checkout>/dbt` 改成
   `current/dbt`）⇒ 属**改架构**，须走「先经人同意 → 更新架构文档 → 再写代码」的顺序。
3. **本机没有「docker 跟随软链 bind 源」的实测案例**。按根本法则「无案例不立标准」，**不立**。

⇒ **R1a 的触发条件**（满足其一即重议，届时按第 2 条的架构顺序走）：① 「整套半应用」**成为实际故障**
（不是理论风险）；② 清单条目增长到**手改清单不可行**（E.3 的摩擦从「有意的」变成「受不了的」）。

### E.7 时间解释：openship cron 按 **UTC**（影响每一个后续注册的 job）

**平台事实**：openship job 的 cron 表达式按 **UTC** 解释，**不是**服务器本地时区（数据面机系统 TZ
实测为 `Asia/Shanghai`）。**证据** = 既有 job `audit:retention-prune` 的 `17 3 * * *`，逐日 `startedAt`
都是 `03:17:00Z`（= 11:17 CST）；本采集 job 的 `30 2 * * *` ⇒ **10:30 CST** 开火（= 02:30 UTC）。
⇒ **凡「按世界时推营业日」的脚本都会错**，且错法是**区间性**的：只有 `16:00–24:00Z` 这段，UTC 日历日
与上海日历日才不同解，其余时段同解 ⇒ **错得很隐蔽**。
⇒ 营业日一律在**脚本里显式钉 `Asia/Shanghai`** 推（不继承系统 TZ、更不按 UTC 推）——
`run-retail-day.sh` 的 `BIZDAY` 就是这么钉的（钉死后对 cron 语义不敏感）；反过来，
**任何依赖 `date` 默认 TZ 的写法都不要接**。

---

## F 调度（「何时跑」归谁）—— 2026-09-26 起改由 duckle 自带调度器承担

> **决策与依据**：`openship-platform` 仓 **ADR-0014**（含实证与两条已完成的实施前验证）。
> **实现细节（为什么这么设计、每条实测事实）**：`deploy/duckle/console/README.md` —— 本文**不复制**，
> 只写运维视角要看的东西。
> **归口口径（「什么时候该归 console、什么时候归 job」）**：`docs/data-platform-handbook.md` §1.1.4 —— 本文只讲怎么运维。

### F.1 现状：谁在跑、跑在哪

| | |
|---|---|
| **执行器** | duckle 自带调度器（`duckle-runner serve` 的 tick 循环），**不再**走 openship job |
| **宿主** | `deploy/data-compose.yml` 里两个**常驻**服务 `lemeng-console-3120` / `lemeng-console-64188` |
| **端口** | **只绑回环**（`127.0.0.1:18080` / `:18081`）—— 调度靠进程内 tick，不需要对外开端口 |
| **定义** | 仓内 `deploy/duckle/console/{pipelines,schedules}/` → **seed 进各账套的 workspace 卷** |
| **凭据** | project env（每账套一份；`LEMENG_TOKEN` 与 `LEMENG_TOKEN_64188` 不同 ⇒ 一账套一 workspace 的理由） |

**一账套一个 console**：调度条目**带不了自己的 env**（实测：塞 `env/args/params` 会被静默丢弃）⇒
一个 console 只有一套凭据 ⇒ 共用必然有一个拿到错 token，**且会静默采错数据**（不是报错）。

**卷内文件集的语义 = 能力供给（#531 裁决）**：seed 期望集 = **共享族（无账套数字后缀）+ 本账套后缀族**
——本账套排班可能引用的一切都该在，不该跑的不必在。**孤儿判定随之机械化**：卷内文件只有
「**他账套后缀**」（`.<别的账套>.json`）才可删；无后缀共享件属于每卷，删了就是真漂移（`--check` 会抓）。
「排班引用了他账套管线」（§F.1 危害形态的源头）由 CI 门禁 `scripts/check-console-schedules.mjs` 在合入前拦。
管线文件本体是账套无关的（账套量全走所在 console 的 env、凭据走 `connectionRef`）——文件名后缀只是
「为哪个账套生成」的命名痕迹，隔离靠排班与凭据，不靠文件集。

### F.2 改了定义之后怎么让它生效

**先分清改的是哪一类——三类的最小动作不一样**（2026-09-26 实测定分）：

| 改了什么 | 最小动作 | 为什么 |
|---|---|---|
| **`schedules/` 或 `pipelines/` 的定义**（本节日常改动） | **seed + 重启容器** | 定义 seed 进的是**命名卷** `/workspace`（`<project>-lemeng-console-<账套>-ws`）——**不是 bind-mount** ⇒ 卷内容·重启即重新读取。**不必定向部署。**（同类还有 `alerts.json`/`owners.json`。**本节即统一口径**，handbook §1.3.2 已于 2026-09-29 按此订正为「按类分」；2026-09-29 两账套投递再次实测：只用服务级 `…/restart`，新调度立刻生效。） |
| **bind-mount 进来的文件**：仓内 `duckle/`（挂 `/pipelines:ro`） | seed/同步 + **重建容器**（**用 `serviceIds` 定向部署**） | **bind-mount 钉的是 inode**，原子替换（同步程序就是这么做的）后运行中的容器**仍看到旧文件** ⇒ 只有重建才换。<br>⚠️ **重建就用 `serviceIds`，别单传 `refreshServiceIds`**——后者名字很像「只重建点名的那个」，但 **2026-09-26 实测：单传它触发了全量重建**，把 `pg_duckdb` 与 `metabase-db` 一并重启（正是本表第三类要避免的）。那次靠卷持久化**数据无损**（实测物化表逐字不变、5 服务全 healthy、outage 0）——但**别把「没出事」读成「这个参数没问题」**。<br>**自证**：重建后**进容器**比对（`$CONTAINER 内` 的 sha256 ≠ 宿主上的 sha256 ⇒ 仍是旧 inode）。 |
| **新增/改服务**（compose 服务集变了） | `post_projects_by_id_services_sync` → 按 `serviceIds` **定向部署** | 只重建点名的那几个；**别全量部署** —— 会重启 `pg_duckdb`。 |

**第 1 类怎么自证它真读到了**（别只看「文件写进去了」——那不等于 console 读了）：带凭据打 console 自己的调度 API，看**已加载**的条目：

```sh
curl -s -H "Authorization: Bearer $DUCKLE_TOKEN" http://127.0.0.1:<port>/api/schedules
```

它返回**以 `pipeline_id` 为键的字典**（不是数组）；条目数与 seed 的一致即算生效。
⚠️ 该端点**只回定义、不回运行状态**——形状与用途见 `deploy/duckle/console/README.md`。

> **2026-09-26 实测**：零售薄管线 + 第三条排班 seed 进卷后**只重启**（未定向部署），
> `/api/schedules` 即列出三条，且 console 对新条目**补上了 `misfire` / `catchup` 默认值**
> ——那是「它真的解析过该条目」的证据。

### F.3 排班与时区

容器 **TZ = UTC**（实测）⇒ **排班按 UTC 写**（与 openship cron 同口径）。当前：门店维 `0 2 * * *`、
商品维 `0 11 * * *`（= 北京 10:00 / 19:00）。
⚠️ **快照日由 wrapper 显式钉 `Asia/Shanghai` 推**（同 §E.7 的道理）：引擎的 `current_date` 是
**会话时区的今天**，在 UTC 容器里夜间跑会算成**前一天**并写进**前一天的分区**，且**不报错**。

### F.4 失败怎么看、排障从哪进

| 现象 | 先看哪 |
|---|---|
| 排班没触发 / console 本身有问题 | **经 openship MCP** 读该 console 服务的日志（数据面 project → 服务 → 日志端点）——正常应是四行：console on / workspace / DuckDB / **sign-in required**。⚠️ **别裸 SSH 上机敲 `docker logs`**（根本法则·唯一通道） |
| 跑了但失败 | **按形态分**（2026-09-29 收口：薄壳已退役）：<br>· **L0/L1（现行）**：`runs/receipts/run-*.json`（**回执**，逐节点 status/rows/耗时）＋ `runs/<pipeline_id>.json`（**运行记录**，终态 + **写了哪些资产**——`assets` **只在这里**，回执对任何管线都不带）；<br>· **薄壳（仅历史形态）**：卷里 `logs/dim-*-run.csv`（含 wrapper 完整 stdout） |
| 自证没过 | 输出里的 `ASSERT_FAIL: …` / `DIM_FAILED` —— **拒写湖是正确行为**（#205），不是故障 |

⚠️ **`/api/schedules` 的 GET 不回运行状态**（文件里已有、GET 恒 `null`）⇒ **别信那个 GET**。

**告警（两条并存；🔴 2026-09-29 收口）**：① **引擎原生 `alerts.json`** = **L0/L1 的告警面**（打进本 console 的**任何非 ok run**，**无门槛**，经 OO 转投）；② wrapper 的 `EXIT` trap = **仅薄壳形态适用**（已退役）——仅当 `LEMENG_NOTIFY=1` 发企微（**薄管线会设** ⇒ 人工/诊断跑不刷群）；缺 `WECOM_WEBHOOK_URL` 时打 `NOTIFY_SKIPPED`（不静默）；**告警绝不改退出码**。
⚠️ 已知未通项：`OPS_SINK=DISABLED reason=no_ingest_env` ⇒ 观测投递没接（见 open issue **#210**）。

### F.5 尚未迁移 + 回滚

- **零售 job（`lemeng-retail-3120-runner`）仍在 openship job 上** ✓ 本次**未动**它；
  迁移需单独决定与观察（它是正在跑的生产链路）。
- **回滚**：停掉两个 console 服务（或对不需要它的项目设 `enabled:false`）⇒ 即回到「没有调度」；
  零售链路**全程未动** ⇒ 无需恢复。

### F.6 物化 job（dbt）——「非 duckle runner ⇒ openship job」那条口径的实例

**job**：`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`），cron **`27 3 * * *` UTC**
（2026-10-06 由 `20 3` 错峰：与 tick `*/5` 同分钟点火天天撞 ETag，#452 E1 定案；retry 配置未变），
`retry 2×/300s`、`timeoutMs 30min`、**仅 `failed` 时告警**（企微渠道）。跑在数据面机（`8281d598`）。

**⚠️ 调 dbt 的正确口径与「计划里写的那条」不同——两者都要知道**：

| | 口径 |
|---|---|
| **计划/本 SOP 早先写的** | `docker compose -f deploy/data-compose.yml --profile etl run --rm dbt build …` |
| **实际可用的（2026-09-26 实测）** | `docker run --rm --network openship-platform-core-shanhai-data -v <检出>/dbt:/usr/app … platform-core-dbt:local build … --profiles-dir /usr/app` |

**为什么 compose 那条不通**（两条独立原因，都得知道）：
1. **网络**：openship 用**自己的项目名/网络**部署（`openship-platform-core-shanhai-data`），
   而 compose 顶层 `name:` 是 `platform-core-data` ⇒ `compose run` 会去 `platform-core-data_default` 网
   （实测该网**空的**）⇒ **解析不到 `pg_duckdb`**；
2. **没有 `deploy/.env`**：该机的 env 真值在 **openship project env**，机器上没有 `.env` 文件 ⇒
   compose 插值拿不到值。

**必须注入的 env 键（少一个就响亮失败，别只传 `DBT_*`）**：

- `DBT_HOST=pg_duckdb` / `DBT_USER` / `DBT_PASSWORD` / `DBT_DBNAME`（连接）
- **`LEMENG_ZOS_BUCKET` / `LEMENG_ZOS_ENDPOINT` / `LEMENG_ZOS_REGION`**（**模型拼 S3 路径用**）
  —— 由 `dbt_project.yml` 的 `vars.zos_*` 经 `env_var()` 取。**缺了会拼成 `s3:///…`**；
  项目里**刻意给空串默认** ⇒ **运行期响亮失败**（`IO Error: URL needs to contain a bucket name`），
  **不会静默读到别的东西**——这是设计对的地方，别把空串默认「修」成别的值。
- 凭据**不落 job 配置、不落 argv**：`materialize.sh` 在运行时从运行中的容器 `docker inspect` 取进变量，
  再用 `docker run -e VAR`（**透传形态**，只带键名）传给容器 ⇒ 值不进 `ps`。
  **键集由脚本的 `mat_env_args()` 唯一定义**，CI（`materialize.test.sh`）钉住「8 键、只透传键名」
  ——改键 = 改脚本走 PR。守卫比旧 job 命令多 UN/DB/ZR/ZE 四项（缺了要等 dbt 连库才炸，晚失败难定位）。
  **AK/SK 不注入**：模型不建 S3 secret，pg_duckdb 的持久 secret 直读湖——多注入反而可能覆盖持久 secret。

**执行集 = 全量 `dbt build`（#679 定案，2026-10-15 用户裁决）**：命令真身已抽成
`scripts/lemeng/materialize.sh` 进仓 + 进投递清单（落地 `/opt/lemeng-materialize.sh`，
job 只调 `sh /opt/lemeng-materialize.sh`），dbt 命令**不带 `--select`**。
依据：仓内 23 模型（`stg_*`×14 + `fct_*`×9）+ 种子×3 = **26 节点，与去名单前的白名单逐一对上**
⇒ 全量执行与旧名单行为逐节点等价，但**新模型自动纳入**——「漏加名单 ⇒ 解析数涨、执行集不变、
run 照绿」的假绿在结构上不可能再发生。（#677 案例 2026-10-15 留档防复发：
`fct_request_fulfillment` 漏加名单，run 报 PASS=178 ERROR=0、执行集与加模型前逐项相同
（22 models / 153 tests）；patch 名单后 PASS=182 = 3 seeds / 23 models / 156 tests。）

**全量态的附产收益**：孤儿 singular 测试 `audit_lemeng__retail__hour_row_count`（无 `ref()`，
旧名单态**被解析但从未执行**——这就是解析 157 / 执行 156 之差的唯一来源）全量态起**每天真跑**。
它红是**真断崖信号**（同小时行数低于 14 天中位数 ×0.5 的量级早警；2026-10-05 真机标定 0 误报；
03:27 UTC 跑 = 昨日最后小时后 ~8.5h，边界风险低），**不是 job 故障**。
将来若真出现「不该日物化」的模型：用该模型的 config 或 `--exclude` 表达，**不要恢复 job 级名单**
——改命令 = 改 `scripts/lemeng/materialize.sh` 走 PR，`materialize.test.sh` 会拦 `--select` 回归。
（旧注「`stg_lemeng_retail_detail` 不在名单」随名单退役一并作废：该模型已仓内退役（2026-10-06），
湖上前缀未下线，状态见正典 §2 旧前缀行。）

**怎么自证**（跑完别只看 job 绿）：
- **全量态不变式**：解析行 == 执行行（`Found 23 models, 157 data tests` vs
  `Finished running 3 seeds, 23 table models, 156 data tests`——157 vs 156 的差 = 上面那条孤儿测试，
  属预期）。
- 在 `pg_duckdb` 里查物化表的行数与**最新日期**，跟湖里的**逐域对**——2026-09-26 实测：
  零售 73,622 行 / max `09-25`（湖同）、门店维 399、商品维 41,870 / 快照 `09-26`，**逐一对上**才算过。
- **物化行数/列形状与本次改动对不上 = 检出台没同步**（§E 的 sync 没跑）——2026-10-12 实测坑。

**投递与首验程序**（#679 落地走了一遍）：merge → §E sync（清单含 materialize.sh，逐件 sha256 断言）
→ **手动先跑一次** `sh /opt/lemeng-materialize.sh`（openship exec），验全量绿 + 不变式 + 行数对上
→ 才把 job `custom:yNWqnvY65iWz1unf` 的命令 patch 成 `sh /opt/lemeng-materialize.sh`
→ 触发 job 验 PASS=TOTAL。此后**换命令 = 改仓走 PR**，openship 侧不再持有任何逻辑。

⚠️ **2026-09-28 订正 —— 这个 job 只做 dbt 模型物化；L1 语义词表是另一件事。**
`scripts/sync-data-semantics.mjs`（`dbt/semantics/l1_metrics.yml` → PG 表 `data.metrics`）是 L1 词表的**唯一**通道。
它可在**平台容器**里直接跑（镜像 COPY 面含 `scripts/`、`dbt/` 与 tsx，**不必另建 node 环境**）：

```sh
docker exec openship-platform-core-shanhai-server pnpm exec tsx scripts/sync-data-semantics.mjs
# --check 是 dry-run（跑前后 data.metrics 行数必须不变）；有漂移 exit 1、用法错 exit 2
```

一条边界（实测过）：

1. **它读的是平台镜像里那份 `dbt/`**，与 §E 投递到**数据面检出**的那份**是两份、没有任何比对机制**
   ⇒ 镜像旧 = 物化出旧口径（2026-09-28 实际发生过，见 issue **#300**）。

**闭环自证（2026-09-28 实测读数）**：物化前 `data.metrics` **0 行** → 跑一次 = 新增 2 / 回读 2 →
**再跑一次 = 未变 2**（幂等）→ `--check` = 无漂移 exit 0。

### F.6b L1 词表物化 job（2026-10-03 注册，销 #297 的「最大缺口」）

**job**：`L1 词表物化（sync-data-semantics，#297）`（`custom:tuQ06mlxBe_2TlTo`），cron **`33 4 * * *` UTC**
（排在 `27 3` 的 dbt 物化之后、避开整点与其他 job），`retry 2×/300s`、`timeoutMs 5min`，**仅 shanhai 机**（`8281d598`——
命令里钉了 shanhai 的容器名，**不许**扩到别的机器，否则会打到错误实例的库）。

**命令形态**（与 §F.6 的 dbt job 同款「容器内直跑」）：

```sh
docker exec -w /app openship-platform-core-shanhai-server node_modules/.bin/tsx scripts/sync-data-semantics.mjs
```

- 用 `node_modules/.bin/tsx` 直调（不裹 `pnpm exec`，少一层进程）；`-w /app` 钉工作目录。
- **首跑已验（2026-10-03 手动触发）**：exit 0 / 425ms /「未变 2；回读 2」——幂等成立。
- **注册前照 README §11.4 的协议核过 `--check` 是真 dry-run**（未变 2 / exit 0）。
- ⚠️ **#300 边界仍然成立**：本 job 物化的是**平台镜像快照**——实例不升级，新声明进不了词表。
  「L1 对账（`--check`）」job **暂不注册**：分叉解决前它近乎恒绿（库内行与快照同源），恒绿探针 = 假保险。
- **#677 再证一次（2026-10-15）**：#678 合并后 shanhai 实例未重新部署，本 job 照跑照绿、
  读的是旧快照（「未变 25」）；部署 8debf57 后重跑才「新增 2」→ 27（再跑「未变 27」，幂等成立）。
  **本 job 绿 ≠ 新声明已进词表——它只绿给镜像里那份 yml 看。**
- 与 `--check` 的 dry-run 契约一样，**每次改 sync 脚本都要重测一次**（T8 的坑：未知 flag 被静默忽略）。

---

## G 提案面（Wave 3）读面的事实来源

提案面（分析师面 / 数据面 MCP）的只读工具**同步读镜像内的文件**，不走 duckle console HTTP。
本节只写「哪条路径可达 / 哪条不可达 / 为什么不可达」，不写推测。

- **可达且已在镜像内**：管线 `deploy/duckle/console/pipelines/*.json`、调度
  `deploy/duckle/console/schedules/*.json`（`COPY deploy`）、契约 `contracts/**`（Wave 3 新增 COPY）。
  缺省根**按模块文件位置解析、与 cwd 无关**（镜像内即 `/app/deploy/duckle/console` 与
  `/app/contracts`；`pnpm --filter @platform/server start` 把 cwd 设在 `apps/server` **不影响**它）；
  `DATA_PIPELINES_ROOT` / `DATA_CONTRACTS_ROOT` 可覆盖缺省。
- **运行记录（#1001 起可达）**：console 的 per-账套 workspace 卷里的 `<workspace>/_data/runs`
  以 **`:ro` bind mount** 挂进 platform-core server（部署期按账套各挂一条），用
  `DATA_RUN_DIRS=<账套>=<挂载目录>,…` 声明。**从不对 console HTTP 取运行记录**——`/api/runs`
  不带唯一 runId、只覆盖已登记管线，且端口只绑回环（跨 compose 项目不可达）。
  未声明的账套 ⇒ 显式 `unknown/runs_source_not_wired`，不是「没跑过」。
- **执行面（#1002）**：`run_pipeline_sandbox` 在**单元 A 的 `sandbox-console`** 里真跑，
  不碰单元 B 的 `lemeng-console-*`（两个 compose 网络互不可达，实测 172.18 / 172.19）。
  决策与全部口径见 `docs/architecture.md` §2.8。接线见下面 §G.1。

### G.1 沙箱执行面（`sandbox-console`）接线与自证

> ✅ **2026-10-23：mytech 已上线且 ①–④ 全部验通**（上线 `dep_KthxaixGDuTyx7LO`，
> 复验部署 `dep_SzQ74TJbw0Cq1stV`）。① 执行面起来（`management console on http://0.0.0.0:18090` /
> `sign-in required`）；② 经**平台代码路径**（`runPipelineSandboxImpl`，在生产 `server` 容器内用
> `tsx` 跑）真跑 `src.csv → snk.csv` ⇒ `status: ok, rows: 3`（产物落 `/workspace/logs/sandbox/`）；
> ③ 共享卷双向通（server 写的草案 console 读到并执行；console 写的产物/回执 server 读到）；
> ④ 负向三连全中（见下表脚本）。**取证方式** = `docker exec` 进 `server`/`sandbox-console` 容器
> （openship MCP 的 exec 端点），不是裸 SSH。
>
> ✅ **2026-10-23 修复后复验（`dep_KaAE5Y25cCpta4mw`，commit `beb6263a`）**：先 `rm -rf`
> 共享卷里的 `sandbox/`（确认没了），再部署 ⇒ 容器起来后 `/workspace/sandbox` **由入口脚本自动建成
> `1000:1000`**，**零手工步骤**；随后经平台代码路径真跑 `src.csv → snk.csv` ⇒
> `status: ok`，`nodes.s1/k1` 各 `rows: 3`，产物与前一轮同形。属主修复与镜像入口的接管逻辑**同时验通**。
>
> ⚠️ **上线当天踩到的坑（先读本条）**：新 compose 服务被 openship **默认 `enabled: true`**，
> 而 mytech 当时没有 `DUCKLE_TOKEN` ⇒ `entrypoint.sh` 对 `serve` 拒起（exit 1）⇒ **crash loop**
> （日志逐条重复「拒绝启动 —— 需要凭据但 token 为空」，退避拉到 60s 一次）。
> **正确顺序 = 先备 token 再让服务出现**；同一份 compose 在**任何尚未备 token 的项目**（含 shanhai）
> 下次部署都会重演，部署前先把该项目的 `DUCKLE_TOKEN` 备好，或把服务行置 `enabled: false`。
>
> ⚠️ **第二个坑：共享卷的属主（不修则②永远跑不通）**。docker 建的命名卷根目录是
> `root:root 0755`，而 `server` 容器是 `USER node`（uid 1000）⇒ 平台侧第一步
> `mkdir -p $DATA_SANDBOX_DIR/sandbox` 就 `Permission denied`（实测；该错误还不是
> `SandboxUnreachableError`，会以裸异常冒到协议壳）。处置已写进镜像入口：`entrypoint.sh` 在
> **以 root 起且给了 `DUCKLE_SHARE_DIR`** 时 `mkdir -p` + 只对该层目录 `chown`（不 `-R`），
> compose 的 `sandbox-console` 服务行给 `DUCKLE_SHARE_DIR=/workspace/sandbox`、
> `DUCKLE_SHARE_UID/GID=1000`（与 `Dockerfile.server` 的 `USER node` 对齐）。
> 手工补丁（排查时用过，**别当常规做法**）：在 console 容器里
> `mkdir -p /workspace/sandbox && chown 1000:1000 /workspace/sandbox`——它是卷上的状态，
> 换卷/换机不复现，正解是上面的入口脚本。
>
> ⚠️ **第三个坑：草案必须带 `position` / `data.label`（引擎必填，校验器一度没查）**。
> 缺任一项 ⇒ 同步 `/api/run` 回 `400 missing field …`；而**异步** `/api/run/async` 照回 `202`
> 却不登记运行 ⇒ 工具轮询到超时回 `status: running`（看着像「还在跑」，其实没跑）。
> 两个字段已补进 `validatePipelineDraft`（`refused/invalid_draft` + 定位到具体路径）。
> 其它解析失败仍是同一个黑洞——排查手法：把 `sandbox/<runId>.json` 拿同步 `/api/run` 跑一次，
> 引擎原话立刻出来。
>
> ⚠️ **第四个坑：compose 里给「已有服务行」加 env，部署不会自动生效**（2026-10-23 实测）。
> 改完 `deploy/docker-compose.yml` 的 `sandbox-console.environment`（加 `DUCKLE_SHARE_DIR` 等）后
> 部署：CI 绿、部署 `ready`、容器也换了新镜像，**但容器里没有这几个 env、`sandbox/` 也没被建**。
> 根因：openship 把 compose 与已存服务行 env 的差异记成 **`drift`**（`GET .../services/:id`
> 返回 `drift.changes`），**不自动写入服务行**。正确顺序 = ① 接受 drift
> （`POST .../services/:id/drift-accept`，或直接 `PATCH .../services/:id` 写 env）→
> ② **再发一次部署**（服务行 env 是在部署时注入容器的）。**`restart` 不够**：它只重启容器，
> 不重读服务行 env（实测：drift 接受后 `restart` 出的新容器，env 仍为空）。
> 判据：`docker exec <console 容器> env | grep DUCKLE_SHARE` 有输出才算真生效——
> 「部署成功」不等于「配置生效」。

| 项 | 值 / 做法 |
|---|---|
| **服务在哪** | `deploy/docker-compose.yml` 的 `sandbox-console`（单元 A），`platform-core-duckle-sandbox:local`，`serve --port 18090`，**无宿主端口** |
| **地址** | server 侧 `DATA_SANDBOX_URL=http://sandbox-console:18090`（容器 DNS 名 = compose 服务名；只在单元 A 默认网络内可解析）。**注入点 = `server` 服务行 env**——compose 的 `server.environment` **故意不声明**它（理由见文件内注释：`${}` 插值在本地会读 `deploy/.env`/shell，写空值反覆盖真值） |
| **token** | `DUCKLE_TOKEN`，**与 console 同一个值**（openship env(isSecret)；仓内不写）。server 侧用 `DATA_SANDBOX_TOKEN` 注入同一值（同样在 `server` 服务行 env） |
| **token 怎么取** | **自己生成**：引擎不铸 token，`serve --token` 收的就是任意强口令（既有 `lemeng-console-*` 同口径）。生成一次强随机串后，落**三处**：① 项目 env `DUCKLE_TOKEN`(isSecret)（compose 服务行的 `${DUCKLE_TOKEN:-}` 由它插值）② `sandbox-console` 服务行 `DUCKLE_TOKEN` ③ `server` 服务行 `DATA_SANDBOX_TOKEN`。**轮换必须三处同改**，否则一边 401/一边拒起 |
| **交换卷** | 命名卷 `sandbox-workspace`：console 看到 `/workspace`，server 看到 `/run/duckle-sandbox`（`DATA_SANDBOX_DIR`）。草案 = `sandbox/<runId>.json`，回执 = `runs/receipts/`。**`sandbox/` 必须交权给 uid 1000**（见上方第二个坑的 `DUCKLE_SHARE_DIR`），否则 server 写不进去 |
| **不要它的项目** | openship 服务行 `enabled: false`（**别只靠 compose profiles**——openship 按自己的服务清单逐服务启停，profiles 对它无效，见 mb-proxy 的教训）。**`platform-core-shanhai` 已按此置 `enabled: false`（2026-10-23）**：那条服务行是预建的，同 compose 的下次部署按名字合并，不会把没备 token 的服务拉起来 |
| **默认档凭据** | **无**：沙箱容器不注入任何 ZOS/LEMENG 凭据 ⇒ 源端只能是公开/无鉴权端点。按账套 opt-in 的只读凭据档**待沉淀**（一个账套 = 一个 sandbox 服务，理由同 ADR-0014） |

部署后按序自证（每条都要**看见**，不看「应该」）：

```sh
# ① 服务面：healthz 公开（其它端点要 token）
docker exec <server 容器> node -e "fetch('http://sandbox-console:18090/healthz').then(r=>console.log(r.status))"   # 期望 200
# ② 真跑一条无鉴权最小管线（src.csv → snk.csv，sink 路径必须在 /workspace/logs/sandbox/ 下）
#    首选：经 openship MCP 调 run_pipeline_sandbox（需平台 PAT）；没有 PAT 时的等效取证 =
#    在生产 server 容器内直接用平台代码路径跑 impl（2026-10-23 用这条）：
#      docker exec -w /app <server 容器> node_modules/.bin/tsx /tmp/probe.ts
#    探针 = 组 deps{env, sandbox: sandboxRunnerFromEnv(process.env)} → runPipelineSandboxImpl(...)
#    期望 status: ok + runId + durationMs/rows + auditRowCount==rows
#    排障用（引擎原话）：对同一草案文件 POST /api/run（同步）⇒ 200 status ok|error，或 400 parse …
# ③ 共享卷两个方向都通：server 写的草案在 console 里可见并被执行；console 写的
#    产物（logs/sandbox/*.csv）与回执（runs/receipts/*.json）在 server 里可读
# ④ 负向三连（缺一条都说明闸没生效）：
#      code.shell            ⇒ denied/component_not_allowed（且执行面零调用）
#      写正式湖（非 __sandbox/）⇒ denied/sandbox_prefix_violation
#      DATA_SANDBOX_URL 清空  ⇒ not_executed/sandbox_runner_unconfigured（isError=false）
```

排障入口与 L0 管线同规：**回执**（`runs/receipts/`）带逐节点 `status/rows/durationMs`，
**console 自己的日志**看 `serve` 起没起来（token 为空时 entrypoint 会拒起，见 `deploy/duckle/entrypoint.sh`）。

**部署告警怎么读（2026-10-23 实测）**：两种告警要分开——
`it restarted 3 times in the first 15s (exit code 1)` 是**真问题**（进程起不来，优先查 token / 命令）；
`"sandbox-console" never answered at <容器IP>:13000/healthz` 是**误报**：openship 的端口探针固定按
`13000` 探，而本服务听 `18090` 且**无宿主端口**。判「起没起」看容器 `running` + 它自己的日志
（成功形状 = `management console on http://0.0.0.0:18090` + `sign-in required`），别看那条探针。
`postgres ... :5432/healthz` 同理（HTTP 探针打的是 PG 端口）。

## 关联

- `deploy/customer-onboarding.md` §5 阶段 5（拆缝建数据面 project 的入口决策）
- `deploy/data-compose.yml`（数据面编排本体；三常驻 + etl profile 的定义处）
- `deploy/data-plane-manifest.txt` / `deploy/data-plane.lock`（§E 的清单与 lock；守卫见 `scripts/check-data-plane-lock.mjs`）
- `scripts/lemeng/sync-data-plane.sh`（§E.3 的同步程序；落成机器上的 `/opt/lemeng-sync.sh`）
- `deploy/openship-adopt.md`（平台面 adopt runbook）
- `deploy/mb-edit-proxy-runbook.md`（**报表编辑页反代的每客户接线 SOP**——专用 host / 平台↔Metabase 网络接线（P7 同款）/ env 顺序与验收判据；跨单元，独立成文）
- issue #150（数据栈 P0–P3）、#187（T6 真机三坑）、#190 / #192（A 层根治笔）、#199（§E 投递机制）
