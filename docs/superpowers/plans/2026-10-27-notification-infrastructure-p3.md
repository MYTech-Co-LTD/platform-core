# 租户级通知基础设施 Plan 3：收口（P3）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口通知基础设施：补 `webhook` 通道（SSRF/HMAC 防护）、真正执行每通道限流、健康 job 覆盖更多故障面、收件箱批量已读与保留期清理，并在 console/文档里补齐。

**Architecture:** 新增 `modules/notify/providers/webhook.ts`（纯函数 + 注入 fetch），在 `worker-deps` 的 send 分发里接上；限流在 worker 的发送路径用 `notify.delivery` 计数实现（不引入新依赖）；保留期清理作为仓内脚本（openship job），与 `notify-health` 同范式。

**Tech Stack:** TypeScript / PostgreSQL / Node `fetch` + `undici` DNS 解析 / Vitest。

## Global Constraints

- 上游：`docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md` §6.2/§6.4/§8/§12；P1/P2 已合入 main（`v0.208.0`）。
- **通道仍只有三个**：`wecom_chat` / `in_app` / `webhook`。**不做**邮件/短信/digest/条件规则/多级路由/外部插件。
- **密钥只存 env 键名**（`secret_refs`），端点与日志绝不回显值；租户不能自建密钥。
- **webhook 出站硬约束**：只允许 `https:`；拒绝私网/回环/链路本地/元数据地址；**不跟随重定向**；超时 5s；body ≤ 32KB；必须带 `X-Notify-Signature` 与 `X-Notify-Timestamp`。
- **org 只来自 `identity.orgId`**；写操作落 `notify.audit`。
- 迁移必须幂等；测试需要 `DATABASE_URL`；全量在 ASCII 工作树副本跑（中文路径会打挂动态 import 测试）。
- 提交纪律：`feat(notify)` / `fix(notify)`，逐任务提交；feat/fix PR 需 `Closes #N`。
- 本计划**不改** P1/P2 已定的表结构与端点语义（只加列/加端点）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `modules/notify/providers/webhook.ts` | webhook 发送：SSRF 校验、HMAC 签名、状态映射 |
| `modules/notify/domain/net-guard.ts` | 纯函数：URL/主机校验（协议、私网段、用户信息） |
| `modules/notify/domain/rate-limit.ts` | 纯函数：限流判定（窗口内计数 → 是否放行 + 顺延秒数） |
| `modules/notify/storage.ts` | 计数查询、批量已读、保留期清理、通道级限流读取 |
| `modules/notify/worker-deps.ts` | 接上 webhook provider + 限流 + 超时 |
| `modules/notify/health.ts` | 增加 `olderThan24h` / 通道错误率 / 丢信面 |
| `modules/notify/routes.ts` | `POST /inbox/read-all`、webhook 健康探测 |
| `modules/notify/manifest.yaml` | 新端点声明 |
| `modules/notify/console/inbox.tsx` | 全部已读按钮 |
| `modules/notify/console/channels.tsx` | webhook 通道说明与健康结果展示 |
| `scripts/notify-health.mjs` | 输出新指标（退出码语义不变） |
| `scripts/notify-retention.mjs` | 保留期清理 job（in-app 90 天、attempt 180 天） |
| `.env.example` / 文档 | 新 env 键与运维口径 |

---

## Task 1: URL 出站守卫（纯函数）

**Files:**
- Create: `modules/notify/domain/net-guard.ts`
- Test: `modules/notify/domain/net-guard.test.ts`

**Interfaces:**
- Produces: `assertSafeWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string }`
- Produces: `isForbiddenHost(host: string): boolean`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { assertSafeWebhookUrl, isForbiddenHost } from './net-guard'

describe('assertSafeWebhookUrl', () => {
  it('https + 公网主机通过', () => {
    const r = assertSafeWebhookUrl('https://hooks.example.com/notify')
    expect(r.ok).toBe(true)
  })

  it('http / 非 http(s) / 带用户信息 / 非法 URL 一律拒绝', () => {
    expect(assertSafeWebhookUrl('http://hooks.example.com/x')).toMatchObject({ ok: false, reason: 'not_https' })
    expect(assertSafeWebhookUrl('ftp://hooks.example.com/x')).toMatchObject({ ok: false, reason: 'not_https' })
    expect(assertSafeWebhookUrl('https://user:pw@hooks.example.com/x')).toMatchObject({ ok: false, reason: 'credentials_in_url' })
    expect(assertSafeWebhookUrl('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' })
  })

  it('私网 / 回环 / 链路本地 / 元数据 / .local / 单标签主机拒绝', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '::1', 'localhost', 'metadata.google.internal', 'internal', 'svc.local']) {
      expect(isForbiddenHost(h), h).toBe(true)
    }
    for (const h of ['8.8.8.8', 'hooks.example.com']) {
      expect(isForbiddenHost(h), h).toBe(false)
    }
  })

  it('IP 字面量形式的 URL 也走同一守卫', () => {
    expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toMatchObject({ ok: false, reason: 'forbidden_host' })
    expect(assertSafeWebhookUrl('https://8.8.8.8/hook')).toMatchObject({ ok: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter notify exec vitest run domain/net-guard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// net-guard.ts — webhook 出站 URL 守卫（纯函数；域名解析后的 IP 检查在 provider 里做）
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata.google.internal', 'metadata',
])
const IPV4_PRIVATE = [
  [10, 8], [172, 12], [192, 168], [127, 8], [169, 254, 16], [100, 64, 10], [0, 8],
]

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  return IPV4_PRIVATE.some(([a, b = 8]) => {
    if (b === 8) return parts[0] === a
    if (b === 12) return parts[0] === a && parts[1]! >= 16 && parts[1]! <= 31
    if (b === 16) return parts[0] === a && parts[1] === 168
    if (b === 10) return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
    return false
  })
}

export function isForbiddenHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (!host.includes('.') && !host.includes(':')) return true // 单标签主机
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ipv4IsPrivate(host)
  return false
}

export function assertSafeWebhookUrl(raw: string):
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid_url' | 'not_https' | 'credentials_in_url' | 'forbidden_host' } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' }
  if (isForbiddenHost(url.hostname)) return { ok: false, reason: 'forbidden_host' }
  return { ok: true, url }
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter notify exec vitest run domain/net-guard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/notify/domain/net-guard.ts modules/notify/domain/net-guard.test.ts
git commit -m "feat(notify): webhook 出站 URL 守卫"
```

---

## Task 2: HMAC 签名与 webhook 发送

**Files:**
- Create: `modules/notify/providers/webhook.ts`
- Test: `modules/notify/providers/webhook.test.ts`

**Interfaces:**
- Consumes: `assertSafeWebhookUrl`、`isForbiddenHost`（Task 1）
- Produces: `signBody(secret: string, timestamp: number, body: string): string`（`sha256=<hex>`）
- Produces: `sendWebhook(args: { url: string; secret: string; payload: unknown; fetchImpl?: typeof fetch; resolveHost?: (h: string) => Promise<string[]>; timeoutMs?: number }): Promise<ProviderResult>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { sendWebhook, signBody } from './webhook'

const url = 'https://hooks.example.com/x'

const okFetch = (capture: { body?: string; headers?: Record<string, string> }) =>
  (async (_u: string, init?: RequestInit) => {
    capture.body = String(init?.body)
    capture.headers = init?.headers as Record<string, string>
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch

describe('signBody', () => {
  it('HMAC-SHA256(timestamp + body)，形如 sha256=<hex>', () => {
    const ts = 1700000000
    const body = '{"a":1}'
    const expected = createHmac('sha256', 'k').update(`${ts}.${body}`).digest('hex')
    expect(signBody('k', ts, body)).toBe(`sha256=${expected}`)
  })
})

describe('sendWebhook', () => {
  it('2xx ⇒ ok；带签名头与时间戳', async () => {
    const cap: { body?: string; headers?: Record<string, string> } = {}
    const r = await sendWebhook({ url, secret: 'k', payload: { a: 1 }, fetchImpl: okFetch(cap) })
    expect(r).toEqual({ ok: true })
    expect(cap.body).toBe('{"a":1}')
    expect(cap.headers!['X-Notify-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(cap.headers!['X-Notify-Timestamp']).toMatch(/^\d+$/)
    expect(cap.headers!['content-type']).toBe('application/json')
  })

  it('4xx（除 408/429）⇒ permanent；408/429/5xx ⇒ retryable；网络异常 ⇒ retryable', async () => {
    const mk = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch
    expect(await sendWebhook({ url, secret: 'k', payload: {}, fetchImpl: mk(400) }))
      .toMatchObject({ ok: false, kind: 'permanent', code: '400' })
    for (const s of [408, 429, 500, 503]) {
      expect(await sendWebhook({ url, secret: 'k', payload: {}, fetchImpl: mk(s) }))
        .toMatchObject({ ok: false, kind: 'retryable', code: String(s) })
    }
    const boom = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await sendWebhook({ url, secret: 'k', payload: {}, fetchImpl: boom }))
      .toMatchObject({ ok: false, kind: 'retryable', code: 'network' })
  })

  it('不安全 URL ⇒ permanent（不再外发）', async () => {
    let called = false
    const spy = (async () => { called = true; return new Response(null, { status: 204 }) }) as unknown as typeof fetch
    expect(await sendWebhook({ url: 'http://hooks.example.com/x', secret: 'k', payload: {}, fetchImpl: spy }))
      .toMatchObject({ ok: false, kind: 'permanent', code: 'unsafe_url' })
    expect(called).toBe(false)
  })

  it('DNS 解析出私网 IP ⇒ permanent（DNS rebinding 防护）', async () => {
    const resolveHost = async () => ['10.0.0.7']
    expect(await sendWebhook({
      url, secret: 'k', payload: {}, fetchImpl: okFetch({}), resolveHost,
    })).toMatchObject({ ok: false, kind: 'permanent', code: 'forbidden_ip' })
  })

  it('body 超过 32KB ⇒ permanent', async () => {
    expect(await sendWebhook({
      url, secret: 'k', payload: { big: 'x'.repeat(40_000) }, fetchImpl: okFetch({}),
    })).toMatchObject({ ok: false, kind: 'permanent', code: 'body_too_large' })
  })

  it('不跟随重定向（3xx ⇒ permanent）', async () => {
    const r = await sendWebhook({
      url, secret: 'k', payload: {},
      fetchImpl: (async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
    })
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: '302' })
  })
})
```

- [ ] **Step 2: 实现**

```ts
// webhook.ts — 出站 webhook：SSRF 守卫 + HMAC 签名 + 状态映射。
import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { assertSafeWebhookUrl, isForbiddenHost } from '../domain/net-guard'

export type ProviderResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

const MAX_BODY_BYTES = 32 * 1024

export function signBody(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${hex}`
}

export async function sendWebhook(a: {
  url: string
  secret: string
  payload: unknown
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  timeoutMs?: number
}): Promise<ProviderResult> {
  const guard = assertSafeWebhookUrl(a.url)
  if (!guard.ok) {
    return { ok: false, kind: 'permanent', code: 'unsafe_url', summary: guard.reason }
  }

  const resolve = a.resolveHost ?? (async (h: string) =>
    (await lookup(h, { all: true })).map((x) => x.address))
  try {
    const ips = await resolve(guard.url.hostname)
    if (ips.length === 0 || ips.some((ip) => isForbiddenHost(ip))) {
      return { ok: false, kind: 'permanent', code: 'forbidden_ip', summary: ips.join(',') }
    }
  } catch (e) {
    return { ok: false, kind: 'retryable', code: 'dns', summary: e instanceof Error ? e.message : String(e) }
  }

  const body = JSON.stringify(a.payload)
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return { ok: false, kind: 'permanent', code: 'body_too_large', summary: `${Buffer.byteLength(body)}B` }
  }

  const ts = Math.floor(Date.now() / 1000)
  const f = a.fetchImpl ?? fetch
  try {
    const res = await f(a.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'X-Notify-Timestamp': String(ts),
        'X-Notify-Signature': signBody(a.secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(a.timeoutMs ?? 5000),
    })
    if (res.status >= 200 && res.status < 300) return { ok: true }
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500
    return {
      ok: false,
      kind: retryable ? 'retryable' : 'permanent',
      code: String(res.status),
      summary: `webhook HTTP ${res.status}`,
    }
  } catch (e) {
    return { ok: false, kind: 'retryable', code: 'network', summary: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter notify exec vitest run providers/webhook.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/providers/webhook.ts modules/notify/providers/webhook.test.ts
git commit -m "feat(notify): webhook provider（SSRF + HMAC）"
```

---

## Task 3: worker 接上 webhook 通道

**Files:**
- Modify: `modules/notify/worker-deps.ts`
- Test: `modules/notify/worker-deps.test.ts`

**Interfaces:**
- Consumes: `sendWebhook`（Task 2）
- Consumes: channel 行新增语义：`provider='webhook'` 的 `secret_refs = { url, key }`

- [ ] **Step 1: 写失败测试**

```ts
it('webhook：从 secret_refs 取 url/key，正文用 rendered.body 或整包 JSON', async () => {
  await pool.query(
    `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
     values ($1,'webhook_ops','webhook',true,'{}',
             '{"url":"NOTIFY_WEBHOOK_URL__ORG_WD3__OPS","key":"NOTIFY_WEBHOOK_KEY__ORG_WD3__OPS"}','u')`,
    [ORG])

  const deps = buildWorkerDeps(pool, async () => null, {
    NOTIFY_WEBHOOK_URL__ORG_WD3__OPS: 'https://hooks.example.com/x',
    NOTIFY_WEBHOOK_KEY__ORG_WD3__OPS: 'secret',
  })
  const orig = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch
  try {
    expect(await deps.send({
      org: ORG, eventId: 'e1', eventKey: 'm.a.b', ruleId: 'r1', recipient: 'u1',
      channel: 'webhook_ops', address: '', templateKey: 't1', revision: 1,
      rendered: { text: 'hello' }, status: 'pending', attempts: 0, lockedUntil: null,
    })).toEqual({ ok: true })
  } finally {
    globalThis.fetch = orig
  }
})
```

- [ ] **Step 2: 实现（在 `send` 分发里加分支）**

```ts
      if (ch.provider === 'webhook') {
        return sendWebhook({
          url: secrets.url,
          secret: secrets.key,
          payload: {
            eventId: d.eventId, eventKey: d.eventKey, recipient: d.recipient,
            templateKey: d.templateKey, revision: d.revision, rendered: d.rendered,
          },
          timeoutMs: typeof ch.config.timeout_ms === 'number' ? ch.config.timeout_ms : undefined,
        })
      }
```

- [ ] **Step 3: 跑测试**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter notify exec vitest run worker-deps.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add modules/notify/worker-deps.ts modules/notify/worker-deps.test.ts
git commit -m "feat(notify): worker 接上 webhook 通道"
```

---

## Task 4: 每通道限流（真正执行）

**Files:**
- Create: `modules/notify/domain/rate-limit.ts`
- Modify: `modules/notify/storage.ts`、`modules/notify/worker.ts`、`modules/notify/worker-deps.ts`
- Test: `modules/notify/domain/rate-limit.test.ts`、`modules/notify/worker.test.ts`、`modules/notify/storage.test.ts`

**Interfaces:**
- Produces: `rateLimitVerdict(sentInWindow: number, limit: number): { allow: boolean; retryAfterMs: number }`
- Produces: `countChannelSends(pool, org, channel, windowSeconds): Promise<number>`
- `WorkerDeps` 新增可选 `channelRateLimited?(org, channel, now): Promise<number | null>`（返回剩余等待毫秒，null = 放行）

- [ ] **Step 1: 写失败测试**

```ts
// domain/rate-limit.test.ts
it('limit=3：窗口内 <3 放行；>=3 顺延到窗口末', () => {
  expect(rateLimitVerdict(0, 3)).toEqual({ allow: true, retryAfterMs: 0 })
  expect(rateLimitVerdict(2, 3)).toEqual({ allow: true, retryAfterMs: 0 })
  expect(rateLimitVerdict(3, 3).allow).toBe(false)
  expect(rateLimitVerdict(3, 3).retryAfterMs).toBeGreaterThan(0)
  expect(rateLimitVerdict(9, 0)).toEqual({ allow: true, retryAfterMs: 0 }) // 0/缺省 = 不限
})

// worker.test.ts
it('通道达上限 ⇒ 不发送，delivery 顺延（failed + retryAfter）', async () => {
  const f = makeDeps({ channelRateLimited: async () => 12_000 })
  const s = await runOnce(f.deps)
  expect(s.sent).toBe(0)
  expect(f.failed[0]!.msg).toBe('channel_rate_limited')
  expect(f.failed[0]!.at.getTime()).toBe(new Date('2026-01-01T00:00:00Z').getTime() + 12_000)
})

// storage.test.ts
it('countChannelSends 只数窗口内 sent', async () => { /* 插 2 sent + 1 failed，窗口 60s */ })
```

- [ ] **Step 2: 实现**

```ts
// domain/rate-limit.ts
export function rateLimitVerdict(
  sentInWindow: number, limit: number, windowMs = 60_000,
): { allow: boolean; retryAfterMs: number } {
  if (!limit || limit <= 0) return { allow: true, retryAfterMs: 0 }
  if (sentInWindow < limit) return { allow: true, retryAfterMs: 0 }
  return { allow: false, retryAfterMs: windowMs }
}
```

```ts
// storage.ts
export async function countChannelSends(
  pool: Pool, org: string, channel: string, windowSeconds = 60,
): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int n from notify.delivery
      where org=$1 and channel=$2 and status='sent'
        and created_at > now() - ($3 || ' seconds')::interval`,
    [org, channel, String(windowSeconds)])
  return rows[0].n as number
}
```

worker 发送循环里，在 `deps.send(d)` 之前：

```ts
    const wait = deps.channelRateLimited ? await deps.channelRateLimited(d.org, d.channel, deps.now()) : null
    if (wait !== null) {
      await deps.markDeliveryFailed(d, 'channel_rate_limited', new Date(deps.now().getTime() + wait))
      failed++
      continue
    }
```

`worker-deps.ts`：

```ts
    channelRateLimited: async (org, channel) => {
      const ch = await storage.getChannel(pool, org, channel)
      const limit = typeof ch?.config.rate_limit_per_min === 'number' ? ch.config.rate_limit_per_min : 0
      if (limit <= 0) return null
      const sent = await storage.countChannelSends(pool, org, channel, 60)
      const v = rateLimitVerdict(sent, limit)
      return v.allow ? null : v.retryAfterMs
    },
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/domain/rate-limit.ts modules/notify/domain/rate-limit.test.ts modules/notify/storage.ts modules/notify/worker.ts modules/notify/worker-deps.ts modules/notify/*.test.ts
git commit -m "feat(notify): 每通道限流真正执行"
```

---

## Task 5: 健康指标扩展 + 健康 job 输出

**Files:**
- Modify: `modules/notify/health.ts`、`scripts/notify-health.mjs`
- Test: `modules/notify/health.test.ts`

**Interfaces:**
- Produces: `Health = { dead; stale; workers; oldestPendingSeconds; failedLastHour; channelErrors }`

- [ ] **Step 1: 写失败测试**

```ts
it('verdict：dead/stale/无心跳之外，failedLastHour 超阈值也算不健康', () => {
  expect(healthVerdict({ dead: 0, stale: 0, workers: 1, oldestPendingSeconds: 0, failedLastHour: 0, channelErrors: 0 })).toBe(0)
  expect(healthVerdict({ dead: 0, stale: 0, workers: 1, oldestPendingSeconds: 0, failedLastHour: 51, channelErrors: 0 })).toBe(1)
})

it('checkHealth 返回新指标', async () => { /* 断言字段存在且为数字 */ })
```

- [ ] **Step 2: 实现**

```ts
export type Health = {
  dead: number; stale: number; workers: number
  oldestPendingSeconds: number; failedLastHour: number; channelErrors: number
}

export const FAILED_LAST_HOUR_LIMIT = 50

export function healthVerdict(h: Health): 0 | 1 {
  if (h.dead > 0 || h.stale > 0 || h.workers === 0) return 1
  if (h.failedLastHour > FAILED_LAST_HOUR_LIMIT) return 1
  return 0
}

export async function checkHealth(pool: Pool): Promise<Health> {
  const { rows } = await pool.query(`
    select
      (select count(*)::int from notify.delivery where status='dead') as dead,
      (select count(*)::int from notify.delivery
        where status='pending' and created_at < now()-interval '10 minutes') as stale,
      (select count(*)::int from notify.worker_heartbeat
        where beat_at > now()-interval '2 minutes') as workers,
      (select coalesce(max(extract(epoch from now()-created_at)),0)::int from notify.delivery
        where status='pending') as "oldestPendingSeconds",
      (select count(*)::int from notify.delivery
        where status='failed' and updated_at > now()-interval '1 hour') as "failedLastHour",
      (select count(*)::int from notify.channel where health like 'error%') as "channelErrors"`)
  return rows[0] as Health
}
```

`scripts/notify-health.mjs` 打印新指标（退出码不变）：

```js
console.log(`notify-health: dead=${r.dead} stale=${r.stale} workers=${r.workers} `
  + `oldestPending=${r.oldestPendingSeconds}s failedLastHour=${r.failedLastHour} channelErrors=${r.channelErrors}`)
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
pnpm exec vitest run scripts/notify-health.test.ts
git add modules/notify/health.ts modules/notify/health.test.ts scripts/notify-health.mjs scripts/notify-health.test.ts
git commit -m "feat(notify): 健康指标扩展"
```

---

## Task 6: 收件箱批量已读 + 保留期清理

**Files:**
- Modify: `modules/notify/storage.ts`、`modules/notify/routes.ts`、`modules/notify/manifest.yaml`
- Create: `scripts/notify-retention.mjs`
- Modify: `modules/notify/console/inbox.tsx`
- Test: `modules/notify/routes.test.ts`、`modules/notify/storage.test.ts`、`modules/notify/console/inbox.test.tsx`

**Interfaces:**
- Produces: `markAllInboxRead(pool, org, recipient): Promise<number>`
- Produces: `purgeOldNotifications(pool, { inboxDays, attemptDays, deliveryDays }): Promise<{ inbox: number; attempts: number; deliveries: number }>`
- Produces: `POST /inbox/read-all`

- [ ] **Step 1: 写失败测试**

```ts
// routes.test.ts
it('POST /inbox/read-all 只标记自己的', async () => {
  // 插 u1 ×2、other ×1
  expect((await app.request('/inbox/read-all', { method: 'POST' })).status).toBe(200)
  const { rows } = await pool.query(
    'select recipient, count(*) filter (where read_at is not null)::int n from notify.inbox where org=$1 group by recipient', [ORG])
  expect(rows).toEqual(expect.arrayContaining([
    { recipient: 'u1', n: 2 }, { recipient: 'other', n: 0 },
  ]))
})

// storage.test.ts
it('purgeOldNotifications 只删过期行', async () => { /* 90 天前后各插一条 */ })
```

- [ ] **Step 1: 写失败测试**

```ts
vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { routeFetch, json } from './test-util'

it('全部已读按钮调用 read-all 并刷新', async () => {
  let readAllCalled = false
  routeFetch({
    'GET /api/modules/notify/inbox': () => json({ items: [
      { id: 'i1', eventId: 'e1', eventKey: 'm.a.b', title: 'T', body: 'B',
        link: null, readAt: null, createdAt: '2026-10-27T00:00:00Z' },
    ] }),
    'POST /api/modules/notify/inbox/read-all': () => {
      readAllCalled = true
      return json({ marked: 1 })
    },
  })
  render(<InboxTab />)
  fireEvent.click(await screen.findByRole('button', { name: /全\s*部\s*已\s*读/ }))
  await waitFor(() => expect(readAllCalled).toBe(true))
})
```

- [ ] **Step 2: 实现**

```ts
export async function markAllInboxRead(
  pool: Pool, org: string, recipient: string,
): Promise<number> {
  const r = await pool.query(
    'update notify.inbox set read_at=now() where org=$1 and recipient=$2 and read_at is null',
    [org, recipient])
  return r.rowCount ?? 0
}

export async function purgeOldNotifications(
  pool: Pool,
  opts: { inboxDays: number; attemptDays: number; deliveryDays: number },
): Promise<{ inbox: number; attempts: number; deliveries: number }> {
  const del = async (table: string, days: number, extra = '') => {
    const r = await pool.query(
      `delete from ${table} where created_at < now() - ($1 || ' days')::interval ${extra}`,
      [String(days)])
    return r.rowCount ?? 0
  }
  const inbox = await del('notify.inbox', opts.inboxDays)
  const attempts = await del('notify.delivery_attempt', opts.attemptDays)
  const deliveries = await del('notify.delivery', opts.deliveryDays,
    "and status in ('sent','suppressed','dead')")
  return { inbox, attempts, deliveries }
}
```

`routes.ts` + `manifest.yaml`：

```ts
  r.post('/inbox/read-all', async (c) => {
    const identity = c.get('identity') as Identity
    const n = await markAllInboxRead(deps.pool, identity.orgId, identity.userId)
    return c.json({ marked: n })
  })
```

```yaml
    - { method: POST,   path: /inbox/read-all,    scope: notify:view }
```

`scripts/notify-retention.mjs`（薄 CLI，照 `notify-health.mjs`）：读 env
`NOTIFY_INBOX_RETENTION_DAYS`（默认 90）/ `NOTIFY_ATTEMPT_RETENTION_DAYS`（180）/
`NOTIFY_DELIVERY_RETENTION_DAYS`（365），退出码 0/1/2。

console 收件箱页加「全部已读」按钮 → `POST /inbox/read-all` 后刷新。

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/storage.ts modules/notify/routes.ts modules/notify/manifest.yaml \
  modules/notify/console/inbox.tsx modules/notify/*.test.ts modules/notify/console/inbox.test.tsx \
  scripts/notify-retention.mjs
git commit -m "feat(notify): 收件箱批量已读与保留期清理"
```

---

## Task 7: webhook 健康探测 + 通道页补充

**Files:**
- Modify: `modules/notify/domain/channel.ts`、`modules/notify/routes.ts`、`modules/notify/console/channels.tsx`
- Test: `modules/notify/domain/channel.test.ts`、`modules/notify/routes.test.ts`

**Interfaces:**
- Produces: `checkWebhookHealth({ url, key, fetchImpl?, resolveHost? }): Promise<{ ok: boolean; detail?: string }>` —— 发一个**签名 + 空 payload** 的探测，2xx 视为健康。

- [ ] **Step 1: 写失败测试**

```ts
it('webhook 健康：2xx ok / 4xx error / 网络 retryable 视为 error', async () => { /* fetch 注入 */ })
it('POST /channels/webhook_ops/health 走 webhook 探测而非 bridge', async () => { /* 断言 URL 命中 webhook */ })
```

- [ ] **Step 2: 实现**

```ts
export async function checkWebhookHealth(a: {
  url: string; key: string; fetchImpl?: typeof fetch; resolveHost?: (h: string) => Promise<string[]>
}): Promise<{ ok: boolean; detail?: string }> {
  const r = await sendWebhook({
    url: a.url, secret: a.key, payload: { probe: 'health' },
    fetchImpl: a.fetchImpl, resolveHost: a.resolveHost,
  })
  return r.ok ? { ok: true } : { ok: false, detail: `${r.code}: ${r.summary}` }
}
```

`routes.ts` 的 `/channels/:id/health` 按 provider 分支：`wecom_chat` → `checkWecomHealth`；`webhook` → `checkWebhookHealth`（url/key 从 `secret_refs` 解析 env）；`in_app` → ok。

console 通道页：webhook 通道显示「目标 URL 只在 env」提示 + 健康结果里的 `code: summary`。

- [ ] **Step 3: 跑测试 + 提交**

```bash
DATABASE_URL=$DATABASE_URL pnpm --filter notify test
git add modules/notify/domain/channel.ts modules/notify/domain/channel.test.ts modules/notify/routes.ts modules/notify/routes.test.ts modules/notify/console/channels.tsx
git commit -m "feat(notify): webhook 健康探测"
```

---

## Task 8: env 契约、文档与全量验证

**Files:**
- Modify: `.env.example`、`docs/architecture.md` §2.6、`deploy/notify-reconcile-job.md`（提及 retention/health 两个 job）
- Create: `deploy/notify-jobs.md`（两个 job 的建法与退出码，照 notify-reconcile 范式）

- [ ] **Step 1: env 契约**

```bash
# webhook 通道（每通道一组；url 与 key 都是 isSecret）
#   NOTIFY_WEBHOOK_URL__<ORG>__<CHANNEL_ID>=https://...
#   NOTIFY_WEBHOOK_KEY__<ORG>__<CHANNEL_ID>=
# 保留期（天；缺省 90 / 180 / 365）
NOTIFY_INBOX_RETENTION_DAYS=
NOTIFY_ATTEMPT_RETENTION_DAYS=
NOTIFY_DELIVERY_RETENTION_DAYS=
```

> 只写键名与「在哪取」，**不写值**；`<ORG>` 复用 `orgEnvKeyFor` 的规范化。

- [ ] **Step 2: 文档**

- `docs/architecture.md` §2.6 增加「P3 收口」小节：webhook（SSRF/HMAC）、限流、健康指标、保留期。
- `deploy/notify-jobs.md`：`notify-health`（每 5 分钟）与 `notify-retention`（每日）两个 openship job 的命令、退出码、订阅失败通知。

- [ ] **Step 3: 全量验证**

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

Expected: 全绿（ASCII 副本里跑全量）。

- [ ] **Step 4: 提交**

```bash
git add .env.example docs/architecture.md deploy/notify-jobs.md deploy/notify-reconcile-job.md
git commit -m "docs(notify): P3 收口文档与 env 契约"
```

---

## Self-Review

- 覆盖：spec §6.2 webhook（Task 1/2/3）、§6.4 限流（Task 4）、§12 健康（Task 5）、§8 收件箱批量已读与保留期（Task 6）、通道健康（Task 7）、文档（Task 8）。
- 缺口：OO 告警接线**不在本计划**（属监控职责分工，需按 `data-monitor` skill 的 Phase 判定与 #538 协同，另立计划）。
- 类型一致性：`ProviderResult` 与 `providers/wecom.ts` 同形；`Health` 扩展后 `healthVerdict` 的签名在 Task 5 内同步更新，调用方（`scripts/notify-health.mjs`、`health.test.ts`）一并改。
- 硬边界：webhook 只 https、不跟随重定向、DNS 解析后再校验 IP、body ≤32KB；密钥只从 `secret_refs` 的 env 键名解析。
