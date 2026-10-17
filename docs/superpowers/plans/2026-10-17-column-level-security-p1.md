# 列级权限（P1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「同一个指标，不同的人看得到不同的列」成为一条**可声明、可门禁、不可绕**的权限维度——不新建权限组件，只在既有唯一划线依据（`modules/data/domain/authz.ts`）上把「列」这一维补上。

**Architecture:** 三层声明 + 一个执法点。**源列**（`contracts/*.json` 的 `sensitivity`）只作血缘门的输入、不直接执法；**指标**（dbt YAML → `data.metrics`）承载真正的策略（`required_scope`）；**报表**（`report_specs`）的 `requiredScope` 改为从面板**派生**。执法点唯一：`authorize()` 组装的 SQL 投影。

**Tech Stack:** Node ESM + TypeScript（`tsx` 直跑 `.mjs`）、vitest、dbt YAML（`yaml@2`）、Postgres。

## Global Constraints

设计正典 = `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md`（下称 **spec**）；架构不变量 = `docs/architecture.md` §2.2 末注 + §4.2。

1. **执法点唯一**：裁剪只发生在 `authorize()` 组装的 SQL 里。**前端、词表、报表渲染一律不承担安全职责**（前端脱敏 = 没脱敏）。任何「靠从词表里藏起来」的写法都**不算**实现（`docs/architecture.md:194-195`）。
2. **血缘单调**：`policy(指标) ⊇ ∪ policy(该指标读到的源列)`。给源列加限制而读它的指标未同步收窄 ⇒ **CI 红**。
3. **闭集是代码常量，不是配置**：`sensitivity` / （P2 的）`mask.kind` 只能**选不能扩**；加值 = 改常量 + 改 schema + 改门禁 + 走 PR（同 `CHART_TYPES` 纪律，`modules/data/domain/report-spec.ts:12`）。
4. ⚠️ **契约元 schema 没有校验器**（`contracts/README.md` §4.3 自陈欠账）⇒ **闭集必须在 `scripts/check-data-contract.mjs` 里实现**，那是唯一进 CI 的契约检查。只改 `_schema.schema.json` = 没改。
5. ⚠️ **改 `contracts/**` 或 `dbt/**` ⇒ 必须重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`**（lock 覆盖 contracts 19 条 + dbt 105 条），否则 `check-data-plane-lock.mjs` 红。
6. **权限码**：P1 新增 `data:cost`（`modules/data/manifest.yaml` 的 `permissions[]`），由装载器按各租户 org 逐个 upsert——**不新增发码通路**。租户管理员可发（`POST /admin/permissions/:code/users`，`requireScope('tenant:admin')`）。
7. **审计**：P1 **不加** `data.query_audit` 的列（既有 `verdict='denied'` 已覆盖 P1 的全部形态；`masking` 列随 P2）。
8. **提交纪律**：`<type>(<scope>): <一句话>`；本计划所有 PR 的 body 含 `Closes #764`（或 `Refs #764`，视该 PR 是否收口伞 issue 而定）；CHANGELOG 禁手写。
9. **本计划不碰**：`modules/data/domain/query-service.ts` 的查询路径、`authorize()` 本体、任何掩码/值级逻辑（全归 P2）。P1 **只加声明面与门禁**，**不改运行时行为**——这是刻意的：先让「约束」可表达、可检查，再谈执行。

---

## File Structure

| 文件 | 责任 | 本计划 |
|---|---|---|
| `contracts/common/_schema.schema.json` | 契约文档的元 schema（**纯文档，无校验器**） | T1 加 `sensitivity` |
| `scripts/check-data-contract.mjs` | 契约的**唯一** CI 检查（B10 门禁） | T1 加闭集校验 |
| `scripts/check-data-contract.test.ts` | 上述门禁的夹具测试 | T1 加用例 |
| `dbt/semantics/l1_metrics.yml` | L1 语义声明（**事实源**，35 条） | T2 加 `required_scope` / `reads` |
| `scripts/sync-data-semantics.mjs` | YAML → `data.metrics` 物化 | T2 去掉硬编码 `requiredScope: null` |
| `scripts/check-data-models.mjs` | dbt 工件静态门禁（规则 ⑤ = 语义声明） | T2 加形状核 + **未知键拒绝** |
| `modules/data/manifest.yaml` | 权限码 + 路由声明 | T2 加 `data:cost` |
| `scripts/check-column-scope-monotonicity.mjs` | **新建**：血缘单调门 | T3 |
| `.github/workflows/ci.yml` | CI（`gates` job） | T3 接线 |
| `modules/data/domain/report-scope.ts` | **新建**：`requiredScope` 派生的纯函数（无 IO） | T4 |
| `modules/data/routes/reports.ts` | 报表路由（含发布） | T4 接线（两个写入点） |
| `deploy/data-plane.lock` | 数据面投递清单（生成物） | T1/T2/T5 重生成 |

**Wave 分组**（波内不得改同一文件；`deploy/data-plane.lock` 是共享文件 ⇒ 触它的任务必须串行）：

| Wave | 任务 | 为什么这么分 |
|---|---|---|
| **1** | T1、T4 | 文件面不相交（T1 触 `contracts/`+lock，T4 只触 `modules/data/routes/`） |
| **2** | T2 | 触 `dbt/`+lock ⇒ 与 T1 串行 |
| **3** | T3 | 依赖 T1（`sensitivity` 数据）+ T2（`reads`/`required_scope` 声明面） |
| **4** | T5 | 依赖 T1+T2+T3（首个真实配对；触 lock ⇒ 串行） |

---

### Task 1: 契约列 `sensitivity`（字段 + **真**校验）

**Files:**
- Modify: `contracts/common/_schema.schema.json`（`$defs.column.properties`，L162-197 之间）
- Modify: `scripts/check-data-contract.mjs`（`checkDataContract` 内的逐契约循环）
- Test: `scripts/check-data-contract.test.ts`
- Regenerate: `deploy/data-plane.lock`

**Interfaces:**
- Produces: 契约列可带可选 `sensitivity: 'cost' | 'pii' | 'none'`；`scripts/check-data-contract.mjs` 导出 `SENSITIVITY_KINDS: readonly string[]`（T3 会 import 它，**不要另立一份**）。

- [ ] **Step 1: 写失败测试**

在 `scripts/check-data-contract.test.ts` 里给 `fixture` 的 `over` 形参加一个字段（放在 `srcSchema` 之后）：

```ts
  sensitivity?: Record<string, string>
```

并把契约列构造那行改成（在 `fixture` 内）：

```ts
    columns: cc.map((name) => ({
      name, type: 'varchar', nullable: true,
      ...(over.sensitivity?.[name] ? { sensitivity: over.sensitivity[name] } : {}),
    })),
```

再在文件末尾加一条用例：

```ts
describe('sensitivity 闭集（元 schema 无校验器 ⇒ 这里才是真闸）', () => {
  it('打错的值必须报违规——否则血缘门会把它当「不敏感」静默放行', () => {
    const root = fixture({ sensitivity: { amount: 'coast' } })   // 注意是 coast 不是 cost
    const v = checkDataContract(root)
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('sensitivity')
    expect(v[0].message).toContain('coast')
  })

  it('合法值（cost）不报违规', () => {
    expect(checkDataContract(fixture({ sensitivity: { amount: 'cost' } }))).toHaveLength(0)
  })

  it('不声明 sensitivity 不报违规（缺省 = none）', () => {
    expect(checkDataContract(fixture())).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `pnpm exec vitest run --dir scripts -t 'sensitivity 闭集'`
Expected: FAIL —— 第 1 条 `expected [] to have a length of 1`（门禁还不认识这个字段）

- [ ] **Step 3: 在门禁里实现闭集**

`scripts/check-data-contract.mjs` 顶部（挨着 `export const SCRIPT_NAME`）加：

```js
/**
 * `sensitivity` 的闭集。**这是唯一进 CI 的那道闸**——`contracts/common/_schema.schema.json`
 * 里那份 `enum` 是给人和生成器看的，仓内**没有任何东西拿它校验契约**
 * （`contracts/README.md` §4.3 自陈欠账）。只改 schema 不改这里 = 打错的标记被血缘门
 * 当成「不敏感」而**静默放行**。
 *
 * 加值 = 改这个常量 + 改元 schema + 改 `check-column-scope-monotonicity.mjs` + 走 PR。
 */
export const SENSITIVITY_KINDS = ['cost', 'pii', 'none']
```

在 `checkDataContract` 的逐契约循环里、拿到 `colNames` 之后（L101 下方）插入：

```js
    // ⑤ sensitivity 闭集（元 schema 无校验器 ⇒ 这里才是真闸）
    for (const col of c.columns) {
      if (col.sensitivity === undefined) continue
      if (!SENSITIVITY_KINDS.includes(col.sensitivity)) {
        violations.push({
          file: rel,
          message:
            `列 \`${col.name}\` 的 sensitivity 取值非法（收到 ${JSON.stringify(col.sensitivity)}）`
            + `—— 闭集是 ${SENSITIVITY_KINDS.join(' / ')}。`
            + '⚠️ 打错的值会被血缘门（scripts/check-column-scope-monotonicity.mjs）'
            + '当成「不敏感」而静默放行，所以这里必须响亮。',
        })
      }
    }
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `pnpm exec vitest run --dir scripts -t 'sensitivity 闭集'`
Expected: PASS（3 passed）

- [ ] **Step 5: 把字段登记进元 schema（文档面）**

`contracts/common/_schema.schema.json` 的 `$defs.column.properties` 里、`"expr"` 之后加：

```json
        "sensitivity": {
          "description": "敏感标记。只作血缘门（scripts/check-column-scope-monotonicity.mjs）的输入；不改变本列的落盘与投影。⚠️ 闭集的**真闸**在 scripts/check-data-contract.mjs 的 SENSITIVITY_KINDS——本文件没有校验器，改一处必须改两处。",
          "enum": ["cost", "pii", "none"]
        }
```

- [ ] **Step 6: 重生成数据面 lock**

Run: `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`
Expected: 退出 0，`deploy/data-plane.lock` 里 `contracts/common/_schema.schema.json` 那行的 sha256 变了（其余行不动）

- [ ] **Step 7: 跑该仓全量门禁**

Run: `pnpm typecheck && pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs && pnpm exec tsx scripts/gen-data-projection.mjs --check && pnpm run test:guard`
Expected: 全部退出 0。⚠️ `gen-data-projection --check` 必须绿——加一个**非 `expr`** 字段不应改变生成物；若它红了，说明生成器读了别的字段，**停下来查清再改**。

- [ ] **Step 8: 提交**

```bash
git add contracts/common/_schema.schema.json scripts/check-data-contract.mjs scripts/check-data-contract.test.ts deploy/data-plane.lock
git commit -m "feat(data): 契约列加 sensitivity 标记与闭集门禁"
```

---

### Task 2: L1 声明面加 `required_scope`（+ 权限码 `data:cost`）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`
- Modify: `scripts/sync-data-semantics.mjs`（`toMetricRow` 的 `requiredScope` 一行 + 新助手）
- Modify: `scripts/check-data-models.mjs`（规则 ⑤ 加两个新字段的形状核 + **未知键拒绝**）
- Modify: `modules/data/manifest.yaml`（`permissions[]`）
- Regenerate: `deploy/data-plane.lock`

**Interfaces:**
- Consumes: 无（与 T1 并行）
- Produces: ① `dbt/semantics/l1_metrics.yml` 的指标对象接受可选 `required_scope: <码>` 与可选 `reads: [<源列全名>]`（形如 `lemeng.item.item_cost_price`，全名 = `<contract.domain>.<contract.table>.<column.name>`）；② `data.metrics.required_scope` 可被 L1 物化写入（今天恒 `null`）；③ 权限码 `data:cost` 存在。

> ⚠️ **本任务不改运行时行为**：现有 35 条指标**一条都不加** `required_scope`（加了才会变），只把**通路**打通。

- [ ] **Step 1: 在 sync 里把硬编码换成响亮校验**

`scripts/sync-data-semantics.mjs` 里 `slaDaysOf` 旁边加一个同脾气的助手（照着 `slaDaysOf` 的形状写——它是本文件既有的「缺/坏形状就响亮失败」范式）：

```js
/**
 * `required_scope`：缺省 = `null`（所有拿到本模块的人可见，与今天一致）；给了就必须是
 * **非空、无首尾空白**的字符串。
 *
 * 为什么不 trim 而是拒绝：本脚本的脾气是「取不到/说不准就响亮失败」，静默 trim 等于替作者
 * 改他的声明；而这个值要与 `modules/data/manifest.yaml` 的 `permissions[].code` **逐字**
 * 比对才生效（`requester.hasScope()` 是集合成员判断，不认近似值）⇒ 带空白的码 = 谁也匹配不上
 * = 该指标对**所有人**静默不可见。与 `source` 那条同款坑，处理方式保持一致。
 *
 * ⚠️ 这里**不校验**该码是否在 manifest 里存在——那需要读另一个文件，属静态门禁的活
 * （`scripts/check-data-models.mjs`）。本助手只保证形状。
 */
function requiredScopeOf(v, name) {
  if (v === undefined || v === null) return null
  const s = String(v)
  if (s.trim() === '') {
    throw new Error(`指标 \`${name}\` 的 \`required_scope\` 是空白 —— 空白码谁也匹配不上`
      + '（该指标对所有人静默不可见）。要么删掉这个键，要么写一个真实存在的权限码。')
  }
  if (s !== s.trim()) {
    throw new Error(`指标 \`${name}\` 的 \`required_scope\` ${JSON.stringify(s)} 首尾带空白 ——`
      + ` 权限码是**逐字**比对的集合成员判断，带空白匹配不上（症状：该指标对所有人都查不出来，`
      + `且不报错）。请写成 \`${s.trim()}\`。`)
  }
  return s
}
```

把 `toMetricRow` 里那一行

```js
      requiredScope: /** @type {string|null} */ (null),
```

换成

```js
      requiredScope: requiredScopeOf(m.required_scope, name),
```

- [ ] **Step 2: 给权限码 `data:cost` 进 manifest**

`modules/data/manifest.yaml` 的 `permissions[]` 里加一条（**沿用该列表既有条目的字段形状**，读一眼再写）：

```yaml
  - code: data:cost
    title: 成本/毛利明细
    description: 看得到成本价、毛利额一类敏感指标。由租户管理员发放。
```

⚠️ **装载期双向核对**（`docs/architecture.md` 不变量 2）：`permissions[]` 是**声明**，不是路由——
加码**不会**让装载失败；但**漏了它**，`required_scope: data:cost` 就永远匹配不上（静默不可见）。

- [ ] **Step 3: 加一条真实声明（验证通路，不改变可见性）**

在 `dbt/semantics/l1_metrics.yml` 里挑一条**已存在**的指标，给它加 `reads`（**不加** `required_scope`）：

```yaml
    reads: ['lemeng.item.item_cost_price']      # 只在确实读了这一列时写；T5 会逐个核准
```

> ⚠️ **别乱写 `reads`**：它是 T3 门禁的**输入**。写错了方向是**不安全**的（少写 = 门禁以为没读 = 放行）。
> 本步骤只挑一条**你有把握**的指标；拿不准就**不加**，把 `reads` 留给 T5 逐条核准。

- [ ] **Step 4: 跑 sync 的 dry-run 面确认形状没坏**

Run: `pnpm exec tsx scripts/sync-data-semantics.mjs --check`
Expected: 退出 0（`--check` 检出漂移；本步只确认 YAML 能解析、形状校验全过）

- [ ] **Step 5: 补规则 ⑤ 的形状核 + **未知键拒绝**（**必做**，不是「看情况」）**

> ⚠️ **为什么必做**：`scripts/check-data-models.mjs` 的规则 ⑤ 今天只做两件事——**必填字段齐全**、
> **已知字段的形态核**（`source` / `freshness_sla_days` 各有自己的形状核，见 L220 / L236）。
> 它**不拒绝未知键**。⇒ 一个把 `required_scope` 拼成 `required_scpoe` 的声明**不会报任何错**，
> 于是那个指标**永远不受限制**——**正是本设计最怕的静默漏**（与 T1 那条 `sensitivity` 打错是同一类）。
> ⇒ 本步**同时**做两件事：① 新字段的形状核；② 指标对象的**未知键拒绝**（闭集 = 今天的键集合）。

- [ ] **Step 5a: 形状核**

照 L236 `source` 那条的写法，给两个新字段各加一条：

```js
  // 规则 ⑤ 的形状：`required_scope`（列级/值级授权码，spec 2026-10-17 §4.2）——给了就必须是
  // 非空、无首尾空白的字符串。**这里不判「码是否存在」**（那要读 manifest，属另一条门禁）；
  // 缺字段的情形不报（缺省 = null = 不限制，是合法声明）。
  // ⚠️ 为什么必须判形态：权限码是**逐字**比对的集合成员判断，带空白/空串的码谁也匹配不上
  //    ⇒ 该指标对所有人静默不可见（坏在数据里，不报错）。
  // 规则 ⑤ 的形状：`reads`（该指标读了哪些源列，spec §4.3）——给了就必须是**非空字符串数组**。
  // 元素指向不存在的源列由 scripts/check-column-scope-monotonicity.mjs 报（T3），这里只判形状。
```

- [ ] **Step 5b: 未知键拒绝**

先**从文件里读出**今天的键集合（**不要凭记忆列**）：

```bash
grep -oE '^    [a-z_]+:' dbt/semantics/l1_metrics.yml | sort -u
```

把结果作为闭集常量写进 `check-data-models.mjs`，并在规则 ⑤ 里对每个指标对象做差集检查：

```js
/** 语义声明允许的键（闭集）。**加字段 = 改这里 + 改 README + 走 PR。**
 *  为什么必须是闭集：规则 ⑤ 的其余部分只认**已知**键 ⇒ 拼错的键名（`required_scpoe`）
 *  会被完全忽略，声明「写了但没生效」，而症状是**那个指标永远不受限制**——静默，不报错。 */
const METRIC_KEYS = new Set(['name', 'label', 'definition', 'expression', 'ratio', 'grain',
  'source', 'freshness_sla_days', 'sources', 'owner', 'tier', 'reads', 'required_scope' /* ← 与上面 grep 结果核对后定稿 */])
```

```js
    for (const k of Object.keys(m)) {
      if (!METRIC_KEYS.has(k)) {
        push(rel, 0, `指标 \`${name}\` 有未知字段 \`${k}\` —— 拼错的键名会被静默忽略`
          + '（声明写了但没生效，症状是该指标永远不受限制）。允许的键见 METRIC_KEYS。')
      }
    }
```

- [ ] **Step 5c: 变异确认**

在 `dbt/semantics/l1_metrics.yml` 里**临时**把某条的 `required_scope` 改成 `required_scpoe`，
跑 `pnpm exec tsx scripts/check-data-models.mjs` ⇒ **必须报未知字段**。确认后改回来。
（若它不报——说明差集检查没接上，**停下查清**。）

- [ ] **Step 5d: 跑 dbt 工件门禁确认全绿**

Run: `pnpm exec tsx scripts/check-data-models.mjs`
Expected: 退出 0（35 条声明全部通过闭集检查）

- [ ] **Step 6: 重生成 lock + 全量门禁**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm typecheck && pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs && pnpm exec tsx scripts/check-manifests.mjs
```
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add dbt/semantics/l1_metrics.yml scripts/sync-data-semantics.mjs modules/data/manifest.yaml deploy/data-plane.lock
git commit -m "feat(data): L1 声明面开放 required_scope 与 reads，加 data:cost 权限码"
```

---

### Task 3: 血缘单调门

**Files:**
- Create: `scripts/check-column-scope-monotonicity.mjs`
- Test: `scripts/check-column-scope-monotonicity.test.ts`
- Modify: `.github/workflows/ci.yml`（`gates` job，接在 `check-data-contract.mjs` 那条之后）

**Interfaces:**
- Consumes: T1 的 `SENSITIVITY_KINDS`（`import { SENSITIVITY_KINDS } from './check-data-contract.mjs'`——**别另立一份闭集**）；T2 的 `l1_metrics.yml` 字段 `required_scope` / `reads`。
- Produces: `export function checkColumnScopeMonotonicity(rootDir: string): Violation[]`，`Violation = { file: string, message: string }`（与 `check-data-contract.mjs` 同形）。

**判据（写死，别扩）**：源列 `sensitivity !== 'none'` 且被某指标 `reads` 声明 ⇒ 该指标**必须**有
`required_scope`。没有 ⇒ 违规。

> ⚠️ **这道门只查「申报的单调性」，查不到「漏申报」**。完整性需要 contract→marts 的列级血缘，
> **仓内不存在**（无 dbt manifest）。这条限制要写进脚本头注与 CI 那行的注释里——**别让它看起来比实际强**。

- [ ] **Step 1: 写失败测试**

新建 `scripts/check-column-scope-monotonicity.test.ts`，照 `scripts/check-data-contract.test.ts` 的手法（临时目录造假仓 + 变异确认）：

```ts
// scripts/check-column-scope-monotonicity.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkColumnScopeMonotonicity } from './check-column-scope-monotonicity.mjs'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** 造一棵最小假仓：一份契约（可选打标）+ 一份 L1 声明（可选 required_scope / reads）。 */
function fixture(opts: { sensitivity?: string; reads?: string[]; requiredScope?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'colscope-'))
  roots.push(root)
  mkdirSync(join(root, 'contracts', 'common'), { recursive: true })
  mkdirSync(join(root, 'dbt', 'semantics'), { recursive: true })
  writeFileSync(join(root, 'contracts', 'common', 'lemeng.item.json'), JSON.stringify({
    contractVersion: 2, domain: 'lemeng', table: 'item', owner: 't',
    layout: { prefix: 'lemeng/dim_item', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
    batch: { markerColumn: 'batch_id', type: 'varchar' },
    schemaVersion: 1, consumerVersion: 1,
    columns: [{
      name: 'item_cost_price', type: 'decimal', precision: 14, scale: 2, nullable: true,
      ...(opts.sensitivity ? { sensitivity: opts.sensitivity } : {}),
    }],
  }, null, 2))
  writeFileSync(join(root, 'dbt', 'semantics', 'l1_metrics.yml'), [
    'metrics:',
    '  - name: \'lemeng:item:gross_rate\'',
    '    label: 毛利率',
    '    definition: 测试用',
    '    expression: \'sum(fct_item.item_cost_price)\'',
    '    grain: [bizday]',
    '    source: lemeng',
    '    freshness_sla_days: 2',
    ...(opts.reads ? [`    reads: [${opts.reads.map((r) => `'${r}'`).join(', ')}]`] : []),
    ...(opts.requiredScope ? [`    required_scope: ${opts.requiredScope}`] : []),
  ].join('\n'))
  return root
}

describe('血缘单调门', () => {
  it('源列敏感 + 指标读了它 + 指标无 required_scope ⇒ 违规', () => {
    const v = checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost', reads: ['lemeng.item.item_cost_price'] }))
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('item_cost_price')
    expect(v[0].message).toContain('gross_rate')
  })

  it('指标声明了 required_scope ⇒ 不违规', () => {
    const v = checkColumnScopeMonotonicity(fixture({
      sensitivity: 'cost', reads: ['lemeng.item.item_cost_price'], requiredScope: 'data:cost',
    }))
    expect(v).toHaveLength(0)
  })

  it('源列不敏感（sensitivity: none）⇒ 不违规', () => {
    expect(checkColumnScopeMonotonicity(fixture({ sensitivity: 'none', reads: ['lemeng.item.item_cost_price'] }))).toHaveLength(0)
  })

  it('源列没打标（缺省 = none）⇒ 不违规', () => {
    expect(checkColumnScopeMonotonicity(fixture({ reads: ['lemeng.item.item_cost_price'] }))).toHaveLength(0)
  })

  it('指标没申报 reads ⇒ 不违规（本门查不到漏申报，这是已知限制）', () => {
    expect(checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost' }))).toHaveLength(0)
  })

  it('reads 指了不存在的源列 ⇒ 违规（打错的名字不许静默通过）', () => {
    const v = checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost', reads: ['lemeng.item.no_such_col'] }))
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('no_such_col')
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `pnpm exec vitest run --dir scripts -t '血缘单调门'`
Expected: FAIL —— `Failed to resolve import "./check-column-scope-monotonicity.mjs"`（脚本还不存在）

- [ ] **Step 3: 实现门禁**

新建 `scripts/check-column-scope-monotonicity.mjs`，**照 `scripts/check-data-contract.mjs` 的形状写**（同款 `Violation`、同款 `SCRIPT_NAME`、同款 `main()` 返回退出码 + 自调用守卫）：

```js
#!/usr/bin/env node
// check-column-scope-monotonicity.mjs — 血缘单调门（spec §4.3；正典 docs/architecture.md §4.2）。
//
// 用法：tsx scripts/check-column-scope-monotonicity.mjs [rootDir]   # 默认 = 仓根
// 契约：干净 → exit 0，stdout 一行 `check-column-scope-monotonicity: OK（…）`；
//       有违规 → exit 1，stderr 每条一行 `✗ <文件>\n      <说明>`。
//
// ── 判据（写死，别扩）──────────────────────────────────────────────────────────
//   源列 `sensitivity !== 'none'` 且被某指标 `reads` 申报 ⇒ 该指标必须有 `required_scope`。
//
// ── ⚠️ 这道门**查不到「漏申报」**，别让它看起来比实际强 ──────────────────────────
//   它只查「申报了的单调性」。完整性需要 contract → staging → marts 的**列级血缘**，
//   而仓内**不存在**（无 dbt manifest、无 parser；详见 spec §2.3 U1/U2）。
//   ⇒ 少写一条 `reads` 就绕过本门。**这是已知且被记录的弱点**，不是 bug。
//   ⇒ 别为此加「按名字在 expression 里模糊匹配」的启发式：那会造出假阳性，
//      让真违规淹没在噪声里（本仓规矩：判据要能变异确认）。
//
// ── 为什么读 YAML 而不是读库 ────────────────────────────────────────────────────
//   静态门禁（CI gates，无 DB）。`reads` 因此**不需要**物化进 data.metrics。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { SENSITIVITY_KINDS } from './check-data-contract.mjs'

export const SCRIPT_NAME = 'check-column-scope-monotonicity'

/** @typedef {{ file: string, message: string }} Violation */

/** 递归列出 <root>/contracts 下所有 .json（跳过 `_` 前缀的基础设施文件）。 */
function contractFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.json') || e.name.startsWith('_')) continue
      out.push(p)
    }
  }
  walk(join(root, 'contracts'))
  return out
}

/** 源列全名 → sensitivity（缺省 = 'none'）。全名 = `<domain>.<table>.<column>`。 */
function loadSensitivity(root) {
  /** @type {Map<string, string>} */
  const m = new Map()
  for (const f of contractFiles(root)) {
    let doc
    try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    for (const col of doc.columns ?? []) {
      m.set(`${doc.domain}.${doc.table}.${col.name}`, col.sensitivity ?? 'none')
    }
  }
  return m
}

/**
 * @param {string} rootDir
 * @returns {Violation[]}
 */
export function checkColumnScopeMonotonicity(rootDir) {
  /** @type {Violation[]} */
  const violations = []
  const sens = loadSensitivity(rootDir)

  const ymlRel = 'dbt/semantics/l1_metrics.yml'
  let doc
  try {
    doc = parseYaml(readFileSync(join(rootDir, ymlRel), 'utf8'))
  } catch (e) {
    violations.push({ file: ymlRel, message: `YAML 解析失败：${/** @type {Error} */ (e).message}` })
    return violations
  }

  for (const m of doc?.metrics ?? []) {
    const name = String(m?.name ?? '<无名>')
    const reads = Array.isArray(m?.reads) ? m.reads.map(String) : []
    // ⚠️ `required_scope` 的**码是否存在**于 manifest，归 check-data-models 管，这里**不重复**。
    for (const colId of reads) {
      if (!sens.has(colId)) {
        violations.push({
          file: ymlRel,
          message: `指标 \`${name}\` 的 reads 里写了 \`${colId}\`，但契约里没有这一列 ——`
            + ' 打错的名字会让本门**以为**没读它（静默放行）。请核对 `contracts/**` 的'
            + ' `domain`/`table`/`columns[].name`。',
        })
        continue
      }
      const s = sens.get(colId)
      if (s === 'none') continue
      if (m.required_scope === undefined || m.required_scope === null) {
        violations.push({
          file: ymlRel,
          message: `指标 \`${name}\` 读了敏感源列 \`${colId}\`（sensitivity=${s}）`
            + ' 却没有声明 `required_scope` —— 违反血缘单调：藏了这一列，但读它的指标照旧算得出'
            + '（spec §3.2 不变量 3）。给它补一个 `required_scope`，或确认 `reads` 写错了。',
        })
      }
    }
  }
  return violations
}

export function main(argv) {
  const root = argv[2] ?? process.cwd()
  const violations = checkColumnScopeMonotonicity(root)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: 发现 ${violations.length} 条违规`)
    for (const v of violations) console.error(`  ✗ ${v.file}\n      ${v.message}`)
    console.error('\n修法：给读了敏感源列的指标补 `required_scope`（码要真实存在于 manifest），'
      + '或修正 `reads`。口径见 docs/architecture.md §4.2 与 spec §4.3。')
    return 1
  }
  console.log(`${SCRIPT_NAME}: OK（血缘单调；闭集 ${SENSITIVITY_KINDS.join('/')}）`)
  return 0
}

const invoked = process.argv[1] ? relative(process.cwd(), process.argv[1]).split(sep).join('/') : ''
if (invoked.endsWith(`scripts/${SCRIPT_NAME}.mjs`)) {
  process.exit(main(process.argv))
}
```

> ⚠️ 上面 `for (const m of ...)` 里那条注释是**留给读的人**的：`required_scope` 的**码是否存在**
> 于 manifest 归 `check-data-models` 管，**别在这重复实现**（重复 = 两处事实源，必然漂移）。

- [ ] **Step 4: 跑测试确认它绿**

Run: `pnpm exec vitest run --dir scripts -t '血缘单调门'`
Expected: PASS（6 passed）

- [ ] **Step 5: 变异确认（本仓铁律：判据只有变异确认过才算数）**

把 `scripts/check-column-scope-monotonicity.mjs` 里那条 `if (s === 'none') continue` **删掉**，
重跑 Step 4 —— **必须恰好红一条**（「源列不敏感 ⇒ 不违规」）。确认后**改回来**。

再删掉 `if (!sens.has(colId))` 那一整块，重跑 —— 必须恰好红「reads 指了不存在的源列」那条。
确认后改回来。

> 判据：**删掉被保护的那一行，恰好有一条用例变红**。整组全红或全绿都说明用例没钉住那一行。

- [ ] **Step 6: 接进 CI `gates`**

`.github/workflows/ci.yml` 的 `gates` job 里，接在 `check-data-contract.mjs` 那条（L109）**之后**：

```yaml
      # 血缘单调门（spec §4.3；正典 docs/architecture.md §4.2）。判据：源列 sensitivity != none
      # 且被某指标 `reads` 申报 ⇒ 该指标必须有 required_scope。
      # ⚠️ **只查「申报的单调性」，查不到「漏申报」**——完整性要 contract→marts 的列级血缘，
      #    仓内不存在（无 dbt manifest）。少写一条 reads 就绕过本门，**这是已知弱点**。
      # 纯静态：只读 contracts/** 与 dbt/semantics/l1_metrics.yml，不连库、不取网络，秒级。
      - run: pnpm exec tsx scripts/check-column-scope-monotonicity.mjs
```

- [ ] **Step 7: 全量门禁 + 提交**

```bash
pnpm typecheck && pnpm run test:guard
git add scripts/check-column-scope-monotonicity.mjs scripts/check-column-scope-monotonicity.test.ts .github/workflows/ci.yml
git commit -m "feat(data): 血缘单调门——读了敏感源列的指标必须收窄"
```

---

### Task 4: 报表发布门（`requiredScope` 改为**派生**）

**Files:**
- Create: `modules/data/domain/report-scope.ts`（纯函数，无 IO）
- Create: `modules/data/domain/report-scope.test.ts`（纯函数单测，**不连库**）
- Modify: `modules/data/routes/reports.ts`（`PUT /reports/:id` 与 `PUT /reports/:id/spec` 两处接线）
- Modify: `modules/data/routes/reports.test.ts`（路由级用例，沿用该文件既有 setup）

**Interfaces:**
- Consumes: `ReportSpec.panels[].metricId`（`modules/data/domain/report-spec.ts`）、`loadMergedCatalog(pool, org)`（`modules/data/domain/query-service.ts`）、`ReportRow.spec` / `ReportRow.renderer`（`modules/data/domain/report-store.ts:16-41`）。
- Produces: `export function deriveRequiredScope(spec, catalog): DeriveResult`，其中
  `DeriveResult = { ok: true; requiredScope: string | null } | { ok: false; reason: 'UNKNOWN_PANEL_METRIC'; metricId: string } | { ok: false; reason: 'CONFLICTING_PANEL_SCOPES'; scopes: string[] }`。
  `catalog` 只要求 `readonly { id: string; requiredScope: string | null }[]`（**故意收窄**：纯函数不需要完整的 `MetricDef`，测试就不用造假 metric）。

**规则（spec §4.2，写死）**：

| 面板指标里**非 null** 的 `requiredScope` 集合 | 结果 |
|---|---|
| 空集 | `null` |
| 单元素 `{C}` | `C` |
| 多元素 | **拒绝**（400，点名指标与码） |

⚠️ **`renderer === 'metabase'` 不派生**（`spec` 为 null，没有面板可推）⇒ 该分支仍用调用方给的值。

- [ ] **Step 1: 写失败测试**

新建 `modules/data/domain/report-scope.test.ts`。**纯函数、不连库**，所以不需要 `DATABASE_URL`，
`describePg` 那套跳过逻辑也用不上：

```ts
// report-scope.test.ts — 报表 requiredScope 派生的单测。纯函数，不连库。
import { describe, expect, it } from 'vitest'
import { deriveRequiredScope } from './report-scope'
import type { ReportSpec } from './report-spec'

/** 只造派生动得到的那两个字段——纯函数的入参故意收窄，别把整个 MetricDef 搬进来。 */
const cat = (...rows: Array<[string, string | null]>) =>
  rows.map(([id, requiredScope]) => ({ id, requiredScope }))

/** 面板只需要 `metricId`；其余字段填最小合法值（`ReportSpec` 的 schema 与派生无关）。 */
const spec = (...metricIds: string[]): ReportSpec =>
  ({ panels: metricIds.map((metricId) => ({ metricId, title: metricId, chart: 'table', dims: [], args: {} })) }) as ReportSpec

describe('deriveRequiredScope（spec §4.2）', () => {
  it('空面板 ⇒ null', () => {
    expect(deriveRequiredScope(spec(), cat())).toEqual({ ok: true, requiredScope: null })
  })

  it('面板指标都无 requiredScope ⇒ null', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', null], ['b', null])))
      .toEqual({ ok: true, requiredScope: null })
  })

  it('面板指标同一个码 ⇒ 该码', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', 'data:cost'], ['b', 'data:cost'])))
      .toEqual({ ok: true, requiredScope: 'data:cost' })
  })

  it('无码与有码混用 ⇒ 取那个码（无码的不放松限制）', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', null], ['b', 'data:cost'])))
      .toEqual({ ok: true, requiredScope: 'data:cost' })
  })

  it('两个不同码 ⇒ 拒绝并点名（单值列表达不了「都要有」）', () => {
    const r = deriveRequiredScope(spec('a', 'b'), cat(['a', 'data:cost'], ['b', 'data:margin']))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('CONFLICTING_PANEL_SCOPES')
    expect(r.scopes.sort()).toEqual(['data:cost', 'data:margin'])
  })

  it('面板指向不存在的指标 ⇒ 拒绝并点名 metricId', () => {
    const r = deriveRequiredScope(spec('ghost'), cat(['a', null]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('UNKNOWN_PANEL_METRIC')
    expect(r.metricId).toBe('ghost')
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `pnpm --filter data test -- -t 'deriveRequiredScope'`
Expected: FAIL —— `Failed to resolve import "./report-scope"`（模块还不存在）

- [ ] **Step 3: 实现派生纯函数**

新建 `modules/data/domain/report-scope.ts`：

```ts
// report-scope.ts — 报表 `requiredScope` 的派生（spec §4.2）。
//
// 纯函数、无 IO：入参故意收窄到「派生动得到的两个字段」，这样单测不用造完整的 MetricDef，
// 也让「这个函数不碰库」变成类型上的事实而不是约定。
import type { ReportSpec } from './report-spec'

export type DeriveResult =
  | { ok: true; requiredScope: string | null }
  | { ok: false; reason: 'UNKNOWN_PANEL_METRIC'; metricId: string }
  | { ok: false; reason: 'CONFLICTING_PANEL_SCOPES'; scopes: string[] }

/**
 * 从面板指标派生报表的 `requiredScope`——它是「**报表可见 ⇒ 每个面板的指标都可见**」
 * 这条不变量的**唯一**实现（spec §4.2）。
 *
 * ⚠️ 为什么不是「取 max(面板 scope)」：**`max` 无定义**——scope 是不透明字符串，这套模型里
 *    **没有 scope 层级**（`hasScope` 就是集合成员判断），故 `hasScope(A) ⇒ hasScope(B)`
 *    当且仅当 `A === B`。⇒ 只能按**集合**判：多元素时单值列**表达不了**「这些码都要有」，
 *    唯一诚实的动作是**拒绝发布并点名**。
 *
 * ⚠️ 为什么多元素是拒绝而不是挑一个：挑任一个都会放行「只有 C1 没有 C2」的人，而他的 C2 面板
 *    `/query` 会 403 ⇒ **报表看起来正常、点进去炸**。宁可发布时响亮地失败。
 *
 * ⚠️ `renderer === 'metabase'` 的报表**不走这里**（`spec` 为 null，没有面板可推）——
 *    那条分支的 `requiredScope` 仍由调用方给。调用点负责这个分支，本函数不做判断。
 */
export function deriveRequiredScope(
  spec: ReportSpec,
  catalog: readonly { id: string; requiredScope: string | null }[],
): DeriveResult {
  const scopes = new Set<string>()
  for (const panel of spec.panels) {
    const metric = catalog.find((m) => m.id === panel.metricId)
    if (metric === undefined) {
      return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: panel.metricId }
    }
    if (metric.requiredScope !== null) scopes.add(metric.requiredScope)
  }
  if (scopes.size > 1) return { ok: false, reason: 'CONFLICTING_PANEL_SCOPES', scopes: [...scopes] }
  return { ok: true, requiredScope: scopes.size === 0 ? null : [...scopes][0] }
}
```

- [ ] **Step 3b: 跑测试确认它绿**

Run: `pnpm --filter data test -- -t 'deriveRequiredScope'`
Expected: PASS（6 passed）

- [ ] **Step 4: 接进两个写入点**

`modules/data/routes/reports.ts` 顶部加 import：

```ts
import { deriveRequiredScope } from '../domain/report-scope'
// ⚠️ `loadMergedCatalog` 的**家在 `domain/metric-store.ts:162`**，不在 query-service（后者只是它的
//    调用方之一）。写计划时我第一版写成了 `'../domain/query-service'`——**那是错的**，已订正。
import { loadMergedCatalog } from '../domain/metric-store'
```

**① `PUT /reports/:id`**（L271-296）里，在 `withObjectLock` **之前**算出派生值：

```ts
    // 派生 requiredScope（spec §4.2）：renderer='platform' 从面板推；metabase 无面板可推 ⇒ 用调用方给的值。
    const catalog = await loadMergedCatalog(ctx.pool, org)
    const current = await getReport(ctx.pool, org, id)   // report-store.ts:77
    if (current === null) return c.json({ error: 'NOT_FOUND' }, 404)
    let effectiveScope = parsed.data.requiredScope
    if (current.renderer === 'platform') {
      if (current.spec === null) return c.json({ error: 'NO_SPEC' }, 400)
      const d = deriveRequiredScope(current.spec, catalog)
      if (!d.ok) {
        return c.json(
          d.reason === 'UNKNOWN_PANEL_METRIC'
            ? { error: d.reason, metricId: d.metricId }
            : { error: d.reason, scopes: d.scopes },
          400,
        )
      }
      effectiveScope = d.requiredScope
    }
```

然后把 `updateRequiredScope(ctx.pool, org, id, parsed.data.requiredScope, parsed.data.expectedVersion)`
改成传 `effectiveScope`。

**② `PUT /reports/:id/spec`** 里，**写 spec 之后**同样跑一遍派生并写回 `required_scope`
（否则「先发空报表再补面板」会绕过门：报表仍是 `null` 而面板有码 ⇒ 低权限者点进去炸）。

- [ ] **Step 5: 加路由级用例（沿用该文件既有 setup）**

在 `modules/data/routes/reports.test.ts` 里，**先读它 L300-330 的 setup 段**（`shell()` / `manage()` /
`post()` / `versionOf()` 都在那儿），照同一手法加：

```ts
describe('发布门：requiredScope 从面板派生（spec §4.2）', () => {
  it('面板指标两个不同码 ⇒ 发布被拒并点名两个码', async () => {
    // ① 用 upsertL1Metric 种两条指标（见 catalog-consumers.test.ts:47 的夹具形状），
    //    requiredScope 分别是 'data:cost' 与 'data:margin'；
    // ② 造一份 platform 报表（POST /reports → PUT /reports/:id/spec，面板指向这两条）；
    // ③ PUT /reports/:id 发布（requiredScope: null + expectedVersion）。
    // 断言：status === 400；body.error === 'CONFLICTING_PANEL_SCOPES'；body.scopes 含两个码。
  })

  it('面板指标同一个码 ⇒ 发布成功且回包 requiredScope 等于该码', async () => {
    // 断言：status === 200；body.requiredScope === 'data:cost'（**不是**调用方传的 null）。
  })

  it('renderer=metabase ⇒ 不派生，仍用调用方给的值', async () => {
    // 造一份 metabase 报表，PUT requiredScope='data:manage'；断言 body.requiredScope === 'data:manage'。
  })
})
```

> ⚠️ **别只写「200 就算过」**：断言要认**具体字段**（`error` 名、`scopes` 内容、`requiredScope` 的值）。
> 「200 即通过」在本仓被反复证明拦不住错东西（见 `catalog-consumers.test.ts:47` 那句
> 「认这个串，而不是认『200』」）。

- [ ] **Step 6: 跑测试 + 变异确认**

Run: `pnpm --filter data test -- -t '发布门'`
Expected: PASS

**变异确认**（本仓铁律）：把 `report-scope.ts` 里 `if (scopes.size > 1) return ...` 那行**删掉**，
重跑 —— **必须恰好红两条**（纯函数的「两个不同码 ⇒ 拒绝」+ 路由级的「冲突被拒」）。确认后改回来。

- [ ] **Step 7: 全量门禁 + 提交**

```bash
pnpm --filter data test && pnpm typecheck
git add modules/data/domain/report-scope.ts modules/data/domain/report-scope.test.ts modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "feat(data): 报表 requiredScope 改为从面板派生，冲突时拒绝发布"
```

---

### Task 5: 首个真实配对（存量收紧的第一批）

**Files:**
- Modify: `contracts/common/*.json`（打 `sensitivity`）
- Modify: `dbt/semantics/l1_metrics.yml`（补 `reads` + `required_scope`）
- Regenerate: `deploy/data-plane.lock`

**为什么单列一个任务**：`sensitivity` 打标与指标收窄**必须成对**——只打标不收窄，T3 的门**立刻红**；
只收窄不打标，门**永远绿**（空转）。这一对是本设计的**首个真实案例**，也是「无案例不立标准」的落点。

- [ ] **Step 1: 找出一个真实的「敏感源列 ← 被某 L1 指标读」配对**

```bash
# ① 找 L1 指标读的 marts 关系
grep -n 'expression:' dbt/semantics/l1_metrics.yml | head -40
# ② 挑一个看起来会读成本的（如含 cost / gross 的关系），找出它对应的 marts 模型
ls dbt/models/common/marts/
# ③ 看该模型引用了哪些 staging 列
grep -rn 'cost' dbt/models/common/marts/ dbt/models/common/staging/ | head -20
# ④ 把 staging 列反查回契约列全名（<domain>.<table>.<col>）
grep -rn '"name": "item_cost_price"' contracts/
```

**产出**：一条明确的四元组 —— `源列全名` / `sensitivity` / `读它的指标 name` / 该指标该用哪个码。

> ⚠️ **找不到也不许编**。若今天**没有任何 L1 指标读** `sensitivity` 候选列，那本任务的正确产出是
> **把这个事实记进 spec §2.3**，门禁保持空转，等首个真实案例——**不要为了「有产出」而给不相干的列
> 打标**（那会造出一条没有真实需求的限制，且立刻让无关指标变不可见）。

- [ ] **Step 2: 打标（契约侧）**

给 Step 1 认定的源列加 `sensitivity`：

```json
      { "name": "item_cost_price", "type": "decimal", "precision": 14, "scale": 2, "nullable": true, "sensitivity": "cost", "description": "…" }
```

- [ ] **Step 3: 先跑门，确认它**红**（这一步是本任务的价值所在）**

Run: `pnpm exec tsx scripts/check-column-scope-monotonicity.mjs`
Expected: **exit 1**，且消息**恰好点名** Step 1 认定的那个指标与源列。
⚠️ 若它绿了 —— 说明 `reads` 还没写，或写错了列名。**这正是这道门「查不到漏申报」的活样本**，
把它记进任务报告。

- [ ] **Step 4: 配对收窄（声明侧）**

给该指标补两条：

```yaml
    reads: ['lemeng.item.item_cost_price']
    required_scope: data:cost
```

- [ ] **Step 5: 再跑门，确认它绿**

Run: `pnpm exec tsx scripts/check-column-scope-monotonicity.mjs`
Expected: exit 0

- [ ] **Step 6: 重生成 lock + 全量门禁**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm typecheck && pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/check-column-scope-monotonicity.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs && pnpm exec tsx scripts/check-data-models.mjs
```
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add contracts/ dbt/semantics/l1_metrics.yml deploy/data-plane.lock
git commit -m "feat(data): 首批列级收紧——成本源列打标并与读它的指标配对"
```

> ⚠️ **上线顺序**（spec §8.1，本任务**不动生产**，只是登记）：真正让这个指标对无码者不可见，
> 要等「① 码进 manifest → ② 租户管理员发码 → ③ 打标 → ④ 灰度开闸」四步走完。
> 本任务做完的是 ③ 的**声明部分**；`data.metrics.required_scope` 的落库由部署期的 sync 完成。

---

## 计划完成后的下一步

P1 落地后写 **P2（值级）** 的计划。P2 的细节**必须**等 P1 落地后再定（YAGNI，与 askdata 回路的
「P2 的 spec 必须在 P1 之后写」同款理由）：占位符语法是否与既有 `${}` 冲突、`mask_spec` 的存储形状、
`masking` 回包字段的位置——都要拿 P1 落地的真实形状说话。
