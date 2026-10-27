# 租户级通知基础设施 Plan 1：协议与竖切（P0+P1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地事件声明协议 + 宿主注入 + 平台自持投递（outbox/worker/企微/in-app），并用 aftersales 员工审批竖切证明全链。

**Architecture:** 模块在 manifest 声明事件；宿主装载期建事件目录并注入 `ctx.notify.emit`；notify 模块把事件写入 outbox；独立 worker 匹配规则、渲染模板、经 provider 直发；Novu 退出关键路径，企微仍走公司 bridge。

**Tech Stack:** TypeScript / Hono / PostgreSQL / Zod / Handlebars / Vitest / openship compose。

## Global Constraints

- 设计正典：`docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md`（本计划的所有取舍以它为准）。
- **Novu 不在关键路径**；本计划不新增任何 `NOVU_*` 依赖；企微走 `WECOM_BRIDGE_URL__<ORG>`。
- **事件 key** = 小写蛇形 + 点号，至少三段，前缀 = `manifest.id`；发布后不复用。
- **org 只来自 `identity.orgId`**，绝不读请求参数；所有业务表 `org text not null` 首列。
- **DB 只存 env 变量名**（`secret_refs`），绝不存密钥值。
- **规则只有五元组**：事件 × 作用域 × 收件人 × 模板 × 通道（+ 可选节流）；**不做条件/延迟/摘要**。
- **AI 不发布文案**；本计划不实现发布工具（P2），只保证发布接口留给 `notify:publish`。
- 迁移必须幂等（`create ... if not exists` / `on conflict`）；重复执行不报错。
- 模块只碰自己的 schema（B1）；`scripts/` 不在扫描根，可跨 import。
- 测试需要 `DATABASE_URL`；无 DB 时 DB 测试按 `describe.skip` 跳过，但纯函数测试必须真跑。
- 本计划覆盖 **P0+P1**；模板草稿/预览/发布 UI、console 五区、agent 工具面（P2）与 webhook/收口（P3）另立计划。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `packages/platform-sdk/src/manifest.ts` | 事件声明 schema + 类型 |
| `packages/platform-sdk/src/module.ts` | `ModuleContext` 新增 `events` / `notify` / `addresses` |
| `packages/platform-sdk/src/index.ts` | 导出新类型 |
| `apps/server/src/migrations/011_event_catalog.sql` | `platform.event_catalog` |
| `apps/server/src/event-catalog.ts` | 目录构建 / 快照 upsert / reader |
| `apps/server/src/notify-port.ts` | 宿主侧的 emit 校验与包装 |
| `apps/server/src/channel-address.ts` | Casdoor 用户 → 渠道地址 |
| `apps/server/src/loader.ts` | 三阶段装载 + 注入 |
| `modules/notify/migrations/002_notify_v2.sql` | 新数据模型 |
| `modules/notify/domain/render.ts` | Handlebars 渲染（预览/投递共用） |
| `modules/notify/domain/rules.ts` | 规则匹配与校验（纯函数） |
| `modules/notify/domain/recipients.ts` | 收件人解析（纯函数部分） |
| `modules/notify/storage.ts` | 所有 SQL 封装 |
| `modules/notify/ports.ts` | `enqueueEvent`（给宿主 createPorts） |
| `modules/notify/worker.ts` | worker 纯编排核心 |
| `modules/notify/providers/*.ts` | wecom / in_app / registry |
| `modules/notify/templates/builtin.ts` | 内置文案 |
| `modules/notify/index.ts` / `routes.ts` / `manifest.yaml` | 端口、端点、声明同步 |
| `scripts/notify-worker.mjs` | worker 进程入口 |
| `scripts/notify-health.mjs` | 健康检查 job |
| `scripts/notify-seed-builtin.mjs` | 内置模板/通道/默认规则 seed |
| `modules/aftersales/manifest.yaml` | 事件声明 |
| `modules/aftersales/routes/registration-guest.ts` | 审批创建后 emit |
| `deploy/docker-compose.yml` | `notify-worker` 服务 |
| `docs/architecture.md` / `docs/module-protocol.md` / `AGENTS.md` | 正典与指针 |

---

## Task 1: SDK 事件声明 schema

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Test: `packages/platform-sdk/src/manifest.test.ts`

**Interfaces:**
- Produces: `NotificationEventDecl`、`EventPayloadType`、`EventFieldDecl`、`EventRecipientDecl`；`ModuleManifest.notifications.events`

- [ ] **Step 1: 写失败测试**

```ts
// packages/platform-sdk/src/manifest.test.ts（追加）
import { ManifestSchema } from './manifest'

const base = {
  id: 'aftersales', name: '售后', version: '0.1.0', platform: '>=0.1',
  permissions: [{ code: 'aftersales:manage', name: '售后管理' }],
}

it('合法事件声明通过', () => {
  const r = ManifestSchema.safeParse({
    ...base,
    notifications: { events: [{
      key: 'aftersales.employee_approval.pending',
      title: '员工登记待审批',
      scope: { key: 'approvalId' },
      payload: {
        approvalId: { type: 'string', required: true },
        applicantName: { type: 'string' },
        link: { type: 'url', required: true },
      },
      recipients: { approvers: { kind: 'scope_holders', scope: 'aftersales:manage' } },
      defaults: { recipient: 'approvers', template: 't1', channels: ['wecom_default'] },
    }] },
  })
  expect(r.success).toBe(true)
})

it('事件 key 前缀必须是模块 id', () => {
  const r = ManifestSchema.safeParse({ ...base, notifications: { events: [{
    key: 'forms.employee_approval.pending', title: 'x', payload: {}, recipients: {},
  }] } })
  expect(r.success).toBe(false)
})

it('scope 字段必须是 payload 的 string 字段', () => {
  const r = ManifestSchema.safeParse({ ...base, notifications: { events: [{
    key: 'aftersales.a.b', title: 'x', scope: { key: 'n' },
    payload: { n: { type: 'number' } }, recipients: {},
  }] } })
  expect(r.success).toBe(false)
})

it('field 收件人必须指向 user/user_list 字段', () => {
  const r = ManifestSchema.safeParse({ ...base, notifications: { events: [{
    key: 'aftersales.a.b', title: 'x',
    payload: { s: { type: 'string' } },
    recipients: { r: { kind: 'field', field: 's' } },
  }] } })
  expect(r.success).toBe(false)
})

it('defaults.recipient 必须已声明', () => {
  const r = ManifestSchema.safeParse({ ...base, notifications: { events: [{
    key: 'aftersales.a.b', title: 'x', payload: {}, recipients: {},
    defaults: { recipient: 'nope', template: 't', channels: ['c'] },
  }] } })
  expect(r.success).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/sdk test -- manifest.test.ts`
Expected: FAIL（`notifications.events` 未定义 / strict 拒绝）

- [ ] **Step 3: 实现类型与 schema**

```ts
// manifest.ts 追加
export type EventPayloadType = 'string' | 'number' | 'boolean' | 'date' | 'url' | 'user' | 'user_list'
export interface EventFieldDecl { type: EventPayloadType; required?: boolean; label?: string }
export interface EventRecipientDecl {
  kind: 'field' | 'scope_holders' | 'literal'
  field?: string
  scope?: string
  label?: string
}
export interface NotificationEventDecl {
  key: string
  title: string
  description?: string
  scope?: { key: string; label?: string }
  payload: Record<string, EventFieldDecl>
  recipients: Record<string, EventRecipientDecl>
  defaults?: { recipient: string; template: string; channels: string[] }
}

export interface ModuleManifest {
  // ...现有字段
  notifications?: { events: NotificationEventDecl[] }
}

const EVENT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/
const PAYLOAD_TYPES = ['string', 'number', 'boolean', 'date', 'url', 'user', 'user_list'] as const

const EventDeclSchema = z.object({
  key: z.string().regex(EVENT_KEY_RE, '事件 key 必须是 <module>.<entity>.<event> 小写蛇形'),
  title: z.string().min(1),
  description: z.string().optional(),
  scope: z.object({ key: z.string().min(1), label: z.string().optional() }).strict().optional(),
  payload: z.record(z.string(), z.object({
    type: z.enum(PAYLOAD_TYPES),
    required: z.boolean().optional(),
    label: z.string().optional(),
  }).strict()),
  recipients: z.record(z.string(), z.object({
    kind: z.enum(['field', 'scope_holders', 'literal']),
    field: z.string().optional(),
    scope: z.string().optional(),
    label: z.string().optional(),
  }).strict()),
  defaults: z.object({
    recipient: z.string(),
    template: z.string(),
    channels: z.array(z.string()).min(1),
  }).strict().optional(),
}).strict()

// 替换原来的 notifications 行
notifications: z.object({ events: z.array(EventDeclSchema) }).strict().optional(),
```

superRefine 追加：

```ts
const events = m.notifications?.events ?? []
const seenKeys = new Set<string>()
for (const [i, ev] of events.entries()) {
  const p = ['notifications', 'events', i]
  if (!ev.key.startsWith(m.id + '.')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'key'], message: `事件 key 必须以 "${m.id}." 开头` })
  }
  if (seenKeys.has(ev.key)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'key'], message: `事件 key 重复 "${ev.key}"` })
  }
  seenKeys.add(ev.key)
  if (Object.keys(ev.payload).length > 20) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'payload'], message: 'payload 最多 20 个字段' })
  }
  if (ev.scope && ev.payload[ev.scope.key]?.type !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'scope', 'key'], message: 'scope.key 必须是 payload 的 string 字段' })
  }
  for (const [rk, r] of Object.entries(ev.recipients)) {
    if (r.kind === 'field') {
      const f = r.field ? ev.payload[r.field] : undefined
      if (!f || (f.type !== 'user' && f.type !== 'user_list')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'recipients', rk], message: 'field 收件人必须指向 user/user_list 字段' })
      }
    } else if (r.kind === 'scope_holders') {
      if (!r.scope) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'recipients', rk], message: 'scope_holders 必须给 scope' })
    } else if (r.field || r.scope) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'recipients', rk], message: 'literal 不能带 field/scope' })
    }
  }
  if (ev.defaults && !ev.recipients[ev.defaults.recipient]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, 'defaults', 'recipient'], message: 'defaults.recipient 必须已在 recipients 声明' })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @platform/sdk test -- manifest.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/manifest.test.ts
git commit -m "feat(sdk): manifest 事件声明协议"
```

---

## Task 2: SDK ModuleContext 注入面

**Files:**
- Modify: `packages/platform-sdk/src/module.ts`
- Modify: `packages/platform-sdk/src/index.ts`
- Test: `packages/platform-sdk/src/module.test.ts`（新建）

**Interfaces:**
- Produces: `NotifyPort`、`EventCatalogReader`、`ChannelAddressResolver`；`ModuleContext.events/notify/addresses`

- [ ] **Step 1: 写失败测试**

```ts
// packages/platform-sdk/src/module.test.ts
import { describe, it, expect } from 'vitest'
import type { ModuleContext } from './module'

it('ModuleContext 可携带 events/notify/addresses', () => {
  const ctx = {
    pool: {} as never,
    events: { get: () => undefined, list: () => [] },
    notify: { emit: async () => ({ accepted: true }) },
    addresses: { resolve: async () => null },
  } satisfies ModuleContext
  expect(typeof ctx.notify?.emit).toBe('function')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/sdk typecheck`
Expected: FAIL（字段不存在）

- [ ] **Step 3: 实现**

```ts
// module.ts 追加/修改
import type { NotificationEventDecl } from './manifest'

export interface NotifyEmitInput {
  eventKey: string
  eventId: string
  scope?: string
  payload: Record<string, unknown>
}
export interface NotifyPort {
  emit(identity: Identity, input: NotifyEmitInput): Promise<{ accepted: boolean; reason?: string }>
}
export interface EventCatalogReader {
  get(key: string): NotificationEventDecl | undefined
  list(filter?: { moduleId?: string; active?: boolean }): NotificationEventDecl[]
}
export interface ChannelAddressResolver {
  resolve(input: { org: string; provider: string; casdoorName: string }): Promise<string | null>
}

/** 端口集合新增通知入口（宿主装载期取用；不声明 = 取不到）。 */
export interface EnqueueEventInput {
  org: string
  eventId: string
  eventKey: string
  scope: string
  payload: Record<string, unknown>
  producer: string
}
export interface ModulePorts {
  resolvePatKey?(token: string): Promise<ResolvedPatKey | null>
  enqueueEvent?(input: EnqueueEventInput): Promise<{ accepted: boolean; reason?: string }>
}

export interface ModuleContext {
  pool: Pool
  identityLinks?: IdentityLinks
  events?: EventCatalogReader
  notify?: NotifyPort
  addresses?: ChannelAddressResolver
}
```

`index.ts` 导出新类型：

```ts
export type {
  NotificationEventDecl, EventFieldDecl, EventRecipientDecl, EventPayloadType,
} from './manifest'
export type {
  NotifyPort, NotifyEmitInput, EventCatalogReader, ChannelAddressResolver,
  EnqueueEventInput, ModulePorts, ModuleContext,
} from './module'
```

- [ ] **Step 4: 跑测试/类型检查**

Run: `pnpm --filter @platform/sdk typecheck && pnpm --filter @platform/sdk test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/platform-sdk/src/module.ts packages/platform-sdk/src/index.ts packages/platform-sdk/src/module.test.ts
git commit -m "feat(sdk): ModuleContext 通知注入面"
```

---

## Task 3: `platform.event_catalog` + 目录构建

**Files:**
- Create: `apps/server/src/migrations/011_event_catalog.sql`
- Create: `apps/server/src/event-catalog.ts`
- Test: `apps/server/src/event-catalog.test.ts`

**Interfaces:**
- Produces: `buildCatalog(manifests): CatalogEntry[]`、`upsertCatalog(pool, entries, loadedModuleIds)`、`createCatalogReader(entries): EventCatalogReader`

- [ ] **Step 1: 写迁移**

```sql
-- 011_event_catalog.sql — 通知事件目录快照（manifest 是事实源，本表是投影）
create table if not exists platform.event_catalog (
  key             text primary key,
  module_id       text not null,
  title           text not null,
  description     text,
  scope_key       text,
  payload_schema  jsonb not null default '{}'::jsonb,
  recipients      jsonb not null default '{}'::jsonb,
  defaults        jsonb,
  source          text not null check (source in ('module', 'external')),
  active          boolean not null default true,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_event_catalog_module
  on platform.event_catalog (module_id) where active;
```

- [ ] **Step 2: 写失败测试**

```ts
// apps/server/src/event-catalog.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { buildCatalog, upsertCatalog, createCatalogReader } from './event-catalog'
import { runMigrations } from './migrate'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL
const d = url ? describe : describe.skip

d('event-catalog', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => { await pool.end() })

  it('buildCatalog 只取声明的事件', () => {
    const out = buildCatalog([
      { id: 'm1', notifications: { events: [{ key: 'm1.a.b', title: 't', payload: {}, recipients: {} }] } },
      { id: 'm2' },
    ] as never)
    expect(out).toEqual([{ key: 'm1.a.b', moduleId: 'm1', title: 't', description: undefined, scopeKey: undefined, payloadSchema: {}, recipients: {}, defaults: undefined, source: 'module' }])
  })

  it('upsert 幂等 + 已加载模块的旧事件标 inactive', async () => {
    await upsertCatalog(pool, [
      { key: 'm1.a.old', moduleId: 'm1', title: 'old', payloadSchema: {}, recipients: {}, source: 'module' },
      { key: 'm1.a.new', moduleId: 'm1', title: 'new', payloadSchema: {}, recipients: {}, source: 'module' },
    ], ['m1'])
    await upsertCatalog(pool, [
      { key: 'm1.a.new', moduleId: 'm1', title: 'new2', payloadSchema: {}, recipients: {}, source: 'module' },
    ], ['m1'])
    const r = await pool.query(`select key,title,active from platform.event_catalog where module_id='m1' order by key`)
    expect(r.rows).toEqual([
      { key: 'm1.a.new', title: 'new2', active: true },
      { key: 'm1.a.old', title: 'old', active: false },
    ])
    expect(createCatalogReader([{ key: 'm1.a.new', moduleId: 'm1', title: 'new2', payloadSchema: {}, recipients: {}, source: 'module' }]).get('m1.a.new')?.title).toBe('new2')
  })
})
```

- [ ] **Step 3: 实现**

```ts
// apps/server/src/event-catalog.ts
import type { Pool } from 'pg'
import type { EventCatalogReader, ModuleManifest, NotificationEventDecl } from '@platform/sdk'

export interface CatalogEntry {
  key: string
  moduleId: string
  title: string
  description?: string
  scopeKey?: string
  payloadSchema: Record<string, unknown>
  recipients: Record<string, unknown>
  defaults?: unknown
  source: 'module' | 'external'
}

export function buildCatalog(manifests: Pick<ModuleManifest, 'id' | 'notifications'>[]): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const m of manifests) {
    for (const ev of m.notifications?.events ?? []) {
      out.push({
        key: ev.key, moduleId: m.id, title: ev.title, description: ev.description,
        scopeKey: ev.scope?.key, payloadSchema: ev.payload, recipients: ev.recipients,
        defaults: ev.defaults, source: 'module',
      })
    }
  }
  return out
}

export function createCatalogReader(entries: CatalogEntry[]): EventCatalogReader {
  const byKey = new Map<string, NotificationEventDecl>()
  for (const e of entries) {
    byKey.set(e.key, {
      key: e.key, title: e.title, description: e.description,
      scope: e.scopeKey ? { key: e.scopeKey } : undefined,
      payload: e.payloadSchema as NotificationEventDecl['payload'],
      recipients: e.recipients as NotificationEventDecl['recipients'],
      defaults: e.defaults as NotificationEventDecl['defaults'],
    })
  }
  return {
    get: (key) => byKey.get(key),
    list: (filter) => [...byKey.values()].filter((ev) => filter?.moduleId ? ev.key.startsWith(filter.moduleId + '.') : true),
  }
}

export async function upsertCatalog(pool: Pool, entries: CatalogEntry[], loadedModuleIds: string[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const e of entries) {
      await client.query(
        `insert into platform.event_catalog
           (key,module_id,title,description,scope_key,payload_schema,recipients,defaults,source,active,updated_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,true,now())
         on conflict (key) do update set
           module_id=excluded.module_id, title=excluded.title, description=excluded.description,
           scope_key=excluded.scope_key, payload_schema=excluded.payload_schema,
           recipients=excluded.recipients, defaults=excluded.defaults,
           source=excluded.source, active=true, updated_at=now()`,
        [e.key, e.moduleId, e.title, e.description ?? null, e.scopeKey ?? null,
         JSON.stringify(e.payloadSchema), JSON.stringify(e.recipients),
         e.defaults === undefined ? null : JSON.stringify(e.defaults), e.source],
      )
    }
    await client.query(
      `update platform.event_catalog set active=false, updated_at=now()
        where module_id = any($1::text[]) and not (key = any($2::text[]))`,
      [loadedModuleIds, entries.map((e) => e.key)],
    )
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/server test -- event-catalog.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/migrations/011_event_catalog.sql apps/server/src/event-catalog.ts apps/server/src/event-catalog.test.ts
git commit -m "feat(server): 事件目录快照与构建器"
```

---

## Task 4: 宿主 emit 端口（校验 + 包装）

**Files:**
- Create: `packages/platform-sdk/src/events.ts`（`validatePayload` 纯函数，宿主与模块共用）
- Modify: `packages/platform-sdk/src/index.ts`
- Create: `apps/server/src/notify-port.ts`
- Test: `apps/server/src/notify-port.test.ts`

**Interfaces:**
- Consumes: `EventCatalogReader`（Task 3）
- Produces: `buildNotifyPort({ catalog, enqueue }): NotifyPort`；`validatePayload(decl, payload): string | null`（由 SDK 导出）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/notify-port.test.ts
import { describe, it, expect } from 'vitest'
import { buildNotifyPort } from './notify-port'
import type { NotificationEventDecl } from '@platform/sdk'

const decl: NotificationEventDecl = {
  key: 'm.a.b', title: 't',
  payload: { userId: { type: 'user', required: true }, link: { type: 'url', required: true }, n: { type: 'number' } },
  recipients: { approver: { kind: 'field', field: 'userId' } },
}
const catalog = { get: (k: string) => k === 'm.a.b' ? decl : undefined, list: () => [decl] }
const id = { userId: 'u1', orgId: 'org1', displayName: 'u', scopes: [], hasScope: () => true }

it('合法事件入队', async () => {
  const calls: unknown[] = []
  const port = buildNotifyPort({ catalog, enqueue: async (x) => { calls.push(x); return { accepted: true } } })
  const r = await port.emit(id, { eventKey: 'm.a.b', eventId: 'e1', payload: { userId: 'u1', link: 'https://x' } })
  expect(r.accepted).toBe(true)
  expect(calls[0]).toMatchObject({ org: 'org1', eventKey: 'm.a.b', eventId: 'e1', scope: '*', producer: 'm' })
})

it('未声明事件/缺 eventId/缺必填 -> 拒绝且不入队', async () => {
  const port = buildNotifyPort({ catalog, enqueue: async () => ({ accepted: true }) })
  expect((await port.emit(id, { eventKey: 'm.x.y', eventId: 'e', payload: {} })).reason).toBe('event_not_declared')
  expect((await port.emit(id, { eventKey: 'm.a.b', eventId: '', payload: {} })).reason).toBe('event_id_required')
  expect((await port.emit(id, { eventKey: 'm.a.b', eventId: 'e', payload: { userId: 'u1' } })).reason).toBe('payload_invalid')
})

it('org 缺失拒绝', async () => {
  const port = buildNotifyPort({ catalog, enqueue: async () => ({ accepted: true }) })
  expect((await port.emit({ ...id, orgId: '' }, { eventKey: 'm.a.b', eventId: 'e', payload: {} })).reason).toBe('org_required')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/server test -- notify-port.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/platform-sdk/src/events.ts —— 宿主与模块共用的 payload 校验
import type { NotificationEventDecl } from './manifest'

const isType = (t: string, v: unknown): boolean => {
  switch (t) {
    case 'string': case 'date': case 'url': case 'user': return typeof v === 'string' && v.length > 0
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'user_list': return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0)
    default: return false
  }
}

export function validatePayload(decl: NotificationEventDecl, payload: Record<string, unknown>): string | null {
  if (JSON.stringify(payload).length > 16 * 1024) return 'payload_too_large'
  for (const [k, f] of Object.entries(decl.payload)) {
    if (f.required && !(k in payload)) return `payload_missing:${k}`
    if (k in payload && !isType(f.type, payload[k])) return `payload_type:${k}`
  }
  return null
}
```

```ts
// apps/server/src/notify-port.ts
import { validatePayload } from '@platform/sdk'
import type {
  EnqueueEventInput, EventCatalogReader, Identity, NotifyPort,
} from '@platform/sdk'

export function buildNotifyPort(deps: {
  catalog: EventCatalogReader
  enqueue?: (input: EnqueueEventInput) => Promise<{ accepted: boolean; reason?: string }>
}): NotifyPort {
  return {
    async emit(identity: Identity, input) {
      if (!identity?.orgId) return { accepted: false, reason: 'org_required' }
      const decl = deps.catalog.get(input.eventKey)
      if (!decl) return { accepted: false, reason: 'event_not_declared' }
      if (!input.eventId || input.eventId.trim() === '') return { accepted: false, reason: 'event_id_required' }
      if (!decl.scope && input.scope && input.scope !== '*') return { accepted: false, reason: 'scope_not_declared' }
      const bad = validatePayload(decl, input.payload)
      if (bad) return { accepted: false, reason: bad }
      if (!deps.enqueue) return { accepted: false, reason: 'notify_not_loaded' }
      return deps.enqueue({
        org: identity.orgId, eventId: input.eventId, eventKey: input.eventKey,
        scope: input.scope ?? '*', payload: input.payload,
        // 事件 key 的第一段 = manifest.id（Task 1 的 schema 强约束），故可作为 producer。
        producer: decl.key.slice(0, decl.key.indexOf('.')),
      })
    },
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @platform/server test -- notify-port.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/platform-sdk/src/events.ts packages/platform-sdk/src/index.ts apps/server/src/notify-port.ts apps/server/src/notify-port.test.ts
git commit -m "feat(server): 宿主通知 emit 端口"
```

---

## Task 5: 渠道地址解析

**Files:**
- Create: `apps/server/src/channel-address.ts`
- Test: `apps/server/src/channel-address.test.ts`

**Interfaces:**
- Produces: `createChannelAddressResolver({ pool }): ChannelAddressResolver`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/channel-address.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { createChannelAddressResolver } from './channel-address'
import { runMigrations } from './migrate'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL
const d = url ? describe : describe.skip

d('channel-address', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => { await pool.end() })

  it('wecom 走 identity_link；无绑定/null；in_app 用 Casdoor 名', async () => {
    await pool.query(`delete from platform.identity_link where org='org-ca'`)
    await pool.query(`insert into platform.identity_link(org,provider,external_id,casdoor_name,status,bound_via)
      values ('org-ca','wecom','wecom-u1','u1','active','manual')`)
    const r = createChannelAddressResolver({ pool })
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u1' })).toBe('wecom-u1')
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u2' })).toBeNull()
    expect(await r.resolve({ org: 'org-other', provider: 'wecom_chat', casdoorName: 'u1' })).toBeNull()
    expect(await r.resolve({ org: 'org-ca', provider: 'in_app', casdoorName: 'u1' })).toBe('u1')
  })
})
```

- [ ] **Step 2: 实现**

```ts
// apps/server/src/channel-address.ts
import type { Pool } from 'pg'
import type { ChannelAddressResolver } from '@platform/sdk'

export function createChannelAddressResolver(deps: { pool: Pool }): ChannelAddressResolver {
  return {
    async resolve({ org, provider, casdoorName }) {
      if (provider === 'in_app') return casdoorName
      if (provider === 'wecom_chat') {
        const { rows } = await deps.pool.query<{ external_id: string }>(
          `select external_id from platform.identity_link
            where org=$1 and provider='wecom' and casdoor_name=$2 and status='active'
            order by id desc limit 1`, [org, casdoorName])
        return rows[0]?.external_id ?? null
      }
      return null
    },
  }
}
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/server test -- channel-address.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/channel-address.ts apps/server/src/channel-address.test.ts
git commit -m "feat(server): 渠道地址解析"
```

---

## Task 6: 装载器三阶段 + 注入

**Files:**
- Modify: `apps/server/src/loader.ts:293-390`
- Test: `apps/server/src/loader.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4/5
- Produces: `ModuleContext.notify/events/addresses` 对所有模块可用；`runtime.port('notify','enqueueEvent')` 仍可用

- [ ] **Step 1: 写失败测试**

复用 `loader.test.ts` 现有的 `newModulesDir` / `writeModule` / `manifestYaml` / `injectIdentity` 脚手架：

```ts
it('注入 ctx.notify，并把事件写进 platform.event_catalog', async () => {
  const modulesDir = await newModulesDir()
  await writeModule(modulesDir, 'prodmod', {
    'manifest.yaml': [
      'id: prodmod',
      'name: 生产者',
      'version: 1.0.0',
      "platform: '>=0.1.0'",
      'permissions: [{ code: prodmod:view, name: view }]',
      'api: { internal: [{ method: GET, path: /ping, scope: prodmod:view }] }',
      'notifications:',
      '  events:',
      '    - key: prodmod.a.b',
      '      title: t',
      '      payload: { u: { type: user, required: true } }',
      '      recipients: { r: { kind: field, field: u } }',
    ].join('\n'),
    'index.ts': [
      "import { Hono } from 'hono'",
      "import { defineModule } from '@platform/sdk'",
      'export default defineModule({',
      "  manifest: { id: 'prodmod', name: 'p', version: '1.0.0', platform: '>=0.1.0',",
      "    permissions: [{ code: 'prodmod:view', name: 'v' }],",
      "    api: { internal: [{ method: 'GET', path: '/ping', scope: 'prodmod:view' }] } },",
      '  createRouter: (ctx) => {',
      '    const app = new Hono()',
      "    app.get('/ping', async (c) => c.json(await ctx.notify!.emit(c.get('identity'), {",
      "      eventKey: 'prodmod.a.b', eventId: 'e1', payload: { u: 'u1' },",
      '    })))',
      '    return app',
      '  },',
      '})',
    ].join('\n'),
  })
  await writeModule(modulesDir, 'notify', {
    'manifest.yaml': manifestYaml('notify', ''),
    'index.ts': [
      "import { Hono } from 'hono'",
      "import { defineModule } from '@platform/sdk'",
      'export default defineModule({',
      "  manifest: { id: 'notify', name: 'n', version: '1.0.0', platform: '>=0.1.0',",
      "    permissions: [{ code: 'notify:view', name: 'v' }],",
      "    api: { internal: [{ method: 'GET', path: '/ping', scope: 'notify:view' }] } },",
      '  createPorts: () => ({ enqueueEvent: async () => ({ accepted: true }) }),',
      '  createRouter: () => new Hono(),',
      '})',
    ].join('\n'),
  })

  const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
  const app = new Hono<TestEnv>()
  app.use('*', injectIdentity(['prodmod:view']))
  runtime.mount(app)

  const res = await app.request('/api/modules/prodmod/ping')
  expect(await res.json()).toEqual({ accepted: true })

  const cat = await pool.query(
    "select key, module_id from platform.event_catalog where key = 'prodmod.a.b'",
  )
  expect(cat.rows[0]).toEqual({ key: 'prodmod.a.b', module_id: 'prodmod' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/server test -- loader.test.ts`
Expected: FAIL（`ctx.notify` undefined）

- [ ] **Step 3: 重构**

把现有 `for (const entry of entries)` 循环体抽成：

> 基础设施模块 id 固定为 `notify`（`const NOTIFY_MODULE_ID = 'notify'`）；loader 只从它取
> `enqueueEvent` port。改名 = 破坏性变更（与「三同纪律」同性质）。

```ts
interface PendingModule { dir: string; manifest: ModuleManifest; def: ModuleDefinition }

async function loadOne(dir: string): Promise<PendingModule> {
  // 原 ①–④ 逻辑：read+YAML+校验 → 迁移 → import → 校验 def
}
```

`loadModules` 尾部改为：

```ts
const pending: PendingModule[] = []
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  pending.push(await loadOne(path.resolve(modulesDir, entry.name)))
}

const catalogEntries = buildCatalog(pending.map((p) => p.manifest))
await upsertCatalog(deps.pool, catalogEntries, pending.map((p) => p.manifest.id))
const events = createCatalogReader(catalogEntries)
const addresses = deps.channelAddressResolver ?? createChannelAddressResolver({ pool: deps.pool })

const baseCtx: ModuleContext = { pool: deps.pool, identityLinks, events, addresses }
for (const p of pending) {
  if (typeof p.def.createPorts === 'function') {
    portsByModule.set(p.manifest.id, p.def.createPorts(baseCtx))
  }
}
const notify = buildNotifyPort({
  catalog: events,
  enqueue: portsByModule.get(NOTIFY_MODULE_ID)?.enqueueEvent,
})
const ctx: ModuleContext = { ...baseCtx, notify }
for (const p of pending) {
  loaded.push({
    manifest: p.manifest,
    dir: p.dir,
    router: applyDeclaredApiGate(p.def.createRouter(ctx), p.manifest),
  })
}
```

`LoadModulesDeps` 增加可选 `channelAddressResolver`；`app.ts` 不需要改（loader 默认构造）。

> 注意：`createPorts` 的签名当前是 `(ctx: ModuleContext) => ModulePorts`，现在会收到完整 ctx；既有 `data` 模块只用 `pool`，向后兼容。

- [ ] **Step 4: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/server test -- loader.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts
git commit -m "feat(server): 装载器三阶段与通知注入"
```

---

## Task 7: notify 新数据模型（迁移 002）

**Files:**
- Create: `modules/notify/migrations/002_notify_v2.sql`
- Modify: `modules/notify/migrations.test.ts`

**Interfaces:**
- Produces: `notify.rule_v2/template/template_revision/channel/event/delivery_v2/delivery_attempt/inbox`

> **expand/contract（2026-10-27 人拍板）**：Task 15 之前**保留**旧 `notify.rule` / `notify.delivery`，
> 新表用 `rule_v2` / `delivery_v2`，旧代码/旧测试保持绿。Task 8–14 的新代码里凡是
> `notify.rule` / `notify.delivery` **一律写 `_v2` 版本**；Task 15 做 contract（drop 旧表 + rename）。
> 本计划后续代码片段为了可读性写的是**最终名**，执行时按这条规则加 `_v2`。

- [ ] **Step 1: 写迁移**

```sql
-- 002_notify_v2.sql — 通知基础设施 v2（pre-production：旧 rule/delivery 可丢弃重建）
create schema if not exists notify;

drop table if exists notify.rule;
drop table if exists notify.delivery;

create table if not exists notify.rule (
  org                  text not null,
  id                   text not null,
  enabled              boolean not null default true,
  event_key            text not null,
  scope                text not null default '*',
  recipient_key        text not null,
  recipient_literal    text[],
  template_key         text not null,
  channels             text[] not null default '{}',
  cooldown_minutes     int,
  origin               text not null check (origin in ('derived','manual')),
  created_by           text not null,
  created_at           timestamptz not null default now(),
  primary key (org, id)
);
create index if not exists idx_notify_rule_match on notify.rule(org,event_key,scope) where enabled;

create table if not exists notify.template (
  org                 text not null,
  key                 text not null,
  name                text not null,
  event_key           text not null,
  status              text not null default 'draft' check (status in ('draft','published','archived')),
  origin              text not null check (origin in ('builtin','tenant')),
  published_revision  int,
  created_by          text not null,
  updated_at          timestamptz not null default now(),
  primary key (org, key)
);

create table if not exists notify.template_revision (
  org            text not null,
  key            text not null,
  revision       int not null,
  contents       jsonb not null,
  body_hash      text not null,
  review_status  text not null default 'draft' check (review_status in ('draft','approved','rejected')),
  created_by     text not null,
  created_at     timestamptz not null default now(),
  approved_by    text,
  approved_at    timestamptz,
  primary key (org, key, revision)
);
create unique index if not exists uq_notify_template_revision_hash on notify.template_revision(org,key,body_hash);

create table if not exists notify.channel (
  org          text not null,
  id           text not null,
  provider     text not null check (provider in ('wecom_chat','in_app','webhook')),
  enabled      boolean not null default true,
  config       jsonb not null default '{}'::jsonb,
  secret_refs  jsonb not null default '{}'::jsonb,
  health       text,
  health_at    timestamptz,
  created_by   text not null,
  updated_at   timestamptz not null default now(),
  primary key (org, id)
);

create table if not exists notify.event (
  org          text not null,
  event_id     text not null,
  event_key    text not null,
  scope        text not null default '*',
  payload      jsonb not null,
  producer     text not null,
  status       text not null default 'new' check (status in ('new','matched','no_rules','invalid')),
  locked_until timestamptz,
  processed_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (org, event_id)
);
create index if not exists idx_notify_event_new on notify.event(org,created_at) where status='new';

create table if not exists notify.delivery (
  org            text not null,
  event_id       text not null,
  rule_id        text not null,
  recipient      text not null,
  channel        text not null,
  address        text not null,          -- 渠道地址（企微 userid / in-app 用 Casdoor 名）
  template_key   text not null,
  revision       int not null,
  rendered       jsonb not null,
  status         text not null default 'pending'
                 check (status in ('pending','sent','failed','dead','suppressed')),
  attempts       int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until   timestamptz,
  last_error     text,
  is_test        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (org, event_id, rule_id, recipient, channel)
);
create index if not exists idx_notify_delivery_due on notify.delivery(next_attempt_at)
  where status in ('pending','failed');

create table if not exists notify.delivery_attempt (
  id            bigserial primary key,
  org           text not null,
  -- delivery_key = '<event_id>|<rule_id>|<recipient>|<channel>'（与 delivery 联合主键同构）
  delivery_key  text not null,
  attempt_no    int not null,
  provider      text not null,
  status        text not null,
  http_status   int,
  error_code    text,
  error_summary text,
  duration_ms   int,
  created_at    timestamptz not null default now()
);
create index if not exists idx_notify_attempt_delivery on notify.delivery_attempt(org,delivery_key,attempt_no);

create table if not exists notify.inbox (
  org          text not null,
  id           text not null,
  recipient    text not null,
  event_id     text not null,
  event_key    text not null,
  template_key text not null,
  revision     int not null,
  title        text not null,
  body         text not null,
  link         text,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  primary key (org, id),
  unique (org, event_id, recipient)
);

-- worker 心跳：健康 job 用它判断「worker 还在跑」
create table if not exists notify.worker_heartbeat (
  id       text primary key,
  beat_at  timestamptz not null default now()
);
```

- [ ] **Step 2: 更新迁移测试**

```ts
it('v2 表齐全且 org NOT NULL', async () => {
  const r = await pool.query(
    `select table_name, is_nullable from information_schema.columns
      where table_schema='notify' and column_name='org' order by table_name`)
  expect(r.rows.map((x) => x.table_name)).toEqual([
    'channel','delivery','delivery_attempt','event','inbox','rule','template','template_revision',
  ])
  expect(r.rows.every((x) => x.is_nullable === 'NO')).toBe(true)
  // worker_heartbeat 是平台级（无 org），单独断言存在
  const hb = await pool.query("select to_regclass('notify.worker_heartbeat') as t")
  expect(hb.rows[0].t).not.toBeNull()
})
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/notify test -- migrations.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/migrations/002_notify_v2.sql modules/notify/migrations.test.ts
git commit -m "feat(notify): v2 数据模型迁移"
```

---

## Task 8: 渲染 + 规则纯函数

**Files:**
- Create: `modules/notify/domain/render.ts`
- Rewrite: `modules/notify/domain/rules.ts`
- Create: `modules/notify/domain/recipients.ts`
- Create: `modules/notify/domain/org-env.ts`
- Test: `modules/notify/domain/render.test.ts`、`rules.test.ts`、`recipients.test.ts`、`org-env.test.ts`

**Interfaces:**
- Produces:
  - `renderContents(contents, payload, channels): { ok: true; rendered: Rendered } | { ok: false; issues: string[] }`
  - `matchRules(rules, event): NotificationRule[]`
  - `validateRule(rule, decl, channels): string | null`
  - `resolveRecipientNames(rule, decl, payload): string[]`

- [ ] **Step 1: 安装 Handlebars**

Run: `pnpm --filter @platform/notify add handlebars@^4.7.8`

- [ ] **Step 2: 写失败测试**

```ts
// render.test.ts
import { describe, it, expect } from 'vitest'
import { renderContents } from './render'

const contents = {
  wecom_chat: { text: '【待审批】{{title}}\n👉 [去审批]({{link}})' },
  in_app: { title: '{{title}}', body: '申请人：{{applicant}}', link: '{{link}}' },
}

it('按通道渲染', () => {
  const r = renderContents(contents, { title: 'T', link: 'https://x', applicant: '张三' }, ['wecom_chat', 'in_app'])
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.rendered.wecom_chat.text).toBe('【待审批】T\n👉 [去审批](https://x)')
    expect(r.rendered.in_app.title).toBe('T')
  }
})

it('未知变量 => 渲染错误', () => {
  const r = renderContents(contents, { title: 'T' }, ['wecom_chat'])
  expect(r.ok).toBe(false)
})

it('超长企微文案 => 错误', () => {
  const r = renderContents({ wecom_chat: { text: 'x'.repeat(4000) } }, {}, ['wecom_chat'])
  expect(r.ok).toBe(false)
})
```

```ts
// rules.test.ts
import { describe, it, expect } from 'vitest'
import { matchRules, validateRule } from './rules'
import type { NotificationEventDecl } from '@platform/sdk'

const decl: NotificationEventDecl = {
  key: 'm.a.b', title: 't', scope: { key: 'id' },
  payload: { id: { type: 'string' }, u: { type: 'user' } },
  recipients: { approver: { kind: 'field', field: 'u' }, managers: { kind: 'scope_holders', scope: 'm:manage' } },
}
const r = (over: object) => ({ org: 'o', id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*',
  recipientKey: 'approver', recipientLiteral: null, templateKey: 't1', channels: ['c1'],
  cooldownMinutes: null, origin: 'manual', createdAt: '2026-01-01', ...over }) as never

it('精确 scope 优先于 *；manual 覆盖 derived', () => {
  const out = matchRules([r({ id: 'a', scope: '*', origin: 'manual' }), r({ id: 'b', scope: 's1', origin: 'derived' })], { eventKey: 'm.a.b', scope: 's1' })
  expect(out.map((x) => x.id)).toEqual(['b'])
  const out2 = matchRules([r({ id: 'a', scope: 's1', origin: 'derived' }), r({ id: 'b', scope: 's1', origin: 'manual' })], { eventKey: 'm.a.b', scope: 's1' })
  expect(out2.map((x) => x.id)).toEqual(['b'])
})

it('validateRule：模板/通道/收件人/scope', () => {
  const base = { eventKey: 'm.a.b', scope: '*', recipientKey: 'approver', recipientLiteral: null, templateKey: 't1', channels: ['c1'], origin: 'manual' as const }
  expect(validateRule(base, decl, new Set(['c1']), new Set(['t1']))).toBeNull()
  expect(validateRule({ ...base, recipientKey: 'nope' }, decl, new Set(['c1']), new Set(['t1']))).toBe('RULE_RECIPIENT_UNKNOWN')
  expect(validateRule({ ...base, scope: 'x' }, decl, new Set(['c1']), new Set(['t1']))).toBe('RULE_SCOPE_UNKNOWN')
  expect(validateRule({ ...base, channels: ['nope'] }, decl, new Set(['c1']), new Set(['t1']))).toBe('RULE_CHANNEL_UNKNOWN')
  expect(validateRule({ ...base, templateKey: 'nope' }, decl, new Set(['c1']), new Set(['t1']))).toBe('RULE_TEMPLATE_UNKNOWN')
})
```

```ts
// recipients.test.ts
import { describe, it, expect } from 'vitest'
import { resolveRecipientNames } from './recipients'
import type { NotificationEventDecl } from '@platform/sdk'

const decl = { key: 'm.a.b', title: 't', payload: { u: { type: 'user' }, us: { type: 'user_list' } },
  recipients: { one: { kind: 'field', field: 'u' }, many: { kind: 'field', field: 'us' }, mgrs: { kind: 'scope_holders', scope: 'x' }, lit: { kind: 'literal' } } } as NotificationEventDecl

it('field / user_list / literal', () => {
  expect(resolveRecipientNames({ recipientKey: 'one', recipientLiteral: null } as never, decl, { u: 'a' })).toEqual(['a'])
  expect(resolveRecipientNames({ recipientKey: 'many', recipientLiteral: null } as never, decl, { us: ['a','b'] })).toEqual(['a','b'])
  expect(resolveRecipientNames({ recipientKey: 'lit', recipientLiteral: ['c'] } as never, decl, {})).toEqual(['c'])
})
it('scope_holders 不在纯函数层解析', () => {
  expect(resolveRecipientNames({ recipientKey: 'mgrs', recipientLiteral: null } as never, decl, {})).toEqual([])
})
```

- [ ] **Step 3: 实现**

```ts
// domain/render.ts
import Handlebars from 'handlebars'

export type Rendered = Record<string, Record<string, string>>
export type Contents = Record<string, Record<string, string>>

const MAX_BYTES: Record<string, number> = { wecom_chat: 3800 }

export function renderContents(contents: Contents, payload: Record<string, unknown>, channels: string[]) {
  const rendered: Rendered = {}
  const issues: string[] = []
  for (const ch of channels) {
    const src = contents[ch]
    if (!src) { issues.push(`missing_channel:${ch}`); continue }
    rendered[ch] = {}
    for (const [field, tpl] of Object.entries(src)) {
      try {
        const text = Handlebars.compile(tpl, { strict: true, noEscape: true })(payload)
        if (ch === 'wecom_chat' && Buffer.byteLength(text) > (MAX_BYTES.wecom_chat ?? 3800)) {
          issues.push(`too_long:${ch}.${field}`); continue
        }
        rendered[ch][field] = text
      } catch (e) {
        issues.push(`render:${ch}.${field}:${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return issues.length > 0 ? { ok: false as const, issues } : { ok: true as const, rendered }
}
```

```ts
// domain/rules.ts（重写）
import type { NotificationEventDecl } from '@platform/sdk'

export type RuleOrigin = 'derived' | 'manual'
export interface NotificationRule {
  org: string; id: string; enabled: boolean; eventKey: string; scope: string
  recipientKey: string; recipientLiteral: string[] | null
  templateKey: string; channels: string[]; cooldownMinutes: number | null
  origin: RuleOrigin; createdAt: string
}

export function matchRules(rules: NotificationRule[], event: { eventKey: string; scope: string }): NotificationRule[] {
  const candidates = rules.filter((r) => r.enabled && r.eventKey === event.eventKey)
  const exact = candidates.filter((r) => r.scope === event.scope)
  const pool = exact.length > 0 ? exact : candidates.filter((r) => r.scope === '*')
  const manual = pool.filter((r) => r.origin === 'manual')
  const chosen = manual.length > 0 ? manual : pool
  return [...chosen].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function validateRule(
  rule: Pick<NotificationRule, 'eventKey' | 'scope' | 'recipientKey' | 'recipientLiteral' | 'templateKey' | 'channels' | 'origin'>,
  decl: NotificationEventDecl,
  enabledChannels: Set<string>,
  publishedTemplates: Set<string>,
): string | null {
  if (!rule.recipientLiteral && !decl.recipients[rule.recipientKey]) return 'RULE_RECIPIENT_UNKNOWN'
  if (rule.recipientLiteral && (rule.origin !== 'manual' || decl.recipients[rule.recipientKey]?.kind !== 'literal')) return 'RULE_LITERAL_MANUAL_ONLY'
  if (rule.scope !== '*' && !decl.scope) return 'RULE_SCOPE_UNKNOWN'
  if (rule.channels.some((c) => !enabledChannels.has(c))) return 'RULE_CHANNEL_UNKNOWN'
  if (!publishedTemplates.has(rule.templateKey)) return 'RULE_TEMPLATE_UNKNOWN'
  return null
}
```

```ts
// domain/recipients.ts
import type { NotificationEventDecl } from '@platform/sdk'

export function resolveRecipientNames(
  rule: Pick<{ recipientKey: string; recipientLiteral: string[] | null }, 'recipientKey' | 'recipientLiteral'>,
  decl: NotificationEventDecl,
  payload: Record<string, unknown>,
): string[] {
  const r = decl.recipients[rule.recipientKey]
  if (!r) return []
  if (r.kind === 'literal') return rule.recipientLiteral ?? []
  if (r.kind === 'field' && r.field) {
    const v = payload[r.field]
    if (typeof v === 'string' && v) return [v]
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  return [] // scope_holders 由 worker 注入的解析器处理
}
```

```ts
// domain/org-env.ts —— org → env 变量名（唯一实现；企微桥/bridge、审批人名单都用它）
export function orgEnvKeyFor(prefix: string, org: string): string {
  return `${prefix}__${org.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}
```

```ts
// domain/org-env.test.ts
import { it, expect } from 'vitest'
import { orgEnvKeyFor } from './org-env'
it('大写下划线化，不折叠', () => {
  expect(orgEnvKeyFor('WECOM_BRIDGE_URL', 'mytech')).toBe('WECOM_BRIDGE_URL__MYTECH')
  expect(orgEnvKeyFor('X', 'a-b')).toBe('X__A_B')
  expect(orgEnvKeyFor('X', 'a--b')).toBe('X__A__B')
})
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @platform/notify test -- domain`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/notify/domain modules/notify/package.json pnpm-lock.yaml
git commit -m "feat(notify): 渲染与规则纯函数"
```

> 注：`pnpm-lock.yaml` 因新增 `handlebars` 而变；一并提交。

---

## Task 9: notify 存储层

**Files:**
- Rewrite: `modules/notify/storage.ts`
- Test: `modules/notify/storage.test.ts`

**Interfaces:**
- Produces（全部 `org` 显式入参，SQL `where org=$1`）：
  - `enqueueEvent(pool, input): Promise<{ accepted: boolean; reason?: string }>`
  - `listRules/upsertRule/setRuleEnabled/deleteRule`
  - `listPublishedTemplates/listChannels`
  - `claimEvents(pool, limit)`, `insertDelivery`, `claimDueDeliveries(pool, limit)`
  - `markDeliverySent/Failed/Dead`, `insertAttempt`
  - `insertInbox`, `listInbox`, `markInboxRead`

- [ ] **Step 1: 写失败测试（关键三例）**

```ts
it('enqueueEvent 幂等', async () => {
  const a = await enqueueEvent(pool, { org, eventId: 'e1', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 'm' })
  const b = await enqueueEvent(pool, { org, eventId: 'e1', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 'm' })
  expect(a.accepted).toBe(true)
  expect(b.accepted).toBe(false)
  expect(b.reason).toBe('duplicate')
})

it('claimDueDeliveries 加租约且只领到期行', async () => {
  // 插入两条 pending，一条 next_attempt_at 过去、一条未来
  // 断言只领到过去那条，且 locked_until 非空
})

it('insertInbox 同 (org,event_id,recipient) 只一条', async () => {
  // 两次 insert，count = 1
})
```

- [ ] **Step 2: 实现核心 SQL**

```ts
import type { EnqueueEventInput } from '@platform/sdk'

export async function enqueueEvent(pool: Pool, e: EnqueueEventInput) {
  const r = await pool.query(
    `insert into notify.event(org,event_id,event_key,scope,payload,producer)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     on conflict (org,event_id) do nothing`,
    [e.org, e.eventId, e.eventKey, e.scope, JSON.stringify(e.payload), e.producer],
  )
  return (r.rowCount ?? 0) > 0 ? { accepted: true } : { accepted: false, reason: 'duplicate' }
}

export async function claimDueDeliveries(pool: Pool, limit = 50) {
  const { rows } = await pool.query(
    `with picked as (
       select org,event_id,rule_id,recipient,channel from notify.delivery
        where status in ('pending','failed') and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
        order by next_attempt_at limit $1 for update skip locked
     )
     update notify.delivery d set locked_until = now() + interval '60 seconds', updated_at = now()
       from picked p
      where d.org=p.org and d.event_id=p.event_id and d.rule_id=p.rule_id
        and d.recipient=p.recipient and d.channel=p.channel
     returning d.*`, [limit])
  return rows
}
```

```ts
export async function listRules(pool: Pool, org: string) {
  const { rows } = await pool.query(
    `select org,id,enabled,event_key,scope,recipient_key,recipient_literal,template_key,
            channels,cooldown_minutes,origin,created_at
       from notify.rule where org=$1 order by created_at,id`, [org])
  return rows.map((r) => ({
    org: r.org, id: r.id, enabled: r.enabled, eventKey: r.event_key, scope: r.scope,
    recipientKey: r.recipient_key, recipientLiteral: r.recipient_literal,
    templateKey: r.template_key, channels: r.channels, cooldownMinutes: r.cooldown_minutes,
    origin: r.origin, createdAt: (r.created_at as Date).toISOString(),
  }))
}

export async function upsertRule(pool: Pool, org: string, rule: {
  id: string; enabled: boolean; eventKey: string; scope: string; recipientKey: string
  recipientLiteral: string[] | null; templateKey: string; channels: string[]
  cooldownMinutes: number | null; origin: 'derived'|'manual'
}, actor: string) {
  await pool.query(
    `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,recipient_literal,
       template_key,channels,cooldown_minutes,origin,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (org,id) do update set
       enabled=excluded.enabled, event_key=excluded.event_key, scope=excluded.scope,
       recipient_key=excluded.recipient_key, recipient_literal=excluded.recipient_literal,
       template_key=excluded.template_key, channels=excluded.channels,
       cooldown_minutes=excluded.cooldown_minutes, origin=excluded.origin`,
    [org, rule.id, rule.enabled, rule.eventKey, rule.scope, rule.recipientKey,
     rule.recipientLiteral, rule.templateKey, rule.channels, rule.cooldownMinutes, rule.origin, actor])
}

export async function getPublishedTemplate(pool: Pool, org: string, key: string) {
  const { rows } = await pool.query(
    `select r.revision, r.contents from notify.template t
       join notify.template_revision r
         on r.org=t.org and r.key=t.key and r.revision=t.published_revision
      where t.org=$1 and t.key=$2 and t.status='published'`, [org, key])
  return rows[0] ? { revision: rows[0].revision as number, contents: rows[0].contents as Record<string, Record<string, string>> } : null
}

export async function getChannel(pool: Pool, org: string, id: string) {
  const { rows } = await pool.query(
    `select org,id,provider,enabled,config,secret_refs,health,health_at
       from notify.channel where org=$1 and id=$2`, [org, id])
  return rows[0] ?? null
}

export async function insertDelivery(pool: Pool, d: {
  org: string; eventId: string; ruleId: string; recipient: string; channel: string
  address: string; templateKey: string; revision: number; rendered: unknown
  status: 'pending'|'suppressed'|'dead'; lastError?: string
}) {
  await pool.query(
    `insert into notify.delivery(org,event_id,rule_id,recipient,channel,address,
       template_key,revision,rendered,status,last_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     on conflict (org,event_id,rule_id,recipient,channel) do nothing`,
    [d.org,d.eventId,d.ruleId,d.recipient,d.channel,d.address,d.templateKey,d.revision,
     JSON.stringify(d.rendered),d.status,d.lastError ?? null])
}

export async function isCoolingDown(pool: Pool, org: string, rule: { id: string; cooldownMinutes: number | null },
  recipient: string, now: Date) {
  if (!rule.cooldownMinutes || rule.cooldownMinutes <= 0) return false
  const { rows } = await pool.query(
    `select 1 from notify.delivery
      where org=$1 and rule_id=$2 and recipient=$3 and status='sent'
        and created_at > $4::timestamptz - ($5 || ' minutes')::interval limit 1`,
    [org, rule.id, recipient, now.toISOString(), String(rule.cooldownMinutes)])
  return rows.length > 0
}
```

```ts
const dkey = (d: { eventId: string; ruleId: string; recipient: string; channel: string }) =>
  `${d.eventId}|${d.ruleId}|${d.recipient}|${d.channel}`

export async function insertAttempt(pool: Pool, d: {
  org: string; eventId: string; ruleId: string; recipient: string; channel: string; attempts: number
}, r: { ok: true } | { ok: false; kind: string; code: string; summary: string }) {
  await pool.query(
    `insert into notify.delivery_attempt(org,delivery_key,attempt_no,provider,status,error_code,error_summary)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [d.org, dkey(d), d.attempts + 1, d.channel, r.ok ? 'sent' : 'failed',
     r.ok ? null : r.code, r.ok ? null : r.summary])
}

export async function markDeliverySent(pool: Pool, d: { org: string; eventId: string; ruleId: string; recipient: string; channel: string }) {
  await pool.query(
    `update notify.delivery set status='sent', attempts=attempts+1, locked_until=null,
       updated_at=now() where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org,d.eventId,d.ruleId,d.recipient,d.channel])
}

export async function markDeliveryFailed(pool: Pool, d: {
  org: string; eventId: string; ruleId: string; recipient: string; channel: string
}, msg: string, at: Date) {
  await pool.query(
    `update notify.delivery set status='failed', attempts=attempts+1, locked_until=null,
       next_attempt_at=$6, last_error=$7, updated_at=now()
     where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org,d.eventId,d.ruleId,d.recipient,d.channel,at.toISOString(),msg])
}

export async function markDeliveryDead(pool: Pool, d: {
  org: string; eventId: string; ruleId: string; recipient: string; channel: string
}, msg: string) {
  await pool.query(
    `update notify.delivery set status='dead', attempts=attempts+1, locked_until=null,
       last_error=$6, updated_at=now()
     where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org,d.eventId,d.ruleId,d.recipient,d.channel,msg])
}

export async function claimEvents(pool: Pool, limit = 50) {
  const { rows } = await pool.query(
    `with picked as (
       select org,event_id from notify.event
        where status='new' and (locked_until is null or locked_until < now())
        order by created_at limit $1 for update skip locked
     )
     update notify.event e set locked_until = now() + interval '60 seconds'
       from picked p where e.org=p.org and e.event_id=p.event_id
     returning e.org, e.event_id as "eventId", e.event_key as "eventKey",
               e.scope, e.payload`, [limit])
  return rows
}

export async function markEvent(pool: Pool, ev: { org: string; eventId: string }, status: string) {
  await pool.query(
    `update notify.event set status=$3, processed_at=now(), locked_until=null
      where org=$1 and event_id=$2`,
    [ev.org, ev.eventId, status])
}

export async function setRuleEnabled(pool: Pool, org: string, id: string, enabled: boolean) {
  const r = await pool.query('update notify.rule set enabled=$3 where org=$1 and id=$2', [org, id, enabled])
  return r.rowCount ?? 0
}

export async function deleteRule(pool: Pool, org: string, id: string) {
  const r = await pool.query('delete from notify.rule where org=$1 and id=$2', [org, id])
  return r.rowCount ?? 0
}

export async function listInbox(pool: Pool, org: string, recipient: string, unreadOnly: boolean) {
  const { rows } = await pool.query(
    `select id,event_id,event_key,title,body,link,read_at,created_at from notify.inbox
      where org=$1 and recipient=$2 ${unreadOnly ? 'and read_at is null' : ''}
      order by created_at desc limit 100`, [org, recipient])
  return rows
}

export async function markInboxRead(pool: Pool, org: string, recipient: string, id: string) {
  await pool.query('update notify.inbox set read_at=now() where org=$1 and recipient=$2 and id=$3',
    [org, recipient, id])
}
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/notify test -- storage.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/storage.ts modules/notify/storage.test.ts
git commit -m "feat(notify): v2 存储层"
```

---

## Task 10: notify 端口与端点

**Files:**
- Create: `modules/notify/ports.ts`
- Modify: `modules/notify/index.ts`
- Modify: `modules/notify/routes.ts`
- Modify: `modules/notify/manifest.yaml`
- Test: `modules/notify/routes.test.ts`、`modules/notify/ports.test.ts`

**Interfaces:**
- Produces: `createPorts(ctx): { enqueueEvent }`；端点 `POST /emit`、`GET /rules`、`POST /rules`、`PUT /rules/:id/enabled`、`DELETE /rules/:id`、`GET /deliveries`、`GET /inbox`、`POST /inbox/:id/read`

- [ ] **Step 1: 写端口测试**

```ts
it('enqueueEvent 直达 storage 且幂等', async () => {
  const p = createPorts({ pool })
  expect((await p.enqueueEvent({ org, eventId: 'p1', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 'm' })).accepted).toBe(true)
  expect((await p.enqueueEvent({ org, eventId: 'p1', eventKey: 'm.a.b', scope: '*', payload: {}, producer: 'm' })).accepted).toBe(false)
})
```

- [ ] **Step 2: 实现端口**

```ts
// ports.ts
import type { Pool } from 'pg'
import { enqueueEvent } from './storage'
import type { EnqueueEventInput } from '@platform/sdk'

export function createPorts(ctx: { pool: Pool }) {
  return {
    enqueueEvent: (input: EnqueueEventInput) => enqueueEvent(ctx.pool, input),
  }
}
```

`index.ts`:

```ts
export default defineModule({
  manifest,
  createPorts: ({ pool }) => createPorts({ pool }),
  createRouter: ({ pool, events, addresses }) => createNotifyRouter({ pool, events, addresses }),
})
```

- [ ] **Step 3: 端点**

`routes.ts` 改为：

- **移除** `registerNotifyMcpManage(r, ...)` 调用（`mcp.ts` 在 Task 15 删除；P2 重建工具面）。
- `POST /emit`：外部生产者（PAT `notify:emit`）；body `{eventId,eventKey,scope?,payload}`；校验用注入的 `events` reader + `validatePayload`（`@platform/sdk`）；写 `enqueueEvent`；恒 202。
- `GET /rules` / `POST /rules` / `PUT /rules/:id/enabled` / `DELETE /rules/:id`：改用新列；`POST` 校验 `validateRule`（模板/通道从 DB 取 published/enabled 集合）。
- `GET /deliveries`：查 `notify.delivery`。
- `GET /inbox` / `POST /inbox/:id/read`：`recipient = identity.userId`。

`manifest.yaml` 的 `api.internal` 必须与注册集合逐条一致（装载期双向核对）。更新权限码：

```yaml
permissions:
  - { code: notify:view,    name: 通知查看 }
  - { code: notify:manage,  name: 通知规则管理 }
  - { code: notify:publish, name: 通知文案发布 }
  - { code: notify:channel, name: 通知通道配置 }
  - { code: notify:emit,    name: 事件触发 }
```

- [ ] **Step 4: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/notify test -- routes.test.ts ports.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/notify/ports.ts modules/notify/index.ts modules/notify/routes.ts modules/notify/manifest.yaml modules/notify/routes.test.ts modules/notify/ports.test.ts
git commit -m "feat(notify): 端口与 v2 端点"
```

---

## Task 11: worker 纯编排核心

**Files:**
- Create: `modules/notify/worker.ts`
- Test: `modules/notify/worker.test.ts`

**Interfaces:**
- Produces: `runOnce(deps): Promise<{ events: number; deliveries: number; sent: number; failed: number; dead: number }>`
- `deps` 全部可注入：`claimEvents`、`markEvent`、`listRules`、`getEventDecl`、`getPublishedTemplate`、`getChannel`、`claimDueDeliveries`、`send`、`insertAttempt`、`insertDelivery`、`markDeliverySent`、`markDeliveryFailed`、`markDeliveryDead`、`resolveScopeHolders`、`resolveAddress`、`isCoolingDown`、`now`
- `getEventDecl` 由 **worker 脚本**注入（`scripts/` 可读 `platform.event_catalog`，模块层不读 platform schema——B1）

- [ ] **Step 1: 写失败测试**

```ts
it('事件 -> 规则 -> delivery（含 scope/manual 优先级）', async () => {
  // 注入一个事件、一条规则、一个已发布模板、一个启用通道
  // 断言 insertDelivery 被调用一次，rendered 含 wecom_chat.text
})

it('冷却命中 => suppressed，不发送', async () => { /* ... */ })

it('provider 返回 retryable => failed + next_attempt_at 前移；permanent => dead', async () => { /* ... */ })
```

- [ ] **Step 2: 实现**

```ts
type ProviderResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

type WorkerDeps = {
  now(): Date
  claimEvents(n: number): Promise<{ org: string; eventId: string; eventKey: string; scope: string; payload: Record<string, unknown> }[]>
  markEvent(ev: { org: string; eventId: string }, status: string): Promise<void>
  listRules(org: string): Promise<NotificationRule[]>
  getEventDecl(key: string): Promise<NotificationEventDecl | null>
  getPublishedTemplate(org: string, key: string): Promise<{ contents: Contents; revision: number } | null>
  getChannel(org: string, id: string): Promise<{ provider: string; enabled: boolean; config?: Record<string, unknown> } | null>
  claimDueDeliveries(n: number): Promise<DeliveryRow[]>
  insertDelivery(row: DeliveryRow): Promise<void>
  insertAttempt(d: DeliveryRow & { attempts: number }, r: ProviderResult): Promise<void>
  markDeliverySent(d: DeliveryRow): Promise<void>
  markDeliveryFailed(d: DeliveryRow, msg: string, at: Date): Promise<void>
  markDeliveryDead(d: DeliveryRow, msg: string): Promise<void>
  resolveScopeHolders(org: string, key: string, decl: NotificationEventDecl): Promise<string[]>
  resolveAddress(input: { org: string; provider: string; casdoorName: string }): Promise<string | null>
  isCoolingDown(org: string, rule: NotificationRule, recipient: string, now: Date): Promise<boolean>
  send(d: DeliveryRow & { attempts: number }): Promise<ProviderResult>
}

type DeliveryRow = {
  org: string; eventId: string; ruleId: string; recipient: string; channel: string
  address: string; templateKey: string; revision: number
  rendered: Record<string, string>; status: 'pending' | 'suppressed' | 'dead'; lastError?: string
}

const base = (ev: { org: string; eventId: string }, rule: { id: string; templateKey: string },
  recipient: string, channel: string, revision: number) => ({
  org: ev.org, eventId: ev.eventId, ruleId: rule.id, recipient, channel,
  templateKey: rule.templateKey, revision,
})

export async function runOnce(deps: WorkerDeps) {
  const now = deps.now()
  const events = await deps.claimEvents(50)
  let deliveries = 0

  for (const ev of events) {
    const rules = matchRules(await deps.listRules(ev.org), { eventKey: ev.eventKey, scope: ev.scope })
    if (rules.length === 0) { await deps.markEvent(ev, 'no_rules'); continue }

    const decl = await deps.getEventDecl(ev.eventKey)
    if (!decl) { await deps.markEvent(ev, 'invalid'); continue }

    for (const rule of rules) {
      const tpl = await deps.getPublishedTemplate(ev.org, rule.templateKey)
      if (!tpl) { await deps.markEvent(ev, 'invalid'); continue }

      const names = resolveRecipientNames(rule, decl, ev.payload)
      const holders = rule.recipientLiteral ? [] : await deps.resolveScopeHolders(ev.org, rule.recipientKey, decl)
      const recipients = [...new Set([...names, ...holders])].filter(Boolean)
      if (recipients.length === 0) continue

      const rendered = renderContents(tpl.contents, ev.payload, rule.channels)
      if (!rendered.ok) {
        for (const channel of rule.channels) {
          await deps.insertDelivery({
            ...base(ev, rule, '<render>', channel, tpl.revision),
            address: '', rendered: {}, status: 'dead', lastError: rendered.issues.join('; '),
          })
        }
        continue
      }

      for (const recipient of recipients) {
        for (const channel of rule.channels) {
          const b = base(ev, rule, recipient, channel, tpl.revision)
          const out = rendered.rendered[channel]
          if (!out) continue

          if (await deps.isCoolingDown(ev.org, rule, recipient, now)) {
            await deps.insertDelivery({ ...b, address: '', rendered: out, status: 'suppressed' })
            continue
          }

          const ch = await deps.getChannel(ev.org, channel)
          if (!ch || !ch.enabled) continue

          const resolved = await deps.resolveAddress({ org: ev.org, provider: ch.provider, casdoorName: recipient })
          // 只有显式开了 address_fallback 的租户才允许把 Casdoor 名当企微 userid（fail-closed 默认）
          const address = resolved
            ?? (ch.provider === 'wecom_chat' && ch.config?.address_fallback === 'casdoor_name' ? recipient : null)
          if (!address && ch.provider !== 'in_app') {
            await deps.insertDelivery({ ...b, address: '', rendered: out, status: 'dead', lastError: 'missing_channel_address' })
            continue
          }

          await deps.insertDelivery({ ...b, address: address ?? recipient, rendered: out, status: 'pending' })
          deliveries++
        }
      }
    }
    await deps.markEvent(ev, 'matched')
  }

  const due = await deps.claimDueDeliveries(50)
  let sent = 0, failed = 0, dead = 0
  for (const d of due) {
    const res = await deps.send(d)
    await deps.insertAttempt(d, res)
    if (res.ok) { await deps.markDeliverySent(d); sent++ }
    else if (res.kind === 'permanent' || d.attempts + 1 >= 5) {
      await deps.markDeliveryDead(d, res.summary); dead++
    } else {
      await deps.markDeliveryFailed(d, res.summary, nextAt(d.attempts + 1, deps.now())); failed++
    }
  }
  return { events: events.length, deliveries, sent, failed, dead }
}
```

> `nextAt` 退避：`[30s, 2m, 10m, 30m]`，带 ±20% 抖动。

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @platform/notify test -- worker.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/worker.ts modules/notify/worker.test.ts
git commit -m "feat(notify): worker 编排核心"
```

---

## Task 12: provider（wecom / in_app）

**Files:**
- Create: `modules/notify/providers/wecom.ts`
- Create: `modules/notify/providers/in-app.ts`
- Test: `modules/notify/providers/wecom.test.ts`、`in-app.test.ts`

**Interfaces:**
- Produces: `sendWecom({bridgeUrl, to, content, fetchImpl})`；`sendInApp({pool, org, recipient, ...})`

- [ ] **Step 1: 写失败测试**

```ts
it('204 => ok', async () => {
  const f = async () => new Response(null, { status: 204 })
  expect(await sendWecom({ bridgeUrl: 'https://b/wecom/t?t=x', to: 'u1', content: 'hi', fetchImpl: f })).toEqual({ ok: true })
})
it('502 errcode 45009 => retryable', async () => {
  const f = async () => new Response(JSON.stringify({ errcode: 45009, error: 'limit' }), { status: 502 })
  const r = await sendWecom({ bridgeUrl: 'https://b/wecom/t?t=x', to: 'u1', content: 'hi', fetchImpl: f })
  expect(r).toMatchObject({ ok: false, kind: 'retryable', code: '45009' })
})
it('401 => permanent', async () => {
  const f = async () => new Response('bad token', { status: 401 })
  const r = await sendWecom({ bridgeUrl: 'https://b/wecom/t?t=x', to: 'u1', content: 'hi', fetchImpl: f })
  expect(r).toMatchObject({ ok: false, kind: 'permanent' })
})
it('in_app 写 inbox 且重复调用不新增', async () => {
  const args = { pool, org: 'org-inapp', recipient: 'u1', eventId: 'e1', eventKey: 'm.a.b',
    templateKey: 't1', revision: 1, rendered: { title: 'T', body: 'B', link: 'https://x' } }
  expect(await sendInApp(args)).toEqual({ ok: true })
  expect(await sendInApp(args)).toEqual({ ok: true })
  const { rows } = await pool.query('select count(*)::int n from notify.inbox where org=$1', ['org-inapp'])
  expect(rows[0].n).toBe(1)
})
```

- [ ] **Step 2: 实现**

```ts
// providers/wecom.ts
export async function sendWecom(a: { bridgeUrl: string; to: string; content: string; fetchImpl?: typeof fetch }) {
  const f = a.fetchImpl ?? fetch
  const url = `${a.bridgeUrl}${a.bridgeUrl.includes('?') ? '&' : '?'}to=${encodeURIComponent(a.to)}`
  try {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: a.content }) })
    if (res.status === 204) return { ok: true as const }
    if (res.status === 401 || res.status === 400) return { ok: false as const, kind: 'permanent' as const, code: String(res.status), summary: `bridge HTTP ${res.status}` }
    if (res.status === 429 || res.status >= 500) {
      const body = await res.json().catch(() => ({})) as { errcode?: number; error?: string }
      return { ok: false as const, kind: 'retryable' as const, code: String(body.errcode ?? res.status), summary: body.error ?? `bridge HTTP ${res.status}` }
    }
    return { ok: false as const, kind: 'permanent' as const, code: String(res.status), summary: `bridge HTTP ${res.status}` }
  } catch (e) {
    return { ok: false as const, kind: 'retryable' as const, code: 'network', summary: e instanceof Error ? e.message : String(e) }
  }
}
```

`in-app.ts`：插入 `notify.inbox`（唯一键冲突视为 ok）：

```ts
export async function sendInApp(a: {
  pool: Pool; org: string; recipient: string; eventId: string; eventKey: string
  templateKey: string; revision: number; rendered: { title: string; body: string; link?: string }
}) {
  await a.pool.query(
    `insert into notify.inbox(org,id,recipient,event_id,event_key,template_key,revision,title,body,link)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (org,event_id,recipient) do nothing`,
    [a.org, `${a.eventId}:${a.recipient}`, a.recipient, a.eventId, a.eventKey,
     a.templateKey, a.revision, a.rendered.title, a.rendered.body, a.rendered.link ?? null],
  )
  return { ok: true as const }
}
```

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter @platform/notify test -- providers`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/providers
git commit -m "feat(notify): wecom 与 in-app provider"
```

---

## Task 13: worker 进程、compose、健康 job

**Files:**
- Create: `scripts/notify-worker.mjs`
- Create: `scripts/notify-health.mjs`
- Modify: `deploy/docker-compose.yml`
- Test: `scripts/notify-worker.test.ts`（纯核）、`scripts/notify-health.test.ts`

**Interfaces:**
- Produces: `node scripts/notify-worker.mjs [--once]`；健康检查退出码 0/1/2

- [ ] **Step 1: 写失败测试**

```ts
it('--once 跑一轮并退出 0', async () => { /* 用 DATABASE_URL + 空库 */ })
it('health：有空事件/死信 => 退出 1', async () => { /* ... */ })
```

- [ ] **Step 2: 实现 worker 入口**

```js
#!/usr/bin/env node
// scripts/notify-worker.mjs — 通知投递 worker（独立进程，租约 + SKIP LOCKED）
import { createRequire } from 'node:module'
import { runOnce } from '../modules/notify/worker.ts'
import * as storage from '../modules/notify/storage.ts'
import { sendWecom } from '../modules/notify/providers/wecom.ts'
import { sendInApp } from '../modules/notify/providers/in-app.ts'
import { createChannelAddressResolver } from '../apps/server/src/channel-address.ts'

const url = process.env.DATABASE_URL
if (!url) { console.error('notify-worker: 缺 DATABASE_URL'); process.exit(2) }
const { Pool } = createRequire(import.meta.url)('pg')
const pool = new Pool({ connectionString: url })
const addresses = createChannelAddressResolver({ pool })

/** secret_refs 的逻辑键 → env 值；缺键返回 null（该通道视为未配置，不假装成功） */
function secretsOf(ch) {
  const out = {}
  for (const [k, envKey] of Object.entries(ch.secret_refs ?? {})) {
    const v = process.env[envKey]
    if (!v) return null
    out[k] = v
  }
  return out
}

const deps = {
  now: () => new Date(),
  claimEvents: (n) => storage.claimEvents(pool, n),
  markEvent: (ev, st) => storage.markEvent(pool, ev, st),
  listRules: (org) => storage.listRules(pool, org),
  getEventDecl: async (key) => {
    const { rows } = await pool.query(
      'select payload_schema, recipients, scope_key from platform.event_catalog where key=$1 and active', [key])
    const r = rows[0]
    return r ? { key, title: '', payload: r.payload_schema, recipients: r.recipients,
      scope: r.scope_key ? { key: r.scope_key } : undefined } : null
  },
  getPublishedTemplate: (org, key) => storage.getPublishedTemplate(pool, org, key),
  getChannel: (org, id) => storage.getChannel(pool, org, id),
  claimDueDeliveries: (n) => storage.claimDueDeliveries(pool, n),
  insertDelivery: (row) => storage.insertDelivery(pool, row),
  insertAttempt: (d, r) => storage.insertAttempt(pool, d, r),
  markDeliverySent: (d) => storage.markDeliverySent(pool, d),
  markDeliveryFailed: (d, msg, at) => storage.markDeliveryFailed(pool, d, msg, at),
  markDeliveryDead: (d, msg) => storage.markDeliveryDead(pool, d, msg),
  // v1 待实测：Casdoor scope 持有者枚举不可用 → 返回 []，由 manual literal 规则兜底
  resolveScopeHolders: async () => [],
  resolveAddress: (input) => addresses.resolve(input),
  isCoolingDown: (org, rule, recipient, now) => storage.isCoolingDown(pool, org, rule, recipient, now),
  send: async (d) => {
    const ch = await storage.getChannel(pool, d.org, d.channel)
    if (!ch || !ch.enabled) return { ok: false, kind: 'permanent', code: 'channel_missing', summary: 'channel not found/disabled' }
    const secrets = secretsOf(ch)
    if (!secrets) return { ok: false, kind: 'permanent', code: 'secret_missing', summary: 'secret_refs 指向的 env 未配置' }
    if (ch.provider === 'in_app') return sendInApp({ pool, org: d.org, recipient: d.recipient, rendered: d.rendered })
    if (ch.provider === 'wecom_chat') return sendWecom({ bridgeUrl: secrets.bridge_url, to: d.address, content: d.rendered.text })
    return { ok: false, kind: 'permanent', code: 'provider_unsupported', summary: ch.provider }
  },
}

const once = process.argv.includes('--once')
do {
  const s = await runOnce(deps)
  await pool.query(
    `insert into notify.worker_heartbeat(id,beat_at) values ('notify-worker',now())
     on conflict (id) do update set beat_at=now()`)
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...s }))
  if (once) break
  await new Promise((r) => setTimeout(r, 2000))
} while (true)
await pool.end()
```

- [ ] **Step 3: 健康 job**

```js
// scripts/notify-health.mjs
// 退出码：0 干净；1 有 dead / 最老 pending > 10min / worker 心跳 > 2min；2 查不成账
import { createRequire } from 'node:module'

const url = process.env.DATABASE_URL
if (!url) { console.error('notify-health: 缺 DATABASE_URL'); process.exit(2) }
const { Pool } = createRequire(import.meta.url)('pg')
const pool = new Pool({ connectionString: url })
try {
  const { rows } = await pool.query(`
    select
      (select count(*)::int from notify.delivery where status='dead') as dead,
      (select count(*)::int from notify.delivery
        where status='pending' and created_at < now()-interval '10 minutes') as stale,
      (select count(*)::int from notify.worker_heartbeat
        where beat_at > now()-interval '2 minutes') as workers`)
  const r = rows[0]
  console.log(`notify-health: dead=${r.dead} stale=${r.stale} workers=${r.workers}`)
  process.exit(r.dead > 0 || r.stale > 0 || r.workers === 0 ? 1 : 0)
} catch (e) {
  console.error('notify-health 查不成账:', e instanceof Error ? e.message : e)
  process.exit(2)
} finally {
  await pool.end()
}
```

- [ ] **Step 4: compose 增加服务**

```yaml
  notify-worker:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.server
    env_file:
      - path: ../.env
        required: false
    environment:
      DATABASE_URL: postgres://platform:platform@postgres:5432/platform
    # 运行镜像已含 tsx（node_modules 全量 COPY，未 prune）；与 server 同镜像换 command
    command: ["pnpm", "exec", "tsx", "scripts/notify-worker.mjs"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
```

> 无 `ports`（worker 不对外）；`scripts/check-compose.mjs` 的 B7 规则二对它无端口条目不报（受管服务名单只含 postgres/server）。

- [ ] **Step 5: 跑测试与门禁**

Run: `DATABASE_URL=$DATABASE_URL pnpm exec vitest run scripts/notify-worker.test.ts scripts/notify-health.test.ts`
Run: `pnpm exec tsx scripts/check-compose.mjs`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add scripts/notify-worker.mjs scripts/notify-health.mjs scripts/notify-worker.test.ts scripts/notify-health.test.ts deploy/docker-compose.yml
git commit -m "feat(notify): worker 进程与健康 job"
```

---

## Task 14: aftersales 竖切（事件 + 模板 + 默认规则）

**Files:**
- Modify: `modules/aftersales/manifest.yaml`
- Modify: `modules/aftersales/routes/registration-guest.ts:116-160`
- Modify: `modules/aftersales/routes/context.ts`（`RouteCtx` 加可选 `notify`）
- Modify: `modules/aftersales/index.ts`（把 `ctx.notify` 透传进 RouteCtx）
- Modify: `.env.example`（新增 `PLATFORM_CONSOLE_BASE_URL=`）
- Create: `modules/notify/templates/builtin.ts`
- Create: `scripts/notify-seed-builtin.mjs`
- Test: `modules/aftersales/routes/registration-guest.test.ts`、`scripts/notify-seed-builtin.test.ts`

**Interfaces:**
- Consumes: `ctx.notify.emit`（Task 6）
- Produces: `aftersales.employee_approval.pending` 事件；内置模板 `aftersales_employee_approval_pending`；默认规则

- [ ] **Step 1: manifest 声明**

```yaml
notifications:
  events:
    - key: aftersales.employee_approval.pending
      title: 员工登记待审批
      scope: { key: approvalId, label: 审批单 }
      payload:
        approvalId:    { type: string, required: true, label: 审批单号 }
        approveType:   { type: string, required: true, label: 类型 }
        applicantName: { type: string, label: 申请人 }
        link:          { type: url, required: true, label: 详情链接 }
      recipients:
        approvers:        { kind: scope_holders, scope: aftersales:manage, label: 售后管理员 }
        approvers_manual: { kind: literal, label: 手动指定审批人 }
      defaults:
        recipient: approvers
        template: aftersales_employee_approval_pending
        channels: [wecom_default, inapp_default]
```

- [ ] **Step 2: 路由 emit（失败不影响业务）**

```ts
// registration-guest.ts，在 matchOnApplication 之后、return 之前
if (ctx.notify) {
  await ctx.notify.emit(c.get('identity'), {
    eventKey: 'aftersales.employee_approval.pending',
    eventId: `aftersales.employee_approval:${approvalId}:pending`,
    scope: String(approvalId),
    payload: {
      approvalId: String(approvalId),
      approveType: diff.approveType,
      applicantName: target.name,
      // 审批页是单页列表（无 :id 深链）——链到列表页，审批单号仍在 scope/payload 里
      link: `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/console/aftersales/approvals`,
    },
  })
}
```

> `RouteCtx` 需要新增可选的 `notify?: NotifyPort`，并由 `index.ts` 从 `ctx.notify` 透传；缺省时跳过（旧宿主/单测）。
> `PLATFORM_CONSOLE_BASE_URL` 必须同时加进 `.env.example`（B9 门禁：代码引用的 env 键必须在模板声明）。
> 同批补注释（不写值）：`WECOM_BRIDGE_URL__<ORG>`、`WECOM_ADDRESS_FALLBACK__<ORG>`、`NOTIFY_APPROVERS__<ORG>`。
> 生产由 openship 项目 env 注入（如 `https://platform.shanhaiyiguo.com`）；缺省时 link 是相对路径，企微里不可点——上线前必须配。

- [ ] **Step 3: 内置模板**

```ts
// modules/notify/templates/builtin.ts
export const BUILTIN_TEMPLATES = [{
  key: 'aftersales_employee_approval_pending',
  name: '员工登记待审批',
  eventKey: 'aftersales.employee_approval.pending',
  contents: {
    wecom_chat: { text: '【待审批】员工登记\n申请人：{{applicantName}}\n类型：{{approveType}}\n👉 [去审批]({{link}})' },
    in_app: { title: '员工登记待审批', body: '{{applicantName}} 提交了{{approveType}}申请', link: '{{link}}' },
  },
}]
```

- [ ] **Step 4: seed 脚本**

`scripts/notify-seed-builtin.mjs`：遍历 `platform.tenant` → upsert `notify.template` + revision（body_hash 去重）→ upsert `wecom_default` / `inapp_default` → 依 `defaults` upsert 派生规则（确定性 id `derived:<module>:<eventKey>:*`）。幂等。

```js
#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { BUILTIN_TEMPLATES } from '../modules/notify/templates/builtin.ts'
import { orgEnvKeyFor } from '../modules/notify/domain/org-env.ts'

const url = process.env.DATABASE_URL
if (!url) { console.error('notify-seed-builtin: 缺 DATABASE_URL'); process.exit(2) }
const { Pool } = createRequire(import.meta.url)('pg')
const pool = new Pool({ connectionString: url })
const { rows: tenants } = await pool.query('select casdoor_org from platform.tenant')

for (const { casdoor_org: org } of tenants) {
  // ① 内置模板 + 已发布 revision（body_hash 去重）
  for (const tpl of BUILTIN_TEMPLATES) {
    const hash = createHash('sha256').update(JSON.stringify(tpl.contents)).digest('hex').slice(0, 16)
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,$2,$3,$4,'published','builtin',1,'system')
       on conflict (org,key) do nothing`, [org, tpl.key, tpl.name, tpl.eventKey])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by,approved_by,approved_at)
       values ($1,$2,1,$3::jsonb,$4,'approved','system','system',now())
       on conflict (org,key,body_hash) do nothing`, [org, tpl.key, JSON.stringify(tpl.contents), hash])
  }
  // ② 默认通道（secret_refs 只存 env 名）
  //    只有「Casdoor 名 = 企微 userid」的租户才把 WECOM_ADDRESS_FALLBACK__<ORG> 设成 casdoor_name
  const fallback = process.env[orgEnvKeyFor('WECOM_ADDRESS_FALLBACK', org)] === 'casdoor_name'
    ? 'casdoor_name' : 'none'
  await pool.query(
    `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
     values ($1,'wecom_default','wecom_chat',true,jsonb_build_object('address_fallback',$3),
             jsonb_build_object('bridge_url',$2),'system')
     on conflict (org,id) do nothing`, [org, orgEnvKeyFor('WECOM_BRIDGE_URL', org), fallback])
  await pool.query(
    `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
     values ($1,'inapp_default','in_app',true,'{}'::jsonb,'{}'::jsonb,'system')
     on conflict (org,id) do nothing`, [org])

  // ③ defaults → derived 规则（确定性 id，重复 upsert no-op）
  await pool.query(
    `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
     values ($1,$2,true,'aftersales.employee_approval.pending','*','approvers',
             'aftersales_employee_approval_pending','{wecom_default,inapp_default}','derived','system')
     on conflict (org,id) do update set enabled=true`, 
    [org, 'derived:aftersales:aftersales.employee_approval.pending:*'])

  // ④ literal 兜底（manual 优先于 derived）
  const names = (process.env[orgEnvKeyFor('NOTIFY_APPROVERS', org)] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (names.length > 0) {
    await pool.query(
      `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,recipient_literal,template_key,channels,origin,created_by)
       values ($1,$2,true,'aftersales.employee_approval.pending','*','approvers_manual',$3::text[],
               'aftersales_employee_approval_pending','{wecom_default,inapp_default}','manual','system')
       on conflict (org,id) do update set recipient_literal=excluded.recipient_literal, enabled=true`,
      [org, 'manual:aftersales:employee_approval.pending:*', names])
  }
}
await pool.end()
```

**收件人兜底（P1 必须可跑通）**：若 `NOTIFY_APPROVERS__<ORG>` 已配（逗号分隔的 Casdoor 用户名），
则额外 upsert 一条 **manual** 规则 `manual:aftersales:employee_approval.pending:*`：
`recipient_key='approvers_manual'`、`recipient_literal=names`，其余同 defaults。理由：
`scope_holders` 的 Casdoor 枚举在 P1 尚未实测，literal 是 spec §13.1 已声明的兜底；manual 优先于
derived，故配了就一定有人收到。未配则只建 derived 规则（收件人数可能为 0，回执 `no_rules`/零投递）。

- [ ] **Step 5: 测试**

- route 测试：`ctx.notify` 替身断言 emit 参数（eventKey/eventId/scope/payload）。
- seed 测试：跑两遍，模板/规则数量不变。
- 端到端（Task 16）：用假 provider 验证 event → delivery → sent。

- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/manifest.yaml modules/aftersales/routes/registration-guest.ts modules/aftersales/routes/context.ts modules/aftersales/index.ts .env.example modules/notify/templates/builtin.ts scripts/notify-seed-builtin.mjs
git commit -m "feat(aftersales): 员工审批事件与默认通知"
```

---

## Task 15: 退役旧 Novu 管道 + forms 对账迁移

> P1 必须让全仓编译/测试保持绿：旧 `pipeline.ts` / `novu/` / `derive.ts` / `console/` 与新模型不共存；
> `scripts/notify-reconcile.mjs` 仍 import 旧 `emit`/`novuFromEnv`，必须同批迁移。

**Files:**
- Create: `modules/notify/migrations/003_notify_contract.sql`
- Modify: `modules/notify/migrations.test.ts`（最终只剩 v2 表名）
- Delete: `modules/notify/pipeline.ts`、`pipeline.test.ts`、`domain/derive.ts`、`domain/derive.test.ts`、
  `domain/novu.ts`、`domain/novu.test.ts`、`novu/`（整目录）、`mcp.ts`、`mcp.test.ts`、`console/`（整目录）
- Modify: `modules/notify/manifest.yaml`（去掉 `frontend.console`；权限码补齐）
- Regenerate: `apps/web/src/console-registry.gen.ts`（`node scripts/gen-console-registry.mjs`）
- Modify: `scripts/notify-reconcile.mjs`、`scripts/notify-reconcile.test.ts`
- Modify: `modules/forms/manifest.yaml`（声明两个事件）
- Modify: `deploy/notify-reconcile-job.md`（退出码语义）

- [ ] **Step 0: contract（drop 旧表 + rename `_v2`，新迁移 `003_notify_contract.sql`）**

```sql
-- 幂等：只在旧表存在时 drop，只在 _v2 存在且最终名不存在时 rename
do $$
begin
  if to_regclass('notify.rule') is not null then drop table notify.rule; end if;
  if to_regclass('notify.delivery') is not null then drop table notify.delivery; end if;
  if to_regclass('notify.rule_v2') is not null and to_regclass('notify.rule') is null then
    alter table notify.rule_v2 rename to rule;
  end if;
  if to_regclass('notify.delivery_v2') is not null and to_regclass('notify.delivery') is null then
    alter table notify.delivery_v2 rename to delivery;
  end if;
  if to_regclass('notify.idx_notify_rule_v2_match') is not null then
    alter index notify.idx_notify_rule_v2_match rename to idx_notify_rule_match;
  end if;
  if to_regclass('notify.idx_notify_delivery_v2_due') is not null then
    alter index notify.idx_notify_delivery_v2_due rename to idx_notify_delivery_due;
  end if;
end $$;
```

然后全仓把新代码 / seed / worker 里的 `notify.rule_v2` / `notify.delivery_v2` 改回最终名
（`rg 'rule_v2|delivery_v2'` 应为零；测试里的迁移断言同步改）。

- [ ] **Step 1: 删除旧文件并重生成 console registry**

```bash
rm -rf modules/notify/novu modules/notify/console
rm -f modules/notify/pipeline.ts modules/notify/pipeline.test.ts \
      modules/notify/domain/derive.ts modules/notify/domain/derive.test.ts \
      modules/notify/domain/novu.ts modules/notify/domain/novu.test.ts \
      modules/notify/mcp.ts modules/notify/mcp.test.ts
node scripts/gen-console-registry.mjs
```

> P2 会重建 console（事件/规则/模板/通道/投递/收件箱五区）；P1 先摘掉入口，避免半成品 UI。

- [ ] **Step 2: forms 声明事件**

```yaml
# modules/forms/manifest.yaml 追加
notifications:
  events:
    - key: forms.form.assigned
      title: 表单指派
      scope: { key: assetId }
      payload:
        assetId:  { type: string, required: true }
        assignee: { type: user, required: true }
        link:     { type: url, required: true }
      recipients:
        assignee: { kind: field, field: assignee }
    - key: forms.form.due_reminder
      title: 表单催办
      scope: { key: assetId }
      payload:
        assetId:  { type: string, required: true }
        assignee: { type: user, required: true }
        link:     { type: url, required: true }
      recipients:
        assignee: { kind: field, field: assignee }
```

- [ ] **Step 3: 对账脚本改写入队**

```js
// scripts/notify-reconcile.mjs（关键 diff）
import { enqueueEvent } from '../modules/notify/storage.ts'
// 删除：
//   - novuFromEnv / emit / NovuResolver 的 import 与 novuResolverFromEnv
//   - deriveFormAssignedRule / deriveReminderRule / upsertRule 的 import 与派生段
//     （规则已由 scripts/notify-seed-builtin.mjs 幂等 seed；本 job 只负责入队）

const r = await enqueueEvent(pool, {
  org: t.org,
  eventId: `form:${t.assetId}:${t.version}:assigned:${user}`,
  eventKey: 'forms.form.assigned',
  scope: t.assetId,
  payload: { assetId: t.assetId, assignee: user, link: `${base}/console/forms/${t.assetId}` },
  producer: 'forms',
})
emitted += r.accepted ? 1 : 0
```

催办同理（`eventKey: 'forms.form.due_reminder'`，`eventId` 含日期）。

- [ ] **Step 4: 退出码语义**

`failed` 不再是本进程能观测的量（投递已异步）。返回 `{ targets, derived, emitted, duplicates }`；
退出码：0 = 全部入队成功；1 = 有入队失败/异常；2 = 缺 `DATABASE_URL`。更新
`deploy/notify-reconcile-job.md`：投递失败由 `notify-health` job 负责红，别在本 job 里假装能看见。

- [ ] **Step 5: 全量验证**

```bash
pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -A modules/notify scripts/notify-reconcile.mjs scripts/notify-reconcile.test.ts \
  modules/forms/manifest.yaml apps/web/src/console-registry.gen.ts deploy/notify-reconcile-job.md
git commit -m "refactor(notify): 退役 Novu 管道，forms 对账改入队"
```

---

## Task 16: 文档、全量验证与验收

**Files:**
- Modify: `docs/architecture.md` §2.6
- Modify: `docs/module-protocol.md`
- Modify: `AGENTS.md`（入口指针）
- Modify: `deploy/notify-reconcile-job.md`（workers/Novu 段）

- [ ] **Step 1: 正典更新**

- §2.6 改写为「通知基础设施（绑定 + 模板 + 通道 + 投递）」：Novu 退场、bridge 保留、outbox/worker、事件声明、五元组、地址解析。
- `module-protocol.md` 增加「事件声明」节，指向 `manifest.ts` 与 spec。
- `AGENTS.md` 文档地图增加通知基础设施入口。

- [ ] **Step 2: 全量验证**

```bash
pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-mcp-toolface.mjs
```

Expected: 全绿（需要 `DATABASE_URL` 的 DB 测试在 CI 有库；本地按 README 起 compose pg）。

- [ ] **Step 3: 竖切验收（§13）**

1. 访客提交员工登记 → `notify.event` 一行。
2. 事件目录 UI/agent 可见（P2 前用 SQL 验）。
3. 默认规则命中 `approvers`（或 `approvers_manual`）。
4. 模板预览通过（P2 前用 `renderContents` 单测 + CLI 验）。
5. 租户管理员发布（P2 前 seed 视为已发布）。
6. 审批人企微真机收到；回执 `sent`。
7. 无企微绑定 ⇒ `failed / missing_wecom_userid`。

五条负对照按 spec §13.3 逐条跑。

- [ ] **Step 4: 提交**

```bash
git add docs/architecture.md docs/module-protocol.md AGENTS.md deploy/notify-reconcile-job.md
git commit -m "docs(notify): 正典与模块协议更新"
```

---

## 后续计划（不在本计划内）

- **Plan 2（P2 产品面）**：模板草稿/预览/发布 UI、console 五区、agent 工具面、通道配置与健康。
- **Plan 3（P3 收口）**：webhook provider、限流、OO 告警接线、`NOVU_*` env 与文档残留清理。

## Self-Review（已做）

- 覆盖：spec §3 协议（Task 1/2/3/4/6）、§4 规则与收件人（Task 8/9/11）、§6 通道（Task 12）、§7 投递（Task 9/11/13）、§8 in-app（Task 12）、§13 竖切（Task 14/16）、Novu 退役与 forms 迁移（Task 15）。
- 缺口：§5 模板草稿/发布 UI（P2）、§9 console（P2）、§10 agent 工具面（P2）、§12 OO 告警（P3）——本计划明确不含。
- 类型一致性：`EventCatalogReader` / `NotifyPort` / `ChannelAddressResolver` 在 Task 2 定义，Task 3/4/5/6 使用同一签名；`EnqueueEventInput` 在 Task 2 定义、Task 4/9/10 同名使用。
- 待实测项未写成断言：Casdoor scope 持有者枚举、bridge `to=` 映射、N=500 限流——均在 Task 14/16 前先做探针，不得据以声称可用。
