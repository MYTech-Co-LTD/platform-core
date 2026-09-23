# deploy/pg-duckdb — 自建 pg_duckdb 镜像（P0）｜**当前未启用（备件）**

> ## ⚠️ 本轮（2026-09-23）改用**官方镜像**，本目录降为**未启用（备件）**
>
> `deploy/data-compose.yml` 的 `pg_duckdb` 服务现在拉 **`pgduckdb/pgduckdb:18-v1.1.1`**
> （Docker Hub，**上游构建**；其自陈配对 = **DuckDB v1.4.3**）。本目录的 Dockerfile /
> workflow **全部保留**，但**不在任何部署路径上**——将来若要走 ossie 通路，按 `main` + commit
> sha **重新验证配对**再启用。
>
> **为什么放弃自建（钉 DuckDB v1.5.5 的唯一理由已消失 + 配对实测失败）**：
> 1. **前提变了**：`duckdb-ossie` 本轮**不采用**（语义事实源 = dbt YAML）⇒「必须在 v1.5.5 上装
>    ossie」这条**自建的唯一理由不存在了**。
> 2. **配对实测失败**：`pg_duckdb v1.1.1 × DuckDB v1.5.5` **首次构建实测编译失败**——
>    **8 处 API 断裂**（如 `DBConfigOptions` 无 `allow_unsigned_extensions`、
>    `extension_directory` 已改名 `extension_directories`）。逐条见 §2.2。
> 3. **官方镜像可达**：目标机（`10.0.0.5` = `113.249.104.181`）的 dockerd 已配
>    `HTTPS Proxy 113.250.177.229:4878`，`docker pull alpine:3.20` **真下载成功** ⇒ 能拉 Docker Hub。
>
> **历史理由（保留作备件启用时的背景）**：pg_duckdb **要 superuser +
> `shared_preload_libraries`**（spec §9.4 方案 2）⇒ **不能用托管 PG**（这条**现在依然成立**，
> 官方镜像也是自建 PG 基底）。当初自建的**额外**理由是「官方镜像钉 v1.5.4 而 ossie 只发到
> v1.5.5，在 v1.5.4 上安装报 404（实测）」——**该理由随 ossie 出局而消失**。

- **镜像**（备件路径）：`ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`
  ——⚠️ **产物从未构建过**（配对实测编译失败，见上）；tag 公式与纪律见 §0。
- **当前实际消费方**：`deploy/data-compose.yml` 的 `pg_duckdb` 服务拉的是**官方镜像**
  `pgduckdb/pgduckdb:18-v1.1.1`。**备件将来启用时**才需要「改 tag 两边同改」。

---

## 0. 版本与 tag 纪律

> ⚠️ **本节全部是「备件启用时」的纪律**——当前**未启用**，不构成任何在跑的部署路径。

tag 编码**两个**版本：`<去掉 v 的 pg_duckdb 源码 tag>-duckdb<去掉 v 的 DuckDB 版本>`。
两者的唯一事实源是 Dockerfile 顶部的两个 `ARG`（`PG_DUCKDB_VERSION` / `DUCKDB_VERSION`）。
例：`PG_DUCKDB_VERSION=v1.1.1` + `DUCKDB_VERSION=v1.5.5` ⇒ `1.1.1-duckdb1.5.5`
——两个 `v` 都**不进** tag；机械按公式拼会得到 `v1.1.1-duckdbv1.5.5`，那是错的。

- **不打 `latest`**：可变 tag 禁用是版本纪律（spec §6.6）。任何升级都是「改 ARG → 出**新** tag」，
  旧 tag 保持可回滚。
- ⚠️ **DB 层看到的扩展版本与 tag 不同名**：`v1.1.1` 源码里的 `pg_duckdb.control` 写的是
  `default_version = '1.1.0'`。所以 tag 是 `1.1.1-...`，但 `CREATE EXTENSION pg_duckdb` 装出来
  `SELECT extversion ...` 是 **1.1.0**。这不是错，是上游 tag 与 control 版本不同步
  （已核对 v1.1.1 源码树）。别按 tag 名去断言扩展版本。
- ~~版本更换前**先核对 duckdb-ossie 的发布版本**（它决定 DuckDB 上限——自建的理由就是这个）。~~
  **这条已作废**（2026-09-23）：ossie 本轮出局，DuckDB 上限不再由它决定。启用备件时改为
  **按 pg_duckdb 上游自陈的配对核对**（源码的 CHANGELOG / CI 默认值），**并且必须重新实测**——
  v1.1.1 × v1.5.5 这个「自选配对」就是这么炸的（§2.2）。

---

## 1. 构建路径（两条，产物同源同 tag）

### 1a. CI dispatch（常规路径）

工作流 `.github/workflows/pg-duckdb-image.yml`，**仅 `workflow_dispatch`**（理由见 §5）：

```bash
gh workflow run pg-duckdb-image.yml          # 或 dashboard 里点 Run workflow
gh run watch                                  # ~1–2h 的 C++ 全量编译
```

产物直接推到 GHCR。**动它之前先确认 Actions 额度**：一次 dispatch 就是 1–2h 的机时，
额度不够时中途失败 = 白烧（team-harness PR#79 因账单挂起的教训）。

目标机取镜像需先登录（凭据「在哪、怎么取」见基建速查，不在此写值）：

```bash
docker login ghcr.io
```

### 1b. 手工 docker commit 兜底（无额度 / 目标机离线时）

这是 spec §11.4 recipe 的**原形态**（实测就是这么做的）。用在「CI 跑不了」但「机器得先有镜像」的
场景，产物与 1a 同源同 tag。

```bash
# ① 起一个可交互的 PG 容器（就是最终镜像的基底）
docker run -d --name pgduckdb-lab postgres:17 sleep infinity
docker exec -it pgduckdb-lab bash

# ② 装构建依赖（与 Dockerfile 的构建 stage 同清单）
#    目标机直连 GitHub 可能不通 ⇒ 代理要在**容器内**配（本路径的 apt / curl 都在容器里跑；
#    `docker build --build-arg HTTPS_PROXY=…` 是**本地构建 Dockerfile** 时才用的参数，
#    而本 runbook 的两条路径都不是——1a 在 GitHub 托管 runner 上跑，1b 在容器里跑）。
#    ⚠️ 下面两行 export 是**无条件**的：**若该机可直连 GitHub，这两行可跳过**
#    （留着就等于强制全部容器流量走代理，不是「按需」）。
#    代理地址口径见基建速查——**用公网 EIP，内网 `10.0.0.8:4878` 被云安全组拦**。
export http_proxy=http://113.250.177.229:4878
export https_proxy=$http_proxy
apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential cmake ninja-build \
  liblz4-dev libzstd-dev zlib1g-dev libcurl4-openssl-dev postgresql-server-dev-17

# ③ 取源码：两个 tarball（别 git clone——pg_duckdb 的子模块在这条网上爬不动）
mkdir -p /src && cd /src
curl -fsSL https://github.com/duckdb/pg_duckdb/archive/refs/tags/v1.1.1.tar.gz | tar xz --strip-components=1
mkdir -p third_party/duckdb
curl -fsSL https://github.com/duckdb/duckdb/archive/refs/tags/v1.5.5.tar.gz \
  | tar xz -C third_party/duckdb --strip-components=1

# ④ 补子模块哨兵（不加这行必挂——原因见 Dockerfile 同位置注释）
mkdir -p .git/modules/third_party/duckdb && touch .git/modules/third_party/duckdb/HEAD

# ⑤ 上游 jemalloc 缺 include 的补丁（⚠️ 路径在第三方树内）
sed -i '1i #include "duckdb/common/string_util.hpp"' \
  third_party/duckdb/src/common/allocator/allocator_jemalloc.cpp

# ⑥ 编译 + 安装（三个编译配置缺一不可，别改；~1–2h）
make DUCKDB_VERSION=v1.5.5 \
  DUCKDB_CMAKE_VARS="-DCXX_EXTRA=-fvisibility=default -DBUILD_SHELL=0 -DBUILD_PYTHON=0 -DBUILD_UNITTESTS=0 -DDISABLE_UNITY=1 -DOVERRIDE_GIT_DESCRIBE=v1.5.5" \
  CMAKE_BUILD_PARALLEL_LEVEL=2 -j2
make install
exit

# ⑦ 提交成镜像并打与 CI 完全相同的 tag
docker commit pgduckdb-lab ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5
```

⚠️ **跨机必须 `docker push`**：§1b 的 tag 与 §1a 完全相同，但两条路径**只在「在目标机上本地构建」
时才等价**。若在别的机器上构建，镜像还在那台机器的本地 daemon 里，必须推上去，否则目标机
`docker compose pull` 找不到镜像：

```bash
docker login ghcr.io
docker push ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5
```

**手工路径的两个已知差异**（不是缺陷，是「为什么它只是兜底」）：

1. **产物是胖镜像**：`docker commit` 会把 gcc / cmake / ninja / `postgresql-server-dev-17`
   一起打进镜像（实测的 lab 镜像即如此）。CI 的多阶段构建则只带运行期。
2. **`libcurl4` 是「顺手带进来的」**：`libcurl4-openssl-dev` 依赖 `libcurl4`，commit 时留在了
   镜像里。CI 路径**不继承**这份依赖，所以在最终 stage 显式装了它——见 §2。

---

## 2. 首次构建要盯的两件事（COPY 落点 + 版本配对）

> ⚠️ **按「备件」状态读本节**：本目录**未启用**。首次构建**已实测停在 §2.2 的编译阶段**（失败）
> ⇒ §2.1 的 COPY 落点核对**从未执行过**（根本没走到 install 之后）。两节都按
> 「**备件将来启用时**的核对步」读。

### 2.1 COPY 落点（三条判据）

Dockerfile 最后两条 `COPY --from=build` 的路径是「按 PG 布局推定」的，**首次真构建时按实际
`make install` 日志复核一次**。核对方法：

```bash
docker run --rm --entrypoint bash <新 tag> -c '
  ls -la /usr/lib/postgresql/17/lib/        | grep -i duck    # 期望：libduckdb.so + pg_duckdb.so
  ls -la /usr/share/postgresql/17/extension/| grep -i duck    # 期望：pg_duckdb.control + pg_duckdb--*.sql
  ldd /usr/lib/postgresql/17/lib/pg_duckdb.so | grep -c "not found"   # 期望：0
'
```

三条判据，任一不符就按 `make install` 的实际输出订正 Dockerfile，**别猜**：

1. `pkglibdir`（= `pg_config --pkglibdir`）里有 `libduckdb.so` 与 `pg_duckdb.so`；
2. `sharedir/extension` 里有 `pg_duckdb.control` 与 `pg_duckdb--*.sql`；
3. `ldd pg_duckdb.so` **没有 `not found`** ——这条是防 §1b 说的 `libcurl4` 一类运行期缺库
   （缺库不会让构建失败，只会让扩展**加载**失败）。

> 参考：spec 实测产出的镜像（`pgduckdb-lab:v1.5.5`）三条都成立。注意那份实测产物是
> **pg_duckdb 1.2.0-dev**（control 里 `default_version = 1.2.0`）+ DuckDB v1.5.5，
> 而本镜像钉的是 v1.1.1 源码 —— **机制同源、revision 不同**，所以这次核对不能省。

### 2.2 版本配对：**首次构建实测已判定——这一对编译失败（8 处 API 断裂）**

> ⚠️ **本节结论已由实测落定（2026-09-23）**，它正是「本轮改用官方镜像」的直接原因之一。
> 本节**不是**「未知风险的提示」，而是**这条自建路径被判定不可用的记录**。

上面那句「revision 不同」说的只是 COPY 落点。它**还有另一半后果**：本镜像的
`pg_duckdb v1.1.1 + DuckDB v1.5.5` 是**未经上游、也未经 lab 验证过的配对**。

- **上游自陈的配对不是这个**：`v1.1.1` 的 CHANGELOG 写着 `Update to DuckDB v1.4.3. (#985)`
  —— 即 v1.1.1 配 **DuckDB v1.4.3**（2025-12-16）。本镜像用的 **v1.5.5 发布于 2026-07-21**
  ⇒ 相隔约 **7 个月、跨 1 个 minor**。
- **上游对 v1.1.1 只测一个组合**：其 CI 跑 `make -j8 install DUCKDB_BUILD=…`，**从不覆盖
  `DUCKDB_VERSION`** ⇒ 测的就是 Makefile 默认的 `v1.4.3`。`v1.1.1 + v1.5.5` 上游没测过。
- **lab 验证的也不是这个**：lab 是 pg_duckdb **1.2.0-dev（main）** + DuckDB v1.5.5，而 main 的
  Makefile 默认 = **v1.5.4** ⇒ 被验证的 override 是 **v1.5.4 → v1.5.5（同 minor 的补丁级）**；
  本镜像是 **v1.4.3 → v1.5.5（跨 1 个 minor）**，**不等于** lab 那一对。
- **首次构建实测：8 处 API 断裂** —— 逐处登记**原文名**：

  | # | 断裂点（原文名） | 已知形态 |
  |---|---|---|
  | 1 | `DBConfigOptions::allow_unsigned_extensions` | `DBConfigOptions` 上**无**该成员 |
  | 2 | `DBConfigOptions::enable_external_access` | — |
  | 3 | `DBConfigOptions::allow_community_extensions` | — |
  | 4 | `DBConfigOptions::autoinstall_known_extensions` | — |
  | 5 | `DBConfigOptions::autoload_known_extensions` | — |
  | 6 | `DBConfigOptions::extension_directory` | **已改名** `extension_directories` |
  | 7 | `DBConfig::storage_extensions` | — |
  | 8 | `DBConfig::optimizer_extensions` | — |

  「—」= **只登记断裂点原名**：除 1 与 6 之外的形态**未逐条定性**，此处**不替上游编原因**。

- ⚠️ **口径（原文的推论错在哪）**：原文写「**已排除的**：头文件级断裂 —— 52/52 头全在（实测），
  所以「include 不到」这种失败不会发生」+「**仍未知的**：符号 / API 漂移，既未证实也未证伪」。
  **头文件 52/52 全在是真的**（复核对 52 条逐条 HTTP 探针 = 52/52 全 200），但它**只**证明
  「include 得到头文件」，**推不出**「编译得过」——上表 8 处正是「头文件里**找不到这些符号**」
  的形态。**别再把「头文件在」读成「配对可行」**；「未知」也**不再是未知**——已实测**证伪**。

⇒ **结论：该配对不成立**（编译失败），自建路径据此**降为「未启用（备件）」**（见文首）。
将来启用备件时，**先按 §0 的订正口径核对上游自陈配对，并重新实测**，**别复用这一对**；
下面的 COPY 落点判据（§2.1）与「真 PG 上验一次可加载」仍是**备件启用时**的核对步。

最后在真 PG 上验一次可加载（`shared_preload_libraries` 之外的第二步）：

```sql
CREATE EXTENSION pg_duckdb;
SELECT extversion FROM pg_extension WHERE extname = 'pg_duckdb';   -- 期望 1.1.0（见 §0）
```

---

## 3. 运行期硬约束（spec §11.5，实测踩到，必须知道）

1. **★ pg_duckdb 的 DuckDB 实例是「按连接」的** ⇒ `SET`（GUC）与「用它」**必须在同一会话**。
   `install_extension` 同理：必须在同一会话里同时开
   `duckdb.allow_community_extensions` **和** `duckdb.allow_unsigned_extensions`。
   （跨会话会报出极具误导性的错——签到三次。）
2. **`duckdb.query()` 跑在 DuckDB 原生上下文，看不到 Postgres 表** ⇒ 用 `duckdb.raw_query()`
   在会话内建 DuckDB 侧的表/视图。
3. **`rebind` 的键是「模型里声明的 `source`」**（官方例子 `MAP{'tpcds.public': 'memory.main'}`）；
   **per-schema + `search_path` 是更贴架构的那条**（每租户一个 schema，同名视图各指各的数据）。

> 给 Metabase 消费方的一条连带约束（spec §9.4 的可见性坑）：`read_parquet()` 裸扫描与
> `duckdb.query()` 的结果**不是 PG 关系、不进 `pg_class`** ⇒ **Metabase 看不见**。
> 要让报表能看，必须包成视图 / 物化视图 / `USING duckdb` 表。

---

## 4. 内存口径（spec §9.4）

**每连接一个 DuckDB 实例**：`max_memory` 默认 **4096MB/连接**（即 `duckdb.max_memory`，
默认值 4096），且**没有 per-tenant 配额** —— 所以连接数一上来，内存是「连接数 × 4GB」的量级，
不是一份。

收口的两条动作（都由编排侧做，不在镜像里）：

- **连接池上限**：把并发连接数卡住，而不是指望每条连接自觉。
- **显式设 `duckdb.memory_limit`**：它是 `duckdb.max_memory` 的**别名**（同一个 GUC，
  上游文档与源码均注明），按业务实际情况往下调，别吃默认。

> 相关的两个默认值也一并留意：`duckdb.threads` / `duckdb.worker_threads` 默认 **`-1`**、
> 两者互为**别名**（v1.1.1 `src/pgduckdb_guc.cpp` L226-230：共享同一全局 `duckdb_maximum_threads`，
> 其初值 `= -1`，range -1..1024；short_desc 明写 *alias for duckdb.threads*）。
> `-1` 的语义**不在 pg_duckdb 侧**：v1.1.1 `src/pgduckdb_duckdb.cpp:137` 是
> `if (duckdb_maximum_threads > -1) { SET_DUCKDB_OPTION(maximum_threads); }` ⇒ **默认值下
> pg_duckdb 根本不把这个选项传给 DuckDB**，落到 DuckDB 自己的默认。上游注释（DuckDB v1.5.5
> `src/include/duckdb/main/config.hpp:110-111`，原文）：
> > `//! The maximum amount of CPU threads used by the database system. Default: all available.`
>
> 即**按机器可用核数**——每条连接都能起满核数线程，连接一多就是线程超订。
> 这跟构建期「ninja 按 nproc 起任务打 OOM」是同一类失控，只是发生在运行期。

---

## 5. 开放项与回退口径

### 5.1 构建频率（**开放项已消解**——前提消失）

> ⚠️ **2026-09-23：本节随「本轮未启用」消解。** 下面这段记录的是备件启用时仍成立的部分。

~~spec §11.9 #4：自建镜像的**构建频率与触发**仍是开放项（跟 pg_duckdb 上游走，还是跟 DuckDB
版本走，未定）。~~ **该开放项的前提（自建镜像在部署路径上）已不存在**——本轮改官方镜像，
自建降为未启用备件 ⇒「多久构建一次」这个问题的对象没有了。将来启用备件时再议（届时应先按
§2.2 的实测结论重新选配对）。

工作流本身**只开 `workflow_dispatch`**（不设 `schedule`、不在 push/PR 上跑）这条形态**保持不变**——
它对备件路径依然是对的：跑一次 ~1–2h 的 C++ 构建，不该被无人值守触发。
要升级版本时：改 Dockerfile 的两个 `ARG` → 重跑 → 出新 tag
（**tag 的三个引用点必须同改**，见 §5.2）。

### 5.2 版本配对的回退路径（**备件启用前先读**）

> ⚠️ **本节前提已变（2026-09-23）**：原文写「这一对尚未被任何一方验证过，首次 dispatch 兼作
> 验收」。**验收已经发生了，结果是失败**（§2.2 的 8 处 API 断裂）⇒ 本节从「预案」变成
> 「**历史记录 + 备件启用时的回退口径**」。本轮**没有走这条回退**——本轮的整体处置是
> **改走官方镜像**（文首），**不是**「在自建路径里换一个配对」。

**原预案**：`PG_DUCKDB_VERSION=v1.1.1` + `DUCKDB_VERSION=v1.5.5` 这一对（§2.2）**未经任何一方
验证过**，而首次 dispatch 同时就是它的验收 —— 跑通之前属「未验证配对」，不能算「P0 已交付」。

**实测失败后**（就是 §2.2 那 8 处断裂），若**仍要走自建**，按顺序回退，
**只改 `PG_DUCKDB_VERSION` 这一个 ARG**：

1. `PG_DUCKDB_VERSION=main` —— 即 lab 验证过的配对（main 的默认 DuckDB v1.5.4 → override v1.5.5）。
   代价：`main` 是移动靶，可复现性掉一档 ⇒ 这是**应急回退**，不是新默认。
2. 钉到 lab 对应的 **1.2.0-dev commit**（拿具体 SHA 填进 ARG）—— 要长期用就选这条，可复现。

> ⚠️ **本轮订正的启用口径**（比原预案更严）：备件将来启用时**不能只做上面这个 ARG 回退**——
> 还得①按 §0 的订正核对**上游自陈的配对**（而不是「谁验证过」），②**重新实测编译**，
> ③按 §0 出「**新** tag」（见下）。原预案的「换 pair 重跑」不足以恢复这条路径。

⚠️ **改完 ARG 还有第二步：按 §0 出「新」tag ——`1.1.1-duckdb1.5.5` 不得复用。**
tag **不是**从 ARG 推导出来的（它是硬编码字面量），所以「只改一个 ARG → 重跑」的实际后果是
**用 `main` / 某个 SHA 编出的另一份产物盖上 `1.1.1-duckdb1.5.5`**：既撞 §0 的「不打可变
tag、**旧 tag 保持可回滚**」（覆盖后收不回），又让 tag 名与产物实际来源不符——而 §2.2 已确认
tag 与 `extversion` 本来就可能不同名，**排查时极难识别**。
回退场景的命名约定建议 **`main-duckdb1.5.5`** / **`<sha8>-duckdb1.5.5`**
（`main` / SHA 不在 §0 那条 tag 公式的取值域内，所以回退要另起一个名字）。

tag 在**三处，必须同改**（漏一处 ⇒ 产物与引用对不上）：

1. `.github/workflows/pg-duckdb-image.yml` 的 `tags:`
2. §1b ⑦ 的 `docker commit …:<tag>`（含 §1b 末尾跨机 `docker push` 的那条同 tag 命令）
3. `deploy/data-compose.yml` 里 `pg_duckdb` 服务的镜像引用（T3；即文首「改 tag 必须两边同改」）

~~**不往下降 `DUCKDB_VERSION`**：duckdb-ossie 只发到 v1.5.5，降到 v1.4.3 会让 §0 的自建理由
（语义层装不上）失效——所以回退方向是换 pg_duckdb，不是换 DuckDB。~~

**⚠️ 上面这条已作废（2026-09-23），作废的不是「不降 DuckDB」这个动作，而是它的理由**：
「降 v1.4.3 会让自建理由失效」的前提是 **ossie 必须装得上**——而**本轮 ossie 出局**
（语义事实源 = dbt YAML）⇒ 这条理由消失。**本轮结论是「整条自建路径未启用」**，
所以「往哪降」已无对象。

**本轮结论（写回本节，开放项就此关闭）**：
1. `pg_duckdb v1.1.1 × DuckDB v1.5.5` —— **实测编译失败**（§2.2，8 处 API 断裂）。
2. 处置 = **改用官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`**（上游构建，自陈配对 = DuckDB v1.4.3），
   本目录与 `.github/workflows/pg-duckdb-image.yml` **降为「未启用（备件）」**，**不删**。
3. 将来启用备件的入口条件是**重新验证配对**（§0 的订正口径 + 重新实测 + 出新 tag），
   **不是**「照本节第 1/2 条回退一下就能用」。
