# bot 问数下钻（Phase 1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「下钻」接到问数上：域级度量组件声明面（measures/compose/dimensions/detail）+ `query_detail` 查询面（HTTP/MCP/agent/企微四通道）+ 权限掩码接线，聚合面一字不动。

**Architecture:** 口径只在组件里算一次：sync 把 YAML 的 `compose`（组件引用文法）解析成 `drill_expr`，随 `drill_dims`/`drill_detail` 物化进 `data.metrics`；下钻 = **两段 SQL**（内层按原子粒度求组件、外层按请求维度上卷）读直读湖视图 `vw_lemeng_retail_order_line`。授权零自建——复用 `visibleMetrics → authorize → maskedSelectSql` 同一条链，仅掩码在场判定改对**下钻 SQL** 做（spec §2.5 两处细节）。L2 行下钻三列恒 NULL ⇒ 「L2 不支持下钻」由存储形状自然涌现，无需特判。

**Tech Stack:** Hono + zod、pg（data.metrics/jsonb）、dbt 1.91（pg_duckdb 直读湖视图）、YAML 闭集门禁（check-data-models）、openclaw native plugin。

**Spec:** `docs/superpowers/specs/2026-10-21-bot-drillthrough-design.md`（唯一事实源）。前置 Phase 0 已验收（#973/#974，含 `duckdb.memory_limit=1536MB` 内存对齐——spec §2.7 阻塞项**已解除**，本计划无内存任务）。

---

## ⚠️ 裁决点（开工前请人确认；计划按保守侧落，翻案只动标注的任务）

spec §2.3 的示例草图与 §2.4 术语钉死、§4 不变量存在三处互相牵制，本计划取保守解并逐处标注。**若裁决翻转，只改 Task 5（声明）与 Task 7（掩码接线）两处**：

1. **`item_num` 不进 `dimensions` 闭集**（spec 草图有它，§2.4 自己说「摊到行属设计选择，不由本 spec 决定」）。折半式 `(非赠品额+订单总额)/2` 是**订单级**算术——若允许按 `item_num` 分组，`(行额+订单总额)/2` 会对每个 item 行各除一次，数值错。Phase 1 原子粒度 = 账套×业务日×门店×订单。
2. **Phase 1 不声明 `data:cost` 列级掩码**（`detail.columns[].granted_by` 与价格列 mask 一并缓到 Phase 2）。算术：`order_detail_std_price` 在**赠品判别式内部**；对它 `nullify` ⇒ 判别式 NULL ⇒ fct 形状的 `case when <判别式> then 0 else sale_money end` 走 else ⇒ 赠品行按 sale_money 计入 ⇒ **掩码后下钻值 ≠ 聚合值，§4「掩码同源」必红**。而聚合路径的列掩码因聚合 `selectSql` 不含湖列根本不生效（spec 明文的不对称）⇒ Phase 1 声明列掩码**没有任何能通过的判据**。Phase 1 掩码 = **指标级整值掩码**（`mask_spec` 里已有的形态）同时作用于两面的 value 头，`masking` 三态照常透出。
3. **`detail.filter` 定为 `state = 'FINISHED'`**（spec 草图是 `... and order_transaction_type = 'SALE_ORDER'`）。交易类型闸**内嵌进组件**的 case-when（见 Task 5），否则退货单不进下钻 ⇒ 逐店日与聚合面（含退货冲减）对不上，§4「口径同源」必红。

以上三点会在 Task 12 写进 spec 附录（「实施订正」节），PR 里可 review。

---

## Global Constraints

- **聚合面零变化**：`fct_*`/`stg_*`/聚合 SQL/调度一律不动；验收 = 43 条指标 + 46 条 audit 全绿（spec §4）。
- **判别式逐字照抄** `dbt/models/lemeng/marts/fct_retail_sale.sql` 的两句（销售侧正数形态、退货侧绝对值形态 #908）——**禁止另写一份**； NULL 语义保真：判别式必须以 `case when <判别式> then 0 else … end` 的**正形态**出现（`not (…)` 会把 NULL 翻成假，改变 fct 的 ELSE 落点）。
- **不引入自由 SQL**（全局约束 12）：`compose` 只收「组件引用 + `+ - ( )` 空白」封闭文法；组件体是 YAML 里的声明文本（与 expression 同信任级，禁 `;`）。
- **manifest 与路由同一提交对齐**（装载期双向核对，任一方向差集 = 起不来）。
- **迁移幂等**：`add column if not exists`（部署脚本会全量重跑）。
- **`scripts/` 是 checkJs**：导出单形状、字段恒在对象，不写可辨识联合（字面量类型会被加宽，假绿先例）。
- **提交纪律**：Conventional Commits；feat/fix 先建 issue，PR body 含 `Closes #N`；squash 合并。**开工第一步建 issue**（见 Task 0）。
- **shell 里 `$VAR` 紧跟中文必须写 `${VAR}`**（bash 3.2 吃掉）。
- **测试需要 `DATABASE_URL`**（本地 compose pg；注意本机 127.0.0.1:5432 是**原生实例**——用 data-compose 起的库端口）。无 DB 的纯函数测试不 skip。
- **openship MCP 是唯一运维通道**：真机部署/日志/重启/验库一律经 MCP，不裸 SSH。
- 回包确定性文案（`📅 📐 ⏱` 行）由**平台拼好**，插件 strip-then-append——不靠模型自觉。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/migrations/021_metric_drill.sql` | **新建**：`data.metrics` 加 `drill_expr/drill_dims/drill_detail`；`data.query_audit` 加 `drill` |
| `modules/data/domain/authz.ts` | **改**：`DrillBinding` 类型、`DenyReason` 加 `no_detail_binding`、`paramFilters` 从 `authorize` 抽出导出 |
| `modules/data/domain/metric-store.ts` | **改**：`ROW_COLUMNS`/`L1MetricDef`/`toMetricRow`/`upsertL1Metric` 接下钻三列 |
| `modules/data/domain/query-service.ts` | **改**：导出 `isLakeRaceError/formatDataAsOf/DATA_AS_OF_SQL`，新增 `execWithLakeRaceRetry` 并让 `runQuery` 改用（重试纪律单源化） |
| `modules/data/domain/drill.ts` | **新建**：`buildDrillSql`（纯函数）+ `runDetailQuery`（下钻唯一执行入口） |
| `modules/data/domain/drill.test.ts` | **新建**：下钻单测（假执行器，不需要湖） |
| `modules/data/routes/query-detail.ts` | **新建**：POST /query/detail HTTP 面 |
| `modules/data/index.ts` + `modules/data/manifest.yaml` | **改**：注册新路由 + api.internal 同提交对齐 |
| `modules/data/domain/agent-loop.ts` | **改**：第三把工具 `query_detail` |
| `modules/data/routes/mcp.ts` | **改**：读面追加静态工具 `query_detail` |
| `deploy/openclaw/data-query-plugin/{index.js,lib.js}` + `skills/data-query/SKILL.md` | **改**：企微通道第四把工具 + 错误文案映射 + 模型指引 |
| `dbt/semantics/l1_metrics.yml` | **改**：顶层 `measures:` 两个组件 + `net_sales` 的 compose/dimensions/detail |
| `dbt/tests/lemeng/assert_drill_net_sales_matches_fct.sql` | **新建**：口径同源不变量（独立复算，audit 模式） |
| `scripts/sync-data-semantics.mjs` | **改**：measures 解析 + compose 文法校验/解析 + comparableOf 扩元 |
| `scripts/check-data-models.mjs` + `scripts/check-data-models.test.ts` | **改**：METRIC_KEYS 闭集 + measures/三键校验 |
| `dbt/README.md` | **改**：键清单与 measures 段说明（门禁头注要求） |

---

### Task 0: 建 issue + 对齐基线

- [ ] **Step 1: fetch main 并对齐**（多会话并行纪律；本工作树 docs 分支早于 #973，**执行时必须从 origin/main 拉新分支**，Phase 0 的 `views/vw_*.sql` 只在 main 上）

```bash
git fetch origin main && git ls-remote origin refs/heads/main
git worktree 相关操作按 orca-cli skill；分支名 feat/bot-drillthrough-phase1
```

- [ ] **Step 2: 建 issue**（feat 门禁）：标题 `feat(data): bot 问数明细下钻 Phase 1——度量组件声明面 + query_detail 四通道`；正文贴 spec 路径 + 本计划路径 + 三处裁决点的保守解。记下编号 `#N`，后续提交引用。

---

### Task 1: authz.ts——`DrillBinding` 类型 + `paramFilters` 抽取 + DenyReason 扩展

**Files:**
- Modify: `modules/data/domain/authz.ts`（`DenyReason` 在 146 行附近；`literal`/`rangeLiteral`/`authorize` 在 239-393 行）
- Test: `modules/data/domain/authz.test.ts`

**Interfaces:**
- Produces: `export interface DrillBinding { expr: string; dims: string[]; relation: string; filter: string }`；`MetricDef.drill?: DrillBinding`；`DenyReason` 增支 `'no_detail_binding'`；`export function paramFilters(params, args, wantTotal): ParamFiltersResult`——Task 7 的 `runDetailQuery` 与 `authorize` 共用，参数→SQL 判据单源。

- [ ] **Step 1: 写失败测试**（authz.test.ts 追加）

```ts
describe('paramFilters（下钻共用抽取）', () => {
  const params = { bizday: { column: 'bizday', type: 'date_range' as const } }
  it('date_range 参数产出 BETWEEN 连接词，与 authorize 内联版逐字一致', () => {
    const r = paramFilters(params, { bizday: { from: '2026-10-19', to: '2026-10-20' } }, false)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.filters[0], " AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date")
  })
  it('from>to → range_invalid（保留既有可解释 detail）', () => {
    const r = paramFilters(params, { bizday: { from: '2026-10-20', to: '2026-10-19' } }, false)
    assert.deepEqual(r, { ok: false, reason: 'bad_param', detail: 'range_invalid:bizday' })
  })
  it('wantTotal=false 时 total 是未知键（fail-closed）', () => {
    const r = paramFilters(params, { total: true }, false)
    assert.deepEqual(r, { ok: false, reason: 'bad_param', detail: 'unknown_param:total' })
  })
})
```

（若该文件用 `it`/`expect` 风格与本块不同，照该文件既有风格改写断言；判据不变。）

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter data test -- authz` → FAIL（`paramFilters` 未导出）。
- [ ] **Step 3: 实现抽取**——把 `authorize` 里 `const filters: string[] = []` 起到「required 检查」止的循环**原样搬**进新导出函数：

```ts
/** 参数 → WHERE 连接词（` AND col op lit` 数组）。authorize 与下钻（drill.ts）共用同一判据。 */
export type ParamFiltersResult =
  | { ok: true; filters: string[] }
  | { ok: false; reason: 'bad_param'; detail: string }

export function paramFilters(
  params: Record<string, MetricParamDef>,
  args: Record<string, unknown>,
  wantTotal: boolean,
): ParamFiltersResult {
  const filters: string[] = []
  for (const [name, value] of Object.entries(args)) {
    if (wantTotal && name === 'total') continue
    const param = params[name]
    if (!param) return { ok: false, reason: 'bad_param', detail: `unknown_param:${name}` }
    if (value === undefined || value === null || value === '') continue
    if (param.type === 'date_range') {
      const r = rangeLiteral(value)
      if (!r.ok) return { ok: false, reason: 'bad_param', detail: (r.detail === 'order' ? 'range_invalid:' : 'invalid_value:') + name }
      filters.push(` AND ${param.column} BETWEEN ${sqlQuote(r.from)}::date AND ${sqlQuote(r.to)}::date`)
      continue
    }
    const lit = literal(param, value)
    if (lit === null) return { ok: false, reason: 'bad_param', detail: `invalid_value:${name}` }
    filters.push(` AND ${param.column} = ${lit}`)
  }
  return { ok: true, filters }
}
```

`authorize` 改为调用它（`total` 保留键检查与 required 检查留在 authorize 原位），过滤逻辑零改动。

- [ ] **Step 4: 加类型**——`MetricDef` 加可选字段与绑定形状（放在 `MetricDef` 定义旁）：

```ts
/** 明细下钻绑定（spec 2026-10-21 §2.3）：sync 从声明 compose/dimensions/detail 物化；未声明 = 字段缺席。 */
export interface DrillBinding {
  /** 原子粒度值表达式（compose 的组件引用替换产物）。 */
  expr: string
  /** 原子粒度维度闭集：请求 dimensions 必须是其子集（只许变粗，不许加列）。 */
  dims: string[]
  /** 直读湖关系（PG 可见；Phase 1 只放 vw_*）。 */
  relation: string
  /** 行域过滤（声明 detail.filter 逐字进 WHERE）。 */
  filter: string
}
```

`MetricDef` 尾部加 `drill?: DrillBinding`；`DenyReason` 联合加一行 `| 'no_detail_binding'`（注释：`能力陈述不是权限拒绝——该指标未声明下钻（spec §2.6），消费面必须据此换措辞`）。

- [ ] **Step 5: 跑全量**：`pnpm --filter data test -- authz` 全绿（authorize 回归由既有用例钉住）。
- [ ] **Step 6: Commit** `feat(data): authz 抽出 paramFilters 并声明 DrillBinding (#N)`。

---

### Task 2: query-service 导出竞态/时钟原语 + 重试单源化

**Files:**
- Modify: `modules/data/domain/query-service.ts`（`LAKE_RACE_RE` 14 行、`DATA_AS_OF_SQL` 20 行、`formatDataAsOf` 34 行、`execWithRaceRetry` 闭包 291-302 行）
- Test: `modules/data/domain/query-service.test.ts`（回归既有 race 用例即可，无新行为）

**Interfaces:**
- Produces（Task 7 消费）: `export function isLakeRaceError(err: unknown): boolean`；`export function formatDataAsOf(v: Date): string`；`export const DATA_AS_OF_SQL: string`；`export async function execWithLakeRaceRetry(exec, delayMs): Promise<{ result: {columns,rows}; retried: boolean }>`

- [ ] **Step 1: 三处加 `export` 关键字**（`LAKE_RACE_RE` 经 `isLakeRaceError` 间接导出即可；`formatDataAsOf`、`DATA_AS_OF_SQL` 直接加 export，注释补「drill.ts 共用」）。
- [ ] **Step 2: 新增导出函数**（放在 `LAKE_RACE_RETRY_DELAY_MS` 附近）：

```ts
/**
 * 湖 ETag 竞态的统一处置（#452 定案 A）：撞重写窗 ⇒ 退避 ~1s 重试恰一次。
 * 本通路全为只读 SELECT，天然幂等。runQuery 与 runDetailQuery 共用 ⇒ 重试纪律只有一份。
 */
export async function execWithLakeRaceRetry(
  exec: () => Promise<{ columns: string[]; rows: unknown[][] }>,
  delayMs: number,
): Promise<{ result: { columns: string[]; rows: unknown[][] }; retried: boolean }> {
  try {
    return { result: await exec(), retried: false }
  } catch (err) {
    if (!isLakeRaceError(err)) throw err
    await sleep(delayMs)
    return { result: await exec(), retried: true }
  }
}
```

- [ ] **Step 3: runQuery 改用**——删除内联闭包，改：

```ts
const execOnce = (sql: string) =>
  deps.execute ? deps.execute(sql) : runWarehouseSql(warehousePool(), sql)
const race = (sql: string) => execWithLakeRaceRetry(() => execOnce(sql), deps.raceRetryDelayMs ?? LAKE_RACE_RETRY_DELAY_MS)
let result = (await race(authz.plan.sql)).result
let raceRetried = false
// raceRetried 需要在多处累计（主计划 + totalSql）：改用小 helper
const execWithRaceRetry = async (sql: string) => {
  const r = await race(sql)
  if (r.retried) raceRetried = true
  return r.result
}
```

（`toError`、审计 `lake_race_retry` 逻辑不动；语义与现闭包逐字节等价，由既有 `query-service.test.ts` 的 race 用例回归。）
- [ ] **Step 4: 跑** `pnpm --filter data test -- query-service` 全绿 → **Step 5: Commit** `refactor(data): 湖竞态重试与 as-of 时钟原语导出复用 (#N)`。

---

### Task 3: 迁移 021 + metric-store 下钻三列

**Files:**
- Create: `modules/data/migrations/021_metric_drill.sql`
- Modify: `modules/data/domain/metric-store.ts`（`ROW_COLUMNS` 138 行、`L1MetricDef` 89 行、`toMetricRow` ~110 行、`upsertL1Metric` 292 行）
- Test: `modules/data/domain/metric-store.drill.test.ts`（新建；pg 门控 `describePg`）

**Interfaces:**
- Consumes: Task 1 的 `DrillBinding`
- Produces: `MetricRow.drill?: DrillBinding`（读侧）；`L1MetricDef.drill: DrillBinding | null`（写侧，sync 必传）；`data.query_audit` 的 `drill` jsonb（Task 7 审计写）

- [ ] **Step 1: 写迁移**（幂等；命名沿用 016-020 序列，先 `ls modules/data/migrations/` 确认 021 未被占用）：

```sql
-- 021_metric_drill.sql — bot 问数下钻 Phase 1（spec 2026-10-21 §2.3/§2.5）。
-- data.metrics 三列：sync 从声明 compose/dimensions/detail 物化的下钻绑定；L2 行恒 NULL
--（upsertMetric 不写它们）⇒「L2 不支持下钻」（spec §5）由存储形状自然涌现，无需运行期特判。
-- data.query_audit.drill：下钻审计面 {dimensions, rowCountTotal}；聚合审计恒 NULL——
--   「这条审计是不是下钻」必须可辨（spec §2.5：下钻审计含粒度与总数）。
alter table data.metrics     add column if not exists drill_expr   text;
alter table data.metrics     add column if not exists drill_dims   jsonb;
alter table data.metrics     add column if not exists drill_detail jsonb;
alter table data.query_audit add column if not exists drill        jsonb;
```

- [ ] **Step 2: 写失败测试**（metric-store.drill.test.ts；夹具形状照 catalog-consumers.test.ts 的 `describePg`/`applyMigrations`/`upsertL1Metric` 用法）：

```ts
// 隔离键与本仓其它测试文件互不相同
const ORG = 'org-drill-store'
it('upsertL1Metric 写入下钻三列，loadMergedCatalog 读回 DrillBinding', async () => {
  await upsertL1Metric(pool, {
    id: 'drillstore:retail:net_sales', title: 't', description: 'd',
    requiredScope: null, subjectColumn: 'org',
    selectSql: "select sum(fct_t.net_amount) as value, system_book from fct_t where state = 'FINISHED' group by system_book",
    groupBy: 'system_book', params: {}, sourceSystem: 'lemeng',
    slaDays: 1, freshnessRelations: [], masks: null,
    drill: { expr: '(sale_amount@order)', dims: ['system_book', 'bizday'], relation: 'vw_t', filter: "state = 'FINISHED'" },
  })
  const rows = await loadMergedCatalog(pool, ORG)
  const row = rows.find((m) => m.id === 'drillstore:retail:net_sales')
  assert.deepEqual(row?.drill, { expr: '(sale_amount@order)', dims: ['system_book', 'bizday'], relation: 'vw_t', filter: "state = 'FINISHED'" })
})
it('drill 列残缺（有 expr 无 dims）⇒ 读侧判未声明（fail-closed，不半绑）', async () => {
  await pool.query(
    "insert into data.metrics (org, id, title, description, subject_column, select_sql, group_by, params, source, drill_expr) values ($1,'drillstore:half','t','d','org','select 1 as value','','{}','l1','(x)') on conflict (org,id) do update set drill_expr = excluded.drill_expr",
    [ORG])
  const rows = await loadMergedCatalog(pool, ORG)
  assert.equal(rows.find((m) => m.id === 'drillstore:half')?.drill, undefined)
})
```

- [ ] **Step 3: 跑确认失败** → **Step 4: 实现**：

`ROW_COLUMNS` 尾部加 `, drill_expr, drill_dims, drill_detail`；`L1MetricDef` 加 `drill: DrillBinding | null`（注释：sync 物化路径必传，未声明 compose 传 null）；`MetricRow` 加 `drill?: DrillBinding`。`toMetricRow` 加：

```ts
drill: drillBindingOf(row),
```

```ts
/** 行的下钻三列 → DrillBinding；任一列缺/坏形状 ⇒ undefined（= 未声明）。读侧不信任存储形状。 */
function drillBindingOf(row: Record<string, unknown>): DrillBinding | undefined {
  const expr = row.drill_expr
  const dims = row.drill_dims
  const detail = row.drill_detail
  if (typeof expr !== 'string' || expr === '') return undefined
  if (!Array.isArray(dims) || dims.length === 0 || dims.some((d) => typeof d !== 'string' || d === '')) return undefined
  if (typeof detail !== 'object' || detail === null) return undefined
  const d = detail as { relation?: unknown; filter?: unknown }
  if (typeof d.relation !== 'string' || d.relation === '' || typeof d.filter !== 'string' || d.filter === '') return undefined
  return { expr, dims: dims as string[], relation: d.relation, filter: d.filter }
}
```

`upsertL1Metric`：insert 列清单尾加 `drill_expr, drill_dims, drill_detail`（占位 `$16, $17::jsonb, $18::jsonb`），conflict 分支加三行 `drill_expr = excluded.drill_expr, drill_dims = excluded.drill_dims, drill_detail = excluded.drill_detail`，参数数组尾加：

```ts
def.drill === null ? null : def.drill.expr,
def.drill === null ? null : JSON.stringify(def.drill.dims),
def.drill === null ? null : JSON.stringify({ relation: def.drill.relation, filter: def.drill.filter }),
```

（`upsertMetric` L2 路径**不动**——三列不写即 NULL。）

- [ ] **Step 5: 跑** `pnpm --filter data test -- metric-store` 全绿 → **Step 6: Commit** `feat(data): data.metrics 下钻三列与审计 drill 面 (#N)`。

---

### Task 4: 门禁——METRIC_KEYS 闭集扩充 + measures/三键校验

**Files:**
- Modify: `scripts/check-data-models.mjs`（`METRIC_KEYS` 196 行；metrics 循环 1088 行起）
- Modify: `dbt/README.md`（键清单节；先 `grep -n 'scope_note' dbt/README.md` 定位）
- Test: `scripts/check-data-models.test.ts`

**Interfaces:**
- Produces（Task 5/6 依赖的声明面合同）: 每指标 `compose`（string）+ `dimensions`（string 数组）+ `detail`（`{relation, filter}`，键闭集）**三者同现或同缺**；顶层 `measures:` 为 `{ '名@粒度': 表达式 }` 映射；compose 引用必须命中 measures 键；`relation` 必须 `^vw_[a-z0-9_]+$` 且 `dbt/models/**/views/<relation>.sql` 存在。

- [ ] **Step 1: 写失败测试**（check-data-models.test.ts 追加；夹具构造照本文件既有 temp-repo helper）：

```ts
it('下钻三键：全给或全不给，半套声明拒绝', () => {
  const root = mkTmpRepo()
  addSemanticsYml(root, [{ name: 'lemeng:retail:net_sales', expression: 'sum(fct_t.net_amount)',
    grain: ['system_book'], source: 'lemeng', freshness_sla_days: 1,
    compose: 'sale_amount@order - return_amount@line' }])   // 缺 dimensions/detail
  const vs = checkDataModels(root)
  assert.ok(vs.some((v) => /compose.*dimensions.*detail|三键/.test(v.message)))
})
it('compose 引用未声明组件 ⇒ 拒', () => { /* measures 缺 sale_amount@order，断言 some(/未声明的度量组件/) */ })
it('detail.relation 非 vw_* 或视图文件不存在 ⇒ 拒', () => { /* 断言 some(/vw_|视图/) */ })
it('measures 表达式含分号 ⇒ 拒', () => { /* 断言 some(/分号|;/) */ })
it('三键齐全 + measures 就位 ⇒ 零违规', () => { /* 完整夹具（含 views/vw_t.sql 骨架文件），断言 length === 0 */ })
```

- [ ] **Step 2: 跑确认失败** → **Step 3: 实现**：

`METRIC_KEYS` 加三键（带注释 `// 下钻三键（spec 2026-10-21 §2.3/§2.3.1）：compose/dimensions/detail 必须同现`）。

metrics 循环里、未知键检查之后加：

```js
// ⑤-x 下钻三键（spec 2026-10-21 §2.3）：同现或同缺——半套声明 = 消费面 NO_DETAIL_BINDING
// 与声明意图相左（静默面）。relation 只认 vw_*（Phase 1 下钻读直读湖视图）且文件必须在仓。
const dkeys = ['compose', 'dimensions', 'detail'].filter((k) => metric.fields?.[k] !== undefined)
if (dkeys.length > 0 && dkeys.length < 3) {
  push(metric.file, 0, `指标 \`${metric.name}\` 的下钻三键只给了 ${dkeys.join('/')} —— `
    + 'compose/dimensions/detail 必须**同现或同缺**（半套 = 声明了但下钻面起不来，静默）。')
}
const composeRaw = metric.fields?.compose
if (composeRaw !== undefined) {
  const compose = typeof composeRaw === 'string' ? composeRaw : ''
  if (compose === '' || compose.includes(';')) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 compose 必须是非空、不含分号的组件组合式（如 \`sale_amount@order - return_amount@line\`）。`)
  }
  for (const m of compose.matchAll(/[A-Za-z_][A-Za-z0-9_]*@[a-z0-9_]+/g)) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 compose 引用组件 \`${m[0]}\`——其必须声明在同文件顶层 \`measures:\`（校验见下方 measures 扫描）。`)  // 占位：与 measures 集比对，见 Step 3b
  }
  const dims = metric.fields?.dimensions
  if (!Array.isArray(dims) || dims.length === 0 || !dims.every((d) => typeof d === 'string' && /^[a-z_][a-z0-9_]*$/.test(d)) || new Set(dims).size !== dims.length) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 dimensions 必须是非空、无重复、蛇形命名的字符串数组——它是**原子粒度闭集**，请求维度只能取其子集。`)
  }
  const detail = metric.fields?.detail
  const rel = typeof detail?.relation === 'string' ? detail.relation : ''
  if (!/^vw_[a-z0-9_]+$/.test(rel)) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.relation ${JSON.stringify(rel)} 不合 \`vw_*\` 形态 —— Phase 1 下钻只读直读湖视图（spec §2.2）。`)
  } else if (!viewFiles.includes(`dbt/models/lemeng/views/${rel}.sql`) && !viewFiles.some((f) => f.endsWith(`/${rel}.sql`))) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.relation \`${rel}\` 在 dbt/models/**/views/ 下不存在——下钻会查一个不存在的关系（运行期才炸）。`)
  }
  const filter = typeof detail?.filter === 'string' ? detail.filter : ''
  if (filter === '' || filter.includes(';')) {
    push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.filter 必须是非空、不含分号的布尔表达式（如 \`state = 'FINISHED'\`）。`)
  }
}
```

**Step 3b（measures 扫描 + compose 引用闭环）**：在收集 metrics 的同一循环处（1088 行附近）顺带收集 `doc.measures`：

```js
// 顶层 measures:（spec 2026-10-21 §2.3）：{ '组件名@粒度': 表达式 } 映射。
// 表达式是声明文本（与 expression 同信任级）：非空字符串、不含分号。
if (doc.measures !== undefined) {
  if (typeof doc.measures !== 'object' || doc.measures === null || Array.isArray(doc.measures)) {
    push(rel, 0, '`measures:` 必须是 `{ "组件名@粒度": 表达式 }` 映射，不是数组。')
  } else {
    for (const [k, v] of Object.entries(doc.measures)) {
      if (!/^[a-z_]+@[a-z_]+$/.test(k)) push(rel, 0, `\`measures.${k}\` 键名不合 \`<snake>@<snake>\` 形态。`)
      if (typeof v !== 'string' || v.trim() === '' || v.includes(';')) {
        push(rel, 0, `\`measures.${k}\` 必须是非空、不含分号的表达式字符串。`)
      }
    }
  }
}
```

然后把 Step 3 里「占位」的 compose 引用检查改为与 **同文件** 的 measures 集比对（把 `doc.measures` 的键集随 metric 一起存进循环变量），未命中即 `引用了未声明的度量组件`。

- [ ] **Step 4: 更新 dbt/README.md**——键清单表加 `compose` / `dimensions` / `detail` 三行与 `measures:` 顶层段说明（各一行语义 + 指回 spec）。门禁头注明文要求「改常量 = 改 README + 走 PR」。
- [ ] **Step 5: 跑** `node --test scripts/check-data-models.test.ts`（或仓内既有调用方式）全绿；`node scripts/check-data-models.mjs` 对现仓应零违规（YAML 还没加三键）。
- [ ] **Step 6: Commit** `feat(data): 声明面闭集扩充——measures 与下钻三键 (#N)`。

---

### Task 5: YAML 声明 + dbt 口径同源不变量

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（`lemeng:retail:net_sales` 条目 + 顶层 `measures:`）
- Create: `dbt/tests/lemeng/assert_drill_net_sales_matches_fct.sql`

**Interfaces:**
- Consumes: Task 4 的门禁合同
- Produces（Task 6 消费）: `measures.sale_amount@order` / `measures.return_amount@line` 两个组件体；net_sales 的 `compose: 'sale_amount@order - return_amount@line'`、`dimensions: [system_book, bizday, branch_num, order_no]`、`detail: {relation: vw_lemeng_retail_order_line, filter: "state = 'FINISHED'"}`

- [ ] **Step 1: 加顶层 `measures:`**（放在 `metrics:` 之前；判别式**逐字**取自 fct_retail_sale.sql，正形态保 NULL 语义；交易类型闸内嵌——见裁决点 3）：

```yaml
# ── 域级度量组件（spec 2026-10-21 bot-drillthrough §2.3）：一个组件只声明一次，指标用 compose 组合 ──
# 判别式**逐字**取自 dbt/models/lemeng/marts/fct_retail_sale.sql（销售侧正数形态 / 退货侧绝对值形态 #908），
# 禁止另写一份；组件与 mart 是同口径的两种粒度。判别式必须保持 `case when <判别式> then 0 else …`
# 的正形态：`not (…)` 会把 NULL 翻成假，改变 fct 的 ELSE 落点（NULL 语义保真）。
# 交易类型闸（state/type）内嵌进 case 条件：下钻行域含退货单（口径同源要求退货冲减在场），
# sale 侧组件靠闸把非 SALE_ORDER 行归零——而不是靠 detail.filter 排掉退货。
measures:
  sale_amount@order: >-
    case when sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then 1 else 0 end) = 0 then 0
    else (sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' and
      (order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and
       abs(discount_money - order_detail_std_price * quantity) <= 0.02) then 0 else sale_money end)
      + max(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_total_money end)) / 2
      - sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_detail_share_discount else 0 end)
    end
  return_amount@line: >-
    sum(case when order_transaction_type like '%RETURN%' and state = 'FINISHED' and
      (order_detail_std_price > 0 and abs(sale_money) > 0 and abs(quantity) > 0 and
       abs(abs(discount_money) - order_detail_std_price * abs(quantity)) <= 0.02) then 0
    when order_transaction_type like '%RETURN%' and state = 'FINISHED' then sale_money + order_detail_share_discount
    else 0 end)
```

- [ ] **Step 2: net_sales 条目加三键**（`grain`/`expression` 等既有键一字不动）：

```yaml
    # ── 下钻绑定（spec §2.3/§2.4；Phase 1 裁决点：item_num 不进闭集——折半是订单级算术，
    # 摊到行是设计选择，spec §2.4 明示不定案；data:cost 列掩码缓到 Phase 2，见计划裁决点 2）──
    compose: 'sale_amount@order - return_amount@line'
    dimensions: [system_book, bizday, branch_num, order_no]
    detail:
      relation: vw_lemeng_retail_order_line
      filter: "state = 'FINISHED'"
```

- [ ] **Step 3: 门禁 + dry-run 自证**：

```bash
node scripts/check-data-models.mjs && DATABASE_URL=... node scripts/sync-data-semantics.mjs --dry-run
```

预期：门禁零违规；dry-run 显示 net_sales 一条「更新」（comparableOf 尚未含下钻字段，此步只为确认 YAML 可解析、sync 不炸；Task 6 之后该漂移会被正式消费）。

- [ ] **Step 4: 写口径同源不变量**（独立复算 = audit 模式定位，生产口径唯一事实源仍是 YAML；含空转绿守卫——守卫必须写成 `= 0` 判据，**别用 not exists**（#973 实测的死分支形态））：

```sql
-- assert_drill_net_sales_matches_fct — 下钻口径同源不变量（spec 2026-10-21 §4 Phase 1）。
-- 独立复算（与 audit_* 同定位）：从直读湖视图按原子粒度（账套×日×店×单）求组件、按店×日上卷，
-- 与 fct_retail_sale.net_amount 逐分对（numeric(20,2)，1 分容差）。只测**闭窗日**
--（bizday < 上海今天）：当日分区被 tick 持续重写，两侧时点不同不可比。
-- 生产口径唯一事实源是 dbt/semantics/l1_metrics.yml 的 measures/compose；本文件漂移 ⇒ 本测试红。
with drill as (
    select system_book, bizday, branch_num, sum(atomic_value) as v
    from (
        select system_book, bizday, branch_num, order_no,
               (case when sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then 1 else 0 end) = 0 then 0
                     else (sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' and
                          (order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and
                           abs(discount_money - order_detail_std_price * quantity) <= 0.02) then 0 else sale_money end)
                          + max(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_total_money end)) / 2
                          - sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_detail_share_discount else 0 end)
                end) as atomic_value
        from {{ ref('vw_lemeng_retail_order_line') }}
        where state = 'FINISHED'
        group by system_book, bizday, branch_num, order_no
    ) t
    group by system_book, bizday, branch_num
),
fct as (
    select system_book, bizday, branch_num, sum(net_amount) as v
    from {{ ref('fct_retail_sale') }}
    group by system_book, bizday, branch_num
)
select drill.system_book, drill.bizday, drill.branch_num, drill.v as drill_v, fct.v as fct_v,
       '下钻组件上卷与聚合口径不一致（measures/compose 与 fct_retail_sale 漂移：判别式或折半式抄错）' as note
from drill
join fct using (system_book, bizday, branch_num)
where drill.bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
  and abs(drill.v - fct.v) > 0.01
union all
select null, null, null, null, null, '空转绿：闭窗日两侧有一侧为空，对账在空集上「通过」是空转绿'
where (select count(*) from drill where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
   or (select count(*) from fct) = 0
```

- [ ] **Step 5: Commit** `feat(data): 零售净额度量组件声明与口径同源不变量 (#N)`。（不变量的**执行验证**在 Task 11 真机层——本地无湖。）

---

### Task 6: sync 编译——measures 解析 + compose 文法 + comparableOf 扩元

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（`declarationsFromYaml` 572 行起、`comparableOf` 711 行、头注）
- Test: `scripts/sync-data-semantics.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `L1MetricDef.drill`、Task 5 的 YAML
- Produces: 声明行新增 `drillExpr: string | null`、`drillDims: string[] | null`、`drillDetail: { relation: string, filter: string } | null`；`comparableOf` 16 元组（+3）

- [ ] **Step 1: 写失败测试**（sync-data-semantics.test.ts 追加；该文件已存在）：

```ts
it('compose：组件引用替换为括号包裹的组件体', () => {
  const rows = declarationsFromYaml({
    measures: { 'sale_amount@order': '(sum(x))', 'return_amount@line': 'sum(y)' },
    metrics: [{ name: 'lemeng:retail:net_sales', label: 't', definition: 'd',
      expression: 'sum(fct_retail_sale.net_amount)', grain: ['system_book', 'bizday', 'branch_num'],
      source: 'lemeng', freshness_sla_days: 1,
      compose: 'sale_amount@order - return_amount@line',
      dimensions: ['system_book', 'bizday', 'branch_num', 'order_no'],
      detail: { relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" } }],
  })
  assert.equal(rows[0].drillExpr, '((sum(x)) - (sum(y)))')
  assert.deepEqual(rows[0].drillDims, ['system_book', 'bizday', 'branch_num', 'order_no'])
  assert.deepEqual(rows[0].drillDetail, { relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" })
})
it('compose 引用未声明组件 ⇒ 响亮失败', () => {
  assert.throws(/未声明的度量组件/, () => declarationsFromYaml({
    metrics: [{ name: 'lemeng:retail:net_sales', label: 't', definition: 'd',
      expression: 'sum(fct_retail_sale.net_amount)', grain: ['system_book'], source: 'lemeng',
      freshness_sla_days: 1, compose: 'ghost@order', dimensions: ['system_book'],
      detail: { relation: 'vw_x', filter: 'true' } }],
  }))
})
it('compose 含乘除/数字等文法外记号 ⇒ 响亮失败', () => {
  assert.throws(/文法外|组件引用与/, () => declarationsFromYaml({ /* compose: 'sale_amount@order * 2' */ }))
})
it('未声明 compose ⇒ 三字段 null（聚合照旧）', () => {
  const rows = declarationsFromYaml({ metrics: [/* 既有最小夹具，无三键 */] })
  assert.equal(rows[0].drillExpr, null)
})
```

- [ ] **Step 2: 跑确认失败** → **Step 3: 实现**（新函数放 `deriveParams` 之后）：

```js
/** 顶层 `measures:` → Map（键 `<snake>@<snake>`；形状由门禁把守，这里再兜一道：非空、无分号）。 */
export function measuresOf(parsed) {
  const raw = parsed?.measures
  if (raw === undefined || raw === null) return new Map()
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('`measures:` 必须是 `{ "组件名@粒度": 表达式 }` 映射')
  }
  const out = new Map()
  for (const [k, v] of Object.entries(raw)) {
    const body = typeof v === 'string' ? v.trim() : ''
    if (!/^[a-z_]+@[a-z_]+$/.test(k) || body === '' || body.includes(';')) {
      throw new Error(`\`measures.${k}\` 形态不合规 —— 键须 \`<snake>@<snake>\`，表达式须非空且不含分号`)
    }
    out.set(k, body)
  }
  return out
}

const MEASURE_REF_RE = /[A-Za-z_][A-Za-z0-9_]*@[a-z0-9_]+/g

/**
 * compose → drill_expr：组件引用替换为 `(<组件体>)`。封闭文法：只许组件引用与 `+ - ( )` 空白——
 * 乘除/数字/其它标识符一律响亮失败（不引入自由 SQL，全局约束 12；括号包裹保证替换后优先级不变）。
 */
export function composeOf(raw, metricName, measures) {
  if (raw === undefined || raw === null) return null
  const compose = String(raw)
  if (compose.trim() === '' || compose.includes(';')) {
    throw new Error(`指标 \`${metricName}\` 的 compose 必须是非空、不含分号的组件组合式`)
  }
  const stripped = compose.replace(MEASURE_REF_RE, ' ').replace(/[+\-()\s]/g, '')
  if (stripped !== '') {
    throw new Error(`指标 \`${metricName}\` 的 compose 含文法外记号「${stripped.slice(0, 20)}」 —— `
      + '只许组件引用与 + - ( ) 空白（不引入自由 SQL）；新算术请先落成组件')
  }
  return compose.replace(MEASURE_REF_RE, (ref) => {
    const body = measures.get(ref)
    if (body === undefined) {
      throw new Error(`指标 \`${metricName}\` 的 compose 引用了未声明的度量组件 \`${ref}\` —— 请在同文件顶层 \`measures:\` 声明`)
    }
    return `(${body})`
  })
}
```

`declarationsFromYaml` 顶部：`const measures = measuresOf(parsed)`；行组装尾部（`reads` 之前）加：

```js
      // 下钻绑定（spec 2026-10-21 §2.3）：缺省三字段全 null（未声明）。门禁已拦「半套」，
      // 这里对 dimensions/detail 再各兜一道形状（sync 会被手跑，不经 CI）。
      drillExpr: composeOf(m.compose, name, measures),
      drillDims: m.dimensions === undefined ? null
        : (Array.isArray(m.dimensions) && m.dimensions.length > 0
          && m.dimensions.every((/** @type {unknown} */ d) => typeof d === 'string' && /^[a-z_][a-z0-9_]*$/.test(d))
          ? m.dimensions.map(String) : null),
      drillDetail: m.detail === undefined ? null
        : (typeof m.detail === 'object' && m.detail !== null
          && typeof /** @type {any} */ (m.detail).relation === 'string'
          && typeof /** @type {any} */ (m.detail).filter === 'string'
          ? { relation: /** @type {any} */ (m.detail).relation, filter: /** @type {any} */ (m.detail).filter }
          : null),
```

任一为 null 而另两个非 null ⇒ `throw new Error('下钻三键必须同现（门禁同款判据，这里兜手跑）')`。`comparableOf` 元组加 `row.drillExpr, row.drillDims, row.drillDetail`（头注补一句：第六组，下钻声明漂了而库内没刷 = 下钻面静默按旧声明跑，必须被 --check 检出）。

- [ ] **Step 4: 跑** sync 测试 + `--check` 门禁契约（check-data-models 的 `checkSyncCheckContract` 若枚举 comparableOf 元数需同步——先跑 `node scripts/check-data-models.mjs` 看是否红）→ 全绿。
- [ ] **Step 5: Commit** `feat(data): sync 编译 compose→drill_expr 并纳入 --check 比对 (#N)`。

---

### Task 7: drill.ts——buildDrillSql + runDetailQuery

**Files:**
- Create: `modules/data/domain/drill.ts`
- Modify: `modules/data/domain/audit-store.ts`（`AuditEntry` 加 `drill` 可选字段 + INSERT 带列）
- Test: `modules/data/domain/drill.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `paramFilters/DrillBinding/no_detail_binding`；Task 2 `execWithLakeRaceRetry/formatDataAsOf/DATA_AS_OF_SQL`；Task 3 `MetricRow.drill`；mask.ts 的 `maskedSelectSql/effectiveMasks`（不改 mask.ts！）
- Produces: `export async function runDetailQuery(deps: QueryDeps, org: string, requester: Requester | null, metricId: string, args: Record<string, unknown>, detail: DetailArgs): Promise<DetailOutcome>`；`export function buildDrillSql(...): DrillPlan`；`DetailOk.status === 'ok'` 且带 `rowCountTotal: number`（Task 8/9/10 的回包契约）

- [ ] **Step 1: 写失败测试**（假执行器注入，不需要湖；逐条给真断言）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildDrillSql, runDetailQuery } from './drill'

const DRILL = { expr: '(sale_amount@order - return_amount@line)', dims: ['system_book', 'bizday', 'branch_num', 'order_no'], relation: 'vw_t', filter: "state = 'FINISHED'" }

describe('buildDrillSql（纯函数）', () => {
  it('缺省 = 原子粒度，value 降序', () => {
    const p = buildDrillSql(DRILL, DRILL.dims, "org = 'o' AND state = 'FINISHED'", 'value', true, 50, 0)
    expect(p.sql).toBe("select system_book, bizday, branch_num, order_no, sum(value) as value from ( select system_book, bizday, branch_num, order_no, ((sale_amount@order - return_amount@line)) as value from vw_t where org = 'o' AND state = 'FINISHED' group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
    expect(p.rowCountSql).toBe("select count(*) as n from vw_t where org = 'o' AND state = 'FINISHED'")
  })
  it('子集上卷：请求维度变粗', () => {
    const p = buildDrillSql(DRILL, ['system_book', 'bizday'], 'w', 'value', true, 50, 0)
    expect(p.sql).toContain('group by system_book, bizday order by value desc')
  })
})

describe('runDetailQuery', () => {
  // 夹具：makeEnv() 参考 query-service.test.ts 的既有假执行器/词表铺法（catalog 夹具带 drill 字段）
  it('缺 bizday ⇒ bad_param missing_param:bizday（400 面）', async () => { /* outcome.status==='denied' && reason==='bad_param' && detail==='missing_param:bizday' */ })
  it('未声明下钻 ⇒ no_detail_binding（能力陈述）', async () => { /* reason==='no_detail_binding' */ })
  it('dimensions 超出闭集 ⇒ bad_param unknown_dimension:item_num', async () => { /* */ })
  it('limit 5000 静默夹到 500；limit=0 ⇒ bad_param', async () => { /* 两个断言 */ })
  it('ok 回包带 rowCountTotal（来自 count SQL）与 dimensions', async () => { /* rowCountTotal===15222 形状断言 */ })
  it('整值掩码：内层 value 头被 null 化，masking 三态透出', async () => { /* rows 值为 null && masking 有 '<value>' 键 */ })
  it('湖竞态：首次 ETag 错误重试恰一次，审计 reason=lake_race_retry', async () => { /* 复用 query-service.test.ts 的 ETag 假执行器做法 */ })
})
```

- [ ] **Step 2: 跑确认失败** → **Step 3: 实现 drill.ts**（全文如下，是最重的一份代码）：

```ts
// drill.ts — 明细下钻的**唯一**执行入口（spec 2026-10-21 §2.4/§2.5/§2.6）。
// 聚合与下钻是同一组件集的两种维度子集：内层按原子粒度求组件（drill.expr），外层按请求
// 维度上卷。授权零自建：词表裁剪/拒绝链/主体钉死/参数校验全部复用 authz（与 runQuery 同链）；
// 掩码在场判定按**下钻 SQL**做（spec §2.5 细节 1）——用「换 selectSql 的合成行」复用
// effectiveMasks，不改 mask.ts 一个字。
import type { DrillBinding, Requester } from './authz'
import { authorize, paramFilters, sqlQuote, visibleMetrics } from './authz'
import { maskingAuditOf, writeAudit } from './audit-store'
import { loadMergedCatalog } from './metric-store'
import { effectiveMasks, maskedSelectSql } from './mask'
import { runWarehouseSql, warehousePool, DATA_WAREHOUSE_UNCONFIGURED } from './warehouse'
import { decorateWithLabels, loadDimensionLookup } from './dimension-labels'
import { DATA_AS_OF_SQL, execWithLakeRaceRetry, formatDataAsOf, isLakeRaceError, type QueryDeps } from './query-service'

/** limit 缺省/上限（spec §2.4：默认 50，上限 500，超出**静默夹紧**）。 */
export const DETAIL_LIMIT_DEFAULT = 50
export const DETAIL_LIMIT_MAX = 500

export interface DetailArgs {
  dimensions?: string[]
  orderBy?: string
  desc?: boolean
  limit?: number
  offset?: number
}

export interface DetailOk {
  status: 'ok'; subject: string; metricId: string
  /** 本次生效的分组维度（= 原子粒度或其子集，声明序）。 */
  dimensions: string[]
  columns: string[]; rows: unknown[][]
  /** 同一 where 的 `count(*)`（**原始视图行数**，不受 limit/dimensions 影响）——「总行数」的唯一权威。 */
  rowCountTotal: number
  truncated: boolean
  /** 明细面时钟 = 查询执行时刻（直读湖，读到即当时湖的全部状态）。 */
  drill_as_of: string
  /** 聚合面时钟（物化钟）——load_log 缺账时缺席。 */
  data_as_of?: string
  /** 两钟差异的平台声明（spec §2.6：不靠模型自觉）。data_as_of 缺席时不附。 */
  clock_note?: string
  /** 口径射程行（与聚合面同规则：声明了才有）。 */
  scope_line?: string
  masking?: Record<string, string>
}
export type DetailOutcome = DetailOk
  | { status: 'denied'; metricId: string; reason: string; detail?: string }
  | { status: 'error'; metricId: string; reason: 'warehouse_unconfigured' | 'warehouse_transient' | 'warehouse_error'; detail: string }

export interface DrillPlan { sql: string; rowCountSql: string; dimensions: string[] }

/** 外层上卷：内层产出原子粒度行后按请求维度 rollup + 排序分页。
 * buildDrillSql 与掩码路径共用它——外层形状只有一份（掩码只改内层投影，见 runDetailQuery）。 */
function rollupOver(inner: string, dims: string[], orderBy: string, desc: boolean, limit: number, offset: number): string {
  const d = dims.join(', ')
  return `select ${d}, sum(value) as value from ( ${inner} ) t group by ${d} order by ${orderBy} ${desc ? 'desc' : 'asc'} limit ${limit} offset ${offset}`
}

/** 两段下钻 SQL（**纯函数**）：内层原子粒度求组件、外层请求维度上卷 + 排序分页；
 * rowCountSql = 同一 where 的裸 count(*)（spec §2.4：rowCountTotal 的唯一来源）。 */
export function buildDrillSql(
  drill: DrillBinding, requested: string[], where: string,
  orderBy: string, desc: boolean, limit: number, offset: number,
): DrillPlan {
  const atomic = drill.dims.join(', ')
  const inner =
    `select ${atomic}, (${drill.expr}) as value from ${drill.relation} where ${where} group by ${atomic}`
  const sql = rollupOver(inner, requested, orderBy, desc, limit, offset)
  const rowCountSql = `select count(*) as n from ${drill.relation} where ${where}`
  return { sql, rowCountSql, dimensions: requested }
}

export async function runDetailQuery(
  deps: QueryDeps, org: string, requester: Requester | null,
  metricId: string, args: Record<string, unknown>, detail: DetailArgs,
): Promise<DetailOutcome> {
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
    masking: ReturnType<typeof maskingAuditOf>,
    drillFacet: { dimensions: string[]; rowCountTotal: number } | null,
  ) => writeAudit(deps.pool, {
    org, userId: requester?.userId ?? '(anonymous)', channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null, metricId, params: { ...args, ...(detail.dimensions !== undefined ? { dimensions: detail.dimensions } : {}) },
    rowCount, verdict, reason, masking,
    ...(drillFacet !== null ? { drill: drillFacet } : {}),
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null, null, null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  const allMetrics = await loadMergedCatalog(deps.pool, org)
  const catalog = visibleMetrics(allMetrics, requester, deps.adoptedSources)
  // authorize 只是**门**（拒绝链 + 参数校验）；它拼的聚合计划在这里被丢弃——下钻 SQL 由
  // buildDrillSql 另拼，但 where 的参数连接词必须与它同源（paramFilters，Task 1 抽取）。
  const authz = authorize(catalog, requester, metricId, args, allMetrics)
  if (!authz.ok) {
    await audit('denied', authz.reason, null, null, null)
    return { status: 'denied', metricId, reason: authz.reason, detail: authz.detail }
  }
  const metricRow = catalog.find((m) => m.id === metricId)
  const drill = metricRow?.drill
  // 能力陈述，不是权限拒绝（spec §2.6）：L2 行天然落这里（三列恒 NULL）——「Phase 1 不支持
  // L2 下钻」由存储形状涌现，无需特判。
  if (metricRow === undefined || drill === undefined) {
    await audit('denied', 'no_detail_binding', null, null, null)
    return { status: 'denied', metricId, reason: 'no_detail_binding',
      detail: '该指标未声明明细下钻（能力边界，非权限问题）——聚合口径可用 query_metric 查询' }
  }

  // bizday 必传（spec §2.4：直读湖全史 11.14s，随天数线性涨）——参数校验过了 authorize，
  // 但 aggregate 的 bizday 非必填，必填性是下钻面自己的规则。
  const biz = args.bizday
  if (biz === undefined || biz === null || biz === '') {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'missing_param:bizday' }
  }

  // 维度校验：缺省 = 原子粒度（声明序）；显式必须 ⊆ 闭集（不许凭空加列 = 注入面）。
  let requested = drill.dims
  if (detail.dimensions !== undefined) {
    const dims = detail.dimensions
    if (!Array.isArray(dims) || dims.length === 0) {
      await audit('denied', 'bad_param', null, null, null)
      return { status: 'denied', metricId, reason: 'bad_param', detail: 'dimensions_empty' }
    }
    for (const d of dims) {
      if (!drill.dims.includes(d)) {
        await audit('denied', 'bad_param', null, null, null)
        return { status: 'denied', metricId, reason: 'bad_param', detail: `unknown_dimension:${d}` }
      }
    }
    requested = [...dims]
  }

  // 排序：'value'（缺省，降序——「哪几行贡献最大」是下钻的主问题）或请求维度之一。
  const orderBy = detail.orderBy ?? 'value'
  if (orderBy !== 'value' && !requested.includes(orderBy)) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: `unknown_orderby:${orderBy}` }
  }
  const desc = detail.desc ?? true
  // limit/offset：整数域校验 + 静默夹紧（spec §2.4 明文：上限超出**静默**夹紧，不报错）。
  const limitRaw = detail.limit ?? DETAIL_LIMIT_DEFAULT
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'invalid_value:limit' }
  }
  const limit = Math.min(limitRaw, DETAIL_LIMIT_MAX)
  const offset = detail.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'invalid_value:offset' }
  }

  // where：主体钉死（subjectColumn 上的列，视图由 dbt 注入 org）+ 声明 filter + 参数连接词
  //（与聚合同一 paramFilters 产物；wantTotal=false ⇒ total 对下钻是未知键，fail-closed）。
  const pf = paramFilters(metricRow.params, args, false)
  if (!pf.ok) {
    await audit('denied', pf.reason, null, null, null)
    return { status: 'denied', metricId, reason: pf.reason, detail: pf.detail }
  }
  const where = `${metricRow.subjectColumn} = ${sqlQuote(authz.plan.subject)} AND ${drill.filter}${pf.filters.join('')}`

  const plan = buildDrillSql(drill, requested, where, orderBy, desc, limit, offset)
  // 掩码（spec §2.5 细节 1）：在场判定按**下钻 SQL**——拿合成行（selectSql 换成投影串）复用
  // effectiveMasks，本文件不写第二份掩码判定。只掩**投影串**（value 头与列），WHERE/count
  // 不掩：Phase 1 掩码只有整值形态（value 头），且列掩码声明期被 grain/在场守卫拦住碰不到
  // 这里；rowCountTotal 数行数，与值掩码正交。
  const projection = `select ${requested.join(', ')}, (${drill.expr}) as value`
  const masked = maskedSelectSql(
    projection,
    effectiveMasks(allMetrics, { ...metricRow, selectSql: projection }),
    requester.hasScope,
  )
  // 外层上卷与 buildDrillSql 共用 rollupOver——外层形状只有一份（掩码只改内层投影）。
  const sql = rollupOver(
    `${masked.sql} from ${drill.relation} where ${where} group by ${drill.dims.join(', ')}`,
    requested, orderBy, desc, limit, offset,
  )

  const execOnce = (q: string) =>
    deps.execute ? deps.execute(q) : runWarehouseSql(warehousePool(), q)
  const toError = async (err: unknown): Promise<DetailOutcome> => {
    const msg = err instanceof Error ? err.message : String(err)
    const reason =
      msg === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured'
      : isLakeRaceError(err) ? 'warehouse_transient'
      : 'warehouse_error'
    await audit('error', reason, null, null, null)
    return { status: 'error', metricId, reason, detail: msg }
  }

  let retried = false
  let result: { columns: string[]; rows: unknown[][] }
  try {
    const r = await execWithLakeRaceRetry(() => execOnce(sql), deps.raceRetryDelayMs ?? 1_000)
    retried = r.retried
    result = r.result
    const cnt = await execWithLakeRaceRetry(() => execOnce(plan.rowCountSql), deps.raceRetryDelayMs ?? 1_000)
    var rowCountTotal = Number(cnt.rows[0]?.[0] ?? 0)
  } catch (err) {
    return await toError(err)
  }

  // 维度名称解析（与聚合面同一装饰器；失败 ⇒ 名称列缺席，主结果照常交付）。
  const lookup = await (deps.dimensionLookup
    ?? (() => loadDimensionLookup((q) => runWarehouseSql(warehousePool(), q))))()
  if (lookup !== null) result = decorateWithLabels(result, lookup)

  // 两只时钟（spec §2.6）：data_as_of = 物化钟（聚合面）；drill_as_of = 查询执行时刻（明细面
  // 直读湖）。结构上恒不一致 ⇒ 有 data_as_of 就附平台声明，不靠模型自觉。
  let dataAsOf: string | undefined
  try {
    const fresh = await runWarehouseSql(warehousePool(), DATA_AS_OF_SQL)
    if (fresh.rows[0]?.[0] instanceof Date) dataAsOf = formatDataAsOf(fresh.rows[0][0])
  } catch { /* load_log 缺席 ⇒ 缺席（未知 ≠ 捏造） */ }
  const drillAsOf = formatDataAsOf(new Date())

  const scopeNote = typeof metricRow.scopeNote === 'string' ? metricRow.scopeNote.trim() : ''
  const hasMasking = Object.keys(masked.applied).length > 0
  await audit('ok', retried ? 'lake_race_retry' : null, result.rows.length,
    maskingAuditOf(masked.applied, masked.exempted),
    { dimensions: requested, rowCountTotal })

  return {
    status: 'ok',
    subject: authz.plan.subject,
    metricId,
    dimensions: requested,
    columns: result.columns,
    rows: result.rows,
    rowCountTotal,
    truncated: result.rows.length >= limit,
    drill_as_of: drillAsOf,
    ...(dataAsOf !== undefined ? {
      data_as_of: dataAsOf,
      clock_note: `⏱ 明细直读数据湖（查询时刻 ${drillAsOf}），聚合口径截至 ${dataAsOf}——两个时钟不同，逐行相加可能与聚合值不一致，以各自标注为准`,
    } : {}),
    ...(scopeNote !== '' ? { scope_line: `📐 口径：${scopeNote}` } : {}),
    ...(hasMasking ? { masking: masked.applied } : {}),
  }
}
```

（`rowCountTotal` 的 `var` 是 TS 块级作用域临时态——嫌丑就在 try 外先 `let rowCountTotal = 0` 再赋值，**实现时落成 let**。）

- [ ] **Step 4: audit-store.ts 扩展**——`AuditEntry` 加可选字段与 INSERT 列（同提交）：

```ts
  /** 下钻面（spec 2026-10-21 §2.5）：下钻审计带粒度与总数；聚合审计缺席（null）。 */
  drill?: { dimensions: string[]; rowCountTotal: number } | null
```

`writeAudit` INSERT 列清单尾加 `, drill`、占位加 `, $11::jsonb`、参数加 `entry.drill === undefined || entry.drill === null ? null : JSON.stringify(entry.drill)`。迁移 021 已建列（Task 3）。

- [ ] **Step 5: 跑** `pnpm --filter data test -- drill` 全绿；再跑 `pnpm --filter data test`（全模块）确认零回归。
- [ ] **Step 6: Commit** `feat(data): runDetailQuery——两段下钻 SQL 与授权掩码接线 (#N)`。

---

### Task 8: HTTP 路由 /query/detail + manifest 同提交对齐

**Files:**
- Create: `modules/data/routes/query-detail.ts`
- Modify: `modules/data/manifest.yaml`（api.internal 问数面段）+ `modules/data/index.ts`（注册）
- Test: `modules/data/routes/query-detail.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 `runDetailQuery`
- Produces: `POST /api/modules/data/query/detail`（scope `data:query`）；请求体 `{ metricId, args?, dimensions?, orderBy?, desc?, limit?, offset? }`；状态码三分法与 /query 一致（ok 200 / denied 403 / error 502）

- [ ] **Step 1: 写失败测试**（夹具照 `modules/data/routes/query.test.ts` 现有铺法——先读它，复用同一 `buildTestApp`/身份注入；断言三例）：

```ts
it('缺 bizday ⇒ 403 + reason=bad_param + detail=missing_param:bizday', ...)
it('未声明下钻的指标 ⇒ 403 + reason=no_detail_binding（body 带能力陈述 detail）', ...)
it('合法下钻（假执行器）⇒ 200 + rowCountTotal 在场', ...)
```

- [ ] **Step 2: 跑确认失败** → **Step 3: 实现路由**（形状照 query.ts，逐行同构）：

```ts
// query-detail.ts — POST /query/detail：明细下钻的 HTTP 面（spec 2026-10-21 §2.4）。
// 状态码映射与 /query 同一三分法（#30 订正）：ok → 200；denied → 403；error → 502。
// denied 的 body 带 reason/detail——`no_detail_binding` 是能力陈述，企微插件靠它换措辞
// （不当「没权限」说），所以 body 必须透传 reason，不得吞成统一文案。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { runDetailQuery } from '../domain/drill'

const DetailBody = z.object({
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  dimensions: z.array(z.string()).optional(),
  orderBy: z.string().optional(),
  desc: z.boolean().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
})

export function registerQueryDetail(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/query/detail', async (c) => {
    const parsed = DetailBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
    const { metricId, args, ...rest } = parsed.data
    const outcome = await runDetailQuery(
      { pool: ctx.pool, execute: ctx.execute, adoptedSources },
      org, requesterOf(c), metricId, args, rest,
    )
    if (outcome.status === 'ok') return c.json(outcome)
    if (outcome.status === 'denied') return c.json(outcome, 403)
    return c.json(outcome, 502)
  })
}
```

- [ ] **Step 4: manifest + index 同一提交**——manifest api.internal 问数面段加一行（注释同行）：

```yaml
    # 明细下钻（spec 2026-10-21 §2.5：路由门必须与 /query 同清单声明——装载期双向核对）
    - { method: POST, path: /query/detail, scope: data:query }
```

`index.ts` 加 `import { registerQueryDetail } from './routes/query-detail'` 与 `registerQueryDetail(r, _ctx) // spec 2026-10-21 下钻`（放 registerQuery 之后）。
- [ ] **Step 5: 跑**路由测试 + **装载期双向核对**（module 装载测试即核对——跑全模块测试；少声明/多声明都会在既有 loader 测试红）→ 全绿。
- [ ] **Step 6: Commit** `feat(data): POST /query/detail 路由与清单声明 (#N)`。

---

### Task 9: agent-loop 第三把工具 + MCP 读面静态工具

**Files:**
- Modify: `modules/data/domain/agent-loop.ts`（`TOOLS` 数组、`runTool`、`describeCall`）
- Modify: `modules/data/routes/mcp.ts`（`readToolset`）
- Test: `modules/data/domain/agent-loop.test.ts` + `modules/data/routes/mcp.test.ts` 追加

**Interfaces:**
- Consumes: Task 7 `runDetailQuery`
- Produces: agent 工具 `query_detail`（inputSchema `{metricId, args, dimensions?, orderBy?, desc?, limit?, offset?}`）；MCP 工具 `query_detail`（tools/list 恒在——工具的存在不是存在性探针，能力陈述在调用回包里）

- [ ] **Step 1: agent-loop 写失败测试**（照 agent-loop.test.ts 既有假 model/假 catalog 铺法；catalog 夹具加一条带 drill 的指标）：

```ts
it('query_detail：透传 dimensions/limit 并走 runDetailQuery', async () => {
  // 假 model 触发 tool_calls=[{name:'query_detail', arguments:{metricId, args:{bizday:{from,to}}, dimensions:['system_book'], limit:10}}]
  // 断言注入的假执行器收到的 SQL 含 'group by system_book order by value desc limit 10'
})
it('query_detail 的 total 键被拒（unknown_param:total）', async () => { /* fail-closed 回归 */ })
```

- [ ] **Step 2: 实现**——`TOOLS` 追加第三把（描述按 flash 级模型口径写全规则，与 query_metric 同风格）：

```ts
  {
    name: 'query_detail',
    description: [
      '按指标下钻到明细构成（订单级）。**只对声明了下钻的指标可用**（调用后 status=denied 且 reason=no_detail_binding = 该指标不支持，改用 query_metric，不要重试）。',
      'args.bizday **必传**（{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}，查单日 from=to）——直读数据湖，范围越大越慢。',
      '回包 rowCountTotal = 该范围的**全量原始行数**（不受 limit/分组影响）——回答「多少行」用它，不要拿 rows 长度或把样本当全量。',
      'dimensions 缺省 = 最细（订单级）；传入必须是 list 后该指标声明维度的子集（变粗上卷）。回包默认按 value 降序。',
      '「哪几行/哪几单贡献最大」用本工具；「合计多少」用 query_metric 的 total。',
      '回包带 drill_as_of（明细查询时刻）与 data_as_of（聚合口径截止）+ clock_note——两个时钟不同，逐行相加可能与聚合值不一致，以 clock_note 为准原样转述。scope_line 有则原样单独一行附在答案末尾。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: '指标 id，取自 list_metrics' },
        args: { type: 'object', description: '指标参数；bizday 必传', additionalProperties: true },
        dimensions: { type: 'array', items: { type: 'string' }, description: '分组维度子集；缺省 = 最细（订单级）' },
        orderBy: { type: 'string', description: "排序键，'value'（缺省）或维度名" },
        desc: { type: 'boolean', description: '降序（缺省 true）' },
        limit: { type: 'number', description: '返回行数，默认 50，上限 500' },
        offset: { type: 'number', description: '翻页偏移' },
      },
      required: ['metricId'],
    },
  },
```

`runTool` 的 dispatch：`query_metric` 分支之前加 `query_detail` 分支（联合每支都带 `status` 的现有纪律不变）：

```ts
  if (call.name === 'query_detail') {
    const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : ''
    const rawArgs = call.arguments.args
    const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>) : {}
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined)
    const dims = Array.isArray(call.arguments.dimensions)
      ? call.arguments.dimensions.filter((d): d is string => typeof d === 'string') : undefined
    return runDetailQuery(
      { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
      deps.org, requester, metricId, args, {
        dimensions: dims,
        orderBy: typeof call.arguments.orderBy === 'string' ? call.arguments.orderBy : undefined,
        desc: typeof call.arguments.desc === 'boolean' ? call.arguments.desc : undefined,
        limit: num(call.arguments.limit),
        offset: num(call.arguments.offset),
      })
  }
```

`describeCall` 加 `if (call.name === 'query_detail') return \`下钻明细 ${metricIdOf(call)}\``（复用既有取 id 逻辑）。

- [ ] **Step 3: MCP 读面**——mcp.ts：list() 返回值改为 `[..., visibleMetrics(...).map(toTool), DETAIL_TOOL]`；call() 开头加分发：

```ts
// 下钻工具（spec 2026-10-21 §2.4）：与 /query/detail 同一 runDetailQuery——授权核心同链。
const DETAIL_TOOL = {
  name: 'query_detail',
  description: '按指标下钻到明细构成（订单级）。args.bizday 必传；回包 rowCountTotal=全量原始行数；dimensions 缺省=最细。仅对声明了下钻的指标可用（否则回 no_detail_binding）。',
  inputSchema: {
    type: 'object',
    properties: {
      metricId: { type: 'string' }, args: { type: 'object', additionalProperties: true },
      dimensions: { type: 'array', items: { type: 'string' } },
      orderBy: { type: 'string' }, desc: { type: 'boolean' },
      limit: { type: 'number' }, offset: { type: 'number' },
    },
    required: ['metricId'],
  },
} as const
```

```ts
    if (name === 'query_detail') {
      const out = await runDetailQuery(
        { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
        deps.org, deps.requester,
        typeof args.metricId === 'string' ? args.metricId : '',
        typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {},
        {
          dimensions: Array.isArray(args.dimensions) ? args.dimensions as string[] : undefined,
          orderBy: typeof args.orderBy === 'string' ? args.orderBy : undefined,
          desc: typeof args.desc === 'boolean' ? args.desc : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
        })
      return { text: JSON.stringify(out), isError: out.status !== 'ok' }
    }
```

- [ ] **Step 4: MCP 测试追加**（mcp.test.ts：tools/list 含 query_detail；call 分发到假执行器）。
- [ ] **Step 5: 跑** `pnpm --filter data test` 全绿（catalog-consumers 四通道守卫天然覆盖：下钻走同一 loadMergedCatalog + visibleMetrics，无第五条加载器）。
- [ ] **Step 6: Commit** `feat(data): query_detail 进 agent 工具面与 MCP 读面 (#N)`。

---

### Task 10: 企微通道（openclaw 插件）+ SKILL 指引

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/index.js`（DETAIL_DEF + 注册）
- Modify: `deploy/openclaw/data-query-plugin/lib.js`（callPlatform 的 403 分支加 `no_detail_binding` 映射）
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`
- Test: 插件既有 node --test 文件（`ls deploy/openclaw/data-query-plugin/*.test.js` 定位）追加

**Interfaces:**
- Consumes: Task 8 的 HTTP 面（403 body 带 `reason: 'no_detail_binding'`）
- Produces: 企微工具 `query_detail`（path `/query/detail`，method POST）

- [ ] **Step 1: lib.js 测试先行**——`no_detail_binding` 映射用例（fetchImpl 注入假 403 响应）：

```js
test('403 no_detail_binding ⇒ 能力陈述文案（不当权限拒绝说）', async () => {
  const out = await callPlatform({ fetchImpl: ok403({ reason: 'no_detail_binding' }), channelKey: 'k', userId: 'u', path: '/query/detail', method: 'POST', body: {} })
  assert.equal(out.code, 'NO_DETAIL_BINDING')
  assert.match(out.error, /不支持.*下钻|能力/)
  assert.doesNotMatch(out.error, /不在你的可见范围/)   // 与 DENIED 文案严格分家
})
```

- [ ] **Step 2: lib.js callPlatform 的 403 分支、在 `bad_param` 分支后加**：

```js
    if (data.reason === "no_detail_binding") {
      return {
        code: "NO_DETAIL_BINDING",
        error: "该指标暂不支持明细下钻（能力边界，不是权限问题）——聚合口径可用 query_data 查询。",
      };
    }
```

- [ ] **Step 3: index.js 注册第四把工具**（LIST/QUERY 同款 factory；description 按 flash 口径写全）：

```js
const DETAIL_DEF = {
  name: "query_detail",
  description:
    "按指标下钻到明细构成（订单级）。args.bizday 必传（{\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}，查单日 from=to）。回包 rowCountTotal = 该范围**全量原始行数**——回答「多少行」用它，不要拿返回行数当全量。dimensions 缺省=最细（订单级）；orderBy 缺省按 value 降序（「哪几单贡献最大」直接问）。仅对声明了下钻的指标可用；回 no_detail_binding 时如实告知该指标不支持下钻、可改用 query_data，不要重试。回包带 drill_as_of/data_as_of/clock_note（两个时钟）与 scope_line——clock_note 与 scope_line 原样转述/钉在答案末尾。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: { type: "object", description: "参数；bizday 必传", additionalProperties: true },
      dimensions: { type: "array", items: { type: "string" } },
      orderBy: { type: "string" }, desc: { type: "boolean" },
      limit: { type: "number" }, offset: { type: "number" },
    },
    required: ["metricId"],
    additionalProperties: false,
  },
};
```

注册块（QUERY 之后）：

```js
    api.registerTool(
      factory(
        DETAIL_DEF,
        (params, userId) =>
          callPlatform({
            apiBase, channelKey: CHANNEL_KEY, userId,
            path: "/query/detail",
            method: "POST",
            body: {
              metricId: params.metricId,
              args: params.args ?? {},
              ...(Array.isArray(params.dimensions) ? { dimensions: params.dimensions } : {}),
              ...(typeof params.orderBy === "string" ? { orderBy: params.orderBy } : {}),
              ...(typeof params.desc === "boolean" ? { desc: params.desc } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
              ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            },
          }),
        (result, sessionKey, runId) => {
          if (!result) return;
          const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
          if (scope) freshnessStore.capture(sessionKey, { scope }, runId);
        },
      ),
      { name: DETAIL_DEF.name },
    );
```

（freshnessStore.capture 的第一参形状是 `{freshness, scope}`——查 freshnessStore.capture 实现确认 partial 入参合法；不合法就传 `{ freshness: undefined, scope }`。）
- [ ] **Step 4: SKILL.md 加「明细下钻」节**（先读现文件 63 行，沿用其行文；内容：什么时候用 query_detail（行数/构成/贡献分解）、bizday 必传、rowCountTotal 权威、no_detail_binding 的正确话术、双时钟声明原样转述）。
- [ ] **Step 5: 跑**插件测试 `node --test deploy/openclaw/data-query-plugin/`；**Commit** `feat(openclaw): 企微问数第四把工具 query_detail (#N)`。

---

### Task 11: 真机部署与验收（spec §4 全表）

**Files:** 无新代码；全部经 openship MCP 操作（唯一通道）。

- [ ] **Step 1: PR + 合并**——PR 标题 `feat(data): bot 问数明细下钻 Phase 1 (#N)`，body `Closes #N` + 三处裁决点说明；等 CI 全绿（**CLEAN，不带 UNSTABLE 强合**——merge-only-on-clean-CI 纪律）；merge main = 门禁全绿自动部署。
- [ ] **Step 2: 部署后验证（deploy-verify 纪律）**——容器创建时间 > 镜像构建时间；进容器 grep 产物（`docker exec <api容器> grep -c no_detail_binding /app/...` 或按 [deploy-verify-grep-container-not-http] 记忆的配方）。
- [ ] **Step 3: 物化链**——① 跑 sync（数据面既有 sync job，openship MCP `post_jobs_by_key_run`），验 `data.metrics` 里 `lemeng:retail:net_sales` 行 `drill_expr IS NOT NULL AND drill_dims IS NOT NULL`（经 openship 对仓库连接执行只读 SQL）；② `sync-data-semantics --check` 零漂移；③ 触发 materialize（dbt build 跑新不变量测试），日志含 `assert_drill_net_sales_matches_fct` PASS。
- [ ] **Step 4: 不变量真机双向验证（变异确认——判据只有变异能证真）**：经 openship 对 pg_duckdb 容器 exec psql：① 控制组 = 不变量 SQL 原文 → **0 行**；② 变异组 = 同 SQL 把 `/ 2` 改 `/ 4` → **>0 行**（预期 ~6122 量级店日）→ 证「真能变红」。只读 SELECT，零风险。
- [ ] **Step 5: Phase 1 四不变量逐条验收**：
  - **口径同源**：取 2-3 个闭窗店日，`query_detail(dimensions=[system_book,bizday,branch_num])` 逐值 == `query_metric(net_sales, 同参)` 逐值（1 分容差）。
  - **掩码同源**：用带整值掩码的请求者（或临时给 net_sales 声明验证后撤销）——掩码后下钻 value 恒 NULL == 聚合面 NULL；`masking` 字段两面同现。
  - **总数不骗人**：`query_detail(args={bizday: 10-20})` 的 `rowCountTotal` == 直查 `select count(*) from vw_lemeng_retail_order_line where state='FINISHED' and bizday='2026-10-20' and org=...`（预期 **15,222** 量级，不是 219）。
  - **聚合面零变化**：43 条指标抽全量 list 正常 + `data.query_audit` 当日聚合审计与上线前形状一致（drill 列 NULL）。
- [ ] **Step 6: 真机渠道轮（企微真机，避开部署窗口）**：①「10-20 有多少行」→ 答 15,222 且说明口径；②「哪几行贡献最大」→ value 降序 + 可翻页；③ 回包带双时间戳与平台声明；④ `data.query_audit` 有对应行且 `drill IS NOT NULL`。
- [ ] **Step 7: 回滚演练（桌面）**：确认回滚 = ① manifest/路由摘除或 ② 线上把该指标 drill_expr 置 NULL（sync 删声明再物化）——聚合通路一字不动。把两种开关写进 PR 的「回滚」节。

---

### Task 12: spec 附录 + 收尾

- [ ] **Step 1: spec 附录**——`docs/superpowers/specs/2026-10-21-bot-drillthrough-design.md` 末尾加「§7 实施订正（Phase 1 落地时）」：三条裁决点的定案与算术（item_num 闭集、列掩码缓 Phase 2 的不变量冲突证明、filter=state）。
- [ ] **Step 2: CHANGELOG 不手写**（release.mjs 生成）；确认提交均为 conventional 格式、PR squash 后 subject 带 `(#N)`。
- [ ] **Step 3: 经验沉淀**——若过程中踩了新坑（mask.ts 锚行为、openclaw capture partial 形状等），先查重再更新 WeKnora 对应条目；不新建重复条目。

---

## Self-Review 记录

- **Spec 覆盖**：§2.3 声明面 → Task 4/5/6；§2.4 query_detail+rowCountTotal+bizday 必传 → Task 7；§2.5 权限五机制 → Task 1/3/7/8（词表裁剪/主体谓词/掩码/审计/路由门各归位）；§2.6 错误与双时钟 → Task 7；§4 Phase 1 判据 → Task 11；§4 真机渠道轮 → Task 11 Step 6；回滚 → Task 11 Step 7；§5 非目标（L2 不支持=存储涌现、无自由 SQL=compose 文法、不改 marts=全程未触）。spec §2.7 内存对齐 Phase 0 已做（#973）。
- **已知偏差**：三处（裁决点），均在计划头与 PR 显式声明，spec 附录回写。
- **类型一致性**：`DrillBinding{expr,dims,relation,filter}` 贯穿 Task 1/3/5/6/7；`DetailOk.rowCountTotal` 贯穿 7/8/9/10/11；`paramFilters` 返回 `{ok:true,filters}`/`{ok:false,reason,detail}` 与 authorize 现行 AuthzResult 的 denied 形状对齐；audit `drill` 可选字段与迁移 021 列名一致。
