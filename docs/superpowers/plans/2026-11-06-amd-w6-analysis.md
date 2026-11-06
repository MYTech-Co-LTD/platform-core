# W6 AI 分析层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 对应路线图 §3 的 **W6**（终态 G8）：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`。
> 开工前重读路线图 §1（G8）、§3（W6 出口判据）、§5（W5 已完成：体系地图/健康五数已在生产 v195 可用），并**用命令核实**。

**Goal:** 把「是多少」推进到「为什么 / 正常吗」——agent 的每个结论都带**可复算的证据包**，口径与数据截至写在包里，而不是靠模型自述。

**Architecture:** 不新开执行路径。`explore_query` 是**受约束的只读聚合器**：只接受结构化 spec（表/度量/维度/过滤/排序/上限），标识符必须命中运行时 `information_schema.columns`，恒定注入 `org`，掩码与整值掩码关系 fail-closed，行数/超时限额，每次查询写 `data.query_audit`。三配方（方差分解 / Top-N 贡献 / 基线异常）只是**把业务问题编译成 explore spec 的纯函数**，执行仍走同一条缝。证据包是分析结果的标准外壳，锚点对账用既有回归核心复算。

**Tech Stack:** 既有 `analystPool`（只读事务 + `statement_timeout=30s`）+ `pg` 参数化查询；纯函数域层 + Hono 工具注册；不引新依赖、不新增执行引擎。

## Global Constraints

- **不接受自由 SQL**：`explore_query` 的入参是结构化 spec，**没有任何字段承载 SQL 文本**；SQL 由 `compileExplore()` 从白名单列拼装，值一律走参数占位符。
- **只读**：只走 `analystPool`（`warehouse.ts:52-58` 每条连接 `default_transaction_read_only=on`）；不写任何业务表，只写审计。
- **租户隔离恒拼 `org = $1`**：目标表必须在 `information_schema.columns` 里有 `org` 列；没有 ⇒ 拒绝（`NO_ORG_COLUMN`），**不猜、不含糊放行**。
- **掩码 fail-closed**：复用 `private-measure.ts` 的 `maskedTargets()` 与 `relationHasWholeValueMask()`——命中值级掩码的列拒用，有整值掩码的关系整表拒用。
- **限额**：`limit` 默认 200、上限 `MAX_QUERY_ROWS = 1000`（`authz.ts:165`）；`statement_timeout=30s`；返回 `truncated` 标记。
- **全量审计**：成功/拒绝/出错都写 `data.query_audit`，`tool='explore_query'`（列已在迁移 `021_query_audit_tool.sql`）；被拒的 spec 只落 `reason`，**不落完整 spec 文本**（防止把用户的自由文本塞进审计）。
- **证据包必须可复算**：同一 `(metric, params, slicing, 数据截至)` 重放两次得到同一数值；包里带 `sql` 与 `asOf`，任何人可拿去复跑。
- **分析结论不写回指标**：本波不新增任何「把分析结果变成指标」的路径（那是人工走 W3 proposal 的事）。
- **工具面预算**：`ANALYST_FACE_MAX_TOOLS = 14`（`toolbox/registry.ts:24`），当前 11 ⇒ 本波只加 **2 个**（`explore_query` / `explore_recipe`），到 13，留 1 个余量。

---

### Task 1: 证据包契约 + 锚点对账（纯函数）

**Files:**
- Create: `modules/data/domain/analysis/evidence.ts`
- Test: `modules/data/domain/analysis/evidence.test.ts`

**Interfaces:**
```ts
export interface EvidenceAnchor {
  metricId: string
  params: Record<string, unknown>
  slicing: { dimensions?: string[]; filters?: Record<string, unknown>; limit?: number }
  /** 锚点数值（由 runQuery 的真实结果填入；不是估计值） */
  value: number | null
}

export interface EvidencePack {
  anchor: EvidenceAnchor
  /** 实际执行的 SQL（参数已内联成可复跑形态时用 `sqlPreview`，原样占位符用 `sql`） */
  sql: string
  sqlPreview: string
  /** 数据截至：来自 freshness 面的水位（`query-service.ts:82`），null = 未知（不冒充最新） */
  dataAsOf: string | null
  freshness: { status: 'fresh' | 'stale' | 'unknown'; slaDays: number | null }
  caliber: {
    tier: 'certified' | 'draft'
    basis: 'l1_tree' | 'column_agg'
    certifiedBy: string | null
    version: number | null
  }
  reconcile: { auditFile: string | null; status: 'ok' | 'missing' | 'unknown' }
  generatedAt: string
}

/** 锚点对账：|current - baseline| / max(|baseline|, 1e-9) <= tolerance */
export function anchorMatches(baseline: number | null, current: number | null, tolerance?: number): boolean
export function buildEvidencePack(input: EvidenceInput): EvidencePack
```

- [ ] **Step 1: 写失败测试**（4 例：包里含锚点/口径/截至；`dataAsOf` 未知时为 null 而非现在时间；容差 0.1% 边界：`|Δ|/|b| = 0.001` 通过、`0.0011` 不通过；`reconcile.missing` 不冒充 ok）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现纯函数**（无 IO；`tolerance` 默认 `0.001`）
- [ ] **Step 4: 测试通过 + `cd modules/data && pnpm exec tsc --noEmit`**
- [ ] **Step 5: 提交**

---

### Task 2: `explore_query`（受约束只读聚合器）

**Files:**
- Create: `modules/data/domain/analysis/explore.ts`（spec 校验 + SQL 编译，纯函数）
- Create: `modules/data/domain/analysis/explore-exec.ts`（执行 + 掩码 + 审计装配）
- Test: `modules/data/domain/analysis/explore.test.ts` / `explore-exec.test.ts`
- Modify: `modules/data/domain/toolbox/registry.ts`（`ANALYST_TOOLS` 加 2 条声明）
- Create: `modules/data/domain/toolbox/explore.ts`（ToolImpl）
- Modify: `modules/data/domain/toolbox/all.ts`（`registerImpl` 两条）

**Interfaces:**
```ts
export type ExploreAgg = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'

export interface ExploreSpec {
  /** marts 模型名（须命中 `dbt/models/**/marts/*.sql` 且库侧存在） */
  relation: string
  measures: Array<{ agg: ExploreAgg; column: string; as?: string }>
  dimensions?: string[]
  filters?: Array<{ column: string; op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'between'; value: unknown }>
  orderBy?: { key: string; desc?: boolean }
  limit?: number
}

export type ExploreErrorCode =
  | 'BAD_SPEC' | 'RELATION_NOT_ALLOWED' | 'NO_ORG_COLUMN'
  | 'COLUMN_NOT_FOUND' | 'COLUMN_NOT_NUMERIC' | 'COLUMN_MASKED' | 'RELATION_MASKED'
  | 'AGG_NOT_ALLOWED' | 'BAD_FILTER'

export type ExploreCompiled =
  | { ok: true; sql: string; params: unknown[] }
  | { ok: false; code: ExploreErrorCode; detail?: string }

export function compileExplore(
  spec: unknown,
  ctx: { allowedRelations: ReadonlySet<string>; columns: ReadonlyArray<{ name: string; dataType: string }>; maskedColumns: ReadonlySet<string>; maskedRelations: ReadonlySet<string> },
): ExploreCompiled
```

**判据（写进 PR 说明）：**
- `relation` 不在 `allowedRelations` ⇒ `RELATION_NOT_ALLOWED`（白名单 = 仓内 `dbt/models/**/marts/*.sql` 文件名，**不猜库里的表**）；
- `columns` 里没有该表 ⇒ `RELATION_NOT_ALLOWED`；
- 没有 `org` 列 ⇒ `NO_ORG_COLUMN`（实测：仓库库 59 张表中 8 张无 `org`——`dim_brand`/`dim_region`/`probe_vw_rol`/`recon_tolerances`/`x01_branch_calendar`/`x01_client_region_overrides`/`x01_region_names`/`x08_thresholds`，它们**按设计**进不来）；
- `sum/avg/min/max` 只允许数值列（`integer|bigint|numeric|double precision|real|smallint`）；
- 列名必须逐字命中 `columns`（大小写敏感，不做模糊匹配）；
- `limit` 缺省 200，`> 1000` 直接拒（不夹紧——夹紧会让调用方以为拿到全量）；
- 编译产物恒为 `select ... from staging.<relation> where org = $1 ...`，值全部 `$n` 占位。

- [ ] **Step 1: 写失败测试**（至少 10 例，含：正常编译；列名带引号/分号注入被拒；未声明表被拒；无 org 表被拒；staging 表被拒；掩码列被拒；整值掩码关系被拒；limit 越界被拒；非数值列 sum 被拒；filters 值走占位符）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `compileExplore`**
- [ ] **Step 4: 实现 `explore-exec.ts`**：`loadExploreContext(pool)`（一次查 `information_schema.columns`，仅 `table_schema='staging'`）+ `executeExplore(deps, spec)`；执行前后写 `query_audit`（`tool='explore_query'`、`row_count`、`verdict`、`reason`）
- [ ] **Step 5: 接工具面**：`registry.ts` 声明 `explore_query`（参数 schema 与上面一致），`toolbox/explore.ts` 实现，`all.ts` 注册；跑 `pnpm exec tsx scripts/check-mcp-toolface.mjs`（预算 14，现 13）
- [ ] **Step 6: 测试通过 + 提交**

---

### Task 3: 三配方（编译成 explore spec，不新开执行缝）

**Files:**
- Create: `modules/data/domain/analysis/recipes.ts`
- Test: `modules/data/domain/analysis/recipes.test.ts`
- Create: `modules/data/domain/toolbox/recipes.ts` + Modify `registry.ts` / `all.ts`（`explore_recipe`）

**Interfaces:**
```ts
export type RecipeKind = 'variance' | 'top_contributors' | 'baseline'

export interface RecipeRequest {
  recipe: RecipeKind
  metricId: string            // 只用来取关系/度量列；数值仍由 explore spec 算
  dimension: string
  periodA?: { from: string; to: string }
  periodB?: { from: string; to: string }
  topN?: number               // 默认 10，上限 50
  baselineWindowDays?: number // 默认 28
}

/** 纯函数：把业务问题编译成 1–2 个 ExploreSpec + 算法说明（供证据包展示） */
export function compileRecipe(req: RecipeRequest, ctx: RecipeContext): RecipeCompiled
```

**三个配方的口径（写死，别让模型即兴）：**
1. **方差分解**：`delta_i = vA_i - vB_i`，按 `|delta_i|` 降序；输出每维度的 `delta_i` 与 `share = delta_i / Σ delta_i`；`share` 为 NaN/Infinity（Σ≈0）时置 `null`，不输出 0。
2. **Top-N 贡献**：按 `period` 内值降序取 N，附 `share = v_i / Σ v`；`N` 默认 10、上限 50。
3. **基线异常**：以 `asOf` 前 `baselineWindowDays`（默认 28）为窗口，按维度取**中位数与 MAD**；`score = 0.6745 * (x - median) / MAD`（MAD=0 时退化为 `x != median ? ±Infinity : 0`，输出 `degenerate: true`，不假装有分数）；`|score| >= 3.5` 记异常。

- [ ] **Step 1: 写失败测试**（每个配方 3 例：正常、边界/退化、结果稳定排序）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `compileRecipe`**（返回 `{ specs, outputSpec, notes }`；`notes` 是给人看的口径说明，进证据包）
- [ ] **Step 4: 接工具 `explore_recipe`**（执行 specs → 套算法 → 返回 `{ result, evidence: EvidencePack[] }`）
- [ ] **Step 5: 提交**

---

### Task 4: 评估集 16 → 50+ 与回归增强

**Files:**
- Create: `scripts/seed-eval-set.mjs`（从 `data.verified_questions` + `data.demand_signals` 生成**候选清单**，零写入）
- Create: `docs/superpowers/notes/2026-11-06-w6-eval-set.md`（清单：问题 → 指标 → 期望口径，人工确认后才入库）
- Modify: `scripts/verify-regression.mjs`（支持 `--twice` 双跑与方向一致性判定）
- Test: `modules/data/domain/verified-regression.test.ts`（补 `directionConsistent` 用例）

**判据：**
- 目标 50 条**只认人工确认过的**（`status='verified'` 且 `decided_by` 非空）；candidate 不计入。
- 扩充来源按此优先级：① 现有 16 条已验；② 需求台账里已 resolved 的真实问法；③ 生产 `askdata_trace` 中反复出现且能落到现有指标的问题；④ 报表口径问题。每条必须能在**当前词表**上跑通并产出稳定基线。
- `--twice`：同一批连跑两次，逐条比较 `delta = current2 - current1` 与 `|delta|/max(|current1|,1e-9)`；容差内视为一致，超差即红（这就是出口判据 ②「两次结论方向一致」的机判形态）。

- [ ] **Step 1: 写 `seed-eval-set.mjs`**（只产出 CSV/Markdown 候选，不写库）
- [ ] **Step 2: 生成候选清单并人工筛选**（把确认结果写进 notes 文档；未确认的保留在清单里标「待定」）
- [ ] **Step 3: 批量入库脚本**（读 notes 里已确认段；幂等 upsert；同时写 `baseline` 与 `tolerance`）
- [ ] **Step 4: `verify-regression.mjs --twice`** 实现 + 单测
- [ ] **Step 5: 真机跑一次全量**（目标 ≥50，全绿），把结果写进路线图 §5
- [ ] **Step 6: 提交**

---

### Task 5: 三个价值指标可观测

**Files:**
- Modify: `modules/data/domain/system-map/map.ts`（总览新增「分析面」一块）
- Create: `modules/data/domain/analysis/value-metrics.ts` + Test
- Modify: `modules/data/routes/system-map.ts`（装配新数据）

**三个指标的精确定义（先定义再采集，缺数就显示「未接入」）：**
1. **可辩护答案时长**：同一会话里，从用户首问（`askdata_trace` 的 `session_id` 首次出现）到第一次带证据包的查询成功（`query_audit.tool='explore_query'` 的 `ok` 行）之间的中位时长；样本 < 20 时显示「样本不足」。
2. **接受率**：`verified_questions` 中 `decided_by IS NOT NULL` 的比例（已裁决 / 全部），并按周分组看趋势。
3. **口径事故数**：沿用 `data.metric_audit` 近 90 天计数（W5 已实现，直接复用 `healthOf`）。

- [ ] **Step 1: 纯函数 + 测试**（缺失数据 → `null` 而不是 0；样本不足 → `insufficient`）
- [ ] **Step 2: 接到体系地图总览**（三张卡 + 「未接入」标注）
- [ ] **Step 3: 真机核对**（生产库数字与 SQL 手算一致）
- [ ] **Step 4: 提交**

---

## 验收（出口判据逐条对应）

| 路线图判据 | 本计划的验证方式 |
|---|---|
| ① 锚点对账 100%（容差 0.1%） | Task 1 的 `anchorMatches` + Task 3 每个配方输出都带锚点；验收时对生产库跑一遍，逐条记录 |
| ② 同一问题两次结论方向一致 | Task 4 的 `verify-regression.mjs --twice` |
| ③ 评估集 ≥50 且回归全绿 | Task 4；数字写进路线图 §5 |
| ④ 三个价值指标可观测 | Task 5 面板 + 真机手算核对 |

## Self-Review

- **不新开执行缝**：explore 走 `analystPool`，与 `runQuery` 同一条只读边界；配方只是 spec 编译器 ✅
- **租户隔离**：无 `org` 列的表按设计拒绝（实测 8 张），不猜 ✅
- **掩码**：复用既有 `maskedTargets` / `relationHasWholeValueMask`，不写第二套判定 ✅
- **不编数据**：评估集只认人工确认；样本不足/缺数一律显示「未接入」而不是 0 ✅
- **已知边界**：`dim_brand` / `dim_region` 等共享参考表暂不可 explore（无 `org` 列）；要放开必须先定义「共享参考表」白名单并说明为什么跨租户可读——**本波不做**。
