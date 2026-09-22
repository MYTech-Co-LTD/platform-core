# dbt 项目（数据栈 ③ staging + ④ marts + ⑤ 语义声明）

> 发布状态：**完整可解析的 dbt 项目 + 模式 + 两三列实证样例 + 显式 gate**。
> **不是**「列全集已定稿」——staging 的逐列清单**是 gate 到 T6 的**（乐檬同域不同日 46 vs 43 列漂移，
> 坑 #2 ⇒ 列清单照猜写必然错）。哪些是实证、哪些是暂定，见下面「实证 vs 暂定」一节，**逐项点名**。
>
> 分层纪律与五坑的正典：`docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（§3 分工 / §7 硬约束 / §9 五坑）。
> 选型与治理：`docs/superpowers/specs/2026-09-20-data-stack-module-design.md`（§9.4 可见性 / §10 四机制 / §11.5 运行期约束）。

## 1 目录与文件

```
dbt/
├── dbt_project.yml            项目骨架 + vars（非敏感值在内；AK/SK **刻意不做 var**，见 §4）
├── profiles.example.yml       连接模板（**不含真值**）+ ZOS 五键的键名登记
├── semantics/l1_metrics.yml   **L1 语义声明 = 唯一事实源**（落点理由见 §5）
├── models/common/staging/     ③ 清洗：一对一、只规范化不改义
│   ├── sources.yml            落地声明（**不是读路径**，见 §2）
│   └── stg_lemeng_retail_detail.sql
├── models/common/marts/       ④ 建模：口径只在这里定义一次
│   ├── schema.yml             列描述 + dbt tests
│   └── fct_retail_sale.sql
├── models/customers/          按客户扩展（约定见该目录 README）
└── tests/                     对账（audit_*.sql）+ 结构断言（assert_*.sql）
```

静态门禁：`scripts/check-data-models.mjs`（七项检查，CI 的 `gates` job 跑）。**它是本目录唯一的机检**。

## 2 两条最容易踩错的口径（先读这个再改模型）

### 2.1 `source()` 不是读路径

本仓用 **pg_duckdb**（Postgres 扩展）读对象存储：读路径是 `read_parquet('s3://…')`。
而 dbt 通过 **dbt-postgres** 适配器连它 ⇒ `{{ source('lemeng','retail_detail') }}` 会被渲染成
`"db"."schema"."table"` 这种 **PG 关系名**，湖上没有那个关系，渲染出来必然查不到。
（能直接读 parquet 的 `external_location` 是 **dbt-duckdb** 适配器的能力，本仓不用它。）

⇒ `models/common/staging/sources.yml` 的 `source` 声明是**声明与血缘的落点**，消费者是
① 静态门禁（④ staging 一对一的另一半）② 人（「这个域有哪些源」的事实源）。**不是** dbt 的运行时接口。
⇒ 由此推出一条硬命名约束：**staging 模型名 = `stg_<source.name>_<table.name>`**（如
`stg_lemeng_retail_detail`），因为「一对一」是**双向**机检的，只对一半就红。

### 2.2 物化落点必须在 PG 可见面上（gate 2）

`read_parquet()` 的**裸扫描结果与 `duckdb.query()` 的结果都不是 PG 关系、不进 `pg_class`**
（spec §9.4，本机实测）⇒ **Metabase 看不见**，任何按 `information_schema` 走的东西都看不见。
⇒ 每个模型都必须物化成 **PG 可见关系**：表 / 视图 / `USING duckdb` 外表。
本项目的缺省是 `+materialized: table`（两个模型里再各写一次 `config(materialized='table')`，
防止「改项目缺省」静默改变语义）。
⚠️ **`USING duckdb` 外表这一形态未实测**（本机没有 pg_duckdb）——三种形态里我们只钉了「不是裸扫描」，
具体用哪种（table / view / 外表）由 T6 按实测选，选完回填本节。

## 3 cast 规范（③ staging 的手写定型）

| 规范 | 为什么 | 机检 |
|---|---|---|
| 读 parquet 一律 `with r as (select * from read_parquet(…))` + **`r['列名']::type`** | 坑 #5：`SELECT *` 能过、**点名取列报 `column does not exist`**，而 `SELECT *` 的成功会掩盖它 | 规则 ①（`staging/stg_*.sql` 必须含 `r['` 取列模式，**注释位不算**） |
| 金额用 `numeric`，浮点用 `float`/`real` | 坑 #4：`DOUBLE` 不是 pg_duckdb 可用的 cast 目标（`type "double" is only a shell`） | 规则 ②（禁 `::double`；**放行** PG 原生的 `::double precision`） |
| 时间列**各自 try、各自成列** | 坑 #3：同表两列两种格式（`order_time` = `%Y-%m-%d %H:%M:%S`、`order_detail_bizday` = `%Y%m%d`） | 无（形态靠评审；`not_null` 在 marts 兜漏解析） |
| 不做聚合、不做 join、不改口径 | layered §3：③ 的职责只有「规范化」 | 无（纪律靠评审） |

**与计划范文块的一处有意偏离**（已在 `stg_lemeng_retail_detail.sql` 头注标明）：范文把两个时间列
`coalesce` 成一个 `order_time`。它们是**两列两种语义**（交易时间 vs 业务日），coalesce 会把两种语义
压成一个字段并静默丢掉一半信息 ⇒ 本实现各自定型、各自成列。

## 4 S3 凭据注入的核对结论（gate 1）

**已证的实测事实（来自 spec / WeKnora《duckdb-ossie 全链路 PoC》《语义层 × Metabase 选型》）**：

1. **DuckDB 实例按连接存在**，`SET`（GUC）与「用它」必须在**同一会话**；跨会话会报极具误导性的错
   （spec §11.5 #1）。
2. pg_duckdb 有**自己的建密钥函数**：`duckdb.create_simple_secret(...)` 支持**自定义 endpoint**
   与 **`url_style = path`**，参数**全是 text**（连 `use_ssl` 也是）——ZOS 的 path-style 要求它正好合得上。
3. ZOS 侧口径：`ENDPOINT` **不带 `https://`**（带了会拼出畸形前缀）、寻址必须 path-style、SSL 开。

**由此得到的结论（推理，非本机实测——本机没有 pg_duckdb）**：

- 注入点必须是**模型级**的（per-model pre-hook / materialization 前置语句），**不能用 `on-run-start`**：
  `on-run-start` 只在一条连接上跑一次，而 dbt 是连接池 + 多线程，模型很可能跑在**别的**连接上 ——
  那条连接上没有这个 secret。这是「实例按连接」这条实测事实的**直接推论**。
- AK/SK **不做 dbt var**（vars 会落进 `target/manifest.json`、编译产物与 `dbt run` 日志）：
  只在建 secret 的那一句里用 `env_var()` 现取。`profiles.example.yml` 只登记键名，不存值。
- 候选形态按优先级：① 模型 pre-hook 里调 pg_duckdb 的建密钥函数（与事实 2 最贴合）；
  ② `read_parquet` 的连接串/形参（若 pg_duckdb 支持透传）；③ credential_chain（需要另一套凭证链，不选）。
- **本文件不预接任何一条**：未实测的接线 = 假绿。T6 的核对动作：在一个真 pg_duckdb 会话里跑通
  「建 secret → `read_parquet` 读 ZOS」两步，再把形态回填到本文件 + `profiles.example.yml`。

## 5 L1 语义声明的落点与形状（T9 的接口）

**落点**：`dbt/semantics/l1_metrics.yml`。**为什么不在 `marts/schema.yml`**（计划原文指的是那里）：
指标 `name` 是命名空间形态 `<域>:<指标名>`（含**冒号**），而 **dbt 资源名不允许冒号** ⇒ 把带冒号的
`name` 放进 dbt 会扫的 schema 文件里，有让 `dbt parse` 挂掉的风险，而「`dbt parse` 可过」是本任务的
验收面之一。故声明放在 **dbt 扫描面之外**的 `semantics/`，指标名保持 `:` 形态不变。
**静态门禁两处都扫**（`dbt/semantics/**` 与 `dbt/models/**`），所以即便将来有人把声明挪进
`schema.yml`，也不会漏检。
**T6 的核对步**：真机 `dbt parse` 若证实 dbt 接受带冒号的指标名（`metrics:` 块），可把本文件并入
`marts/schema.yml`；核不过就维持现状（本文件的形状不依赖 dbt）。

**字段**：`name` / `label` / `definition` / `expression` / `grain` / `owner` / `tier`（必填六项：
除 `label`、`sources` 外全必填；`sources` 选填人读）。取舍与「为什么」在文件头注里。

**T9 消费的那条规则（唯一事实源）**：指标名 → 对账文件名，由
`scripts/check-data-models.mjs` **导出的函数**给出，**文档不复述规则**：

```js
metricToAuditFileName(metricName: string): string   // 例：'retail:net_sales' → 'audit_retail__net_sales.sql'
```

语义三条：入参 = 声明的 `name` 原值；**每一个** `:` 替换成 `__`（其余下划线不动）；返回值是
**文件名**（落点 `dbt/tests/`）。**T9 必须 import 这个函数，不许照文档再实现一份**（计划 L645 的原话：
两个 worker 不得各造一套）。门禁的规则 ⑦ 另外保证**映射无碰撞**（两个不同的指标名映到同一文件时报警）。

## 6 漂移策略（列集 46 vs 43，坑 #2）

**禁 `union_by_name` 兜**（规则 ③ 静态拦）：它会让引擎替我们**猜**列集，悄悄补一堆 NULL，然后算出
一个没人能解释的口径 —— 比响亮失败危险得多。

显式处理的三条：

1. **当前形态**：`/**/*.parquet` 一次读全窗，**只在窗口内列集一致时成立**；混进不同列集的日子时
   DuckDB 的 binder 会**响亮报错**（这是要的行为）。
2. **目标形态（待 T6 钉死）**：按列集**分组**读 —— 每个列集一组路径列表、各自 `read_parquet`，
   再 `union all`，**缺失列显式补 `NULL::<type>`**，分组清单写死在模型里（分组一变就要走 PR，被看见）。
3. **`read_parquet` 的分组形参形态未实测**（是否透传 `columns=` 一类参数在 pg_duckdb 下未知）⇒
   **不预写**，T6 实测后回填。在此之前，「列集一致窗口」是唯一已验证的读法。

## 7 对账三档（硬要求 7：cast 错了静默，只有断言能抓）

| 档 | 抓什么 | 形态 | 现状 |
|---|---|---|---|
| **① 复算 marts vs staging** | ④ 的 join / 过滤 / 粒度漂移 | singular test | **未做**（本轮只做第二档，见下） |
| **② 复算 parquet vs marts** | ③ 的 cast 错（截断/取整/精度丢），以及 marts 的全部口径错 | `dbt/tests/audit_*.sql`（每个声明指标一条） | **已交付**（两条） |
| **③ 人工抽样比对** | parquet 本身的错（源系统写错、落盘错） | 人 | 未做（T6 首跑时按样本抽） |

**为什么交付的是第二档**：它绕开 staging 与 marts，**直接打 parquet**，是唯一能发现「staging 把
VARCHAR 手写 cast 成 numeric 时悄悄丢精度/截断」的形态（dbt 的列级 tests 一条都不会红）。
对账文件里**刻意重复**一次读路径与 cast —— 重复是方法不是冗余：复算若走 staging，staging 的 cast 错
会同时污染两边 ⇒ 对账恒等、永远绿（「对账看着有、其实没用」的典型形态）。
**已知边界**：这条对账能保证「两边算的是同一件事」，**保证不了**「列的含义就是业务意义上的那个」——
那要第三档（人工抽样）与 T6 的样本核对。

## 8 实证 vs 暂定（**别把暂定当已定**）

| 项 | 状态 | 依据 / 待办 |
|---|---|---|
| 金额列值形态是字符串（`"12.79"`）⇒ `::numeric` | **实证** | 坑 #1/#4（layered §9，2026-09-21 压测） |
| 两个时间列两种格式 + 各自格式串 | **实证** | 坑 #3（同上） |
| 同域不同日列数不等（46 vs 43） | **实证** | 坑 #2（同上） |
| `read_parquet` 读得通对象存储 + 自定义 endpoint / path-style 的建密钥函数支持 | **实证** | spec §9.4 / WeKnora 两条条目 |
| 账套在**路径**里（`lemeng/retail_detail/<账套>/…`） | **实证** | handbook §2 + §4 欠账 |
| **列全集**（staging 的完整列清单） | **暂定 → T6 钉死** | 列清单照猜写必然错；T6 按 ZOS 样本回填 |
| **`order_no`**（订单数指标的唯一依赖列） | **暂定 → T6 核对** | 列名与去重语义都要按样本核；核不到就**删掉该指标声明**，不换近似口径 |
| **账套取值方式**（当前 dbt var 供值，而非路径解析） | **暂定 → T6 定形态** | 目标形态 = 路径解析进列（C3 身份跟着数据走），需实测 `filename` + 正则的可用形态 |
| **跨列集分组的读法**（§6 的目标形态） | **暂定 → T6 实测** | 分组形参是否透传未知 |
| **S3 凭据注入形态**（§4 的候选 ①②） | **暂定 → T6 实测** | 只能在真 pg_duckdb 上验 |
| **物化落点形态**（table / view / `USING duckdb` 外表） | **部分实证** | 「必须是 PG 可见关系」实证；「用哪一种」待 T6 选 |
| **「有效订单」的判定条件**（退货/赠品/作废是否剔除） | **暂定 → 业务确认** | 当前实现 = 全部明细行合计，与该缺口同址的注记在 `fct_retail_sale.sql` 与 `l1_metrics.yml` |
| `try_strptime` / `::timestamptz` / `::date` 在 pg_duckdb 会话内可用 | **未验** | 本机无 pg_duckdb/dbt ⇒ T6 真机首跑核对 |

## 9 未验清单（诚实边界，一条都不含糊）

1. **`dbt parse` 未跑**：本机没有 dbt。**不要 `pip install` 去凑一个绿**（那证明不了项目可解析）。
   已验证的是**结构可解析**：本目录的 YAML 全部经仓库既有的 `yaml` 依赖解析通过
   （`scripts/check-data-models.mjs` 跑真仓 = `check-data-models: OK`），
   而 **dbt 语义可解析**（模型/测试/指标的资源解析、`ref()` 存在性、`config()` 合法性）
   **明确未验，需 T6 或装了 dbt 的环境补**（计划 L661 本来就写着「有 dbt 的机器上验证」）。
2. **所有 SQL 未在真 pg_duckdb 上跑过**（本机没有）：`r['列名']` 取列、`try_strptime`、cast 目标、
   物化落点，四处形态都待 T6（见 §8 最后同两行）。
3. **对账/断言测试从未在真数据上跑过**（`dbt test` 需要库 + 数据）。
4. **`dbt/` 的 env 键没有任何静态门禁**：B9（`check-env-example.mjs`）的扫描根只有
   `apps/ packages/ modules/`，**不扫 `dbt/`**（T2 评审实测确认）。`.env.example` 里那段 dbt 键是
   **键面事实源的文档化**，不是被门禁守住的约定。
5. **本目录不碰 `.gitignore`**（T5 是唯一写入方）：`dbt/target/`、`dbt/logs/`、`dbt/dbt_packages/`
   是 `dbt parse/run` 的本地生成物，**不 `git add`、不提交**；静态门禁自己也跳过这三个目录。
   若需要忽略规则，见 T4 任务报告的「需要协调方转给 T5」段。
