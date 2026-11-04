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
| G1 | 新源/新租户接入后，**无需人工预先定义指标**，系统能在 N 小时内产出可用候选（覆盖 L1 已用关系的主要可聚合列） | 候选表首轮产出时间与覆盖率（数值在 W2 标定） | 未开始 |
| G2 | 用户问「词表没有但数据支持」的问题，**首答能给出结果**（draft 口径 + 证据），而不是「查不到」 | 真实会话抽样：此类问题首答产出率 | 未开始 |
| G3 | 任何数字都能回答：**出自哪条口径、哪一档可信度、谁创建/认证、数据截至何时** | 回答徽标覆盖率（抽样 100%） | 部分（新鲜度已有） |
| G4 | 使用 90 天后词表自增长，但 **certified 口径数量受控**（draft→certified 有审核、30 天淘汰生效），且**首答即中率 / 探索动作次数持续改善** | `metric-usage` 统计 + `askdata-tuning` 的 0–1 动作判据曲线 | 未开始 |
| G5 | 口径变更**可回归**：已验问答集覆盖核心问题，改口径后回归能准确报红 | 已验问答条数 + 回归命中率 | 进行中（W1，限本地夹具） |

**一句话**：不是「指标变多」，而是「每个数字都可信、可追溯、越用越准」。

## §2 能力地图（现状 → 目标）

| 能力 | 现状 | 目标 | 缺口 | 波次 |
|---|---|---|---|---|
| 指标口径单一定义 | ✅ `dbt/semantics/l1_metrics.yml` + B11 门禁 | 保持 | — | — |
| L2 组合 | ✅ B 中档算术树 + 唯一编译点 | 保持 | — | — |
| 私有测度（列级聚合） | ❌ 不存在（L2 只能组合 L1） | 新增档：`basis='column_agg'`，写入期编译成 L1 同形 | 编译器 + 白名单 + 生命周期 | W2 |
| 可信度分级 | ✅ `certified/draft`（027）+ 新建默认 draft 且可查 | 回答带徽标 | 输出标注 | W1/W2 |
| 使用统计 | ✅ `metric-usage.ts`（统计 + 零使用候选） | 30 天淘汰动作 | `archived_at` + 下线动作 | W2 |
| 实体/关系声明 | ❌ 无（L1 只有 grain） | `entities:` + 指标级 `synonyms`/`entity`（**落库可消费**） | 声明字段 + 门禁 + 词表读面 | W0 |
| 源数据画像 | ❌ 无（引擎有 `qa.profile`/`qa.classify`，未用） | duckle 管线产出 profile | 管线 + 登记面 | W2 |
| 验证/回归 | ❌ 无 | `verified_questions` + 回归 job + 双臂 eval | 全部 | W1 |
| L1 提案 | ✅ 管线/契约的 draft PR 通路（`apply_pipeline_proposal`） | 覆盖语义声明 + dbt model | 扩展 piece 路径白名单 | W3 |
| 需求挖掘 | ⚠️ 已有轨迹采集（#741 P1） | 从轨迹挖候选 | 挖掘器 | Phase 2 |

## §3 波次、依赖与出口判据

```
W0 实体与注释声明 ──┐
                    ├──▶ W2 三档闭环 ──▶ W3 L1 提案自动化 ──▶ Phase 2 需求挖掘
W1 可信度地基 ──────┘                     （依赖 W1 回归 + W2 升级信号）
```

| 波次 | 范围 | 入口条件 | **出口判据（全部满足才算完成）** |
|---|---|---|---|
| **W0** 实体与注释声明 | `entities:` + `synonyms` + `sample_values` + 门禁规则 | 无（可立即开工） | ① 门禁绿；② 词表产出含同义词/样本值；③ §5 台账已更新 |
| **W1** 可信度地基 | `verified_questions` 表 + 人工/自动双源采集 + 回归 job（结构+容差） | 无（可与 W0 并行） | ① 10 条已验问答改口径能报红；② 自动信号在小样本会话上强/弱/负三档判对；③ 台账已更新 |
| **W2** 三档闭环 | 私有测度档（编译/白名单/生命周期）+ duckle profiler + 候选表 + 路由 + MCP 工具 | W0 完成（label/同义词用于候选生成） | ① §6 验收全绿；② 真机走通「问→自动建→他人可用→30 天淘汰」；③ 台账已更新 |
| **W3** L1 提案自动化 | 扩展 `apply_pipeline_proposal` 到语义声明 + dbt model | W2 完成（有升级信号） | ① 一条私有测度→draft PR 可达；② CI 全绿；③ 台账已更新 |
| **Phase 2** 需求挖掘 | 从 `askdata_stuck` + 追问序列挖候选 | W1 有真实数据；W2 候选池在跑 | 单独 spec（不预先写） |

**波次计划文件索引**（写计划前先回读本文件）：
- W0 → `docs/superpowers/plans/2026-11-04-amd-w0-entities.md`（已写）
- W1 → `docs/superpowers/plans/2026-11-04-amd-w1-verified-questions.md`（已写）
- W2 → 待写（依赖 W0 完成）
- W3 → 待写（依赖 W2 完成）
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
| W1 | 进行中（实现完成，待 PR） | 2026-11-04 | — | 本地 PG 真机回归：`DATABASE_URL=postgres://localhost/ma_dev DATA_WAREHOUSE_URL=postgres://localhost/ma_dev npx tsx scripts/verify-regression.mjs --org w1-acceptance-org --limit 10` 基线 `total=10 pass=10` exit 0；改 `w1:test:by_branch` 口径（`sum(amount)*1.1`）后 `total=10 pass=6 fail=4 error=0` exit 1；还原后 `pass=10` exit 0。`pnpm -r test` exit 0（modules/data 759 passed / 396 skipped 等；W1 自身 DB 用例在该轮被 skip，带 `DATABASE_URL` 单独复跑 3 个文件 **42 passed**）；`pnpm run test:guard` 773 passed / 16 skipped；`pnpm run typecheck` 仅 `apps/web` 既有红（见备注⑤） | ① 真机重放用本地 `ma_dev` 兼作 `DATA_WAREHOUSE_URL` + `w1:test:*` 夹具（走真 `runQuery`/CLI，非注入替身），未在生产 marts 重放（部署后动作）；② 10 条已验问答经域函数 `upsertCandidate`+`setStatus` 写入，未走 HTTP（本机无 Casdoor 租户会话；路由另有 7 条 HTTP 测试）；③ OO 真流未验：`_search` 未用新只读凭据实测、`askdata_verified` 引号标识符仅类比验证（Task 5），待部署后 `--dry-run` 再正式跑；④ 部署前置未做（不在本任务）：`verify.py` 交付 `/var/lib/askdata/`、job env `ASK_VERIFY_ORG`、server 新增只读 `OO_READ_URL/ORG/TOKEN`（需用户点名）；⑤ `pnpm typecheck` 整体 exit 2，仅 `apps/web` 预存在红（#1197 console-menu ReactNode vs @types/react@18 bigint），W1 对 apps/web 零改动；⑥ 测试数据（tenant/metrics/vq/schema）已清理，无 L1 行 |
| W2 | 未开始 | — | — | — | — |
| W3 | 未开始 | — | — | — | — |
| Phase 2 | 未开始 | — | — | — | — |

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

## §7 变更记录（**append-only，只增不改**）

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-04 | 初版：确立终态 G1–G5、W0–W3 + Phase 2、防遗忘机制 | 用户诉求「整体规划、分步实施、不要实施一半忘了布局」 |
| 2026-11-04 | W0 去掉 `sample_values`，移到 W2 由 profiler 产出；W0 增加「落库 + 词表读面消费」 | `sample_values` 手写等于人凭想象编值（违反「不编」）；声明不落库就是死声明（`tier` 的教训），W0 必须闭环到可消费 |
| 2026-11-04 | W1 去掉「双臂 eval」，挪到 W2；W1 改为「人工/自动双源 + 结构容差回归」 | 双臂 eval 比较的是「有/无语义层」的生成质量；W1 的已验问答本就经语义层产生，此刻无对照意义。W2 引入候选生成后才具备对照条件 |

## §8 开工 / 收工清单

**开工（每波开始）**
- [ ] 读本文件 §1/§3/§5
- [ ] 命令核实当前代码状态（不信任台账）
- [ ] 读对应波次计划；若不存在，先写计划（writing-plans）
- [ ] 在 §5 把该波状态改为「进行中」+ 填开始日期

**收工（每波结束）**
- [ ] 出口判据逐条跑过，附证据（命令/截图/测试输出）
- [ ] §5 台账填完成日期 + PR + 证据
- [ ] 若与 §4 范围有偏离，写进台账「偏离与备注」
- [ ] 下一波入口条件是否已满足？满足则无需动作，不满足写进台账
