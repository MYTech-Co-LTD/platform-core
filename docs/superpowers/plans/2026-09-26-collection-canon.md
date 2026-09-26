# 采集正典（升级 handbook）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/data-platform-handbook.md` 从 3.2KB 的薄指针升级为本项目的**采集正典**（正典正文 + 台账合一），并补上 `AGENTS.md` 文档地图里缺失的采集路由、修掉 `docs/architecture.md` 里 duckle「不常驻」的漂移。

**Architecture:** 零新增文件。正典落在既有入口 handbook 上：新的 §1 装采集正典正文，§2/§3/§4/§5 保持节号（三处外仓内引用按节号指向它们），新增 §6 下钻清单与 §7 待沉淀。下钻的四份文档（`contracts/README.md`、`duckle/README.md`、`deploy/duckle/console/README.md`、`docs/architecture.md` §2.2）**正文一律不动**——它们是目录自述/架构节，正典只挂指针。

**Tech Stack:** 纯 Markdown + 本仓既有的 shell/grep 核验；不引入新工具、不改任何脚本。

## Global Constraints

- **设计源**：`docs/superpowers/specs/2026-09-26-collection-canon-design.md`（已获用户确认，commit `9460612`）。本计划实现它；冲突处以 spec 为准。
- **保号约束（硬）**：`docs/data-platform-handbook.md` 的 **§2 与 §4 节号与内容必须留住**。按节号引用它的站点**实测共 8 处**（2026-09-26 全仓清点；**不是「三处」**——初稿数漏了 5 处，评审抓出）：

  | 站点 | 指向 | 引用的是 |
  |---|---|---|
  | `dbt/dbt_project.yml:48` | §2 | 源清单里的旧乐檬路径 |
  | `dbt/models/common/staging/sources.yml:23` | §2 | 源清单 |
  | `contracts/README.md:58` | §4 | 欠账「路径非 hive」 |
  | `contracts/README.md:157` | §2 | 抖音现状行 |
  | `contracts/common/_schema.schema.json:49` | §4 | 路径规范正典 |
  | `contracts/common/_schema.schema.json:60` | §4 | 非 hive 欠账 |
  | `duckle/README.md:121` | §2 | `_ops` 那条记录 |
  | `.gitignore:26` | §2 | `_ops`「duckle 自己的产出」 |

  破坏了它们是**静默**的（无人会红）⇒ 任何动 §2/§4 的任务（尤其 **Task 7**）必须逐条对照上表保留内容与节号。
- **零新增文件**：不新建文档、不新建脚本、不新建目录。
- **不复制正文**：本仓规矩是「正文不复制，只给指针」（`AGENTS.md:4`、`docs/architecture.md:320`）。正典写**采集专属**内容；通用不变量指向 `docs/architecture.md` §4。
- **历史快照不改**：`docs/superpowers/specs/**` 与**本分支之外的** `docs/superpowers/plans/**` 既有文件一律不动（那是已合入的历史稿）。
  ⚠️ **例外**：本分支正在执行的计划文件 `docs/superpowers/plans/2026-09-26-collection-canon.md` **可改**——本仓纪律是「规划先行，调整先改规划」，
  中途调整的**第一步就是改规划稿**（否则实现者照旧稿做，错就固化）。改它不算违反本条。
- **不许编**：无案例支撑的一律写进 §7 待沉淀并标注，**不编**（根本法则：无案例不立标准）。
- **不可碰的受管文件**：`deploy/data-plane-manifest.txt` 覆盖的文件改了会让 `check-data-plane-lock.mjs` 红。**本计划触碰的 4 个文件（handbook / AGENTS.md / architecture.md / data-plane-deploy-sop.md）都不在清单内**，因此**无需**重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。若执行中决定改到清单内文件，必须重跑该生成器。
- **CI 对本计划的改动是「全绿」且这不构成证据**：五条守卫（`lint-architecture` / `check-compose` / `check-env-example` / `check-data-models` / `check-data-plane-lock`）**都不扫 `docs/` 与 `AGENTS.md`**。⇒ 本计划的正确性**只能**由下面的核验步骤与人工评审保证，**不要**拿「CI 绿」当完成证据。
- **提交纪律**：`docs(collection): <一句话>`；docs 类型**免 issue**；一切可见变更**走 PR**（squash）；**不要**手写 CHANGELOG。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `docs/data-platform-handbook.md` | **改写**（结构 + 正文） | 本项目采集正典正文（§1）+ 台账（§2–§5）+ 下钻清单（§6）+ 待沉淀（§7） |
| `AGENTS.md` | 改「文档地图」表，加 1 行 | 补上缺失的数据面/采集路由 |
| `docs/architecture.md` | 改 §2.2 第 2 条 + §6 文档地图 | 订正 duckle「不常驻」漂移；文档地图加一行 |
| `deploy/data-plane-deploy-sop.md` | §F 加 1 行指针 | 调度「怎么做」不在 SOP，指向正典 |

**升级后 handbook 的节次（目标态）**：

```
头部      定位改写：正典正文即在本文件
§0        本文管什么 / 不管什么（含「采集完成」判据）
§1        采集正典
  1.1     决策层：怎么选「最合适的方式」
  1.2     硬约束清单（门禁固化 / 仅文档，两档）
  1.3     生命周期 SOP（A→I，每步带验收与回退）
  1.4     四层验收
  1.5     运维与故障速查
  1.6     案例库（只增不改）
  1.7     逐源决策登记区
§2        本项目的数据源清单      ← 保号
§3        落地位置                ← 补齐 4 个 <待补>
§4        已知欠账（对照标准的差距） ← 保号
§5        验收记录
§6        下钻清单 + 公司标准指针
§7        待沉淀（无案例，先标明，不编）
```

> **对 spec §6.1 的一处补充（执行时按此处办）**：spec §6.1 的 §1 骨架原列 6 个子节（决策/SOP/验收/运维/案例/登记），**未含「硬约束清单」**。但 handbook **§4 的内容引用了「标准 §2 硬约束」**（原文第 50 行），若不把硬约束放进正典，这条引用就没有落点。故 §1 增设 **1.2 硬约束清单**，后续子节顺延一位。

---

## Task 1: handbook 结构改造（头部 + §0 + §1 骨架 + §6 下钻清单 + §7 待沉淀）

**Files:**
- Modify: `docs/data-platform-handbook.md`（全文件重排；§2–§5 内容原样保留）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `docs/data-platform-handbook.md` 的新节号体系（§0、§1.1–§1.7、§2–§7）。后续 Task 2–7 往既定节号里填正文；Task 8 依赖 §6 下钻清单已存在。

- [ ] **Step 1: 重写头部与 §0**

把文件开头（原第 1–10 行：标题 + `⚠️ 标准正文不在这里` 引用块 + `---`）整段替换为：

```markdown
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

> **为什么这条要写死**：2026-09-26 实测——零售采集每天绿、湖每天长，而 PG 里的物化**停在 09-23**
> （湖已有 **09-24 / 09-25**；`staging.stg_lemeng_retail_order_line` 19,678 行、`min=max=2026-09-23`，
> 恰等于湖 09-23 一天；37 个 job 里**没有一个在跑 dbt**——唯一含 dbt 字样的只是 prep job 里的一句 `ls -d`）
> ⇒ **湖已领先两天，而报表读到的是 09-23**，**且没有任何东西会报错**。这是「采集成功」最坏的一类假绿。
> ⚠️ 本段只写**量过的东西**：09-26 当天有没有入湖**未测**，故不写（「job 绿」不等于「数据到了」）。

---
```

- [ ] **Step 2: 插入 §1 骨架（标题 + 七个子节标题 + 各一行「待填」说明）**

紧接 §0 之后、原 §1「设计依据」之前插入：

```markdown
## 1 采集正典

> 本节是正典正文。**只写采集专属的内容**；通用架构不变量不在此复制（**例外：§1.2 重复列出了 B7/B9 两条**，理由见该节），见 `docs/architecture.md` §4。

### 1.1 决策层：怎么选「最合适的方式」

（Task 2 填）

### 1.2 硬约束清单

（Task 3 填）

### 1.3 生命周期 SOP（A→I）

（Task 4 填）

### 1.4 四层验收

（Task 5 填）

### 1.5 运维与故障速查

（Task 5 填）

### 1.6 案例库（只增不改）

（Task 6 填）

### 1.7 逐源决策登记区

（Task 6 填）

---
```

- [ ] **Step 3: 删除原 §1「设计依据」**

原 §1（`## 1 设计依据（本仓内）` 及其表格与「**实测数据**…」那段）**整节删除**——它的内容并入 Step 4 的 §6 下钻清单（它本来就是一份指针表，与下钻清单同职）。

- [ ] **Step 4: 在文件末尾追加 §6 与 §7**

在 §5 验收记录之后追加：

```markdown
---

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
| 2 | **退役流程（§1.3 阶段 I）** 的操作细节 | 无已完成的退役案例（乐檬旧湖退役**尚未执行**） |
| 3 | **抖音接收器**的通道定性 | 需先核实其实现与落盘形态 |
| 4 | **「看得见下游」的探测与告警落地形态** | 要求已定（§0 判据），机制未定 |
```

- [ ] **Step 5: 核验保号约束（step 5 是硬门禁，必须逐条跑）**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块

# ① §2 与 §4 的标题仍在，且顺序为 2 < 3 < 4 < 5
grep -n "^## " docs/data-platform-handbook.md

# ② 三处外仓内引用仍对得上（这三行必须都打印出内容）
echo "--- contracts/README.md:58 → §4"; sed -n '58p' contracts/README.md
echo "--- contracts/README.md:157 → §2"; sed -n '157p' contracts/README.md
echo "--- duckle/README.md:121 → §2"; sed -n '121p' duckle/README.md

# ③ §2/§4 的目标内容确实还在
grep -q "本项目的数据源清单" docs/data-platform-handbook.md && echo "§2 OK"
grep -q "已知欠账" docs/data-platform-handbook.md && echo "§4 OK"
```

**Expected:** ① 输出里 `## 2`、`## 3`、`## 4`、`## 5` 依次存在；② 三行都打印出含 `handbook` 与 `§2`/`§4` 的句子；③ 打印 `§2 OK` 与 `§4 OK`。

- [ ] **Step 6: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): handbook 结构改造——正典头部 + §0 判据 + §1 骨架 + §6 下钻清单 + §7 待沉淀"
```

---

## Task 2: §1.1 决策层

**Files:**
- Modify: `docs/data-platform-handbook.md`（把 `### 1.1 决策层：怎么选「最合适的方式」` 下的 `（Task 2 填）` 替换为下面的正文）

**Interfaces:**
- Consumes: Task 1 建立的 §1.1 锚点
- Produces: 「汇总决策表」（§2.6 的形态）——Task 6 的逐源决策登记按这张表的行来填

- [ ] **Step 1: 写入 §1.1 正文**

替换 `（Task 2 填）` 为：

````markdown
> **一张表定案，不靠临场判断。** 逐项取值见下表与 1.1.1–1.1.5。

| 判定项 | 取值 | 判据 |
|---|---|---|
| 通道 | duckle / E1 / E2 / E3 | §1.1.1（例外须写证据） |
| 落点前缀 | `<域>/<表>` | 契约 `layout.prefix` |
| 分区键 | `system_book=` + `hour=` / `bizday=` / `snapshot=` | §1.1.3（粒度不得细于采集间隔） |
| 写模型 | 分区单文件覆盖写 | §1.1.2 |
| 调度归口 | duckle console / openship job | §1.1.4 |
| 节奏 | cron + 窗口 | §1.1.3（由消费侧 SLA 倒推） |
| 验收 | 四层 | §1.4 |

#### 1.1.1 通道选型

**默认：duckle 管线**（含 job 层薄 wrapper）。依据见乐檬采集链路 spec §4。

**例外条件**——命中须在 §1.7 决策登记里写明**命中了哪一条 + 证据**：

| # | 例外条件 | 案例 | 状态 |
|---|---|---|---|
| **E1** | **推送式 / 需长驻接收**（源主动推给我们；duckle 是一次性 runner） | 抖音：生产上 `dy-upload` 以 `bare` runtime 跑 `/opt/douyin-life/capture/dy_receiver_run.py` | 有案例（细节见 §7 待沉淀 #3） |
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

#### 1.1.2 落地形态（**无例外**）

| 项 | 定死为 | 出处 |
|---|---|---|
| 分区命名 | **hive**（`system_book=3120/`）；非 hive 直接校验失败 | `contracts/common/_schema.schema.json` 的 `const` |
| 文件名 | **`all.parquet`**（唯一），一个叶子分区一个文件 | 同上 |
| 写模型 | **分区单文件覆盖写**：内容 = 该分区**当前完整内容**；历史修正靠重放层幂等覆盖 | 乐檬 spec §5 |
| 定型 | **落盘即定型**：金额 numeric / 时间 timestamp / 日期 date，**不落字符串** | layered spec §7 硬约束 1 |
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
| **duckle 管线** | **duckle 自带调度器**（常驻 console，`duckle-runner serve` 的 tick 循环） | ADR-0014；`deploy/data-plane-deploy-sop.md` §F |
| **非 duckle 的 runner**（dbt、自建脚本） | **openship job** | 同上（dbt 是另一个 runner，容器内没有 docker，丢不进 console） |

- 判据一句话：**能不能被 duckle console 调度？能就 console。**
- **时区一律 UTC**（容器 TZ 实测为 UTC，openship cron 同口径）；「日期类」参数必须由 wrapper
  **显式钉 `Asia/Shanghai`** 推算——否则 UTC 夜间跑会算成前一天、**写进前一天的分区且不报错**（SOP §F.3）。
- **一账套一个 console**：调度条目带不了自己的 env（实测塞 `env`/`args`/`params` 被**静默丢弃**）
  ⇒ 共用必然有账套拿到错 token，**且静默采错数据**。

#### 1.1.5 一源一路（禁双采集）

一个源**只有一条采集链路**。反模式（`docs/architecture.md` §2.3 已明列）：两个采集器各拉同一源
⇒ 两份数据必然漂移、对账永远追不上。
````


- [ ] **Step 2: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "1.1.5 一源一路" docs/data-platform-handbook.md && echo "§1.1 OK"
grep -c "（Task 2 填）" docs/data-platform-handbook.md
```

**Expected:** 打印 `§1.1 OK`；第二条输出 `0`（占位已被替换掉）。

- [ ] **Step 3: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 正典 §1.1 决策层——通道选型/落地形态/节奏/调度归口/一源一路"
```

---

## Task 3: §1.2 硬约束清单

**Files:**
- Modify: `docs/data-platform-handbook.md`（替换 `### 1.2 硬约束清单` 下的 `（Task 3 填）`）

**Interfaces:**
- Consumes: `docs/architecture.md` §4 的两档结构；`contracts/README.md` §5 的「没人守」清单
- Produces: §1.2 的清单——Task 4 的 SOP 验收步骤引用它

- [ ] **Step 1: 写入 §1.2 正文**

替换 `（Task 3 填）` 为：

```markdown
> **先看清是哪一档。** 第一档违反 = CI 红；第二档违反 = 门禁不拦，靠评审与人。
> **通用不变量不在此复制**——**例外**：与采集直接相关的 **B7（部署面）** 与 **B9（env 契约）** 两条，
> 本身就是 `docs/architecture.md` §4.1 的通用不变量，在此**重复列出并给指针**，理由是采集读者不该为这两条离开本页。
> 其余通用不变量一律见 `docs/architecture.md` §4（第一档 / 第二档同为两档制）。

#### 第一档：门禁固化（在 CI 真跑，且会红）

| 规则 | 守什么 | 固化处 | 跑在 |
|---|---|---|---|
| **B7** 部署面 | 全仓**只两份** compose（`deploy/docker-compose.yml` 单元 A + `deploy/data-compose.yml` 单元 B/数据面）；两份里**所有** `ports` 必须 `127.0.0.1:` 起头 | `scripts/check-compose.mjs` | `gates` |
| **B9** env 契约 | `.env.example` 键齐全 | `scripts/check-env-example.mjs` | `gates` |
| **dbt 工件七项** | staging 必含 `r['列名']` 取列模式 / 禁 `::double` / 禁 `union_by_name` / staging 一对一双向 / 语义声明必填字段 / 指标命名空间与同名唯一 / 每个声明指标一条对账 test | `scripts/check-data-models.mjs` | `gates` |
| **数据面投递** | lock 首行自校验 + lock ↔ 工作区逐文件 sha256/落地路径/模式一致 + 消费面覆盖 | `scripts/check-data-plane-lock.mjs` | `gates` |

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
> ② 那份清单**已经在漂**——`duckle/README.md:137`（§6）写「**四项**」，而 §7.4 实际枚举**五项**
> （漏的是「非回环 `UNCLAIMED` 分支」）。**照着抄就会把这个错一起抄进正典**。
```

> **执行者注（不要抄进正典）**：该漂移属 `duckle/README.md` 自身、不在本计划文件面内（spec 非目标：下钻文档正文不改），已挂在 §后续。
> 正典没有「后续」表，把它抄进去会悬空——它只属于本计划文件。

- [ ] **Step 2: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "第二档：仅文档" docs/data-platform-handbook.md && echo "§1.2 OK"
# 核验：上面每条固化处都真实存在于 CI 的 gates job
for f in check-compose check-env-example check-data-models check-data-plane-lock; do
  grep -q "scripts/$f.mjs" .github/workflows/ci.yml && echo "  $f ∈ gates ✓" || echo "  $f ∉ gates ✗"
done
```

**Expected:** 打印 `§1.2 OK`，随后四行**全部**为 `✓`。若任一条为 `✗`，说明该守卫不在 CI 里跑——把它从「第一档」移到「第二档」，**不要**留在第一档。

- [ ] **Step 3: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 正典 §1.2 硬约束清单——门禁固化/仅文档两档（含采集侧没人守的诚实清单）"
```

---

## Task 4: §1.3 生命周期 SOP（A→I）

**Files:**
- Modify: `docs/data-platform-handbook.md`（替换 `### 1.3 生命周期 SOP（A→I）` 下的 `（Task 4 填）`）

**Interfaces:**
- Consumes: §1.1（决策层，阶段 B 要按它定案）、§1.2（硬约束，阶段 F 引用）
- Produces: 阶段 I（退役）——§7 待沉淀 #2 指向它

- [ ] **Step 1: 写入 §1.3 正文**

替换 `（Task 4 填）` 为：

````markdown
> **没有验收的步骤等于没有步骤。** 验收不过不许进下一步。

| 阶段 | 动作 | 验收 | 回退 |
|---|---|---|---|
| **A 摸清源**（不写码） | 字段清单（**每列的正确类型有人签字**）；主体维度有几个；**自然键（行粒度，含 `snapshot`）**；增量字段；抽样看**真实值**；**网关/接口语义探针** | 能写出幂等采集策略；能说出分页风格、跨度上限、**有无 count**、时间过滤是否**真生效** | — |
| **B 选型定案** | 按 §1.1 逐项定案，**命中例外须写证据** | 产出**决策记录**并登记进 §1.7。**不留在对话里** | — |
| **C 契约** | 写 `contracts/<域>/<源>.<表>.json`（**人写的意图源**） | 元 schema 校验过（§1.2 第二档：手动跑）；与 `layout.prefix` 一致 | 改契约（改前先想清楚 `contractVersion`） |
| **D 管线** | duckle 管线，**由真引擎产出**（MCP `create_pipeline` / `validate_pipeline`），**仓内不手编**；含 `data.schema` + `qa.contract` gate + `drift` 门禁 + 末页守卫 | 引擎 `validate` 过；`drift` 有效（**先断言声明存在**，防假绿——见 §1.5「漂移」一条与 `duckle/README.md` §7.3 坑 1） | 回退到上一版管线 JSON |
| **E 调度** | 按 §1.1.4 定归口；薄 wrapper 只做三件事（算窗口 env / 注入 / 调 runner） | 排班触发一次且**如实入账**；改定义**两步都做了**（见 §1.3.2） | 停服务即回到「没有调度」 |
| **F 验收** | **四层**（§1.4） | 四层缺一层不算过 | 自证没过时**拒写湖是正确行为**，不是故障 |
| **G 运维** | 按 §1.5 速查处置 | 告警可达；容量有余量；观测有数据 | 按 §1.5 各条 |
| **H 变更与回填** | 改契约 / 改节奏 / 加域；**回填 = 同一管线换窗口参数** | 回填期逐日对账全绿 + 总量 sanity | 回填不影响在线链路（同管线、同写出通道） |
| **I 退役** | 旧前缀下线**前**必须：① 已有替代且对账过；② 消费面已切；③ 观察期 | 三项齐备才下前缀 | 保留前缀至观察期结束（细节见 §7 #2） |

#### 1.3.1 阶段 A 的方法学（最容易省，也最贵）

以下四条全部来自「跳过 A 直接写码」的实测教训：

- **看真实值，不看文档**：乐檬 `date_type` 文档写 `format=date-time`，实测**时间分量被网关静默忽略**
  （06-07 点窗返回 10:43 的单）⇒ 单据系的时间过滤**不可用**，只能「当日全拉 + 按业务日拆写」。
- **能力探针要反着问**：乐檬响应**无 total** ⇒ 翻页只能到「短页」+ **末页守卫**；
  文档写分页上限 200（早期误读成 100），误读会直接改变页容量规划。
- **跨度上限分域实测**：乐檬单店 ≤3 个月 / 多店 ≤1 个月 / 单据系 >7 天直接拒绝
  ⇒ 决定回填的分批策略（H 阶段）。
- **主体要探到 whoami 级**：PAT 实测**绑定单账套**；且单店单日可能空窗 ⇒ 探针须**多店合查**。

#### 1.3.2 阶段 E 的三个实测坑（别让下一个人重踩）

> ⚠️ **别与 `duckle/README.md` §7.3 的「三个坑」搞混——那是另一组三坑**
> （引擎能力面：`drift` 假绿 / `qa.freshness` 时区 / `pipelineHash` 不是数据指纹）。
> 本节这三条是**薄管线与 console 的坑**，完整实测依据见 `deploy/duckle/console/README.md`。

1. **`code.shell` 节点非零退出不让管线失败** —— 整条管线仍 `status: ok`，退出码只是**一行数据**
   ⇒ 必须跟一个 `qa.contract` 判红（`rules = { exit_code: "in_range:0,0" }`）。
2. **判据后面必须有 sink** —— 引擎是**惰性**的，gate 当叶子时**判据根本不被求值**；薄管线必须以 sink 收尾。
3. **console 必须显式给 `--duckdb`** —— 否则每次触发都记 `last_run_error: "DuckDB engine isn't installed yet."`。

**改调度定义后必须两步都做**（漏一步 = 改了没生效，**且不报错**）：
① 重新 **seed** 进该账套的 workspace 卷；② **重建 console 容器**——
文件 bind-mount 钉的是 inode，原子替换后运行中的容器**仍看到旧文件**。
（用 `serviceIds` **定向部署**；**别全量部署**——会重启 `pg_duckdb`。）

#### 1.3.3 薄 wrapper 的职责边界（唯一自建增补）

只做三件：按当前时刻**算窗口 env**（`TIME_FROM` / `TIME_TO` / `BIZDAY` / `HOUR`）、**清晨追加昨日**、**调 runner**。
**无状态**：窗口全部由时钟推导（重叠式），**不需要水位持久化**。
凭据走 **job/项目 env**，**不放宽** `deploy/duckle/entrypoint.sh` 的安全闸
（那道闸管「裸跑时不许做什么」，job 管「授权作业带凭据做什么」——**两者不是一回事**）。
````

- [ ] **Step 2: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "1.3.3 薄 wrapper 的职责边界" docs/data-platform-handbook.md && echo "§1.3 OK"
grep -c "（Task 4 填）" docs/data-platform-handbook.md
```

**Expected:** `§1.3 OK`；占位计数 `0`。

- [ ] **Step 3: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 正典 §1.3 生命周期 SOP A→I + A 阶段方法学 + E 阶段三坑 + wrapper 边界"
```

---

## Task 5: §1.4 四层验收 + §1.5 运维与故障速查

**Files:**
- Modify: `docs/data-platform-handbook.md`（替换 §1.4 与 §1.5 下的两处 `（Task 5 填）`）

**Interfaces:**
- Consumes: §1.3 阶段 F 指向 §1.4
- Produces: §1.5 的速查表——§1.6 案例库里「物化断链」一条与它互指

- [ ] **Step 1: 写入 §1.4 正文**

替换 §1.4 下的 `（Task 5 填）` 为：

```markdown
**缺一层不算过。**

| 层 | 机制 | 抓什么 | 乐檬零售（3120）实测 |
|---|---|---|---|
| **自证** | 写后**回读对象存储**（行数 / 金额） | 上传 / 转换失败 | 过（19,678 行 / 合计 1,622,276.08；hour=17 窗 126,596.06 与既有基线**逐分吻合**） |
| **幂等** | **同 `batch_id`** 重跑 ETag / Size **逐字节一致**；**换** `batch_id` 则 ETag 变（**by design**——`batch_id` 是载荷列） | 不确定性 / 重复累积 | 强判通过 |
| **独立通道** | 预聚合端点（`branchindicator` / `itemsales`）vs 明细聚合；固化为 dbt `audit_*` 独立复算 | 引擎 / 口径侧 bug | **未归零**：+17,250.91（**+1.15%**），149 家有值门店**全为正差**、无负差、无湖内独有店 ⇒ 指向**口径差**而非抽取缺失。⚠️ 这个数是 **S1 湖内逐店对账**跑出来的，**不是** `audit_*` 的产出——后者是让它**可重复、进 CI** 的机制（S2 起） |
| **跨系统** | 与旧平台同期关键指标一次性对比 | 口径 / 语义分歧 | 待回填后做 |

> ⚠️ **「引擎说 ok」≠「对象真的到了」**：`k1 ok (3 rows)` 只是引擎自认为成功，**必须回读**才算数。
> ⚠️ **独立通道未归零是「已知偏差」，不是「已通过」**：它是 S2 口径对齐的**起点**，
> 别把上面那个 +1.15% 读成绿。
```

- [ ] **Step 2: 写入 §1.5 正文**

替换 §1.5 下的 `（Task 5 填）` 为：

```markdown
| 现象 | 先看哪 |
|---|---|
| 排班没触发 / console 本身有问题 | **经 openship MCP** 读该 console 服务的日志（数据面 project → 服务 → 日志端点）——正常应是**四行**：console on / workspace / DuckDB / **sign-in required**。⚠️ **别裸 SSH 上机敲 `docker logs`**（根本法则·唯一通道；console 是 openship 管的服务，日志走 MCP 拿得到） |
| 跑了但失败 | `schedules.json` 的 `last_run_status` / `last_run_error`；以及该账套卷里 `logs/*.csv`（薄管线的运行记录，含 wrapper 完整 stdout）。⚠️ 这两样在**容器/卷里**，同样**经 MCP 的容器内执行端点**读，**不要上机** |
| ⚠️ **`/api/schedules` 的 GET 不回运行状态** | 文件里已有 `last_run_at`，GET 却恒 `null` ⇒ **别信那个 GET**，读 `schedules.json` 或 serve 日志 |
| 自证没过（`ASSERT_FAIL:` / `DIM_FAILED`） | **拒写湖是正确行为**（#205），**不是故障** |
| 容量撞顶 | 末页哨兵命中 ⇒ **fail-loud 不丢数**。**余量按阈值算，不按「页数 × 容量」算**——哨兵页占一页，真实阈值 = (页数 − 1) × 页容量 |
| 漂移 | 先看**声明是否存在**：`drift` 在「源未声明 schema」时**静默 `exit 0`（假绿）** ⇒ 门禁必须先断言「声明存在」，再判 drift 结论 |
| 观测没数据 | `OPS_SINK=DISABLED reason=no_ingest_env` ⇒ 观测投递未接通，见 issue **#210** |
| **下游数据陈旧（采集绿、报表陈）** | **先查物化有没有在跑**——2026-09-26 实测：37 个 job 无一跑 dbt，PG 停在 09-23（详见 §0 与 §1.6） |
| 改定义后没生效 | 检查**两步**是否都做了：re-seed 进 workspace 卷 + **重建容器**（§1.3.2） |

**告警**：接在 wrapper 的 `EXIT` trap（覆盖**所有**失败路径，且只有一份代码），**不接在管线的 `ctl.try`**
（其配置未建模，靠猜属性名配它 = **静默不生效**）。仅当 `LEMENG_NOTIFY=1` 时发（**薄管线会设** ⇒
人工/诊断跑失败不刷告警群）；缺 `WECOM_WEBHOOK_URL` 时打 `NOTIFY_SKIPPED`（**不静默**）；
**告警绝不改退出码**——别把判红变成绿。
```

- [ ] **Step 3: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "1.15%" docs/data-platform-handbook.md && echo "§1.4 OK（独立通道未归零如实记录）"
grep -q "下游数据陈旧" docs/data-platform-handbook.md && echo "§1.5 OK"
grep -c "（Task 5 填）" docs/data-platform-handbook.md
```

**Expected:** 打印两行 OK；占位计数 `0`。

- [ ] **Step 4: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 正典 §1.4 四层验收 + §1.5 运维速查（含物化断链与假绿两条）"
```

---

## Task 6: §1.6 案例库 + §1.7 逐源决策登记区

**Files:**
- Modify: `docs/data-platform-handbook.md`（替换 §1.6 与 §1.7 下的两处 `（Task 6 填）`）

**Interfaces:**
- Consumes: §1.1 的决策维度（1.7 登记表按它列）；§1.5（互指「物化断链」）
- Produces: §1.7 决策登记——后续每接一个源在此加一行

- [ ] **Step 1: 写入 §1.6 正文**

替换 §1.6 下的 `（Task 6 填）` 为：

```markdown
> **只增不改**；每条规则指回它长出来的案例。**无案例的不写**（进 §7 待沉淀）。

| # | 案例 | 长出的规则 |
|---|---|---|
| 1 | 网关 `date_type` 文档写 `format=date-time`，实测**时间分量被静默忽略**（06-07 点窗返回 10:43 的单） | §1.3.1「看真实值，不看文档」 |
| 2 | 乐檬响应**无 total** ⇒ 只能翻页到短页 | §1.3.1 末页守卫；§1.5 容量条 |
| 3 | **生产峰值 1459 单/时击穿 1400 阈值**（哨兵命中、窗口断在 19 点）⇒ 扩容到 12 页（#197） | §1.5「余量按阈值算」；**阈值 = (页数 − 1) × 页容量** |
| 4 | 维度域原写行粒度键 `(system_book, item_num)`，**漏了 `snapshot`**（2026-09-26 订正） | §1.1.2 粒度纪律 |
| 5 | `snk.parquet` / `snk.s3` 都不通，而 `snk.minio` **可直写 ZOS** | §1.1.1 E3 的证成方法学 |
| 6 | 同 `batch_id` 重跑 **ETag/Size 逐字节一致**；换 `batch_id` 则变 | §1.4 幂等层的判据（「变」是 by design） |
| 7 | `drift` 在「源未声明 schema」时**静默 `exit 0`** | §1.5 漂移条 + §1.3 阶段 D 的「先断言声明存在」 |
| 8 | `code.shell` 节点 `exit 3`，整条管线仍 `status: ok` | §1.3.2 坑 1 |
| 9 | gate 当叶子时判据**根本不被求值**（引擎惰性） | §1.3.2 坑 2 |
| 10 | 调度条目带不了自己的 env（塞 `env`/`args`/`params` 被静默丢弃） | §1.1.4「一账套一个 console」 |
| 11 | 文件 bind-mount 钉 inode ⇒ 原子替换后运行中的容器**仍看到旧文件** | §1.3.2「改定义必须两步」 |
| 12 | 存量乐檬 parquet**列全是字符串**（金额/时间是 VARCHAR），聚合直接报错 | layered spec §9 坑 1 ⇒ §1.1.2「落盘即定型」 |
| 13 | 同一域不同日期**列数不同**（46 vs 43）⇒ union 直接读不出 | §1.1.2 字段集稳定（禁 `union_by_name`） |
| 14 | 同一张表里两个时间列**两种格式**（`2026-07-01 10:02:34` vs `20260707`） | §1.1.2「落盘即定型」 |
| 15 | pg_duckdb **不接受 `DOUBLE`** 作 cast 目标（`type "double" is only a shell`） | `contracts/` 类型枚举里**故意不含 `double`** |
| 16 | 读 parquet 点名取列必须 **`r['列名']` + 别名 `r`**；`SELECT *` 能过、点名报 `column does not exist` | dbt staging 门禁（`check-data-models` 第 ① 项） |
| 17 | **物化断链**：采集每天绿、湖每天长，而 PG **停在 09-23**；37 个 job 无一跑 dbt；**没有任何东西报错** | §0 完成判据「落湖归我、下游看得见」；§1.5「下游数据陈旧」一条 |
```

- [ ] **Step 2: 写入 §1.7 正文**

替换 §1.7 下的 `（Task 6 填）` 为：

```markdown
> 每接一个源加一行（阶段 B 的产物）。**例外须写明命中了哪一条 + 证据**（§1.1.1）。

| 源 / 表 | 通道 | 例外证据 | 落点前缀 | 分区键 | 节奏 | 调度归口 | 验收结论 |
|---|---|---|---|---|---|---|---|
| 乐檬零售明细（3120） | duckle | — | `lemeng/retail_order_line` | `system_book=` + `hour=` | **设计** 5min tick / **现行**日粒度 | **openship job**（`lemeng-retail-3120-runner`，`30 2 * * *` **UTC**，**尚未迁 console**） | 自证 ✓ / 幂等 ✓ / 独立通道 **✗ 未归零（+1.15%）** / 跨系统 待回填 |
| 乐檬零售明细（64188） | duckle | — | 同上 | 同上 | 同 3120 | 未落 | — |
| 乐檬门店维 / 商品维（双账套） | duckle | — | `lemeng/dim_branch`、`lemeng/dim_item` | `system_book=` + `snapshot=` | 日更（全量快照） | **duckle console** ×2（UTC `0 2 * * *` / `0 11 * * *`） | 首次真跑销账（**拒写湖**路径已验证）——**不是「四层全过」** |
| 乐檬调拨 / 批发 / 退货 / 要货（5 源） | duckle（设计定稿） | — | `lemeng/transfer_out` 等 | `system_book=` + `bizday=` | 5min 增量 + 每小时全量（设计） | 未落 | — |
| 抖音 `sku_daily` | 未定 | — | `douyin/sku_daily` | 月（**键名未定**） | 未定 | 未落 | 待接入 |
| 抖音接收器（`dy-upload`，生产在跑） | **E1**（长驻接收） | 长驻接收器**在跑**（生产 project `dy-upload` 以 `bare` runtime 跑 `/opt/douyin-life/capture/dy_receiver_run.py`）⇒ 命中 E1；**落盘形态等细节待核实**（§7 #3） | 待核实 | 待核实 | 常驻 | 待核实 | — |
```

> ⚠️ **上表的「验收结论」列**才是这个登记区的价值所在：**空着 = 没验过**，别用「跑起来了」当验收。

- [ ] **Step 3: 修 §1.1 里一处兑现不了的承诺（Task 2 评审抓出）**

§1.1.1 的 E1 行现在写「有案例（细节见 §7 #3）」，但 §7 第 3 行本身就是一个**待沉淀项**
（「需先核实其实现与落盘形态」）⇒ 指针能解析，**却兑现不了「有细节」这个承诺**。
§1.6 案例库落地后，把 E1 那一格改成指向它：

| 位置 | 原文 | 改为 |
|---|---|---|
| §1.1.1 的 E1 行末格 | `有案例（细节见 §7 待沉淀 #3）` | `有案例（细节待核实后补；见 §7 #3）` |

> ⚠️ **原文那句要按上面这个写法逐字匹配**（初稿把「原文」写成了缩略的 `细节见 §7 #3`，与文档实际不符）。
> 更要紧的是：**守卫要能红**。初稿给的 `grep -c "细节见 §7 #3"` 在**改动前就已经是 0**（文档里从没出现过那个缩略形式）
> ⇒ 它**永远不可能失败**，是个假绿守卫——正是本正典 §1.5 在批的那类东西。
> 有牙的判据是这两条**同时**成立：`grep -c "细节见 §7 待沉淀 #3"` = `0`（旧格确已消失）**且** `grep -c "细节见 §1.6 案例库"` ≥ `1`（新格确已落地）。

> ⚠️ 只改这一格。别顺手改 E2/E3 两格——E2 本就是「无案例」（§7 #1），E3 指向 `duckle/README.md` §1.4，两者都对。

- [ ] **Step 4: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "1.7 逐源决策登记区" docs/data-platform-handbook.md && echo "§1.7 OK"
grep -q "物化断链" docs/data-platform-handbook.md && echo "案例 17 在"
echo "E1 承诺已修（应 ≥1）:"; grep -c "细节待核实后补" docs/data-platform-handbook.md
echo "旧承诺已消（应为 0）:"; grep -c "细节见 §7 待沉淀 #3" docs/data-platform-handbook.md
# 登记表里的每一条都要与本文档 §2 的源清单对得上（数目一致）
grep -c "^| 乐檬\|^| 抖音" docs/data-platform-handbook.md
grep -c "（Task 6 填）" docs/data-platform-handbook.md
```

**Expected:** 两行 OK；`细节见 §1.6 案例库` 计数 ≥ 1；`细节见 §7 待沉淀 #3` 计数 `0`、`细节待核实后补` 计数 ≥ 1；登记表行数 ≥ 6；占位计数 `0`。

- [ ] **Step 5: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 正典 §1.6 案例库（17 条实测）+ §1.7 逐源决策登记区 + 修 §1.1 E1 承诺"
```

---

## Task 7: 台账补齐（§2 数据源清单现状 + §3 落地位置四个 `<待补>`）

**Files:**
- Modify: `docs/data-platform-handbook.md`（§2 表格、§3 表格）

**Interfaces:**
- Consumes: Task 1 保住的 §2/§3
- Produces: §3 零 `<待补>`——Task 9 的门禁之一

- [ ] **Step 1: 补 §3 的四个 `<待补>`**

把 §3 表格整段替换为（**保留 §3 节号**）：

```markdown
## 3 落地位置

| 东西 | 在哪 |
|---|---|
| duckle 管线 | `duckle/common/<源>.<表>.json`（客户级覆盖 `duckle/customers/`）；约定见 `duckle/README.md` §2 |
| duckle console 定义 | `deploy/duckle/console/{pipelines,schedules}/`（seed 进各账套 workspace 卷） |
| dbt 项目 | `dbt/`（按域分目录；staging / marts / semantics / tests） |
| 语义声明 | `dbt/semantics/l1_metrics.yml`（L1 唯一事实源）+ `dbt/models/common/marts/schema.yml` |
| 采集契约（落盘 schema 声明的**意图源**） | `contracts/<域>/<源>.<表>.json`（机器面在管线：`node.data.schema` + `qa.contract` + `drift`） |
| 数据面编排 | `deploy/data-compose.yml`（部署单元 B；全仓只两份 compose，B7 守） |
| **物化调度** | **openship job**（归口）——⚠️ **现状：没有任何 job 在跑 dbt**，PG 物化停在 09-23（§0 / §1.5） |
```

- [ ] **Step 2: 补 §2 的现状行**

§2 表格里，把状态列按**实际**更新。**保留原有的两行说明**（`> 每接一个源加一行。**状态**只有三种：摸清源 / 已落盘 / 已进语义。`）
——**不要另创状态词**。表格替换为：

```markdown
| 域 | 表 / 前缀 | 主体维度 | 状态 | 备注 |
|---|---|---|---|---|
| 乐檬 | `lemeng/retail_order_line/<主体>/<日>/<时>/all.parquet` | 账套（3120 熊喵 / 64188 品品甜） | **已落盘**（3120；64188 未落） | 新湖口径见 §1.7；旧前缀 `lemeng/retail_detail/…` 待退役（§1.3 阶段 I） |
| 乐檬 | `lemeng/dim_branch`、`lemeng/dim_item`（`system_book=` + `snapshot=`） | 同上 | **已落盘**（双账套） | 全量快照日更；行粒度键含 `snapshot`（§1.1.2） |
| 乐檬 | 调拨 / 批发 / 退货 / 要货（`transfer_out` / `wholesale_order` / `wholesale_return` / `request_order`） | 3120（要货双账套） | **摸清源**（设计定稿，未落） | 见 `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md` |
| 抖音 | `douyin/sku_daily/<月>/all.parquet` | — | **摸清源**（待接入） | 分区键名未定；见 `contracts/README.md` §7 |
```

> ⚠️ 删掉原来那一行 `duckle/<域>/_ops/…`（备注「duckle 自己的产出」）——`duckle/README.md` §5 已实测订正：
> `_ops` 是**桶里的路径猜想**、在 runner 二进制里检索不到，不是本仓的目录约定。
> **但 `duckle/README.md:121` 仍然引用本文档 §2**——所以那句订正的**落脚点**要留：把该行的信息并入上表
> 「duckle 管线」相关行或在 §2 表后加一句：
> `> 「`_ops`」不是本仓目录约定（实测订正见 duckle/README.md §5）——桶内路径猜想，别再照抄。`

- [ ] **Step 3: 修 §4 / §5 里指向「未合入的公司标准」的陈旧引用**

§2–§5 的正文在 Task 1 里被冻结保留，但其中三处引用的是 **`team-harness` 那份尚未合入**的标准
（写作「标准 §N」）——本正典升级后，它们应当指回本正典自己的节。逐处改：

| 位置 | 原文 | 改为 |
|---|---|---|
| §4 开头引用块 | `> 按标准 §2 硬约束逐条对账；…重构时一并改。` | `> 按 §1.2 硬约束清单逐条对账；…重构时一并改。` |
| §4 末句 | `**⇒ 重构时按标准 §3 的 SOP 重走一遍，这些一并消掉。**` | `**⇒ 重构时按 §1.3 的生命周期 SOP 重走一遍，这些一并消掉。**` |
| §5 开头引用块 | `> 每接完一个源，记一行：…卡点进标准 §6 案例库）。` | `> 每接完一个源，记一行：…卡点进 §1.6 案例库，并登记进 §1.7）。` |

（§3 里那处 `按标准 §4.1 的形态` 已被 Step 1 整表替换掉，不必单独改。）

⚠️ **只改这三处的引用目标，不动 §4/§5 的其余内容，也不动它们的节号**——
`contracts/README.md:58` 仍按节号引用 §4，改号即静默破引用。

- [ ] **Step 4: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
echo "待补残留（应为 0）:"; grep -c "<待补>" docs/data-platform-handbook.md
echo "陈旧「标准 §N」引用（应为 0）:"; grep -c "标准 §" docs/data-platform-handbook.md
echo "§2 仍在:"; grep -n "^## 2 本项目的数据源清单" docs/data-platform-handbook.md
echo "§3 仍在:"; grep -n "^## 3 落地位置" docs/data-platform-handbook.md
echo "§4 仍在:"; grep -n "^## 4 已知欠账" docs/data-platform-handbook.md
echo "duckle/README.md:121 引用的 §2 内容仍有落点:"; grep -q "_ops" docs/data-platform-handbook.md && echo "  ✓ 有" || echo "  ✗ 缺"
```

**Expected:** 前两个计数都是 `0`；§2/§3/§4 标题各打印一行；最后打印 `✓ 有`。

- [ ] **Step 5: Commit**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(collection): 台账补齐——§3 四个 <待补> 填实 + §2 按现状更新 + §4/§5 陈旧标准引用改指本正典"
```

---

## Task 8: 路由与漂移订正（AGENTS.md + architecture.md + SOP §F）

**Files:**
- Modify: `AGENTS.md`（「文档地图」表加 1 行）
- Modify: `docs/architecture.md`（§2.2 第 2 条加订正指针；§6 文档地图加 1 行）
- Modify: `deploy/data-plane-deploy-sop.md`（§F 加 1 行指针）

**Interfaces:**
- Consumes: Task 1–7 已把 handbook 变成正典（路由指向它才有意义）
- Produces: 无后续依赖（本任务是最后的内容件）

- [ ] **Step 1: `AGENTS.md` 文档地图补一行**

在 `## 文档地图（动手前先读对应的）` 表格里，「新接一个业务模块」行**之后**插入：

```markdown
| 接采集任务 / 改采集链路 / 改调度 | `docs/data-platform-handbook.md`（**采集正典**：决策 / 生命周期 SOP / 四层验收 / 运维速查 / 逐源决策登记 + 数据源台账） |
```

- [ ] **Step 2: `docs/architecture.md` §2.2 第 2 条加订正指针**

在 §2.2 的 `**2. duckle（headless runner；…）**` 条目里，`- **不做什么**：**不建模**（口径在 dbt）、**不做语义与权限**（在 `modules/data`）、**不常驻**。` 这一行的末尾追加：

```markdown
  ⚠️ **订正（2026-09-26）**：其中「**不常驻**」一句**已被 ADR-0014 取代**——`deploy/data-compose.yml` 起
  两个**常驻** `lemeng-console-3120` / `lemeng-console-64188` 服务（`duckle-runner serve` 的调度 tick，
  只绑回环，见 `deploy/data-plane-deploy-sop.md` §F）。**「不常驻」对它不再成立**；`etl` profile 的
  一次性 runner 语义不变。归口口径见 `docs/data-platform-handbook.md` §1.1.4。
```

- [ ] **Step 3: `docs/architecture.md` §6 文档地图加一行**

在 §6 的表格里，「`deploy/openship-adopt.md` | 部署接入」行**之后**插入：

```markdown
| `docs/data-platform-handbook.md` | 接采集任务 / 改采集链路 / 改调度前**必读**（采集正典 + 数据源台账） |
```

- [ ] **Step 4: `deploy/data-plane-deploy-sop.md` §F 加指针**

在 §F 标题下方那句 `> **实现细节（为什么这么设计、每条实测事实）**：`deploy/duckle/console/README.md` —— 本文**不复制**，只写运维视角要看的东西。` **之后**追加一行：

```markdown
> **归口口径（「什么时候该归 console、什么时候归 job」）**：`docs/data-platform-handbook.md` §1.1.4 —— 本文只讲怎么运维。
```

- [ ] **Step 5: 核验**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
grep -q "采集正典" AGENTS.md && echo "AGENTS.md 路由 ✓"
grep -q "不常驻.*已被 ADR-0014 取代" docs/architecture.md && echo "architecture 订正 ✓"
grep -q "data-platform-handbook.md.*必读" docs/architecture.md && echo "architecture 文档地图 ✓"
grep -q "1.1.4" deploy/data-plane-deploy-sop.md && echo "SOP §F 指针 ✓"
# 顺带确认没把「不常驻」那句删掉（订正是追加指针，不是改写历史结论的措辞）
grep -c "不常驻" docs/architecture.md
```

**Expected:** 四行 `✓`；最后一条输出 ≥ 2（原文那句还在 + 订正里引了它）。

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/architecture.md deploy/data-plane-deploy-sop.md
git commit -m "docs(collection): 补 AGENTS.md 文档地图采集路由 + 订正 architecture duckle「不常驻」漂移"
```

---

## Task 9: 全量一致性校验 + 开 PR

**Files:**
- 无改动（只读校验 + 开 PR）

**Interfaces:**
- Consumes: Task 1–8 全部产出
- Produces: 可评审的 PR

- [ ] **Step 1: 跑全量核验（这一节是本次交付的「验收四层」对应物）**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块

echo "===== ① 保号约束：三处外仓内引用仍对得上 ====="
sed -n '58p' contracts/README.md
sed -n '157p' contracts/README.md
sed -n '121p' duckle/README.md

echo "===== ② §2/§4 标题仍在，且节序正确 ====="
grep -n "^## " docs/data-platform-handbook.md

echo "===== ③ 占位清零（两处都应为 0）====="
grep -c "（Task [0-9] 填）" docs/data-platform-handbook.md
grep -c "<待补>" docs/data-platform-handbook.md

echo "===== ④ 正典七个子节齐备 ====="
for s in "1.1 决策层" "1.2 硬约束清单" "1.3 生命周期 SOP" "1.4 四层验收" "1.5 运维与故障速查" "1.6 案例库" "1.7 逐源决策登记区"; do
  grep -q "$s" docs/data-platform-handbook.md && echo "  ✓ $s" || echo "  ✗ 缺 $s"
done

echo "===== ⑤ 下钻清单里每个指针文件都真实存在 ====="
for f in contracts/README.md duckle/README.md deploy/duckle/README.md deploy/duckle/console/README.md \
         deploy/data-plane-deploy-sop.md docs/architecture.md \
         docs/superpowers/specs/2026-09-21-data-platform-layered-design.md \
         docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md; do
  [ -f "$f" ] && echo "  ✓ $f" || echo "  ✗ 不存在 $f"
done

echo "===== ⑥ 受管文件未被误碰（应为空）====="
git diff --name-only origin/main...HEAD | grep -E "^(deploy/data-compose\.yml|deploy/duckle/entrypoint\.sh|deploy/duckle/Dockerfile|dbt/|duckle/|deploy/duckle/console/|scripts/lemeng/)" || echo "  ✓ 未碰任何清单内文件 ⇒ 无需重跑 data-plane-lock 生成器"

echo "===== ⑦ 本计划承诺的改动面 = 实际改动面 ====="
git diff --name-only origin/main...HEAD
```

**Expected:**
- ① 三行都打印出含 `handbook` 与 `§2`/`§4` 的句子
- ② `## 0`→`## 7` 依次存在，`## 2 本项目的数据源清单` 与 `## 4 已知欠账…` 在
- ③ 两个计数都为 `0`
- ④ 七行全 `✓`
- ⑤ 八行全 `✓`
- ⑥ 打印 `✓ 未碰任何清单内文件…`
- ⑦ 恰好四行：`docs/data-platform-handbook.md`、`AGENTS.md`、`docs/architecture.md`、`deploy/data-plane-deploy-sop.md`（外加 `docs/superpowers/specs/2026-09-26-collection-canon-design.md` 与 `docs/superpowers/plans/2026-09-26-collection-canon.md` 这两个本轮的稿）。**若有第五个非稿件文件 ⇒ 停下来核对**。

- [ ] **Step 2: 确认 CI 会绿但**不拿它当证据**

```sh
cd /Users/duo/orca/workspaces/platform-core/采集板块
pnpm exec tsx scripts/check-compose.mjs && \
pnpm exec tsx scripts/check-env-example.mjs && \
pnpm exec tsx scripts/check-data-models.mjs && \
pnpm exec tsx scripts/check-data-plane-lock.mjs && \
pnpm exec tsx scripts/lint-architecture.mjs && echo "五条守卫全绿"
```

**Expected:** 打印 `五条守卫全绿`。
⚠️ **读法**：它们**都不扫 `docs/` 与 `AGENTS.md`** ⇒ 绿只证明「没碰坏受管面」，**不证明正典写对了**。
正典的正确性由 Step 1 的七项 + 人工评审保证。

- [ ] **Step 3: 推送并开 PR**

```bash
cd /Users/duo/orca/workspaces/platform-core/采集板块
git push -u origin docs/data-platform-canon
gh pr create --repo MYTech-Co-LTD/platform-core \
  --title "docs(collection): 采集正典——升级 handbook（决策/SOP/验收/运维/案例 + 逐源登记），补采集路由" \
  --body "$(cat <<'EOF'
## 这是什么

把 `docs/data-platform-handbook.md` 从 3.2KB 的薄指针升级为**本项目的采集正典**，并把
`AGENTS.md` 文档地图里缺失的「数据面/采集」路由补上。**零新增文件。**

设计稿：`docs/superpowers/specs/2026-09-26-collection-canon-design.md`

## 为什么现在做

`AGENTS.md` 的文档地图里，改模块 / 部署 / 冒烟 / 提交纪律都有路由，**唯独数据面/采集没有**
⇒ 接采集任务没有入口。而数据面相关的「正典」自称已有 4 处（`architecture.md` §2.2 /
`contracts/README.md` / `duckle/README.md` §7 / `console/README.md`），各讲一个主语但**没有总入口**。

## 内容

- **§0** 管什么/不管什么 + **「采集完成」判据**（落湖归我、下游看得见）
- **§1.1 决策层**：通道选型（duckle 优先 + E1/E2/E3 例外条件与证成方法学）/ 落地形态 / 节奏 / 调度归口 / 一源一路
- **§1.2 硬约束清单**：门禁固化 4 条 + **仅文档 8 条**（含「没人守」的诚实清单）
- **§1.3 生命周期 SOP A→I**：每步带验收与回退 + A 阶段方法学 + E 阶段三坑 + wrapper 边界
- **§1.4 四层验收**（独立通道**未归零 +1.15% 如实记录**，不读成绿）
- **§1.5 运维与故障速查**
- **§1.6 案例库 17 条**（全部实测）
- **§1.7 逐源决策登记区**（含「空着 = 没验过」的读法）
- **§2–§5 台账**（§3 的四个 `<待补>` 填实；§2 按实际现状更新）
- **§6 下钻清单**、**§7 待沉淀 4 项**（无案例的**不编**）

## 顺带修

- `AGENTS.md` 文档地图补采集路由行
- `docs/architecture.md` §2.2 订正 duckle「**不常驻**」——ADR-0014 后有两个常驻 console，该句已漂（**追加订正指针，不改原句**）
- `deploy/data-plane-deploy-sop.md` §F 加归口指针

## 纪律

- 本 PR 为 `docs` 类型，按 dev-discipline 免 issue
- **保号约束**：handbook §2 与 §4 的节号与内容留住（`contracts/README.md:58`、`contracts/README.md:157`、`duckle/README.md:121` 按节号引用它）
- 未碰 `deploy/data-plane-manifest.txt` 清单内任何文件 ⇒ 无需重跑 lock 生成器
- CI 五条守卫**都不扫 `docs/`** ⇒ 绿**不构成**正典正确的证据；正确性由 PR 内的一致性核验（保号 / 占位清零 / 指针存在 / 改动面）与评审保证
EOF
)"
```

- [ ] **Step 4: 等 CI CLEAN 再合**

```bash
cd /Users/duo/orca/workspaces/platform-core/采集板块
gh pr checks --watch
```

**Expected:** 全部检查通过（`unit` / `gates` / `web` / `smoke` / `discipline` 类）。
**只有 CLEAN 才合**——UNSTABLE 强合在本仓出过生产 502。squash 合并。

---

## 后续（不在本计划内，明确留给下一个决定）

| # | 事项 | 为什么不在本计划内 |
|---|---|---|
| 1 | 给「正典里的 `§N` 交叉引用」加一道守卫脚本 | 本仓规矩：升级成门禁是**另一个决定**，需单独案例。且 spec 的非目标已排除 |
| 2 | 提炼公司标准提 `team-harness/docs/standards/` | 要等 PR #79 那轮 Actions 额度恢复；且规范要求**先跑通下一个源**再提炼 |
| 3 | 修物化断链（建 dbt 物化 job）+ 观测通道 #210 | 是正典 §1.5 的**输入**，不是本计划的交付物；各自按独立 issue 走 |
| 4 | 零售链路从 openship job 迁到 duckle console | 正在跑的生产链路，迁移需单独决定与观察（SOP §F.5） |
| 5 | **修 `duckle/README.md` 的自相矛盾**：`§6`（该文件 137 行）写「未验**四项**」，而 `§7.4` 实际枚举**五项**（漏「非回环 `UNCLAIMED` 分支」） | 属那份下钻文档自身；spec 非目标明确「下钻文档正文不改」⇒ 本计划只**绕开**它（正典不枚举、只给指针），漂移本身另开一处修。<br>⚠️ **修它时必须同时重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`**——`duckle/` 是 `deploy/data-plane-manifest.txt` 的**递归条目**，`data-plane.lock` 钉着 `duckle/**` 每个文件的 sha256，`check-data-plane-lock` 在 `gates` 里跑 ⇒ 只改 README 不动 lock，**CI 直接红**。（这条是我在 Task 3 评审时才知道的，原先漏了。） |
| 6 | **订正 `scripts/check-data-models.mjs:56` 与 `.github/workflows/ci.yml:92` 的同类过宽措辞**（都写「`duckle/` 与 `contracts/` 不在任何扫描面内」）。二者在各自上下文里（env 键覆盖 / 那一条守门的扫描根）仍准确，但按本正典 §1.2 已订正的口径（`duckle/**` **受投递完整性门禁**）读会偏宽 | Task 3 复评的 out-of-scope 观察；既存、非本计划引入。**注意 ci.yml 是 CI 定义本身，改它要另行评审** |
| 7 | **`deploy/data-plane-deploy-sop.md` §F.4 有同一条越权指令**：它也让运维「`docker logs <console>`」，与**根本法则·唯一通道**（看日志也走 openship MCP）冲突。本计划 Task 5 已把**正典侧**改成走 MCP，**SOP 侧未动**（不在本计划文件面内）⇒ 两处口径**暂时不一致**，需另开一处把 SOP 也订正 | Task 5 复评的 out-of-scope 观察。**这是纪律级问题**（不是笔误）：正典若不动就成了「教人违规」，所以正典先改；SOP 跟上另议 |
