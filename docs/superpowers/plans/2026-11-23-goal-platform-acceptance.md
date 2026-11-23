# 目标平台件 C 期 验收记录（C1–C4）

> 计划：`docs/superpowers/plans/2026-11-23-goal-platform-a-b-c.md`（Phase C）
> issue：#2708（Closes）/ #2705（epic，Refs）
> 记录时间：**2026-11-23 16:00 北京时间**（本文件只写实测与阻塞，不写「应该」）
> 分支：`ylwzzs/oa-g2-goal`（PR #2738）；数据面：`platform-core-shanhai-data` @ 8281d598

## 0 一句话结论

代码与静态门禁全绿；**两段模型的 SQL 语义已在真 warehouse + 真湖上验证**（目标值用临时夹具表，
见 §2.2）。**真实流程（建轮 → 录格子 → 采集入湖 → 物化 → 看板/日报）未跑**，阻塞项见 §4：
目标值来源（forms 采集）在山海数据面**已退役**（2026-10-18 R7），重新启用属既定架构决策；
且「合并后部署」不由 worker 执行。**A3 的真湖 dbt build 亦未完成**（mytech 实库无 A 期夹具表单/提交）。

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
| 段② 对真 warehouse 运行（`goal_probe` 临时夹具表：store 12/29 × 2026-10，含重复提交） | ✅ 数值逐分吻合：store 12 actual_sale **387120.6300**（独立查询 387120.63）、target 410000（取最新提交）、rate **0.9442**；actual_outbound **184032.6500**、rate **0.8763**；store 29 **1.0436 / 0.8857**；封版月 progress_rate **1.0**（31/31）；data_status `partial`/`complete` 均可解释 |
| L1 ratio SQL（sync 编译形态）对同一关系 | ✅ `0.94419665…` / `1.043644`；进度 `1` |

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
| 7 | 真实录目标 → 摊平 → 达成 → 看板 | ⛔ BLOCKED | forms 采集在山海已退役（R7）；需人确认重新启用 |
| 8 | 企微日报真送达 | ⛔ BLOCKED | 依赖 7 + 合并后部署 |
| 9 | 负对照：round 非 open 409 / 部门门分母收缩 / 重复提交幂等 | ⛔ BLOCKED | 依赖 7（B 期能力已有，需真环境跑） |
| 10 | A3 真湖 dbt build 摊平 = 提交值 | ⛔ BLOCKED | mytech 实库无 A 期夹具表单/提交（仅有 M1.4 的 form-m14-accept 一笔） |

## 4 阻塞与待决（需要人或部署动作）

1. **山海数据面的 forms 采集已退役**（2026-10-18 R7：服务 `forms-console` `enabled:false`、排班写卷
   置 disabled、`s3://shanhai-data/forms/submission/` 对象已删）。目标件在山海落地 = 重新启用一条
   **被明确退役的**采集管线 ⇒ 属架构决策，**不能由 worker 单方面反转**。重新启用的最小步骤（供决策）：
   启用 `forms-console` 服务 → seed 工作区（`forms.submission.l0` + 排班）→ 确认 `FORMS_TOKEN`/`FORMS_API_BASE`
   指向山海平台 → 首跑落第一个湖文件 → 再开 `data.dbt_goals`（否则本 job 必红，属预期）。
2. **部署**：`platform-core-shanhai-data`（数据单元）+ `platform-core-shanhai`（应用单元）的部署在
   合并 main 后手动触发（autoDeploy=false）。本 worker 被要求 **不合并**，故未部署、未在部署产物的
   容器内验（§2.2 是用 `/tmp` 副本验的语义，**不等于**部署验证）。
3. **A3 夹具缺失**：A 期的 `ops-round-2026-11` 表单与其 2 条提交不在 mytech 实库（实库仅有
   `form-m14-accept` 一笔）。要补做 A3，需在山海或 mytech 重新造该表单 + 提交 + 采集，再在容器内
   `dbt build` 摊平模型；当前未做（避免再往生产库写一次性夹具）。
4. **`data.dbt_goals` / `data.dbt_audit_goal` 开闸**：seed 恒 `enabled=false`（四步开闸），需在
   生产 `platform.job_schedule` 手动 `update … set enabled=true`（前置：§4-1 首文件已落）。
5. **决策提醒**：若最终不重新启用山海 forms 采集，则目标件应改落到 **mytech 数据面**（forms 域在
   那边活跃）——但那边没有乐檬 marts，actuals join 不成立 ⇒ 需要在两个数据面之间做选择（或把
   forms 采集迁到山海）。这是 spec §2 部署地理决策的返工点，需人拍板。

## 5 快速复跑命令（部署后）

```sh
# 数据单元容器内（部署产物）
DATA_PLANE_DOMAINS=lemeng,goals dbt ls --profiles-dir /tmp/dbt-profiles --select path:models/goals
# 四步开闸后由 job 自动跑；手动首跑：
MATERIALIZE_SCOPE=tables MATERIALIZE_TABLES_DOMAIN=lemeng,goals \
MATERIALIZE_TABLES_SELECT=path:models/goals sh /opt/lemeng-materialize.sh   # 路径以投递后为准
# 词表物化 + 编译查询
DATABASE_URL=<平台库> DATA_WAREHOUSE_URL=<数据面> node scripts/sync-data-semantics.mjs
```
