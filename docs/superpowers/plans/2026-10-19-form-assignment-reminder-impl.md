# forms 指派与催办（T9/T11）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「契约声明了谁该填 + 多久没填就催」的表单，在发布后自动收到 `form.assigned`、到期未提交自动收到 `form.due_reminder`——**零新机制**（不建 HTTP 接缝、不建令牌、不建跨模块通路）。

**Architecture:** 契约新增两个**可选**顶层键 `assignees`（**只存字典引用**，名单本体在受管数据集）/ `due`（发布后 N 天）。**声明式对账**：一个仓内脚本 `scripts/notify-reconcile.mjs` 由 **openship job** 定时跑，直连 DB，做三件事——① 读已发布表单的声明 → 幂等派生两条 notify 规则；② 逐人 emit `form.assigned`；③ 到期未提交者逐人 emit `form.due_reminder`。两处 emit 的 `event_id` 都**确定性派生** ⇒ 重复调度天然去重。脚本 import `modules/notify/**` 与 `modules/forms/**` **不触 B1**（`scripts/` 不在 `lint-architecture.mjs` 扫描根内）。

**Tech Stack:** pg（幂等读 + 复用既有 storage 函数）+ zod/手写校验 + vitest（真库集成测试，照既有 `modules/forms/*.test.ts` 范式）+ Node ESM 脚本（`tsx`）。

## Global Constraints

- **三同纪律**：`manifest.id` = DB schema 名 = API 前缀，本计划不改 manifest，无需触碰。
- **B1 边界**：`modules/forms/**` 与 `modules/notify/**` **互不 import**（扫描根 = `apps/ packages/ modules/`）；唯一允许跨模块 import 的落点是 `scripts/**`（不在扫描根内）。
- **org 一律显式传入**：脚本遍历租户时，每次查询与每次 emit 都带该 `org`；notify 侧 `org` 只来自调用方，不读请求参数。
- **fail-open**：通知链失败**不得**让脚本以「业务失败」退出——emit 失败落回执、计数、不抛；脚本退出码只表达**对账自身**的成功/失败（照 `scripts/reconcile-tenant-sources.mjs` 口径：0=干净，1=有差集/有失败，2=对不成账）。
- **幂等**：所有 DDL 已存在；本计划只读 + 幂等 upsert（`on conflict (org,id)` 已在 notify storage 内）。
- **敏感值不落明文**：`DATABASE_URL` / `NOVU_*` 只从运行环境取；文档只写「在哪取」。
- **无案例不立标准**：名单条目是「人」（Casdoor 用户名），**不**做门店 subject（正典 §2.4 不做清单末条）。
- **cron 按 UTC**：openship job 的 cron 是 UTC（`deploy/data-plane-deploy-sop.md` §E.7 已实测）。
- **Conventional Commits**；feat 必须先有 issue（本批建一枚）；PR body `Closes #<issue>`。

## 决策（已人拍板，2026-10-19）

| # | 决策 | 结论 |
|---|---|---|
| D-A | `form.assigned` 的接缝 | **全交 openship job（声明式对账）**——发布路径**不接线**。语义：`form.assigned` 从「发布瞬间」变为「**下一次调度周期内**」（小时批 ≤1h）。理由：零新机制，且与已采纳的 emit-seam spec 原话一致（「in-platform 这一半既不需要 HTTP、不需要令牌、更不需要跨模块通路」） |
| D-B | 催办对象 = 谁 | **名单里的人**（`assignee`）；`due_reminder` 的规则 `recipient` 由 shipped 的 `'submitter'` 改为 `'assignee'`（见 Task 3——shipped 值是 forms 尚无指派语义时的占位） |

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `modules/forms/domain/contract.ts` | 契约形状 + 编译闸 | **改**：`FormContractBody` 加两键；`compileGate` 加两道闸（⑧⑨） |
| `modules/forms/domain/assignees.ts` | 名单解析（纯/薄 IO） | **新建**：`parseAssignment(body)`（纯）+ `resolveAssigneeKeys(...)`（读字典） |
| `modules/forms/storage.ts` | forms 读面 | **改**：导出 `listAssignmentTargets(pool)`（跨租户列已发布表单的声明，供脚本用） |
| `modules/notify/domain/derive.ts` | 声明派生（纯函数） | **改**：`deriveReminderRule` 的 `recipient` → `'assignee'`；**新增** `deriveFormAssignedRule` |
| `scripts/notify-reconcile.mjs` | 对账脚本（三职责） | **新建** |
| `scripts/notify-reconcile.test.mjs` | 脚本测试（真库） | **新建** |
| `docs/superpowers/plans/2026-10-19-form-assignment-reminder-impl.md` | 本计划 | 新建（本文件） |
| `deploy/notify-reconcile-job.md` | openship job 定义与运维口径 | **新建** |

---

### Task 1: 契约字段 `assignees` / `due`（编译闸两道）

**Files:**
- Modify: `modules/forms/domain/contract.ts`（`FormContractBody` 定义 ~140-143；`compileGate` 尾部 ~250 之后）
- Test: `modules/forms/domain/contract.test.ts`

**Interfaces:**
- Consumes: 既有 `DICT_REF_RE = /^(dict|gdict):([a-z][a-z0-9-]*)$/`（已导出）。
- Produces: `FormContractBody` 变为 `{ schema; uiSchema?; assignees?: { dictRef: string }; due?: { afterDays: number } }`；`compileGate` 新增错误码 `BAD_ASSIGNEE_REF` / `BAD_DUE`。

- [ ] **Step 1: 写失败测试**（追加到 `contract.test.ts`）

```ts
import { compileGate, DICT_REF_RE } from './contract'

const base = { schema: { type: 'object', properties: { a: { type: 'string' } } } }

describe('compileGate：指派与催办两键（§2.4）', () => {
  it('两键缺省 → 通过（向后兼容，存量表单不受影响）', () => {
    expect(compileGate(base).ok).toBe(true)
  })
  it('assignees.dictRef 合法 → 通过', () => {
    expect(compileGate({ ...base, assignees: { dictRef: 'dict:store-staff' } }).ok).toBe(true)
  })
  it('assignees.dictRef 不匹配引用语法 → BAD_ASSIGNEE_REF', () => {
    const r = compileGate({ ...base, assignees: { dictRef: 'store-staff' } })
    expect(r).toMatchObject({ ok: false, code: 'BAD_ASSIGNEE_REF' })
  })
  it('assignees 形状不对（不是对象 / 缺 dictRef）→ BAD_ASSIGNEE_REF', () => {
    expect(compileGate({ ...base, assignees: ['a'] })).toMatchObject({ ok: false, code: 'BAD_ASSIGNEE_REF' })
    expect(compileGate({ ...base, assignees: {} })).toMatchObject({ ok: false, code: 'BAD_ASSIGNEE_REF' })
  })
  it('due.afterDays 正整数 → 通过', () => {
    expect(compileGate({ ...base, due: { afterDays: 7 } }).ok).toBe(true)
  })
  it('due.afterDays 非正整数（0 / 负数 / 小数 / 非数）→ BAD_DUE', () => {
    for (const bad of [0, -1, 1.5, '7', null]) {
      expect(compileGate({ ...base, due: { afterDays: bad } })).toMatchObject({ ok: false, code: 'BAD_DUE' })
    }
    expect(compileGate({ ...base, due: {} })).toMatchObject({ ok: false, code: 'BAD_DUE' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/forms && npx vitest run domain/contract.test.ts`
Expected: FAIL（`assignees.dictRef 不匹配…` 与 `due…BAD_DUE` 两例失败——当前 `compileGate` 对未知顶层键放行）

- [ ] **Step 3: 实现**

`FormContractBody`（contract.ts ~140）：

```ts
export interface FormContractBody {
  schema: Record<string, unknown>
  /** 可选：没有 UI 意图就不写（RJSF 用默认渲染）。 */
  uiSchema?: Record<string, unknown>
  /** 可选（§2.4「指派与催办」）：谁该填——**只存对名单的引用**，名单本体在受管数据集（字典）。 */
  assignees?: { dictRef: string }
  /** 可选（§2.4）：截止 = 发布时刻 + afterDays 天（v1 只此一种）。 */
  due?: { afterDays: number }
}
```

`compileGate` 尾部（在既有 ⑦ 之后、`return { ok: true }` 之前）追加两道闸：

```ts
  // ⑧ 指派声明（§2.4）：只存引用，且引用语法与字段字典同一套（不新增解析器）。
  const rawAssignees = (body as Record<string, unknown>)['assignees']
  if (rawAssignees !== undefined) {
    const ref = (rawAssignees as { dictRef?: unknown } | null)?.dictRef
    if (rawAssignees === null || typeof rawAssignees !== 'object' || Array.isArray(rawAssignees)
        || typeof ref !== 'string' || !DICT_REF_RE.test(ref)) {
      return { ok: false, code: 'BAD_ASSIGNEE_REF', detail: 'assignees.dictRef 必须匹配 dict:<id> / gdict:<id>' }
    }
  }
  // ⑨ 截止声明（§2.4）：v1 只支持「发布后 N 天」，N 必须是正整数。
  const rawDue = (body as Record<string, unknown>)['due']
  if (rawDue !== undefined) {
    const n = (rawDue as { afterDays?: unknown } | null)?.afterDays
    if (rawDue === null || typeof rawDue !== 'object' || Array.isArray(rawDue)
        || typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      return { ok: false, code: 'BAD_DUE', detail: 'due.afterDays 必须是正整数（v1 只支持「发布后 N 天」）' }
    }
  }
```

并把 `BAD_ASSIGNEE_REF` / `BAD_DUE` 加进 `GateResult` 的 code 联合类型（contract.ts ~42 附近）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/forms && npx vitest run domain/contract.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: Commit**

```bash
git add modules/forms/domain/contract.ts modules/forms/domain/contract.test.ts
git commit -m "feat(forms): 契约新增 assignees/due 两键（§2.4 指派与催办）——只存引用 + 编译闸两道"
```

---

### Task 2: 名单解析 `parseAssignment` / `resolveAssigneeKeys`

**Files:**
- Create: `modules/forms/domain/assignees.ts`
- Test: `modules/forms/domain/assignees.test.ts`

**Interfaces:**
- Consumes: `dictOptions(pool, scope, org|null, dictId)`（`modules/forms/storage.ts:297`，返回 `{key,label,sortNo}[]`，**只含 enabled**）；`DICT_REF_RE`。
- Produces:
  - `parseAssignment(body: unknown): { dictRef: string; afterDays: number | null } | null` —— 纯函数；无 `assignees` 返 `null`。
  - `resolveAssigneeKeys(pool: Pool, org: string, dictRef: string): Promise<string[]>` —— 解析为**已生效**的名单 key 列表（Casdoor 用户名）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseAssignment } from './assignees'

describe('parseAssignment（纯函数）', () => {
  it('无 assignees → null（该表单没有指派语义）', () => {
    expect(parseAssignment({ schema: {} })).toBeNull()
    expect(parseAssignment(null)).toBeNull()
  })
  it('有 assignees 无 due → afterDays 为 null', () => {
    expect(parseAssignment({ assignees: { dictRef: 'dict:x' } })).toEqual({ dictRef: 'dict:x', afterDays: null })
  })
  it('两键齐 → 都取出', () => {
    expect(parseAssignment({ assignees: { dictRef: 'gdict:y' }, due: { afterDays: 3 } }))
      .toEqual({ dictRef: 'gdict:y', afterDays: 3 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/forms && npx vitest run domain/assignees.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// assignees.ts — §2.4「指派与催办」：名单**只存引用**，本体在受管数据集（字典）。
// 解析走与字段字典**同一套** dictOptions（不新增解析器）。
import type { Pool } from 'pg'
import { DICT_REF_RE } from './contract'
import { dictOptions, type DictScope } from '../storage'

export type Assignment = { dictRef: string; afterDays: number | null }

/** 纯函数：从契约 body 取指派声明；无 `assignees` ⇒ null（该表单没有指派语义）。 */
export function parseAssignment(body: unknown): Assignment | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const a = (body as Record<string, unknown>)['assignees']
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return null
  const ref = (a as { dictRef?: unknown }).dictRef
  if (typeof ref !== 'string' || !DICT_REF_RE.test(ref)) return null // 编译闸已挡；此处再兜一次
  const d = (body as Record<string, unknown>)['due']
  const n = d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as { afterDays?: unknown }).afterDays : undefined
  const afterDays = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  return { dictRef: ref, afterDays }
}

/** 解析名单：dictRef → **已生效**（enabled）条目 key 列表。key = Casdoor 用户名。 */
export async function resolveAssigneeKeys(pool: Pool, org: string, dictRef: string): Promise<string[]> {
  const scope: DictScope = dictRef.startsWith('gdict:') ? 'global' : 'tenant'
  const dictId = dictRef.replace(/^(dict|gdict):/, '')
  const options = await dictOptions(pool, scope, scope === 'tenant' ? org : null, dictId)
  return options.map((o) => o.key)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/forms && npx vitest run domain/assignees.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/forms/domain/assignees.ts modules/forms/domain/assignees.test.ts
git commit -m "feat(forms): 名单解析 parseAssignment/resolveAssigneeKeys（复用 dictOptions，不新增解析器）"
```

---

### Task 3: notify 派生补齐（`form.assigned` 规则 + 催办对象改 assignee）

**Files:**
- Modify: `modules/notify/domain/derive.ts`
- Test: `modules/notify/domain/derive.test.ts`

**Interfaces:**
- Consumes: `NotificationRule`（`modules/notify/domain/rules.ts:12`）。
- Produces:
  - `deriveFormAssignedRule(org: string, decl: { mount: string; templateId?: string }, now: string): NotificationRule` —— id `derived:form:<mount>:form.assigned`，`recipient: 'assignee'`，模板缺省 `form_assigned`。
  - `deriveReminderRule` 的 `recipient` 由 `'submitter'` 改为 `'assignee'`（**契约变更**：催办对象＝名单里的人；shipped 的 `'submitter'` 是 forms 尚无指派语义时的占位）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { deriveFormAssignedRule, deriveReminderRule } from './derive'

const now = '2026-10-19T00:00:00.000Z'

describe('form 声明派生（§2.4）', () => {
  it('form.assigned 规则：id 确定性 + recipient=assignee', () => {
    const r = deriveFormAssignedRule('acme', { mount: 'form-1' }, now)
    expect(r).toMatchObject({
      id: 'derived:form:form-1:form.assigned', eventType: 'form.assigned',
      mount: 'form-1', recipient: 'assignee', templateId: 'form_assigned', origin: 'derived', enabled: true,
    })
  })
  it('催办规则 recipient=assignee（改：催办对象＝名单里的人）', () => {
    expect(deriveReminderRule('acme', { mount: 'form-1' }, now)).toMatchObject({
      id: 'derived:form:form-1:form.due_reminder', recipient: 'assignee', templateId: 'form_due_reminder',
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/notify && npx vitest run domain/derive.test.ts`
Expected: FAIL（`deriveFormAssignedRule` 未导出；`recipient` 仍是 `'submitter'`）

- [ ] **Step 3: 实现**

在 `derive.ts` 追加：

```ts
/** 表单指派声明（契约含 assignees ⇒ 派生 form.assigned 默认规则）。 */
export type FormAssignedDeclaration = { mount: string; templateId?: string }

export function deriveFormAssignedRule(org: string, decl: FormAssignedDeclaration, now: string): NotificationRule {
  return {
    id: `derived:form:${decl.mount}:form.assigned`,
    org, enabled: true, eventType: 'form.assigned', mount: decl.mount,
    templateId: decl.templateId ?? 'form_assigned',
    recipient: 'assignee', recipientArg: null,
    channels: [...DEFAULT_CHANNELS], cooldownMinutes: null, origin: 'derived', createdAt: now,
  }
}
```

并把 `deriveReminderRule` 的 `recipient: 'submitter'` 改为 `recipient: 'assignee'`，加注释：

```ts
    // 催办对象＝名单里的人（§2.4）；shipped 的 'submitter' 是 forms 尚无指派语义时的占位，
    // 语义应为「这条提醒是关于谁的」= assignee（与 form.assigned / case.awaiting_approval 同键）。
    recipient: 'assignee',
```

- [ ] **Step 4: 跑测试确认通过**（并跑全模块，确认无回归）

Run: `cd modules/notify && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/notify/domain/derive.ts modules/notify/domain/derive.test.ts
git commit -m "feat(notify): 补 form.assigned 派生规则；催办对象改 assignee（§2.4 指派语义）"
```

---

### Task 4: 对账脚本 `scripts/notify-reconcile.mjs`（三职责）

**Files:**
- Create: `scripts/notify-reconcile.mjs`
- Create: `scripts/notify-reconcile.test.mjs`
- Modify: `modules/forms/storage.ts`（新增 `listAssignmentTargets`）

**Interfaces:**
- Consumes: `parseAssignment` / `resolveAssigneeKeys`（Task 2）；`deriveFormAssignedRule` / `deriveReminderRule`（Task 3）；`emit`（`modules/notify/pipeline.ts:48`）；`novuFromEnv`（`modules/notify/domain/novu.ts`）；`upsertRule`（`modules/notify/storage.ts:66`）。
- Produces: `scripts/notify-reconcile.mjs`，用法 `DATABASE_URL=… pnpm exec tsx scripts/notify-reconcile.mjs [--json]`；退出码 0=干净 / 1=有失败 / 2=对不成账。`listAssignmentTargets(pool)` 返回 `Array<{org, assetId, version, publishedAt, dictRef, afterDays}>`。

- [ ] **Step 1: 加 `listAssignmentTargets`（forms 读面）**

在 `modules/forms/storage.ts` 追加（只读，跨租户列**当前活跃版本**）：

```ts
/** §2.4：列出所有租户「当前活跃版本」带指派声明的已发布表单（供 scripts/notify-reconcile 对账用）。
 *  active 版本 = asset_head.active_version（回滚即改此行）——与「以当前 published 版本为准」口径一致。 */
export async function listAssignmentTargets(pool: Pool): Promise<Array<{
  org: string; assetId: string; version: number; publishedAt: string; body: unknown
}>> {
  const { rows } = await pool.query(
    `select v.org, v.asset_id, v.version, v.published_at, v.body
       from forms.asset_version v
       join forms.asset_head h
         on h.org = v.org and h.kind = v.kind and h.asset_id = v.asset_id and h.active_version = v.version
      where v.kind = $1 and v.status = 'published'`, [KIND])
  return rows.map((r) => ({ org: r.org, assetId: r.asset_id, version: r.version, publishedAt: r.published_at, body: r.body }))
}
```

- [ ] **Step 2: 写失败测试**

```js
// scripts/notify-reconcile.test.mjs —— 真库（DATABASE_URL）；无库则 skip（照既有脚本测试姿势）
import { describe, it, expect, beforeAll } from 'vitest'
import { reconcileOnce } from './notify-reconcile.mjs'   // 导出纯编排入口，便于测

describe('notify-reconcile', () => {
  it('名单 N 人 ⇒ 发布后各收到一次 form.assigned；同日重跑不重复（确定性 event_id）', async () => { /* … */ })
  it('到期未提交 ⇒ 各收到一次 form.due_reminder；已提交的人不收', async () => { /* … */ })
  it('契约不含 assignees 的存量表单 ⇒ 零派生、零 emit（负对照）', async () => { /* … */ })
  it('停用规则后不再 emit（负对照）', async () => { /* … */ })
})
```

> 测试用 mock novu（`novu: null` ⇒ 回执记 `failed`）与真库；断言**回执行数/幂等**，不依赖外部服务。

- [ ] **Step 3: 跑测试确认失败**

Run: `DATABASE_URL=$TEST_DB pnpm exec vitest run scripts/notify-reconcile.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现脚本**

```js
#!/usr/bin/env node
// notify-reconcile.mjs — §2.4「指派与催办」声明式对账（T9/T11；决策 D-A：全交 openship job）。
// 三职责（全部幂等，靠确定性 event_id + 规则确定性 id）：
//   ① 派生：已发布表单的声明 → upsert 两条 notify 规则（form.assigned / form.due_reminder）
//   ② 指派：逐人 emit form.assigned（event_id = form:<assetId>:<version>:assigned:<user>）
//   ③ 催办：到期未提交者逐人 emit form.due_reminder（event_id 含日期 ⇒ 同日重跑不重复）
// 为什么是 scripts/ 脚本而非模块端点：它要同时读 forms 与 notify 两个 schema（B1 模块读不到）；
//   scripts/ 不在 lint-architecture 扫描根内（先例：reconcile-tenant-sources.mjs）。
// 退出码：0=干净 / 1=有失败（emit 失败计数>0）/ 2=对不成账（缺 DATABASE_URL / 查询失败）。
import { Pool } from 'pg'
import { parseAssignment, resolveAssigneeKeys } from '../modules/forms/domain/assignees.ts'
import { listAssignmentTargets } from '../modules/forms/storage.ts'
import { deriveFormAssignedRule, deriveReminderRule } from '../modules/notify/domain/derive.ts'
import { novuFromEnv } from '../modules/notify/domain/novu.ts'
import { emit } from '../modules/notify/pipeline.ts'
import { upsertRule } from '../modules/notify/storage.ts'

const DAY = 86400000
const ymd = (d) => new Date(d).toISOString().slice(0, 10)

export async function reconcileOnce(pool, { now = new Date(), novu = null, dryRun = false } = {}) {
  const targets = await listAssignmentTargets(pool)
  let derived = 0, emitted = 0, failed = 0
  for (const t of targets) {
    const decl = parseAssignment(t.body)
    if (!decl) continue                                   // 无指派语义 ⇒ 不派生、不 emit（负对照）
    const users = await resolveAssigneeKeys(pool, t.org, decl.dictRef)
    if (users.length === 0) continue                      // 名单空（字典没条目 / 全软删）⇒ 无事可做
    const nowIso = now.toISOString()

    // ① 派生两条规则（确定性 id ⇒ upsert no-op）
    if (!dryRun) {
      await upsertRule(pool, t.org, deriveFormAssignedRule(t.org, { mount: t.assetId }, nowIso), 'system'); derived++
      if (decl.afterDays !== null) {
        await upsertRule(pool, t.org, deriveReminderRule(t.org, { mount: t.assetId }, nowIso), 'system'); derived++
      }
    }

    // ② 指派：逐人 emit（确定性 event_id ⇒ 重复调度天然去重）
    for (const user of users) {
      const r = await emit({ pool, novu }, {
        org: t.org, eventId: `form:${t.assetId}:${t.version}:assigned:${user}`,
        eventType: 'form.assigned', mount: t.assetId, payload: { assignee: user },
      })
      emitted += r.delivered; failed += r.failed
    }

    // ③ 催办：到期且未提交者
    if (decl.afterDays !== null && now.getTime() >= new Date(t.publishedAt).getTime() + decl.afterDays * DAY) {
      const { rows } = await pool.query(
        `select distinct submitted_by from forms.submission where org=$1 and kind='form' and asset_id=$2 and version=$3`,
        [t.org, t.assetId, t.version])
      const submitted = new Set(rows.map((r) => r.submitted_by))
      const day = ymd(now)
      for (const user of users.filter((u) => !submitted.has(u))) {
        const r = await emit({ pool, novu }, {
          org: t.org, eventId: `form:${t.assetId}:${t.version}:remind:${user}:${day}`,
          eventType: 'form.due_reminder', mount: t.assetId, payload: { assignee: user },
        })
        emitted += r.delivered; failed += r.failed
      }
    }
  }
  return { derived, emitted, failed, targets: targets.length }
}

// CLI 入口（被测试 import 时不执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）'); process.exit(2) }
  const pool = new Pool({ connectionString: url })
  try {
    const r = await reconcileOnce(pool, { novu: novuFromEnv() })
    const line = `notify-reconcile: targets=${r.targets} derived=${r.derived} emitted=${r.emitted} failed=${r.failed}`
    console.log(process.argv.includes('--json') ? JSON.stringify(r) : line)
    process.exit(r.failed > 0 ? 1 : 0)
  } catch (e) {
    console.error('notify-reconcile 对不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally { await pool.end() }
}
```

> ⚠️ `kind='form'` 常量以 `modules/forms/storage.ts` 里的 `KIND` 为准（脚本内联字符串需与之一致；实现时核对）。

- [ ] **Step 5: 跑测试确认通过**

Run: `DATABASE_URL=$TEST_DB pnpm exec vitest run scripts/notify-reconcile.test.mjs`
Expected: PASS（四条含负对照）

- [ ] **Step 6: Commit**

```bash
git add scripts/notify-reconcile.mjs scripts/notify-reconcile.test.mjs modules/forms/storage.ts
git commit -m "feat(notify): 指派与催办对账脚本（三职责，确定性 event_id 幂等）——T9/T11"
```

---

### Task 5: openship job 定义 + 运维口径文档

**Files:**
- Create: `deploy/notify-reconcile-job.md`

**Interfaces:**
- Consumes: Task 4 的脚本 CLI 契约（`DATABASE_URL`、`--json`、退出码 0/1/2）。
- Produces: 一份「在哪建 job、怎么配、怎么读日志、失败怎么告警」的运维口径（**照 `deploy/openship-adopt.md` §job 段落与 `scripts/reconcile-tenant-sources.mjs` 的注释范式**）。

- [ ] **Step 1: 写文档**（要点，正文实现时按仓内既有 runbook 风格展开）

```markdown
# notify-reconcile job（指派与催办定时对账）

## 建在哪 / 怎么建
- openship 面板 Jobs 新建（照 deploy/openship-adopt.md §「清理由 openship job 定时执行」）。
- 命令：一次性容器跑 `pnpm exec tsx scripts/notify-reconcile.mjs --json`（照 deploy/data-compose.yml 的 dbt runner 范式：`docker run` 零常驻）。
- **cron 按 UTC**（deploy/data-plane-deploy-sop.md §E.7 实测）——要「每日 08:00 CST」须写 UTC 00:00。
- 建议频率：**小时级**（D-A 下 `form.assigned` 的延迟 = 一个调度周期）。

## 配置从哪取（不写明文）
- `DATABASE_URL`：从 openship 该项目 env 注入（isSecret）；`NOVU_BASE_URL`/`NOVU_API_KEY` 同。
- ⚠️ 不要去 SSH 读机器状态（违反「唯一通道」铁律）。

## 怎么读结果 / 告警
- 退出码：0=干净 / 1=有失败（回执里 failed>0）/ 2=对不成账。
- **必须订阅失败通知**（job 静默失败 = 通知没发，正典 openship-adopt.md 同款要求）。

## 待实测（不得据以声称可用）
- N=500 名单时的调度耗时与 Novu 限速（正典 §2.4 实施注记的验收项）。
```

- [ ] **Step 2: Commit**

```bash
git add deploy/notify-reconcile-job.md
git commit -m "docs(notify): notify-reconcile job 运维口径（UTC cron / env 取法 / 退出码 / 失败告警）"
```

---

## Self-Review（对照设计稿与正典逐节核）

- 设计稿 §4 契约形状 → Task 1（两键 + 编译闸）
- §5 执行流（发布路径 + 定时路径）→ **决策 D-A 收敛为「全交 job」**：Task 4 的 ②③ 即两条路径，`event_id` 与设计稿逐字一致
- §5 幂等 → Task 4 确定性 `event_id` + 规则确定性 id
- §6 不做清单 → 未列入任务即为不做（多级指派/角色展开/字段驱动截止/补填/名单变更重发/门店 subject）
- §8 验收五条 → Task 4 测试四条（发布各一次、到期一次、已提交不收、存量不变）+ 停用不收
- 正典 §2.4 实施注记「待实测 N=500」→ Task 5 文档登记
- **缺口自陈**：设计稿 §5 只说派生「reminder」一条规则，但 `form.assigned` 事件**也需要一条规则**才能被 `matchRules` 命中（notify 模块 shipped 只有 approval/reminder 两条派生函数）⇒ Task 3 补 `deriveFormAssignedRule`。这是设计稿的**隐含缺口**，本计划显式补齐。
- **口径变更自陈**：`deriveReminderRule` 的 `recipient` 由 shipped 的 `'submitter'` 改为 `'assignee'`（Task 3），理由见 D-B；Task 3 必须同步更新既有断言 `'submitter'` 的测试。
