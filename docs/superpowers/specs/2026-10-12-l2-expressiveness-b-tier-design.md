# L2 表达力 · B 中档（受限表达式）允许面 —— 设计增补

> **性质**：对 `2026-09-21-data-platform-layered-design.md` §10 拍板记录 **第 5 条（L2 表达力）** 的
> **增补与收口**。该节原文（分叉表行 5、拍板记录 6）**不删改**（历史留档）；冲突处**以本增补为准**。
> **由来**：issue **#574**——正典字面与实现注释对「定义权下放」的读法**互斥**且从未裁决。
> 人裁 **乙**（放开到 B 中档），并授权由实现方划定**允许面范围**（即本文）。

## 0. 一句话

L2 从「只 `refine` 单条 L1」（A 薄档）放开到「**用受限算术把多条 L1 组合成新测度**」（B 中档）；
表达面是**可机检的结构化算术树**，**不是表达式字符串**；**原子测度仍只能走 L1**——本增补只放开**组合**。

## 1. 裁决与收口

| 来源 | 读法 |
|---|---|
| 正典 §10 拍板 6（L219） | 「定义权下放——租户管理员与平台超管均可**定义**指标与语义（**不止 A 薄档**…）」⇒ 指向 **B** |
| 实现 `semantic-compiler.ts:18-21` | 同一句读成「**写权限**下放，与表达力档位无关」⇒ v1 只发 **A**，B 记为「走 spec 增补」 |
| **本增补（裁决）** | 采**正典字面**：L2 表达力 = **B 中档**；「定义权下放」= **表达力**下放 + 写权限下放**两者皆是**。C 厚档维持排除。 |

⇒ 实现注释的「写权限」读法**收窄**为「表达力**亦**下放」；`semantic-compiler.ts:18-21` 的指针须回填指向本文（见 §9）。

## 2. 允许面（可机检上界）

### 2.1 形态 = 结构化算术树，不是表达式字符串 ⭐

这是本文唯一不让步的选择。

| | **结构化树**（采用） | 表达式字符串（否） |
|---|---|---|
| 租户输入 | `{div, {ref:'lemeng:retail:net_sales'}, {ref:'lemeng:retail:order_count'}}` | `"net_sales / order_count"` |
| 可达 SQL 集合 | **= zod schema 本身**，可被单测穷举断言 | = 手写解析器**接受的一切**，须先证明解析器是全函数 |
| 与 `semantic-compiler.ts` 既定纪律 | **一致**（文件头：任何一处把入参拼进 SQL 都是注入面；收成一处才能穷举） | **违背**——重新引入自由文本 → SQL 面 |

> 结论：**选树**。字符串方案是把「禁任意 SQL」这条安全属性，换成「解析器恰好正确」这条赌注。

### 2.2 节点集（闭集）

```ts
type ExprNode =
  | { kind: 'ref'; id: string }                                   // ref.id 必须命中 L1 词表
  | { kind: 'num'; value: number }                                // 有限数字字面量（z.number().finite()）
  | { kind: 'add' | 'sub' | 'mul' | 'div'; left: ExprNode; right: ExprNode }
```

- **不给函数名**：除零守卫由**编译器注入**（§2.4），不作为租户可选项——少一个「函数名拼错 / 越界」校验面。
- **明确排除**：聚合函数（`SUM`/`COUNT`——L1 已是聚合后的测度，再聚合无意义）、`CASE`/比较/布尔、
  子查询、类型转换、引用另一条 L2。
- **`num` 只许有限数**（拒 `NaN`/`Infinity`）——否则会编译出 `NaN` 字面量这类非法 SQL。

### 2.3 组合约束（编译期硬校验）

树里**每个 `ref`** 解析出的 L1 行，必须满足：

1. **同关系**（`parseL1Select(selectSql).relation` 逐字相等）
2. **同 grain**（`groupBy` 逐字相等）
3. **同主体列**（`subjectColumn` 逐字相等）

任一不等 ⇒ 抛 **`MIXED_BASE`**（新码）。理由：产物是 `select <树> as value[, 维度] from <关系>`，
跨关系/跨粒度/跨主体列**根本拼不出合法且有意义的 SELECT**（例如跨粒度的比值，分母是另一粒度的部分和）。

### 2.4 除法语义

`div(a, b)` 编译成 **`(a) / NULLIF((b), 0)`** ⇒ **0 分母 → NULL**（不是 0——0 会污染下游均值/累计）。
守卫由编译器注入，租户**看不到也控制不了**它。

### 2.5 v1 不支持 `filters`（已知边界）

**带 `filters` 的 expr 声明 ⇒ 抛 `OP_UNSUPPORTED`（复用）。**

理由（设计约束，非临时裁剪）：现行为 `refine` 生成 `filters` 时走**派生表 + 外层 `sum(t.value)` 重聚合**，
**只对可加量成立**；而客单价/退货率是**比例、不可加**——`sum(客单价)` 是错的。要在 expr 上支持 `filters`，
得改成「**每个 ref 一列**的派生表、重聚合落在组件上」（`sum(a)/NULLIF(sum(b),0)`），是**后一增量**。
驱动用例（客单价/退货率/占比）都是整店口径，v1 够用。

### 2.6 `ref` 只指 L1（不可 L2 引 L2）

维持 `resolveL1Base` 的既有纪律（`source === 'l1'`）：口径链不得无限延长，每跳只看上一跳编译产物。
⇒ 一条 expr L2 **不能被另一条 L2 引用**。

### 2.7 规模上限

- 树**深度 ≤ 8**、节点中 `ref` 总数 **≤ 16**（超限 ⇒ `EXPR_DEPTH_EXCEEDED` 新码）。
- `visibility.dims` 沿用既有 ≤ 64。
- 上限值是可调常量，放在编译器同文件。

## 3. 声明形状与接口兼容

### 3.1 域层：判别式 union（`op.kind` 为判别键）

```ts
type L2Declaration =
  | { baseMetric: string; op: { kind: 'refine' }; alias?; visibility?; filters?; target? }   // 现有，逐字保留
  | { op: { kind: 'expr'; expr: ExprNode }; alias?; visibility? }                            // 新增；无 filters/target
```

```ts
const ExprNodeSchema: z.ZodType<ExprNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('ref'), id: z.string().min(1).max(128) }).strict(),
    z.object({ kind: z.literal('num'), value: z.number().finite() }).strict(),
    z.object({ kind: z.enum(['add', 'sub', 'mul', 'div']), left: ExprNodeSchema, right: ExprNodeSchema }).strict(),
  ]),
)
```

- `refine` 支**逐字不动**（字段名、必填性、宽容度全不变）——它就是现有那个 object schema。
- `expr` 支**带 `.strict()`**：多带 `baseMetric` / `target` 任一 ⇒ `BAD_DECL`（400）。
  两个 member 的宽容度**故意不同**（refine 去宽、expr 从严），互不影响——union 是按 member 各自校验的。
- **`filters` 是唯一例外**：expr 支**声明**它为 optional，但编译器立刻以 `OP_UNSUPPORTED` 拒（§2.5）。
  宁可「声明了再拒」也不并进 `.strict()` 的 `BAD_DECL`——因为调用方多半是**从 refine 声明拷来**的，
  要给的信号是「**这个 op 还不支持 filters**」而不是「**不认识这个键**」；顺带把后一增量的落点标出来。
- 判别键是 `op.kind`：两支的 `op` 都有该键且字面量互斥 ⇒ 不会歧义匹配。

### 3.2 两个 write 面的兼容（非破坏）

| 面 | 现状 | 改后 | 兼容性 |
|---|---|---|---|
| **HTTP** `routes/metrics.ts` `L2Body` | `{id, baseMetric, op:{kind:'refine'}, …}` | 判别式 union：refine 支原样；expr 支 `{id, op:{kind:'expr', expr}}` | refine 调用方**零改动** |
| **MCP** `routes/mcp-metric-tools.ts` `CustomizeArgs` | `{id, baseMetric, alias?, visibility?, filters?}`，**面内硬编码** `op:{kind:'refine'}`（L119） | 判别式 union：`{id, baseMetric?, …}`（面注入 refine）**或** `{id, expr, alias?, visibility?}`（面注入 expr） | refine 调用方**零改动**；expr 为新增支 |

> MCP 面**不再能硬编码** `op.kind='refine'`（现 L119）——须按入参（有 `expr` 则 expr，否则 refine）归一。
> 这是本增补对 MCP 面的唯一实质改动点。

## 4. 编译与存储

### 4.1 产物形状不变，**无需新列**

expr 的编译产物与 refine 同形：`select <表达式> as value[, <可见维度>] from <关系>`——
只是 `<表达式>` 由「单条 L1 的 expression」换成「树的内联渲染」：

- `ref` → 该 L1 的 `parseL1Select().expression`（**逐字**，不重写口径）
- `num` → 数字字面量
- `add/sub/mul` → `(<左>) <op> (<右>)`；`div` → `(<左>) / NULLIF((<右>), 0)`

⇒ `data.metrics` 表**列不变**（声明 JSON 本就**不落库**，只存编译后的 `select_sql`/`group_by`）。
行字段：`title` = alias ?? 派生名；`description` = `L2 派生自 (<ref ids>)`；`subjectColumn` = 共享主体列；
`groupBy` = 生效可见维度（同 refine）；`params = {}`。

### 4.2 写路径改动：adopted 闸从「1 个 base」扩到「N 个 ref」

`metric-write.ts` 现只对**单个** base 校验 `sourceSystem ∈ adoptedSources`（403 `METRIC_SOURCE_NOT_ADOPTED`）。
expr 有 N 个 ref ⇒ 须**逐个**校验，任一未采用即拒，并在 `extra` 里**点名**缺哪个源（`{its_source, your_sources}`）。
> 注意：读侧不做二次校验——`select_sql` 已内联，**写时的 adopted 闸是 ref 的唯一闸门**（与 refine 同）。

## 5. 错误码

`CompileErrorCode` 扩展（`semantic-compiler.ts`）：

| 码 | 触发 | 新旧 |
|---|---|---|
| `L1_BASE_NOT_FOUND` | `ref.id` 未命中 L1 词表（message 点名该 ref） | 复用（语义同「该 id 不在 L1 词表」） |
| `MIXED_BASE` | refs 非同关系/同 grain/同主体列 | **新增** |
| `EXPR_DEPTH_EXCEEDED` | 树超深或 ref 超量 | **新增** |
| `OP_UNSUPPORTED` | expr 带 `filters`；未知 `op.kind` | 复用 |
| `BAD_DECL` | schema 层就不过（expr 支多带 `baseMetric`/`filters`/`target`；`num` 非有限数） | 复用 |
| `UNKNOWN_DIM` | `visibility.dims` 越出共享 grain | 复用 |

新增码须同时补进 `metric-write.ts` 的 `compileFailure` 映射（`MIXED_BASE`/`EXPR_DEPTH_EXCEEDED` → 400）。

## 6. 门禁与测试要求

1. **穷举可达集**：每个 node kind 编译出的片段只含 `[标识符 . ( ) + - * / 数字 NULLIF]`，且整体形如
   `<…> as value` + 合法 `from <关系>`（沿用 `semantic-compiler.test.ts` 的纯 SELECT 断言风格）。
2. **schema ↔ compiler 对偶**（T9 机检）：schema 拒的形状编译器也拒，反之亦然（防两处漂移）。
3. **随机树 fuzz**：在 schema 内随机生成 ≥1000 棵树，断言输出恒**不含** `FORBIDDEN_SQL_RE`。
4. **负例**：ref 非 L1 → `L1_BASE_NOT_FOUND`；跨粒度 refs → `MIXED_BASE`；越深/越量 → `EXPR_DEPTH_EXCEEDED`；
   expr+`filters` → `OP_UNSUPPORTED`；`num` 为 `NaN`/`Infinity` → schema 拒。
5. **端到端**：客单价 `div(ref:net_sales, ref:order_count)` 编译结果与手写期望 SQL **逐字相等**。
6. **门禁③**（§10 拍板 6 明列）：机检范围须**覆盖 expr 声明**。

## 7. 边界（本增补**不做**）

- **原子测度**（如「退货额」）：仍须先进 `dbt/semantics/l1_metrics.yml` 走 L1——本增补只放开**组合**。
- **expr 上的 `filters`**：v1 禁（§2.5），后一增量再做「每 ref 一列」派生表。
- **函数/条件/比较/聚合**：不开放（§2.2）。
- **L2 引 L2**：不开放（§2.6）。
- **console 表达式构建器 UI**：可后置（前端），不在本增补的必交范围。
- **agent 接入面**：拍板 6 已标「另题不在本轮」。

## 8. 与其它 issue 的关系

- **#573**（shanhai 首批指标登记）：**部分解锁**——「两 L1 之比」（客单价）**当场可定义**；
  但「退货率」仍缺 L1「退货额」⇒ 那部分仍卡在 L1/湖列。
- **#176**（同一拍板的**写权限**轴）：**另一条轴**，本增补是**表达力**轴，二者不重叠。
- **#300**（L1 事实源分叉）：乙路**不以 #300 为前置**（甲路才是）。
- **#389**（已合：语义源维度/词表裁剪/写入闸）：本增补的实现面来处。

## 9. 对 §10 的订正指向

- 在 `2026-09-21-…-design.md` §10 拍板记录第 5 条下加**指向注记**：订正为「= **B 中档（受限表达式）**」，
  消除「不止 A 薄档的四件事」的歧义表述，指向本文。
- 回填 `modules/data/domain/semantic-compiler.ts:18-21` 的实现注释指针指向本文。
