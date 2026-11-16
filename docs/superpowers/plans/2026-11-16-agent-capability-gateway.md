# Agent 能力网关实施计划（A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 追踪：issue #2360；分支：`agent-capability-gateway`（基于 `origin/main`；按计划 Task 13 只开 PR，不合并）。

**Goal:** 把 data/notify/forms 的 agent 面收敛到一个统一 MCP 网关（`/api/agent/mcp`），按调用方 scope/channel 投影能力；openclaw 通过两个 native 元工具接入同一能力核心。

**Architecture:** 模块侧持有工具元数据、face 门与 `tools/list`/`callTool` 执法；宿主网关只做 face 选择、命名空间、转发、分页/缓存/超时/限流/审计。B（PAT）与 C（企微渠道身份）共用网关，网关解析一次身份后用进程内 HMAC 内部身份向下游转发；C 的 notify 更严策略由 notify 模块按 `identity.channel` 强制。

**Tech Stack:** TypeScript、Hono、Node 22、vitest、node:test、pnpm。

---

## 工作约定

- 当前分支：`agent-capability-gateway`（从 `origin/main` 创建，含 spec `9f80098c`）。**不要切回 main，不要 push 到 main。**
- 设计正典：`docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md`。
- 必须同时对读：`docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md`（N1–N5）、`docs/superpowers/specs/2026-11-14-business-scheduler-design.md`、`docs/superpowers/specs/2026-11-14-business-monitor-design.md`。
- 仓库纪律：feat 必须先有 issue；Conventional Commits；每个 Task 结束提交；不 push（除非 Task 13 明确）。
- `pnpm` 可能不在 PATH：用 `corepack pnpm`；`test:guard` 若 `spawnSync pnpm ENOENT`，用 `/tmp/pnpm-shim/pnpm`（`exec corepack pnpm "$@"`）并前置 PATH。

---

### Task 0: Issue 与基线

**Files:**
- Modify: 无

- [ ] **Step 1: 建 issue**

```bash
gh issue create \
  --title "feat(data): agent 能力网关（统一 MCP 入口 + 能力目录）" \
  --body "设计：docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md

统一 data/notify/forms 的 agent 面；B 走 MCP 网关，C 走 native 元工具；按 scope/channel 投影能力；外发人 gate。"
export ISSUE=<URL 末尾数字>
echo "$ISSUE"
```

- [ ] **Step 2: 记录当前 HEAD**

```bash
git log -1 --oneline
```

Expected: 当前 HEAD 是 spec 提交（`9f80098c` 或其后）。把 SHA 记到 issue。

---

### Task 1: manifest `mcpFaces` 协议

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Test: `packages/platform-sdk/src/manifest.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `manifest.test.ts` 追加：

```ts
import { ManifestSchema } from './manifest'

const base = {
  id: 'data', name: '数据', version: '0.1.0', platform: '>=0.1',
  permissions: [{ code: 'data:read', name: '读' }, { code: 'data:query', name: '查' }],
  api: { internal: [
    { method: 'POST', path: '/mcp-read', scope: 'data:read' },
    { method: 'POST', path: '/mcp', scope: 'data:query' },
  ] },
}

describe('mcpFaces', () => {
  it('合法声明通过', () => {
    const m = { ...base, mcpFaces: [
      { face: 'read', group: 'agent', precedence: 1, path: '/mcp-read', method: 'POST', scope: 'data:read', audiences: ['mcp'] },
      { face: 'query', group: 'agent', precedence: 2, path: '/mcp', method: 'POST', scope: 'data:query', audiences: ['mcp'] },
    ] }
    expect(ManifestSchema.safeParse(m).success).toBe(true)
  })
  it('path 不在 api.internal / scope 不一致 ⇒ 拒', () => {
    const m = { ...base, mcpFaces: [
      { face: 'read', group: 'agent', precedence: 1, path: '/nope', method: 'POST', scope: 'data:read', audiences: ['mcp'] },
    ] }
    expect(ManifestSchema.safeParse(m).success).toBe(false)
  })
  it('同一 (group,audience) precedence 重复 ⇒ 拒；不同 audience 可重复', () => {
    const dup = { ...base, mcpFaces: [
      { face: 'a', group: 'g', precedence: 1, path: '/mcp-read', method: 'POST', scope: 'data:read', audiences: ['mcp'] },
      { face: 'b', group: 'g', precedence: 1, path: '/mcp', method: 'POST', scope: 'data:query', audiences: ['mcp'] },
    ] }
    expect(ManifestSchema.safeParse(dup).success).toBe(false)
    const ok = { ...base, mcpFaces: [
      { face: 'a', group: 'g', precedence: 1, path: '/mcp-read', method: 'POST', scope: 'data:read', audiences: ['mcp'], profile: 'full' },
      { face: 'b', group: 'g', precedence: 1, path: '/mcp-read', method: 'POST', scope: 'data:read', audiences: ['wecom'], profile: 'c-manage' },
    ] }
    expect(ManifestSchema.safeParse(ok).success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter @platform/sdk test -- manifest 2>&1 | tail -20
```

Expected: FAIL（`mcpFaces` 未知字段 / 未实现）。

- [ ] **Step 3: 加类型与 schema**

在 `ModuleManifest` 上方加：

```ts
export type McpAudience = 'mcp' | 'wecom'
export type McpProfile = 'full' | 'c-manage'

export interface McpFaceDecl {
  face: string
  group: string
  precedence: number
  path: string
  method: ApiMethod
  scope: string
  audiences: McpAudience[]
  profile?: McpProfile
}
```

在 `ModuleManifest` 加：

```ts
  /** agent MCP face 声明（2026-11-16 能力网关）：path 必须 ∈ api.internal 且 method/scope 一致 */
  mcpFaces?: McpFaceDecl[]
```

在 `ManifestObject` 的 `notifications` 之前加：

```ts
  mcpFaces: z.array(z.object({
    face: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    group: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    precedence: z.number().int().positive(),
    path: z.string().regex(/^\/(?!$)/),
    method: z.enum(['POST']),
    scope: z.string(),
    audiences: z.array(z.enum(['mcp', 'wecom'])).min(1),
    profile: z.enum(['full', 'c-manage']).optional(),
  }).strict()).optional(),
```

在 `superRefine` 末尾加：

```ts
  const faces = m.mcpFaces ?? []
  const faceSeen = new Set<string>()
  const byGroupAudience = new Map<string, Set<number>>()
  const byPath = new Map<string, Array<{ audiences: readonly string[]; profile?: string }>>()
  for (const f of faces) {
    if (faceSeen.has(f.face)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces.face 重复：${f.face}` })
    faceSeen.add(f.face)
    const ep = m.api?.internal?.find((e) => e.path === f.path && e.method === f.method && e.scope === f.scope)
    if (!ep) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces ${f.face}: path/method/scope 未在 api.internal 声明` })
    if (!m.permissions.some((p) => p.code === f.scope)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces ${f.face}: scope 不在 permissions` })
    for (const a of f.audiences) {
      const key = `${f.group}\0${a}`
      const set = byGroupAudience.get(key) ?? new Set<number>()
      if (set.has(f.precedence)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces (${f.group},${a}) precedence 重复：${f.precedence}` })
      set.add(f.precedence)
      byGroupAudience.set(key, set)
    }
    const pk = `${f.path}\0${f.method}\0${f.scope}`
    const list = byPath.get(pk) ?? []
    for (const other of list) {
      if (other.audiences.some((a) => f.audiences.includes(a as McpAudience))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces ${f.face}: 同 path/method/scope 的 audiences 必须不相交` })
      }
      if ((other.profile ?? 'full') === (f.profile ?? 'full')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcpFaces ${f.face}: 同 path/method/scope 的 profile 不得相同` })
      }
    }
    list.push({ audiences: f.audiences, profile: f.profile })
    byPath.set(pk, list)
  }
```

- [ ] **Step 4: 跑测试**

```bash
corepack pnpm --filter @platform/sdk test -- manifest
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/manifest.test.ts
git commit -m "feat(sdk): manifest 增加 mcpFaces 声明与校验 (#$ISSUE)"
```

---

### Task 2: loader 暴露 `mcpFaces()`

**Files:**
- Modify: `apps/server/src/loader.ts`
- Test: `apps/server/src/loader.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `loader.test.ts` 的模块 fixture 里加一个带 `mcpFaces` 的 manifest（或复用现有 fixture 追加），断言：

```ts
it('runtime.mcpFaces() 返回模块/face/mountPath', () => {
  const faces = runtime.mcpFaces()
  expect(faces).toContainEqual(expect.objectContaining({
    moduleId: 'data', mountPath: '/api/modules/data',
    face: expect.objectContaining({ face: 'read', path: '/mcp-read' }),
  }))
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter @platform/server exec vitest run src/loader.test.ts
```

Expected: FAIL（`mcpFaces` 不是函数）。

- [ ] **Step 3: 加接口与方法**

`ModulesRuntime` 加：

```ts
  /** agent MCP face 声明（manifest.mcpFaces）；未声明的模块不出现 */
  mcpFaces(): Array<{ moduleId: string; face: McpFaceDecl; mountPath: string }>
```

在 `runtime` 对象末尾（`enabledGuestScopes` 之后）加：

```ts
    mcpFaces: () => loaded.flatMap((m) =>
      (m.manifest.mcpFaces ?? []).map((face) => ({
        moduleId: m.manifest.id, face, mountPath: moduleApiBasePath(m.manifest.id),
      })),
    ),
```

导入 `McpFaceDecl` 类型（从 `@platform/sdk`）。

- [ ] **Step 4: 跑测试**

```bash
corepack pnpm --filter @platform/server exec vitest run src/loader.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts
git commit -m "feat(server): loader 暴露 mcpFaces (#$ISSUE)"
```

---

### Task 3: 内部签名身份

**Files:**
- Create: `apps/server/src/internal-identity.ts`
- Create: `apps/server/src/internal-identity.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { issueInternalIdentity, verifyInternalIdentity, INTERNAL_IDENTITY_HEADER } from './internal-identity'

describe('internal identity', () => {
  it('签发后可验；过期/篡改/缺头 ⇒ null', () => {
    const h = issueInternalIdentity({
      org: 'acme', userId: 'u1', channel: 'wecom', scopes: ['data:query'], sessionId: 's1',
    })
    expect(verifyInternalIdentity(h)).toMatchObject({ org: 'acme', userId: 'u1', channel: 'wecom' })
    expect(verifyInternalIdentity(h.replace(/.$/, 'x'))).toBeNull()
    expect(verifyInternalIdentity(undefined)).toBeNull()
    expect(INTERNAL_IDENTITY_HEADER).toBe('x-internal-identity')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter @platform/server exec vitest run src/internal-identity.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// internal-identity.ts — 网关→模块的进程内身份断言（HMAC，30s TTL）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import { createMiddleware } from 'hono/factory'
import type { RequesterEnv } from './pat-auth'

export const INTERNAL_IDENTITY_HEADER = 'x-internal-identity'
const SECRET = randomBytes(32)
const TTL_MS = 30_000

export interface InternalIdentityPayload {
  org: string
  userId: string
  displayName?: string
  accountName?: string
  channel: 'pat' | 'session' | 'wecom'
  keyId?: number | null
  scopes: string[]
  roles?: string[]
  sessionId?: string
  exp: number
}

const sign = (payload: string): string =>
  createHmac('sha256', SECRET).update(payload).digest('base64url')

export function issueInternalIdentity(p: Omit<InternalIdentityPayload, 'exp'>): string {
  const payload = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyInternalIdentity(header: string | undefined, now = Date.now()): InternalIdentityPayload | null {
  if (!header) return null
  const [payload, mac] = header.split('.')
  if (!payload || !mac) return null
  const expected = sign(payload)
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as InternalIdentityPayload
    return Number.isFinite(p.exp) && p.exp > now ? p : null
  } catch {
    return null
  }
}

export function identityFromInternal(p: InternalIdentityPayload): Identity {
  return {
    userId: p.userId, orgId: p.org,
    displayName: p.displayName ?? p.userId,
    scopes: p.scopes, hasScope: (code) => p.scopes.includes(code),
    ...(p.roles ? { roles: p.roles } : {}),
    ...(p.accountName ? { accountName: p.accountName } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
  }
}

/** 只接受网关签发的内部头；外部同名头验不过即放行给下游门卫（fail-closed 在那）。 */
export function internalIdentityMiddleware() {
  return createMiddleware<RequesterEnv>(async (c, next) => {
    if (c.get('identity')) return next()
    const p = verifyInternalIdentity(c.req.header(INTERNAL_IDENTITY_HEADER))
    if (p) {
      c.set('identity', identityFromInternal(p))
      c.set(REQUESTER_CHANNEL, p.channel)
      if (p.keyId != null) c.set(REQUESTER_KEY_ID, p.keyId)
    }
    await next()
  })
}
```

- [ ] **Step 4: 在 app.ts 挂到 `/api/modules/*`**

在 `patIdentityMiddleware` 之前加：

```ts
  app.use('/api/modules/*', internalIdentityMiddleware())
```

导入 `internalIdentityMiddleware`。

- [ ] **Step 5: 跑测试与 typecheck**

```bash
corepack pnpm --filter @platform/server exec vitest run src/internal-identity.test.ts
corepack pnpm --filter @platform/server exec tsc --noEmit
```

Expected: PASS / clean。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/internal-identity.ts apps/server/src/internal-identity.test.ts apps/server/src/app.ts
git commit -m "feat(server): 内部签名身份与中间件 (#$ISSUE)"
```

---

### Task 4: 网关核心 + 能力目录

**Files:**
- Create: `apps/server/src/routes/agent-mcp.ts`
- Create: `apps/server/src/routes/agent-mcp.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { agentMcpRoutes } from './agent-mcp'

const faces = [
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'read', group: 'agent', precedence: 1, path: '/mcp-read', method: 'POST' as const, scope: 'data:read', audiences: ['mcp' as const] } },
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'agent', group: 'agent', precedence: 2, path: '/mcp-curated', method: 'POST' as const, scope: 'data:query', audiences: ['mcp' as const] } },
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'manage', group: 'manage', precedence: 1, path: '/mcp-manage', method: 'POST' as const, scope: 'data:manage', audiences: ['mcp' as const, 'wecom' as const] } },
]

function makeApp(scopes: string[], channel: 'pat' | 'wecom' = 'pat') {
  const app = new Hono<{ Variables: { identity: { orgId: string; userId: string; scopes: string[]; hasScope: (c: string) => boolean } } }>()
  app.use('*', async (c, next) => {
    c.set('identity', { orgId: 'acme', userId: 'u1', scopes, hasScope: (code) => scopes.includes(code) })
    await next()
  })
  app.route('/agent', agentMcpRoutes({
    faces: () => faces,
    fetchModule: async (path, init) => {
      const body = JSON.parse(String(init.body))
      const face = faces.find((f) => path.endsWith(f.face.path))!
      if (body.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [
          { name: 'search_catalog', description: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ] } })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, face: face.face.face }) }], isError: false } })
    },
  }))
  return app
}

describe('agent mcp', () => {
  it('只暴露可进 face 的工具；命名 <module>__<tool>；暴露出选中的 query 面', async () => {
    const app = makeApp(['data:query'])
    const r = await app.request('/agent/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const body = await r.json()
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('data__search_catalog')
    expect(body.result.tools.map((t: { name: string }) => t.name)).not.toContain('data__customize_metric')
  })
  it('缺 manage scope ⇒ manage 面不可见；capabilities lockedFaces 带 scope', async () => {
    const app = makeApp(['data:query'])
    const r = await app.request('/agent/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent__capabilities', arguments: {} } }) })
    const body = await r.json()
    const out = JSON.parse(body.result.content[0].text)
    expect(out.lockedFaces).toContainEqual(expect.objectContaining({ module: 'data', face: 'manage', scope: 'data:manage' }))
  })
  it('tools/call 转发到选中 face；未知名 -32601', async () => {
    const app = makeApp(['data:query'])
    const r = await app.request('/agent/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'data__search_catalog', arguments: {} } }) })
    expect((await r.json()).result.content[0].text).toContain('agent')
    const bad = await app.request('/agent/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope__x', arguments: {} } }) })
    expect((await bad.json()).error.code).toBe(-32601)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter @platform/server exec vitest run src/routes/agent-mcp.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现网关**

```ts
// agent-mcp.ts — 统一 agent MCP 网关：face 选择 + 命名空间 + 转发 + 能力目录。
import type { Hono } from 'hono'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import type { Identity, McpFaceDecl } from '@platform/sdk'
import { INTERNAL_IDENTITY_HEADER, issueInternalIdentity } from '../internal-identity'

export interface AgentFace { moduleId: string; face: McpFaceDecl; mountPath: string }
type IdentityVars = { Variables: { identity: Identity } }
type Rpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

const PROTOCOL_VERSION = '2025-11-25'
const MAX_PAGE_TOOLS = 50
const MAX_PAGE_BYTES = 10_240
const CACHE_TTL_MS = 30_000

const audienceOf = (channel: string): 'mcp' | 'wecom' => (channel === 'wecom' ? 'wecom' : 'mcp')

function selectFaces(all: AgentFace[], identity: Identity, channel: string): AgentFace[] {
  const audience = audienceOf(channel)
  const chosen = new Map<string, AgentFace>()
  for (const f of all) {
    if (!f.face.audiences.includes(audience)) continue
    if (!identity.hasScope(f.face.scope)) continue
    const key = `${f.moduleId}\0${f.face.group}`
    const prev = chosen.get(key)
    if (!prev || f.face.precedence > prev.face.precedence) chosen.set(key, f)
  }
  return [...chosen.values()]
}

const toolName = (moduleId: string, name: string) => `${moduleId}__${name}`

const BUILTIN_CAPABILITIES = {
  name: 'agent__capabilities',
  description: '返回当前身份可用的能力、lockedFaces 与所需 scope；先调它，再调列表里的工具。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true },
}

export function agentMcpRoutes(deps: {
  faces: () => AgentFace[]
  fetchModule: (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>
}): Hono<IdentityVars> {
  const app = new Hono<IdentityVars>()
  const cache = new Map<string, { at: number; tools: Array<{ name: string; [k: string]: unknown }> }>()
  const buckets = new Map<string, { at: number; count: number }>()

  const internalHeaders = (identity: Identity, channel: string): Record<string, string> => ({
    'content-type': 'application/json',
    [INTERNAL_IDENTITY_HEADER]: issueInternalIdentity({
      org: identity.orgId, userId: identity.userId, displayName: identity.displayName,
      channel: channel as 'pat' | 'session' | 'wecom',
      ...(identity.roles ? { roles: identity.roles } : {}),
      ...(identity.accountName ? { accountName: identity.accountName } : {}),
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      scopes: identity.scopes,
    }),
  })

  const rpc = async (face: AgentFace, identity: Identity, channel: string, body: Rpc): Promise<Response> =>
    deps.fetchModule(`${face.mountPath}${face.face.path}`, {
      method: 'POST', headers: { ...internalHeaders(identity, channel), 'x-agent-profile': face.face.profile ?? 'full' },
      body: JSON.stringify(body),
    })

  const listFaceTools = async (face: AgentFace, identity: Identity, channel: string) => {
    const key = `${identity.orgId}\0${identity.scopes.join(',')}\0${audienceOf(channel)}\0${face.moduleId}\0${face.face.face}\0${face.face.profile ?? 'full'}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tools
    const res = await rpc(face, identity, channel, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    if (!res.ok) return []
    const body = await res.json() as { result?: { tools?: Array<{ name: string; [k: string]: unknown }> } }
    const tools = (body.result?.tools ?? []).map((t) => ({ ...t, name: toolName(face.moduleId, t.name) }))
    cache.set(key, { at: Date.now(), tools })
    return tools
  }

  const allTools = async (identity: Identity, channel: string) => {
    const faces = selectFaces(deps.faces(), identity, channel)
    const pairs = await Promise.all(faces.map(async (face) => ({ face, tools: await listFaceTools(face, identity, channel) })))
    const byName = new Map<string, { tool: { name: string; [k: string]: unknown }; face: AgentFace }>()
    for (const { face, tools } of pairs) {
      for (const tool of tools) {
        const prev = byName.get(tool.name)
        if (prev && prev.face.moduleId !== face.moduleId) throw new Error(`agent mcp: 工具名冲突 ${tool.name}`)
        if (!prev) byName.set(tool.name, { tool, face })
      }
    }
    return { faces, tools: [...byName.values()] }
  }

  const rateOk = (identity: Identity, tool: string): boolean => {
    const key = `${identity.userId}\0${tool}`
    const now = Date.now()
    const b = buckets.get(key)
    if (!b || now - b.at >= 60_000) { buckets.set(key, { at: now, count: 1 }); return true }
    if (b.count >= 60) return false
    b.count += 1
    return true
  }

  app.post('/mcp', async (c) => {
    if (process.env.AGENT_MCP_ENABLED === '0') return c.json({ error: 'NOT_FOUND' }, 404)
    const identity = c.get('identity')
    if (!identity) return c.json({ error: 'UNAUTHENTICATED' }, 401)
    const channel = c.get(REQUESTER_CHANNEL) ?? 'session'
    const msg = await c.req.json().catch(() => null) as Rpc | null
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    if (msg.id === undefined) return c.body(null, 202)
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcErr = (code: number, message: string) => c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-agent-mcp', version: '0.1.0' },
        instructions: '工具按 <module>__<tool> 命名；先调 agent__capabilities；发布/启用必须人做。',
      })
    }
    if (msg.method === 'ping') return reply({})

    if (msg.method === 'tools/list') {
      const { tools } = await allTools(identity, channel)
      const all = [BUILTIN_CAPABILITIES, ...tools]
      const cursor = typeof msg.params?.cursor === 'string' ? Number(msg.params.cursor) : 0
      const page: Array<{ name: string; [k: string]: unknown }> = []
      let bytes = 0
      for (const t of all.slice(cursor)) {
        const b = JSON.stringify(t).length
        if (page.length >= MAX_PAGE_TOOLS || bytes + b > MAX_PAGE_BYTES) break
        page.push(t); bytes += b
      }
      const next = cursor + page.length < all.length ? String(cursor + page.length) : undefined
      return reply({ tools: page, ...(next ? { nextCursor: next } : {}) })
    }

    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      if (name === 'agent__capabilities') {
        const { faces, tools } = await allTools(identity, channel)
        const audience = audienceOf(channel)
        const locked = [...new Map(
          deps.faces()
            .filter((f) => f.face.audiences.includes(audience) && !identity.hasScope(f.face.scope))
            .map((f) => [`${f.moduleId}\0${f.face.face}`, { module: f.moduleId, face: f.face.face, scope: f.face.scope }]),
        ).values()]
        return reply({ content: [{ type: 'text', text: JSON.stringify({ faces: faces.map((f) => ({ module: f.moduleId, face: f.face.face, scope: f.face.scope })), tools: tools.map((x) => x.tool), lockedFaces: locked }) }], isError: false })
      }
      const { tools } = await allTools(identity, channel)
      const hit = tools.find((x) => x.tool.name === name)
      if (!hit) return rpcErr(-32601, 'method not found')
      if (!rateOk(identity, name)) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'error', reason: 'rate_limited' }) }], isError: true })
      }
      const original = name.slice(hit.face.moduleId.length + 2)
      const res = await rpc(hit.face, identity, channel, { jsonrpc: '2.0', id: msg.id, method: 'tools/call', params: { name: original, arguments: args } })
      if (res.status === 403) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'denied', reason: 'missing_scope', scope: hit.face.face.scope }) }], isError: true })
      }
      if (!res.ok) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'error', reason: 'module_unavailable' }) }], isError: true })
      }
      const body = await res.json() as { result?: unknown; error?: unknown }
      if (body.error) return c.json({ jsonrpc: '2.0', id: msg.id, error: body.error }, 200)
      return reply(body.result)
    }
    return rpcErr(-32601, 'method not found')
  })
  return app
}
```

注意 `allTools` 里重复调用了 `listFaceTools`（一次在 `tools`，一次在循环）；实现时可合并为一次：

```ts
const pairs = await Promise.all(faces.map(async (face) => ({ face, tools: await listFaceTools(face, identity) })))
const byName = new Map(...)
for (const { face, tools } of pairs) for (const tool of tools) ...
```

- [ ] **Step 4: 在 app.ts 挂 `/api/agent/*`**

在 `patIdentityMiddleware`/`wecomChannelIdentityMiddleware` 之后、`runtime.mount` 之前：

```ts
  app.use('/api/agent/*', patIdentityMiddleware({ ... }))      // 复用同一配置
  app.use('/api/agent/*', wecomChannelIdentityMiddleware({ ... }))
  app.route('/api/agent', agentMcpRoutes({
    faces: () => runtime.mcpFaces(),
    fetchModule: async (path, init) => app.request(path, init),
  }))
```

（`app.request` 的 `init` 类型为 `RequestInit`；网关的 `fetchModule` 签名与其兼容。）

⚠️ **内部转发必须带原请求的 `host` / `x-forwarded-host` 头**：宿主租户解析按 host，内部 `app.request` 的默认 host 会落到错误租户。实现时把 `const host = c.req.header('host') ?? ''` 传进 `internalHeaders`/`rpc`，并加 `host` 头；测试要覆盖“原 host = 租户域名”。

- [ ] **Step 5: 跑测试**

```bash
corepack pnpm --filter @platform/server exec vitest run src/routes/agent-mcp.test.ts
corepack pnpm --filter @platform/server exec tsc --noEmit
```

Expected: PASS / clean。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/agent-mcp.ts apps/server/src/routes/agent-mcp.test.ts apps/server/src/app.ts
git commit -m "feat(server): agent MCP 网关与能力目录 (#$ISSUE)"
```

---

### Task 5: data face（read/curated + faceScope + 工具级执法）

**Files:**
- Modify: `modules/data/skill/contract.ts`、`modules/data/skill/contract.json`
- Modify: `modules/data/domain/toolbox/registry.ts`
- Modify: `modules/data/routes/mcp.ts`
- Modify: `modules/data/index.ts`
- Modify: `modules/data/manifest.yaml`
- Test: `modules/data/routes/mcp-faces.test.ts`、`modules/data/domain/toolbox/registry.test.ts`

- [ ] **Step 1: 写失败测试**

`mcp-faces.test.ts`：用 `buildTestApp`/mock deps 断言：

```ts
it('/mcp-read 只回读工具；/mcp-curated 回 13+query_detail、无 legacy', async () => {
  // 省略装配，见既有 mcp.test.ts 的 buildTestApp/makeIdentity
  const read = await rpc(app, 'read', 'tools/list')
  expect(read.names).toContain('search_catalog')
  expect(read.names).not.toContain('query_metric')
  const curated = await rpc(app, 'curated', 'tools/list')
  expect(curated.names).toContain('query_metric')
  expect(curated.names).toContain('query_detail')
  expect(curated.names).not.toContain('lemeng__retail__sales') // legacy
})
it('callTool 缺工具级 scope ⇒ missing_scope', async () => {
  // data:read 调 query_metric（不在 read face，直接 unit 测 registry）
})
```

`registry.test.ts`：`callTool` 的 `requiredScope` 检查：

```ts
it('工具级 requiredScope 不满足 ⇒ denied/missing_scope', async () => {
  const deps = { ...baseDeps, requester: { ...requester, hasScope: () => false } }
  const out = await callTool(deps, 'query_metric', {})
  expect(out.payload).toMatchObject({ status: 'denied', reason: 'missing_scope' })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter data exec vitest run routes/mcp-faces.test.ts domain/toolbox/registry.test.ts
```

Expected: FAIL（新 face / scope 检查不存在）。

- [ ] **Step 3: `contract.ts` + `contract.json` 加 `faceScope`**

`ContractTool` 加：

```ts
  /** face 最低权限（data:read / data:query）；requiredScope 只放 face 之上的附加 scope */
  faceScope: 'data:read' | 'data:query'
```

`contract.json` 每个工具加 `"faceScope": "data:read"`（read 工具）或 `"data:query"`（query 工具）；`requiredScope` 均改为 `null`（read/query 由 face 门负责）。`contract.test.ts` 增加 `faceScope` 必填断言。

- [ ] **Step 4: `registry.ts`**

`ToolMeta` 加 `faceScope: 'data:read' | 'data:query'`；投影加 `faceScope: t.faceScope`。`callTool` 在 `if (!meta)` 后加：

```ts
  if (meta.requiredScope !== null && !deps.requester.hasScope(meta.requiredScope)) {
    return finish(
      { payload: { status: 'denied', reason: 'missing_scope', scope: meta.requiredScope, name }, isError: true },
      'denied', 'missing_scope',
    )
  }
```

（read/query 工具的 `requiredScope` 为 null，face 门负责；未来 `data:cost` 等附加 scope 用这个检查。）

加 `visibleAnalystTools(requester)`：

```ts
export function visibleAnalystTools(requester: Requester): readonly ToolMeta[] {
  return ANALYST_TOOLS.filter((t) => t.requiredScope === null || requester.hasScope(t.requiredScope))
}
```

- [ ] **Step 5: `mcp.ts` 三个 face**

把 `readToolset` 拆成 `makeToolset(face: 'full' | 'curated' | 'read')`：

- `full`：现有 `list()`（legacy + analyst + static）；`call()` 现有逻辑。
- `curated`：`analystListEntries()` + `STATIC_MCP_TOOLS`；`call()` 只允许 analyst 名 + `query_detail`（未知 ⇒ unknown_tool）。
- `read`：`analystListEntries().filter(t => (faceScopeOf(t) === 'data:read'))`；`call()` 只允许 read 工具（未知 ⇒ missing_scope/unknown_tool）。

在 `toListEntry` 里保留 `faceScope` 不外泄（MCP list 不带）；`read`/`curated` 的过滤用 `CONTRACT` 的 `faceScope`。

新增：

```ts
export function registerMcpRead(r: ModuleHono, ctx: RouteCtx): void { registerMcpEndpoint(r, '/mcp-read', ctx, readOnlyToolset) }
export function registerMcpCurated(r: ModuleHono, ctx: RouteCtx): void { registerMcpEndpoint(r, '/mcp-curated', ctx, curatedToolset) }
```

`registerMcp` 保留 `/mcp` full。

- [ ] **Step 6: `index.ts` + manifest**

`modules/data/index.ts` 加 `registerMcpRead`/`registerMcpCurated` 调用。`manifest.yaml` 的 `api.internal` 加：

```yaml
- { method: POST, path: /mcp-read,    scope: data:read }
- { method: POST, path: /mcp-curated, scope: data:query }
```

加 `mcpFaces`（见 spec §5.2）。

- [ ] **Step 7: 更新 data 内部 golden 快照（`faceScope` 新增）**

`registry.golden.test.ts` 会因 `ToolMeta` 多一个 `faceScope` 而红；这是内部元数据 shape 变化，**不是 MCP wire 变化**（`toListEntry` 仍只输出 name/title/description/inputSchema/outputSchema/annotations）。

```bash
corepack pnpm --filter data exec vitest run domain/toolbox/registry.golden.test.ts -u
corepack pnpm --filter data exec vitest run domain/toolbox/registry.golden.test.ts
```

Expected: 第二次不带 `-u` PASS；在提交说明里写“golden 仅新增 faceScope”。

- [ ] **Step 8: 跑测试 + 门禁**

```bash
corepack pnpm --filter data exec vitest run routes/mcp-faces.test.ts domain/toolbox/registry.test.ts
corepack pnpm exec tsx scripts/check-mcp-toolface.mjs
corepack pnpm exec tsx scripts/check-manifests.mjs
```

Expected: PASS / OK。

- [ ] **Step 9: 提交**

```bash
git add modules/data/skill/contract.ts modules/data/skill/contract.json modules/data/skill/contract.test.ts modules/data/domain/toolbox/registry.ts modules/data/domain/toolbox/registry.golden.test.ts modules/data/domain/toolbox/__snapshots__ modules/data/routes/mcp.ts modules/data/index.ts modules/data/manifest.yaml modules/data/routes/mcp-faces.test.ts
git commit -m "feat(data): agent read/curated face 与 faceScope (#$ISSUE)"
```

---

### Task 6: data 能力目录 + agent-loop 过滤 + 读面指南

**Files:**
- Modify: `modules/data/domain/toolbox/guide.ts`
- Modify: `modules/data/domain/agent-loop.ts`
- Modify: `modules/data/skill/content/mcp.md`（只读变体或追加提示）
- Modify: `modules/data/skill/render.ts`（如需 read 变体）

- [ ] **Step 1: `data_harness_catalog` 加 `faceScope` + `available`**

`harnessCatalogImpl` 接收 `deps`，按 `deps.requester.hasScope(t.requiredScope)` 与 `t.faceScope` 输出：

```ts
tools: ANALYST_TOOLS.map((t) => ({
  name: t.name, group: t.group, title: t.title, description: t.description,
  requiredScope: t.requiredScope, faceScope: t.faceScope,
  available: t.requiredScope === null || deps.requester.hasScope(t.requiredScope),
  mutating: t.mutating, annotations: t.annotations,
}))
```

- [ ] **Step 2: `agent-loop` 工具列表过滤**

找到 `agent-loop.ts` 里 `listAnalystTools` 的消费点，改为 `visibleAnalystTools(requester)`；若它把工具列表写进 SYSTEM_PROMPT，按过滤后的列表生成。

- [ ] **Step 3: 读面指南**

在 `content/mcp.md` 末尾追加（只读 face 的 `renderSkill('mcp')` 会包含；`/mcp-curated` 也包含，无妨）：

```markdown
> 只读面提示：`preview_query` / `query_metric` 等查询类工具需要 `data:query`；只读面看不到它们时，向管理员申请该权限。
```

- [ ] **Step 4: 测试 + 快照**

```bash
corepack pnpm --filter data exec vitest run domain/toolbox/guide.test.ts domain/agent-loop.test.ts
```

Expected: 更新 guide 快照（`-u` 一次）并说明变化；agent-loop 测试按过滤后的工具列表更新。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/toolbox/guide.ts modules/data/domain/agent-loop.ts modules/data/skill/content/mcp.md modules/data/**/__snapshots__ modules/data/domain/agent-loop.test.ts
git commit -m "feat(data): 能力目录 available/faceScope 与 agent-loop 过滤 (#$ISSUE)"
```

---

### Task 7: notify face（读面 + C channel 档 + namespace 钉死）

**Files:**
- Modify: `modules/notify/mcp-tools.ts`
- Modify: `modules/notify/mcp.ts`
- Modify: `modules/notify/routes.ts`（或 index）
- Modify: `modules/notify/manifest.yaml`
- Modify: `modules/notify/agent-actions.ts`
- Test: `modules/notify/mcp.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
// 复用本文件既有的 deps() 形状，增加 channel：
const depsCh = (channel: 'pat' | 'session' | 'wecom') => ({ ...deps(), channel })

it('wecom identity 只能看到 C-safe 工具；propose_rule/set_rule_enabled 不可见', () => {
  const names = toolDefs(depsCh('wecom')).map((t) => t.name)
  expect(names).toContain('create_agent_rule')
  expect(names).not.toContain('propose_rule')
  expect(names).not.toContain('set_rule_enabled')
})

it('wecom 直连不带 profile、伪造 full ⇒ 仍拒 propose_rule', async () => {
  const out = await callTool(depsCh('wecom'), 'propose_rule', {
    eventKey: 'x', recipientKey: 'y', templateKey: 'z', channels: ['inapp'],
  })
  expect(out.isError).toBe(true)
  expect(JSON.parse(out.text).reason).toBe('c_tool_not_allowed')
})

it('wecom create_agent_rule 落 pending，namespace 被钉死', async () => {
  process.env.NOTIFY_WECOM_NAMESPACE = 'openclaw-acme'
  // 传入别的 namespace 也应被覆盖；用测试库断言规则 namespace/owner 与回包 status='pending'
  // 具体断言按 create_agent_rule 的返回值形状写（回包含 status/approvalId/namespace）。
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter notify exec vitest run mcp.test.ts
```

Expected: FAIL。

- [ ] **Step 3: `mcp-tools.ts` 加 C-safe 集合与 profile**

```ts
export const C_SAFE_TOOLS = new Set([
  'list_events', 'get_event', 'list_rules', 'list_templates', 'get_template',
  'list_deliveries', 'check_rule', 'preview_template', 'send_test',
  'create_agent_template', 'create_agent_rule', 'send_message',
  // + SCHEDULE_TOOLS 的名字（在 mcp-tools.ts 末尾用 SCHEDULE_TOOLS 补）
])
export function toolsForChannel(channel: 'pat' | 'session' | 'wecom'): NotifyToolMeta[] {
  return channel === 'wecom' ? NOTIFY_TOOLS.filter((t) => C_SAFE_TOOLS.has(t.name)) : NOTIFY_TOOLS
}
```

（排班工具的名字从 `SCHEDULE_TOOLS` 取；在导出前构造 `C_SAFE_TOOLS` 时加入。）

- [ ] **Step 4: `mcp.ts` 按 channel 过滤与拒绝**

`McpDeps` 加 `channel: 'pat' | 'session' | 'wecom'`。`toolDefs(deps)` 用 `toolsForChannel(deps.channel)`；`callTool` 开头：

```ts
if (deps.channel === 'wecom' && !C_SAFE_TOOLS.has(name)) {
  return err('c_tool_not_allowed', { tool: name })
}
```

`create_agent_rule`/`create_agent_template`/`send_message` 的 namespace 改为：

```ts
const ns = deps.channel === 'wecom' ? process.env.NOTIFY_WECOM_NAMESPACE ?? '' : str(args.namespace)
if (!ns) return err('namespace_unconfigured')
```

`create_agent_rule` 在 wecom 下 `draftOnly: true`（传给 `createAgentRule`；在 `agent-actions.ts` 里该参数让规则落 `status='pending'`/disabled，并把 approval 走 N3）。

- [ ] **Step 5: 读面 `/mcp`**

`routes.ts` 加：

```ts
registerNotifyMcpRead(r, { pool, events, addresses, scheduler }, '/mcp')
```

读面：`toolsForChannel('pat').filter(t => !t.mutating)` + `notify:view` 门；`callTool` 只接受非 mutating。manifest `api.internal` 加 `POST /mcp, scope: notify:view`；`mcpFaces` 加 read/manage（B full / C c-manage 同 path/scope，audiences 不相交，profile 不同）。

- [ ] **Step 6: 跑测试 + 门禁**

```bash
corepack pnpm --filter notify exec vitest run mcp.test.ts
corepack pnpm exec tsx scripts/check-mcp-toolface.mjs
corepack pnpm exec tsx scripts/check-manifests.mjs
```

Expected: PASS / OK。

- [ ] **Step 7: 提交**

```bash
git add modules/notify/mcp-tools.ts modules/notify/mcp.ts modules/notify/routes.ts modules/notify/manifest.yaml modules/notify/agent-actions.ts modules/notify/mcp.test.ts
git commit -m "feat(notify): agent 读面与 C channel 档 (#$ISSUE)"
```

---

### Task 8: forms（FORMS_TOOLS + 读面 + 审计 + scope）

**Files:**
- Create: `modules/forms/mcp-tools.ts`
- Modify: `modules/forms/mcp.ts`
- Modify: `modules/forms/routes.ts`
- Modify: `modules/forms/manifest.yaml`
- Create: `modules/forms/migrations/002_forms_mcp_audit.sql`
- Modify: `modules/forms/storage.ts`
- Test: `modules/forms/mcp.test.ts`（追加）、`modules/forms/mcp-tools.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('FORMS_TOOLS 两个工具、命名合法、mutating 带 annotations/scope', () => {
  expect(FORMS_TOOLS.map((t) => t.name).sort()).toEqual(['generate_form_draft', 'list_forms'])
  const gen = FORMS_TOOLS.find((t) => t.name === 'generate_form_draft')!
  expect(gen.mutating).toBe(true)
  expect(gen.annotations?.readOnlyHint).toBe(false)
  expect(gen.requiredScope).toBe('forms:manage')
})
it('/mcp 只回 list_forms；/mcp-manage 两工具', async () => { ... })
it('forms:view 看不到 draft body；generate_form_draft 落 draft + forms.mcp_audit 一行', async () => { ... })
```

测试装配沿用 `modules/forms/mcp.test.ts` 的 `deps()`；新签名是 `toolDefs(face)` / `callTool(deps, face, name, args)`，`deps` 增加 `hasScope`（默认 `(code) => code === 'forms:manage'`）。

- [ ] **Step 2: 跑测试确认失败**

```bash
corepack pnpm --filter forms exec vitest run mcp.test.ts mcp-tools.test.ts
```

Expected: FAIL。

- [ ] **Step 3: `mcp-tools.ts`**

```ts
export const FORMS_MAX_TOOLS = 2
export type FormsToolMeta = { name: string; description: string; inputSchema: Record<string, unknown>; mutating: boolean; annotations: { readOnlyHint: boolean }; requiredScope: string | null; faceScope: 'forms:view' | 'forms:manage' }
export const FORMS_TOOLS: FormsToolMeta[] = [
  { name: 'list_forms', description: '列出本租户可查看的表单（摘要，不含 draft body）。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutating: false, annotations: { readOnlyHint: true }, requiredScope: null, faceScope: 'forms:view' },
  { name: 'generate_form_draft', description: '用自然语言生成表单契约并落为草稿；不会发布，需持 forms:publish 的人在控制台发布。', inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'], additionalProperties: false }, mutating: true, annotations: { readOnlyHint: false }, requiredScope: 'forms:manage', faceScope: 'forms:manage' },
]
```

- [ ] **Step 4: `mcp.ts`**

- `toolDefs(face: 'read' | 'manage')`: read ⇒ `list_forms`；manage ⇒ 两个。
- `callTool(deps, face, name, args)`：read 只允许 `list_forms`；manage 两个；`generate_form_draft` 检查 `deps.hasScope('forms:manage')`（缺失 ⇒ `missing_scope`）；每次调用写 `forms.mcp_audit`。
- `McpDeps` 加 `hasScope`.
- `registerFormsMcpRead` 与 `registerFormsMcpManage` 两个 shell（复用同一函数，参数 path/face）。

- [ ] **Step 5: 审计**

迁移：

```sql
create table if not exists forms.mcp_audit (
  id bigserial primary key,
  org text not null,
  user_id text not null,
  tool text not null,
  outcome text not null check (outcome in ('ok','denied','error')),
  reason text,
  asset_id text,
  version integer,
  created_at timestamptz not null default now()
);
create index if not exists forms_mcp_audit_org_idx on forms.mcp_audit (org, created_at desc);
```

`storage.ts` 加 `writeMcpAudit(pool, org, userId, tool, outcome, reason, assetId?, version?)`；`callTool` 在 `ok`/`err` 两个分支写。注意审计失败不能改变业务结果（try/catch 吞掉并 `console.warn`）。

- [ ] **Step 6: manifest + 路由**

`manifest.yaml`：
```yaml
- { method: POST, path: /mcp,        scope: forms:view }
- { method: POST, path: /mcp-manage, scope: forms:manage }
mcpFaces:
  - { face: read,   group: forms, precedence: 1, path: /mcp,        method: POST, scope: forms:view,   audiences: [mcp] }
  - { face: manage, group: forms, precedence: 2, path: /mcp-manage, method: POST, scope: forms:manage, audiences: [mcp, wecom] }
```

`routes.ts` 调 `registerFormsMcpRead(r, {...})`。

- [ ] **Step 7: `check-mcp-toolface.mjs` 纳入 forms**

```ts
import { FORMS_MAX_TOOLS, FORMS_TOOLS } from '../modules/forms/mcp-tools.ts'
...
...checkToolface(FORMS_TOOLS, { maxTools: FORMS_MAX_TOOLS }),
```

`check-mcp-toolface.test.ts` 更新。

- [ ] **Step 8: 跑测试 + 门禁**

```bash
corepack pnpm --filter forms exec vitest run
corepack pnpm exec tsx scripts/check-mcp-toolface.mjs
corepack pnpm exec tsx scripts/check-manifests.mjs
```

Expected: PASS / OK。

- [ ] **Step 9: 提交**

```bash
git add modules/forms/mcp-tools.ts modules/forms/mcp.ts modules/forms/routes.ts modules/forms/manifest.yaml modules/forms/migrations modules/forms/storage.ts modules/forms/mcp.test.ts modules/forms/mcp-tools.test.ts scripts/check-mcp-toolface.mjs scripts/check-mcp-toolface.test.ts
git commit -m "feat(forms): FORMS_TOOLS、读面与 MCP 审计 (#$ISSUE)"
```

---

### Task 9: openclaw `platform_capabilities` / `platform_call`

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/lib.js`
- Modify: `deploy/openclaw/data-query-plugin/index.js`
- Modify: `deploy/openclaw/data-query-plugin/openclaw.plugin.json`
- Modify: `deploy/openclaw/data-query-plugin/contracts.test.js`
- Create: `deploy/openclaw/data-query-plugin/platform-tools.test.js`

- [ ] **Step 1: 写失败测试**

```js
test('platform_call 不接受 userId；结果映射 content/isError', async () => { ... })
test('contracts.tools 含 platform_capabilities/platform_call', () => { ... })
```

- [ ] **Step 2: `lib.js` 加 JSON-RPC helper**

```js
export async function callGateway({ apiBase, channelKey, userId, sessionId, method, params, fetchImpl = fetch }) {
  if (!channelKey) return { error: 'CHANNEL_KEY_MISSING' }
  if (!userId) return { error: 'USERID_MISSING' }
  const res = await fetchImpl(`${apiBase}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-channel-key': channelKey,
      'x-wecom-userid': userId,
      ...(sessionId ? { 'x-session-id': String(sessionId) } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `oc-${Date.now()}`, method, params }),
  })
  return res.json()
}
export function toGatewayToolResult(rpc) {
  const r = rpc?.result
  if (!r) return { content: [{ type: 'text', text: JSON.stringify(rpc?.error ?? { status: 'error' }) }], isError: true }
  return { content: r.content ?? [{ type: 'text', text: JSON.stringify(r) }], isError: r.isError === true, ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}) }
}
```

- [ ] **Step 3: `index.js` 注册两个工具**

```js
const CAPS_DEF = { name: 'platform_capabilities', description: '列出当前企微用户可用的平台管理工具（指标/报表/通知/表单草稿）与缺失的 scope；先调它。', parameters: { type: 'object', properties: { q: { type: 'string' }, tool: { type: 'string' } }, additionalProperties: false } }
const CALL_DEF = { name: 'platform_call', description: '调用 platform_capabilities 返回的工具；tool 名必须来自列表；写操作只产草稿，发布/启用必须人做。', parameters: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object', additionalProperties: true } }, required: ['tool'], additionalProperties: false } }
```

`registerTool`：
- `platform_capabilities`: `callGateway({ method: 'tools/call', params: { name: 'agent__capabilities', arguments: {} } })`；按 `q`/`tool` 过滤；返回紧凑索引 + lockedFaces；`tool` 指定时再 `tools/list` 取 schema。
- `platform_call`: `callGateway({ method: 'tools/call', params: { name: tool, arguments: args } })`；`toGatewayToolResult`。

`AGENT_API_BASE` = `process.env.AGENT_API_BASE || 'http://server:13000/api/agent'`；`CHANNEL_KEY` 复用 `DATA_WECOM_CHANNEL_KEY`。

- [ ] **Step 4: manifest/contracts 更新**

`openclaw.plugin.json` `contracts.tools` 加两个；`contracts.test.js` 的 `known` 加两个。

- [ ] **Step 5: 跑测试**

```bash
cd deploy/openclaw/data-query-plugin && node ../../../scripts/gen-openclaw-skill.mjs --plugin-dir . && node --test
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add deploy/openclaw/data-query-plugin/lib.js deploy/openclaw/data-query-plugin/index.js deploy/openclaw/data-query-plugin/openclaw.plugin.json deploy/openclaw/data-query-plugin/contracts.test.js deploy/openclaw/data-query-plugin/platform-tools.test.js
git commit -m "feat(openclaw): platform_capabilities/platform_call 元工具 (#$ISSUE)"
```

---

### Task 10: openclaw SKILL / 部署文档

**Files:**
- Modify: `modules/data/skill/content/openclaw.md`
- Modify: `deploy/openclaw/data-query-plugin/README.md`
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`（生成物，不手改）

- [ ] **Step 1: 在 `content/openclaw.md` 加一节**

```markdown
## 平台能力管理（指标 / 报表 / 通知 / 表单草稿）

数据**查询**继续用上面的 search/query 工具；**创建/管理**走：
1. `platform_capabilities`：先看当前用户可用的管理工具与缺失的 scope；
2. `platform_call({ tool, args })`：只调列表里的工具。

硬纪律：
- 写操作先向用户确认；创建只产草稿。
- 报表发布、监控开启、通知规则启用、表单发布必须由人在控制台做；
- `missing_scope` 如实转告（告诉用户缺哪个 scope），不要换工具试；
- `asset_id_taken`/`TITLE_TAKEN` 先用 list 查重，不要原样重试。
```

- [ ] **Step 2: 重新生成 SKILL.md**

```bash
corepack pnpm gen:skill
```

Expected: `skills/data-query/SKILL.md` 更新（生成物，gitignored）。

- [ ] **Step 3: README 部署节**

补充：

```markdown
openclaw 服务 env 增加 `AGENT_API_BASE=http://server:13000/api/agent`；
`agents.entries.main.tools.allow` 增加 `platform_capabilities`、`platform_call`。
```

- [ ] **Step 4: 跑 skill 测试**

```bash
corepack pnpm --filter data exec vitest run skill/render.test.ts
```

Expected: PASS；若快照变化，先确认是新增章节，`-u` 一次并说明。

- [ ] **Step 5: 提交**

```bash
git add modules/data/skill/content/openclaw.md deploy/openclaw/data-query-plugin/README.md modules/data/skill/__snapshots__
git commit -m "docs(openclaw): 平台能力元工具 SKILL 与部署说明 (#$ISSUE)"
```

---

### Task 11: playbook 与架构文档

**Files:**
- Create: `docs/agent-playbook.md`
- Modify: `docs/architecture.md`（§1.5 加“能力网关”指针；§2.6/§14.6b 不改结论）
- Modify: `docs/module-protocol.md`（manifest `mcpFaces` 字段）

- [ ] **Step 1: 写 playbook**

包含：
- 入口：`/api/agent/mcp`，工具名 `<module>__<tool>`。
- B（PAT）与 C（openclaw）的身份差异。
- **C 不含 `send_message`**（C 角色不授 `notify:emit`）；C 的 notify 使用 **service-owned 钉死 namespace**（`NOTIFY_WECOM_NAMESPACE`，owner=`system:openclaw`），事件/模板/规则都在该 namespace 内闭环，规则一律 pending、启用/恢复需人持 `notify:publish`。
- scope 申请：`data:read/query/manage/cost`、`notify:view/manage/publish/emit`、`forms:view/manage/publish`。
- recipes：L2 指标、L1 提案、报表、通知草稿、表单草稿、（B）监控。
- 人 gate 表（与 spec §9 同表）。
- `missing_scope`/step-up、不重试、查重。
- 示例 JSON-RPC 调用（initialize/tools/list/tools/call）。
- 内部身份信任边界：`x-internal-identity` 是**进程内** HMAC（密钥 `randomBytes`，不落 env）；网关与模块必须**同进程/同副本**，拆进程或跨副本会验签失败（fail-closed，但功能中断）。进程内任何代码均可签发任意身份，勿把该密钥/签发能力暴露给不可信代码。

- [ ] **Step 2: architecture/module-protocol 指针**

`docs/architecture.md` §1.5 末尾加：

```markdown
### 1.5.1 agent 能力网关（2026-11-16）

B/C 的统一能力入口是 `POST /api/agent/mcp`；manifest `mcpFaces` 声明模块 face；网关只做投影/路由，
授权仍在模块。设计：`docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md`。
```

`docs/module-protocol.md` 加 `mcpFaces` 字段说明与校验规则（face/group/precedence/path/method/scope/audiences/profile）。

- [ ] **Step 3: 提交**

```bash
git add docs/agent-playbook.md docs/architecture.md docs/module-protocol.md
git commit -m "docs(data): agent playbook 与能力网关指针 (#$ISSUE)"
```

---

### Task 12: E2E 与全量验证

**Files:**
- Create: `apps/server/src/agent-mcp.e2e.test.ts`
- Modify: `.github/workflows/ci.yml`（仅当需要新 step；现有 gates 应自动覆盖）

- [ ] **Step 1: E2E 矩阵**

用现有 `data-query.e2e.test.ts` 的 mock Casdoor/tenant helpers，覆盖：

- PAT `data:read` only：`tools/list` 只有 read；`query_metric` 不可见；直接 call ⇒ `missing_scope`。
- PAT `data:query` only：read + query 工具；`data__customize_metric` 不可见。
- PAT `data:manage`：manage 面可见；`data__customize_metric` 可调（mock）。
- 企微 C：`platform_capabilities` 只 manage；直连 `/api/modules/notify/mcp-manage` 不带 profile、带 `full` ⇒ `propose_rule`/`set_rule_enabled` 仍拒。
- C 的 notify `create_agent_rule` 落 pending；namespace 钉死。
- forms `forms:view` 只 `list_forms`、看不到 draft body；`forms:manage` 可 draft；无 publish 工具。
- 网关伪造 `x-internal-identity` / `x-agent-profile` 被剥/拒。
- `agent__capabilities` 的 `lockedFaces` 与 `missing_scope` 一致。

- [ ] **Step 2: 跑 E2E**

```bash
corepack pnpm --filter @platform/server exec vitest run src/agent-mcp.e2e.test.ts
```

Expected: PASS（需要 `DATABASE_URL`；无库时按既有 e2e 门控跳过，记录）。

- [ ] **Step 3: 全量验证**

```bash
corepack pnpm run typecheck
corepack pnpm run test:guard
corepack pnpm --filter data test
corepack pnpm --filter notify test
corepack pnpm --filter forms test
corepack pnpm --filter @platform/server test
corepack pnpm exec tsx scripts/check-mcp-toolface.mjs
corepack pnpm exec tsx scripts/check-manifests.mjs
cd deploy/openclaw/data-query-plugin && node --test
cd /Users/buddybot/orca/workspaces/platform-core/MCP-及-skill
```

Expected: 全绿；已知的既有失败（如 `query-service.test.ts` 的 DB 门控）区分记录，不在本 PR 修。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/agent-mcp.e2e.test.ts
git commit -m "test(server): agent 能力网关 e2e 矩阵 (#$ISSUE)"
```

---

### Task 13: 收口与 PR

- [ ] **Step 1: 更新 spec/plan 指针**

在 spec 顶部加“实施计划：docs/superpowers/plans/2026-11-16-agent-capability-gateway.md”；plan 顶部记录 issue 号与分支。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md docs/superpowers/plans/2026-11-16-agent-capability-gateway.md
git commit -m "docs(data): 关联 agent 能力网关实施计划 (#$ISSUE)"
```

- [ ] **Step 3: 推送与 PR（不合并）**

```bash
git push -u origin agent-capability-gateway
gh pr create --head agent-capability-gateway --base main \
  --title "feat(data): agent 能力网关（统一 MCP + 能力目录）" \
  --body "设计：docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md
计划：docs/superpowers/plans/2026-11-16-agent-capability-gateway.md

- manifest mcpFaces + 网关 /api/agent/mcp（双身份 + 内部签名身份）
- data read/curated face + faceScope + 工具级 scope
- notify 读面 + C channel 档 + namespace 钉死（N3 之上）
- forms FORMS_TOOLS/读面/MCP 审计/草稿人 gate
- openclaw platform_capabilities/platform_call + SKILL

Closes #$ISSUE

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR 创建成功；**不合并**。

---

## 自检记录

- **Spec 覆盖**：manifest（Task 1）、loader（2）、内部身份（3）、网关/目录（4）、data（5/6）、notify（7）、forms（8）、openclaw（9/10）、playbook（11）、E2E（12）、PR（13）。
- **关键不变量**：C 的 notify 更严策略在 notify 模块按 `identity.channel` 执法（Task 7），不依赖网关头；namespace 钉死；`platform_capabilities` 用 `agent__capabilities`（Task 9）；网关不记 token/args；模块是唯一执法点。
- **与既有正典**：notify 复用 N1–N5（不新增 draft_rule/notify:publish）；监控引用业务监控 spec；调度引用 `platform.scheduler`。
- **无占位符**：每个 Task 给了文件、代码/转换规则、命令、预期；大文件改动给了精确函数/位置。
- **顺序**：Task 1–4 是网关地基；5–8 是模块 face；9–10 是 C 侧；11–13 收口。每个 Task 可独立测试。
