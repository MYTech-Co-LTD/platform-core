# 聚合面组件化 P3.3——4 族影子波实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 4 个 fct 族（branch_expense / client_expense / transfer_line_quality / retail_quantity）的度量列迁到生成器（`__gen` 影子列 + 逐族对账测试），运行时零变化；certified 窗口（14 天）与 experimental 窗口（7 天）到期后分批签核切换（Wave 2，另立 plan）。

**Architecture:** 生成器从「钉死 fct_retail_sale 的常量」扩展为 **per-model 注册表**；新增 `flat` 粒度（单层直聚，无预分组）与可选 `precision`。四个族的声明（domains + measures）进 `l1_metrics.yml`，每个 fct 生成 `__gen` 影子列与现有手写列并存，逐族影子对账测试钉逐分一致。

**Tech Stack:** dbt (pg_duckdb) + `scripts/gen-fct-measures.mjs`（tsx + vitest）+ `dbt/semantics/l1_metrics.yml`。

**Spec:** `docs/superpowers/specs/2026-10-23-aggregate-face-componentization-design.md`（§5 P3.3 行 + §8 例外登记，2026-10-24 修订）；issue #1031。

## Global Constraints

- **运行时零变化（影子波铁律）**：4 个 fct 现有列的**取值与列名逐字不变**；只**新增** `<col>__gen` 影子列。消费方（指标 `expression`）一律不动。
- **影子对账判据**：数值列 `abs(旧列 - coalesce(__gen列,0)) <= 0.01`（逐行）；计数列逐行相等。零差异行数 = 全窗口行数。
- **生成区只进标记区**：`-- BEGIN/END GENERATED MEASURES` 内由生成器独占，逗号只能落区外单独一行；`pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对（CI gates）。
- **retail_sale 输出逐字节不变**：注册表化后 `fct_retail_sale` 标记区必须与现在逐字节一致（现有单测 + `--check` 双保险）。
- **计数列保持手写**（不属任何 measure）：`bill_count`（两费用族）、`negative_order_count` 及其余非指标消费列（transfer_line_quality）、派生列 `e_net` / `net_quantity` 在 final SELECT 相减。
- **声明自洽 fail-loud**：`additivity ∈ flow|stock|non_additive` 必填；`grain` 必须与组件键后缀一致；缺 domain 报错不许默认全表。
- **声明形态照抄邻近先例**：`l1_metrics.yml` 里新组件的 YAML 形态（缩进/字段名）逐字照抄 `lemeng:retail:net_sales` 的 `measure:` 块；本计划只给出**字段值**。
- **词表不变判据**：本波只加 `measures`/`domains`，不动 `expression`/`definition`/`detail.filter` ⇒ 词表 job 判据 = **未变 43**。
- 每个任务结束跑该任务验收命令并提交；提交格式 `type(scope): subject`（Conventional Commits）。

---

### Task 1: 生成器 per-model 注册表 + `flat` 粒度 + 可选 precision

**Files:**
- Modify: `scripts/gen-fct-measures.mjs`
- Modify: `scripts/lib/measure-compile.mjs:34-40`（`compileAggregate`）
- Test: `scripts/gen-fct-measures.test.ts`

**Interfaces:**
- Produces: `MODELS: ModelSpec[]`（导出），`renderFctMeasures(measures, spec, domains)`（第二参从 `string[]` 改为 ModelSpec）；`ModelSpec = { rel, stagingRef, grainKeys, fctGrain, columns, baseAliases }`。
- Produces: `compileAggregate` 读 `measure.precision`（可选 `"20,3"` 形态字符串；缺省 `"20,2"`）。
- 声明侧新增：`measure.grain: [flat]` 合法（仅当表达式是单层可结合聚合时）。

- [ ] **Step 1: 写失败测试**（追加进 `scripts/gen-fct-measures.test.ts`）

```ts
// ① flat 粒度：单层直聚，无预分组 CTE
test('flat measure compiles to single-stage sum at fct grain', () => {
  const spec = { rel: 'x.sql', stagingRef: "{{ ref('stg_x') }}",
    grainKeys: {}, fctGrain: ['system_book', 'bizday'],
    columns: ['ep_payable@flat'], baseAliases: { 'ep_payable@flat': 'base_payable' } }
  const measures = new Map([['ep_payable@flat', { expr: 'sum(coalesce(amount, 0))',
    domain: 'be.payable', grain: ['flat'], additivity: 'flow' }]])
  const r = renderFctMeasures(measures, spec, { 'be.payable': { predicate: "direction = '应付'" } })
  // 阶段 1 直接在 fct 粒度求和（无 group by order 键的中间层）
  expect(r.ctes).toContain('select system_book, bizday, sum(coalesce(amount, 0))::numeric(20,2) as ep_payable__gen')
  expect(r.names).toEqual(['ep_payable__gen'])
})
// ② precision 覆盖：声明 "20,3" ⇒ cast 逐字变
test('measure precision overrides default cast', () => {
  /* 同上构造，measure 加 precision: '20,3'，断言输出含 '::numeric(20,3)' */
})
// ③ retail_sale 回归：MODELS[0] 渲染结果与现有标记区逐字节一致
test('retail_sale region stays byte-identical after registry refactor', () => {
  const { measures, domains } = readSemantics(rootFixture)
  const expected = renderRegion(renderFctMeasures(measures, MODELS[0], domains))
  expect(expected).toBe(readFileSync(join(rootFixture, MODELS[0].rel), 'utf8').match(/-- BEGIN GENERATED MEASURES[\s\S]*-- END GENERATED MEASURES/)![0])
})
// ④ flat + 多组件 gen_agg：flat 组件不产 rollup，gen_agg 直接引阶段 1
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run scripts/gen-fct-measures.test.ts` → 新用例红。
- [ ] **Step 3: 实现**：

```js
// gen-fct-measures.mjs —— 常量改注册表（retail_sale 块的值 = 现有常量逐字搬运）
/**
 * @typedef {object} ModelSpec
 * @property {string} rel 仓内相对路径
 * @property {string} stagingRef 基面输入关系
 * @property {Record<string, string[]>} grainKeys grain 名 → 分组键；`flat` 不在此（单层直聚）
 * @property {string[]} fctGrain 该 fct 的粒度键
 * @property {string[]} columns 物化的组件键（顺序即生成顺序）
 * @property {Record<string, string>} baseAliases 组件键 → 基面 CTE 名
 * @type {ModelSpec[]}
 */
export const MODELS = [
  { rel: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
    stagingRef: "{{ ref('stg_lemeng_retail_order_line') }}",
    grainKeys: { order: ['system_book', 'bizday', 'branch_num', 'order_no'],
                 line: ['system_book', 'bizday', 'branch_num', 'order_no', 'order_detail_num'] },
    fctGrain: ['system_book', 'bizday', 'branch_num'],
    columns: ['sale_amount@order', 'return_amount@line'],
    baseAliases: { 'sale_amount@order': 'base_sale', 'return_amount@line': 'base_return' } },
  // Task 2-5 逐族追加四个块（见各任务 Interfaces）
]
```

- `renderFctMeasures(measures, spec, domains)`：`columns`/`GRAIN_KEYS`/`FCT_GRAIN`/`STAGING_REF`/`BASE_ALIASES` 全部改读 `spec`。`grain === 'flat'` 时：跳过「grain 键集查找」与「fctGrain ⊆ keys 校验」（无 keys 可校验），阶段 1 直接 `select ${spec.fctGrain}, ${compileAggregate(...)} from ${base} group by ${spec.fctGrain.map((_, i) => i + 1)}`，CTE 名仍是 `<name>__gen`；该组件**不产 rollup**（阶段 1 已在 fct 粒度），`renderGenAgg` 的 rollups 列表里 flat 组件直接用其阶段 1 CTE 名。
- `measure-compile.mjs:40`：`` `sum(${valueExpr})::numeric(${measure.precision ?? '20,2'}) as ${column}` ``。
- `run(rootDir)`：`for (const spec of MODELS) { … }`，逐模型走现流程；OK 行逐模型打印。
- **Step 4: 全测试绿 + retail_sale 逐字节回归绿**：`pnpm vitest run scripts/gen-fct-measures.test.ts && pnpm exec tsx scripts/gen-fct-measures.mjs --check`（后者此刻仍只注册 retail_sale ⇒ 必须 OK）。
- [ ] **Step 5: Commit** `feat(data): gen-fct-measures 多模型注册表 + flat 粒度 + precision（#1031）`

### Task 2: fct_branch_expense 声明 + 影子列 + 对账测试

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（domains + 组件 measure 化）
- Modify: `dbt/models/lemeng/marts/fct_branch_expense.sql`
- Create: `dbt/tests/lemeng/assert_fct_branch_expense_measure_shadow_parity.sql`

**Interfaces:**
- Consumes: Task 1 的 `MODELS` 追加块：`{ rel: 'dbt/models/lemeng/marts/fct_branch_expense.sql', stagingRef: "{{ ref('stg_lemeng_branch_expense') }}", grainKeys: {}, fctGrain: ['system_book', 'bizday', 'branch_num', 'expense_type'], columns: ['ep_payable@flat', 'er_receivable@flat'], baseAliases: { 'ep_payable@flat': 'base_payable', 'er_receivable@flat': 'base_receivable' } }`
- 声明字段值（形态照抄 `lemeng:retail:net_sales` 的 measure 块）：
  - `domains:` 新增 `branch_expense.payable`（谓词 `direction = '应付'`）、`branch_expense.receivable`（谓词 `direction = '应收'`）——**谓词以现 fct SQL 的 case-when 条件逐字核对**；
  - 组件 `ep_payable@flat`：expr=现文件 `ep_payable` 聚合内层逐字（`sum(coalesce(amount, 0))` 形态，**不带** case-when——方向过滤上移到 domain），`grain: [flat]`、`additivity: flow`；`er_receivable@flat` 同构。
- `bill_count` **保持手写**：独立 CTE 直读 staging（不过生成区基面），现谓词逐字。

- [ ] **Step 1: 声明先行**——`l1_metrics.yml` 加 domains + 两个组件 measure 化（`expression` 保留不动）。
- [ ] **Step 2: MODELS 注册**——追加 Task 1 Interfaces 里的块。
- [ ] **Step 3: 跑生成器写标记区**：`pnpm exec tsx scripts/gen-fct-measures.mjs`；手工重排 `fct_branch_expense.sql`：标记区 + 区外逗号行 + `bill_count` 手写 CTE + final SELECT（现有 3 列逐字保留 + 新增 `coalesce(gen_agg.ep_payable__gen, 0)::numeric(20,2) as ep_payable__gen`、`er_receivable__gen` 同构 + `e_net` **不改**（仍由现有两列相减））。
- [ ] **Step 4: 影子对账测试**——模板：`git show 4c0cf89a:dbt/tests/lemeng/assert_fct_retail_sale_measure_shadow_parity.sql`，替换：表=`fct_branch_expense`、粒度键=4 键、对账列=`ep_payable`/`er_receivable`（数值 ≤0.01）、窗口=近 14 天。
- [ ] **Step 5: 验证**：`pnpm exec tsx scripts/gen-fct-measures.mjs --check` 绿；本地 dev-stack 跑 `dbt build -s fct_branch_expense+`（DATABASE_URL 指本地 compose pg）对账测试绿、旧列值不变。
- [ ] **Step 6: Commit** `feat(data): fct_branch_expense 度量组件化影子列（#1031）`

### Task 3: fct_client_expense（与 Task 2 同构）

**Files:** 同 Task 2 模式（`fct_client_expense.sql`、`assert_fct_client_expense_measure_shadow_parity.sql`）。

**Interfaces:** MODELS 块：stagingRef=`{{ ref('stg_lemeng_client_expense') }}`，fctGrain=`['system_book','bizday','branch_num','expense_type']`，columns=`['ep_payable@flat','er_receivable@flat']`，baseAliases 同构；domains `client_expense.payable`（`other_inout_flag = false`）/ `client_expense.receivable`（`other_inout_flag = true`）——**谓词与现 SQL 的 case-when 条件逐字核对后落声明**。

- [ ] 步骤同 Task 2（声明 → 注册 → 生成 → 重排 → 对账测试（14 天窗）→ 验证 → Commit `feat(data): fct_client_expense 度量组件化影子列（#1031）`）。

### Task 4: fct_transfer_line_quality（唯一两阶段族：order 粒度 measure）

**Files:** `fct_transfer_line_quality.sql`、`l1_metrics.yml`、`assert_fct_transfer_line_quality_measure_shadow_parity.sql`。

**Interfaces:**
- MODELS 块：stagingRef=现 base 的 ref（打开现文件取逐字）；`grainKeys: { order: ['system_book','bizday','branch_num','order_no'] }`；`fctGrain: ['system_book','bizday','branch_num']`；columns=`['zero_cost_amount@order']`；baseAliases=`{ 'zero_cost_amount@order': 'base_transfer_quality' }`。
- 声明：domain `transfer_line.quality_base`（谓词 = 现 base 的 where 逐字：`state_code = 3 and out_branch_num = 99 and branch_num <> out_branch_num`）；组件 `zero_cost_amount@order`：**expr = 现 fct 里 zero_cost_amount 的完整 case-when 聚合逐字照抄**（含 `coalesce(out_money, 0)` 守卫与 `subtotal = 0` 的 null 排除语义——`b.` 前缀随基面别名消失）、`grain: [order]`、`additivity: flow`。
- **其余列全部保持手写**（`negative_order_count` 的 per_order CTE、`missing_cost_amount`、`lot_filled_lines`、`line_count` 等——不属本波组件化对象，原样在标记区外）。

- [ ] **Step 1-2**: 声明 + 注册（同前）。
- [ ] **Step 3: 生成 + 重排**——布局：手写 base/per_order CTE 在标记区外**自带**（手写部分不依赖生成区基面，避免生成器改动扩散）；标记区内生成 base + `zero_cost_amount__gen`；final SELECT 现列逐字 + `coalesce(gen_agg.zero_cost_amount__gen, 0)::numeric(20,2) as zero_cost_amount__gen`。**staging 因此扫两次**（手写一次 + 生成一次）——影子期可接受，切换批消除。
- [ ] **Step 4: 对账测试**——模板同 Task 2，列=`zero_cost_amount`，14 天窗。
- [ ] **Step 5-6**: 验证同前；Commit `feat(data): fct_transfer_line_quality 度量组件化影子列（#1031）`

### Task 5: fct_retail_quantity（experimental + numeric(20,3)）

**Files:** `fct_retail_quantity.sql`、`l1_metrics.yml`、`assert_fct_retail_quantity_measure_shadow_parity.sql`。

**Interfaces:**
- MODELS 块：stagingRef=`{{ ref('stg_lemeng_retail_order_line') }}`；`grainKeys: {}`；`fctGrain: ['system_book','bizday','branch_num','item_num']`；columns=`['sale_quantity@flat','return_quantity@flat']`；baseAliases 同构（`base_rq_sale` / `base_rq_return`）。
- 声明：domains `retail_quantity.sale`（`order_transaction_type = 'SALE_ORDER' and state = 'FINISHED'`）/ `retail_quantity.return`（`order_transaction_type like '%RETURN%' and state in ('FINISHED', 'REPAID')`）——**与现 SQL 的 case 列条件逐字核对**；组件 `sale_quantity@flat` / `return_quantity@flat`：expr=现 case 列的求和内层逐字、`grain: [flat]`、`additivity: flow`、**`precision: '20,3'`**（现表精度，Global Constraints 的缺省 20,2 不适用）。
- `net_quantity` **不改**（仍由现有两列相减）。

- [ ] 步骤同 Task 2；对账测试窗口 = **7 天**（experimental，spec §9.1）。Commit `feat(data): fct_retail_quantity 度量组件化影子列（#1031）`

### Task 6: 全量验证 + spec §5 落地记录

- [ ] **Step 1**: `pnpm exec tsx scripts/gen-fct-measures.mjs --check`（5 个模型全 OK）；`pnpm vitest run` 全绿；门禁脚本（`check-data-models` / sync 相关）全绿。
- [ ] **Step 2**: 本地 dev-stack 全量 `dbt build` 相关域绿（4 张 fct + 4 个对账测试 + 既有审计）；确认旧列值不变（对账测试零差异行数=全行）。
- [ ] **Step 3**: spec §5 追加 P3.3 Wave 1 实施记录（合并 SHA、窗口到期日：certified ≈ 合并日+14、experimental ≈ 合并日+7）。
- [ ] **Step 4**: Commit `docs(data): P3.3 影子波落地记录（#1031）`

---

## Wave 2（切换，不在本计划）

窗口到期后各批小 plan 循 P3.2 先例： certified 批（3 族）~11-07、experimental 批 ~10-31；切换 = final SELECT 改取 `gen_agg` 列 + 删影子列与对账测试 + 零差异指纹验收 + 数据面四步链（sync 注意 EXTRA 残留手工 rm）。

## 词表与部署判据（合并后）

数据面链：`lemeng-sync.sh`（只增改不删）→ 山海 manual deploy → 词表 job **未变 43** → materialize `MATERIALIZE_OK`；采集窗口并发写湖的审计瞬时红重跑即绿，不算回归。
