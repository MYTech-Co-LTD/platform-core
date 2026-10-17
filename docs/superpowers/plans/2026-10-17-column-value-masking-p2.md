# 值级脱敏（P2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「同一个指标，不同的人看到不同**精度**的值」成为一条**可声明、可门禁、不可绕**的权限维度——与 P1 的列级共用**同一个执法点**（`authorize()`），不新建权限组件。

**Architecture:** `selectSql` **一个字都不动**；掩码以「列引用 + 掩码规格」声明，在 `authorize()` 组装的 SQL 上做**运行期定点替换**（列引用 → 掩码表达式）。因为替换的是列引用、而列引用必然在聚合函数**内部**，所以「掩码先于聚合」是**构造上成立**的，不是靠纪律。

**Tech Stack:** Node ESM + TypeScript、vitest、dbt YAML（`yaml@2`）、Postgres + pg_duckdb。

## Global Constraints

设计正典 = `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md`（下称 **spec**）§5。

1. **执法点唯一**：掩码只发生在 `authorize()` 组装的 SQL 里。**前端、词表、报表渲染一律不承担安全职责**。
2. **掩码先于聚合**：靠「替换列引用」在构造上保证（spec §5.3 订正块）。**不许**改成「在 `authorize` 之外
   对结果值做加工」——那是聚合后掩码，可被差分攻击逼近精确值。
3. **默认严档**（spec §4.1.1，人裁）：指标**不声明** `mask` 而读了带 `sensitivity` 的源列 ⇒ 套默认掩码
   **`nullify`**。⚠️ **P1 已裁决「先不隐藏」**（#781 关闭），所以今天**没有任何列带 `sensitivity`** ⇒
   默认档**不会命中任何人**。本计划的实现必须**照样实现**它（否则将来打标时会静默漏），但**验收时
   不得依赖生产上有敏感列**——用夹具。
4. **回包必须自述掩码**：`masking` 非空 ⇒ 模型要答「约」。**不做这条 = 另一种泄漏**（更隐蔽）。
5. **闭集是代码常量**：`mask.kind` 只能**选不能扩**；加 kind = 改常量 + 加展开分支 + 测试，走 PR。
6. **`selectSql` 不可被改写存库**：`parseL1Select`（`semantic-compiler.ts:193`）会把它抽出来喂 L2 编译
   （`L1_SELECT_RE`，`:178`）。占位符/掩码**绝不能进**库里那份 `selectSql`。
7. **改 `dbt/**` ⇒ 必须重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`**。
8. **提交纪律**：`<type>(<scope>): <一句话>`；⚠️ issue 锚定见各任务；**PR 正文里不要逐字写**
   "Closes" 加伞 issue 编号（正则会把它当真关联，见 P1 的教训）。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `dbt/semantics/l1_metrics.yml` | L1 声明面（事实源） | T1 加 `mask` |
| `scripts/sync-data-semantics.mjs` | YAML → `data.metrics` 物化 | T1 校验 + 透传 |
| `modules/data/migrations/018_metric_mask.sql` | 加 `data.metrics.mask_spec jsonb` | T1 |
| `modules/data/domain/mask.ts` | **新建**：掩码词表 + `maskedSelectSql()` 纯函数 | T2 |
| `modules/data/domain/authz.ts` | SQL 组装（唯一执法点） | T2 接线 |
| `modules/data/domain/query-service.ts` | 回包与审计 | T2/T3 |
| `modules/data/migrations/019_query_audit_masking.sql` | 审计加列 | T3 |
| `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` | 指令面 | T3 |

**Wave 分组**（波内不得改同一文件）：

| Wave | 任务 | 说明 |
|---|---|---|
| **1** | T0（引擎实测）、T1 | T0 是**前置**（不过不进 T1 之后） |
| **2** | T2 | 依赖 T1 的字段 |
| **3** | T3、T4 | T3 触迁移+审计+SKILL；T4 触 L2 写路径 ⇒ 文件面不相交 |

---

### Task 0: 引擎语义实测（**前置，不过不进 T1**）

**为什么单独一任务**：本计划的三条核心机制都建立在引擎语义上，而**本机没有 duckdb CLI**，
写计划时无法验证。**无案例不立标准**：先测，测不过就改设计，别写完再发现。

- [ ] **Step 1: 在真引擎上跑这四条**

在 pg_duckdb（数据面）或任一 DuckDB 连接上执行：

```sql
-- ① round 的负 scale（掩码的核心表达式）
select round(12345.678::numeric, -3) as v;            -- 期望 12000
-- ② 掩码先于聚合的形状（本计划的核心不变量）
select sum(round(x, -3)) as masked, sum(x) as raw
  from (values (1234.0::numeric), (5678.0::numeric)) t(x);   -- 期望 7000 vs 6912
-- ③ nullify 的 typed NULL 能不能进 sum
select sum(cast(null as numeric)) as v;               -- 期望 NULL（不是报错）
-- ④ 词边界替换的对照：cost 不许命中 cost_money
select regexp_replace('sum(a.cost) + sum(a.cost_money)', '\bcost\b', 'X', 'g') as v;
-- 期望 'sum(a.X) + sum(a.cost_money)'
```

- [ ] **Step 2: 记录结论**

把四条的真实输出贴进任务报告。**任一条不符预期 ⇒ 停下改设计**：
① 不改则掩码表达式换成 `(floor(x / 1000) * 1000)`；③ 不改成 `cast(null as double precision)`；
④ 不成则改用带标识符边界的正则（`(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])`）。

---

### Task 1: `mask` 声明面 + 物化

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（指标对象接受可选 `mask`）
- Modify: `scripts/sync-data-semantics.mjs`（校验 + 透传）
- Modify: `scripts/check-data-models.mjs`（`METRIC_KEYS` 加 `mask`；形状核）
- Create: `modules/data/migrations/018_metric_mask.sql`
- Modify: `modules/data/domain/authz.ts`（`MetricDef` 加可选 `masks`）
- Regenerate: `deploy/data-plane.lock`

**Interfaces:**
- Produces: `data.metrics.mask_spec jsonb`；`MetricDef.masks?: MaskSpec[]`；
  `MaskSpec = { column: string | null; kind: 'round' | 'nullify'; step?: number; grantedBy: string }`。
  **`column === null` = 整值掩码**（见下 ⚠️）。`MASK_KINDS` 常量（T2 与门禁共用，**别另立一份**）。

> ⚠️ **为什么 `column` 必须可为 `null`（写计划时验算出的设计缺口）**：
> 默认档（spec §4.1.1：指标读了带 `sensitivity` 的源列却没声明 `mask` ⇒ 套 `nullify`）里，
> 那个**源列是契约列**（如 `lemeng.wholesale_out.cost_money`），而指标的 `selectSql` 引用的是
> **marts 列**（`fct_contribution.n_net`）——**契约列根本不出现在 `selectSql` 里**
> ⇒ 用列引用替换会**一个都命中不了** ⇒ 掩码静默不生效。
> ⇒ 默认档只能**整值掩码**（把 `… as value` 的表达式整个换成 typed NULL），不能按列替换。
> 这也是 fail-closed 的正确语义：读了敏感列又没声明精细策略 ⇒ **整个值都别给**。

- [ ] **Step 1: 写迁移（幂等）**

`modules/data/migrations/018_metric_mask.sql`：

```sql
-- 018_metric_mask.sql — 值级脱敏的声明面（spec 2026-10-17 §5.2）。
--
-- 纪律（与 016/017 同源）：
--   · 幂等：add column if not exists。执行器是 apps/server/src/migrate.ts 的 runMigrations：
--     它按 platform.schema_migrations **记账去重，已记账的迁移不会重跑**。幂等是给「开发期
--     连跑」与「坏形状下重放」兜底 —— **别指望「删一列再上线能自动加回来」**（不会）。
--   · 无 create table ⇒ 无租户隔离面新增（data.metrics 的 org 由 001 建立）。
--
-- mask_spec = 该指标的掩码声明数组，形如
--   [{"column":"fct_x.net_amount","kind":"round","step":1000,"grantedBy":"data:precise"}]
-- NULL = 未声明（此时由「源列 sensitivity」推默认档，见 spec §4.1.1）。
-- ⚠️ 它**不进 select_sql**：运行期在 authorize() 里对 select_sql 做列引用定点替换
--    （spec §5.3 订正块——占位符进 select_sql 会被 L2 编译原样带出去）。

alter table data.metrics
  add column if not exists mask_spec jsonb;
```

- [ ] **Step 2: 声明面校验（sync）**

`scripts/sync-data-semantics.mjs` 里加 `masksOf(v, metricName, selectSql)`，照 `requiredScopeOf` / `slaDaysOf`
的脾气（缺省 → `null`；给了就逐项校验，坏形状**响亮失败**）：

判据（写死）：
- `mask` 必须是数组，元素是对象，键闭集 `{column, kind, step, grantedBy}`；
- `kind ∈ MASK_KINDS`；`kind === 'round'` ⇒ `step` 必须是正整数；
- `grantedBy` 必须是非空无空白字符串；
- **`column` 非 null 时必须逐字出现在该指标的 `selectSql` 里**（否则运行期替换命中不了 ⇒
  **静默不生效**，正是本设计最怕的形态）。用 `new RegExp('\\b' + escapeRegExp(column) + '\\b').test(selectSql)`。
  `column === null`（整值掩码）**跳过这条**——它本来就不按列命中。
- **`column === null` 时 `kind` 只允许 `nullify`**（整值做 `round` 没有语义）。

⚠️ **`escapeRegExp` 必须转义 `.`**——列引用是 `表.列` 形态，不转义会被当通配符。

- [ ] **Step 3: `check-data-models.mjs` 加 `mask`**

① `METRIC_KEYS` 加 `'mask'`；② 形状核照 ⑤-b/⑤-c 的写法加一条。变异确认：把某条的 `mask`
写成非数组 ⇒ 必须报。

- [ ] **Step 4: 物化 + 重生成 lock + 门禁**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm typecheck && pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs
```

- [ ] **Step 5: 单测 + 变异确认**

给 `sync-data-semantics.test.ts` 加 `mask` 用例组（缺省 / 合法 / 非数组 / 未知 kind / 缺 step /
`column` 不在 `selectSql` 里）。变异确认：去掉「column 必须在 selectSql 里」那条检查 ⇒
**恰好**有一条用例红。

- [ ] **Step 6: 提交**

`feat(data): 指标声明面开放 mask（值级脱敏）`

---

### Task 2: 运行期展开 + `masking` 回包

**Files:**
- Create: `modules/data/domain/mask.ts`（纯函数）
- Create: `modules/data/domain/mask.test.ts`
- Modify: `modules/data/domain/authz.ts`（`authorize` 里接线）
- Modify: `modules/data/domain/query-service.ts`（回包 `masking`）

**Interfaces:**
- Consumes: T1 的 `MetricDef.masks` / `MaskSpec` / `MASK_KINDS`。
- Produces: `export function maskedSelectSql(selectSql, masks, hasScope): { sql: string; applied: Record<string, string> }`；
  `QueryOk` 增**可空** `masking?: Record<string, string>`。

- [ ] **Step 1: 写失败测试**

`modules/data/domain/mask.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { maskedSelectSql } from './mask'

const SEL = 'select sum(fct_x.net_amount) as value, bizday from fct_x'
const R = (spec: string) => ({ column: 'fct_x.net_amount', kind: 'round' as const, step: 1000, grantedBy: 'data:precise', ...JSON.parse(spec) })

describe('maskedSelectSql（spec §5.3）', () => {
  it('有 grantedBy ⇒ 原样返回、applied 为空', () => {
    const r = maskedSelectSql(SEL, [R('{}')], () => true)
    expect(r.sql).toBe(SEL)
    expect(r.applied).toEqual({})
  })

  it('无 grantedBy ⇒ 列引用被包成 round(…, -step)（掩码在聚合内部）', () => {
    const r = maskedSelectSql(SEL, [R('{}')], () => false)
    expect(r.sql).toBe('select sum(round(fct_x.net_amount, -1000)) as value, bizday from fct_x')
    expect(r.applied).toEqual({ 'fct_x.net_amount': 'round:1000' })
  })

  it('nullify ⇒ 列引用换成 typed NULL（sum(NULL) 会报错，必须带类型）', () => {
    const r = maskedSelectSql(SEL, [R('{"kind":"nullify"}')], () => false)
    expect(r.sql).toBe('select sum(cast(null as numeric)) as value, bizday from fct_x')
    expect(r.applied).toEqual({ 'fct_x.net_amount': 'nullify' })
  })

  it('词边界：cost 不许命中 cost_money（子串误伤 = 把没声明的列也掩了）', () => {
    const sql = 'select sum(a.cost) + sum(a.cost_money) as value from a'
    const r = maskedSelectSql(sql, [{ column: 'a.cost', kind: 'round', step: 1000, grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select sum(round(a.cost, -1000)) + sum(a.cost_money) as value from a')
  })

  it('列引用不在 selectSql 里 ⇒ 不改、applied 为空（L2 编译已展开的情形）', () => {
    const r = maskedSelectSql('select sum(a.other) as value from a', [{ column: 'a.cost', kind: 'round', step: 1000, grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select sum(a.other) as value from a')
    expect(r.applied).toEqual({})
  })

  it('★ 整值掩码（column=null）⇒ 把 `… as value` 的表达式整个换掉（默认档用它）', () => {
    const r = maskedSelectSql(SEL, [{ column: null, kind: 'nullify', grantedBy: 'p' }], () => false)
    expect(r.sql).toBe('select cast(null as numeric) as value, bizday from fct_x')
    expect(r.applied).toEqual({ '<value>': 'nullify' })
  })

  it('整值掩码在有 grantedBy 时也不改', () => {
    expect(maskedSelectSql(SEL, [{ column: null, kind: 'nullify', grantedBy: 'p' }], () => true).sql).toBe(SEL)
  })

  it('多条掩码各自独立生效', () => { /* 两个不同列、不同 step */ })
})
```

- [ ] **Step 2: 跑测试确认它红**（模块不存在）

- [ ] **Step 3: 实现**

关键实现要点（都是硬坑，别省）：

```ts
/**
 * ⚠️ 用**每次新建**的带 `g` 正则、且只走 `replace`，**不要**先 `.test()` 再 `.replace()`：
 *    带 `g` 的正则 `.test()` 会推进 `lastIndex`，同一正则复用时会**跳过**命中（经典坑）。
 *    这里用「replace 后比较是否变化」判命中，既避开 lastIndex 又不用二次匹配。
 */
const next = sql.replace(re, () => maskExpr(spec))
if (next === sql) continue // 没命中
```

```ts
/**
 * ⚠️ `maskExpr` 的返回值走**回调**（`() => expr`），不是字符串：字符串形态下 `$&` / `$1`
 *    会被 replace 当成替换模式解释——掩码表达式里出现 `$` 就会静默产生垃圾 SQL。
 */
```

`maskExpr`：
- `round` → `round(${column}, -${step})`
- `nullify`（按列）→ `cast(null as numeric)`
- `nullify`（整值，`column === null`）→ 用另一条改写：把 `^select\s+([\s\S]+?)\s+as\s+value`
  的捕获组整段换成 `cast(null as numeric)`（**保留 `as value` 之后的维度列**）。
  形状与 `L1_SELECT_RE`（`semantic-compiler.ts:178`）同源——写的时候照它抄，别自创。

> ⚠️ 整值改写**只动 `selectSql` 的副本**，绝不回写库（Global Constraint 6）。

- [ ] **Step 4: 接进 `authorize()`**

`modules/data/domain/authz.ts` 里、**拼出 `whereAndGroup` 之前**，对 `metric.selectSql` 跑一遍
`maskedSelectSql`；把 `applied` 带进 `AuthzResult`。⚠️ **`total` 那条查询自动受益**——
它读的是同一个内层 select，所以 `total` 与明细行用的是**同一套掩码值**（spec §3.2 不变量 2）。

- [ ] **Step 5: 回包带 `masking`**

`query-service.ts` 的 `QueryOk` 组装处，`applied` 非空才带 `masking`（空则**不出现该键**，
与既有 `total?` / `freshness_*?` 同风格）。

- [ ] **Step 6: 变异确认**

① 去掉词边界 ⇒ 「cost 不许命中 cost_money」红；
② 把 `round(${column}, -${step})` 改成 `round(value, -${step})`（模拟「聚合后掩码」）⇒
   「无 grantedBy ⇒ round 在聚合内部」红。

- [ ] **Step 7: 提交** `feat(data): 值级掩码在 authorize 里定点展开 + 回包 masking`

---

### Task 3: 审计列 + 指令面

**Files:**
- Create: `modules/data/migrations/019_query_audit_masking.sql`
- Modify: `modules/data/domain/audit-store.ts`（`AuditEntry` + INSERT）
- Modify: `modules/data/domain/query-service.ts`（传 `masking`）
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`

- [ ] **Step 1: 迁移**

```sql
-- 019_query_audit_masking.sql — 谁看过掩码值 / 谁看过原值（spec §4.4）。
alter table data.query_audit
  add column if not exists masking jsonb;
```

- [ ] **Step 2: 写入**

`AuditEntry` 加 `masking: Record<string,string> | null`；INSERT 加一列。⚠️ **`null` 与 `{}` 是两回事**：
`null` = 本次没有任何掩码生效（用户有 `grantedBy` 或指标无掩码）；`{}` 在本设计里**不该出现**
（`applied` 为空时传 `null`）。照 `rowCount: null ≠ 0` 的既有注记写清楚。

- [ ] **Step 3: SKILL 同步（**不做 = 另一种泄漏**）**

`SKILL.md` 的「纪律（回包信号 → 动作）」加一条：

> **`masking` 非空** ⇒ 答「约 ¥X」「X 元上下」，**不得报精确值**。掩码是系统给的精度上限，
> 报成精确值等于把系统抹掉的精度又还回去。

- [ ] **Step 4: 验收**

真库跑（全新空库，`DATABASE_URL=… pnpm --filter data test`），确认**无 skip**；变异确认：
把审计的 `masking` 恒传 `null` ⇒ 恰好有一条用例红。

- [ ] **Step 5: 提交** `feat(data): 审计记录掩码 + 指令面同步`

---

### Task 4: L2 fail-closed 守卫（**别让它成为绕过口**）

**Files:**
- Modify: `modules/data/domain/semantic-compiler.ts` 或 L2 写路径（实施时定位）
- Test: 对应测试文件

**为什么必须做**：L2 由 `compileL2` 从 L1 编译而来，编译后**已经没有那个列引用**（已展开成 `sum/base`）
⇒ **定点替换命中不了它**。一个基于被掩码 L1 的 L2 就能把原值透出来。

**判据（fail-closed）**：L2 的 base 若指向**带 `mask` 的 L1** ⇒ **拒绝创建/更新该 L2**，错误信息点名
是哪个 L1、哪条掩码。⚠️ 不要「静默放行 + 记日志」——那正是本设计要防的形态。

- [ ] **Step 1: 先查现状**

```sql
select count(*) from data.metrics where source = 'l2';
```

把结果记进报告。若为 0，说明本守卫**今天是空转**，但**仍要落**（将来第一个 L2 就会踩）。

- [ ] **Step 2: 写失败测试** → 实现 → 变异确认（去掉守卫 ⇒ 恰好一条红）→ 提交

`feat(data): L2 不得基于被掩码的 L1 构建（fail-closed）`

---

## 验收（全计划）

| 判据 | 怎么验 |
|---|---|
| **掩码先于聚合** | 抓 `authz.plan.sql` 看 `sum(round(col,-n))`；再看 `total` 是同一内层 select 的和 |
| **不可绕** | 换过滤 / 换时间窗 / 换分组 / `total=true` / 走 MCP / 走报表 —— 掩码恒定 |
| **差分攻击** | 两组只差一行的过滤取差 ⇒ 只能得到**掩码后的值** |
| **回包自述** | `masking` 非空且内容 == 审计列 |
| **默认严档** | 夹具里给源列打 `sensitivity: cost`、指标不声明 `mask` ⇒ 无特权者拿到 NULL |
| **L2 不绕** | 基于被掩码 L1 建 L2 ⇒ 400 点名 |
| **前端不算数** | 一律从 `rows` 原始 JSON 判，**不看界面** |

## 已知边界（写进 issue 的「非目标」）

1. **只覆盖 L1**（spec §5.3.1）；L2 走 T4 的 fail-closed，不做掩码传播。
2. **`bucket` 不在本计划**：它的防护强度 = 桶宽（不是「安全」），且与 `total` 冲突（spec §5.1）。
   真有人要区间展示时再做。
3. **直读面（Metabase / AI 直读数据面）不受本机制约束**（spec §3.3）——那是另一条腿。
