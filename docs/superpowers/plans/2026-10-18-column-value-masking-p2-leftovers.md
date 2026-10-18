# 值级脱敏（P2）遗留项实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 P2 掩码设施的五个硬遗留（#820 / #821 / #822 / #823 / #830），把「掩码解析单位按列」「默认档」「豁免码可查」「审计三态」「运行期与门禁共用一份 token 化」落成**可门禁、不可绕**的机制。

**Architecture:** 沿用 P2 既有架构（唯一执法点 `authorize()` + `mask.ts` 纯函数）。本轮的架构变化只有一条：**掩码解析单位从「指标行」改为「列」**（spec §5.3.1 R10 裁决）——`selectSql` 里出现的列，其掩码取自**全量 catalog** 里所有声明过该列的 metric 行，而非只读本行的 `masks`。因为 L2 编译**逐字保留** L1 的列引用（实测，见 spec §5.3.1），L2 自动被覆盖，#820 结构上消失。

**Tech Stack:** Node ESM + TypeScript、vitest、dbt YAML（`yaml@2`）、Postgres + pg_duckdb。

## Global Constraints

设计正典 = `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md`（下称 **spec**）§5。架构正典 = `docs/architecture.md` §2.2 / §4.2。每个任务的要求**隐含包含本节**。

1. **执法点唯一**：掩码只发生在 `authorize()` 组装的 SQL 里。前端、词表、报表渲染一律不承担安全职责。
2. **掩码先于聚合**：靠「替换列引用」在构造上保证。不许改成对结果值做加工——那是聚合后掩码，可被差分攻击逼近精确值。
3. **按列解析**（spec §5.3.1 R10）：`掩码集 = ⋃{ 声明 d : d.column 逐字出现在本次 metric.selectSql 里 }`，d 取自**全量 catalog**（含被 `required_scope` 裁掉的行）。**行为只增不减**（并集 ⊇ 原集合）⇒ 拿「我看不见的行」上的掩码来掩自己，是 fail-closed 的正确方向。
4. **同一列只许一处声明**（新门禁，spec §4.3.1 ③）：否则按列解析有歧义。
5. **整值声明（`column` 为 null 或缺席）手写一律拒**：该形态**只由默认档合成**（`applyDefaultMaskTier` 不经过 `maskItemError`）。理由：整值声明是**指标级**的、**不跨指标按列传播**，手写它 = 重开 #820 同型洞。
6. **默认档留在指标级**：`reads` 是**湖契约列全名**（`lemeng.retail_order_line.sale_money`），`selectSql` 引用的是 **mart 列**（`fct_retail_sale.net_amount`）——**不同命名空间、无机械映射**，且仓规**明文禁止**「按名字在 expression 里模糊匹配」的启发式（`scripts/check-column-scope-monotonicity.mjs:17-18`）⇒ 默认档**不能**物化成列键声明，只能整值。
7. **闭集是代码常量**：`mask.kind` 只能选不能扩；加 kind = 改常量 + 加展开分支 + 测试，走 PR。
8. **`selectSql` 不可被改写存库**：`parseL1Select`（`semantic-compiler.ts:193`）会把它抽出来喂 L2 编译（`L1_SELECT_RE`，`:178`）。掩码/占位符**绝不能进**库里那份 `selectSql`。
9. **夹具一律内联在测试里，不碰 `dbt/**`**（避免 data-plane lock 重跑）。若确实改了 `dbt/**` ⇒ **必须**重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。
10. **提交纪律**：`<type>(<scope>): <一句话>`；⚠️ **PR 正文里不要逐字写** "Closes" 加伞 issue 编号 **764**（正则会把它当真关联）；写「伞 issue 编号 764」。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md` | 设计正典：订正假断言 + 新增 R12 + 三态表补混合形 | T1 |
| `docs/architecture.md` | 架构正典（**本计划前已改**，本计划不重复改） | — |
| `modules/data/manifest.yaml` | 加 `data:precise` 码 | T2 |
| `modules/data/domain/mask.ts` | 共享 token 化（`topLevelValueHead` / `sqlMentionsColumn`）；`effectiveMasks`；`exempted` | T3 / T6 / T7 |
| `modules/data/domain/authz.ts` | `DEFAULT_TIER_SCOPE`；`authorize` 第 5 参；`plan.exempted` | T3 / T6 / T7 |
| `scripts/sync-data-semantics.mjs` | `masksOf`/`maskItemError` 改调共享 token 化；`reads` 上载；默认档合成 | T3 / T5 |
| `dbt/semantics/l1_metrics.yml` | `mask` 字段参考头：`column: null` 陈旧指引改成指向默认档（Task 3 评审 Important 补入；**动它必重跑 data-plane lock**） | T3 |
| `scripts/check-column-scope-monotonicity.mjs` | 门禁四项检查 + 读 `manifest.yaml` | T4 |
| `scripts/check-data-models.mjs` | 订正 `:1005` 陈旧注释 | T4 |
| `modules/data/domain/query-service.ts` | 传全量 catalog；审计/回包同源派生 | T6 / T7 |
| `modules/data/domain/audit-store.ts` | `MaskingAudit` 三态 + `maskingAuditOf` 纯函数 | T7 |
| `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` | 整值 nullify 的指令面文案 | T5 |

**Wave 分组**（波内不得改同一文件）：

| Wave | 任务 | 说明 |
|---|---|---|
| **1** | T1、T2 | spec 文档 vs manifest，文件面不相交 |
| **2** | T3 | 共享 token 化 + `DEFAULT_TIER_SCOPE`（W3 的两个消费者都依赖它） |
| **3** | T4、T5 | 门禁脚本 vs sync + SKILL，文件面不相交 |
| **4** | T6 | 运行期按列解析（依赖 T3 的 `sqlMentionsColumn`） |
| **5** | T7 | 审计三态（与 T6 同改 `mask.ts`/`authz.ts`/`query-service.ts` ⇒ 串行） |

**PR 切法**（按 Phase 切，不按 Wave）：

- **PR ①（Phase 0）** = T1 + T2 + T3 + T4 + T5 → 关 #822（T2 + T4①）、#821（T5 + T4②）、#830（T3），并销掉 `check-data-models.mjs:1005` 的陈旧承诺（T4④）。
- **PR ②（Phase 1）** = T6 → 关 #820。
- **PR ③（Phase 2）** = T7 → 关 #823。

---

### Task 1: spec 订正（文档先行，**先于任何代码**）

**为什么单独一任务**：本轮全部代码都按 spec 实现；spec 里有两处**实测证伪**的断言（默认档「天然覆盖 L2」）与一处**语义未覆盖**（审计三态表缺混合形）。**先签语义再改码**——不订正就写码，等于把假断言固化成实现。

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md`

- [ ] **Step 1: 订正 §5.2 ② 的触发条件（`:393` 一带）**

把 ② 的触发条件从「本指标的 `selectSql` 读了带 sensitivity 的列」改成**机械可判**的形态：

```markdown
② 默认档（按指标兜底）
   → 本指标**一条列键声明都没命中**，且**本指标的 `reads` 申报里含 `sensitivity !== 'none'` 的源列**。
```

理由写进正文：`reads` 是**湖契约列全名**、`selectSql` 是 **mart 列引用**，两者**不同命名空间、无机械映射**；「`selectSql` 读了带 sensitivity 的列」在仓内**不可判**（那需要 contract → staging → marts 的列级血缘，仓内不存在，见 §2.3 U1/U2）。

- [ ] **Step 2: 删掉 §5.2 的假断言（`:402` 一带）**

原句（逐字）：

```markdown
> 但它**天然覆盖 L2**：触发条件是「本指标的 `selectSql` 读了带 sensitivity 的列」，而 L2 保留了列引用。
```

**删掉**，替换为指向 R12 的订正说明（默认档是**整值 / 指标级**的 ⇒ **不按列传播** ⇒ **L2 不继承**；真正的兜底是 `L2_BASE_MASKED` 写侧守卫）。

- [ ] **Step 3: 订正 §5.3.1 配套 3（`:547` 一带）**

把「3. ✅ **默认档不漏 L2**（不需要额外机制）」从 ✅ 改成 🔴 **FALSE**，并交叉引用 R12。**保留原文作订正对照**（本仓口径：订正旧文另附说明，不静默改写）。

- [ ] **Step 4: §7 追加 R12（`:641-653` 一带的 R 表）**

新行内容：

```markdown
| **R12** | 🔴 **默认档不覆盖 L2**（实测订正 §5.2 ② 与 §5.3.1 配套 3） | 默认档是**整值 / 指标级**的 ⇒ 不按列传播 ⇒ L2 不继承。两条实测依据：① `reads` 是湖契约列全名、`selectSql` 是 mart 列引用，**无机械映射**且仓规禁止模糊匹配（`check-column-scope-monotonicity.mjs:17-18`）；② 默认档**只在 sync 处理 L1 YAML 时物化**，L2 行由 API 写入、**根本不过 sync**。⇒ 真正的兜底是 `L2_BASE_MASKED` 写侧守卫。⚠️ 该守卫**只拦新建**，拦不住**打 `sensitivity` 之前就已存在**的 L2 ⇒ §8.1 的 ③（打 `sensitivity`）之前**必须先盘点存量 L2**。 |
```

- [ ] **Step 5: §8.1 ③ 补前置条件（`:668-686`）**

在「③ 给契约列打 `sensitivity`」那一步前加一条前置：

```markdown
> **③ 的前置**：先盘点存量 L2（`select count(*) from data.metrics where source = 'l2'`），
> 逐个确认其 base 是否会被默认档覆盖——**不会**（R12）。这些 L2 在打标之前就已存在，
> `L2_BASE_MASKED` 守卫拦不住它们。
```

- [ ] **Step 6: §4.4.1 三态表补「混合形」**

现有三态（`NULL` / `{"net_sales": "round:1000"}` / `{"__exempted__": ["net_sales"]}`）是**发生的三种形态**；补一句说明**它们的并**也存在：一个指标带两个掩码列、`grantedBy` 不同 ⇒ 一列被掩、另一列被豁免 ⇒ 审计 JSON 同时带两个键 `{列:记号, "__exempted__":[列]}`。并加一句：

```markdown
> ⚠️ **响应面 `masking` 字段（契约 `Record<string,string>`）不能复用审计值**——它装不下 `__exempted__`。
> 两者必须由 `query-service.ts` 从同一份 `authz.plan` 在一处派生（防「各写一遍 ⇒ 不同尺」）。
```

- [ ] **Step 7: §5.3.1 配套 2 的括注点名 `maskItemError`**

把「（`masksOf` 拒 `column: null`）」改成点名**唯一实现** `maskItemError`（`scripts/sync-data-semantics.mjs`）——这样 `masksOf`（物化侧）与 `check-data-models.mjs` 规则 ⑤-d（静态门禁）**都在更早的失败点**拒掉它。

- [ ] **Step 8: §5.2 的 `mask` 元素解析规则补一条**

现有「`column` 缺省 ≡ `column: null`」**保留**（它描述**库内 jsonb 的读取口径**），但补一句：

```markdown
> ⚠️ **手写**声明里 `column` 缺席或为 `null` ⇒ **拒**（`maskItemError`）。整值形态**只由默认档合成**
> （`applyDefaultMaskTier` 不经 `maskItemError`）。读取侧仍按「缺席 ≡ null」解释**库内既有行**。
```

- [ ] **Step 9: 提交**

```bash
git add docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md docs/architecture.md
git commit -m "docs(data): P2 遗留 spec 订正——默认档不覆盖 L2（R12）+ 审计混合形 + 手写整值一律拒"
```

> ⚠️ `docs/architecture.md` 的两处改动**本计划之前已落盘未提交**，随本任务一起提交（它们与 spec 是同一批裁决）。

---

### Task 2: `manifest.yaml` 加 `data:precise`（#822）

**为什么必须先行**：`data:precise` 是**默认档的豁免码**（spec §4.1.1 裁决 A）。装载器按各租户 org 逐个 upsert ⇒ **声明了才发得出去**（admin 端点校验码 ∈ 本清单，否则 404 `NO_SUCH_CODE`）。**打第一个 `sensitivity` 之前必须先有它**（T4 的门禁会拦）。

**Files:**
- Modify: `modules/data/manifest.yaml`（`permissions` 段）

**Interfaces:**
- Produces: 权限码 `data:precise`（名称「精确值查看」）。T3 的 `DEFAULT_TIER_SCOPE` 常量值必须**逐字**等于它；T4 的 ② 检查读它。

- [ ] **Step 1: 在 `permissions` 段追加（`:13` 之后）**

```yaml
  # 值级脱敏的**默认档豁免码**（spec 2026-10-17 §4.1.1，裁决 A：专用码而非复用 data:cost）。
  # 语义：持有它 ⇒ 看原值；否则默认档（整值 nullify）生效。与 data:cost 分开是刻意的——
  # 列级可见（看得到成本指标）与值级精确（看得到精确值）是**两条独立的授权**，
  # 合成一个码会让「给了成本可见就顺带给了精确值」。
  # ⚠️ **打第一个 `sensitivity` 之前必须先声明它**：check-column-scope-monotonicity 会拦
  #    （否则默认档的豁免码在清单里不存在 ⇒ 谁都豁免不了 ⇒ 全租户静默拿 NULL）。
  # ⚠️ **这不是终态**：将来若按敏感级别细分（cost / pii / …各一码），本码拆成一组；
  #    别把「一码走天下」当成设计意图。
  - { code: data:precise, name: 精确值查看 }
```

> ⚠️ 上面最后一条注释是 spec §4.1.1 的**明文要求**（「**但 `manifest.yaml` 那行注释要留一句**，免得后来者把「一码走天下」当成终态」），**不许省**。

- [ ] **Step 2: 验门禁仍绿**

```bash
pnpm exec tsx scripts/check-manifests.mjs
```

Expected: `check-manifests: OK`（`permissions` 是既有字段，加行不改形状）。

- [ ] **Step 3: 提交**

```bash
git add modules/data/manifest.yaml
git commit -m "feat(data): manifest 声明 data:precise（默认档豁免码，堵 #822）"
```

---

### Task 3: 共享 token 化 + `DEFAULT_TIER_SCOPE`（#830）

**为什么**：运行期（`mask.ts`）与声明侧（`sync-data-semantics.mjs` 的 `masksOf`）今天**各写一份**「这一列在不在 selectSql 里」的判定——运行期用带别名跳过的正则、声明侧用 `as __alias__` 文本哨兵。**两份实现在同一件事上可以不同尺**（PR #827 评审 M1 实测出两个反例：哨兵名撞车 `column: '__alias__'`、大小写不匹配 `(select 1 AS VALUE) + sum(t.y)`）。本任务把判定收成**一份**。

**Files:**
- Modify: `modules/data/domain/mask.ts`
- Modify: `modules/data/domain/mask.test.ts`
- Modify: `modules/data/domain/authz.ts`（加 `DEFAULT_TIER_SCOPE`）
- Modify: `scripts/sync-data-semantics.mjs`（`masksOf` / `maskItemError`）
- Modify: `scripts/sync-data-semantics.test.ts`
- Modify: `dbt/semantics/l1_metrics.yml`（`mask` 字段参考头清陈旧指引；**必重跑 data-plane lock**）— Task 3 评审 Important 发现补入
- Modify: `scripts/check-data-models.{mjs,test.ts}` + `modules/data/module.test.ts`（实现中发现的必要连带，见任务日志）

**Interfaces:**
- Produces（`mask.ts`）：
  - `export function topLevelValueHead(sql: string): { exprStart: number; aliasStart: number; aliasEnd: number } | null`
  - `export function sqlMentionsColumn(selectSql: string, column: string): boolean`
  - `maskedSelectSql` 签名**不变**（T7 才加 `exempted`）
- Produces（`authz.ts`）：`export const DEFAULT_TIER_SCOPE = 'data:precise'`
- Consumes：T2 的 `data:precise`（值必须逐字一致）

- [ ] **Step 1: 写失败测试（`mask.test.ts` 追加）**

```ts
import { sqlMentionsColumn, topLevelValueHead } from './mask'

describe('sqlMentionsColumn（唯一 token 化，#830）', () => {
  it('列在 selectSql 里 ⇒ true；不在 ⇒ false', () => {
    expect(sqlMentionsColumn('select sum(fct_x.net_amount) as value from fct_x', 'fct_x.net_amount')).toBe(true)
    expect(sqlMentionsColumn('select sum(fct_x.other) as value from fct_x', 'fct_x.net_amount')).toBe(false)
  })

  it('★ 别名位 value 不是列引用 ⇒ 只声明 value 的列判为「不在」（PR #827 评审 M1②）', () => {
    expect(sqlMentionsColumn('select sum(f.x) as value from f', 'value')).toBe(false)
  })

  it('★ 不再依赖 `as __alias__` 文本哨兵 ⇒ 列名恰好叫 __alias__ 也判得准（M1①）', () => {
    const sql = 'select sum(f.__alias__) as value from f'
    expect(sqlMentionsColumn(sql, '__alias__')).toBe(true)
  })

  it('★ 大小写：`(select 1 AS VALUE) + sum(t.y) as value` 里的 value 是内层别名，不是列（M1②）', () => {
    const sql = 'select (select 1 AS VALUE) + sum(t.y) as value from t'
    expect(sqlMentionsColumn(sql, 'VALUE')).toBe(false)
  })

  it('子串不误伤：cost 不命中 cost_money', () => {
    expect(sqlMentionsColumn('select sum(a.cost_money) as value from a', 'a.cost')).toBe(false)
  })
})

describe('topLevelValueHead（深度/引号感知的 `… as value` 头）', () => {
  it('顶层 `as value` ⇒ 三段偏移', () => {
    const h = topLevelValueHead('select sum(f.x) as value, bizday from f')
    expect(h).not.toBeNull()
    expect('select sum(f.x) as value, bizday from f'.slice(h!.aliasStart, h!.aliasEnd)).toBe('value')
  })

  it('★ 内层 `as value … from` 不算头（PR #827 评审 M6）', () => {
    const sql = 'select (select 1 as value from x) + sum(t.y) as value from t'
    const h = topLevelValueHead(sql)
    expect('select (select 1 as value from x) + sum(t.y) as value from t'.slice(h!.aliasStart, h!.aliasEnd)).toBe('value')
    expect(h!.exprStart).toBe('select '.length)   // 顶层表达式从 `(` 起，不是内层
  })

  it('单引号里的 `as value` 不算（字符串字面量）', () => {
    expect(topLevelValueHead("select 'as value' as x from f")).toBeNull()
  })

  it('别名不是 value ⇒ null', () => {
    expect(topLevelValueHead('select sum(f.x) as value_added, bizday from f')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm --filter data test -- mask.test
```

Expected: FAIL（`sqlMentionsColumn` / `topLevelValueHead` 未导出）。

- [ ] **Step 3: 实现 `topLevelValueHead`（深度 + 单引号感知）**

在 `mask.ts` 里替换 `WHOLE_VALUE_HEAD_RE`。**必须**：跳过单引号字面量；跟踪括号深度；只在**深度 0** 找 `as` + 其后 `value` 且**后接 `,` 或 `from`**；返回 `exprStart`（表达式起点，`select` + 空白之后）、`aliasStart`、`aliasEnd`（`value` 之后）。

```ts
/**
 * 顶层 `… as value` 头的三段偏移。**深度与单引号感知**——PR #827 评审 M6 实测：
 * 非贪婪正则会在 `select (select 1 as value from x) + sum(t.y) as value from t` 上
 * 命中**内层**那个 `as value`（其后正好是 ` from`，lookahead 成立）⇒ 产出垃圾 SQL。
 * 形状与 `L1_SELECT_RE`（semantic-compiler.ts）同源：`select <表达式> as value[, 维度…] from …`。
 *
 * @returns null = 形状不合（无顶层 `… as value`）⇒ 调用方「不改、不记」。
 */
export function topLevelValueHead(sql: string): { exprStart: number; aliasStart: number; aliasEnd: number } | null
```

要点（写进实现注释）：① 只扫到第一个顶层 `from` 为止；② `as` 与 `value` 之间允许空白；③ `value` 之后必须紧跟 `,` 或 `from`（词边界）；④ 大小写不敏感。

**同一步里必须改 `maskedSelectSql` 的列分支**（否则下面 Step 1 的 M1② 用例红）：

`WHOLE_VALUE_HEAD_RE` 一撤，列分支里那句 `offset === aliasStart` 就失去了它的来历；而且它**本来就只跳顶层别名**——M1② 的内层 `AS VALUE` 照样被当列替换。改成**「匹配处前面就是 `as `」**（大小写不敏感），它在构造上同时覆盖顶层与内层：

```ts
/** 别名位判据：匹配处**紧跟在 `as ` 之后** ⇒ 那是别名，不是列引用（大小写不敏感）。 */
const ALIAS_BEFORE_RE = /\bas\s+$/i
```

```ts
    // 列分支（替换原先「先取 head.aliasStart、再 offset === aliasStart 跳过」那三行）
    const colRe = new RegExp(`\\b${escapeRe(spec.column)}\\b`, 'g')
    const next = sql.replace(colRe, (match, offset: number) =>
      ALIAS_BEFORE_RE.test(sql.slice(0, offset)) ? match : maskExpr(spec))
    if (next === sql) continue   // 列引用不在 selectSql 里（或只命中别名位）⇒ 不改、不记
    sql = next
    applied[spec.column] = notationOf(spec)
```

> ⚠️ **`aliasStart` 仍是 `topLevelValueHead` 的返回字段**（`value` 别名的起点，M6 用例靠它区分内层/顶层），但**列分支不再用它**——「前置 `as `」是它的严格超集。别把两者都留下当双保险：那样内层别名会被 `aliasStart` 那条放过（M1② 正是这个形状）。
> 列分支从此**不调 `topLevelValueHead`**；整值分支照旧调它（用 `exprStart` / `aliasEnd`）。

- [ ] **Step 4: 实现 `sqlMentionsColumn`（复用展开器本身）**

```ts
/**
 * 「这一列会不会被掩码展开命中」——**唯一 token 化**（#830）。
 *
 * 实现方式刻意是「**问展开器自己**」而不是另写一份正则：传 `hasScope = () => false`
 * （= 谁都没豁免）跑一次 `maskedSelectSql`，看 `applied` 里有没有这一列。
 * `applied` 只在**替换真的改动了 SQL** 时才记（`next !== sql`）⇒ 这个谓词与运行期
 * 的命中判定**构造上同一份**，不可能不同尺。别名位跳过、词边界、`$&` 回调等
 * 既有语义全部自动继承。
 */
export function sqlMentionsColumn(selectSql: string, column: string): boolean {
  const probe = maskedSelectSql(selectSql, [{ column, kind: 'nullify', grantedBy: 'probe' }], () => false)
  return Object.prototype.hasOwnProperty.call(probe.applied, column)
}
```

> ⚠️ **不要**给 `sqlMentionsColumn` 传整值 spec（`column: null`）——它的键是 `<value>`，语义不同。
>
> ⚠️ **反向依赖是禁止的**：`maskedSelectSql` 里**绝不能**调 `sqlMentionsColumn`。本谓词的定义就是「跑一遍 `maskedSelectSql`、看 `applied` 里有没有这一列」⇒ 展开器再回头调它 = **自递归爆栈**（T7 Step 1 的初稿正是这么写的，已被订正）。展开器判「在场」用它自己的 `next !== sql`——那是**同一个事实的另一种读法**，不是第二份实现（`applied` 本来就是按 `next !== sql` 记的）。

- [ ] **Step 5: `masksOf` 改调共享实现（`sync-data-semantics.mjs`）**

把 `:367-368` 的 `as __alias__` 文本哨兵整段换成：

```js
      if (!sqlMentionsColumn(selectSql, String(column))) {
        throw new Error(`指标 \`${metricName}\` 的 \`mask\` column \`${String(column)}\` 没有逐字出现在该指标的 selectSql 里 —— `
          + '运行期替换会命中不了 ⇒ **静默不生效**（本设计最怕的形态）。'
          + '判据与运行期同源：mask.ts 的 sqlMentionsColumn（#830）。')
      }
```

顶部加 `import { sqlMentionsColumn } from '../modules/data/domain/mask.ts'`（`.ts` 扩展名，与 `:60` 的 `MASK_KINDS` 同款既有先例）。

检查 `escapeRegExp`（`:244`）是否还有别的消费者：**没有**就删（它只剩这一处用途）。

- [ ] **Step 6: `maskItemError` 加「整值手写一律拒」（Global Constraint 5）**

在 `:295-299` 那条 `column === null && kind !== 'nullify'` 之前，加一条**更早**的拒绝（它把旧条覆盖掉）：

```js
  if (column === null) {
    return `指标 \`${metricName}\` 的 \`mask\` 声明了整值掩码（column 缺席或为 null）—— `
      + '**手写整值声明一律拒**（spec §5.3.1 R10 配套 2）：整值形态是**指标级**的、'
      + '**不跨指标按列传播**，手写它等于重开 #820 同型洞。'
      + '该形态**只由默认档合成**（sync 的 applyDefaultMaskTier，不经本函数）。'
      + '想按列掩码请写出具体 column；想整值隐藏请给源列打 sensitivity。'
  }
```

⚠️ 旧的 `column === null && kind !== 'nullify'` 分支**被本分支完全覆盖** ⇒ 删掉旧分支（别留两条永不可达的检查）。

⚠️ **`masksOf` 里没有独立的 `column === null` 分支**（先读一遍再动手，别照着想象改）：null 走的是
`if (column !== null) { … }` 这个守卫的**否定侧**，一路落到函数末尾那个 `out.push`。末尾那句是：

```js
    out.push(column === null || m.kind === 'nullify'
      ? { column, kind, grantedBy }
      : { column, kind, step, grantedBy })
```

本步之后 `column === null` 在 `masksOf` 里**不可达**（`maskItemError` 已先一步一律拒）⇒
**删掉 `column === null ||` 这个 disjunct**，只留 `m.kind === 'nullify' ? … : …`。
**行为不变**（nullify 剥 `step`、round 留 `step` 的语义原样保留），只是不再留一条永不可达的分支——
与本步删掉旧 `kind !== 'nullify'` 分支是同一条理由。

函数头注里那句「`column === null`（整值掩码）跳过这条——它本来就不按列命中」**改成事实**：
「新声明写不出整值形态（`maskItemError` 一律拒，spec §5.3.1 R10 配套 2）；整值形态只由物化层的
默认档合成（见 T5）」。**别留着那句旧话**——它会让后来者以为 YAML 里能写 `column: null`。

🔴 **同一个提交里必须清掉「叫用户去写 `column: null`」的陈旧指引**——本步一落地，那两处就从
「有用的兜底建议」变成「**照着做会报错**」的错误指引（比留一句过时注释严重：它会被真人读到）：

```sh
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && grep -n "整值" scripts/sync-data-semantics.mjs
```

逐处判：`:262`（`maskItemError` 头注「`column` 是 null（整值掩码）或非空字符串；**null 时 kind 只许
`nullify`**」）、`:293`（column 形态错误信息末尾「或 null（整值掩码：把 `… as value` 整个换成 typed
NULL）」）、`:360` 与 `:375`（列不在 selectSql 里的错误信息里那句「若要掩的是敏感**源列**而非口径列，
请声明 `column: null` 的整值掩码（kind 只许 nullify）」）。四处都改成**指向默认档**的说法：

> 想整值隐藏 ⇒ **给源列打 `sensitivity`**（物化层自动合成整值 nullify 默认档，见 T5）；
> YAML 里**写不出**整值形态（`maskItemError` 一律拒）。

⚠️ `:296-298`（旧 `kind !== 'nullify'` 分支的报错串）随旧分支一起删，别单独留。
**判据**：改完 `grep -n '整值' scripts/sync-data-semantics.mjs` 的输出里，**不该再有**任何一处
建议读者去写 `column: null`。

🔴 **清扫范围必须覆盖 `dbt/semantics/l1_metrics.yml` 的字段参考头**（Task 3 评审 Important 发现补入；
本步原判据只写了 `scripts/` 一个文件，**漏了最权威的那处**）：

```sh
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && grep -n "column: null" dbt/semantics/l1_metrics.yml
```

`:41-42` 是 `mask` 字段的**字段参考正文**（指标作者照着写 YAML 的地方，比脚本里的报错串更权威）：
「`column: null` = **整值掩码**（把 `… as value` 整个换成 typed NULL，fail-closed 默认档语义），
此时 kind 只许 nullify」。本步一落地这句就是**照着做会报错**的错误指引。同处 `:45` 的
「当前无指标声明」在本轮之后也不再是事实（默认档会合成声明），一并订正。

改成指向默认档的说法（与上面四处同口径）：

> 整值形态**只由默认档合成**（给源列打 `sensitivity`，物化层自动套整值 nullify，见 T5）；
> YAML 里**写不出**整值形态（`maskItemError` 一律拒）。

⚠️ 该文件在 `dbt/**` 内 ⇒ **同一提交里必须重跑 data-plane lock**（Global Constraint 9）：

```sh
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
```

（lock 连 `dbt/` 纯文档都计哈希 ⇒ 不重跑会让数据面清单校验红。）

- [ ] **Step 7: `authz.ts` 加 `DEFAULT_TIER_SCOPE`**

放在 `MASK_KINDS` 旁边（`:31-32` 一带，词表的家）：

```ts
/**
 * 默认档的豁免码（spec §4.1.1 裁决 A：专用码，不复用 `data:cost`）。
 *
 * ⚠️ 值必须**逐字**等于 `modules/data/manifest.yaml` 的 `permissions[].code`——
 * 声明了才发得出去（admin 端点校验码 ∈ 清单，否则 404 NO_SUCH_CODE）。
 * `scripts/check-column-scope-monotonicity.mjs` 有门禁（T4 ②）兜这条。
 * 写侧（sync 合成默认档）与门禁都从这里取，别各写一份字面量。
 */
export const DEFAULT_TIER_SCOPE = 'data:precise'
```

- [ ] **Step 8: 更新既有用例 + 变异确认**

- `sync-data-semantics.test.ts` 里断言「整值声明被接受」的用例改成断言**被拒**。
- **变异确认 A**：把 `sqlMentionsColumn` 改成恒 `true` ⇒ 恰好「列不在 selectSql 里」那条用例红。
- **变异确认 B**：删掉 `topLevelValueHead` 的深度跟踪（退回非贪婪正则）⇒ 恰好 M6 那条用例红。
- **变异确认 C**：删掉 `maskItemError` 的整值拒绝 ⇒ 恰好「手写整值被拒」那条用例红。

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm --filter data test -- mask.test && pnpm exec vitest run --dir scripts sync-data-semantics
```

> ⚠️ `sync-data-semantics.test.ts` 若在根 `scripts/` 下，按仓内既有跑法执行（`README.md §常用命令`）。

- [ ] **Step 9: 提交**

```bash
git add modules/data/domain/mask.ts modules/data/domain/mask.test.ts modules/data/domain/authz.ts scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts
git commit -m "refactor(data): 运行期与声明侧共用一份 token 化（堵 #830）+ 手写整值声明一律拒"
```

> **M2（grain 检查过宽）不在本任务**：它是 **fail-closed**（多掩一个维度列 ⇒ 报错拒绝，不是漏掩），记入本计划「已知边界」，不修。

---

### Task 4: 门禁四项检查（#822 ① + #821 ② + 新 ③ + 补陈旧承诺 ④）

**为什么**：spec §4.3.1 定案「同脚本、不另起」——`check-column-scope-monotonicity.mjs` 已有「读契约 + 读 `dbt/semantics/l1_metrics.yml`」的两份输入，四项新检查**全部**只需再加一份 `manifest.yaml`。

**Files:**
- Modify: `scripts/check-column-scope-monotonicity.mjs`
- Modify: `scripts/check-column-scope-monotonicity.test.ts`
- Modify: `scripts/check-data-models.mjs`（`:1005` 陈旧注释）

**Interfaces:**
- Consumes：T2 的 `data:precise`（② 检查它已在 manifest 里）；T3 的 `DEFAULT_TIER_SCOPE` 常量值
- Produces：`export function loadManifestCodes(rootDir): Set<string>`

- [ ] **Step 1: 先读门禁全文，确认插入点**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && sed -n '80,115p' scripts/check-column-scope-monotonicity.mjs
```

⚠️ **关键**：现有循环体第 86 行是

```js
    if (!Array.isArray(m?.reads)) continue // 未申报 ⇒ 本门无从判（见文件头「查不到漏申报」）
```

**今天 40 个指标一个都没申报 `reads`** ⇒ 这条 `continue` 会让**每一个**新检查静默跳过。**①③④ 必须放在这条 `continue` 之上**（② 读的是契约列、与指标行无关，放在循环外）。

- [ ] **Step 2: 加 `loadManifestCodes`**

```js
/** 本模块的权限清单（`permissions[].code`）——码的**唯一可发放来源**。 */
export const DATA_MANIFEST_REL = 'modules/data/manifest.yaml'

/**
 * manifest 里声明过的权限码集合。
 *
 * ⚠️ 仓内**没有**可复用的 manifest 权限读取器（`scripts/lib/` 只有 `data-contract.mjs`；
 * `check-manifests.mjs` 是 16 行 shim，走 `packages/platform-sdk` 的 `runChecks`，
 * 不导出 permissions）⇒ 本函数自带，别去找。
 *
 * @param {string} rootDir
 * @returns {Set<string>}
 */
export function loadManifestCodes(rootDir) {
  const doc = parseYaml(readFileSync(join(rootDir, DATA_MANIFEST_REL), 'utf8'))
  const perms = Array.isArray(doc?.permissions) ? doc.permissions : []
  return new Set(perms.map((p) => String(p?.code ?? '')).filter((c) => c !== ''))
}
```

读失败（文件不存在/坏 YAML）**抛**，由 `main` 的既有错误路径兜（不要静默返回空集——空集会让 ①②④ 全报违规，看着像「manifest 全错」）。

- [ ] **Step 3: 加四项检查**

**① `mask[].grantedBy ∈ codes`（堵 #822）**

```js
    // ① 掩码的豁免码必须真实存在于 manifest（否则发不出去 ⇒ 谁都豁免不了 ⇒ 静默全掩）
    if (Array.isArray(m?.mask)) {
      for (const item of m.mask) {
        const g = item?.grantedBy
        if (typeof g !== 'string' || g === '') continue // 形状问题归 check-data-models ⑤-d
        if (!codes.has(g)) {
          violations.push({
            file: L1_DECLARATIONS_REL,
            message: `指标 \`${name}\` 的 \`mask\` 声明了豁免码 \`${g}\`，但 ${DATA_MANIFEST_REL} 的`
              + ' `permissions[]` 里没有它 —— 装载器按各租户 org 逐个 upsert，**没声明就发不出去**'
              + '（admin 端点会 404 NO_SUCH_CODE）。失败方向是**过度掩码**（fail-closed）：'
              + '持码人也看掩码值。修法：在 manifest 里声明该码，或改掉 `grantedBy`。',
          })
        }
      }
    }
```

**② 打 `sensitivity` 之前必须先有默认档的码（堵 #821 / #764 R6）**

循环**外**、`loadSensitivity` 之后：

```js
  // ② 有任一契约列带 sensitivity ⇒ 默认档的豁免码必须在 manifest 里
  //    （否则默认档一开，全租户静默拿 NULL 且**无人能豁免**——没有任何码能放行原值）
  const hasSensitiveColumn = [...sensitivity.values()].some((s) => s !== 'none')
  if (hasSensitiveColumn && !codes.has(DEFAULT_TIER_SCOPE)) {
    violations.push({
      file: DATA_MANIFEST_REL,
      message: `契约里已有列声明了 \`sensitivity !== 'none'\`，但 \`permissions[]\` 里没有`
        + ` \`${DEFAULT_TIER_SCOPE}\`（默认档的豁免码，spec §4.1.1 裁决 A）——`
        + '默认档一开，**谁都豁免不了**，全租户静默拿 NULL。'
        + `请先声明 \`${DEFAULT_TIER_SCOPE}\`（spec §8.1 的 ② 是人工步骤，闸只拦顺序颠倒）。`,
    })
  }
```

**③ 同一列只许一处 `mask` 声明（#820 路线 C 的前置条件）**

```js
  // ③ 按列解析要求「同一列只有一处声明」——否则并集里同一列有两个规格，谁赢没定义
  /** @type {Map<string, string>} */
  const colOwners = new Map()
  for (const m of metrics) {
    const name = String(m?.name ?? '(空)')
    if (!Array.isArray(m?.mask)) continue
    for (const item of m.mask) {
      const col = item?.column
      if (typeof col !== 'string' || col === '') continue // 整值/形状问题归别处
      const prev = colOwners.get(col)
      if (prev !== undefined) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `列 \`${col}\` 被两个指标各声明了一次 \`mask\`（\`${prev}\` 与 \`${name}\`）——`
            + '按列解析（spec §5.3.1 R10）下同一列只许一处声明，两处会让「取哪个规格」无定义。'
            + '请合并到一处，或改掉其中一处的 column。',
        })
        continue
      }
      colOwners.set(col, name)
    }
  }
```

**④ `required_scope ∈ codes`（销掉 `check-data-models.mjs:1005` 的陈旧承诺）**

```js
    // ④ required_scope 的码必须真实存在（今天 `check-data-models.mjs:1005` 写着「属另一条门禁」
    //    ——那条门禁**不存在**。本检查就是它。）
    if (m?.required_scope !== undefined && m.required_scope !== null) {
      const sc = String(m.required_scope)
      if (!codes.has(sc)) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `指标 \`${name}\` 的 \`required_scope: ${sc}\` 不在 ${DATA_MANIFEST_REL} 的`
            + ' `permissions[]` 里 —— 该指标对**所有人**静默不可见（码匹配不上，且没人能拿到它）。',
        })
      }
    }
```

⚠️ ①②③④ 的位置：①③④ 在 `if (!Array.isArray(m?.reads)) continue` **之上**；② 在循环外。**四项今天都是 no-op**（零 `reads`、零 `sensitivity`、零 `mask`、40 个指标全无 `required_scope`）。

- [ ] **Step 4: 更新文件头注释**

在 `── 判据（写死，别扩）` 段补四项，并加一句：**「四项都只查『申报了的自洽性』，查不到『漏申报』」**（与既有的「查不到漏申报」弱点同源，别让它看起来比实际强）。

- [ ] **Step 5: 订正 `check-data-models.mjs:1005`**

把「（要读 manifest，属另一条门禁）」改成指向 `check-column-scope-monotonicity.mjs` 的 ④ 检查（**同一提交**里对齐，否则注释与事实再次脱节）。

- [ ] **Step 6: 扩 `fixture()` + 写用例**

⚠️ **必须**给 `fixture()` 加 `modules/data/manifest.yaml`（含 `data:query` / `data:manage` / `data:cost` / `data:precise`）——**否则既有的「`required_scope: data:cost` 合法」用例会在新检查 ④ 下变红**（那正是 ④ 生效的证明，但既有用例的**意图**不是测它）。

新用例（每条都要**变异确认**）：

```ts
  it('① mask 的 grantedBy 不在 manifest ⇒ 违规（堵 #822）', () => { … })
  it('① mask 的 grantedBy 在 manifest ⇒ 不违规', () => { … })
  it('② 有 sensitivity 列但 manifest 缺 data:precise ⇒ 违规（堵 #821）', () => { … })
  it('② 无 sensitivity 列 ⇒ 不违规（今天的状态）', () => { … })
  it('③ 同一列被两个指标声明 ⇒ 违规，报出两个指标名', () => { … })
  it('③ 不同列各声明一次 ⇒ 不违规', () => { … })
  it('④ required_scope 不在 manifest ⇒ 违规（销 check-data-models:1005 的承诺）', () => { … })
  it('★ 指标没申报 reads ⇒ 四项检查**照样跑**（不被那条 continue 吃掉）', () => { … })
```

最后一条是**回归护栏**：它专门钉住 Step 1 那个坑。变异确认：把 ④ 挪到 `continue` **之下** ⇒ 恰这条红。

- [ ] **Step 7: 跑门禁 + 全套守卫**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm exec tsx scripts/check-column-scope-monotonicity.mjs && pnpm exec vitest run --dir scripts check-column-scope-monotonicity
```

Expected: `check-column-scope-monotonicity: OK`（今天四项全 no-op）。

- [ ] **Step 8: 提交**

```bash
git add scripts/check-column-scope-monotonicity.mjs scripts/check-column-scope-monotonicity.test.ts scripts/check-data-models.mjs
git commit -m "feat(data): 门禁补四项——豁免码可查 + 默认档码前置 + 同列单声明 + required_scope 可查（#821 #822）"
```

---

### Task 5: 默认档合成（#821）

**为什么**：默认档（spec §4.1.1）是**人裁**的「严档」——指标不声明 `mask` 却读了带 `sensitivity` 的源列 ⇒ 套整值 `nullify`。它必须**今天实现**（否则将来打标时会静默漏），但**验收不得依赖生产上有敏感列**（今天零敏感列）⇒ 用夹具。

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`
- Modify: `scripts/sync-data-semantics.test.ts`
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`

**Interfaces:**
- Consumes：T3 的 `sqlMentionsColumn`（`mask.ts`）、`DEFAULT_TIER_SCOPE`（`authz.ts`）、`loadSensitivity`（`check-column-scope-monotonicity.mjs`）
- Produces：`export function applyDefaultMaskTier(rows, sensitivity)`

- [ ] **Step 1: `declarationsFromYaml` 上载 `reads`**

在返回行对象里加（`:621-642` 那一段）：

```js
    // `reads` 上载进行对象：默认档要读它（`applyDefaultMaskTier`）。
    // ⚠️ 它**不在** `comparableOf` 的 12 元组里 ⇒ 加它**不会**让 `--check` 凭空报漂移；
    //    但 `reads` 的改动**仍可被 `--check` 检出**——经由它对**合成 masks**（第 12 元）的影响。
    // ⚠️ 也**不会**影响写库：`upsertL1Metric` 的列清单来自 `ROW_COLUMNS` 白名单，多出的键被忽略。
    reads: Array.isArray(m.reads) ? m.reads.map(String) : null,
```

- [ ] **Step 2: 实现 `applyDefaultMaskTier`**

```js
/**
 * 默认档（spec §4.1.1 裁决：**严档 `nullify`**）——「本指标一条列键声明都没命中，
 * 且本指标的 `reads` 申报里含 `sensitivity !== 'none'` 的源列」⇒ 合成一条**整值**掩码。
 *
 * ★ 为什么是**整值**（`column: null`）而不是按列：`reads` 是**湖契约列全名**
 *   （`lemeng.retail_order_line.sale_money`），`selectSql` 引用的是 **mart 列**
 *   （`fct_retail_sale.net_amount`）——**不同命名空间、无机械映射**。仓规**明文禁止**
 *   「按名字在 expression 里模糊匹配」的启发式（check-column-scope-monotonicity.mjs:17-18：
 *   会造假阳性、让真违规淹没）。⇒ 只能整值。
 *   ⚠️ 后果：整值是**指标级**的 ⇒ **不按列传播 ⇒ L2 不继承**（spec §7 R12）。
 *
 * ★ 为什么在这里（`readDeclarations`）而不是 `declarationsFromYaml`：
 *   `declarationsFromYaml` 是**纯**函数、被约 20 处内联夹具测试调用；
 *   `readDeclarations` 才持有 `rootDir`（要读 `contracts/**`）。默认档必须**只在真仓路径**生效，
 *   否则那些夹具测试会全变。
 *
 * @param {any[]} rows
 * @param {Map<string, string>} sensitivity
 * @returns {any[]}
 */
export function applyDefaultMaskTier(rows, sensitivity) {
  // 「列键声明」= 全仓所有 metric 行里 column 非 null 的声明（按列解析口径，spec §5.3.1 R10）
  const declared = new Set()
  for (const r of rows) for (const spec of r.masks ?? []) if (spec.column !== null) declared.add(spec.column)

  return rows.map((r) => {
    const reads = r.reads ?? []
    if (!reads.some((c) => (sensitivity.get(c) ?? 'none') !== 'none')) return r   // 没读敏感列 ⇒ 不套
    // ① 命中：本次 selectSql 里有任一被声明的列 ⇒ 默认档不叠加（spec §5.2 ① 优先于 ②）
    if ([...declared].some((col) => sqlMentionsColumn(r.selectSql, col))) return r
    return { ...r, masks: [...(r.masks ?? []), { column: null, kind: 'nullify', grantedBy: DEFAULT_TIER_SCOPE }] }
  })
}
```

- [ ] **Step 3: `readDeclarations` 接线**

```js
export function readDeclarations(rootDir) {
  const file = path.join(rootDir, L1_DECLARATIONS_REL)
  const parsed = parseYaml(readFileSync(file, 'utf8'))
  return applyDefaultMaskTier(declarationsFromYaml(parsed), loadSensitivity(rootDir))
}
```

顶部加 import：`loadSensitivity` from `./check-column-scope-monotonicity.mjs`（**安全**：该文件的 CLI 守卫使 import 时不跑 `main`；且**无环**——门禁不 import sync）、`sqlMentionsColumn` from `../modules/data/domain/mask.ts`、`DEFAULT_TIER_SCOPE` from `../modules/data/domain/authz.ts`。

⚠️ **同一步里必须改 `masksOf` 的函数头注**（否则那句注释当场变成假话，评审会按 spec 一致性记一条）：
它现在写着「缺省 → `null`（= 未声明；**运行期由「源列 sensitivity」推默认档——那是 `authorize()` 的
运行期职责，本物化层不推**）」。本任务之后**默认档就在本物化层**（`readDeclarations` → 写进
`data.metrics.masks`），运行期只消费 `masks`、**完全不认识 `sensitivity`**——那正是本方案的好处
（运行期保持笨）。把那半句改成：

```
 * 缺省 → `null`（= 未声明）。**默认档在本层合成**（`applyDefaultMaskTier`，读契约的
 * `sensitivity`）⇒ 运行期只消费物化好的 `masks`，不认识 `sensitivity`（运行期保持笨）。
```

> 顺带自查：`maskItemError` 的 `column` 形态错误信息里那句「或 null（整值掩码：把 `… as value`
> 整个换成 typed NULL）」在本任务后也**不再可达**（T3 Step 6 已一律拒 null）——一并改成
> 「非空字符串（整值形态写不出来，只由默认档合成）」。**判据**：`grep -n '整值' scripts/sync-data-semantics.mjs`
> 剩下的每一处，都要么仍成立、要么已改。

- [ ] **Step 4: 写测试**

```ts
  it('★ 今天真仓零 reads 零 sensitivity ⇒ 默认档合成 0 条（零行为变更）', () => {
    const rows = readDeclarations(ROOT)   // 真仓根，既有测试已这么用（:53/76/80/100/226）
    expect(rows.every((r) => (r.masks ?? []).every((s) => s.grantedBy !== DEFAULT_TIER_SCOPE))).toBe(true)
  })

  it('读了敏感列且无列键命中 ⇒ 合成整值 nullify', () => { … })
  it('读了敏感列但列键命中 ⇒ 不叠加（① 优先于 ②）', () => { … })
  it('reads 全是 none 列 ⇒ 不合成', () => { … })
  it('reads 含不存在的列 ⇒ 不合成（未声明 sensitivity 的按 none 计）', () => { … })
```

- [ ] **Step 5: SKILL.md 补整值 nullify 的答法**

`deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` 里 `masking` 那段（既有逐字行：「**`masking` 非空** ⇒ 答「约 ¥X」「X 元上下」，**不得报精确值**」）后面补：

```markdown
**整值掩码（记号键为 `<value>`）** ⇒ 整个值不可用（不是「约 0」、不是「无数据」）：
如实答「该项按平台规则不提供精确值」，**不得**把 `null` 转述成 0 / 无 / 未采集。
```

⚠️ 这条不能省：`sum(cast(null as numeric))` 回的是 `NULL`，模型很容易把 `NULL` 说成「0」或「没有数据」——**那是把掩码说成业务事实**。

- [ ] **Step 6: 跑测试**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm exec vitest run --dir scripts sync-data-semantics
```

- [ ] **Step 7: 提交**

```bash
git add scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md
git commit -m "feat(data): sync 合成默认档整值掩码 + 整值答法入指令面（堵 #821）"
```

---

### Task 6: 运行期按列解析（#820 / 路线 C）— **PR ②**

**为什么**：这是本轮的架构核心。今天 `authorize` 只读**本行**的 `metric.masks` ⇒ L2 行 `masks` 恒 null ⇒ **L2 恒不掩**（fail-open 洞）。改按列解析后，L2 的 `select_sql` 逐字保留了 L1 的列引用（实测）⇒ L2 自动被覆盖，**#820 结构上消失**（不需要血缘列、不需要反向检查、**无过期状态**）。

> ⚠️ **射程限定（2026-10-18）**：上面「不需要血缘列…**无过期状态**」只对**列键声明**成立——默认档的**整值掩码**是指标级、**不按列传播** ⇒ **L2 不继承**（spec §7 R12 / §5.3.1 补注）。别读成整个掩码设施都无过期状态。

**Files:**
- Modify: `modules/data/domain/mask.ts`（加 `effectiveMasks`）
- Modify: `modules/data/domain/mask.test.ts`
- Modify: `modules/data/domain/authz.ts`（`authorize` 第 5 参）
- Modify: `modules/data/domain/authz.test.ts`
- Modify: `modules/data/domain/query-service.ts`
- Modify: `modules/data/domain/query-service.test.ts`

**Interfaces:**
- Consumes：T3 的 `sqlMentionsColumn`
- Produces：`export function effectiveMasks(catalog: MetricDef[], metric: MetricDef): MaskSpec[]`
- Produces：`authorize(catalog, requester, metricId, args, maskCatalog = catalog)`（**第 5 参可选**）

- [ ] **Step 1: 实现 `effectiveMasks`**

```ts
/**
 * 按列解析本次查询的掩码集（spec §5.3.1 R10 裁决 C，堵 #820）。
 *
 * `掩码集 = ⋃{ 声明 d : d.column 逐字出现在 metric.selectSql 里 }`，d 取自**全量 catalog**。
 *
 * ★ 为什么取全量（含调用者看不见的行）：掩码**只会减少信息**⇒ 拿「我看不见的行」上的掩码
 *   来掩自己，是 fail-closed 的正确方向；并集 ⊇ 原集合 ⇒ **行为只增不减**。
 * ★ 为什么 L2 自动被覆盖：L2 的 `select_sql` **逐字保留** L1 的列引用（实测见 spec §5.3.1）
 *   ⇒ L2 查的列在 L1 行里声明过 ⇒ 命中。不需要血缘列、不需要反向检查、**无过期状态**。
 *   ⚠️ 射程限定（2026-10-18）：以上只对**列键声明**成立——默认档的整值掩码不覆盖 L2（spec §7 R12 / §5.3.1 补注）。
 * ★ 整值（`column === null`）**不跨指标按列传播** ⇒ 只取本行的整值声明（默认档合成的那些）。
 *
 * @param catalog 全量 catalog（**未**经 visibleMetrics 裁剪）
 * @param metric  本次查询的指标行
 */
export function effectiveMasks(catalog: MetricDef[], metric: MetricDef): MaskSpec[] {
  const byColumn = new Map<string, MaskSpec>()
  for (const row of catalog) {
    for (const spec of row.masks ?? []) {
      if (spec.column === null) continue                                  // 整值不按列传播
      if (byColumn.has(spec.column)) continue                             // 同列单声明由门禁保证；这里防御性取首个
      if (!sqlMentionsColumn(metric.selectSql, spec.column)) continue     // 本指标没查这列 ⇒ 与它无关
      byColumn.set(spec.column, spec)
    }
  }
  const whole = (metric.masks ?? []).filter((s) => s.column === null)
  return [...byColumn.values(), ...whole]
}
```

顶部把 `import type { MaskSpec } from './authz'` 放宽成 `import type { MaskSpec, MetricDef } from './authz'`（**仍只导入类型**，tsx 会擦除 ⇒ 依赖仍为零）。

- [ ] **Step 2: `authorize` 加第 5 参**

签名改成：

```ts
export function authorize(
  catalog: MetricDef[],
  requester: Requester,
  metricId: string,
  args: Record<string, unknown>,
  /**
   * 掩码解析用的**全量** catalog（spec §5.3.1 R10）。**缺省 = `catalog`** ⇒ 既有调用点
   * （`authz.test.ts` 约 40 处）一字不改。生产调用点（`query-service.ts`）**显式传未裁剪的那份**。
   *
   * ⚠️ **刻意不把裁剪挪进本函数**：那会改变文档化的拒绝原因（`metric_not_declared`
   *    → `metric_not_authorized`），重新引入 spec 刻意避开的**存在性探测**
   *    （见 `query-service.ts` 的 catalog 裁剪注释）。
   */
  maskCatalog: MetricDef[] = catalog,
): AuthzResult {
```

调用点（`:312` 一带）改成：

```ts
  const masked = maskedSelectSql(metric.selectSql, effectiveMasks(maskCatalog, metric), requester.hasScope)
```

- [ ] **Step 3: `query-service.ts` 传全量**

`query-service.ts:244-259` 改成：

```ts
  // 全量 catalog 同时供两个用途：① 裁剪出可见集（问数面）；② 掩码按列解析的输入。
  // ② 刻意用**未裁剪**的：掩码只减信息，用看不见的行上的掩码掩自己 = fail-closed。
  const allMetrics = await loadMergedCatalog(deps.pool, org)
  const catalog = visibleMetrics(allMetrics, requester, deps.adoptedSources)
  const authz = authorize(catalog, requester, metricId, args, allMetrics)
```

⚠️ `loadMergedCatalog` 由**一次**调用变成仍是一次（别写成调两次）。

- [ ] **Step 4: 写测试**

`mask.test.ts`：

```ts
describe('effectiveMasks（按列解析，#820 路线 C）', () => {
  const L1 = { id: 'l1', selectSql: 'select sum(fct_x.net_amount) as value from fct_x', masks: [{ column: 'fct_x.net_amount', kind: 'round', step: 1000, grantedBy: 'data:precise' }] }
  const L2 = { id: 'l2', selectSql: 'select sum(fct_x.net_amount) as value, bizday from dbt.fct_x', masks: null }

  it('★ L2 行 masks 恒 null，但按列解析仍拿到 L1 的掩码（洞 #820 消失）', () => {
    expect(effectiveMasks([L1, L2], L2)).toEqual(L1.masks)
  })

  it('★ 被 required_scope 裁掉的 L1 行**仍贡献**掩码（只看掩码集，不看可见性）', () => {
    // 调用方传全量 ⇒ 传进来就有；这条钉的是「不要在 effectiveMasks 里做可见性过滤」
    expect(effectiveMasks([L1], L2)).toHaveLength(1)
  })

  it('列不在本指标 selectSql 里 ⇒ 不贡献', () => {
    const other = { id: 'o', selectSql: 'select sum(fct_y.other) as value from fct_y', masks: L1.masks }
    expect(effectiveMasks([L1, other], other)).toEqual([])
  })

  it('整值（column=null）**不跨指标**传播：只有本行的整值生效', () => {
    const whole = { id: 'w', selectSql: L1.selectSql, masks: [{ column: null, kind: 'nullify', grantedBy: 'data:precise' }] }
    expect(effectiveMasks([whole, L2], L2)).toEqual([])
    expect(effectiveMasks([whole, L2], whole)).toEqual(whole.masks)
  })
})
```

`query-service.test.ts`：加一条端到端——L2 指标 + L1 带掩码 ⇒ 回包 `masking` **非空**（今天为空）。

- [ ] **Step 5: 跑测试 + 全量**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm --filter data test
```

- [ ] **Step 6: 提交**

```bash
git add modules/data/domain/mask.ts modules/data/domain/mask.test.ts modules/data/domain/authz.ts modules/data/domain/authz.test.ts modules/data/domain/query-service.ts modules/data/domain/query-service.test.ts
git commit -m "feat(data): 掩码按列解析（全量 catalog）+ L2 自动覆盖（堵 #820）"
```

---

### Task 7: 审计三态（#823）— **PR ③**

**为什么**：`masking` 列已在（`AuditEntry.masking: Record<string,string> | null`），本任务是**三态语义细化 + 类型加宽**，不是加列。判据是「**这次掩码到底有没有生效**」，不是「带了什么码」——所以被豁免的列也要记（否则审计看不出「这个人这次看的是原值」）。

**Files:**
- Modify: `modules/data/domain/mask.ts`（返回 `exempted`）
- Modify: `modules/data/domain/authz.ts`（`plan.exempted`）
- Modify: `modules/data/domain/audit-store.ts`（`MaskingAudit` + `maskingAuditOf`）
- Modify: `modules/data/domain/query-service.ts`
- Modify: `modules/data/domain/audit-store.test.ts`（新建或既有）
- Modify: `modules/data/migrations/019_query_audit_masking.sql`（头注）
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`

**Interfaces:**
- Produces：`maskedSelectSql(...) => { sql: string; applied: Record<string,string>; exempted: string[] }`
- Produces：`export type MaskingAudit = Record<string, string | string[]>`
- Produces：`export function maskingAuditOf(applied: Record<string,string>, exempted: string[]): MaskingAudit | null`

- [ ] **Step 1: `maskedSelectSql` 加 `exempted`**

⚠️ **顺序要紧**：**先判在场、再判豁免**——否则「豁免了、但目标根本不在 SQL 里」的声明会被**假记**成 exempted（它其实什么都没发生）。

```ts
export function maskedSelectSql(
  selectSql: string,
  masks: MaskSpec[] | null | undefined,
  hasScope: (code: string) => boolean,
): { sql: string; applied: Record<string, string>; exempted: string[] } {
  const applied: Record<string, string> = {}
  const exempted: string[] = []
  if (!masks || masks.length === 0) return { sql: selectSql, applied, exempted }
  let sql = selectSql
  for (const spec of masks) {
    const exempt = hasScope(spec.grantedBy)
    if (spec.column === null) {
      const h = topLevelValueHead(sql)
      if (h === null) continue                                   // 形状不合 ⇒ 不改、不记（★ 在场先于豁免）
      if (exempt) { exempted.push(WHOLE_VALUE_KEY); continue }
      sql = sql.slice(0, h.exprStart) + maskExpr(spec) + ' as value' + sql.slice(h.aliasEnd)
      applied[WHOLE_VALUE_KEY] = notationOf(spec)
      continue
    }
    // ★ 在场先于豁免：**先算「改了没改」，再决定记 applied 还是 exempted**。
    //   「在场」的判定就是展开本身（`next !== sql`）——**不调 `sqlMentionsColumn`**：
    //   那个谓词的定义是「跑一遍本函数看 applied」⇒ 在此调用 = **自递归爆栈**。
    const colRe = new RegExp(`\\b${escapeRe(spec.column)}\\b`, 'g')
    const next = sql.replace(colRe, (match, offset: number) =>
      ALIAS_BEFORE_RE.test(sql.slice(0, offset)) ? match : maskExpr(spec))
    if (next === sql) continue                                    // 不在（或只命中别名位）⇒ 不改、不记
    if (exempt) { exempted.push(spec.column); continue }
    sql = next
    applied[spec.column] = notationOf(spec)
  }
  return { sql, applied, exempted }
}
```

> ⚠️ 上面所有判定读的都是**当前** `sql`（可能已被前一条掩码改过）——与 `applied` 的记法一致（记的是「这次实际改没改」）。**别**改成读原始 `selectSql`。
> ⚠️ 列分支的别名跳过用的是 **`ALIAS_BEFORE_RE`（T3 Step 3 引入）**，不是 `aliasStart`——顶层与内层别名都要跳（M1②）。整值分支照旧用 `topLevelValueHead`（`exprStart` / `aliasEnd`）。
> ⚠️ 本步**只**动列分支的「在场 / 豁免」次序，别顺手改别名判据（那是 T3 的地盘，改了会让 T3 的用例与这里不同尺）。

- [ ] **Step 2: `authz.ts` 透传 `exempted`**

`plan` 类型加 `exempted: string[]`，返回处加 `exempted: masked.exempted`。文档注释照 `applied` 的风格写（**恒在场**，可能为空数组）。

- [ ] **Step 3: `audit-store.ts` 三态**

```ts
/**
 * 审计里的掩码形态（spec §4.4.1）：三种**发生的形态** + 它们的**并**。
 *
 * - `null` —— 本次无掩码生效（未声明 / 形状没命中 / 查询未执行）
 * - `{ "net_sales": "round:1000" }` —— 有列被掩
 * - `{ "__exempted__": ["net_sales"] }` —— 有列被豁免（持码看原值）
 * - 混合形 `{ "net_sales": "round:1000", "__exempted__": ["cost"] }` —— 同一次查询里
 *   一列被掩、另一列被豁免（两条声明的 `grantedBy` 不同）⇒ 两个键**同现**。
 *
 * ⚠️ **响应面 `masking` 装不下本类型**（契约是 `Record<string,string>`）——两者必须由
 *    `query-service.ts` 从同一份 `authz.plan` 在一处派生，别各写一遍（会不同尺）。
 */
export type MaskingAudit = Record<string, string | string[]>

/** 审计掩码值的**唯一构造点**（纯函数，可脱库单测）。 */
export function maskingAuditOf(applied: Record<string, string>, exempted: string[]): MaskingAudit | null {
  if (Object.keys(applied).length === 0 && exempted.length === 0) return null
  return { ...applied, ...(exempted.length > 0 ? { __exempted__: [...exempted].sort() } : {}) }
}
```

`AuditEntry.masking` 类型从 `Record<string, string> | null` 改成 `MaskingAudit | null`（`writeAudit` 的 `JSON.stringify` 分支不变）。

- [ ] **Step 4: `query-service.ts` 同源派生**

```ts
  // 审计掩码（spec §4.4.1 三态）与回包 masking 同源：都从 authz.plan 派生，一处构造。
  // ⚠️ 两者**不同尺是刻意的**：回包契约是 `Record<string,string>`，装不下 `__exempted__`
  //   （那是运营侧信息，不该喂给模型/前端）；反过来审计要记「豁免了谁」。
  //   ⇒ 判据只有一份 `hasMasking`（回包用）；审计那份的 null 判据在 maskingAuditOf 内部。
  const hasMasking = Object.keys(authz.plan.applied).length > 0
  const auditMasking = maskingAuditOf(authz.plan.applied, authz.plan.exempted)
  await audit('ok', raceRetried ? 'lake_race_retry' : null, result.rows.length, auditMasking)
```

回包处（`:381-387`）改成用 `hasMasking`：

```ts
    ...(hasMasking ? { masking: authz.plan.applied } : {}),
```

> ⚠️ **必须同时改那段既有注释**：`:383-385` 现在写着「★ 复用上面审计那一份 `appliedMasking`（T3-②，issue #824）：两处各写一遍 `Object.keys(...).length > 0 ? applied : null` 是同一个判据的第二份实现」。本轮之后 `appliedMasking` 这个名字**不再指审计值**（审计值叫 `auditMasking`，且是三态），「复用同一份」不再成立。把注释改成上面那段：**判据一份（`hasMasking`）、形状两份、输入同源**——#824 要防的「同一判据两份实现」仍然被防住，别把这条约束连同它的注释一起丢掉。
> ⚠️ 顺带：`audit()` 的形参类型（`query-service.ts:218` 的 `masking: Record<string, string> | null`）也要跟着加宽成 `MaskingAudit | null`，否则 Step 3 加宽 `AuditEntry` 会在这里断链。

- [ ] **Step 5: 迁移头注 + SKILL.md**

`019_query_audit_masking.sql` 头注补三态表 + 混合形；`SKILL.md` 补一句「**被豁免**的列在审计里记 `__exempted__`，指令面看不到它（回包不含）」。

- [ ] **Step 6: 写测试**

```ts
describe('maskingAuditOf（spec §4.4.1 三态）', () => {
  it('空 applied + 空 exempted ⇒ null（不是 {}）', () => { … })
  it('只有 applied ⇒ 就是它', () => { … })
  it('只有 exempted ⇒ 只带 __exempted__ 键', () => { … })
  it('★ 混合形：两个键同现', () => { … })
  it('__exempted__ 排序（稳定输出，避免 jsonb 键序噪声）', () => { … })
})
```

`mask.test.ts` 补：**豁免了但目标不在 SQL 里 ⇒ 不记 exempted**（Step 1 的「在场先于豁免」）。变异确认：把在场检查挪到豁免之后 ⇒ 恰这条红。

- [ ] **Step 7: 跑测试 + 提交**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm --filter data test
git add modules/data/domain/mask.ts modules/data/domain/authz.ts modules/data/domain/audit-store.ts modules/data/domain/query-service.ts modules/data/migrations/019_query_audit_masking.sql deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md
git commit -m "feat(data): 审计掩码三态（含混合形）+ 与回包同源派生（堵 #823）"
```

---

## 已知边界（不在本计划内）

| # | 项 | 为什么不做 |
|---|---|---|
| **M2** | `masksOf` 的 grain 检查过宽（维度列出现在 selectSql 别处也算「掩了维度列」） | **fail-closed**：多掩 ⇒ 报错拒写，不是漏掩。修它要动 `masksOf` 的判定基准，收益不抵风险 |
| **R11** | `L2_BASE_MASKED` 守卫在路线 C 下的定位 | §5.3.1 已记：**列键分支**降为可用性约束（代价 = 一个 400），**整值/默认档分支仍是安全约束**（整值不跨指标传播）。**本轮不动它** |
| **存量 L2** | 打 `sensitivity` 之前已存在的 L2 行 | `L2_BASE_MASKED` **只拦新建** ⇒ 这些行是 R12 的残余风险。已写进 spec §8.1 ③ 的前置（**人工盘点**） |
| **② 人工步骤** | §8.1 的「给该看精确值的人发码」 | **闸拦不住**「跳过 ② 直接开闸」——这是租户管理员的判断，不是机械判据。spec 已明记 |

## 验收（本计划完成时逐条勾）

- [ ] `pnpm typecheck` 全绿（含根 `tsconfig.json` 的 `scripts/`）
- [ ] CI `gates` 全绿：`check-column-scope-monotonicity` / `check-data-models` / `check-manifests` / `check-env-example` / `check-compose` / `lint-architecture` / `gen-data-projection --check`
- [ ] `pnpm --filter data test` 全绿
- [ ] **今天零行为变更**：真仓 `readDeclarations(ROOT)` 合成 0 条默认档（有测试钉）
- [ ] **三条变异确认都做过**（T3 的 A/B/C、T4 的 ④ 挪位、T7 的在场/豁免换序）——**判据只有变异确认**，绿不算
- [ ] 三个 PR 各自 `Closes` 对应 issue（**不写** 764）
- [ ] 若动了 `dbt/**` ⇒ 已重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（本计划默认不碰）
