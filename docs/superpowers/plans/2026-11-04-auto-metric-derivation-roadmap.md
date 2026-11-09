# 源数据自动推导指标 + 可信度回路 —— 路线图（总图与台账）

> **本文件是本版块的唯一导航面。** 以后每个会话/每个实施者**先读这里**，再读对应波次的计划。
> - 「为什么 / 是什么 / 边界」的正典：`docs/superpowers/specs/2026-11-04-auto-metric-derivation-design.md`
> - 「这一波怎么做」：`docs/superpowers/plans/2026-11-04-amd-w<N>-*.md`（按波次单独写，写前必须回读本文件）
>
> **两条不可违反的维护规则**：
> 1. **布局只能通过 §7 变更记录改**——改范围/顺序/终态，必须先在 §7 写「改了什么、为什么」，再改正文。
> 2. **每波完成必须在同一个 PR 里更新 §5 台账**——不更新台账 = 这波没完成。

## §1 终态（「目的达成」的可判定形态）

> 状态：**已确认（2026-11-04）**。这五条是整个版块收敛的目标，任何一波都不许偏离。

| # | 终态判据 | 怎么量 | 现在 |
|---|---|---|---|
| G1 | 新源/新租户接入后，**无需人工预先定义指标**，系统能在 N 小时内产出可用候选（覆盖 L1 已用关系的主要可聚合列） | 候选表首轮产出时间与覆盖率（数值在 W2 标定） | **机制已建**（W2 profiler 首跑 83.9s / 21 关系 / 263 行；现库 L1 已用关系同为 21 条，**关系数相等≠覆盖率已标定**）；「主要可聚合列」覆盖率与「N 小时」**未标定**（profiler 落仓库库，标定需在数据侧统计） |
| G2 | 用户问「词表没有但数据支持」的问题，**首答能给出结果**（draft 口径 + 证据），而不是「查不到」 | 真实会话抽样：此类问题首答产出率 | **机制已建 + 有真机实例**：2026-11-05 bot 用 draft 私有测度（`lemeng:branch:order_count`）直接答出「门店订单数」，并按 #1417 支持按日期过滤；**首答产出率仍未做抽样度量**（有效样本 1） |
| G3 | 任何数字都能回答：**出自哪条口径、哪一档可信度、谁创建/认证、数据截至何时** | 回答徽标覆盖率（抽样 100%） | **机制完成**：新鲜度 / 口径 / 创建者已有；回答面 `metric.caliber`/`basis` 已上线（#1415），bot 真机回答带「草稿口径」；**徽标覆盖率未做抽样度量** |
| G4 | 使用 90 天后词表自增长，但 **certified 口径数量受控**（draft→certified 有审核、30 天淘汰生效），且**首答即中率 / 探索动作次数持续改善** | `metric-usage` 统计 + `askdata-tuning` 的 0–1 动作判据曲线 | **机制已建**（usage 统计 + `archived_at` 淘汰 + 归档 job + 候选池 276 pending）；90 天曲线**未开始**（需真实使用时间） |
| G5 | 口径变更**可回归**：已验问答集覆盖核心问题，改口径后回归能准确报红 | 已验问答条数 + 回归命中率 | **已完成（W1 + W6）**：生产 **50 条已验**（全部落在已封板 2026-10 整月），回归 `total=50 pass=50`，连跑两次逐条一致；回归 job 每日 04:10 |

| G6 | **语义完备**：每个 certified 指标都有实体归属，维度可从明细上卷到层级 | 实体绑定率 / 层级可上卷率 | **已完成（W4）**：实体绑定 **50/50 = 100%**（13 个对象各带权威源/对齐键/合并规则）；**3 组**维度层级（门店行政区划 / 商品 / 客户）由门禁校验；10 条不变量。**已知缺口**：战区层级（`region_l1`）等 `dim_lemeng_branch` 补契约 |
| G7 | **可回溯、不黑盒**：任一指标 5 分钟内能走到「口径原文 → 源表 → 上游模型」；体系健康四数可季度复评 | 回溯路径可用性 / 对账覆盖率 / 孤儿数 / 零使用指标 | **已完成（W5）**：体系地图在生产可用（山海 v195+）——健康五数、五视图、指标回溯链、移动端与深链；孤儿表 **0**（25 张 marts 全登记）、实体绑定 98%（私有测度待补 entity）、对账覆盖 98% |
| G8 | **可分析**：从「是多少」到「为什么 / 正常吗」，且结论可复算 | 锚点对账通过率 / 同一问题两次结论一致率 / 可辩护答案时长 | **已完成（W6，④ 待样本）**：`explore_query` / `explore_recipe` 生产可用；锚点对账 **50/50**；两次结论一致；可辩护答案时长**已接线**（迁移 039）但真实会话样本 0，面板如实显示「样本不足」 |

**一句话**：不是「指标变多」，而是「每个数字都可信、可追溯、越用越准」。

## §2 能力地图（现状 → 目标）

| 能力 | 现状 | 目标 | 缺口 | 波次 |
|---|---|---|---|---|
| 指标口径单一定义 | ✅ `dbt/semantics/l1_metrics.yml` + B11 门禁 | 保持 | — | — |
| L2 组合 | ✅ B 中档算术树 + 唯一编译点 | 保持 | — | — |
| 私有测度（列级聚合） | ✅ `basis='column_agg'` 已上线（W2）+ **`bizday` 可过滤**（#1417，其余维度未开参数） | 保持 | 其它维度的过滤参数（需先查列类型） | 待排期 |
| 可信度分级 | ✅ `certified/draft`（027）+ 新建默认 draft；移动端列表有徽标；**回答面 `metric.caliber`/`basis` 已上线（#1415）** | 回答带徽标 | —（2026-11-05 真机已验证，见 §5 W2 行） | — |
| 使用统计 | ✅ `metric-usage.ts` + `archived_at` 淘汰 + 归档 job（W2） | 保持 | — | — |
| 实体/关系声明 | ✅ `entities:` + `synonyms`/`entity` 已落库并消费（W0） | 保持 | — | — |
| 源数据画像 | ✅ duckle `qa.profile` 管线 + 周更排班（W2） | 保持 | — | — |
| 验证/回归 | ✅ `verified_questions` + 回归 job（16/16）；双臂已跑：A 臂 31/48=64.6%、B 臂 reachability matched=1 | 双臂模型实测 | **B 臂模型首答率待样本量累积** | 等数据 |
| L1 提案 | ✅ 已覆盖语义声明（W3）+ draft PR 端到端已验（#1413）；**「只改 synonyms」走键级编辑**（#1435，携带键/注释逐字保留） | 保持 | — | — |
| 租户语义自治 | ⚠️ 仅私有测度（列级聚合）与 L2 算术树；**不能覆盖平台口径**（写侧 409 + 读侧 L1 赢） | 租户可新建同等表达力声明、可覆盖平台口径，即时生效、不部署 | `basis='declared'` + `override_of` + loader 优先级 | **W8（新，2026-11-09）** |
| 实体与权威源 | ⚠️ 50 条 L1 仅 **2 条**有 `entity:`；无权威源矩阵 | 多源接入时实体可对齐、冲突可裁决 | `entities.yml` + 门禁 | W4 |
| 一致性维度与层级 | ❌ 语义层 **0 组**层级（`city/province/district/item_brand` 出现 0 次） | 4 组层级 + 跨源一致性维度 | `dimensions.yml` | W4 |
| 业务不变量 | ❌ **0 条**可执行业务规则 | 10 条（先数据验证再落测试） | `invariants.yml` + dbt tests | W4 |
| 可信度可观测 | ⚠️ 无面板（答不出「几条有对账、几条零使用」） | 四数 + 口径事故数，季度可复评 | 面板/页面 | W5 |
| 体系可回溯 | ❌ 无 | 业务可读 HTML 体系地图（仓内+运行库为事实源） | `system-map` 页面 | W5 |
| 自由探索分析 | ❌ 仅声明式 `query_detail` | 明细自由探索 + 分析配方 + 证据包 | `explore_query` + 配方 | W6 |
| 需求挖掘 | ✅ 人审需求台账 + 每日 job + 两工具（Phase 2）；对话侧读 **`askdata_trace`**（#1423）；实测 17 行/21 occ + `metric_hunt` 4 条；**首条 `alias_gap` 已自动消解**（补 synonyms → `resolved`，21→19） | 保持 | `new_metric`/`drill_gap` 仍需人工判断（口径/绑定要人写） | — |

## §3 波次、依赖与出口判据

```
W0 实体与注释声明 ──┐
                    ├──▶ W2 三档闭环 ──▶ W3 L1 提案自动化 ──▶ Phase 2 需求挖掘
W1 可信度地基 ──────┘                     （依赖 W1 回归 + W2 升级信号）

Phase 2 ──▶ W4 语义完备 ──▶ W5 治理可回溯 ──▶ W6 AI 分析层
            （接第二个源系统前必须完成）      （W4 过半即可并行）      （依赖 W4 + W5）
```

| 波次 | 范围 | 入口条件 | **出口判据（全部满足才算完成）** |
|---|---|---|---|
| **W0** 实体与注释声明 | `entities:` + `synonyms` + 门禁规则（`sample_values` 已移出，见 §7） | 无（可立即开工） | ① 门禁绿；② 词表产出含同义词（样本值由 W2 profiler 产出）；③ §5 台账已更新 |
| **W1** 可信度地基 | `verified_questions` 表 + 人工/自动双源采集 + 回归 job（结构+容差） | 无（可与 W0 并行） | ① 10 条已验问答改口径能报红；② 自动信号在小样本会话上强/弱/负三档判对；③ 台账已更新 |
| **W2** 三档闭环 | 私有测度档（编译/白名单/生命周期）+ duckle profiler + 候选表 + 路由 + MCP 工具 | W0 完成（label/同义词用于候选生成） | ① §6 验收（**「draft 徽标」已真机验证 #1415；「Loan B」= 可达性已证 matched=1、模型首答率待样本**，见 §5 偏离）；② 真机走通「问→自动建→他人可用」（30 天淘汰为机制+单测，**未走完真机周期**）；③ 台账已更新 |
| **W3** L1 提案自动化 | 扩展 `apply_pipeline_proposal` 到语义声明 + dbt model | W2 完成（有升级信号） | ① 一条私有测度 → **draft PR 真开成功**（#1413）；② CI 全绿；③ 台账已更新 |
| **Phase 2** 需求挖掘 | 从 `query_audit` 拒绝类 + `askdata_trace` 挖「想要但词表没有」→ **人审需求台账**（`askdata_stuck` 仅作证据附注） | W1 有真实数据；W2 候选池在跑 | ① 四类判定有真实案例 fixture + 单测；② 真机 job 产出真实行且重跑幂等；③ 台账工具可读/可否决；④ §5 台账已更新 |
| **W4** 语义完备 | `entities.yml`（对象/别名/**权威源**/对齐键/冲突规则）· 48 条 entity 绑定 · `dimensions.yml`（4 组层级 + 跨源一致性维度）· `invariants.yml`（10 条，**先数据验证再落测试**）· 接新源前置闸 | 无（**必须在接第二个源系统之前完成**） | ① certified 指标实体绑定 **100%**；② 4 组层级可从明细上卷；③ 每条不变量有 owner/执行位置/最近结果且验证通过（≥99% 期间成立）；④ 三表门禁上线（新源接入必填） |
| **W5** 治理可回溯 | 可信度面板（对账覆盖率/实体绑定率/零使用指标/未消解需求/口径事故数）· 体系地图页面（仓内+运行库为事实源）· 孤儿归零 · 候选池质量闸 | W4 过半（实体/层级就位） | ① 四数可查且季度可复评；② 任一指标 5 分钟内回溯到口径原文/源表/上游模型；③ 孤儿指标与孤儿表 = 0；④ 候选采用率可观测 |
| **W6** AI 分析层 | `explore_query`（只读 marts/掩码/限额/审计）· 三配方（方差分解/Top-N 贡献/基线异常）· 证据包契约（锚点+SQL+数据截至+对账）· 评估集 16→50+ | W4 完成 + W5 面板可用 | ① 锚点对账 **100%**（容差 0.1%）；② 同一问题两次结论方向一致；③ 评估集 ≥50 且回归全绿；④ 三个价值指标可观测（可辩护答案时长/接受率/口径事故数） |
| **W7** 跨对象与自进化 | 建模补键（retail 补 client_fid/item_num）· 关系声明 + explore join（只收有命中率证据的关系）· 租户级自进化（需求/候选/回归按 org）· 事件表（类型+时间，不做状态迁移） | W6 完成（已满足）+ 已接入源 | ① 补键后两键非空率/命中率 ≥95% 有数（达不到标部分可用）；② 3 类跨对象问题一次查得出且回包带 evidence；③ 单租户 30 天自转、平台零介入；④ 事件表可查、退货关联覆盖率如实证 |
| **W8** 租户语义自治 | 租户声明（`basis='declared'`，与 L1 同编译器/校验链）· 覆盖平台口径（`override_of`，草稿→确认）· loader 优先级改判 · 回答标注「本租户口径」 | W2/W3 完成（已有私有测度与提案链） | ① 双租户同 id 覆盖互不影响；② 新建/覆盖即时生效（无部署）；③ 坏声明六道校验全拒；④ 四通道一致性 + 租户隔离门禁绿；⑤ §5 台账已更新 |

**波次计划文件索引**（写计划前先回读本文件）：
- W0 → `docs/superpowers/plans/2026-11-04-amd-w0-entities.md`（已写）
- W1 → `docs/superpowers/plans/2026-11-04-amd-w1-verified-questions.md`（已写）
- W2 → `docs/superpowers/plans/2026-11-04-amd-w2-three-tier.md`（已写）
- W3 → `docs/superpowers/plans/2026-11-05-amd-w3-l1-proposal.md`（已写）
- Phase 2 → 单独 spec
- W4 → `docs/superpowers/plans/2026-11-06-amd-w4-semantics.md`（待写）
- W5 → `docs/superpowers/plans/2026-11-06-amd-w5-governance.md`（已写，PR #1452）
- W6 → `docs/superpowers/plans/2026-11-06-amd-w6-analysis.md`（已写，issue #1470）

**为什么这个顺序**：
- W0/W1 **互不依赖** ⇒ 可同波并行派发（波内不碰同一文件：W0 只动 `dbt/semantics/` + 门禁；W1 只动 `modules/data/` 新表与新域）。
- W2 必须在 W0 之后：候选的 `label/synonyms` 依赖 W0 的声明字段。
- W3 必须在 W2 之后：没有私有测度的热度信号就没有升级对象。
- Phase 2 最后：它的判据需要真实使用数据（先有 W1 的采集与 W2 的候选池）。

## §4 每波范围（含**明确不做**）

### W0 实体与注释声明
- **做**：顶层 `entities:`（name/label/synonyms）+ 指标级 `entity` / `synonyms`；门禁规则扩展；
  **落库**（迁移加 `entity`/`synonyms` 列）并让 `search_catalog` / `describe_metric` 消费。
- **不做**：`sample_values`（改由 W2 profiler 从真实数据产出，不手写）；图库、推理、跨实体自动 join；不改 `expression`/`grain` 语义。

### W1 可信度地基
- **做**：`verified_questions` 表；人工标注入口（API）；自动信号（强信号自动生效 / 弱信号待确认 / 负信号不入集）；
  回归 job（结构 + 相对容差）；OO 中转链路（bot 写 `askdata_verified`，平台只读凭据拉取）。
- **不做**：双臂 eval（挪到 W2——它比较「有/无语义层」的生成质量，W1 的已验问答本就源于语义层，此刻无对照意义）；
  自动判断「用户是否认可」的模型；console UI（先用 API + 脚本）。

### W2 三档闭环
- **做**：`basis`/`archived_at`/`metric_candidates`；私有测度编译点与三闸；duckle profiler 管线；候选池；MCP 工具；draft 徽标。
- **不做**：跨表 join 自动发现；个人级可见性状态机；自由 SQL。

### W3 L1 提案自动化
- **做**：`apply_pipeline_proposal` 扩展语义声明 + dbt model 的 piece；draft PR 自动生成。
- **不做**：自动合并；自动改已 certified 口径。

### Phase 2 需求挖掘
- **做**：从轨迹挖「想要但词表没有」→ 候选。
- **不做**：未定，单独 spec。

### W4 语义完备
- **做**：`entities.yml`（对象/别名/权威源/对齐键/冲突规则）+ 48 条 entity 绑定 + `dimensions.yml`（4 组层级 + 跨源一致性维度）+ `invariants.yml`（10 条，先数据验证再落测试）+ 接新源前置闸（三表 + 门禁）。
- **不做**：完整六视野本体；不做知识图谱/推理；不做 Data Vault。

### W5 治理可回溯
- **做**：可信度面板（对账覆盖率/实体绑定率/零使用指标/未消解需求/口径事故数）+ 体系地图页面（仓内声明 + 运行库为事实源，单文件 HTML，`data:query` 保护）+ 孤儿归零 + 候选池质量闸。
- **不做**：自建 BI；手绘/手工维护的图（必须可重新生成）；改造 console 为图编辑器。

### W6 AI 分析层
- **做**：`explore_query`（只读 marts、org 注入、掩码强制、行数/超时限额、全量审计）+ 三配方（方差分解 / Top-N 贡献 / 基线异常）+ 证据包契约（锚点 + SQL + 数据截至 + 对账）+ 评估集 16→50+。
- **不做**：让 agent 自由写任意 SQL 打 raw 表；无锚点的"自由发挥"；把分析结论自动写回指标。

### W8 租户语义自治（2026-11-09 新增）
- **做**：租户新建同等表达力声明（`basis='declared'`，与 L1 同编译器/校验链，即时生效）+ 覆盖平台口径（`override_of`，草稿→确认）+ `loadMergedCatalog` 优先级改判 + 回答标注「本租户口径」+ 双租户隔离验收。
- **不做**：平台 L1 的运行时直写与 repo 回收对账（另案）；租户收自由 SQL；跨租户共享租户指标；把租户声明写进 git。
- 设计：`docs/superpowers/specs/2026-11-09-tenant-semantic-autonomy-design.md`；可行性实测：`docs/superpowers/notes/2026-11-09-tenant-write-feasibility.md`。

## §5 进度台账（**每波完成必须更新**）

| 波次 | 状态 | 开始 | 完成 | PR / 证据 | 偏离与备注 |
|---|---|---|---|---|---|
| W0 | 已完成 | 2026-11-04 | 2026-11-04 | PR #1376 · CI 全绿（unit/gates/smoke/web/discipline）· 含 DB 1114 passed | 两处**预存在**红未修：`apps/web` typecheck（React bigint，另案）；`apps/server/loader.test.ts` 并发时序偶发红（隔离复跑绿） |
| W1 | 已完成 | 2026-11-04 | 2026-11-04 | PR #1379 · CI 全绿 · 部署 v685（commit 0a4dfa1a）· 生产库 `data.verified_questions` + 033 决策列已验 · 真机回归 10/10→改口径 4 红→还原 10/10 · Python 28 / Vitest 61 | 本地 PG 真机回归：`DATABASE_URL=postgres://localhost/ma_dev DATA_WAREHOUSE_URL=postgres://localhost/ma_dev npx tsx scripts/verify-regression.mjs --org w1-acceptance-org --limit 10` 基线 `total=10 pass=10` exit 0；改 `w1:test:by_branch` 口径（`sum(amount)*1.1`）后 `total=10 pass=6 fail=4 error=0` exit 1；还原后 `pass=10` exit 0。`pnpm -r test` exit 0（modules/data 759 passed / 396 skipped 等；W1 自身 DB 用例在该轮被 skip，带 `DATABASE_URL` 单独复跑 3 个文件 **42 passed**）；`pnpm run test:guard` 773 passed / 16 skipped；`pnpm run typecheck` 仅 `apps/web` 既有红（见备注⑤） | ① 真机重放用本地 `ma_dev` 兼作 `DATA_WAREHOUSE_URL` + `w1:test:*` 夹具（走真 `runQuery`/CLI，非注入替身），未在生产 marts 重放（部署后动作）；② 10 条已验问答经域函数 `upsertCandidate`+`setStatus` 写入，未走 HTTP（本机无 Casdoor 租户会话；路由另有 7 条 HTTP 测试）；③ OO 真流未验：`_search` 未用新只读凭据实测、`askdata_verified` 引号标识符仅类比验证（Task 5），待部署后 `--dry-run` 再正式跑；④ 部署前置未做（不在本任务）：`verify.py` 交付 `/var/lib/askdata/`、job env `ASK_VERIFY_ORG`、server 新增只读 `OO_READ_URL/ORG/TOKEN`（需用户点名）；⑤ `pnpm typecheck` 整体 exit 2，仅 `apps/web` 预存在红（#1197 console-menu ReactNode vs @types/react@18 bigint），W1 对 apps/web 零改动；⑥ 测试数据（tenant/metrics/vq/schema）已清理，无 L1 行；⑦ 终审修正 5 Important + 3 Minor 已修（drill 事件 W1 移出 / 用量统计排除 regression / 空基线拒绝确认 / 读面升 `data:manage` / 水位按轮龄 settle）；⑧ 已知 Minor 待硬化：损坏的水位文件被当作首跑（fail-silent），应改为 `SYNC_FAIL`；⑨ **OO 读凭据为 admin**（该版本无 RBAC，用户 2026-11-04 裁决维持现状，已知风险）；⑩ 摄入 job `custom:JOntLXLq4x4EgPIq` 每小时 :40；⑪ 水位在容器 `/tmp`，重建会回看 7 天重放（幂等，有小成本）；⑫ **强信号须过「像指标问题」过滤**（PR #1393；实测历史重放 strong 7→2）；⑬ 首轮 6 条脏数据（指令/附件/纠错）已 `rejected`；⑭ **2026-11-04 人工复核 38 条候选**：确认 15、拒绝 20、保留 3（口径讨论）；现 `verified=16` / `rejected=26` / `candidate=3`；回归 **16/16 pass** |
| W2 | 部分完成(见偏离) | 2026-11-04 | 2026-11-05 | PR #1398 · CI 全绿 · 部署山海 v184（ab5221fc）· 迁移 034/035 已验 · profiler seed 完成（首跑 ok 83.9s / 21 关系 / 本批 263 行）· 真机验收通过（候选→adopt→查询 401 行）· 归档 job `custom:efjBgqRgYyKPT6dU` 每日 03:30 · 双臂 A 臂 **31/48 = 64.6%**（2026-11-05 容器内实测：76 轮 / 业务 75 / 数据面 54；零探索且首答即中 30/48 = 62.5%；探索动作 mean=0.467、median=0、p90=1.6、有绕路 9 轮）· B 臂 reachability **matched=1 / A缺→B有=1**（真实新会话「门店订单数是多少」被私有测度点亮；模型首答率需更大样本） | ① profiler 落仓库库（pg_duckdb），平台经 DATA_WAREHOUSE_URL 读；② ORG 硬编码单租户；③ 静态 21 关系清单（有 check-profile-relations.mjs）；④ 明文 connections/pgduck.json（台账见 README §🔑）；⑤ 掩码旁路已修（MEASURE_MASKED/RELATION_MASKED fail-closed）；⑥ 低基数是候选规则非写入闸（spec 已订正）；⑦ **双臂已跑（2026-11-05）**：A 臂数字见证据列；B 臂跑 `reachability`（脚本默认模式）——把本轮真实新会话（`036c084d…`，124 事件）并入轨迹 + 契约「门店订单数是多少」→ `lemeng:branch:order_count` 后 **matched=1、A缺→B有=1**。**口径**：reachability 是上界不是模型首答率，且只有 1 个样本 ⇒ 「Loan B 有效」只算**初证**。⑧ **发现 W1 采集水位缺陷（issue #1419，本波不做）**：`export-transcript.py` 用全局 `seq` 做水位，而 `seq` **按 session 从 0 起** ⇒ 新会话被永久静默跳过（实测 13:36 的会话没进 OO，job 长期 `rows=0`）；B 臂那条新会话是**绕过水位、直接从 sqlite 导出**的。⑩ **私有测度可过滤（#1417，2026-11-05 真机）**：`compileColumnAgg` 现在按 `dims` 产出 `params`——`bizday` ⇒ `date_range`（其它维度不开，列类型未知不猜）；迁移 037 回填存量 `column_agg` 行；真机 `{bizday:{from:'2026-11-04',to:'2026-11-04'}}` ⇒ `ok / 402 行 / 9,495 单`（此前恒 `unknown_param:bizday`、只能给全时段累计）。⑨ **回答面 draft 徽标已真机验证（2026-11-05 21:36 CST）**：新建 draft 私有测度 `lemeng:branch:order_count`（候选 #12 采用，`basis=column_agg`），域级实查回包 `caliber=draft`/`basis=column_agg`/`tier=custom`；企微问 bot，openclaw 日志（13:36:37 UTC）显示回答含「草稿口径」标注 ⇒ 机制端到端成立；**偏差**：bot 把徽标写在正文首段而非「首行单独一行」，已收紧 SKILL 措辞（本 PR）待下次部署生效；**真机还暴露一个缺口**（独立 issue #1417）：私有测度只有 `group_by`、`params` 恒空 ⇒ 不能按 `bizday` 过滤，只能全时段累计 |
| W3 | 已完成 | 2026-11-05 | 2026-11-05 | PR #1402（squash `e6027001`，CI 全绿）· issue #1401 · commits `95a2015c`（组装器 `propose_metric_declaration`，零写入，工具面 8→9）/ `66c6b7f8`（apply 白名单扩 `dbt/semantics/l1_metrics.yml` 精确单文件 + `dbt/tests/**.sql`，YAML/SQL piece 重校验）/ `6152cd77`（`POST /metrics/candidates/:id/propose-l1`，零写盘）· **验证证据**（2026-11-05 本地实测）：`pnpm -r test` exit 0（modules/data 827 passed/476 skipped、apps/server 125 passed/248 skipped，其余 workspace 全绿）；带 `DATABASE_URL=postgres://localhost/ma_dev` 补跑 modules/data = **79 文件 / 1304 用例全绿** exit 0；`pnpm run test:guard` exit 0（**791 passed** / 16 skipped）；`pnpm run typecheck` exit 2 = **仅 `apps/web` 既有红**（console-menu ReactNode vs @types/react@18 bigint，W0 台账同款另案），被首败中断的 `modules/data`/`modules/notify` 单工程补跑 + `pnpm run typecheck:scripts` 全净；`check-mcp-toolface` / `check-data-models`（声明指标 50）/ `check-data-plane-lock` 三门禁 OK；**真机草案演练**（真实仓 dbt 树副本，非仓内文件）：`composeMetricDeclaration` create+modify 两档 piece 覆盖副本后跑 `checkDataModels` 纯核 = **零违规**，同名同义重提如实拒，仓内零写入（git status clean）· **部署+真机验收**（2026-11-05 山海 v185 `e6027001`）：容器产物四查 OK（`propose-metric.ts` 在场 / tools 8→9 / apply 头注两档白名单 / manifest 107 行声明 propose-l1）；生产候选 #2（origin=profile，`fct_branch_day_activity`，count_distinct(bizday) × [system_book,branch_num]）**domain 级全链**（容器内复刻路由组装映射，零写盘）：无 auditSql ⇒ 单 YAML piece + gate ⑦ downstream `required` + validation 注记；带 auditSql ⇒ YAML + `dbt/tests/lemeng/audit_lemeng__retail__bizday_count_distinct.sql` 双 piece（`:`→`__` 映射正确）；新条目字典序落位（`lemeng:retail:bizday_count_distinct` 排 `sales` 前）、现行 58960B → piece 59293B（只多该条）；apply 侧重校验 `semanticsYamlPieceIssues` 对**真实现行文件** = 零 issues |① **dbt 新 model 不在 v1**：升级对象是已有 marts 列聚合，不需要新 model；新 model 需求出现再议（计划 Self-Review 已登记）；② **audit test 不自动生成**（gate ⑦ 不旁路）：提案输入带 `auditSql` 才成 piece，缺席 ⇒ downstream `required` + validation 注记——draft PR 合并前红是**特性**（复算测试人写才是对账真身）；③ **dim-less 候选不可升级**：grain 非空是 L1 声明硬约定，路由不代选维度（400 回 issues 指导）；④ 评审缓办 Minor（Task1 插入位「字典序」vs 域内聚待业务裁决、回读校验未覆盖全部键、`REL_REF_RE` 与 `ratioShapeError` 两份正则无同形锁；Task2 未触碰区按解析值面比对（注释/格式改动不检出）、同 path 重复 piece 后写者胜；Task3 `defaultSla` 取同关系首条非 min/max、修改档测试依赖 fixture 形状）——**部署已执行**（2026-11-05 山海 v185 `e6027001`，既有自动链路：无新迁移 / 无新 env / 无数据面投递；compose 探活告警为已知假阳性形态，容器 4/4 running）；L1 词表物化走既有日 job `custom:tuQ06mlxBe_2TlTo`（04:33 UTC，#300 边界：物化的是镜像快照，自动部署升级实例后新声明才进词表；要立即生效可手动触发该 job）；⑤ **apply 的 GitHub 半程已于 2026-11-05 真机打通**：用户点名配了 `DATA_MCP_GITHUB_TOKEN`（细粒度 PAT，仅 `MYTech-Co-LTD/platform-core` 一仓、Contents + Pull requests 读写、2027-02-03 到期，存 openship 项目 env isSecret）。打通后发现 applier 只支持「新文件 / 内容一致」，对已存在文件的修改恒判 `proposal_conflict` ⇒ L1 声明**结构上永远应用不了**；已开 issue #1411 并修（piece 增 `baseSha256` 三态：基线未变则允许更新并带远端 sha，基线被改仍拒绝），PR #1412 合并部署。**真机验收**：`origin=profile` 候选 → compose（`PIECE_BASE a86860eb…`）→ apply ⇒ `ok`，**draft PR #1413 真开成功**（2 commit：`dbt/semantics/l1_metrics.yml` + `dbt/tests/lemeng/audit_lemeng__retail__bizday_count_distinct.sql`），核对 `isDraft=true`、文件清单正确后关闭 PR 并删分支（验收产物不入库）；⑥ **HTTP 端点未走真会话**（本机无 Casdoor 租户真人会话，与 W1/W2 同法：路由 403/404/409 分支由 HTTP 测试覆盖，真机走 domain 级全链）|
| Phase 2 | 已完成 | 2026-11-05 | 2026-11-05 | PR #1407（squash `178c42d0`，CI 全绿）· 部署山海 **v186** · 每日 job `custom:4eM6UfhB2ANodSJ_`（UTC 21:10 = CST 05:10，失败告警接既有通知通道）· issue #1404 · spec #1405 · 计划 #1406 · commits `0f6cb7ae`（迁移 036 + 台账存储层：`data.demand_signals` / `data.demand_mining_state`）/ `847b09cf`（四类纯判定器）/ `de298549`（挖掘编排 + CLI）/ `3021138f`（manage 面两工具，预算 9→11）/ 4 个 fix commit（审阅整改）· **验证证据**：`domain/demand` + manage 两路由测试 **70 passed**（含真库 4 例）；`pnpm run typecheck:scripts` 与模块 `tsc --noEmit` 均净；`check-mcp-toolface: OK`（MANAGE_TOOLS 11，序列化 6841B） | ① 四类判定全部机判零阈值（`alias_gap` 不足三段才按末段匹配 / `new_metric` / `drill_gap` / `metric_hunt` ≥2 结构判据），每条有生产真实案例 fixture；② **测试探针必须排除**（实测 4 条假需求混在真数据里：`verify-` / `mcp-probe-` / `w1:test` / `test-`）；③ **水位入 DB 且排他**（`query_audit` 按本批 max 推、对话流写 max 不写 max+1——+1 有 1µs 盲区）；④ OO 分页 `total` 权威、`MAX_PAGES` 超限抛错；⑤ 对话流列名是 `session_id`（真机实测 `sessionid` 会 400）；⑥ 已知边界（见 spec §8）：conv 只覆盖 openclaw 会话、探针前缀是白名单、resolved 基于 L1 词表快照（L2 裸名会误判 `new_metric`）、`metric_hunt` 只在单批内分组（跨轮会话不命中）、`detail` 顶层 jsonb 合并不累积数组；⑦ 缓办 follow-up 见 SDD 台账（含 upsert 与写水位非原子、stuck 30 天全窗口 >100k 行会硬失败）——**建 job 前必须真机确认 OO_READ_* 在容器 env 且分页 >1000 行可用** —— **已确认并真机验收（2026-11-05 山海 v186）**：容器内 `OO_READ_URL/ORG/TOKEN` + `PLATFORM_ORG` 齐备、迁移 036 两表建成、代码与脚本在 `/app`；首跑 summary `scanned=24 alias=3 new_metric=4 drill=14 hunt=0 skipped_probe=3 cursor_audit=5624`，表内 17 行 / 21 occurrences（别名缺口 `retail:net_sales`×2 + `net_sales`×1、真缺 `retail:target`/`sales:target`/`line_count`/`sale_line_count`、下钻缺口 11 项含 `outbound:net_amount`×3）；**再跑一次 `scanned=0`、occurrences 不变（水位幂等成立）**；工具面域级真机：`list_demand_signals` 按 occurrences 降序 + `truncated=false`、`dismiss` → `already_dismissed` 回原信息、默认列表隐藏已否决（16 vs includeDismissed 17）、非法 kind → `refused/bad_kind`（验收用的那条已恢复未否决）；job 手动 run `success` exit 0。⑧ ~~`hunt=0` 是预期~~ **订正（2026-11-05 当晚查明）**：`hunt=0` 当时被误判为「没有样本」，实际是**两个真缺口叠在一起**——① W1 导出水位用全局 `seq`（新会话 seq 从 0 起 ⇒ 永久跳过，issue #1419）；② 挖掘器读的 `askdata_conv` 自 10-16 起就冻结了（issue #1423）。两者修完后 `hunt` 由 0 → **4**（见 §5「修复批次」行）。教训：**「没有数据」与「数据没进来」必须先区分开**；⑪ **`alias_gap` 已可全自动（2026-11-06）**：#1427→#1433（修改模式认 synonyms）+ #1434→#1435（键级编辑，携带键/注释逐字保留）⇒ 真机 `net_sales`（最复杂条目）只改 synonyms **`ok=true`**；配 #1412 的 apply 三态，可完成「台账需求 → 提案 → draft PR」全自动（仍需人 review 合并）。⑩ **首条真实需求闭环（2026-11-05/06）**：`alias_gap` 两条（`net_sales` ×1、`retail:net_sales` ×2）→ 给 `lemeng:retail:net_sales` 补 synonyms（PR #1428）→ 词表物化（job `custom:tuQ06mlxBe_2TlTo` 手动跑，**更新 1**）→ 台账 `resolvedOf` 自动判定 **两条均 resolved=true（`synonym@lemeng:retail:net_sales`）**，默认清单 **21→19**。这是「需求挖掘 → 人工处置 → 台账自动消解」的第一次完整闭环。**已知限制**：`propose_metric_declaration` 修改模式要求 definition 必变 ⇒ 「只加同义词」走不了提案链（issue #1427），本次走人工 PR。⑨ **CI 自动部署只到 mytech 实例**（`proj_v0QZ68VYDc0pkFxL` / mytech.hookflow.cn），山海实例按既有口径手动部署（本次 v186）|
| **W4** 语义完备 | 已完成 | 2026-11-06 | 2026-11-06 | PR #1448（squash `2d1ea879`，CI 全绿）· issue #1447（计划 `2026-11-06-amd-w4-semantics.md`）· commits `bf65456c`（实体字段扩 + check-semantics）… `0ebc4c68`（接新源闸）· **真机/证据**：① 实体 **2/50 → 50/50（100%）**，13 个对象各带 `system_of_record`/`identity_keys`/`merge_rule`/`owner`；② 维度 3 组（门店行政区划 / 商品 / 客户），门禁校验「relation 有契约 + 层级列真实存在 + 末级=key + 键唯一」；③ 不变量 10 条**逐条在仓库库上跑**：6 条 0 违反、3 条 <1%（verified/warn）、**1 条 9.14% 违反（`contribution_expense_nonneg`——费用冲减为负是业务常态，规则本身错）⇒ observing，不生成测试**；已生成 9 个 dbt singular test；④ 接新源闸：`check-semantics --new-source <sys>`（未挂对象即拒）+ collect-source A 段前置 + CI 三门（check-semantics / gen-invariant-tests --check） | ① **实体正典不另建文件**：W0 已在 `l1_metrics.yml` 顶层 `entities:`，本波只扩字段（曾误建 entities.yml，被 check-data-models 当场拦下后删除）；② **战区层级未声明**：`region_l1 → region_name → branch_num` 的列在 dbt 派生维 `dim_lemeng_branch`，**没有契约可校验**，按「未知 ≠ 没有」留缺口，待该维补契约；③ 不变量验证脚本在容器内人工跑（`verify-invariants.mjs` 需 `DATA_WAREHOUSE_URL`，本机无仓库库）；④ 全量门禁：`check-semantics`（entities 13/dimensions 3/invariants 10）、`check-data-models`、`gen-invariant-tests --check`、`test:guard`、`typecheck:scripts` 全绿 |
| **W5** 治理可回溯 | 已完成 | 2026-11-06 | 2026-11-06 | PR **#1460**（squash `654480d6`，CI 全绿：unit/gates/smoke/web/discipline）· issue #1455 · 计划 `2026-11-06-amd-w5-governance.md`（PR #1452）· commits `22a49314`（健康五数纯函数 + 5 单测）/ `b46701b7`（体系地图：五视图 + SVG 二部图 + 深链 + 移动端）/ `bde3b785`（375px 版式修正）· 新增 `dbt/semantics/table-owners.yml`（25 张 marts 全登记 ⇒ 孤儿表 0）· **本地验证**：`modules/data` 全量 **920 passed / 480 skipped**、`test:guard` **814 passed**、门禁 `check-manifests`/`lint-architecture`/`check-compose`/`check-env-example`/`check-integrations`/`check-data-models`/`check-semantics`/`check-data-plane-lock` + `gen-invariant-tests --check` **全 OK**；真机渲染（本地库 acme 租户）：marts 25 张 / 孤儿 0 / 待处置候选 0 · **移动端 375×667 实测（Edge CDP 设备模拟）**：`scrollWidth=375=innerWidth`（无横向滚动）、底部 4 标签各 94/93px 且高 56px（≥44）、卡片单列、指标详情深链 `#/metrics/<id>` 直达且「← 返回」在位 | ① 口径正文的轻量 Markdown（`**加粗**`/反引号代码）改由 `richText` 转 `strong/code` 渲染（此前原样显示星号，业务面不可读）；② 页面零外链、零新依赖，动态文本全走 `textContent`（测试断言全文无 `innerHTML`）；③ 候选池质量只统计不处置，本机库无 pending 行 ⇒ 真实噪声占比待山海实例观察；④ **`apps/web` typecheck 既有红仍是另案**（console-menu `ReactNode` vs `@types/react` bigint，在干净树上同样复现，非本波引入）；⑤ 体系地图分支 `feat/system-map`（issue #1443）已被本波实现取代（该分支未合并）|
| **W6** AI 分析层 | 已完成（出口判据 ①②③ 达标；④ 部分：答案时长未接入） | 2026-11-06 | 2026-11-06 | issue #1470 / #1484 / #1493 / #1497 / #1502 · 计划 PR #1471 · 代码 #1476（`39d200b5`）· 修 #1480（`8ffa8eae`）· 基线刷新 #1494（`25c7616b`）· 评估集 v2 #1501（`65ff6ff8`）· 部署山海 **v197 → v200**（末次 dep_-I3l4J69UcfUtZRC，4/4 服务成功） · **① 锚点对账**：50/50 条评估集与基线一致（`verify-regression` **total=50 pass=50 fail=0 error=0**，连跑两次同结果）；**② 两次一致**：同一批连跑两次，逐条结果完全相同（0 条状态翻转）；**③ 评估集 50 条**：全部落在**已封板**区间（2026-10 整月），`verified=50 / stale=24 / candidate=4 / rejected=26`；**④ 价值指标**：接受率 **95.2%（99/104）**、口径事故 5 可算；可辩护答案时长**已接入**（迁移 039 `query_audit.session_id` + 企微 `x-session-id` + 插件透传），当前真实会话样本 0 ⇒ 面板如实显示「样本不足」，不画 0 | ① **真机连抓三个缺陷并全修**：列清单查错库（#1479）、基线过期无刷新机制（#1493）、滚动窗口基线 30 分钟自红（#1497）；② **上一批 24 条滚动窗口行已软退役**（`status='stale'`，不删行，审计留痕）；③ 评估集窗口纪律：**只用封闭历史区间**，滚动窗口留给看板；入库闸 `open_period_not_stable` 已在代码里；④ `explore_query`/`explore_recipe` 已在生产可用（山海 v197+），真机冒烟见上文 |
| **W7** 跨对象与自进化 | 进行中（Task 1–4 完成；回归 49/49 已恢复；仅剩 30 天自转观察） | 2026-11-07 | — | **Task 1 证据**（PR #1534 `ba618d39` + 真机物化）：`fct_retail_item_sale` 当日 **7,221 行 = 源侧去重组合数 7,221**；`item_num` 对维表命中 **1,858/1,858 = 100%**（`exists` 口径）；`fct_retail_sale` **219 行 / net 434,857.09 逐分未变**（口径未触碰）；首建全历史 7,423,662 行 / 767 天约 13 分钟。**新发现**：`stg_lemeng_item` ≈43 行/商品（非唯一）⇒ 商品关系是 **N:M**，声明必须带去重口径，否则 join 放大 ~40 倍。**Task 2 证据**（join 接线 + 三用例，真机）：门店/商品/客户三条关系全部 verified；**单列键会跨账套串表**——门店单日 202→14,292 行（70×）、商品 7,867→8,785 行（+11.7%），补 `keys:[system_book]` + `latest_snapshot` 后三个用例**金额逐分守恒**（89,559.50 / 551,477.12 / 146,681,225.46）；客户有键行命中 **44,793/44,793 = 100%**（transfer 行 client_fid 恒 NULL）。**Task 3 开工前验证（2026-11-07，真机）**：① `askdata_trace`/`askdata_stuck` **无租户字段**（16/8 字段）⇒ conv 侧只能按「部署单租户」归因；② 两部署均 `TENANT_MODE=single`、各 1 租户；数据层已按 org 隔离（audit 7,875 / candidates 278 / signals 45 / verified 104 / state 2）；③ **回归腿连续 3 天红**（11-05/06/07）：`#3` 滚动窗口 `params={}` 结构性不稳、`#1723` 业务 `value` 未变仅标识列 `branch_num` sum 漂移；④ `rowCount` 恒截 1000 不能替代行集信号；⑤ job failed **不进站内 deliveries**（100 条中 `job.*=0`），数据面单出口是 OO `data_plane_probes`→企微；⑥ 基线刷新**已有 CLI**（#1494）但 dry-run **仍写库**（domain 无 write 开关）。⇒ Task 3 范围修订为**多 org + 评估集卫生 + 判定分级 + verdict 可见性**（spec `2026-11-07-tenant-selfdriving-design.md`）。**Task 3 落地（PR #1589）**：`demand-mining --org/--all-tenants`（失败隔离；conv 单租户护栏）；`apply-eval-set` 拒 `default`；`compare` 增 `warns`（value/结构=fail、标识列=warn、无 value 列 fail-closed）；`emit-probe.py` 投 OO `data_plane_probes`；并发现/修复 `refresh-baseline` 的 dry-run 仍写库（domain 增 `write?: boolean`）。**Task 3 上线实测（v203 `30c71d7c`）**：`--all-tenants` → `org=shanhaiyiguo-org conv=ok`；#3 置 stale（回归集 50→49）；#1723 fail→pass+warn；回归 job 已投 OO `data_plane_probes`（手动 run 末行 `已投递 … RED`，OO 可查）。**上线后出现 10 条 value 漂移**（10 月出库类；源侧 `transfer_out` 在 11-06T23:45Z 重采 + mart 重建）⇒ 受控刷新 9 条 + #1723，回归终态 **49/49 pass、0 warn**；途中发现 ingest 静默覆盖基线（无 by/reason），已修 #1596 并真机探针验证。**Task 4 证据**：`fct_order_event` incremental（首建 30 天，`SELECT 524,562` 行 / 69s）；类型分布审计 15157/69/9/32、粒度唯一、ref 覆盖 201/15,267 全 PASS；演示 `2026-10-20` 四类事件时间窗可查。全历史 CTAS 会把仓库打进 recovery（已记录为降级边界）。**Task 4 上线（PR #1601 `fdfe6ed`）**：数据面 `SYNC_OK 388/388`；**生产检出**增量 build **PASS=11 WARN=0 ERROR=0**（142s）；表 **524,562 行**（2026-10-08..11-07）。**2026-11-08 复核**：`fct_order_event` **549,763 行**（10-08..11-08，增量正常）；10-20 审计仍全过（类型 15157/69/32/9、行级重复 0、ref 覆盖 201/15,267）。回归 11-08 04:10Z 曾红 **34/49（15 fail，contribution/expense/region 结构性变化，系数据面增量改造在飞）**；**2026-11-09 复核：数据面修复生效后仅剩 #1723（order_count +0.31% 数据漂移），已受控刷新 → 49/49 pass、0 warn，job 投递 OK**。观察起点 2026-11-07，7 天对照 **2026-11-14**。 | issue #1530 · 计划 PR #1531（squash `d55e90e4`）· 计划 `docs/superpowers/plans/2026-11-07-amd-w7-cross-object.md` · **立项前的实测证据**：门店关系 **571,626/571,626 = 100%** 命中；`fct_retail_sale` **无 `client_fid` / `item_num`**（跨对象问题的真堵点 = 建模缺键）；单日 9,361 单中 **0 单**有多状态 ⇒ 状态迁移不可重建、事件只做「类型+时间」；跨月聚合致仓库 recovery 30s ⇒ 明细探索按日切片 + 15s 超时 | ① **范围收缩**：未接入的源**不在本次范围**（接源归 Orca `pipe-migrate` 线）；② 关系只收命中率 ≥95% 且带 `evidence`，不许给缺失键造关系；③ 事件不推断因果；④ Task 1 的第一件事是核实源侧键是否存在（有则补、无则登记缺口）|
| **W8** 租户语义自治 | 进行中（P0–P2 代码完成；待部署 + 双租户真机验收） | 2026-11-09 | — | P0 PR #1720（`fa97b84`）：041 迁移 + loader 覆盖优先级 + 三面 `override` 标注；P1 PR #1723（`030abff`）：编译器抽取 + `POST /metrics/declarations` + 六道校验；P2 PR #1724：`override` 草稿→确认→生效（D6）。本地 `modules/data` **95 文件 / 1496 用例全绿**（含 8 条纯核 + 5 条路由用例）。设计 `docs/superpowers/specs/2026-11-09-tenant-semantic-autonomy-design.md` · 可行性实测 `docs/superpowers/notes/2026-11-09-tenant-write-feasibility.md`（本地 `ma_dev` + 真代码路径：运行时写**即时可见**、同一校验器可复用、`EXPLAIN` 可做写前校验、现行 loader 丢弃同 id L2、L1 job 只碰 `org='platform'` 不会冲租户行） | 覆盖平台口径要改「L1 赢」优先级（`metric-store.ts` 合并分支）与写侧 `ID_RESERVED_BY_L1`（仅对专用覆盖操作放行）；平台 L1 运行时直写**不在本波**；租户声明不进 git，灾备依赖平台库备份 |
| **修复批次**（跨波） | 已完成 | 2026-11-05 | 2026-11-05 | #1411 → PR #1412（applier 三态：基线未变才允许更新；真机 draft PR #1413）· #1419 → PR #1421（导出/归因/验证三脚本水位改 `(created_at, seq)` 复合游标；投递 `SYNC_OK 327/327`；job 补采 **23 条**、`weak=1` 入集）· #1423 → PR #1422（挖掘器对话流 `askdata_conv`→`askdata_trace`；`hunt` **0→4**）· #1417 → PR #1424 + 迁移 037（私有测度按 `dims` 产出 `params`，`bizday`⇒`date_range`；真机 **402 行 / 9,495 单**）· #1427 → PR #1433（修改模式改为「definition 或 synonyms 至少一个变」）· #1434 → PR #1435（只改 synonyms 走**键级编辑**：携带键/注释逐字保留；真机 `net_sales` ⇒ `ok=true`，注释与 `detail` 均在） | ① **流程自报**：PR #1422 在 discipline/gates 双红时被合入（body 缺 `Closes #N`；free 私仓无服务端保护，`gh pr merge` 不拦红），已补 issue #1423 登记，并把「命令成功 ≠ 绿灯」写入记忆；② 三个缺陷都是**静默**型（水位跳过新会话 / 流冻结 / 参数空），靠「回路三查」（§6-8）才暴露；③ 待办：B 臂模型实测（等样本）、`#1417` 其它维度的过滤参数（需先查列类型）|

**状态取值**：`未开始` / `进行中` / `已完成` / `部分完成(见偏离)` / `已取消(见变更记录)`。
**偏离登记**：任何缩水、跳过、延后，写进「偏离与备注」列——**不许静默丢**。

## §6 防遗忘机制（每条都是动作）

1. **开工第一步**：重读本文件 §1（终态）+ §3（当前波次的入口/出口）+ §5（真的没做过吗）。
2. **开工第二步**：用命令验证台账声称的现状（例：`grep -rn "basis" modules/data`、`ls dbt/semantics/`），不信任台账文本。
3. **每波一个 PR**：DoD 含「更新 §5 台账」，写在 PR 描述里。
4. **改布局先改 §7**：范围/顺序/终态变更，先写变更记录再改正文。
5. **计划头部强制引用**：每份 `2026-11-04-amd-w<N>-*.md` 头部写明「本计划对应 roadmap §3 的 W<N>」。
6. **入口可见**：`AGENTS.md` 文档地图加一行指向本文件（让下一个会话找得到）。
7. **跨会话记忆**：agent 侧记忆索引加一条指针（不复制正文）。
8. **回路「真的在进数」三查**（2026-11-05 事故沉淀，缺一不可）：
   - **水位模型**：增量游标是否是**全局单调**的？（`seq` 按 session 从 0 起 ⇒ 全局水位会永久跳过新会话，issue #1419）
   - **流是否活**：读的那个 OO 流**最近一条的时间戳**是不是新的？（`askdata_conv` 冻结了一个月，issue #1423）
   - **参数是否可用**：回包字段能不能支撑业务问法？（私有测度 `params` 空 ⇒ 只能全时段累计，issue #1417）
9. **「已完成」= 出口判据逐条有**真机**证据**：单测/绿 CI 只能证明「代码没坏」，证明不了「功能在用」。本轮 W2/W3 各有一条判据靠这条才被发现未满足。
10. **放宽判定规则前，先用仓库里最复杂的真实样本回归**：#1427 放宽后，在 `net_sales`（带 `detail`/注释）上才暴露 `#1434` 的组装缺陷——fixture 太干净会放过它。改规则 = 拿真文件跑一遍。

## §7 变更记录（**append-only，只增不改**）

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-04 | 初版：确立终态 G1–G5、W0–W3 + Phase 2、防遗忘机制 | 用户诉求「整体规划、分步实施、不要实施一半忘了布局」 |
| 2026-11-04 | W0 去掉 `sample_values`，移到 W2 由 profiler 产出；W0 增加「落库 + 词表读面消费」 | `sample_values` 手写等于人凭想象编值（违反「不编」）；声明不落库就是死声明（`tier` 的教训），W0 必须闭环到可消费 |
| 2026-11-04 | W1 去掉「双臂 eval」，挪到 W2；W1 改为「人工/自动双源 + 结构容差回归」 | 双臂 eval 比较的是「有/无语义层」的生成质量；W1 的已验问答本就经语义层产生，此刻无对照意义。W2 引入候选生成后才具备对照条件 |
| 2026-11-05 | Phase 2 收窄为「人审需求台账」：**不进** `metric_candidates` 候选池；信号面改为 `query_audit` 拒绝类 + `askdata_conv`，`askdata_stuck` 仅作证据附注 | 30 天只有 9 个真实会话，自动聚类没有可校准阈值的案例（「无案例不立标准」）；且需求 ≠ 该建——写进候选池会污染 W2 的推导/淘汰口径。spec #1405 |
| 2026-11-05 | W2 / W3 状态由「已完成」改为「部分完成(见偏离)」 | 出口判据未全满足：W2 双臂 B 臂未做、回答面 draft 徽标未落地；W3 未真开过 draft PR（未配 PAT）。代码/部署/真机主链均在，缺的是判据本身——标「已完成」会让地图失真 |
| 2026-11-05 | W3 状态由「部分完成」回到「已完成」 | 出口判据①已真机满足：配 PAT（用户点名）+ 修 #1411（applier 三态）+ 真开出 draft PR #1413 |
| 2026-11-05 | Phase 2 对话流由 `askdata_conv` 改为 `askdata_trace`（事实订正，不动布局） | 实测 `askdata_conv` 自 10-16 起无写入（566 行冻结），活流是 `askdata_trace`；不改则 `metric_hunt` 永远无样本（issue #1423） |
| 2026-11-05 | §5 台账新增**「修复批次」行类别**（跨波缺陷的集中登记） | 本轮 4 个缺陷横跨 W1/W2/Phase 2（#1411/#1419/#1423/#1417），塞进各自波次行会淹没主证据；单列一行便于「这版块最近修了什么」一眼看到 |
| 2026-11-06 | **新增 W4/W5/W6 三波**（语义完备 / 治理可回溯 / AI 分析层）与终态 **G6–G8** | 用户即将接入第二个源系统：多源下「同名不同源、跨系统事件链、口径打架」必须事先定义，否则形成乱麻。W4 是接入前置闸；W5 治「黑盒/不可回溯」（用户明确诉求）；W6 把治理成果转成分析能力。三波均按「证据优先」排序：语义（已证缺口 48/50）→ 治理（已证缺口：无面板）→ 分析（依赖前两者）。完整六视野本体**不在**本规划内，放量条件见 §7 同条：≥3 源互联 / 跨域分析 / 审计要求 |
| 2026-11-06 | §2/§6 增「`alias_gap` 全自动」现状与「放宽规则前先用最复杂真实样本回归」 | #1427 放宽后只在 `net_sales` 上暴露 `#1434`；干净 fixture 没有此形态，教训要写成动作 |
| 2026-11-05 | §6 增「回路三查」与「出口判据须有真机证据」两条动作 | 本轮三次「看起来在工作、实际空转」（水位/冻结流/参数都静默），只有按这三查才暴露 |
| 2026-11-05 | W2 的「draft 徽标」判据：机制落地（#1415），截图待补 | `query_metric` 回包新增 `metric.caliber`/`basis`，bot SKILL 规定 draft ⇒ 回答首行「⚠️ 草稿口径」。判据原文要求「真机截图验」，生产当前无 live draft 测度 ⇒ 截图需先建一条再问 bot，故 W2 仍为部分完成 |
| 2026-11-05 | 修正 §3 的 W0 出口判据：删「样本值」 | 与 §4 及本条 2026-11-04 变更记录矛盾（`sample_values` 已移出 W0，改由 W2 profiler 产出） |

## §8 开工 / 收工清单

**开工（每波开始）**
- [ ] 读本文件 §1/§3/§5
- [ ] 命令核实当前代码状态（不信任台账）
- [ ] 读对应波次计划；若不存在，先写计划（writing-plans）
- [ ] 在 §5 把该波状态改为「进行中」+ 填开始日期

**收工（每波结束）**
- [ ] 出口判据逐条跑过，附证据（命令/截图/测试输出）
- [ ] **每条判据都要有真机证据**（不只是单测/绿 CI）；判据做不到真机验的，明确写「未验 + 原因」
- [ ] 数据面回路跑一次「三查」（§6-8：水位模型 / 流是否活 / 参数可用）
- [ ] §5 台账填完成日期 + PR + 证据
- [ ] 若与 §4 范围有偏离，写进台账「偏离与备注」
- [ ] 下一波入口条件是否已满足？满足则无需动作，不满足写进台账
| 2026-11-07 | **新增 W7「跨对象与自进化」四件，并明确范围收缩** | 验证驱动：① 门店关系实测 **571,626/571,626 = 100%** 命中；② `fct_retail_sale` **无 client_fid / item_num**（跨对象问题的真堵点是建模缺键，不是缺关系表）；③ 事件验证：单日 9,361 单中 **0 单**有多状态 ⇒ **状态迁移不可重建**，事件只能做「类型+时间」表；④ 明细表跨月聚合曾把仓库打进 recovery（30s），已改为单日切片 + 15s 超时。**范围收缩（用户 2026-11-07 裁决）**：未接入的源**不在本次开发范围**——只做已接入源上的建模与探索，接源仍由平台管线线（Orca `pipe-migrate`）承担。 |
| 2026-11-07 | **W7 Task 3 范围修订**：由「多 org 参数化」扩为 **多 org + 评估集卫生 + 判定分级 + verdict 可见性** 四件 | 开工前真机验证（spec `2026-11-07-tenant-selfdriving-design.md` V1–V8）：多 org 只是小改动；真正让 30 天判据不成立的是「回归腿每日必红（滚动窗口基线 + 标识列求和）」与「红不可见（job 通知不进站内 feed）」。故先让环路可信/可执行/可见，再谈租户扩展。不改 fail 级语义：只新增 warn 级，`value` 缺席时 fail-closed。 |
| 2026-11-09 | **新增 W8「租户语义自治」**：租户可新建同等表达力声明（`basis='declared'`）+ 覆盖平台口径（`override_of`），即时生效、不部署；改「L1 撞名时 L1 赢」的读侧优先级 | 用户裁决「租户可以写，每家租户情况不一样」。可行性已实测：运行时写即时可见、同一校验器可复用、L1 job 不碰租户 org（不会冲掉）。平台 L1 运行时直写与 repo 回收对账**不做**（拆到另案），以免为租户自主权引入 clobber 风险。 |
