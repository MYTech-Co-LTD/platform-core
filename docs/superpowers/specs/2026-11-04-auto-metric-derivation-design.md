# 源数据自动推导指标 + 可信度回路 —— 设计

> 日期 2026-11-04 · 状态：**待评审**
> **导航**：整体布局、波次顺序与**当前进度**看路线图
> `docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`（唯一导航面）；本文件只讲为什么/是什么。
> 由来：用户诉求「agent 分析源数据 → 自动总结 L2 指标与 L1 待审指标 → 用户自主分析 → 越用越准」。
> 本 spec 是**两期拆解的第一期**设计；第二期（需求驱动挖掘）只定骨架。
>
> 既有决定（本 spec 不推翻，只做边界澄清）：
> - `docs/superpowers/specs/2026-11-01-mobile-first-business-surface-design.md` §10.4 **D6/D7**（L2 草稿→确认；可信度分级）
> - `docs/superpowers/specs/2026-10-12-l2-expressiveness-b-tier-design.md`（L2 = B 中档结构化算术树）
> - `docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md`（提案 → draft PR 通路）

## §0 问题

今天 agent 只在**用户明确要求**时创建 L2（`customize_metric`），且只能组合已有 L1。
两个缺口：

1. **覆盖缺口**：源数据里可聚合、可当维度的列，只要没被 L1 用上，用户就分析不到；
   新租户/新源上来时尤其明显（词表从零开始）。
2. **回路缺口**：`query_audit`（每次查询一行、含 `metric_id`）与 `askdata_conv/askdata_stuck`
   （#741 演进 loop P1 已落）在采集「bot 撞墙」，但没有任何环节把「用户反复想要、词表没有」
   变成新口径。用了半年，词表不会自己变好。

## §0.5 可行性验证（2026-11-04 实测，真实代码/真编译器）

| # | 假设 | 结论 | 证据 |
|---|---|---|---|
| A1 | 私有测度能编译成 L1 同形 `select_sql` 并过 `L1_SELECT_RE` | ✅ **通过** | 用真 `parseL1Select` 跑 31 个单列 sum 声明 × 3 种 grain = **93/93 解析通过**；35 条 L1 声明中 31 条是单列 sum（另 4 条为差/count distinct/case，本就不属私有测度允许面） |
| A2 | 运行期只依赖 `subject_column`+`select_sql`，零新路径 | ✅ **通过** | `authz.ts` 内核只读 `metric.subjectColumn` / `metric.selectSql` + 掩码；`WHERE <subject> = <org>` 恒拼 |
| A3 | `column ∈ 契约已声明列` 可作白名单 | ❌ **不成立，已改设计** | 抽样 `lemeng.retail_order_line` vs `fct_retail_sale`：契约 25 列仅 **13** 出现在 mart；`authz.ts:49` 注释本身就写着「契约列根本不出现在 selectSql 里」。⇒ 白名单必须是 **marts 实际列**（运行时 `information_schema.columns`），不是契约列 |
| A4 | `query_audit.metric_id` 在查询路径写入 | ✅ **通过** | `audit-store.ts:60` insert 显式含 `metric_id` |
| A5 | 新建 L2 落 `certified='draft'` 且可查 | ✅ **通过（现状即符合）** | `metric-store.ts` 的 insert 硬编码 `'draft'`；查询路径**不过滤** `certified` ⇒「新建即时可用 + 标 draft」**无需改代码** |
| A6 | 能从 L1 `select_sql` 反解 relation | ✅ **通过** | `parseL1Select` 返回 `{expression, relation}` |

**另外两处比预想更省**（既有实现可直接复用，减小 Wave 2 工作量）：

- `metric-usage.ts` 已实现 `metricUsageStats`（使用统计读面）与 `retireCandidatesOf`（L2 零使用下线候选，读面）
  ⇒ 本 spec **只需加 `archived_at` 动作**，不重建统计
- D6 的确认端点已落（`POST /metrics/:id/confirm-draft`）⇒ §2.1 的「修改走 D6」直接复用

**仍待验项已在 2026-11-04 当轮验完**（openship MCP 只读探测，shanhai 数据机）：

- **P1 ✅ 通过**：`information_schema.columns` 可读；marts 落在 `staging` schema（实测 20 张 `fct_*`），
  `fct_retail_sale` 的 `org text` 与 `sale_amount numeric` 等列类型均可见 ⇒ 白名单可用运行时列清单。
- **P2 ✅ 引擎原生有（判停门 ①）**：duckle 自带
  `qa.profile`（逐列 count/nulls/distinct/min/max/quartiles）、`qa.profile.adv`、
  `qa.classify`（PII 启发式分类，regex+统计、无模型）、`qa.describe`、`qa.histogram`、`qa.baseline`（历史基线对比）；
  `src.postgres` 支持 `customSql` / `pushdown` / `readOnly`。
  ⇒ **profiler 必须是一条 duckle 管线**，不是 Node 侧手写采样 SQL。
- **P3 ⚠️ 仍须设计约束**：`qa.profile` 输出的 min/max 也是数据事实 ⇒ **跨租户 profile 会泄漏**。
  管线按 org 用 `customSql` 过滤（org 清单由平台给），或只落租户内可见的 profile 表。

## §1 核心判断（先于方案）

### 1.1 两个 loop 的长期价值差一个量级

| | **Loop A：词表扩张** | **Loop B：可信度复利** |
|---|---|---|
| 机制 | 自动生成更多指标 | 真实问答 → verified_question → 回归集 |
| 收益曲线 | 递减（前 200 条有用，之后是长尾噪声） | **递增**（问得越多越准，沉淀成资产） |
| 失败模式 | **指标蔓延**（metric sprawl） | 无 |
| 护城河 | 无 | 强（口径裁决史 + 问答语料，抄不走） |

⇒ **本 spec 把 Loop B 与三档闭环并列为 P0**，不把「指标数量」当目标。

### 1.2 「自由」不等于「无治理」

一手调研证据（2026-11-04，详见附录 A）：

| 来源 | 事实 |
|---|---|
| Spider 2.0（第三方基准） | 企业级真实 SQL 准确率 **10.1%** —— 裸 text2sql 在生产不可用 |
| dbt Labs 2026 实测 | 裸 schema 64.5% vs 语义层建模后 **98.2–100%** |
| Snowflake Cortex Analyst | 「90%+」为**官方自评**、无第三方复现 |
| dbt / Cube / Databricks / Fabric | 全部提供 **MCP server**，官方指引「agent 经语义层取数，不读裸表」 |
| NVIDIA auto-ontology | **人审 certify 是强制环节**，不是可选 |

⇒ 自主性来自**零等待**（不用等人出报表），不来自**零治理**（随便写 SQL）。
方案据此定形。

## §2 三档落地与边界

| 档 | 形态 | 生效 | 治理 |
|---|---|---|---|
| **L2 组合** | 既有 B 中档：L1 ref 的结构化算术树 | 新建即用（`certified='draft'`） | 现有 `metric-write.ts` 闸门 |
| **私有测度（新档）** | `{agg, column, dims}` 单列聚合 | 新建即用（`certified='draft'`） | 同下 §4 |
| **L1 提案** | dbt YAML + model | **draft PR 人审合并** | `apply_pipeline_proposal` 机制扩展 |

**私有测度的定位 = 过渡档，不是长期档位**：它是「待收敛的实验口径」，
30 天内要么升为 L1、要么被淘汰（§4.4）。不做长期悬挂。

### 2.1 与 D6 的边界澄清（须评审确认）

D6 原文「L2 变更走草稿→确认→生效（不做即时生效）」的实质是：
**改一条已生效口径，不能让全租户看数人的数字悄悄变**。

本 spec 的切分：

| 情形 | 行为 | 与 D6 关系 |
|---|---|---|
| **新建** AI 私有测度 | 直接写生效列 + `certified='draft'` + 草稿徽标 → 立即可查 | 不动任何人的现有数字 ⇒ 不撞 D6 实质 |
| **修改**任何已生效口径 | 严格走 `draft_spec` → 管理员确认 → 生效 + `metric.definition.changed` 通知 | **D6 原样不变** |

⚠️ 这是**对 D6 的边界澄清，不是例外**。若评审认为不成立，退化为「全部走草稿→一键确认」
（即 auto-ontology 的 Certify 模型），本 spec §3 的其余部分不受影响。

## §3 架构与数据流

```
① Profiler（**duckle 管线**，不是自写 SQL）
   形态：src.postgres（customSql 按 org 过滤）→ qa.profile → snk.postgres（`data.metric_profiles`）
   ⚠️ **落点订正（2026-11-04 实测）**：该表在**仓库库（pg_duckdb）**，不是平台库——console 到平台 pg 超时，
   且 `data.load_log` 同址先例。平台侧（Task 5）经 `DATA_WAREHOUSE_URL` 读，建表走数据面引导步骤而非平台迁移。
   ⚠️ 判停门结论 = **①引擎有**（`qa.profile` / `qa.classify` 均 available，2026-11-04 真机目录实测）；
      自写采样 SQL 属违反 duckle-native-first，不采纳
   输入：L1 已用的 marts（当前 18/25）× 运行时 `information_schema.columns` 取实际列
   ⚠️ 跨租户：按 org 逐租户跑（org 清单由平台给），不跨租户聚合——见 §0.5 P3
   实现：采样 profile（LIMIT N，不全扫）→ 列画像
        ↓
② Candidate generator
   规则筛（LLM 不负责算式）：
     · 排除 全空列 / 基数=1 列 / 非数值且不可枚举列
     · 排除 已被某个 L1 指标覆盖的 列×聚合 组合
     · 每关系上限 20 条
     · 维度候选 = 低基数、已声明、未被掩码的列
   LLM 只做：中文 label、rationale、业务可读性判断
        ↓
③ 分流
   ├─ 能被既有 L1 ref 树表达 → L2（现有闸门）
   ├─ 单列聚合 → 私有测度（basis='column_agg'）
   └─ 高频使用（二期）→ L1 draft PR
        ↓
④ 使用 → query_audit.metric_id（已有，无需新埋点）→ 热度
```

**两种生成来源的落点不同**（防灌水）：

| 来源 | 落点 |
|---|---|
| **对话中用户明确要**（「按店看退货率」但词表无） | **直接创建**私有测度，即时可用（标 draft） |
| **批量 profile 产出** | **只进候选池** `data.metric_candidates`，console 可浏览、一键采用；不自动上台 |

理由：26 个关系 × 几十列若自动建测度会产生数百条垃圾口径，热度淘汰救不回来。

## §4 关键设计

### 4.1 私有测度 = L2 行 + `basis`，写入期编译成与 L1 同形

**不新增运行期编译器**——私有测度在写入期就编译成 L1 同形状的 `select_sql`：

```
声明 { agg:'sum', column:'net_amount', dims:['branch_num'] }
        ↓ 编译一次（唯一编译点）
select sum(net_amount) as value, branch_num from fct_retail_sale
        ↑ 与 L1 select_sql 逐字同形状（L1_SELECT_RE 同一份正则）
        ↓ 运行期
authorize 拼 WHERE org = '<租户org>' │ 掩码列引用定点替换 │ 行域 —— 全部原样复用
```

⇒ `subject_column` / 行域 / 掩码 / 审计**零新路径**。这是本档能安全上线的前提。

存储（新增一个 `metric_basis` 迁移，编号取落库时的下一个可用值）：

| 列 | 语义 |
|---|---|
| `basis` | `'l1_tree'`（现有 L2，默认）\| `'column_agg'`（私有测度）。**不新增 `source` 枚举值**——`source` 仍 `l2`，保护等级与「谁能改」判定不变 |
| `archived_at` | 热度淘汰时间戳；查询面过滤 `archived_at is null`（存量 NULL = 在用） |

`certified` / `created_by` / `biz_description` / `unit` / `caliber_note` **复用现有列**（027 已落），不新造可信度概念。

### 4.2 三道 fail-closed 闸

1. **白名单**：`relation ∈ L1 声明当前引用的 marts 集合`（2026-11-04 实测 21 个），
   `column ∈ 该 marts 的**实际列**`（运行时 `information_schema.columns`，**不是**契约列——
   实测契约列与 mart 列仅 13/25 重合，见 §0.5 A3）；measure 列限数值型；**measure / dim 列都不得是被掩码列**（fail-closed）。
   ⚠️ **低基数不是写入闸**（2026-11-05 订正）：写入面没有廉价的基数来源，低基数只是**候选生成规则**
   （`pickDims` 的 `DIM_MAX_DISTINCT`/`DIM_MAX_RATIO`）；直接调 `POST /metrics/private` 可对高基数列分组——
   这是已知边界（性能风险，非授权面）。
2. **不可被引用**：私有测度**不能作为 L2 的 ref 基底**（`resolveL1Base` 只认 L1，需加显式断言），
   防「私有测度 → L2 → 更多 L2」的口径蔓延。
3. **维度约束**：`dims` 不得含被掩码列（沿用「维度列不能按列掩码」同一判据）。

### 4.3 可信度与输出标注

- 私有测度新建即 `certified='draft'`；管理员可升 `certified`（现有 `PUT /metrics/:id/certified`）。
- **输出必须带徽标**：agent 回答中凡用到 `draft` 口径的数字，显式标「草稿口径」。
  这是防「错数上会」的最低成本措施，也是 Loop B 的入口（用户纠正 → 修正候选）。

### 4.4 生命周期（热度淘汰）

| 事件 | 动作 | 数据来源 |
|---|---|---|
| 被查询 | 无需探查写 | `query_audit.metric_id`（已有） |
| **30 天零使用** | `archived_at = now()`，从 `list_metrics` 消失；可复活 | `query_audit` 聚合 |
| **30 天内多次使用且跨 ≥2 用户** | 标 `promotion_candidate` → 二期出 L1 draft PR | 同上（**次数阈值不预先编**，Wave 1 拿到真实分布后标定） |
| 用户纠正 / 拒绝 | 候选表记 `rejected` + 理由，回灌生成器（防重复产物） | 候选表 |

⚠️ 与既有 P1 登记的关系：`2026-11-01` spec §10.4.3 的第二项**已实现读面**——
`metric-usage.ts` 的 `metricUsageStats` 与 `retireCandidatesOf`（L2 零使用候选）。
本 spec **不重建统计**，只补两件：① `archived_at` 落点（当前只有候选清单，没有下线动作）；
② 触发条件钉死为 30 天（次数阈值仍待 Wave 1 真实分布标定）。

### 4.5 候选表

`data.metric_candidates`：`org / relation / expr / dims / evidence jsonb / rationale /
confidence / origin('profile'|'demand') / status('pending'|'created'|'promoted'|'rejected'|'expired') /
created_at`。

候选表是 **L1 提案队列 + 去重台账 + 需求信号收集器**，不是批量上线通道。

## §5 阶段拆解

按团队派发纪律（`rules/common/dispatch-and-visibility.md`）按波次；**每波一个独立 PR + 独立计划**，
不合成一个大 PR。

### Wave 0 —— 语义深化声明面（独立小 PR，可并行）
- `dbt/semantics/l1_metrics.yml` 增：顶层 `entities:`（name/label/synonyms）+ 指标级 `entity` / `synonyms`
- **落库**（迁移加 `entity` / `synonyms` 列）+ `search_catalog` / `describe_metric` 消费
- 门禁 `scripts/check-data-models.mjs` 扩规则（键闭集、实体引用自洽）
- `sample_values` **不在本波**——由 W2 profiler 从真实数据产出（不手写）
- **验收**：`node scripts/check-data-models.mjs` 绿；问数搜同义词能命中对应指标

> 依据：行业正在集体补回实体/关系层（Databricks Genie Ontology、Fabric ontology、
> Snowflake relationships 一等公民）——多跳问题纯指标层表达不了。成本最低，收益最直接。

### Wave 1 —— 可信度地基（与 Wave 0 并行）
- `data.verified_questions`：`org / question / sql_or_params / result_digest / verified_by / verified_at / metric_ids[]`
- 采集器：从 `query_audit` + 会话轨迹把「用户认可的回答」固化（首版可人工标）
- 回归 job：口径变更后重跑已验问答，比对 `result_digest`
- 双臂 eval 脚本：有/无语义层对照（execution-match 判分）
- **验收**：任选 10 条已验问答，改一条口径 → 回归 job 准确报红；双臂脚本产出可复现数字

### Wave 2 —— 三档闭环（依赖 Wave 0 的声明字段做 label 生成）
- 迁移：`basis` / `archived_at` / `metric_candidates`（编号取**落库时的下一个可用值**；W0 已占用 031）
- 私有测度编译点（复用 `L1_SELECT_RE`）+ 三道闸
- Profiler：**duckle 管线**（`qa.profile` 原生组件）+ 三处登记面（管线/契约/排班 seed，
  见 `new-pipeline-three-registration-surfaces` 经验：merge→sync→seed→重启 console）
- Router + MCP 工具扩展（`propose_metrics_from_data` / `adopt_candidate`）
- console 候选池页
- **验收**：见 §6

### Wave 3 —— L1 提案自动化
- 扩展 `apply_pipeline_proposal`：piece 支持 `dbt/semantics/l1_metrics.yml` + 对应 dbt model
- 触发：`promotion_candidate` 或被多租户使用
- **验收**：一条私有测度 → 一键生成 draft PR，CI 全绿可达

### Phase 2 骨架（本期不做）
需求驱动挖掘：从 `askdata_stuck` + 用户追问序列挖「想要但词表没有」→ 候选。
**必须在 Wave 1 有真实数据后再写 spec**（YAGNI，同 #741 的节奏）。

## §6 验收判据

| 判据 | 怎么验 |
|---|---|
| **编译一致性** | 私有测度的 `select_sql` 必须过 `parseL1Select`（同一份解析器）；形状不符即拒 |
| **授权继承** | 单测：他租户查到 0 行；无 scope 403；掩码列按 L1 同规则生效 |
| **不破 B11** | 私有测度只允许单列聚合（无复合表达式）；复合走 L2；`basis='column_agg'` 不出现在任何 `ref` 解析路径 |
| **不撞 D6** | 修改已生效口径必产生 `draft_spec` 且不通知不发；新建才即时可用 |
| **真机** | 真实业务问题 → bot 当场创建 → 同租户另一用户可用 → 时钟注入 30 天后 archived |
| **Loan B 有效** | 双臂对照：有私有测度档 vs 无 → 首答即中率 / 探索动作次数（沿用 askdata-tuning 的 0–1 判据） |
| **标注** | 用 draft 口径的回答必带「草稿口径」徽标（真机截图验） |

## §7 风险与待裁决

| # | 事项 | 性质 |
|---|---|---|
| R1 | **掩码地基空转**：契约层目前**零列**声明 `sensitivity`（默认档未激活）。私有测度是新读路径，须同批补列级声明最小面 | **待裁决**；可用引擎 `qa.classify`（PII 启发式）产出**候选敏感性列**供人审，降低补声明成本 |
| R2 | **指标蔓延**：批量 profile 若绕过候选池直接建测度 → 数百条垃圾 | 设计已规避（§3 双来源分流） |
| R3 | **profile 成本**：全扫代价高 | 采样 + 周更 + 每关系上限 |
| R4 | **幻觉口径**：数字算对但业务含义错 | evidence 必展示 + draft 徽标 + 归属人 |
| R5 | **D6 边界澄清是否被接受** | 须评审确认（§2.1） |
| R6 | `basis` 与既有 `source='l2'` 的语义叠加：所有按 source 过滤的查询不受影响，但新增按 basis 的过滤点要一次找全 | 实施时 `grep -rn "basis"` 复查 |
| R7 | ~~marts 列取数通路未验~~ | ✅ 已验（§0.5 P1）：`information_schema.columns` 可读，marts 在 `staging` schema |
| R8 | **profiler 跨租户**（§0.5 P3）：min/max 也是数据事实，跨租户聚合即泄漏 | 按 org 逐租户跑（customSql 过滤），profile 落租户可见表 |
| R9 | ~~duckle 判停门未走~~ | ✅ 已走（§0.5 P2）：`qa.profile`/`qa.classify` 原生可用 ⇒ 自建 SQL 方案作废 |

## §8 架构文档同步项（架构先行）

实施前须先改 `docs/architecture.md`：

1. §2.x 指标面：补「私有测度 = L2 的 `basis='column_agg'` 变体」与三档表
2. **B11 口径单一定义**：补边界说明——私有测度是「列级聚合」不是「业务口径」，
   且不可被 L2 ref 引用（防第二实现）
3. §4.2 duckle 原生优先：登记本 spec 的判停结论——**profiler = `qa.profile` 管线（①引擎有）**，
   并注明「自写采样 SQL」属违反判停门，不得回退
4. 若 R5 被否决（全部走确认），§2.1 改为引用 D6 原文

## §9 非目标

- 不做跨表 join 自动发现
- 不做自由 SQL 查询面（现有 `query_metric` 受治理面不变）
- 不自动合并 L1 PR
- 不做形式化本体/RDF/推理机（调研已排除：通用 BI 无落地）
- 不引入 NVIDIA auto-ontology 服务（封闭治理、无生产案例、不吃 dbt manifest）
- 不做「个人级 → 租户级」的两级可见性状态机（YAGNI）

## 附录 A —— 调研依据（2026-11-04，一手来源为主）

| 方案 | 关键事实 | 一手来源 |
|---|---|---|
| Palantir Foundry Ontology | 运营本体（object/link/**action**），官方明言「不是语义层」；OSDK + Ontology MCP | palantir.com/docs/foundry/ontology/overview |
| Microsoft Fabric ontology | entity/relationship/metrics/rules/actions；**至今 preview**（2027-01 旧体验退役）；双层结构 ontology≠graph | learn.microsoft.com/fabric/iq/ontology/overview |
| dbt Semantic Layer | entities 仅四型（join 键+维度归属）；MCP server GA（七工具） | docs.getdbt.com/docs/build/entities |
| Cube | cube 即业务实体；MCP GA；`ai_context` 2000 字符**静默截断** | docs.cube.dev/docs/data-modeling/ai-context |
| Snowflake Cortex Analyst | relationships 一等公民；VQR 已验证查询复用；**GA 无节点**、90%+ 为自评 | docs.snowflake.com/user-guide/views-semantic/semantic-view-yaml-spec |
| Databricks Genie + UC | metric views GA 2026-04；trusted assets；Benchmarks 回归；Genie Ontology | docs.databricks.com/uc-semantics/metric-views |
| WrenAI | MDL（model/relationship/view/cube）与我们的 YAML 几乎同构；引擎侧 dry-plan 校验 | docs.getwren.ai/oss/reference/mdl |
| NVIDIA auto-ontology | Terms/SQL attributes/Relationships；**Generate→Certify→Answer**，人审强制；9 个只读 MCP 工具；不收外部 PR | github.com/NVIDIA/auto-ontology |

**结论**：行业收敛为两条路线——Palantir 式运营本体（写回/动作）与湖仓指标语义层（供 AI 问数）。
我们属后者；实体层是所有玩家正在回补的共同缺口，可信度验证（VQR/Benchmarks）是共同机制。
