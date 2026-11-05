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
| G5 | 口径变更**可回归**：已验问答集覆盖核心问题，改口径后回归能准确报红 | 已验问答条数 + 回归命中率 | **已完成（W1）**：生产 16 条已验，回归 job 每日 04:10，16/16 pass |

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
| L1 提案 | ✅ 已覆盖语义声明（W3）+ draft PR 端到端已验（#1413） | 保持 | — | — |
| 需求挖掘 | ✅ 人审需求台账 + 每日 job + 两工具（Phase 2）；对话侧读 **`askdata_trace`**（#1423）；实测 17 行/21 occ + `metric_hunt` 4 条 | 保持 | — | — |

## §3 波次、依赖与出口判据

```
W0 实体与注释声明 ──┐
                    ├──▶ W2 三档闭环 ──▶ W3 L1 提案自动化 ──▶ Phase 2 需求挖掘
W1 可信度地基 ──────┘                     （依赖 W1 回归 + W2 升级信号）
```

| 波次 | 范围 | 入口条件 | **出口判据（全部满足才算完成）** |
|---|---|---|---|
| **W0** 实体与注释声明 | `entities:` + `synonyms` + 门禁规则（`sample_values` 已移出，见 §7） | 无（可立即开工） | ① 门禁绿；② 词表产出含同义词（样本值由 W2 profiler 产出）；③ §5 台账已更新 |
| **W1** 可信度地基 | `verified_questions` 表 + 人工/自动双源采集 + 回归 job（结构+容差） | 无（可与 W0 并行） | ① 10 条已验问答改口径能报红；② 自动信号在小样本会话上强/弱/负三档判对；③ 台账已更新 |
| **W2** 三档闭环 | 私有测度档（编译/白名单/生命周期）+ duckle profiler + 候选表 + 路由 + MCP 工具 | W0 完成（label/同义词用于候选生成） | ① §6 验收（**「draft 徽标」已真机验证 #1415；「Loan B」= 可达性已证 matched=1、模型首答率待样本**，见 §5 偏离）；② 真机走通「问→自动建→他人可用」（30 天淘汰为机制+单测，**未走完真机周期**）；③ 台账已更新 |
| **W3** L1 提案自动化 | 扩展 `apply_pipeline_proposal` 到语义声明 + dbt model | W2 完成（有升级信号） | ① 一条私有测度 → **draft PR 真开成功**（#1413）；② CI 全绿；③ 台账已更新 |
| **Phase 2** 需求挖掘 | 从 `query_audit` 拒绝类 + `askdata_trace` 挖「想要但词表没有」→ **人审需求台账**（`askdata_stuck` 仅作证据附注） | W1 有真实数据；W2 候选池在跑 | ① 四类判定有真实案例 fixture + 单测；② 真机 job 产出真实行且重跑幂等；③ 台账工具可读/可否决；④ §5 台账已更新 |

**波次计划文件索引**（写计划前先回读本文件）：
- W0 → `docs/superpowers/plans/2026-11-04-amd-w0-entities.md`（已写）
- W1 → `docs/superpowers/plans/2026-11-04-amd-w1-verified-questions.md`（已写）
- W2 → `docs/superpowers/plans/2026-11-04-amd-w2-three-tier.md`（已写）
- W3 → `docs/superpowers/plans/2026-11-05-amd-w3-l1-proposal.md`（已写）
- Phase 2 → 单独 spec

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

## §5 进度台账（**每波完成必须更新**）

| 波次 | 状态 | 开始 | 完成 | PR / 证据 | 偏离与备注 |
|---|---|---|---|---|---|
| W0 | 已完成 | 2026-11-04 | 2026-11-04 | PR #1376 · CI 全绿（unit/gates/smoke/web/discipline）· 含 DB 1114 passed | 两处**预存在**红未修：`apps/web` typecheck（React bigint，另案）；`apps/server/loader.test.ts` 并发时序偶发红（隔离复跑绿） |
| W1 | 已完成 | 2026-11-04 | 2026-11-04 | PR #1379 · CI 全绿 · 部署 v685（commit 0a4dfa1a）· 生产库 `data.verified_questions` + 033 决策列已验 · 真机回归 10/10→改口径 4 红→还原 10/10 · Python 28 / Vitest 61 | 本地 PG 真机回归：`DATABASE_URL=postgres://localhost/ma_dev DATA_WAREHOUSE_URL=postgres://localhost/ma_dev npx tsx scripts/verify-regression.mjs --org w1-acceptance-org --limit 10` 基线 `total=10 pass=10` exit 0；改 `w1:test:by_branch` 口径（`sum(amount)*1.1`）后 `total=10 pass=6 fail=4 error=0` exit 1；还原后 `pass=10` exit 0。`pnpm -r test` exit 0（modules/data 759 passed / 396 skipped 等；W1 自身 DB 用例在该轮被 skip，带 `DATABASE_URL` 单独复跑 3 个文件 **42 passed**）；`pnpm run test:guard` 773 passed / 16 skipped；`pnpm run typecheck` 仅 `apps/web` 既有红（见备注⑤） | ① 真机重放用本地 `ma_dev` 兼作 `DATA_WAREHOUSE_URL` + `w1:test:*` 夹具（走真 `runQuery`/CLI，非注入替身），未在生产 marts 重放（部署后动作）；② 10 条已验问答经域函数 `upsertCandidate`+`setStatus` 写入，未走 HTTP（本机无 Casdoor 租户会话；路由另有 7 条 HTTP 测试）；③ OO 真流未验：`_search` 未用新只读凭据实测、`askdata_verified` 引号标识符仅类比验证（Task 5），待部署后 `--dry-run` 再正式跑；④ 部署前置未做（不在本任务）：`verify.py` 交付 `/var/lib/askdata/`、job env `ASK_VERIFY_ORG`、server 新增只读 `OO_READ_URL/ORG/TOKEN`（需用户点名）；⑤ `pnpm typecheck` 整体 exit 2，仅 `apps/web` 预存在红（#1197 console-menu ReactNode vs @types/react@18 bigint），W1 对 apps/web 零改动；⑥ 测试数据（tenant/metrics/vq/schema）已清理，无 L1 行；⑦ 终审修正 5 Important + 3 Minor 已修（drill 事件 W1 移出 / 用量统计排除 regression / 空基线拒绝确认 / 读面升 `data:manage` / 水位按轮龄 settle）；⑧ 已知 Minor 待硬化：损坏的水位文件被当作首跑（fail-silent），应改为 `SYNC_FAIL`；⑨ **OO 读凭据为 admin**（该版本无 RBAC，用户 2026-11-04 裁决维持现状，已知风险）；⑩ 摄入 job `custom:JOntLXLq4x4EgPIq` 每小时 :40；⑪ 水位在容器 `/tmp`，重建会回看 7 天重放（幂等，有小成本）；⑫ **强信号须过「像指标问题」过滤**（PR #1393；实测历史重放 strong 7→2）；⑬ 首轮 6 条脏数据（指令/附件/纠错）已 `rejected`；⑭ **2026-11-04 人工复核 38 条候选**：确认 15、拒绝 20、保留 3（口径讨论）；现 `verified=16` / `rejected=26` / `candidate=3`；回归 **16/16 pass** |
| W2 | 部分完成(见偏离) | 2026-11-04 | 2026-11-05 | PR #1398 · CI 全绿 · 部署山海 v184（ab5221fc）· 迁移 034/035 已验 · profiler seed 完成（首跑 ok 83.9s / 21 关系 / 本批 263 行）· 真机验收通过（候选→adopt→查询 401 行）· 归档 job `custom:efjBgqRgYyKPT6dU` 每日 03:30 · 双臂 A 臂 **31/48 = 64.6%**（2026-11-05 容器内实测：76 轮 / 业务 75 / 数据面 54；零探索且首答即中 30/48 = 62.5%；探索动作 mean=0.467、median=0、p90=1.6、有绕路 9 轮）· B 臂 reachability **matched=1 / A缺→B有=1**（真实新会话「门店订单数是多少」被私有测度点亮；模型首答率需更大样本） | ① profiler 落仓库库（pg_duckdb），平台经 DATA_WAREHOUSE_URL 读；② ORG 硬编码单租户；③ 静态 21 关系清单（有 check-profile-relations.mjs）；④ 明文 connections/pgduck.json（台账见 README §🔑）；⑤ 掩码旁路已修（MEASURE_MASKED/RELATION_MASKED fail-closed）；⑥ 低基数是候选规则非写入闸（spec 已订正）；⑦ **双臂已跑（2026-11-05）**：A 臂数字见证据列；B 臂跑 `reachability`（脚本默认模式）——把本轮真实新会话（`036c084d…`，124 事件）并入轨迹 + 契约「门店订单数是多少」→ `lemeng:branch:order_count` 后 **matched=1、A缺→B有=1**。**口径**：reachability 是上界不是模型首答率，且只有 1 个样本 ⇒ 「Loan B 有效」只算**初证**。⑧ **发现 W1 采集水位缺陷（issue #1419，本波不做）**：`export-transcript.py` 用全局 `seq` 做水位，而 `seq` **按 session 从 0 起** ⇒ 新会话被永久静默跳过（实测 13:36 的会话没进 OO，job 长期 `rows=0`）；B 臂那条新会话是**绕过水位、直接从 sqlite 导出**的。⑩ **私有测度可过滤（#1417，2026-11-05 真机）**：`compileColumnAgg` 现在按 `dims` 产出 `params`——`bizday` ⇒ `date_range`（其它维度不开，列类型未知不猜）；迁移 037 回填存量 `column_agg` 行；真机 `{bizday:{from:'2026-11-04',to:'2026-11-04'}}` ⇒ `ok / 402 行 / 9,495 单`（此前恒 `unknown_param:bizday`、只能给全时段累计）。⑨ **回答面 draft 徽标已真机验证（2026-11-05 21:36 CST）**：新建 draft 私有测度 `lemeng:branch:order_count`（候选 #12 采用，`basis=column_agg`），域级实查回包 `caliber=draft`/`basis=column_agg`/`tier=custom`；企微问 bot，openclaw 日志（13:36:37 UTC）显示回答含「草稿口径」标注 ⇒ 机制端到端成立；**偏差**：bot 把徽标写在正文首段而非「首行单独一行」，已收紧 SKILL 措辞（本 PR）待下次部署生效；**真机还暴露一个缺口**（独立 issue #1417）：私有测度只有 `group_by`、`params` 恒空 ⇒ 不能按 `bizday` 过滤，只能全时段累计 |
| W3 | 已完成 | 2026-11-05 | 2026-11-05 | PR #1402（squash `e6027001`，CI 全绿）· issue #1401 · commits `95a2015c`（组装器 `propose_metric_declaration`，零写入，工具面 8→9）/ `66c6b7f8`（apply 白名单扩 `dbt/semantics/l1_metrics.yml` 精确单文件 + `dbt/tests/**.sql`，YAML/SQL piece 重校验）/ `6152cd77`（`POST /metrics/candidates/:id/propose-l1`，零写盘）· **验证证据**（2026-11-05 本地实测）：`pnpm -r test` exit 0（modules/data 827 passed/476 skipped、apps/server 125 passed/248 skipped，其余 workspace 全绿）；带 `DATABASE_URL=postgres://localhost/ma_dev` 补跑 modules/data = **79 文件 / 1304 用例全绿** exit 0；`pnpm run test:guard` exit 0（**791 passed** / 16 skipped）；`pnpm run typecheck` exit 2 = **仅 `apps/web` 既有红**（console-menu ReactNode vs @types/react@18 bigint，W0 台账同款另案），被首败中断的 `modules/data`/`modules/notify` 单工程补跑 + `pnpm run typecheck:scripts` 全净；`check-mcp-toolface` / `check-data-models`（声明指标 50）/ `check-data-plane-lock` 三门禁 OK；**真机草案演练**（真实仓 dbt 树副本，非仓内文件）：`composeMetricDeclaration` create+modify 两档 piece 覆盖副本后跑 `checkDataModels` 纯核 = **零违规**，同名同义重提如实拒，仓内零写入（git status clean）· **部署+真机验收**（2026-11-05 山海 v185 `e6027001`）：容器产物四查 OK（`propose-metric.ts` 在场 / tools 8→9 / apply 头注两档白名单 / manifest 107 行声明 propose-l1）；生产候选 #2（origin=profile，`fct_branch_day_activity`，count_distinct(bizday) × [system_book,branch_num]）**domain 级全链**（容器内复刻路由组装映射，零写盘）：无 auditSql ⇒ 单 YAML piece + gate ⑦ downstream `required` + validation 注记；带 auditSql ⇒ YAML + `dbt/tests/lemeng/audit_lemeng__retail__bizday_count_distinct.sql` 双 piece（`:`→`__` 映射正确）；新条目字典序落位（`lemeng:retail:bizday_count_distinct` 排 `sales` 前）、现行 58960B → piece 59293B（只多该条）；apply 侧重校验 `semanticsYamlPieceIssues` 对**真实现行文件** = 零 issues |① **dbt 新 model 不在 v1**：升级对象是已有 marts 列聚合，不需要新 model；新 model 需求出现再议（计划 Self-Review 已登记）；② **audit test 不自动生成**（gate ⑦ 不旁路）：提案输入带 `auditSql` 才成 piece，缺席 ⇒ downstream `required` + validation 注记——draft PR 合并前红是**特性**（复算测试人写才是对账真身）；③ **dim-less 候选不可升级**：grain 非空是 L1 声明硬约定，路由不代选维度（400 回 issues 指导）；④ 评审缓办 Minor（Task1 插入位「字典序」vs 域内聚待业务裁决、回读校验未覆盖全部键、`REL_REF_RE` 与 `ratioShapeError` 两份正则无同形锁；Task2 未触碰区按解析值面比对（注释/格式改动不检出）、同 path 重复 piece 后写者胜；Task3 `defaultSla` 取同关系首条非 min/max、修改档测试依赖 fixture 形状）——**部署已执行**（2026-11-05 山海 v185 `e6027001`，既有自动链路：无新迁移 / 无新 env / 无数据面投递；compose 探活告警为已知假阳性形态，容器 4/4 running）；L1 词表物化走既有日 job `custom:tuQ06mlxBe_2TlTo`（04:33 UTC，#300 边界：物化的是镜像快照，自动部署升级实例后新声明才进词表；要立即生效可手动触发该 job）；⑤ **apply 的 GitHub 半程已于 2026-11-05 真机打通**：用户点名配了 `DATA_MCP_GITHUB_TOKEN`（细粒度 PAT，仅 `MYTech-Co-LTD/platform-core` 一仓、Contents + Pull requests 读写、2027-02-03 到期，存 openship 项目 env isSecret）。打通后发现 applier 只支持「新文件 / 内容一致」，对已存在文件的修改恒判 `proposal_conflict` ⇒ L1 声明**结构上永远应用不了**；已开 issue #1411 并修（piece 增 `baseSha256` 三态：基线未变则允许更新并带远端 sha，基线被改仍拒绝），PR #1412 合并部署。**真机验收**：`origin=profile` 候选 → compose（`PIECE_BASE a86860eb…`）→ apply ⇒ `ok`，**draft PR #1413 真开成功**（2 commit：`dbt/semantics/l1_metrics.yml` + `dbt/tests/lemeng/audit_lemeng__retail__bizday_count_distinct.sql`），核对 `isDraft=true`、文件清单正确后关闭 PR 并删分支（验收产物不入库）；⑥ **HTTP 端点未走真会话**（本机无 Casdoor 租户真人会话，与 W1/W2 同法：路由 403/404/409 分支由 HTTP 测试覆盖，真机走 domain 级全链）|
| Phase 2 | 已完成 | 2026-11-05 | 2026-11-05 | PR #1407（squash `178c42d0`，CI 全绿）· 部署山海 **v186** · 每日 job `custom:4eM6UfhB2ANodSJ_`（UTC 21:10 = CST 05:10，失败告警接既有通知通道）· issue #1404 · spec #1405 · 计划 #1406 · commits `0f6cb7ae`（迁移 036 + 台账存储层：`data.demand_signals` / `data.demand_mining_state`）/ `847b09cf`（四类纯判定器）/ `de298549`（挖掘编排 + CLI）/ `3021138f`（manage 面两工具，预算 9→11）/ 4 个 fix commit（审阅整改）· **验证证据**：`domain/demand` + manage 两路由测试 **70 passed**（含真库 4 例）；`pnpm run typecheck:scripts` 与模块 `tsc --noEmit` 均净；`check-mcp-toolface: OK`（MANAGE_TOOLS 11，序列化 6841B） | ① 四类判定全部机判零阈值（`alias_gap` 不足三段才按末段匹配 / `new_metric` / `drill_gap` / `metric_hunt` ≥2 结构判据），每条有生产真实案例 fixture；② **测试探针必须排除**（实测 4 条假需求混在真数据里：`verify-` / `mcp-probe-` / `w1:test` / `test-`）；③ **水位入 DB 且排他**（`query_audit` 按本批 max 推、对话流写 max 不写 max+1——+1 有 1µs 盲区）；④ OO 分页 `total` 权威、`MAX_PAGES` 超限抛错；⑤ 对话流列名是 `session_id`（真机实测 `sessionid` 会 400）；⑥ 已知边界（见 spec §8）：conv 只覆盖 openclaw 会话、探针前缀是白名单、resolved 基于 L1 词表快照（L2 裸名会误判 `new_metric`）、`metric_hunt` 只在单批内分组（跨轮会话不命中）、`detail` 顶层 jsonb 合并不累积数组；⑦ 缓办 follow-up 见 SDD 台账（含 upsert 与写水位非原子、stuck 30 天全窗口 >100k 行会硬失败）——**建 job 前必须真机确认 OO_READ_* 在容器 env 且分页 >1000 行可用** —— **已确认并真机验收（2026-11-05 山海 v186）**：容器内 `OO_READ_URL/ORG/TOKEN` + `PLATFORM_ORG` 齐备、迁移 036 两表建成、代码与脚本在 `/app`；首跑 summary `scanned=24 alias=3 new_metric=4 drill=14 hunt=0 skipped_probe=3 cursor_audit=5624`，表内 17 行 / 21 occurrences（别名缺口 `retail:net_sales`×2 + `net_sales`×1、真缺 `retail:target`/`sales:target`/`line_count`/`sale_line_count`、下钻缺口 11 项含 `outbound:net_amount`×3）；**再跑一次 `scanned=0`、occurrences 不变（水位幂等成立）**；工具面域级真机：`list_demand_signals` 按 occurrences 降序 + `truncated=false`、`dismiss` → `already_dismissed` 回原信息、默认列表隐藏已否决（16 vs includeDismissed 17）、非法 kind → `refused/bad_kind`（验收用的那条已恢复未否决）；job 手动 run `success` exit 0。⑧ ~~`hunt=0` 是预期~~ **订正（2026-11-05 当晚查明）**：`hunt=0` 当时被误判为「没有样本」，实际是**两个真缺口叠在一起**——① W1 导出水位用全局 `seq`（新会话 seq 从 0 起 ⇒ 永久跳过，issue #1419）；② 挖掘器读的 `askdata_conv` 自 10-16 起就冻结了（issue #1423）。两者修完后 `hunt` 由 0 → **4**（见 §5「修复批次」行）。教训：**「没有数据」与「数据没进来」必须先区分开**；⑨ **CI 自动部署只到 mytech 实例**（`proj_v0QZ68VYDc0pkFxL` / mytech.hookflow.cn），山海实例按既有口径手动部署（本次 v186）|
| **修复批次**（跨波） | 已完成 | 2026-11-05 | 2026-11-05 | #1411 → PR #1412（applier 三态：基线未变才允许更新；真机 draft PR #1413）· #1419 → PR #1421（导出/归因/验证三脚本水位改 `(created_at, seq)` 复合游标；投递 `SYNC_OK 327/327`；job 补采 **23 条**、`weak=1` 入集）· #1423 → PR #1422（挖掘器对话流 `askdata_conv`→`askdata_trace`；`hunt` **0→4**）· #1417 → PR #1424 + 迁移 037（私有测度按 `dims` 产出 `params`，`bizday`⇒`date_range`；真机 **402 行 / 9,495 单**） | ① **流程自报**：PR #1422 在 discipline/gates 双红时被合入（body 缺 `Closes #N`；free 私仓无服务端保护，`gh pr merge` 不拦红），已补 issue #1423 登记，并把「命令成功 ≠ 绿灯」写入记忆；② 三个缺陷都是**静默**型（水位跳过新会话 / 流冻结 / 参数空），靠「回路三查」（§6-8）才暴露；③ 待办：B 臂模型实测（等样本）、`#1417` 其它维度的过滤参数（需先查列类型）|

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
