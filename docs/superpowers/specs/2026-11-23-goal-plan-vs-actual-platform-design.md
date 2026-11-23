# 平台自助能力提升：表单字段级数据通路 + 「计划 vs 实际」目标件（设计稿）

> 状态：设计定稿，待人审（2026-11-23）
> 触发：把 data-analysis 的「目标 + 目标看板」用本项目自助表单/自助报表/自助语义承接，**不做一次性移植**；目标场景是通用件的第一个消费者。
> 上游：`docs/superpowers/specs/2026-11-16-ai-native-oa-design.md`（OA 正典，本文扩展其 P3/P5）、data-analysis 目标能力取证（epic #2385 侧调研记录）。
> 决策载体：platform-core `docs/architecture.md`（§2.4 表单、数据面正典）；本文人审后落正典再写码。

---

## 0. 摘要

不移植代码，而是补齐平台三块**通用件**，让「目标 + 达成率看板」成为它们的第一个消费者：

1. **件① 表单字段级数据通路**：表单字段契约 → 生成的 dbt 摊平模型 → 词表可引用的关系。打通「表单提交 → 语义 → 报表」的字段级消费（今天 payload 整列 varchar，词表零通路）。
2. **件② 「计划 vs 实际」目标件**：目标定义（指标映射 × 维度 × 周期）+ 目标值（收集表单录入）+ **生成的达成率语义**（dbt 关系：actual join target → 达成率/时间进度），暴露为 L1 指标，报表层零改动渲染。
3. **件③ 收集轮次**（OA P3 提前）：周期 × 名单 × 进度 × 催办，让「按月重复录目标」有载体。

关键架构洞察：**达成率不进报表引擎，下沉到语义层做成指标**——报表 10 种组件今天就能渲染达成率（bullet target=100% + 达标着色、kpi、line、table），不需要改报表 spec 的目标语义。data-analysis 的四段 CTE 对比逻辑，在平台上的等价物是 dbt 语义层的生成模型，不是报表特性。

---

## 1. 问题（实测取证，两个子代理分别核过两仓）

### 1.1 被承接方：data-analysis「目标」的真实语义（必须保）

| # | 语义 | 取证 |
|---|---|---|
| S1 | 目标矩阵：周期 × 维度（战区/区域/门店 + 品类）× 多指标值 | `046_report_targets.sql` targets + target_metric_values |
| S2 | 三级分解 + 平衡校验：total→战区→区域→门店，子和=总；前端「总出库≥门店配送汇总」 | `053/057/063` RPC |
| S3 | 三态达成率：active 实时 / closed 快照 / 受限用户**分母收缩**（outbound 族受限直接 NULL） | `report_achievement_gen` / achievement-config.ts |
| S4 | 双口径：达成率 × 时间进度，三色（≥1 绿/≥0.8 琥珀/<0.8 红） | 046:143-149、kpi-cards.tsx:39-47 |
| S5 | 关闭固化：close 注入全量 claims 定格，幂等重固化，cron 兜底 | `210_close_target` / target-close job |
| S6 | 维度锚：`dim_branch` 复合键 `(system_book_code, branch_num)` + 考核战区 | architecture 主数据节 |
| S7 | 实际值口径：考核战区过滤、64188 按 client_name 匹配、delivery FULL JOIN wholesale、品类白名单、成本脱敏 | achievement-config.ts（SQL 在配置） |
| S8 | 数据完整度：按 biz_date 覆盖率 complete/partial/missing | 046:112-127 |

**复杂度评级「大」**：046→210 约 30 个迁移、4 次 close 重写；分母收缩是踩坑后补的隐性权限语义。

### 1.2 承接方：platform-core 今天的三块硬缺口

| 缺口 | 取证 |
|---|---|
| G1 目标值无存储位置 | 指标写侧 `400 TARGET_NOT_SUPPORTED`（metric-write.ts:110）；bullet/table target 仅 spec 静态常量（report-spec.ts）；`NET_MARGIN_TARGET=0.2` 硬编码（report-daily-review.ts:33） |
| G2 表单提交无字段级消费 | payload 整列 varchar（stg_forms_submission:20-24 「字段级语义不进本模型」）；词表 56 条零 forms；编译器无 JSON 词汇；唯一先例 #1791 分支绕湖直读 PG（定制代码，未合并） |
| G3 维度外部权威无通路 | 字典引用门店/区域 = architecture.md:458 写死 ❌；门店档案在 `aftersales.store`，跨 schema 读 = B1 违规 |

另：收集**轮次**未落地（P3 仅设计稿）；per-dimension 目标 join 报表 spec 不支持——路线 C 用语义层绕开（见 §2）。

---

## 2. 核心决策

### D1（件①）字段级数据通路 = 「表单字段契约 → 生成的 dbt 摊平模型」

| 候选 | 判断 |
|---|---|
| a. duckle 管线内 transform 逐表单摊平（一表单一管线） | ❌ 管线数量爆炸；改字段=改管线；与「新表单零改动」背道 |
| b. forms 模块物化类型化视图（PG 端） | ❌ 视图直读 JSONB 绕开湖；与「湖是唯一交付物」冲突；dbt/词表看不到 |
| **c. dbt 生成摊平模型（推荐）** | ✅ 照 lemeng `json_extract` 先例；契约驱动、git 受控；**表单字段契约 = 湖列集唯一事实源**的既有哲学延伸 |

**设计**：
- 表单定义 body.schema 的 properties 即字段契约。选中的表单（声明了数据面消费的）由**生成器**产出两件东西：
  1. `contracts/forms/<form_def>.json`（字段 → 列名/类型 映射，照 `contracts/` 既有模式，git 受控 + `--check` 防漂移）；
  2. 生成的 dbt 模型 `dbt/models/forms/staging/stg_forms_submission__<form_slug>.sql`（read 同一 parquet，`json_extract` 摊平出契约列）。
- **opt-in 声明**：不是所有表单都摊平；form_def body 增加可选 `dataPlane: { enabled: true }`（发布门校验字段契约可生成：字段名/类型在白名单内）。不声明 = 现状逐字不变。
- **不改 `stg_forms_submission`**（它的一对一定位与 varchar 决策保持）；摊平模型是**兄弟模型**，同 read_parquet 源。
- 类型映射白名单 v1：string/number/boolean/enum(single) + date；数组/嵌套对象/附件 v1 不摊平（进 detail JSONB 列，可查不可聚合）。

### D2（件②）「计划 vs 实际」= 目标定义 + 收集值 + 生成的达成率关系

| 候选 | 判断 |
|---|---|
| a. 指标加 target 字段 | ❌ 已被 `TARGET_NOT_SUPPORTED` 显式拒绝是对的——目标是**数据**（有周期/维度/状态），不是指标属性 |
| b. 报表 spec 加「目标数据集 join」 | ❌ 报表引擎开始懂业务 join，组件语义爆炸；且 declaration-compiler 只许单关系 |
| **c. 目标 = 一张 dbt 生成关系 + L1 ratio 指标（推荐）** | ✅ 达成率/进度全是普通指标，报表 10 组件零改动渲染；「目标」对报表不可见 |

**设计**：
- **目标定义**（新的一等声明，git 受控 YAML，照 `l1_metrics.yml` 模式进 `dbt/semantics/goals.yml`）：
  ```yaml
  - goal: shanhai:monthly_store_sale
    label: 门店月度销售目标
    period: month                      # v1: month
    dimensions: [branch_num]           # v1: 门店/战区（锚 dim_branch 复合键）
    target_source:
      form_def: goal-monthly-store     # 件③轮次表单的资产 id；值从摊平模型取
      value_fields: { sale_amount: target_sale, outbound_amount: target_outbound }
    actuals:                           # 指标映射（目标域特有语义 S7 的平台落点）
      sale_amount:  lemeng:store:sale_amount        # 引用既有 L1 指标
      outbound_amount: lemeng:store:outbound_amount
    scope: { assessed_war_zone_only: true }
  ```
- **生成的达成率关系** `dbt/models/goals/mart_goal_achievement__<goal>.sql`：
  grain = `goal_period × dimension`；列 = `target_*`（收集值汇兑）、`actual_*`（actual L1 的 select_sql 编译产物 join）、`achievement_rate`、`progress_rate`（北京时钟日界）、`data_status`（S8）。口径 SQL 来自 YAML 的 actuals 映射——**SQL 在配置，生成器只组装**（照 data-analysis achievement-config 的已被验证的模式，但落在 dbt 正统里）。
- **L1 声明**：每 goal×metric 两条指标（达成率/时间进度），`ratio` 或 expression 形态；词表可引用 ⇒ 问数/报表/推送全链免费。
- **报表渲染零改动**：bullet `target: 1` + `colorSemantics:'target'`（达成率 vs 100%）、kpi、line、table 按 grain 下钻——每店每行各自的达成率天然由 grain 给出（B 类缺口的「per-row 目标」就此消解）。
- **多目标并存**：一个 goal 定义一个生成模型；报表按 `goal` 筛选。v1 不做跨 goal 聚合。

### D3（件③）收集轮次（OA P3 提前，取 OA 设计稿 §7.3 草案落正典）

- `forms.collection_round(id, org, asset_id, version, round_key, name, starts_at, ends_at, status)` + `forms.collection_target(round_id, user_name, status, submission_id)`。
- 提交按 `(round_id, user_name)` 记目标状态；更正 = 新提交 + `supersedes_id`。
- 轮次开启 emit `forms.collection.assigned`（**本次必须真正声明进 manifest**——P1 审计发现它只在设计稿）；催办沿用 `notify` 规则管道（`forms.collection.due`，事件 id 含日期）。
- **目标值轮 ≠ 名单轮**：目标收集是「按维度录值」（门店 × 指标字段），不是「按人交表」——轮次件 v1 同时服务两种：`targets`（名单型，既有设计）与**值集轮**（维度格子型，目标场景新增）。值集轮的完整格子 = 维度 × 指标字段；开启时从维度锚生成格子，录入页按格子校验完整性。

### D4 维度锚与外部权威（分两步）

- **v1（本波）**：维度锚用**字典快照**（开启轮次时从数据面门店清单同步生成 `gdict` 全局字典项，带 `(system_book_code, branch_num)` 复合 key）；字典项 content 存锚字段。漂移由「每次开轮重新同步」兜底——轮次是月频，漂移窗口可接受。
- **v2**：实现正典 §2.4 的外部权威适配器（操作面稳定视图 + `dataDependencies`），字典/目标格子直接引用。本波不做，但目标定义 YAML 的 dimensions 字段预留 `source: dim_branch`。

### D5 分母收缩 = 分解到店 + 行级权限，不是报表特性

- data-analysis 的教训（S3）：受限用户达成率必须「目标也收缩到可见门店」——**前提是目标落店级**。总部级目标无法收缩（outbound 族直接 NULL 就是这么来的）。
- **本设计规定：目标值必须收集到店粒度**（战区/区域目标 = 店目标汇兑出的派生视图，录入仍到店），行级权限用数据面既有部门门（org 行 + 门店门）作用于达成率关系的查询——分母收缩对加和类指标**自动成立**（可见子集的 Σactual/Σtarget）。
- 非（跨店）加和类指标（毛利率等比率型）v1 不进目标件；`auto_approve` 式特例不存在。

### D6 关闭固化 = 湖封版分区（平台天然等价）

- 不做 `close_target` 快照表：目标周期的实际值来自湖分区，周期封版后数据不可变——closed 语义由「读封版分区」天然获得；`data_status` 同理可复算。
- v1 不做显式 close 动作；若后续要「提前锁定口径+存档审计」，再加 `goal_close`（记录固化时点的水位）。

### D7 实际值口径（S7）的落点

- actuals 映射引用**既有 L1 指标**（词表口径），不复制 data-analysis 的四段 CTE——口径统一是本次移植的净收益。
- data-analysis 特有过滤（考核战区、品类白名单、成本脱敏）落两处：`scope.assessed_war_zone_only` 进生成模型（join `dim_war_zone.is_assessed`）；成本脱敏沿用数据面列级权限，不进目标件。

### D8 权限与多租户

- 目标定义 YAML 是平台级（数据面部署=单租户口径，与 L1 一致）；收集值带 org（forms 既有纪律）；达成率关系经 Gate-B/部门门出。
- agent 面：`search_goal_definitions` / `get_goal_status` 两个只读工具进 forms mcp-manage（起草目标值仍走表单，AI 不产出生效值）。

---

## 3. 首个消费者（第一刀，最小范围）

- **目标**：月度 × 门店（锚 dim_branch）× `{sale_amount, outbound_amount}` 两指标；战区/区域达成率为店级汇兑派生。
- **录入**：目标值走 `goal-monthly-store` 收集轮次表单（维度格子型，D3）；谁录入 = 数据/经营角色（`forms:fill`）；**审批不强制**（目标录入要不要审批留开放项，见 §6）。
- **看板**：一个「目标达成」报表模板（内置模板库新增）：kpi（达成率/时间进度）+ table（按店/战区，达标着色）+ line（周期内累计 actual vs target 节奏）+ ai_text（叙事）。
- **告警**：monitor threshold 挂达成率（静态阈值即可，如 <0.8 落后提醒）。
- **推送**：复用 notify 管道（达成日报），企微渠道既有。
- **明确不做（第二刀）**：品类维度、总部分解录入 UI、多目标并存聚合、目标审批流、关闭动作、历史目标回填工具。

---

## 4. 语义保真对照（data-analysis → 平台落点）

| data-analysis | 平台落点 | 是否等价 |
|---|---|---|
| targets/target_metric_values | 收集轮次表单提交（摊平后 `stg_goal_values`） | ✅ 载体不同、语义同 |
| 三级分解 + 平衡校验 | 店级录入 + 汇兑派生 + 录入校验（格子完整性/汇总一致性） | ✅ 且更简单（不存分解行，汇兑即视图） |
| report_achievement_gen | 生成 `mart_goal_achievement__<goal>` + L1 指标 | ✅ 生成器模式同源，落 dbt 正统 |
| 三态（active/closed/受限） | active=当期分区；closed=封版分区；受限=行级部门门（D5） | ✅ 平台机制更自然 |
| 达成率×时间进度三色 | progress_rate 指标 + 报表达标着色（target=1） | ✅ |
| 企微达成日报 | notify 管道 + 企微渠道 | ✅ 既有 |
| 数据完整度 data_status | 生成模型列（biz_date 覆盖） | ✅ |
| Next.js API/看板壳/推送渲染 | 报表平台 + notify 平台（胶水不再需要） | ✅ 净收益 |

---

## 5. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **A 件① 字段级通路** | opt-in 声明 + 契约生成器（含 `--check`）+ 生成摊平模型 + 词表首条 forms 指标（非目标场景：如巡检完成数） | 新表单 opt-in 后零改动出指标；`--check` 门禁 CI 绿；既有 pipeline/stg 不回归 |
| **B 件③ 收集轮次** | 轮次/目标/值集轮三表 + 事件声明 + 进度/催办 | 开轮→录格子→进度可见→催办送达；`forms.collection.assigned` 真声明 |
| **C 目标第一刀** | goals.yml 目标定义 + 生成达成关系 + L1 达成率/进度 + 报表模板 + 告警/推送 | 真实录一个月目标 → 看板呈现 → 企微日报；受限用户分母收缩负对照（不可见店不计入） |
| **D 第二刀（另立计划）** | 品类维度、总部分解录入 UI、目标审批流、goal_close、v2 外部权威 | 另评审 |

依赖：A/B 可并行；C 依赖 A+B。预计 A≈1.5 周、B≈1 周、C≈1.5–2 周。

---

## 6. 开放项（人审时拍板）

1. **目标录入要不要审批门**（部门报目标 → 上级确认生效）？v1 建议不做（轮次内可改，以提交时间最新为准），真需求出现再加。
2. **forms:fill 之外是否要 `forms:goal-fill` 之类细分码**？v1 建议复用既有码，不新增。
3. **达成率口径的分母保护**：`target=0` 行（新店无目标）达成率置 NULL 还是剔除？建议 NULL（照 data-analysis outbound 族）。
4. **告警阈值挂谁**：数据面 monitor（既有）即可，无需新告警面。

---

## 7. 架构文档更新清单（人审后、写码前）

1. `docs/architecture.md` §2.4 追加「表单字段级数据通路（opt-in 摊平）」小节；数据面正典追加「计划 vs 实际目标件」节（D2/D5/D6）。
2. OA 设计稿 §7.3 轮次草案升正典（本文 D3）；`forms.collection.assigned` 的声明缺口随 B 期落地。
3. `docs/data-platform-handbook.md` 目标场景登记（作为首个消费者案例）。

---

## 8. 非目标

- 不移植 data-analysis 任何应用代码/页面/推送渲染。
- 不做跨 goal 聚合、目标审批流、目标版本 diff、多维（品类）——第二刀另议。
- 不动 `stg_forms_submission` 既有定位与 varchar 决策。
- 不在本波实现外部权威适配器 v2（字典快照先行）。
- 报表 spec 的 target 语义不改（保持常量 + 未来覆盖源路线，本文不依赖它）。
