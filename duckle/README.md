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

`docs/data-platform-handbook.md` §2 记录了 `duckle/<域>/_ops/…`（备注：duckle 自己的产出）。
**但那是一条「数据湖路径」，不是本仓的目录约定**：`_ops` 在 v0.7.3 的 runner 二进制里
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
6. **引擎能力接入的三条坑与四项未验** —— 见 §7（C3 的三条坑**已实测，按纪律对待**；C4 的四项**是 gate**）。

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
