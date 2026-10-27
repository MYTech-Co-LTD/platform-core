# 租户级通知基础设施 Plan 2：产品面（P2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P1 的通知基础设施做成可自助使用的产品面：模板草稿/预览/发布/回滚、通道配置与健康、console 六区、agent MCP 工具面、审计；**AI 永不发布文案、永不改通道密钥**。

**Architecture:** 服务端在既有 notify 模块上增加模板/通道/测试发送/审计端点；预览与投递共用 `renderContents`；console 走 `platformFetch` + 页内 tabs；MCP 工具面复用 `POST /mcp-manage`，工具元数据放纯模块供门禁静态检查。

**Tech Stack:** TypeScript / Hono / PostgreSQL / Handlebars / Ant Design / React / Vitest / MCP JSON-RPC。

## Global Constraints

- 上游：`docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md` §5/§9/§10；P1 计划已落地（分支 `feat/notification-infrastructure-p1` / PR #1120）。
- **本计划基于 P1 分支堆叠**（`feat/notification-infrastructure-p2`）；#1120 合入 main 后 rebase。
- **通道仍只有 `wecom_chat` / `in_app`**；webhook 属 P3。**不做**邮件/短信/digest/条件规则/多级路由/外部插件。
- **AI 永不发布文案、永不改通道密钥**：MCP 无 publish / channel 工具；发布只能由持 `notify:publish` 的人触发。
- **预览与投递共用 `renderContents`**（单一渲染实现）；变量 = 事件 payload 字段名，未知变量 = 错误。
- **密钥只存 env 键名**（`secret_refs`），任何端点**不得回显值**；通道密钥由运维在 env 层预备。
- **org 只来自 `identity.orgId`**，绝不读请求参数；所有写操作落 `notify.audit`。
- **工具面门禁**：`scripts/check-mcp-toolface.mjs` 必须纳入 notify 面（工具数/命名/mutating 注解/scope）。
- 测试需要 `DATABASE_URL`；全量在 ASCII 工作树副本跑（中文路径会打挂动态 import 测试）。
- 提交纪律：`feat(notify)/fix(notify)`，逐任务提交。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `modules/notify/migrations/004_notify_audit.sql` | `notify.audit` |
| `modules/notify/domain/template.ts` | 模板内容校验（变量子集、渲染、长度） |
| `modules/notify/storage.ts` | 模板/通道/审计/测试发送/重试 SQL |
| `modules/notify/routes.ts` | 事件目录、模板、通道、测试发送、投递重试端点 |
| `modules/notify/manifest.yaml` | 新端点/权限/console 条目 |
| `modules/notify/mcp-tools.ts` | **纯**工具元数据（供门禁静态检查） |
| `modules/notify/mcp.ts` | MCP JSON-RPC 壳 + 工具实现 + 审计 |
| `modules/notify/console/*` | 六区 UI + api 客户端 |
| `apps/web/src/console-registry.gen.ts` | 重新生成 |
| `scripts/check-mcp-toolface.mjs` | 纳入 notify 面 |
| `modules/notify/*.test.ts` / `console/*.test.tsx` | 单测/UI 测试 |
| `docs/architecture.md` / `docs/module-protocol.md` / `AGENTS.md` | P2 补充（UI/MCP/审计） |

---

## Task 1: `notify.audit` 迁移

**Files:**
- Create: `modules/notify/migrations/004_notify_audit.sql`
- Modify: `modules/notify/migrations.test.ts`

**Interfaces:**
- Produces: `notify.audit(id, org, actor, action, target, detail, created_at)`

- [ ] **Step 1: 写迁移**

```sql
-- 004_notify_audit.sql — 通知写操作审计（发布/通道/规则/MCP）
create table if not exists notify.audit (
  id         bigserial primary key,
  org        text not null,
  actor      text not null,
  action     text not null,
  target     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_notify_audit_org
  on notify.audit (org, created_at desc);
```

- [ ] **Step 2: 扩展迁移测试**

在 `migrations.test.ts` 的 org 表清单加入 `'audit'`（排序后 `audit` 在最前）：

```ts
expect(names).toEqual([
  'audit', 'channel', 'delivery', 'delivery_attempt', 'event',
  'inbox', 'rule', 'template', 'template_revision',
])
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter notify exec vitest run migrations.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/migrations/004_notify_audit.sql modules/notify/migrations.test.ts
git commit -m "feat(notify): 审计表迁移"
```

---

## Task 2: 模板存储与发布

**Files:**
- Modify: `modules/notify/storage.ts`
- Test: `modules/notify/storage.test.ts`

**Interfaces:**
- Produces:
  - `listTemplates(pool, org): Promise<TemplateSummary[]>`
  - `getTemplate(pool, org, key): Promise<TemplateDetail | null>`（含 revisions）
  - `createTemplateRevision(pool, org, key, contents, actor): Promise<{ revision: number }>`
  - `publishTemplateRevision(pool, org, key, revision, actor): Promise<void>`
  - `audit(pool, org, actor, action, target, detail): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
it('草稿追加 revision；发布移动指针；旧版本可回滚', async () => {
  await seedTemplate(pool, ORG, 't1', 'm.a.b') // helper: template + revision 1 published
  const t0 = await getTemplate(pool, ORG, 't1')
  expect(t0!.publishedRevision).toBe(1)

  const d1 = await createTemplateRevision(pool, ORG, 't1',
    { wecom_chat: { text: 'v2 {{title}}' } }, 'u')
  expect(d1.revision).toBe(2)
  await publishTemplateRevision(pool, ORG, 't1', 2, 'publisher')
  const t1 = await getTemplate(pool, ORG, 't1')
  expect(t1!.publishedRevision).toBe(2)
  expect(t1!.revisions.find((r) => r.revision === 2)!.reviewStatus).toBe('approved')

  await publishTemplateRevision(pool, ORG, 't1', 1, 'publisher')
  expect((await getTemplate(pool, ORG, 't1'))!.publishedRevision).toBe(1)
})

it('审计行落库', async () => {
  await audit(pool, ORG, 'u1', 'template.publish', 't1', { revision: 2 })
  const { rows } = await pool.query(
    "select action,target,detail from notify.audit where org=$1 order by id desc limit 1", [ORG])
  expect(rows[0]).toMatchObject({ action: 'template.publish', target: 't1', detail: { revision: 2 } })
})
```

- [ ] **Step 2: 实现**

```ts
export type TemplateSummary = {
  key: string; name: string; eventKey: string; status: string; origin: string
  publishedRevision: number | null; updatedAt: string
}
export type TemplateRevision = {
  revision: number; contents: Record<string, Record<string, string>>
  bodyHash: string; reviewStatus: string; createdBy: string; createdAt: string
}
export type TemplateDetail = TemplateSummary & { revisions: TemplateRevision[] }

export async function listTemplates(pool: Pool, org: string): Promise<TemplateSummary[]> {
  const { rows } = await pool.query(
    `select key,name,event_key,status,origin,published_revision,updated_at
       from notify.template where org=$1 order by key`, [org])
  return rows.map((r) => ({
    key: r.key, name: r.name, eventKey: r.event_key, status: r.status, origin: r.origin,
    publishedRevision: r.published_revision, updatedAt: (r.updated_at as Date).toISOString(),
  }))
}

export async function getTemplate(pool: Pool, org: string, key: string): Promise<TemplateDetail | null> {
  const t = await pool.query(
    `select key,name,event_key,status,origin,published_revision,updated_at
       from notify.template where org=$1 and key=$2`, [org, key])
  if (!t.rows[0]) return null
  const revs = await pool.query(
    `select revision,contents,body_hash,review_status,created_by,created_at
       from notify.template_revision where org=$1 and key=$2 order by revision desc`, [org, key])
  const r = t.rows[0]
  return {
    key: r.key, name: r.name, eventKey: r.event_key, status: r.status, origin: r.origin,
    publishedRevision: r.published_revision,
    updatedAt: (r.updated_at as Date).toISOString(),
    revisions: revs.rows.map((x) => ({
      revision: x.revision, contents: x.contents, bodyHash: x.body_hash,
      reviewStatus: x.review_status, createdBy: x.created_by,
      createdAt: (x.created_at as Date).toISOString(),
    })),
  }
}

export async function createTemplateRevision(
  pool: Pool, org: string, key: string,
  contents: Record<string, Record<string, string>>, actor: string,
): Promise<{ revision: number }> {
  const bodyHash = createHash('sha256').update(JSON.stringify(contents)).digest('hex').slice(0, 16)
  const { rows } = await pool.query<{ max: number }>(
    'select coalesce(max(revision),0)::int as max from notify.template_revision where org=$1 and key=$2',
    [org, key])
  const revision = Number(rows[0]!.max) + 1
  await pool.query(
    `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
     values ($1,$2,$3,$4::jsonb,$5,'draft',$6)`,
    [org, key, revision, JSON.stringify(contents), bodyHash, actor])
  await pool.query('update notify.template set updated_at=now() where org=$1 and key=$2', [org, key])
  return { revision }
}

export async function publishTemplateRevision(
  pool: Pool, org: string, key: string, revision: number, actor: string,
): Promise<void> {
  await pool.query(
    `update notify.template_revision
        set review_status='approved', approved_by=$4, approved_at=now()
      where org=$1 and key=$2 and revision=$3`, [org, key, revision, actor])
  await pool.query(
    `update notify.template set status='published', published_revision=$3, updated_at=now()
      where org=$1 and key=$2`, [org, key, revision])
}

export async function audit(
  pool: Pool, org: string, actor: string, action: string, target: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `insert into notify.audit(org,actor,action,target,detail) values ($1,$2,$3,$4,$5::jsonb)`,
    [org, actor, action, target, JSON.stringify(detail)])
}
```

（`createHash` 从 `node:crypto` 导入。）

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter notify exec vitest run storage.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/storage.ts modules/notify/storage.test.ts
git commit -m "feat(notify): 模板存储与发布"
```

---

## Task 3: 模板内容校验（纯函数）

**Files:**
- Create: `modules/notify/domain/template.ts`
- Test: `modules/notify/domain/template.test.ts`

**Interfaces:**
- Produces: `validateContents(contents, decl, providers): string[]`；`samplePayload(decl): Record<string, unknown>`

- [ ] **Step 1: 写失败测试**

```ts
it('变量必须是声明字段；未知变量报错', () => {
  const decl = { key:'m.a.b', title:'t', payload:{ title:{type:'string'}, link:{type:'url'} }, recipients:{} }
  expect(validateContents({ wecom_chat:{ text:'{{title}} {{link}}' } }, decl, ['wecom_chat'])).toEqual([])
  expect(validateContents({ wecom_chat:{ text:'{{nope}}' } }, decl, ['wecom_chat']))
    .toContain('unknown_variable:nope')
})

it('启用通道缺内容 / 超长 / 链接非法都报', () => {
  const decl = { key:'m.a.b', title:'t', payload:{ link:{type:'url'} }, recipients:{} }
  expect(validateContents({}, decl, ['in_app'])).toContain('missing_channel:in_app')
  expect(validateContents({ wecom_chat:{ text:'x'.repeat(4000) } }, decl, ['wecom_chat']))
    .toContain('too_long:wecom_chat.text')
})
```

- [ ] **Step 2: 实现**

```ts
import Handlebars from 'handlebars'
import type { NotificationEventDecl } from '@platform/sdk'
import { renderContents } from './render'

export function samplePayload(decl: NotificationEventDecl): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(decl.payload)) {
    out[k] = f.type === 'number' ? 1
      : f.type === 'boolean' ? true
      : f.type === 'user_list' ? ['u1']
      : f.type === 'url' ? 'https://example.com'
      : 'sample'
  }
  return out
}

/** 返回问题清单（空 = 通过）。用 samplePayload 真渲染：未知变量/长度/缺通道都会暴露。 */
export function validateContents(
  contents: Record<string, Record<string, string>>,
  decl: NotificationEventDecl,
  providers: string[],
): string[] {
  const issues: string[] = []
  const known = new Set(Object.keys(decl.payload))
  for (const [ch, fields] of Object.entries(contents)) {
    for (const [field, tpl] of Object.entries(fields)) {
      for (const m of String(tpl).matchAll(/\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!known.has(m[1]!)) issues.push(`unknown_variable:${m[1]}`)
      }
      void field
    }
  }
  const rendered = renderContents(contents, samplePayload(decl), providers)
  if (!rendered.ok) issues.push(...rendered.issues)
  return [...new Set(issues)]
}
```

> `renderContents` 的 `too_long` / `missing_channel` / `render:` 问题直接复用；变量扫描是提前给出 `unknown_variable:*`。

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter notify exec vitest run domain/template.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/domain/template.ts modules/notify/domain/template.test.ts
git commit -m "feat(notify): 模板内容校验"
```

---

## Task 4: 通道存储与健康

**Files:**
- Modify: `modules/notify/storage.ts`
- Create: `modules/notify/domain/channel.ts`
- Test: `modules/notify/storage.test.ts`、`domain/channel.test.ts`

**Interfaces:**
- Produces:
  - `listChannels(pool, org): Promise<ChannelView[]>`
  - `patchChannel(pool, org, id, patch, actor): Promise<number>`
  - `setChannelHealth(pool, org, id, health, detail): Promise<void>`
  - `channelConfigured(secretRefs, env): boolean`
  - `checkWecomHealth(bridgeUrl, fetchImpl?): Promise<{ok:boolean; detail?:string}>`

- [ ] **Step 1: 实现**

```ts
export type ChannelView = {
  id: string; provider: string; enabled: boolean; config: Record<string, unknown>
  secretRefs: Record<string, string>; health: string | null; healthAt: string | null
}

export async function listChannels(pool: Pool, org: string): Promise<ChannelView[]> {
  const { rows } = await pool.query(
    `select id,provider,enabled,config,secret_refs,health,health_at
       from notify.channel where org=$1 order by id`, [org])
  return rows.map((r) => ({
    id: r.id, provider: r.provider, enabled: r.enabled, config: r.config,
    secretRefs: r.secret_refs, health: r.health,
    healthAt: r.health_at ? (r.health_at as Date).toISOString() : null,
  }))
}

export function channelConfigured(secretRefs: Record<string, string>, env = process.env): boolean {
  return Object.values(secretRefs).every((k) => !!env[k])
}

export async function patchChannel(
  pool: Pool, org: string, id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> }, actor: string,
): Promise<number> {
  const r = await pool.query(
    `update notify.channel set
       enabled = coalesce($3, enabled),
       config = case when $4::jsonb is null then config else config || $4::jsonb end,
       updated_at = now()
     where org=$1 and id=$2`,
    [org, id, patch.enabled ?? null, patch.config ? JSON.stringify(patch.config) : null])
  if ((r.rowCount ?? 0) > 0) await audit(pool, org, actor, 'channel.patch', id, patch)
  return r.rowCount ?? 0
}

export async function setChannelHealth(
  pool: Pool, org: string, id: string, health: string, detail?: string,
): Promise<void> {
  await pool.query(
    'update notify.channel set health=$3, health_at=now(), updated_at=now() where org=$1 and id=$2',
    [org, id, detail ? `${health}:${detail}` : health])
}
```

```ts
// domain/channel.ts
export async function checkWecomHealth(
  bridgeUrl: string, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail?: string }> {
  // bridge URL 形如 https://push.hookflow.cn/wecom/<tenant>?t=<token>；healthz 在 host 根
  const url = new URL('/healthz', bridgeUrl).toString()
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    return res.status === 200 ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 2: 测试**

```ts
it('channelConfigured：任一 env 缺 ⇒ false', () => {
  expect(channelConfigured({ bridge_url: 'X' }, { X: 'v' })).toBe(true)
  expect(channelConfigured({ bridge_url: 'X' }, {})).toBe(false)
})
it('healthz 200/500/超时', async () => { /* fetch 注入 */ })
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/storage.ts modules/notify/domain/channel.ts modules/notify/*.test.ts modules/notify/domain/channel.test.ts
git commit -m "feat(notify): 通道存储与健康"
```

---

## Task 5: 模板 / 事件 / 通道端点

**Files:**
- Modify: `modules/notify/routes.ts`
- Modify: `modules/notify/index.ts`（把 `ctx.addresses` 透传进 router）
- Modify: `modules/notify/storage.ts`（`insertDelivery` 支持 `isTest`；`retryDelivery`）
- Modify: `modules/notify/manifest.yaml`
- Test: `modules/notify/routes.test.ts`

**Interfaces:**
- Produces endpoints:
  - `GET /events`、`GET /events/:key`
  - `GET /templates`、`GET /templates/:key`
  - `POST /templates/:key/revisions`
  - `POST /templates/:key/preview`
  - `POST /templates/:key/publish`
  - `GET /channels`、`PATCH /channels/:id`、`POST /channels/:id/health`
  - `POST /test-send`、`POST /deliveries/retry`

- [ ] **Step 1: 写失败测试（关键）**

```ts
it('GET /events 返回注入目录；未知 key 404', async () => {
  const r = await app.request('/events')
  expect(((await r.json()) as { events: unknown[] }).events).toHaveLength(1)
  expect((await app.request('/events/nope')).status).toBe(404)
})

it('草稿→预览→发布；无 notify:publish 的调用方由宿主门卫挡（本测试验 403 由宿主施加，模块不判）', async () => {
  const draft = await post('/templates/t1/revisions', { contents: { wecom_chat: { text: 'v2 {{title}}' } } })
  expect(draft.status).toBe(201)

  const preview = await post('/templates/t1/preview', { contents: { wecom_chat: { text: '{{title}}' } }, payload: { title: 'T' } })
  expect(preview.status).toBe(200)
  expect(((await preview.json()) as any).rendered.wecom_chat.text).toBe('T')

  const pub = await post('/templates/t1/publish', { revision: 2 })
  expect(pub.status).toBe(200)
  expect((await get('/templates/t1')).publishedRevision).toBe(2)
})

it('预览未知变量 ⇒ 400；发布前必须校验通过', async () => {
  expect((await post('/templates/t1/preview', {
    contents: { wecom_chat: { text: '{{nope}}' } }, payload: {},
  })).status).toBe(400)
})

it('通道：列表不含密钥值；patch 只改非敏感；health 走 provider', async () => {
  const list = await app.request('/channels')
  const body = await list.json() as { channels: any[] }
  expect(body.channels[0].secretRefs).toEqual({ bridge_url: 'WECOM_BRIDGE_URL__X' })
  expect(JSON.stringify(body)).not.toContain('secret-value')

  expect((await app.request('/channels/wecom_default', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })).status).toBe(200)

  expect((await app.request('/channels/wecom_default', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret_refs: { bridge_url: 'X' } }),
  })).status).toBe(400)
})
```

- [ ] **Step 2: 实现路由**

要点：

- `GET /events`：`deps.events?.list() ?? []`；`GET /events/:key`：`get` 不到 404。
- `GET /templates` / `GET /templates/:key`：`listTemplates` / `getTemplate`。
- `POST /templates/:key/revisions`：
  - body `{ contents }`；取模板 `getTemplate` + 事件声明 `deps.events.get(template.eventKey)`；
  - `validateContents(contents, decl, providerSet)`；有问题 400 `{error:'TEMPLATE_INVALID', issues}`；
  - `createTemplateRevision`；审计 `template.draft`；201 `{revision}`。
- `POST /templates/:key/preview`：
  - body `{ contents?, revision?, payload }`；取 contents（缺省用 revision 或 published）；
  - `renderContents(contents, payload, Object.keys(contents))`；失败 400 `{error:'TEMPLATE_RENDER_FAILED', issues}`；200 `{rendered}`；
  - **纯函数，不外发**。
- `POST /templates/:key/publish`：
  - body `{ revision }`；取模板/事件；`validateContents(revision.contents, decl, enabledProviders)`；
  - 失败 400；成功 `publishTemplateRevision`；审计 `template.publish`；200 `{publishedRevision}`。
- `GET /channels`：`listChannels` 返回 `{id,provider,enabled,config,secretRefs,health,healthAt,configured}`；
  `configured` = `secret_refs` 的每个 env 键在当前进程 env 中存在；**绝不返回值**。
- `PATCH /channels/:id`：body 仅允许 `{enabled?, config?}`；出现 `secret_refs` ⇒ 400 `SECRET_REFS_READONLY`；
  `config` 只允许键 `address_fallback|rate_limit_per_min|timeout_ms`；审计 `channel.patch`。
- `POST /channels/:id/health`：`wecom_chat` 调 `GET {bridgeUrl}/healthz`（5s 超时）；`in_app` 恒 ok；
  写 `health/health_at`；返回 `{ok, detail}`。
- `POST /test-send`：body `{ templateKey, payload }`；recipient = `identity.userId`；取 published 模板；
  `validatePayload`（事件声明）+ `renderContents`；`resolveAddress`（wecom/in_app）；插 `notify.delivery` 行
  `is_test=true`、`status='pending'`、`event_id='test:<uuid>'`；审计 `test.send`；202。
  速率：同一用户最近 1 分钟最多 5 条（查 `is_test` 行数）⇒ 超限 429。
- `POST /deliveries/retry`：body `{eventId,ruleId,recipient,channel}`；把 `failed/dead` 置回 `pending`、
  `next_attempt_at=now()`、`locked_until=null`；审计 `delivery.retry`；200。

```ts
// routes.ts（关键实现；identity/org 取法与 P1 相同）
export function createNotifyRouter(deps: {
  pool: Pool
  events?: EventCatalogReader
  addresses?: ChannelAddressResolver
}) {
  // 既有 /rules /deliveries /emit /inbox 端点保持 P1 实现
  r.get('/events', async (c) => c.json({ events: deps.events?.list() ?? [] }))
  r.get('/events/:key', async (c) => {
    const ev = deps.events?.get(c.req.param('key'))
    return ev ? c.json(ev) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  r.get('/templates', async (c) => c.json({ templates: await listTemplates(deps.pool, org(c)) }))
  r.get('/templates/:key', async (c) => {
    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    return t ? c.json(t) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  r.post('/templates/:key/revisions', async (c) => {
    const body = await c.req.json().catch(() => null) as { contents?: Record<string, Record<string, string>> } | null
    if (!body?.contents) return c.json({ error: 'INVALID_BODY' }, 400)
    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    const channels = await listChannels(deps.pool, org(c))
    const issues = validateContents(body.contents, decl,
      [...new Set(channels.filter((x) => x.enabled).map((x) => x.provider))])
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_INVALID', issues }, 400)
    const r = await createTemplateRevision(deps.pool, org(c), t.key, body.contents,
      (c.get('identity') as Identity).userId)
    await audit(deps.pool, org(c), (c.get('identity') as Identity).userId,
      'template.draft', t.key, { revision: r.revision })
    return c.json(r, 201)
  })

  r.post('/templates/:key/preview', async (c) => {
    const body = await c.req.json().catch(() => null) as
      { contents?: Record<string, Record<string, string>>; revision?: number; payload?: Record<string, unknown> } | null
    if (!body?.payload) return c.json({ error: 'INVALID_BODY' }, 400)
    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const contents = body.contents
      ?? t.revisions.find((x) => x.revision === (body.revision ?? t.publishedRevision))?.contents
    if (!contents) return c.json({ error: 'REVISION_NOT_FOUND' }, 404)
    const rendered = renderContents(contents, body.payload, Object.keys(contents))
    if (!rendered.ok) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues: rendered.issues }, 400)
    return c.json({ rendered: rendered.rendered })
  })

  r.post('/templates/:key/publish', async (c) => {
    const body = await c.req.json().catch(() => null) as { revision?: number } | null
    if (!body?.revision) return c.json({ error: 'INVALID_BODY' }, 400)
    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const rev = t.revisions.find((x) => x.revision === body.revision)
    if (!rev) return c.json({ error: 'REVISION_NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    const channels = await listChannels(deps.pool, org(c))
    const issues = validateContents(rev.contents, decl,
      [...new Set(channels.filter((x) => x.enabled).map((x) => x.provider))])
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_INVALID', issues }, 400)
    const actor = (c.get('identity') as Identity).userId
    await publishTemplateRevision(deps.pool, org(c), t.key, rev.revision, actor)
    await audit(deps.pool, org(c), actor, 'template.publish', t.key, { revision: rev.revision })
    return c.json({ publishedRevision: rev.revision })
  })

  r.get('/channels', async (c) => {
    const list = await listChannels(deps.pool, org(c))
    return c.json({
      channels: list.map((x) => ({ ...x, configured: channelConfigured(x.secretRefs) })),
    })
  })

  r.patch('/channels/:id', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'INVALID_BODY' }, 400)
    if ('secret_refs' in body || 'secretRefs' in body) {
      return c.json({ error: 'SECRET_REFS_READONLY' }, 400)
    }
    const allowed = new Set(['enabled', 'config'])
    if (Object.keys(body).some((k) => !allowed.has(k))) return c.json({ error: 'INVALID_BODY' }, 400)
    const config = body.config as Record<string, unknown> | undefined
    if (config && Object.keys(config).some((k) =>
      !['address_fallback', 'rate_limit_per_min', 'timeout_ms'].includes(k))) {
      return c.json({ error: 'CONFIG_KEY_INVALID' }, 400)
    }
    const n = await patchChannel(deps.pool, org(c), c.req.param('id'), {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      config,
    }, (c.get('identity') as Identity).userId)
    return n === 0 ? c.json({ error: 'NOT_FOUND' }, 404) : c.json({ ok: true })
  })

  r.post('/channels/:id/health', async (c) => {
    const ch = await getChannel(deps.pool, org(c), c.req.param('id'))
    if (!ch) return c.json({ error: 'NOT_FOUND' }, 404)
    let result: { ok: boolean; detail?: string } = { ok: true }
    if (ch.provider === 'wecom_chat') {
      const envKey = ch.secret_refs.bridge_url
      const bridgeUrl = envKey ? process.env[envKey] : undefined
      result = bridgeUrl
        ? await checkWecomHealth(bridgeUrl)
        : { ok: false, detail: 'bridge_url env 未配置' }
    }
    await setChannelHealth(deps.pool, org(c), ch.id, result.ok ? 'ok' : 'error', result.detail)
    return c.json(result)
  })

  r.post('/test-send', async (c) => {
    const body = await c.req.json().catch(() => null) as
      { templateKey?: string; channel?: string; payload?: Record<string, unknown> } | null
    if (!body?.templateKey || !body.channel || !body.payload) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const identity = c.get('identity') as Identity
    const recent = await countRecentTestDeliveries(deps.pool, identity.orgId, identity.userId)
    if (recent >= 5) return c.json({ error: 'TEST_RATE_LIMITED' }, 429)

    const t = await getTemplate(deps.pool, identity.orgId, body.templateKey)
    const rev = t?.revisions.find((x) => x.revision === t.publishedRevision)
    if (!t || !rev) return c.json({ error: 'NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    const bad = validatePayload(decl, body.payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)
    const rendered = renderContents(rev.contents, body.payload, Object.keys(rev.contents))
    if (!rendered.ok) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues: rendered.issues }, 400)

    const ch = await getChannel(deps.pool, identity.orgId, body.channel)
    if (!ch || !ch.enabled) return c.json({ error: 'CHANNEL_NOT_FOUND' }, 404)
    const resolved = await deps.addresses?.resolve({
      org: identity.orgId, provider: ch.provider, casdoorName: identity.userId,
    })
    const address = resolved
      ?? (ch.provider === 'wecom_chat' && ch.config.address_fallback === 'casdoor_name'
        ? identity.userId : null)
    if (!address && ch.provider !== 'in_app') return c.json({ error: 'MISSING_ADDRESS' }, 400)

    await insertDelivery(deps.pool, {
      org: identity.orgId, eventId: `test:${randomUUID()}`, eventKey: t.eventKey,
      ruleId: 'test', recipient: identity.userId, channel: ch.id,
      address: address ?? identity.userId, templateKey: t.key, revision: rev.revision,
      rendered: rendered.rendered[ch.provider] ?? {}, status: 'pending', isTest: true,
    })
    await audit(deps.pool, identity.orgId, identity.userId, 'test.send', t.key,
      { channel: ch.id })
    return c.json({ accepted: true }, 202)
  })

  r.post('/deliveries/retry', async (c) => {
    const body = await c.req.json().catch(() => null) as
      { eventId?: string; ruleId?: string; recipient?: string; channel?: string } | null
    if (!body?.eventId || !body.ruleId || !body.recipient || !body.channel) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const n = await retryDelivery(deps.pool, org(c), body as Required<typeof body>)
    if (n === 0) return c.json({ error: 'NOT_RETRYABLE' }, 404)
    await audit(deps.pool, org(c), (c.get('identity') as Identity).userId,
      'delivery.retry', `${body.eventId}|${body.ruleId}`, body)
    return c.json({ ok: true })
  })
}
```

存储侧补充（Task 5 一并做）：

```sql
-- insertDelivery 追加 is_test（P1 的列清单 + 新列）
insert into notify.delivery
  (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,is_test,last_error)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)
```

```ts
export async function retryDelivery(pool: Pool, org: string, k: {
  eventId: string; ruleId: string; recipient: string; channel: string
}): Promise<number> {
  const r = await pool.query(
    `update notify.delivery
        set status='pending', next_attempt_at=now(), locked_until=null, last_error=null, updated_at=now()
      where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5
        and status in ('failed','dead')`,
    [org, k.eventId, k.ruleId, k.recipient, k.channel])
  return r.rowCount ?? 0
}
export async function countRecentTestDeliveries(pool: Pool, org: string, recipient: string) {
  const { rows } = await pool.query(
    `select count(*)::int n from notify.delivery
      where org=$1 and recipient=$2 and is_test and created_at > now()-interval '1 minute'`,
    [org, recipient])
  return rows[0].n as number
}
```

`index.ts` 改为：

```ts
createRouter: ({ pool, events, addresses }) => createNotifyRouter({ pool, events, addresses })
```

`manifest.yaml` 增加对应声明：

```yaml
  - { method: GET,    path: /events,                  scope: notify:view }
  - { method: GET,    path: /events/:key,             scope: notify:view }
  - { method: GET,    path: /templates,               scope: notify:view }
  - { method: GET,    path: /templates/:key,          scope: notify:view }
  - { method: POST,   path: /templates/:key/revisions,scope: notify:manage }
  - { method: POST,   path: /templates/:key/preview,  scope: notify:manage }
  - { method: POST,   path: /templates/:key/publish,  scope: notify:publish }
  - { method: GET,    path: /channels,                scope: notify:view }
  - { method: PATCH,  path: /channels/:id,            scope: notify:channel }
  - { method: POST,   path: /channels/:id/health,     scope: notify:manage }
  - { method: POST,   path: /test-send,               scope: notify:manage }
  - { method: POST,   path: /deliveries/retry,        scope: notify:manage }
  - { method: POST,   path: /mcp-manage,              scope: notify:manage }
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter notify exec vitest run routes.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/routes.ts modules/notify/manifest.yaml modules/notify/routes.test.ts
git commit -m "feat(notify): 模板/通道/测试发送端点"
```

---

## Task 6: Console 脚手架 + api 客户端

**Files:**
- Create: `modules/notify/console/api.ts`
- Create: `modules/notify/console/test-util.tsx`（页面测试共用：mock `platformFetch`）
- Create: `modules/notify/console/index.tsx`
- Modify: `modules/notify/manifest.yaml`（frontend.console）
- Regenerate: `apps/web/src/console-registry.gen.ts`

**Interfaces:**
- Produces: `/console/notify` 六 tab 壳；`apiGet/apiSend` 用 `platformFetch`

- [ ] **Step 1: 声明 console 条目**

```yaml
frontend:
  console:
    - { path: /console/notify, title: 通知, icon: BellOutlined, scope: notify:view, entry: ./console/index.tsx }
```

- [ ] **Step 2: api 客户端**

```ts
import { platformFetch } from '@platform/sdk/web'
const BASE = '/api/modules/notify'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
  }
}
async function read(res: Response): Promise<never> {
  const b = await res.json().catch(() => null) as { error?: string; issues?: string[] } | null
  throw new ApiError(res.status, b?.error ?? `HTTP_${res.status}`, b?.issues?.join('; '))
}
export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(path)
  if (!res.ok) await read(res)
  return res.json() as Promise<T>
}
export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await platformFetch(path, {
    method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  })
  if (!res.ok) await read(res)
  return res.json() as Promise<T>
}
export const get = <T>(p: string) => apiGet<T>(p)
export const post = <T>(p: string, b?: unknown) => apiSend<T>('POST', p, b)
export const patch = <T>(p: string, b?: unknown) => apiSend<T>('PATCH', p, b)
export const del = <T>(p: string) => apiSend<T>('DELETE', p)
```

- [ ] **Step 3: 页面测试共用 harness**

```tsx
// console/test-util.tsx
import { vi } from 'vitest'
import { platformFetch } from '@platform/sdk/web'

export const fetchMock = vi.mocked(platformFetch)

export function routeFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    const h = routes[key] ?? routes[input]
    if (!h) throw new Error('unexpected fetch: ' + key)
    return h(init)
  })
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
```

每个页面测试文件顶部：

```tsx
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json, fetchMock } from './test-util'
beforeEach(() => { fetchMock.mockReset() })
```

- [ ] **Step 3: tab 壳**

```tsx
const BASE = '/console/notify'
const TABS = [
  { key: 'events', label: '事件目录' },
  { key: 'rules', label: '规则' },
  { key: 'templates', label: '模板' },
  { key: 'channels', label: '通道' },
  { key: 'deliveries', label: '投递' },
  { key: 'inbox', label: '收件箱' },
] as const
// 与 forms/aftersales 同姿势：pathname 末段选页、绝对路径导航、无嵌套 Routes
```

各 tab 组件先渲染 `<Empty description="P2 待实现" />`，后续任务填充；**不要**写半个编辑器。

- [ ] **Step 4: 生成 registry + 自验**

```bash
node scripts/gen-console-registry.mjs
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
```
Expected: registry 出现 `/console/notify`；测试绿。

- [ ] **Step 5: 提交**

```bash
git add modules/notify/console modules/notify/manifest.yaml apps/web/src/console-registry.gen.ts
git commit -m "feat(notify): console 六区脚手架"
```

---

## Task 7: 事件目录 + 规则页

**Files:**
- Create: `modules/notify/console/events.tsx`
- Create: `modules/notify/console/rules.tsx`
- Modify: `modules/notify/console/index.tsx`
- Test: `modules/notify/console/events.test.tsx`、`rules.test.tsx`

- [ ] **Step 1: 事件页**

`GET /events` 列表：key / title / source / scope / payload 字段 / recipients / defaults；点击行展开 JSON。

- [ ] **Step 2: 规则页**

列表：事件 / 作用域 / 收件人 / 模板 / 通道 / 来源 / 启停 / 删除。
新建表单（**只放下拉，无表达式编辑器**）：
- 事件：`/events`（选中后按 `recipients` 给收件人下拉；按 `scope` 决定作用域输入是否可用）；
- 模板：`/templates` 只列 `status=published`；
- 通道：`/channels` 只列 `enabled`；
- 冷却分钟数可选。
提交 `POST /rules`；启停 `PUT /rules/:id/enabled`；删除 `DELETE /rules/:id`。

- [ ] **Step 3: 测试（happy-dom）**

```tsx
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json } from './test-util'

const decl = {
  key: 'm.a.b', title: 't',
  payload: { title: { type: 'string' } },
  recipients: { approvers: { kind: 'scope_holders', scope: 'm:manage' } },
}

it('新建规则只允许选已声明收件人/已发布模板/启用通道', async () => {
  let captured: Record<string, unknown> | null = null
  routeFetch({
    'GET /api/modules/notify/events': () => json({ events: [decl] }),
    'GET /api/modules/notify/templates': () => json({
      templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
    }),
    'GET /api/modules/notify/channels': () => json({
      channels: [{ id: 'wecom_default', enabled: true, provider: 'wecom_chat' }],
    }),
    'POST /api/modules/notify/rules': (init) => {
      captured = JSON.parse(String(init!.body))
      return json({ id: 'r1' }, 201)
    },
  })
  render(<RulesTab />)
  await userEvent.click(await screen.findByRole('button', { name: /新建规则/ }))
  await userEvent.click(screen.getByLabelText('事件'))
  await userEvent.click(await screen.findByText('m.a.b'))
  expect(screen.getByText('approvers')).toBeInTheDocument()
  expect(screen.queryByText('nope')).toBeNull()
  // 选收件人/模板/通道后提交
  await userEvent.click(screen.getByLabelText('收件人'))
  await userEvent.click(screen.getByText('approvers'))
  await userEvent.click(screen.getByLabelText('模板'))
  await userEvent.click(screen.getByText('t1'))
  await userEvent.click(screen.getByLabelText('通道'))
  await userEvent.click(screen.getByText('wecom_default'))
  await userEvent.click(screen.getByRole('button', { name: /保存/ }))
  expect(captured).toMatchObject({
    eventKey: 'm.a.b', recipientKey: 'approvers', templateKey: 't1', channels: ['wecom_default'],
  })
})
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/console/events.tsx modules/notify/console/rules.tsx modules/notify/console/*.test.tsx modules/notify/console/index.tsx
git commit -m "feat(notify): console 事件与规则页"
```

---

## Task 8: 模板页（编辑/预览/版本/发布）

**Files:**
- Create: `modules/notify/console/templates.tsx`
- Test: `modules/notify/console/templates.test.tsx`

- [ ] **Step 1: 页面**

- 左侧模板列表（`GET /templates`）；右侧：
  - **编辑区**：按 provider 分块（`wecom_chat.text` textarea、`in_app.title/body/link`）；
  - **样例 payload**：JSON textarea（按事件 payload 字段给默认值）；
  - **预览**：`POST /templates/:key/preview`，逐通道展示渲染结果；
  - **保存草稿**：`POST /templates/:key/revisions`；
  - **版本列表**：revision / reviewStatus / createdBy / createdAt；
  - **发布**：`POST /templates/:key/publish {revision}`；**回滚** = 发布旧 revision。
- 按钮可见性：保存/预览对 `notify:manage`；发布按钮只在有 `notify:publish` 时显示。
  前端如何拿 scopes：读 `/api/platform/config` 若返回 `scopes` 则用；否则显示按钮、由服务端 403 兜底。
  **不新增前端权限判定机制**。

- [ ] **Step 2: 测试**

```tsx
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json } from './test-util'

const tpl = {
  key: 't1', name: 'T', eventKey: 'm.a.b', status: 'published', publishedRevision: 1,
  revisions: [{
    revision: 1, contents: { wecom_chat: { text: '{{title}}' } }, bodyHash: 'h',
    reviewStatus: 'approved', createdBy: 'u', createdAt: '2026-10-27T00:00:00Z',
  }],
}

it('预览展示逐通道渲染；未知变量由服务端 400 展示', async () => {
  routeFetch({
    'GET /api/modules/notify/templates': () => json({ templates: [tpl] }),
    'GET /api/modules/notify/templates/t1': () => json(tpl),
    'POST /api/modules/notify/templates/t1/preview': (init) => {
      const body = JSON.parse(String(init!.body))
      return body.payload.title
        ? json({ rendered: { wecom_chat: { text: 'T' } } })
        : json({ error: 'TEMPLATE_RENDER_FAILED', issues: ['unknown_variable:nope'] }, 400)
    },
  })
  render(<TemplatesTab />)
  await userEvent.click(await screen.findByText('t1'))
  await userEvent.type(screen.getByLabelText('样例 payload'), '{"title":"T"}')
  await userEvent.click(screen.getByRole('button', { name: /预\s*览/ }))
  expect(await screen.findByText('T')).toBeInTheDocument()
})

it('发布按钮调用 publish 并展示新发布版本', async () => {
  let published: unknown = null
  routeFetch({
    'GET /api/modules/notify/templates': () => json({ templates: [tpl] }),
    'GET /api/modules/notify/templates/t1': () => json(tpl),
    'POST /api/modules/notify/templates/t1/publish': (init) => {
      published = JSON.parse(String(init!.body))
      return json({ publishedRevision: 2 })
    },
  })
  render(<TemplatesTab />)
  await userEvent.click(await screen.findByText('t1'))
  await userEvent.click(screen.getByRole('button', { name: /发布 v2/ }))
  expect(published).toEqual({ revision: 2 })
})
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/console/templates.tsx modules/notify/console/templates.test.tsx
git commit -m "feat(notify): console 模板页"
```

---

## Task 9: 通道页（配置/健康/测试发送）

**Files:**
- Create: `modules/notify/console/channels.tsx`
- Test: `modules/notify/console/channels.test.tsx`

- [ ] **Step 1: 页面**

- 列表：id / provider / 启停 / `configured`（已配置/未配置 + env 键名）/ health + 时间；
- 配置：`address_fallback`（none/casdoor_name）、`rate_limit_per_min`、`timeout_ms`；
- 操作：启停（PATCH）、健康检查（POST health）、测试发送（**只发给自己**：选模板 + 样例 payload）；
- **不显示、不编辑任何密钥值**；`secret_refs` 只读展示键名。

- [ ] **Step 2: 测试**

```tsx
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json } from './test-util'

it('未配置通道只显示 env 键名，不显示任何值', async () => {
  routeFetch({
    'GET /api/modules/notify/channels': () => json({
      channels: [{
        id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: false,
        secretRefs: { bridge_url: 'WECOM_BRIDGE_URL__X' },
        config: { address_fallback: 'none' }, health: null, healthAt: null,
      }],
    }),
  })
  render(<ChannelsTab />)
  expect(await screen.findByText(/未配置/)).toBeInTheDocument()
  expect(screen.getByText('WECOM_BRIDGE_URL__X')).toBeInTheDocument()
  expect(document.body.textContent).not.toContain('secret-value')
})

it('patch 只发 enabled/config；测试发送无收件人输入', async () => {
  let patched: Record<string, unknown> | null = null
  routeFetch({
    'GET /api/modules/notify/channels': () => json({
      channels: [{ id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
        secretRefs: {}, config: {}, health: 'ok', healthAt: null }],
    }),
    'PATCH /api/modules/notify/channels/wecom_default': (init) => {
      patched = JSON.parse(String(init!.body))
      return json({ ok: true })
    },
  })
  render(<ChannelsTab />)
  await userEvent.click(await screen.findByRole('switch'))
  expect(patched).toEqual({ enabled: false })
  expect(screen.queryByLabelText('收件人')).toBeNull()
})
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/console/channels.tsx modules/notify/console/channels.test.tsx
git commit -m "feat(notify): console 通道页"
```

---

## Task 10: 投递页 + 收件箱页

**Files:**
- Create: `modules/notify/console/deliveries.tsx`
- Create: `modules/notify/console/inbox.tsx`
- Test: `modules/notify/console/deliveries.test.tsx`、`inbox.test.tsx`

- [ ] **Step 1: 投递页**

- 列表：时间 / 事件 / 收件人 / 通道 / 状态 / 尝试次数 / 错误摘要 / `isTest`；
- 筛选：状态、通道、收件人；
- 单条重试：`POST /deliveries/retry`（仅 `failed/dead` 可点）；
- 不显示渲染正文（只显示模板 key + revision）。

- [ ] **Step 2: 收件箱页**

- `GET /inbox?unread=1` 切换；列表标题/正文/链接/时间；
- 单条已读 `POST /inbox/:id/read`；全部已读 = 循环或后端 `read-all`（本计划只做单条，批量留 P3）。

- [ ] **Step 2.5: 页面测试**

```tsx
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json } from './test-util'

it('投递页只对 failed/dead 显示重试；重试发复合键', async () => {
  let retried: unknown = null
  routeFetch({
    'GET /api/modules/notify/deliveries': () => json({ deliveries: [
      { eventId: 'e1', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
        status: 'failed', attempts: 2, lastError: '502', createdAt: '2026-10-27T00:00:00Z' },
      { eventId: 'e2', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
        status: 'sent', attempts: 1, lastError: null, createdAt: '2026-10-27T00:00:00Z' },
    ] }),
    'POST /api/modules/notify/deliveries/retry': (init) => {
      retried = JSON.parse(String(init!.body))
      return json({ ok: true })
    },
  })
  render(<DeliveriesTab />)
  expect(await screen.findAllByRole('button', { name: /重试/ })).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: /重试/ }))
  expect(retried).toEqual({ eventId: 'e1', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default' })
})

it('收件箱：未读筛选 → 标记已读', async () => {
  routeFetch({
    'GET /api/modules/notify/inbox?unread=1': () => json({ items: [
      { id: 'i1', title: 'T', body: 'B', link: 'https://x', read_at: null, created_at: '2026-10-27T00:00:00Z' },
    ] }),
    'POST /api/modules/notify/inbox/i1/read': () => json({ ok: true }),
  })
  render(<InboxTab />)
  await userEvent.click(await screen.findByText('T'))
  expect(await screen.findByText(/已读/)).toBeInTheDocument()
})
```

- [ ] **Step 3: 测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/console/deliveries.tsx modules/notify/console/inbox.tsx modules/notify/console/*.test.tsx
git commit -m "feat(notify): console 投递与收件箱页"
```

---

## Task 11: Agent MCP 工具面

**Files:**
- Create: `modules/notify/mcp-tools.ts`（**纯**元数据，无 Hono/pg 运行时依赖）
- Create: `modules/notify/mcp.ts`
- Modify: `modules/notify/routes.ts`（注册 `/mcp-manage`）
- Modify: `scripts/check-mcp-toolface.mjs`
- Test: `modules/notify/mcp.test.ts`、`scripts/check-mcp-toolface.test.ts`

**Interfaces:**
- Produces: `NOTIFY_TOOLS`（12 个）、`NOTIFY_MAX_TOOLS = 12`、`callTool(deps, name, args)`

- [ ] **Step 1: 工具清单（纯元数据）**

```ts
export const NOTIFY_MAX_TOOLS = 12
export type NotifyToolMeta = {
  name: string; description: string; inputSchema: Record<string, unknown>
  mutating: boolean; annotations?: Record<string, unknown>; requiredScope: string | null
}

const t = (
  name: string, description: string,
  properties: Record<string, unknown>, required: string[],
  mutating: boolean, requiredScope: string | null,
): NotifyToolMeta => ({
  name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  mutating,
  annotations: { readOnlyHint: !mutating },
  requiredScope,
})

const EVENT = { eventKey: { type: 'string' } }
const RULE_FIELDS = {
  eventKey: { type: 'string' },
  mount: { type: 'string' },
  recipientKey: { type: 'string' },
  recipientLiteral: { type: 'array', items: { type: 'string' } },
  templateKey: { type: 'string' },
  channels: { type: 'array', items: { type: 'string' } },
  cooldownMinutes: { type: 'number' },
}

export const NOTIFY_TOOLS: NotifyToolMeta[] = [
  t('list_events', '列出本租户可用的事件目录（建规则前先查）。', {}, [], false, null),
  t('get_event', '查看单个事件的 payload / 收件人 / 默认规则。', EVENT, ['eventKey'], false, null),
  t('list_rules', '列出通知规则。', {}, [], false, null),
  t('propose_rule', '创建一条通知规则（事件 × 作用域 × 收件人 × 模板 × 通道），即时生效、可一键停用。',
    RULE_FIELDS, ['eventKey', 'mount', 'recipientKey', 'templateKey', 'channels'],
    true, 'notify:manage'),
  t('update_rule', '修改一条规则（字段同 propose_rule，另需 id）。',
    { id: { type: 'string' }, ...RULE_FIELDS }, ['id'], true, 'notify:manage'),
  t('set_rule_enabled', '启停一条规则。',
    { id: { type: 'string' }, enabled: { type: 'boolean' } }, ['id', 'enabled'],
    true, 'notify:manage'),
  t('list_templates', '列出模板与当前发布版本。', {}, [], false, null),
  t('get_template', '查看模板与全部 revision。', { key: { type: 'string' } }, ['key'], false, null),
  t('draft_template', '新建/更新模板草稿 revision（只写草稿，不发布）。',
    { key: { type: 'string' }, contents: { type: 'object' } }, ['key', 'contents'],
    true, 'notify:manage'),
  t('preview_template', '用样例 payload 渲染模板（纯预览，不外发）。',
    { key: { type: 'string' }, revision: { type: 'number' }, payload: { type: 'object' } },
    ['key', 'payload'], false, 'notify:manage'),
  t('list_deliveries', '查看投递回执与错误摘要。', { limit: { type: 'number' } }, ['limit'], false, null),
  t('send_test', '给自己试发一条（收件人强制为调用者本人）。',
    { templateKey: { type: 'string' }, channel: { type: 'string' }, payload: { type: 'object' } },
    ['templateKey', 'channel', 'payload'], true, 'notify:manage'),
]
```

> **没有** publish / channel / 任意收件人试发工具。

- [ ] **Step 2: MCP 壳与实现**

- `POST /mcp-manage`：JSON-RPC 壳照 `modules/forms/mcp.ts`（initialize/ping/tools/list/tools/call；通知 202；错误信封）。
- `callTool`：
  - `list_events/get_event` → `deps.events.list/get`
  - `list_rules/update_rule/set_rule_enabled` → storage（写操作 `audit('mcp.<tool>')`）
  - `propose_rule` → `validateRule` 后 `upsertRule`（origin manual）
  - `list_templates/get_template` → storage
  - `draft_template` → `validateContents` + `createTemplateRevision`（只草稿）
  - `preview_template` → `renderContents`（纯函数，无外发）
  - `list_deliveries` → storage
  - `send_test` → **收件人强制 = `deps.userId`**；复用 Task 5 的 test-send 逻辑；`audit('mcp.send_test')`
- 所有写工具带 `audit`。

- [ ] **Step 3: 门禁纳入 notify 面**

`check-mcp-toolface.mjs`：

```js
import { NOTIFY_MAX_TOOLS, NOTIFY_TOOLS } from '../modules/notify/mcp-tools.ts'

// main 的 violations 数组追加：
...checkToolface(NOTIFY_TOOLS, { maxTools: NOTIFY_MAX_TOOLS }),
```

- [ ] **Step 4: 测试**

```ts
it('tools/list 恰 12 个；无 publish/channel 工具', async () => {
  const names = toolDefs().map((t) => t.name)
  expect(names).toHaveLength(12)
  expect(names.some((n) => n.includes('publish') || n.includes('channel'))).toBe(false)
})
it('send_test 收件人只能是调用者本人', async () => {
  await callTool({ pool, org: ORG, userId: 'u1', events }, 'send_test', {
    templateKey: 't1', channel: 'inapp_default',
    payload: { title: 'T', link: 'https://x' },
    recipient: 'other',
  })
  const { rows } = await pool.query(
    "select distinct recipient from notify.delivery where org=$1 and is_test", [ORG])
  expect(rows.map((r) => r.recipient)).toEqual(['u1'])
})
it('draft_template 只写 draft，不移动发布指针', async () => {
  const before = await getTemplate(pool, ORG, 't1')
  await callTool({ pool, org: ORG, userId: 'u1', events }, 'draft_template', {
    key: 't1', contents: { wecom_chat: { text: 'v2 {{title}}' } },
  })
  const after = await getTemplate(pool, ORG, 't1')
  expect(after!.publishedRevision).toBe(before!.publishedRevision)
  expect(after!.revisions.some((r) => r.reviewStatus === 'draft')).toBe(true)
})
```

- [ ] **Step 5: 跑测试 + 门禁 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
pnpm exec tsx scripts/check-mcp-toolface.mjs
git add modules/notify/mcp-tools.ts modules/notify/mcp.ts modules/notify/routes.ts scripts/check-mcp-toolface.mjs modules/notify/mcp.test.ts
git commit -m "feat(notify): agent MCP 工具面"
```

---

## Task 12: P2 负对照与权限验收

**Files:**
- Modify/Create: `modules/notify/routes.test.ts`、`mcp.test.ts`、`console/*.test.tsx`

五条负对照（全部要有测试证据）：

```ts
// 1) 无 notify:publish 不能发布（宿主门卫）
it('publish 缺 notify:publish ⇒ 403（宿主施加，模块不判）', async () => {
  const declared = [{ method: 'POST', path: '/templates/:key/publish', scope: 'notify:publish' }]
  const app = buildTestApp(notify, makeIdentity({ orgId: ORG, scopes: ['notify:manage'] }), { pool, events })
  const guarded = new Hono()
  guarded.use('/templates/:key/publish', declaredScopeGate(declared))
  guarded.route('/', app)
  const res = await guarded.request('/templates/t1/publish', { method: 'POST' })
  expect(res.status).toBe(403)
})

// 2) AI 无发布/通道工具
it('tools/list 不含 publish/channel', () => {
  const names = NOTIFY_TOOLS.map((t) => t.name)
  expect(names.some((n) => /publish|channel/.test(n))).toBe(false)
})

// 3) 预览未知变量
it('preview 未知变量 ⇒ 400 unknown_variable', async () => {
  const res = await post('/templates/t1/preview', {
    contents: { wecom_chat: { text: '{{nope}}' } }, payload: { title: 'T' },
  })
  expect(res.status).toBe(400)
  const body = await res.json() as { issues: string[] }
  expect(body.issues.some((i) => i.startsWith('unknown_variable'))).toBe(true)
})

// 4) 测试发送只给自己
it('test-send 传 recipient=other 也只落调用者本人', async () => {
  await post('/test-send', {
    templateKey: 't1', channel: 'inapp_default', payload: { title: 'T', link: 'https://x' },
    recipient: 'other', // 恶意/误传字段：必须被忽略
  })
  const { rows } = await pool.query(
    "select distinct recipient from notify.delivery where org=$1 and is_test", [ORG])
  expect(rows.map((r) => r.recipient)).toEqual(['u1'])
})

// 5) 通道 patch 不能改密钥
it('patch 带 secret_refs ⇒ 400，且响应不回显密钥', async () => {
  const res = await app.request('/channels/wecom_default', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret_refs: { bridge_url: 'X' } }),
  })
  expect(res.status).toBe(400)
  expect(await res.text()).not.toContain('secret-value')
})
```

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
```

Expected: PASS。

提交：

```bash
git add modules/notify
git commit -m "test(notify): P2 负对照与权限验收"
```

---

## Task 13: 文档、全量验证、收尾

**Files:**
- Modify: `docs/architecture.md` §2.6（P2 产品面：UI/MCP/审计；AI 永不发布）
- Modify: `docs/module-protocol.md`（事件声明补充「MCP 工具面不含 publish」）
- Modify: `AGENTS.md`（文档地图/硬约束补一句审计与预览同源）

- [ ] **Step 1: 文档**

- §2.6 增加「产品面（P2）」小节：console 六区、模板草稿/预览/发布/回滚、通道健康、MCP 12 工具、`notify.audit`；明确 **AI 永不发布/永不改密钥**。
- `module-protocol.md` 的通知事件节补：`draft_template` 只写草稿；`preview_template` 与投递同渲染函数。

- [ ] **Step 2: 全量验证**

```bash
pnpm test
pnpm typecheck
pnpm build && pnpm smoke
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-mcp-toolface.mjs
DATABASE_URL=$DATABASE_URL pnpm exec tsx scripts/check-tenant-isolation.mjs
pnpm exec tsx scripts/check-guide-sync.mjs
```

> 中文工作树：全量测试/`smoke` 在 ASCII 副本跑（见记忆 `non-ascii-worktree-path-breaks-vitest`）。

- [ ] **Step 3: 提交**

```bash
git add docs/architecture.md docs/module-protocol.md AGENTS.md
git commit -m "docs(notify): P2 产品面正典"
```

---

## 后续（P3，不在本计划）

- webhook provider、限流细化、OO 告警接线、批量已读/保留期 job。

## Self-Review

- 覆盖：spec §5 模板（Task 2/3/5/8）、§9 UI（Task 6–10）、§10 agent（Task 11）、§11 权限/审计（Task 1/5/12）、§12 可观测（P3）。
- 缺口：webhook/限流/OO 告警（P3）；批量已读（P3）。
- 类型一致性：`TemplateSummary/TemplateDetail/TemplateRevision` 在 Task 2 定义，Task 5/8/11 使用；`ChannelView` 在 Task 4 定义，Task 5/9 使用；`validateContents` 在 Task 3 定义，Task 5/11 使用。
- 硬边界：无 publish/channel MCP 工具；测试发送只给自己；密钥只读键名。
