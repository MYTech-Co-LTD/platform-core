# 列级与值级权限（CLS + 动态脱敏）—— 设计（spec）

> 日期 2026-10-17 · issue #764 · 状态：**待评审**（P1 列级 / P2 值级；P3 只登记不设计）
> 本文 §2 每条事实都标了**文件:行**；凡标「未验」的一律**不许当已知**（本仓规矩：无案例不立标准）。

## §0 问题

平台的划线依据今天只有**一处**——`modules/data/domain/authz.ts` 的 org 谓词 + scope 矩阵
（`docs/architecture.md` §2.2 末注：「**这条通路唯一的划线依据**」）。但它只划到两档：

| 已有 | 在哪 | 划什么 |
|---|---|---|
| 路由级 | `modules/data/manifest.yaml` 的 `api.internal[].scope` | 这个端点你能不能打 |
| **指标级** | `metric.requiredScope`（`authz.ts:20-38`） | 这个**指标**你能不能看到 |

**列级与值级是空的**，于是两个真实需求今天无解：

| # | 情形 | 例子 |
|---|---|---|
| **① 列级** | 同一指标，不同的人**看得到不同的列** | 店长看得到「销售额」，看不到「成本 / 毛利」 |
| **② 值级** | 同一指标同一列，不同的人看到**不同的精度** | 老板看「¥1,234,567.89」，店长看「约 ¥123 万」 |

⚠️ **不能靠「从词表里藏起来」来解决**——架构已明确：

> 「**词表裁剪**是一种**能力**，**不是闸**——它给 AI 一份理解口径用的词表，**不构成「不在词表即不可见」**。」
> —— `docs/architecture.md:194-195`

`visibleMetrics()`（`authz.ts:120-128`）只是过滤器，绕过它（直打 `/query`、MCP、报表）仍然拿得到数。
**真要裁剪，只能落在查询网关组装的 SQL 投影上。**

## §1 目标与判据

**目标**：在**既有唯一划线依据**上**加一维**（列 / 值），**不新增权限组件、不新增第二划线依据**。

| 段 | 判据（可机器判） |
|---|---|
| **列级** | 不满足某指标 `requiredScope`（如新码 `data:cost`）的人打 `/query`，回包 `columns` 里**不含**成本/毛利列，且**SQL 里也不含**（不是前端隐藏） |
| **值级** | 有 `data:query` 无 `data:precise` 的人查同一个指标，**明细行与 `total` 都是掩码后的值**，且 `total` == 展示行之和 |
| **不可绕** | 换过滤条件 / 换时间窗 / 换分组 / 走 MCP / 走报表，**掩码恒定**，差分不出精确值 |
| **默认严档** | 指标**不声明** `mask` 而读了带 `sensitivity` 的列 ⇒ 无特权者拿到 **NULL**（不是原值、不是"忘了就漏"） |
| **血缘单调** | 给源列加限制后，**读它的指标**若未同步收窄 ⇒ CI **红**（不是告警） |

## §2 现状取证

### 2.1 执法点在哪（已验）

**唯一执法点是 `authorize()`**（`modules/data/domain/authz.ts`）——它组装 SQL，所有查询面都经过它：

```
routes/query.ts:31  POST /query ─┐
routes/mcp.ts:69    MCP         ├─▶ runQuery()  ──▶ authorize() ──▶ authz.plan.sql
domain/agent-loop.ts:158  chat  ┘   query-service.ts:200   authz.ts:255-271
报表渲染 ──(HTTP)──▶ /query ────────┘        ← ⚠️ 报表**不是**直接调 runQuery，是打 HTTP
```

- `runQuery` 自己**不拼 SQL**，执行的是 `authz.plan.sql`（`query-service.ts:279`）。
- SQL 形状（`authz.ts:255-271`）：

```ts
const whereAndGroup = `${metric.selectSql} WHERE ${metric.subjectColumn} = ${sqlQuote(subject)}`
  + filters.join('') + (metric.groupBy ? ` GROUP BY ${metric.groupBy}` : '')
const sql = wantTotal
  ? `SELECT sum(value) AS total FROM ( ${whereAndGroup} ) t`
  : `${whereAndGroup}${detailOrder} LIMIT ${MAX_QUERY_ROWS}`
```

- `metric.selectSql` 由**编译期**产出：L1 走 `buildSelectSql(expression, grain, relation)`
  （`scripts/sync-data-semantics.mjs:228-231`），L2 走 `compileL2`（`semantic-compiler.ts:533/579/641`）。
  形态：`select <expression> as value[, <dims>] from <relation>`。
- 回包 `QueryOk`（`query-service.ts:156-187`）：`status/subject/metricId/columns/rows/truncated/total?/data_as_of?/watermark?/freshness_status?/freshness_line?`。

**⇒ 加一维授权，只改 `authorize()` 一处；四个消费面（`/query`、MCP、chat、报表）自动全覆盖。**

### 2.2 两个已确认的缺口

1. **契约列没有授权位。** 全仓 grep `masking|列级权限|sensitivity` **零命中**（只在无关的
   「secret 脱敏」语境出现过）。契约列的 schema 是 `contracts/common/_schema.schema.json` 的
   `$defs.column`（`:157-217`），字段只有 `name/type/nullable/precision/scale/description/expr`，
   且 **`additionalProperties: false`** ⇒ **加一个字段必须先改 schema**（这本身就是一道真闸）。
2. **报表面有一条已确认的旁路。** `modules/data/routes/reports.ts:350-352` 的注释自陈：

   > 「规格里的 metricId 可见性**另由 /query 的语义裁剪兜底**」

   即：发布报表时**不校验面板指标的 scope**。今天靠 `/query` 兜底还成立；一旦引入列级/值级，
   这条兜底就**不够**了（报表是**冻结的规格**，不是实时查询）⇒ P1 必须补发布门（§4.4）。

### 2.3 无地基 / 未验（不许当已知）

| # | 项 | 现状 | 影响 |
|---|---|---|---|
| **U1** | **列级血缘** | **仓内不存在**。搜遍 `modules/data` / `scripts/` / `dbt/` 只有散文注释；无 dbt manifest（`dbt/target` 不存在），`gen-data-projection.mjs` 做的是**契约列 → 管线投影**（不是血缘），`parseL1Select`（`semantic-compiler.ts:193-216`）只取出 value 表达式与 relation，**不回溯源列** | 我原提的「血缘 CI 门」**没有地基**。§4.3 据此降级为**申报 + 只查单调性**，完整性**不进第一档** |
| **U2** | **表达式引用的是 marts 列，不是契约列** | 实测 L1：`expression: 'sum(fct_retail_sale.net_amount)'`（`dbt/semantics/l1_metrics.yml:56`），`grain: [system_book, bizday, branch_num]`。契约列 → dbt 模型 → marts 列 → 指标表达式，**两跳** | 机械血缘需要解析 `dbt/models/**/*.sql`——**这是另一个项目**，不在本 spec |
| **U3** | **直读面不受本机制约束** | 架构 §2.2 末注（`:622`）：2026-09-26 起「任何绕开 facade 的数据面直连都不合规」**整句作废**，直连改由「**受授权面约束 + 入审计**」判定；AI 可直读数据面，Metabase 亦在列 | **本机制只覆盖 `modules/data` 这条腿**（§3.3） |
| **U4** | `mask` 的**默认值**（不声明时是什么） | 未定 | §7 待裁决 |

## §3 架构

### 3.1 三层声明 + 一个执法点

```
[源列]  contracts/*.json   columns[].sensitivity   ← 声明「这一列敏感」，不直接执法
   │                                                    只作 §4.3 血缘门的输入
   │  血缘（U1：今天靠申报，非机械）
   ▼
[指标]  dbt YAML / L2 定义 ──编译期──▶ data.metrics ──▶ MetricDef
        requiredScope（已有，= 整指标隐藏）
        mask          （新增，= 值级）
   │
   ▼
[执法]  authorize()  ← 唯一执法点；按 requester 展开投影
   │
   ▼
[报表]  report_specs ── 发布门（新增）+ /query 兜底（已有）
```

**三层各自管什么**（别混）：

| 层 | 声明在哪 | 语义 | 谁来执法 |
|---|---|---|---|
| **源列** | `contracts/*.json` | 「这一列敏感」 | **不直接执法**——它从不被直接返回给用户，只喂指标表达式 |
| **指标** | dbt YAML → `data.metrics` | 隐藏（`requiredScope`）/ 脱敏（`mask`） | `authorize()` |
| **报表** | `report_specs` | 发布门 | `PUT /reports/:id` + `/query` |

> **为什么源列不直接执法**：查询面返回的是 `value` + dims（`QueryOk.columns`），**契约列从不出现在回包里**。
> 所以「隐藏成本价」在问数语境里 = **隐藏读它的指标**，不是隐藏那一列本身。

### 3.2 三条不变量

1. **执法点唯一。** 裁剪与脱敏**只**发生在 `authorize()` 组装的 SQL 里。
   前端、词表、报表渲染、MCP 一律**不承担安全职责**（前端脱敏 = 没脱敏）。
2. **掩码先于聚合**（对可下推的 kind）。`sum(round(x,-1000))`，**不是** `round(sum(x),-1000)`。
   后者可被差分攻击逼近精确值；前者用户**最多**看到掩码允许的值，与查询模式无关。
   不可下推的 kind（`bucket`）必须显式声明其**防护强度 = 桶宽**，且**不得附 `total`**（§5.1）。
3. **血缘单调。** `policy(指标) ⊇ ∪ policy(该指标读到的源列)`。
   给源列加限制而读它的指标没收窄 ⇒ **CI 红**。违反的表现是隐蔽泄漏：
   藏了 `item_cost_price`，但「毛利率」照旧能算出来。

### 3.3 射程边界（**必须写在 spec 里，不许含糊**）

本机制**只覆盖 `modules/data` 这条腿**（`/query`、MCP、chat、报表经 HTTP 打 `/query`）。
**直读面不在射程内**：Metabase 直连 pg_duckdb、AI 直读数据面湖，**不经过 `authorize()`**
（架构 §2.2 末注已接受此形态，合规判据是「受授权面约束 + 入审计」）。

⇒ 直读面的列级/值级要落到**数据面自己的授权**（pg_duckdb 的 USER MAPPING / dbt view 列裁剪），
那是**另一条腿、另一个 spec**。**本 spec 不得声称「全平台列级权限已解决」。**

## §4 P1：列级（隐藏）

### 4.1 契约列加 `sensitivity`

`contracts/common/_schema.schema.json` 的 `$defs.column` 增**可选**字段（`additionalProperties:false` ⇒ 必须同改 schema）：

```jsonc
"sensitivity": {
  "description": "敏感标记。只作血缘门（§4.3）的输入；不改变本列的落盘与投影。",
  "enum": ["cost", "pii", "none"]      // 封闭词表，加值 = 改常量 + 改 schema + 走 PR
}
```

**为什么是标记而不是策略**：源列不直接执法（§3.1），所以这一层只需要回答「敏感吗、哪一类」。
真正的策略（谁能看、看多精确）在**指标层**——那里才有 requester。

#### 4.1.1 默认档：**打了标记就自动套最严**（R1 已裁决，2026-10-17）

**裁决**：指标**不声明** `mask` 时，**按源列 `sensitivity` 自动套默认掩码**（fail-closed），
不采用「默认原值」。误伤由租户管理员改（§5.6）。

**默认值 = `nullify`（置 NULL），不是某个取整步长。** 两个理由：

1. **`nullify` 不需要编造任何数字**。默认 `round:1000` 得先回答「为什么是 1000」——本仓规矩是
   **无案例不立标准**，凭空定一个平台级步长正是「编标准」。
2. **它响亮，取整不响亮**。取整出的数看着像真数，没人会察觉「这个数被抹了精度」，
   于是全租户拿着略错的数做决策而无人投诉；NULL 会立刻被看见、被报、被修。
   **静默的错比响亮的缺更坏。**

**中间档（`round` / `bucket`）必须显式声明**，走 PR 改 dbt YAML。⚠️ **因此它是「非自助」的**——
这是本设计**有意**的取舍（§5.6 写明）。

> ⚠️ **`sensitivity` 是新的必答题，不是免费标签**：给一个已被指标读的列打标记 = **当场改变那些指标的
> 行为**（对无特权者变 NULL）。⇒ 见 §8 的上线顺序硬约束。

### 4.2 指标层：`requiredScope` 已有，补**报表发布门**

指标级隐藏**已经存在**（`metric.requiredScope`，`authz.ts:210-212` 的 `metric_not_authorized`），
P1 **不改它**。要补的是报表面那条旁路（§2.2 第 2 条）：

**发布门（新增，`PUT /reports/:id`）**：报表 `requiredScope` 不再由调用者随手给，
改为**从面板指标推导**，保证「**报表可见 ⇒ 每个面板的指标都可见**」。

⚠️ **订正（2026-10-17 写计划时验算）**：本节初稿写的是「取 `max(面板 scope)`」——**`max` 无定义**。
scope 是**不透明字符串**，这套模型里**没有 scope 层级**（`hasScope` 就是「集合里有没有这个码」），
所以 `hasScope(A) ⇒ hasScope(B)` **当且仅当 `A == B`**。⇒ 正确规则是按**集合**判，不是按大小：

| 面板指标里**非 null** 的 `requiredScope` 集合 | 发布结果 |
|---|---|
| 空集（都无限制） | 报表 `requiredScope = null`（与今天一致） |
| **单元素** `{C}` | 报表 `requiredScope = C` |
| **多元素** `{C1, C2, …}` | **拒绝发布**，错误信息**点名**是哪些指标、哪些码——单值列**表达不了**「这些码都要有」 |

**为什么多元素是拒绝而不是挑一个**：挑任一个都会放行「只有 C1 没有 C2」的人，
而他的 C2 面板 `/query` 会 403 ⇒ **报表看起来正常、点进去炸**。宁可发布时响亮地失败。

**为什么不是「拒绝一切有 scope 的面板」**：那会让人「先发空报表再补面板」，把门绕过去。
上面这张表**只在真正表达不了时**才拒绝。

`/query` 兜底**保留**（双保险）。

### 4.3 血缘门（**只查单调性，完整性不进第一档**）

| 查什么 | 怎么查 | 档位 |
|---|---|---|
| **单调性** | 指标在 **dbt YAML**（与 `expression` 同处）声明 `reads: ["<contract 列全名>", …]`；CI 检查 `policy(指标) ⊇ ∪ policy(声明的源列)` | **第一档（CI 红）** |
| **完整性**（声明是否漏了） | 需要 contract → staging → marts 的列级血缘（U1/U2），**仓内不存在** | **第二档（仅评审）**，标注为**未验** |

⚠️ **诚实标注这道门的弱点**：它**只**拦「加了限制却忘了同步指标」，**拦不住**「故意/无意漏申报」。
完整性要机械化，得先有 dbt 模型级血缘（U2）——**那需要真实案例驱动，本 spec 不预先建**。

### 4.4 审计

`data.query_audit`（`modules/data/migrations/001_init.sql:50-62`）增**可空** `masking jsonb`，
记录本次实际生效的裁剪/掩码（P1 写被隐藏的指标/列；P2 写 `{"net_sales":"round:1000"}`；都没有则 `NULL`）。
迁移**必须幂等**：`ALTER TABLE … ADD COLUMN IF NOT EXISTS`。
写入点：`query-service.ts:207-222` 的 `audit()` 闭包（已有，四个出口都过它）。

> 这一列是「谁看过精确值」的**唯一凭据**。没有它，事后无法回答「那次泄漏是谁的权限」。

## §5 P2：值级（脱敏）

### 5.1 mask 词表与**可下推性**（本 spec 最容易做错的一处）

| kind | 语义 | 能下推进聚合内部？ | 说明 |
|---|---|---|---|
| `nullify` | 置 NULL | ✅ 等价 | 明细与合计都为 null，顺序无关 |
| `round` | 按步长取整（`step: 1000` ⇒ 千元） | ✅ **必须**下推 | 下推后 `total` == 展示行之和，且差分不出精确值 |
| `bucket` | 落区间（`edges: [...]` ⇒ 「50–100 万」） | ❌ **不可**（区间标签不能求和） | 只能作用于**输出值**；防护强度 **= 桶宽**，不是「安全」 |

**`bucket` 的两条附加约束**（不做就会自相矛盾）：

1. **不得附 `total`**：`bucket(sum)` ≠ `sum(bucket)`，两者同时出现会直接暴露精度差。
   ⇒ `bucket` 生效时该次查询视同 `totalable = false`（与 `MetricDef.totalable` 同语义，`authz.ts:20-38`）。
2. **必须标注防护强度**：回包 `masking` 里写 `"bucket:[500000,1000000]"`，让调用方知道这是**有界**而非**安全**。

**能选、不能扩**：加 kind = 改常量 + 加展开分支 + 加测试，走 PR（同 `CHART_TYPES` 纪律）。

### 5.2 声明链（四处，缺一处静默不生效）

```
dbt/semantics/l1_metrics.yml        mask: [{ column, kind, step|edges, grantedBy }]
        │  scripts/sync-data-semantics.mjs   ← 今天这里硬编码 requiredScope: null（:385）
        ▼
data.metrics                        新增列 mask_spec jsonb（迁移，幂等）
        │  loadMergedCatalog（query-service.ts:242）
        ▼
MetricDef（authz.ts:20-38）          新增可选 mask 字段
        │  authorize()  运行期展开
        ▼
authz.plan.sql
```

L2 指标同理，声明在 L2 定义里，经 `compileL2`（`semantic-compiler.ts`）落到同一个 `MetricDef` 字段。

**`grantedBy` 是新增权限码**（写进 `modules/data/manifest.yaml` 的 `permissions[]`，
由装载器按各租户 org 逐个 upsert——既有机制，不新增基建）。语义：

> **持有 `grantedBy` ⇒ 看原值；否则套 mask。** 与 `requiredScope` 的「默认拒绝」**方向相反**——
> 这是 masking 与 hiding 的本质区别，别把两个字段合成一个。

**解析顺序（写死，别让两处各有一套默认）**：

```
指标显式声明 mask            → 用声明的（可带自己的 grantedBy）
指标未声明，但读了带 sensitivity 的源列  → 用默认档：nullify（§4.1.1）
指标未声明，且不读敏感列       → 无掩码
```

### 5.3 运行期展开：**编译期占位符，运行期零解析**

**做法**：编译期把表达式里被 `mask.column` 点名的标识符替换成占位符，产出**骨架**存库：

```
编译期：  sum(fct_retail_sale.net_amount)
      →   sum({{MASK:fct_retail_sale.net_amount}})

运行期（authorize）： 有 grantedBy → sum(fct_retail_sale.net_amount)
                      无 grantedBy → sum(round(fct_retail_sale.net_amount, -1000))
```

**为什么这么做**（三个理由，都是硬的）：

1. **天然满足不变量 2**：占位符在**聚合函数内部**，展开即下推，不可能写错顺序。
2. **运行期零 SQL 解析**：只做字符串替换，不引 SQL parser、不吃运行期 CPU。
3. **编译期可机械校验**：`mask.column` 必须**逐字出现在** `expression` 里，否则编译期报错——
   拼错列名不会变成静默失效。

⚠️ **未验**：占位符与 `{{ }}` 语法是否与既有 SQL/模板层冲突（`${ENV:…}` / `${datetime}` 已占用 `${}` 形态）
——**实施期第一件事就是实测**，冲突则换分隔符（`§MASK:…§` 之类）。

### 5.4 回包与指令面（**不做这条 = 另一种泄漏**）

回包 `QueryOk` 增**可空**字段：

```jsonc
{ "columns": [...], "rows": [...], "masking": { "net_sales": "round:1000" } }
```

**为什么必须有**：模型拿到 `1234000` 会报成「123.4 万**元整**」。**脱敏了但答成精确值 = 另一种泄漏**
（更隐蔽——用户以为系统给的就是准的）。

同步两处（**都在既有机制内**，不新造）：

1. `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`——写死：
   **`masking` 非空 ⇒ 答「约 ¥X」「X 元上下」，不得报精确值**（随镜像走，重建部署生效）。
2. `query_data` 工具描述——同一条。

### 5.5 与 hiding 的合流（三档，不是两档）

| 用户持有的码 | 结果 |
|---|---|
| 无 `data:query` | 端点不可达（路由门） |
| `data:query` | 看得到**脱敏后**的值 |
| `data:query` + `data:precise` | 看**原值** |
| 指标 `requiredScope` 不满足 | **整个指标不在**（连约数都没有） |

### 5.6 误伤怎么修，以及**自助的边界在哪**（R2 已裁决，2026-10-17）

**裁决**：`grantedBy` 特权码**由租户管理员发**——租户管理员在租户内是最高权限，发码走既有机制
（`POST /admin/permissions/:code/users`，`apps/server/src/routes/admin.ts`，`requireScope('tenant:admin')`），
**不新增任何发码通路**。

**误伤的两条修法，一条自助一条不自助**（别含糊）：

| 症状 | 修法 | 自助？ |
|---|---|---|
| 「这些人本来就该看精确值」 | 租户管理员**发码**（既有机制） | ✅ 自助 |
| 「这个指标根本不该被掩码 / 该用取整而不是 NULL」 | 改 dbt YAML 的 `mask` 声明 → **PR** | ❌ 走 PR |
| 「这个列不该被标敏感」 | 改 `contracts/*.json` → **PR** | ❌ 走 PR |

> **为什么中间档不自助**：`mask` 声明在 **git**（dbt YAML），不在租户可编辑的配置里。
> 让租户自助改「平台级口径声明」会开一个**绕开评审改口径**的口子——与既有的
> 「口径只能有单一定义、改动走 PR」（`docs/architecture.md` §5.1 第 1 条）冲突。
> 自助的是**授权**（发码），不是**口径**。

#### 5.6.1 ⚠️ 必须写明的一条：**这不是防租户管理员的机制**

租户管理员持有 `tenant:admin` ⇒ 他能给自己发 `data:precise`，也能给任何人发。
**所以列级/值级权限防的是「租户内的普通成员」，不防租户管理员。**

平台侧要「连租户管理员也看不到」，**唯一**的实现是**不让这个指标/源进这个租户**
（`sourceSystem ∉ adoptedSources` ⇒ `visibleMetrics` 过滤掉，`authz.ts:120-128`），
或平台侧不下发该指标。**码级收口做不到这件事**——因为所有码都按租户 org 供给，租户管理员都能发。

⇒ 结论写死：**别把 CLS/脱敏当保密机制卖。** 它是**权限分级**机制；对租户管理员的保密
只能靠「不给这个租户接这个源」。

## §6 验收

| 判据 | 怎么验 |
|---|---|
| **列级不可绕** | 不满足指标 `requiredScope` 的人：`/query` 回包无成本列 **且** 抓 `authz.plan.sql` 确认 SQL 里也没有；再走 MCP 与报表各打一次，同样结论 |
| **值级恒定性** | 同一指标换过滤 / 换时间窗 / 换分组 / 换 `total=true`，**掩码恒定**；`total` == 展示行之和（`round` 类） |
| **差分攻击** | 造两组只差一行的过滤，取两次结果之差 ⇒ **只能得到掩码后的值**，得不到精确值 |
| **单调性门会红** | 变异测试：给源列加 `sensitivity` 而指标不收窄 ⇒ **恰好** `gates` 变红（判据只有变异确认，见既有教训） |
| **报表发布门** | 三种构造各验一次：面板都无 scope ⇒ 发布后为 `null`；面板同一个码 ⇒ 发布后等于该码；面板**两个不同码** ⇒ **发布被拒且点名**。三种情况下低权限者 `/query` 仍被拒 |
| **审计** | 脱敏查询后 `data.query_audit.masking` 非空且内容 == 回包 `masking` |
| **前端不算数** | 从 `rows` 原始 JSON 判，**不看界面** |

## §7 风险与待裁决

| # | 事项 | 性质 |
|---|---|---|
| **R1** | `mask` 的默认档 | ✅ **已裁决（2026-10-17）**：**自动套默认掩码**，默认值 = `nullify`。见 §4.1.1 |
| **R2** | `grantedBy` 的授予面 | ✅ **已裁决（2026-10-17）**：**租户管理员可发**（租户内最高权限），走既有发码机制。并写明**这不是防租户管理员的机制**——见 §5.6.1 |
| **R3** | **直读面（§3.3）**：本机制不覆盖 Metabase/AI 直读 ⇒ **存在一个已知的、被架构接受的缺口**。写进 §3.3 而不是藏着 | 已知 |
| **R4** | **占位符语法冲突**（§5.3 未验） | 实施期第一件事实测 |
| **R5** | **血缘门只查单调性**（§4.3）⇒ 拦不住漏申报 | 已知，第二档 |
| **R6** | 🔴 **上线即全租户变 NULL 的风险**（R1 判 fail-closed 的直接后果）：给一个**已被指标读**的列打 `sensitivity`，那些指标**当场**对无特权者返回 NULL——而 `data:precise` 是**新码，今天没人持有**。若直接开闸，**全租户问数同时黑屏**。⇒ §8 的顺序硬约束（先发码、后开闸）；按租户灰度，不一次性全开 | **必须按顺序做** |
| **R7** | 报表发布门会**抬严**既有报表（面板带 scope 而报表本身是 null）⇒ 可能让今天能看的人明天看不了；面板 scope **不一致**的报表**发布会被拒** | 迁移须预告 + 存量报表需盘点 |

## §8 拆解与顺序

```
P1 列级（契约 sensitivity + 血缘单调门 + 报表发布门 + 审计）   ← 本 spec 主体
        │
P2 值级（mask 词表 + 占位符骨架 + 运行期展开 + masking 回包 + SKILL）   ← 本 spec 主体
        │
P3（只登记，不设计）维度级隐藏（dims 白名单，同一投影点）；标签批量（sensitivity → 策略映射）
```

**顺序硬约束**：**先更新 `docs/architecture.md`（§2.2 加一条划线维度 + §4 不变量清单加「血缘单调」
与「掩码先于聚合」），再写码**——架构先行，顺序不得颠倒。

### 8.1 🔴 上线顺序（R6 的直接后果，不得调换）

因为 R1 判的是 **fail-closed**，而 `data:precise` 是**新码、今天无人持有**，
**先开闸 = 全租户问数同时返回 NULL**。所以：

```
① 权限码进 manifest，装载器按租户 org 供给（此时无人持有，行为不变）
② 租户管理员把码发给「今天本来就该看精确值」的人      ← 自助，走既有 /admin/permissions
③ 给契约列打 sensitivity                             ← 此时开闸才安全
④ 按租户灰度开闸，看一天再下一个租户
```

⚠️ **② 不能省**。省了就是 §7 R6。按租户灰度是因为「该看的人是谁」是**每个租户自己的判断**，
平台不该替他猜（也无从猜）。

**P3 不预先做**的理由：dims 白名单与值级同机制、同投影点，**不需要新架构**，但今天**没有真实案例**
（无案例不立标准）；真需求出现时随依赖登记。

## §9 关联

- issue **#764**（本 spec 的伞）
- 架构：`docs/architecture.md` §2.2 末注（唯一划线依据 / 直读面作废条款）、§4 不变量清单、§2.4（授权面口径）
- 既有实现：`modules/data/domain/authz.ts`（执法点）、`query-service.ts`（回包与审计）、
  `routes/reports.ts:350-352`（旁路注释）、`contracts/common/_schema.schema.json`（契约 schema）
- 行业对照：Snowflake Dynamic Data Masking / Databricks Unity Catalog column mask（列上策略、按
  querying role 生效、**列读时掩码 ⇒ 聚合在掩码值上做**）、BigQuery policy tags、Looker field access
- 相邻面：#753 / skill `askdata-tuning`（问数效果；`masking` 回包会改指令面，改完按该 skill 验收）
