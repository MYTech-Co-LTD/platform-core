# 乐檬指标 W0 语义基建 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec《2026-10-12-lemeng-metrics-sources-semantics-design.md》的 W0：① 零售净额口径按 #430 定案公式实现（声明先行）；② L1 支持 ratio（率类）声明（sync 脚本 + 门禁同步）；③ 口径构件列约定与率类 L1/L2 边界写入 dbt/README。

**Architecture:** 口径唯一事实源 = `dbt/semantics/l1_metrics.yml`（定义先行，实现不得倒逼定义）；口径只在 marts（`fct_retail_sale`）定义一次；对账走「独立复算」singular test（直接打 parquet，不 ref staging）；词表物化走 `scripts/sync-data-semantics.mjs`（写侧唯一），门禁 `scripts/check-data-models.mjs` 规则 ⑤⑥⑦ 同步扩。

**Tech Stack:** dbt 1.9（模型在数据面真机跑，本机无 dbt/pg_duckdb）+ pg_duckdb + vitest（scripts/ checkJs）+ openship MCP（真机操作唯一通道）。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-10-12-lemeng-metrics-sources-semantics-design.md`（§5 语义设计 / §6 裁1/裁7 / §0 D5）。W1–W4 **不在本计划内**。
- 赠品判别式与换货半边公式**逐字照抄正典勿改**：正典 = `docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md` §0；公式 = `net(店,日) = Σ_订单[(Σ非赠品行额 + order_total_money)/2] − Σ分摊折扣`，基面 `state='FINISHED' AND order_transaction_type='SALE_ORDER'`（issue #430，2026-10-05 真机逐分归零）。
- audit 形态四铁律（照抄同族文件）：复算侧**直接打 parquet**（不 ref staging/marts）；只比**已闭窗营业日**（`bizday < 上海今天`，两侧都滤）；聚合值显式 `::numeric(20,2)`；**空转自检**必带。read_parquet 只认位置参数、取列用 `from read_parquet(…) r` + `r['列']`、`r['列']` 算术先 `::numeric`、FULL JOIN 键逐个 cast。
- `fct_retail_sale` 现头注的「明确不过滤 state」块是**被本计划取代的旧口径**（spec §0-D5 + 裁1 走了声明变更）；本计划落地后该块改写为新口径注记，其余历史注记（换源、numeric 精度）保留。
- `{{ subject_org() }}` 只在 fct 最终 select 注入为 `as org`（规则 ⑩ 单一形状），不透传、不进 CTE、不进 GROUP BY。
- scripts/ 是 checkJs：单形状、字段恒在，不写可辨识联合；`$VAR` 紧邻中文一律 `${VAR}`。
- tier 保持 `experimental`（裁1 客户回签前不转 certified）。
- 提交纪律：一个 issue（执行前建）+ 一个 PR（`Closes #N`）；commit 用 `type(scope): subject`；CHANGELOG 不手写。
- 真机操作（部署/触发 job/查日志）一律走 **openship MCP**，不裸 SSH。
- 本机验证面 = `pnpm typecheck:scripts` + `pnpm test:guard` + `pnpm exec tsx scripts/check-data-models.mjs`；dbt 模型正确性在**数据面真机**验收（Task 6），本机绿 ≠ 真机绿。

---

### Task 1: sync 脚本支持 ratio 声明（TDD）

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（`declarationsFromYaml` 内）
- Test: `scripts/sync-data-semantics.test.ts`

**Interfaces:**
- Consumes: 现有 `deriveRelation(expression, metricName)`（单一关系判定，复用在合并表达式上）、`buildSelectSql(expression, grain, relation)`。
- Produces: 声明侧新可选字段 `ratio: { numerator: string, denominator: string }`——与 `expression` **互斥**；物化的 expression = `` `${numerator} / nullif(${denominator}, 0)` ``（零分母 → 不适用，spec §5.4）。后续波次的率类指标声明（W1 起）都走这条通道。

- [ ] **Step 1: 写失败测试**

在 `scripts/sync-data-semantics.test.ts` 追加一组用例（文件已是 vitest `describe/it/expect` 风格，照抄）：

```ts
describe('ratio 声明（与 expression 互斥）', () => {
  const base = {
    name: 'lemeng:retail:test_rate',
    label: '率夹具',
    definition: '测试夹具：不可加，上滚=重算。',
    grain: ['system_book', 'bizday'],
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
  }

  it('ratio 只给分子分母时，物化出 nullif 除法表达式', () => {
    const rows = declarationsFromYaml({
      metrics: [{ ...base, ratio: {
        numerator: 'sum(fct_retail_sale.net_amount)',
        denominator: 'sum(fct_retail_sale.order_count)',
      } }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].selectSql).toBe(
      'select sum(fct_retail_sale.net_amount) / nullif(sum(fct_retail_sale.order_count), 0) as value, system_book, bizday from fct_retail_sale',
    )
  })

  it('ratio 与 expression 同时给 → 响亮拒绝', () => {
    expect(() =>
      declarationsFromYaml({
        metrics: [{ ...base, expression: 'sum(fct_retail_sale.net_amount)', ratio: {
          numerator: 'sum(fct_retail_sale.net_amount)', denominator: 'sum(fct_retail_sale.order_count)',
        } }],
      }),
    ).toThrow(/互斥/)
  })

  it('ratio 缺分子或缺分母 → 响亮拒绝', () => {
    expect(() =>
      declarationsFromYaml({ metrics: [{ ...base, ratio: { numerator: 'sum(fct_retail_sale.net_amount)' } }] }),
    ).toThrow(/denominator|分母/)
    expect(() =>
      declarationsFromYaml({ metrics: [{ ...base, ratio: { denominator: 'sum(fct_retail_sale.order_count)' } }] }),
    ).toThrow(/numerator|分子/)
  })

  it('ratio 分子分母引用不同关系 → 响亮拒绝（复用 deriveRelation 的单一关系约束）', () => {
    expect(() =>
      declarationsFromYaml({ metrics: [{ ...base, ratio: {
        numerator: 'sum(fct_retail_sale.net_amount)', denominator: 'sum(fct_wholesale_out.r_net)',
      } }] }),
    ).toThrow(/多个关系/)
  })

  it('ratio 里带分号 → 响亮拒绝（写侧先拦，不等读侧 parseL1Select）', () => {
    expect(() =>
      declarationsFromYaml({ metrics: [{ ...base, ratio: {
        numerator: 'sum(fct_retail_sale.net_amount); drop table x',
        denominator: 'sum(fct_retail_sale.order_count)',
      } }] }),
    ).toThrow(/分号/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/sync-data-semantics.test.ts`
Expected: 新增用例 FAIL（ratio 分支不存在，第一例 selectSql 断言失败），存量用例全 PASS。

- [ ] **Step 3: 实现 ratio 分支**

在 `declarationsFromYaml` 的 `metrics.map((raw) => {…})` 内，**替换**现有的两行——`const expression = String(m.expression ?? '')` 与其后的 `if (expression === '') throw …`——为下面的块（保持既有注释密度与错误文案风格；其后 `deriveRelation(expression, name)` 及 `buildSelectSql(...)` 调用不动）：

```js
    const expressionField = String(m.expression ?? '')
    const hasRatio = m.ratio !== undefined && m.ratio !== null
    if (hasRatio && expressionField !== '') {
      throw new Error(`指标 \`${name}\` 的 ratio 与 expression 互斥：率类声明用 ratio（分母自动包 nullif），可加指标用 expression，不许两处各写一份`)
    }
    let expression = expressionField
    if (hasRatio) {
      const r = /** @type {Record<string, unknown>} */ (m.ratio)
      const numerator = String(r.numerator ?? '')
      const denominator = String(r.denominator ?? '')
      if (numerator === '') throw new Error(`指标 \`${name}\` 的 ratio 缺 numerator（分子）`)
      if (denominator === '') throw new Error(`指标 \`${name}\` 的 ratio 缺 denominator（分母）`)
      // 写侧先拦注入；读侧 parseL1Select 的形状契约仍在（两层防线，职责见文件头注）
      if (numerator.includes(';') || denominator.includes(';')) {
        throw new Error(`指标 \`${name}\` 的 ratio 含分号：声明里只写聚合表达式，不许拼语句`)
      }
      // 零分母 → 不适用（spec §5.4）：分母统一包 nullif，「口径只定义一次」由声明侧保证
      expression = `${numerator} / nullif(${denominator}, 0)`
    }
    if (expression === '') throw new Error(`指标 \`${name}\` 缺 expression（或给 ratio）`)
```

其后 `deriveRelation(expression, name)` 及 `buildSelectSql(...)` 调用**不动**（合并后的表达式仍满足「单一关系.列」约束——ratio 两侧必须同关系，Task 2 门禁再钉一层形状面）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run scripts/sync-data-semantics.test.ts`
Expected: 全 PASS（含既有形状契约用例 ①②③）。

- [ ] **Step 5: 静态检查 + 提交**

```bash
pnpm typecheck:scripts && pnpm test:guard
git add scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts
git commit -m "feat(data): L1 语义声明支持 ratio（率类）——分母自动包 nullif，与 expression 互斥"
```

---

### Task 2: 门禁规则 ⑤ 扩展 ratio 形状（TDD）

**Files:**
- Modify: `scripts/check-data-models.mjs`（规则 ⑤ 区块，锚点：`REQUIRED_METRIC_FIELDS`（约 L173）与规则 ⑤ 文案（约 L169））
- Create: `scripts/check-data-models.test.ts`

**Interfaces:**
- Consumes: 现有 `maskSqlComments` / `firstMatchLine` / 规则 ⑤ 的声明扫描结构。
- Produces: 导出纯函数 `ratioShapeError(decl)`：入参 `{ name, expression?, ratio? }` 形状，返回 `string | null`（违规文案或 null）。规则 ⑤ 主流程调用它；单测直接 import 它。

- [ ] **Step 1: 读规则 ⑤ 现状**

Run: `grep -n 'REQUIRED_METRIC_FIELDS' scripts/check-data-models.mjs` 并读该函数块（约 30 行）。
记录：expression 必填的判定行、错误文案的拼接风格。

- [ ] **Step 2: 写失败测试**（新文件 `scripts/check-data-models.test.ts`）

```ts
// check-data-models.test.ts — 门禁规则 ⑤ ratio 扩展的纯核单测（对真仓的整仓扫描由 CI gates 跑脚本本身覆盖）。
import { describe, expect, it } from 'vitest'
import { ratioShapeError } from './check-data-models.mjs'

describe('规则 ⑤ ratio 形状', () => {
  const base = { name: 'lemeng:retail:test_rate', definition: 'x', grain: ['a'], owner: 'o', tier: 'experimental', source: 'lemeng' }

  it('ratio 与 expression 互斥', () => {
    expect(ratioShapeError({ ...base, expression: 'sum(f.x)', ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' } }))
      .toMatch(/互斥/)
  })
  it('缺分子或分母 → 报错', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)' } })).toMatch(/numerator|分子/)
    expect(ratioShapeError({ ...base, ratio: { denominator: 'sum(f.y)' } })).toMatch(/denominator|分母/)
  })
  it('分子分母必须各含「关系.列」且同关系', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(x)', denominator: 'sum(f.y)' } })).toMatch(/关系/)
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(a.x)', denominator: 'sum(b.y)' } })).toMatch(/多个关系|同关系/)
  })
  it('含分号 → 报错', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x);', denominator: 'sum(f.y)' } })).toMatch(/分号/)
  })
  it('合法 ratio → null；纯 expression 声明 → null', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' } })).toBeNull()
    expect(ratioShapeError({ ...base, expression: 'sum(f.x)' })).toBeNull()
  })
  it('两者都不给 → 报错（⑤ 的必填缺口，走 ratio 路径后的兜底）', () => {
    expect(ratioShapeError({ ...base })).toMatch(/expression|ratio/)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/check-data-models.test.ts`
Expected: FAIL（`ratioShapeError` 未导出）。

- [ ] **Step 4: 实现并接线**

在 `scripts/check-data-models.mjs` 规则 ⑤ 附近新增（并 `export`）：

```js
/**
 * 规则 ⑤ 的 ratio 形状核（纯函数，供单测与主扫描共用）。
 * 率类声明走 `ratio: { numerator, denominator }`，与 expression 互斥；物化侧
 * （sync-data-semantics.mjs）会把分母包成 nullif —— 这里钉声明侧的形状：
 * 分子分母各含 ≥1 个「关系.列」引用、且必须同一个关系（单 FROM 约束的声明面）。
 */
export function ratioShapeError(decl) {
  const hasRatio = decl.ratio !== undefined && decl.ratio !== null
  const hasExpr = typeof decl.expression === 'string' && decl.expression !== ''
  if (hasRatio && hasExpr) return `指标 \`${decl.name}\` 的 ratio 与 expression 互斥（率类用 ratio，可加指标用 expression）`
  if (!hasRatio && !hasExpr) return `指标 \`${decl.name}\` 缺 expression（率类请改用 ratio: {numerator, denominator}）`
  if (!hasRatio) return null
  const num = String(decl.ratio.numerator ?? '')
  const den = String(decl.ratio.denominator ?? '')
  if (num === '') return `指标 \`${decl.name}\` 的 ratio 缺 numerator（分子）`
  if (den === '') return `指标 \`${decl.name}\` 的 ratio 缺 denominator（分母）`
  if (num.includes(';') || den.includes(';')) return `指标 \`${decl.name}\` 的 ratio 含分号（声明只写聚合表达式）`
  const rel = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*/g
  const numRels = new Set([...num.matchAll(rel)].map((m) => m[1]))
  const denRels = new Set([...den.matchAll(rel)].map((m) => m[1]))
  if (numRels.size === 0 || denRels.size === 0) return `指标 \`${decl.name}\` 的 ratio 分子/分母必须含「关系.列」形态的引用`
  const all = new Set([...numRels, ...denRels])
  if (all.size > 1) return `指标 \`${decl.name}\` 的 ratio 分子分母引用了多个关系（${[...all].join(', ')}）：单条声明只有一个 FROM`
  return null
}
```

规则 ⑤ 主扫描在读完每条声明后调用 `ratioShapeError(decl)`，非 null 即按该文件既有违规上报形态 push（文案前缀与规则 ⑤ 其它违规一致）。

- [ ] **Step 5: 跑测试 + 对真仓跑门禁**

```bash
pnpm exec vitest run scripts/check-data-models.test.ts
pnpm exec tsx scripts/check-data-models.mjs   # 现仓（两条 expression 声明）必须仍全绿
```
Expected: 单测全 PASS；门禁 exit 0。

- [ ] **Step 6: 提交**

```bash
git add scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "feat(data): 门禁规则 ⑤ 支持 ratio 声明形状（互斥/同关系/无分号）"
```

---

### Task 3: l1_metrics.yml 净额/订单数口径更新（**声明先行**）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`
- Modify: `dbt/README.md`（「实证 vs 暂定」表，约 L169）

**Interfaces:**
- Produces: `lemeng:retail:net_sales` / `lemeng:retail:order_count` 的新 definition + `grain: [system_book, bizday, branch_num]`。Task 4 的 fct/audit 与 Task 6 的词表物化都以此为准。

- [ ] **Step 1: 改写两条声明**

`net_sales` 整块替换为（`expression`/`sources`/对账注释段保持原样，只动 definition/grain 与新增的边界说明）：

```yaml
  - name: 'lemeng:retail:net_sales'
    label: 净销售额
    definition: >-
      零售净销售额，平台口径（issue #430 定案，2026-10-05 双账套真机 5 天逐分归零）：
      取 state=FINISHED 且 order_transaction_type=SALE_ORDER 的订单（退货单不进 gross——
      平台 sale_money 不冲退货单），逐订单取「(Σ非赠品行额 + order_total_money) / 2」，
      按门店×日合计后再减 Σ分摊折扣（order_detail_share_discount）；
      赠品行按判别式排除（std_price>0 且 sale_money>0 且 quantity>0 且
      |discount_money − std_price×quantity| ≤ 0.02，容差标定见判别式正典）。
      粒度 = 账套 × 业务日 × 门店。
      ⚠️ tier=experimental：公式已真机验证；等客户回签裁1（换货「送出半边」叠加进净额 L）
      后再转 certified（spec 2026-10-12 §6 裁1）。
    expression: 'sum(fct_retail_sale.net_amount)'
    grain: [system_book, bizday, branch_num]
```

`order_count` 的 definition 替换为：

```yaml
    definition: >-
      有效零售订单数：state=FINISHED 且 order_transaction_type=SALE_ORDER 的去重订单笔数
      （与净销售额同基面，换货单算一单）。粒度 = 账套 × 业务日 × 门店。
      上滚语义：更粗粒度求和 = 各门店日去重笔数之和；跨门店重号会重复计入
      （order_no 的跨门店唯一性未证，见 audit 头注）——这是本口径的已知边界，
      要「全账套唯一订单数」得单独声明新指标，不许改本定义。
    grain: [system_book, bizday, branch_num]
```

- [ ] **Step 2: 同步 dbt/README「实证 vs 暂定」表**

约 L169 行 `| **「有效订单」的判定条件**…` 一行改为：

```markdown
| 「有效订单」的判定条件（退货/赠品/作废剔除） | **已定案（#430）→ 实现随 W0 落地** | 平台口径 = FINISHED+SALE_ORDER 基面 + 换货「送出半边」公式 + 赠品判别式；客户回签裁1 前指标保持 experimental。声明见 `l1_metrics.yml`，实现见 `fct_retail_sale.sql` |
```

- [ ] **Step 3: 门禁自证**

Run: `pnpm exec tsx scripts/check-data-models.mjs && pnpm exec vitest run scripts/sync-data-semantics.test.ts`
Expected: 全绿（grain 三列、definition 更新都在声明契约内）。此刻 fct 还没实现新口径——**声明与实现的窗口期只活在本 PR 内**（同 PR 的 Task 4 关掉它），这是「口径先行」的既定形态（fct 头注原话：不许实现倒逼定义）。

- [ ] **Step 4: 提交**

```bash
git add dbt/semantics/l1_metrics.yml dbt/README.md
git commit -m "feat(data): 零售净销售额/订单数口径定案声明（#430 换货半边公式，粒度扩到门店）"
```

---

### Task 4: fct_retail_sale 实现 #430 公式 + 粒度扩 + 断言/audit 对齐

**Files:**
- Modify: `dbt/models/common/marts/fct_retail_sale.sql`（口径实现 + 头注改写）
- Modify: `dbt/models/common/marts/schema.yml`（fct 列清单加 `branch_num`、grain 描述）
- Modify: `dbt/tests/assert_fct_retail_sale_grain_unique.sql`（三列粒度）
- Modify: `dbt/tests/audit_lemeng__retail__net_sales.sql`（复算对齐新口径）
- Modify: `dbt/tests/audit_lemeng__retail__order_count.sql`（复算对齐粒度）

**Interfaces:**
- Consumes: `stg_lemeng_retail_order_line` 的 25 列投影（state / order_transaction_type / sale_money / order_total_money / order_detail_share_discount / order_detail_std_price / discount_money / quantity）。
- Produces: `fct_retail_sale` 粒度 = `(system_book, bizday, branch_num)`，列 `net_amount ::numeric(20,2)`、`order_count`、`org`。L1 expression（Task 3）与 audit（本任务）都指向它。

- [ ] **Step 0: 对齐 recon-preagg 的公式实现形态（防除法形态漂移）**

Run: `grep -rn 'order_total_money' deploy/duckle/console/pipelines/ scripts/lemeng/ | head`
读 recon-preagg 的公式 SQL（console 管线 code.sql 节点），确认它 `/2` 的**除法与舍入形态**（逐单除还是先和后除、有没有中间 cast）。fct 与 audit 的实现**逐字同型**照抄它——2026-10-05 的「逐分归零」是按那个形态验证的，本任务不许引入第三种除法形态。若发现它就是「逐单 (Σ非赠品+total)/2 再求和」，则下面代码块照用；若不同，以它为准改写两处除法行。

- [ ] **Step 1: 重写 fct_retail_sale.sql**

保留文件既有头注中仍成立的段（物化 gate 2、分层纪律、org 注入两理由、numeric(20,2) 精度段），**替换**「指标口径」与「明确不过滤 state」两段为新口径注记：

```sql
-- 指标口径（逐字，与 l1_metrics.yml 的 definition 同源，2026-10-12 W0 落地，spec §0-D5/裁1）：
--   · 净销售额 = FINISHED+SALE_ORDER 基面上，逐订单「(Σ非赠品行额 + order_total_money)/2」
--     按门店日合计 − Σ分摊折扣；赠品行按判别式排除（正典 2026-09-30-recon-zeroing §0）。
--     退货单不进 gross（平台 sale_money 不冲退货单，issue #430）。
--   · 订单数   = 同基面的 count(distinct order_no)。
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 🔒【口径变更记录】本文件曾按「全部明细行 sum(sale_money)」实现（旧暂定口径）。2026-10-12
--    起按 #430 定案公式实现——那是口径定案的落地，不是漏写 where。旧注记（「不许加 where
--    state=…」）随暂定口径一并退役；再改口径仍必须先改 l1_metrics.yml 的 definition。
--    order_total_money / order_detail_share_discount 为 null 的基面行会被 sum 丢弃（静默）——
--    输入形状守卫在 audit_lemeng__retail__recon_exchange_shape.sql（形状违规它红）。
-- ════════════════════════════════════════════════════════════════════════════════════════
with base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sale_money,
        order_total_money,
        order_detail_share_discount,
        (order_detail_std_price > 0 and sale_money > 0 and quantity > 0
         and abs(discount_money - order_detail_std_price * quantity) <= 0.02) as is_gift
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type = 'SALE_ORDER'
),
per_order as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sum(case when is_gift then 0 else sale_money end) as non_gift_amount,
        max(order_total_money)                            as order_total_money,
        sum(order_detail_share_discount)                  as share_discount
    from base
    group by 1, 2, 3, 4
)
select
    per_order.system_book,
    {{ subject_org() }} as org,
    per_order.bizday,
    per_order.branch_num,
    (sum(per_order.non_gift_amount + per_order.order_total_money) / 2
     - sum(per_order.share_discount))::numeric(20,2) as net_amount,
    count(distinct per_order.order_no)               as order_count
from per_order
group by 1, 3, 4
```

（`/2` 的形态按 Step 0 的对齐结论定；`org` 用宏注入、不在 CTE 透传、不进 GROUP BY——规则 ⑩。）

- [ ] **Step 2: 粒度断言三列化**

`assert_fct_retail_sale_grain_unique.sql` 的 group by/去重键改为 `(system_book, bizday, branch_num)`，头注同步「粒度：账套 × 业务日 × 门店」。

- [ ] **Step 3: 两条 audit 复算对齐**

`audit_lemeng__retail__net_sales.sql` 的 `recheck` CTE 换成与 fct **同型的独立实现**（仍直接打 parquet、不 ref staging）：

```sql
with base as (
    select
        r['system_book']::varchar  as system_book,
        r['bizday']::date          as bizday,
        r['branch_num']::int       as branch_num,
        r['order_no']::varchar     as order_no,
        r['sale_money']::numeric   as sale_money,
        r['order_total_money']::numeric    as total_money,
        r['order_detail_share_discount']::numeric as share_discount,
        (r['order_detail_std_price']::numeric > 0
         and r['sale_money']::numeric > 0
         and r['quantity']::numeric > 0
         and abs(r['discount_money']::numeric - r['order_detail_std_price']::numeric * r['quantity']::numeric) <= 0.02
        ) as is_gift
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_transaction_type'] = 'SALE_ORDER'
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
per_order as (
    select
        system_book, bizday, branch_num, order_no,
        sum(case when is_gift then 0 else sale_money end) as non_gift_amount,
        max(total_money)                                  as order_total_money,
        sum(share_discount)                               as share_discount
    from base
    group by 1, 2, 3, 4
),
recheck as (
    select
        system_book,
        bizday,
        branch_num,
        (sum(non_gift_amount + order_total_money) / 2 - sum(share_discount))::numeric(20,2) as net_sales
    from per_order
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, branch_num, net_amount as net_sales
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.net_sales                            as recheck_value,
    b.net_sales                            as materialized_value,
    '复算与物化结果不一致（净销售额，#430 口径）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.net_sales is distinct from b.net_sales

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
```

（文件头注补一行：口径换 #430 定案 + Step 0 的除法形态结论出处。`order_count` audit 同法：`recheck` 只把末段聚合换成 `count(distinct order_no) as order_count`，粒度三列、闭窗过滤、空转自检照旧。）

- [ ] **Step 4: schema.yml 对齐**

`dbt/models/common/marts/schema.yml` 的 `fct_retail_sale` 段：加 `branch_num` 列描述（`账套内门店号；粒度第三键`），把粒度描述改为 `(system_book, bizday, branch_num)`，`net_amount` 的 description 更新为「净销售额（#430 平台口径：换货半边公式，详见模型头注）」。

- [ ] **Step 5: 本机验证面**

```bash
pnpm exec tsx scripts/check-data-models.mjs && pnpm typecheck:scripts && pnpm test:guard
```
Expected: 全绿。SQL 本身本机跑不了（无 dbt/pg_duckdb）——真机验收在 Task 6。

- [ ] **Step 6: 提交**

```bash
git add dbt/models/common/marts/fct_retail_sale.sql dbt/models/common/marts/schema.yml dbt/tests/assert_fct_retail_sale_grain_unique.sql dbt/tests/audit_lemeng__retail__net_sales.sql dbt/tests/audit_lemeng__retail__order_count.sql
git commit -m "feat(data): fct_retail_sale 落地换货半边净额口径（#430），粒度扩到门店"
```

---

### Task 5: dbt/README 构件列约定 + 率类 L1/L2 边界（spec §5.2/裁7）

**Files:**
- Modify: `dbt/README.md`

**Interfaces:**
- Produces: W1–W4 各域 fct 模型的**构件列命名约定表**（后续计划的引用锚）+ 率类可否驻 L1 的结论文档。

- [ ] **Step 1: 新增「口径构件列约定」节**（放在「L1 语义声明的落点」节之后）

内容（照抄进 README）：

> **口径构件列约定**（spec 2026-10-12 §5.2）：客户总册的公共定义 R/C/G/E/N/P/A/L/Q/T 不做新机制，落为各域 marts 模型的标准列。构件列只在 fct 定义一次、指标 expression 只引用不改算。
>
> | 域 | fct 模型（W 后缀=落地方） | 构件列 |
> |---|---|---|
> | retail | fct_retail_sale（W0 ✓） | `net_amount`(L)、`order_count` |
> | transfer | fct_transfer_out（W1） | `r_net`(R)、`c_cost`(C)、`g_gross`(G=R−C) |
> | wholesale | fct_wholesale（W1，随回填） | `r_net`、`c_cost`、`g_gross` |
> | expense | fct_expense（W2） | `ep_payable`(EP)、`er_receivable`(ER)、`e_net`(E=应付−应收)、`q_compensation`(Q 补损) |
> | procure | fct_purchase（W3） | `p_net`(P)、`a_weighted_price`(A) |
> | inventory | fct_inventory（W3） | `cover_days`、`near_expiry_money` |
> | finance | fct_finance（W4） | 期初/发生/核销分层列，落点随 W4 设计 |
>
> 新域/新列先改本表再写模型（表是约定的事实源）。

- [ ] **Step 2: 新增「率类（不可加指标）的 L1/L2 边界」段**（裁7 结论）

> 率类指标（毛利率/占比/退货率…）用 L1 的 `ratio: {numerator, denominator}` 声明，分母由 sync 自动包 `nullif(…, 0)`（零分母 → 不适用）。**可驻 L1 的依据**（2026-10-12 对 `modules/data/domain/semantic-compiler.ts` 的读码结论，裁7）：L2 编译点只在 L1 声明的 grain 上追加 WHERE/GROUP BY（`GROUP BY ${metric.groupBy}`），**从不重聚合 value 列**——率在声明粒度上就地计算，不存在「引擎把日率平均成月率」的静默错误；要更粗粒度的率，**另声明一条 L1**（grain 写粗），不许在 L2 里滚。definition 必须写「不可加；上滚=重算/另声明」。

> **既有源 4 项指标的落点**（spec §1「既有源可启动」的逐项处置）：`03-01 门店零售净额及变化` ≡ 本计划的 `lemeng:retail:net_sales`（粒度扩到门店后即它）；`01-05 可比门店增长率`、`07-06 可比门店零售增长`（两期对比）与 `03-05 连续无业绩天数`（窗口序列）按 §5.1 判据属 **L2**，随八角色消费面 spec 落地，不进 L1。

- [ ] **Step 3: 提交**

```bash
git add dbt/README.md
git commit -m "docs(data): 口径构件列约定表 + 率类 L1/L2 边界（裁7 结论）"
```

---

### Task 6: issue + PR + CI + 数据面真机验收

**Files:**
- 无新文件（流程任务）

**Interfaces:**
- Consumes: Task 1–5 的全部提交；`deploy/data-plane-deploy-sop.md` §E（投递程序）/§F（调度归口）；openship 项目 `platform-core-shanhai-data`（server `8281d598`）。

- [ ] **Step 1: 建 issue**

```bash
gh issue create --title "feat(data): 乐檬指标 W0 语义基建（净额口径落地 + L1 ratio 支持）" --body "spec: docs/superpowers/specs/2026-10-12-lemeng-metrics-sources-semantics-design.md §4 W0。范围：① fct_retail_sale 按 #430 换货半边公式实现净额口径（声明先行，粒度扩到门店）；② l1_metrics.yml ratio 声明支持（sync + 门禁 ⑤ 同步）；③ 构件列约定与率类 L1/L2 边界（裁7）。验收：门禁全绿 + 数据面 materialize 后两条 audit 绿 + 净额与 recon-preagg 锚逐分一致。"
```

- [ ] **Step 2: 推分支开 PR**

```bash
git push -u origin ylwzzs/lemeng-metrics-w0-semantics
gh pr create --title "feat(data): 乐檬指标 W0 语义基建（净额口径落地 + L1 ratio 支持）" --body "Closes #<N>

spec: docs/superpowers/specs/2026-10-12-lemeng-metrics-sources-semantics-design.md（§0-D5/§4-W0/§5/裁1/裁7）
- fct_retail_sale：换货半边净额口径（#430），粒度 (system_book, bizday, branch_num)
- l1_metrics.yml：net_sales/order_count 口径声明先行；sync+门禁支持 ratio 声明
- dbt/README：构件列约定表 + 率类边界
真机验收（merge 后）：materialize 两 audit 绿 + recon-preagg 逐分锚 + 词表 groupBy 三列"
```

- [ ] **Step 3: 等 CI CLEAN 再 merge**（铁律：UNSTABLE 不合）

```bash
gh pr checks --watch
gh pr checks   # 全部 pass 且无 UNSTABLE 才合
gh pr merge --squash
```

- [ ] **Step 4: 数据面真机验收**（openship MCP；操作单细节照 `deploy/data-plane-deploy-sop.md` §E）

1. 部署数据面：openship `platform-core-shanhai-data` 触发部署（deployments 接口），等 status 成功（判 `activeDeploymentStatus`，别用 CI job 绿当部署成功）。
2. 触发 `lemeng-dbt-materialize` job，读 run 日志：`dbt build` 中两条 audit（`audit_lemeng__retail__net_sales` / `…__order_count`）**0 行通过**、粒度断言绿。
3. **逐分锚**：用 `scripts/lemeng/recon-preagg.sh` 同一观测窗跑对拍，或用 dbx（PG 连接）抽查 3 个 (账套, 闭窗日, 门店)：`select * from <schema>.fct_retail_sale where …` 与 recon-preagg 2026-10-05 归零公式自算值逐分一致（允许的偏差 = 0）。
4. 词表：`sync-data-semantics --check` 无漂移；`data.metrics` 里两条指标 `group_by` 已是三列。
5. 报表面抽查：Metabase 任一引用 `fct_retail_sale.net_amount` 的看板，数值变化方向与口径一致（旧值偏大——旧口径含作废/换货重复边），在 PR 报告里记录前后值。

- [ ] **Step 5: 收尾报告**

在 issue 收尾评论记录：真机四步证据（audit 绿日志摘录 / 逐分锚差值=0 / 词表 group_by / 看板前后值）+ 裁1 待客户回签的提醒（experimental 不转正）。
