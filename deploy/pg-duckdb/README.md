# deploy/pg-duckdb — 自建 pg_duckdb 镜像（P0）

数据面的 PG 必须带 pg_duckdb，而 pg_duckdb **要 superuser + `shared_preload_libraries`**
（spec §9.4 方案 2）⇒ 不能用托管 PG、也不能用官方镜像，得自建。

**为什么不用官方镜像**：官方 pg_duckdb 钉 DuckDB v1.5.4，而语义层要装的 `duckdb-ossie`
只发到 v1.5.5 —— 在 v1.5.4 上安装报 404（实测）。所以自建，把 DuckDB 钉在 v1.5.5。

- **镜像**：`ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`
- **消费方**：`deploy/data-compose.yml` 的 `pg_duckdb` 服务（T3）。**改 tag 必须两边同改。**

---

## 0. 版本与 tag 纪律

tag 编码**两个**版本：`<pg_duckdb 源码 tag>-duckdb<DuckDB 版本>`。两者的唯一事实源是
Dockerfile 顶部的两个 `ARG`（`PG_DUCKDB_VERSION` / `DUCKDB_VERSION`）。

- **不打 `latest`**：可变 tag 禁用是版本纪律（spec §6.6）。任何升级都是「改 ARG → 出**新** tag」，
  旧 tag 保持可回滚。
- ⚠️ **DB 层看到的扩展版本与 tag 不同名**：`v1.1.1` 源码里的 `pg_duckdb.control` 写的是
  `default_version = '1.1.0'`。所以 tag 是 `1.1.1-...`，但 `CREATE EXTENSION pg_duckdb` 装出来
  `SELECT extversion ...` 是 **1.1.0**。这不是错，是上游 tag 与 control 版本不同步
  （已核对 v1.1.1 源码树）。别按 tag 名去断言扩展版本。
- 版本更换前**先核对 duckdb-ossie 的发布版本**（它决定 DuckDB 上限——自建的理由就是这个）。

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

**手工路径的两个已知差异**（不是缺陷，是「为什么它只是兜底」）：

1. **产物是胖镜像**：`docker commit` 会把 gcc / cmake / ninja / `postgresql-server-dev-17`
   一起打进镜像（实测的 lab 镜像即如此）。CI 的多阶段构建则只带运行期。
2. **`libcurl4` 是「顺手带进来的」**：`libcurl4-openssl-dev` 依赖 `libcurl4`，commit 时留在了
   镜像里。CI 路径**不继承**这份依赖，所以在最终 stage 显式装了它——见 §2。

目标机直连 GitHub 可能不通：构建期 `curl`/`apt` 需要走 smart-proxy，
`docker build --build-arg HTTPS_PROXY=http://113.250.177.229:4878 --build-arg HTTP_PROXY=...`
（代理地址口径见基建速查——**用公网 EIP，内网 `10.0.0.8:4878` 被云安全组拦**）。

---

## 2. 首次构建必须核对的落点（COPY gate）

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

> 相关的两个默认值也一并留意（同源实测）：`duckdb.threads` / `duckdb.worker_threads` 默认
> `-1` = **按机器核数**，即每条连接都能起满核数线程；连接一多就是线程超订。
> 这跟构建期「ninja 按 nproc 起任务打 OOM」是同一类失控，只是发生在运行期。

---

## 5. 构建频率（**开放项**，本工作流不替它拍板）

spec §11.9 #4：自建镜像的**构建频率与触发**仍是开放项（跟 pg_duckdb 上游走，还是跟 DuckDB
版本走，未定）。所以工作流**只开 `workflow_dispatch`**：不设 `schedule`、不在 push/PR 上跑。

现口径 = **按需手动 dispatch**。要升级版本时：改 Dockerfile 的两个 `ARG` → 重跑 → 出新 tag
（同步改 `deploy/data-compose.yml`）。等 §11.9 #4 拍板后，再把触发方式写进这里。
