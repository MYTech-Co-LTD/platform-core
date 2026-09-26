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

## E 数据面工件投递程序（仓 → 数据面机）

> **适用**：仓里的**数据面工件**要落到**数据面机**（`ecm-7d66` / 内网 `10.0.0.5`）上跑。
> **不是一个脚本**——机器实际消费 **7 个路径 / 4 个落地位置**（E.2 的表）。
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
| `deploy/data-compose.yml` | 同名 | `run-retail-day.sh` 的 `docker compose -f` |
| `duckle/**` | 同名 | compose bind `../duckle:/pipelines:ro`；宿主侧另有直读（drift 前置断言） |
| `dbt/**` | 同名 | compose bind `../dbt:/usr/app` |
| `deploy/duckle/entrypoint.sh` | 同名 | 仅作构建上下文（`deploy/duckle/Dockerfile` 的 COPY） |
| `scripts/lemeng/run-retail-day.sh` | `/opt/lemeng-run.sh`（**改名**） | job / `exec` 直调 |
| `scripts/lemeng/readback-helper.sh` | `<checkout>/lemeng-readback.sh`（**改名**） | 挂进容器跑回读 |

**消费面怎么定的**（三条，缺一会漏）：① `run-retail-day.sh` 里对 `$REPO/<路径>` 的**每一处引用**；
② `data-compose.yml` 里的**每一处 bind**（源路径即仓内路径）；③ 各 Dockerfile 的 **COPY 来源**。
⇒ **改了其中任一目录/文件，都要重投**——「只投了 `run-retail-day.sh`」正是本节要根治的漏法。

**⚠️ 明写不做：Dockerfile 本体不进清单**（`deploy/duckle/Dockerfile`、`deploy/dbt/Dockerfile`）。
判据 ③ 只取它们的 **COPY 来源**（= `deploy/duckle/entrypoint.sh`，已在表内），Dockerfile 本身**不在
消费面**，两条依据：① 它们只在**镜像构建期**被读，而构建走 openship 部署通路（部署会把构建上下文
送上去），不经本投递程序；② 实测佐证——S1 的 24 窗口全量跑 + probe 均通过，而这两个文件**从未投递过**。
⇒ 反过来，**若哪天把构建搬到数据面机上本机跑**，这条就不成立，届时要连 Dockerfile 一起登记。

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
scripts/lemeng/run-retail-day.sh      /opt/lemeng-run.sh                   0755
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
sh /opt/lemeng-sync.sh <全SHA>            # 同步
sh /opt/lemeng-sync.sh <全SHA> --check    # 只比不写
```

四步：**取 lock**（按全 SHA 经 smart-proxy **公网 EIP** `113.250.177.229:4878`；控制面内网
`10.0.0.8:4878` 被云安全组拦、**直连不通**，实测 code=000）→ **验 lock 自校验** → **逐条取件**
（同目录临时文件 → sha256 断言 → 补模式 → 原子 `mv -f`；跨目录 rename 不原子）→ **最后**写
`<checkout>/.data-plane-revision`。

**版本标记语义**：**标记在 = 这套文件是全的**。单文件 `mv` 是原子的，但**整套不是**——中途失败会停在
半应用状态，靠「标记缺失 / 与 `--check` 不符」把它显性化，而不是静默。

**输出契约**：每文件一行 `<状态> <落地路径> <期望 sha256> <实际 sha256>`（状态 `OK`/`DRIFT`）；
末尾 `SYNC_OK <n>/<n>` 或 `SYNC_DRIFT <n> mismatched`。失败字面量：`LOCK_FETCH_FAILED:` /
`LOCK_SELFTEST_FAILED:` / `FETCH_FAILED: <path>` / `REVISION_WRITE_FAILED:`。取件失败**重试至多
10 次**（E.4 ② 的跨境断流是间歇的 ⇒ 重试有意义；E.4 ① 的元数据说谎是确定性的 ⇒ 重试无用）。

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

### F.2 改了定义之后怎么让它生效

**先分清改的是哪一类——三类的最小动作不一样**（2026-09-26 实测定分）：

| 改了什么 | 最小动作 | 为什么 |
|---|---|---|
| **`schedules/` 或 `pipelines/` 的定义**（本节日常改动） | **seed + 重启容器** | 定义 seed 进的是**命名卷** `/workspace`（`<project>-lemeng-console-<账套>-ws`）——**不是 bind-mount** ⇒ 卷内容·重启即重新读取。**不必定向部署。** |
| **bind-mount 进来的文件**：仓内 `duckle/`（挂 `/pipelines:ro`）、`/opt/lemeng-run.sh` | seed/同步 + **重建容器**（**用 `serviceIds` 定向部署**） | **bind-mount 钉的是 inode**，原子替换（同步程序就是这么做的）后运行中的容器**仍看到旧文件** ⇒ 只有重建才换。<br>⚠️ **重建就用 `serviceIds`，别单传 `refreshServiceIds`**——后者名字很像「只重建点名的那个」，但 **2026-09-26 实测：单传它触发了全量重建**，把 `pg_duckdb` 与 `metabase-db` 一并重启（正是本表第三类要避免的）。那次靠卷持久化**数据无损**（实测物化表逐字不变、5 服务全 healthy、outage 0）——但**别把「没出事」读成「这个参数没问题」**。<br>**自证**：重建后**进容器**比对（`$CONTAINER 内` 的 sha256 ≠ 宿主上的 sha256 ⇒ 仍是旧 inode）。 |
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
| 跑了但失败 | `schedules.json` 的 `last_run_status` / `last_run_error`，以及该账套卷里 `logs/dim-*-run.csv`（薄管线的运行记录，含 wrapper 完整 stdout） |
| 自证没过 | 输出里的 `ASSERT_FAIL: …` / `DIM_FAILED` —— **拒写湖是正确行为**（#205），不是故障 |

⚠️ **`/api/schedules` 的 GET 不回运行状态**（文件里已有、GET 恒 `null`）⇒ **别信那个 GET**。

**告警**：wrapper 的 `EXIT` trap 发企微（仅当 `LEMENG_NOTIFY=1`，**薄管线会设** ⇒ 人工/诊断跑不刷群）。
缺 `WECOM_WEBHOOK_URL` 时打 `NOTIFY_SKIPPED`（不静默）；**告警绝不改退出码**。
⚠️ 已知未通项：`OPS_SINK=DISABLED reason=no_ingest_env` ⇒ 观测投递没接（见 open issue **#210**）。

### F.5 尚未迁移 + 回滚

- **零售 job（`lemeng-retail-3120-runner`）仍在 openship job 上** ✓ 本次**未动**它；
  迁移需单独决定与观察（它是正在跑的生产链路）。
- **回滚**：停掉两个 console 服务（或对不需要它的项目设 `enabled:false`）⇒ 即回到「没有调度」；
  零售链路**全程未动** ⇒ 无需恢复。

---

## 关联

- `deploy/customer-onboarding.md` §5 阶段 5（拆缝建数据面 project 的入口决策）
- `deploy/data-compose.yml`（数据面编排本体；三常驻 + etl profile 的定义处）
- `deploy/data-plane-manifest.txt` / `deploy/data-plane.lock`（§E 的清单与 lock；守卫见 `scripts/check-data-plane-lock.mjs`）
- `scripts/lemeng/sync-data-plane.sh`（§E.3 的同步程序；落成机器上的 `/opt/lemeng-sync.sh`）
- `deploy/openship-adopt.md`（平台面 adopt runbook）
- issue #150（数据栈 P0–P3）、#187（T6 真机三坑）、#190 / #192（A 层根治笔）、#199（§E 投递机制）
