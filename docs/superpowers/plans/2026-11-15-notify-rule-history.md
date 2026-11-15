# 规则历史与回滚 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次规则写入在 audit 中留下完整快照，并提供 `GET /rules/:id/history` 与 `POST /rules/:id/restore`，支持单步回滚。

**Architecture:** 不新增 revision 表；复用 `notify.audit.detail.snapshot` 作为不可变历史。恢复是一次普通规则写入：先按当前事件声明/通道/模板重新校验快照，再 `upsertRule` 并写 `rule.restore` 审计。

**Tech Stack:** Hono（模块路由）、PostgreSQL（`notify.audit` jsonb）、vitest（真库测试）、TypeScript。

**Spec:** `docs/superpowers/specs/2026-11-15-notify-remaining-candidates-design.md` §4

---

## File Structure

| 文件 | 责任 |
|---|---|
| `modules/notify/migrations/017_notify_audit_rule_history_index.sql` | history 查询索引 |
| `modules/notify/domain/rules.ts` | `RuleSnapshot` 类型 + `ruleSnapshot()` 纯函数（各写路径共用） |
| `modules/notify/storage.ts` | `listRuleHistory` / `getRuleAuditSnapshot`；`RuleInput` 改为 `RuleSnapshot` 别名 |
| `modules/notify/routes.ts` | HTTP 写路径快照、history/restore 端点 |
| `modules/notify/manifest.yaml` | history/restore 两条声明 |
| `modules/notify/mcp.ts` | MCP 写路径快照 |
| `modules/notify/agent-actions.ts` | agent 规则写路径快照 |
| `modules/notify/*.test.ts` | 各层回归 |

---

### Task 1: 快照类型与历史查询

**Files:**
- Create: `modules/notify/migrations/017_notify_audit_rule_history_index.sql`
- Modify: `modules/notify/domain/rules.ts`（文件末尾追加）
- Modify: `modules/notify/storage.ts:13-28`（`RuleInput`）与文件末尾追加查询函数
- Test: `modules/notify/storage.test.ts`

- [ ] **Step 1: 写迁移**

```sql
-- 017_notify_audit_rule_history_index.sql — 规则历史按 (org,target) 查询（2026-11-15）
--
-- 现有索引是 (org, created_at desc)；history 固定按 rule id 过滤，单租户审计行变多后
-- 会退化成扫描。补 (org, target, created_at desc)。
create index if not exists idx_notify_audit_org_target
  on notify.audit (org, target, created_at desc);
```

- [ ] **Step 2: 在 `domain/rules.ts` 增加快照类型与构造函数**

```ts
/** 规则的可回滚快照（= storage.RuleInput 的字段集；放 domain 避免 storage ↔ domain 环）。 */
export type RuleSnapshot = {
  id: string
  enabled: boolean
  eventKey: string
  scope: string
  recipientKey: string
  recipientLiteral: string[] | null
  recipientDepts: string[] | null
  templateKey: string
  channels: string[]
  cooldownMinutes: number | null
  origin: RuleOrigin
  ownerNamespace?: string | null
}

/** 从当前规则行构造快照；`overrides` 用于写入后的 enabled 等目标状态。 */
export function ruleSnapshot(
  rule: NotificationRule,
  overrides: Partial<RuleSnapshot> = {},
): RuleSnapshot {
  return {
    id: rule.id,
    enabled: rule.enabled,
    eventKey: rule.eventKey,
    scope: rule.scope,
    recipientKey: rule.recipientKey,
    recipientLiteral: rule.recipientLiteral,
    recipientDepts: rule.recipientDepts,
    templateKey: rule.templateKey,
    channels: rule.channels,
    cooldownMinutes: rule.cooldownMinutes,
    origin: rule.origin,
    ownerNamespace: rule.ownerNamespace ?? null,
    ...overrides,
  }
}
```

- [ ] **Step 3: 让 `storage.RuleInput` 复用该类型**

`modules/notify/storage.ts` 顶部 import 处补 `RuleSnapshot`，并把现有 `RuleInput` 定义替换为：

```ts
export type RuleInput = RuleSnapshot
```

（`storage.ts` 已 import `NotificationRule`，同文件再加 `type RuleSnapshot` 即可。）

- [ ] **Step 4: 写失败测试（storage.test.ts 末尾追加）**

```ts
describePg('notify 规则历史（N5 后续）', () => {
  const ORG_H = 'org-rule-history'
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.audit where org=$1', [ORG_H])
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.audit where org=$1', [ORG_H])
  })

  const snap = {
    id: 'rule:h1', enabled: true, eventKey: 'm.a.b', scope: '*',
    recipientKey: 'approver', recipientLiteral: null, recipientDepts: null,
    templateKey: 't1', channels: ['inapp_default'], cooldownMinutes: null,
    origin: 'manual' as const, ownerNamespace: null,
  }

  it('有 snapshot 的条目 complete=true；旧条目 complete=false', async () => {
    await audit(pool, ORG_H, 'u1', 'rule.upsert', 'rule:h1', { snapshot: snap })
    await audit(pool, ORG_H, 'u1', 'rule.enabled', 'rule:h1', { enabled: false }) // 旧形状
    const h = await listRuleHistory(pool, ORG_H, 'rule:h1', 10)
    expect(h).toHaveLength(2)
    const withSnap = h.find((x) => x.action === 'rule.upsert')!
    expect(withSnap).toMatchObject({ complete: true, actor: 'u1', snapshot: snap })
    const legacy = h.find((x) => x.action === 'rule.enabled')!
    expect(legacy).toMatchObject({ complete: false, snapshot: null })
  })

  it('getRuleAuditSnapshot 只回本 org + 本 rule + 有快照的条目', async () => {
    await audit(pool, ORG_H, 'u1', 'rule.upsert', 'rule:h1', { snapshot: snap })
    const id = Number((await pool.query(
      "select id from notify.audit where org=$1 order by id desc limit 1", [ORG_H])).rows[0].id)
    expect(await getRuleAuditSnapshot(pool, ORG_H, 'rule:h1', id)).toMatchObject({
      complete: true, snapshot: snap,
    })
    expect(await getRuleAuditSnapshot(pool, 'org-other', 'rule:h1', id)).toBeNull()
    expect(await getRuleAuditSnapshot(pool, ORG_H, 'rule:other', id)).toBeNull()
  })
})
```

- [ ] **Step 5: 补 storage.test.ts import**

在 `modules/notify/storage.test.ts` 的 `./storage` import 块加入
`getRuleAuditSnapshot, listRuleHistory`（`audit` 已在）。

- [ ] **Step 6: 运行测试确认失败**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run storage.test.ts -t "规则历史"`
Expected: FAIL，`listRuleHistory is not a function`。

- [ ] **Step 7: 实现查询函数（storage.ts 末尾追加）**

```ts
export type RuleHistoryEntry = {
  auditId: number
  at: string
  actor: string
  action: string
  complete: boolean
  snapshot: RuleSnapshot | null
}

/** 哪些 audit action 属于「规则写」——history 只列这些。 */
export const RULE_WRITE_ACTIONS = [
  'rule.upsert', 'rule.enabled', 'rule.restore',
  'mcp.propose_rule', 'mcp.update_rule', 'mcp.set_rule_enabled',
  'agent.rule.upsert',
] as const

function isRuleSnapshot(v: unknown): v is RuleSnapshot {
  if (typeof v !== 'object' || v === null) return false
  const x = v as Record<string, unknown>
  return typeof x.id === 'string' && typeof x.eventKey === 'string'
    && Array.isArray(x.channels) && typeof x.enabled === 'boolean'
}

function toHistoryEntry(r: {
  id: string | number; actor: string; action: string
  detail: Record<string, unknown> | null; created_at: Date
}): RuleHistoryEntry {
  const snap = r.detail?.snapshot
  return {
    auditId: Number(r.id),
    at: r.created_at.toISOString(),
    actor: r.actor,
    action: r.action,
    complete: isRuleSnapshot(snap),
    snapshot: isRuleSnapshot(snap) ? snap : null,
  }
}

export async function listRuleHistory(
  pool: Pool, org: string, ruleId: string, limit = 50,
): Promise<RuleHistoryEntry[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100)
  const { rows } = await pool.query(
    `select id,actor,action,detail,created_at from notify.audit
      where org=$1 and target=$2 and action = any($3::text[])
      order by created_at desc, id desc limit $4`,
    [org, ruleId, [...RULE_WRITE_ACTIONS], n])
  return rows.map(toHistoryEntry)
}

export async function getRuleAuditSnapshot(
  pool: Pool, org: string, ruleId: string, auditId: number,
): Promise<RuleHistoryEntry | null> {
  const { rows } = await pool.query(
    `select id,actor,action,detail,created_at from notify.audit
      where org=$1 and target=$2 and id=$3
        and action = any($4::text[]) limit 1`,
    [org, ruleId, auditId, [...RULE_WRITE_ACTIONS]])
  return rows[0] ? toHistoryEntry(rows[0]) : null
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run storage.test.ts -t "规则历史"`
Expected: PASS（2 tests）。

- [ ] **Step 9: 提交**

```bash
git add modules/notify/migrations/017_notify_audit_rule_history_index.sql \
  modules/notify/domain/rules.ts modules/notify/storage.ts modules/notify/storage.test.ts
git commit -m "feat(notify): 规则历史快照类型与查询 (#2322)"
```

---

### Task 2: HTTP 写路径落完整快照

**Files:**
- Modify: `modules/notify/routes.ts:244-295`（POST /rules、PUT /rules/:id/enabled）
- Test: `modules/notify/routes.test.ts`

- [ ] **Step 1: 写失败测试（routes.test.ts 追加）**

```ts
it('POST /rules 的 audit detail 含完整 snapshot；PUT enabled 也带快照', async () => {
  const created = await app.request('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      templateKey: 't1', channels: ['wecom_default'], cooldownMinutes: 5,
    }),
  })
  expect(created.status).toBe(201)
  const { id } = await created.json() as { id: string }
  const up = await pool.query(
    "select detail from notify.audit where org=$1 and target=$2 and action='rule.upsert' order by id desc limit 1",
    [ORG, id])
  expect(up.rows[0].detail.snapshot).toMatchObject({
    id, enabled: true, eventKey: 'm.a.b', recipientKey: 'approver',
    templateKey: 't1', channels: ['wecom_default'], cooldownMinutes: 5, origin: 'manual',
  })

  await app.request(`/rules/${encodeURIComponent(id)}/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  const en = await pool.query(
    "select detail from notify.audit where org=$1 and target=$2 and action='rule.enabled' order by id desc limit 1",
    [ORG, id])
  expect(en.rows[0].detail.snapshot).toMatchObject({ id, enabled: false })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run routes.test.ts -t "完整 snapshot"`
Expected: FAIL，`detail.snapshot` undefined。

- [ ] **Step 3: 改 POST /rules**

把传给 `upsertRule` 的对象提成常量，并写进 audit：

```ts
const input = {
  id,
  enabled: true,
  eventKey: body.eventKey,
  scope: body.scope ?? '*',
  recipientKey: body.recipientKey,
  recipientLiteral: body.recipientLiteral ?? null,
  recipientDepts: body.recipientDepts ?? null,
  templateKey: body.templateKey,
  channels: body.channels,
  cooldownMinutes: body.cooldownMinutes ?? null,
  origin: 'manual' as const,
  ownerNamespace,
}
await upsertRule(deps.pool, org(c), input, actor)
await audit(deps.pool, org(c), actor, 'rule.upsert', id, {
  eventKey: body.eventKey,
  scope: body.scope ?? '*',
  recipientKey: body.recipientKey,
  templateKey: body.templateKey,
  channels: body.channels,
  snapshot: input,
})
```

- [ ] **Step 4: 改 PUT /rules/:id/enabled**

在 `setRuleEnabled` 成功后（`n > 0`）把现有 audit 换成：

```ts
if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
const snapshot = ruleSnapshot(rule!, { enabled: body.enabled })
await audit(deps.pool, org(c), identity.userId, 'rule.enabled', id, {
  enabled: body.enabled,
  snapshot,
})
return c.json({ ok: true })
```

`rule` 在上面已查过且 n>0 即存在；`ruleSnapshot` 从 `./domain/rules` import。

- [ ] **Step 5: 运行通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run routes.test.ts -t "完整 snapshot"`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add modules/notify/routes.ts modules/notify/routes.test.ts
git commit -m "feat(notify): HTTP 规则写入落完整快照 (#2322)"
```

---

### Task 3: history / restore 端点

**Files:**
- Modify: `modules/notify/routes.ts`（import + 规则端点区）
- Modify: `modules/notify/manifest.yaml:23-27`（rules 声明区）
- Test: `modules/notify/routes.test.ts`

- [ ] **Step 1: manifest 加声明**

```yaml
    - { method: GET,    path: /rules/:id/history,  scope: notify:view }
    - { method: POST,   path: /rules/:id/restore,  scope: notify:manage }
```

- [ ] **Step 2: 写失败测试（routes.test.ts 追加）**

```ts
it('history 列出快照；restore 按快照恢复并写 rule.restore', async () => {
  const created = await app.request('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
      channels: ['wecom_default'], cooldownMinutes: 5,
    }),
  })
  const { id } = await created.json() as { id: string }
  // 改成另一个合法配置（cooldown 清空）
  await app.request('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id, eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
      channels: ['wecom_default'],
    }),
  })

  const hist = await app.request(`/rules/${encodeURIComponent(id)}/history`)
  expect(hist.status).toBe(200)
  const { history } = await hist.json() as { history: Array<Record<string, unknown>> }
  expect(history.length).toBeGreaterThanOrEqual(2)
  const first = history.find((h) => (h.snapshot as { cooldownMinutes?: unknown }).cooldownMinutes === 5)!
  expect(first.complete).toBe(true)

  const restored = await app.request(`/rules/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: first.auditId }),
  })
  expect(restored.status).toBe(200)
  const row = await pool.query(
    'select cooldown_minutes from notify.rule where org=$1 and id=$2', [ORG, id])
  expect(row.rows[0].cooldown_minutes).toBe(5)
  const a = await pool.query(
    "select detail from notify.audit where org=$1 and target=$2 and action='rule.restore'", [ORG, id])
  expect(a.rows[0].detail).toMatchObject({ restoredFrom: first.auditId })
})

it('restore 负例：无快照 409、reserved id 409、不存在 404', async () => {
  const missing = await app.request('/rules/rule:nope/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: 1 }),
  })
  expect(missing.status).toBe(404)

  const reserved = await app.request('/rules/derived:notify:x/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: 1 }),
  })
  expect(reserved.status).toBe(409)

  await audit(pool, ORG, 'u1', 'rule.enabled', 'rule:legacy', { enabled: true })
  const legacyId = Number((await pool.query(
    "select id from notify.audit where org=$1 and target='rule:legacy' order by id desc limit 1", [ORG])).rows[0].id)
  await pool.query(
    `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
     values ($1,'rule:legacy',true,'m.a.b','*','approver','t1','{wecom_default}','manual','u')`, [ORG])
  const legacy = await app.request('/rules/rule:legacy/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: legacyId }),
  })
  expect(legacy.status).toBe(409)
})
```

- [ ] **Step 3: 补 routes.test.ts import**

在 `modules/notify/routes.test.ts` 顶部从 `./storage` import `audit`（若尚未导入）。

- [ ] **Step 4: 运行确认失败**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run routes.test.ts -t "history 列出快照"`
Expected: FAIL 404（路由未声明/未实现）。

- [ ] **Step 5: 实现 GET history**

在 `r.get('/rules', ...)` 附近追加：

```ts
r.get('/rules/:id/history', async (c) => {
  const raw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(raw) ? raw : 50
  return c.json({
    history: await listRuleHistory(deps.pool, org(c), c.req.param('id'), limit),
  })
})
```

- [ ] **Step 6: 实现 POST restore**

```ts
r.post('/rules/:id/restore', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { auditId?: number } | null
  if (!body || typeof body.auditId !== 'number') {
    return c.json({ error: 'RULE_INVALID_BODY' }, 400)
  }
  if (!isWritableRuleId(id)) return c.json({ error: 'RULE_ID_RESERVED' }, 409)

  const identity = c.get('identity') as Identity
  const rule = (await listRules(deps.pool, org(c))).find((x) => x.id === id)
  if (!rule) return c.json({ error: 'RULE_NOT_FOUND' }, 404)
  if (rule.ownerNamespace && !await ownsNamespace(org(c), rule.ownerNamespace, identity)) {
    return c.json({ error: 'RULE_NOT_OWNED' }, 403)
  }

  const entry = await getRuleAuditSnapshot(deps.pool, org(c), id, body.auditId)
  if (!entry) return c.json({ error: 'HISTORY_NOT_FOUND' }, 404)
  if (!entry.snapshot) return c.json({ error: 'HISTORY_INCOMPLETE' }, 409)

  const snap = entry.snapshot
  const decl = await resolveEventDecl(org(c), snap.eventKey)
  if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 409)
  const [channels, published] = await Promise.all([
    listEnabledChannelIds(deps.pool, org(c)),
    listPublishedTemplateKeys(deps.pool, org(c)),
  ])
  const bad = validateRule({
    eventKey: snap.eventKey, scope: snap.scope, recipientKey: snap.recipientKey,
    recipientLiteral: snap.recipientLiteral, recipientDepts: snap.recipientDepts,
    templateKey: snap.templateKey, channels: snap.channels,
    cooldownMinutes: snap.cooldownMinutes, origin: 'manual',
  }, decl, channels, published)
  if (bad) return c.json({ error: 'RULE_RESTORE_INVALID', issues: [bad] }, 409)

  const input: RuleInput = {
    ...snap,
    id,
    origin: rule.origin,
    ownerNamespace: rule.ownerNamespace ?? null,
  }
  await upsertRule(deps.pool, org(c), input, identity.userId)
  await audit(deps.pool, org(c), identity.userId, 'rule.restore', id, {
    snapshot: input,
    restoredFrom: body.auditId,
  })
  return c.json({ id, restoredFrom: body.auditId, enabled: input.enabled })
})
```

- [ ] **Step 7: 补 imports**

`routes.ts` 的 storage import 加 `getRuleAuditSnapshot, listRuleHistory` 和
`type RuleInput`；`./domain/rules` import 加 `ruleSnapshot`（Task 2 已用）。

- [ ] **Step 8: 运行 history/restore 测试**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run routes.test.ts -t "history 列出快照|restore 负例"`
Expected: PASS。

- [ ] **Step 9: manifest 门禁**

Run: `pnpm exec tsx scripts/check-manifests.mjs`
Expected: `check-manifests: OK`。

- [ ] **Step 10: 提交**

```bash
git add modules/notify/routes.ts modules/notify/manifest.yaml modules/notify/routes.test.ts
git commit -m "feat(notify): 规则历史查询与单步恢复 (#2322)"
```

---

### Task 4: MCP 与 agent 写路径快照

**Files:**
- Modify: `modules/notify/mcp.ts`（`propose_rule` / `update_rule` / `set_rule_enabled`）
- Modify: `modules/notify/agent-actions.ts:240-300`
- Test: `modules/notify/mcp.test.ts`（在既有 N3b 用例里追加 agent 规则快照断言）

- [ ] **Step 1: 写失败测试（mcp.test.ts 追加）**

```ts
it('propose_rule 的 audit 含完整 snapshot', async () => {
  const out = await callTool(deps(), 'propose_rule', {
    eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
    templateKey: 't1', channels: ['wecom_default'],
  })
  expect(out.isError).toBe(false)
  const { rows } = await pool.query(
    "select detail from notify.audit where org=$1 and action='mcp.propose_rule' order by id desc limit 1", [ORG])
  expect(rows[0].detail.snapshot).toMatchObject({
    eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
    channels: ['wecom_default'], origin: 'manual',
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run mcp.test.ts -t "完整 snapshot"`
Expected: FAIL。

- [ ] **Step 3: 改 mcp.ts propose/update**

在 `upsertRule` 前构造快照（`rule` 对象已有除 id/enabled 外字段）：

```ts
const snapshot = {
  id,
  enabled: true,
  eventKey: rule.eventKey,
  scope: rule.scope,
  recipientKey: rule.recipientKey,
  recipientLiteral: rule.recipientLiteral,
  recipientDepts: rule.recipientDepts,
  templateKey: rule.templateKey,
  channels: rule.channels,
  cooldownMinutes: rule.cooldownMinutes,
  origin: 'manual' as const,
  ownerNamespace: null,
}
await upsertRule(deps.pool, deps.org, snapshot, deps.userId)
await audit(deps.pool, deps.org, deps.userId, `mcp.${name}`, id, { ...rule, id, snapshot })
```

- [ ] **Step 4: 改 mcp.ts set_rule_enabled**

在 `setRuleEnabled` 前查现有规则，成功后写快照：

```ts
const existing = (await listRules(deps.pool, deps.org)).find((x) => x.id === id)
...
if (n === 0) return err('not_found')
await audit(deps.pool, deps.org, deps.userId, 'mcp.set_rule_enabled', id, {
  enabled: args.enabled,
  snapshot: existing ? ruleSnapshot(existing, { enabled: args.enabled }) : undefined,
})
```

（`mcp.ts` 从 `./domain/rules` import `ruleSnapshot`；`listRules` 已在 storage import 里。）

- [ ] **Step 5: 改 agent-actions.ts**

在 `upsertRule` 前构造与写入完全一致的 `snapshot`（id、enabled=`!needsApproval`、字段、origin、ownerNamespace=namespace），audit 改为：

```ts
await audit(pool, input.org, input.userId, 'agent.rule.upsert', id, {
  ...approvalDetail, status, approvalId: approvalId ?? null, snapshot,
})
```

- [ ] **Step 6: 在 mcp.test.ts 的 N3b 用例追加 agent 快照断言**

在 `create_agent_rule` 成功后追加：

```ts
const a = await pool.query(
  "select detail from notify.audit where org=$1 and action='agent.rule.upsert' order by id desc limit 1", [ORG])
expect(a.rows[0].detail.snapshot).toMatchObject({
  eventKey: 'ext.agent_a.daily', recipientKey: 'assignee',
  templateKey: 'agent_a_daily', channels: ['inapp_default'],
  origin: 'manual', ownerNamespace: 'agent_a',
})
```

- [ ] **Step 7: 运行测试**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify exec vitest run mcp.test.ts routes.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add modules/notify/mcp.ts modules/notify/agent-actions.ts modules/notify/mcp.test.ts
git commit -m "feat(notify): MCP/agent 规则写入落完整快照 (#2322)"
```

---

### Task 5: 文档、全量门禁与生产演练

**Files:**
- Modify: `docs/architecture.md` §2.6（规则历史一句）
- Modify: `docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md` §9（规则版本化标记已定）

- [ ] **Step 1: 文档**

`docs/architecture.md` §2.6 增加：

```markdown
- **规则历史/回滚**：每次规则写在 `notify.audit.detail.snapshot` 留完整快照；
  `GET /rules/:id/history` 只读，`POST /rules/:id/restore` 用快照重校验后写回。
  不建 revision 表；已删规则/`derived:`/`manual:` 不支持恢复。
```

roadmap §9 把「规则版本化/回滚」改为已定：轻量审计快照 + 单步恢复（本 spec）。

- [ ] **Step 2: 全量门禁**

```bash
pnpm typecheck
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter notify test
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm run test:guard
pnpm exec tsx scripts/check-manifests.mjs
```

Expected: 全绿。

- [ ] **Step 3: 提交并开 PR**

```bash
git add docs/architecture.md docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md
git commit -m "docs(notify): 规则历史/回滚口径入账 (#2322)"
git push -u origin feat/notify-rule-history
```

PR 描述引用 spec，并写明生产演练步骤。

- [ ] **Step 4: 合并后生产演练（二选一实例，非关键规则）**

1. 选一条 `rule:` 开头的自有规则，用控制台/API 改一个无害字段（如 `cooldown_minutes`）；
2. `GET /rules/:id/history` 确认两条快照；
3. 用旧 `auditId` 调 `POST /rules/:id/restore`；
4. 回读规则字段 = 旧值，`notify.audit` 出现 `rule.restore`；
5. 两套生产 `notify-preflight` 仍为 `blockedCount:0`。

---

## Self-Review

- **Spec coverage**：§4.1 数据模型 → Task 1/2/4；§4.2 API → Task 3；§4.3 权限/索引 → Task 1/3；§4.4 验收 → 各 Task 测试 + Task 5 演练；§4.5 非目标未实现。
- **Placeholder scan**：无 TBD；所有代码步骤给出可粘贴内容。
- **Type consistency**：`RuleSnapshot` 在 domain 定义，`RuleInput` 别名复用；history 返回 `snapshot: RuleSnapshot | null`；restore 的 `input` 同类型。
