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

### P8 平台侧接线

| 动作 | 过门条件 |
|---|---|
| 平台 project env 加 `DATA_WAREHOUSE_URL`（isSecret）→ 重部署 | 部署后**必验服务 env 形状**（逐键看物化结果，不是看配置面） |

> mytech 实测：部署把 `DATABASE_URL` **重写成无口令形态** ⇒ `client password must be a string`
> crash loop。修法：从 postgres 容器读真口令 → **服务级 PATCH 写回** → 重部署。同类问题一律
> 「读真值 → 服务级写回 → 重部署 → 再验形状」。

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

---

## C 21 坑三层分类表

> 三层的处置语义不同：**A 层已根治**（再撞说明回退了修复，查 git）；**B 层结构性**（openship
> services 模式的固有行为，防法=按 B 节固定序列走）；**C 层环境前置**（防法=检查项+判定，P0-P2/P9/P10 已内置）。

### A 层：已根治 6（修复已进仓/控制面）

| # | 坑 | 根治处 |
|---|---|---|
| 1 | dbt-postgres 1.9.8 配对不存在（1.9 线只到 1.9.1） | #187 钉 `1.9.1`（`deploy/dbt/Dockerfile`） |
| 2 | dbt Jinja 块内 SQL 注释编译错 | #187（模型改写规避） |
| 3 | 构建容器内 corepack/pnpm 直连 npmjs 超时 | #192 `Dockerfile.server` 双键 npmmirror |
| 4 | 真库测试锁竞态族（超时抖动） | #190 `fileParallelism` 根级串行 |
| 5 | 智能代理大镜像分块拉取缺陷 | 控制面代码+配置双修（首块 4MB / 块超时 600s / 并行 6——细节见 WeKnora《智能代理大镜像拉取根治》） |
| 6 | openship services 模式三坑（相对 bind / PG18 数据目录 / env 终值） | #187 入档 + 本 SOP P5 固化 |

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

## 关联

- `deploy/customer-onboarding.md` §5 阶段 5（拆缝建数据面 project 的入口决策）
- `deploy/data-compose.yml`（数据面编排本体；三常驻 + etl profile 的定义处）
- `deploy/openship-adopt.md`（平台面 adopt runbook）
- issue #150（数据栈 P0–P3）、#187（T6 真机三坑）、#190 / #192（A 层根治笔）
