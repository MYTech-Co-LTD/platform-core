# 数据平台正典（本项目）—— 采集全生命周期 + 台账

> **本文就是本项目数据平台的「正典」**：采集的纪律、流程、验收、案例与决策登记，正文均在本文件（§1）。
> **台账也在本文件**：数据源清单（§2）、落地位置（§3）、已知欠账（§4）、验收记录（§5）——正典与台账合一，一个文件。
> **公司级标准**正文在 `team-harness/docs/standards/`（**尚未合入**，挂起于 PR #79）；它合入后，本文件的**执行细节**仍在
> 此处，**纪律表述**改为指向它（公司规则：标准正文唯一事实源在 `team-harness`，其他仓库**只放指针、不复制正文**）。
> **改契约 / 改管线 / 改调度之前**，先读 §6 下钻清单找到对应的目录自述。

## 0 本文管什么 / 不管什么

| | |
|---|---|
| **管** | 采集的**全生命周期**：接一个新采集任务 → 选型 → 契约 → 管线 → 调度 → 验收 → 运维 → 变更/回填 → 退役 |
| **不管** | 清洗 / 建模 / 语义 / 物化 / 消费层的口径与流程（在 `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md` 与 `docs/superpowers/plans/2026-09-22-data-stack.md`）；**部署**（在 `deploy/data-plane-deploy-sop.md`）；公司级纪律正文（在 `team-harness`，见 §6） |

**「采集完成」的判据（两个方向都写死）**：

- **落湖归我，是硬验收**：自证 / 幂等 / 独立通道 / 跨系统 四层（§1.4）缺一层不算过。
- **下游只要求「看得见」**：物化与消费**不归采集管**，但采集**必须要求下游新鲜度有探测与告警**——
  「谁产生」不归我，「看得见」归我。

> **为什么这条要写死**：2026-09-26 实测——零售采集每天绿、湖已领先两天，而 PG 里的物化**停在 09-23**
> （湖已有 **09-24 / 09-25**；`staging.stg_lemeng_retail_order_line` 19,678 行、`min=max=2026-09-23`，
> 恰等于湖 09-23 一天；37 个 job 里**没有一个在跑 dbt**——唯一含 dbt 字样的只是 prep job 里的一句 `ls -d`）
> ⇒ **湖已领先两天，而报表读到的是 09-23**，**且没有任何东西会报错**。这是「采集成功」最坏的一类假绿。
> ⚠️ 本段只写**量过的东西**：09-26 当天有没有入湖**未测**，故不写（「job 绿」不等于「数据到了」）。
>
> **订正（2026-09-28）：「没有一个在跑 dbt」已不成立，但假绿的形态换了，教训不变。**
> 物化 job `lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `20 3 * * *`【2026-10-06 起
> 错峰为 `27 3 * * *`，#452 E1；**2026-10-20 起改为 `27 3,7,9,11,13,15 * * *`** = 上海
> **11:27 / 15:27 / 17:27 / 19:27 / 21:27 / 23:27**，每 2 小时一次，紧随各采集波次
> （采集在 `:00–:55`，物化落在**下一小时的 `:27`**）——为让「当天采到的数当天可见」；
> **`11:27` 那一刀必须保留**：它是**接 00:30 对账产出**、并给 12:17 的 heal/重述任务提供台账的】）已注册并逐日成功
> ——2026-09-28 那次 **PASS=26 WARN=0 ERROR=0**，PG 物化到 **09-27**，且与湖**逐行对上**
> （3120 / bizday=09-27：湖 9,233 行 18 窗 = PG 9,233 行 18 窗）。
> 但同日端到端验下游时，**三条消费链的接线全没接**，失败依旧**全部静默**：
> Gate-B 网络掉了（问数必 502）、`data.metrics` **0 行**（词表空）、仓库连接 `search_path` 未绑
> （编译出的 SQL 报 `relation "<模型>" does not exist`）、`data-query` 权限码**没授给任何人**
> （侧栏菜单静默不出现）。
> ⇒ **「有 job 在跑」不等于「下游看得见」**。排查入口见 §1.5「下游看不见」一条；跟踪 **#297 / #298**。

---

## 1 采集正典

> 本节是正典正文。**只写采集专属的内容**；通用架构不变量不在此复制（**例外：§1.2 重复列出了 B7/B9 两条**，理由见该节），见 `docs/architecture.md` §4。

### 1.1 决策层：怎么选「最合适的方式」

> **一张表定案，不靠临场判断。** 逐项取值见下表与 1.1.1–1.1.5。

| 判定项 | 取值 | 判据 |
|---|---|---|
| 通道 | duckle / E1 / E2 / E3 | §1.1.1（例外须写证据） |
| 落点前缀 | `<域>/<表>`；**维度面带 `dim_` 段**（`lemeng/dim_branch`、`lemeng/dim_item`） | 契约 `layout.prefix`；维度面的例外见 `contracts/README.md` §4.2 规则 ② 的注 |
| 分区键 | `system_book=` + `hour=` / `bizday=` / `snapshot=` | §1.1.3（粒度不得细于采集间隔） |
| 写模型 | 分区单文件覆盖写 | §1.1.2 |
| 调度归口 | duckle console / openship job | §1.1.4 |
| 节奏 | cron + 窗口 | §1.1.3（由消费侧 SLA 倒推） |
| 验收 | 四层 | §1.4 |

> **判据：duckle first（每接一个能力先问这个）**
> 答案必须落在**三档之一，不许含糊**：
>
> | 档 | 判据 | 写法要求 |
> |---|---|---|
> | **①引擎有 ⇒ 首选** | 源码级确认存在，**且在本环境跑通过** | 写成「首选」，注明**怎么声明**与**哪次实测**定的案 |
> | **②引擎有但未验 ⇒ 先挂 gate** | 源码级确认存在，**本环境没跑过** | 写成「首选（**未验**）」，**同段给出最小验证动作**；验过才升 ① |
> | **③结构性没有 ⇒ 归我方** | 不是「不会用」，是**引擎结构里无处安放** | 必须给**结构性理由**（引源码或上游自述）——「嫌麻烦」不算 |
>
> **两条不放松**：**禁止把 ② 写成 ①**；**禁止把 ③ 写成 ②**（挂个 gate 拖着 = 永远不做）。
> **依据强度**：能力判断的出处**优先级 = 源码 > `capabilities --markdown` 产物 > 上游文档**
> （上游文档漂过：出现过不存在的组件 id）。出处与逐条论证见外部分析件（**不在本仓**）。
>
> **适用范围（2026-10-19 订正，issue #920）**：本判据**不只管「接一个新能力」**——做**任何数据面工件**
> （采集 / 判定 / 对账 / 管线节点）都先过它，并落进 `docs/architecture.md` §4.2「duckle 原生优先」。
> 执法器 = `.claude/skills/duckle-native-first`（判停门：**查目录 → 横向试同类 → 落三档 → 登记缺口**）。
>
> ⚠️ **反例（2026-10-19，issue #917）**：对账子管线手搓了一份净销售额口径（`lagg` 节点），而同环境里
> `src.postgres`（读物化结果）、`qa.reconcile`（原生源↔目标对账）、`routines/`（可被 `routineRef`
> 引用的保存 SQL）**都在**。没人查目录 ⇒ 那份手搓的实现与 dbt 构件悄悄漂移，酿成两次静默事故
> （#813 容差地板 / #917 退回侧判别式）。**「引擎有」不等于「我们知道它有」——先问引擎是动作，不是知识。**

#### 1.1.1 通道选型

**默认：duckle 管线**（含 job 层薄 wrapper）。依据见乐檬采集链路 spec §4。

**例外条件**——命中须在 §1.7 决策登记里写明**命中了哪一条 + 证据**：

| # | 例外条件 | 案例 | 状态 |
|---|---|---|---|
| **E1** | **推送式 / 需长驻接收**（源主动推给我们；duckle 是一次性 runner） | 抖音：生产上 `dy-upload` 以 `bare` runtime 跑 `/opt/douyin-life/capture/dy_receiver_run.py` | 有案例（细节待核实后补；见 §7 #3） |
| **E2** | **需登录态交互 / 浏览器自动化**（无稳定 API） | 无 | **预留，无案例**（§7 #1） |
| **E3** | **引擎能力缺口** | `snk.parquet` / `snk.s3` 都不通 **≠** 引擎不支持——`snk.minio` 可直写 ZOS | 有案例（`duckle/README.md` §1.4） |

**E3 的证成方法学（硬要求，不许省）**：判「引擎不支持」之前必须
① **横向试遍同类组件**（对象存储有 `s3` / `minio` / `r2` / `b2` 四个候选）；
② **先问引擎**（`list_components(kind=sink)` / `get_component_schema` 列真实字段），比外推可靠。
「试了一个不行」**不构成**能力缺口证据。

**例外的红线**：例外的是**执行器**，不是标准。走例外通道的采集必须**同样**满足：
① hive 分区 + `all.parquet` + 落盘即定型；② 幂等可重跑；③ 有契约（`contracts/`）；
④ 过 §1.4 的四层验收；⑤ 有失败告警。
**缺任一条 ⇒ 不是例外，是欠账。**

#### 1.1.2 落地形态（无例外）

| 项 | 定死为 | 出处 |
|---|---|---|
| 分区命名 | **hive**（`system_book=3120/`）；非 hive 直接校验失败 | `contracts/common/_schema.schema.json` 的 `const` |
| 文件名 | **`all.parquet`**（唯一），一个叶子分区一个文件 | 同上 |
| 写模型 | **分区单文件覆盖写**：内容 = 该分区**当前完整内容**；历史修正靠重放层幂等覆盖 | 乐檬 spec §5 |
| 定型 | **落盘即定型**：金额 numeric / 时间 timestamp / 日期 date，**不落字符串** | layered spec §7 硬约束 1 |
| 字段集 | **字段集稳定**：跨日/跨分区不漂移；漂移必须**显式改契约**，禁 `union_by_name` 兜底 | layered spec §7 硬约束 2；**半机检**——§1.2「dbt 工件七项」只覆盖「禁 `union_by_name`」那一半，**字段集漂移本身无机检** |
| 身份 | **主体（账套/租户）既是 hive 分区键、也是行内列** | 欠账 C3 的解法 |
| 批次 | 批次标记列（`batch_id` 等）随载荷落盘 | 乐檬 spec §10 |
| 嵌套 | 管线内展开成**行粒度**（湖里落平的行），消费侧免二次展开 | 乐檬 spec §5 |

> ⚠️ **粒度纪律**（2026-09-26 订正过的真实教训）：全量快照类（维度）**湖里一行 = 一个实体 × 一个快照日**
> ⇒ 行粒度键**必须含 `snapshot`**。`(system_book, item_num)` 是**实体粒度**，**不是**湖行粒度，两者别混用。

#### 1.1.3 节奏选型（由消费侧 SLA 倒推）

- 依据 `docs/architecture.md` §2.3 ②：**订单类高频（小时级或 15 分钟起步，按业务定），档案类日批**；
  **不为实时把批处理改流式**；**采集频率即消费方的 SLA**。
- **分区粒度不得细于采集间隔**（`采集间隔 ≤ 分区时间粒度`）：5min 采集 ⇒ `hour=` 分区
  （每个分区当日被覆盖写多次，终态 = 该小时完整内容）；日更 ⇒ `bizday=` / `snapshot=` 分区。
  ⚠️ 反过来（日更却按 `hour=` 分区）会让 24 个分区里 23 个永远空着——**分区粒度比采集间隔细 = 结构性欠账**。
- 高频率的代价要**写进 §1.7 决策登记**（乐檬单据系 5min 的实测代价：≈ 2.3k 请求/天）。

#### 1.1.4 调度归口（「何时跑」归谁）

| 被调度的东西 | 归口 | 依据 |
|---|---|---|
| **duckle 管线** | **duckle 自带调度器**（常驻 console，`duckle-runner serve` 的 tick 循环） | ADR-0014（**`openship-platform` 仓**）；`deploy/data-plane-deploy-sop.md` §F |
| **非 duckle 的 runner**（dbt、自建脚本） | **openship job** | 同上（dbt 是另一个 runner，容器内没有 docker，丢不进 console） |

- 判据一句话：**能不能被 duckle console 调度？能就 console。**
- **时区一律 UTC**（容器 TZ 实测为 UTC，openship cron 同口径）；「日期类」参数必须由 wrapper
  **显式钉 `Asia/Shanghai`** 推算——否则 UTC 夜间跑会算成前一天、**写进前一天的分区且不报错**（SOP §F.3）。
- **一账套一个 console —— 这是默认形态，不是引擎铁律**（🔴 2026-10-06 订正，见 §1.6 案例 18）：
  **被强制的只有一半**——`Schedule` 结构体与控制台写入路径**都没有** env / 凭据 / 参数 字段
  （上游作者自己标注为未来项）⇒ **调度条目**带不了自己的 env（实测塞 `env`/`args`/`params` 被**静默丢弃**）。
  **没有被强制的是**：账号维度**不必住容器 env** —— 隔离实测（本地 + **生产 0.7.4 容器**
  `lemeng-console-64188`，零生产触碰）证明 `ctl.foreach` 的 `${ITER_ITEM_*}` 会替换子管线的**任意 prop**，
  **含 `connectionRef`（凭据）**：两行驱动 → 两个连接 → 回显实录 `AUTH=Bearer TOKEN-A-lab` / `TOKEN-B-lab` 各一次；
  账号清单本身可住 workspace 文件（父 `read_json_auto` 读它）。
  ⇒ **一个 console 服务 N 个账套在机制上成立**（生产上 `lemeng.recon.preagg.item` 已在用
  `${ITER_ITEM_BUCKET}`/`SYSTEM_BOOK` 吃账号维度，只差 `connectionRef` 那一步）。
  ⇒ **要不要共用的真代价是权衡**：塌成一个 = **一个 workspace 一把钥匙**（`.duckle/keys/secret.key`）
  **护所有账套凭据**（现状每账套一 workspace = 每账套一把钥匙），外加**共享故障域**。
  **现行选择仍是一账套一 console**（密钥隔离 + 简单）；**账套数咬人时**（≈≥5 一类触发点）再按上述形态切，
  **不必现在重做**。⚠️ 别再把它读成「结构性约束」——那会挡掉一次本可做的合并。

#### 1.1.5 一源一路（禁双采集）

一个源**只有一条采集链路**。反模式（`docs/architecture.md` §2.3 已明列）：两个采集器各拉同一源
⇒ 两份数据必然漂移、对账永远追不上。

#### 1.1.6 编写与部署口径（duckle 的「桌面测 → 服务器跑」）

> **出处**：外部源码级分析件（**不在本仓**）`~/Documents/mytechcode/source-analysis/ANALYSIS-duckle-capabilities.md`
> —— 结论取自 duckle **v0.7.4** 源码（逐条 `file:line`）。本节只写**照着做的口径**，论证与出处看那份。
> ✅ **已升级（2026-10-06 实测订正）**：线上**已是 v0.7.4**——容器实测 `duckle 0.7.4 / duckdb-cli 1.5.5`
> （`deploy/duckle/Dockerfile` 的 `ARG DUCKLE_VERSION=0.7.4`，2026-09-28 升级；`lemeng-console-64188` 内 `duckle`/`duckdb --version` 实测）。
> 原文「我们线上跑的是 **v0.7.3**」已过时。v0.7.4 修的那类「**绿灯却在丢数据**」bug
> （**单文件 sink 改为按 rename 发布**；否则下游 glob 会读到**被杀的 run 留下的半写文件**）**现已在线上生效**。
> ⚠️ **连带待核**：本节 ③ 第五条与 §1.1.7 里那套「服务端 **0.7.3** vs 桌面 app **0.7.1**」的版本差论证
> **须按 0.7.4 / 1.5.5 重核**（本次只核了版本号，**未重测** header 增量与并发默认值）。

**① 资产在哪**：duckle 的模型是「**一个 workspace 文件夹 = 一份控制面**」——管线 / 连接 / 上下文 /
`routines/` / `schedules.json` / `alerts.json` / `owners.json` 都是**明文 JSON**（只有连接是密文），**进 Git**；
`.duckle/` 是**机器本地**状态（含**解 `connections/` 的明文密钥**），**永不进 Git**
（官方每次 commit 前会重写 `.duckle/.gitignore`，但**别依赖它**：那条 commit 走的是 `git add -A`）。
⇒ **换机 clone 后连接解不开**（密钥不在 Git 里）⇒ 密钥要**另行分发**。

**② 桌面测什么 / 服务器跑什么**：两端**内核同一份**（同一个 crate、同一个执行体、同一个计划器）
⇒ **同一份 pipeline 的结果可信**。缺口只在**外壳与两端自带的引擎版本**，见 ③。

**③ 五条保真度纪律**：
- **凡涉及 `${date}` / context 优先级：必须在 CLI 或 `serve` 上再验一次** —— 桌面 canvas 的占位符替换是
  **TypeScript** 实现，服务端是 **Rust**（两份手工同步，无编译期约束）。
- **并发默认值按面不同**（同进程**两条**限流器、**同名** `default`）：**Rust 外壳侧**（CLI / `serve` 的 HTTP 面）
  实测 **1**（走 CLI / HTTP 提交的会**排队**）、**调度器侧**默认 **8**（**源码级，未在本环境复现**，而调度跑才是
  生产路径）、**桌面侧的 8 未实测**（源码级）⇒ 桌面上并发跑得动的，上服务器**未必**跑得动。口径见 `duckle/README.md` §7.4 第 7 项 ④⑤。
- **桌面 Settings 的三项服务端不读**：`spill_dir` / `allow_unsigned_extensions` / `https_proxy`
  （服务端只读 `memory_limit_mb` 与 context 文件）⇒ 资源/代理类设置要**在服务端另配**。
- **扩展预装两端不同**（桌面 11 个 / 服务端镜像 12 个，多 `inet`）⇒ 用 `xf.ip.parse` 这类组件的管线
  **别只在一端验**。
- **`{incremental}` 的 header 落点两端不同**（这一条的根因是**引擎版本差**、不是外壳代码差，但同属「两端有缺口」）：
  `duckle` **0.7.3+** 能在 **url / body / header** 三处替换，而**桌面 app 自带引擎（本条记录时为 0.7.1）不替换 header**
  （把字面量 `{incremental}` **原样发出去**）⇒ 用 header 传增量的管线**必须先钉生产引擎版本**
  （🔴 2026-10-06 订正：**线上 = `0.7.4`**，见本节抬头块）——**否则在桌面验出来的是假阴性**
  （2026-09-27 实测，原始请求字节见 §1.3 阶段 D 的 ① 出处）。
  ⚠️ **桌面 app 的引擎版本号、以及它升级后是否仍不替换 header，本次未复核**（待验）。

**④ 分发三条路，别混**：

| 路 | 做什么 | 适用 |
|---|---|---|
| **Deploy**（编辑器「Deploy to a server」） | 推 **pipeline JSON 原文**到服务器 workspace 根；**随附调度强制 `enabled:false`** | 单份管线快速上线 |
| **Git + CI** | 仓库里评审 + 模板（上游 `docs/ci/*.yml` 是 duckle 自带的，**我们另有自己的 CI**） | 要评审 / 可回溯 |
| **`release` CLI** | **控制面全量快照 + 环境指针**（`activate` / `rollback`） | 要「整份版本化 + 可回滚」 |

⇒ **Deploy 是盲覆盖**（只回 `replaced: true/false`）、**桌面 `git pull` 是 `--ff-only`**（无合并、分叉即失败）
⇒ **版本一致性只能靠纪律**：**服务器只运行、不编辑**；回滚 = Git 里那一版重发。

**⑤ 两条硬纪律**（不守会**静默坏数**）：
1. **一个 pipeline 只在一侧跑** —— 桌面**手动 Run 不取跨进程运行锁**（引擎注释自认），
   与服务器同管线的调度跑**可并发** ⇒ 同时写同一 sink、推进同一水位。
2. **机密只用 `${ENV:...}`** —— 「**已保存连接**」的值会被**复制进管线文件并随 deploy 传出去**
   （官方逐字：Picking a saved connection does not, by itself, protect the credential）。

**⑥ 上生产后的观测**：用 `/api/run/async` + `/api/run/status`、`/metrics`、`runs`、`alerts.json`
（规则 + 冷却 + 恢复通知）；**别再自己起容器解析 stdout**。

**⑥a 手动触发口径（console HTTP 面；2026-09-27 实测 + v0.7.3 源码注）**：手动跑生产管线一律走
console 的 HTTP API（容器内 curl `127.0.0.1:18080`，Bearer=`DUCKLE_TOKEN`——entrypoint 翻译来的键，
**不回显值**；端口实测 `duckle serve --host 0.0.0.0 --port 18080`）。「实测」= 当日 console-3120 用
`lemeng.dim.branch.run` 真触发（幂等维度面）；行号 = `source-analysis/duckle`（v0.7.3）。

- **提交**：`POST /api/run/async`，body `{"file":"pipelines/<id>.json","params":{…}}`——`file` 必填、
  workspace 相对路径，`params` 可选供 `${...}` 占位符，需 operator 角色（源码 serve.rs:2650-2660；
  上游 `docs/current/ci-and-orchestration.md` 同形）→ **202 + `runId`**（2026-09-27 实测；body 的
  `status:"queued"` 只是受理回执，**不是运行态**）。
- **轮询**：`GET /api/run/status?runId=`。**等并发闸门的 run 也报 `state:"running"`**——`running` 集合
  在执行体**入口**登记、早于闸门（源码 serve.rs:3965-3968 登记先于 4056 取闸），且响应**无 `queue_ms`**
  ⇒ **排队证据读 receipt**：`<workspace>/runs/receipts/<runId>.json` 的 `queueMs`（源码 serve.rs:4057；
  实测 queueMs:0、逐节点 durationMs 在 receipt、整 run `durationMs` 在 status 的 `result`——实测 6464ms）。
- **判绿红必读 body 的 `status`，别信 HTTP 状态码**：**失败/取消也是 200**（实测：cancelled run 全程 200；
  同步口 `POST /api/run` 跑而失败同样 `respond_json` 200——源码 serve.rs:2635-2645）。`status` ∈
  `ok`/`error`/`cancelled`；**404 只代表 runId 不存在**。
- **取消**：`DELETE /api/run?runId=` → 200 `{"cancelling":true}`，终态 `status:"cancelled"`（实测）。
  ⚠️ **cancel 只杀薄管线的外层 shell 节点**——内层引擎是 shim 直调的子进程，成**孤儿继续跑完并写湖**
  （实测：cancel 后 run 2.1s 即终态 cancelled、receipt `nodes:{}`，湖 `snapshot=` 分区却出现**该 run 的
  batch_id** 且行数完整）⇒ **取消 ≠ 数据面急停**；取消后湖被覆盖是预期，别误读成「没取消掉」。
- **同管线冲突 409**：调度 / HTTP / CLI **三路同锁**（`claim_for_run` 在 202 前申请——源码 serve.rs:2673；
  CLI 裸跑同锁 main.rs:515/916），**但只在同 workspace 内互斥**：锁文件是
  `<workspace>/.duckle/locks/<pipeline>.lock`（源码 runlock.rs:82-83）⇒ **跨卷不互斥**（job 侧
  `platform-core-data_duckle-workspace` 与 console 侧
  `openship-platform-core-shanhai-data-lemeng-console-3120-ws` 两卷同机并存，2026-09-27 实测）；
  **桌面手 Run 不在此锁内**（⑤1——**别在桌面触发生产管线**）。409 body 自带处置文案（实测：
  「…is already running in this workspace, so this run was refused rather than started beside it…」）。
- **验收尾巴**：手动跑完照 §1.4 回读湖分区（实测：`snapshot=2026-09-27` 270 行 / **1** 个 batch_id /
  batch 已换成该 run 的）——console 容器内 `/etc/openobserve-ingest.env` 缺失 ⇒ `_ops` 观测行走
  **#210 已知缺口**（OPS_SINK=DISABLED），别拿「OO 没数据」当失败判据。

**⑦ 待裁决（无案例不立标准）**：把采集从「shell 算窗口 + 固定分页」迁到引擎原生的
`src.rest`（分页 + 请求侧增量）与水位状态 —— 它与「采集调度迁 duckle 自带调度器」（§1.1.4）
是**同一批决定**；候选、风险与实测代价见 §1.3.3 与分析件。

> **现状（2026-09-27 实测订正——原先这里只写「未拍板前不动」，与 §1.3 阶段 D 的 ① 冲突）**：
> **① 已验（引擎机制那半边）**：五种分页（`none`/`cursor`/`offset`/`page`/`link`）**无 total 均可翻到耗尽**；
> `maxPages` 撞上限**报错**（非静默截断）；`{incremental}` 可落 **url / body / header**（**0.7.3**）；
> 水位落 `<workspace>/state/`、**只在整条 run 成功时推进**。版本、命令与原始输出见
> `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-1b-report.md`。
> **② 未验且未拍板**：「**目标 API 适配**」（乐源是否支持 `since=`/游标、是否返回 `Link` 头 ⇒ §1.3.1 探针）
> 与**「迁不迁」这个决定本身**（§1.3 阶段 D 的 ② 指的就是这一半，**不是整行未验**）。
> 🔴 **2026-10-06 订正**：**生产引擎实际是 `duckle` 0.7.4（`duckdb-cli` 1.5.5）**，不是 0.7.3/1.5.4——
> 容器实测（`lemeng-console-64188`：`duckle 0.7.4`；`duckdb --version` = `v1.5.5`）。原文「钉死 0.7.3」
> 自 2026-09-28 升版后即已过时（升级对六管线 validate 逐字节一致，见 `deploy/duckle/Dockerfile` 注）。
> `{incremental}` 走 header 在 **0.7.3+** ✅；**桌面 app 自带引擎（记录时 0.7.1）❌**——该桌面版本号**本次未复核**
> （见 §1.1.6 ③ 第五条）。**不钉版本，下次用桌面 app 验出来的是假阴性。**

**⑧ 资产面：桌面端管什么、怎么到服务器侧**（2026-09-27 追加；出处同上，分析件 §6/§7）

**总拓扑**：**桌面（+Git）= authoring 与唯一事实源；服务器 = runtime，只运行、不编辑**（**单向**）。
⚠️ 上游原意（**原文为英文，此处是译文**；出处 = 本节抬头那份分析件 **§6.7(a)**）：桌面与 runner **同时**打开一个 workspace 是「**从笔记本搬到服务器的中途形态**」，
**不是推荐的长期拓扑**。⇒「**桌面端永远保留资产**」成立的条件是「资产在桌面与 Git，**服务器不反向持有唯一副本**」，
**不是**「两端同时开着同一个 workspace」。

**三个动作别混**：

| 动作 | 产物 | 去向 | 我们用它做什么 |
|---|---|---|---|
| **Deploy** | **pipeline JSON 原文**（⚠️ 占位符**不解析**）| 服务器 workspace **根**（非 `pipelines/`；临时文件 + rename；**可覆盖**、盲覆盖）| **单份管线快速上线** |
| **Build** | 自包含单文件可执行（内嵌引擎 + DuckDB + 已用扩展 + **已解析**管线 + 密钥）| **本机磁盘**（**不是服务器**）| 无 duckle 环境的交付。⚠️ **不打包 `components/`** ⇒ `ext.*` 在别的机器上**直接失败** |
| **Release** | **控制面全量快照**（hash 寻址）+ 环境指针（`activate`/`rollback`，单次 rename）| 服务器 workspace 的 release store | **整份版本化 + 可回滚**（⚠️ **不含密钥**）——**未验** |

⚠️ **Deploy 与 release 在源码里没有任何调用关系**。**上线是两个动作**：
**Deploy = Admin**（理由：部署就是**交出代码执行权**，因为管线会在这台机上跑 shell 与 SQL
——**原文为英文，此处是译文**，出处 = 分析件 **§6.4**（`audit.rs:362-369`））；
**启用调度 = Operator**，且**随部署下发的调度一律被强制 `enabled:false`**
（理由：「在笔记本上设的节奏不该一到生产就开始点火，**打开它是一个独立的动作**」
——**原文为英文，此处是译文**，出处 = 分析件 **§6.3**（`serve.rs:3429`））。

**资产类 × 谁维护 × 怎么投**：

| 资产类 | 进 Git？ | 谁维护 | 怎么到服务器 |
|---|---|---|---|
| 管线 `pipelines/*.json` | ✅ | 桌面（真引擎产出，**仓内不手编**）| Deploy **或** Git seed——**二选一，别混** |
| 调度 / 告警 / 所有者 / 编排（`schedules.json`、`alerts.json`、`owners.json`、`plans.json`）| ✅ | 仓内 | **seed 进 workspace 卷 + 重启容器**（§1.3.2 的「两步」；⚠️ **2026-09-29 投递实测订正**：**卷内定义重启即读**——`schedules`/`pipelines`/`owners`/`alerts` 进的是命名卷，重启后 console 重新加载。**「定向重建」只对需换 env 的改动必要**，因为 env 在容器创建时注入；原文三处写「重建容器」对此过度）|
| 契约 / 语义（`contracts/`、`dbt/`）| ✅ | 仓内 | 随仓（与 §1.3 的 A/C 段同源）|
| 连接 `connections/*.json`（**密文**）| ✅ | 桌面 | ⚠️ **换机 clone 后解不开**——解它的 `.duckle/keys/secret.key` **永不进 Git** ⇒ 密钥**另行分发** |
| 上下文 / 例程（`contexts/`、`routines/`）| ✅ | 桌面 | 与管线同路 |
| **自定义代码** | ⚠️ 分三种 | 桌面 + 仓 | **三种载体三种投法**（见下）|
| **扩展 `ext.*`** | ⚠️ 目录进仓 | 桌面 + 仓 | **`<workspace>/components/<name>/` 一个目录**（docker = **挂卷**）⇒ **seed 进每个账套各自的卷** |
| 运行态正确性状态（`state/`：**水位**、checkpoints、baselines）| ❌ **由运行产生** | 引擎 | ⚠️ **不是缓存，是正确性状态**——决定「下次采哪些」。跟着 workspace 卷走，**不进 Git、别手改**；回填用 `watermarks` |
| 历史与派生物（`runs/`、`receipts/`、`logs/`、`cache/`、`manifests/`）| ❌ | 引擎 | 不用投——引擎自产（§1.5 观测面吃它）|
| 机器本地 `.duckle/`（`keys/`、`secrets/`、`locks/`、`settings.json`、`deploy-targets.json`、`console.db`、`environments/`）| ❌ **绝不** | 各机自持 | **永不投递**。⚠️ 官方每次 commit 前重写 `.duckle/.gitignore`，但它走 `git add -A` ⇒ 那份 ignore 是**最后防线，不是建议** |

**自定义代码与扩展：三种载体**——

| 路线 | 形态 | 状态 | 分发单元 |
|---|---|---|---|
| **① `ext.*` 外部组件** | `<workspace>/components/<name>/duckle-component.json` + **任意语言可执行文件**（stdin JSON 请求 / stdout JSON 应答；数据走 Parquet）| **生产可用、官方文档化** | **workspace 里一个目录**（docker = 挂卷）|
| **② 管线内 `code.*` 节点** | `code.sql` / `sqltemplate` / `python` / `javascript` / `shell` / `wasm` **available**；⚠️ **`code.rust` 是 planned 且零实现** | 可用 | **随管线** |
| **③ 内建级组件**（`src.*` / `xf.*` 那种）| 改上游 Rust 5 处 + 重生成 catalog；`crates/plugin-sdk` 是**已废弃脚手架** | 只能 fork | 维护分叉——**不做** |

⇒ **判定：`ext.*` 首选 / `code.*` 兜底 / 内建级不做**。

**① 的实测出处（2026-09-27 补验；「无案例不立标准」——原先本仓零 `ext.*` 案例）**：
本机隔离实验室（darwin/arm64，**零生产**）、**pip `duckle` 0.7.3** + `duckdb` CLI 1.5.4。
命中的四条：**① 真 pipeline 里 spawn 成功、干活成功、数据往返成功**（`src.csv → ext.probe → snk.json`，
sink 真拿到 3 行）；**② 子进程继承宿主 env**（`sha256` 前 8 位与独立算出的逐位相符）；
**③ `components conform` 10 passed / 0 failed**；**④ 分发单元成立**（`build` 产物不打包 `components/`，
搬到无 `components/` 的裸目录隔离跑 **exit 1 且报错干净**——点名 `looked in components/`）。
原始输出见 `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-2b-report.md`。

⚠️ **`ext.*` 的待遇是「半套」，别看成一等公民**（**2026-09-27 实测订正**：原文写「调色板 / catalog / MCP /
capabilities / policy 门禁 / run 回执」一句打包，**实测与其中两项相反**）：
- ✅ **成立**：**policy 门禁**（`ext.` 前缀 ⇒ `executes_process()=true`）、**run 回执** `Used`·`used_by`、
  以及 **`components conform <id>` 行为验收套件**（initialize 不许干活 / 零行进零行出 / 20 万行大批 /
  崩了要干净报错 / **secret 脱敏**（查实际发出的字节）/ 超时上界），**输出 json 能直接卡 CI 门禁**；
  ⚠️ **用例数随组件 kind 变**：source（0 输入）时第 4/5/6/9 条显示 **`n/a`（不适用）——`n/a` 不等于绿**；
  transform 形态那 4 条才真跑，而**要 10 pass / 0 n/a 还得应答里带 `rejects` / `artifacts`**（否则这两条判 `n/a`）。
  ⇒ **引用「10 用例」时必须带上组件 kind 与应答字段**，否则不诚实。
- ❌ **不成立**：**`catalog` 与 MCP 都看不见 `ext.*`** —— `duckle components schema` 导出 **411 条全是内建、
  0 条 `ext.*`**；MCP `list_components` / `get_component_schema` 同样返回不了。
  **唯一**能发现它的列举面是 **`duckle components external --workspace <ws>`**。

🚧 **gate 级 blocker（2026-09-27 实测，必须先知道）**：**MCP `validate_pipeline` 会把含 `ext.*` 的管线判死在门口**
——`(ext.probe) isn't executable on the DuckDB engine yet - it's a preview component.`
⇒ **我们惯用的 MCP 通道不能用来校验含 `ext.*` 的管线，改用 CLI `validate`**（同一份管线 CLI 放行、`exit 0`）。
⚠️ 但 CLI 也**查不了 ext 组件的属性**（它自认 `component_not_in_catalog … its properties cannot be checked`）
⇒ **属性名写错能过 `validate`、到运行时才炸**。

⇒ **凡「会长期存在的自建逻辑」优先做成 `ext.*`**；`code.*` 用在「一次性 / 只这一段用」。

⚠️ **两条安全空档（设计如此，不是疏漏）**：① **`allowed_paths` 与 `allowed_domains` 对 `code.*` 全部失效**
（子进程可连任意主机、读任意文件，policy 看不见——`code.*` 就是「跑任意程序」，**有意留着**）；
② **没有 per-execution 审计事件**（审计记的是**鉴权动作**，不记「某个 `code.*` 被执行了」）⇒ 留痕靠 run manifest + retry 回执。
⇒ **纪律**：能进 policy 的尽量进 policy（`ext.` 前缀 ⇒ `executes_process()=true`；`components.deny:["ext.*"]` 一票否决）。

**投递的五条硬纪律**（不守会**静默**坏数 / **静默**覆盖）：

1. **服务器只运行、不编辑** —— ⚠️ **没有回拉，也没有漂移检测**（源码里穷举 `reconcile`/`drift`/`desync`/
   `diverged`/`out_of_sync` **均无此语义**）⇒ 有人在服务器改了管线，下次 deploy **静默覆盖**它，而桌面**不会知道**。
   这是「桌面为源」模型**唯一的真实风险**，靠纪律规避（**回滚 = Git 里那一版重发**）。
2. **一个 pipeline 只在一侧跑** —— 桌面**手动 Run 不取运行锁**（引擎注释自认）⇒ 与服务器同管线的调度跑**可并发**、
   **同时写同一 sink、同时推进同一水位** ⇒ **静默丢数**。锁只覆盖「调度触发」那一条路径。
3. **管线里机密只用 `${ENV:...}`** ——「**已保存连接**」的解密值会被**复制进管线文件、随 deploy 传出去**
   （官方逐字：「Picking a saved connection does not, by itself, protect the credential」）。
   ⚠️ **组件侧方向相反**：`ext.*` 组件**继承宿主 env** ⇒ **只传引用名 + 组件自己读 `std::env`**；
   **别在组件属性里用 `${ENV:...}`**（宿主会把**真值**替换进属性再塞进 stdin 的 JSON）。**两条路别套用同一条纪律。**
   ⚠️ **静默坑（2026-09-27 实测）**：属性里的占位符**未解析时不报错**——只发一句 warning
   （`${ENV:…} is unresolved …`），**run 仍 `status: ok`**，且**字面量原样下发**给组件
   ⇒ 密钥没配好**不会红**，组件收到的是一个看着正常的字符串（**静默错配面**）。
4. **deploy 完不会跑** —— 见上「上线是两个动作」。
5. **两端外壳有缺口，别只在一端验**：🔴 **占位符替换是两份实现**（桌面 canvas = TypeScript、服务端 = Rust，
   **手工同步、无编译期约束**）⇒ 凡涉 `${date}` / context 优先级**必须在 CLI 或 `serve` 上再验一次**；
   **默认并发按面不同**：**Rust 外壳侧**（CLI / `serve` 的 HTTP 面）实测 **1**、**调度器侧**同名 `default`
   默认 **8**（**源码级，未在本环境复现**）、**桌面侧的 8 未实测**（源码级）⇒ 桌面跑得动 ≠ 服务器跑得动；
   （面别口径见 `duckle/README.md` §7.4 第 7 项 ④⑤）；**桌面 Settings 的三项服务端不读**
   （`spill_dir` / `allow_unsigned_extensions` / `https_proxy`）；**扩展预装两端不同**（桌面 11 / 服务端镜像 12，多 `inet`）。

**W4 前置 gate（`ext.probe`）现状**（2026-09-27 实测回填；spec §W4「前置 gate」行那三项）：**已清 3/3 + 新增 1 条 blocker**——
**能否 spawn ✅ 已清**（真 pipeline 里 spawn / 干活 / 数据往返均成功）；
**能否读 `SYSTEM_BOOK` + `ZOS_*` ✅ 已清**（引擎 spawn 的组件自己回报全部 `present=true`，**机制层面无碍**；
⚠️ 注意这**只证了「能读」，没证「有得读」**——生产 console 容器里那些值是否真注入，**未验**）；
**能否解析 `pg_duckdb` ✅ 已清**（2026-09-27 第三轮实测：本机隔离实验室 `/tmp/duckle-lab-p1`、零生产，引擎 spawn 的 `ext.pgprobe` 经 postgres 线协议连官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`，CLI `validate` exit 0 + run `ok`（`n2 rows=3`）+ 三条 DuckDB 方言证据；证据 `/tmp/duckle-lab-p1/wsext/evidence-pgduckdb.txt`，详见 `duckle/README.md` §7.4 第 8 条实测块）；
⚠️ **新增 blocker**：**MCP `validate_pipeline` 对 `ext.*` 直接报错**（见上「gate 级 blocker」）
⇒ **W4 开工前必须先定「管线校验走哪个 validate 面」**。

**⑧.a 新采集任务操作卡（2026-09-27 晚定稿；每步带当日真案例背书）**

> 分工一句话：**桌面管编、Git 管版、release 管滚、console 管跑**。桌面=authoring 面（不是版本面）；
> 版本正源始终是 Git；服务器只运行不编辑（本节总拓扑的单向性）。
>
> **桌面端自带 Git 面板 ＝ 草稿保险箱，非正典版本面**（2026-09-28 定位并启用）：工作区可关联私有备份仓
> `platform-core-authoring-backup` 防草稿丢失——泄密面已核（源码 `workspace_git.rs` 的 GITIGNORE_SAFETY
> 每次提交前强制排除 settings.json/keys/secrets 等，fail-closed）；两条边界：① connections 密文进仓但
> **换机解不开**（解密钥匙 `.duckle/keys/` 永不进 Git，按规矩另行分发）；② 备份仓**永远不是正典**——
> 正式版本一律 collect 回仓走 PR（操作卡 3）。

| # | 步骤 | 要点与案例 |
|---|---|---|
| 1 | **立题** | issue 六必答：源/账套｜**频率与窗口语义**（先实测——#260 探针 30 分钟定了整个提频地基）｜**幂等口径**（覆盖写/追加 + batch_id 含义）｜容量预估（对照 12页×200 闸）｜失败语义｜消费方。**先按 §1.1.7 定形态**（L0 直连 / L1 父子两层），再查本表 §2 + WeKnora |
| 2 | **桌面 authoring**（本地零生产） | 打开与服务器卷**同构布局**的本地工作区（pipelines/+schedules.json；2026-09-27 桌面首案例）→ 画布搭/复制改 → 本地试跑 → 产出 json。**仓内不手编**。⚠️ 节点 `type` 词汇表只有 `source`/`transform`/`sink`：`qa.contract` 写 `"type":"quality"` 引擎照跑，但桌面画布把它渲染成**无端口芯片**——连不出线、下游看似空画布（#272 实测、#273 修复） |
| 3 | **落仓一次 PR 齐活** | pipelines + schedules/<账套> + alerts + owners + 契约 schema。验收锚看 build 的「N pipeline(s)」计数——⚠️ build 对解析失败 json **静默跳过**（2026-09-27 实测：exit 0、hash 不变、零警告） |
| 4 | **投递** | push → 机器 sync 按 SHA 取件（不 push=404）→ seed 进账套卷 → **重启容器**（两步都做；卷内定义重启即读，**改 env 键**才走定向重建） |
| 5 | **启用 + 首验** | Operator API 启用（与部署分离）。四验：**receipts startedAt**（判触发；last_run_at 是完成时刻）｜湖分区当日 batch｜_ops 行到 OO｜告警面静默 |
| 6 | **release 快照**（推荐） | 改动前后各一版 ⇒ 有单步 rollback。边界（实测）：previous=你来时那版；会把 schedules.json 运行记账一起回退；**不覆盖 alerts/owners**；被跟踪文件切版即删、散文件不动；drift 闸 exit 1 可依赖 |
| 7 | **沉淀** | 台账回填 §2 → WeKnora 查重沉淀 |

**资产一致性盘点（上线资产的「正本核对」，改完/定期跑）**：
两账套卷面 5+3 份控制面资产 `sha256sum` 对照仓内正本（2026-09-27 实测**全部逐字节一致**）；
重管线在容器 `/pipelines/common/`（宿主机盘 **ro 挂载** ← 机器 repo ← Git main，两账套 3/3 一致）——
溯源闭环成立。⚠️ 64188 卷缺 alerts/owners 的缺口见当日记录（待补课：seed + catalog 前置 + 定向重建）。

**资产归属与客户区分（2026-09-28 定稿）**：管线文件**默认账套无关**——客户维度住在**部署实例**上
（一账套一 console；`SYSTEM_BOOK`/`LEMENG_TOKEN` 等走 env 注入；湖分区带 `system_book=`；§2 台账按行记账套）。
**拆分判据**：只有当同一条管线**无法用 env/参数在账套间复用**（真有账套专属逻辑或专属源）才拆**专属资产**——
放 `deploy/duckle/accounts/<账套>/`（文件名带账套号），投递按账套卷定向（操作卡 4），§2 台账登记归属行。
**别为「只是参数不同」复制管线**——复制即双份漂移面。

#### 1.1.7 采集任务标准形态（统一方法论，2026-09-28 定稿）

> **一句话**：**管线里只写「数据怎么流」；一切「程序性的循环/重试/计数」下沉给引擎。**
> 判据出处：`docs/superpowers/specs/2026-09-28-duckle-orchestration-capability-survey.md`（源码级 + 21 组隔离实测）；
> 目标登记：issue **#276**。**本文只写「照着做的形态」，能力论证与方言坑看那份报告。**

**按复杂度选层，不许含糊**：

| 档 | 什么时候用 | 形态 | 状态 |
|---|---|---|---|
| **L0 直连**（默认） | **单窗/日频/无跨窗编排**的采集 | **一条管线 + 一条调度**，没有第二种文件 | **①现行可用**（既有先例：维度面 `lemeng.dim.*`） |
| **L1 编排** | 需要**跨窗循环**（24 时窗等）、逐窗重试、失败登记 | **foreach 父管线（编排）+ 业务子管线（单窗怎么采）**，两层，**父里不写 shell** | **②实验室验证完毕（未上生产）**——首航过即转 ① |
| **禁止** | —— | **不再新增 shell 包装层**；也不拿 `code.*` 节点当编排器（子节点看不到别的窗，跨窗只能靠外部状态 ⇒ 撞 `state/` 红线） | —— |

**L1 标准形态**（编排层各件与旧 wrapper 职责一一对应，逐行对照见报告 §6/§8）：

```
调度（console，只管几点）
 └─ 父管线（编排层，~声明式）
     身份门：SSE 探针(xml+raw) → 抠 data: → 断 company/book + 门店子集 → die
                                          ← 替代 wrapper 的凭据↔账套自证（L0 已实测原生化，见下）
     窗口表：src 由频率推导（日批 00..23 / tick [cur,prev]）
     ctl.foreach → 业务子管线
        · itemKey = 窗号
        · retryAttempts = N（同 run 同窗重试）
        · 子管线内 src.rest 声明 checkpoint ← 跨 run 只补失败/未采窗
     汇总 + 末尾判红（die）               ← 替代 wrapper 的失败登记与 EXIT 判红
 └─ 业务子管线（= 现「重管线」，**凭据改走 `connectionRef`、`${ENV:*}` 一律删**；另加 checkpoint）
     ⚠️ 子管线**不解析 `${ENV:...}`**（只顶层解析）⇒ 凭据不许用 env 占位符；**正解 = `connectionRef`**
     （引擎为子管线专设，runjob/iterate/foreach/batch items/install fallback **五条子路径全覆盖**，
     含 queue worker——比「顶层 contextVariables 下传」还稳，后者到不了 worker）。凭据值住
     `connections/<id>.json`（**密文** `enc:v2:`），管线 JSON 里**一个密钥字符都没有**。
     两条必须守的边界：① **建连接必须用会加密的写入方**（桌面 app / `duckle-runner web --dist` /
     按源码自封——**MCP `create_connection` 写明文，禁用**）；② **加载失败是静默的**（fail-open，
     非 Salesforce 连接出错返回 Ok ⇒ 表现为空凭据、静默 401）⇒ 必须有独立探测。
     ⚠️ **「零明文」的边界**：解密钥匙 `.duckle/keys/secret.key` 就在 workspace 里 ⇒ 这层加密保护的是
     「**连接文件单独流出**」（进 git/备份/镜像/分享包），**不是**「拿到整个 workspace 的人」——
     **`.duckle/keys/` 必须与 `connections/` 分开管控**（备份/快照/镜像构建上下文一律排除它）。
     src.rest 分页 → schema 校验 → 写湖分区
```

**配套决策（照此执行，别临场发明）**：

| 场景 | 做法 |
|---|---|
| 新采集任务（无跨窗编排） | **L0**：写一条管线 + 调度，**不写 shell** |
| 新采集任务（要跨窗） | **L1**：窗口表 + 子管线 + foreach；重试/幂等全部原生声明 |
| 连败 ≥N 中止 | **默认不做**——跨 run 补采已保证正确性，缺的只是止损（代价有界：网关全挂时每窗快速失败）。真出事故（压力/告警风暴）→ **`ext.*` 自定义组件兜底**（2026-09-28 拍板，触发条件即「必须处理且上游无方案」）|
| 诊断 / 对账 / ETag 验收 / 身份探针工具 | **独立只读入口，永不进采集主链**（合并只增耦合）——这些验收的是引擎之外的世界（湖对象、网关），引擎无视角 |
| 凭据（密钥/token）| **保存的连接**（`connectionRef`）：值住 `connections/`（密文），管线与子管线只写引用名；**密钥物化仍在平台层**（建连接用会加密的写入方，禁用 MCP `create_connection`）|
| **身份门（凭据↔账套自证）** | **可原生化，不必留 shell**（2026-09-28 D2 实测）：`src.rest` + `responseFormat:"xml"` + `rawResponseDestination` 把 SSE 原样落盘 → `code.sql` 抠 `^data: ` → 断 `company_id` 与门店子集 → `ctl.die`；身份不符实测 **0 次业务调用 + 0 写湖 + rc=1**。**四条护栏一条不许少**：探针节点必须带 `data.schema`；必须有「抠不出身份 ⇒ 红」的反向闸；⚠️ `${ENV:X}` 解析不到 duckle **只警告不报错**（期望值缺参 ⇒ 闸静默半失效，本仓吃过的亏）；传输失败要 `retryAttempts`。已知弱点：raw 路径必须**绝对路径**且带 `BATCH_ID`、**绝不写 `s3://`**（PII 落对象存储）；载荷含未闭合 `<` 会 fail-closed 假红（上游诉求）|
| sink 写法 | **照现重管线抄**：一窗一 key 的单对象覆盖、分区写进 key、**不开 `partitionBy`**（0.7.4 实测：云 sink 上被**静默忽略**，同 run 两个 sink 写同一 key 会**静默丢数**）|

**现状与迁移波次（🔴 2026-09-29 订正：原文写「本形态尚无生产首航案例」——已过时，现有三个）**：

| 波 | 内容 | 状态（2026-09-29 实测） |
|---|---|---|
| **Wave 0** | 零售 tick 按 #260 已批的**薄壳形态**投递——不切形态 | **从未投递**（tick 薄壳在生产上不存在）⇒ 由 Wave C 的 L1 形态直接取代，不经薄壳阶段 |
| **Wave 1 首航（L0 首验）** | `lemeng.branch` 回迁 **L0**（⚠️ 原写「回迁 L1」有误——它是**单窗日频**，按本节分类属 L0，**不需要 foreach**）。形态 = **一条管线替代「薄管线 + shell + 重管线」三层**；凭据走 `connectionRef`（L0 本可用 `${ENV:}`，**故意用它是为后续在生产预验凭据机制**） | ✅ **已投产**（2026-09-28 切流；09-29 首次「**调度触发**」五点验收全绿）。**首个 L0 生产案例** |
| **Wave A** | `lemeng.dim.item` → L0 | ✅ **已投产**（09-29 首跑五点全绿：17,135 行 / `batch_id` 唯一 / 运行记录带写资产） |
| **Wave 2 / Wave B（L1 首验）** | 零售日批回迁 **L1**（foreach 父替 `windows` wrapper，约 −400 行 shell）——**foreach 在这里才第一次上生产** | ✅ **已投递**（09-29：L1 接管、薄壳置停；foreach **24 窗**首飞 `ok`）。**首个 L1 / foreach 生产案例** |
| **Wave C** | `tick` / `close` → L1（**tick 形**） | ⏸️ **管线与调度已落，`enabled:false` 未激活**；`tick.l1` 取 `misfire:skip`（**catchup 结构上补不回错过的窗**——窗口由执行时刻算）|
| **Wave D** | 64188 跟进 + 试点收口 | 🔄 **进行中**（09-29：64188 投递 `dim.branch.l0`（129 行，与哨兵 `visible=129` 吻合）/ `retail.windows.l1`（24 窗，对照臂 4,348→4,353）；薄壳退役、本文收口见 `docs/superpowers/plans/2026-09-29-waveD-64188-retirement-closeout.md`）|

**首个生产案例得来的三条（🆕 有案例才写）**：

1. **L0/L1 形态在生产上成立**：两条 dim L0 + 一条 retail L1 跑通，含 **foreach 24 窗**、`connectionRef` 凭据、身份门与期望值形状闸。**L0/L1 不再是「待验形态」。**
2. **观测面的选锚判据（Wave B 投递当天发现，源码级）**：新鲜度锚**必须指向「有运行记录的管线」自己写**的资产——**别指向 foreach 子管线写的对象**。子管线不产运行记录 ⇒ 该锚**从不参与评估**（`freshness.json` 里压根不出现，比 `unknown` 更阴）。判据与修法见 **#359**。
3. **双点火的价值被实测证实**：同一营业日两次点火，第二次捞回「后结算」的数据（3120 **+36 行 / +24 单**；64188 **+5 行**）——前一次采的是尚未收敛的当日快照。

> 📐 **新增账套 / 客户 / 源系统时的落点与命名**：见 `docs/superpowers/plans/2026-10-05-collection-layout-convention.md` —— **管线文件名即 id（平铺，不分目录）；客户差异只走 `env` + `connections/` + `schedules/<账套>.json`**。

### 1.2 硬约束清单

> **先看清是哪一档。** 第一档违反 = CI 红；第二档违反 = 门禁不拦，靠评审与人。
> **通用不变量不在此复制**——**例外**：与采集直接相关的 **B7（部署面）** 与 **B9（env 契约）** 两条，
> 本身就是 `docs/architecture.md` §4.1 的通用不变量，在此**重复列出并给指针**，理由是采集读者不该为这两条离开本页。
> 其余通用不变量一律见 `docs/architecture.md` §4（第一档 / 第二档同为两档制）。

#### 第一档：门禁固化（在 CI 真跑，且会红）

| 规则 | 守什么 | 固化处 | 跑在 |
|---|---|---|---|
| **B7** 部署面 | 全仓**只两份** compose（`deploy/docker-compose.yml` 单元 A + `deploy/data-compose.yml` 单元 B/数据面）；两份里**所有** `ports` 必须 `127.0.0.1:` 起头 | `scripts/check-compose.mjs` | `gates` |
| **B9** env 契约 | `.env.example` 键齐全 | `scripts/check-env-example.mjs` | `gates` |
| **B10** 数据契约注册 | 湖列集唯一事实源 = `contracts/*.json`；管线 `flatten` 投影与对应 staging 投影必须与它**逐列一致** | `scripts/check-data-contract.mjs` **+ 生成器 `scripts/gen-data-projection.mjs --check`** | `gates` |
| **dbt 工件七项** | staging 必含 `r['列名']` 取列模式 / 禁 `::double` / 禁 `union_by_name` / staging 一对一双向 / 语义声明必填字段 / 指标命名空间与同名唯一 / 每个声明指标一条对账 test | `scripts/check-data-models.mjs` | `gates` |
| **数据面投递** | lock 首行自校验 + lock ↔ 工作区逐文件 sha256/落地路径/模式一致 + 消费面覆盖 | `scripts/check-data-plane-lock.mjs` | `gates` |

> **B10 的形态在 2026-10-06（#460）变了**：生成器 `scripts/gen-data-projection.mjs` 已把**管线 `flatten`
> 投影与 staging 投影**变成生成物 ⇒ B10 从"事后查两处一致"**降级为保险丝**，真正把关的是
> `gen-data-projection.mjs --check`（生成物 == committed）。**改列集现在 = 改契约一处 + 跑生成器**
> （未回填 `columns[].expr` 的契约会被跳过，存量回填跑 `--seed`）；dbt/ 变了记得重生成
> `deploy/data-plane.lock`。正典：`docs/architecture.md` §4.1（B10）/ §5.2。

#### 第二档：仅文档（无门禁，靠评审与人守）

采集侧「目前没人守」的诚实清单（源：`contracts/README.md` §5 + `docs/architecture.md` §2/§5.1）：

| 约定 | 谁在守 |
|---|---|
| 契约元 schema 的字段级约束 | ⚠️ **只有人手动跑**（`contracts/README.md` §4.3 那条命令），CI 不跑 |
| 契约的六条跨字段规则 | ❌ 没人守——连元 schema 都表达不了 |
| 「新源必须先有契约再落盘」的**顺序** | ❌ 流程约束，无机器判据 |
| **三件套同一个 PR**（契约 + 管线 + dbt staging；供操作面消费时加 `modules/data` 引用表与稳定视图 = 四件套） | ❌ 流程约束，**当前无静态门禁**（`docs/architecture.md` §5.1 明写） |
| `contracts/**` 与 `duckle/**` 的 env 键 | ❌ **不在 B9 扫描面内**（`docs/architecture.md` §2 明写「当前没有任何静态门禁」） |
| 契约类型 ↔ duckle `data.schema` 类型的枚举映射 | ⚠️ **未实测核对**（两套词汇不同，别直抄） |
| 管线引擎能力的**未验清单**（`duckle/README.md` §7.4） | ❌ 无人守——但**是 gate，不是「大概可以」**：接入 PR 的首次真跑必须**逐条销账**，销账结论写回 `duckle/README.md` |
| `_` 前缀 = 不是契约 | ❌ 只在自动发现场景才有意义，而自动发现尚不存在 |
| 「例外的红线」五条（§1.1.1） | ❌ 流程约束，无机器判据 |

> ⚠️ **读这张表的方式**：「第二档」不等于「不重要」，而是「目前没有自动化的守门人」。
> 把某一条升级成门禁是**另一个决定**，需要单独的真实案例支撑（本仓规矩：**无案例不立标准**）。
> **别把「CI 绿」读成「采集纪律都守住了」**——CI 对 `duckle/**` 只守**投递完整性**（`deploy/data-plane.lock` 把每个文件的 sha256 钉死，
> `check-data-plane-lock` 在 `gates` 里跑；改了 `duckle/` 下任何文件却不重生成 lock 就**红**），**不守**它的内容语义、也不守它的 env 键；
> 而 `contracts/` 与本文档**完全不在任何扫描面内**——改它们**不会有任何东西红**。
>
> ⚠️ **「未验清单」那行故意不枚举条目**：只给 `§7.4` 的指针，不抄几条、也不抄是哪几条。
> 两条理由：① 本正典的纪律是**不复制正文**（枚举就是把下钻文档的正文搬过来）；
> ② 那份清单**漂过**——`deploy/duckle/README.md:249` 曾把 §7.4 写成「**四项**」，而当时 `duckle/README.md` §7.4 已实列**五项**
> （漏的是第 5 项「跨组件 parquet 格式兼容」——本仓切官方镜像时新引入的面）；2026-09-27 §7.4 再增三项（第 6/7/8）、同日 W1 观测面任务再补**第 9 项** ⇒ **当前 9 项**，计数声明随每次增项按实同步（本句只记历史，**以 §7.4 实数为准**）。
> **照着抄就会把这个错一起抄进正典**。
> ⚠️ **本仓有两份同名前缀的 README，别混**：**仓根 `duckle/README.md` §7.4 = 引擎能力面**；
> **`deploy/duckle/README.md` §6 = 镜像/构建面**（`docker build --check`、容器内实跑…）。

### 1.3 生命周期 SOP（A→I）

> **没有验收的步骤等于没有步骤。** 验收不过不许进下一步。

> **每段三段式 + 回退栏**：**duckle 原生首选（分档）** / **我方保留或兜底** / **验收锚** / **回退**。
> 分档取 §1.1 的判据；**未验项必须在表里当场看得出来**。

| 阶段 | duckle 原生首选（分档） | 我方保留 / 兜底 | 验收锚 | 回退 |
|---|---|---|---|---|
| **A 摸清源**（不写码） | — **③归我方**（引擎没有「**网关/接口语义探针**」这件事）——**结构性理由**：质量/校验类组件**清一色「对已落地的数据做断言」**（本次会话实查 `list_components(kind=quality)` = **30 个、无一是探针**；`list_components(query='probe')` = **0**），而「网关语义」是**源侧外部事实**⇒ 组件面里**无处安放**（同 §1.1.1 E3 的证成方法学②「先问引擎」） | **A 阶段交付物**（字段清单（**每列的正确类型有人签字**）；主体维度有几个；**自然键（行粒度，含 `snapshot`）**；增量字段；抽样看**真实值**）；探针四条**全保留**（§1.3.1）；产物**同时喂引擎**（字段/类型/键 → 节点的 `data.schema` 声明） | 能写出幂等采集策略；能说出分页风格、跨度上限、**有无 count**、时间过滤是否**真生效**；引擎侧声明与探针结论**一致** | — |
| **B 选型定案** | —（决策纪律，见 §1.1）：**组件选型**本身是决策（分页策略 / 增量形态 / 校验组件 / 编排形态），但它**不是引擎能力**——给它打 ①/②/③ 属**定义域错配** | 按 §1.1 逐项定案，**命中例外须写证据**；例外红线（不变）；还须写「引擎为什么不行」 | 产出**决策记录**并登记进 §1.7，**含组件选型一栏**；**不留在对话里** | — |
| **C 契约** | **①首选**：机器面在引擎（`data.schema` + `qa.contract`——**定案出处**：现行乐檬采集链路的既有 gate，见 §1.3.3 与 `deploy/duckle/console/README.md`）；`drift` 门禁**拆两半**——**本地形态已验**、**远端源（S3/PG/REST）形态未验** ⇒ **②首选（未验）**（`duckle/README.md` §7.4 #1；§1.6 案例 7 只证明**有坑**，不等于远端形态已验；**销账结论与 Task 3 对齐**）| **人写的意图源** `contracts/`（写 `contracts/<域>/<源>.<表>.json`；契约=意图，引擎声明=实现）；⚠️ `drift` 源未声明 schema 时**静默 exit 0** ⇒ **先断言声明存在**；**最小验证动作（drift 远端形态）**：对一条**远端 REST 源**管线开 `drift` 跑一次，确认**结论随真实漂移变化**（不是恒 exit 0） | 元 schema 校验过（§1.2 第二档：手动跑）；与 `layout.prefix` 一致；`drift` **有效**（不是 exit 0） | 改契约（改前先想清楚 `contractVersion`） |
| **D 管线** | **①首选**（**仅指引擎机制那半边**；定案 = 2026-09-27 实测，版本 `duckle` **0.7.3** / `duckdb-cli` 1.5.4，命令与原始输出见 `.superpowers/sdd/2026-09-27-duckle-first-collection-flow-p1/task-1b-report.md`）：`src.rest` 分页（`paginationType` 枚举 = `none`/`cursor`/`offset`/`page`/`link`——**schema 级**，**没有 `nextUrl`**；**实测覆盖四风格**：`cursor`/`offset`/`page`/`link` **无 total 也能翻到耗尽**——停止信号：`offset` 短页 / `cursor` 指针缺失 / `link` 无 `rel="next"` / `page` 空页，只 `page` 多一次请求；`none` = 不分页，不在四问范围）+ 请求侧增量（`incrementalField` + `{incremental}`）+ `xf.incremental`（水位）；`totalCountPath` 可选、**仅省一次请求**；`maxPages` 撞上限**报错**（exit 1 + 自报截断行数，**非静默截断**）；`{incremental}` 可落 **url / body / header**（0.7.3 ✅ / **桌面 app 引擎 0.7.1 ❌** ⇒ 钉版本）；水位落 `<workspace>/state/`、**只在整条 run 成功时推进**。**②首选（未验）**：`xf.tumble`（窗口聚合）与 `qa.*`（管线内 gate——**定级随 F 行②**，不在此重复）——**1b 四问未覆盖**（出处同报告 §8）；**最小验证动作**：各跑一条带该组件的管线、断言窗口切分与聚合产出形状；**目标 API 适配**——乐源**是否支持 `since=`/游标**、**是否返回 `Link` 头**（决定 `link` 风格可用不可用）；**最小验证动作** = §1.3.1 探针：拿一条周窗管线加 `since={incremental}` 打一次**真实**请求，看网关是**按条件过滤**还是**照单全收**，并抓响应头看有无 `Link` | duckle 管线，**由真引擎产出**（MCP `create_pipeline` / `validate_pipeline`），**仓内不手编**；含 `data.schema` + `qa.contract` gate + `drift` 门禁 + 末页守卫（**`drift` 定级见 C 行：远端源形态未验**；引擎 `maxPages` 撞上限**报错**，好过静默截断；288 窗/天必须显式调）；目标 API 适配 | 引擎 `validate` 过；`drift` 有效（**先断言声明存在**，防假绿——见 §1.5「漂移」一条与 `duckle/README.md` §7.3 坑 1）；**分页配置成对**（`cursor` / `offset` 缺参 = **静默只取首页**——实测 8 行源只拿 3 行，**且 `validate` 与 run 都报 ok、抓不到**；`page` 无此风险）| 回退到上一版管线 JSON |
| **E 调度** | **①首选**（**定案**：双账套维度管线 **2026-09-26 cron 真跑并如实入账**，见 §1.7 登记行与 `deploy/duckle/README.md` §9；机制面出处 = 外部分析件）：**duckle 自带调度器**（cron 归一 / interval / IANA 时区且**未知区名报错不回落** / `Misfire` + 发生账本 / **跨进程排他锁** / 运行历史）| 按 §1.1.4 定归口；**薄 wrapper**（旧说「只做三件事（算窗口 env / 注入 / 调 runner）」**已被 §1.3.3 订正**——只做引擎做不到的）；**新纪律**：**一个 pipeline 只在一侧跑** | 排班触发一次且**如实入账**；改定义**两步都做了**（见 §1.3.2）| 停服务即回到「没有调度」 |
| **F 验收** | **②首选（未验）**：`qa.baseline`（**中位数**基线）/ `qa.reconcile` / `audit_*` | **四层**（§1.4）**全保留**——「独立通道 / 跨系统」两层是**业务口径** | 四层缺一层不算过；新增 gate 先跑过一轮真实周期；**tick 对账（#260 裁决，2026-09-28 起）**：任一时刻 hour 分区文件内**恰一个 batch_id**（最新 tick 完整快照）且**内容 = 网关当刻累计**——闭窗小时用 **`sh /opt/lemeng-diagnose.sh recon <H>`** 对照（湖回读 vs 网关翻页累计，容差 0；2026-09-29 换工具，原 `run-retail-day.sh recon`，**判据未改**）；「count(DISTINCT batch_id) 按 hour=1」作为**独立锚**只对**日批兜底层**继续成立（tick 层每 5 分钟换 batch_id 覆盖写，判据是快照等值，不是去重计数） | 自证没过时**拒写湖是正确行为**，不是故障 |
| **G 运维** | **①首选（本 PR 已验，销账 = #210：Task 6/7c/8）**：`alerts.json` **引擎侧事件链**（`failure`/`recovery` 触发 → POST 入 OO 流 → OO 告警 firing；**恢复 all-clear 跳冷却、Recovered 只报一轮**实测复现）；`/metrics` + `/api/runs` + receipt **可读**（`duckle/README.md` §7.4 第 9 项）；**`sla` 新鲜度巡检停更抓取**（`owners.json` 的 `maximumAge`——两组 Stale→Recovered 循环，引擎侧×OO 流毫秒对表）。**②首选（未验）**：**群侧投递**（企微两条消息**目视确认开环**）、**冷却重报窗口**（15 分钟一轮，源码级、未跨窗实测）、**事件载荷脱敏**（未单测）、其余通知通道；**最小验证动作**：群内目视确认探针的失败/恢复两条；对一条已 Stale 资产跨 15 分钟看重报节奏；抽一条实发事件载荷按凭据清单比对| **凭据↔账套 whoami 自证**；**lake 对象清单 + ETag 核对**（引擎无「列 bucket」组件）；**外层兜底重试**（引擎**没有运行级自动重试**）| 告警可达、**能响、能恢复**；**容量有余量**；观测有数据（`/metrics` 有数）；**主动停更能被巡检抓到** | 按 §1.5 速查处置各条 |
| **H 变更与回填** | **②首选（未验）**：`/api/backfills` + `/api/watermarks`（set/clear）+ `retry` CLI（**会拒绝重放会重写 sink 的 run**——特性不是缺陷）；**最小验证动作**：对**一条已跑过的**管线调一次 `/api/backfills` 换窗口重跑、读回 `state/` 看水位 `set`/`clear` 是否生效，再对一条**会重写 sink 的** run 跑 `retry`、确认它**按设计拒绝**（拒绝即通过）| 改契约 / 改节奏 / 加域；**回填 = 同一管线换窗口参数**（⚠️ **回填 = checkpoint 重放**：已冻结的条目只会原样重放，**修不了冻结缺口**——修数走 §1.4.1 的 heal 闭环，#528）；**窗口分批策略**（跨度上限是 §1.3.1 的实测结论）| 回填期逐日对账全绿 + 总量 sanity；**回填不影响在线链路** | 回填不影响在线链路（同管线、同写出通道） |
| **I 退役** | **②首选（未验）**：`catalog diff <rev>`（抓「资产还在但**失去所有写入者**」）+ `affected`；**最小验证动作**：在有 rev 的 workspace 上先跑一次**只读**的 `catalog diff <rev>`、确认输出能点名「失去所有写入者」的资产——**当前无已完成的退役案例**（§7 #2）⇒ 只能在**首次真退役**时销账 ⚠️ **但 2026-10-06 已出现首个「半步退役」案例**（只退了仓内、**湖上前缀未下线**），见下表后的订正块 | 旧前缀下线**前**必须（三步）：① 已有替代且对账过；② 消费面已切；③ 观察期 | 三项齐备才下前缀 | 保留前缀至观察期结束（细节见 §7 #2） |

> ⚠️ **首个「半步退役」案例（2026-10-06，乐檬旧湖前缀 `lemeng/retail_detail/…`）——不是完整执行，别当范例**：
> 仓内工件（staging 模型 `stg_lemeng_retail_detail.sql`、`sources.yml` 的 `retail_detail` 声明、
> `dbt_project.yml` 的 `lemeng_retail_prefix` / `account_book` 两个 var、投递 lock 的对应条目）
> 已按**仓内退役**删净；**湖上前缀一字未动、未下线**。
> **为什么只能退半步**：上面那三步里，**③ 观察期不满足**——该前缀所读的数据**一直在被生产方写**
> （2026-10-06 实测：`data-analysis` 每 5 min 一轮，跑在 `data.shanhaiyiguo.com`，**不在 openship 管辖内**），
> 即「旧写入者」从未消失 ⇒ 前缀不可下。**①（替代+对账）** 满足；**②（消费面切换）** 只切了本仓这一半。
> ⇒ 这次是**主动提前**：把「不必等观察期就能做的仓内清理」先做掉，**放弃**对本仓之外写入者的等待。
> 全部事实与出处见 §2 的旧前缀行与 §7 #2。**下次真退役照原三步走，别照抄这次的「半步」。**

> **找旧版「动作」栏的哪去了**：原表的**「动作」栏已重分配**进「duckle 原生首选」与
> 「我方保留 / 兜底」两栏（引擎做得了的归前者，我方纪律与交付物归后者）——**没有整栏删除**。

#### 1.3.1 阶段 A 的方法学（最容易省，也最贵）

以下四条全部来自「跳过 A 直接写码」的实测教训：

- **看真实值，不看文档**：乐檬 `date_type` 文档写 `format=date-time`，实测**时间分量被网关静默忽略**
  （06-07 点窗返回 10:43 的单）⇒ 单据系的时间过滤**不可用**，只能「当日全拉 + 按业务日拆写」。
- **能力探针要反着问**：乐檬响应**无 total** ⇒ 翻页只能到「短页」+ **末页守卫**；
  文档写分页上限 200（早期误读成 100），误读会直接改变页容量规划。
- **跨度上限分域实测**：乐檬单店 ≤3 个月 / 多店 ≤1 个月 / 单据系 >7 天直接拒绝
  ⇒ 决定回填的分批策略（H 阶段）。
- **主体要探到 whoami 级**：PAT 实测**绑定单账套**；且单店单日可能空窗 ⇒ 探针须**多店合查**。

#### 1.3.2 阶段 E 的三条设计规则（**引擎的既定行为，不是偶发**）

> ⚠️ **别与 `duckle/README.md` §7.3 的「三个坑」搞混——那是另一组三坑**
> （引擎能力面：`drift` 假绿 / `qa.freshness` 时区 / `pipelineHash` 不是数据指纹）。
> 本节这三条是**薄管线与 console 的既有行为**，完整实测依据见 `deploy/duckle/console/README.md`。
> **措辞从「坑」改成「规则」是有意的**：坑是「可能踩」，规则是「照此设计」——
> 这三条**不会**因为小心而消失。

1. **凡 `code.shell`，其后必须跟一个 `qa.contract` 判 `exit_code`** —— 非零退出**不让管线失败**
   （整条仍 `status: ok`，退出码只是**一行数据**）⇒ 结构要求：`rules = { exit_code: "in_range:0,0" }`。
2. **薄管线必须以 sink 收尾** —— 引擎是**惰性**的，gate 当叶子时**判据根本不被求值** ⇒ 布局要求。
3. **console 启动必须显式给 `--duckdb`** —— 否则每次触发都记 `last_run_error: "DuckDB engine isn't installed yet."` ⇒ 启动口径。

**改定义后必须两步都做**（漏一步 = 改了没生效，**且不报错**）——🔴 **按类分，别一律「重建容器」**
（2026-09-29 投递实测订正：原文把「② 重建容器」写成了对所有定义都适用）：

① **卷内定义**（`schedules/` / `pipelines/` / `alerts.json` / `owners.json`——落在**命名卷** `/workspace`）⇒
   **seed + 重启容器**：卷内容·**重启即重新读取**（SOP §F.2 第 1 类；2026-09-26 实测，**2026-09-29 两账套投递再次实测**：只用服务级 `…/restart`，新调度立刻生效）。
② **bind-mount 进来的文件**（仓内 `duckle/` → `/pipelines:ro`）⇒
   **同步 + 用 `serviceIds` 定向重建**——**「bind-mount 钉 inode、原子替换后运行中的容器仍看到旧文件」这条理由只对这一类成立**。
   （原例中的 `/opt/lemeng-run.sh` 已于 2026-09-29 随 #382 退役删除，今此类只剩 `duckle/`。）
（**别全量部署**——会重启 `pg_duckdb`。）

#### 1.3.3 薄 wrapper 的职责边界（🔴 **已退役**，2026-09-29；本节**保留在册以便查历史**——目标形态见 §1.1.7）

> 🔴 **退役更新（2026-09-29）**：本形态**两账套均已退役**——3120 与 64188 的 dim/retail 全部切到 **L0/L1**，薄管线文件、调度条目与告警规则已删（#364）。本节**只作历史查阅**。
> 统一方法论在 **§1.1.7**（L0 直连 / L1 foreach 父子两层，**不再新增 shell 包装**）；wrapper 的 8 项职责 7 项已有原生替代（21 组实测）。
> **新任务一律按 §1.1.7 选层**。旧脚本 `run-retail-day.sh` 里仍有用的只剩**只读诊断形**（`recon`/`rb`/`identity`）——**它们已由独立只读工具 `scripts/lemeng/diagnose.sh`（落 `/opt/lemeng-diagnose.sh`）承接**（2026-09-29，P1–P7 落地；新旧工具同参数对照**逐字相同**）；旧脚本与 `duckle/common/*.json` 的物理删除按批序排在**指针改向**之后。

**⚠️ 订正（2026-09-27，实测）**：本节原先写「只做三件、几十行、无状态」。**现状不是这样**：
`scripts/lemeng/run-retail-day.sh` 已是 **787 行**的**宿主级编排器**——它**自己起容器**跑引擎
（宿主上没有 duckle 可执行文件），职责长到了：逐窗子进程 / 失败窗登记与重试 /
凭据↔账套 whoami 自证 / 湖对象清单与 ETag 核对 / 幂等强判 / 漂移门禁。
外面还有一层**薄包装管线**（`code.shell` + `qa.contract` 闸）把它接上 duckle 调度器。
⇒ **「唯一自建增补」这句仍成立，但「只做三件、几十行」已不成立** ——
**别按旧描述去那个脚本里找逻辑**（逻辑在那个 shell 里，不在管线 JSON 里）。

**仍然成立的部分**：凭据走 **job/项目 env**，**不放宽** `deploy/duckle/entrypoint.sh` 的安全闸
（那道闸管「裸跑时不许做什么」，job 管「授权作业带凭据做什么」——**两者不是一回事**）。

**⚠️「不需要水位持久化」这句要带前提**：它只在「**按时钟窗口采集 + 幂等覆盖写**」时成立。
引擎**原生有**水位机制（`xf.incremental` / `src.rest` 的请求侧增量 / `xf.tumble` / `src.spool` /
`src.changed` …），状态落 `<workspace>/state/`，且**只在整条 run 成功时才推进**。
引擎文档把「自算窗口」的两种失效形态写成了表：状态**比汇旧** ⇒ 重复；**状态比汇新** ⇒ **静默缺口**
（无报错、无行数异常）。⇒ 迁移方向见 §1.1.6 ⑦（**引擎机制已实测；「迁不迁」与「目标 API 适配」仍未拍板**）。

#### 1.3.4 缓存（checkpoint）的设计约束（2026-10-09 #528 定案——任何源开 `checkpoint: true` 前必答）

引擎语义：checkpoint 是**追加式键值缓存**，条目 key = 节点配置 + 父行的哈希，**不含 run 标识**
⇒ **首抓永久化**：同键的后续 run（日批/close/回填）一律**重放第一次抓的内容**，源侧后来怎么变都进不来。

**开 checkpoint 前的必答题：「这个缓存条目何时失效？」** 引擎侧没有答案（装载路径丢弃条目的抓拍时间戳，
管线层拿不到 ⇒ TTL/过期判据**无处安放**，E3 引擎能力缺口，#528 已记）。管线层的合法姿态只有三种：

| 姿态 | 适用 | 前提 |
|---|---|---|
| ① **内容真不变的窗才开** | 维度/基础资料类快照 | 「内容不变」的假设**必须有独立对账面背书**——「闭窗 ⇒ 不再变」这类推导会被证伪（#528：闭窗后源侧仍在补录，实测同窗 472→476→482） |
| ② **接受冻结 + 独立对账 + 脚本化 heal 旁路** | 时序明细类（**零售明细已于 2026-10-21 退出本档 → 姿态 ③**，见下表后注） | 对账发现缺口后，修数走 `recon-day-heal.sh`（失效冻结条目 → 重抓 → 复验，§1.4.1）——**没有脚本化失败动作的姿态 ② 不成立**（一次性手删操作会蒸发） |
| ③ **不开** | 拿不准时 | 默认姿态 |

**2026-10-21 变更（#975）：零售明细 day / window 由姿态 ② 改为 ③（不开）。** 三条依据：

1. 该缓存**换不到东西**：两条管线 96 / 12 个源节点 `urlTemplate` 全空、`paginationType=none` ⇒ 无扇出、
   无分页，组件说明里的原生收益（「扇出死在第 90 万行不用重跑前 90 万」）在此不成立。
2. **成本无界**：body 含日期 ⇒ 键每天不同、条目只增不命中，引擎无保留期 ⇒ 两账套 `state/` 累积到 **11G**，
   已致数据机 96% 满，并让一次部署构建 ENOSPC。
3. 姿态 ② 的**三道闸根源都是冻结本身**（排班父管线由 now 推导 bizday / 回填 `WINDOW_OPEN` 守卫 /
   heal 旁路）；关掉后 heal 的旁路步骤自然空转（脚本对目录缺失有 `[ -f ] || continue` 兜底），
   也不再依赖「排班构造性只在闭窗后抓」。

代价：windows 每次跑重抓 24 窗 × 12 页（约 +576 请求/天，相对 tick 的 ~2300/天 约 +25%）；
同窗重试也重抓（这正是 #528 想要的语义）。**同族对照**：tick 变体本就是姿态 ③，两者 12 个源节点
除 `checkpoint` 外逐字段相同（差异 0）。

**两条伴生规则**（同案长出）：

- **守卫的判定单元 = 数据的真实闭窗单元，不是触发单元**。#528 的点火发生在上海 23:06——对 h00–h22
  每个窗自身都「已闭」，真正没闭的是**营业日** ⇒ 回填守卫做在回填父管线的 **bizday 级**（未闭窗 ⇒ 整条
  fail-closed 拒绝），而不是窗级。反之，**不变量不可能被违反的地方不加守卫**：调度侧父管线的 bizday 由
  now 推导恒已闭窗，加同款守卫是死代码。
- **回填 ≠ 修数**。回填 = 同一管线换窗口参数 = **重放**（§1.3 H 行）；它只能补「从没采过的窗」，
  补不了「采错了/采少了已冻结的窗」。缺口修复的唯一通路是 heal 旁路。

### 1.4 四层验收

**缺一层不算过。**

| 层 | 机制 | 抓什么 | 乐檬零售（3120）实测 |
|---|---|---|---|
| **自证** | 写后**回读对象存储**（行数 / 金额） | 上传 / 转换失败 | 过（19,678 行 / 合计 1,622,276.08；hour=17 窗 126,596.06 与既有基线**逐分吻合**） |
| **幂等** | **同 `batch_id`** 重跑 ETag / Size **逐字节一致**；**换** `batch_id` 则 ETag 变（**by design**——`batch_id` 是载荷列） | 不确定性 / 重复累积 | 强判通过 |
| **独立通道** | 预聚合端点（`branchindicator` / `itemsales`）vs 明细聚合；固化为 dbt `audit_*` 独立复算 | 引擎 / 口径侧 bug | **口径已于 2026-10-05 对齐**（issue #430/#431；2026-10-17 **净销售额改为冲退货**，issue #813——销售侧公式未变，另减退货侧 Σ(sale_money + order_detail_share_discount)，REPAID_RETURN 不计；**退货行同套赠品判别式（绝对值形态）**，2026-10-18 #908 定案 / 2026-10-19 #917 补到对账两副本）。旧数 +17,250.91（+1.15%）是**用旧口径跑的**——当时把「退货」理解反了：平台 `sale_money` **不冲减退货单**，真正要扣的是**换货单的「退回半边」**`(Σ非赠品行额 + order_total_money)/2`。对齐后在 **64188 上真机验证 5 天 × 63 店逐分归零**（执行面 `scripts/lemeng/recon-preagg.sh`）。⚠️ **本表这一列是 3120**：3120 的报表族自 2026-09-30 起被乐檬侧改坏（恒 `10006`），**无法复验**——64188 的结论不能直接搬给它，3120 这一格按「口径已对齐、通道不可用」记。**✅ 2026-10-18 订正：该「通道不可用」已不成立**——两账套对 `nhsoft.report.ai.itemsales.find` 实测 `code=0 请求成功`，且 certified 净额逐分吻合：64188 三店 `27,777.50` vs `27,777.50`、3120 两店 `9,893.40` vs `9,893.40`（2026-10-16）。⚠️ **但净额侧仍挂着过渡容差 `NET_ABS_TOL=200`（issue #814「退货晚到」未关）**：抽样日差为 0、容差未被用到，**落仓对账时必须把容差作为数据列带出**（否则闸自带 200 元盲区＝静默绿）。通道细节：凭据取容器 env `LEMENG_TOKEN`（**不是** `connections/lemeng.json` 的 `authToken`，后者 401）；`branch_nums` 必传且单次 ≤100 家。 |
| **跨系统** | 与旧平台同期关键指标一次性对比 | 口径 / 语义分歧 | 待回填后做 |

> ⚠️ **「引擎说 ok」≠「对象真的到了」**：`k1 ok (3 rows)` 只是引擎自认为成功，**必须回读**才算数。
> ✅ **2026-10-05 更新**：口径已对齐（见 §5.2 的注册机制与本行注），64188 上逐分归零。
> ⚠️ 仍然成立的老规矩：**「对账绿」只说明两侧算的是同一件事**，不等于口径已由业务确认——
> 换货半边是**我方逆向**出来的（乐檬未确认），赠品侧仍有硬依赖（`order_detail_state` 真机恒空）。

> **复算 vs 对账 —— 两种性质不同的控制，别写成同一个算式（2026-10-19 定案，issue #920）**
>
> | | 问的问题 | 对手方 | 该在哪 | 允许几份实现 |
> |---|---|---|---|---|
> | **复算**（内部一致性） | 我们自己算得对不对 | **同一份原始数据** | 贴着模型，同一工具链（dbt `audit_*`，独立**读路径**、不 ref staging） | **2 份**（构件 + 复算） |
> | **对账**（外部一致性） | 我们和客户系统对不对 | **外部系统**（乐檬端点） | **消费者**：读物化结果（`fct_retail_sale`）比外部源 | **0 份** —— 不自带等价算式 |
>
> 把两者混在一起（对账侧也自己算一遍）⇒ 同一业务规则出现两份并列实现、靠人手同步 ⇒ **静默漂移**
> （#813 容差地板、#917 退货侧判别式，两次都是这个形态）。机检 = `docs/architecture.md` §4.1 的 **B11**。

#### 1.4.1 判据落位：闸在管线内只判「不可能」，量级判在管线外

> 新增 **2026-10-05**（案例 = 乐檬零售量级判据选型，证据见 WeKnora 条目 `1b7724f1-45ae-4e36-b92e-8e7dc70468ca`）。
> **适用于每个源**；接新源时按此表逐栏表态，不要再逐个源重新吵。

| 判据性质 | 落哪 | 靠什么 | 失败代价 | 组件 |
|---|---|---|---|---|
| **结构 / 内部一致性**：末页容量、契约非空与范围、跨页合并后行数自洽、行数下限的**粗保险丝** | **采集管线内**（sink 前）| 今天这一份数据本身 | **fail-closed**：拦住采集 | 末页守卫 / `qa.contract` / `xf.assert` |
| **量级（vs 历史）** + **独立通道（vs 另一源）** | **管线外**：dbt `audit_*`（走 pg_duckdb，**免凭据**）| **历史** ＋ **第二条通路** | 事后告警，可人工复核 | dbt `audit_*` |
| **对账（vs 外部系统）** | **管线外**：dbt 读**物化结果** ⋈ 外部源快照 | **外部系统**（乐檬端点） | 事后台账，可人工复核 | dbt `recon_break` / `recon_run` + 采集侧只负责**取数落湖** |

> ⚠️ **对账侧不许自算口径**（2026-10-19，issue #920）：外部一致性只该问「我们发布的数 vs 别人的数」。
> 让对账侧再实现一遍口径 = 第二份并列实现（机检见 architecture §4.1 B11）。采集管线在这一层只做
> **取数**（调端点、落湖），比较与判定归 dbt。

**为什么「量级」不进管线内**（三条，逐条有实测）：
1. **它需要历史**，而管线内只有今天这一份。放进管线就得让管线去读自己的过去 ⇒ 耦合 + 冷启动 + 「状态按什么键分桶」一类坑（实测：`qa.baseline` 状态按「**运行名 + 节点 id**」键控，24 窗 foreach 共用同一子管线节点时会把**不同小时混进同一条基线**）。
2. **管线内是 fail-closed**，误伤代价是**整条采集判红**；而量级判据天生有误伤面（合法空窗、0 明细单、源侧事后增长——三者均实测）。**别拿高误伤面的判据去闭锁采集。**
3. **管线内对被采集数据「对账」是自证**：与被测方共享问句，只能证明「管线忠实执行了自己的问句」，**证明不了问句本身对**。

**求值时机**：源对**已关闭的小时**仍在变（实测同一窗 8 小时内行数 472 → 476 → 482）⇒ **量级判据必须在第二次点火之后求值**，且要把「收敛」本身当判据（当天值 vs 二次点火后的值）。这是它只能落在数仓层的又一理由。
⚠️ 同一实测还给出一个连带边界：**5min tick 持续往「最新那天」追写** ⇒ 拿最新那天比对完整日必然误报（首版就是这么写的，实跑当场误报 3 行）⇒ 判据对象必须是**最后一个已跑完日批的营业日**。

**判据口径（同样别收紧）**：量级判据是**灾难探测器，不是漂移探测器**。实测同一窗口按天总量在 8.5k ↔ 27k 之间摆动（含**换源后的档位切换**与假期季节性）⇒ 尾随中位数会跨档位被抬高，新档位的每一天都「看着低一档」。**小幅漂移 / 档位切换 / 季节性不该由它抓**（那属口径对账 + 人工解释）；它只抓**断崖**。收紧阈值 = 正常日子天天红。

**定稿线（settle line）—— 实时更新源的对账口径（2026-10-05 定）**：

> 口径原话：**实时更新的源，当天不追求完全准确；但「三天前的数据」必须完整对账。**

⇒ 按**定稿与否**分两档，判据与失败动作都不同：

| 档 | 对象 | 判据 | 容差 | 失败动作 |
|---|---|---|---|---|
| **未定稿** | 最新完整日批日 … T-2 | **量级早警**（灾难探测，即上条）| **宽** | 告警，**不阻断** |
| **已定稿** | **T-3 及更早** | **完整对账**：与源**同问句**重拉逐单比对（或独立通道）| **0** | **heal 闭环**（`recon-day-heal.sh`）：旁路失效冻结条目 → 回填 → 复验（#528 实测**裸回填 = checkpoint 重放**，修不了冻结缺口）|

**为什么这条线是必要的（机械事实，非偏好）**：湖里 **T-1 在当天两次点火之后就冻结**（写者只有 tick=今天、日批=昨天），而**源在更久之后仍在变**（实测同一窗 472 → 476 → 482）⇒ **冻住的湖会永久短于稳态的源**。⇒ **T-3 的完整对账正是用来发现这段差额并交 heal 闭环处理的**（`recon-day-heal.sh`：旁路失效冻结 checkpoint 条目 → 回填 → 复验；**裸回填 = checkpoint 重放，修不了冻结缺口**，见 #528 实测）；没有它，这段缺口无人知晓。**未定稿档的当天口径不要去抠完全准确**（源还在变，抠了也是白抠）。

**重述窗口（restatement window）——2026-10-19，issue #814**

定稿线对账 + heal 闭环原先只覆盖「**T-3 那一天**」，而源侧可能在更久之后仍在长
（#528 实测同一窗行数 472 → 476 → 482）。采集侧因此需要一条**滚动重述窗口**：

| 层 | 做什么 | 落点 |
|---|---|---|
| **窗口** | 每天对 **T-3 … T-3−(N−1)**（默认 N=7）**逐日**跑一次 heal 闭环（判别 → 真缺口才旁路失效 checkpoint → 重采 → 复验）| `scripts/lemeng/recon-restate.sh`（投递到 `/opt/lemeng-recon-restate.sh`）|
| **触发** | **台账粗筛**：只对 `recon_run` 里 `break_count>0` 或 `status ∈ {within_tol, not_evaluated}` 的日子跑（**零网关调用的第一刀**）；精确判别交给 heal 的逐小时行数比对（行齐就 `HEAL_OK`、不写湖）| 同上；台账是 dbt 每日重建的**派生物**，故必须先 materialize |
| **覆盖** | **两账套**（3120 / 64188）。⚠️ 旧排班**只跑 3120** ⇒ 64188 此前从未被 heal 覆盖 | openship job |

⚠️ **边界（别把重述窗口当万能）**：它补的是「**行数**」层面的缺口（晚到 / 后补 / 重述的行）。
若台账差额来自「**报表引擎 ↔ 订单行接口的口径差**」（#814 复诊：逐小时行数 0 容差、
强制重采后金额一分未变——br20 48.19 / br31 49.00 / br127 25.87），**重采补不回来**；
这类日子写进 `RESTATE_EXCLUDE`，按本节的过渡容差记账，直到源头能给出单据/商品级明细。
**判据**：`recon-day` 逐小时行数 0 容差但金额仍差 ⇒ 口径差，不是缺口。

**两条结构性缺口（照实记，别读成绿）**：
- 诊断脚本的 `recon` 与采集**同问句**（工具自陈「换的是通道，不是问句」）⇒ 只能发现**执行偏差**，**发现不了问句本身错**。
- 引擎实测（`duckle 0.7.4`，2026-10-05）：**管线脚本里一旦出现建凭据语句，`qa.baseline` 对整条管线静默记 0**（run 状态仍是 ok、无报错），与是不是 S3 / 是不是远程 / 有没有声明 schema / 分支顺序**全都无关**（对照矩阵见 WeKnora 条目）。⇒ **`qa.baseline` 在带凭据的采集管线上不可用**；等价的量级判据放管线外（dbt）。

### 1.5 运维与故障速查

| 现象 | 先看哪 |
|---|---|
| 排班没触发 / console 本身有问题 | **经 openship MCP** 读该 console 服务的日志（数据面 project → 服务 → 日志端点）——正常应是**四行**：console on / workspace / DuckDB / **sign-in required**。⚠️ **别裸 SSH 上机敲 `docker logs`**（根本法则·唯一通道；console 是 openship 管的服务，日志走 MCP 拿得到） |
| 跑了但失败 | **按形态分**（🔴 2026-09-29 收口：薄壳已退役，日更链一律走 L0/L1）：<br>· **L0/L1（现行）**：`runs/receipts/run-*.json`（**回执**——逐节点 `status` / `rows` / 耗时）＋ `runs/<pipeline_id>.json`（**运行记录**——终态 + **这次 run 写了哪些资产**）。⚠️ **两个目录不是一个东西**，`assets` **只在运行记录里**（回执对**任何**管线都不带它）；<br>· **薄壳（仅历史形态适用）**：卷里 `logs/*.csv`（含 wrapper 完整 stdout）。<br>⚠️ 这些都在**容器/卷里**，一律**经 MCP 的容器内执行端点**读，**不要上机** |
| ⚠️ **`/api/schedules` 的 GET 不回运行状态** | 文件里已有 `last_run_at`，GET 却恒 `null` ⇒ **别信那个 GET**，读 `schedules.json` 或 serve 日志 |
| ⚠️ **回执账里的 `run-manual-*` ≠ 有人手点** | 薄管线班的**内层引擎直调**（wrapper「起引擎退化成直接调用」）共享同一 workspace 回执账，CLI 直调一律标 `trigger=manual`——识别法：数量恰=时窗数、逐窗时刻与外层 `run-scheduled-*` 的窗口推进对齐（2026-09-28 首跑验收实测，差点当入侵查） |
| 自证没过（`ASSERT_FAIL:` / `DIM_FAILED`） | **拒写湖是正确行为**（#205），**不是故障** |
| 容量撞顶 | 末页哨兵命中 ⇒ **fail-loud 不丢数**。**余量按阈值算，不按「页数 × 容量」算**——哨兵页占一页，真实阈值 = (页数 − 1) × 页容量 |
| 漂移 | 先看**声明是否存在**：`drift` 在「源未声明 schema」时**静默 `exit 0`（假绿）** ⇒ 门禁必须先断言「声明存在」，再判 drift 结论 |
| 观测没数据（OO 流里没有 `_ops` 行） | **按管线查**：**零售三条已自带管线内 `_ops` 投递**（tick/windows/close，`su→op→wh`，#406/#410——tick 与 close 已实测在收行）；**L0 两条决定不做**（上游 duckle 的 sink 取行缺陷：脚本前导的 `CREATE SECRET` 自己返回一行被当成数据，见 #414）——L0 的观测面改用 `owners.json` 湖对象锚 + 运行记录/回执。⚠️ OO 不可达时 tick run 会**红**——error 指 observe.hookflow.cn 即此因，**不是采集失败**（方言见管线 `_note` ⑩）。旧字面量 `OPS_SINK=DISABLED`（薄壳形态、issue **#210**）随 wrapper 退役成为历史 |
| **下游数据陈旧（采集绿、报表陈）** | **先查物化有没有在跑**——2026-09-26 实测：37 个 job 无一跑 dbt，PG 停在 09-23（详见 §0 与 §1.6）。⚠️ **2026-09-28 起物化 job 已在跑**（见 §3），这个现象不再由「没 job」引起 ⇒ **别照这条判，先看下一行** |
| **下游看不见（物化在跑、消费端却空）** | 四步查，**四处都是静默失败**（2026-09-28 实测；跟踪 #297 / #298）：① **路由挂没挂**——无身份打 `POST /api/modules/data/{query,mcp}` 应回 **401**（**404 = 没挂载**）；② **三张表的行数**——`data.metrics`（空 = 词表没物化）/ `data.reports`（空 = 报表没登记）/ `data.query_audit`（空 = 从没人问过）；③ **Gate-B**——平台容器内 `dns.lookup('pg_duckdb')` 必须解析（**ENOTFOUND ⇒ 网络掉了**，容器重建即掉，重做步骤见 SOP P7）；④ **仓库连接的 `search_path`**——不设则报 `relation "<模型名>" does not exist`（见 SOP P8b） |
| **问数偶发 `warehouse_transient`（或审计里冒出 `lake_race_retry`）** | 读湖撞写入的 **ETag 竞态已定案**（#452，§1.6 案例 19）：咽喉自动「识别 ETag 形状 → 退避 1s → **重试恰一次**」——重试成功对消费方**无感**，审计照写 `verdict='ok', reason='lake_race_retry'`（**判「重试长期是否够用」的唯一数据源**，#452 spec §3.5；频率在 `data.query_audit` 按 `reason` 数）；仍撞 ⇒ `reason='warehouse_transient'`（detail 保 DuckDB 原文）＝**活跃写入窗内持续冲突**——**别当服务 bug 排查**：先查触发方（物化 job / tick）是否与查询同窗（物化已错峰 `27 3` 避 tick `*/5`，见 §3） |
| 改定义后没生效 | 检查**两步**是否都做了：re-seed 进 workspace 卷 + **重启容器**（卷内定义重启即读；改 env 键才需定向重建） |
| **对账缺口「回填了还在」** | 回填 = checkpoint **重放**，修不了冻结缺口（§1.3.4）——走 heal 闭环：`recon-day-heal.sh`（旁路失效冻结条目 → 重抓 → 复验；§1.4.1，#528） |
| 🔴 **close 管线白天别手动触发** | 引擎残留边界（#528 记录未修）：checkpoint 键不含 run 标识 ⇒ 白天手动跑 close 会把**当日已闭小时**的抓拍冻结、次日重放旧内容。close 只让**调度**跑（UTC `0 16`）；确需诊断用 `diagnose.sh`（只读），修数走 heal 旁路。引擎修了再解除本条 |

#### 1.5.1 两个名词：**运行记录**（run record）与**回执**（receipt）—— 🔴 **别互换**（2026-09-29 收口）

| 词 | 文件 | 形状 / 上限 | 带 `assets`？ | 用途 |
|---|---|---|---|---|
| **运行记录**（run record） | `runs/<pipeline_id>.json` | **数组**，50 条/管线 | ✅ **带** | **新鲜度时钟的输入**（owners ②）+ 判「这次 run 写了哪些资产」 |
| **回执**（receipt） | `runs/receipts/run-*.json` | 200 条（正典 §1.6） | ❌ **不带** | **逐节点**排障（`nodes.<id>.rows` / `status` / 每节点耗时） |

⚠️ **本仓踩过这个坑**：曾据「L0 的回执里没有 `assets`、同日薄管线却『正常带』」得出「L0 形态有问题」——
**那个对比不成立**：`assets` **只在运行记录里**，**回执对任何管线都不带它**（两边其实都没有）。
⇒ 判「这次 run 写了哪些资产」**只能**看运行记录；判「哪个节点慢/挂」看回执。

**告警（两条并存，覆盖不同的面；🔴 2026-09-29 收口）**：

| 面 | 覆盖 | 门槛 |
|---|---|---|
| **引擎原生 `alerts.json`** —— **L0/L1 的告警面**（✅ 转投链路 2026-09-27 拍板并配置在位：引擎 → OO org=miyuan `data_alerts` 流 → OO 规则 → 企微；机制正文唯一出处 = `deploy/duckle/console/README.md` §引擎原生告警。⚠️ 覆盖面：仅已 seed `alerts.json` 的 console（3120 ✓，64188 未 seed）；企微侧端到端开环确认遗留（#210）。分工终局见 §1.5.3 / #538） | 打进本 console 的**任何非 ok run**（含 wrapper 之前就失败的路径：源不存在、DuckDB 起不来、判据失败…） | **无门槛** |
| wrapper 的 `EXIT` trap —— **仅薄壳形态适用**（已退役） | 只有 wrapper **自己判红**的路径 | 仅 `LEMENG_NOTIFY=1`（薄管线会设 ⇒ 人工/诊断跑不刷群） |

**wrapper 侧细节**（供历史形态排障）：接在 wrapper 的 `EXIT` trap（覆盖**所有**失败路径，且只有一份代码），
**不接在管线的 `ctl.try`**（其配置未建模，靠猜属性名配它 = **静默不生效**）；缺 `WECOM_WEBHOOK_URL` 时打
`NOTIFY_SKIPPED`（**不静默**）；**告警绝不改退出码**——别把判红变成绿。

#### 1.5.2 发布面判据-节奏对齐表（#536，2026-10-10 实测定稿）

> **给发布面/物化面写新鲜度容差前，先照此表核「采集滞后 + 发布周期」**——容差拍天数必踩
> 「零点起结构性红到中午发布完成」（#534 首夜 ~200 条企微误报的根因）。「停更」≠「断流」，
> 判红先核发布节奏再定级。

| 发布面（平台 PG） | 数据来源 | 采集滞后 | 物化（dbt） | 发布（整批替换） | 探活项/容差 | 零点时面内最新 |
|---|---|---|---|---|---|---|
| `fct_retail_sale`（湖经语义层） | 零售 windows/tick/close（双账套） | 当日盘中即到（tick `*/5`） | UTC `27 3,7,9,11,13,15`（上海 11:27/15:27/17:27/19:27/21:27/23:27） | 语义物化同左 | ④ 上海今天−2 | T-1（close 上海 0 点收日） |
| `data.dim_branch` / `data.dim_item` | dim l0 日更快照（UTC `0 2` / `0 11`） | T-0（当天快照） | 同左 | 维表发布 UTC `43 3`（上海 11:43） | ⑥ snapshot ≥ 上海今天−3 | T-2 |
| `data.dim_item_price` | item_price l0（UTC `15 11`，R1 增量） | T-1 | 同左 | 维表发布同上 | **⑧ snapshot ≥ 上海今天−3**（2026-10-10 增设：价目管线失败曾无告警，#538） | T-2 |
| `data.dim_transfer_out` / `data.dim_wholesale_out` | transfer/wholesale l0（UTC `35 15` / `45 15`，采**昨日制单日**） | **T-1** | UTC `27 3,7,9,11,13,15`（每 2 小时） | 维表发布 UTC `43 3` | （随 ⑦ 面） | **T-3** |
| `data.dim_settlement_order_line`（取价面） | 上两行的 staging 归一 | 同上 | 同上 | 同上 | **⑦ 时段感知：上海 13 点前 −3、后 −2** | **T-3**（结构下限） |

| `recon_run` / `recon_break`（口径对账**台账**） | 湖 `lemeng/recon_source`（父管线每日 T-3 线；console UTC `16:30` 64188 / `16:40` 3120） | **T-3**（管线按「上海日 −3」定稿） | UTC `27 3,7,9,11,13,15`（上海 11:27/15:27/17:27/19:27/21:27/23:27） | 同左（dbt 表整表替换） | **⑨ 台账覆盖（时段感知）**：上海 12 点前按 −4、之后按 −3，须在 `recon_run` 里有行；`not_evaluated`（源侧零返回）与 `source_cover_pct < 1` **各成一条**——探活断言 **⑪⑫⑬**（`wire-warehouse.sh`，advisory，见 §1.5.3） | **T-3** |

> 要点：调出/批发链「23:35 采 T-1 → 次日 11:43 发布」意味着**取价面每天零点必然停在 T-3**——
> 这不是故障，是节奏；判据必须容得下它。新增发布面时：先在本表加行，再定探活容差。

#### 1.5.3 监控职责分工（🔴 决策定案 2026-10-10，用户裁决；执行计划 #538）

> 背景：监控职责讨论过多轮，执行物散落未收口——**2026-09-27 用户已拍板「引擎原生告警经 OO 转投企微」并端到端配置在位**
> （OO org=mytech（显示名 2026-10-22 前为 miyuan）：`data_alerts_failure`/`data_alerts_recovery` 等 10 条 enabled 规则（2026-10-22 抖音退役后；原 14 条含抖音 5 条），机制正文唯一出处 =
> `deploy/duckle/console/README.md` §引擎原生告警）；未完成的是**开环确认（企微侧）、看门狗、覆盖面（L0 事件行 / 64188 未 seed alerts）**。
> 本节是**终局分工**，配 skill `.claude/skills/data-monitor/`（执法器）强制后续执行；执行状态表与
> #538 同步，翻绿/翻红都要改这里。
>
> **通用接入手册（公司级）**：任何新项目把日志/遥测/事件行接入 OO 并形成预警的标准操作 =
> team-harness `docs/standards/observability.md`（2026-10-10 起，本节为其在采集板块的专用特化）。
>
> ⚠️ **OO API 认 identifier 不认显示名**（miyuan 的 identifier 是长随机串，`default`/`woke` 例外恰好可读）——
> 2026-10-10 审计错按显示名查 org 得出「0 规则」假阴性。多 org 审计先 `GetUserOrganizations` 列全再查。

**三层职责（谁拥有语义，谁写判据；告警必须从一条通道出）**：

| 层 | 职责 | 明确不做 |
|---|---|---|
| **OpenObserve** | 数据面**预警面**：对管线 run 事件（现网 `data_alerts` 流，**org=mytech**——⚠️ 2026-10-22 订正：显示名已由 miyuan 改为 mytech，identifier `3IJ5tM4en3A06FzcJQhoHMTl4Xe` 不变）配规则（status≠ok / 该来的没来），通知企微；全量观测检索（run 史/判红史/基建日志一处 SQL）。**已在位**：管线失败/恢复、tick 缺席、基建探活（casdoor/novu/wecom）、宿主资源、桥自警共 10 条 enabled 规则（2026-10-22 抖音源退役，5 条抖音规则删除；在位清单唯一事实源 = `deploy/oo-alert-registry.txt`，对账 job 每 30 分钟核）。⚠️ 该构建定时规则**流静默即评估跳过 ⇒ 状态机冻结**（恢复永不来、silence 到期重发成风暴；复位 = disable→enable，2026-10-22 `wecom_bridge_delivery_failed` 实证，详见 WeKnora「OO 告警链路排障」条目） | **不是探测器**：不 docker exec、不持库凭据、**不在 OO SQL 里写对账/新鲜度语义**（阈值与缺席规则只消费数据面吐出的判红结论） |
| **openship** | 机器/进程/任务层：容器 crash_loop、服务器不可达、部署结果、job 崩溃；**告警兜底看门狗**（盯 OO 内最后证据年龄，OO 闪断即红——OO 2026-10-09 实测有 unreachable→0s 闪断，看门狗是切换前置） | 不承载语义判据脚本（历史遗留的探活/物化 job 保留，Phase 2 起通知收敛为 job 崩溃级） |
| **数据面** | **判据本体**：对账、新鲜度容差（§1.5.2 对齐表）、契约 gate——脚本/qa gate 实现，判红结论**逐行吐进 OO 流**（带 org/账套标签） | — |

**伸缩论据**：事件行带 org 标签 ⇒ OO 规则**一条覆盖全部租户**，告警规则数不随租户涨（否决「每租户一份 openship job 副本」路线；day-heal 类多账套循环另案 #538）。

**执行状态（与 #538 同步；未过实测的环节不翻绿）**：

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | **开环确认 ✅（结论出乎意料）**：摄取/评估/点火全通（transitions 与测试行秒级吻合），**但「点火→目的地发送」在本 OO 构建内静默死**（零发送日志、`last_notified` 恒空；手动直发同 URL `errcode:0` 隔离出群与机器人无恙）——即 09-27 的「端到端实测」实际止步于 OO firing，投递腿先天未通。**过渡架构（用户裁决）**：`scripts/lemeng/oo-notify-bridge.sh` 桥接通知——直读本机 OO 元库 `alert_state_transitions` 新点火 → 直发企微（at-least-once，状态水位 `oo-notify-bridge` job 驱动）；治本 = 钉版升级 OO（另案 #53x）。**流布局定案 ✅**：`data_alerts` 不动 / `oo_watchdog_heartbeat` / `data_plane_probes`（Phase 1）。**看门狗 v1 ✅**：`oo-watchdog.sh`（healthz+心跳摄取）+ openship job `*/15`。**桥 v1.2（2026-10-22）**：通道②（data_plane_probes 判红行）加 **per-check 12h 冷却**——持续红（如 `marts_fresh` ⑨ 每 5 分钟一行 ERR）曾逐行转发轰炸企微（实测 04:47–04:57 UTC 每 2 分钟一条）；现首报即时、同断言 12h 内静默、水位照推不丢行，新断言仍即时报（机侧 `/opt/lemeng-oo-notify-bridge.sh`，备份 `.bak-v1.2-20261022`） | ✅（治本转 #53x） |
| 1 | 覆盖面补齐：管线 run 事件行（L0 绕 #414；transfer/wholesale/client 无事件行）；**64188 卷 seed `alerts.json`/`owners.json`**（~~现未 seed~~ **✅ 已完成：2026-10-06 落盘、2026-10-16 实查确认**——`/workspace/` 两份在位且规则为**账套无关**模式（`lemeng.dim.*.l0`、`lemeng.retail.tick.l1`、`lemeng.recon.*`…）正好覆盖 64188 自己的管线；本行旧文作废）；在位 14 条规则逐条过分工与 §1.5.2 对齐（能复用不新建）；探活逐断言吐判红行进 `data_plane_probes`；
  **✅ 已接线（#898，2026-10-18；**Phase 1 第一刀**）：「战区未登记」** —— 判据本体在 dbt 侧
  （`dbt/tests/lemeng/warn_region_unregistered.sql`，覆盖「新 `region_id` 未进 `dim_region`」），
  但 **dbt 的 `WARN=` 在本仓没有任何消费方**（全仓 grep 只命中测试夹具）⇒ 它只进物化 job 日志、**不构成告警**。
  ⇒ 接线走**探活断言**：`wire-warehouse.sh` 的 ⑩ `region_registered`（**advisory**，挂在既有 `*/5` job 内）
  吐判红行进 `data_plane_probes`；**通知由桥承担**（`oo-notify-bridge.sh` 通道② = `verdict <> 'OK'` → 企微，≤2 分钟）
  ⇒ **不新建 OO 规则**，也**不让 job 变红**（红线③：语义判据不走 openship 通知）。
  ⚠️ **订正一处旧论（本行原文）**：「规则不存在时投了也没人消费」**是错的** —— 桥自 Phase 0 起就在消费
  `data_plane_probes`（`WHERE verdict <> 'OK'`）；该流实测 **23,778 行**、最新时间戳当日仍在长。
  **判据接上即可见**，缺的从来不是规则，是判据本身没进那条流。
  ✅ **判据本意 = 发现新区**（变化检测），**不是覆盖率 100%**；2026-10-18 真机实测覆盖**完整**
  （物化 `PASS=303 WARN=0 ERROR=0`、直查未登记 `region_id` 为空）⇒ 接线后**当前零命中**，不会一上来就结构性红。
  ⚠️ 立项时按「枚举接口实测有门店无行」外推的「覆盖可能不全 ⇒ 首次跑就红」**已被真机证伪**——别照抄那条外推。
  **反向测试见 #898**（`WIRE_REGION_SELFTEST` 造一次真红 ⇒ 企微收到）。
  **openship 通知不拆**双通道并行 1-2 周；**R12 存量 L2 判据**：「契约有 `sensitivity !== 'none'` 列 **且** `data.metrics` 存在 `source='l2'` 行」⇒ 逐行吐进 `data_plane_probes`。**契约侧闸已就位**（②b，`2026-10-18`）；**判据本体（运行期那条）待本 Phase 的流就位后接线**。 | **进行中**（第一刀 ✅ #898 战区未登记；✅ #905 口径对账台账 ⑪⑫⑬；其余仍挂着） |
| 2 | 通知切换（数据面告警归 OO，openship 收敛 job 崩溃级）；**拆桥**（OO 升级修好投递腿后，桥接退役）；看门狗升级（search 凭据 → 证据年龄检查）；悬空 duckle→openship webhook 处置；本表翻绿 + 基建速查订正 | **未开工** |

**红线（执法器 skill 同款）**：① OO 不写对账/新鲜度语义；② 新管线/新发布面必带事件行 + 对齐表行 + OO 规则（或登记豁免+兜底路径），缺一不验收；③ 告警单出口（企微经 OO；openship 只出基础设施与 job 崩溃级）；④ 任何告警组件不许静默失效——看门狗盯 OO，OO 规则缺席/到期不发 = 配置漂移，按故障算。

  **✅ 已接线：「口径对账台账」的三条 advisory 判据**（#892，2026-10-18）——
  判据本体在数据面（PR #899：`recon_run` 加 `source_cover_pct`），**告警面照 ⑩ 的同款形态接线**
  （`wire-warehouse.sh` 断言 ⑪⑫⑬，advisory ⇒ 不翻 job rc ⇒ 走桥投递企微，合红线③）：

  | 断言 | 抓什么 | 处置 |
  |---|---|---|
  | **⑪ 台账覆盖** | 目标营业日**缺 `recon_run` 行** | **对账没跑完**——与「跑了但账不平」完全不同的处置 |
  | **⑫ 源侧零返回** | `status = not_evaluated` | **源故障**，**绝不能与「数不平」混**（计划稿 §G） |
  | **⑬ 源返回率** | `source_cover_pct < 1`（且非 ⑫） | **先怀疑源**，不要先怀疑账 |

  ⑬ 的由来是一条**真实误判**：2026-10-18 把 64188/10-15 的源只返 51/74 家误读成「23 家结构性缺口」
  并推到客户面前，而**同一条请求原样重跑即全返**——「源少返回」与「真不平」在旧台账里**形状一模一样**。
  **容差是时段感知的**（对齐 §1.5.2）：台账是 dbt 物化件（UTC `27 3,7,9,11,13,15` = 上海 11:27/15:27/…/23:27，每 2 小时），
  故目标日 = 上海今天−3，**上海 12 点前按 −4**；期望的 (账套, control) 组合取自**近 7 天实际出现过的组合**
  （不硬编码账套）。⚠️ ⑪ **基线为空不算过**（`ERR 近 7 天台账没有任何行`）——否则「台账整体消失」会假绿。
  **反向测试**：`WIRE_RECON_SELFTEST=1 sh wire-warehouse.sh --check` ⇒ 三条各注入一行假判红 ⇒ 桥送企微。
  **兜底（与本组互补，不重叠）**：「对账**没跑**」在数据层另有 §1.6 案例 35 的父管线收尾汇总 freshness 锚；
  「**跑了但失败**」由引擎 alerts 的 failure 事件兜。

### 1.6 案例库（只增不改；**勘正错指针/错出处不算改**）

> **只增不改**（指**已发布**的条目）；**勘正错指针 / 错出处不算改**——本节的规则格正是靠它才敢与案例对齐。
> 每条规则指回它长出来的案例。**无案例的不写**（进 §7 待沉淀）。

| # | 案例 | 长出的规则 |
|---|---|---|
| 1 | 网关 `date_type` 文档写 `format=date-time`，实测**时间分量被静默忽略**（06-07 点窗返回 10:43 的单） | §1.3.1「看真实值，不看文档」 |
| 2 | 乐檬响应**无 total** ⇒ 只能翻页到短页 | §1.3.1 末页守卫；§1.5 容量条 |
| 3 | **生产峰值 1459 单/时击穿 1400 阈值**（哨兵命中、窗口断在 19 点）⇒ 扩容到 12 页（#197） | §1.5「余量按阈值算」；**阈值 = (页数 − 1) × 页容量** |
| 4 | 维度域原写行粒度键 `(system_book, item_num)`，**漏了 `snapshot`**（2026-09-26 订正） | §1.1.2 粒度纪律 |
| 5 | `snk.parquet` / `snk.s3` 都不通，而 `snk.minio` **可直写 ZOS** | §1.1.1 E3 的证成方法学 |
| 6 | 同 `batch_id` 重跑 **ETag/Size 逐字节一致**；换 `batch_id` 则变 | §1.4 幂等层的判据（「变」是 by design） |
| 7 | `drift` 在「源未声明 schema」时**静默 `exit 0`** | §1.5 漂移条 + §1.3 阶段 D 的「先断言声明存在」 |
| 8 | `code.shell` 节点 `exit 3`，整条管线仍 `status: ok` | §1.3.2 规则 1 |
| 9 | gate 当叶子时判据**根本不被求值**（引擎惰性） | §1.3.2 规则 2 |
| 10 | 调度条目带不了自己的 env（塞 `env`/`args`/`params` 被静默丢弃） | §1.1.4「一账套一个 console」 |
| 11 | 文件 bind-mount 钉 inode ⇒ 原子替换后运行中的容器**仍看到旧文件** | §1.3.2「改定义必须两步」 |
| 12 | 存量乐檬 parquet**列全是字符串**（金额/时间是 VARCHAR），聚合直接报错 | layered spec §9 坑 1 ⇒ §1.1.2「落盘即定型」 |
| 13 | 同一域不同日期**列数不同**（46 vs 43）⇒ union 直接读不出 | §1.1.2 字段集稳定（禁 `union_by_name`） |
| 14 | 同一张表里两个时间列**两种格式**（`2026-07-01 10:02:34` vs `20260707`） | §1.1.2「落盘即定型」 |
| 15 | pg_duckdb **不接受 `DOUBLE`** 作 cast 目标（`type "double" is only a shell`） | `contracts/` 类型枚举里**故意不含 `double`** |
| 16 | 读 parquet 点名取列必须 **`r['列名']` + 别名 `r`**；`SELECT *` 能过、点名报 `column does not exist` | dbt staging 门禁（`check-data-models` 第 ① 项） |
| 17 | **物化断链**：采集每天绿、湖已领先两天，而 PG **停在 09-23**；37 个 job 无一跑 dbt；**没有任何东西报错** | §0 完成判据「落湖归我、下游看得见」；§1.5「下游数据陈旧」一条 |
| 18 | 「一账套一 console」原写成**结构性约束**；实测（本地 + **生产 0.7.4 容器**）证明被强制的只是「**调度条目**带不了 env」——账号维度可走 `${ITER_ITEM_*}` + `connectionRef`（两行驱动两连接，回显实录 `TOKEN-A`/`TOKEN-B` 各一次） | §1.1.4 订正：那是**权衡**（一个 workspace 一把钥匙护所有凭据 + 共享故障域），**不是引擎铁律** |
| 19 | **引擎 src.rest 响应体上限**：`REST response read: response too big for into_string`（HTTP 客户端 into_string 编译期默认，DUCKLE_* 配置面**无旋钮**——runner 二进制 strings 全查）。实测 **12.3MB 过（7,688 行）/ 32.9MB 炸（20,213 行）**，且**单店即可越限** ⇒ 逐店扇出救不了大店；全量快照直采对本源不可行（#499 首跑实测三墙之一） | 大响应源设计前先测「单请求响应上限」；超限源改**请求侧增量**（变更窗响应 KB 级）——正典 §1.1 已有同族先例 |
| 20 | **首跑同日覆盖首载**：backfill 写 `bizday=今日` 后当天手动触发日常增量（同 bizday 同 key）⇒ 覆盖写把 20.4 万行首载文件换成 66 行增量——**无报错、行数腰斩只能靠 staging 对数发现** | 首载日 ≠ 首个日常 run 日（调度错开一天）；或首载写独立 bizday。靠「写后回读对数」抓的，不是靠跑绿 |
| 21 | **手抄门店清单两次引入重复元素**（`37,37`），且第二次是在修正第一次时再犯——管道下游（键唯一断言/门店覆盖守卫）会抓，但生成时就该防 | 门店/ID 清单一律**从源头管线逐字提取 + 唯一性断言**（`gen-item-price-pipeline.mjs` 的提取器即为此改），绝不手抄 |
| 22 | **读湖三方同撞一个竞态**（tick `*/5` 重写与读并发）：物化 job `20 3` 首跑**天天撞**（03:20 读湖恰逢 tick 重写 hour=10 文件）、问数咽喉对湖的读随时可撞（spec ③ 读「今天」的视图尤甚）、对账 audit 撞未闭窗营业日 ⇒ 三路定案（#452/#462）：读侧咽喉**重试恰一次**（`lake_race_retry` / `warehouse_transient` 归因）+ 物化**错峰 `27 3`** + audit **只比已闭窗营业日** | §1.5「问数偶发 `warehouse_transient`」一条；§3 物化调度行错峰注 |
| 23 | **checkpoint 首抓永久化**：10-05 手动回填在上海 23:06 点火，把尚未结束的营业日整日截断快照冻结；10-01/04 闭窗后源侧补录进不来 ⇒ 三天对账红。**裸回填后逐格「正常」实为重放假象**——条目 key 不含 run 标识，回填根本没碰源（#528） | §1.3.4 全节（缓存三姿态 / 守卫判定单元 = 闭窗单元 / 回填≠修数）；§1.4.1 失败动作 = heal 闭环；§1.5「回填了还在」速查条 |
| 24 | **seed 全量期望集双害**：64188 卷恒报 3 条他账套管线 DRIFT（真漂移信号被淹）；全量 seed 会把他账套管线灌进卷。裁决后首日执行，误删一件**无后缀共享件**被 `--check` 当轮抓出（#531/#532） | 期望集 = 共享族 + 本账套后缀族；**孤儿判定机械化**（卷内只有「他账套后缀」可删，无后缀共享件属于每卷）；排班↔能力源头闸 `check-console-schedules.mjs`（SOP §F.1） |
| 25 | **排班↔能力闸只有一个方向**：`check-console-schedules` 只查「排班引用的管线存在」，**不查「管线必须有排班」** ⇒ W1/W2/W3 六条新管线只进 `pipelines/` 没进 `schedules/`，卷里**永不自动采集**，闸照样绿（#630）。活着的 9 条排班全是指标项目之前配的 | 源头闸要**双向**（① 引用完整性 + ② 期望采集集完整性）；豁免须**显式列名带理由**，不许用前缀猜 |
| 26 | **分页扇出的静默截断**：D17 库存快照 9 页×100 = 900 行上限、**无哨兵** ⇒ 实测单日 4,192 行，**静默丢 78%**，构件金额系统性偏低且无任何告警（#632）。且 `page_size` 有**服务端上限**：**200 可用 / 300 起静默返回空集**（`{"code":0,"result":[]}`，不报错） | 容量哨兵页是**必需**不是可选（阈值 = (页数−1)×页容量，案例 3 同源）；调大 `page_size` 前**先实测服务端上限**（超限静默空集，validate/run 都报 ok） |
| 27 | **窗口语义不能照信首次探针**：D17 契约写「T-1 有数据 / T 空集 / 不可回溯，错过即丢」，实测恰好**相反**（T-1 未发布 / T-2 及更早全可得 / 历史深可回溯）——发布滞后 16~40h（#632）。首探针的两种结果可能被记反 | 窗口语义用**两个相邻 bizday 交叉验证**，别用单点；「不可回溯/错过即丢」这类**驱动设计**的论断必须实测坐实才写进契约 |
| 28 | **staging 路径模板手写双斜杠**：三个 W3 model 的 `read_parquet` 路径写成 `prefix//*/bizday=`（多一个 `/`），**本地全绿**、**真机物化才炸**（`No files found that match ...//*/bizday=**`）——因为本地门禁只校「契约 expr ↔ 管线投影」，**不校 model SQL 的路径模板**（#634） | 路径模板与 `sources.yml` 的 `access_path` **同源**；了解本地门禁的覆盖边界（model SQL 路径是盲区）——新源首次物化是真机验收的必需一步 |
| 29 | **新管线的「登记面」漏配 = 静默空转**（两处实证，#630/#637）：① 只进 `pipelines/` 不进 `schedules/` ⇒ 卷里**永不自动采集**（源头闸原只查单方向）；② 进了管线但**没重建 catalog** ⇒ run record **整条不带 `assets`** ⇒ freshness 锚**静默失效**（写 `owners` 锚也匹配不到；「恒 unknown = 规则没挂」）；③ 下游侧 `wire-warehouse` 判据只查零售构件 ⇒ 新构件物化断链无人知 | §1.3 阶段 E「**新管线三个登记面必须同步**」（排班种子 / 重建 catalog / 跑一次起算）；锚须**湖侧+下游侧成对配**、容差按窗口语义**分档**（T-2 快照类比日更件宽一天）；**未验点当场验证**：glob `*` 能匹配含 `${...}` 占位符的资产 id |
| 30 | **照抄骨架必逐项核对**（#641 真机迭代两例）：① \`w0\`（whoami）**漏 \`data.schema\`** ⇒ 空结果 Binder 报错「no schema is declared to type an empty result」（D17 的 w0 有占位 \`[{\"name\":\"x\",\"type\":\"string\"}]\`）；② 断言 \`error()\` 编在 \`batch_id\` 的 CASE 里 ⇒ 被 \`gen-data-projection\` 用契约 expr **覆盖掉**（生成器只重写「SELECT…顶层 FROM」列区）⇒ 正解是移到 \`FROM\` **之后**的 \`WHERE\`（保留区） | 照抄同族管线模板后**逐节点核对**（尤其 \`schema\` 申报）；**断言语义不能编在契约列里**——契约 expr 归生成器管，断言放 FROM 之后；\`gen-data-projection --check\` 是「生成物没被手改」的闸，手改列区必红 |
| 31 | **新列「落湖成功 ≠ 列有意义」**（#665/#669）：transfer_in 补采 `lot_number`，先漏采（同单同商品多批号行失去区分键，唯一键 FAIL 3）⇒ 补列；**再补错别名**（契约 expr 写 `o.lot_number` 订单级，而 items 展开列须 `json_extract_string(u.d, '$.lot_number')`）⇒ 回填 701 行落湖**成功**但**新列全 NULL**——两侧只验行数都会放过；**闭环实证（2026-10-15 排班首跑）**：v2 主管线排班准点 ok、10-13 窗 675 行写读对平、`lot_number` 非空 100%（3120），同夜 materialize 全量 183 全绿（#679）——修复在产线站住 | 契约 expr 的**别名必须照抄同族源形态**（D16 items 展开用 `u.d`，不是订单级 `o.`）；**新列验收必看非空率**，不只行数；**回填变体是独立文件**，生成器只管契约主生产者 ⇒ 改契约后要手工同步变体 |
| 32 | **新 console 的 workspace 引导三坑**（#729 forms console，2026-10-17）：① **`.duckle/keys/secret.key` 缺失 ⇒ sink 对正确凭据仍报 `NoSuchBucket`**——该 key 是连接解密的配对密钥，console **首启时 connections/ 为空则不生成**，事后补文件不会自动补 key（bisect 实证：整包拷 `.duckle/` 即愈，其余要素全同）；② **`snk.minio` 漏 `connectionRef`** ⇒ 凭据/端点不生效，同报 NoSuchBucket（与 ① 症状相同，先查谁）；③ 排班/告警文件进仓会牵动 **tz 期望表 + spec 转换表 + alerts 判据 B** 三处联动，漏一处 CI 红 | 建 forms 专属 console（ADR-0014 新域）时：**首启前** connections/ 必须在位；起动后跑一次最小探针（pureSql→sink 1 行）验写湖；`secret.key` 缺失的判据 = 「凭据/网络/env 全同却只有本容器写不进」；bisect 手法 = 同镜像一次性容器分别挂两个卷跑同一探针文件 |
| 33 | **静态门店清单漏新店 17 天静默漏采**（#793，用户对数才发现）：3120 的 env `BRANCH_NUMS`=269 手抄，凭据可见 271；缺的 271 是真店（09-30 建店、type 也是 `SYSTEM`）⇒ 自 09-30 起每天没进湖，守卫全绿。whoami **每轮都在跑**（v0→g2），但 g3 断言只单向查「配置⊆可见」查完即弃；驱动 foreach 的 w0 仍写死 env 清单——真相每轮在手就是没接上 | 采集清单一律 **run 内现算**（whoami 可见 − 显式 `BRANCH_EXCLUDE`，#801 落地），静态清单退役为**对账底账**（gd 节点双向 diff → `config_drift` 告警，不阻断）；豁免必须显式清单（`type=SYSTEM` 里有真店，**不能按 type 自动豁免**）；现算清单为空 ⇒ 判红（foreach 零 item = 静默空转）。同型审计：其余 19 个 `BRANCH_NUMS` 消费方**全是断言侧**、无采集驱动残留（#802） |
| 34 | **「凭据失效」误报 = 把连接文件的密文当明文试**（#729 M1.4 收尾，2026-10-17）：`connections/*.json` 的密钥字段是**密文**（须配对本 workspace 的 `.duckle/keys/secret.key` 才解密），把它逐字喂给裸 `duckdb` 的 `SET s3_access_key_id=…` 探针 ⇒ 400/403，据此误判「3120 的 zos 凭据被拒、**需换发**」。**实为测试法无效**：3120 console 排班当日 18:35 CST 仍在跑、`freshness.json` 里 `minio://…/dim_branch/…/snapshot=${date+8h}`（当日）恒 `fresh`、pg_duckdb 独立读回 `snapshot=2026-10-17` 在位 ⇒ 凭据**一直有效**。同批另一条无效探针：容器里 boto3 已随重建消失（`ModuleNotFoundError`）——**探针工具本身也得先验在不在** | 连接凭据**只能经引擎消费**（`connectionRef` / duckle 解密）；**裸 duckdb 拿密文当明文 = 恒失败**，其结果**不可作凭据判据**。判「凭据是否有效」看**消费侧事实**三件套：console 排班实跑成功 + freshness 里 `minio://` 资产 `fresh` + 独立通道（pg_duckdb）读到当期分区；**下结论前先自问「我的探针走的是凭据的真消费路径吗」** |

| 35 | **新鲜度锚指向 foreach 子管线写的对象 ⇒ 声明了却「压根不出现」**（#891，2026-10-18 两账套实测）：口径对账的两条锚（`recon-*.csv` 与湖 `recon_preagg` 的 glob）指的是**子管线**的产物，而**子管线不产运行记录** ⇒ 引擎的资产集（①run 记录里 `direction=write` 的资产 ∪ ②pattern 里不含 `*` 的规则）**两头不占** ⇒ `freshness.json` 里既不是 `Unknown` 也不是 `Stale`，是**不存在**。三个登记面前提**全满足**（owners seed ✓ / catalog 重建且晚于 owners ✓ / 排班 run 均 ok ✓）仍不生效——**不是漏步骤，是锚挂错了对象**。修法：父管线补**收尾汇总 sink（完全字面路径）**，并用 `ctl.anchor` 的 **trigger 边**排在 `foreach` 之后；真机验证：锚 `fresh` + 次序成立（3120 两块 CSV `:55.220`/`:59.248` → 汇总 `:59.921`） | 锚必须指向**「有运行记录的管线」自己写**的资产（**字面路径**走 ②，或确认它进了某条 run 的 `write` 资产）；**别指向只有子管线会写的东西**。自查手法是 **`grep` `freshness.json` 里那个资产 id**——「不出现」≠「还没跑到」：`Unknown` 至少提示「规则没挂」，**不出现连提示都没有**。另：`ctl.anchor` + trigger 边是让「收尾汇总」具备「**全部块成功才有它**」这个语义的手段（§1.1.7 L1 形态的「汇总 + 末尾判红」） |
### 1.7 逐源决策登记区

> 每接一个源加一行（阶段 B 的产物）。**例外须写明命中了哪一条 + 证据**（§1.1.1）。

| 源 / 表 | 通道 | 例外证据 | 落点前缀 | 分区键 | 节奏 | 调度归口 | 验收结论 |
|---|---|---|---|---|---|---|---|
| 乐檬零售明细（3120） | duckle | — | `lemeng/retail_order_line` | `system_book=` + `hour=` | **日批在跑** + 5min tick 已定义（**试点待投递**，Task 6 未投——别读成「现行 5min」） | **duckle console**（调度 enabled，cron 不变；openship job 已先禁、观察期 ≥3 运行日后退役——#265） | 自证 ✓ / 幂等 ✓ / 独立通道 **口径已对齐**（2026-10-05；旧数 +1.15% 系**旧口径**、已废）——⚠️ 但 **3120 侧通道被乐檬改坏（恒 `10006`），无法复验**（§1.4） / 跨系统 待回填。**2026-10-17 采集清单改 whoami 现算**（可见 − `BRANCH_EXCLUDE`，静态 `BRANCH_NUMS` 退役为对账底账 + 双向漂移告警——#793；曾因静态清单漏新店 271 号店 17 天，见 §1.6 案例 33） |
| 乐檬零售明细（64188） | duckle | — | 同上 | 同上 | 同 3120 | **未落**（调度；**数据已落盘**——见 §2） | 自证 / 幂等 同 3120 / 独立通道 **✓ 逐分归零**（2026-10-05 真机 5 天 × 63 店；执行面 `scripts/lemeng/recon-preagg.sh`） / 跨系统 待回填。2026-10-17 同改 whoami 现算（exclude=`[]`，行为不变——#793）。2026-10-17 净额口径改冲退货（#813）：对账锚**新增**净额锚 `sale_money − return_money`（**销售侧锚保留**），退货侧另有逐店缺口（#814，过渡容差 NET_ABS_TOL=200 带到期）；**退货行同套赠品判别式（绝对值形态，#908/#917）** |
| **乐檬口径对账源侧快照**（**派生资产，非源**：`itemsales` 报表逐店返回值；平台侧在 dbt 构件、比较在 dbt；消费面 spec §12.4 缺口①） | duckle | — | `lemeng/recon_source` | `system_book=` + `bizday=` + **`chunk=`** | 日更（T-3 线；**两账套都排班**：64188 `30 0` / 3120 `40 0` CST，2026-10-19 订正） | **duckle console**：父 `lemeng.recon.preagg`（`pday` 切块 → `pfe` foreach）→ 子 `lemeng.recon.preagg.item` | **未验收（B 段登记，2026-10-18）**——计划 `docs/superpowers/plans/2026-10-18-recon-preagg-lake-sink.md`。**分解（第三版）**：① 湖只放**源侧逐店值**（加 `chunk=` 分区解决端点单次 ≤100 家硬限——父管线原先把全部门店拼一个数组，64188/3120 都 >100 ⇒ 必 `10001`）；**2026-10-19 订正（#920）**：平台侧与比较**都不在管线里**——平台侧读 dbt 构件 `fct_retail_sale`，比较在 dbt `recon_fact`/`recon_break`（不变量 architecture §4.1 B11）；② **台账归 dbt**：`recon_run`（`status` 四态 `ok/within_tol/over_tol/**not_evaluated**` + `break_count`/`max_break`/容差）+ `recon_break`（超容差行 + 原因/到期/认领）——派生分析不进采集；③ **原因与到期在 seed**（`recon_tolerances.csv`，与 `x08_thresholds` 同形；`NET_ABS_TOL=200` 现为**具名 reason code** `late_return_restatement`，过期自动转红）；④ **健康判据 = `break_count`/`max_break` 趋势**，不是 `sum(diff)≈0`（正负可抵消）。⚠️ 本资产**不含 completeness 对账**（那是 `diagnose.sh recon`，另一个控制）。⚠️ 父管线 `_note` 的「3120 恒 10006 所以不排班」已被 2026-10-18 实测推翻 **2026-10-18 追加（PR #895）**：观测面修复——原两条锚指向**子管线**写的对象 ⇒ **不进资产集**（§1.6 案例 35）；改为父管线**收尾汇总**（字面路径）+ `ctl.anchor` 的 trigger 边。两账套真机验证：`freshness.json` 该资产 **fresh**、run 记录里 `direction=write`、次序实测成立（汇总写在最后一块之后）。**排班首跑验收仍待**（下一夜 00:30 / 00:40 CST）。 |
| 乐檬门店维 / 商品维（双账套） | duckle | — | `lemeng/dim_branch`、`lemeng/dim_item` | `system_book=` + `snapshot=` | 日更（全量快照） | **duckle console** ×2（UTC `0 2 * * *` / `0 11 * * *`） | 首次真跑销账（**拒写湖**路径已验证；门店维见 `deploy/duckle/README.md` §9，商品维 2026-09-26 两账套 cron 真跑）——**不是「四层全过」** |
| 乐檬价格批 / 门店商品应用价（双账套，#499/#481） | duckle | **首载走一次性脚本（H 例外）**：引擎 src.rest 响应体上限（into_string 编译期默认 **12.3MB 过 / 32.9MB 炸、不可配**）使单店即越限 ⇒ 管线无法承载 2 年窗全量；首载 = 探针测量产物直写湖（`scripts/lemeng/backfill-item-price-once.py`，已留档），日常增量走管线 | `lemeng/item_price` | `system_book=` + `bizday=`（**R1 增量模型**：行 = 价格变更事件，`last_edit_time` = 事件时间；staging 取每 key 最新物化现价） | 日更（请求侧增量水位 `incrementalField=last_edit_time`；响应 KB 级/天） | **duckle console** ×2（UTC `15 11 * * *`，与 dim.item 错峰） | 首载 ✓（64188 = 204,474 / 3120 = 734,682，写读对平）/ 日常增量首跑 ✓（**双账套均 ok**——3120 PAT 2026-10-08 晚已换发恢复，见 #499/#511）/ 幂等 ✓（同 key 覆盖写两次实证）/ 独立通道 ✓（发布表 vs 网关定点逐分平：蒙自01×22441 = 9.96/996）/ spec_rate 换算方向 ✓ 真机样本实证（礼盒 ÷3 公斤价、份装 ÷2 盒价；「鲜切」类 unit 同 rate=2 的 ~20 行语义留业务确认）/ 跨系统 待回填 |
| 乐檬批发销售单（3120 单账套，#499/R3） | duckle | — | `lemeng/wholesale_out` | `system_book=` + `bizday=`（行=批发单商品行，`order_detail_price`=基本单位批发价——**按单结算，≠档案批发价**） | 日更（窗口=昨日制单日；`date_type=制单时间`——⚠️ 2026-10-08 组合反转实测订正（#513）：短词「制单/审核」被**静默忽略**返回全史，正确值恰是文档描述的「制单时间」；变更过滤参数后必须实证日期形状） | **duckle console**（UTC `45 15 * * *`，与调出单错峰） | 首跑 ✓（222 行落湖/staging 键唯一 PASS/发布 `data.dim_wholesale_out` 218 行，仅审核单）；历史批发单未回填——**2026-10-10 裁决：待数据稳定后发起全管线补采（覆盖时间范围更广），不单点补**（届时按 §1.3 阶段 H 参数化 run 实测后沉淀；本行与 §2 对应行同步此裁决）。**2026-10-12 契约 v2**（W1）：补采单头 `wholesale_order_total_money/cost_money` 两列（客户公式 R/C wholesale 侧构件，R3 当时未采）；已存在分区须按新 schema 重采覆盖（不属历史回填批次），未完成前 staging 读全表会炸列集漂移 |
| 乐檬批发退货单（3120 单账套，W1 2026-10-12） | duckle | — | `lemeng/wholesale_return` | `system_book=` + `bizday=`（行=退货单商品行；单头 `wholesale_return_total_money/cost_money` 随行冗余——**聚合前 per_order 取 max，行级 sum 重复计**） | 日更（窗口=昨日制单日单日；`date_type=制单时间`；**区间 ≤7 天接口硬限**（2026-10-12 实测）） | **duckle console**（UTC `55 15 * * *`，批序列尾） | **A 阶段恒空集**（接口可达 code:0 但近窗/历史窗/不筛状态全空——业务或走 D02 负金额红字；管线空转合法）；明细键名未获真样本实证（契约 description 载边界）；首跑 ✓（合法空转）；**排班首触发 ✓**（2026-10-14 凌晨准点 ok，六条新管线同批验证，见 PR #631 跟帖）|
| 乐檬门店费用单（3120 单账套，W2 2026-10-13） | duckle | — | `lemeng/branch_expense` | `system_book=` + `bizday=`（行=费用单；归属店=branch_num，operate=结算方；direction 中文名 应付/应收；due_amount 红字保留） | 日更（窗口=审核日单日，date_from/date_to 完整时分秒；ama 族 page_number/page_size） | **duckle console**（UTC `05 16 * * *`，费用序列头） | 首跑 ✓（232 行）；A 阶段真样本已锚：expense_type=产品售后补损/settlement_state=已核销；**排班首触发 ✓**（同批验证）|
| 乐檬客户费用单（3120 单账套，W2 2026-10-13） | duckle | — | `lemeng/client_expense` | `system_book=` + `bizday=`（行=客户费用单；归属客户=client_fid 前导零字符串；other_inout_flag: false=应付/true=应收 真样本实证） | 日更（窗口=审核日单日，date_type=审核时间；whs 族 offset/limit、区间 ≤7 天硬限） | **duckle console**（UTC `15 16 * * *`，费用序列尾） | 首跑 ✓（7 行）；A 阶段真样本已锚：kind=抖音直播补贴/kind_code=043/memo=3A级大吉大梨礼盒抖音补贴；**排班首触发 ✓**（同批验证）|
| 乐檬要货单（3120，W3 2026-10-13） | duckle | — | `lemeng/request_order` | `system_book=` + `bizday=`（行=要货单 × items[] 展开；自然键含 item_num） | 日更（窗口=`${date-1d}` 单日；ama 族 page_number/page_size，9 页×100 上限） | **duckle console**（UTC `20 16 * * *`，费用序列后） | 首跑 ✓ / **独立通道 ✓**（2026-10-12：接口 88 单 × items 展开 = **342 行** = staging 342 逐行平）/ **排班首触发 ✓**（六条同批验证）/ 跨系统 待回填 |
| 乐檬调入单（3120，W3 2026-10-13；**契约 v2 #665**） | duckle | — | `lemeng/transfer_in` | `system_book=` + `bizday=`（行=调入单 × items[] 展开；**自然键含 lot_number**——同单同商品可多批次） | 日更（窗口=`${date-1d}` 单日；ama 族 page_number/page_size，9 页×100 上限）**+ 回填变体**（`${BIZDAY}` 声明参数，#667） | **duckle console**（UTC `25 16 * * *`） | 首跑 ✓ / 独立通道 ✓（701=701 逐行平）/ 排班首触发 ✓ / **契约 v2**：首版漏采 `lot_number`（同单同商品多批号行失去区分键，唯一键 FAIL 3 ⇒ #665/#669 两轮修：补列 + expr 别名 `u.d`）+ 回填变体重采 10-12（701 行、批号非空 100%）；materialize **PASS=178/ERROR=0** |
| 乐檬库存快照（3120，W3 2026-10-13 / #632 订正） | duckle | — | `lemeng/inventory_snapshot` | `system_book=` + `bizday=`（行=账套×bizday×仓库×商品） | 日更 ×5（14/16/18/20/22 CST，**窗口=`${date-1d}` 单日——查最新**；2026-10-20 #931 订正：原先固定 `-2d` 是为躲「T-1 常未发布」，但那把源慢变成了我们的固定延时；现改为**空集时打具名状态 `SOURCE_NOT_PUBLISHED`、日内 5 轮重试**，桥只在 22 点后仍空才推群；**page_size 上限 200**，300 起静默返回空集；数据页 30×200=6,000/日容量 + 哨兵页 p31） | **duckle console**（UTC `35 16 * * *`，费用序列后） | 首跑 ✓ **4,208 行落湖**（旧 9 页×100 静默截断 78%——#632 修复）/ **独立通道 ✓**（10-11：接口翻页 4,208 = staging 4,208 逐行平）/ **空集哨兵 ✓**（T-1 空集大声红、拒写湖）/ **容量哨兵 ✓**（p31 has-rows 硬失败）/ **排班首触发 ✓**（同批验证）；跨系统 待回填 |
| 乐檬采购分析（3120，W3 余项 2026-10-13 / #641） | duckle | — | `lemeng/item_purchase` | `system_book=` + `bizday=`（行=账套×bizday×供应商×商品；**响应无 branch/audit_date 列**） | 日更（窗口=`${date-1d}` 单日；**≤31 天硬限**；**无翻页**——单次全量但响应带 `total_count`） | **duckle console**（UTC `40 16 * * *`，费用序列后） | 首跑 ✓ **59 行落湖** / **独立通道 ✓**（10-12：rows 59=59、amount 155413.10=155413.10 逐分平）/ **截断守卫 ✓**（`len(rows)!=total_count` 即 error，编在 shape 的 WHERE——勿放 gate 叶子，见案例 #9）；⚠️ **branch_nums=[99] 固定**（门店配送制不采购，采购全在管理中心）；跨系统 待回填 |
| 乐檬经营指标校验 D10（3120，**A 阶段已探·暂不接**） | duckle | — | —（不落湖） | `date_type` 仅 `year`/`quarter`/`month`（**小写**）；`date` 须 `yyyy-MM-dd`；`metrics` 仅 `sale_money`（**小写**） | — | — | **暂不接**（2026-10-13 裁决）：`month` 实测恒空集（4 日期×2 门店全 0）；`year` 仅 **1 行/年**（`target_value`/`actual_value`/`actual_rate` 对照值）⇒ 对照价值极低；spec 明写它「只作对照注、**不决定波次**」且**无指标依赖**。若客户要系统目标对照再按此形状接（形态同 D11，年频）。详见 spec 附录 |
| 乐檬批发客户档案（3120，#516 段①） | duckle | **固定窗例外（不用标准翻页形态，2026-10-10）**：GET 裸码路径是零参数路由（openapi paths 无 parameters；`limit=3/200/1000` 恒返 707、`offset/page/pageSize/rows/start/keyword` 全无效），POST 三形态全断（文档前缀→`PAT接口路由未配置`/裸码→method not supported/MCP 代理→AGI HTTP 500）⇒ 无翻页可配。窗口跟随活档案（最晚建档 09-23、最晚编辑 10-09 均在窗内，非静态切片），已知 41 个 WO 客户 41/41 在窗内；落窗外风险由发布侧未映射大声红兜底（探针报告 `.superpowers/sdd/2026-10-10-500-lemeng-client/probe-report.md`） | `lemeng/client` | `system_book=` + `snapshot=` | 日更（全量快照，单页固定窗；UTC `55 15 * * *`，wholesale 后 / 03:27 dbt 前） | **duckle console** | 首跑 ✓（707 行落湖/staging 写读对平 707/已知 41 WO 客户 41/41 命中/同名抽样 5/5 命中 dim_branch；行数带守卫 <500 die 在位）；跨系统 待回填 |
| 乐檬调拨 / 批发 / 退货 / 要货（5 源） | duckle | — | `lemeng/transfer_out` 等 | `system_book=` + `bizday=` | 日更（见各源行） | **duckle console** | **已落**（W1/W3 分批：D01/D02 R2/R3 先行、D03 W1、D15/D16 W3；见上各源行） |
| 抖音 `sku_daily` | 未定 | — | `douyin/sku_daily` | 月（**键名未定**） | 未定 | 未落 | **已退役（2026-10-22 用户裁决：抖音采集整体下线；本源未接入即废弃）** |
| 抖音接收器（`dy-upload`） | **E1**（长驻接收，**未销账**） | 长驻接收器曾以 `bare` runtime 跑 `/opt/douyin-life/capture/dy_receiver_run.py`（openship project `dy-upload`，机 f225d818）；**2026-10-22 随抖音采集整体下线**：监控面已清（OO 5 条抖音规则删除 + 该机 6 条抖音 cron 已注释，备份 `/root/crontab.bak.douyin-retire-20261022`）；**服务本体（`dy-upload` / `huopan-reports` 两个 openship project）待停**，湖上历史数据不删 | — | — | 已停 | — | 退役登记：监控执法走 data-monitor；残留 Novu 侧 mytech tenant 收件人问题另案 |
| 表单提交（forms，**platform-core 自身域**，#729 M1.4） | duckle | — | `forms/submission` | `bizday=` + `batch_id=`（**org 不在路径里**——由 `subject_org()` 注入，契约 description 记了这处对 ADR 的显式偏离；`batch_id` 即批次目录、防 append 实为覆写；行 = 提交 × 表单定义） | 日批（CST `20 0 * * *`；L0 直连默认形态） | **duckle console（forms 专属，**mytech 数据机** 18082，`openship-platform-core-data-forms-console`，2026-10-18 起运行）**：ADR-0014「一账套一 console」⇒ 不与 3120/64188 混装（调度条目带不了自己的 env，混装会静默采错源） | 自证 ✓（qa.contract）/ 幂等 ✓（批次目录）/ 独立通道 ✓（pg_duckdb 直读 1 行 5 列逐字段对）/ 跨系统 ✓（staging 1 行；#799 复 enable 后 materialize 内 `stg_forms_submission` PASS）/ **主验收 ✓ 新表单零改动自动可见**（form-m14-accept 全链路）；新鲜度锚 fresh（owners.forms.json）。✅ **已知偏差已闭合（2026-10-18）**：原 staging 的 org 被物化 job 盖成 **`shanhaiyiguo-org`**（forms console 当时落在山海数据面）。按 2026-10-17 裁决**已回迁**到 mytech 数据面（`proj_SU8cmQ8OLVfM971X` / server `23a1091e`）⇒ 现 **`org = mytech`**，落湖/物化/水位三处实测见 §5。**L1 指标的封锁随回迁解除**（回迁前那条禁令成立，现在不成立）——但 forms 目前**仍未声明任何 L1 指标**（M1.4 范围不含） |

> ⚠️ **上表的「验收结论」列**才是这个登记区的价值所在：**空着 = 没验过**，别用「跑起来了」当验收。
>
> 📌 **2026-10-06 订正**：本区两行曾**未跟随** §1.4 / §2 的订正而与之矛盾——3120 行的独立通道仍写
> `✗ 未归零（+1.15%）`（那数是**旧口径**跑的）、64188 行的验收结论仍为空。已按 §1.4（口径对齐，3120 通道不可用）
> 与 §2（双账套已落盘）对齐。⚠️ **本区是台账，会滞后**——**与 §1.4/§2 冲突时以它们为准**（它们带日期与出处）。

---

## 2 本项目的数据源清单

> 每接一个源加一行。**状态**只有三种：摸清源 / 已落盘 / 已进语义。

| 域 | 表 / 前缀 | 主体维度 | 状态 | 备注 |
|---|---|---|---|---|
| 乐檬 | `lemeng/retail_order_line/<主体>/<日>/<时>/all.parquet` | 账套（3120 熊喵 / 64188 品品甜） | **已落盘**（**双账套**——2026-09-28 订正：64188 已落；物化侧 64188 有 09-25～09-27 三天的 `fct_retail_sale` 行） | 新湖口径见 §1.7；旧前缀 `lemeng/retail_detail/…`：**所在桶已核实 = `lemeng-datasource`**（**不是**租户桶 `shanhai-data` —— 2026-09-26 在租户桶里逐对象 / 前缀都 404 是**对的**，旧文「所在桶待核实」到此销账），且**至今仍在被写**（2026-10-06 实测：生产方 `data-analysis`，跑在 `data.shanhaiyiguo.com`，每 **5 min** 一轮，**不在 openship 管辖内**，本仓与 openship 都停不掉它）⇒ **§1.3 阶段 I 的第 ③ 项（观察期）不满足 ⇒ 前缀不能下线**。本仓侧已于 2026-10-06 完成**仓内退役**（读它的 staging / `sources.yml` 声明 / `dbt_project.yml` 两个 var / 投递 lock 条目全删），见 §1.3 阶段 I 的订正块。**别默认它在租户桶里找。** 2026-10-17 起采集清单=每 run whoami 现算（可见 − `BRANCH_EXCLUDE`），静态 `BRANCH_NUMS` 退役为对账底账（#793）。 |
| 乐檬 | `lemeng/dim_branch`、`lemeng/dim_item`（`system_book=` + `snapshot=`） | 同上 | **已落盘**（双账套） | 全量快照日更；行粒度键含 `snapshot`（§1.1.2） |
| 乐檬 | `lemeng/item_price`（`system_book=` + `bizday=`） | 账套 × 门店 × 商品（#499 价格批） | **已落盘**（双账套；64188 日常增量在跑，3120 待 PAT 恢复——见 #499） | R1 增量模型：行 = 变更事件；发布面 `data.dim_item_price`（#500 工单侧消费）；探针报告 `.superpowers/sdd/2026-10-08-481-lemeng-price-batch/probe-report.md` |
| 乐檬 | `lemeng/wholesale_out`（`system_book=` + `bizday=`） | 账套 × 批发单 × 商品行（#499/R3；**v2 2026-10-12** 补采单头 total/cost 两列） | **已落盘**（3120；64188 不在范围） | 行=批发单商品行；`order_detail_price`=基本单位批发价（按单结算，≠档案批发价）；发布 `data.dim_wholesale_out`（client_fid=批发客户键）；历史未回填——**2026-10-10 裁决：待数据稳定后随全管线补采统一覆盖**（§1.7 同行）；v2 两列的已存在分区重采随 W1 验收做 |
| 乐檬 | `lemeng/wholesale_return`（`system_book=` + `bizday=`） | 账套 × 退货单 × 商品行（W1 2026-10-12） | **已落盘**（管线/契约/staging 就绪；**A 阶段恒空集**——首跑随 W1 验收） | 单头两列随行冗余（per_order 取 max）；明细键名未获真样本实证（契约 description）；与 D02 负金额红字**不得重复扣**（fct/audit 守卫） |
| 乐檬 | `lemeng/branch_expense` / `lemeng/client_expense`（`system_book=` + `bizday=`） | 账套 × 费用单（W2 2026-10-13） | **已落盘**（管线/契约/staging 就绪；首跑随 W2 验收） | 归属：店=branch_num / 客户=client_fid（operate_branch_num=结算方仅落列）；direction/flag 方向语义见契约；费用率类指标为跨模型比率 → L2（消费面） |
| 乐檬 | `lemeng/request_order`（`system_book=` + `bizday=`） | 3120（要货单 × items 展开） | **已落盘**（W3 2026-10-13；首跑 + 独立通道逐行平，见 §1.7） | 行=要货单商品行（自然键含 item_num）；窗口 `${date-1d}` 单日 |
| 乐檬 | `lemeng/transfer_in`（`system_book=` + `bizday=`） | 3120（调入单 × items 展开） | **已落盘**（W3 2026-10-13；首跑 + 独立通道逐行平，见 §1.7） | 行=调入单商品行；窗口 `${date-1d}` 单日 |
| 乐檬 | `lemeng/inventory_snapshot`（`system_book=` + `bizday=`） | 3120（仓库 × 商品库存快照） | **已落盘**（W3 2026-10-13；#632 订正窗口语义） | 窗口 `${date-1d}`（2026-10-20 #931 改；源端发布滞后 16~40h ⇒ 前几轮常空，靠日内 5 轮重试补齐，历史深可回溯；空集只记录不告警）；page_size 上限 200；粒度键 (bizday, branch_num, storehouse_num, item_num) |
| 乐檬 | `lemeng/item_purchase`（`system_book=` + `bizday=`） | 3120（供应商 × 商品 summary） | **已落盘**（W3 余项 2026-10-13；首跑 + 独立通道逐分平，见 §1.7） | 采购**收货**口径（≠采购订单）；无门店维度（管理中心采购）；窗口 `${date-1d}` 单日、≤31 天硬限 |
| 乐檬 | `lemeng/client`（`system_book=` + `snapshot=`） | 账套 × 客户（#516 工单取价对照表） | **已落盘**（3120，2026-10-10 首跑） | 进销存批发客户档案（GET 零参数固定窗，例外见 §1.7）；**不是门店维**——发布侧只消费 client_fid+client_name 做对照，行不进 dim_branch（spec §5 单源分工）；探针报告 `.superpowers/sdd/2026-10-10-500-lemeng-client/probe-report.md` |
| 乐檬 | 调拨 / 批发 / 退货 / 要货 / 调入 / 库存快照 | 3120 | **已落盘**（W1/W3 分批全部落地，见上各行） | 设计源 `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md` |
| 抖音 | `douyin/sku_daily/<月>/all.parquet` | — | **已退役（2026-10-22 用户裁决：采集整体下线，未接入即废弃；湖上历史不删）** | 分区键名未定；见 `contracts/README.md` §7 |
| 平台（forms） | `forms/submission/bizday=<采集日>/batch_id=<run id>/all.parquet`（**无 `<org>` 段**） | 租户 org（一 PAT 一租户 ⇒ 一租户一管线；导出按 `identity.orgId` 隔离，PAT 跨租户被宿主拒）；⚠️ **org 不进湖**——契约 `layout.partitionBy` 只有 `["bizday","batch_id"]`，主体列由 `subject_org()` 注入（部署常量） | **已落盘**（2026-10-17：forms 专属 console 上线、排班/锚/告警齐，**主验收「新表单零改动自动可见」通过**——见 §5）；✅ **2026-10-18 已回迁 mytech 数据面**（console 18082 + `mytech-dbt-materialize` 日频 `27 3 * * *`；`org = mytech` 实测见 §5 末行） | 设计源 ADR-0005 §13.1（人审）+ `docs/superpowers/plans/2026-10-16-forms-out-lake-m1.4.md`；三个实施面选择已人确认（#729 评论 2026-10-16）：**水位=`id`(bigserial) / 日批 / 前缀如上**；分页 = id 键集游标；staging 已复 enable（#799，湖首文件已落）。📌 **2026-10-17 订正**：本行原写 `forms/submission/<org>/<bizday>/_batch=<ts>/all.parquet`——**两处错**（多一个 `<org>` 段、分区键写成 `_batch`），与已落盘契约不符（契约列名 pattern 不许前导下划线，故 `_batch` 落地为 `batch_id`） |

> 「`_ops`」不是本仓目录约定（实测订正见 duckle/README.md §5）——桶内路径猜想，别再照抄。
>
> ⚠️ **数据集根部的 `_SCHEMA/v<N>.parquet` 是 schema 版本标记**（约定产物，非数据）——朴素 glob
> 统计会把它计入文件数、且它的路径不带 `system_book=` 分区段（2026-10-10 审计实测，差点误报孤儿
> 文件）。扫湖统计一律按分区段过滤或剔除 `_SCHEMA/`。

---

| 乐檬 | `lemeng/recon_source`（`system_book=` + `bizday=` + **`chunk=`**） | 账套 × 对账业务日 × 块 × 门店（**派生资产，非源**：`itemsales` 报表逐店返回值；**平台侧读 dbt 构件、比较归 dbt**，#920） | **已落盘**（双账套，10-01～10-15 各 15 天；3120 每天 2 块 147–149 行 / 64188 1 块 65–74 行） | T-3 线日更（64188 `30 0` / 3120 `40 0` CST）；父 `lemeng.recon.preagg` → 子 `lemeng.recon.preagg.item`；**判定归 dbt** `recon_run`/`recon_break`；新鲜度锚 = 父管线收尾汇总 CSV（§1.6 案例 35）；回填变体带 `${BIZDAY}`（#888） |
## 3 落地位置

| 东西 | 在哪 |
|---|---|
| duckle 管线 | `duckle/common/<源>.<表>.json`（客户级覆盖 `duckle/customers/`）；约定见 `duckle/README.md` §2 |
| duckle console 定义 | `deploy/duckle/console/{pipelines,schedules}/`（seed 进各账套 workspace 卷） |
| dbt 项目 | `dbt/`（按域分目录；staging / marts / semantics / tests） |
| 语义声明 | `dbt/semantics/l1_metrics.yml`（L1 唯一事实源）+ `dbt/models/<域>/marts/schema.yml` |
| 采集契约（落盘 schema 声明的**意图源**） | `contracts/<域>/<源>.<表>.json`（机器面在管线：`node.data.schema` + `qa.contract` + `drift`） |
| 数据面编排 | `deploy/data-compose.yml`（部署单元 B；全仓只两份 compose，B7 守） |
| **物化调度** | **openship job**（归口）：`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `27 3 * * *`（2026-10-06 由 `20 3` 错峰，#452 E1：避开 tick `*/5` 同分钟点火），重试 2×/300s，仅 `failed` 告警）——2026-09-28 订正：**已在跑**，命令形态见 `deploy/data-plane-deploy-sop.md` §F.6 |
| **L1 语义词表物化** | **openship job** `L1 词表物化`（`custom:tuQ06mlxBe_2TlTo`，UTC `33 4 * * *`，重试 2×/300s）——2026-10-03 注册、当日首跑（原「无 job」状态已消，#297）。⚠️ 它物化的是**平台镜像里那份 `dbt/` 快照**（镜像更新前新声明进不了词表——分叉与比对机制见 **#300**）；对账 `--check` job **有意未注册**（#300 落地前近乎恒绿 = 假保险，裁决见 `dbt/README.md` §11.4 回填表）。「词表被清空 / PG 停更」由探活 job 的 ④⑤⑥⑦ 断言盯（SOP §P8b；⑥⑦ 判据见 §7 #4） |

---

## 4 已知欠账（对照硬约束的差距）

> 按**硬约束**逐条对账。本表的 **C1 / C2 / C3** 是公司标准（`team-harness`，**尚未合入**）§2 的编号——本正典对这几条的表述见 §1.1.2（落盘即定型 / 字段集稳定 / 身份列）。**这些是「已落盘但不符合约束」的存量**，重构时一并改。⚠️ 本表的欠账描述的是**旧前缀** `lemeng/retail_detail/…` 的存量；新湖口径见 §1.7。⚠️ 该前缀**所在桶已核实 = `lemeng-datasource`**（不在租户桶——见 §2 的注）；且**它仍在被写**（每 5 min，§2 同注）⇒ **别按本表去租户桶里翻旧数据**。⚠️ **本仓读它的模型已于 2026-10-06 仓内退役**（§1.3 阶段 I 订正块）——本表欠账**仍在**（湖上数据没动），只是**仓里不再有消费它的代码**。

| 欠账 | 违反哪条硬约束 | 表现 |
|---|---|---|
| 列全是字符串（金额/时间是 `VARCHAR`） | **C1 落盘即定型** | 下游每个模型都要手写 cast |
| 账套只在路径、数据里没有 | **C3 身份跟着数据走** | union 后分不出主体 |
| 路径非 hive 分区命名（`3120/` 而非 `system_book=3120/`） | hive 分区命名（§1.1.2 落地形态） | 下游拿不到自动分区列 |
| 字段集漂移（同域不同日 46 vs 43 列） | **C2 字段集稳定** | 跨日 union 直接读不出 |
| 同一表两种日期格式（`2026-07-01 10:02:34` vs `20260707`） | **C1** | 需要逐列 `strptime` |

**⇒ 重构时按 §1.3 的生命周期 SOP 重走一遍，这些一并消掉。**

---

## 5 验收记录

> 每接完一个源，记一行：跑过哪些验收、结论、卡点（卡点进 §1.6 案例库，并登记进 §1.7）。

| 日期 | 数据源 | 验收范围 | 结论 | 卡点 → 案例号 |
|---|---|---|---|---|
| 2026-10-08 | 乐檬 item_price（价格批首载+增量，#499） | A→I 完整走（A 探针→B 契约→C/D 管线→E 调度→F 验收；H 首载例外登记） | 双账套首载 939,156 行落湖→staging→发布 `data.dim_item_price` 906,362 行；64188 日常增量首跑 ok；三墙实录见 §1.6 案例 19–21 | #1 #2 #3 #4 #5 #6（**公司标准 §6 的编号；该标准尚未合入**）——本正典的案例库见 §1.6。⚠️ **本行是史实、不改**：压测读的是 `lemeng-datasource` 桶里的**旧湖数据**（湖上仍在、仍被写）；仓内那份同名 staging 已于 **2026-10-06 退役**（§1.3 阶段 I），**与本次验收结论无关** |
| 2026-10-13 | 乐檬 W1/W2/W3 六源（D03 批发退货 / D04 门店费用 / D05 客户费用 / D15 要货 / D16 调入 / D17 库存快照） | A→I 复核补课：**E 调度补齐**（6 条排班进种子 + 源头闸补完整性方向）+ **D17 窗口/分页修复** + **三 staging 路径修复** + 四层验收 | 排班 15 条 enabled 真机生效；D17 首跑 **4,208 行**（旧 9 页×100 静默截断 78% 已修）；三源独立通道**逐行平**（要货 342/342、调入 701/701、库存 4208/4208）；空集/容量双哨兵实证；词表 **19 条 L1** 入 `data.metrics` | #630（排班缺口+闸）/#632（D17 窗口分页）/#634（staging 双斜杠）；坑见 §1.6 |
| 2026-10-13 | 乐檬 D11 采购分析（W3 余项，#641/#642/#644） | A→I 完整走（A 探针→B 契约→C/D 管线→E 调度→F 验收→G 锚） | 59 行落湖；独立通道逐分平（rows/amount）；词表 **25 条**（+采购族 6）；三登记面齐（排班/重建 catalog/重跑起算）+ 锚成对配（11 条 minio 全 fresh）；真机迭代修 w0 漏 schema | #642（w0 schema 漏申报）；坑见 §1.6 案例 #29/#30 |
| 2026-10-17 | 平台 forms 表单提交（#729 M1.4，首个**非乐檬域**：专属 console） | A→I 完整走（A 建源+探针→B 契约→C/D 管线→**E 建 forms 专属 console + 三登记面**→F 四层验收→G 锚+告警） | 主验收 ✓ **新表单零改动自动可见**：新建 form-m14-accept（全新形状）→提交→**管线零改动**采集 1 行落湖（submission_id=1，payload 整列 JSON 文本）→pg_duckdb 独立读回 5 列逐字段对→staging 1 行；新鲜度锚 fresh；失败/恢复事件实入 OO `data_alerts` | console 引导坑见 §1.6 案例 #32；**误报订正（2026-10-17 当日）**：「3120 zos.json 凭据 403、需换发」**系误报**——那是把连接文件里的**密文**当明文喂给裸 duckdb 探针的假阴性，凭据实为有效（排班在跑 / freshness 里 `minio://` 资产恒 fresh / pg_duckdb 独立读回当期分区在位），见 §1.6 案例 #34。🚨 **同日追加裁决（2026-10-17）**：本次验收的**管线**结论全部成立（本行不改），但**部署落点被推翻**——console 落在**山海**数据面 ⇒ staging 主体列 `org` 被物化 job 盖成 `shanhaiyiguo-org`（`org` 是行级授权主体列 ⇒ 一旦声明 L1 指标即**可见性反转**）。裁决：**回迁 forms 到 mytech 数据面**；牵扯面（mytech 数据面**从未启用** + 共享 dbt 树**缺域隔离**）与步骤见计划稿 `docs/superpowers/plans/2026-10-16-forms-out-lake-m1.4.md` §裁决 |
| 2026-10-17 | 乐檬 retail 明细族（#793 门店清单改 whoami 现算，PR #801→v0.146.1） | 治本 PR 合并部署 + 3120 漏店 271 回填（09-30→10-16）+ Phase 3 双账套真机验收 | 回填 **ALL_DAYS_DONE**（09-30/10-01 源侧零单核过，无需补）；仓库 `staging.fct_retail_sale`（pg_duckdb 容器）逐日含 271 共 **16 天**（10-02→10-17，10-17 当日累计；10-16 = 2,825.70，与报案 sale_money 面缺口逐分闭合）；recon 对平 10-13 +0.00 / 10-14 +0.01 **PREAGG_OK**；物化 **PASS=246**；Phase 3：3120 tick ok + OO `retail_day` config_drift **rows=0**（现算 270==底账 270）；64188 首两轮 tick 崩于 wc2（`BRANCH_EXCLUDE` 服务行已补但容器未重建——env 是容器创建时注入，restart 不重注）→ env-only refresh 重建后 10:20 tick ok + OO config_drift rows=0（129==129）；64188 窗口数据与回填前形状一致（无 271，65-74 店/日） | #802（同型审计，A/B 待裁；+gv2 闸在消费节点 wc2 之后的次序缺陷——缺键先炸 wc2，fail-closed 语义不变但报错形状差）；坑见 §1.6 案例 33 |
| 2026-10-18 | 乐檬零售净销售额口径改冲退货（#813，PR #834 → v0.153.1） | 补缺陷（客户裁1 原文的净额 L 本含「销售−退货」，实现只落了换货折半）+ 端到端验收 | 构件拆 `sale_amount`/`return_amount`/`net_amount` 三列，新增 `lemeng:retail:sales` 保留旧数；五条 dbt 测试全绿（net_sales/sales/order_count 三条 audit + grain + sale_amount 非负）；**64188/10-16 净额 220,217.50**、**3120/10-16 323,430.10**——与业务「直接查」逐分吻合；两账套 × 5 天脚本对账：销售侧逐日 **0.00**，净额侧差额恰为已登记缺口（−5.00 / −123.06 / −19.80），**无 `branch_missing`**、无超容差；管线侧 `pfe`（foreach）跑通：73 店两侧非空、合计 −123.06、判定通过；词表 **41 条**含 `retail:sales`；#835 dbt 按域重构 + 域裁剪（job env `DATA_PLANE_DOMAINS=lemeng,forms`）下重跑仍 **PASS=281 / ERROR=0**、两账套数值不变 | 退货侧逐店缺口 **#814**（`NET_ABS_TOL=200` 的到期条件，治本后归 0）；脚本↔管线同源无防漂移门禁 **#831**；口径与证据见 spec `2026-10-17-retail-net-sales-return-offset-design.md` |
| 2026-10-18 | 平台 forms **回迁 mytech 数据面**（#729 裁决执行；连带 #861 / #863） | R3 数据面启用 → R5 console 落地 → R4 物化 job 上线 → R6 验收 | **R3**：检出换版；Gate-B 接线 + `search_path` 转绿（`wire-warehouse --check` ①② 由 `ENOTFOUND` → `OK`，③ 由连接错变成「表还没物化」的正确形态）；`mytech-data` 桶 + **只对该桶有权限**的子账号密钥（不用账号级钥匙）；pg_duckdb 持久 secret 建好且**跨会话可见**（探针：本桶 `region 'xinan1'` 生效、阴性对照仍 404）。**R5**：`forms-console` 4/4 服务起、workspace seed（`zos`/`forms` 两个密文连接 + 32B 工作区钥匙 + 管线/排班/告警/owners）、catalog 2 assets；首跑 `src 1 rows` → `sink Success`，落湖 **1 行 / 1 批 / bizday=2026-10-18**，列 = 契约 6 列、**无 `org`**（主体列不进湖 ✓）。**R4**：`mytech-dbt-materialize（forms 域）` 日频 `27 3 * * *` + 失败告警；首跑 `Found 1 model`（域裁剪生效）+ **PASS=17 WARN=0 ERROR=0 → MATERIALIZE_OK**。**R6 判据**：`staging.stg_forms_submission` → **`org = mytech`，1 行**；`data.load_log` 有水位行（新鲜度时钟起算）。⚠️ 山海侧 forms 残留（console + staging 表）**暂不退役**，等 mytech 侧连续两晚日跑稳定后再动，避免双写窗口 | **#861**（管线 sink 缺 `connectionRef:zos` → 新部署首跑必 `NoSuchBucket`；山海那份是手工补过的）／**#863**（`+enabled` 按 `models:` 路径配，**管不到平铺的 `dbt/tests/`** ⇒ 乐檬 singular test 在 forms 面照跑并拖红本域）／服务器层两个坑记在 WeKnora（dockerd 代理配内网不可达 + **BuildKit 不继承 dockerd 代理** ⇒ 拉基础镜像失败，构建用 `DOCKER_BUILDKIT=0`） |
| 2026-10-18 | 山海侧 forms 残留**退役**（#729 R7 收尾；**取代上一行末尾那条「暂不退役」**） | 停 console → 卷内排班 `enabled:false` → 山海 job 域列表改回 `lemeng` → 只物化 lemeng 验绿 → 删山海 staging 表 | **依据不是「等够两晚」，是更强的证据**：同一个派生选择器 + 同一份 main，**两个域在真机上都跑绿**（lemeng `PASS=285 WARN=0 ERROR=0`、forms `PASS=24`），且山海那边此前那个**冻结束**已成往事（最近一次 `PASS=285 ERROR=0`）。删表前核数：山海 `stg_forms_submission` **1 行**（`shanhaiyiguo-org`，bizday 2026-10-17）vs mytech **1 行**（`org=mytech`）—— **同一笔提交，不丢数**；且 forms 从未声明 L1 指标 ⇒ 无消费者。删后复验：`relation "staging.stg_forms_submission" does not exist`，staging 里已无 forms 表。 | **两处遗留**：① ~~forms-console 服务行仍 `enabled:true`~~ → **已改 `enabled:false`（2026-10-18 同日）**。当时以为是「MCP 工具整族缺失」，实为**注册名 ≠ 派发名且逐次抖动**：`…_byServiceId` 报 `Unknown tool`、`…_by_service_id` 也报，**只有 `…_by_serviceId`（snake 前缀 + camel 后缀）稳定命中** —— 用「多命名轮询重试」直调 MCP 端点完成了三处服务行修改（本行 `enabled=false`；mytech `duckle`/`dbt` 卷改绝对路径，`dbt` 按 SOP §C #20 不带 `:ro`），全部回读复核。留档见 openship-platform `docs/platform/openship/architecture.md` §8；② ~~湖上 `s3://shanhai-data/forms/submission/` 仍有 1 个对象未删~~ → **同日已删**：实为 **5 个**批次对象（10-17 水位未推进时反复采同一笔，各落一个批次目录）。首次 DELETE 全 403 是**签名 bug**（canonical URI 里路径的 `/` 不该编码）；改正后 **204×5**，复查 `LIST` 返回空 |

| 2026-10-18 | **recon 预聚合通道复验**（不是接新源；消费面 spec §12.4 的 A 段前置） | 只跑 A 段探针：两账套直调 `nhsoft.report.ai.itemsales.find`（2026-10-16，抽样门店），与 `staging.fct_retail_sale.net_amount` 逐店比 | **两账套都通且逐分吻合**：64188 三店 `27,777.50` vs `27,777.50`；3120 两店 `9,893.40` vs `9,893.40`；`code=0 请求成功`。**订正 §2 独立通道行的「3120 通道不可用」**（该结论今日不成立）。⚠️ 净额侧过渡容差 `NET_ABS_TOL=200` 仍在（#814 未关），抽样日差 0、容差未被用到 | 无新坑；通道细节（`LEMENG_TOKEN` 取 env 而非 connections 文件、`branch_nums` 必传且单次 ≤100 家）已并入 §2 |

---
| 2026-10-18 | 乐檬口径对账（观测面修复 + 双账套 15 天回填，#888/#891/#892） | E 调度（三登记面）+ F 验收（自证与观测面层）+ H 回填（10-01～10-15 × 两账套） | **回填**：台账 60 个 control-day `over_tol` = **0**；**观测面修复**（PR #895）：两条死锚换成父管线收尾汇总，两账套真机验 `freshness.json` **fresh** + run 记录 `direction=write` + 次序成立；日物化 `PASS=294 WARN=0 ERROR=0`。**排班首跑验收仍待**（下一夜 00:30/00:40） | #891 → §1.6 案例 35；#892（覆盖度 SLI + 源返回率闸，待做）；观测窗 #448 |

## 6 下钻清单 + 公司标准指针

> 本节只给指针，**不复制正文**。改对应东西之前，先读对应那份。

| 要改什么 | 先读 | 它讲什么 |
|---|---|---|
| 采集契约的字段与形态 | `contracts/README.md` | 契约的元 schema / 分区与文件名的 `const` / 类型枚举 / **§5「目前没人守」诚实清单** |
| 管线里的引擎能力边界 | `duckle/README.md` §1、§7 | duckle→ZOS 直写口径 / 原生可替代·半替代 / **三条坑** / 未验清单（**是 gate，不是「大概可以」**） |
| 管线的目录与命名约定 | `duckle/README.md` §2、§3 | `<源>.<表>.json` 命名 / 三件套同构 |
| duckle 镜像与入口闸 | `deploy/duckle/README.md` | 镜像 / `entrypoint.sh` 的白名单闸（**安全边界，不放宽**） |
| 调度器（console）机制 | `deploy/duckle/console/README.md` | 薄管线为什么必须长那样 / 调度器实测事实 / 失败告警怎么接 |
| 数据面部署与投递 | `deploy/data-plane-deploy-sop.md` | Phase 0–10 操作单 / 21 坑三层分类 / §E 投递程序 / §F 调度归口 |
| 组件职责边界 | `docs/architecture.md` §2.2 | 六组件分工（**数据栈职责边界的正典**） |
| 通用架构不变量 | `docs/architecture.md` §4 | 第一档（门禁固化）/ 第二档（仅文档）逐条 |
| 分层设计与硬约束论证 | `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md` | 七层分工 / 七个硬约束 / 标准路径 10 步 / 资源画像 |
| 数据栈选型定稿 | `docs/superpowers/specs/2026-09-20-data-stack-module-design.md` | duckle / pg_duckdb / dbt / Metabase 怎么定的 + 模块接入协议 |
| 乐檬采集链路（现行主线的设计源） | `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md` | 选型 / 写模型 / 调度矩阵 / 四层验收 / 回填 |
| 模块 API 契约 | `docs/module-protocol.md` | 模块 API 契约正典（改模块前必读） |

> **实测数据（资源画像等）在两份 spec 里，不在本正典里**——因为那是**本项目实测的**，不是公司规范。
> ⚠️ 上表是从原 §1「设计依据」并入的（**一条都没丢**）：并进来是因为它与下钻清单同职（都是指针表）。

**公司标准指针**：`team-harness/docs/standards/data-platform.md` —— **尚未合入**（挂起于 PR #79，
因 Actions 账单额度）。**不要把它当现行正典用**：那份 2026-09-21 稿早于乐檬 S1–S3 的全部实测
（无选型决策 / 无写模型 / 无自然键与粒度纪律 / 无末页守卫 / 无调度归口 / 无四层对账与回填纪律）。

---

## 7 待沉淀（**无案例，先标明，不编**）

| # | 待沉淀项 | 为什么留着不写 |
|---|---|---|
| 1 | **E2 浏览器自动化通道**的正式条件与验收形态 | 无案例。写出来就是编 |
| 2 | **退役流程（§1.3 阶段 I）** 的操作细节 | 仍**无已完成的退役案例**：乐檬旧湖于 2026-10-06 只做了**仓内退役（半步）**——湖上前缀**未下线**（生产方 `data-analysis` 每 5 min 仍在写它，观察期无法开始），**三步门槛一次都没走完** ⇒ 连「下前缀」的动作都还没发生过，**不能算案例**。**完整的③观察期后下前缀**仍待首次执行（见 §1.3 阶段 I 订正块与 §2 旧前缀行） |
| 3 | ~~**抖音接收器**的通道定性~~ **✅ 随源退役销账（2026-10-22 用户裁决：抖音采集整体下线）**——监控面已清（OO 5 条抖音规则删 + f225d818 机 6 条抖音 cron 注释）；服务本体（`dy-upload`/`huopan-reports` project）待停，落盘形态不再需要核实 | 退役登记见 §1.7/§2 |
| 4 | ~~「看得见下游」的探测与告警落地形态~~ **✅ 已落地（2026-10-06，销账 #297 最后一格）** | 机制 = `wire-warehouse.sh --check` 八断言：①DNS ②TCP ③真查询（Gate-B + search_path 接线）+ **④ PG 新鲜度**（fct 的 max(bizday) ≥ 上海今天−2，抓「dbt 绿但读湖读短了」）+ **⑤ 词表非空**（`data.metrics` ≥ 1 行）——挂在既有 `*/5` 探活 job 上（失败即告警）。**④⑤ 变异验证已做（2026-10-06 真机）**：容差调 −1 ⇒ ④ 红、表名指错 ⇒ ⑤ 红，对照五条全 OK。判据面出处 = 本行旧文与 #297。**⑥⑦ 增补（#476/#520，2026-10-07/09）**：⑥ 发布维表 `data.dim_item` 非空且 max(snapshot) ≥ 上海今天−3；⑦ 工单取价面 `dim_settlement_order_line` 非空且 max(order_bizday) ≥ 上海今天**−3/−2（上海 13 点前/后）**。⚠️ **⑦ 判据案例（#534，2026-10-10）**：首版固定 −2 首夜即结构性红 ~200 条企微误报——面由维表发布 job（上海 11:43）整批替换、读 L0 昨晚 23:35 采的 T-1 ⇒ **零点时面必然停在 T-3**。**通用判据：给发布面/物化面写新鲜度容差，必须 ≥「采集滞后 + 发布周期」，或按当前时刻分段取容差**；容差只看数据面拍天数 = 每晚零点红到中午发布完成（「停更」≠「断流」，先核发布节奏再定级）。**⑧ 增补（#538，2026-10-10）**：⑧ 价目发布面 `data.dim_item_price` 非空且 max(snapshot) ≥ 上海今天−3（判据见 §1.5.2 表）——价目管线 429 失败曾无任何告警，本断言补盲 |
