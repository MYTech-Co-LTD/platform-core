# deploy/duckle/Dockerfile — duckle headless runner（数据面「部署单元 B」的 ETL 执行器）
#
# 消费方：`deploy/data-compose.yml` 的 `duckle` 服务（T3）——
#   build: { context: .., dockerfile: deploy/duckle/Dockerfile }
#   image: platform-core-duckle:local
#   profiles: ["etl"]            ⇒ 平时不 up；按需 `docker compose --profile etl run duckle <args>`
#   environment: DUCKLE_TOKEN    ⇒ 由本镜像的 ENTRYPOINT 收口（见 §为什么不写在 compose 的 `:?`）
#   volumes: duckle-workspace:/workspace（工作区）+ ../duckle:/pipelines:ro（仓内管线，只读）
#   无 ports                     ⇒ headless，不需要网络面
#
# ── 为什么自建而不直接用官方镜像（spec 2026-09-20 §1「duckle 的打包事实」）──────────
# 官方确有镜像 `ghcr.io/slothflowlabs/duckle-web`，但它是**web 编辑器**，不是 headless runner；
# 官方**没有** headless 镜像（Docker Hub 的 `slothflowlabs/*` 命名空间根本不存在）。
# headless 的两条官方分发路径：① PyPI `duckle`；② release 二进制 `duckle-runner-linux-x64`
# + `SHA256SUMS.txt`。spec 明载 PyPI 为分发路径 ⇒ **本镜像取 ① 作主路径，② 记进 README 作替代**。
#
# ── 与计划范文（plans/2026-09-22-data-stack.md L692–711）的差异，全部有实测依据 ──────
# 计划 L713 自己写明「范文给的是结构，CLI 形态与版本号是首次构建核对点，照抄即错」。
# 核对后改了四处，逐条列明依据：
#
#   ① **不需要单独下载 DuckDB CLI**。范文用 curl+unzip 从 GitHub release 取
#      `duckdb_cli-linux-amd64.zip`。实测：PyPI `duckle` 0.7.3 的元数据硬钉
#      `Requires-Dist: duckdb-cli==1.5.4`，而 `duckdb-cli` 这个包**自带 `duckdb` 控制台脚本**
#      （wheel METADATA 的 `[console_scripts] duckdb = duckdb_cli.__main__:main` 实测）。
#      ⇒ `pip install duckle` 一步就把引擎装好了，curl/unzip/apt-get 三层都可以删掉。
#      duckle 自己的入口垫片也证实这条路：它 `_find_duckdb()` 优先在解释器的 scripts 目录里找
#      `duckdb`（该函数 docstring 原文：'Locate the DuckDB CLI that `duckdb-cli` installed
#      alongside us'）。
#
#   ② **不照抄 `DUCKDB_VERSION=1.5.5`**。范文的前提是与 pg_duckdb 内核（**v1.5.5**）对齐——
#      ⚠️ **该前提已过期**（2026-09-23：pg_duckdb 改走**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`，
#      上游自陈配对 = **DuckDB v1.4.3**）。核对后**结论不变、且理由更强**（不照抄 1.5.5）：
#      duckle 0.7.3 把 `duckdb-cli==1.5.4` 钉死在**自己的包元数据**里（不是建议，是 Requires-Dist），
#      且 runner 二进制里带 `target_version 1.5.4` 的版本检查字符串（v0.7.3 二进制实测）。
#      强行改 1.5.5 会让 pip 解析出与引擎自陈 target 不一致的组合，而**该组合的行为未实测** ——
#      按团队根本法则「不许编」，这里选上游钉死的组合，把分歧记为 gate（见 README §3 与
#      `docs/superpowers/plans/2026-09-22-data-stack.md` 的 T5 报告）。
#      真要换 DuckDB，走引擎自陈的优先项 `DUCKLE_DUCKDB_BIN`（METADATA 原文：
#      'To pin your own build instead, set DUCKLE_DUCKDB_BIN'），不要改 pip 解析。
#
#   ③ **ENTRYPOINT 不是 `duckle "$@" --token "$DUCKLE_TOKEN"`**。三点都不对：
#      · `--token` **不是全局开关**，它只属于 `serve` / `web` 两个开控制台面的子命令
#        （`serve --help` 的 OPTIONS 段实测，全文见 deploy/duckle/README.md）。
#        在入口无条件追加 `--token` 会让 `validate` / `--pipeline` 直接因未知参数失败。
#      · 环境变量名不是 `DUCKLE_TOKEN`，引擎读的是 **`DUCKLE_CONSOLE_TOKEN`**
#        （`--token` 条目自陈 'Shared sign-in token (also DUCKLE_CONSOLE_TOKEN)'）。
#      · 安全闸要挡的是「凭据**未设置**」，而不是「已设置但为空」——后者引擎自己就拒起。
#      ⇒ 收口改由 `entrypoint.sh` 做（把编排侧别名翻成引擎正式名 + 默认拒跑 + 白名单放行离线动词）。
#
#   ④ **不做 `docker build --check` 之外的镜像自证**（本任务不构建镜像，见 README §4）。
#      计划 L698 的 `ARG DUCKLE_VERSION=x.y.z # ⚠️ 待核对` 已按实查钉死为 0.7.3（PyPI 实返）。
#
# ── 为什么不把 token 闸写进 compose 的 `:?`（T3 已言明同一取舍）────────────────────
# `:?` 会在**没配 token**时让整份 compose（含无关的三服务）up 都起不来。安全闸只该挡
# 真正要凭据的那一次调用 ⇒ 闸放 ENTRYPOINT。

FROM python:3.12-slim

# 钉死版本：0.7.3 = PyPI 实测最新（2026-09-16 发布），也是 release v0.7.3 的同一版。
# 升级前先看 deploy/duckle/README.md §3「版本与升级」——那里记着 CLI 面的核对点。
ARG DUCKLE_VERSION=0.7.3
RUN pip install --no-cache-dir "duckle==${DUCKLE_VERSION}"

# 入口（安全闸 + token 名字翻译 + exec 透传）。见文件头 §③。
# 单独成文件而非 `sh -c` 内联：它的行为可在本机用 `sh` 直接跑全套用例（含拒跑分支），
# 内联写法只能靠「读起来对」——而 `docker build --check` 不验运行期行为，本任务又不构建镜像。
COPY deploy/duckle/entrypoint.sh /usr/local/bin/duckle-entrypoint
RUN chmod 0755 /usr/local/bin/duckle-entrypoint

# /workspace 是工作区根（引擎的 --workspace 默认值也是「当前目录」）。
# 与 T3 compose 的 `duckle-workspace:/workspace` 命名卷对齐——**运行时状态落在卷里，
# 不落进镜像层**（`.duckle/` 状态、`logs/`、`runs/`、`secrets.enc` 都在这里）。
# 仓内管线是另一个挂载点（`/pipelines`，只读），不 COPY 进镜像：管线定义的真源在 git，
# 镜像里再存一份就会出现「镜像里的管线」与「仓里的管线」两个事实源。
WORKDIR /workspace

# 注意：这里**不**注入 `--memory-limit / --threads / --temp-dir / --max-temp-size`
# 四个资源预算参数（spec 2026-09-20 §8：DuckDB 默认 spill 可用 90% 磁盘，共享机上必须显式收口）。
# 不在入口替调用方补默认值——那会把「谁来定预算」这个决定藏进镜像，且引擎是否支持这四个参数
# 的环境变量形态**未实测**（只实测了命令行开关），不许编。由调用方在
# `docker compose --profile etl run duckle <args>` 的 args 里显式给，见 README §5。

ENTRYPOINT ["/usr/local/bin/duckle-entrypoint"]
