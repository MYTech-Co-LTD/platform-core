# deploy/pg-duckdb/Dockerfile — 自建 pg_duckdb（spec 2026-09-20 §11.2 #3 / §11.4，实测 recipe 容器化）。
#
# ⚠️ 当前未启用（备件）——2026-09-23：部署路径已改用官方镜像 pgduckdb/pgduckdb:18-v1.1.1
#（deploy/data-compose.yml）。本文件保留不删；启用前先按 README §0 的订正口径核对上游自陈配对、
# 重新实测编译，并出新 tag。详见 deploy/pg-duckdb/README.md 文首与 §2.2、§5.2。
#
# 为什么当初自建：官方 pg_duckdb 钉 DuckDB v1.5.4，duckdb-ossie 只发到 v1.5.5（安装 404，实测）；
# 且 pg_duckdb 需 superuser + shared_preload_libraries（spec §9.4 方案 2）⇒ 必须自建 PG。
# ⚠️ 该理由**已消失**（ossie 本轮不采用）；且本镜像的 v1.1.1 × v1.5.5 配对**实测编译失败**
#（8 处 API 断裂，见 README §2.2）⇒ 这条路本轮不通。
#
# 构建耗时长（C++ 全量编译，-j2 下 ~1–2h）——这是版本换来的代价，别为了快改并行度把机器打 OOM
#（spec 实测：外层 -j 压不住 ninja，它按 nproc 起任务 ⇒ OOM；DISABLE_UNITY=1 同理是 OOM 对策）。
FROM postgres:17 AS build

# 产物 tag 编码这两个版本：pg_duckdb 源码 tag + DuckDB 版本（见 README「版本与升级」）。
ARG PG_DUCKDB_VERSION=v1.1.1
ARG DUCKDB_VERSION=v1.5.5

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential cmake ninja-build \
      liblz4-dev libzstd-dev zlib1g-dev libcurl4-openssl-dev postgresql-server-dev-17 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# tarball 预填 third_party/duckdb，绕开 git submodule（spec §11.4 ①）。
# 别改用 git clone：pg_duckdb 的子模块在这条网上爬不动（spec 原话）。
RUN curl -fsSL https://github.com/duckdb/pg_duckdb/archive/refs/tags/${PG_DUCKDB_VERSION}.tar.gz \
      | tar xz --strip-components=1
RUN mkdir -p third_party/duckdb \
    && curl -fsSL https://github.com/duckdb/duckdb/archive/refs/tags/${DUCKDB_VERSION}.tar.gz \
      | tar xz -C third_party/duckdb --strip-components=1

# 补齐「子模块已初始化」哨兵：pg_duckdb 的 Makefile 里每个目标文件都挂在
#   $(OBJS): .git/modules/third_party/duckdb/HEAD
# 上（注释自陈「靠这个 target pull 进子模块的头文件」）。该路径缺失时 make 会去执行
#   git submodule update --init --recursive
# ——而上面的 tarball 解出来的树**不是 git 仓库**，这条命令直接 fatal（不是编译失败，是当场退出）。
# 源码既已由 tarball 预填到位，这里只需补上哨兵文件让 make 认为子模块就绪。
# ⚠️ 这不是可选的：不加这行，tarball-only 构建必挂。
RUN mkdir -p .git/modules/third_party/duckdb \
    && touch .git/modules/third_party/duckdb/HEAD

# 上游真 bug 的手工补丁（spec §11.4 ③）：allocator_jemalloc.cpp 用了 StringUtil::Format(...)
# 却没 include string_util.hpp。
# ⚠️ 路径在**第三方树内**：该文件属 DuckDB（duckdb v1.5.5 实证：第 32 行用 StringUtil::Format，
# 而 include 清单里没有 string_util.hpp）。pg_duckdb 自己的 src/ 下**没有**这个文件——
# 写成 src/common/allocator/... 会 No such file 当场失败，别按字面照抄 spec 的简写路径。
RUN sed -i '1i #include "duckdb/common/string_util.hpp"' \
      third_party/duckdb/src/common/allocator/allocator_jemalloc.cpp

# §11.4 ②：三个编译配置缺一不可（DISABLE_UNITY / CMAKE_BUILD_PARALLEL_LEVEL / 上面的 include）。
# DUCKDB_VERSION 是 pg_duckdb Makefile 的变量，命令行赋值会覆盖其默认值（默认 v1.4.3）。
RUN make DUCKDB_VERSION=${DUCKDB_VERSION} \
      DUCKDB_CMAKE_VARS="-DCXX_EXTRA=-fvisibility=default -DBUILD_SHELL=0 -DBUILD_PYTHON=0 -DBUILD_UNITTESTS=0 -DDISABLE_UNITY=1 -DOVERRIDE_GIT_DESCRIBE=${DUCKDB_VERSION}" \
      CMAKE_BUILD_PARALLEL_LEVEL=2 -j2
RUN make install

FROM postgres:17

# 运行期依赖：pg_duckdb.so 经 libduckdb.so 依赖 libcurl.so.4（ldd 实测），
# 而 postgres:17 基镜像**不带** libcurl4（实测：ldconfig 里只有 liblz4/libzstd/libssl/libcrypto）。
# §11.4 的 docker commit 路径用不出问题，是因为它 commit 的构建容器里 libcurl4-openssl-dev
# 顺手把 libcurl4 带了进来；**多阶段构建不会继承** ⇒ 不显式装，扩展加载时就报
# `libcurl.so.4: cannot open shared object file`（是运行期加载失败，不是构建失败）。
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 \
    && rm -rf /var/lib/apt/lists/*

# make install 的落点：pkglibdir 与 sharedir/extension（`pg_config --pkglibdir --sharedir` 实测
# = /usr/lib/postgresql/17/lib 与 /usr/share/postgresql/17）。
# 已用 spec 实测产出的镜像（pgduckdb-lab:v1.5.5）核对过实际落点：
#   libduckdb.so + pg_duckdb.so         → pkglibdir
#   pg_duckdb.control + pg_duckdb--*.sql → sharedir/extension
# 两目录都在同一基镜像里，路径与本 stage 一致。首次构建仍按 README 的核对步复核一遍。
COPY --from=build /usr/lib/postgresql/17/lib/ /usr/lib/postgresql/17/lib/
COPY --from=build /usr/share/postgresql/17/extension/ /usr/share/postgresql/17/extension/

# pg_duckdb 需 superuser + shared_preload_libraries（spec §9.4 方案 2）；由编排侧经 command 传，
# 不在镜像里写死（本镜像只负责「可加载」）。
