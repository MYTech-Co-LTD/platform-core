# SaaS 管理域 M1（订阅进 Casdoor + config 改造 + 租户 CLI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 订阅真身从 `platform.tenant_module` 迁到 Casdoor Subscription（一模块一 Plan、按 org 建），config 聚合双源切换 + TTL 缓存，外加租户开通 CLI（spec：`docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md`，PR #40）。

**Architecture:** auth-core 的 CasdoorClient 扩订阅域五方法（真机尖刺三铁律内建：RFC3339 格式化 / delete 一律 body / 写后回读）；loader 的 `enabledForImpl` 加 `PLATFORM_SUBSCRIPTION_SOURCE` 双源分支 + TTL 缓存（纯函数抽 `subscription-source.ts`）；迁移与开通都是「纯核函数 + 薄 CLI」。

**Tech Stack:** TS + hono + pg + vitest（auth-core 用 fetchImpl 假路由器测，loader 用注入 casdoorFactory 桩测，scripts 纯核单测）。

## Global Constraints

- 三铁律（spec §1.2 真机实测）：① startTime/endTime 一律 RFC3339 UTC（客户端内格式化，写错毒化整 org 列表）② delete 类端点一律 JSON body `{owner,name}` ③ 每次写订阅后回读验证。
- 用户名/标识仅字母数字（`_` 被拒）；权限/订阅/plan 名可含 `-`，不可含 `/?:#&%=+;`。
- 订阅读取口径：`plan.startsWith('mod-') && state==='Active' && Date.parse(endTime) >= now`；**容忍外来订阅**（woke org 已有 `sub_6a6def`，非 `mod-` 前缀一律忽略）。
- `enabledFor` 两个消费方（/config 清单闸门 + mount API 闸门）必须同源——只改 `enabledForImpl` 一处。
- 灰度开关默认 `platform`（读旧表）；`casdoor` 需显式 env。测试门禁：`pnpm typecheck && pnpm test`。
- 提交 Conventional Commits，PR 带 `Closes #<issue>`；实施分支 `feat/saas-admin-domain`。

---

### Task 0: 分支 + issue + spec 微修正

- [ ] **Step 1:** `git fetch origin main && git checkout -b feat/saas-admin-domain origin/main`
- [ ] **Step 2:** 建 issue（标题：`SaaS 管理域 M1：订阅进 Casdoor + config 双源改造 + 租户开通 CLI`，正文引用 spec 路径与验收）
- [ ] **Step 3:** spec §2 D2/§4.1 修正一行：`ensureModulePlan` 的 plan **owner=租户 org（按 org 各建一份，随订阅扇出）**，不是平台 org——Casdoor UI 建订阅时 plan picker 按当前 org 查，平台 org 的 plan 运营选不到。提交 `docs(specs): 修正 D2——plan 按租户 org 建（UI picker 可见性）(#<issue>)`

---

### Task 1: CasdoorClient 读路径——类型 + listSubscriptions

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`（追加 describe，用本地 fetchImpl 假路由器，不动 MockCasdoor）

**Interfaces:**
- Produces: `export interface CasdoorSubscription { owner: string; name: string; user: string; plan: string; startTime: string; endTime: string; state: string }`；`listSubscriptions(owner: string): Promise<CasdoorSubscription[]>`

- [ ] **Step 1: 失败测试（追加到 casdoor-client.test.ts 末尾）**

```ts
// ── 订阅域（spec 2026-09-13 SaaS 管理域；真机尖刺三铁律见 casdoor-client.ts 头注）──
describe('CasdoorClient 订阅域（fetchImpl 假路由器）', () => {
  function subRouter(rows: Record<string, unknown[]>, log: { path: string; body?: unknown }[]) {
    return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const u = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined
      log.push({ path: u.replace(/^https?:\/\/[^/]+/, ''), body })
      if (u.includes('/api/login')) return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'set-cookie': 'casdoor_session_id=x' } })
      for (const [frag, data] of Object.entries(rows)) if (u.includes(frag)) return new Response(JSON.stringify({ status: 'ok', data }))
      return new Response(JSON.stringify({ status: 'error', msg: 'no route: ' + u }))
    }
  }
  const mk = (f: typeof fetch) => new CasdoorClient({ origin: 'http://x', clientId: 'c', clientSecret: 's', org: 'acme', adminUser: 'a', adminPwd: 'p', fetchImpl: f as typeof fetch })

  it('listSubscriptions：按 owner 查、透传全部字段、error 抛错', async () => {
    const log: { path: string; body?: unknown }[] = []
    const c = mk(subRouter({ '/api/get-subscriptions?owner=acme': [
      { owner: 'acme', name: 'sub-mod-demo', user: 'acme/tenantsub', plan: 'mod-demo', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z', state: 'Active' },
      { owner: 'acme', name: 'sub_6a6def', user: 'woke-admin', plan: 'plan-pro', state: 'Active' }, // 外来订阅原样透传，过滤是调用方的事
    ] }, log))
    const subs = await c.listSubscriptions('acme')
    expect(subs).toHaveLength(2)
    expect(subs[0]).toMatchObject({ plan: 'mod-demo', state: 'Active' })
    expect(log[log.length - 1].path).toBe('/api/get-subscriptions?owner=acme')
  })
})
```

- [ ] **Step 2:** `pnpm --filter @platform/auth-core test -- casdoor-client` → FAIL（方法不存在）
- [ ] **Step 3: 实现**（casdoor-client.ts，放 upsertPermissions 之后）

```ts
export interface CasdoorSubscription {
  owner: string; name: string; user: string; plan: string
  startTime: string; endTime: string; state: string
}

/** 按 org 列订阅（admin 会话）。真机实测：数据坏行（非 RFC3339 时间）会让此接口整体
 * error——error 一律抛，不静默空表（静默空表=全租户失能，响亮失败才可排障）。 */
async listSubscriptions(owner: string): Promise<CasdoorSubscription[]> {
  const j = await this.#adminJson(`/api/get-subscriptions?owner=${encodeURIComponent(owner)}`)
  if (j.status !== 'ok') throw new Error(`casdoor get-subscriptions: ${j.msg || 'error'}`)
  return Array.isArray(j.data) ? (j.data as CasdoorSubscription[]) : []
}
```

- [ ] **Step 4:** 同命令 → PASS。**Step 5:** `git add -A packages/auth-core && git commit -m "feat(auth-core): Casdoor 客户端订阅域读路径 listSubscriptions (#<issue>)"`

---

### Task 2: CasdoorClient 写路径——ensureOrg / ensureAnchorUser / ensureModulePlan / upsertSubscription

**Files:** 同 Task 1。

**Interfaces:**
- Produces: `ensureOrg(name: string): Promise<void>`；`ensureAnchorUser(org: string): Promise<void>`（锚用户名常量 `tenantsub`）；`ensureModulePlan(org: string, moduleId: string): Promise<void>`（plan 名 `mod-<moduleId>`）；`upsertSubscription(org: string, moduleId: string, opts: { state: 'Active' | 'Terminated'; days?: number }): Promise<void>`（订阅名 `sub-mod-<moduleId>`，RFC3339 内部格式化 + 写后回读）

- [ ] **Step 1: 失败测试（追加进同一 describe——读写路由器 + 一条四联用例）**

```ts
  function rwRouter(get: (frag: string, q: URLSearchParams) => unknown[], post: (frag: string, body: any, q: URLSearchParams) => { status: string; data?: unknown }, log: { path: string; body?: unknown }[]) {
    return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const frag = u.pathname.replace('/api/', '/')
      log.push({ path: frag + u.search, body })
      if (frag === '/login') return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'set-cookie': 'casdoor_session_id=x' } })
      if (init?.method === 'GET') return new Response(JSON.stringify({ status: 'ok', data: get(frag, u.searchParams) }))
      return new Response(JSON.stringify(post(frag, body, u.searchParams)))
    }
  }
  it('写路径四联：org→锚用户→plan→订阅（RFC3339 + body 形状 + 回读）', async () => {
    const orgs: string[] = []
    const users = new Set<string>()
    const plans = new Set<string>()
    const subs = new Map<string, any>()
    const log: { path: string; body?: any }[] = []
    const c = mk(rwRouter(
      (frag, q) => {
        if (frag === '/get-organizations') return orgs.map((name) => ({ name }))
        if (frag === '/get-user') return q.get('id') && users.has(q.get('id')!) ? [{ noop: 1 }] : [null]
        if (frag === '/get-plans') return [...plans].filter((p) => p.startsWith(q.get('owner') + '/')).map((p) => ({ owner: p.split('/')[0], name: p.split('/')[1] }))
        if (frag === '/get-subscription') return subs.has(q.get('id')!) ? [subs.get(q.get('id')!)] : [null]
        if (frag === '/get-subscriptions') return [...subs.values()].filter((s) => s.owner === q.get('owner'))
        return []
      },
      (frag, body) => {
        if (frag === '/add-organization') { orgs.push(body.name); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-user') { users.add(body.owner + '/' + body.name); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-plan') { plans.add(body.owner + '/' + body.name); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-subscription') { subs.set(body.owner + '/' + body.name, body); return { status: 'ok', data: 'Affected' } }
        if (frag === '/update-subscription') { subs.set(body.owner + '/' + body.name, body); return { status: 'ok', data: 'Affected' } }
        if (frag.startsWith('/delete-')) return { status: 'ok', data: 'Affected' }
        return { status: 'error', msg: 'no post route ' + frag }
      },
      log,
    ))
    await c.ensureOrg('neworg'); expect(orgs).toContain('neworg')
    await c.ensureAnchorUser('neworg'); expect(users.has('neworg/tenantsub')).toBe(true)
    await c.ensureAnchorUser('neworg'); // 幂等：不重复 add
    expect(log.filter((l) => l.path === '/add-user').length).toBe(1)
    await c.ensureModulePlan('neworg', 'case-engine'); expect(plans.has('neworg/mod-case-engine')).toBe(true)
    await c.upsertSubscription('neworg', 'case-engine', { state: 'Active', days: 30 })
    const sub = subs.get('neworg/sub-mod-case-engine')!
    expect(sub.state).toBe('Active')
    expect(sub.user).toBe('neworg/tenantsub')
    expect(sub.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/) // RFC3339（铁律①）
    // 退订 = update（body 形状，铁律②——日志里不该出现 delete ?id=）
    await c.upsertSubscription('neworg', 'case-engine', { state: 'Terminated' })
    expect(subs.get('neworg/sub-mod-case-engine').state).toBe('Terminated')
    expect(log.some((l) => l.path?.includes('?id='))).toBe(false)
  })
```

- [ ] **Step 2:** 跑 → FAIL。**Step 3: 实现**（casdoor-client.ts；成员常量 + 四方法，全部走既有 `#adminJson`，add 失败时先查再判幂等竞态——同 upsertPermission 的既有套路）

```ts
/** 订阅锚用户名：仅字母数字（Casdoor 用户名字符集实测拒绝 `_`） */
const ANCHOR_USER = 'tenantsub'
const rfc3339 = (d: Date) => d.toISOString()

/** 建 org（存在即跳过） */
async ensureOrg(name: string): Promise<void> {
  const j = await this.#adminJson(`/api/get-organizations`)
  if (j.status === 'ok' && Array.isArray(j.data) && j.data.some((o) => (o as { name: string }).name === name)) return
  await this.#adminJson('/api/add-organization', { method: 'POST', body: { name, displayName: name, isEnabled: true } })
}

/** 建租户订阅锚用户（禁登、随机密码、幂等）。Casdoor UI 按用户管理订阅——空 user 不可运营（spec D3）。 */
async ensureAnchorUser(org: string): Promise<void> {
  const id = `${org}/${ANCHOR_USER}`
  const j = await this.#adminJson(`/api/get-user?id=${encodeURIComponent(id)}`)
  if (j.status === 'ok' && j.data) return
  await this.#adminJson('/api/add-user', {
    method: 'POST',
    body: { owner: org, name: ANCHOR_USER, displayName: 'Tenant Subscription Anchor', password: crypto.randomUUID() + '!Aa1', email: `${ANCHOR_USER}@subscription.invalid`, isForbidden: true, type: 'normal-user' },
  })
  // 铁律③：写后回读
  const back = await this.#adminJson(`/api/get-user?id=${encodeURIComponent(id)}`)
  if (back.status !== 'ok' || !back.data) throw new Error(`casdoor ensure-anchor-user: 写后回读失败 ${id}`)
}

/** 建模块 plan（owner=租户 org，spec D2 修正版：UI picker 按当前 org 查）。plan 名 mod-<moduleId>，Role 留空。 */
async ensureModulePlan(org: string, moduleId: string): Promise<void> {
  const plan = `mod-${moduleId}`
  const j = await this.#adminJson(`/api/get-plan?id=${encodeURIComponent(`${org}/${plan}`)}`)
  if (j.status === 'ok' && j.data) return
  await this.#adminJson('/api/add-plan', { method: 'POST', body: { owner: org, name: plan, displayName: plan, price: 0, currency: 'CNY', isEnabled: true } })
}

/** 订阅/退订（幂等 upsert；Active 带 days 窗口，RFC3339 内部格式化——铁律①）。 */
async upsertSubscription(org: string, moduleId: string, opts: { state: 'Active' | 'Terminated'; days?: number }): Promise<void> {
  const name = `sub-mod-${moduleId}`
  const id = `${org}/${name}`
  const existing = await this.#adminJson(`/api/get-subscription?id=${encodeURIComponent(id)}`)
  const days = opts.days ?? 3650
  const base = { owner: org, name, displayName: name, user: `${org}/${ANCHOR_USER}`, plan: `mod-${moduleId}` }
  const next = opts.state === 'Active'
    ? { ...base, startTime: rfc3339(new Date()), endTime: rfc3339(new Date(Date.now() + days * 864e5)), state: 'Active' }
    : { ...base, startTime: rfc3339(new Date()), endTime: rfc3339(new Date(Date.now() + days * 864e5)), state: 'Terminated' }
  const path = existing.status === 'ok' && existing.data ? '/api/update-subscription' : '/api/add-subscription'
  await this.#adminJson(path, { method: 'POST', body: next })
  const back = await this.#adminJson(`/api/get-subscription?id=${encodeURIComponent(id)}`)
  if (back.status !== 'ok' || !back.data) throw new Error(`casdoor upsert-subscription: 写后回读失败 ${id}`)
}
```

- [ ] **Step 4:** 跑全包 → PASS。**Step 5:** commit `feat(auth-core): Casdoor 订阅域写路径——org/锚用户/plan/订阅 upsert（三铁律内建）(#<issue>)`

---

### Task 3: enabledFor 双源 + TTL 缓存

**Files:**
- Create: `apps/server/src/subscription-source.ts` + `subscription-source.test.ts`
- Modify: `apps/server/src/loader.ts:311-322`（enabledForImpl 分支）+ `apps/server/src/config.ts`（读两个新 env，校验后下传）

**Interfaces:**
- Consumes: Task 1 的 `listSubscriptions`（经注入的 casdoorFactory）
- Produces: `enabledFromSubscriptions(subs: CasdoorSubscription[], loadedIds: Iterable<string>, now: number): Set<string>`；`class SubscriptionCache { get/org set }`（TTL，构造入参 `{ ttlMs: number; now?: () => number }`）；env `PLATFORM_SUBSCRIPTION_SOURCE ∈ {platform,casdoor}`（默认 platform）、`PLATFORM_SUBSCRIPTION_CACHE_TTL_MS`（默认 60000）

- [ ] **Step 1: 失败测试**（subscription-source.test.ts）

```ts
import { describe, expect, it, vi } from 'vitest'
import { enabledFromSubscriptions, SubscriptionCache } from './subscription-source'
const SUB = (over: Partial<{ plan: string; state: string; endTime: string }>) => ({ owner: 'acme', name: 'n', user: 'u', plan: 'mod-demo', startTime: '2026-01-01T00:00:00Z', endTime: '2999-01-01T00:00:00Z', state: 'Active', ...over })
describe('enabledFromSubscriptions', () => {
  it('只认 mod- 前缀 + Active + 未过期；plan 名去前缀回模块 id；未装载模块不进集合', () => {
    const out = enabledFromSubscriptions(
      [SUB({}), SUB({ plan: 'plan-pro' }), SUB({ state: 'Terminated' }), SUB({ endTime: '2020-01-01T00:00:00Z' }), SUB({ plan: 'mod-ghost' })],
      ['demo', 'case-engine'],
      Date.parse('2026-09-13T00:00:00Z'),
    )
    expect([...out]).toEqual(['demo'])
  })
})
describe('SubscriptionCache', () => {
  it('TTL 内命中不重查，过期后重查', () => {
    let t = 1000
    const cache = new SubscriptionCache({ ttlMs: 5000, now: () => t })
    let calls = 0
    const load = async () => { calls += 1; return new Set(['demo']) }
    expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    t = 4000
    expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    expect(calls).toBe(1) // TTL 内
    t = 7000
    expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    expect(calls).toBe(2) // 过期重查
  })
})
```

- [ ] **Step 2:** 跑 → FAIL → **Step 3: 实现**

```ts
// subscription-source.ts — Casdoor 订阅源的纯逻辑：过滤口径与 TTL 缓存（spec D5）。
// 口径三件套：mod- 前缀 / state=Active / 未过 EndTime；外来订阅（非 mod-）一律忽略。
import type { CasdoorSubscription } from '@platform/auth-core'

export function enabledFromSubscriptions(subs: CasdoorSubscription[], loadedIds: Iterable<string>, now: number): Set<string> {
  const loaded = new Set(loadedIds)
  const out = new Set<string>()
  for (const s of subs) {
    if (!s.plan.startsWith('mod-')) continue
    const id = s.plan.slice(4)
    if (!loaded.has(id)) continue
    if (s.state !== 'Active') continue
    if (!s.endTime || Date.parse(s.endTime) < now) continue
    out.add(id)
  }
  return out
}

export class SubscriptionCache {
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #store = new Map<string, { at: number; value: Promise<Set<string>> }>()
  constructor(opts: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = opts.ttlMs
    this.#now = opts.now ?? Date.now
  }
  get(org: string, load: () => Promise<Set<string>>): Promise<Set<string>> {
    const hit = this.#store.get(org)
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value
    const value = load()
    this.#store.set(org, { at: this.#now(), value })
    return value
  }
}
```

- [ ] **Step 4:** PASS → commit `feat(server): 订阅源纯逻辑——mod-过滤口径 + TTL 缓存 (#<issue>)`

- [ ] **Step 5: loader 接线**（enabledForImpl 改双源；config.ts 加两个 env 校验；loader.test.ts 追加一例——真 PG 场景注入 casdoorFactory 桩）：

loader.ts 关键改法（`enabledForImpl` 处）：

```ts
const subCache = new SubscriptionCache({ ttlMs: config.subscriptionCacheTtlMs })
const enabledForImpl = async (tenantId: number): Promise<Set<string>> => {
  if (deps.subscriptionSource === 'casdoor') {
    const { rows: [t] } = await deps.pool.query<{ casdoor_org: string }>('select casdoor_org from platform.tenant where id = $1', [tenantId])
    if (!t) return new Set()
    return subCache.get(t.casdoor_org, async () => enabledFromSubscriptions(
      await deps.casdoorFor(t.casdoor_org).listSubscriptions(t.casdoor_org),
      loaded.map((m) => m.manifest.id),
      Date.now(),
    ))
  }
  // ……原 tenant_module 路径逐字保留（含「无行=启用默认」语义）
}
```

`LoadModulesDeps` 加 `subscriptionSource: 'platform' | 'casdoor'`；app.ts 构造处从 config 传入。loader.test.ts 追加：

```ts
it('订阅源（casdoor）：Active 未过期 mod- 订阅出清单，退订即剔除', async () => {
  // 复用本文件既有 fixture 建模块的套路（同 enabledFor 现有用例），deps 额外传：
  // subscriptionSource: 'casdoor', casdoorFactory: () => ({ listSubscriptions: async (org) => org === 'acme-org'
  //   ? [{ owner: org, name: 'sub-mod-<fixtureId>', user: 'x', plan: `mod-${fixtureId}`, startTime: '2026-01-01T00:00:00Z', endTime: '2999-01-01T00:00:00Z', state: 'Active' }] : [] }) as any
  // 断言 enabledFor(acmeId) 含 fixtureId；把 state 改 'Terminated' 再断言剔除
})
```

（fixtureId/租户 id 取自本文件现成 enabledFor 用例的局部量——执行者照现有用例的变量名接。）

- [ ] **Step 6:** `pnpm --filter @platform/server test`（有 DATABASE_URL 才跑真 PG，无则跳过——按本文件既有约定）+ `pnpm typecheck` → commit `feat(server): enabledFor 双源切换（PLATFORM_SUBSCRIPTION_SOURCE）+ 订阅缓存接线 (#<issue>)`

---

### Task 4: 迁移脚本（tenant_module → Casdoor 订阅）

**Files:**
- Create: `scripts/migrate-tenant-module-to-subs.mjs` + `scripts/migrate-tenant-module-to-subs.test.ts`（`pnpm test:guard` 会跑 scripts 目录）

**Interfaces:**
- Consumes: Task 2 的 `ensureAnchorUser/ensureModulePlan/upsertSubscription`（经传入的 casdoorFor）
- Produces: `export function planMigration(rows: Array<{ casdoorOrg: string; enabled: string[] }>): Array<{ org: string; moduleId: string; steps: string[] }>`（纯函数）；CLI：`node scripts/migrate-tenant-module-to-subs.mjs [--apply]`（默认 dry-run 打印计划）

- [ ] **Step 1: 失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { planMigration } from './migrate-tenant-module-to-subs.mjs'
describe('planMigration', () => {
  it('每租户每启用模块产出 锚用户→plan→订阅 三步计划', () => {
    const plan = planMigration([{ casdoorOrg: 'acme-org', enabled: ['demo', 'case-engine'] }, { casdoorOrg: 'woke-org', enabled: [] }])
    expect(plan).toEqual([
      { org: 'acme-org', moduleId: 'demo', steps: ['anchor', 'plan', 'subscribe'] },
      { org: 'acme-org', moduleId: 'case-engine', steps: ['anchor', 'plan', 'subscribe'] },
    ])
  })
})
```

- [ ] **Step 2:** FAIL → **Step 3: 实现**（纯核 + 薄 CLI：读 DB 取「每租户有效启用集」（复用无行=启用语义：`loaded ∩ (explicit ?? true)`）→ planMigration → dry-run 打印 / `--apply` 逐条调三方法。CLI 主体 ≤60 行，复用 server 侧 getPool 的连接约定（读 process.env.DATABASE_URL））→ PASS
- [ ] **Step 4:** commit `feat(scripts): tenant_module→Casdoor 订阅迁移脚本（纯核+dry-run 默认）(#<issue>)`

---

### Task 5: 租户开通 CLI

**Files:**
- Create: `scripts/provision-tenant.mjs` + `scripts/provision-tenant.test.ts`

**Interfaces:**
- Consumes: `ensureOrg/ensureAnchorUser/ensureModulePlan/upsertSubscription`（Task 2）+ `provisionModulePermissions`（loader.ts，既有）
- Produces: `export function tenantProvisionSteps(slug: string, opts: { modules?: string[] }): string[]`（纯核：步骤序）；CLI `node scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...`（org 缺省 `<slug>-org`）

- [ ] **Step 1: 失败测试**（tenantProvisionSteps 返回 `['org','tenant-row','anchor','permissions', ...modules.flatMap(m=>['plan:'+m,'subscribe:'+m])]` 两例：带/不带 --module）
- [ ] **Step 2:** FAIL → **Step 3: 实现**（纯核 + CLI：org→platform.tenant/tenant_domain upsert（照 seed.ts 的 insert/on conflict 形状）→锚用户→权限码扇出（直接 import provisionModulePermissions，permissions 从 modules/*/manifest.yaml 现读）→逐模块 plan+订阅）→ PASS
- [ ] **Step 4:** commit `feat(scripts): 租户开通 CLI——org/租户行/权限扇出/锚用户/初始订阅一键 (#<issue>)`

---

### Task 6: 全量门禁 + PR

- [ ] **Step 1:** `pnpm typecheck && pnpm test`（全绿；loader 真 PG 用例按既有 DATABASE_URL 约定）
- [ ] **Step 2:** 验收对照 spec §5：M1a=Task1/2，M1b=Task3/4，M1c=Task5；真机演练另做（部署后跑 dry-run 迁移 + 开一个测试租户，属部署阶段，不在本 PR）
- [ ] **Step 3:** `git push -u origin feat/saas-admin-domain` + `gh pr create`（正文 Closes #<issue>，列 spec/plan 路径与验收对照）
