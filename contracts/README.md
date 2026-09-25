# contracts/ — 采集契约（落盘即定型的机器面）

> 本目录是**数据工件**，不是 Node workspace 包。它**不在** B1（跨 schema）/ B8 / B9（env 键齐全）
> **任何扫描面内**——`docs/architecture.md` §2 已明写「`contracts/` 与 `duckle/` 的 env 键等约束
> **当前没有任何静态门禁**」。别把本目录里的任何约定读成「被守住了」，**§5 逐条列了没人守的部分**。

**契约是什么**：一个数据源**首次落盘前**写下的 schema 声明——表身份、列名与类型、可空性、分区键、
批次标记、owner。它是「**落盘即定型**」这条硬约束的**机器面**：落盘时按声明定型，类型不符即失败，
**不静默降级成 VARCHAR**（重演存量乐檬 parquet「金额/时间全是字符串」的坑）。

**适用面（收窄后的口径）**：**只适用新数据源接入**。存量乐檬 parquet（VARCHAR）**不重落盘**，
由 dbt staging 手写 cast 补——见 `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`
§10 拍板记录·分叉 1 与 §7 硬约束第 1 条的收窄注记。**别拿本目录去追溯存量。**

---

## 1 目录与命名约定

```
contracts/
├── README.md                        ← 本文件（形态与纪律的正典）
├── common/
│   ├── _schema.schema.json          ← 元 schema：契约文档本身的 JSON Schema（下划线前缀 = 基础设施，不是契约）
│   ├── _template.contract.json      ← 模板（同样是下划线前缀 = 不是契约；新源复制它改名）
│   └── <源>.<表>.json               ← 真契约，如 douyin.sku_daily.json
└── customers/
    └── <客户>/                       ← 客户级覆盖，见 customers/README.md
```

- **`_` 前缀 = 不是契约**。任何自动发现契约的校验器**必须跳过 `_` 开头的文件**——否则会把元 schema
  和模板本身当成契约去校验。这是本目录唯一的「命名即语义」约定，写在这里以防有人按扩展名扫。
- **一份契约 = 一个数据源的一张表**。同一个源的多张表 = 多个文件（`<源>.<表>.json`）。
- **客户级覆盖**放 `contracts/customers/<客户>/`，形态见该目录 README。

## 2 契约文档的字段

以 `common/_template.contract.json` 为骨架，语义以 `common/_schema.schema.json` 为准（**那里是机器判据，这里只是导读**）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `contractVersion` | ✅ | 只接受 `1`。改格式要递增版本号并同步元 schema 与本节，**不许原地改语义** |
| `domain` / `table` | ✅ | 数据域与表名；与 `layout.prefix` 必须一致（跨字段，校验器补检） |
| `owner` | ✅ | 负责方（团队/角色名）。**不写个人联系方式**——联系方式的取法在 owners.json / README，不在契约里 |
| `layout.prefix` | ✅ | 桶内前缀，等于 `<domain>/<table>` |
| `layout.partitionStyle` | ✅ | **只接受 `hive`**（`system_book=3120/`），见 §3 |
| `layout.partitionBy` | ✅ | 分区键，从外到内；每键必须是 `columns` 里的列 |
| `layout.fileName` | ✅ | 只接受 `all.parquet`，见 §3 |
| `batch.markerColumn` / `batch.type` | ✅ | 批次标记的列名与类型 |
| `columns[]` | ✅ | `name` / `type` / `nullable` 三者必填；`decimal` 另需 `precision` + `scale` |

## 3 两条写死在 schema 里的纪律（不是风格偏好）

### 3.1 分区命名必须是 hive 风格

`layout.partitionStyle` 是 `const: "hive"`，写别的直接校验失败。

**为什么**：非 hive 命名的存量路径（`3120/` 而不是 `system_book=3120/`）已被记为欠账 ——
`docs/data-platform-handbook.md` §4 的账：「路径非 hive 分区命名 ⇒ **下游拿不到自动分区列**」。
新源不许再欠一次，所以这条禁令放在元 schema 里，而不是靠评审口头提醒。

### 3.2 文件名只接受 `all.parquet`

**依据**：本仓已有的三处路径规范都这么写 —— handbook §2 的乐檬
`lemeng/retail_detail/<主体>/<日期>/all.parquet` 与抖音 `douyin/sku_daily/<月>/all.parquet`，
layered design §4 的 `s3://<bucket>/<domain>/<table>/<date>/all.parquet`。

⚠️ **这是「当前无案例支持放宽」的硬约束，不是「永远这样」**：多文件形态（含 duckle 分片产出）
**没有实测案例**。真要放开，先拿案例，再改元 schema 的 `contractVersion`。

## 4 机检面：校验什么、怎么被消费、现在有没有校验器

### 4.1 元 schema 校验什么

`common/_schema.schema.json` 是 **JSON Schema draft 2020-12**，管的是**单文档内部**的约束：

- 必填字段齐全、未知字段一律拒绝（`additionalProperties: false`）
- `type` 取闭集枚举（§5）、`decimal` 必须带 `precision`/`scale`、**非 decimal 不许带**这两个键
- `layout.partitionStyle` / `fileName` / `contractVersion` 是 `const`
- 名字形态（小写下划线）、`partitionBy` 非空、`batch.type` 只收标识/时间类标量

### 4.2 ⚠️ 它**表达不了**六条跨字段约束（校验器必须补）

JSON Schema 没有跨字段引用能力。以下六条**过了 schema 也可能不合规**，元 schema 的 `$comment`
里同样记着这一份清单 —— 两处必须同步改：

1. partitionBy 里的每个键必须是 columns 里出现过的列名
2. layout.prefix 必须等于 domain + '/' + table
   ⚠️ **本仓「维度面」是这条的已知例外**（只登记口径，不改校验逻辑）：按
   `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md` §5 的湖布局，
   维度表落湖一律带 **`dim_` 段**（`lemeng/dim_branch`、`lemeng/dim_item`）⇒ 规则 ② 在该面
   **不适用**（`layout.prefix ≠ domain/table`）。两份维度契约（`common/lemeng.branch.json`、
   `common/lemeng.item.json`）的 description 里都写了「layout 说明」段声明这一点——
   **别把它们的前缀当笔误改掉**。其余面（零售/批发等）仍照规则 ② 走。
3. columns 的 name 不得重复
4. batch.markerColumn 必须是 columns 里出现过的列名
5. decimal 的 scale 必须 ≤ precision
6. 分区键列不得声明 nullable = true

### 4.3 校验器：**当前不存在**（这是本任务最大的一条欠账）

本仓**没有任何脚本消费 `contracts/`**——没有校验器、没有 CI 步骤、没有 dbt/duckle 侧的读取方。
`docs/architecture.md` §2 的原话就是「它们的 env 键等约束**当前没有任何静态门禁**」。
本任务只交付**契约格式**（元 schema + 模板 + 约定），**不交付校验器**（不在 T5 的文件面内）。

**要跑一次真实校验，现在就能跑**（元 schema 是标准 2020-12，任何标准实现都行）：

```sh
# Node 侧（与仓库同栈；ajv 未在本仓依赖里，需 npx 临时取）
npx --yes ajv-cli@5 validate -s contracts/common/_schema.schema.json \
  -d contracts/common/_template.contract.json --spec=draft2020

# 或 Python 侧
python3 -c "import json,glob;from jsonschema import Draft202012Validator as V; \
m=json.load(open('contracts/common/_schema.schema.json'));V.check_schema(m); \
[V(m).validate(json.load(open(f))) for f in glob.glob('contracts/**/*.json') if not f.split('/')[-1].startswith('_')]"
```

**校验器落地时的判据**（给后来者，也给出可供机器守的形状）：

- 必须**跳过 `_` 前缀文件**（§1）；`_template.contract.json` 只作模板，不作契约
- 必须补 §4.2 那六条跨字段规则
- 建议挂进 `.github/workflows/ci.yml` 的 `gates` job——但**先经 T4 或评审加面**：
  `scripts/check-data-models.*` 是 T4 的文件面，本任务不碰

> ⚠️ **2026-09-23 订正：本目录不再另建校验器** —— 机器面改由 **duckle 管线**承担
> （`node.data.schema` + `qa.contract` + `drift`），**理由与分工见 §10**。
> 上面这份「校验器落地时的判据」保留作**历史设计意图记录**；将来若仍要建，
> 先读 §10 说明为什么不在引擎里做、以及它解决不了的 §4.2 六条。

## 5 本目录里「目前没人守」的约定（诚实清单）

| 约定 | 谁在守 |
|---|---|
| 元 schema 的字段级约束 | ⚠️ **只有你手动跑** §4.3 那条命令。CI 不跑 |
| §4.2 的六条跨字段规则 | ❌ **没人守**——连元 schema 都表达不了 |
| 「新源必须先有契约再落盘」的**顺序** | ❌ 流程约束，无机器判据 |
| `_` 前缀语义 | ❌ 只在自动发现场景才有意义，而自动发现尚不存在 |
| 契约里的类型 ↔ duckle `data.schema` 类型枚举的映射 | ⚠️ **未实测核对**，见 §7 |
| `contracts/**` 的 env 键 | ❌ 不在 B9 扫描面内（`docs/architecture.md` §2） |

## 6 类型枚举：`double` 为什么不在里面

`columns[].type` 是**闭集**，取 **DuckDB SQL 的类型名（小写）**——因为落盘是 DuckDB 写的 parquet、
下游 staging 的 cast 目标也是 DuckDB SQL 类型，**两边同一套词汇**才谈得上「按契约校验」。

**`double` 故意不在枚举里**，依据是既有实测坑（layered design §9 坑 #4）：
pg_duckdb 不接受 `DOUBLE` 作 cast 目标（报错 `type "double" is only a shell` ⇒ 用 `numeric` / `float`）。
把禁令写进枚举 = 让「照抄一个看起来正常的 cast」**在契约层就失败**，而不是等到物化时才炸。
这就是「契约是机器面」与「契约只是一份文档」的区别。

⚠️ 与 duckle 管线声明里的类型枚举（`string/int32/int64/float32/float64/bool/date/timestamp/time/decimal/json/binary/geometry`，
出处：经验库记录的真实报错信息）**不是同一套词汇**。**别把这里的名字直接抄进 duckle 的 `data.schema`。**
逐项映射见 §7 待核对清单。

## 7 第一个适用对象：抖音（**只出模板，实际契约随接入 PR**）

`docs/data-platform-handbook.md` §2 的现状行：

| 域 | 表 / 前缀 | 状态 |
|---|---|---|
| 抖音 | `douyin/sku_daily/<月>/all.parquet` | **待接入** |

**⇒ 已确定的只有三件事**：`domain = douyin`、`table = sku_daily`、分区粒度到**月**。

**✋ 还不能写进契约的**（**不许编**，等接入 PR 摸清源之后填）：

- 分区键的**列名**（handbook 只写了 `<月>`，**没有键名** —— 别照抄模板里的 `biz_month`）
- 全部列名与类型（这正是 layered design §4 步骤 1 的产物）
- `owner`
- 批次标记的列名与取值口径（用采集时刻？源快照 id？）

**接入时的动作**：复制 `common/_template.contract.json` → `common/douyin.sku_daily.json`，
逐字段替换，走 PR，**与 duckle 管线、dbt staging 三件套同一个 PR**。

## 8 与其它两件套的关系

一个新源 = **契约 + 管线 + dbt staging** 三个文件**同一个 PR**（`docs/architecture.md` §5.1 第 2 条）：

| 件 | 在哪个目录 | 本契约的作用 |
|---|---|---|
| 契约 | `contracts/`（本目录） | 声明落盘定型目标——**先有它**；定位见 §10 |
| 管线 | `duckle/` | 落盘前**由管线自己**按声明校验（`node.data.schema` + `qa.contract` + `drift`）——见 §10；**本目录不再另建校验器**（§4.3） |
| staging | `dbt/` | 一对一取列并用 `r['列名']::type` 定型（`DOUBLE` 被禁，见 §6） |

## 9 未验 / 待核对清单

1. **校验器不存在** —— §4.3；本任务是格式先行的第一步。
2. **契约类型 ↔ duckle `data.schema` 类型枚举的逐项映射** —— 未实测核对（要真跑 duckle 才能核）。
3. **`all.parquet` 之外的多文件形态** —— 无案例（§3.2）。
4. **抖音契约本身** —— 随接入 PR（§7）。
5. **`layout.fileName` 的 `all.parquet` 与 duckle 的 `snk.minio` 输出是否天然一致** —— 未验；
   若 duckle 按 `key` 直接写对象，文件名与分区目录的拼法由管线决定，须在接入 PR 里对着引擎核。

## 10 本目录的定位：**人写的意图源**（机器面在 duckle，2026-09-23 订正）

**一句话**：本目录讲的是「**这张表该长什么样、归谁、怎么分区**」——**是给人读、给评审看的意图源**；
**「落盘即定型」的机器执行点不在本目录**，而在 **duckle 管线自己**的声明与门禁上
（`node.data.schema` + `qa.contract` + `drift`）。

**为什么改**：duckle 引擎**原生**就能做这三件事（spike 实测结论，见 `duckle/README.md` §7.1）——
列漂移门禁（`drift` 抓 missing/added/typeChanged，exit 1）、落地契约校验、管线级血缘。
既有的元 schema（`common/_schema.schema.json`）**只能管单文档内部约束**，§4.2 那六条跨字段规则
**连它自己都表达不了** ⇒ 再在本目录另建一套校验器 = **与引擎重复造一份，且必然漂移**。

**分工（不是二选一）**：

| | 本目录（`contracts/`） | duckle（管线内） |
|---|---|---|
| 是什么 | **人写的意图源**：表身份 / 列与类型 / 分区 / 批次 / owner | **机器面**：`node.data.schema` + `qa.contract` + `drift` |
| 谁读 | 人、评审、接入 PR | 引擎（落盘时执行） |
| 作用 | 接入的**起点与依据**——先想清楚再写管线 | 「落盘即定型」的**执行点**（类型不符即失败，不静默降 VARCHAR） |

**⚠️ 因此，本目录的既有内容（元 schema / 模板 / §4.2 / §5 的诚实清单）一律不变**——
它们仍描述**契约文档本身**的规格。变的只是**「谁来执行校验」**这一条：

- 原先的设计意图是「落盘前按契约校验」需要一个**独立的校验器**（§4.3，**从未存在**）；
- 现在这条**改由管线承担**：契约里声明的东西，要在 `duckle` 的 `data.schema` / `qa.contract` 里落成
  引擎认得的形态，由引擎在跑管线时执行。
- ⇒ **两条待办随之改口**：① §5 里「§4.2 六条跨字段规则没人守」**仍然成立**（引擎不认这份元 schema）；
  ② 接入新源时**两边都要写**，且**必须一致**——不一致就是「人写的意图」与「引擎执行的面」分叉，
  **须在接入 PR 里逐项核对**（这正是 §9 第 2/5 条那两项未验的落点）。

**三条坑按纪律对待**（出处 `duckle/README.md` §7.3，**别在接入时重踩**）：
① `drift` 在**源未声明 schema** 时**静默 exit 0（假绿）** ⇒ 门禁必须先断言「声明存在」；
② `qa.freshness` 对 **UTC 列按本地墙钟**算（实测偏 **+8h**）⇒ 用它必须强制时区对齐（RFC3339 UTC）；
③ `pipelineHash` 是**代码指纹不是数据指纹** ⇒ 不能判「输入数据变没变」。
