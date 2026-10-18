# R12 存量 L2 盘点门（发布门硬化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec §8.1 ③ 那句「打 `sensitivity` 前先盘点存量 L2」从**散文提示**变成**机械发布门**——契约里出现敏感列时，盘点产物必须存在且**逐列点名**，否则 CI 红。

**Architecture:** 沿用既有契约门禁（`scripts/check-column-scope-monotonicity.mjs`，数据面层，正典 §1.5.3）。**不加运行时组件、不加血缘列、不加 openship job**。运行期那条断言（「有敏感列 **且** 存在 L2 行」）**本计划不实现**，只登记进 #538 Phase 1（它要吐进 `data_plane_probes` 流，而该流 Phase 1 未开工）。

**Tech Stack:** Node ESM + vitest、dbt YAML（yaml@2）。

## Global Constraints

1. **执法点唯一**：掩码只在 `authorize()` 组装的 SQL 里生效。本计划**不改**掩码机制本身。
2. **不加会过期的状态**：不引入血缘列、不建基指针（spec §5.3.1 的否决理由，2026-10-18 复核后维持）。
3. **判据必须能变异确认**：新增检查的每条用例都要做变异确认——绿不算。
4. **层不越界**（正典 §1.5.3）：契约 gate 归**数据面**；**不得**把语义判据塞进 openship job（红线③）；OO 只消费判红结论（红线①）。
5. **`dbt/**` 一律不碰**（会触发 data-plane lock 重跑）。`docs/**` 不在 `deploy/data-plane-manifest.txt` 里 ⇒ 改它无需重跑 lock。
6. **夹具一律内联在测试里。**
7. **提交纪律**：`<type>(<scope>): <一句话>`；PR 正文里**不要**逐字写 "Closes" 加伞 issue 编号 **764**。

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `scripts/check-column-scope-monotonicity.mjs` | 加 ②b：敏感列存在 ⇒ 盘点产物必须存在且逐列点名 | T1 |
| `scripts/check-column-scope-monotonicity.test.ts` | ②b 的用例 + 变异确认 | T1 |
| `docs/data/l2-sensitivity-inventory.md` | **新建**：R12 存量 L2 盘点产物（今天为真空集） | T1 |
| `docs/data-platform-handbook.md` §1.5.3 | 执行状态登记：Phase 1 加项 | T2 |

---

### Task 1: ②b 检查 + 盘点产物

**Files:**
- Modify: `scripts/check-column-scope-monotonicity.mjs`
- Modify: `scripts/check-column-scope-monotonicity.test.ts`
- Create: `docs/data/l2-sensitivity-inventory.md`

**Interfaces:**
- Produces：`export const L2_INVENTORY_REL = 'docs/data/l2-sensitivity-inventory.md'`

**Consumes：** 该脚本已有的 `sensitivity`（`loadSensitivity(rootDir)` 的返回值，`Map<列全名, sensitivity>`）与 `violations` 数组。

- [ ] **Step 1: 加常量与检查**

在 `L1_DECLARATIONS_REL` 附近加：

```js
/** R12 存量 L2 盘点产物（spec §8.1 ③ 硬化后的发布门凭据）。 */
export const L2_INVENTORY_REL = 'docs/data/l2-sensitivity-inventory.md'
```

在既有 ②（「有敏感列 ⇒ manifest 必须有 `DEFAULT_TIER_SCOPE`」）**紧后面**加 ②b。⚠️ **位置要求**：它读的是契约（不是指标行），所以必须在指标循环**之外**、与 ② 同侧；放到指标循环里会被 `if (!Array.isArray(m?.reads)) continue` 吃掉（今天 40 个指标零 `reads`）。

```js
  // ②b 打 sensitivity ⇒ 必须先有 R12 存量 L2 盘点产物，且该产物覆盖当前**每一个**敏感列（spec §8.1 ③）。
  //     为什么是发布门而不是提示：打标那一刻**已经存在**的 L2 不会继承默认档整值掩码（spec §7 R12），
  //     而 L2_BASE_MASKED 写侧守卫**只拦新建** ⇒ 敞口恰好落在「打标前已存在」的那批上。
  //     ⚠️ 每次新增打标都会**重新打开**窗口（后打的标，其「打标前已存在」的 L2 是新的一批）
  //        ⇒ 所以判据是「逐列点名」而不是「文件存在」。
  const sensitiveCols = [...sensitivity.entries()]
    .filter(([, s]) => s !== 'none')
    .map(([c]) => c)
    .sort()
  if (sensitiveCols.length > 0) {
    let inventory = null
    try {
      inventory = readFileSync(join(rootDir, L2_INVENTORY_REL), 'utf8')
    } catch {
      inventory = null
    }
    if (inventory === null) {
      violations.push({
        file: L2_INVENTORY_REL,
        message: `契约里已有 ${sensitiveCols.length} 个列声明了 \`sensitivity !== 'none'\`（${sensitiveCols.join('、')}），`
          + `但 \`${L2_INVENTORY_REL}\` 不存在 —— 打标前必须先盘点存量 L2（spec §8.1 ③ 的发布门）。`
          + '打标时**已存在**的 L2 不会继承默认档整值掩码（spec §7 R12），'
          + '而 `L2_BASE_MASKED` 只拦新建 ⇒ 那批必须先确认、留痕。',
      })
    } else {
      // ⚠️ 判据必须**定界匹配**，不能用 `includes` 子串匹配（Task 1 评审 Important 订正）：
      //    本仓真实列名里有**前缀撞车对** —— `lemeng.branch_expense.settlement_state` ⊂
      //    `…settlement_state_name`、`…other_inout_flag` ⊂ `…other_inout_flag_name`、
      //    `…other_inout_kind` ⊂ `…other_inout_kind_code`、`lemeng.client_expense.other_inout_flag` ⊂
      //    `…other_inout_flag_name`。同概念的两列一起打标、操作者只列长名 ⇒ 短名**静默通过**，
      //    正是本闸存在的意义（防漏报）。⇒ 两侧都不许再接 `[A-Za-z0-9_.]`（列名含点，故点也算词内字符）。
      const namedRe = (c) => new RegExp(`(?<![A-Za-z0-9_.])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.])`)
      const missing = sensitiveCols.filter((c) => !namedRe(c).test(inventory))
      if (missing.length > 0) {
        violations.push({
          file: L2_INVENTORY_REL,
          message: '契约里这些列声明了 `sensitivity !== \'none\'` 但盘点产物里**没有点名**：'
            + `${missing.join('、')} —— 每次新增打标都会重新打开窗口（spec §8.1 ③），`
            + '盘点必须**逐列留痕**（点出列全名 + 查询原文 + 原始输出 + 日期）。',
        })
      }
    }
  }
```

> ⚠️ **诚实边界**：这条检查**只保证「产物在且点了名」**，**不保证盘点真的做了**——契约 gate 读不到生产 `data.metrics`。这是刻意取舍（能拦「忘了做」，拦不住「写了 0」），后者归运行期判据（T2 登记进 #538 Phase 1）。**把这句话写进代码注释**，别让后来者以为这条闸比实际强。

- [ ] **Step 2: 建盘点产物**

新建 `docs/data/l2-sensitivity-inventory.md`：

```markdown
# R12 存量 L2 盘点产物

> **谁读**：`scripts/check-column-scope-monotonicity.mjs` 的 ②b 检查（spec §8.1 ③ 的发布门）。
> **何时更新**：**每次新增 `sensitivity` 打标**都要在下面补一行——窗口会被重新打开。
> **判据**：契约里出现的每一个 `sensitivity !== 'none'` 的列，都必须在下表**被点名**，否则 CI 红。

## 为什么

打标那一刻**已经存在**的 L2 不继承默认档的整值掩码（spec §7 R12）：
默认档是指标级/整值、不按列传播；而 `L2_BASE_MASKED` 写侧守卫**只拦新建**。
⇒ 这批存量 L2 是唯一敞口，必须人工确认后留痕。

## 盘点记录

| 契约列全名 | 盘点日期 | 查询原文 | 原始输出 | 结论 |
|---|---|---|---|---|
| （今天为空——契约里暂无 `sensitivity !== 'none'` 的列） | | | | |

**查询原文**（照抄，别改写；盘点时用生产 `data.metrics`）：

    select id, source, description from data.metrics where source = 'l2';

**怎么读结论**：逐行看它的 base 是否会被默认档覆盖——**不会**（R12）。对每个这样的 L2，
要么它不读敏感列（写「无影响」），要么**先处置再放行**（改口径、下线、或明确接受）。
```

> ⚠️ 上面那段「查询原文」的缩进块**必须原样保留**（它是操作者照抄的对象）。**不要**在本文档里写生产库连接串或凭据——按规矩只写「在哪、怎么取」。

- [ ] **Step 3: 写用例**

在 `check-column-scope-monotonicity.test.ts` 追加。⚠️ 先读既有 `fixture()` 的形状——它已经能造契约（含 `sensitivity`）与 L1 YAML；**本步要确认它能不能控制盘点产物是否存在**，不能就扩它（在 temp root 下按需写/不写 `docs/data/l2-sensitivity-inventory.md`）。

```ts
  it('②b 有敏感列但盘点产物缺失 ⇒ 违规（spec §8.1 ③ 的发布门）', () => { … })
  it('②b 有敏感列且产物逐列点名 ⇒ 不违规', () => { … })
  it('②b 产物只点名了一部分 ⇒ 违规，且报出缺的那一列', () => { … })
  it('②b 无敏感列 ⇒ 不违规（今天的状态；产物可有可无）', () => { … })
  it('②b ★ 前缀撞车：只列长名 ⇒ 短名仍报违规（子串匹配会漏报）', () => { … })   // Task 1 评审 Important 补入
```

> ⚠️ **前缀撞车那条用真实存在的列名对**，例如同时打标
> `lemeng.branch_expense.settlement_state` 与 `lemeng.branch_expense.settlement_state_name`，
> 产物里**只写长名** ⇒ 断言违规里点名了**短名**。用真名而非编造的名字，是因为「不会撞车」这个
> 假设正是被真实数据证伪的那个。
>
> ⚠️ 「无敏感列 ⇒ 产物可有可无」那条**两半都要跑**（Task 1 评审 Minor 订正）：除了「产物在」，
> 还要跑一次 **`inventory: null`**（有敏感列才需要产物；无敏感列时缺产物不算违规），
> 否则「把 `sensitiveCols.length > 0` 守卫删掉」这个变异不会红。

- [ ] **Step 4: 跑门禁 + 变异确认**

```bash
cd /Users/duo/orca/workspaces/platform-core/p2-leftovers && pnpm exec tsx scripts/check-column-scope-monotonicity.mjs && pnpm exec vitest run --dir scripts check-column-scope-monotonicity
```

Expected: 门禁 `OK`（今天零敏感列 ⇒ ②b 是 no-op）；用例全绿。

**变异确认（必须做，绿不算）**：

1. 把 ②b 的判据从「逐列点名」退回「只看文件存在」（即删掉 `missing` 那段）⇒ **②b 的两条判据用例都红**
   （「产物只点名了一部分」+「前缀撞车」）。⚠️ 这两条**共用 `missing` 分支**，所以两条一起红是
   **共用分支的必然结果，不是缺陷**——别为了让这里恰好只红一条而去窄化判据。
   （本行原写「恰好一条」，2026-10-18 按实现者实测订正：那条措辞早于「前缀撞车」用例的补入。）
2. 把定界匹配退回子串匹配（`inventory.includes(c)`）⇒ **恰好**「前缀撞车」那条红（Task 1 评审 Important 的判据）。

记录红掉的用例名，然后复原。

- [ ] **Step 5: 提交**

```bash
git add scripts/check-column-scope-monotonicity.mjs scripts/check-column-scope-monotonicity.test.ts docs/data/l2-sensitivity-inventory.md
git commit -m "feat(data): 打 sensitivity 须有存量 L2 盘点产物（R12 发布门硬化）"
```

---

### Task 2: 记账（正典执行状态 + #538）

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.5.3 执行状态表的 Phase 1 行）

- [ ] **Step 1: 正典 §1.5.3 执行状态表加项**

在 Phase 1 行（「覆盖面补齐…」）里补一句范围项，措辞与既有风格一致：

> \+ **R12 存量 L2 判据**：「契约有 `sensitivity !== 'none'` 列 **且** `data.metrics` 存在 `source='l2'` 行」⇒ 逐行吐进 `data_plane_probes`。**判据已就位**（契约侧门禁 ②b，`2026-10-18`）；**运行期那条待本 Phase 的流就位后接线**。

⚠️ **只加这一句**，别改 Phase 状态（Phase 1 仍是「未开工」——它整体没开工，本项只是**登记范围**）。

- [ ] **Step 2: #538 加项**

在 issue #538 的 Phase 1 清单里追加同一条（命令：`gh issue comment 538 --body "…"`，或编辑正文——**用注释**，别改别人写的正文）。

- [ ] **Step 3: 提交**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(data): §1.5.3 执行状态登记 R12 存量 L2 判据（归 Phase 1）"
```

---

## 已知边界

| # | 项 | 为什么这样 |
|---|---|---|
| **①** | 门禁只保证「产物在且点了名」，不保证盘点真做了 | 契约 gate 读不到生产 `data.metrics`。机械闸能拦「忘了做」，拦不住「写了 0」——后者归运行期判据（已登记 #538 Phase 1） |
| **②** | 运行期那条断言本计划**不实现** | 数据面运行期判红要吐进 `data_plane_probes`，该流是 #538 **Phase 1（未开工）**。现在自己起管道 = 越层 + 造第二套告警出口（红线③） |
| **③** | 存量 L2 敞口是**一次性**的 | 打标后新建 L2 已被 `L2_BASE_MASKED` 拦住（写入时校验，300/400）。所以状态集合收敛，不会无限增长 |
| **④** | 不为默认档引入血缘列 | 2026-10-18 复核：L2 有**两档**（`refine` 基是单个必填 `baseMetric`；`expr` 档**没有** `baseMetric`，基是表达式树里的**一组** ref，上限 16）⇒ 标量列按构造就错；legacy 行连基信息都没有；且那正是 §5.3.1 否决的「会过期的状态」 |

## 验收

- [ ] `pnpm typecheck` 全绿（含根 `tsconfig.json` 的 `scripts/`）
- [ ] `pnpm exec vitest run --dir scripts` 全绿
- [ ] CI 九条门禁脚本全 OK（尤其 `check-column-scope-monotonicity` 与 `check-data-plane-lock`）
- [ ] **变异确认做过**：②b 退回「只看文件存在」⇒ 恰「产物只点名了一部分」那条红
- [ ] 今天零行为变更：真仓零敏感列 ⇒ ②b 是 no-op（门禁仍打印 `OK`）
- [ ] 未碰 `dbt/**`
