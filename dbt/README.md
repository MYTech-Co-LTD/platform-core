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
├── macros/                    `generate_schema_name.sql`（多租户 schema 派生，见 §10）
├── models/common/staging/     ③ 清洗：一对一、只规范化不改义
│   ├── sources.yml            落地声明（**不是读路径**，见 §2）
│   ├── schema.yml             列描述 + dbt tests
│   ├── stg_lemeng_retail_order_line.sql   **新湖（现行）**：S1 换源后的零售 staging
│   ├── stg_lemeng_branch.sql             门店维（**全量快照**，S2-a 新增）——列全集见 §8/§9
│   ├── stg_lemeng_item.sql               商品维（**全量快照**，S2-a 新增）——列全集见 §8/§9
│   └── stg_lemeng_retail_detail.sql       旧湖（**双轨期保留，待 S4 删**）——取列形态在本栈报错，
│                                          故裸 `dbt run` 会因它红（见 §3 第 1 行、§9 第 6 条）
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
`stg_lemeng_retail_order_line`），因为「一对一」是**双向**机检的，只对一半就红。

### 2.2 物化落点必须在 PG 可见面上（gate 2）

`read_parquet()` 的**裸扫描结果与 `duckdb.query()` 的结果都不是 PG 关系、不进 `pg_class`**
（spec §9.4，本机实测）⇒ **Metabase 看不见**，任何按 `information_schema` 走的东西都看不见。
⇒ 每个模型都必须物化成 **PG 可见关系**：表 / 视图 / `USING duckdb` 外表。
本项目的缺省是 `+materialized: table`（两个模型里再各写一次 `config(materialized='table')`，
防止「改项目缺省」静默改变语义）。
⚠️ **`USING duckdb` 外表这一形态未实测**（本机没有 pg_duckdb）——三种形态里我们只钉了「不是裸扫描」，
**具体用哪种已定：`table`**（2026-09-24 数据面真机 `dbt run` PASS=2，两个模型均落成 PG 表、
`information_schema` 查得到；T6 已选定，本节回填完毕）。`view` 形态同样满足 gate 2 但未采用。

## 3 cast 规范（③ staging 的手写定型）

| 规范 | 为什么 | 机检 |
|---|---|---|
| 读 parquet 一律 **`from read_parquet(…) r`（别名挂在函数调用上）** + **`r['列名']::type`** | 坑 #5：`SELECT *` 能过、**点名取列报 `column does not exist`**，而 `SELECT *` 的成功会掩盖它。⚠️ **CTE 形态（`with r as (select * from read_parquet(…))`）在本栈上取列即报错**——2026-09-24 数据面真机实测原文：`ERROR:  cannot subscript type record because it does not support subscripting`；pg_duckdb 要求 `r` 是 **read_parquet 调用的别名**，不是 PG 子查询/CTE（原文 + pg_duckdb 的提示语 + 推理见 `stg_lemeng_retail_order_line.sql` 头注「【二】取列形态」）。**规则 ① 只查 `r['` 这个构造 ⇒ 上面两种形态都过门** ⇒ 照 CTE 写会「门禁绿、真机跑不动」（S2 的七个 staging 会一起中标）。⚠️ 门禁规则 ① 的**报错提示文案**里给的例子恰好也是 CTE 形态（`scripts/check-data-models.mjs`）——**别照那句抄**；文案订正不在本轮范围 | 规则 ①（`staging/stg_*.sql` 必须含 `r['` 取列模式，**注释位不算**） |
| 金额用 `numeric`，浮点用 `float`/`real` | 坑 #4：`DOUBLE` 不是 pg_duckdb 可用的 cast 目标（`type "double" is only a shell`） | 规则 ②（禁 `::double` **与** `CAST(... AS double)`（同一坑 #4、同一类型名查找路径）；**放行** PG 原生的 `double precision`） |
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
| **列全集** | **分裂三档**（2026-09-25 订正） | **新湖零售** `stg_lemeng_retail_order_line` = 契约 18 列、**实证**（2026-09-24 真机 `dbt run` 落 19,678 行）；**两张维度 staging** = `stg_lemeng_branch` 16 列 / `stg_lemeng_item` 108 列，**契约钉死 + 静态门禁绿，未在真库跑过**（见 §9 第 7 条）；**旧湖** `stg_lemeng_retail_detail` 的列全集仍**暂定**（该文件从未跑过、待 S4 删） |
| **`order_no`**（订单数指标的唯一依赖列） | **列存在已证 / 语义未证** | **已证** = 新湖契约列**存在且非空**（`nullable=false` + 管线 `qa.contract` 非空闸 + 真机 `not_null_…_order_no` 过，列名与类型合契约）；**未证** = 「该列**就是业务意义上的单号**」与 `count(distinct order_no)` 的**去重语义**（两者都属**口径转正**，S5）。⚠️ 别把「列存在且非空」读成「口径已确认」；核不到就**删掉该指标声明**，不换近似口径 |
| **账套取值方式** | **新湖实证 / 旧湖暂定** | 新湖 = **路径解析进列**（hive 分区键 `system_book=<账套>/` 被 read_parquet 推断成列，真机 `::varchar` 定型通过）；`account_book` var 只用于**拼读路径**、不灌数据。旧湖（双轨期）仍只能 var 供值 |
| **跨列集分组的读法**（§6 的目标形态） | **暂定 → T6 实测** | 分组形参是否透传未知 |
| **S3 凭据注入形态**（§4 的候选 ①②） | **暂定 → T6 实测** | 只能在真 pg_duckdb 上验；⚠️ 真机 `dbt run` 能读 S3 靠的是「会话里已有的 secret」（非本次接线），**pg_duckdb 一重启即失效** |
| **物化落点形态**（table / view / `USING duckdb` 外表） | **已定：`table`** | 「必须是 PG 可见关系」实证；「用哪一种」T6 已选定 `table`（真机 PASS=2，两个模型都落成 PG 表）；`USING duckdb` 外表仍未实测 |
| **「有效订单」的判定条件**（退货/赠品/作废是否剔除） | **暂定 → 业务确认** | 当前实现 = 全部明细行合计，与该缺口同址的注记在 `fct_retail_sale.sql` 与 `l1_metrics.yml` |
| `try_strptime` / `::timestamptz` / `::date` 在 pg_duckdb 会话内可用 | **部分实证** | 新湖链实证的是 `::varchar` / `::int` / `::date`（真机 PASS=2）；`try_strptime` 与 `::timestamptz` 只出现在**旧湖**模型里，**仍未验**（该文件从未跑过 ⇒ 裸 `dbt run` 会红，见 §9 第 6 条） |

## 9 未验清单（诚实边界，一条都不含糊）

> ⚠️ **订正（2026-09-25）**：第 1–3 条写于「本机无 dbt / pg_duckdb」时期；**2026-09-24 数据面真机首跑**
> 已把**新湖链**（`stg_lemeng_retail_order_line` + `fct_retail_sale` + 两个 audit + 两条结构断言）实跑过。
> 下面逐条**收窄**到仍未验的面上（别把「本条未验」读成「整个 dbt 都没跑过」）。

1. **`dbt parse` 在真机上已实证**（2026-09-24 数据面 dbt 1.9.1：`Found 3 models, 14 data tests,
   2 sources, 435 macros`，`dbt run` / `dbt test` 全绿）⇒ 资源解析、`ref()` 存在性、`config()` 合法性
   **已验证**。**本机仍没有 dbt**——保留原来的纪律：**不要 `pip install` 去凑一个绿**（那证明不了
   项目可解析；本仓 `scripts/check-data-models.mjs` 跑真仓 = `check-data-models: OK` 给的是**结构可解析**）。
2. **新湖链的 SQL 形态已实证**：`r['列名']` 取列（**函数别名形态**，见 §3 第 1 行）、`::varchar` / `::int` /
   `::date` 三个 cast 目标、物化落点 `table`，四处均经真机 `dbt run` PASS=2 验证。
   **仍未验的是旧湖** `stg_lemeng_retail_detail.sql` 的 CTE 取列 + `try_strptime` + `::timestamptz`
   形态（该文件从未跑过，见 §8 最后一行）。
3. **对账/断言测试已在真数据上跑过**：真机 `dbt test` **PASS=14 WARN=0 ERROR=0**（含两条 `audit_*.sql`
   的独立复算与 `assert_*` 结构断言）。⚠️ 「对账绿」只说明**两侧算的是同一件事**，**不是**「口径已确认」
   （见 `audit_retail__order_count.sql` 头注）。
4. **`dbt/` 的 env 键没有任何静态门禁**：B9（`check-env-example.mjs`）的扫描根只有
   `apps/ packages/ modules/`，**不扫 `dbt/`**（T2 评审实测确认）。`.env.example` 里那段 dbt 键是
   **键面事实源的文档化**，不是被门禁守住的约定。
5. **本目录不碰 `.gitignore`**（T5 是唯一写入方）：`dbt/target/`、`dbt/logs/`、`dbt/dbt_packages/`
   是 `dbt parse/run` 的本地生成物，**不 `git add`、不提交**；静态门禁自己也跳过这三个目录。
   若需要忽略规则，见 T4 任务报告的「需要协调方转给 T5」段。
6. **双轨期「裸 `dbt run`（不带 `--select`）会红」**（S1 Task 9 结论；**推断**，未直接试跑——已知为红、
   不想在生产库留失败痕迹）：旧湖 `stg_lemeng_retail_detail.sql` 仍在项目里且会被裸 `dbt run` 选中，
   它的取列形态正是本栈拒绝的 **CTE 形态**（§3 第 1 行；真机原文 `cannot subscript type record …`）
   ⇒ 一取列就报错。**验证过的形态是带 `--select`**：真机
   `dbt run --select stg_lemeng_retail_order_line fct_retail_sale` = `PASS=2`，`dbt test`（全量 14 条）
   = `PASS=14`（2026-09-24 数据面，证据见 `.superpowers/…/task-9-report.md` §5）。
   ⇒ **跑 dbt 一律带 `--select`**，别把「静态门禁绿」读成「裸 `dbt run` 绿」；S4 删掉旧湖文件后这条消失
   （**S4 可考虑直接删**）。
7. **两张维度 staging 与两条维度唯一性断言从未执行过**：`stg_lemeng_branch` / `stg_lemeng_item` 与
   `dbt/tests/assert_stg_lemeng_branch_key_unique.sql` / `assert_stg_lemeng_item_key_unique.sql`
   都是 S2-a 新加的，**没在真库上跑过**（本机无 dbt / pg_duckdb），当前只有「契约钉死 + 静态门禁绿」
   这一档证据（§8「列全集」行）。真机验收归 **S2-a Task 5b**（投递 + 注册 job + 真机回读那段）——
   在那之前，别把静态门禁绿读成「维度面跑过了」（这条正是本节存在的意义）。

## 10 多租户跑法（P3 / T11：每租户一个 schema）

**一句话**：多租户不是「跑一份多租户模型」，是**同一份模型跑 N 次、每次换一个租户 schema**。

```bash
# openship job 逐租户循环（零新常驻组件 —— 拍板 #4：调度 = openship jobs）
for KEY in <租户键 1> <租户键 2>; do
  dbt run --select <…> --vars "{tenant: $KEY}"
done
```

**租户键 = `platform.tenant.casdoor_org`**（不是 slug）。理由：身份面一致 —— 模块里的
`identity.orgId`、marts 行里的 `org` 列、数据面 schema 三者同源，换成 slug 会让「谁能看到哪份数据」
在三个地方各说各话。取法：平台库 `select casdoor_org from platform.tenant`（**不写进任何文档/日志的值面**）。

**schema 名的派生只有一处实现**：`macros/generate_schema_name.sql`（`tenant_` + 键折小写 +
连字符改下划线，如 `acme-org` → `tenant_acme_org`）。**同一份模型、不同 `--vars` ⇒ 落进不同 schema**；
会话绑哪个 schema 就只能看到哪个租户的物化结果（spec §11.5 #3 的 per-schema + `search_path`）。

⚠️ **这条派生不是单射**（修复笔 I1 点出）：`acme-org` 与 `Acme-Org` **都**归一到 `tenant_acme_org`
⇒ 两个不同租户落进**同一个** schema（数据面串租户）。而 **macro 这一侧结构性看不见**：
`dbt run --vars` 一次只喂一个租户键，撞名要同时看到**全部**平台键才判得出来。⇒ 判它的地方是
`scripts/reconcile-data-tenants.mjs` 的 **`collisions`** 桶（**撞名 ⇒ 逐条报出 + `exit 1`，
绝不报 clean**）。改派生规则时**两处必须同步**（`dbt/macros/**` 与那个脚本，同源纪律见该脚本头注）。

**不给 `tenant` var ⇒ 逐字回到 dbt 内置行为**（`target.schema`，即 P1 私有化单租户那份配置）——
私有化部署**不需要**任何改动，也不该被多租户这条路径影响。

**配套的三件（不在这份 dbt 里，但缺了它这条跑法是空的）**：

| 件 | 落在哪 | 谁建 |
|---|---|---|
| 每租户 PG role + schema + 授权 | `deploy/data-tenants/provision-template.sql` | openship job（逐租户跑一次，幂等；**整份模板单事务 ⇒ 失败无残留**） |
| 每租户 S3 凭据（`SCOPE` 收窄到该租户桶前缀） | 同上（§3，**未实测形态**） | 同上 |
| 平台启用集 ↔ 数据面已建的对账 | `scripts/reconcile-data-tenants.mjs`（**双向差集，openship 定时 job 打**） | job |

**为什么这一节不改 §8/§9 的「未验」清单**：本节的每一条**都还没在真库上跑过**（本机没有
dbt / pg_duckdb）；「不给 var 时回内置行为」依赖 dbt-core 的 `generate_schema_name_for_env`
（见 macro 头注判断③）——同样是**真机首跑核对**项，归 T6/T13。**多租户的 schema 名派生**则有
机检兜底：`scripts/check-data-models.test.ts` 的 T11 格①（macro 必须由 `var('tenant')` 派生、
不许出现整名形态的字面量 schema）与格②（平台侧对账用同一张用例表），外加 T11 修复笔段
（**撞名组必须非 clean**、空键分歧被记录、模板单事务、`dbt_project.yml` 显式 `macro-paths`）。

## 11 血缘与排查（T9 / 治理四机制收口）

> **本节的定位**：`spec §10` 的四机制在 dbt 侧「原生全有」（`schema.yml` / `dbt docs` / `dbt test` /
> 状态选择）——本节把它们落成**可执行的 runbook**。与 §10 一样，本节**不改 §8/§9 的「未验」清单**：
> 下面每条命令都**还没在本仓的环境里跑过**（本机没有 dbt / pg_duckdb），属**真机首跑核对**项。

### 11.1 四机制 ↔ 落点（一张表看全）

| 机制（spec §10） | 仓内落点 | 谁守着它 |
|---|---|---|
| ① 记录 | `dbt/semantics/l1_metrics.yml` 的必填六项（`name`/`definition`/`expression`/`grain`/`owner`/`tier`） | 门禁规则 ⑤（静态必填）；`sync-data-semantics.mjs` 物化进 `data.metrics` |
| ② 血缘 | `dbt docs generate` 产物（见 §11.2） | 本节 runbook；**无静态门禁**（产物要 dbt 环境） |
| ③ 测试 | `dbt/tests/audit_<指标>.sql`（singular test，**独立复算**） | 门禁规则 ⑦（存在性 + 文件名映射无碰撞，事实源 = `metricToAuditFileName()`） |
| ④ 状态选择 | `dbt run --select …` 的按需物化 + `sync-data-semantics.mjs --check` 对账 | 本节 §11.4（job）；`--check` 的**契约**由门禁规则 ⑨ 守着 |

**T9 新增的两条机检**（`scripts/check-data-models.mjs`，改这两个面时先读规则头注）：
- **规则 ⑧ — L2 声明静态面**：`modules/data/domain/semantic-compiler.ts` 里**写时校验**（zod schema）
  与**唯一编译点**必须同源（`op.kind` / 过滤算子的接受集逐字一致、字段面集合相等）。
  漂移形态是**假绿**：schema 放行的声明落库，直到某个租户查它时才炸。拍板 #5 要求门禁覆盖
  「用户/agent 产生的声明」——L2 的入参正是**租户数据**，这条断言只能落在模块源码上。
  ⚠️ **强度如实披露（T9 评审 I-1）：这条是「标记级文本比对」，不是行为断言。**「同源」在这里的
  含义只是**两侧的字面量 / 结构 / 正则一致**，**不等于**「编译器真的执行了那套话」。构造
  「**编译器行为变了、而比对标记没变**」的改动时它会**假绿**——评核实测两例：① 把守卫体掏空
  （`if (decl.op?.kind !== 'refine') { /* 空 */ }`）⇒ 编译器实际接受任意 `op.kind`；②
  `const filters = decl.filters ?? []` 改成 `const filters = []` ⇒ 租户的 `filters` 被**静默丢弃**、
  编译出的 `select_sql` 不再带切片。两例的标记面都**逐字未动** ⇒ 门禁读成「两处一致」而 exit 0。
  这个缺口**当前由** `modules/data/domain/semantic-compiler.test.ts`（CI `unit` job）兜住
  （两例在该测试里分别红 1 / 4 条）——所以不是「无防守」，是**这道门禁在这一层是盲的**。
  计划 L896 原本要的是**行为** fixtures（「**schema 拒的编译器也拒**」，纯函数对纯函数、不需要库）
  ⇒ 属**后续加固**，本轮**只披露、不改比对机制**。
- **规则 ⑨ — `--check` 契约**：把 dry-run 的四条性质（`--check` 存在 / **用法错响亮** / 漂移非 0 /
  无漂移 0）与**出口码三分法**接进机检面。为什么值得单列：T8 第一版的真实缺陷就是
  「未知 flag 被静默忽略 ⇒ 打了 `--check` **实际写库**、还 exit 0」。
  ⚠️ 规则 ⑨ **只断言契约、不连库**（真跑 `--check` 见 §11.4）。

### 11.2 血缘：产物怎么来（runbook）

**主路径 —— `dbt docs generate`**（dbt 原生血缘，来源是 `ref()`/`source()` 的静态解析）：

```bash
dbt docs generate --project-dir dbt          # 产物：dbt/target/{index.html,manifest.json,catalog.json}
```

- ⚠️ **不要写 `--profiles-dir dbt`**（本节原文的错误，T9 评审 I-3 订正）：`--profiles-dir` 找的是该目录下
  **名为 `profiles.yml`** 的文件，而 `dbt/` 里**只有 `profiles.example.yml`** —— 真值**刻意不进仓**
  （`dbt/dbt_project.yml` 的 profile 头注、`dbt/profiles.example.yml` 的「用法」两条都写明）。
  ⇒ 与 §10 一致，**不给 `--profiles-dir`**，靠 `~/.dbt/profiles.yml`
  （`cp dbt/profiles.example.yml ~/.dbt/profiles.yml` 后填值）；profile 若放在**仓外**的目录，
  再用 `--profiles-dir "$DBT_PROFILES_DIR"`（那是 `profiles.example.yml` 允许的另一种用法，
  **该目录在仓外**）。
  ⚠️ **待核**：dbt 在「给了 `--profiles-dir` 但目录内没有 `profiles.yml`」时是否回落到 `~/.dbt`，
  **依 dbt 版本而异**，本机无 dbt、**未实测** ⇒ 这里按**仓内正典**（不给 `--profiles-dir`）取。
- **产物是生成物**：`dbt/target/` 已在 §9 第 5 条的「不提交」清单里，**不 `git add`**。
- **谁来跑**：挂 **T6 的物化 job 附带**（每次物化后顺带 generate，代价小），**或**独立**低频** job
  （见 §11.4 的 cron 建议）。二选一即可，**别两处都跑**（同一条产物两个写入方只会互相覆盖）。
- `manifest.json` 是**机器可读**的那一份：要拿血缘做检查/告警时读它，不要解析 HTML。

**补充路径 —— Postgres 目录递归**（marts 是**视图**形态时的兜底）：

```bash
psql "$DATABASE_URL" -c "select distinct v.view_schema||'.'||v.view_name as view, v.table_schema||'.'||v.table_name as depends_on from information_schema.view_table_usage v where v.view_schema = '<目标 schema>' order by 1, 2"
```

- ⚠️ **必须带 `where v.view_schema = '<目标 schema>'`，且不要再 join `pg_class` 取 schema 名**
  （本节原文的缺陷，T9 评审 M-2 订正）：原写法把 `view_table_usage` 再 join 回 `pg_class`，
  而 join 条件**只有 `relname`**、没有 schema 限定 ⇒ 同名关系在多 schema 并存时**笛卡尔扇出**。
  本仓的多租户正是「同一份模型跑 N 次、每次一个 schema」（§10）⇒ 各租户 schema 里**模型名完全相同**，
  于是会把 A 租户的视图配到 B 租户的同名对象上，输出**看着有、其实错**的血缘。
  实测（PG 16.15，两个 schema 各放一对同名 `v_dep` / `t_src`）：**原查询对 `tenant_a.v_dep` 出 5 行**
  （正确 1 行），且**连 `information_schema` / `pg_catalog` 的系统视图也一并列出**
  （44 行输入 → 56 行输出）。`view_table_usage` 本身就带 `view_schema` / `table_schema` 两列
  ⇒ **直接用它们**即可，join 回 `pg_class` 是多余且有害的一步。`distinct` 是防同一对重复出行的兜底。
- **为什么留这一条**：dbt docs 的血缘是**声明面**推出来的（`ref()`），而 PG 目录里的依赖是
  **数据库自己记的**——两者一致才说明「声明与落库没分叉」。视图形态下这条几乎**零维护且不漂移**
  （spec §10 机制② 的原话）。
- ⚠️ **这条只对 `view` 形态有意义**：本仓 marts / staging **全部 `materialized='table'`**（§2.2；全仓零 view）
  ⇒ 加了 schema 限定后**该 schema 返回 0 行**（表没有依赖记录）。**那是静默空、不是报错**
  —— 读成「没有血缘」之前，先确认物化形态（§2.2 的 gate 2）。

### 11.3 排查五步阶梯（**每步一条命令，按顺序走，别跳**）

口径出问题的典型症状是「数不对」——**先定位到哪一层，再改**。五步的**顺序即收敛方向**：
从「我们**说要**算什么」逐步走到「源数据**这次真的**是什么」。

> ⚠️ **本阶梯的 ④⑤ 命令写的是「旧湖」形态**（路径 `lemeng/retail_detail/…`、列 `order_detail_bizday` /
> `amount`、`try_strptime`）。S1 换源（2026-09-24）后**现行**零售链路的形态是
> `s3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日>/hour=<时>/all.parquet`，
> 列取 `bizday` / `sale_money` / `order_no`（**湖里已定型，不再 `try_strptime`**）。
> ⇒ **照抄 ④⑤ 会停在旧湖读法上**；新湖的等价口径见 §2.1、`staging/sources.yml` 的 `retail_order_line`
> 段与 `stg_lemeng_retail_order_line.sql` 头注。（下面 I-5 那条「四处一致」写于**换源前**：换源后
> `l1_metrics.yml` 的 `sources` 与两个 `audit_*` 的读路径都已指向**新湖**，旧湖只剩
> `stg_lemeng_retail_detail.sql` 与 `dbt_project.yml` 的旧 var 头注。）

| # | 步 | 命令 |
|---|---|---|
| ① | **读声明**（口径的事实源） | `sed -n "/name: 'retail:net_sales'/,/^  - name:/p" dbt/semantics/l1_metrics.yml` |
| ② | **dbt docs 看依赖**（这一层读了谁） | `dbt docs generate --project-dir dbt && echo '开 dbt/target/index.html → 选模型 → Lineage'` |
| ③ | **看 PG 里实际的关系定义** | `psql "$DATABASE_URL" -c '\d+ <schema>.fct_retail_sale'` |
| ④ | **抽 parquet 源核对**（上游真值长什么样） | `psql "$DATABASE_URL" -c "select r['order_detail_bizday'], r['amount'] from read_parquet('s3://<桶>/lemeng/retail_detail/<账套>/<日期>/all.parquet') r limit 5"` |
| ⑤ | **独立复算**（不复用 dbt 任何产物） | `psql "$DATABASE_URL" -c "select '<账套>' as system_book, try_strptime(r['order_detail_bizday'], '%Y%m%d')::date as bizday, sum(r['amount']::numeric) as net_sales from read_parquet('s3://<桶>/lemeng/retail_detail/<账套>/<日期>/all.parquet') r group by 1, 2"` |

**每步的判读**：
- ① 与 ⑤ **按 grain 对齐后数不一致** ⇒ 先怀疑 **cast / 列名**（§3）或**列集漂移**（§6）——这正是
  `dbt/tests/audit_*.sql` 在真数据上抓的东西。
- ③ 的定义**与 ① 的表达式对不上** ⇒ 落库那一步没跟上声明（**重新物化**，别手改关系）。
- ④ 读不出/报错 ⇒ **先核对路径形态**（与 `dbt/models/common/staging/sources.yml` 的
  `meta.path_convention` 逐段对照），**再**查**凭据 / secret**（§4 与 §11.4）——**别把路径形态错误
  误判成凭据问题**（本节原判读表的归因顺序会把排查带偏，T9 评审 I-5 点出）。
- 走到 ⑤ 仍与 BI 里的数不同 ⇒ 问题在**消费层**（locked 参数 / 报表 SQL），不在数据面。

**阶梯命令的订正依据（T9 评审 I-4 / I-5 / M-3 / M-4；全部**离线可查**，不依赖真机）**：
（I-3 的 `--profiles-dir` 订正在 §11.2，同属本节这一批）

- **① 的锚点必须带引号**（M-3）：`l1_metrics.yml` 里写的是 `  - name: 'retail:net_sales'`（**带单引号**）。
  原文的不带引号模式**匹配不到任何行** ⇒ `sed` **静默输出空、exit 0**，排查者会据此判「声明压根不存在」。
  实测：不带引号 `0` 行；带引号 `18` 行。⚠️ 外层用**双引号**，别用单引号（`sed -n '…/name: 'x'…'` 会写坏）。
- **③ 不能用 `pg_get_viewdef`**（I-4）：本仓 marts / staging **全部 `materialized='table'`**
  （项目级 `+materialized: table` + 两个模型各自又显式 `config(materialized='table')` ⇒ **全仓零 view**），
  而 `pg_get_viewdef` 只对**视图 / 物化视图**有定义。**实测（PG 16.15）**：对**表**调用**不报错**，
  而是返回 **NULL**（静默空 —— 比报错更糟：容易被读成「这个关系没有定义」）；
  对视图/物化视图返回定义文本。**另一处**：`'dbt.fct_retail_sale'` 里的 schema `dbt`
  **任何配置都不产生**（`profiles.example.yml` 缺省 schema = `staging`；多租户 = `tenant_<租户键>`，
  见 §10；仓内 `dbt.fct_x` 只出现在**注释里的举例**）⇒ 实测报 `ERROR: schema "dbt" does not exist`。
  ⇒ 改读**关系定义本身**（`\d+` 列出列与类型，实测可用）；`<schema>` 按 `search_path` /
  `tenant_<租户键>` 取，**`dbt` 不是本仓的任何 schema**。等价写法：
  `select column_name, data_type from information_schema.columns where table_schema='<schema>' and table_name='fct_retail_sale' order by ordinal_position`。
- **④ 只用「已实证」的列**（M-4）：`sources.yml` 只登记**三列**（`amount` / `order_time` /
  `order_detail_bizday`）；原文抽的 `order_no` 在 L1 声明里**当时**明确标**「暂定」**（`retail:order_count`
  的 definition **当时的原文**：*「单号列的列名与去重语义待 T6 按实测样本核对（staging 里 `order_no` 是暂定列）」*
  ——该句已于 2026-09-25 随换源订正为「列面实证 / 口径面待业务确认」，见 `l1_metrics.yml`）
  ⇒ 拿未实证列去抽查源，报错概率高、且报错会被归因错。故改抽**已实证的** `order_detail_bizday` + `amount`。
- **⑤ 必须与声明的 grain 同量**（M-4）：`l1_metrics.yml` 的 `grain: [system_book, bizday]`，
  `dbt/tests/audit_retail__net_sales.sql` 也是按 `(system_book, bizday)` 对齐的。原文的
  **不带 `group by` 的总计**与粒度级声明**不同量** ⇒ 判读表那条「① 与 ⑤ 数不一致」**按字面不可执行**。
  故 ⑤ 采用与 audit **同一形态**的 `group by`（`try_strptime(...)::date` 也是照抄 audit 的写法）。
- **④⑤ 的 parquet 路径形态必须与正典逐段一致**（I-5）：正典（**四处一致**，皆在仓内）是
  `s3://<bucket>/lemeng/retail_detail/<账套>/<日期>/all.parquet` —— `dbt/semantics/l1_metrics.yml` 的
  `sources`、`dbt/models/common/staging/sources.yml` 的 `meta.path_convention` 与 `access_path`、
  `dbt_project.yml` 的 vars 头注、`dbt/tests/audit_retail__net_sales.sql` 的实际读路径。
  原文写成 `<桶前缀>/retail_detail/<账套>/<日期>.parquet`：**丢了 `lemeng/` 段**，且把目录里的
  **叶子文件 `all.parquet` 换成了以日期命名的文件**（后者无论怎么读 `<桶前缀>` 都错）。
  这类错误「照着跑读不到东西」，而原判读表把它归因到**凭据** ⇒ **误判方向**。
  ⚠️ 模型与 audit 的实际读路径是**通配**（`…/<账套>/**/*.parquet`，见 `audit_retail__net_sales.sql`）；
  这里读**某一天的叶子文件**是**抽查**形态（同一份源、范围更小），不是模型的正式读路径。

⚠️ ④⑤ 两条的 `read_parquet` **要求同会话已建 secret**（pg_duckdb 的 secret 按**连接**生效，
见「附：已知坑」里的 DuckDB 实例按连接那条）；`<桶>` / `<账套>` / `<日期>` / `<schema>` 是占位，
**真值不进文档**（安全基线：只写「在哪、怎么取」）。

### 11.4 对账持续在真数据上执行（**机制③④ 的落点**）

**这是本节最关键的一句**：**物化 job 每次跑都带 tests** ⇒ `dbt test`（含每个 `audit_<指标>.sql`
的独立复算）**每次物化都在真实数据上重跑一遍**。所以「对账」不是一次性验收动作，而是**常态**：
cast 错了、源列漂移了，下一次物化就会红。

| job | 建议 cron（**非整点**，避开业务高峰与其他 job 撞车） | 命令要点 |
|---|---|---|
| 物化（带 tests） | `17 2 * * *` | `dbt run --select <按需> && dbt test --select <同一批>`——**test 必须跟在同一 job 里**，否则「跑过 tests」不成立 |
| L1 对账（`--check`） | `43 2 * * *` | `tsx scripts/sync-data-semantics.mjs --check`——**漂移 ⇒ exit 1**（规则 ⑨ 守的契约）；⚠️ **先核这一条是 dry-run**：跑前后查 `data.metrics` 行数，**必须不变** |
| 租户对账 | `7 3 * * *` | `tsx scripts/reconcile-data-tenants.mjs`（§10 那条双向差集；**撞名必报、exit 1**） |
| 血缘产物（可选） | `23 4 * * 1`（每周） | `dbt docs generate`（§11.2；若已挂在物化 job 上，**本行删掉**） |

- **cron 全部是建议值**，真值由 T6 注册 job 时与机主/客户确认（**外部输入④**：业务排期/窗口）。
  写进本文件是为了「别默认 0 点整点打」——整点会被所有定时任务挤在一起。
- ⚠️ **对账 job 的失败必须显式可见**（non-zero + 告警），**不许 `continue-on-error`**：
  漂移被静默 = 回到「没有对账」的状态（部署验证纪律：别用容错掩盖失败）。
- ⚠️ 上面三条 job 的**命令形态都还没在真机上跑过**（本机无 dbt / pg_duckdb / 部署库），
  归 T6 首次注册时核对；其中 `--check` 的**契约**已由门禁规则 ⑨ 静态守住，
  但**它对真库的行为**（尤其「不写库」）**每次改 sync 脚本都要重测一次**——那是 T8 踩过的坑。
