# 通知可送达性 D3+D4 实施计划（配置期预检 + agent 自证）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「这条规则会发给谁 / 为什么发不出去」在**配置期**就能问出来——HTTP 端点、console 列、MCP 工具、定期体检 job 四个入口，全部复用 D1 的 `resolveDeliverability`。

**Architecture:** 新增只读端点 `GET /rules/:id/resolve` 与批量 `GET /rules/deliverability`；console 规则表加「可解析」列；MCP 加只读 `check_rule`；`scripts/notify-preflight.mjs` + openship job 定期扫全量规则。

**Tech Stack:** TypeScript / Hono / React+antd / MCP JSON-RPC / Vitest。

## Global Constraints

- 上游：`docs/superpowers/specs/2026-10-28-notify-deliverability-design.md` §5（D3/D4 的设计）。
- **绝对复用 `resolveDeliverability`**（`modules/notify/domain/deliverability.ts`）——**不得另写一份解析**。
  否则会出现「预检说能发、实际发不出」，这正是本设计要消灭的病。
- **全部只读**：端点/MCP 工具/preflight job 都**不写任何表**、**不外发**任何消息。
- `mode=sample` 用 `samplePayload(decl)`：对 `field` 类收件人**只能验「字段存在」**
  （sample 的 user 值是 `'sample'`，解析不到真实用户）⇒ 响应必须带 `mode` 与 `warnings` 说明这一局限。
- org 只来自 `identity.orgId`；**绝不读请求参数**。
- MCP 工具数 12 → 13，`NOTIFY_MAX_TOOLS` 与 `scripts/check-mcp-toolface.mjs` 同步。
- 测试需 `DATABASE_URL`；全量在 ASCII 工作区跑。
- 逐任务提交；feat 需 `Closes #N`（#1144）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `modules/notify/domain/sample-payload.ts` | `samplePayload(decl)`（从 `domain/template.ts` 移出，供预检与预览共用） |
| `modules/notify/routes.ts` | 两个只读端点 + `buildDeliverabilityDeps` 适配器 |
| `modules/notify/manifest.yaml` | 端点声明 |
| `modules/notify/console/api.ts` / `rules.tsx` | 「可解析」列 |
| `modules/notify/mcp-tools.ts` / `mcp.ts` | `check_rule` 工具 |
| `scripts/check-mcp-toolface.mjs` | 常量 12→13 |
| `scripts/notify-preflight.mjs` | 定期体检 CLI |
| `deploy/notify-jobs.md` | 新 job 登记 |

---

## Task 1: 预检端点（单条 + 批量）

**Files:**
- Modify: `modules/notify/routes.ts`
- Modify: `modules/notify/manifest.yaml`
- Test: `modules/notify/routes.test.ts`

**Interfaces:**
- Consumes: `resolveDeliverability`（已存在）、`samplePayload`（`domain/template.ts` 已有）
- Produces:
  - `GET /rules/:id/resolve?mode=sample|payload` → `{
      ruleId, eventKey, scope, mode, blocked, recipients: [{name,source}],
      channels: [{id,provider,enabled}], warnings: string[]
    }`
  - `GET /rules/deliverability` → `{ rules: Array<{ ruleId, eventKey, blocked, recipientCount }> }`

- [ ] **Step 1: 写失败测试**

```ts
it('GET /rules/:id/resolve：scope_holders 无人 ⇒ blocked=no_recipient', async () => {
  await post('/rules', {
    eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
    channels: ['wecom_default'],
  })
  const list = await app.request('/rules')
  const { rules } = await list.json() as { rules: Array<{ id: string }> }
  const id = rules[0]!.id

  const res = await app.request(`/rules/${encodeURIComponent(id)}/resolve`)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    blocked: string | null; recipients: unknown[]; mode: string; warnings: string[]
  }
  // approver 是 field 收件人，sample payload 的 u='sample' ⇒ 能解析出 1 人
  expect(body.mode).toBe('sample')
  expect(body.recipients).toHaveLength(1)
  expect(body.blocked).toBeNull()
})

it('GET /rules/:id/resolve：字段缺失的真实 payload ⇒ no_recipient', async () => {
  // mode=payload + 空 payload
  const res = await app.request(`/rules/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'payload', payload: {} }),
  })
  expect(res.status).toBe(200)
  expect((await res.json() as { blocked: string }).blocked).toBe('no_recipient')
})

it('GET /rules/:id/resolve：未知 id ⇒ 404', async () => {
  expect((await app.request('/rules/nope/resolve')).status).toBe(404)
})

it('GET /rules/deliverability：批量返回每条规则的可解析人数', async () => {
  const res = await app.request('/rules/deliverability')
  expect(res.status).toBe(200)
  const body = await res.json() as { rules: Array<{ ruleId: string; recipientCount: number }> }
  expect(body.rules.length).toBeGreaterThan(0)
  expect(typeof body.rules[0]!.recipientCount).toBe('number')
})

it('预检不外发：调用后 notify.delivery 无新增', async () => {
  const before = (await pool.query('select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
  await app.request(`/rules/${encodeURIComponent(id)}/resolve`)
  await app.request('/rules/deliverability')
  const after = (await pool.query('select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
  expect(after).toBe(before)
})
```

- [ ] **Step 2: 实现**

在 `routes.ts` 里加一个共用的 deps 适配器（**唯一**一处把 worker 的 deps 形状接给 deliverability）：

```ts
import { resolveDeliverability, type DeliverabilityDeps } from './domain/deliverability'
import { samplePayload } from './domain/template'

/** 把模块 storage + 注入的 events/addresses 适配成 deliverability 的依赖（唯一一处）。 */
function deliverabilityDeps(deps: {
  pool: Pool
  events?: EventCatalogReader
}): DeliverabilityDeps {
  return {
    getEventDecl: async (key) => deps.events?.get(key) ?? null,
    getPublishedTemplate: async (org, key) => {
      const t = await getPublishedTemplate(deps.pool, org, key)
      return t ? { revision: t.revision, contents: t.contents } : null
    },
    getChannel: async (org, id) => {
      const ch = await getChannel(deps.pool, org, id)
      return ch ? { id, provider: ch.provider, enabled: ch.enabled, config: ch.config } : null
    },
    resolveScopeHolders: async (org, key, decl) =>
      deps.addresses?.resolveScopeHolders?.(org, key, decl) ?? [],
  }
}
```

> ⚠️ `resolveScopeHolders` 现在由 worker 的 `worker-deps.ts` 注入（走 Casdoor）。
> 模块层**拿不到**它（B1）⇒ 端点必须走 `deps.addresses`。
> 因此 `ChannelAddressResolver`（SDK）需扩一个可选方法：

```ts
// packages/platform-sdk/src/module.ts
export interface ChannelAddressResolver {
  resolve(input: { org: string; provider: string; casdoorName: string }): Promise<string | null>
  /** 权限码 → Casdoor 用户名列表（通知预检/投递共用；宿主注入） */
  resolveScopeHolders?(
    org: string,
    permissionCode: string,
    decl: NotificationEventDecl,
  ): Promise<string[]>
}
```

**若未注入**（旧宿主/单测）：返回 `[]` 并在响应的 `warnings` 里加
`scope_holders_unavailable`——**不能静默当成「没人持有」**。

端点实现：

```ts
  // ── 可送达性预检（只读，D3）────────────────────────────────────────────────
  r.get('/rules/:id/resolve', async (c) => {
    const mode = c.req.query('mode') === 'payload' ? 'payload' : 'sample'
    return resolveRule(c, { mode, payload: undefined })
  })

  r.post('/rules/:id/resolve', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      { payload?: Record<string, unknown> } | null
    if (!body?.payload) return c.json({ error: 'INVALID_BODY' }, 400)
    return resolveRule(c, { mode: 'payload', payload: body.payload })
  })

  r.get('/rules/deliverability', async (c) => {
    const o = org(c)
    const rules = await listRules(deps.pool, o)
    const dd = deliverabilityDeps(deps)
    const out: Array<{ ruleId: string; eventKey: string; blocked: string | null; recipientCount: number }> = []
    for (const rule of rules) {
      const decl = deps.events?.get(rule.eventKey)
      const payload = decl ? samplePayload(decl) : {}
      const r2 = await resolveDeliverability({ org: o, rule, payload }, dd)
      out.push({
        ruleId: rule.id, eventKey: rule.eventKey,
        blocked: r2.blocked, recipientCount: r2.recipients.length,
      })
    }
    return c.json({ rules: out })
  })
```

`resolveRule` 辅助（放在同一文件、`createNotifyRouter` 内）：

```ts
  async function resolveRule(
    c: { get: (k: 'identity') => unknown; req: { param: (k: string) => string } },
    opts: { mode: 'sample' | 'payload'; payload?: Record<string, unknown> },
  ) {
    const o = org(c)
    const id = c.req.param('id')
    const rules = await listRules(deps.pool, o)
    const rule = rules.find((x) => x.id === id)
    if (!rule) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const decl = deps.events?.get(rule.eventKey)
    if (!decl) return Response.json({ error: 'EVENT_NOT_DECLARED' }, { status: 400 })

    const warnings: string[] = []
    if (!deps.addresses?.resolveScopeHolders) warnings.push('scope_holders_unavailable')
    if (opts.mode === 'sample') {
      warnings.push('sample_mode_field_recipients_unverified')
    }

    const payload = opts.payload ?? samplePayload(decl)
    const r2 = await resolveDeliverability({ org: o, rule, payload }, deliverabilityDeps(deps))
    return Response.json({
      ruleId: rule.id, eventKey: rule.eventKey, scope: rule.scope, mode: opts.mode,
      blocked: r2.blocked, recipients: r2.recipients, channels: r2.channels, warnings,
    })
  }
```

`manifest.yaml` 加：

```yaml
    - { method: GET,    path: /rules/:id/resolve,  scope: notify:view }
    - { method: POST,   path: /rules/:id/resolve,  scope: notify:view }
    - { method: GET,    path: /rules/deliverability, scope: notify:view }
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
pnpm exec tsx scripts/check-manifests.mjs
git add modules/notify/routes.ts modules/notify/routes.test.ts modules/notify/manifest.yaml \
  packages/platform-sdk/src/module.ts
git commit -m "feat(notify): 可送达性预检端点（D3）"
```

---

## Task 2: console「可解析」列

**Files:**
- Modify: `modules/notify/console/api.ts`
- Modify: `modules/notify/console/rules.tsx`
- Test: `modules/notify/console/rules.test.tsx`

- [ ] **Step 1: api 客户端**

```ts
export type RuleDeliverability = {
  ruleId: string; eventKey: string; blocked: string | null; recipientCount: number
}
export const fetchDeliverability = (): Promise<RuleDeliverability[]> =>
  apiGet<{ rules: RuleDeliverability[] }>(`${BASE}/rules/deliverability`).then((r) => r.rules)
```

- [ ] **Step 2: 规则表加列**

规则列表的 `load()` 并行拉 `/rules` 与 `/rules/deliverability`，用 `Map<ruleId, RuleDeliverability>` 关联；
新增一列：

```tsx
{
  title: '可解析',
  render: (_, r) => {
    const d = deliv.get(r.id)
    if (!d) return '—'
    return d.blocked === null
      ? <Tag color="green">{d.recipientCount} 人</Tag>
      : <Tag color="red">0 人（{blockedLabel(d.blocked)}）</Tag>
  },
},
```

`blockedLabel`：`no_recipient → 无可解析收件人`、`no_channel → 通道全停用`、
`template_missing → 模板未发布`。

- [ ] **Step 3: 测试**

```tsx
it('规则表显示可解析人数；0 人时显示原因', async () => {
  routeFetch({
    'GET /api/modules/notify/rules': () => json({ rules: [
      { ...rule, id: 'r-ok' }, { ...rule, id: 'r-bad' },
    ] }),
    'GET /api/modules/notify/rules/deliverability': () => json({ rules: [
      { ruleId: 'r-ok', eventKey: 'm.a.b', blocked: null, recipientCount: 2 },
      { ruleId: 'r-bad', eventKey: 'm.a.b', blocked: 'no_recipient', recipientCount: 0 },
    ] }),
    // 既有依赖
    'GET /api/modules/notify/events': () => json({ events: [] }),
    'GET /api/modules/notify/templates': () => json({ templates: [] }),
    'GET /api/modules/notify/channels': () => json({ channels: [] }),
  })
  render(<RulesTab />)
  expect(await screen.findByText('2 人')).toBeInTheDocument()
  expect(screen.getByText(/无可解析收件人/)).toBeInTheDocument()
})
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/console/api.ts modules/notify/console/rules.tsx modules/notify/console/rules.test.tsx
git commit -m "feat(notify): console 规则表显示可解析人数（D3）"
```

---

## Task 3: MCP `check_rule`（只读）

**Files:**
- Modify: `modules/notify/mcp-tools.ts`、`modules/notify/mcp.ts`
- Modify: `scripts/check-mcp-toolface.mjs`
- Test: `modules/notify/mcp.test.ts`

- [ ] **Step 1: 工具定义**

```ts
t('check_rule', '只读：跑一次投递可行性，回答「会发给谁 / 为什么发不出去」。建完规则用它自证。',
  { id: { type: 'string' }, payload: { type: 'object' } }, ['id'], false, null)
```

`NOTIFY_MAX_TOOLS = 13`。

- [ ] **Step 2: 实现**

```ts
  if (name === 'check_rule') {
    const id = str(args.id)
    if (!id) return err('id_required')
    const rules = await listRules(deps.pool, deps.org)
    const rule = rules.find((x) => x.id === id)
    if (!rule) return err('not_found')

    const decl = deps.events?.get(rule.eventKey)
    if (!decl) return err('event_not_declared')

    const warnings: string[] = []
    if (!deps.addresses?.resolveScopeHolders) warnings.push('scope_holders_unavailable')
    const payload = (args.payload as Record<string, unknown> | undefined)
      ?? samplePayload(decl)
    if (!args.payload) warnings.push('sample_mode_field_recipients_unverified')

    const r2 = await resolveDeliverability({ org: deps.org, rule, payload }, { /* 同 routes 的适配器 */ })
    return ok({
      ruleId: rule.id, eventKey: rule.eventKey, blocked: r2.blocked,
      recipients: r2.recipients, channels: r2.channels, warnings,
      next: r2.blocked === null ? '可送达' : '按 blocked 修配置；改完再跑一次 check_rule',
    })
  }
```

- [ ] **Step 3: 测试**

```ts
it('check_rule 只读、返回 recipients 与 blocked', async () => {
  const out = await callTool(deps(), 'check_rule', { id: 'r1' })
  expect(out.isError).toBe(false)
  const body = JSON.parse(out.text) as { blocked: string | null; recipients: unknown[] }
  expect(body).toHaveProperty('blocked')
  expect(Array.isArray(body.recipients)).toBe(true)
})

it('check_rule：未知 id ⇒ error；工具面无 publish/channel', () => {
  // 已由既有断言覆盖 publish/channel，这里只补数量
  expect(NOTIFY_TOOLS).toHaveLength(13)
})
```

- [ ] **Step 4: 跑测试 + 门禁 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
pnpm exec tsx scripts/check-mcp-toolface.mjs
git add modules/notify/mcp-tools.ts modules/notify/mcp.ts modules/notify/mcp.test.ts scripts/check-mcp-toolface.mjs
git commit -m "feat(notify): MCP check_rule 只读自证（D4）"
```

---

## Task 4: 定期体检 job

**Files:**
- Create: `scripts/notify-preflight.mjs`
- Test: `scripts/notify-preflight.test.ts`
- Modify: `deploy/notify-jobs.md`

- [ ] **Step 1: CLI**

```js
#!/usr/bin/env node
// scripts/notify-preflight.mjs — 全量规则可送达性体检（只读）。
// 退出码：0 全部可送达；1 存在阻塞规则；2 查不成账。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { listRules } from '../modules/notify/storage.ts'
import { resolveDeliverability } from '../modules/notify/domain/deliverability.ts'
import { samplePayload } from '../modules/notify/domain/template.ts'

/**
 * 只纳入「不依赖真实 payload」的规则：recipientKind ∈ scope_holders / literal。
 * field 类必须真实 payload，sample 无意义 ⇒ 跳过并计数（不是「通过」）。
 */
export function pickCheckable(rules, declOf) {
  const out = []
  const skipped = []
  for (const r of rules) {
    const d = declOf(r.eventKey)
    const kind = d?.recipients?.[r.recipientKey]?.kind
    if (kind === 'field') { skipped.push(r.id); continue }
    out.push({ rule: r, decl: d })
  }
  return { checkable: out, skipped }
}
```

CLI 主体：拉 `platform.tenant` 全租户 → 每 org 拉 enabled 规则 → 逐条 `resolveDeliverability`
（`getPublishedTemplate` / `getChannel` 直接用 storage；`getEventDecl` 读 `platform.event_catalog`；
`resolveScopeHolders` 用宿主 `createScopeHolderResolver`）→ 输出阻塞清单。

- [ ] **Step 2: 纯核测试**

```ts
it('pickCheckable：field 类被跳过并单独计数', () => {
  const rules = [
    { id: 'a', eventKey: 'e1', recipientKey: 'k1' },
    { id: 'b', eventKey: 'e1', recipientKey: 'k2' },
  ]
  const declOf = () => ({
    recipients: { k1: { kind: 'scope_holders' }, k2: { kind: 'field', field: 'x' } },
  })
  const r = pickCheckable(rules, declOf)
  expect(r.checkable.map((x) => x.rule.id)).toEqual(['a'])
  expect(r.skipped).toEqual(['b'])
})
```

- [ ] **Step 3: 建 job + 文档**

job：`docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/notify-preflight.mjs'`，
cron 每日（如 `43 3 * * *`），`states: ['failed']`，与 `notify-reconcile` 同通道。
`deploy/notify-jobs.md` 加一行 + 退出码说明。

- [ ] **Step 4: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm exec vitest run scripts/notify-preflight.test.ts
pnpm typecheck:scripts
git add scripts/notify-preflight.mjs scripts/notify-preflight.test.ts deploy/notify-jobs.md
git commit -m "feat(notify): preflight 体检 job（D4）"
```

---

## Task 5: 文档与全量验证

- [ ] **Step 1: 文档**

- `docs/architecture.md` §2.6「可送达性」小节补：预检端点、console 列、MCP `check_rule`、preflight job；
- 强调 **四个入口共用 `resolveDeliverability`**（这是防漂移的唯一手段）。

- [ ] **Step 2: 全量验证（ASCII 工作区）**

```bash
pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-mcp-toolface.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
```

- [ ] **Step 3: 提交**

```bash
git add docs/architecture.md
git commit -m "docs(notify): 可送达性四入口（D4）"
```

---

## Self-Review

- 覆盖：spec §5.1（Task 1）、§5.2（Task 2）、§5.3（Task 3）、§5.4（Task 4）。
- 关键约束：**单一实现**（Task 1 的适配器 + Task 3/4 复用 `resolveDeliverability`）；
  **只读**（Task 1 有「不外发」负对照）。
- 已知局限：`mode=sample` 对 `field` 类只能验字段存在 ⇒ 响应带 `warnings`；preflight 直接跳过 field 类并计数。
- 风险：`scope_holders` 未注入时返回空会在预检里表现为「0 人」——已用 `warnings`
  `scope_holders_unavailable` 显式区分「没人持有」与「查不了」。
