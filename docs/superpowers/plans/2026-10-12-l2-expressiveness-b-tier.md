# L2 表达力放开到 B 中档（受限表达式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> ⚠️ 本计划有几处文字与实现事实不符，已逐条订正 —— 见文末「实施期勘误（2026-10-12，实测订正）」。

**Goal:** 把 L2 声明从「只 `refine` 单条 L1」（A 薄档）放开到「用受限算术把多条 L1 组合成新测度」（B 中档），表达面是**可机检的算术树**而不是表达式字符串，并让门禁⑧同步覆盖这一档。

**Architecture:** 在 `modules/data/domain/semantic-compiler.ts` 内把 `L2Declaration` 改成以 `op.kind` 为判别键的**判别式 union**（`refine` 支逐字保留 + 新增 `expr` 支），`compileL2` 由「单函数」变成「**分派器 + 两个档位编译函数**」，产物多两个字段（`subjectColumn`/`description`）以免路由成为第二事实源；两个写面（HTTP / MCP）改成分支各自的 schema + 面级 union；`scripts/check-data-models.mjs` 的门禁⑧从「一份 schema ↔ 一份 interface」升级为「逐支 + union 级 + 节点集」四条子判定。**不新增文件**（原因见「为什么这样切」②）。

**Tech Stack:** TypeScript 5 / zod v3.23.0 / Hono / vitest v3.2.7 / pnpm workspaces；门禁是手写 Node 脚本（`scripts/check-data-models.mjs`，checkJs）。

---

## Global Constraints

**规格权威**：一切数值、码名、文案口径以人已批准的设计增补为准 ——
`docs/superpowers/specs/2026-10-12-l2-expressiveness-b-tier-design.md`（下称「增补」）。
本计划与增补冲突时**以增补为准并向人报告**，不得静默改计划。

**本仓硬约束（逐条都踩过）**：

- **声明即授权（fail-closed）**：模块 API 门卫由宿主按 manifest 施加；未声明的路径/方法一律 403。**本次不动 manifest / 不动路由集合**（不新增端点 ⇒ 无需改 `api.internal`；改了路由不改 manifest = 部署即挂）。
- **`compileL2` 必须保持 `export function` 声明**。门禁断言 `/export\s+function\s+compileL2\b/`（`scripts/check-data-models.mjs:459`）；改成箭头函数 / `export const` 会同时让门禁与调用方一起失效。
- **桶文件 export 纪律**：本次**不新增/不修改任何 barrel**；若某个改动落到了 barrel 上，`export` 值清单里**绝不混入 `interface`/`type`**（#44 生产事故：Node ESM 运行时 SyntaxError，typecheck 与单测都拦不住）。
- **架构先行**：本次是**已批准的架构增补**（增补 §1 裁决）⇒ 授权已具备。**不得顺手改**服务拆分 / 技术栈 / 数据流向 / 存储方案 —— `data.metrics` 表**列不变**（增补 §4.1：声明 JSON 本就不落库）。
- **数据库迁移纪律**：本次**不含迁移**。若实施中发现需要加列，**停下来问人**（属于架构变更）。
- **敏感值**：不写明文、不复述密钥；命令输出不得回显密钥。本计划所有凭据都只写「在哪、怎么取」。
- **shell 里 `$VAR` 紧跟中文必须写 `${VAR}`**（本机 bash 3.2 会把中文吃进变量名；本仓中文文案多，一天咬两次）。
- **工作树路径含中文**：本仓库当前工作树路径含非 ASCII。已知两种打挂机制（issue #203）：vite 不解码 `pathToFileURL`、`.pathname`→`readdir` ENOENT 让 `runMigrations` **静默空转**。**本项目实测 `pnpm --filter data exec vitest run <文件>` 可用**（vitest v3.2.7）；受影响的是 `runMigrations` / 动态 import 路径，本次不碰。若遇到诡异空转，**先换纯 ASCII 工作树**再排。
- **提交纪律**：Conventional Commits，`<type>(<scope>): <一句话>`，**一次提交只写一个 scope**；feat/fix 必须先有 issue（本计划 = issue **#576**）；可见变更必须走 PR；**合并只等 CI CLEAN**（UNSTABLE 强合出过生产 502）。
- **开工前先 `git fetch origin main`，分支从 fetch 过的 `origin/main` 新建**（本仓多工作树并行，本地 main 会脱节；`Orca --base-branch main` 取的是本地 ref）。
- **计划与真机冲突时先向人裁决，不静默改计划**；偏离必须写进报告。

**推前门禁（逐条跑，别挑）**：

- `pnpm typecheck`（含 `typecheck:scripts` —— **`scripts/` 是 checkJs**，JSDoc 字面量类型会被加宽，只有它能拦住守卫脚本的类型错）
- `pnpm test`（**含 `test:guard`**，即 `scripts/*.test.*` —— 门禁⑧ 的用例在这里）
- `ls scripts/check-*.mjs` 列出的**全部**守卫脚本（正典清单在 `README.md §常用命令`，**别凭记忆列**）。本次直接相关的三条：`node scripts/check-data-models.mjs`（门禁⑧所在）、`node scripts/check-compose.mjs`、`node scripts/check-env-example.mjs`
- 纪律脚本与 `main-guard`（CI 的 `discipline` / `main-guard` job）
- 单跑一个测试文件：`pnpm --filter data exec vitest run <相对仓库根的路径>`

> ⚠️ **本机「全量门禁」不等于 CI gates**：`pnpm test` + `pnpm test:guard` 只是守卫的**单测**；推前必须把上面八条 `check-*` 与纪律脚本真跑一遍（记忆：`local-full-gate-approximation-misses-ci`）。

**术语**（本计划里一律这样用）：

- **L1** = 平台词表指标行（`data.metrics` 里 `source='l1'`），**原子测度只能走 L1**。
- **refine / A 薄档** = 现有档位（裁剪 / 别名 / 过滤 / 目标值）。
- **expr / B 中档** = 新增档位（受限算术组合多条 L1）。
- **节点 / node** = 表达式树的一个节点，kind ∈ `{ref, num, add, sub, mul, div}`。
- **到达 SQL 集合** = 编译器在合法声明下能产出的 `selectSql` 全集。

---

## 为什么这样切（关键设计决定，实施者必读）

### ① Task 1 不可再分（这是本计划最重要的一条）

门禁⑧-b 断言：**schema 侧的 `op.kind` 接受集与编译器侧的接受集逐字相等**（`sameSet`）。
⇒ 如果先落「union 声明（schema 接受 `expr`）」而编译器仍只认 `refine`，门禁**立刻红**（接受集 = `['expr','refine']` vs `['refine']`）。
⇒ 反过来也一样。**所以 union 声明与 expr 编译路径必须在同一次提交里落地**，不是一个可拆的工程偏好，是门禁的设计后果。

同理：`pnpm test` 含 `test:guard`，门禁⑧ 对**真实文件**（不是 fixture）断言 ⇒ 任何「先改 schema、后改编译器」的中间态都会红。

### ② 不新增文件

L2 声明的**唯一事实源**必须与**唯一编译点**同文件 —— 这正是门禁⑧-a 在检查的事（它从 `semantic-compiler.ts` 同文件里同时取 schema 与 compiler）。把 `expr` 拆到 `expr-compiler.ts` 会让「声明 ↔ 编译」跨文件，门禁⑧ 要么失效要么被迫改成跨文件扫描（放宽）。**不拆。**

同理不拆 expr 与 refine 的 schema：两支共用 `filters` 形状、共用 `visibility` 形状，拆开就是三份 `z.enum(['=', 'in'])` 需要同步。

### ③ 产物加两个字段，而不是让路由自己挑

`compileL2` 的返回从 `{selectSql, title, groupBy}` 扩成 5 字段（+`subjectColumn` +`description`）。
理由（增补 §4.1）：expr 的基是**树里多个** ref，路由拿不到「那一个 base」；若让路由自己挑一个来继承主体列 / 拼派生关系，就有了**第二个事实源**（refine 支的 `description` 是 `L2 派生自 <id>`，expr 支是 `L2 派生自 (<id>, <id>)` —— 两种形状）。
⇒ 路由只做「编译产物 → 落库」，**不再自己推导任何字段**。refine 支这两个字段的取值**逐字等于**原来路由算出来的值（`compiled.description` = `` `L2 派生自 ${base.id}` ``，`compiled.subjectColumn` = `base.subjectColumn`）⇒ 对外行为零变化。

### ④ 增补 §5 与代码的一处分叉（照实说明，别"顺手补"）

增补 §5 末句：「新增码须同时补进 `metric-write.ts` 的 `compileFailure` 映射（`MIXED_BASE`/`EXPR_DEPTH_EXCEEDED` → 400）」。
**实况**：`metric-write.ts:66-70` 的 `compileFailure` 已经是
`e.code === 'BAD_BASE_SQL' ? {http:500, error:'L1_BASE_SQL_INVALID'} : {http:400, error: e.code}` ——
即**任何非 `BAD_BASE_SQL` 的码都已经是 400**。⇒ 两个新码**天然**映射到 400，**不需要任何代码改动**。
本计划按实况执行（不加冗余分支），并把这条分叉写进 Task 1 的报告。

### ⑤ 增补 §3.1 散文 vs §5 表格的冲突裁决（已定，实施者照此）

增补 §3.1 说 expr 支**声明** `filters` 为 optional、编译器立刻以 `OP_UNSUPPORTED` 拒；§5 表格里 `BAD_DECL` 那一行却把「expr 支多带 `filters`」也算作 `BAD_DECL`。
**裁决（以 §3.1 散文为准，理由：它是解释性的、写了 why）**：

- expr 支 schema **声明** `filters?`（与 refine 同形）；
- 编译期的**判别谓词是「声明了」而不是「非空」** —— `decl.filters !== undefined` 就拒，**包括 `filters: []`**。理由：「声明了却什么都不做」比拒绝更难查（调用方以为切片生效了）。
- 因此 `L2ExprDeclaration` 接口**必须**有 `filters?`（门禁⑧-c 要求 schema/interface 字段面逐键对齐；若接口不写 `filters?`，⑧-c 立刻红）。

### ⑥ 面级 schema 拒绝 ≠ 编译期码（两个不同层，别混）

- **面级**（`routes/metrics.ts` 的 `L2Body.safeParse` / MCP 的 `CustomizeArgs.safeParse`）失败 ⇒ 一律 `400 INVALID_BODY`（现有行为，不变）。
- **编译期**（`compileL2` 抛 `SemanticCompileError`）⇒ 经 `compileFailure` ⇒ `400` + `error` = **错误码本身**（如 `MIXED_BASE`）。
⇒ 「`op.kind` 不认识」在**面级**是 `INVALID_BODY`（union 两支都不匹配），在**编译期**是 `OP_UNSUPPORTED`。两条路都到 400，但 `error` 字段不同 —— 写用例时别把两者混为一谈。

### ⑦ README:137 属于 Task 1（不是文档收口）

`modules/data/README.md:137` 写着「`op` 由工具面固定为 `refine`」。Task 1 落地的一瞬间这句话就**变假**。
⇒ 它的修正**跟着 Task 1 走**（不能留到 Task 3）——同一提交里改，否则 Task 1 的评审会（正确地）判为「文档与代码不一致」。

### ⑧ 增补 §9 的两处指针，代码侧那处也属于 Task 1

增补 §9 要求两处指针：(a) `2026-09-21-…-design.md` §10 拍板记录 第 5 条下的指向注记（**文档侧**）；(b) 回填 `semantic-compiler.ts:18-21` 的实现注释（**代码侧**）。
(b) 所在的文件正是 Task 1 重写的文件，且改动后该注释**当即变假**（它写着「B 中档不在 v1」）⇒ **跟 Task 1 走**。(a) 留在 Task 3。

---

## 文件结构（无新增文件）

| 文件 | 责任 | 本次改动 |
|---|---|---|
| `modules/data/domain/semantic-compiler.ts` | L2 声明的形状（唯一事实源）+ 唯一编译点 | 加 `ExprNode`/`ExprNodeSchema`/`L2RefineDeclarationSchema`/`L2ExprDeclarationSchema`/union；`compileL2` 变分派器；新增 `compileRefine`/`compileExpr`/`renderExprNode`/`scanExpr`/`collectRefIds`/`assertCleanDims`/`visibleDimsOf`；`CompiledL2`；两个新错误码；`FORBIDDEN_SQL_RE` 导出；`:18-21` 指针回填 |
| `modules/data/domain/metric-write.ts` | 写路径的判定链（唯一一份，HTTP 面与 MCP 面共用） | adopted 闸 1 base → N ref（`collectRefIds`）；行字段改读编译产物 |
| `modules/data/routes/metrics.ts` | HTTP 写面 | `:27` import；`:33-40` 注释；`:41` `L2Body` 改两层 union |
| `modules/data/routes/mcp-metric-tools.ts` | MCP 写面 | `CustomizeArgs` 改两层 union；`inputSchema` 加 `expr`；`op` 归一不再硬编码 refine；工具描述更新（**保留** `不能凭空造新指标` 子串） |
| `modules/data/console/lib/api.ts` | console 错误码文案 | 追加 3 个新码（`BAD_DECL` 若已有则跳过） |
| `modules/data/README.md` | 模块自述 | `:137` 修正（Task 1）；`:41` + 已知边界（Task 3） |
| `scripts/check-data-models.mjs` | 门禁（含⑧） | ⑧ 升级为四条子判定（含 ⑧-d 节点集对偶） |
| `scripts/check-data-models.test.ts` | 门禁⑧ 的 T9 用例 | 七个既有用例重锚 + 合成源改写；新增 3 条 |
| `modules/data/domain/semantic-compiler.test.ts` | 域层用例 | 新增 expr 档 describe 块；16 处 `compileL2(base,` → `compileL2([base],`；`standinBase` 返回类型 |
| `modules/data/domain/metric-write.test.ts` | 写路径单测 | 见 Task 1 Step 12 / Task 2 |
| `modules/data/routes/metrics.test.ts` | HTTP 面用例 | 改写 1 条既有（`:196-200`）+ 新增 expr 正例与 adopted 闸 |
| `modules/data/routes/mcp-manage.test.ts` | MCP 面用例 | 新增 expr customize 用例 |
| `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md` | 正典（只加指向注记，不删改原文） | Task 3 |

---

## Task 1: 域层 B 中档（union 声明 + expr 编译 + 门禁⑧同步 + 两个写面 + console 文案 + README）

**Files:**
- Modify: `modules/data/domain/semantic-compiler.ts`
- Modify: `modules/data/domain/metric-write.ts`
- Modify: `modules/data/routes/metrics.ts`（只动 `:27` / `:33-40` / `:41`）
- Modify: `modules/data/routes/mcp-metric-tools.ts`
- Modify: `modules/data/console/lib/api.ts`
- Modify: `modules/data/README.md:137`
- Modify: `scripts/check-data-models.mjs`
- Test: `modules/data/domain/semantic-compiler.test.ts`, `modules/data/routes/metrics.test.ts`, `modules/data/routes/mcp-manage.test.ts`, `modules/data/domain/metric-write.test.ts`, `scripts/check-data-models.test.ts`

**Interfaces:**
- Consumes: 无（本任务是第一波）
- Produces（后续任务只依赖这些名字与类型，**逐字**）：
  - `export type ExprNode = { kind: 'ref'; id: string } | { kind: 'num'; value: number } | { kind: 'add' | 'sub' | 'mul' | 'div'; left: ExprNode; right: ExprNode }`
  - `export const ExprNodeSchema: z.ZodType<ExprNode>`
  - `export interface L2RefineDeclaration { baseMetric: string; op: { kind: 'refine' }; alias?: string; visibility?: { dims: string[] }; filters?: { dim: string; op: '=' | 'in'; values: string[] }[]; target?: number }`
  - `export interface L2ExprDeclaration { op: { kind: 'expr'; expr: ExprNode }; alias?: string; visibility?: { dims: string[] }; filters?: { dim: string; op: '=' | 'in'; values: string[] }[] }`
  - `export type L2Declaration = L2RefineDeclaration | L2ExprDeclaration`
  - `export const L2RefineDeclarationSchema`（非 strict，宽容度同旧 `L2DeclarationSchema`）
  - `export const L2ExprDeclarationSchema`（strict）
  - `export const L2DeclarationSchema = z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])`
  - `export interface CompiledL2 { selectSql: string; title: string; description: string; subjectColumn: string; groupBy: string }`
  - `export function compileL2(l1Catalog: readonly MetricRow[], decl: L2Declaration): CompiledL2`
  - `export function renderExprNode(node: ExprNode, refExpr: ReadonlyMap<string, string>): string`
  - `export function collectRefIds(decl: L2Declaration): string[]`
  - `export const FORBIDDEN_SQL_RE: RegExp`
  - `export type CompileErrorCode = … | 'MIXED_BASE' | 'EXPR_DEPTH_EXCEEDED'`

---

- [ ] **Step 0: 前置 —— 从 fetch 过的 `origin/main` 新建工作分支**

```bash
git fetch origin main
git switch -c feat/576-l2-expr-b-tier origin/main
git log --oneline -3
```

Expected: 新分支的 HEAD 是 `origin/main` 的最新提交（不是本工作树里那份可能脱节的本地 `main`）。
**若本计划文件不在新分支上**：`git switch docs/574-l2-expressiveness-b-tier` 把本计划先提交/合并（PR #575），再回到本步骤。

> 本任务对应 issue **#576**；PR body 写 `Closes #576`（`Refs` 不算）。
> `#575` 是「spec + 本计划」的文档 PR，与本任务不是一个 PR。

---

- [ ] **Step 1: 先写失败用例（域层 expr 档）**

在 `modules/data/domain/semantic-compiler.test.ts` **文件末尾**追加下面这个 `describe` 块（不要动既有用例）。
它用了文件里既有的 `standinBase()`，并额外引入 `ExprNode` / `collectRefIds` / `compileL2` 等新导出。

先在文件顶部的 import 里补上新符号（**保留**现有 `import type { MetricDef }`，它还被 `authorizeLike` 用着）：

```ts
import {
  compileL2, collectRefIds, renderExprNode, FORBIDDEN_SQL_RE,
  type ExprNode, type L2Declaration,
} from './semantic-compiler'
```

然后追加：

```ts
describe('L2 · B 中档（受限表达式）', () => {
  const base = standinBase()
  // 第二条 L1 必须是「同关系 / 同 grain / 同主体列」的克隆 —— 只换 id。
  const catalog = [base, { ...base, id: 'standin:clone' }]

  /** 取抛出的错误码与消息；不抛返回 {}（期望抛时它会自然让断言失败）。 */
  const errorOf = (fn: () => unknown): { code?: string; message?: string } => {
    try {
      fn()
    } catch (e) {
      const err = e as { code?: string; message?: string }
      return { code: err.code, message: err.message }
    }
    return {}
  }

  const ref = (id: string): ExprNode => ({ kind: 'ref', id })

  it('div(ref, ref) ⇒ 除法守卫由编译器注入（NULLIF，0 分母得 NULL）；title/description/subjectColumn 来自编译产物', () => {
    const out = compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'div', left: ref(base.id), right: ref('standin:clone') } },
    })
    expect(out.selectSql).toContain('NULLIF(')
    expect(out.selectSql).toContain(' as value')
    expect(out.selectSql).toContain(' from ')
    expect(out.title).toBe(`派生(${base.id} / standin:clone)`)
    expect(out.description).toBe(`L2 派生自 (${base.id}, standin:clone)`)
    expect(out.subjectColumn).toBe(base.subjectColumn)
  })

  it('alias 优先于派生名', () => {
    const out = compileL2(catalog, {
      alias: '客单价',
      op: { kind: 'expr', expr: ref(base.id) },
    })
    expect(out.title).toBe('客单价')
  })

  it('同一 ref 出现两次 ⇒ 只解析一次、渲染成同一段 expression（title 里也只出现一次）', () => {
    const out = compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(base.id) } },
    })
    expect(out.title).toBe(`派生(${base.id})`)
    expect(out.description).toBe(`L2 派生自 (${base.id})`)
  })

  it('ref 未命中 L1 词表 ⇒ L1_BASE_NOT_FOUND（message 点名该 ref）', () => {
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: ref('no:such:l1') } }))
    expect(got.code).toBe('L1_BASE_NOT_FOUND')
    expect(got.message).toContain('no:such:l1')
  })

  it('refs 跨主体列 ⇒ MIXED_BASE（点出两侧的主体列）', () => {
    const other = { ...base, id: 'standin:other-subject', subjectColumn: `${base.subjectColumn}_x` }
    const got = errorOf(() => compileL2([...catalog, other], {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(other.id) } },
    }))
    expect(got.code).toBe('MIXED_BASE')
    expect(got.message).toContain(other.id)
  })

  it('refs 跨 grain（同关系、同主体列）⇒ MIXED_BASE', () => {
    const other = { ...base, id: 'standin:other-grain', groupBy: `${base.groupBy}, extra_dim` }
    const got = errorOf(() => compileL2([...catalog, other], {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(other.id) } },
    }))
    expect(got.code).toBe('MIXED_BASE')
    expect(got.message).toContain('grain')
  })

  it('纯字面量 expr ⇒ BAD_DECL（拼不出 from 子句）', () => {
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: { kind: 'num', value: 1 } } }))
    expect(got.code).toBe('BAD_DECL')
  })

  it('表达式树深 9（上限 8 层）⇒ EXPR_DEPTH_EXCEEDED', () => {
    let deep: ExprNode = ref(base.id)
    for (let i = 0; i < 8; i++) deep = { kind: 'add', left: deep, right: { kind: 'num', value: 1 } }
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: deep } }))
    expect(got.code).toBe('EXPR_DEPTH_EXCEEDED')
    expect(got.message).toMatch(/表达式树深 9/)
  })

  it('ref 出现 17 次（上限 16）⇒ EXPR_DEPTH_EXCEEDED；树很浅 ⇒ 证明计数的是"出现次数"而不是深度', () => {
    const balanced = (leaves: number): ExprNode => leaves === 1
      ? ref(base.id)
      : {
        kind: 'add',
        left: balanced(Math.floor(leaves / 2)),
        right: balanced(leaves - Math.floor(leaves / 2)),
      }
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: balanced(17) } }))
    expect(got.code).toBe('EXPR_DEPTH_EXCEEDED')
    expect(got.message).toMatch(/ref 出现 17 次/)
  })

  it('expr 声明带 filters ⇒ OP_UNSUPPORTED —— 空数组也算"声明了"', () => {
    const got = errorOf(() => compileL2(catalog, {
      op: { kind: 'expr', expr: ref(base.id) },
      filters: [],
    }))
    expect(got.code).toBe('OP_UNSUPPORTED')
  })

  it('num 非有限数 ⇒ BAD_DECL（面级 schema 也拒，见 Task 2 的对偶用例）', () => {
    const got = errorOf(() => compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'num', value: Number.NaN } },
    }))
    expect(got.code).toBe('BAD_DECL')
  })

  it('未知节点 kind ⇒ BAD_DECL（fail-closed，不许静默跳过）', () => {
    const pow = { kind: 'pow', left: ref(base.id), right: { kind: 'num', value: 2 } } as unknown as ExprNode
    expect(errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: pow } })).code).toBe('BAD_DECL')
  })

  it('未知 op.kind ⇒ OP_UNSUPPORTED（分派器兜底；面级会先以 INVALID_BODY 拦下，这是绕过面级的防线）', () => {
    const bogus = { op: { kind: 'aggregate' } } as unknown as L2Declaration
    expect(errorOf(() => compileL2(catalog, bogus)).code).toBe('OP_UNSUPPORTED')
  })

  it('非对象声明 ⇒ BAD_DECL', () => {
    expect(errorOf(() => compileL2(catalog, null as unknown as L2Declaration)).code).toBe('BAD_DECL')
  })

  it('collectRefIds：refine 取 baseMetric；expr 去重保序；形状不对返回 []（不抛）', () => {
    expect(collectRefIds({ baseMetric: base.id, op: { kind: 'refine' } })).toEqual([base.id])
    expect(collectRefIds({
      op: {
        kind: 'expr',
        expr: { kind: 'add', left: ref('a'), right: { kind: 'div', left: ref('b'), right: ref('a') } },
      },
    })).toEqual(['a', 'b'])
    expect(collectRefIds({} as unknown as L2Declaration)).toEqual([])
  })

  it('renderExprNode 逐节点：只有字面量渲染该点的片段，除零守卫在 div 上', () => {
    const refs = new Map([['a', 'sum(t.x)'], ['b', 'sum(t.y)']])
    expect(renderExprNode({ kind: 'num', value: 3 }, refs)).toBe('3')
    expect(renderExprNode(ref('a'), refs)).toBe('sum(t.x)')
    expect(renderExprNode({ kind: 'add', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) + (2)')
    expect(renderExprNode({ kind: 'sub', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) - (2)')
    expect(renderExprNode({ kind: 'mul', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) * (2)')
    expect(renderExprNode({ kind: 'div', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) / NULLIF((2), 0)')
    // ref 解析表缺项 ⇒ fail-closed（不是静默出空串）
    expect(errorOf(() => renderExprNode(ref('missing'), refs)).code).toBe('BAD_DECL')
  })

  it('expr 产物不含任何 DDL/DML 关键字（B 中档的安全属性，见 FORBIDDEN_SQL_RE）', () => {
    const out = compileL2(catalog, {
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: ref(base.id), right: { kind: 'mul', left: ref('standin:clone'), right: { kind: 'num', value: 2 } } },
      },
    })
    expect(out.selectSql).not.toMatch(FORBIDDEN_SQL_RE)
  })
})
```

- [ ] **Step 2: 跑测试确认红**

```bash
pnpm --filter data exec vitest run modules/data/domain/semantic-compiler.test.ts
```

Expected: **FAIL** —— 编译期就有错（`ExprNode` / `collectRefIds` / `renderExprNode` / `FORBIDDEN_SQL_RE` 都还不存在），或全红在 `compileL2` 签名不符（当前是 `(base: MetricDef, decl)`）。
**这一步的意义**：确认用例真的在测新东西，不是恒真。

---

- [ ] **Step 3: 实现 `semantic-compiler.ts`**

按下面的顺序改**同一个文件**。每一步都给了锚点与目标文本。

**3a. 头部 `:18-21` 的档位注释（增补 §9(b) 的指针回填 + 消除假述）**

把这一整块注释（从 `── v1 的表达力档位` 起、到「要放开，走 spec 增补。」止）替换为：

```ts
// ── 表达力档位（**别私自放宽**）───────────────────────────────────────────────
// 两档：`op.kind = 'refine'`（A 薄档：裁剪 / 别名 / 过滤 / 目标值）
// 与 `op.kind = 'expr'`（B 中档：受限算术组合多条 L1）。C 厚档仍排除。
// **B 中档的允许面以这份增补为准**（它同时订正了正典 §10 拍板 5 下本注释旧有的「写权限」读法）：
// docs/superpowers/specs/2026-10-12-l2-expressiveness-b-tier-design.md
// 再加档位要**先改那份增补**：档位不许先在码里放开。
```

**3b. `CompileErrorCode`：在联合末尾追加两码**

在 `CompileErrorCode` 联合的**最后一项**之后追加（既有各码及其注释**一行都不动**）：

```ts
  // expr 档新增：参与运算的 refs 不在同一关系/grain/主体列上
  | 'MIXED_BASE'
  // expr 档新增：树超深或 ref 出现次数超量
  | 'EXPR_DEPTH_EXCEEDED'
```

**3c. `L2Declaration` 接口：改成两支的显式 interface + union**

把现有 `export interface L2Declaration { … }` 整块（6 字段那版）替换为下面三块。
**注意**：两个 interface 必须**显式写在本文件顶层**、**一个键一行**（门禁⑧-c 的 `topLevelKeys` 按行读 depth-1 键；用 `extends z.infer<…> {}` 这类推导形式会得到**零个**键 ⇒ 门禁红）。

```ts
/**
 * A 薄档（refine）的声明形状。**字段面与旧 `L2Declaration` 逐字相同**（这次只换名字）。
 */
export interface L2RefineDeclaration {
  baseMetric: string
  op: { kind: 'refine' }
  alias?: string
  visibility?: { dims: string[] }
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
  target?: number
}

/**
 * B 中档（expr）的声明形状：用受限算术把**多条 L1** 组合成新测度。
 *
 * `filters?` **在这里，是故意的**（增补 §3.1）：声明了再由编译器以 `OP_UNSUPPORTED` 拒 ——
 * 调用方多半是从 refine 声明拷来的，要给的信号是「这个 op 还不支持 filters」，
 * 而不是「不认识这个键」。空数组也算「声明了」。
 */
export interface L2ExprDeclaration {
  op: { kind: 'expr'; expr: ExprNode }
  alias?: string
  visibility?: { dims: string[] }
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
}

/**
 * L2 声明：以 `op.kind` 为判别键的**判别式 union**。
 * 两支的 `op.kind` 字面量互斥 ⇒ 不会歧义匹配；union **按各自 member** 校验宽容度
 * （refine 去宽、expr 从严），互不影响。
 */
export type L2Declaration = L2RefineDeclaration | L2ExprDeclaration
```

**3d. `ExprNode` 类型 + 节点 schema（放在两个 interface 之后、refine schema 之前或之后都行，但必须满足 3e 的顺序要求）**

```ts
/**
 * 表达式节点（增补 §2.2，**闭集**）。
 *
 * 为什么不给函数名 / 不给字符串表达式：节点集**就是**「能产生什么 SQL」的词表 ——
 * 它等于 zod schema 本身，可以被单测穷举断言；换成表达式字符串就是把「禁任意 SQL」
 * 这条安全属性换成「解析器恰好正确」这条赌注（增补 §2.1）。
 * 除零守卫由编译器注入（见 `renderExprNode`），不作为租户可选项 —— 少一个校验面。
 */
export type ExprNode =
  | { kind: 'ref'; id: string }
  | { kind: 'num'; value: number }
  | { kind: 'add' | 'sub' | 'mul' | 'div'; left: ExprNode; right: ExprNode }
```

**3e. 两份 zod schema + union（顺序有硬要求，见下）**

把现有 `export const L2DeclarationSchema = z.object({ … })`（`baseMetric` 起、`target` 止的那块）替换为下面四块，**顺序不许换**：

```ts
/**
 * A 薄档的写时校验。**字段面与宽容度逐字保留**原 `L2DeclarationSchema` ——
 * 它就是那一份，只多了名字（非 strict：多余的键被 strip，与旧行为一致）。
 */
export const L2RefineDeclarationSchema = z.object({
  baseMetric: z.string().min(1).max(128),
  op: z.object({ kind: z.literal('refine') }),
  alias: z.string().min(1).max(128).optional(),
  visibility: z.object({ dims: z.array(z.string().min(1)).max(64) }).optional(),
  filters: z
    .array(z.object({
      dim: z.string().min(1),
      op: z.enum(['=', 'in']),
      values: z.array(z.string()).min(1),
    }))
    .max(64)
    .optional(),
  target: z.number().optional(),
})

/**
 * 表达式节点的 zod 形状。`z.lazy` 是递归 schema 的唯一写法（节点自引用）。
 * 每个成员 `.strict()`：多带任何键（如 `{kind:'ref', id:'x', fn:'sum'}`）都拒 ——
 * 节点集就是词表，词表外的键不该被静默 strip。
 */
export const ExprNodeSchema: z.ZodType<ExprNode> = z.lazy(() => z.union([
  z.object({ kind: z.literal('ref'), id: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('num'), value: z.number().finite() }).strict(),
  z.object({
    kind: z.enum(['add', 'sub', 'mul', 'div']),
    left: ExprNodeSchema,
    right: ExprNodeSchema,
  }).strict(),
]))

/**
 * B 中档的写时校验。与 refine 支**故意不同**：这里 `.strict()`（多带 `baseMetric`/`target` ⇒ 拒），
 * 但 `filters` **声明**为 optional —— 由编译器以 `OP_UNSUPPORTED` 拒（增补 §3.1，理由见 L2ExprDeclaration）。
 */
export const L2ExprDeclarationSchema = z.object({
  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),
  alias: z.string().min(1).max(128).optional(),
  visibility: z.object({ dims: z.array(z.string().min(1)).max(64) }).optional(),
  filters: z
    .array(z.object({
      dim: z.string().min(1),
      op: z.enum(['=', 'in']),
      values: z.array(z.string()).min(1),
    }))
    .max(64)
    .optional(),
}).strict()

/**
 * L2 声明的写时校验（**唯一事实源**）：按 `op.kind` 判别。
 * 用 union 而不是 `.extend()` 拼单支：ZodUnion 没有 `.extend()`，
 * 而且两支的宽容度不同，本来就必须分开校验。
 */
export const L2DeclarationSchema = z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])
```

> **顺序为什么是「refine → ExprNodeSchema → expr」**：门禁⑧-d 的 schema 侧窗口 = 从 `export const ExprNodeSchema` 到 `const L2ExprDeclarationSchema` 之间的文本。只有把 refine 的 schema 放在窗口**之前**，窗口里的 `kind:` 才**只有**节点集那 6 个（否则 `z.literal('refine')` 会混进节点集 ⇒ 门禁红）。

**3f. `FORBIDDEN_SQL_RE` 加 `export`**

把 `const FORBIDDEN_SQL_RE = …` 改成 `export const FORBIDDEN_SQL_RE = …`，并在其上方的注释里补一句：

```ts
// 导出是为了让测试能直接断言"编译产物永不含 DDL/DML 关键字"这条不变量（B 中档的随机树 fuzz 也用它）。
```

**3g. `assertCleanDims`：把 `compileL2` 里的 IDENT_RE 循环抽成共享函数**

在 `dimensionNamesOf` 之后加：

```ts
/**
 * 断言一份 grain 的每个维度都是干净标识符（授权层会把它**原样**拼进 GROUP BY）。
 * refine 与 expr 共用：两档的维度都来自 L1 行，而行可能是手写/历史行（不都是 sync 生成的）。
 * 返回维度列表，省掉调用方再查一次。
 */
function assertCleanDims(base: MetricDef): string[] {
  const dims = dimensionNamesOf(base)
  for (const d of dims) {
    if (!IDENT_RE.test(d)) {
      throw new SemanticCompileError('BAD_BASE_SQL', `L1 指标 \`${base.id}\` 的 group_by 里 \`${d}\` 不是合法列名`)
    }
  }
  return dims
}
```

（错误码与消息**逐字**取自原来 `compileL2` 里那一段。）

**3h. `visibleDimsOf`：可见维度裁剪抽成共享函数**

```ts
/**
 * 生效可见维度：省略 `visibility` = 继承 L1 全部维度；显式给（含空数组）= 按白名单，且只少不多。
 * 去重但保序（`[...new Set(...)]`）—— 重复维度不该出现在 GROUP BY 里两次。
 */
function visibleDimsOf(
  decl: Pick<L2Declaration, 'visibility'>,
  baseDims: readonly string[],
  baseId: string,
): string[] {
  if (decl.visibility === undefined) return [...baseDims]
  const dims = decl.visibility.dims.map((d) => {
    assertDim(d, baseDims, baseId)
    return d
  })
  return [...new Set(dims)]
}
```

**3i. `scanExpr` + 两个上限常量**

```ts
/** 规模上限（可调常量，与 schema 同文件 —— 增补 §2.7）。 */
const EXPR_MAX_DEPTH = 8
/** `ref` 的**出现次数**上限。注意：同一个 id 出现两次算两次（增补 §2.7 的「ref 总数」）。 */
const EXPR_MAX_REFS = 16

/**
 * 走一遍表达式树：形状校验 + 深度 + ref 去重/计数。**一遍做完**，且用显式栈 ——
 * 深树不会打爆调用栈（zod 那关可能先爆，那是另一条边界，见 README 已知边界）。
 *
 * 为什么形状校验也在这里（不是只靠 zod）：编译器的入参在**类型上**已经是 `L2Declaration`，
 * 但类型可以用 `as` 绕过，而 zod 只校验入口。编译器是拼 SQL 的地方，必须 fail-closed ——
 * 「面级拒绝」和「编译期拒绝」是两道，不是一道（见「为什么这样切」⑥）。
 *
 * 报错时机：**先走完整棵树再报量纲**，这样错误信息里带得出「实际多少」（比走到一半就抛更好排障）。
 */
function scanExpr(root: unknown): { refIds: string[]; refCount: number; depth: number } {
  const stack: { node: unknown; level: number }[] = [{ node: root, level: 1 }]
  const refIds: string[] = []
  const seen = new Set<string>()
  let refCount = 0
  let depth = 0

  while (stack.length > 0) {
    const top = stack.pop()
    if (top === undefined) break
    const node = top.node
    const level = top.level
    if (node === null || typeof node !== 'object') {
      throw new SemanticCompileError('BAD_DECL', `表达式节点不是对象：${typeof node}`)
    }
    depth = Math.max(depth, level)
    const kind = (node as { kind?: unknown }).kind

    if (kind === 'num') {
      const value = (node as { value?: unknown }).value
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SemanticCompileError('BAD_DECL', `表达式里的数字字面量必须是有限数，收到 \`${String(value)}\``)
      }
      continue
    }
    if (kind === 'ref') {
      const id = (node as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') {
        throw new SemanticCompileError('BAD_DECL', '表达式里的 ref 必须带非空 id')
      }
      refCount += 1
      if (!seen.has(id)) {
        seen.add(id)
        refIds.push(id)
      }
      continue
    }
    if (kind === 'add' || kind === 'sub' || kind === 'mul' || kind === 'div') {
      // LIFO ⇒ 先压 right 再压 left，弹出顺序才是 left → right（ref 次序可复现）
      stack.push({ node: (node as { right?: unknown }).right, level: level + 1 })
      stack.push({ node: (node as { left?: unknown }).left, level: level + 1 })
      continue
    }
    throw new SemanticCompileError('BAD_DECL', `表达式节点 kind 不在闭集内，收到 \`${String(kind)}\``)
  }

  if (refCount > EXPR_MAX_REFS) {
    throw new SemanticCompileError(
      'EXPR_DEPTH_EXCEEDED',
      `表达式里的 ref 出现 ${refCount} 次，超过上限 ${EXPR_MAX_REFS}（同一 id 出现两次算两次）`,
    )
  }
  if (depth > EXPR_MAX_DEPTH) {
    throw new SemanticCompileError('EXPR_DEPTH_EXCEEDED', `表达式树深 ${depth}，超过上限 ${EXPR_MAX_DEPTH}`)
  }
  return { refIds, refCount, depth }
}
```

**3j. `renderExprNode` + 算符表**

```ts
/** 二元算符 → SQL 拼写。**放在 renderExprNode 之外**：门禁⑧-d 只扫函数体，这里的 `add:` 之类不该混进 case 集。 */
const EXPR_OP_SQL: Record<'add' | 'sub' | 'mul', string> = { add: '+', sub: '-', mul: '*' }

/**
 * 表达式节点 → SQL 片段。**唯一渲染点**（树里每个字节都出自这里 ⇒ 可穷举断言）。
 *
 * `div` 的除零守卫由**编译器注入**：`(a) / NULLIF((b), 0)` ⇒ 0 分母得 NULL（不是 0 —— 0 会污染
 * 下游均值/累计）。租户看不到也控制不了它（增补 §2.4）。
 *
 * `switch` 是**穷尽的**：`default` 把 node 赋给 `never` ⇒ 节点集一改，typecheck 当场红
 * （这是「节点集是闭集」在类型层的落点，别删）。
 */
export function renderExprNode(node: ExprNode, refExpr: ReadonlyMap<string, string>): string {
  switch (node.kind) {
    case 'num':
      return String(node.value)
    case 'ref': {
      const expr = refExpr.get(node.id)
      if (expr === undefined) {
        throw new SemanticCompileError('BAD_DECL', `表达式引用了未解析的 L1 \`${node.id}\`（内部错误：ref 解析表缺项）`)
      }
      return expr
    }
    case 'add':
    case 'sub':
    case 'mul':
      return `(${renderExprNode(node.left, refExpr)}) ${EXPR_OP_SQL[node.kind]} (${renderExprNode(node.right, refExpr)})`
    case 'div':
      return `(${renderExprNode(node.left, refExpr)}) / NULLIF((${renderExprNode(node.right, refExpr)}), 0)`
    default: {
      const unknownNode: never = node
      throw new SemanticCompileError('BAD_DECL', `表达式节点 kind 不在闭集内：${JSON.stringify(unknownNode)}`)
    }
  }
}
```

> 三条纪律（都会让门禁/掩码出问题，别违反）：
> 1. 函数体里**不许**出现不平衡的 `{`/`}`（门禁用花括号配平取函数体）。
> 2. 字符串/模板字面量里**不许**出现 `//` 或 `/*`（`maskJsComments` 是 3 状态机，**不认识字符串**）。上面 ` / ` 两侧都有空格，是安全的。
> 3. 别在这里新增 `kind: z.literal(...)` 之类的 schema 片段。

**3k. `collectRefIds`**

```ts
/**
 * 一条声明用到的全部 L1 ref id（去重保序）—— 写路径的 adopted 闸按它**逐个**校验（增补 §4.2）。
 *
 * **宽容**：形状不对时返回 `[]` 而**不抛**。它服务于「先算闸、再编译」的顺序；形状错该由
 * schema / 编译器响亮地拒 —— 在这里抛会把一个 zod 该报的错伪装成编译错。
 */
export function collectRefIds(decl: L2Declaration): string[] {
  if (decl === null || typeof decl !== 'object') return []
  const op = (decl as { op?: unknown }).op
  const kind = (op !== null && typeof op === 'object') ? (op as { kind?: unknown }).kind : undefined
  if (kind === 'refine') {
    const base = (decl as { baseMetric?: unknown }).baseMetric
    return typeof base === 'string' ? [base] : []
  }
  if (kind !== 'expr') return []

  const stack: unknown[] = [(op as { expr?: unknown }).expr]
  const out: string[] = []
  const seen = new Set<string>()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    const nk = (node as { kind?: unknown }).kind
    if (nk === 'ref') {
      const id = (node as { id?: unknown }).id
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
      continue
    }
    if (nk === 'add' || nk === 'sub' || nk === 'mul' || nk === 'div') {
      stack.push((node as { right?: unknown }).right)
      stack.push((node as { left?: unknown }).left)
    }
  }
  return out
}
```

**3l. `CompiledL2`**

```ts
/**
 * 编译产物 = 行的**全部派生字段**（路由只负责落库，不再自己推导 —— 见「为什么这样切」③）。
 *
 * 比旧版多 `description` / `subjectColumn`：expr 的基是**树里多个** ref，路由拿不到「那一个 base」；
 * 让路由自己挑一个来继承主体列 / 拼派生关系，就有了第二个事实源。
 */
export interface CompiledL2 {
  selectSql: string
  title: string
  description: string
  subjectColumn: string
  groupBy: string
}
```

**3m. 把现有 `compileL2` 的函数体搬进 `compileRefine`，只做四处改动**

把现有 `compileL2` 的**文档注释以下、函数体以内**的内容整体搬到新的 `compileRefine` 里。**恰好**四处改动（其余逐字保留，包括 `filterSql` 的用法与派生表的形状）：

1. 签名与首行取基：
   ```ts
   /** A 薄档（refine）的编译。原 `compileL2` 的行为逐字保留。 */
   function compileRefine(l1Catalog: readonly MetricRow[], decl: L2RefineDeclaration): CompiledL2 {
     const base = resolveL1Base(l1Catalog, decl.baseMetric)
   ```
   （原来第一行是 `const base = …resolveL1Base(base, decl.baseMetric)` 之类从参数拿 base；现在 base 由 `resolveL1Base(l1Catalog, …)` 解析 —— **`resolveL1Base` 本就是「按 id 从词表取行」，没有新语义**。）
2. 原来的 `parseL1Select(base.selectSql)` 与「IDENT_RE 循环」两段合成：
   ```ts
     const shape = parseL1Select(base.selectSql)
     const baseDims = assertCleanDims(base)
     const visibleDims = visibleDimsOf(decl, baseDims, base.id)
   ```
   （原来的 `dims`/去重那几行被 `visibleDimsOf` 取代；`assertDim` 的调用搬进 `visibleDimsOf`。）
3. 两个 return 都补两个字段 —— **取值必须逐字等于原路由算出来的值**：
   ```ts
     const title = decl.alias ?? base.title
     const description = `L2 派生自 ${base.id}`
   ```
   无过滤支：
   ```ts
       return {
         selectSql: `select ${shape.expression} as value${dimSelect} from ${shape.relation}`,
         title,
         description,
         subjectColumn: base.subjectColumn,
         groupBy: visibleDims.join(', '),
       }
   ```
   有过滤（派生表）支：
   ```ts
       return {
         selectSql: `select sum(t.value) as value${outerDims} from (${innerSelect}) t`,
         title,
         description,
         subjectColumn: base.subjectColumn,
         groupBy: visibleDims.join(', '),
       }
   ```
   （`dimSelect` / `innerSelect` / `outerDims` / `where` 的拼法与原来完全一致。）

**3n. `compileExpr`**

```ts
/**
 * B 中档（expr）的编译。
 *
 * 产物形状与 refine **同形**：`select <树> as value[, 可见维度] from <关系>` ——
 * 只是 `<表达式>` 由「单条 L1 的 expression」换成「树的内联渲染」（增补 §4.1，表列不变）。
 */
function compileExpr(l1Catalog: readonly MetricRow[], decl: L2ExprDeclaration): CompiledL2 {
  // ① filters 是 v1 已知边界（增补 §2.5）。判据是「**声明了**」而不是「非空」：
  //    空数组也拒 —— 「声明了却什么都不做」比拒绝更难查（调用方以为切片生效了）。
  if (decl.filters !== undefined) {
    throw new SemanticCompileError(
      'OP_UNSUPPORTED',
      'expr 声明暂不支持 filters（v1 边界）：比例/比率不可加，对派生表重聚合 sum 是错的'
      + '（增补 §2.5）—— 请先在 L1 侧切片',
    )
  }

  // ② 形状 + 量纲闸（一遍走完；越深/越量在这里响亮拒绝）
  const { refIds } = scanExpr(decl.op.expr)

  // ③ 逐个 ref 解析 + 同基校验（关系 / grain / 主体列 三者逐字相等）
  const firstId = refIds[0]
  if (firstId === undefined) {
    // 只有字面量的树（如 num:3）拼不出 from 子句 —— 这不是 MIXED_BASE 也不是词表问题
    throw new SemanticCompileError('BAD_DECL', 'expr 至少要引用一条 L1（只有字面量时算不出关系，拼不出 from 子句）')
  }
  const first = resolveL1Base(l1Catalog, firstId)
  const sharedShape = parseL1Select(first.selectSql)
  const sharedDims = assertCleanDims(first)
  const refExpr = new Map<string, string>([[first.id, sharedShape.expression]])

  for (const id of refIds.slice(1)) {
    const other = resolveL1Base(l1Catalog, id)
    const otherShape = parseL1Select(other.selectSql)
    const otherDims = assertCleanDims(other)
    if (
      otherShape.relation !== sharedShape.relation
      || otherDims.join(', ') !== sharedDims.join(', ')
      || other.subjectColumn !== first.subjectColumn
    ) {
      throw new SemanticCompileError(
        'MIXED_BASE',
        `表达式的 ref 不在同一基上 —— \`${first.id}\`(关系 ${sharedShape.relation} / grain ${sharedDims.join(', ')} / 主体列 ${first.subjectColumn})`
        + ` vs \`${other.id}\`(关系 ${otherShape.relation} / grain ${otherDims.join(', ')} / 主体列 ${other.subjectColumn})：`
        + '跨关系 / 跨粒度 / 跨主体列拼不出合法且有意义的 SELECT（例如跨粒度的比值，分母是另一粒度的部分和）',
      )
    }
    refExpr.set(other.id, otherShape.expression)
  }

  const visibleDims = visibleDimsOf(decl, sharedDims, first.id)
  const dimSelect = visibleDims.length > 0 ? `, ${visibleDims.join(', ')}` : ''
  return {
    selectSql: `select ${renderExprNode(decl.op.expr, refExpr)} as value${dimSelect} from ${sharedShape.relation}`,
    title: decl.alias ?? `派生(${refIds.join(' / ')})`,
    description: `L2 派生自 (${refIds.join(', ')})`,
    subjectColumn: first.subjectColumn,
    groupBy: visibleDims.join(', '),
  }
}
```

**3o. `compileL2` 变分派器（保持 `export function` 声明！）**

```ts
/**
 * L2 声明的唯一编译点：按 `op.kind` 分派到档位编译函数。
 *
 * ★ 判别键**两段式读**：`decl.op` 在类型上一定有，但**运行时**可能不是对象
 *   （调用方 `as` 绕过 / 历史数据）⇒ 读之前先收形状，不能直接点。
 * ★ 这里**只**分派，不编译 —— 每个档位的产物形状由它自己的函数负责。
 */
export function compileL2(l1Catalog: readonly MetricRow[], decl: L2Declaration): CompiledL2 {
  if (decl === null || typeof decl !== 'object') {
    throw new SemanticCompileError('BAD_DECL', 'L2 声明不是对象')
  }
  const op: unknown = (decl as { op?: unknown }).op
  const opKind = (op !== null && typeof op === 'object') ? (op as { kind?: unknown }).kind : undefined
  if (opKind === 'refine') return compileRefine(l1Catalog, decl as L2RefineDeclaration)
  if (opKind === 'expr') return compileExpr(l1Catalog, decl as L2ExprDeclaration)
  throw new SemanticCompileError(
    'OP_UNSUPPORTED',
    `op.kind 只支持 'refine'（A 薄档）| 'expr'（B 中档），收到 \`${String(opKind)}\`——C 厚档要经 spec 增补`,
  )
}
```

> ⚠️ 旧 `compileL2` 的**文档注释**（讲 A 薄档那一段）搬去 `compileRefine`；`compileL2` 用上面这段新注释。
> ⚠️ 分派器里的局部变量**必须**叫 `opKind`：门禁⑧-b 的编译面正则就是 `\bopKind\s*===\s*'([^']+)'`。改名字 = 门禁取不到接受集 = 红。

---

- [ ] **Step 4: 跑域层测试**

```bash
pnpm --filter data exec vitest run modules/data/domain/semantic-compiler.test.ts
```

Expected: **仍有 FAIL** —— 16 处老调用还在传单行 base（`compileL2(base, …)`），签名已变成 `(readonly MetricRow[], …)`。Step 5 修。
（新加的 expr describe 块在这一步应当已经全绿。）

- [ ] **Step 5: 机械改写既有调用点 + `standinBase` 返回类型**

```bash
grep -c 'compileL2(base,' modules/data/domain/semantic-compiler.test.ts
```

把所有把**单行**当第一参的调用改成数组：

- `compileL2(base,` → `compileL2([base],`
- `compileL2(<其它单行变量>,` → `compileL2([<那个变量>],`（PG 的 5 个用例同样处理）

再把 `standinBase()` 的返回类型标注从 `: MetricDef` 改成 `: MetricRow`（`MetricDef[]` 不可赋给 `readonly MetricRow[]` —— `MetricRow` 是 `MetricDef` 的超集）。
若文件还没导入 `MetricRow`，加 `import type { MetricRow } from './metric-store'`。

**验收（三条都要过）**：

```bash
grep -c 'compileL2(base,' modules/data/domain/semantic-compiler.test.ts   # 期望 0
grep -n 'MetricDef' modules/data/domain/semantic-compiler.test.ts        # 期望只剩 2 行：import 那行 + authorizeLike 那行
pnpm --filter data exec vitest run modules/data/domain/semantic-compiler.test.ts
```

> ⚠️ **这一步不要用 `sed -i`**：本机是 ugrep，且路径含中文。用编辑器逐个改（或 `grep -n` 列出后按行改）——`typecheck` 是兜底网，Step 6 会抓漏。

- [ ] **Step 6: typecheck 兜底**

```bash
pnpm typecheck
```

Expected: 只剩**下游**（`metric-write.ts` / `routes/*`）的错 —— 它们还在按旧签名与旧字段（`compiled.subjectColumn` 还不存在）用。Step 7-9 修。
**若出现「test 文件里某处调用签名不符」⇒ 回 Step 5 补。**

- [ ] **Step 7: `metric-write.ts` —— adopted 闸从 1 个 base 扩到 N 个 ref**

目标改动（锚点按现有行号给出）：

1. **`:82` target 判定**改成「键存在且非 undefined」（expr 支类型上没有 `target`，`decl.target` 会 typecheck 失败）：

```ts
    if ('target' in decl && decl.target !== undefined) return { ok: false, http: 400, error: 'TARGET_NOT_SUPPORTED' }
```

2. **`:88-114` 取基 + adopted 闸**改成「先算 N 个 ref，再逐个校验」。把原来的
`let base: MetricRow` + `resolveL1Base(await loadPlatformCatalog(deps.pool), decl.baseMetric)` + 单次 adopted 判定，替换为：

```ts
    // 词表只取一次（expr 有 N 个 ref，别在循环里反复 load）
    const catalog = await loadPlatformCatalog(deps.pool)
    // ref 是**唯一**要过 adopted 闸的东西：读侧不做二次校验（增补 §4.2）。
    // 用 collectRefIds 而不是按档位分支：它在形状不对时返回 []（不抛），
    // 形状错留给 compileL2 响亮地拒 —— 别把 zod 该报的错伪装成编译错。
    for (const refId of collectRefIds(decl)) {
      const refBase = resolveL1Base(catalog, refId)
      if (refBase.sourceSystem !== null && !deps.adoptedSources.has(refBase.sourceSystem)) {
        return {
          ok: false,
          http: 403,
          error: 'METRIC_SOURCE_NOT_ADOPTED',
          extra: { its_source: refBase.sourceSystem, your_sources: [...deps.adoptedSources] },
        }
      }
    }
```

> ⚠️ `extra` 的三个键与取值形式**逐字不变**（`its_source` / `your_sources` 用 `[...deps.adoptedSources]` 展开成数组）—— 已有用例对它是 byte-shape 断言。
> ⚠️ 行为等价性（refine 支）：`collectRefIds` 对 refine 返回 `[decl.baseMetric]` ⇒ 一次循环 = 原来的单次校验，**顺序与结果都一样**（含 `L1_BASE_NOT_FOUND` 由 `resolveL1Base` 抛、`sourceSystem === null` 放行）。

3. **`:116-136` 编译与行字面量**：`let compiled: { selectSql: string; title: string; groupBy: string }` 改成 `let compiled: CompiledL2`，并给 `semantic-compiler.ts` 的 import 补上 `collectRefIds`、`resolveL1Base`、`loadPlatformCatalog`（若尚未导入）、`CompiledL2`、`CompileErrorCode`（按需）。

   行字面量里两处改读编译产物：

```ts
      description: compiled.description,
      subjectColumn: compiled.subjectColumn,
```

   （原来分别是 `` description: `L2 派生自 ${base.id}` `` 与 `subjectColumn: base.subjectColumn` —— refine 支下**取值逐字相同**。）
   其余字段（`requiredScope: null`、`params: {}`、`title: compiled.title`、`selectSql: compiled.selectSql`、`groupBy: compiled.groupBy`）**不变**。
   **若 `base` 变量在替换后不再被使用**，删掉它（残留的未使用变量会让 lint 红）。

- [ ] **Step 8: `routes/metrics.ts` —— 面级也改成两层 union**

1. `:27` 的 import 补两个 member schema：
```ts
import { L2RefineDeclarationSchema, L2ExprDeclarationSchema } from '../domain/semantic-compiler'
```
（若原 import 还带别的符号，**保留**它们；只加这两个名字。若 `L2DeclarationSchema` 在本文件其他地方不再被使用，**删掉**它的 import —— 未使用的 import 会让 lint 红。）
2. `:33-40` 的注释末尾补一句（讲清为什么是两层）：
```ts
 *   B 中档起 body 是**两层 union**（refine 支 / expr 支），各自 `.extend()` 后再 union ——
 *   ZodUnion 本身没有 `.extend()`，而两支的宽容度不同，本来也必须分开校验。
```
3. `:41` 换成：
```ts
const L2RefineBody = L2RefineDeclarationSchema.extend({ id: z.string().min(1).max(64) }).strict()
const L2ExprBody = L2ExprDeclarationSchema.extend({ id: z.string().min(1).max(64) }).strict()
const L2Body = z.union([L2RefineBody, L2ExprBody])
```
（`.extend()` 会带过 `unknownKeys`，再显式 `.strict()` 一次：refine 支的**面级**因此仍是 strict，与旧行为一致。）
4. `:43` 的 `type L2BodyType = z.infer<typeof L2Body>` **不用改**（union 也能 `z.infer`）。
5. POST/PUT 的处理**不动**。

- [ ] **Step 9: `routes/mcp-metric-tools.ts` —— 判别式 union + `op` 归一**

1. `:29-32` 的 `CustomizeArgs` 换成：
```ts
const CustomizeRefineArgs = L2RefineDeclarationSchema
  .omit({ op: true, target: true })
  .extend({ id: z.string().min(1).max(64) })
  .strict()
const CustomizeExprArgs = L2ExprDeclarationSchema
  .omit({ op: true })
  .extend({ id: z.string().min(1).max(64) })
  .strict()
const CustomizeArgs = z.union([CustomizeRefineArgs, CustomizeExprArgs])
```
（`.omit()` / `.extend()` **会**带过 `unknownKeys` ⇒ expr 支的面级仍是 strict。ZodUnion 上没有 `.omit()`，所以必须按 member 做。）
2. `:68-72` 的工具描述：**保留** `'**只能基于已有口径裁剪，不能凭空造新指标**：baseMetric 必须是 list_metrics 里出现的'` 这个子串（`mcp-manage.test.ts:98-99` 对它断言），把数组改成三段：
```ts
        description: [
          '基于已有平台口径定义本租户口径：裁剪 / 改名 / 收窄可见维度 / 加过滤（refine），',
          '或用**受限算术**把多条口径组合成新测度（expr，例如两条口径相除得客单价）。',
          '**只能基于已有口径裁剪，不能凭空造新指标**：baseMetric 必须是 list_metrics 里出现的',
          '平台口径 id，expr 里的 ref 也只能指向它们；可用维度以基底为准（越界会被拒）。',
        ].join(''),
```
3. `:73-83` 的 `inputSchema`：`properties` 加一项 `expr`，`required` 改成「只要 id」+ `anyOf` 二者其一：
```ts
            expr: { type: 'object', description: '受限算术表达式树（与 baseMetric 二选一）；节点 kind ∈ ref/num/add/sub/mul/div' },
          },
          required: ['id'],
          anyOf: [{ required: ['baseMetric'] }, { required: ['expr'] }],
```
4. `:117-119` 的写调用：`op` 不再硬编码 refine，按入参归一：
```ts
      const { id, ...decl } = parsed.data
      const body: L2DeclarationBody = 'expr' in decl
        ? { ...decl, op: { kind: 'expr' as const, expr: decl.expr } }
        : { ...decl, op: { kind: 'refine' as const } }
      const r = await writeL2Declaration(writeDeps, deps.org, id, body)
```
5. 文件顶部的 import 补 `L2RefineDeclarationSchema` / `L2ExprDeclarationSchema`（`L2DeclarationSchema` 若不再用则删）。

- [ ] **Step 10: 跑全部 data 域测试 + typecheck**

```bash
pnpm typecheck
pnpm --filter data exec vitest run modules/data
```

Expected: typecheck **干净**。测试应只剩 Step 12/13 尚未改写的用例红（下面列出预期红的清单）：
- `modules/data/routes/metrics.test.ts` 的 `op.kind 不是 refine` 那条（标题假了，行为其实仍对 —— 它传的是 `{kind:'expression'}`，两支都不匹配 ⇒ 仍是 `INVALID_BODY` 400）；
- 若 `metrics.test.ts` 有对 `compileL2` 旧产物的直接断言，Step 12 处理。

- [ ] **Step 11: console 文案**

先查 `BAD_DECL` 是否已在 `MESSAGES` 里：

```bash
grep -n 'BAD_DECL\|MIXED_BASE\|OP_UNSUPPORTED\|EXPR_DEPTH_EXCEEDED' modules/data/console/lib/api.ts
```

在 `MESSAGES` 里 `ID_MISMATCH` 那一行**之后**（写保护那一段**之前**）插入**尚不存在**的键：

```ts
  // ── L2 域层编译闸（B 中档起）──────────────────────────────────────────
  OP_UNSUPPORTED: '这个写法当前不支持：表达式里不能带过滤条件，也不认识这种指标类型',
  MIXED_BASE: '参与运算的平台指标不在同一张表 / 同一粒度上，拼不出一个值',
  EXPR_DEPTH_EXCEEDED: '表达式太复杂（层级或引用条数超上限），拆成几步再试',
  BAD_DECL: '表达式不合法，请检查后重试',
```

（若 `BAD_DECL` / `OP_UNSUPPORTED` 已存在 ⇒ **不要**重复插入，按上面 grep 的结果只补缺的那些。）
`L1_BASE_NOT_FOUND` 的文案**不改**（语义仍是「ref 的 id 不在 L1 词表里」）。

- [ ] **Step 12: 改写 `metrics.test.ts`**

1. **改标题、不改断言**（`:196-200`）：现在它测的其实是「哑判别键两支都不匹配」。
```ts
  it('POST op.kind 既不是 refine 也不是 expr ⇒ 400 INVALID_BODY（union 两支都不匹配）', async () => {
    const res = await post(l2Body({ op: { kind: 'expression' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })
```
2. **新增 expr 正例**（放在同 `describe` 里、既有 201 用例之后）。用**单 ref**，避免引入 MIXED_BASE 面：
```ts
  it('POST expr 声明 ⇒ 201，selectSql 是内联表达式且带编译器注入的除零守卫', async () => {
    const res = await post(l2Body({
      baseMetric: undefined,                                   // 见下：先确认 l2Body 的构造方式
      op: { kind: 'expr', expr: { kind: 'div', left: { kind: 'ref', id: <已采用的 L1 id> }, right: { kind: 'num', value: 2 } } },
    }))
    ...
  })
```
> ⚠️ **这一步的落地方式（已核实 `:79`，不必再猜）**：`l2Body(over) = ({ id: 'l2_net_sales_xiongmao', baseMetric: L1_SALES.id, op: { kind: 'refine' }, ...over })`。
> **它恒塞一个真值 `baseMetric`** ⇒ 直接 `l2Body({ op: { kind: 'expr', … } })` 会带着 `baseMetric` 进 expr 支，而 expr 支是 `.strict()` ⇒ **`BAD_DECL` 400，不是 201**。
> 两种都对，选一种并写清：
> - **（推荐）另写一个 expr 专用字面量** `const exprBody = (over = {}) => ({ id: 'l2_avg_price', op: { kind: 'expr', expr: {…} }, ...over })` —— 不碰既有构造器，语义最清楚；
> - 或复用 `l2Body({ baseMetric: undefined, op: { kind: 'expr', … } })`：`...over` 把 `baseMetric` 覆成 `undefined`，而请求体经 `JSON.stringify` 会**丢掉值为 `undefined` 的键**，最终报文里没有该键 ⇒ 也能过。**但这条依赖「undefined 键在序列化时消失」，别在断言里依赖它**。
> 无论哪种，**不许**出现 `baseMetric: <真值>` 与 `op.kind:'expr'` 同现。
> 断言至少要有三条：
> - `expect(res.status).toBe(201)`
> - `expect(body.selectSql).toContain('NULLIF((2), 0)')`
> - `expect(body.selectSql).toContain(' as value')`
> 以及（映射到判据②「产物形状不变」）`expect(body.groupBy).toBe(<该 L1 行的可见维度>)`、`expect(body.subjectColumn).toBe(<该 L1 行的主体列>)`。
3. **新增 expr 的 adopted 闸用例**：照抄同文件既有 `METRIC_SOURCE_NOT_ADOPTED` 用例的**播种方式**（拿同一个「未被采用」的 L1 行），把 body 换成两条 ref 的 expr，其中**第二个 ref 指向未采用那条**：
```ts
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: <已采用的 L1 id> }, right: { kind: 'ref', id: <未采用的 L1 id> } },
      },
```
> 断言**逐字沿用**既有用例那条（`403` + `expect(await res.json()).toEqual({ error: 'METRIC_SOURCE_NOT_ADOPTED', its_source: <未采用那条的源>, your_sources: [...] })`）—— 判据是「extra 的形状没变」。
> ⚠️ 若既有用例的 ROUTE 用的是 `l2Body`，expr body 要用 Step 12.2 里那个新构造方式。
4. **★ 严格性循环（`:164-176`）与其余 L2 用例（`L1_BASE_NOT_FOUND` / `UNKNOWN_DIM` / `TARGET_NOT_SUPPORTED` / `ID_RESERVED_BY_L1`）一个都不改** —— 它们的期望值在本次改动后依然成立（未知键面级 strict 拦下；词表/维度/限流判定链没动）。

- [ ] **Step 13: 新增 MCP 面 expr 用例（`mcp-manage.test.ts`）**

在同文件描述 `customize_metric` 的 `describe` 里加一条：`{ id, expr: { kind: 'div', left: {kind:'ref', id:<已采用 L1>}, right: {kind:'num', value:2} } }` ⇒ 工具返回非错误、写入成功（沿用既有 customize 用例的断言方式与清理方式）。

> ⚠️ **只删自己插的行**：清理只按本用例写入的 id 删（记忆教训：`test-body-global-delete-slaughters-sibling-fixtures` —— 真库共享时"全局清理"会砍兄弟夹具的种子数据）。

- [ ] **Step 14: 修 `README.md:137`**

`:136-137` 那句「**`op` 由工具面固定为 `refine`**（工具面比 HTTP 面窄，是有意的）」已经**变假**。改成（保持整段语义连贯，只改这一处）：

```md
- 「agent 只需产出可机检的声明、不必也不该生成 SQL」这条不变：`customize_metric` 的入参与 HTTP 面同源（结构化声明），
  **`op` 由工具面按入参归一**（给了 `expr` 就是 `expr` 支，否则 `refine` 支）；工具面的表达面仍比 HTTP 面窄
（HTTP 面还接受 `target`，工具面不收）。
```

（若 `:137` 前后的换行/缩进与上面不同，**只替换含 `op` 由工具面固定为 `refine` 的那一句**，不要重排整段。）

- [ ] **Step 15: 门禁⑧ 升级（`scripts/check-data-models.mjs`）**

**15a. 换掉标记正则**（原 `L2_SCHEMA_MARKER_RE` / `L2_IFACE_MARKER_RE` 删除，换成下面这组）：

```js
// ⑧ L2 声明的「形状面 ↔ 编译面」对偶（T9）。B 中档起按 op.kind 分两支比对，并加节点集对偶。
const L2_DECLARATION_REL = 'modules/data/domain/semantic-compiler.ts'
const SYNC_SCRIPT_REL = 'scripts/sync-data-semantics.mjs'
// ── 声明侧：两支各自的具名 schema / interface ──
const L2_REFINE_SCHEMA_MARKER_RE = /const\s+L2RefineDeclarationSchema\s*=\s*z\.object\(/
const L2_EXPR_SCHEMA_MARKER_RE = /const\s+L2ExprDeclarationSchema\s*=\s*z\.object\(/
const L2_REFINE_IFACE_MARKER_RE = /export\s+interface\s+L2RefineDeclaration\s*\{/
const L2_EXPR_IFACE_MARKER_RE = /export\s+interface\s+L2ExprDeclaration\s*\{/
// union 的成员从**捕获组**读（这行没有 `{`，sliceBalancedBlock 取不到它）
const L2_UNION_MARKER_RE = /const\s+L2DeclarationSchema\s*=\s*z\.union\(\s*\[([\s\S]*?)\]\s*\)/
const L2_MEMBER_NAME_RE = /\b(L2[A-Za-z]*DeclarationSchema)\b/g
// ── 判别键接受集（逐支窗口）──
const L2_KIND_SCHEMA_RE = /kind\s*:\s*z\.literal\(\s*'([^']+)'\s*\)/g
const L2_KIND_ENUM_SCHEMA_RE = /kind\s*:\s*z\.enum\(\s*\[([^\]]*)\]\s*\)/g
const L2_KIND_COMPILER_RE = /\bopKind\s*===\s*'([^']+)'/g
const L2_FILTER_OP_SCHEMA_RE = /op\s*:\s*z\.enum\(\s*\[([^\]]*)\]\s*\)/g
const L2_FILTER_OP_COMPILER_RE = /\bf\.op\s*!==\s*'([^']+)'/g
// ── 节点集（expr 闭集）：schema 侧窗口 vs renderExprNode 的 case ──
const L2_EXPR_NODE_SCHEMA_START_RE = /\bexport\s+const\s+ExprNodeSchema\b/
const L2_EXPR_NODE_SCHEMA_END = 'const L2ExprDeclarationSchema'
const L2_RENDER_MARKER_RE = /function\s+renderExprNode\s*\(/
const L2_CASE_KIND_RE = /\bcase\s+'([^']+)'\s*:/g
```

> ⚠️ **`sliceBalancedBlock` 的 marker 必须非 global**（它靠 `marker.exec` 拿 `m.index` 再 `indexOf('{')`）——上面 5 个 marker 正则都不带 `g`，别加。
> ⚠️ **`.exec()` 打在 global 正则上会改 `lastIndex`**，所以下面每次 `.exec` 之前都显式赋 `lastIndex`；`literalValueSet` / `matchAll` 不受影响（它们克隆）。

**15b. 文档口径**：

- `:20-24` 的 ⑧ 一句话说明**末尾**追加：`；B 中档起还比对 **expr 节点集**（schema 的 kind 闭集 = \`renderExprNode\` 的 case 集）`
- `:36`、`:280`、`:426`、`:434` 的「三条子判定」全部改成「**四条**子判定」（`:36` 是头部清单里的措辞，后三处是函数文档）。
- `:280-283` 的子判定清单末尾加第 4 条（**`不许`那句原样保留**）：
```js
 *  ④ 节点集对偶：expr 闭集的 node kind（schema 侧 literal ∪ enum） = `renderExprNode` 的 `case` 集
```
- `:39-43` 的**假绿示例**第一条要改成新的分派器形态（旧文本的 `if (decl.op?.kind !== 'refine') { /* 空 */ }` 已经不对应任何真实代码）：
```js
 *   · 守卫体掏空（把 `if (opKind === 'refine') return …` 的兜底 `throw` 删掉）⇒ 编译器实际**接受任意** `op.kind`，
 *     而 schema 侧只列了两支 —— 本检查必须在**不改真文件**的前提下抓到这种漂移（见本文件的合成源用例）。
```

**15c. 重写 `checkL2DeclarationSameSource`**（整个函数替换；`maskJsComments` / `sliceBalancedBlock` / `topLevelKeys` / `literalValueSet` / `lineAt` / `sameSet` **一行都不动**）：

```js
/**
 * ⑧ L2 声明的「形状面 ↔ 编译面」对偶（T9）。
 *
 * 这条检查**不是**「同名 ⇒ 行为等价」—— 它只保证**同一份声明，schema 放行的形状集合与编译器
 * 认识的形状集合逐字相等**。两侧是两处独立维护的清单（schema 是运行时门禁、编译器是 SQL 生产者），
 * 任一处改了另一处没跟上，就会出现「写进去了但编译不出」/「编译认识但写不进去」。
 * **不许**把这条注释或它的对外表述写成「同源 ⇒ 行为等价」—— 它只比对形状面，比对不了行为。
 *
 * 四条子判定：
 * ⑧-a 存在性：L2DeclarationSchema 是 union 且成员恰为两支；两支的 schema/interface 都可取；compileL2 仍是导出函数声明
 * ⑧-b 判别键接受集：逐支的 op.kind 字面量、filters 算子 ── 与编译面逐字相等（外加 union 级合计）
 * ⑧-c 字段面：逐支 schema 块 depth-1 键集 = 该支 interface 键集
 * ⑧-d 节点集对偶：expr 闭集的 node kind（schema literal ∪ enum） = renderExprNode 的 case 集
 */
function checkL2DeclarationSameSource(src) {
  const violations = []
  const masked = maskJsComments(src)

  const refineSchemaBlock = sliceBalancedBlock(masked, L2_REFINE_SCHEMA_MARKER_RE)
  const exprSchemaBlock = sliceBalancedBlock(masked, L2_EXPR_SCHEMA_MARKER_RE)
  const refineIfaceBlock = sliceBalancedBlock(masked, L2_REFINE_IFACE_MARKER_RE)
  const exprIfaceBlock = sliceBalancedBlock(masked, L2_EXPR_IFACE_MARKER_RE)

  // ── ⑧-a 存在性 ──
  if (!/\bL2DeclarationSchema\b/.test(masked) || !/export\s+const\s+L2DeclarationSchema\b/.test(masked)) {
    violations.push(`${L2_DECLARATION_REL}: 找不到 \`export const L2DeclarationSchema\`——L2 声明的写时校验必须与编译器同文件导出（HTTP 面与 MCP 面都靠它）`)
  }
  const unionMatch = L2_UNION_MARKER_RE.exec(masked)
  if (unionMatch === null) {
    violations.push(`${L2_DECLARATION_REL}: \`L2DeclarationSchema\` 必须是 \`z.union([...])\`（B 中档起按 \`op.kind\` 判别；单一 object schema 表达不了两支不同的宽容度）`)
  } else {
    const members = new Set()
    for (const m of unionMatch[1].matchAll(L2_MEMBER_NAME_RE)) members.add(m[1])
    const want = ['L2ExprDeclarationSchema', 'L2RefineDeclarationSchema']
    const got = [...members].sort()
    if (!sameSet(got, want)) {
      violations.push(`${L2_DECLARATION_REL}: \`L2DeclarationSchema\` 的成员应为 ${want.join(' / ')}，实际 ${got.join(' / ') || '（空）'}——两支必须各有一个具名 schema，本检查才逐得起支`)
    }
  }
  if (!/export\s+function\s+compileL2\b/.test(masked)) {
    violations.push(`${L2_DECLARATION_REL}: \`compileL2\` 必须仍是 \`export function\` 声明（本检查靠它在同文件定位编译面；改成箭头函数/重导出会同时让这条检查与调用方一起失效）`)
  }

  // 四个块缺任一 ⇒ 后面所有逐支比对都无意义，显式报错后结束（比"静默通过"安全）
  if (refineSchemaBlock === '' || exprSchemaBlock === '' || refineIfaceBlock === '' || exprIfaceBlock === '') {
    const miss = [
      `refine schema=${refineSchemaBlock === '' ? '缺' : '有'}`,
      `expr schema=${exprSchemaBlock === '' ? '缺' : '有'}`,
      `refine interface=${refineIfaceBlock === '' ? '缺' : '有'}`,
      `expr interface=${exprIfaceBlock === '' ? '缺' : '有'}`,
    ].join(' / ')
    violations.push(`${L2_DECLARATION_REL}: 取不到两支的 schema/interface 块（${miss}）——① 具名 schema 须写成 \`const L2XxxDeclarationSchema = z.object({\` 单头形式；② interface 须显式写在本文件顶层（不得用 extends z.infer<…> 之类的推导形式，那样取不到键）`)
    return violations
  }

  const members = [
    {
      name: 'refine',
      schemaAt: masked.indexOf('const L2RefineDeclarationSchema'),
      ifaceAt: masked.indexOf('export interface L2RefineDeclaration'),
      schemaBlock: refineSchemaBlock,
      ifaceBlock: refineIfaceBlock,
    },
    {
      name: 'expr',
      schemaAt: masked.indexOf('const L2ExprDeclarationSchema'),
      ifaceAt: masked.indexOf('export interface L2ExprDeclaration'),
      schemaBlock: exprSchemaBlock,
      ifaceBlock: exprIfaceBlock,
    },
  ]

  const schemaKindsAll = new Set()

  for (const mb of members) {
    const where = `${L2_DECLARATION_REL}:${lineAt(masked, mb.schemaAt)}`

    // ── ⑧-b-1 该支的 op.kind 字面量 ──
    const opAt = mb.schemaBlock.indexOf('op:')
    if (opAt === -1) {
      violations.push(`${where}: ${mb.name} 支的 schema 里找不到 \`op:\`——判别键必须显式写在该支的 schema 块里（编译器按它分派）`)
    } else {
      L2_KIND_SCHEMA_RE.lastIndex = opAt
      const kinds = new Set()
      for (let m = L2_KIND_SCHEMA_RE.exec(mb.schemaBlock); m !== null; m = L2_KIND_SCHEMA_RE.exec(mb.schemaBlock)) {
        if (m[1] !== undefined) kinds.add(m[1])
      }
      const got = [...kinds].sort()
      for (const k of got) schemaKindsAll.add(k)
      if (!sameSet(got, [mb.name])) {
        violations.push(`${where}: ${mb.name} 支 schema 的 \`op.kind\` 字面量应为 \`'${mb.name}'\`，实际 ${got.map((k) => `'${k}'`).join(' / ') || '（取不到）'}`)
      }
    }

    // ── ⑧-b-2 该支的 filters 算子 ──
    const filtersAt = mb.schemaBlock.indexOf('filters')
    if (filtersAt === -1) {
      violations.push(`${where}: ${mb.name} 支 schema 里找不到 \`filters\`——两支都必须**显式声明**它（expr 支声明了再由编译器以 OP_UNSUPPORTED 拒），否则 ⑧-c 的字段面比对会静默少一个键`)
    } else {
      L2_FILTER_OP_SCHEMA_RE.lastIndex = filtersAt
      const opEnumMatch = L2_FILTER_OP_SCHEMA_RE.exec(mb.schemaBlock)
      const schemaOps = opEnumMatch === null ? [] : literalValueSet(opEnumMatch[1] ?? '', /'([^']*)'/g)
      const compilerOps = literalValueSet(masked, L2_FILTER_OP_COMPILER_RE)
      if (schemaOps.length === 0) {
        violations.push(`${where}: ${mb.name} 支 schema 的 \`filters[].op\` **过滤算子**取不到（写成 \`op: z.enum(['=', 'in'])\` 才认得）`)
      } else if (!sameSet(schemaOps, compilerOps)) {
        violations.push(`${where}: ${mb.name} 支 schema 的**过滤算子**集 ${schemaOps.join(' / ')} 与编译面 ${compilerOps.join(' / ') || '（取不到）'} 不等`)
      }
    }

    // ── ⑧-c 字段面：该支 schema 块 vs 该支 interface ──
    const schemaKeys = topLevelKeys(mb.schemaBlock).sort()
    const ifaceKeys = topLevelKeys(mb.ifaceBlock).sort()
    if (!sameSet(schemaKeys, ifaceKeys)) {
      const onlySchema = schemaKeys.filter((k) => !ifaceKeys.includes(k))
      const onlyIface = ifaceKeys.filter((k) => !schemaKeys.includes(k))
      const detail = [
        onlySchema.length > 0 ? `仅 schema：${onlySchema.join(', ')}` : '',
        onlyIface.length > 0 ? `仅 interface：${onlyIface.join(', ')}` : '',
      ].filter((s) => s !== '').join('；')
      violations.push(`${where}: ${mb.name} 支的字段面两侧不等（${detail || '键集不一致'}）——schema 与 interface 必须逐键对齐`)
    }
  }

  // ── ⑧-b（union 级）：两支 schema 的接受集合计 = 编译器 opKind 分派集 ──
  const compilerKinds = literalValueSet(masked, L2_KIND_COMPILER_RE)
  const schemaKinds = [...schemaKindsAll].sort()
  if (!sameSet(schemaKinds, compilerKinds)) {
    violations.push(`${L2_DECLARATION_REL}: \`op.kind\` 的接受集两侧不等——schema 面 ${schemaKinds.map((k) => `'${k}'`).join(' / ')} vs 编译面 opKind 分派 ${compilerKinds.map((k) => `'${k}'`).join(' / ') || '（取不到）'}。任一侧加/减档位必须另一侧同步：只改一边就是"写得进但编译不出"或反之`)
  }

  // ── ⑧-d 节点集对偶 ──
  const nodeStart = L2_EXPR_NODE_SCHEMA_START_RE.exec(masked)
  const nodeEndAt = masked.indexOf(L2_EXPR_NODE_SCHEMA_END)
  if (nodeStart === null || nodeEndAt === -1 || nodeEndAt < nodeStart.index) {
    violations.push(`${L2_DECLARATION_REL}: 取不到 expr 节点集的两侧窗口——schema 侧要有 \`export const ExprNodeSchema\`，且它必须写在 \`const L2ExprDeclarationSchema\` 之前（窗口 = 两者之间）`)
  } else {
    const nodeWindow = masked.slice(nodeStart.index, nodeEndAt)
    const schemaNodeKinds = new Set(literalValueSet(nodeWindow, L2_KIND_SCHEMA_RE))
    for (const m of nodeWindow.matchAll(L2_KIND_ENUM_SCHEMA_RE)) {
      for (const k of literalValueSet(m[1] ?? '', /'([^']*)'/g)) schemaNodeKinds.add(k)
    }
    const renderBlock = sliceBalancedBlock(masked, L2_RENDER_MARKER_RE)
    if (renderBlock === '') {
      violations.push(`${L2_DECLARATION_REL}: 取不到 \`renderExprNode\` 的函数体——expr 档的唯一渲染点必须是一个具名函数（本检查靠它的 \`case\` 集取节点集）`)
    } else {
      const compilerNodeKinds = literalValueSet(renderBlock, L2_CASE_KIND_RE)
      const got = [...schemaNodeKinds].sort()
      if (!sameSet(got, compilerNodeKinds)) {
        violations.push(`${L2_DECLARATION_REL}: expr **节点集**两侧不等——schema 面 ${got.map((k) => `'${k}'`).join(' / ')} vs \`renderExprNode\` 的 case ${compilerNodeKinds.map((k) => `'${k}'`).join(' / ') || '（取不到）'}。节点集就是"能产生什么 SQL"的词表，任一侧加/减必须另一侧同步`)
      }
    }
  }

  return violations
}
```

- [ ] **Step 16: 升级 T9 用例（`scripts/check-data-models.test.ts:876-1010`）**

**段头注（`:876-893`）里「本段不重排、不改写、不删上面任何既有用例」这句保留**；下面是对既有 7 条**锚点级**的调整与新用例。

**16a. 前 6 条（`:912-954`）：锚点全部仍然有效，逐条确认**

> ⛓️ **这是 Step 3 对 Step 16 的硬约束（跨步）**：既有 6 条用例全靠 `l2RealSource().replace('<锚点>', …)` 打真文件 ——
> **锚点是「真文件里逐字存在的子串」**。⇒ Task 1 **Step 3 重写 `semantic-compiler.ts` 时，下面这 5 个串必须逐字存活**
> （含**前导空格数**；`.replace` 只打**第一处**）：
>
> | 锚点串（逐字） | 改后落在哪 | 不许怎么改 |
> |---|---|---|
> | `kind: z.literal('refine')` | `L2RefineDeclarationSchema` 里 | 不许改成 `z.literal('refine')` 之外的形式/换引号/加空格 |
> | `z.enum(['=', 'in'])` | **两处**（refine 支在前、expr 支在后） | 不许去掉空格、不许把 refine 支挪到 expr 支之后 |
> | `export const L2DeclarationSchema` | union 那一行 | 不许把 union 改名、不许去掉 `export` |
> | `  target: z.number().optional(),` | `L2RefineDeclarationSchema` 里，**恰好两个前导空格** | 不许重排/重缩进 refine 支的键 |
> | `  target?: number` | `export interface L2RefineDeclaration` 里，**恰好两个前导空格** | 同上 |
>
> **落地后自查（推前跑，全部期望 1）**：
> ```bash
> for s in "kind: z.literal('refine')" "export const L2DeclarationSchema" "  target: z.number().optional()," "  target?: number"; do
>   printf '%s -> ' "$s"; grep -cF "$s" modules/data/domain/semantic-compiler.ts
> done
> grep -cF "z.enum(['=', 'in'])" modules/data/domain/semantic-compiler.ts   # 期望 2
> ```
> 若 Task 1 的写法让某条**不得不**变（例如 refine 支需要 `.strict()`），**不要静默改锚点** ——
> 那会让「真文件零违规」这条基线用例连带失效，**先停下来问人**。

| 用例 | 锚点 | 为什么仍有效 |
|---|---|---|
| 1 真文件零违规 | — | 前提：Step 3-15 已让真文件满足四条子判定 |
| 2 `.replace("kind: z.literal('refine')", "kind: z.literal('aggregate')")` | 该串在真文件里**只出现一次**（refine 支） | refine 支的 `op.kind` ≠ `'refine'` ⇒ 逐支报错，消息含 `op.kind` ✔ |
| 3 `.replace("z.enum(['=', 'in'])", "z.enum(['=', 'in', 'like'])")` | 该串出现**两次**（refine 先、expr 后）；`.replace` 打第一处 | refine 支算子集 ≠ 编译面 ⇒ 消息含 `过滤算子` ✔ |
| 4 `.replace('export const L2DeclarationSchema', 'const L2DeclarationSchema')` | 唯一 | ⑧-a 的第二个分支报错，消息含 `L2DeclarationSchema` ✔ |
| 5 `.replace('  target: z.number().optional(),', '  target: z.number().optional(),\n  expression: z.string().optional(),')` | 唯一（expr 支没有 `target`） | refine 支 `仅 schema：expression`，消息含 `expression` ✔ |
| 6 `.replace('  target?: number', '  target?: number\n  expression?: string')` | 唯一 | refine 支 `仅 interface：expression` ✔ |

**16b. 第 7 条（合成源，`:956-976`）：整块替换**

```ts
  const synthetic = [
    'export interface L2RefineDeclaration {',
    '  baseMetric: string',
    "  op: { kind: 'refine' }",
    "  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]",
    '}',
    'export interface L2ExprDeclaration {',
    "  op: { kind: 'expr'; expr: ExprNode }",
    "  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]",
    '}',
    'export const L2RefineDeclarationSchema = z.object({',
    '  baseMetric: z.string().min(1).max(128),',
    "  op: z.object({ kind: z.literal('refine') }),",
    '  filters: z.array(z.object({',
    "    op: z.enum(['=', 'in']),",
    '  })),',
    '})',
    'export const ExprNodeSchema = z.lazy(() => z.union([',
    "  z.object({ kind: z.literal('ref'), id: z.string() }),",
    "  z.object({ kind: z.literal('num'), value: z.number() }),",
    "  z.object({ kind: z.enum(['add', 'sub', 'mul', 'div']), left: ExprNodeSchema, right: ExprNodeSchema }),",
    ']))',
    'export const L2ExprDeclarationSchema = z.object({',
    "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),",
    '  filters: z.array(z.object({',
    "    op: z.enum(['=', 'in']),",
    '  })),',
    '}).strict()',
    'export const L2DeclarationSchema = z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])',
    'export function compileL2(d: L2Declaration, l1: readonly MetricRow[]) {',
    "  const opKind = (d as { op?: { kind?: unknown } }).op?.kind",
    "  if (opKind === 'refine') return compileRefine(l1, d)",
    "  if (opKind === 'expr') return compileExpr(l1, d)",
    "  throw new Error('x')",
    '}',
    'function renderExprNode(node: ExprNode, refExpr: ReadonlyMap<string, string>): string {',
    '  switch (node.kind) {',
    '    case \'num\': return String(node.value)',
    '    case \'ref\': return refExpr.get(node.id) ?? \'\'',
    '    case \'add\':',
    '    case \'sub\':',
    '    case \'mul\':',
    '      return \'x\'',
    '    case \'div\':',
    '      return \'y\'',
    '    default: throw new Error(\'z\')',
    '  }',
    '}',
    'function filterSql(f) {',
    "  if (f.op !== '=' && f.op !== 'in') throw new Error('y')",
    '}',
  ].join('\n')

  expect(checkL2DeclarationSameSource(synthetic)).toEqual([])
```

> **合成源为什么必须长这样**（改任何一个字符前先读这四条）：
> 1. refine 的 schema 块必须在 `ExprNodeSchema` **之前** —— 否则 `z.literal('refine')` 混进 ⑧-d 的节点集窗口。
> 2. 里那个过滤器参数**必须**叫 `f`：编译面正则 `\bf\.op` 不匹配 `f2.op`（`2` 与 `f` 之间没有词边界）⇒ 取不到算子集 ⇒ 红。真文件里的 `filterSql` 用的就是 `f`。
> 3. `opKind` 这个名字不能换：⑧-b 的编译面正则就是 `\bopKind\s*===`。
> 4. `renderExprNode` 的 6 个 `case` **一个都不能少**（`num`/`ref`/`add`/`sub`/`mul`/`div`）；`case 'add': case 'sub': case 'mul':` 写成三个标签是**对的**（每个标签各算一个）。

**16c. 新增 3 条用例**（追加在同段之后）：

```ts
  it('⑧-a union 少一支 ⇒ 报成员集不符（消息含 L2DeclarationSchema）', () => {
    const src = l2RealSource()
    const broken = src.replace(
      'z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])',
      'z.union([L2RefineDeclarationSchema])',
    )
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((m) => m.includes('L2DeclarationSchema'))).toBe(true)
  })

  it('⑧-c expr 支多一个 schema 键 ⇒ 报字段面不等（消息含该键名）', () => {
    const src = l2RealSource()
    const broken = src.replace(
      "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),",
      "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),\n  remark: z.string().optional(),",
    )
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((m) => m.includes('remark'))).toBe(true)
  })

  it('⑧-d 节点集漂移（renderExprNode 少认一个 kind）⇒ 报节点集（消息含 节点集）', () => {
    const src = l2RealSource()
    const broken = src.replace("case 'div':", "case 'divide':")
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((m) => m.includes('节点集'))).toBe(true)
  })
```

> **`l2RealSource()` 就是本段既有的读源函数（`:907-909`），直接复用，别新造第二套**：
> `function l2RealSource(): string { return readFileSyncT9(join(repoRoot, L2_COMPILER_REL), 'utf8') }`，
> 其中 `L2_COMPILER_REL = L2_DECLARATION_REL`（从门禁 import 常量，不在这里再写一份路径）。
> 既有 6 条用例的统一写法就是 `l2RealSource().replace('<真文件里的锚点串>', '<改坏>')` —— 新 3 条照抄这个形状。
> `checkL2DeclarationSameSource` 已在本段 import（`:898`），无需新增 import。
> **三个新锚点在真文件里必须唯一**，推前用 grep 各验一次：
> `grep -c 'z.union(\[L2RefineDeclarationSchema, L2ExprDeclarationSchema\])' modules/data/domain/semantic-compiler.ts` → 1；
> `grep -c "kind: z.literal('expr')" modules/data/domain/semantic-compiler.ts` → 1（只在该 schema 块里；`ExprNode` 用的是 `literal('ref')`/`literal('num')`）；
> `grep -c "case 'div':" modules/data/domain/semantic-compiler.ts` → 1。
> ⚠️ **T9 锚点卫生**：`.replace()` 打在**原始源**（含注释）上，而 `maskJsComments` 是在检查器内部才生效的 ⇒ **新增的注释里绝不能复述任何锚点串**（否则 `.replace` 会打到注释上、或锚点不再唯一）。Step 3 写的那些注释已按这条约束写过，**新增注释时同样守**。

- [ ] **Step 17: 全量门禁**

```bash
pnpm typecheck
pnpm test
ls scripts/check-*.mjs
```

Expected: 全绿。**逐条跑** `ls` 出来的每个 `check-*.mjs`（`node <script>`）；再按 `README.md §常用命令` 把纪律脚本补齐。

- [ ] **Step 18: 提交**

按逻辑边界分提交（一次提交只写一个 scope；squash 合并时最终是一个提交）：

```bash
git add modules/data/domain/semantic-compiler.ts modules/data/domain/semantic-compiler.test.ts
git commit -m "feat(data): L2Declaration 改判别式 union + expr 档编译路径"

git add modules/data/domain/metric-write.ts
git commit -m "feat(data): L2 写路径 adopted 闸从 1 个 base 扩到 N 个 ref"

git add modules/data/routes/metrics.ts modules/data/routes/mcp-metric-tools.ts modules/data/routes/metrics.test.ts modules/data/routes/mcp-manage.test.ts
git commit -m "feat(data): 两个 L2 写面支持 expr 声明（面级两层 union）"

git add modules/data/console/lib/api.ts
git commit -m "feat(data): console 补 L2 B 中档错误码文案"

git add scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "chore(guards): 门禁⑧覆盖 B 中档（逐支 shape 对偶 + expr 节点集对偶）"

git add modules/data/README.md
git commit -m "docs(data): 修正 MCP 工具面 op.kind 表述并回填表达力档位指针"
```

---

## Task 2: 证明加固（穷举 / fuzz / 逐字 / 真库）

**Files:**
- Modify: `modules/data/domain/semantic-compiler.test.ts`（追加 describe 块）
- Modify: `modules/data/routes/metrics.test.ts`（schema ↔ compiler 对偶的运行期用例）

**Interfaces:**
- Consumes: Task 1 的全部导出（`ExprNode` / `renderExprNode` / `compileL2` / `FORBIDDEN_SQL_RE` / `CompiledL2` / 两个新码）+ 既有的 `parseL1Select`
- Produces: 无（纯测试）

**为什么单独一个任务**：增补 §6 要的是「**证明**这档安全」，不是「测了几个例子」。
判据的性质不同（穷举/随机/逐字/端到端），换一个评审人独立看，价值才在。

- [ ] **Step 1: 逐节点可达集（穷举单节点 + 组合片段的白名单）**

追加：

```ts
describe('L2 · B 中档 · 逐节点可达集（增补 §6.1）', () => {
  const REF_EXPR = new Map([['a', 'sum(t.x)'], ['b', 'sum(t.y)']])
  const num = (v: number): ExprNode => ({ kind: 'num', value: v })
  const ref = (id: string): ExprNode => ({ kind: 'ref', id })

  /** 片段白名单：只许标识符、点、括号、四则、空白、数字。 */
  const FRAGMENT_RE = /^[A-Za-z0-9_.()+\-*/\s]+$/

  it('每个 node kind 渲染出的片段只含白名单字符', () => {
    const nodes: ExprNode[] = [
      num(3), ref('a'),
      { kind: 'add', left: num(1), right: num(2) },
      { kind: 'sub', left: num(1), right: num(2) },
      { kind: 'mul', left: num(1), right: num(2) },
      { kind: 'div', left: num(1), right: num(2) },
    ]
    for (const n of nodes) {
      const sql = renderExprNode(n, REF_EXPR)
      expect(sql).toMatch(FRAGMENT_RE)
    }
  })

  it('NULLIF 只可能出现在 div 上（其它 kind 不注入守卫）', () => {
    expect(renderExprNode({ kind: 'add', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'sub', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'mul', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'div', left: num(1), right: num(2) }, REF_EXPR)).toContain('NULLIF')
  })

  it('嵌套渲染的括号结构可复现（同一棵树两次渲染逐字相同）', () => {
    const tree: ExprNode = {
      kind: 'div',
      left: { kind: 'add', left: ref('a'), right: num(3) },
      right: { kind: 'mul', left: ref('b'), right: num(2) },
    }
    expect(renderExprNode(tree, REF_EXPR)).toBe('(sum(t.x) + (3)) / NULLIF(((sum(t.y) * (2))), 0)')
    expect(renderExprNode(tree, REF_EXPR)).toBe(renderExprNode(tree, REF_EXPR))
  })
})
```

> ⚠️ 第二条断言里的期望串是**按 Step 3j 的渲染规则手推的**（`add` → `(l) + (r)`；`num 3` → `3` ⇒ `(sum(t.x) + (3))`；`mul` ⇒ `(sum(t.y) * (2))`；整棵 `div` ⇒ `(… ) / NULLIF((… ), 0)`）。
> 若跑出来不等，**先手校渲染规则**再动断言 —— 不许把实际输出粘回去当期望（那就是恒真断言）。

- [ ] **Step 2: schema ↔ compiler 对偶的运行期用例（增补 §6.2 的行为侧；静态侧由门禁⑧保）**

追加（放在 HTTP 面测试文件里，用面级 `L2Body` 与域层 `compileL2` 同一批输入）：

```ts
describe('L2 · B 中档 · schema ↔ compiler 对偶（运行时）', () => {
  // 每一条：面级 schema 拒（400 INVALID_BODY）**且** 域层编译器拒（有 code）。
  // 门禁⑧ 保的是**形状面**（字段名/字面量集）静态一致；这一组保的是**行为面**：真正喂进去时两边都不放行。
  const bothReject: Array<[string, unknown]> = [
    ['expr 多带 baseMetric', { op: { kind: 'expr', expr: { kind: 'ref', id: 'x' } }, baseMetric: 'y' }],
    ['expr 多带 target', { op: { kind: 'expr', expr: { kind: 'ref', id: 'x' } }, target: 1 }],
    ['expr 节点多带未知键', { op: { kind: 'expr', expr: { kind: 'ref', id: 'x', fn: 'sum' } } }],
    ['expr 的 num 是 NaN', { op: { kind: 'expr', expr: { kind: 'num', value: Number.NaN } } }],
    ['refine 缺 baseMetric', { op: { kind: 'refine' } }],
  ]
  ...
})
```

> 落地要求（**先读文件里既有的面级用例怎么打请求、域层怎么调 `compileL2`**，照它的写法）：
> - 面级：每条 `expect(res.status).toBe(400)` 且 `expect(body.error).toBe('INVALID_BODY')`；
> - 域层：把同一条输入 `as unknown as L2Declaration` 喂 `compileL2([base], …)`，断言**抛了且带 `code`**（具体码随条目而定：`NaN`/未知键是 `BAD_DECL`；`refine` 缺 baseMetric 也是 `BAD_DECL`）；
> - `NaN` 那条**必须**同时出现在两侧：`z.number().finite()` 拒它，`scanExpr` 也拒它（这是「`.finite()` 不是装饰」的证据）。

- [ ] **Step 3: 随机树 fuzz ≥1000（可达集上界）**

追加：

```ts
describe('L2 · B 中档 · 随机树 fuzz（增广补 §6.3）', () => {
  const base = standinBase()
  const catalog = [base, { ...base, id: 'standin:clone' }]
  const ids = catalog.map((m) => m.id)

  /** 确定性 PRNG（LCG）：同一个种子永远长同一棵树 —— fuzz 失败必须可复现。 */
  const makeRng = (seed: number) => {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  /** 随机树：叶子按 rng 交替 ref/num；到 level≥5 就强制收成叶子（避免把树长到量纲闸上）。 */
  const randomExpr = (rng: () => number, level: number): ExprNode => {
    if (level >= 5 || rng() < 0.25) {
      return rng() < 0.6
        ? { kind: 'ref', id: ids[Math.floor(rng() * ids.length)]! }
        : { kind: 'num', value: Math.floor(rng() * 100) + 1 }
    }
    const ops = ['add', 'sub', 'mul', 'div'] as const
    return {
      kind: ops[Math.floor(rng() * ops.length)]!,
      left: randomExpr(rng, level + 1),
      right: randomExpr(rng, level + 1),
    }
  }

  it('≥1000 棵随机树：编译产物恒是纯 SELECT 且不含任何 DDL/DML 关键字', () => {
    let compiled = 0
    for (let i = 0; i < 1200; i++) {
      const rng = makeRng(0x5eed + i)
      const decl = { op: { kind: 'expr', expr: randomExpr(rng, 1) } } as L2Declaration
      let out
      try {
        out = compileL2(catalog, decl)
      } catch (e) {
        // 只允许量纲闸把它拦下（深度/引用条数）；其它错误码是真缺陷
        expect((e as { code?: string }).code).toBe('EXPR_DEPTH_EXCEEDED')
        continue
      }
      compiled += 1
      expect(() => parseL1Select(out.selectSql)).not.toThrow()
      expect(out.selectSql).not.toMatch(FORBIDDEN_SQL_RE)
      expect(out.selectSql).toContain(' as value')
    }
    // 别让"全都被拦下"伪装成通过
    expect(compiled).toBeGreaterThan(900)
  })
})
```

> ⚠️ `parseL1Select` 需要从 `./semantic-compiler` 导入（若当前不是导出符号 ⇒ 它是本任务的依赖，**导出它**并把这条决定写进报告；不要复制一份解析逻辑到测试里）。
> ⚠️ 那个 `compiled > 900` 的下界断言是**故意**的：没有它，一个「全抛异常」的实现也能让这条用例变绿。

- [ ] **Step 4: 客单价 —— 与手写期望 SQL 逐字相等（增补 §6.5）**

先**手工**构造两条同基 L1 行（写死 `selectSql`，别从别处借）：

```ts
describe('L2 · B 中档 · 客单价逐字（增广补 §6.5）', () => {
  const netSales: MetricRow = {
    ...standinBase(),
    id: 'lemeng:retail:net_sales',
    title: '净销售额',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value from fct_retail_sale',
    groupBy: 'system_book, bizday',
    subjectColumn: 'system_book',
  }
  const orderCount: MetricRow = {
    ...netSales,
    id: 'lemeng:retail:order_count',
    title: '订单数',
    selectSql: 'select sum(fct_retail_sale.order_count) as value from fct_retail_sale',
  }

  it('div(ref:net_sales, ref:order_count) 的 selectSql 逐字相等', () => {
    const out = compileL2([netSales, orderCount], {
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: netSales.id }, right: { kind: 'ref', id: orderCount.id } },
      },
    })
    expect(out.selectSql).toBe(
      'select (sum(fct_retail_sale.net_amount)) / NULLIF((sum(fct_retail_sale.order_count)), 0) as value, system_book, bizday from fct_retail_sale',
    )
    expect(out.groupBy).toBe('system_book, bizday')
    expect(out.subjectColumn).toBe('system_book')
  })

  it('可见维度收窄后，表达式部分逐字不变（只有维度列表变）', () => {
    const out = compileL2([netSales, orderCount], {
      visibility: { dims: ['system_book'] },
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: netSales.id }, right: { kind: 'ref', id: orderCount.id } },
      },
    })
    expect(out.selectSql).toBe(
      'select (sum(fct_retail_sale.net_amount)) / NULLIF((sum(fct_retail_sale.order_count)), 0) as value, system_book from fct_retail_sale',
    )
    expect(out.groupBy).toBe('system_book')
  })
})
```

> ⚠️ **期望串是手推的**：`ref → parseL1Select(selectSql).expression`（`sum(fct_retail_sale.net_amount)` / `sum(fct_retail_sale.order_count)`），`div → (左) / NULLIF((右), 0)`，再加 ` as value`、可见维度（继承 = `groupBy` 全部）、` from fct_retail_sale`。
> 若 `parseL1Select` **不接受**这个形状，就换成本文件既有 standin 的形状，并**重新手推**期望串 —— **不许把编译产物粘回来**（那会让这条用例失去全部价值）。

- [ ] **Step 5: 真库端到端（在既有的 `describePg` 块里加一条）**

**先读那个块（`:272-400`，已核实的骨架在这里，照抄即可，不必猜）**：
`describePg('compileL2 产物在真库上可执行（需要 DATABASE_URL）', …)` 里已有 5 条用例。可复用件：
- `const SCHEMA = 't8_standin'`；`afterAll` 已 `drop schema if exists ${SCHEMA} cascade`；
- `await seedStandin()` —— 建 `create table ${SCHEMA}.fct_retail_sale (org, system_book, bizday, net_amount, order_count)`，播 4 行（acme 3120 两天 100/2、50/1；acme 64188 一天 7/1；beta 3120 999/9）；
  ⇒ **`order_count` 列已存在**，本步要的分子分母都在里头，初始数据即 `3120 → net=150,cnt=3`、`64188 → net=7,cnt=1`（与上面第 1 项**一致**，不是另外造数）；
- `function l1(over: Partial<MetricRow> = {}): MetricRow` —— 造 L1 行；既有用例用 `l1({ selectSql: '… from ${SCHEMA}.fct_retail_sale' })` 把关系名指到替身 schema；
- `const standinBase = (): MetricRow` —— **但它是单条**（写死 `'lemeng:retail:net_sales'`）⇒ expr 要**两条** ref，须自建 catalog：
```ts
  // 两条 L1 必须同关系 / 同 grain / 同主体列（否则 MIXED_BASE）—— l1() 的默认值已保证后两者
  const CATALOG = [
    l1({ selectSql: `select sum(${SCHEMA}.fct_retail_sale.net_amount) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale` }),
    l1({ id: 'lemeng:retail:order_count',
         selectSql: `select sum(${SCHEMA}.fct_retail_sale.order_count) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale` }),
  ]
```
- `authorizeLike(m, org, groupBy)` / `localDay(x)`（`localDay` 是既有辅助，`bizday` 是 date 列，**别拿 `String(date)` 或 `toISOString()` 比**——头注里有实测教训）。
  expr 的产物形状与 refine 同形 ⇒ 直接 `authorizeLike({ ...base, selectSql } , 'acme', <可见维度>)` 跑。

用例要证明的事（在**同一个用例内**插入、断言、清理）：

1. 按 `system_book` 造两组成对的量：`3120 → net=150, cnt=3`、`64188 → net=7, cnt=1`；
2. 编译 `div(ref:net_sales, ref:order_count)` 得 `selectSql`；
3. **执行它**，断言每个 `system_book` 只有一行、且值分别为 `50` 与 `7`；
4. **再插一行零分母**（`cnt = 0`、`net = 12`，另一天的 `system_book`，例如 `acme / 90000 / 2026-01-01`），重跑断言那一行的值为 **`NULL`**（不是 0 —— 这是 `NULLIF` 守卫的端到端证据）；
5. 清理**只删本用例插入的行**。

> ⚠️ 表名/列名以同块既有用例的实际写法为准（本计划给的是**数据与断言**；列名若与上面不一致，改成实际的，并把差异写进报告）。
> ⚠️ 没有 `DATABASE_URL` 时整个 `describePg` 会跳过 —— 这条 e2e **必须在有库的环境真跑过**，报告里写清跑的是哪个库。本机原生 postgres 会遮蔽 compose 容器（记忆：`local-postgres-shadows-compose-container`），跑前确认连的是哪个实例。
> ⚠️ 别用「全局清理」：只删自己插的行（记忆：`test-body-global-delete-slaughters-sibling-fixtures`）。

- [ ] **Step 6: 跑 + 提交**

```bash
pnpm --filter data exec vitest run modules/data/domain/semantic-compiler.test.ts modules/data/routes/metrics.test.ts
pnpm typecheck
```

```bash
git add modules/data/domain/semantic-compiler.test.ts modules/data/routes/metrics.test.ts
git commit -m "test(data): L2 B 中档证明加固（逐节点可达集/1200 棵 fuzz/客单价逐字/真库 e2e）"
```

> 若为了 Step 3 而导出了 `parseL1Select`，**把它并进这次提交**并在提交信息里点到（`test(data): … （导出 parseL1Select 供 fuzz 复用）` 之类）——但要在一个 scope 内。

---

## Task 3: 正典指向注记 + 已知边界（含实测的那条）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（只加注记）
- Modify: `modules/data/README.md`（`:41` 表达力行 + `### L2 的已知边界` 一节）

**Interfaces:**
- Consumes: Task 1/2 的落地事实（哪些码、哪条边界、实测到什么）
- Produces: 无

- [ ] **Step 1: 正典 §10 拍板记录 第 5 条下加指向注记（增补 §9(a)）**

打开 `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`，先读 §10 拍板记录附近，**注意该节已有的「原文不删改（历史留档）」说明** —— 本步骤**只加**，不改任何既有行。
在这句之上或之下加一行指向（位置以该节现有体例为准：跟它上面那几条注记同形）：

```md
> **（订正指向 · 2026-10-12）** 本条第 5 行「L2 表达力」的「**不止 A 薄档的四件事**」= **B 中档（受限表达式）**；
> 允许面（节点闭集 / 组合约束 / 除法语义 / v1 的 `filters` 边界 / 规模上限）以
> `2026-10-12-l2-expressiveness-b-tier-design.md` 为准。原文不删改（历史留档）。
```

> `semantic-compiler.ts:18-21` 那处指针**已在 Task 1 落地**（同一文件内留假注释不可接受）。**不要**在本步骤重复改代码。

- [ ] **Step 2: 实测路径的深度上限边界（无案例不立标准 ⇒ 先测再写）**

在有意设计的**病态输入**上量一次真实行为：把一棵远比 `EXPR_MAX_DEPTH` 更深的裸 JSON 体打到写面，看它返回什么。

用文件里已有的测试 app 实例做一次性探针（**Step 1** 里加一条临时用例，跑完删掉，或直接保留成一条只断言「不会建行成功」的用例）：

```ts
  it('病态深度的裸 JSON 体：不会被接受为合法声明（深度闸之前还有一层解析/校验栈）', async () => {
    // 手工拼串：JSON.stringify 自己会先爆栈，所以逐层拼字符串
    let node = '{"kind":"num","value":1}'
    for (let i = 0; i < 5000; i++) node = `{"kind":"add","left":${node},"right":{"kind":"num","value":1}}`
    const raw = `{"id":"deep:probe","op":{"kind":"expr","expr":${node}}}`
    const res = await postRaw(raw)          // 沿用文件里既有的请求方式；Content-Type: application/json
    // 真正的判据：**绝不能被当成合法声明建出来**
    expect(res.status).not.toBe(201)
    // 具体状态码是**实测值**，写进 README（下面的 <实测值>），不在这里写死断言
  })
```

跑这条，**把实际状态码记下来**（把 `console.log(res.status, await res.text())` 临时打一次即可，测完去掉）。两种可能：

- **4xx** ⇒ 深度闸在栈爆之前生效，边界干净；
- **5xx** ⇒ 解析/校验栈先炸（`z.lazy` 递归校验或 `JSON.parse`），`scanExpr` 的迭代走法没能兜住 —— **这不是本次要修的缺陷，是已知边界**，照实写进 README。

- [ ] **Step 3: 更新 `modules/data/README.md`**

1. **`:41` 的表达力行**（在「表达力」那一列/那一格）改成两档并陈，例如：
```md
| L2 表达力 | A 薄档（裁剪 / 别名 / 过滤 / 目标值）+ **B 中档（受限算术表达式）**；C 厚档排除 |
```
（先读该表实际列头，按列对齐；**只改这一格**。）
2. **`### L2 的已知边界（本轮**未**做，别当成漏检）` 一节**（`:201` 起）：在既有两条**之后**追加（既有两条**不改**）：

```md
3. **expr 声明上的 `filters` 不支持**（v1，`OP_UNSUPPORTED`）：比例/比率不可加，对派生表重聚合 `sum` 是错的。
   要支持得改成「**每个 ref 一列**的派生表、重聚合落在组件上」（`sum(a)/NULLIF(sum(b),0)`），是后一增量。
4. **病态深度的表达式树是「先解析、后量纲」**：`EXPR_MAX_DEPTH` / `EXPR_MAX_REFS` 在 zod 解析之后才生效。
   实测（2026-10-12，本机，<库/环境>）：一条深约 5000 层的裸 JSON 体返回 **<实测值>**。
   也就是说超深输入的拒绝路径**不保证**是 400；它的保证只有一条 —— **不会被建成合法声明**。
   要把它变成干净的 400，需要在解析之前加一层线性深度预检（本增量未做）。
5. **原子测度仍只能走 L1**：`expr` 只放开**组合**。要新原子测度（如「退货额」）仍须先进
   `dbt/semantics/l1_metrics.yml` 走 L1（见 §L2 只能 refine 已声明的平台指标那条纪律）。
```

> ⚠️ 第 4 条里的 `<实测值>` / `<库/环境>` **必须是你真跑出来的值**。没跑出来就**不要写这一条**（无案例不立标准：宁缺，不编）。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-09-21-data-platform-layered-design.md modules/data/README.md
git commit -m "docs(data): 回填 L2 表达力档位的正典指向注记与已知边界"
```

---

## 已知边界与不做的事（本计划明列，别当成漏检）

1. **expr 上的 `filters`**：v1 不支持（增补 §2.5/§7）；判据是「声明了」而不是「非空」，空数组也拒。
2. **原子测度**：仍只能走 L1（增补 §7）。本增量只放开**组合**。
3. **`L2` 引 `L2`**：不开放（增补 §2.6，`resolveL1Base` 的既有纪律不变）。
4. **函数 / 条件 / 比较 / 聚合**：不开放（增补 §2.2）。
5. **console 的表达式构建器 UI**：不在本增量（增补 §7，前端可后置）。
6. **agent 接入面**：拍板 6 已标「另题不在本轮」（增补 §7）。
7. **病态深度的拒绝路径不保证 400**：见 Task 3 Step 2/3 —— 实测记录，不在本增量修。
8. **`#573`（shanhai 首批指标登记）**：本增量只能**部分解锁** —— 「两 L1 之比」（客单价）当场可定义；
   「退货率」仍缺 L1「退货额」⇒ 仍卡在 L1/湖列（增补 §8）。
9. **`#176`（写权限轴）**：另一条轴，本增量不碰（增补 §8）。

### 越界提醒（本计划**不**覆盖，别顺手做）

- `docs/superpowers/plans/2026-10-10-shanhai-openclaw-wecom.md` 的 **Task 5 Step 2**（「从湖 L1/L2 物化表接、登记指标」）在这条裁决落地后需要**重新表述**（增补 §8：`#573` 部分解锁 ⇒ 客单价可走 L2，退货率仍须先补 L1）。
  该文件在**另一条分支**上，是**另一份交付物** ⇒ **不在本计划范围**；实施本计划时**不要**动它。落地后向人报告这条后续。
- 明文密钥相关的账（openclaw wecom secret 等）**不属于本计划**，已在其它对话处理，不要触碰。

---

## 自检（写完计划后跑一遍）

- **规格覆盖**：增补 §1（裁决）→ Task 1 Step 3a/3b/3e；§2.1-2.2（形态/节点集）→ 3c/3d/3e + Task 2 Step 1；§2.3（同基）→ 3n；§2.4（除法）→ 3j + Task 2 Step 1/5；§2.5（filters）→ 3n + Step 12；§2.6（只指 L1）→ 3n（`resolveL1Base`）+ Step 12 负例；§2.7（规模）→ 3i + Step 12；§3.1（union）→ 3c/3e；§3.2（两个写面）→ Step 8/9/12/13；§4.1（产物同形/表列不变）→ 3l/3m；§4.2（adopted 闸 N ref）→ Step 7 + Step 12.3；§5（错误码）→ 3b + Step 11 + 「为什么这样切」④；§6.1-6.5（门禁与测试）→ Task 2 全 + 门禁⑧；§6.6（门禁③覆盖 expr）→ Step 15/16；§7（边界）→ 本计划「已知边界」；§8（与其它 issue）→「越界提醒」；§9（两处指针）→ 3a + Task 3 Step 1。**无缺口。**
- **占位符扫描**：**已逐处清零**（写完后按真实文件回读核对过，不是推断）——
  `l2Body` 的真实形状（`:79`：`baseMetric: L1_SALES.id, op:{kind:'refine'}, ...over`）已写进 Step 12；
  T9 读源函数已正名为既有的 **`l2RealSource()`**（`:907`，原先写的 `readDeclarationSource()` **是个不存在的名字，已改**）；
  Task 2 Step 5 已点名 `SCHEMA='t8_standin'` / `seedStandin()` / `l1(over)` / `authorizeLike()` / `localDay()`，并确认替身表**本就有 `order_count` 列**（⇒ `150/3=50`、`7/1=7` 有现成种子支撑）。
  仍**刻意**留给实施者现场读的只剩一处：Task 1 **Step 13** 的 adopted 用例播种方式（同文件既有 `METRIC_SOURCE_NOT_ADOPTED` 用例 `:301-324` 已给出行号，照它的 `post()` 与清理方式写）—— 凭猜写 fixture 会把错误虚构进计划，故只给「必须断言什么」与「不许怎么写」。
  Task 3 Step 3 的 `<实测值>` 是**要求实测**，且明写「跑不出来就别写这一条」。
- **类型一致性**：`compileL2(l1Catalog, decl)` 的两参顺序在 Task 1/2 的所有用例、`metric-write.ts`、门禁正则里一致；`CompiledL2` 的 5 个字段名在 3l/3m/3n/Step 7/Step 12 一致；错误码字面量 `'MIXED_BASE'` / `'EXPR_DEPTH_EXCEEDED'` / `'OP_UNSUPPORTED'` / `'BAD_DECL'` / `'L1_BASE_NOT_FOUND'` 全程一致；门禁里 `opKind` 这个名字在 3o 与 15a/15c 一致。

---

## 实施期勘误（2026-10-12，实测订正）

（本节为实施期回填；上方正文一律不删改，冲突处以本节为准。每条：**位置** + **原文口径** + **实测/裁定口径** + **依据**。）

**① Task 2 Step 1 的逐字期望串少两层括号**（计划 `:1586`）

- 原文口径：`(sum(t.x) + (3)) / NULLIF(((sum(t.y) * (2))), 0)`
- 订正口径（= 手推值 = 实跑值）：`((sum(t.x)) + (3)) / NULLIF(((sum(t.y)) * (2)), 0)`
- 依据：同一文档内三处一致反对原字面 —— `:682-683` 的 `renderExprNode` 实现（`add`/`sub`/`mul`/`div` 各支都把**每个操作数**各包一层括号）、`:335-342` 已钉断言（`add(num1,num2) → '(1) + (2)'`）、`:1709` Step 4 期望串。
- 性质：计划笔误（同一文档自相矛盾）。**人已裁 A**（以规则+实现为准，断言保留「与手推值逐字比对」）。

**② Task 2 Step 3 的 fuzz 生成器未约束 ⇒ 会产零 ref 纯字面量树**（计划 Step 3）

- 原文口径：生成器无 ref 约束，`catch` 只放行 `EXPR_DEPTH_EXCEEDED`。
- 订正口径：生成器改为**保证整棵树至少含一个 ref**（首次收叶子强制 ref）；`catch` 维持逐字只放行
  `EXPR_DEPTH_EXCEEDED` 一行不改；`compiled > 900` 的反空转下界不动。
- 依据：零 ref 纯字面量树撞 `BAD_DECL`（`compileExpr`），会让该分支必红；而它已由既有用例单独覆盖，不丢覆盖面。
  **人已裁 A**。（否掉「放行 `BAD_DECL`」：那是多种非法形状的兜底码，放行会弱化本轮要加固的判据。）

**③ Task 2 Step 2 的 `bothReject`（「域层也拒」）与实现事实冲突**（计划 Step 2）

- 原文口径：域名 `bothReject`、注释「面级拒 **且** 域层拒」，域层码写 `BAD_DECL`。
- 订正口径：**域层编译器不读多余键** ⇒ 落地为「**面级拒 + 域层不读 ⇒ 产物与不带键逐字相等**」，配 4 条真对偶
  （NaN / Infinity / 空 id / 闭集外 kind）；域层对 `{op:{kind:'refine'}}` 的实测码是 **`L1_BASE_NOT_FOUND`**
  （不是 `BAD_DECL`）；NaN 的 `.finite()` 证据走 `L2ExprDeclarationSchema.safeParse` **直调**（绕开 JSON，
  因为 NaN 过不了 JSON，HTTP 面实际收到的是 `null`）。
- 依据：`compileL2` 的唯一非测试调用方是 `modules/data/domain/metric-write.ts:123`，其前两个写面
  （`modules/data/routes/metrics.ts:43-44`、`mcp-metric-tools.ts:29-37`）均已 `.strict()`。
  **人已裁 A（接受已落地版本，零生产代码改动）**。

**④ Task 2 Step 1 的白名单正则 `FRAGMENT_RE` 漏逗号**（计划 `:1557`）

- 原文口径：`/^[A-Za-z0-9_.()+\-*/\s]+$/`
- 订正口径：`/^[A-Za-z0-9_.()+\-*,\/\s]+$/`（**只多一个逗号**）
- 依据：同一 Step 的循环（`:1568-1569`）把 `div` 节点也扫进来，而 `div` 的渲染产物含编译器注入的
  `NULLIF((b), 0)` ⇒ 原正则该条恒红（Step 内自相矛盾）。逗号**只可能**来自该注入守卫、不是输入，
  故白名单本意（不许引号/分号/DDL 关键字）不受损。**人已裁 A。**

**⑤ Task 3 Step 3「既有两条」与 README 实况不符**（计划 Task 3 Step 3）

- 原文口径：「在既有**两条**之后追加」，新条目编号 3/4/5。
- 订正口径：`### L2 的已知边界` 一节**实有 4 条** ⇒ 追加在全部既有条目之后，编号 **5/6/7**；既有四条不改。
- 性质：计划前提笔误（控制方认定，非语义决定）。

**⑥ 复跑命令带包名前缀跑不通**（计划 Task 2 的复跑命令 / Task 2 简报）

- 原文口径：`pnpm --filter data exec vitest run modules/data/…`
- 订正口径：`--filter … exec` 的 cwd 是 `modules/data` ⇒ 带包名前缀的路径报
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`；**正解 = 包内相对路径**
  （如 `routes/metrics.test.ts`、`domain/semantic-compiler.test.ts`，前面加 `pnpm --filter data exec vitest run`）。
- 性质：命令笔误（实测）。
