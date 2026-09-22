# deploy/duckle — duckle headless runner 镜像（P1 / T5）

> 镜像本体**尚未构建产出**（首次构建走 CI dispatch，与 `deploy/pg-duckdb/` 同一形态与节奏）。
> 本文件里的每一条「实测」都注明了实测对象与方式 —— **没实测的一律标「未验」，别读成已验证**。

**它是什么**：数据面「部署单元 B」的 ETL 执行器（headless，非常驻）。
**谁消费它**：`deploy/data-compose.yml` 的 `duckle` 服务（T3）——
`build: { context: .., dockerfile: deploy/duckle/Dockerfile }`、`profiles: ["etl"]`（平时不 up）、
`environment: DUCKLE_TOKEN`、卷 `duckle-workspace:/workspace` + `../duckle:/pipelines:ro`、**无 ports**。
**谁不消费它**：平台模块 API 面。本镜像全内网，不进 openship edge、不绑公网、不签证书。

---

## 1. 为什么自建：官方镜像只有 web 编辑器

（出处：spec `docs/superpowers/specs/2026-09-20-data-stack-module-design.md` §1「duckle 的打包事实」）

- 官方**有**镜像 `ghcr.io/slothflowlabs/duckle-web`，但它是**web 编辑器**，不是 headless runner。
- 官方**没有** headless 镜像。Docker Hub 的 `slothflowlabs/*` 命名空间**根本不存在**——别去那儿找。
- headless 两条官方分发路径：① PyPI `duckle`；② release 二进制 `duckle-runner-linux-x64` + `SHA256SUMS.txt`。
  spec 明载 PyPI 为分发路径 ⇒ **本镜像取 ①**；②见 §2.2。

## 2. 镜像构成

### 2.1 主路径：PyPI（Dockerfile 实际用的）

```dockerfile
FROM python:3.12-slim
ARG DUCKLE_VERSION=0.7.3
RUN pip install --no-cache-dir "duckle==${DUCKLE_VERSION}"
COPY deploy/duckle/entrypoint.sh /usr/local/bin/duckle-entrypoint
```

**不需要单独下载 DuckDB CLI。** 这一条与计划范文（`plans/2026-09-22-data-stack.md` L692–711 的
curl + unzip 块）不同，依据是实测：

| 事实 | 实测方式 |
|---|---|
| PyPI `duckle` **存在**，最新 `0.7.3`（2026-09-16 发布），有 `manylinux2014_x86_64` wheel | `GET https://pypi.org/pypi/duckle/json` → HTTP 200 |
| 该 wheel 的元数据**硬钉** `Requires-Dist: duckdb-cli==1.5.4` | 解 wheel 读 `duckle-0.7.3.dist-info/METADATA` |
| `duckdb-cli` **自带 `duckdb` 控制台脚本** | 解 `duckdb_cli-1.5.4` wheel：`entry_points.txt` 有 `duckdb = duckdb_cli.__main__:main`，并含 61.9 MB 的 `duckdb_cli/duckdb` |
| 所以 `pip install duckle` 一步就把引擎装好了 | 上两条的推论（**未经容器内实跑**，见 §4 未验清单） |

duckle 自己的入口垫片也证实这条路：`duckle/__main__.py` 的 `_find_duckdb()` docstring 原文是
`Locate the DuckDB CLI that duckdb-cli installed alongside us`，它优先在解释器的 scripts 目录里找
`duckdb`，并把结果设成 `DUCKLE_DUCKDB_BIN` 交给 runner。

**入口的长相**：wheel 装出两个 console script —— `duckle`（= `duckle.__main__:main`）与
`duckle-mcp`（stdio MCP server）。`duckle` 是个**垫片**，POSIX 下 `os.execve` 掉包内的
`duckle/duckle-runner` 二进制，并把自己的名字作为 `argv[0]` 传下去（源码 docstring 原文：
"This shim exists only so the command lands on PATH as `duckle` rather than under the Cargo target name"）。
⇒ **`duckle --pipeline …` 与 release 版的 `duckle-runner --pipeline …` 是同一个程序、同一套参数**。

### 2.2 替代路径：release 二进制 + `SHA256SUMS.txt` 校验（**本镜像未采用，留档**）

适用场景：PyPI 不通、或要绕开 pip 解析。实测数据（`v0.7.3` 的 GitHub release API + 资产）：

| 资产 | 大小 | sha256 |
|---|---|---|
| `duckle-runner-linux-x64` | 41326640 | `1a7d4e2bcd3604f1966c74961287a754f965f2c6eb8070fc0b632362cb37e748` |
| `SHA256SUMS.txt` | 606 | — |

> 交叉验证（**两条独立通道同源**）：从 PyPI wheel 里解出的 `duckle/duckle-runner`
> `shasum -a 256` = `1a7d4e2b…cb37e748`，与上面 `SHA256SUMS.txt` 里 `duckle-runner-linux-x64`
> 那一行**逐字节一致**，且两者文件大小都是 41326640。⇒ PyPI wheel 内嵌的就是同一个 release 二进制。
>
> ⚠️ release 资产**只有 `-linux-x64`，没有 `-linux-arm64`**（同 release 的 `Duckle-linux-arm64`
> 是桌面 App，不是 runner）。arm64 机器只能走 PyPI 路径。

## 3. 版本与升级

| 组件 | 本镜像钉的值 | 依据 |
|---|---|---|
| duckle | `0.7.3` | PyPI 实返最新；与 release `v0.7.3` 同一版 |
| DuckDB CLI | `1.5.4`（**传递依赖，非本镜像显式钉**） | duckle 0.7.3 自己的 `Requires-Dist: duckdb-cli==1.5.4` |
| Python | `3.12-slim` | 计划范文同值；duckle 声明 `Requires-Python: >=3.8` |

### ⚠️ 与计划的版本分歧：计划要 `DUCKDB_VERSION=1.5.5`（对齐 pg_duckdb 内核），本镜像**没有照做**

**不是取舍，是根本装不上。** 实测（`pip download "duckle==0.7.3" "duckdb-cli==1.5.5"`）：

```
ERROR: Cannot install duckdb-cli==1.5.5 and duckle==0.7.3 because these package versions have conflicting dependencies.
The conflict is caused by:
    duckle 0.7.3 depends on duckdb-cli==1.5.4
ERROR: ResolutionImpossible
```

即 `duckdb-cli` 的版本**由 duckle 的包元数据独占决定**，在 pip 这一层没有可换的余地。
另有一条同向证据：runner 二进制里带 `target_version 1.5.4` 的版本检查字符串（v0.7.3 二进制实测）。

**为什么这不影响与 pg_duckdb 的协作**：runner 的 DuckDB 只负责**本地/远端 parquet 的读写与转换**，
与 pg_duckdb 那个**嵌在 PG 进程里的** DuckDB 是两个独立实例，二者之间只经过 parquet 文件。
版本对齐是「计划作者的良好意愿」，不是链路要求 —— 但**这条推论本身也没实测过**，
故按根本法则记为 gate（见 §6），**不写成结论**。

**要换 DuckDB 时的正路**：引擎自陈的优先项 `DUCKLE_DUCKDB_BIN`（METADATA 原文：
"To pin your own build instead, set `DUCKLE_DUCKDB_BIN`"；`--duckdb` 的帮助也写明解析顺序
`DUCKLE_DUCKDB_BIN` → runner 同级 `bin/duckdb` → `PATH`）。
**别去改 pip 解析**——那条路已被上面的 `ResolutionImpossible` 封死。

### 升级 duckle 版本时的核对点（照 `deploy/pg-duckdb/README.md §0` 的「版本与 tag 纪律」形态）

1. `duckle` 新版的 `Requires-Dist: duckdb-cli==` 钉到了哪一版（决定引擎版本）。
2. `serve` / `web` 的 `--token` 语义与默认 `--host` 是否变（安全闸靠它）。
3. 跑一遍 §4 的入口用例（entrypoint 的行为断言，不依赖镜像）。
4. `pip install` 后 `duckdb` 是否仍在 scripts 目录里被垫片找到（§2.1 的整条链）。

## 4. 本任务的自证边界（**读这节就知道哪些没验**）

| 项 | 状态 | 证据 / 原因 |
|---|---|---|
| 入口 gate 行为（拒跑 / 透传 / token 名字翻译） | ✅ **已验** | 本机 `sh` 跑 8 条用例，见 §4.1 |
| Dockerfile 结构面（指令集 / ENTRYPOINT 是合法 JSON 数组 / COPY 源存在且未被 `.dockerignore` 排除） | ✅ **已验** | 见 §4.2 |
| `docker build --check -f deploy/duckle/Dockerfile .` | ❌ **未验** | 本机 Docker **daemon 未运行**，实测报 `ERROR: Cannot connect to the Docker daemon at unix:///Users/duo/.docker/run/docker.sock. Is the docker daemon running?`（CLI 29.6.1 / buildx v0.35.0 在场，缺的是 daemon） |
| 镜像能构建成功 | ❌ **未验** | 同上一行：本任务**不构建镜像**（计划 L713 与本任务书都这么定） |
| 容器内 `pip install duckle` 能装上、`duckdb` 落在 PATH 上 | ❌ **未验** | 推论自 §2.1 的两条实测，但**没在容器里跑过**；首次构建时按 §3 核对点复核 |
| 容器内 `duckle --pipeline …` 真跑通一条管线 | ❌ **未验** | 本任务**不跑真管线**；且入口 gate 只保证「参数透传与凭据收口」，不保证引擎与业务 | 

### 4.1 入口用例（本机 `sh` 实跑，桩替身 `duckle` 固定 exit 7 以分辨「透传」）

| # | 入参 | token | 期望 | 实得 |
|---|---|---|---|---|
| 1 | `serve --host 0.0.0.0` | 空 | 拒跑 exit 1 | ✅ exit 1 |
| 2 | `--pipeline x.json` | 空 | 拒跑 exit 1 | ✅ exit 1 |
| 3 | （无参数） | 空 | 拒跑 exit 1 | ✅ exit 1 |
| 4 | `validate --json` | 空 | 透传 exit 7 | ✅ exit 7 |
| 5 | `serve --host 0.0.0.0` | `DUCKLE_CONSOLE_TOKEN=<占位A>`（非真值） | 透传，引擎看到 `<占位A>` | ✅ |
| 6 | `serve --host 0.0.0.0` | 只有别名 `DUCKLE_TOKEN=<占位B>`（非真值） | 透传，引擎看到**翻译后**的 `DUCKLE_CONSOLE_TOKEN=<占位B>` | ✅ |
| 7 | `serve --host 0.0.0.0` | `DUCKLE_TOKEN=`（空串，= T3 compose 的默认形态） | 拒跑 exit 1 | ✅ exit 1 |
| 8 | `validate` | 别名已设 | 透传 exit 7 | ✅ exit 7 |

> ⚠️ **本表只覆盖 `serve` / `--pipeline` / 无参数 / `validate`，以及 token 名翻译 —— 它不描述白名单的边界。**
> 白名单经独立评审（T5 review §3.5）**收窄过一次**：`sequence` / `work` / `deliveries` / `drift` /
> `branch` / `python` 移出（它们会跑管线 / 读活源 / 取包 / 改活库 / 投递出站）；`review` 改为
> **条件**动词（带 `--data` / `--drift` 才要 token）。用例集同时扩到 **51 条**（含主威胁防线
> `serve` / `web` / `--pipeline` / `mcp` / 未知形态，与「保留的本地动词仍放行」两个方向）。
> **名单与逐条理由的唯一事实源是 `entrypoint.sh` 的注释**；本表不复制它，免得又一处漂移。

### 4.2 结构面命令（无 daemon 也能跑）

- 指令集全部合法（无未知指令）；`ENTRYPOINT ["/usr/local/bin/duckle-entrypoint"]` 可被 JSON 解析。
- `COPY` 源 `deploy/duckle/entrypoint.sh` 存在，且**不命中 `.dockerignore` 任何一条规则**
  （规则集 `**/node_modules` `**/dist` `**/out` `**/coverage` `**/*.tsbuildinfo` `.env` `*.local`
  `.tmp` `.git` `.gitattributes` `.github` `.DS_Store`）。

> 这两条**替代不了** `docker build --check`：它们只判「文件长对了没有」，不判构建期解析与
> 依赖解析。别把 §4.2 当 §4 里那两个「未验」的替身。

## 5. 怎么用

T3 的 compose 把 `duckle` 放进 `etl` profile（平时 `up` 不起），按需跑：

```sh
# 跑一条管线（★ 四个资源预算参数必须显式给——见下）
docker compose -f deploy/data-compose.yml --profile etl run --rm duckle \
  --pipeline /pipelines/common/<源>.<表>.json \
  --workspace /workspace \
  --memory-limit 24GB --threads 2 --temp-dir /workspace/tmp --max-temp-size 300GB

# 静态检查（不需要凭据、不需要 DuckDB、不需要网络；退出码 0/1/2 可直接作 CI 门禁）
docker compose -f deploy/data-compose.yml --profile etl run --rm duckle validate --json
```

**★ 为什么必须显式给那四个参数**（spec 2026-09-20 §8，引擎帮助里的原话）：
`--threads` 默认是**每一个核**，会饿死同机其它服务；`--max-temp-size` 不给的话
"DuckDB's own default is 90% of the disk, so without this one large join can fill the volume the OS is on"。
DuckDB 默认 spill 上限 = 磁盘 90%，**共享机上必须收口**。
镜像**不替调用方补默认值**——那会把「谁来定预算」藏进镜像，且这四个参数的**环境变量形态未实测**
（只实测了命令行开关），不许编。

**容器内路径**：`/workspace` = 工作区（命名卷，运行时状态 `.duckle/` `logs/` `runs/` `secrets.enc` 落这里）；
`/pipelines` = 仓内 `duckle/` 目录（**只读**挂载；管线定义的真源在 git，镜像里不存副本）。

## 6. 未验 / 待核对清单（**首次构建与首次真跑时逐条销账**）

1. **`docker build --check`** —— 本机 daemon 未运行，未跑（§4）。
2. **镜像能构建** —— 与 pg_duckdb 一样走 CI dispatch；跑前确认 Actions 额度未挂起。
3. **容器内 `pip install "duckle==0.7.3"` 的实际解析结果** —— 是否恰好 `duckdb-cli==1.5.4`；
   `duckdb` 是否落在 PATH（§2.1 的两条推论未经容器实跑）。
4. **`--token` 之外的控制台面** —— 本镜像只收口了「空 token」这一缺口。引擎还有 OIDC 登录与
   `console add-user` 两条建号路径（二进制字符串实测，见 §7），**本任务未评估**；
   首次部署前若要对外暴露控制台面，须另立处置。
5. **DuckDB 版本分歧** —— 计划要 1.5.5、上游钉 1.5.4（§3）。是否需要为 pg_duckdb 协作而对齐，
   **待有人拿实测结论**；在拿到之前，读作「两个独立实例，只经 parquet 交互」。
6. **duckle→ZOS 直写** —— 见 `duckle/README.md` 开头；本任务不跑真管线，验证归 W1g（T6）。

## 7. CLI 面速查（v0.7.3 二进制实测，非官方文档抄录）

来源：从 PyPI wheel 解出的 `duckle/duckle-runner`（linux-x64）二进制字符串。
**这是「引擎这一版实际印出来的字」**，但**没有在容器/真机上实跑过这些命令**。

```
duckle-runner --pipeline <file.json> [options]      # 跑一条管线（无子命令即此形态）
duckle-runner validate [<file.json> ...] [--json]   # 静态编译检查；无凭据/无网络/无 DuckDB
duckle-runner test [<file.test.json> ...]           # 单节点断言；断点上游不跑、下游不写
duckle-runner serve [--host] [--port] [--workspace] [--duckdb] [--tick-interval] [--token]
duckle-runner web --dist <dir> [--host] [--port] [--workspace] [--token]   # 编辑器 spike
duckle-runner console add-user|list|key-add|key-list|key-revoke
duckle-runner catalog|review|drift|audit|branch|import|runs|sql|components|python|xsd|cache|work|…
```

- ⚠️ **上面这份是「引擎有哪些子命令」，不是「入口闸放行哪些」**——两者别混读。
  入口闸只放行**不读活源、不写 sink、不出网**的本地动词
  （`validate` / `test` / `catalog` / `sql` / `components` / `xsd` / `console` / `cache` /
  `import` / `runs` / `audit`），`review` **仅**在纯静态（不带 `--data` / `--drift`）时放行。
  上表里的 `drift` / `python` / `work`、以及 `sequence` / `deliveries` / `branch`
  **不在**名单内（读活源 / 取包 / 跑管线 / 改活库 / 投递出站），无 token 一律拒跑。
  逐条理由见 `entrypoint.sh` 的注释。
- **`--token` 只属于 `serve` / `web`**，不是全局开关；环境变量形态是 **`DUCKLE_CONSOLE_TOKEN`**
  （`serve --help` 的 `--token` 条目自陈 "also DUCKLE_CONSOLE_TOKEN"）。
- **`validate` 不吃 `--duckdb`**（它不碰引擎）；跑管线才需要。这是既有经验库里记过的踩坑同一条。
- 退出码稳定：`0` 干净 / `1` 有真发现（管线失败或编译不过）/ `2` runner 起不来（用法错、缺引擎）。
- `serve` 默认 `127.0.0.1:8080`；`--duckdb` 解析顺序 `DUCKLE_DUCKDB_BIN` → 同级 `bin/duckdb` → `PATH`。
- ⚠️ **`serve` 绑非回环且无凭据 ⇒ UNCLAIMED 15 分钟认领窗**（`--help` 原文），本镜像的入口
  正是为堵这一条而存在（见 `entrypoint.sh` 文件头）。
