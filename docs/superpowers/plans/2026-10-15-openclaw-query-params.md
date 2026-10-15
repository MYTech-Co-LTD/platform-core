# L1 问数参数面（等值 + 日期区间）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 27 条 L1 指标编译出问数参数面（日期区间 + 账套 + domain 等值），使 openclaw bot 能答「近7天净销售额」这类真实问法，随后走 openclaw-wecom 计划 Task 6 真机端到端验收。

**Architecture:** 参数面是 sync 编译产物（`grain ∩ 白名单`，持久化进 `data.metrics.params`，存储层零改动）；`authz.authorize()` 的参数→SQL 单点加 `date_range` 分支（`BETWEEN` + `from>to` 显式报错）；词表响应只投影 `{type, required}`（`column` 不出词表面）；agent 工具描述改为「参数键只能取 list_metrics 返回的键」。spec：`docs/superpowers/specs/2026-10-15-openclaw-data-query-params-design.md`。

**Tech Stack:** TypeScript（Hono 模块 + vitest）、checkJs 脚本（`scripts/sync-data-semantics.mjs`）、Postgres（`data.metrics` jsonb params 列已在）。

## Global Constraints

- 分支已存在：`feat/openclaw-query-params`（spec 提交 `fc037ec` 已在其上）；本计划全部提交继续落在该分支。
- **feat 必须先有 issue**：Task 5 建 issue；PR body 写 `Closes #N`；merge 只等 CI **CLEAN**（UNSTABLE 不合）。
- 提交格式 `<type>(<scope>): <subject>`；CHANGELOG 不手写（release.mjs 独占）。
- shell 里 `$VAR` 紧跟中文一律写 `${VAR}`。
- T2 不变量（`authz.ts` 头注）：词表裁剪「看不见不是报错」；主体钉死（`SUBJECT_RESERVED_KEYS` 出现在参数键即拒）；fail-closed 可解释 reason；本文件不得 import pool/env/Hono。
- 词表防泄漏口径：响应不外泄 `column`/`selectSql`/`subjectColumn`/`groupBy`。
- 本改动**不触碰** `deploy/data-plane-manifest.txt` 覆盖的树（`scripts/sync-data-semantics.mjs` 不在清单）⇒ **无需**重跑 `data-plane-lock.mjs`。
- `modules/data` 的路由/域测试需要真库：`DATABASE_URL` 指本地 compose pg（本机 127.0.0.1:5432 上的实例即可；并发类测试才需要全新空库，本计划不涉及）。
- `date_range` 值形状：`{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }`，闭区间；`from > to`（字符串比较）→ `bad_param` + `detail=range_invalid:<参数名>`；形状坏 → `invalid_value:<参数名>`。空参（undefined/null/''）仍视为「不传」。
- 等值路径（`date`/`string`/`number`）**一字不动**。

---

### Task 1: authz 的 `date_range` 类型与区间谓词

**Files:**
- Modify: `modules/data/domain/authz.ts:11`（类型）、`:121` 起的 `literal()` 区域（新增 `rangeLiteral`）、`:146` 起的 `authorize()` 参数循环
- Test: `modules/data/domain/authz.test.ts`

**Interfaces:**
- Consumes: 既有 `MetricParamDef`（`{column, type, required?}`）、`DATE_RE`、`sqlQuote()`、`authorize()` 的 filters 组装循环（`filters.push(\` AND ${param.column} = ${lit}\`)`）。
- Produces: `MetricParamType = 'date' | 'date_range' | 'string' | 'number'`；内部函数 `rangeLiteral(value: unknown): { ok: true; from: string; to: string } | { ok: false; detail: 'shape' | 'order' }`（不导出，仅供 `authorize` 用）。`authorize()` 对 `type='date_range'` 的参数产出 ` AND <column> BETWEEN '<from>'::date AND '<to>'::date`。

- [ ] **Step 1: 写失败测试**（在 `authz.test.ts` 的 `describe('authorize —— 主体钉死')` 之后追加；夹具构造照文件内 `A2/A3` 用例的现成形状——它已有带 `params` 的指标夹具，复制一个把 `params` 换成下面这组）

```ts
describe('authorize —— date_range 区间参数（spec 2026-10-15 §2.3）', () => {
  const rangeMetric = { /* 照 A3 的夹具形状复制，仅 params 不同： */
    params: { bizday: { column: 'bizday', type: 'date_range' as const } },
  }
  it('R1 合法区间 → BETWEEN 闭区间 SQL', () => {
    const r = authorize('m', [ { ...基夹具, ...rangeMetric } ], requester, { bizday: { from: '2026-10-08', to: '2026-10-14' } })
    expect(r.ok).toBe(true)
    expect(r.plan?.sql).toContain(`bizday BETWEEN '2026-10-08'::date AND '2026-10-14'::date`)
  })
  it('R2 from>to → bad_param + range_invalid（T2 恒空集坑的结构化报错）', () => {
    const r = authorize('m', [cat], requester, { bizday: { from: '2026-10-14', to: '2026-10-08' } })
    expect(r).toMatchObject({ ok: false, reason: 'bad_param', detail: 'range_invalid:bizday' })
  })
  it('R3 缺键/非对象/非日期串 → bad_param + invalid_value', () => {
    for (const v of [{ from: '2026-10-08' }, '2026-10-08', { from: '20261008', to: '2026-10-09' }]) {
      const r = authorize('m', [cat], requester, { bizday: v })
      expect(r).toMatchObject({ ok: false, reason: 'bad_param', detail: 'invalid_value:bizday' })
    }
  })
  it('R4 空串值仍视为「不传」（与既有空参语义一致）', () => {
    const r = authorize('m', [cat], requester, { bizday: '' })
    expect(r.ok).toBe(true)
    expect(r.plan?.sql).not.toContain('BETWEEN')
  })
  it('R5 既有 date 等值路径回归不变（A3 原断言原样通过）', () => {
    const r = authorize('m', [cat], requester, { day: '2026-10-08' })
    expect(r.plan?.sql).toContain(`day = '2026-10-08'::date`)
  })
})
```

（`cat`/`requester`/`基夹具` = 该文件 `A2/A3` 用例已在作用域里的同名物；执行时照抄其构造，**不改它们的断言**。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/authz.test.ts`
Expected: FAIL（`date_range` 不在类型 union，`authorize` 走 `literal` 返回 null → `invalid_value`，R1/R2 断言不成立）。

- [ ] **Step 3: 最小实现**

`authz.ts:11`：

```ts
export type MetricParamType = 'date' | 'date_range' | 'string' | 'number'
```

`literal()` 旁新增（保持文件「参数→SQL 单点」职责）：

```ts
/**
 * date_range 参数值校验：{from,to} 闭区间。形状坏与顺序错**分开报**——
 * from>to 是 T2「恒空集且不报错」老坑的结构化修复，必须给可解释 detail（range_invalid）。
 */
function rangeLiteral(
  value: unknown,
): { ok: true; from: string; to: string } | { ok: false; detail: 'shape' | 'order' } {
  if (typeof value !== 'object' || value === null) return { ok: false, detail: 'shape' }
  const { from, to } = value as { from?: unknown; to?: unknown }
  if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { ok: false, detail: 'shape' }
  }
  if (from > to) return { ok: false, detail: 'order' }   // YYYY-MM-DD 字典序即日历序
  return { ok: true, from, to }
}
```

`authorize()` 参数循环里、`const lit = literal(param, value)` **之前**插入分支（空参 skip 在其之前已存在，保持顺序）：

```ts
    if (param.type === 'date_range') {
      const r = rangeLiteral(value)
      if (!r.ok) {
        return {
          ok: false, reason: 'bad_param', metricId,
          detail: (r.detail === 'order' ? 'range_invalid:' : 'invalid_value:') + name,
        }
      }
      filters.push(` AND ${param.column} BETWEEN ${sqlQuote(r.from)}::date AND ${sqlQuote(r.to)}::date`)
      continue
    }
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter data exec vitest run domain/authz.test.ts`
Expected: PASS（R1–R5 + 既有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/authz.ts modules/data/domain/authz.test.ts
git commit -m "feat(data): 问数参数面 date_range——区间值校验与 BETWEEN 谓词（openclaw 问数前置）"
```

---

### Task 2: sync 白名单推导（`grain ∩ 白名单` → params）

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`（`buildSelectSql` 附近新增 `ASK_PARAM_WHITELIST` + `deriveParams`；替换 `:254-255` 的硬编码 `params: {}`）
- Test: `scripts/sync-data-semantics.test.ts`

**Interfaces:**
- Consumes: 该文件已解析的 `grain: string[]`（`:244`）。
- Produces: `export function deriveParams(grain: readonly string[]): Record<string, MetricParamDef>`（JSDoc 类型沿用文件内既有的 `MetricParamDef` 引用方式）；每条 L1 的 `data.metrics.params` 变为推导产物。`comparableOf` 已含 params ⇒ 首次物化 diff = **更新 27**（预期行为，不是 bug）。

- [ ] **Step 1: 写失败测试**（追加到 `sync-data-semantics.test.ts`；import 行与该文件既有 `buildSelectSql` 的 import 同形）

```ts
import { deriveParams } from './sync-data-semantics.mjs'

describe('deriveParams —— 问数参数面白名单推导（spec 2026-10-15 §2.2）', () => {
  it('D1 全维 grain → 只剩白名单三件，参数名=列名', () => {
    expect(deriveParams(['system_book', 'bizday', 'domain', 'branch_num', 'region_id'])).toEqual({
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
      domain: { column: 'domain', type: 'string' },
    })
  })
  it('D2 无 domain 的 grain → 两件（bizday + system_book）', () => {
    expect(deriveParams(['system_book', 'bizday', 'branch_num'])).toEqual({
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
    })
  })
  it('D3 编码维度一个不进（branch_num/item_num/supplier_num/storehouse_num/client_fid/region_id/expense_type/other_inout_kind）', () => {
    const p = deriveParams(['system_book', 'bizday', 'branch_num', 'storehouse_num', 'item_num', 'client_fid', 'supplier_num', 'region_id', 'expense_type', 'other_inout_kind'])
    expect(Object.keys(p).sort()).toEqual(['bizday', 'system_book'])
  })
  it('D4 required 恒缺省（空参=全量，历史调用形态不破坏）', () => {
    expect(Object.values(deriveParams(['system_book', 'bizday', 'domain'])).every((p) => p.required === undefined)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/sync-data-semantics.test.ts`
Expected: FAIL（`deriveParams` is not a function / 不存在）。

- [ ] **Step 3: 最小实现**（`sync-data-semantics.mjs`，放 `buildSelectSql` 导出之后）

```js
/**
 * 问数参数白名单（spec 2026-10-15 §2.2）：grain ∩ 白名单 = 该指标的问数参数面。
 * 判定原则：值域「模型或用户说得出」的维度才可作参数（bizday 日期人会说、system_book=3120/64188
 * 记得住、domain∈{transfer,wholesale} 记得住）；业务编码维度（branch_num/item_num/…）说了不出合法值，
 * 暴露即死参数——回流条件：设计「维度值解析」工具后再扩集。
 * 参数名 = 列名（与 group_by 同名，模型看到什么就能填什么）；required 恒缺省（空参=全量）。
 */
const ASK_PARAM_WHITELIST = {
  bizday: { column: 'bizday', type: 'date_range' },
  system_book: { column: 'system_book', type: 'string' },
  domain: { column: 'domain', type: 'string' },
}

export function deriveParams(/** @type {readonly string[]} */ grain) {
  return Object.fromEntries(
    grain.filter((/** @type {string} */ c) => c in ASK_PARAM_WHITELIST)
      .map((/** @type {string} */ c) => [c, ASK_PARAM_WHITELIST[c]]),
  )
}
```

替换 `:254-255` 两行：

```js
      // 问数参数面：grain ∩ 白名单（spec 2026-10-15 §2.2）。L2 仍不开放参数面（维持下行旧注释的边界）。
      params: deriveParams(grain),
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm exec vitest run scripts/sync-data-semantics.test.ts`
Expected: PASS（D1–D4 + 既有用例）。

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts
git commit -m "feat(data): L1 问数参数面编译——grain 白名单推导 params（spec 2026-10-15 §2.2）"
```

---

### Task 3: 词表投影（`/metrics` 响应带 `{type, required}`）

**Files:**
- Modify: `modules/data/routes/metrics.ts:54`（`publicView`）
- Test: `modules/data/routes/metrics.test.ts`

**Interfaces:**
- Consumes: `MetricParamDef`（`../domain/authz`，需加 type import）；`publicView` 现签名 `(m: { id; title; description })`，调用点 `:131` 不变（`visibleMetrics` 返回的行天然带 `params`）。
- Produces: `GET /metrics` 每行多 `params: Record<名, {type, required}>`；响应不含 `column`/`select_sql`/`group_by`。管理面 `adminView` 不动（本来就全量）。

- [ ] **Step 1: 写失败测试**（追加到 `metrics.test.ts` 的某个 `describePg` 块；**app 构造、鉴权头、`upsertL1Metric` 用法照本文件紧邻用例逐字复制**——文件已 import `buildTestApp`/`makeIdentity`/`upsertL1Metric`，ORG 隔离键沿用本文件的 `ORG`）

```ts
describePg('GET /metrics —— 参数面投影（spec 2026-10-15 §2.4）', () => {
  it('P1 params 只含 {type, required}；column 与 SQL 形状不出词表响应', async () => {
    // 夹具：l1Def({ id: `${L1_ID_PREFIX}params_face`, params: { bizday: { column: 'bizday', type: 'date_range' }, system_book: { column: 'system_book', type: 'string' } } })
    // ↑ 用本文件现成的 l1Def 造，upsertL1Metric 入库；app/request 写法照本文件上一个 GET /metrics 用例。
    const res = await app.request('/api/modules/data/metrics', { /* 头照抄邻近用例 */ })
    expect(res.status).toBe(200)
    const { metrics } = await res.json()
    const row = metrics.find((m: { id: string }) => m.id === `${L1_ID_PREFIX}params_face`)
    expect(row.params).toEqual({
      bizday: { type: 'date_range', required: false },
      system_book: { type: 'string', required: false },
    })
    expect(JSON.stringify(row)).not.toContain('"column"')
    expect(JSON.stringify(row)).not.toContain('select_sql')
    expect(JSON.stringify(row)).not.toContain('group_by')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run routes/metrics.test.ts`（需 `DATABASE_URL`）
Expected: FAIL（响应无 `params` 键）。

- [ ] **Step 3: 最小实现**（`metrics.ts:54` 整体替换 `publicView`，并在文件头 type import 区加 `MetricParamDef`）

```ts
import type { MetricParamDef } from '../domain/authz'

/**
 * 词表投影：id/标题/说明 + **参数面形状**（type/required）——模型据此才知道能填什么键。
 * `column` 是 SQL 内部面，不出词表响应（与头注「selectSql/subjectColumn 不外泄」同口径）。
 */
const publicView = (m: { id: string; title: string; description: string; params?: Record<string, MetricParamDef> }) => ({
  id: m.id, title: m.title, description: m.description,
  params: Object.fromEntries(
    Object.entries(m.params ?? {}).map(([name, p]) => [name, { type: p.type, required: p.required ?? false }]),
  ),
})
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter data exec vitest run routes/metrics.test.ts`
Expected: PASS（P1 + 既有用例；既有用例若断言响应逐字段相等需同步加 `params: {}`——执行时跑了就知道）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/metrics.ts modules/data/routes/metrics.test.ts
git commit -m "feat(data): 词表响应投影问数参数面形状（type/required，column 不外泄）"
```

---

### Task 4: agent 工具描述（`query_metric` 参数契约）

**Files:**
- Modify: `modules/data/domain/agent-loop.ts:41`（`const TOOLS` → `export const TOOLS`）、`:49-58`（`query_metric` description）
- Test: `modules/data/domain/agent-loop.test.ts`

**Interfaces:**
- Produces: `export const TOOLS: ToolSpec[]`（只加 export，形状不变）；新 description（下方逐字）。

- [ ] **Step 1: 写失败测试**（追加到 `agent-loop.test.ts`）

```ts
describe('TOOLS —— query_metric 参数契约（spec 2026-10-15 §2.5）', () => {
  it('T1 描述锁定：参数键只能取 list_metrics 返回值；date_range 传 {from,to}；未声明参数只能空参全量', () => {
    const q = TOOLS.find((t) => t.name === 'query_metric')
    expect(q).toBeDefined()
    const d = q!.description
    expect(d).toContain('list_metrics 返回的该指标 params 键名')
    expect(d).toContain('{from')
    expect(d).toContain('空参查全量')
  })
})
```

（import 行补 `TOOLS`；该文件若未导出会先红。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/agent-loop.test.ts`
Expected: FAIL（`TOOLS` 未导出）。

- [ ] **Step 3: 最小实现**：`const TOOLS` 改 `export const TOOLS`；`query_metric` 的 description 整体替换为：

```ts
      '按指标 id 查询数据。参数键**只能**取 list_metrics 返回的该指标 params 键名（未列出的键会被拒绝）。',
      'type=date_range 的参数传 {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} 闭区间（查某天则 from=to）；',
      'type=string/number 的参数只做**等值**匹配，且同列不要同时传（会拼出恒空条件且不报错）。',
      '未声明 params 的指标只能空参查全量（可能返回大量行）——能用参数就用参数。',
```

（数组保持既有拼接方式 `join('')`，上面 4 行即数组元素。）

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter data exec vitest run domain/agent-loop.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/agent-loop.ts modules/data/domain/agent-loop.test.ts
git commit -m "feat(data): query_metric 工具描述对齐参数面契约（键名取自 list_metrics）"
```

---

### Task 5: 全量验证 + issue + PR

**Files:** 无新改动（验证与流程）。

- [ ] **Step 1: 全量测试**（需 `DATABASE_URL`）

```bash
pnpm --filter data test          # modules/data 全包
pnpm test:guard                  # scripts 全部守卫测试（含 sync-data-semantics）
pnpm typecheck
```
Expected: 全绿。

- [ ] **Step 2: 本地物化验证**（连本地 compose pg）

```bash
DATABASE_URL=<本地库> node scripts/sync-data-semantics.mjs
```
Expected: diff 输出 **更新 27 / 新增 0 / 删除 0**（`comparableOf` 含 params ⇒ 27 条全部判「更新」——预期行为）。

- [ ] **Step 3: 快门禁**（改动不涉清单树，lock 无需重生成；跑一遍以示无附带破坏）

```bash
for s in check-manifests lint-architecture check-compose check-env-example check-data-models check-data-contract check-data-plane-lock check-console-schedules check-console-alerts check-diagnostic-tool check-prune-roots; do pnpm exec tsx scripts/$s.mjs || break; done
pnpm exec tsx scripts/gen-data-projection.mjs --check
```
Expected: 全 OK（`check-tenant-isolation` 需真库，CI 侧跑）。

- [ ] **Step 4: 建 issue**（feat 必须先有 issue）

```bash
gh issue create --title 'feat(data): L1 问数参数面——等值/日期区间参数（openclaw 问数前置）' --body-file - <<'EOF'
## 背景
openclaw 问数链路已端到端通（wecom 审计 69 条），但 27 条 L1 零参数声明 ⇒ 只能空参全量查（1000 行 dump）；
真实问法「近7天销售额」（start/end_date）44 条全 bad_param。spec：docs/superpowers/specs/2026-10-15-openclaw-data-query-params-design.md（已批）。
## 方案（F′）
sync 编译期 `grain ∩ {bizday, system_book, domain}` → params；authz 加 date_range（BETWEEN，from>to 显式 range_invalid）；词表投影 {type,required}；工具描述对齐。推导规则/验收/不做清单见 spec。
EOF
```

- [ ] **Step 5: 推分支开 PR**

```bash
git push -u origin feat/openclaw-query-params
gh pr create --title 'feat(data): L1 问数参数面——等值/日期区间参数（openclaw 问数前置）' --body-file - <<'EOF'
Closes #<Task5 Step4 的 N>

## 什么
spec docs/superpowers/specs/2026-10-15-openclaw-data-query-params-design.md（设计含架构重审与已否决候选）：
① sync 编译期 `grain ∩ 白名单` → params（bizday→date_range / system_book / domain，参数名=列名，required 恒缺省）
② authz `date_range`：`{from,to}` → BETWEEN；`from>to` → 显式 `range_invalid`（T2 恒空集坑升为结构化报错）；等值路径一字未动
③ `GET /metrics` 投影 `params: {type, required}`（column/select_sql/group_by 不出词表响应）
④ `query_metric` 工具描述对齐（参数键只能取 list_metrics 返回值）

## 验证
本地：authz/sync/routes/agent-loop 测试 + `pnpm --filter data test` + `test:guard` + typecheck + 12 项快门禁；
本地物化 diff = 更新 27（params 变更，预期）。CI 全绿后 merge。
## 部署与验收
merge → 山海主项目部署 → 词表 job 重跑（更新 27）→ openclaw 真机端到端（openclaw-wecom 计划 Task 6，另帖记证据）。
EOF
```

- [ ] **Step 6: 盯 CI 到 CLEAN 后 merge**（squash；分支清理照 `gh-pr-merge-delete-branch` 惯例：merge 成功后验 origin/main，再手工删分支）

---

### Task 6（ops）: 部署链 + 词表重跑 + 真机端到端（openclaw-wecom Task 6）

**Files:** 无仓内改动（openship MCP + 企微真机轮）。

**Interfaces:**
- Consumes: shanhai 主项目 `proj_GLXUtN2bJ92DpPrS`（openclaw/server/postgres 服务键已核：openclaw=`svc_3R9wVrQSz__9nwgc`、postgres=`svc_leSjobAoX-nm5er6`）；词表 job `custom:tuQ06mlxBe_2TlTo`；`deploy/openship-adopt.md` 的部署惯例。
- Produces: 生产 `data.metrics.params` 非空（27 条）；Task 6 Step 3–6 验收证据帖。

- [ ] **Step 1: merge 后等 main 更版跑完 → 触发山海主项目部署**

`post_deployments { projectId: 'proj_GLXUtN2bJ92DpPrS', branch: 'main', commitSha: <合并提交全 SHA，git rev-parse 逐字取> }`。
判活：`get_deployments_by_id` 到成功；**server 容器 CreatedAt > 镜像构建时间**（部署后验铁律）。

- [ ] **Step 2: 触发词表 job**（`custom:tuQ06mlxBe_2TlTo`，跑在平台镜像里吃新 dbt 快照）

Expected 输出含「**更新 27**」；随后 postgres 服务 exec 验库：

```sql
select count(*) filter (where params::text <> '{}') as with_params, count(*) as total from data.metrics;
```
Expected: `with_params=27, total=27`；抽查 `select id, params from data.metrics where id='lemeng:retail:net_sales';` → `{bizday:{column:"bizday",type:"date_range"}, system_book:{…}, }`（注：净销售额 grain 无 domain，两件）。

- [ ] **Step 3: 词表探针**（openclaw 容器 exec，key 从容器 env 取不落盘）

```sh
curl -s "http://server:13000/api/modules/data/metrics" -H "x-channel-key: $DATA_WECOM_CHANNEL_KEY" -H "x-wecom-userid: ZhangDuo" | head -c 600
```
Expected: 200，行内 `params` 含 `{"bizday":{"type":"date_range","required":false}}` 且**无** `column`。
（若 userid 探针 401 NOT_LINKED：换 Task 6 验收要用的真实企微 userid。）

- [ ] **Step 4: 真机五问（**用户在企微发消息**，bot=现有 wecom 机器人）**

1. 「10月12日净销售额」→ 期望：带 `bizday:{from:'2026-10-12',to:'2026-10-12'}` 查询，答案出数；
2. 「近7天净销售额」→ 期望：一次区间查询出数（不再逐日、不再 bad_param）；
3. 「3120 账套 10 月的净销售额」→ 期望：`system_book` 等值 + 跨月区间；
4. 「调出和批发各多少」→ 期望：两条 `domain` 等值查询；
5. 「毛利率是多少」→ 期望：词表无此指标（⛔D08 未上线）时模型如实说明，**不臆造**。

每问后看 openclaw 容器日志：`[plugin -> server]` 流式帧 + `finish=true`；占位首响 ≤2s（Task 6 Step 4 硬指标表照抄取证）。

- [ ] **Step 5: 审计落库验证**（postgres exec）

```sql
select metric_id, params, row_count, verdict, created_at from data.query_audit
where channel='wecom' and created_at > now() - interval '1 hour' order by created_at desc limit 10;
```
Expected: 本轮各问一行、`verdict='ok'`、`params` 含区间值。

- [ ] **Step 6: 收尾**（openclaw-wecom 计划 Task 6 Step 6 照走）

- 验收证据（探针输出/五问答案/审计行/流式时间戳）回帖 openclaw-wecom 计划的跟踪 issue；
- spec §11 风险表逐项销账（requesterSenderId 形状、LLM 流式、corpId 核对——若上轮已销则引用）；
- 遗留不阻塞项记录：mytech 项目 openclaw 行 `disabled` 巡检口径 → deploy runbook；维度解析工具（branch_num 回流条件）→ 本仓 issue 登记。

---

## Self-Review 记录

- **Spec 覆盖**：§2.2 推导→T2；§2.3 区间→T1；§2.4 投影→T3；§2.5 描述→T4；§4 单测三条→T1/T2/T3（真机五问→T6 Step 4）；§5 不做清单→无实现任务（正确）；§3 兼容（空参语义）→T1 R4/T2 D4。无缺口。
- **占位符**：T3 的「app/request 写法照邻近用例」与 T1 的「夹具照 A2/A3 构造」是**指向同文件既有逐字代码的复用指令**（执行者打开文件即得），非空洞；其余全部给出逐字代码/命令。
- **类型一致性**：`date_range` 字符串在 T1（类型 union）、T2（白名单字面量）、T3（断言）、T4（描述）四处逐字一致；`range_invalid:`/`invalid_value:` detail 前缀 T1 内一致；`deriveParams` 名称 T2 定义与测试一致；`TOOLS` 导出名 T4 一致。
