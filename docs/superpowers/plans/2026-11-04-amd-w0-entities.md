# W0 实体与同义词声明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本计划对应路线图 §3 的 W0**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`
> 开工前先读该文件 §1/§3/§5，并用命令核实代码现状。

**Goal:** 让指标能声明「实体」和「同义词」，并**落库到词表**、被问数工具消费（搜索命中、详情返回），为 W2 的候选生成与消歧提供声明面。

**Architecture:** 声明侧（`dbt/semantics/l1_metrics.yml`）新增顶层 `entities:` 与指标级 `entity`/`synonyms`；门禁（`check-data-models.mjs`）扩键闭集与引用自洽校验；物化侧（`sync-data-semantics.mjs` → `upsertL1Metric`）把两个字段写进 `data.metrics` 新列；消费侧（`toolbox/discovery.ts`）让 `search_catalog` 匹配同义词、`describe_metric` 返回实体与同义词。

**Tech Stack:** YAML 声明 / Node ESM 脚本 / vitest / Hono 工具面 / PostgreSQL（迁移 `modules/data/migrations/`）。

## Global Constraints

- **B11 口径单一定义**：本波**不改**任何 `expression`/`ratio`/`grain`，只加声明与消费。
- **声明即授权（fail-closed）**：未知键必须红（`METRIC_KEYS` 是闭集）；`metric.entity` 引用不存在的实体必须红。
- **迁移幂等**：`add column if not exists`；同一批迁移重复执行不报错（`db-migration` 纪律）。
- **不编数据**：本波**不**加 `sample_values`（由 W2 profiler 从真实数据产出）。
- **L1 行由 sync 独占写**：本波不允许任何 API 写 `entity`/`synonyms`（L2 行恒 NULL/空）。
- **提交纪律**：feat/fix 需 issue；PR 走 squash；CHANGELOG 不手写。

---

### Task 1: 声明面与门禁（YAML 结构 + 校验）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（加 `entities:` 与 2–3 条指标的 `entity`/`synonyms` 示例）
- Modify: `scripts/check-data-models.mjs`（`METRIC_KEYS`、新实体校验）
- Test: `scripts/check-data-models.test.ts`

**Interfaces:**
- Produces: YAML 顶层 `entities: Record<string, { label: string; synonyms?: string[] }>`；
  指标键 `entity?: string`、`synonyms?: string[]`。
- Produces: `checkDataModels(root)` 对下列情形返回含关键词的错误：
  `entity` 引用未声明实体、`synonyms` 非字符串数组/重复项、`entities` 条目缺 `label`。

- [ ] **Step 1: 写失败测试（fixture 驱动）**

在 `scripts/check-data-models.test.ts` 的基线 fixture 里加：

```ts
const compliant = {
  'dbt/semantics/l1_metrics.yml': [
    'version: 1',
    'entities:',
    '  branch:',
    '    label: 门店',
    '    synonyms: [店铺, 分店]',
    'metrics:',
    "  - name: 'lemeng:retail:sales'",
    '    label: 销售额',
    '    entity: branch',
    '    synonyms: [销售金额, 营业额]',
    '    definition: 测试口径',
    "    expression: 'sum(fct_retail_sale.sale_amount)'",
    '    grain: [branch_num]',
    '    owner: data-platform',
    '    tier: certified',
    '    source: lemeng',
    '    freshness_sla_days: 1',
  ].join('\n'),
}
```

再加三个变异用例（每个只改一处）：

```ts
it('entity 引用未声明实体 ⇒ 红', () => {
  const root = fixture({ ...compliant, 'dbt/semantics/l1_metrics.yml': compliant['dbt/semantics/l1_metrics.yml']!.replace('entity: branch', 'entity: store') })
  const out = checkDataModels(root)
  expect(out.some((e) => e.message.includes('未声明的实体'))).toBe(true)
})

it('synonyms 有重复项 ⇒ 红', () => {
  const root = fixture({ ...compliant, 'dbt/semantics/l1_metrics.yml': compliant['dbt/semantics/l1_metrics.yml']!.replace('[销售金额, 营业额]', '[销售金额, 销售金额]') })
  const out = checkDataModels(root)
  expect(out.some((e) => e.message.includes('synonyms 有重复项'))).toBe(true)
})

it('entities 条目缺 label ⇒ 红', () => {
  const root = fixture({ ...compliant, 'dbt/semantics/l1_metrics.yml': compliant['dbt/semantics/l1_metrics.yml']!.replace('    label: 门店\n', '') })
  const out = checkDataModels(root)
  expect(out.some((e) => e.message.includes('entities.branch 缺 label'))).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/check-data-models.test.ts -t "entity"`
Expected: FAIL（当前门禁不认识 `entities`，且 `METRIC_KEYS` 不含 `entity`/`synonyms`）

- [ ] **Step 3: 改门禁**

在 `scripts/check-data-models.mjs`：

```js
const METRIC_KEYS = new Set([
  // …既有键原样保留…
  'entity', 'synonyms',
])

const ENTITY_KEYS = new Set(['label', 'synonyms'])
const ENTITY_NAME_RE = /^[a-z][a-z0-9_]*$/
```

在逐文件扫描 `parsed.metrics` 之前，先校验顶层 `entities`：

```js
const entities = parsed.entities ?? {}
if (entities !== null && typeof entities === 'object' && !Array.isArray(entities)) {
  for (const [name, def] of Object.entries(entities)) {
    if (!ENTITY_NAME_RE.test(name)) push(file, 0, 'entities 名必须是 snake_case：' + name)
    if (def === null || typeof def !== 'object' || Array.isArray(def)) { push(file, 0, `entities.${name} 必须是对象`); continue }
    for (const k of Object.keys(def)) if (!ENTITY_KEYS.has(k)) push(file, 0, `entities.${name} 有未知键 \`${k}\``)
    if (typeof def.label !== 'string' || def.label === '') push(file, 0, `entities.${name} 缺 label`)
    if (def.synonyms !== undefined && (!Array.isArray(def.synonyms) || def.synonyms.some((s) => typeof s !== 'string' || s === ''))) {
      push(file, 0, `entities.${name}.synonyms 必须是非空字符串数组`)
    }
  }
}
```

在逐指标校验处加：

```js
if (m.entity !== undefined) {
  if (typeof m.entity !== 'string' || !ENTITY_NAME_RE.test(m.entity)) push(file, lineOfMetric, `指标 \`${m.name}\` 的 entity 必须是 snake_case`)
  else if (!Object.hasOwn(entities, m.entity)) push(file, lineOfMetric, `指标 \`${m.name}\` 引用了未声明的实体 \`${m.entity}\``)
}
if (m.synonyms !== undefined) {
  if (!Array.isArray(m.synonyms) || m.synonyms.some((s) => typeof s !== 'string' || s === '')) {
    push(file, lineOfMetric, `指标 \`${m.name}\` 的 synonyms 必须是非空字符串数组`)
  } else if (new Set(m.synonyms).size !== m.synonyms.length) {
    push(file, lineOfMetric, `指标 \`${m.name}\` 的 synonyms 有重复项`)
  }
}
```

⚠️ `push` 的签名是 `(file, line, message)`——**三个参数**，`line` 取该指标在文件里的行号变量（沿用该扫描块既有的行号来源；没有就传 `0`，既有规则里 `0` 表示文件级）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/check-data-models.test.ts`
Expected: PASS（含三个新变异用例）

- [ ] **Step 5: 提交**

```bash
git add dbt/semantics/l1_metrics.yml scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "feat(data): L1 声明支持 entities/entity/synonyms（含门禁）"
```

---

### Task 2: 落库（迁移 + 存储层）

**Files:**
- Create: `modules/data/migrations/031_metric_semantics_meta.sql`
- Modify: `modules/data/domain/metric-store.ts`（`L1MetricDef`、`MetricRow`、`ROW_COLUMNS`、`toMetricRow`、`upsertL1Metric`）
- Test: `modules/data/domain/metric-store.test.ts`

**Interfaces:**
- Produces: `MetricRow.entity: string | null`、`MetricRow.synonyms: string[]`（恒数组，缺省 `[]`）。
- Produces: `upsertL1Metric` 原地扩展，写 `entity` / `synonyms`（jsonb）。

- [ ] **Step 1: 写失败测试**

在 `modules/data/domain/metric-store.test.ts` 加：

```ts
it('L1 行的 entity/synonyms 往返一致；L2 行恒 NULL/空', async () => {
  const def = {
    id: 'w0:test:sales', title: '销售额', description: 'd', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select sum(sale_amount) as value from fct_retail_sale',
    groupBy: 'org', params: {}, totalable: false, scopeNote: '', slaDays: 1,
    sourceSystem: null, freshnessRelations: [], masks: null,
    entity: 'branch', synonyms: ['营业额', '销售金额'],
  }
  await upsertL1Metric(pool, def as never)
  const rows = await loadPlatformCatalog(pool)
  const hit = rows.find((r) => r.id === 'w0:test:sales')!
  expect(hit.entity).toBe('branch')
  expect(hit.synonyms).toEqual(['营业额', '销售金额'])

  await upsertMetric(pool, 'org-w0-test', {
    id: 'w0:test:l2', title: 'L2', description: 'd', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select 1 as value from t', groupBy: 'org',
    params: {}, totalable: false,
  } as never, 'u-w0')
  const l2 = (await loadMergedCatalog(pool, 'org-w0-test')).find((r) => r.id === 'w0:test:l2')!
  expect(l2.entity).toBeNull()
  expect(l2.synonyms).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run modules/data/domain/metric-store.test.ts -t "entity/synonyms"`
Expected: FAIL（列不存在 / 类型无字段）

- [ ] **Step 3: 建迁移**

`modules/data/migrations/031_metric_semantics_meta.sql`：

```sql
-- 031_metric_semantics_meta.sql — L1 语义深化（W0）：实体与同义词
--
-- 两列都是**声明侧物化**：只有 sync 从 dbt/semantics/l1_metrics.yml 写；
-- L2 行恒 NULL / '[]'::jsonb（没有声明面）。幂等：add column if not exists。
alter table data.metrics
  add column if not exists entity    text,
  add column if not exists synonyms  jsonb;

comment on column data.metrics.entity is
  '实体名（L1 声明侧）；NULL = 未声明。L2 行恒 NULL';
comment on column data.metrics.synonyms is
  '同义词数组（L1 声明侧）；缺省空数组。L2 行恒空';
```

- [ ] **Step 4: 改存储层**

`ROW_COLUMNS` 末尾追加 `, entity, synonyms`。

`MetricRow` 加：

```ts
/** 实体名（L1 声明侧）；NULL = 未声明。L2 行恒 null。 */
entity: string | null
/** 同义词（L1 声明侧）；恒数组，缺省 []。L2 行恒 []。 */
synonyms: string[]
```

`toMetricRow` 加归一：

```ts
entity: typeof row.entity === 'string' ? row.entity : null,
synonyms: Array.isArray(row.synonyms) ? row.synonyms.map(String) : [],
```

`L1MetricDef` 加可选 `entity?: string; synonyms?: string[]`。

`upsertL1Metric` 的 insert 列表加 `entity, synonyms`，values 加 `$20, $21::jsonb`，`on conflict … do update set` 加：

```sql
       entity              = excluded.entity,
       synonyms            = excluded.synonyms,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run modules/data/domain/metric-store.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add modules/data/migrations/031_metric_semantics_meta.sql modules/data/domain/metric-store.ts modules/data/domain/metric-store.test.ts
git commit -m "feat(data): 指标词表落库 entity/synonyms（迁移 031）"
```

---

### Task 3: sync 写侧 + 消费面

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（构造 L1MetricDef 时带上 `entity`/`synonyms`）
- Modify: `modules/data/domain/toolbox/discovery.ts`（`searchImpl` 匹配同义词；`describeMetricImpl` 返回）
- Test: `scripts/sync-data-semantics.test.ts`、`modules/data/domain/toolbox/discovery.test.ts`

**Interfaces:**
- Consumes: Task 1 的两字段声明、Task 2 的存储字段。
- Produces: `search_catalog` 的 `q` 命中同义词时返回该指标；`describe_metric` 返回 `entity` 与 `synonyms`（有才返回）。

- [ ] **Step 1: 写失败测试（消费面）**

在 `modules/data/domain/toolbox/discovery.test.ts`：

```ts
it('search_catalog 命中同义词', async () => {
  const out = await searchImpl(deps([row({ synonyms: ['营业额'] })]), { kind: 'metric', q: '营业额' })
  const results = (out.payload as { results: { id: string }[] }).results
  expect(results.map((r) => r.id)).toContain('lemeng:retail:net_sales')
})

it('describe_metric 返回 entity/synonyms', async () => {
  const out = await describeMetricImpl(deps([row({ entity: 'branch', synonyms: ['营业额'] })]), { id: 'lemeng:retail:net_sales' })
  expect((out.payload as { entity: string }).entity).toBe('branch')
  expect((out.payload as { synonyms: string[] }).synonyms).toEqual(['营业额'])
})
```

⚠️ 同时改 `deps()` 里那条假 DB 行：把 `entity: m.entity, synonyms: m.synonyms` 加进 `query: async () => ({ rows: catalog.map(...) })` 的映射（否则 `toMetricRow` 读不到，测试会假绿/假红）。`row()` 夹具的默认值也补 `entity: null, synonyms: []`。

⚠️ **同类夹具必须一起补**：`modules/data/domain/toolbox/health.test.ts` 也用 `as MetricRow` 构造行且缺这两字段——Task 2 评审已点名。若 `searchImpl`/`describeMetricImpl` 的代码路径会读到它，运行期 `undefined.some(...)` 会 TypeError；两处夹具都补默认值。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run modules/data/domain/toolbox/discovery.test.ts -t "同义词"`
Expected: FAIL

- [ ] **Step 3: 改 sync（声明 → 行）**

在构造 `L1MetricDef` 的位置（`sync-data-semantics.mjs` 里映射每条声明的地方）加两个字段透传：

```js
...(typeof m.entity === 'string' ? { entity: m.entity } : {}),
...(Array.isArray(m.synonyms) && m.synonyms.length > 0 ? { synonyms: m.synonyms } : {}),
```

⚠️ 不要在这里另行校验形态——形态归门禁（Task 1），sync 只搬值（两处各判会漂）。

⚠️ **同时改 `comparableOf`（`scripts/sync-data-semantics.mjs` 约 L1118 的固定元组）**：把
`entity` / `synonyms` 纳入比对，否则改了声明后 `--check` **不报漂移**（该元组是「内容比对」的唯一口径）。
⚠️ 二进制的 jsonb 比对口径：`synonyms` 声明侧是数组、库里读回也是数组，直接 `JSON.stringify` 比对。

- [ ] **Step 4: 改消费面**

`searchImpl` 的过滤条件追加：

```ts
|| m.synonyms.some((s) => s.toLowerCase().includes(q))
```

`describeMetricImpl` 的 payload 追加（只在有值时出现，保持「未声明 = 字段缺席」口径）：

```ts
...(m.entity !== null ? { entity: m.entity } : {}),
...(m.synonyms.length > 0 ? { synonyms: m.synonyms } : {}),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run modules/data/domain/toolbox/discovery.test.ts scripts/sync-data-semantics.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add scripts/sync-data-semantics.mjs modules/data/domain/toolbox/discovery.ts modules/data/domain/toolbox/discovery.test.ts scripts/sync-data-semantics.test.ts
git commit -m "feat(data): 词表消费 entity/synonyms（搜索命中 + 详情返回）"
```

---

### Task 4: 真声明 + 全量验证 + 台账

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（至少 `branch` 实体 + 5 条高频指标的同义词）
- Modify: `docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`（§5 台账）

**Interfaces:**
- Consumes: Task 1–3 的全部实现。

- [ ] **Step 1: 真声明（**本波不扩**）**

2026-11-04 用户裁决：**不新增业务同义词**，`l1_metrics.yml` 保留 Task 1 的两个示例即可（真实别名等业务方确认后再补，不编）。

**同时（Task 3 评审遗留，必须一并做）**：
- `modules/data/domain/toolbox/registry.ts` 的 `search_catalog` 描述补「同义词也命中」；`describe_metric` 描述补「返回 entity/synonyms」。工具描述是**模型看到的契约**，不写等于没消费。
- 订正两处过期注释：`scripts/sync-data-semantics.mjs:1066`「16 元组」→ 当前实际元组数；`scripts/check-data-models.mjs:221-223`「本波不落库」→ 已落库。

顶层加：

```yaml
entities:
  branch:
    label: 门店
    synonyms: [店铺, 分店, 门店]
```

给高频指标加（示例，按实际业务词补）：

```yaml
  - name: 'lemeng:retail:net_sales'
    entity: branch
    synonyms: [净销售, 净额, 销售额净, 实收]
```

**判定标准**：只给「业务方真的会换着说」的指标加；没有真实别名的指标**留空**，不编。

- [ ] **Step 2: 跑门禁与同步 dry-run**

```bash
npx tsx scripts/check-data-models.mjs
npx tsx scripts/sync-data-semantics.mjs --check
```

Expected: 两条都 exit 0；`--check` 输出差异里只出现本次新增字段。

- [ ] **Step 3: 跑全量验证（波末）**

```bash
pnpm -r --if-present test && pnpm run test:guard
pnpm run typecheck
```

Expected: 全绿。

- [ ] **Step 4: 更新路线图台账**

把 `docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md` §5 的 W0 行改为：

```md
| W0 | 进行中（实现完成，待 PR） | 2026-11-04 | 2026-11-04 | 门禁绿 · `--check` 无意外 diff · 全量测试绿 | — |
```

⚠️ 状态停在「进行中（实现完成，待 PR）」——**合并后由控制器改为「已完成」并填 PR 号**（台账的「已完成」含义是已合入）。

- [ ] **Step 5: 提交**

```bash
git add dbt/semantics/l1_metrics.yml docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md
git commit -m "docs(data): W0 声明落地并更新路线图台账"
```

---

## Self-Review

**1. Spec coverage（按 spec §5 Wave 0）**
- `entities:` + `entity`/`synonyms` 声明 → Task 1 ✅
- 门禁规则扩展 → Task 1 ✅
- 落库 + 消费 → Task 2/3 ✅
- `sample_values` → **有意不做**（spec/roadmap §7 已记录改由 W2 profiler 产出）✅

**2. Placeholder scan**：无 TBD/TODO；所有代码步给了实际代码；`scripts/sync-data-semantics.mjs` 的插入点用「构造 L1MetricDef 的位置」描述——实施者需先 `grep -n "L1MetricDef"` 定位（该文件 1567 行，插入点唯一）。

**3. Type consistency**：`entity: string | null`、`synonyms: string[]` 在 Task 2 定义，Task 3 的读取与 Task 1 的声明形态一致；`upsertL1Metric` 参数类型 `L1MetricDef` 扩展为可选字段，不破坏既有调用。
