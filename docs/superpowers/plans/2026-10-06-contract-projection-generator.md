# 契约生成器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `contracts/*.json` 成为湖列集的**唯一事实源**——改契约一处，管线的 `flatten`/`shape` 投影与 dbt staging 投影由生成器重写；B10 从「事后查四面是否一致」降级为「生成物没被手改」。

**Architecture:** 先抽一个共享库 `scripts/lib/data-contract.mjs`（解析契约 / 找生产者 / 找投影节点），门禁与生成器共用同一实现；再写生成器 `scripts/gen-data-projection.mjs`，它**只重写**「`SELECT` … 顶层 `FROM`」之间的列区，**`FROM` 及其之后逐字保留**。契约格式升到 `contractVersion: 2`，列上新增 `expr`。

**Tech Stack:** Node ESM（`scripts/**` 走 `checkJs`）、vitest（`test:guard = vitest run --dir scripts`）、pnpm、JSON Schema draft 2020-12。

**设计依据（必读）：** `docs/superpowers/specs/2026-10-06-contract-projection-generator-design.md`。

## Global Constraints

- `scripts/**` 是 **checkJs**（`tsc -p tsconfig.json`）：JSDoc 一律用**单形状、字段恒在**的对象——可辨识联合会被加宽、收窄失败（见本仓记忆「scripts/ 是 checkJs」）。
- 契约类型枚举里**没有 `double`**（pg_duckdb 不接受；金额用 `decimal`）。
- 新列**一律追加末尾**；staging 投影恒为契约列的**同序前缀**（`docs/architecture.md` §5.2）。
- 改 `dbt/**` 或 `deploy/duckle/console/**` 后**必须**重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，否则 `gates` 的 `check-data-plane-lock` 红。
- 提交走 Conventional Commits；**feat 必须先有 issue**；可见变更走 PR；不手改 CHANGELOG。
- 生成器测试用 **tmpdir 假仓**，不碰真库/真仓（夹具互砍是已知坑）。
- **本计划是串行的**（任务改同一批文件）——不按波次并行派发。

## File Structure

| 文件 | 责任 |
|---|---|
| `scripts/lib/data-contract.mjs`（新） | 纯函数：SQL 掩注释/取别名、契约解析、找生产者管线、找投影节点。只读文件，无其它副作用 |
| `scripts/check-data-contract.mjs`（改） | 门禁；改为 import 自 lib 并**原样 re-export** 旧公开名（保 `check-data-contract.test.ts` 一字不改） |
| `scripts/gen-data-projection.mjs`（新） | 生成器：`--check` / `--seed`；写 ③ 管线投影与 ④ staging 投影 |
| `scripts/gen-data-projection.test.ts`（新） | 夹具测试（tmpdir 假仓），含「`--check` 会红」的变异用例 |
| `contracts/common/_schema.schema.json`（改） | `contractVersion` const `1→2`；column 加 `expr`；顶层预留 `sourceFields` |
| `contracts/common/_template.contract.json`（改） | `contractVersion: 2` + 示例 `expr` |
| `contracts/common/lemeng.{retail_order_line,branch,item}.json`（改） | `contractVersion: 2` + 逐列 `expr`（由 `--seed` 从现有 SQL 抽出） |
| `dbt/models/common/staging/stg_lemeng_{retail_order_line,branch,item}.sql`（生成） | 投影**归一**（每列显式 `::type`） |
| `deploy/duckle/console/pipelines/lemeng.{retail_order_line.window,retail_order_line.tick,dim.branch.l0,dim.item.l0}.json`（生成） | flatten/shape 投影（**应逐字节不变**） |
| `.github/workflows/ci.yml`（改） | `gates` 加一步 `gen-data-projection.mjs --check` |
| `deploy/data-plane.lock`（重生成） | `dbt/` 与 `console/` 变 ⇒ lock 必须同步 |
| `contracts/README.md`、`docs/data-platform-handbook.md`、`docs/architecture.md`（改） | 格式变更说明 + B10 口径订正 |

> **本契约的 4 个产出管线**（都要被生成器重写）：`retail_order_line` → `lemeng.retail_order_line.window.json` + `lemeng.retail_order_line.tick.json`（两个子管线各一个投影节点）；`branch` → `lemeng.dim.branch.l0.json`；`item` → `lemeng.dim.item.l0.json`（后两者的投影节点叫 `shape`）。

---

## Phase 1：共享库与契约格式（零行为变更）

### Task 1：抽出 `scripts/lib/data-contract.mjs`

**Files:**
- Create: `scripts/lib/data-contract.mjs`
- Modify: `scripts/check-data-contract.mjs`
- Test: `scripts/check-data-contract.test.ts`（**不改**——这是本任务的验收面）

**Interfaces:**
- Produces（`lib` 的导出，后续任务全部依赖）：
  - 常量 `CONTRACT_DIR = 'contracts'`、`PIPELINE_DIRS = ['deploy/duckle/console/pipelines','duckle']`、`NON_CONTRACT`、`INJECTED_STAGING_COLUMNS = ['org']`
  - `maskSqlComments(src: string): string`
  - `extractPipelineAliases(sql: string): string[]`
  - `extractStagingAliases(sql: string): string[]`
  - `collectJson(root: string, relDir: string): string[]`
  - `readContractDoc(root: string, rel: string): { rel: string, domain: string, table: string, prefix: string, schemaVersion: unknown, consumerVersion: unknown, columns: { name: string, type: string, nullable: boolean, expr: string }[] } | null`
  - `findProducerPipelines(root: string, prefix: string): string[]`
  - `findProjectionNode(doc: unknown, columnNames: string[]): { id: string, sql: string, aliases: string[] } | null`

- [ ] **Step 1: 建库文件，把现有函数逐字搬过去**

从 `scripts/check-data-contract.mjs` **原样复制** `maskSqlComments` / `extractPipelineAliases` / `extractStagingAliases` / `collectJson`（连注释一起；它们是本仓已验证的取列器）。再新增两个函数：

```js
// scripts/lib/data-contract.mjs（节选：新的三个）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 契约目录（相对仓根）。 */
export const CONTRACT_DIR = 'contracts'
/** 管线目录（相对仓根）——生产者的推导面。 */
export const PIPELINE_DIRS = ['deploy/duckle/console/pipelines', 'duckle']
/** 契约里不是「真契约」的文件名（元 schema 与模板）。 */
export const NON_CONTRACT = new Set(['_schema.schema.json', '_template.contract.json'])
/** dbt 在 staging 层注入的列（不属契约）。 */
export const INJECTED_STAGING_COLUMNS = ['org']

/**
 * 读一份契约的关键字段。**单形状**（字段恒在）——缺字段时分派给调用方报违规。
 * `columns[].expr` 缺失时回落空串（生成器据此判「未回填」）。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ rel: string, domain: string, table: string, prefix: string, schemaVersion: unknown, consumerVersion: unknown, columns: { name: string, type: string, nullable: boolean, expr: string }[] } | null}
 */
export function readContractDoc(root, rel) {
  /** @type {any} */
  let doc
  try {
    doc = JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch {
    return null
  }
  const layout = doc && typeof doc.layout === 'object' && doc.layout !== null ? doc.layout : {}
  const cols = Array.isArray(doc?.columns) ? doc.columns : []
  return {
    rel,
    domain: String(doc?.domain ?? ''),
    table: String(doc?.table ?? ''),
    prefix: String(layout.prefix ?? ''),
    schemaVersion: doc?.schemaVersion,
    consumerVersion: doc?.consumerVersion,
    columns: cols.map((/** @type {any} */ c) => ({
      name: String(c?.name ?? ''),
      type: String(c?.type ?? ''),
      nullable: Boolean(c?.nullable),
      expr: String(c?.expr ?? ''),
    })),
  }
}

/**
 * 生产者 = 有 `snk.*` 节点的属性里写着该 prefix 的管线（**排除只读的 `src.*` 引用**，
 * 该收窄见 #447）。判据与 B10 规则② 同源。
 *
 * @param {string} root
 * @param {string} prefix
 * @returns {string[]}
 */
export function findProducerPipelines(root, prefix) {
  return PIPELINE_DIRS.flatMap((d) => collectJson(root, d)).filter((p) => {
    try {
      /** @type {any} */
      const doc = JSON.parse(readFileSync(join(root, p), 'utf8'))
      const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
      return nodes.some(
        (/** @type {any} */ n) =>
          typeof n?.data?.componentId === 'string' &&
          n.data.componentId.startsWith('snk.') &&
          JSON.stringify(n?.data?.properties ?? {}).includes(prefix),
      )
    } catch {
      return false
    }
  })
}

/**
 * 投影节点 = 该管线里**唯一**一个 `code.sql`，其输出别名序列 == 契约列序。
 * 返回 null 表示 0 个或 ≥2 个（调用方报错，不猜）。
 *
 * @param {unknown} doc
 * @param {string[]} columnNames
 * @returns {{ id: string, sql: string, aliases: string[] } | null}
 */
export function findProjectionNode(doc, columnNames) {
  /** @type {any} */
  const d = doc
  const nodes = Array.isArray(d?.nodes) ? d.nodes : []
  const hits = []
  for (const n of nodes) {
    if (n?.data?.componentId !== 'code.sql') continue
    const sql = n?.data?.properties?.sql
    if (typeof sql !== 'string') continue
    const aliases = extractPipelineAliases(sql)
    if (aliases.length > 0 && aliases.join('\u0000') === columnNames.join('\u0000')) {
      hits.push({ id: String(n?.id ?? ''), sql, aliases })
    }
  }
  return hits.length === 1 ? hits[0] : null
}
```

- [ ] **Step 2: 把 `check-data-contract.mjs` 改成用 lib（并 re-export 旧名）**

顶部改为从 lib 引入；把原来**内联**的 `maskSqlComments` / `extractPipelineAliases` / `extractStagingAliases` / `collectJson` / `CONTRACT_DIR` / `PIPELINE_DIRS` / `NON_CONTRACT` / `INJECTED_STAGING_COLUMNS` 删掉；`readContract` 的调用点改用 `readContractDoc`；②的生产者过滤改用 `findProducerPipelines`；`hits` 的挑选改用 `findProjectionNode`（**注意**：原实现要区分「0/≥2 命中」的报错文案，`findProjectionNode` 返回 null，故命中数需由调用方用 `extractPipelineAliases` 复算一份——保持原报错文案不变）。

```js
// scripts/check-data-contract.mjs 顶部（节选）
import {
  CONTRACT_DIR, INJECTED_STAGING_COLUMNS, NON_CONTRACT, PIPELINE_DIRS,
  collectJson, extractPipelineAliases, extractStagingAliases, findProducerPipelines,
  findProjectionNode, maskSqlComments, readContractDoc,
} from './lib/data-contract.mjs'

// 旧公开名原样 re-export —— check-data-contract.test.ts 直接 import 这三个，不许改它
export { maskSqlComments, extractPipelineAliases, extractStagingAliases }
export { INJECTED_STAGING_COLUMNS }
```

- [ ] **Step 3: 跑门禁与既有测试（**零行为变更**是本任务的判据）**

Run: `pnpm exec tsx scripts/check-data-contract.mjs`
Expected: `check-data-contract: OK（契约 = 湖列集的唯一事实源；生产者与 staging 均已对齐）`

Run: `pnpm run test:guard`
Expected: 全绿（`check-data-contract.test.ts` 一字未改却仍通过 ⇒ 证明搬运没改行为）

- [ ] **Step 4: 类型门（checkJs）**

Run: `pnpm run typecheck:scripts`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/data-contract.mjs scripts/check-data-contract.mjs
git commit -m "refactor(scripts): 抽出 lib/data-contract.mjs —— 门禁与生成器共用取列/定位逻辑（零行为变更）"
```

---

### Task 2：契约格式 v2（`expr` + 预留 `sourceFields`）

**Files:**
- Modify: `contracts/common/_schema.schema.json`
- Modify: `contracts/common/_template.contract.json`
- Modify: `contracts/common/lemeng.retail_order_line.json`、`lemeng.branch.json`、`lemeng.item.json`（**只改 `contractVersion`，本任务不填 `expr`**）
- Modify: `contracts/README.md`

**Interfaces:**
- Produces: 契约 schema 允许 `columns[].expr: string`（可选）与顶层 `sourceFields`（可选，本批不消费）；`contractVersion` 变为 `2`。

- [ ] **Step 1: 元 schema —— `contractVersion` 升 2、column 加 `expr`、顶层预留 `sourceFields`**

在 `_schema.schema.json` 里改三处：

```jsonc
"contractVersion": {
  "description": "契约格式版本。**2 = 列上新增 `expr`（该列从投影输入关系到该列的完整 SQL 表达式，供契约生成器产出管线投影）、顶层预留 `sourceFields`**。1 → 2 是**加字段**（旧文档仍能被 2 读，但 2 的文档带新字段）；改格式必须递增并同步本文件与 README。",
  "const": 2
},
```

顶层 `properties` 里加（与 `columns` 平级）：

```jsonc
"sourceFields": {
  "description": "**预留（本批不消费）**：源侧原始字段清单（名 + 类型），供生成器产出 `src.rest` 的 `data.schema`（设计 spec 的「步 2」）。留位是为了步 2 不再动格式。当前允许缺省。",
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["name", "type"],
    "properties": {
      "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
      "type": { "type": "string", "minLength": 1 }
    }
  }
},
```

`$defs.column` 的 `properties` 里加（与 `description` 平级）：

```jsonc
"expr": {
  "description": "**该列从投影节点的输入关系到该列的完整 SQL 表达式**（逐字，含 cast；如 `CAST(json_extract_string(u.d, '$.order_detail_money') AS DECIMAL(14,2))`）。由 `scripts/gen-data-projection.mjs` 用来产出管线投影。可选：缺省表示该契约尚未回填 `expr`，生成器会跳过它。",
  "type": "string",
  "minLength": 1
}
```

- [ ] **Step 2: 模板同步**

`_template.contract.json`：`"contractVersion": 1` → `2`；给每列补一条 `expr`（示例即可，如 `"expr": "'示例：该列怎么从源算出来'"`），并在文件 `description` 里提一句「`expr` 见 README §2」。

- [ ] **Step 3: 三份契约改 `contractVersion`**

`contracts/common/lemeng.retail_order_line.json` / `lemeng.branch.json` / `lemeng.item.json`：`"contractVersion": 1` → `2`（**本任务不填 `expr`**；`expr` 由 Task 6 的 `--seed` 落）。

- [ ] **Step 4: README 记格式变更**

`contracts/README.md`：§2 字段表加 `columns[].expr` 一行（✅/可选），§4.3 头部订正一句——「**2026-10-06 起 `contracts/` 有消费方**：`scripts/check-data-contract.mjs`（B10 门禁）与 `scripts/gen-data-projection.mjs`（生成器）；§4.3 原「没有任何脚本消费 contracts/」已过时」。

- [ ] **Step 5: 跑一次真实 schema 校验**

Run: `python3 -c "import json,glob;from jsonschema import Draft202012Validator as V; m=json.load(open('contracts/common/_schema.schema.json'));V.check_schema(m); [V(m).validate(json.load(open(f))) for f in glob.glob('contracts/**/*.json') if not f.split('/')[-1].startswith('_')]"`
Expected: 无输出（三份契约过 schema）。若本机无 `jsonschema`：`pip3 install jsonschema` 后重跑。

- [ ] **Step 6: Commit**

```bash
git add contracts/
git commit -m "feat(contracts): 契约格式 v2 —— 列上新增 expr（生成器用）+ 顶层预留 sourceFields"
```

---

## Phase 2：生成器

### Task 3：生成器 ③ —— 重写管线投影 + `--seed`

**Files:**
- Create: `scripts/gen-data-projection.mjs`
- Create: `scripts/gen-data-projection.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readContractDoc` / `findProducerPipelines` / `findProjectionNode` / `collectJson` / `CONTRACT_DIR` / `NON_CONTRACT`
- Produces（本任务导出的纯函数，Task 4/5 依赖）：
  - `selectListBounds(sql: string): { selectStart: number, fromStart: number } | null`
  - `rewriteSelectList(sql: string, newSelectList: string): string`（抛错 = 无法界定）
  - `buildPipelineSelect(columns: {name,expr}[]): string`
  - `extractPipelineExprs(sql: string): Record<string,string>`
  - `splitTopLevelCommas(s: string): string[]`

- [ ] **Step 1: 写失败测试（夹具假仓）**

```ts
// scripts/gen-data-projection.test.ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPipelineSelect, extractPipelineExprs, rewriteSelectList, runGenerate } from './gen-data-projection.mjs'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

function fixture(expr: Record<string, string>, opts: { contractHasExpr?: boolean } = {}) {
  const names = Object.keys(expr)
  const root = mkdtempSync(join(tmpdir(), 'gdp-'))
  roots.push(root)
  mkdirSync(join(root, 'contracts/common'), { recursive: true })
  mkdirSync(join(root, 'deploy/duckle/console/pipelines'), { recursive: true })
  const cols = names.map((n) => ({ name: n, type: 'varchar', nullable: true, ...(opts.contractHasExpr === false ? {} : { expr: expr[n] }) }))
  writeFileSync(join(root, 'contracts/common/x.y.json'), JSON.stringify({
    contractVersion: 2, schemaVersion: 1, consumerVersion: 1, domain: 'x', table: 'y', owner: 't',
    layout: { prefix: 'x/y', partitionStyle: 'hive', partitionBy: [names[0]], fileName: 'all.parquet' },
    batch: { markerColumn: names[0], type: 'varchar' }, columns: cols,
  }, null, 2))
  const select = 'SELECT\n' + names.map((n) => `  ${expr[n]} AS ${n}`).join(',\n')
  writeFileSync(join(root, 'deploy/duckle/console/pipelines/x.y.p.json'), JSON.stringify({
    nodes: [{ id: 'flat', data: { componentId: 'code.sql', properties: { sql: `${select}\nFROM input o\nCROSS JOIN UNNEST(x) AS u(d)` } } }],
  }, null, 2))
  return root
}

describe('生成器 ③', () => {
  it('selectListBounds/rewrite 只换列区，FROM 之后逐字不动', () => {
    const sql = 'SELECT\n  a AS x\nFROM input o\nCROSS JOIN UNNEST(y) AS u(d)'
    const next = rewriteSelectList(sql, 'SELECT\n  CAST(b AS INT) AS x')
    expect(next).toBe('SELECT\n  CAST(b AS INT) AS x\nFROM input o\nCROSS JOIN UNNEST(y) AS u(d)')
  })
  it('extractPipelineExprs 从现有投影反抽 expr', () => {
    const sql = 'SELECT\n  a AS x,\n  CAST(f(g), 2) AS y\nFROM input o'
    expect(extractPipelineExprs(sql)).toEqual({ x: 'a', y: 'CAST(f(g), 2)' })
  })
  it('契约已有 expr ⇒ 生成 == 现有（幂等，零 diff）', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" })
    expect(runGenerate(root, { check: true })).toBe(0)
  })
  it('契约 expr 与投影不一致 ⇒ --check 非零', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" })
    const f = join(root, 'deploy/duckle/console/pipelines/x.y.p.json')
    const d = JSON.parse(readFileSync(f, 'utf8')); d.nodes[0].data.properties.sql = d.nodes[0].data.properties.sql.replace("'lit'", "'other'")
    writeFileSync(f, JSON.stringify(d, null, 2))
    expect(runGenerate(root, { check: true })).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts`
Expected: FAIL —— 模块 `./gen-data-projection.mjs` 不存在

- [ ] **Step 3: 实现生成器 ③**

```js
#!/usr/bin/env node
// scripts/gen-data-projection.mjs —— 契约 → 管线投影生成器（设计稿：
// docs/superpowers/specs/2026-10-06-contract-projection-generator-design.md）。
// 只重写「SELECT … 顶层 FROM」之间的列区；FROM 及其之后逐字保留。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTRACT_DIR, NON_CONTRACT, collectJson, findProducerPipelines, findProjectionNode, readContractDoc,
} from './lib/data-contract.mjs'

/** 顶层逗号切分（忽略括号与单引号内的逗号）。 */
export function splitTopLevelCommas(s) {
  const out = []
  let depth = 0, quote = false, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { cur += c; if (c === "'") quote = false; continue }
    if (c === "'") { quote = true; cur += c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/** 列区边界：开头 SELECT 的起点 … 顶层 FROM 前那个换行的下标。 */
export function selectListBounds(sql) {
  const sel = /^\s*select\b/i.exec(sql)
  if (!sel) return null
  const rest = sql.slice(sel.index)
  const from = /\n\s*from\b/i.exec(rest)
  if (!from) return null
  return { selectStart: sel.index, fromStart: sel.index + from.index }
}

/** 用新的列区替换旧的；无法界定即抛错（不猜）。 */
export function rewriteSelectList(sql, newSelectList) {
  const b = selectListBounds(sql)
  if (!b) throw new Error('无法界定 SELECT … 顶层 FROM —— 该投影不支持生成')
  return sql.slice(0, b.selectStart) + newSelectList + sql.slice(b.fromStart)
}

/** 契约列 → 管线投影列区文本。 */
export function buildPipelineSelect(columns) {
  return 'SELECT\n' + columns.map((c) => `  ${c.expr} AS ${c.name}`).join(',\n')
}

/** 从现有投影反抽 `别名 → 表达式`（`--seed` 用）。 */
export function extractPipelineExprs(sql) {
  const b = selectListBounds(sql)
  if (!b) return {}
  const body = sql.slice(b.selectStart, b.fromStart).replace(/^\s*select\s+/i, '')
  const out = {}
  for (const part of splitTopLevelCommas(body)) {
    const m = /\bAS\s+([a-z][a-z0-9_]*)\s*$/i.exec(part.trim())
    if (m) out[m[1]] = part.trim().slice(0, m.index).trim()
  }
  return out
}

/**
 * @param {string} rootDir
 * @param {{ seed?: boolean, check?: boolean }} [opts]
 * @returns {number} 退出码
 */
export function runGenerate(rootDir, opts = {}) {
  const contracts = collectJson(rootDir, CONTRACT_DIR).filter((p) => !NON_CONTRACT.has(p.split('/').pop() ?? ''))
  let changed = 0, missing = 0
  for (const rel of contracts) {
    const c = readContractDoc(rootDir, rel)
    if (!c) continue
    for (const p of findProducerPipelines(rootDir, c.prefix)) {
      const abs = join(rootDir, p)
      const doc = JSON.parse(readFileSync(abs, 'utf8'))
      const proj = findProjectionNode(doc, c.columns.map((x) => x.name))
      if (!proj) continue
      if (opts.seed) continue // ③ 的 --seed 在 Task 6 落库，本任务先只测生成
      const next = rewriteSelectList(proj.sql, buildPipelineSelect(c.columns))
      if (next === proj.sql) continue
      changed++
      if (!opts.check) {
        for (const n of doc.nodes) if (n?.id === proj.id) n.data.properties.sql = next
        writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n')
      }
    }
    if (c.columns.some((x) => x.expr === '')) missing++
  }
  if (missing > 0) console.error(`gen-data-projection: ${missing} 份契约尚未回填 expr —— 生成器跳过（先跑 --seed）`)
  return changed > 0 && opts.check ? 1 : 0
}

const invoked = process.argv[1]?.endsWith('scripts/gen-data-projection.mjs') ?? false
if (invoked) {
  const root = process.argv[2] ?? process.cwd()
  const flag = process.argv.includes('--check') ? 'check' : process.argv.includes('--seed') ? 'seed' : ''
  if (flag === 'seed') { console.error('gen-data-projection: --seed 在 Task 6 落地'); process.exit(2) }
  process.exit(runGenerate(root, { check: flag === 'check' }))
}
```

> ⚠️ **`JSON.stringify(doc, null, 2) + '\n'`** 必须与管线文件现状的序列化形态一致（缩进 2、行尾换行）——否则「应该零 diff」的 Step 5 会因格式而非内容变红。若真出现纯格式 diff，**改这里对齐现状**，不要手改管线。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 在真仓上验证「③ 零 diff」**

先把 `expr` 临时灌进真契约（Task 6 会正式做，这里只为验证生成器）——**或**直接跳到 Task 6 一起验。若现在验，用 `extractPipelineExprs` 手工核对 3 份契约后跑：

Run: `pnpm exec tsx scripts/gen-data-projection.mjs --check`
Expected: exit 0 且 `git status` 对 4 个产出管线**无改动**（逐字节）。任何 diff = `expr` 回填与现 SQL 不一致，停下查。

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-data-projection.mjs scripts/gen-data-projection.test.ts
git commit -m "feat(scripts): 契约生成器 ③ —— 只重写 SELECT…FROM 列区，FROM 之后逐字保留"
```

---

### Task 4：生成器 ④ —— staging 投影归一 + `org` 注入

**Files:**
- Modify: `scripts/gen-data-projection.mjs`
- Modify: `scripts/gen-data-projection.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `selectListBounds` / `rewriteSelectList`
- Produces: `sqlType(col: {type:string}): string`、`buildStagingSelect(columns: {name,type}[], orgAfter: string): string`；`runGenerate` 增加对 staging 的处理

- [ ] **Step 1: 写失败测试**

在 `scripts/gen-data-projection.test.ts` 追加：

```ts
import { buildStagingSelect, sqlType } from './gen-data-projection.mjs'

describe('生成器 ④', () => {
  it('类型映射：decimal→numeric、integer→int、varchar 原样', () => {
    expect(sqlType({ type: 'decimal' })).toBe('numeric')
    expect(sqlType({ type: 'integer' })).toBe('int')
    expect(sqlType({ type: 'varchar' })).toBe('varchar')
  })
  it('org 注入在 system_book 之后，其它列按契约序', () => {
    const out = buildStagingSelect([{ name: 'batch_id', type: 'varchar' }, { name: 'system_book', type: 'varchar' }, { name: 'amt', type: 'decimal' }], 'system_book')
    expect(out).toBe("select\n  r['batch_id']::varchar as batch_id,\n  r['system_book']::varchar as system_book,\n  {{ subject_org() }}       as org,\n  r['amt']::numeric as amt")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts`
Expected: FAIL —— `buildStagingSelect` / `sqlType` 未导出

- [ ] **Step 3: 实现 ④**

在 `scripts/gen-data-projection.mjs` 增加：

```js
/** 契约类型 → staging 的 DuckDB SQL 类型文本（照现有 staging 用法）。 */
export function sqlType(col) {
  if (col.type === 'decimal') return 'numeric'
  if (col.type === 'integer' || col.type === 'smallint' || col.type === 'bigint') return 'int'
  return col.type
}

/** 契约列 → staging 列区文本（每列显式 cast；org 注入在 orgAfter 之后）。 */
export function buildStagingSelect(columns, orgAfter) {
  const lines = []
  for (const c of columns) {
    lines.push(`  r['${c.name}']::${sqlType(c)} as ${c.name}`)
    if (c.name === orgAfter) lines.push('  {{ subject_org() }}       as org')
  }
  return 'select\n' + lines.join(',\n')
}
```

并在 `runGenerate` 内、每个契约处理完后，对 `dbt/models/common/staging/stg_${c.domain}_${c.table}.sql` 做同样的 `rewriteSelectList`（`orgAfter` = 契约列里 `system_book` 存在则 `'system_book'`，否则第一列名）。staging 的列区前缀是 `select`（小写），`selectListBounds` 大小写不敏感，**无需改动**。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 类型门**

Run: `pnpm run typecheck:scripts`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-data-projection.mjs scripts/gen-data-projection.test.ts
git commit -m "feat(scripts): 契约生成器 ④ —— staging 投影归一（每列显式 ::type）+ org 注入"
```

---

### Task 5：`--check` 接入 CI + lock 重生成

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify（重生成）: `deploy/data-plane.lock`

- [ ] **Step 1: `gates` 加一步（紧跟在 `check-data-contract` 之后）**

在 `.github/workflows/ci.yml` 第 109 行那条 `check-data-contract.mjs` **之后**插入：

```yaml
      # 生成物 == committed：契约一处改，投影由 scripts/gen-data-projection.mjs 生成。
      # 手改投影/漏跑生成器 ⇒ 这里红（B10 已降级为保险丝）。
      - run: pnpm exec tsx scripts/gen-data-projection.mjs --check
```

- [ ] **Step 2: 本地跑一遍 CI 的 gates 面（近似）**

Run: `pnpm run test:guard && pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/gen-data-projection.mjs --check && pnpm exec tsx scripts/check-data-plane-lock.mjs`
Expected: 全绿。（**注**：本仓记忆「本地全量门禁 ≠ CI gates」——真值以推后的 CI 为准。）

- [ ] **Step 3: 重生成 lock（若本任务阶段已有 dbt/console 变更）**

Run: `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs`
Expected: lock 更新 + 校验 OK

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml deploy/data-plane.lock
git commit -m "ci(gates): 接入 gen-data-projection --check（生成物==committed）+ lock 同步"
```

---

## Phase 3：存量回填与验收（3 份契约）

### Task 6：`--seed` 回填 `expr` + 逐字节验收

**Files:**
- Modify: `scripts/gen-data-projection.mjs`（实现 `--seed`）
- Modify: `contracts/common/lemeng.retail_order_line.json`、`lemeng.branch.json`、`lemeng.item.json`（回填 `expr`）
- Modify（生成）: 4 个产出管线 + 3 个 staging

- [ ] **Step 1: 实现 `--seed`**

`--seed` 用 `extractPipelineExprs(proj.sql)` 抽出 `别名 → 表达式`，写回契约对应列的 `expr`（**只填空缺项**；已有值不覆盖），保持 `JSON.stringify(doc, null, 2) + '\n'` 的序列化形态。把 Task 3 里 `if (opts.seed) continue` 那段替换成落库逻辑。

- [ ] **Step 2: 跑 `--seed`，人工复核**

Run: `pnpm exec tsx scripts/gen-data-projection.mjs --seed`
然后 `git diff contracts/` **逐列复核**：抽出的 `expr` 是否与原投影逐字一致（尤其是 `json_extract_string(u.d, '$.…')` 与 `'${ITER_ITEM_*}'` 这类）。

- [ ] **Step 3: 验收 ③（**逐字节**——本计划的核心安全性质）**

Run: `pnpm exec tsx scripts/gen-data-projection.mjs`（默认写）
Expected: `git status` 对 `deploy/duckle/console/pipelines/lemeng.{retail_order_line.window,retail_order_line.tick,dim.branch.l0,dim.item.l0}.json` **无改动**。
任何改动 ⇒ `expr` 回填与现 SQL 不一致（或序列化形态不符）⇒ **停下查**，不许「接受这个 diff」。

- [ ] **Step 4: 验收 ④（评审归一 diff）**

`git diff dbt/models/common/staging/` 应**只有**：每列补显式 `::type`、`org` 位置不变。**不该有**列增删、改序、改名。若出现列集变化 ⇒ `expr`/`type` 或 `consumerVersion` 逻辑有误，停下查。

- [ ] **Step 5: 全量门禁 + lock**

Run: `pnpm run test:guard && pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/gen-data-projection.mjs --check && pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs`
Expected: 全绿

- [ ] **Step 6: 文档收口**

- `contracts/README.md` §4.3 已订正（Task 2）；补一句生成器入口。
- `docs/data-platform-handbook.md` §1.2：B10 那条补「生成器 `gen-data-projection` 已把 ③④ 变生成物，B10 降级为保险丝」。
- `docs/architecture.md` §5.1/§5.2：加一行指针（改列集现在改契约一处 + 跑生成器）。

- [ ] **Step 7: Commit + 开 PR**

```bash
git add -A
git commit -m "feat(contracts): 契约生成器落地存量三源 —— expr 回填 + ③ 逐字节零 diff + ④ 归一（Closes #<issue>)"
```

（`<issue>` = 本任务开工前开的 feat issue。）

- [ ] **Step 8: 合并后验证 ④ 的运行时等价**

合并触发 `lemeng-dbt-materialize` job。用 openship MCP 读该 job 的 run：应为 **PASS 且列序/类型不变**（staging 归一不改变物化结果）。**这是 ④「行为零变更」的实证**，不是靠断言。

---

## Self-Review（计划 vs 设计稿）

- **覆盖**：设计稿 §2.1 `expr` → T1/T2/T6；§2.2 生成器与定位 → T1/T3；§2.3 形态 → T3/T4；§2.4 逐字节 vs 归一 → T3.5/T6.3/T6.4；§3 门禁 → T5；§4 回填验收 → T6；§5 分两步 → 本计划**只做步 1**（步 2 的 `sourceFields` 在 T2 仅**预留**）；§6 非目标 → 无对应任务（正确）。
- **占位符**：无 TBD/TODO；所有代码步骤含真实代码。`--seed` 在 T3 先落桩、T6 实现——**已显式标注**，非隐藏占位。
- **类型一致**：`readContractDoc` 返回 `columns[].expr:string`（恒在）；`findProjectionNode` 返回 `{id,sql,aliases}|null`；`rewriteSelectList(sql,newSelectList)`、`buildPipelineSelect(columns)`、`buildStagingSelect(columns,orgAfter)`、`sqlType(col)` 在 T3/T4 定义、T6 复用——命名一致。
- **风险**：T3.5 的「零 diff」依赖 `JSON.stringify(doc,null,2)+'\n'` 与现管线序列化一致——已在 T3 Step 3 的 ⚠️ 里点名处置。
