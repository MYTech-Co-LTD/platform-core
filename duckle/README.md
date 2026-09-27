# duckle/ — 管线定义骨架

> **本目录只放「目录与命名约定 + README」，不放管线 DSL 范文。**
> 理由写在 §4：duckle 的管线 JSON 是**引擎格式**，本仓没有可跑的引擎实例来核对写出来的范文
> 是不是真能 load —— 按根本法则「不许编」，宁可不给范文，也不给一个看起来像样的假样例。

---

## 1 ⚠️ duckle 直写天翼云 ZOS：**口径已订正**（动手前必须先读这一节）

**计划与 spec 的旧口径**：`plans/2026-09-22-data-stack.md` L688 与
`specs/2026-09-20-data-stack-module-design.md` §8 都写着「**duckle 原生 s3 sink 直连天翼云 ZOS
反复 403、两条既有条目判定能力空白**」。

**经验库现状（本任务实测检索，2026-09-22）**：这个口径**已经过期**。那两条条目里的一条
（《Duckle 原生 s3 sink 直连天翼云 ZOS 403 根因调查》，`wiki.hookflow.cn` 研发运维经验库）
**自己带着 2026-09-17 的订正与真机实测**，把「能力空白」这个结论**下宽了**：

> §七【2026-09-17 订正】：结论下宽了 —— duckle **有**直写自定义 S3 端点的 sink。
> 当时只试了 `snk.parquet` 和 `snk.s3`，**没试 `snk.minio`**。

### 1.1 三条 sink 的实测对照（ZOS 写入）

| sink | 官方组件说明 | 对天翼云 ZOS | 失败形态与根因（实测） |
|---|---|---|---|
| `snk.parquet` | 本地文件控件，**无** `endpoint` / `urlStyle` 字段 | ❌ | **403**。抓包实证：请求 dial 的是 **AWS 默认端点**（`<桶名>.s3.amazonaws.com:443`，桶名见经验库原文；此处不写明文）——**根本没到 ZOS**，是 AWS 拿天翼云的 AK 签名后被拒 |
| `snk.s3` | Write via DuckDB httpfs（面向 AWS 默认端点） | ❌ | **404**（与上面的 403 形态不同）。端点字段齐、URL 也按 path-style 拼对了，但仍不互通 |
| **`snk.minio`** | **"Write via S3-compatible endpoint"** | ✅ **可直写** | — |

### 1.2 `snk.minio` 的填法（真机实测）

`endpoint` 填**不带 `https://`** 的 host（与 DuckDB httpfs 那套口径一致）、
`urlStyle` 选 **`path`**、`useSsl` 选 **`true`**；配合 `format=parquet` / `mode=overwrite` / `compression=zstd`。

实测证据强度（2026-09-17，在 `weknora` 机上的部署型 `duckle-runner` + `duckdb` 实跑）：

- `duckle-runner validate` 通过（`2 stages, 0 failed`）；`run` 两次均 `status: ok`
- **两条独立通道回读**对象存储（DuckDB httpfs + `curl --aws-sigv4` 列对象）都证实对象真的在
- 重跑幂等：ETag 与 Size **两次逐字节一致**，`KeyCount=1` 无重复对象

### 1.3 本仓据此采取的口径

- **不再写「能力空白」**。计划 L688 那句按本节订正；`specs/2026-09-20-…-design.md` §8 里的同句
  仍是旧稿，**改动 spec 不在本任务的文件面内** ⇒ 已在 T5 报告里列为待协调项。
- **也不写「已验证可用」**。本任务（T5）**不跑真管线** —— 上面是**经验库的真机实录**，
  不是本仓在这套部署上的复现。⇒ 本仓的验证归 **W1g（T6）**，它有计划内的核对步：
  能直写则记结论、不能则记「经 dbt/中转落盘」的替代路径结论，**不静默绕过**。
- **退路仍然有效**：本地湖 + DuckDB httpfs 上传（`CREATE SECRET` 指 `endpoint` + path-style
  + SSL，再 `COPY … TO 's3://…'`）。这条**已投产**，`snk.minio` 出问题时回退到它，不是回退到「空白」。

### 1.4 两条随这件事一起搬运的教训

1. **「试了某个组件不行」≠「引擎不支持这件事」。** 同一类里要横向都试过再下结论
   （对象存储有 s3 / minio / r2 / b2 四个候选），而且**下结论前先问引擎**——
   `list_components(kind=sink)` / `get_component_schema` 能直接列出每个组件的**真实字段**，比外推可靠。
2. **「引擎说 ok」≠「对象真的到了」。** `k1 ok (3 rows)` 只是引擎自认为成功；
   **必须回读对象存储**才算数（这正是经验库《数据管道的「完整/不重复/无脏」可验证范式》的「自证」那一层）。

## 2 目录与命名约定

```
duckle/
├── README.md
├── common/
│   ├── README.md
│   └── <源>.<表>.json              ← 管线定义
└── customers/
    └── README.md                   ← 客户级覆盖（形态同 contracts/customers/）
```

- **一个管线 = 一个数据源的一张表**，文件名 `<源>.<表>.json` —— **与 `contracts/` 的契约同名**
  （`contracts/common/douyin.sku_daily.json` ↔ `duckle/common/douyin.sku_daily.json`）。
  **同名不是巧合，是耦合的可见化**：两者讲的是同一张表，改名要一起改。
- 客户级覆盖放 `customers/<客户>/`，形态见 `customers/README.md`。
- **`_ops` 不在本目录的仓内约定里**（见 §5）。

## 3 三件套同构（一个新源 = 三个文件同一个 PR）

| 件 | 文件 | 讲什么 |
|---|---|---|
| 契约 | `contracts/<域>/<源>.<表>.json` | 落盘定型目标（列/类型/分区/批次标记） |
| **管线** | `duckle/<域>/<源>.<表>.json` | **怎么取数、怎么按契约落盘** |
| staging | `dbt/models/…/stg_<表>.sql` | 一对一取列并定型 |

出处：`docs/architecture.md` §5.1 第 2 条。**该纪律是流程约束，当前无静态门禁**（同文件 §2 已言明）。

## 4 为什么这里没有管线范文

duckle 的管线文件是**引擎格式的 JSON**，其结构（节点 id / `data.componentId` / `properties` /
`data.schema` 的位置等）**只有对着真引擎核对过才算数**。本仓**没有可跑的引擎实例**
（镜像尚未构建、也没有本地 duckle），所以按「不许编」：

- 本目录**只给命名与目录约定**，不给任何 YAML/JSON 样例；
- 需要范文时，**从真引擎产出**——用 duckle 自己的 MCP（`list_components` / `get_component_schema` /
  `create_pipeline` / `validate_pipeline`）生成并 `validate` 通过后，再落仓。

**要写管线前先读**（经验库已记的踩坑，都是真机实测，别重踩）：

- `src.rest` 对 **0 行响应直接报错** ⇒ 必须声明 `data.schema`；**嵌套数组列不要声明**
  （声明 `items: json` 会让真实数据的 `list<struct>` 变成 json，下游 `UNNEST` 直接报错）
- `qa.expect` 输出的是**记分卡**（一行一规则），主链路做校验 gate 要用 **`qa.contract`**
- **`ctl.foreach` 子管线里 `ENV 变量` 与 `connectionRef` 都失效**（实测 HTTP 401）⇒ 多账套
  别指望 foreach 带凭据
- `变量 workspace` 在 run 时不解析 ⇒ **路径一律用绝对路径**
- `--log-dir` 会在其下建 `【name】/runtime.log` 子目录 ⇒ 日志采集 glob 要带 `**/*.log`

## 5 与容器运行时约定的衔接

`deploy/data-compose.yml`（T3）把本目录**只读挂进 runner 容器**：

| 容器内路径 | 宿主 | 说明 |
|---|---|---|
| `/pipelines` | 仓内 `duckle/` | **只读**。管线定义的真源在 git，镜像里不存副本 |
| `/workspace` | 命名卷 `duckle-workspace` | 工作区；运行时状态（`.duckle/` `logs/` `runs/` `secrets.enc`）落这里，**不进 git** |

⇒ **本目录里只会出现管线定义文件**。引擎的运行时产物落在卷里；若有人在宿主的 `duckle/` 里
本地跑引擎，产物会被 `.gitignore` 挡住（见根 `.gitignore` 的 duckle 段）。

### 关于 `_ops`

`docs/data-platform-handbook.md` §2 提过 `duckle/<域>/_ops/…`（**该条已按本节的实测订正**）。
**它是一条「数据湖路径」，不是本仓的目录约定**：`_ops` 在 v0.7.3 的 runner 二进制里
**检索不到**（实测 `strings` 无 `_ops` 相关产物名），它是桶里的路径而不是引擎的本地状态目录。
⇒ 若有人在宿主 `duckle/` 下把湖物化出来，`.gitignore` 里的 `duckle/**/_ops/` 会挡住它；
**这条规则的实际触发概率低**，属防御性冗余——**不要把它读成「duckle 会生成 `_ops/`」**。

## 6 未验 / 待核对清单

1. **duckle→ZOS 直写**（§1）—— 本任务不跑真管线，验证归 W1g（T6）。
2. **管线 JSON 的实际结构** —— 无范文（§4），随第一个源的接入 PR 由真引擎产出。
3. **`snk.minio` 产出与契约 `layout` 的拼法是否天然一致**（`key` 前缀 / 分区目录 / `all.parquet`
   文件名）—— 未验；须在接入 PR 里对着引擎核，见 `contracts/README.md` §9 第 5 条。
4. **契约里的类型 ↔ duckle `data.schema` 类型枚举的逐项映射** —— 未实测核对。
5. **资源预算四个参数**（`--memory-limit` / `--threads` / `--temp-dir` / `--max-temp-size`）——
   引擎帮助已实测（见 `deploy/duckle/README.md` §5），但**本仓的部署里给什么值未定**，
   且**环境变量形态未实测**（只实测了命令行开关）。
6. **引擎能力接入的三条坑与九项未验** —— 见 §7（C3 的三条坑**已实测，按纪律对待**；C4 的五项**扩到八项**，
   W1 观测面任务再补**第 9 项**，**都是 gate**）。

## 7 引擎能力接入（spike 实测结论，2026-09-23）

> **本节是「duckle 的哪部分能力本仓要接、接得上多少」的正典**（接手方先读 `docs/architecture.md`
> §2.2 第 2 条）。逐条区分**原生可替代 / 半替代 / 仍需自建**——**别把三者读成一回事**。

### 7.1 三条**原生可替代**（用引擎自己的面，不自己造）

| 要的能力 | 用 duckle 的什么 | 形态 |
|---|---|---|
| **列漂移门禁** | `drift` | 抓 **missing / added / typeChanged** 三类，**exit 1** |
| **落地契约校验** | `node.data.schema` + `qa.contract`（**+ `drift`**） | 按声明定型，不符即失败（**不静默降成 VARCHAR**） |
| **管线级血缘** | `catalog build` → `.duckle/catalog.json` | 含 **lint / orphans / owners** |

### 7.2 一条**半替代**（一半靠引擎，一半**仍需自建**）

**新鲜度**：`run receipt` + `logs/duckle_metrics.prom` + `qa.freshness` 能给**上次成功时间**与**行数**
——**但「输入指纹」引擎自陈未按 run 记录** ⇒ 这一半**仍需自建**。**别把「有时间戳」当成「有输入指纹」。**

### 7.3 三个坑（**写成纪律，不许漏**）

1. ⚠️ **`drift` 在「源未声明 schema」时静默 `exit 0`（假绿）** ⇒ **门禁必须先断言「声明存在」**，
   再判 drift 的结论。只看退出码 = 把没声明当成没漂移。
2. ⚠️ **`qa.freshness` 对 UTC 列按本地墙钟算（实测偏 +8h）** ⇒ 用它**必须强制时区对齐**
   （本仓铁律：时间一律 **RFC3339 UTC**）。不钉时区就会得出「数据晚 8 小时」的假告警，
   或反过来**把真延迟判成新鲜**。
3. ⚠️ **`pipelineHash` 是「代码指纹」，不是「数据指纹」** ⇒ **不能**用它判「输入数据变没变」。
   判定输入变化要靠**自建的输入指纹**（见 §7.2）。

### 7.4 未验清单（**这些是 gate，不是「大概可以」**）

1. **远端源（S3 / PG / REST）上的 `drift`** —— 未验（本机只验到本地形态）。
2. **`review --data` / `review --drift`** —— 未验。
3. **容器内行为** —— 未验（实测机的 docker daemon 未运行；镜像也未构建，见 `deploy/duckle/README.md` §4/§6）。
4. **非回环 `UNCLAIMED` 分支** —— 未验（安全闸覆盖了「空 token」，其余控制台面见 `deploy/duckle/README.md` §6 第 4 条）。
5. **跨组件 parquet 格式兼容（写方比读方新）** —— 未验：本 runner 自带的 DuckDB 是 **`1.5.4`**
   （`duckle==0.7.3` ⇒ `duckdb-cli==1.5.4`，**写** parquet 的一方），而消费侧 pg_duckdb
   （官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`）是 **`1.4.3`** ⇒ **写方比读方新**。
   真机**必验一条**：**用 duckle 写一个 parquet ⇒ 让 pg_duckdb `read_parquet` 读**（读得出、列类型符合预期）。
   这条是**镜像从「自建（DuckDB v1.5.5）」切到「官方镜像（v1.4.3）」时新引入的面**——
   归 **T6 的 Gate-E**（计划 `docs/superpowers/plans/2026-09-22-data-stack.md` Task 6 Step 1 第 10 项）。
6. **`release` CLI 在本项目 compose 上可用** —— **已验：支持**（2026-09-27，**真机 · 数据面机
   64188 账套**；证据 `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-4-report.md`）：
   机 = `platform-core-shanhai-data`（`proj_AFbJvyb0onaX7LVr`）/ 服务 `lemeng-console-64188`
   （`svc_u4pvEqZPfstnE5vI`），duckle **0.7.3**，**不需要 docker / 网络**——「未知子命令 / 要 docker」
   那条不成立。
   ① **入口**：**`duckle-runner` 不在 PATH**（`sh: not found`，exit 127）⇒ 用 PATH 上的
   **`duckle release …`**，或全路径 `/usr/local/lib/python3.12/site-packages/duckle/duckle-runner`。
   ② `build` exit 0 ⇒ **hash 寻址**的 release id（`8be4835f…`）；`list` / `verify`（打印 `verifies`）/
   `diff` 均 exit 0。
   ③ **`activate` 必须带 `--environment E`**（省略 ⇒ exit 2）；**`rollback` 要两次 release 才有
   `previous`**（只有一次 ⇒ **exit 1** `has no previous release to go back to`）⇒
   **「`build` → `activate` → `rollback` 一次到底」不成立，回滚面至少要有两版**。
   ④ ⚠️ **`activate` / `rollback` 都 `materialise`**：把快照的控制面文件**写回 workspace**、
   并**移除快照里没有的**控制面文件（实测打印 4 条路径）；
   ⚠️ **`activate` 在 workspace 有 drift 时拒绝**（除非 `--force`）——**源码级，未在本环境复现**：
   出处 `duckle@v0.7.3`（与容器内 `duckle==0.7.3` 同版）`crates/duckle-runner/src/release_cmd.rs:305–318`
   ——`release::drift(&ws, &release)` 非空且未给 `--force` ⇒ 打印 `would overwrite …` /
   `would remove … (not part of this release)` 并 **exit 1**；drift 的定义是逐文件比 sha256，
   见 `crates/duckdb-engine/src/release.rs:341`。**此闸只在 `activate`**：`rollback`（同文件 `:375`）
   **刻意不过 drift 闸**。最小验证动作（**未做——需再进生产，本轮未做**）：scratch 工作区 `build` 后
   手改任一控制面文件 ⇒ `activate` 应 exit 1；加 `--force` ⇒ 应 exit 0。
   ⑤ ⚠️ **W2 用它之前必须先知道**：本项目 `schedules.json` 是**运行状态**
   （`last_run_at` / `last_run_status` 由 console 写），而 release 把它**整份**当控制面快照 ⇒
   **rollback 会把调度记账回退到快照时刻**（实测：`4085e3b4…` → 模拟一次运行 `786bdde1…` →
   activate 后仍 `786bdde1…` → rollback 后**回到** `4085e3b4…`）⇒
   **别把 release 当「不含状态的配置回滚面」**。
   ⑥ **「不含密钥」名副其实**：store 里只有 release doc（键 `files` / `formatVersion` / `id` /
   `pipelines` / `schedulesHash` / `schemaVersion`）+ 内容寻址对象副本；`DUCKLE_TOKEN` /
   `LEMENG_TOKEN` / `ZOS_ACCESS_KEY` / `ZOS_SECRET_KEY` / `ZOS_BUCKET` / `ZOS_ENDPOINT` 逐值
   grep **全 absent**（**只判有无、未回显任何值**）。⚠️ 但这条保证是**条件性**的——成立的前提是
   「凭据在 env、不在文件」；凭据一旦写进控制面文件，release 会照单收下。
   ⑦ **验证姿势（生产零接触）**：在该卷的 **scratch 副本** `/workspace/tmp/relws`（3 个 pipelines +
   `schedules.json` 的**逐字副本**）上跑全链，跑完删除 ⇒ **生产控制面文件 sha256 前后逐字不变**
   （`4085e3b4…` / `a19c1453…` / `df0a3cb3…` / `54e57b13…`）。
7. **两端外壳保真度（占位符替换 / 默认并发）** —— ⚠️ **先把面别摆明**（标题的「两端」= 桌面 / 服务端，
   而**实测只落在 Rust 外壳侧**、**桌面这一端本轮未实测** ⇒ **别读成「两端都验过并一致」**）：
   **已验的只有 Rust 外壳侧**（①CLI 与 ②`serve` 的 HTTP 面，**同一条 `apply_time_builtins`**）——
   两侧都把 `${date}` 解成同一天（UTC）、**实测并发默认 = 1**；**调度器侧**同名 `default` 默认 = **8**
   （**源码级，未在本环境复现**，见 ⑤）；**桌面侧未实测**（③ 只到 TS 源文件级；桌面 App 的 8 = 源码级，见 ③⑤）。
   （2026-09-27，**真机 · 数据面机 3120 账套**；证据
   `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-5-report.md`）：
   机 = `platform-core-shanhai-data`（`proj_AFbJvyb0onaX7LVr`）/ 服务 `lemeng-console-3120`
   （`svc_srQwfTvdkjxbCeoA`，`commandArgv: serve --host 0.0.0.0 --port 18080 --workspace /workspace
   --duckdb /usr/local/bin/duckdb`）/ 卷 `openship-platform-core-shanhai-data-lemeng-console-3120-ws`
   （**全名，理由见第 9 项 ② 的 ⚠️**），容器内 duckle **0.7.3**、DuckDB **1.5.4**。
   探针 = `src.inline`（`columns` 放 `${date}` / `${datetime}` / `${now}`）→ `snk.csv`
   （`${workspace}/tmp/probe-${date}.csv`），**同一份字节**（sha256 `22f459b3…`）在 **Rust 外壳侧的两个入口**
   （①②）各跑一次：
   ① **CLI 侧**（容器内全路径 `…/duckle/duckle-runner`；`validate` exit 0，run `status: ok` 86 ms）⇒
   文件名 `probe-2026-09-27.csv`，行值 `2026-09-27` / `2026-09-27_030734` / `2026-09-27T03:07:34Z`。
   ② **HTTP 侧**（`POST /api/run`，body `{"file":"tmp/_probe.date.json"}`）⇒ **HTTP 200 且 body
   `status:"ok"`**（61 ms）⇒ 同一文件名，行值 `2026-09-27` / `2026-09-27_030740` / `2026-09-27T03:07:40Z`。
   两侧 `${now}` 与容器 `date -u` **逐秒相同** ⇒ **无缺口、均为 UTC**。
   ⚠️ 但 ① 与 ② **都是 Rust 外壳**（同一 `apply_time_builtins`）⇒ **这两条只证「同一外壳的两条入口一致」，
   不证「桌面 / 服务端两端一致」**；真正的 TS/Rust 分叉见 ③（而 ③ 只到源文件级，桌面 App 仍未验）。
   ③ **桌面（TS）侧**：`frontend/src/run-resolve.ts` 的 `formatTimeBuiltin` 全用 `getUTC*`，与 Rust
   `context.rs:110 format_time_builtin` 逐字段同形；以 `TZ=Asia/Shanghai` 直接执行该源文件 ⇒ 宿主本地
   `11:08:50 +0800`，而 `date` / `datetime` / `now` 仍是 `2026-09-27` / `2026-09-27_030850` /
   `2026-09-27T03:08:50Z` ⇒ **同一 UTC、不吃宿主时区**。**跑的是 TS 源文件本身，不是打包 App** ⇒
   桌面 GUI 未验（无桌面运行环境）。
   ④ **Rust 外壳侧（CLI 与 `serve` 的 HTTP 面）默认并发 = 1（实测坐实，只限此面）**：容器 env 无
   `DUCKLE_MAX_CONCURRENT_RUNS`、无 `DUCKLE_POOLS_FILE`，工作区无 `.duckle/pools.json` ⇒ 该面默认池上限 1
   （`pools.rs:63 env_default`）。**它 ≠「服务端 = 1」**——服务端同进程里的**调度器**走**另一条**限流器、
   默认 **8**（源码级，见 ⑤）。两个 `sleep 8` 探针**同时**
   `POST /api/run/async` ⇒ 乙 `queueMs: 0`、甲 **`queueMs: 8267`**（≈乙 `durationMs 8264`），且甲的
   `startedAt` = 乙的完成时刻 ⇒ **串行**；两份 receipt 都落 `resourcePool: "default"`。
   ⚠️ **判定口径**：**`/api/run/status` 的 `state: "running"` 不是「正在执行」**——它把排队中的甲也报成
   `running`（与 receipt 的 `queueMs: 8267` 直接矛盾）；真因是 `serve.rs:3963` 在**取许可之前**就把
   pipeline id 塞进 `state.running`，而 `run_lock.acquire` 在 `:4057`（该字段的注释 `:3002-3004`
   与实现不符）。且 **`queue_ms` 只写在 receipt 里**（`serve.rs:1249`），**任何 HTTP 响应都不带**
   ⇒ **排队时长只能读 `<ws>/runs/receipts/<runId>.json`**。
   ⑤ ⚠️ **「8」在另一条限流器上，不是 runner 的**：`crates/scheduler/src/lib.rs:1060` 的调度信号量
   `.unwrap_or(8)`，且它对自己的 default 池**保留 8**（注释自陈「deliberately generous rather than 1」）⇒
   **同一个 `default` 名字，Rust 外壳侧 1 / 调度器侧 8**——同进程**两个**限流器，正是该模块注释所告的形态。
   ⚠️ **这条 8 属「源码级，未在本环境复现」**：本轮实测只覆盖 Rust 外壳侧那一侧，调度器侧的排队行为未取证。
   ⚠️ **`serve.rs:182 max_concurrent_runs()` 在 0.7.3 是死代码**（只有定义、无调用点），真正生效的是
   `pools.rs:63 env_default()` ——读这一项别读错函数。
   ⚠️ **桌面 App 的 8 = 源码级，未在本环境复现**（出处是既有记载「桌面 scheduler 默认 8」，
   `docs/data-platform-handbook.md:147`；本轮**没在桌面上取过证**，也没回源复核它在 0.7.3 的落点）。
   **最小验证动作（未做——本环境没有可运行的桌面产物）**：在桌面侧沿**会取并发许可的那条路径**（调度触发）
   同时排两条 `sleep 8` 管线，看第二条是**并发**还是**排队** ⇒ 并发即排除「桌面默认 = 1」（与记载的 8 相符）；
   排队则桌面侧默认也是 1、与记载不符。⚠️ **别拿手动 Run 当判据**——既有记载说桌面手动 Run
   **不取运行锁**（`docs/data-platform-handbook.md:276`）。
   ⑥ **两条新差异**（W1/W2 用得上）：**(a) CLI 这次真写了运行历史与 metrics** ——
   `runs/_probe.date.json` 里 **两次都在**（`…454477` CLI 86 ms / `…460858` HTTP 61 ms）、
   CLI 的 receipt 也在盘、`duckle_runs_window{pipeline="_probe.date",status="ok"} 2` ⇒ 与上游
   `docs/current/ci-and-orchestration.md`「CLI：Records run history = No / Updates the metrics file = No」
   **不符**（0.7.3 实测）；**(b) CLI 的 receipt 无 `queuedAt`/`startedAt`/`queueMs`**（console 侧有）⇒
   「等了多久」只有 console 侧答得出。
   ⑦ **取证姿势与残留（如实记）**：探针只写 `/workspace/tmp/`（跑前不存在、跑后 `rm -rf`）+ 探针名下的
   lock（已删）；`schedules.json` 与 3 条生产管线 sha256 **前后逐字不变**（`9156af41…` `a19c1453…`
   `df0a3cb3…` `54e57b13…`）。**HTTP 跑不可避免地在 console 自己的记账面留下探针记录**：
   `logs/_probe.{date,slow.a,slow.b}/`、`runs/_probe.*.json`、`runs/receipts/run-*_probe*`（4 个）、
   `logs/duckle_metrics.prom` 的 `_probe.*` 序列、`logs/audit.ndjson` 追加行；**未手工清理**
   （那要手改 console 活状态，超出授权）。`schedules.json` / `occurrences.ndjson` **未被触碰**。
8. **`ext.*` 在本项目 console 镜像里的可用面** —— **已验 4 项**（2026-09-27，**本机隔离实验室、
   零生产**；证据 `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-2b-report.md`
   与 `/tmp/duckle-lab-p1/wsext/evidence-*.txt`）：
   ① **能在真 pipeline 里 `spawn` 并完成数据往返**（`src.csv → ext.probe → snk.json`，sink 真拿到 3 行）；
   ② **子进程继承宿主 env**（`sha256` 前 8 位与独立算出的逐位相符）；
   ③ **`components conform` 10 passed / 0 failed**（引擎自带 10 用例行为验收套件）；
   ④ **`build` 产物不打包 `components/`**（产物清单只有 `bin/duckdb` / `pipeline/*.json` /
   `secrets.env.example`；把它搬到**无 `components/` 的裸目录**隔离跑 ⇒ **exit 1**，报错干净、
   点名 `looked in components/`）⇒ **带 `ext.*` 的分发必须随附 `components/`**。
   **已验：能解析 `pg_duckdb`**（2026-09-27 第三轮实测，**本机隔离实验室 `/tmp/duckle-lab-p1`、
   零生产**；证据 `/tmp/duckle-lab-p1/wsext/evidence-pgduckdb.txt` 与同目录
   `report-pgduckdb-gate8.md`）——判据形态 = **引擎 spawn 的 ext 组件**
   （`components/ext.pgprobe/`）**经 postgres 线协议连真 `pg_duckdb`**：官方镜像
   `pgduckdb/pgduckdb:18-v1.1.1`（digest `sha256:44c88eb92079…`；实测 PG 18.1 +
   pg_duckdb 扩展 1.1.0 + 内嵌 DuckDB v1.4.3）。
   ① **CLI `validate` exit 0**（含 `ext.*` 的管线；MCP 面不可用的既有 blocker 不变，见下 🚧）；
   ② **run `status: ok`**（`run-manual-ext-pgduckdb-1790504959104`，`n2 rows=3`）；
   ③ **三条方言证据**：`r['列名']` 下标（**函数别名形态**）3 行；用返回值构造的二次查询 1 行
   （**证明往返真实**）；`duckdb.query` 内 `[1,2,3]` 列表字面量（**原生 PG 语法错误 ⇒
   DuckDB 方言坐实**）；
   ④ **主验证的 parquet 由 pg_duckdb 自己写**（写方 `1.4.3` ⇒ **把 duckle `1.5.4` 写方
   隔离出本 gate**）；
   ⑤ ⚠️ **副产品观察（只登记，不并入第 5 条 gate）**：duckle `1.5.4` 写的 parquet 被
   pg_duckdb `1.4.3` 读通；镜像直连拉取失败（context deadline）改用本机经 `docker.1ms.run`
   镜像源拉得的同 tag 镜像（digest 锚定 + 可运行冒烟），**未改任何 Docker 全局配置**；
   ⑥ ⚠️ **未测边界（如实列）**：dbt 本体、console 容器内形态、s3 远端、并发/超时。
   口令纪律：密码只经 env 传入（管线文件仅记引用名 `passwordEnv`）+ sha8 双向核对，零明文。
   🚧 **blocker（必须先知道）**：**MCP `validate_pipeline` 把 `ext.*` 判成 preview 组件而直接失败**
   （`(ext.probe) isn't executable on the DuckDB engine yet - it's a preview component.`）
   ⇒ **校验含 `ext.*` 的管线不能走 MCP，改用 CLI `validate`**（同一份管线 CLI 放行、`exit 0`；
   ⚠️ 但 CLI 也**查不了 ext 组件的属性** ⇒ **属性名写错能过 `validate`、到运行时才炸**）。
   ⚠️ **`catalog` 与 MCP 都看不见 `ext.*`**（`components schema --json` 411 项里 `ext.*` 为 **0**；
   MCP `list_components` / `get_component_schema` 同样返回不了）——**唯一**能发现它的列举面是
   **`duckle components external --workspace <ws>`**。
   ⇒ W4 前置 gate 三项，现状 **3/3 全清**（「能否解析 `pg_duckdb`」已于 2026-09-27 第三轮实测清账）
   + **上面这条 blocker 仍在**。
9. **生产采集 run 的引擎原生观测面「在哪个 workspace」** —— **已验：job 侧与 console 侧是
   两个卷、互不可见**（2026-09-27，**真机 · 数据面机 3120 账套**；证据
   `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-6-report.md` 与 issue #210）：
   ① **openship job 侧**（`lemeng-retail-3120-runner`，`sh /opt/lemeng-run.sh windows`）的 run 落在
   **`platform-core-data_duckle-workspace`** 卷——实测 09-27T02:30Z 那轮 **24 窗的 `run_id` / `rows` /
   `duration_ms` 全在该卷 `runs/lemeng.retail_order_line.json` 里**；② **console 侧**（容器
   `openship-platform-core-shanhai-data-lemeng-console-3120` 常驻 `serve`）落在
   **`openship-platform-core-shanhai-data-lemeng-console-3120-ws`**，**是另一个卷**。
   ⚠️ **两个卷名一律用 `docker volume ls` 的全名**：短名 `lemeng-console-3120-ws`
   **在 `docker volume ls` 里不存在**（openship 部署时另起卷名）⇒ **认卷别用短名**。
   **怎么认出的**（2026-09-27，数据面机 `113.249.104.181`／`10.0.0.5`，**openship MCP 只读**）：
   `docker volume ls --format '{{.Name}}'` 出全名；`docker inspect` 那只 console 容器见
   `volume …-lemeng-console-3120-ws -> /workspace`；两卷的**分属**由载体坐实——job 侧是宿主机
   `docker compose run --rm`（`deploy/data-compose.yml`，其 `name: platform-core-data`）的默认卷名
   `<project>_<volume>`，console 侧是 openship 起的卷。
   ⚠️ **「项目」这一层按原始标签逐字重写（2026-09-27 只读取证 · 数据面机 `113.249.104.181`／`10.0.0.5` · `openship MCP`）**：
   ⓐ **job 那卷有 compose 标签** —— `docker volume inspect platform-core-data_duckle-workspace --format '{{json .Labels}}'` 回
   `{"com.docker.compose.config-hash":"f384111d…","com.docker.compose.project":"platform-core-data","com.docker.compose.version":"5.5.0","com.docker.compose.volume":"duckle-workspace"}`
   ⇒ 它确是 compose 项目 `platform-core-data` 的卷（`deploy/data-compose.yml:5` 的 `name:`）。
   ⓑ **console 那卷一个标签都没有** —— 同命令对 `openship-platform-core-shanhai-data-lemeng-console-3120-ws` 回 **`null`**
   ⇒ **它是 openship 起的卷**，其上拿不到任何 compose 归属（卷名形如 openship 命名空间
   `openship-platform-core-shanhai-data` ＋服务自报卷名 `lemeng-console-3120-ws`；`64188` 同形，**2/2 一致**）。
   ⚠️ **「前缀 ＋ 服务自报卷名」这一层是「推断」、不是实测**：本轮只验了 **2/2 同名规律**，
   **未读 openship 源码**逐字验证拼接机制 ⇒ 只写「2/2 一致」，**不写「openship 的实现是……」**（无案例不立标准）。
   ⓒ **带 compose 标签的是那只容器、不是它的卷** —— `docker inspect openship-platform-core-shanhai-data-lemeng-console-3120 --format '{{json .Config.Labels}}'` 回
   `{"com.docker.compose.project":"platform-core-data","com.docker.compose.service":"duckle","com.docker.compose.version":"5.5.0","openship.deployment":"dep_rTS9-HYzqkAuG89n","openship.project":"proj_AFbJvyb0onaX7LVr","openship.service":"lemeng-console-3120"}`
   ⇒ **两个名字空间要分开看**：`com.docker.compose.project` = `platform-core-data`（来自 compose 文件 `name:`），
   而 openship 的**网络与卷名**一律走 `openship-platform-core-shanhai-data`（该容器实挂网络即此名）。
   ⇒ ⚠️ **「两卷同属一个项目」不成立，「两卷分属两个 compose 项目」也不成立**——差别在**谁创建了卷**：
   **job 那卷是 compose 建的（有标签），console 那卷是 openship 建的（无标签）**。
   ⚠️ **对 W2（3120 切 console、job 退役）的含义**——**「改哪里」按仓内文件逐字核过（2026-09-27）**：
   卷的**定义就在 `deploy/data-compose.yml`**（**不是**「只在 openship 项目配置里」）——顶层 `volumes:`（`:164-172`）
   声明 `duckle-workspace` / `lemeng-console-3120-ws` / `lemeng-console-64188-ws`（＋`pgduckdata` / `mbdata`），
   服务里再各映射一次（`:87` 的 `duckle-workspace:/workspace`、`:133` 的 `lemeng-console-3120-ws:/workspace`、
   `:156` 的 `lemeng-console-64188-ws:/workspace`）；该文件即数据栈部署单元的 compose
   （`deploy/customer-onboarding.md:30` / `:161` 的 `composePath=deploy/data-compose.yml`）。
   **openship 项目配置侧声明的卷串与它逐字相同**（`duckle-workspace:/workspace` / `lemeng-console-3120-ws:/workspace` /
   `lemeng-console-64188-ws:/workspace`）——**openship 独有的只是 `namespaceVolumes:true` 带来的前缀**
   （实卷名 = `openship-platform-core-shanhai-data-` ＋该串，**2/2 一致**；⚠️ 见 ⓑ 的「推断」限定）
   ⇒ **名字不同，定义同源**。（openship 侧那条 `duckle` 服务声明的是 `duckle-workspace:/workspace`，
   **该服务 `enabled:false`、机器上无对应容器**。）
   ⇒ **结论不变：「改一处 `volumes:` 映射就让 job 与 console 同卷」这条路不通** —— 因为
   **console 一账套一卷**（3120 / 64188 **各自一条**映射，`deploy/data-compose.yml:133` / `:156`），
   且**每账套一套凭据**（同文件 `:168-169`：调度条目带不了 env ⇒ 一个 workspace 只有一套 env）
   ⇒ 要统一得**逐账套**改（贵的那条路），**改一处不够**。
   反向的便宜路正是 W2 本来就要做的「把调度收进 console」——那样 run 天然落在 console 自己的卷里。
   ⇒ ⚠️ **console 的 `/api/runs` / `/metrics` / `/api/run/status` 看不到 job 的 run**：
   console 侧 `duckle_run_last_timestamp_seconds{pipeline="lemeng.retail_order_line"}` 停在
   **09-26T12:55Z**（那次是容器内手工跑、撞 429 中止），而当日的 24 窗 job 在**另一卷**里。
   **挂告警/看板前先定「挂哪个 workspace」**——挂错面 = 盯着一只空桶。
   ③ **四处能按 `runId` 定位到具体一次 run**（同一 run 探针实测）：`/api/run/status?runId=` 给
   `state` / `status` / `durationMs` / 逐节点 `rows`；**receipt**（`<ws>/runs/receipts/<runId>.json`）
   与 **NDJSON `runtime.log`** 逐行带 `run_id`；`<ws>/runs/<pipeline>.json` 历史带 `run_id` +
   `rows` + `duration_ms`。
   ⚠️ **`/metrics` 与 `/api/runs` 都不带 `runId`，不在这四处里**（R1 逐字回读原始响应）：
   `/metrics` 只按 **pipeline** 打标（`duckle_run_last_rows` / `duckle_run_last_duration_seconds` /
   `duckle_runs_window`）⇒ 是**聚合面**；`/api/runs` 每条是
   `{id, name, file, at, status, durationMs, rows, nodeCount, trigger, error, category}`——**无 `runId`**，
   且**只覆盖 console 自己 `pipelines/` 目录里登记的管线**（本轮实测：无参返回 **6 条 / 3 个 id**，
   全是 `lemeng.*.run`；`?id=_t6.probe` ⇒ **`{"runs":[]}`**——**跑过的临时管线根本不进来**）
   ⇒ **不能拿它当「本次 run 的历史」**（`?id=<已登记管线>` 是有效过滤器，`?pipeline=` 被忽略）。
   ④ ⚠️ **job 侧只有落盘文件、没有 HTTP 面**（那个卷上没有 `serve` 在跑）⇒ 从 console 读不到它；
   要读只能读文件（`runs/*.json` / `runs/receipts/*` / `logs/<hour>/<pipeline>/runtime.log` /
   `logs/duckle_metrics.prom`）。CLI receipt **不带 `queuedAt`/`startedAt`/`queueMs`**（console 侧那份才带）。
   ⑤ `_ops` 行（job stdout）与引擎原生 `rows` **对账：逐窗计数一致（24/24）、合计一致**
   （**9470 = 9470**）——⚠️ 比的是**每个窗的 `rows` 计数与合计**，**不是逐字段/逐列**；
   **口径 = 该 run 的 `sink` 节点行数**（receipt `nodes.sink.rows`；历史条目的 `rows` 与之同值——
   样本 `16 = 16`；`node_count: 17` 是**节点数**，**不是** rows 口径），`_ops` 也取自 sink 行 ⇒ 三者同源；
   而 **`_ops` 行里没有「耗时」字段**（实测键只有 `ts` / `job` / `system_book` / `bizday` / `hour` /
   `rows` / `status`）⇒ spec §6 的「行数/页数/窗口/耗时」四项里，**「页数」与「耗时」从未进入
   `_ops` 行**（本条只证「该行键集里没有」，**不证代码里没有**）；
   引擎原生侧两项都有（`duration_ms` 逐 run、`duckle_run_last_duration_seconds`）。

### 7.5 接入方式（**凭据与网络从哪来**）

`drift` / `review --data` **要凭据与网络** ⇒ **etl job 显式带 `--token` 跑**——这是
**入口闸白名单之外的设计路径**。
⚠️ **不是**「放宽 `deploy/duckle/entrypoint.sh` 的闸」：那道白名单（`sequence` / `work` /
`deliveries` / `drift` / `branch` / `python` 移出，`review` 改条件动词）是**安全边界**，
本轮接入能力**不放宽它**。二者的分工：**闸管「裸跑时不许做什么」，job 管「授权作业带凭据做什么」。**

### 7.6 落点结论（对 `contracts/` 的分工订正）

⇒ **`contracts/` 降级为「人写的意图源」**（讲清该源该长什么样、owner 是谁、分区怎么切），
**机器面改用 duckle 自己的声明与门禁**（`node.data.schema` + `qa.contract` + `drift`）。
两者**不是二选一**：契约仍是接入的起点与评审依据，「落盘即定型」的**执行点**从「另建校验器」
移到**管线**。相应说明见 `contracts/README.md` §10；`docs/architecture.md` §5.1 第 2 条已同步。

> **附带订正（C6）**：PyPI 上 `duckle` 除 `manylinux2014_x86_64` 外**还有 `macosx_11_0_arm64`
> 与 `manylinux2014_aarch64` wheel**（**实测装机成功**：`0.7.3` + 传递依赖 `duckdb-cli==1.5.4`）。
> ⇒ ① `deploy/duckle/README.md` §2.2 的「**release 资产只有 `-linux-x64`**」那句只对
> **release 二进制**成立（**PyPI 侧有 arm64/macOS wheel**），该处已订正；
> ② §4 说的「本仓**没有本地 duckle**」是**当时（T5）**的事实 —— **本机实测可以装**
> （macOS arm64，见上），但**装得上 ≠ 已验证管线**，§6 的未验项一条都不因此销账。
