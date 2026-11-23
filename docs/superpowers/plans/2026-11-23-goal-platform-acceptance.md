# 目标平台件 C 期 验收记录（C1–C4）

> 计划：`docs/superpowers/plans/2026-11-23-goal-platform-a-b-c.md`（Phase C）
> issue：#2708（Closes）/ #2705（epic，Refs）
> 记录时间：**2026-11-23 16:00 北京时间**（本文件只写实测与阻塞，不写「应该」）
> 分支：`ylwzzs/oa-g2-goal`（PR #2738）；数据面：`platform-core-shanhai-data` @ 8281d598

## 0 一句话结论

代码与静态门禁全绿；**两段模型的 SQL 语义已在真 warehouse + 真湖上验证**（目标值用临时夹具表，
见 §2.2）。**真实流程（建轮 → 录格子 → 采集入湖 → 物化 → 看板/日报）未跑**：协调者已授权
「为山海租户在山海数据面建它自己的 forms 采集管线」，但按分工（worker 不合并、不部署、不启停
生产服务）需协调者执行；步骤与回读判据见
**`docs/superpowers/plans/2026-11-23-goal-shanhai-forms-runbook.md`**。
A3 夹具（`ops-round-2026-11`）经裁决 **superseded**：改用目标表单本身验证摊平与字段级数值。

## 1 交付物（C1–C3）

| 件 | 交付物 | 状态 |
|---|---|---|
| C1 | `dbt/semantics/goals.yml`、`scripts/gen-goal-achievement.mjs`、`dbt/models/goals/*`（段①/段②）、4 条 L1（ratio）、4 条对账（`dbt/tests/lemeng/audit_lemeng__goal__*.sql`）、job `data.dbt_goals` / `data.dbt_audit_goal` | ✅ 代码/门禁全绿 |
| C2 | 内置模板 `goal_achievement` + `TemplateMeasure.target/colorSemantics` 透传 | ✅ 单测 8 条 |
| C3 | `scripts/goal-daily-push.mjs` + job `goal.daily_push` + 事件 `forms.goal.daily` + 模板 `oa_goal_daily`（manifest/template/seed 三处同描） | ✅ 单测 8 条 + 三处同描门禁 |

**关键设计修正（相对计划）**：模型落 `dbt/models/goals/`（独立 `goals` 域），**不是** lemeng 域。
理由：#751 实测——forms 湖在首个文件落下前 `read_parquet` 报 `IO Error: No files found`；
若挂 `path:models/lemeng`，每日乐檬物化档会被 forms 采集空窗打红、水位冻结。专用 job
`data.dbt_goals` 以 `DATA_PLANE_DOMAINS=lemeng,goals` 解析（`ref` 可解析）但只选 `path:models/goals`。

## 2 已执行的验证（真机，2026-11-23 北京时间）

### 2.1 静态门禁 / 单测（本地 CI 等价全量）

| 门禁 | 结果 |
|---|---|
| `gen-goal-achievement --check` | OK（2 份产物 == committed） |
| `check-data-models` | OK（域 3：lemeng/forms/goals；声明指标 61；对账 67） |
| `check-semantics` / `check-data-contract` / `check-column-scope-monotonicity` | OK |
| `check-data-plane-lock`（lock 已重跑） | OK |
| `check-manifests` / `lint-architecture` / `check-job-scripts-portable` | OK |
| `pnpm typecheck`（5 包 + scripts） | OK |
| 单测 | 生成器 22 / 日报 8 / 报表模板 8 / forms 190 / notify 170 / server-scheduler 80 —— 全绿 |

### 2.2 真机 SQL 语义（shanhai 数据面）

方法：在数据单元 `scheduler` 容器内把 `/app/dbt` **复制到 `/tmp`**（镜像只读），补入本分支的
`goals` 域与两个模型，用容器内 dbt 1.9.1 + 既有 `pg_duckdb` 连接运行；**生产检出与生产工件未改**，
探针用后即删（`/tmp` 副本与 `goal_probe` schema 均已清理）。

| 探针 | 结果 |
|---|---|
| `dbt parse`（`DATA_PLANE_DOMAINS=lemeng,goals`） | ✅ PASS（ref/jinja/macros 全解析） |
| `dbt ls --select path:models/goals` | ✅ 恰好 2 个目标模型；`path:models/lemeng` 选择器 **0** 个 goal 模型（隔离成立） |
| 段① 对真湖 `s3://shanhai-data/forms/submission/...` 运行 | ⚠️ **预期失败**：`IO Error: No files found that match the pattern`——山海 forms 湖为空（见 §4-1），正是独立域设计的依据 |
| 段② 对真 warehouse 运行（`goal_probe` 临时夹具表：3120 账套 store 153/75/29 × 2026-10，含重复提交与 target=0） | ✅ 数值逐分吻合：store 153 取**最新提交** target 300000/30000，actual_sale **252771.4000**（独立查询 252771.40）、rate **0.8426**；actual_outbound **27860.1500**、rate **0.9287**；store 29 sale **118998.1000 / 0.5950**、outbound target=0 ⇒ 达成率 **NULL**；store 75 sale target=0 ⇒ **NULL**、outbound **99283.3000 / 0.9928**；`system_book` 列 = **3120**；封版月 progress **1.0**（31/31），data_status `complete` |
| L1 ratio SQL（sync 编译形态）对同一关系 | ✅ 达成率 `0.84257133…`（252771.4/300000）；进度 `1` |

### 2.4 真机首跑与对账修复（#2750，2026-11-23 20:37 北京时间）

协调者已在山海数据面完成首跑：forms 采集落湖 1 行（`goal-monthly-store`）、`data.dbt_goals` PASS、
mart 1 行（target 300000/50000，actual 78415.30/25849.33，progress 0.7667，complete）、
`data.semantics_sync` 物化 4 条、`goal.daily_push` 2 条事件 sent。随后 `data.dbt_audit_goal`
（job 17713）报 **PASS=2 ERROR=2**，暴露三类真机缺陷（全部已修 + 真机复验）：

| # | 缺陷（真机原文） | 修法 | 复验 |
|---|---|---|---|
| 1 | `Relation name 'audit_lemeng__goal__monthly_store_sale_outbound_achievement_rate' is longer than 63 characters` | 指标名后缀压成 `_rate` / `_pace`（四条），派生测试名 48/52 字符；同步 l1 / 生成器 / 文件名 / registry 选择器 / 两张同步登记表 | `dbt ls` 可解析、`dbt test` 正常建 relation |
| 2 | `Catalog Error: Scalar Function with name to_char does not exist`（含 `read_parquet` 的语句整条路由进 DuckDB；**求值期炸，0 行也炸**） | 截止月改**编译期字面量**宏 `compile_time_month()`（新宏）；周期分组 `strftime(date_trunc(...),'%Y-%m')`；去 `DISTINCT ON`（改 `row_number()`）、去复合 interval 字面量 | 空集 PASS |
| 2b | `regexp_matches(...)` → `set-returning functions are not allowed in WHERE`；`SIMILAR TO` → `similar_to_escape does not exist` | 形状判据回到 `~ '^…$'` 运算符（`duckdb.query` 探针：`t`） | PASS |
| 3 | `sum(UnsupportedPostgresType(DuckDB requires the precision of a NUMERIC to be set))`（PG 无精度 numeric 不可被 DuckDB 聚合） | 生成的 mart 数值列全部显式 `::numeric(20,4)` / `::numeric(10,4)`（**需重建 mart 生效**） | 重建后 `information_schema` 显示 numeric(20,4)/(10,4)，`sum()` 正常 |

**真机复验终态**（数据单元 scheduler 容器，`dbt test --select <4 条>`）：
`PASS=4 WARN=0 ERROR=0 SKIP=0 TOTAL=4`；mart 重建后仍为 1 行、数值与首跑一致
（`2.3` 之后这一行由 `dbt run --select mart_goal_achievement__monthly_store_sale` 在 7abe59e0 源上重建）。

⚠️ **部署顺序**：typmod 修复要求**先重建 mart 再跑对账**（`data.dbt_goals` → `data.dbt_audit_goal`）；
若只重跑对账而 mart 仍是旧列型，会继续报 #3。

### 2.3 未做（阻塞，见 §4）

- A3「目标数据面按 lock 投递 + 采集入湖后容器内 `dbt build` 摊平模型，验字段级数值 = 提交值」；
- C4 真实流程（建轮→录格子→摊平/达成出数→报表看板→阈值告警→企微日报）与负对照全套。

## 3 C4 验收清单（逐项）

| # | 项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 生成物 == committed（`--check`） | ✅ PASS | CI gates + 本地 |
| 2 | 两段模型在真 warehouse 可运行、达成率/进度口径正确 | ✅ PASS | §2.2 探针（夹具目标值） |
| 3 | 乐檬每日物化不受目标模型影响 | ✅ PASS | `dbt ls` 选择器隔离 + 独立 job |
| 4 | target=0 ⇒ 达成率 NULL | ✅ PASS（逻辑级） | 生成 SQL `case when target > 0`；待真数据复验 |
| 5 | 报表模板编译 + target 着色透传 | ✅ PASS | 模板单测 |
| 6 | 日报事件三处同描 | ✅ PASS | builtin 三处一致性门禁 + 单测 |
| 7 | 真实录目标 → 摊平 → 达成 → 看板 | ⏸ 待协调者执行 | 已授权重建山海 forms 采集；步骤见 runbook §1（PAT→FORMS_TOKEN→启服务→换连接凭据→首跑→湖回读） |
| 8 | 企微日报真送达 | ⏸ 待协调者执行 | 依赖 7 + 合并后部署（runbook §1-6/-8） |
| 9 | 负对照：round 非 open 409 / 部门门分母收缩 / 重复提交幂等 | ⏸ 待 7 之后 | B 期能力已在（#2715）；需真环境跑 |
| 10 | A3 真湖 dbt build 摊平 = 提交值 | 🔁 SUPERSEDED | 裁决：夹具在任何可达实库都不存在，不再追；改用**目标表单本身**验证（runbook §1-5/-6） |
| 11 | `data.dbt_audit_goal` 真机 PASS=4（#2750） | ✅ PASS | 真机容器 `dbt test` 4/4 PASS（见 §2.4）；job 仍 disabled，待协调者开闸 |
| 12 | 封版 as-of（协调者裁决 4） | ⛔ 已知边界（未实现） | 技术原因见 §7：分析面只读湖，封版状态在 PG；as-of 需先把 goal_period/supersedes_id 出湖（新采集物），成本超「最小版」 |

## 4 阻塞与待决（需要人或部署动作）

1. **山海 forms 采集重建已获授权（2026-11-23），但执行在协调者**：需山海租户 PAT（`forms:view`，
   严禁复用 mytech token）→ 写入 `forms-console` 服务 env `FORMS_TOKEN` → 启服务 → **换掉 workspace
   `forms` 连接里的凭据**（密文）→ 首跑落湖 → 湖回读（无 org 列、6 列、form_def_id 正确）→
   再开 `data.dbt_goals`。逐步对象与回读判据见 runbook。**若拿不到山海 PAT：停下报 exact blocker，
   不使用旧凭据、不伪造。**
2. **部署**：`platform-core-shanhai-data`（数据单元）+ `platform-core-shanhai`（应用单元）的部署在
   合并 main 后手动触发（autoDeploy=false）。本 worker 被要求 **不合并**，故未部署、未在部署产物的
   容器内验（§2.2 是用 `/tmp` 副本验的语义，**不等于**部署验证）。
3. **A3 夹具：SUPERSEDED（裁决 2026-11-23）**——`ops-round-2026-11` 在任何可达实库都不存在，
   不再追；摊平与字段级数值改由**目标表单 `goal-monthly-store`** 在同面采集后验证（runbook §1-5/-6）。
4. **`data.dbt_goals` / `data.dbt_audit_goal` 开闸**：seed 恒 `enabled=false`（四步开闸），需在
   生产 `platform.job_schedule` 手动 `update … set enabled=true`（前置：§4-1 首文件已落）。
5. **部署地理已定**：山海 forms 采集重建（同面 join）——不再考虑落 mytech（那边无乐檬 marts）。

## 5 告警示例（运维配置，不改代码；C2 交付面）

达成率告警挂**既有 monitor**（不新增告警面，spec §6 开放项 4）：目标件的达成率是普通 L1 指标，
按 `metric_id = lemeng:goal:monthly_store_sale_sale_achievement_rate` 建阈值规则，示例形状
（阈值 0.8、连续 2 天、只发企微日报收件人组）：

```yaml
# 数据面 monitor 规则（DB 配置，非仓内代码；字段以 data-monitor skill 的判据表为准）
metric_id: lemeng:goal:monthly_store_sale_sale_achievement_rate
op: lt
threshold: 0.8
consecutive: 2
channel: wecom_default
note: 目标落后提醒（时间进度过半仍未达 80%）
```

⚠️ **不写进 `dbt/semantics`/仓内标准**：阈值是运营参数（客户/月度可调），仓内只登记「怎么挂」，
不把某个具体阈值升成标准（无案例不立标准）。

## 6 快速复跑命令（部署后）

```sh
# 数据单元容器内（部署产物）
DATA_PLANE_DOMAINS=lemeng,goals dbt ls --profiles-dir /tmp/dbt-profiles --select path:models/goals
# 四步开闸后由 job 自动跑；手动首跑：
MATERIALIZE_SCOPE=tables MATERIALIZE_TABLES_DOMAIN=lemeng,goals \
MATERIALIZE_TABLES_SELECT=path:models/goals sh /opt/lemeng-materialize.sh   # 路径以投递后为准
# 词表物化 + 编译查询
DATABASE_URL=<平台库> DATA_WAREHOUSE_URL=<数据面> node scripts/sync-data-semantics.mjs
```

## 7 已知边界：封版 as-of 未实现（协调者裁决 4 的「成本超预期」出口）

裁决要求的**最小封版版**：`goal_period(org, goal, period, state, closed_at)`；目标摊平行带
`effective_at`（= submitted_at）与 `supersedes_id`；达成 mart 只读「该 period 封版时刻前的最新有效行」；
封版后更正需显式 reopen + 审计。

**评估结论：成本明显超出「最小版」，按裁决出口登记为已知边界，未实现。** 技术原因（不是工时借口）：

1. **分析面只读湖**（数据宪法 I1：PG = 系统记录，永不给分析面读）。`goal_period` 与 `supersedes_id`
   都是 PG 侧事实；今天它们**不在湖里** ⇒ mart 无法按封版时刻过滤。
2. 要做 as-of，必须先把它们**出湖**：新契约 + 新/扩展采集管线（`forms.submission` 契约加列或新
   `goal_period` 数据集）+ staging + 生成器/模型 + 迁移 + 测试 + 部署，且 `form.submission` 是
   既有生产契约（A 期定稿「列集唯一事实源」），扩列要重跑 lock、改生产者投影。**这是一条新的采集线，
   不是「最小版」。**
3. 当前行为如实说明：mart 取**最新提交**（`submitted_at desc, submission_id desc`）；封版后对某月
   目标的更正会改写该月达成率，**没有 as-of 快照**。目标表的 `version`/`submitted_at` 与提交历史仍
   完整保留在 forms 侧（PG），需要追责时可回溯。
4. 第二刀建议的最小路径（供立项）：B 期收集轮次已有 `status ∈ draft|open|closed`；把轮次的
   `closed_at` 作为「封版时刻」**随提交导出**（`forms.submission` 增加 `round_id` + `round_closed_at`），
   mart 侧按 `submitted_at <= round_closed_at` 取最新行即可，不需要单独的 goal_period 表。
