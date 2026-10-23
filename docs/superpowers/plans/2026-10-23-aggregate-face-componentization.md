# 聚合面组件化 Phase 3（P3.0–P3.1 影子对账）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 measure（口径组件）一处声明，编译出下钻行域与 fct 的度量列；本批只做声明模型 + 门禁 + 派生行域 + 影子对账，**运行时零变化**，切换留给影子对账通过后的下一份计划。

**Architecture:** `measures` 从「字符串表达式」升级为对象（`expr` / `domain` / `grain` / `additivity` / `unit`）。`sync` 与 `check-data-models` 消费同一份解析；`detail.filter` 由 `domain` 派生；新增生成器在 `fct_retail_sale.sql` 的标记区写出**影子列**（`sale_amount__gen` / `return_amount__gen` / `net_amount__gen`），由 dbt singular test 与现有列逐分对账。

**Tech Stack:** Node 22 + vitest + tsx（scripts 是 checkJs）；dbt 1.9.1（pg_duckdb）；YAML 声明面。

## Global Constraints

- **运行时零变化**：`query_data` / `query_detail` 的 SQL 形状、`data.metrics` 的字段、四通道回包一律不改。
- **fct 骨架手写**：join / 去重 / 分母 / 分区 / 断言不进声明面；生成器只写标记区。
- **`additivity` 必填**，只允许 `flow` / `stock` / `non_additive`（与指标级 additivity 同一词表）；字符串形态与 `unknown` 均门禁红。
- **对账窗口**：默认 7 天；`tier: certified` 14 天（本批涉及 `net_sales`）。
- **口径不许顺手改**：影子列必须与现有列**逐分一致**（容差 0.01），任何语义变更都停下来裁决。
- 提交规范：`type(scope): subject`；本批每个任务一个提交；CHANGELOG 不手写。
- `deploy/data-plane.lock` 由 `scripts/lemeng/data-plane-lock.mjs` 重新生成，**不手改**。

---

### Task 1: measure 对象形态（解析 + 类型）

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（`measureKeys` / measure 读取处）
- Test: `scripts/sync-data-semantics.test.ts`

**Interfaces:**
- Produces: `measureOf(value) => { expr: string, domain?: string, grain?: string[], additivity: 'flow'|'stock'|'non_additive', unit?: string }`（导出给门禁复用；**唯一解析实现**）
- 对象形态：`{ expr, domain?, grain?, additivity, unit? }`；`grain` 缺省 = `['line']` 语义（组件自述的原子粒度，仅供门禁校验，不进 SQL）

- [ ] **Step 1: 写失败测试**

```ts
// scripts/sync-data-semantics.test.ts 追加
it('measure 对象形态：合法字段解析；字符串形态与 missing additivity 抛错', () => {
  const ok = measureOf({ expr: 'sum(sale_money)', domain: 'sale_finished', grain: ['order'], additivity: 'flow', unit: 'CNY' })
  expect(ok.expr).toBe('sum(sale_money)')
  expect(ok.domain).toBe('sale_finished')
  expect(ok.additivity).toBe('flow')
  expect(() => measureOf('sum(sale_money)')).toThrow(/对象形态|additivity/)
  expect(() => measureOf({ expr: 'sum(x)' })).toThrow(/additivity/)
  expect(() => measureOf({ expr: 'sum(x)', additivity: 'unknown' })).toThrow(/additivity/)
  expect(() => measureOf({ expr: 'sum(x)', additivity: 'flow', domain: "state = 'FINISHED'" })).toThrow(/具名行域/)
  expect(() => measureOf({ expr: 'sum(x)', additivity: 'flow', bogus: 1 })).toThrow(/未知键/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd scripts && pnpm exec vitest run sync-data-semantics`
Expected: FAIL —— `measureOf` 未导出/不存在。

- [ ] **Step 3: 实现解析（唯一实现，门禁 import 它）**

```js
// scripts/sync-data-semantics.mjs
/** @typedef {{ expr: string, domain?: string, grain?: string[], additivity: 'flow'|'stock'|'non_additive', unit?: string }} Measure */
const MEASURE_KEYS = new Set(['expr', 'domain', 'grain', 'additivity', 'unit'])
const ADDITIVITY = new Set(ADDITIVITY_VALUES)  // 与指标级共用：flow / stock / non_additive

/** @param {unknown} v @returns {Measure} */
export function measureOf(v) {
  if (typeof v === 'string') {
    throw new Error('measure 必须是对象形态 { expr, additivity } —— 字符串形态无法表达 additivity（P3.0 起拒绝）')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('measure 必须是对象')
  const o = /** @type {Record<string, unknown>} */ (v)
  for (const k of Object.keys(o)) if (!MEASURE_KEYS.has(k)) throw new Error(`measure 有未知键 \`${k}\`（只许 expr/domain/grain/additivity/unit）`)
  const expr = typeof o.expr === 'string' ? o.expr.trim() : ''
  if (!expr || expr.includes(';')) throw new Error('measure.expr 必须是非空、不含分号的表达式')
  const add = o.additivity
  if (typeof add !== 'string' || !ADDITIVITY.has(add)) throw new Error('measure.additivity 必填且只允许 flow / stock / non_additive')
  if (o.domain !== undefined && (typeof o.domain !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(o.domain))) throw new Error('measure.domain 必须是 domains: 里的具名行域（蛇形标识符），不是自由 SQL')
  if (o.grain !== undefined && (!Array.isArray(o.grain) || o.grain.length === 0 || o.grain.some((g) => typeof g !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(g)))) throw new Error('measure.grain 必须是非空蛇形列名数组')
  if (o.unit !== undefined && (typeof o.unit !== 'string' || !/^[A-Za-z_]+$/.test(o.unit))) throw new Error('measure.unit 必须是简单标识符（CNY / count / ratio）')
  return /** @type {Measure} */ ({ expr, ...(o.domain ? { domain: o.domain } : {}), ...(o.grain ? { grain: o.grain } : {}), additivity: add, ...(o.unit ? { unit: o.unit } : {}) })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd scripts && pnpm exec vitest run sync-data-semantics`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts
git commit -m "feat(data): measure 对象形态与唯一解析（#1012）"
```

---

### Task 2: 门禁消费同一解析 + 迁移存量 3 个 measure

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（`measures:` 三个组件改对象形态）
- Modify: `scripts/check-data-models.mjs`（measures 校验改用 `measureOf`）
- Test: `scripts/check-data-models.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `measureOf`
- Produces: 门禁对 `measures` 的判据与 `sync` 逐字一致（同一函数）

- [ ] **Step 1: 写失败测试**

```ts
it('measures 对象形态：缺 additivity / 字符串形态 / 未知键 ⇒ 拒', () => {
  const base = drillCompliant()
  const bad1 = { ...base, [METRICS]: base[METRICS].replace(
    '  "sale_amount@order": "sum(fct_retail_sale.net_amount)"',
    '  "sale_amount@order": "sum(sale_money)"') }
  expect(checkDataModels(fixture(bad1)).some((v) => /对象形态|additivity/.test(v.message))).toBe(true)

  const bad2 = { ...base, [METRICS]: base[METRICS].replace(
    '  "sale_amount@order": "sum(fct_retail_sale.net_amount)"',
    '  "sale_amount@order": { expr: "sum(sale_money)" }') }
  expect(checkDataModels(fixture(bad2)).some((v) => /additivity/.test(v.message))).toBe(true)

  const good = { ...base, [METRICS]: base[METRICS].replace(
    '  "sale_amount@order": "sum(fct_retail_sale.net_amount)"',
    '  "sale_amount@order": { expr: "sum(sale_money)", additivity: flow }') }
  expect(checkDataModels(fixture(good))).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd scripts && pnpm exec vitest run check-data-models`
Expected: FAIL —— 目前字符串仍被接受。

- [ ] **Step 3: 改门禁**

```js
// scripts/check-data-models.mjs（measures 校验处）
for (const [k, v] of Object.entries(doc.measures)) {
  if (!/^[a-z_]+@[a-z_]+$/.test(k)) push(rel, 0, `\`measures.${k}\` 键名不合 \`<snake>@<snake>\` 形态。`)
  try { syncContract.measureOf(v) } catch (e) { push(rel, 0, `\`measures.${k}\` ${/** @type {Error} */ (e).message}`) }
  measureKeys.push(k)
}
```

- [ ] **Step 4: 迁移测试夹具**

`drillCompliant()` 里的两个 measure 改对象形态（`{ expr: ..., additivity: flow }`），否则同一提交里「三键齐全 ⇒ 零违规」等用例会因字符串形态红掉；同时把删 measures 的用例（`compose 引用未声明组件`）保持不变。

- [ ] **Step 5: 迁移 YAML 三个组件**

```yaml
measures:
  sale_amount@order:
    expr: >-
      case when sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then 1 else 0 end) = 0 then 0
      else (sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' and
        (order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and
         abs(discount_money - order_detail_std_price * quantity) <= 0.02) then 0 else sale_money end)
        + max(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_total_money end)) / 2
        - sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_detail_share_discount else 0 end)
      end
    grain: [order]
    additivity: flow
    unit: CNY
  return_amount@line:
    expr: >-
      sum(case when order_transaction_type like '%RETURN%' and state = 'FINISHED' and
        (order_detail_std_price > 0 and abs(sale_money) > 0 and abs(quantity) > 0 and
         abs(abs(discount_money) - order_detail_std_price * abs(quantity)) <= 0.02) then 0
      when order_transaction_type like '%RETURN%' and state = 'FINISHED' then sale_money + order_detail_share_discount
      else 0 end)
    grain: [line]
    additivity: flow
    unit: CNY
  line_amount@line:
    expr: 'sum(sale_money)'
    grain: [line]
    additivity: flow
    unit: CNY
```

- [ ] **Step 6: 跑门禁与 sync 测试**

Run: `pnpm exec tsx scripts/check-data-models.mjs && cd scripts && pnpm exec vitest run check-data-models sync-data-semantics`
Expected: 门禁 OK（43 指标）；两个测试文件全绿。

- [ ] **Step 7: 提交**

```bash
git add dbt/semantics/l1_metrics.yml scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "feat(data): measures 必填 additivity，门禁与 sync 共用解析（#1012）"
```

---

### Task 3: 具名行域 + `detail.filter` 由组件域 LUB 派生

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（`drillDetailOf` / `declarationsFromYaml`：解析 `domains:`，派生 filter）
- Modify: `scripts/check-data-models.mjs`（`detail.filter` 可缺席但必须可派生；`measure.domain` 必须在 `domains:` 里）——**同一解析/派生实现，不另写**
- Modify: `dbt/semantics/l1_metrics.yml`（`order_line` / `net_sales` 删 `detail.filter`，组件补 `domain`，新增 `domains:`）
- Test: `scripts/sync-data-semantics.test.ts` / `scripts/check-data-models.test.ts`（真事实源用例改为断言派生结果）

**Interfaces:**
- Consumes: Task 1 的 `measureOf`
- Produces:
  - `resolveDomain(name, domains) => string` —— 沿 `extends` 链自根向下用 `and` 拼出完整谓词
  - `domainLub(names, domains) => string` —— 最小上界（公共祖先里最深的那个）；无公共祖先 ⇒ 抛错
  - `detailFilterOf(compose, measures, domains) => string` —— 取所引用组件域的 LUB

- [ ] **Step 1: 写失败测试**

```ts
const DOMAINS = {
  finished: { filter: "state = 'FINISHED'" },
  sale_finished: { extends: 'finished', filter: "order_transaction_type = 'SALE_ORDER'" },
  return_finished: { extends: 'finished', filter: "order_transaction_type like '%RETURN%'" },
}
it('具名行域：完整谓词沿链拼接；LUB = 最近公共祖先', () => {
  expect(resolveDomain('sale_finished', DOMAINS)).toBe("state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'")
  expect(domainLub(['sale_finished', 'return_finished'], DOMAINS)).toBe('finished')
  expect(domainLub(['sale_finished'], DOMAINS)).toBe('sale_finished')
})
it('无公共祖先 ⇒ 抛错（fail-closed，不许放宽成 true）', () => {
  const d = { ...DOMAINS, other: { filter: "state = 'REPAID'" } }
  expect(() => domainLub(['sale_finished', 'other'], d)).toThrow(/公共祖先|LUB/)
})
it('detail.filter = 组件域 LUB：净销售额两组件 ⇒ finished，谓词逐字等于今日物化值', () => {
  const measures = new Map([
    ['sale_amount@order', measureOf({ expr: 'sum(x)', domain: 'sale_finished', additivity: 'flow' })],
    ['return_amount@line', measureOf({ expr: 'sum(y)', domain: 'return_finished', additivity: 'flow' })],
  ])
  expect(detailFilterOf('sale_amount@order - return_amount@line', measures, DOMAINS)).toBe("state = 'FINISHED'")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd scripts && pnpm exec vitest run sync-data-semantics`
Expected: FAIL —— `resolveDomain` / `domainLub` / `detailFilterOf` 不存在。

- [ ] **Step 3: 实现（行域解析 + LUB）**

```js
/**
 * 具名行域：完整谓词 = 沿 extends 链自根向下逐层 and。
 * LUB = 公共祖先里最深的一个；没有公共祖先 ⇒ 抛错（fail-closed：放宽成 true 会让下钻面
 * 悄悄多出别的行域的行，且没有任何报错）。
 * @param {string} name @param {Record<string, {extends?: string, filter: string}>} domains @returns {string}
 */
export function resolveDomain(name, domains) {
  const chain = []
  let cur = name
  const seen = new Set()
  while (cur !== undefined) {
    if (seen.has(cur)) throw new Error(`domains 出现环：${name}`)
    seen.add(cur)
    const d = domains[cur]
    if (!d) throw new Error(`未知行域 \`${cur}\``)
    chain.unshift(d.filter)
    cur = d.extends
  }
  return chain.join(' and ')
}

/** 祖先集合（含自身），自根向下 */
function ancestry(name, domains) {
  const out = []
  let cur = name
  while (cur !== undefined) {
    const d = domains[cur]
    if (!d) throw new Error(`未知行域 \`${cur}\``)
    out.unshift(cur)
    cur = d.extends
  }
  return out
}

/** @param {string[]} names @param {Record<string, {extends?: string, filter: string}>} domains */
export function domainLub(names, domains) {
  if (names.length === 0) throw new Error('domainLub 需要至少一个行域')
  const chains = names.map((n) => ancestry(n, domains))
  const common = chains[0].filter((a) => chains.every((c) => c.includes(a)))
  if (common.length === 0) throw new Error(`行域 ${names.join(' / ')} 没有公共祖先 —— 无法为下钻面定义 LUB`)
  return common[common.length - 1]
}

/** @param {string} compose @param {Map<string, Measure>} measures @param {Record<string, {extends?: string, filter: string}>} domains */
export function detailFilterOf(compose, measures, domains) {
  const refs = [...compose.matchAll(/([a-z_]+@[a-z_]+)/g)].map((m) => m[1])
  if (refs.length === 0) throw new Error(`compose 里没有组件引用：${compose}`)
  const names = refs.map((r) => {
    const m = measures.get(r)
    if (!m) throw new Error(`compose 引用了未声明的组件 ${r}`)
    if (!m.domain) throw new Error(`组件 ${r} 缺 domain —— 下钻行域不能靠放宽，必须显式声明`)
    return m.domain
  })
  return resolveDomain(domainLub(names, domains), domains)
}
```

- [ ] **Step 3.5: 门禁接同一派生（`check-data-models.mjs`）**

```js
// detail.filter 的处理（与 sync 同源）：
//  - 写了 ⇒ 按旧规则校验（迁移窗口内允许）；
//  - 没写 ⇒ 必须能从 compose + measures + domains 派生；派生抛错 ⇒ 门禁红（不许静默缺 filter）。
const filter = typeof detail?.filter === 'string' ? detail.filter : ''
const derived = filter === '' && typeof detail?.relation === 'string'
  ? (() => { try { return syncContract.detailFilterOf(String(metric.fields?.compose ?? ''), measuresOfFile, domainsOfFile) } catch (e) { push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.filter 缺席且无法从组件域派生：${/** @type {Error} */ (e).message}`); return '' } })()
  : filter
if (derived === '' && filter === '') { /* 已在上面 push */ }
// measure.domain 成员性：不在 domains: 里 ⇒ 门禁红（reviewer 指出的 Task 1 缺口在这里闭合）
```

- [ ] **Step 3.6: 门禁用例**

```ts
it('detail.filter 缺席但可派生 ⇒ 零违规；domain 拼错 ⇒ 拒', () => {
  const ok = drillCompliantWithDomains()   // compose 两组件 + domains + detail 无 filter
  expect(checkDataModels(fixture(ok))).toEqual([])
  const bad = drillCompliantWithDomains()
  bad[METRICS] = bad[METRICS].replace('domain: sale_finished', 'domain: sale_finishedd')
  expect(checkDataModels(fixture(bad)).some((v) => /domain|domains/.test(v.message))).toBe(true)
})
```

- [ ] **Step 4: 改 YAML**

```yaml
domains:
  finished:        "state = 'FINISHED'"
  sale_finished:   { extends: finished, filter: "order_transaction_type = 'SALE_ORDER'" }
  return_finished: { extends: finished, filter: "order_transaction_type like '%RETURN%'" }

# 在三个 measure 条目上各加一行（其余字段沿用 Task 2 的迁移结果）：
#   sale_amount@order    →  domain: sale_finished
#   return_amount@line   →  domain: return_finished
#   line_amount@line     →  domain: finished

# 两条指标的 detail 删掉 filter:
    detail:
      relation: vw_lemeng_retail_order_line
```

> `order_line` 的 compose 只有 `line_amount@line`（domain `finished`）；
> `net_sales` 两组件 LUB = `finished`。两者的 `detail.filter` 派生后都是 `state = 'FINISHED'`，
> 与今日物化值逐字一致——这是本任务的硬判据。

- [ ] **Step 5: 迁移测试夹具**

`drillCompliant()` 的 measures 改对象形态并补 `domain`/`additivity`；所有断言「字符串形态合法」的用例改为断言「字符串形态红」；新增 `domains:` 到夹具。

- [ ] **Step 6: 跑测试与门禁**

Run: `pnpm exec tsx scripts/check-data-models.mjs && pnpm run test:guard`
Expected: 全绿；真事实源用例断言 `detail.filter === "state = 'FINISHED'"`（派生结果与今日物化值逐字一致）。

- [ ] **Step 7: 提交**

```bash
git add dbt/semantics/l1_metrics.yml scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts scripts/check-data-models.test.ts
git commit -m "feat(data): 具名行域 + detail.filter 由组件域 LUB 派生（#1012）"
```

---

### Task 4: 两阶段编译纯函数

**Files:**
- Create: `scripts/lib/measure-compile.mjs`
- Test: `scripts/lib/measure-compile.test.ts`

**Interfaces:**
- Produces:
  - `compilePerGroup({ measure, keys, baseAlias }) => string` —— `<expr>` 在 `keys` 分组上的 per-group 表达式（用于 CTE）
  - `compileAggregate({ measure, column, valueExpr }) => string` —— 指标粒度的聚合（`sum(<value>)::numeric(20,2)`）

- [ ] **Step 1: 写失败测试**

```ts
it('两阶段：per-order 表达式先逐单求值、再按指标粒度求和（不是先和后除）', () => {
  const m = measureOf({ expr: 'sum(a) + max(b)', grain: ['order'], additivity: 'flow' })
  const cte = compilePerGroup({ measure: m, keys: ['system_book', 'bizday', 'branch_num', 'order_no'], baseAlias: 'base' })
  expect(cte).toContain('group by system_book, bizday, branch_num, order_no')
  expect(cte).toContain('as measure_value')
  const agg = compileAggregate({ measure: m, column: 'sale_amount__gen', valueExpr: 'measure_value' })
  expect(agg).toBe('sum(measure_value)::numeric(20,2) as sale_amount__gen')
})

it('grain 缺失时拒绝编译两阶段（缺省不许猜）', () => {
  const m = measureOf({ expr: 'sum(a)', additivity: 'flow' })
  expect(() => compilePerGroup({ measure: m, keys: ['order_no'], baseAlias: 'base' })).toThrow(/grain/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd scripts && pnpm exec vitest run lib/measure-compile`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```js
// scripts/lib/measure-compile.mjs
/** @typedef {import('../sync-data-semantics.mjs').Measure} Measure */

/** @param {{ measure: Measure, keys: string[], baseAlias: string }} a */
export function compilePerGroup({ measure, keys, baseAlias }) {
  if (!measure.grain) throw new Error('measure 缺 grain —— 两阶段编译必须知道逐组求值的键')
  if (keys.length === 0) throw new Error('两阶段编译的 keys 不能为空')
  return `select ${keys.join(', ')}, (${measure.expr}) as measure_value from ${baseAlias} group by ${keys.join(', ')}`
}

/** @param {{ measure: Measure, column: string, valueExpr: string }} a */
export function compileAggregate({ measure, column, valueExpr }) {
  if (measure.additivity === 'non_additive') throw new Error(`non_additive measure 不能直接求和（column=${column}）`)
  return `sum(${valueExpr})::numeric(20,2) as ${column}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd scripts && pnpm exec vitest run lib/measure-compile`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/measure-compile.mjs scripts/lib/measure-compile.test.ts
git commit -m "feat(data): measure 两阶段编译纯函数（#1012）"
```

---

### Task 5: 影子列生成器（fct_retail_sale）

**Files:**
- Create: `scripts/gen-fct-measures.mjs`
- Modify: `dbt/models/lemeng/marts/fct_retail_sale.sql`（加标记区 + 手写 `base` CTE）
- Modify: `scripts/check-data-models.mjs` 或 CI（`.github/workflows/ci.yml`）挂 `--check`
- Modify: `deploy/data-plane.lock`（跑 lock 脚本）
- Test: `scripts/gen-fct-measures.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `compilePerGroup` / `compileAggregate`
- Produces: `renderFctMeasures(measures, columns) => { ctes, cols }` —— `columns` 是**该 fct 物化的 measure 键列表**（本批 `['sale_amount@order','return_amount@line']`；`line_amount@line` 属 order_line 的视图，不在这里物化）；CLI `--check`

- [ ] **Step 1: 写失败测试**

```ts
it('生成物幂等：跑两次结果一致；手改标记区 ⇒ --check 红', () => {
  const once = renderFctMeasures(FIXTURE_MEASURES)
  expect(JSON.stringify(renderFctMeasures(FIXTURE_MEASURES))).toBe(JSON.stringify(once))
  const tampered = { ...once, cols: once.cols.replace('sum(measure_value)', 'sum(measure_value) + 1') }
  expect(checkRendered(tampered, FIXTURE_MEASURES)).toMatch(/漂移|不一致/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd scripts && pnpm exec vitest run gen-fct-measures`
Expected: FAIL。

- [ ] **Step 3: 实现生成器**

```js
// scripts/gen-fct-measures.mjs
// 只写标记区：-- BEGIN/END GENERATED MEASURES。区外逐字节不动。
const BEGIN = '-- BEGIN GENERATED MEASURES'
const END = '-- END GENERATED MEASURES'

export const GRAIN_KEYS = {
  order: ['system_book', 'bizday', 'branch_num', 'order_no'],
  line:  ['system_book', 'bizday', 'branch_num', 'order_no', 'order_detail_num'],
}

/** @param {Map<string, import('./sync-data-semantics.mjs').Measure>} measures @param {string[]} columns 该 fct 物化的组件键 */
export function renderFctMeasures(measures, columns) {
  const ctes = []
  const cols = []
  for (const key of columns) {
    const m = measures.get(key)
    if (!m) throw new Error(`fct 引用了未声明的组件 ${key}`)
    const [name, grain] = key.split('@')
    const keys = GRAIN_KEYS[grain]
    if (!keys) throw new Error(`未知 grain \`${grain}\`（只认 ${Object.keys(GRAIN_KEYS).join(' / ')}）`)
    // 声明自洽：measure.grain 必须与键名后缀一致（`line_amount@line` 却声明 grain:[order] = 声明面自相矛盾）
    if (m.grain && m.grain[0] !== grain) throw new Error(`组件 ${key} 的 grain ${JSON.stringify(m.grain)} 与键名后缀 @${grain} 不一致`)
    ctes.push(`${name}__gen as (\n    ${compilePerGroup({ measure: m, keys, baseAlias: 'base' })}\n)`)
    cols.push(compileAggregate({ measure: m, column: `${name}__gen`, valueExpr: `${name}__gen.measure_value` }))
  }
  return { ctes: ctes.join(',\n'), cols: cols.join(',\n    ') }
}
```

> `GRAIN_KEYS` 是 grain 名 → 分组键的唯一映射（`order` / `line`），测试必须覆盖两个键与未知键抛错。

- [ ] **Step 4: 改 fct 模型**

`fct_retail_sale.sql` 保留手写 `base` CTE（含 `is_gift` 判别式与 `where <domain>`），其后插入标记区：

- 生成的 CTE：`sale_amount__gen`（keys = order 键）、`return_amount__gen`（keys = line 键）；
- 生成的聚合列：`sale_amount__gen` / `return_amount__gen`；
- **手写**派生列（不属任何单一 measure）：`(coalesce(sale_amount__gen,0) - coalesce(return_amount__gen,0))::numeric(20,2) as net_amount__gen`；
- 最终 SELECT 同时输出旧列与三个 `*__gen` 列（**本任务不改旧列**）。

`line_amount@line` **不物化进本 fct**（它属 `vw_lemeng_retail_order_line` 的聚合面）。

- [ ] **Step 5: 跑生成与测试**

Run: `pnpm exec tsx scripts/gen-fct-measures.mjs && pnpm exec tsx scripts/gen-fct-measures.mjs --check && cd scripts && pnpm exec vitest run gen-fct-measures`
Expected: 生成物写入、`--check` OK、测试绿。

- [ ] **Step 6: 重新生成 lock 并提交**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
git add scripts/gen-fct-measures.mjs scripts/gen-fct-measures.test.ts scripts/lib/measure-compile.mjs dbt/models/lemeng/marts/fct_retail_sale.sql deploy/data-plane.lock
git commit -m "feat(data): fct 度量列影子生成器（#1012）"
```

---

### Task 6: 影子对账 singular test

**Files:**
- Create: `dbt/tests/lemeng/assert_fct_retail_sale_measure_shadow_parity.sql`
- Modify: `.github/workflows/ci.yml`（无需；dbt test 随 materialize 跑）

**Interfaces:**
- Consumes: Task 5 的 `*__gen` 列
- Produces: 对账结论（返回任何行 = 失败）

- [ ] **Step 1: 写测试 SQL**

```sql
-- 影子对账：生成列 vs 现有列，按 (账套 × 业务日 × 门店) 逐分比。
-- 窗口：默认 7 天；net_sales 为 certified ⇒ 14 天（下界写死为 14）。
with cmp as (
    select system_book, bizday, branch_num,
           sale_amount, sale_amount__gen,
           return_amount, return_amount__gen,
           net_amount, net_amount__gen
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE) - 14
)
select *, '影子列与现有列不一致（sale/return/net，1 分容差）' as note
from cmp
where abs(coalesce(sale_amount,0)   - coalesce(sale_amount__gen,0))   > 0.01
   or abs(coalesce(return_amount,0) - coalesce(return_amount__gen,0)) > 0.01
   or abs(coalesce(net_amount,0)    - coalesce(net_amount__gen,0))    > 0.01

union all

select null, null, null, null, null, null, null, null, null,
       '空转绿：窗口内一行都没有' as note
where (select count(*) from cmp) = 0
```

- [ ] **Step 2: 本地跑 dbt（无库则记录未验）**

Run: `sh scripts/lemeng/materialize.test.sh` 或真机 materialize job
Expected: 新测试 PASS（无法本地跑时在任务报告写明「留真机」）。

- [ ] **Step 3: 提交**

```bash
git add dbt/tests/lemeng/assert_fct_retail_sale_measure_shadow_parity.sql deploy/data-plane.lock
git commit -m "test(data): fct 度量列影子对账（#1012）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 声明模型 → Task 1/2；§3.2 派生 filter → Task 3；§4.2 编译 → Task 4/5；§5 P3.0/P3.1 → Task 1–6；§6.2 守恒校验与 §5 P3.2 切换 → **下一份计划**（本计划明确不切）。
- **占位符**：所有任务含可执行代码/命令；生成器映射表以常量形式给出并要求测试覆盖。
- **类型一致性**：`Measure` 在 Task 1 定义，Task 2/3/4/5 消费同一导出；`compilePerGroup`/`compileAggregate` 名称前后一致。
- **已知风险**：两阶段编译的 `keys` 映射若与 fct 现有 CTE 不一致 ⇒ 影子对账会红（这正是 Task 6 的作用，**不许**为了让测试绿而调容差）。
