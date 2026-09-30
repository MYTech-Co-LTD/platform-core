# 报表编辑页反代会话 实施计划（报表制作域 3/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Metabase 的**编辑页**经一个专用入口搬进平台后台（spec §3⑦「甲」形态），落成三条硬约束：**① 专用入口（不挂子路径）② 认证走服务端会话 Cookie ③ 租户隔离由反代补**（只放行本租户已登记对象 + 封搜索面 + 页面壳也要判）。

**Architecture:**
- **专用入口 = 新增独立服务 `mb-proxy`**（部署单元 A：`deploy/docker-compose.yml` 内加第三个服务，复用 `deploy/Dockerfile.server` 的镜像、换 command），对外由 openship edge 路由到一个**每客户专用的 host**（如 `mb.<客户域>`）——Metabase 前端用**绝对路径**，所以入口必须在某个 host 的**根**上，不能挂子路径。
- **身份过桥 = 一次性 handoff**：console 点「编辑 Metabase」→ **模块**端点 `GET /reports/:id/edit-url`（`data:manage`）核对该行确实属于调用者 org 且 `renderer='metabase'` → 用 `PLATFORM_SESSION_SECRET` 签一枚**短时票据** `{org,did,nonce,exp}`（120s）→ 返回专用入口 URL；浏览器（顶层导航或同父域 iframe）访问 `/handoff?t=…`，代理验签 + 校验 nonce 未用过 + 设**自己的 host-only HttpOnly Cookie**（`SameSite=Lax; Secure`；同父域 ⇒ iframe 内也是同站，Cookie 照发）→ 302 到 `/dashboard/<did>`。**平台会话 Cookie 不扩散**（不设 Domain）。
- **代理由此不碰数据库**：身份来自票据/自有 Cookie，白名单来自票据里的**单个 dashboard id**（+ 该 dashboard 的卡片，由代理向 Metabase 上游读取）⇒ 代理**不需要** `DATABASE_URL`，也就天然规避了架构 lint 的 **B1**（`apps/` 只许 `platform` schema）。
- **票据由模块签**（人裁 2026-09-29）：登记表 `data.reports` 只有模块能读（B1），所以「本 org 已登记」这一判定只能发生在模块；模块已有一个同形先例（`signEmbedToken` 手搓 HS256）。代理侧**独立实现验签**，两侧用**同一金样本**钉住格式（见 Task 3）。

**Tech Stack:** Hono + node:crypto（HS256，照 `modules/data/domain/metabase.ts:449` 的 `signEmbedToken` 先例，不引 jose）+ node:http/fetch 流式透传；vitest（模块侧真库、代理侧纯内存 + 假 Metabase 桩）。

## Global Constraints

1. **spec §3⑦ 三条硬约束逐字**：① 必须专用入口，不能挂子路径（Metabase 前端用绝对路径，挂子路径整站资源 404）；② 认证必须走服务端会话 Cookie（页面自己发的异步请求**不带**地址栏令牌）；③ 租户隔离由反代补——只放行本租户**已登记**的对象、**封掉「列出全站」的搜索面**、**非接口的页面壳也要判**。
2. **锁定语义别误判**：编辑态下租户参数是**普通参数（可改、可为空）**，锁定只在「嵌入观看」时生效（spec §3⑦ 尾注）。
3. **架构 lint 归属（`scripts/lint-architecture.mjs`）**：
   - **B2**：`jose` / `jsonwebtoken` / 含 `casdoor` 的 import 只许 `packages/auth-core/**`；`@platform/auth-core` 只许 `apps/server` 引。⇒ 模块与代理**都不得**引 auth-core/jose（模块手搓 HS256 是本条下的既有先例 `signEmbedToken`；代理同理）。
   - **B1**：`apps/` 与 `packages/` 只许 `platform` schema。⇒ 代理**不写任何 SQL、不读 `data.reports`**（这是本设计让白名单走票据的原因，别「顺手加个库查询」）。
   - **B8**：源码里**不得**出现 `hookflow.cn` 或点分 IPv4 字面量（`127.0.0.1` 白名单）。⇒ 专用入口 origin、上游地址**一律走 env**，代码里零硬编码域名。
4. **compose 只许两份**（`scripts/check-compose.mjs` 的 `ALLOWED` 白名单）：新服务加进 `deploy/docker-compose.yml`，**不得**新增 compose 文件（含 `*fragment*` 路径）。该文件的 `ports` 必须：**每条都以 `127.0.0.1:` 开头**（判据 a），且只能是「缩进 4 的 `ports:` + 缩进 6 的 `- '…'`」块序列（判据 c，flow 形式与非 4 缩进一律违规）。
5. **新 env 键必须进根 `.env.example`**（B9，`scripts/check-env-example.mjs` 扫 `apps/ packages/ modules/` 下的 `.ts`）：本计划新增 **`MB_PROXY_PUBLIC_ORIGIN`**（模块用来拼 handoff URL）与 **`MB_PROXY_CONSOLE_ORIGIN`**（代理用来设 CSP `frame-ancestors`）。**复用**已有键：`PORT`、`PLATFORM_SESSION_SECRET`、`DATA_METABASE_URL`、`DATA_METABASE_API_KEY`——**不新增任何密钥**。
6. **deny-by-default**：代理的放行表是白名单，**每条必须写明用途**。**永久禁止**放行：枚举类面（`/api/search`、`/api/collection*`、`/api/table*`、`/api/database*`、`/api/user*`、`/api/setting*`、`/api/permissions*`）与**任意查询面**（`/api/dataset*`——那是「用编辑页自己写 SQL 查任意数据」的口子，与「只编辑已登记报表」的能力面不符）。
7. **凭据纪律**：代理对上游用 `DATA_METABASE_API_KEY`（与模块同一把，服务身份）；**绝不**把浏览器 Cookie（`platform_session` / `mb_edit`）转发给 Metabase。
8. **不碰数据面 compose**：`deploy/data-compose.yml` 一行不改（Metabase 侧配置不动）；平台↔Metabase 的网络接线走**部署 SOP**（照 `data-plane-deploy-sop.md` 的 P7 先例 `docker network connect`）。
9. **不在本计划范围**：写保护（计划 4）、agent 制作通路与语义源维度（计划 4）、审计（spec 无定义）、Metabase 侧的建表/建问题能力面（编辑页只编辑**已登记报表**）。
10. **提交**：Conventional Commits，每任务一提交，不删改 provenance trailer；feat/fix 的 PR body 要 `Closes #N`（本计划 PR 需先开对应 issue）。
11. **测试口径**：模块侧需 `DATABASE_URL`（shell 提供，正典值 `postgres://platform:platform@127.0.0.1:5432/platform`）；代理侧**不需要** DB。各测试文件用**互不相同**的 org 常量（防互相擦数据）。

---

### Task 1: 模块侧——handoff 票据 + `GET /reports/:id/edit-url`

**Files:**
- Create: `modules/data/domain/edit-handoff.ts`
- Modify: `modules/data/routes/reports.ts`（新增一个 GET 端点）
- Modify: `modules/data/manifest.yaml`（`api.internal` 加一行，**同一提交**）
- Modify: `.env.example`（加 `MB_PROXY_PUBLIC_ORIGIN`）
- Test: `modules/data/domain/edit-handoff.test.ts`（新建）+ `modules/data/routes/reports.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `getReport(pool, org, id)`、`requesterOf(c)`、`reportIdOf(...)`。
- Produces:
  - `signEditHandoff(input: { org: string; did: number; nonce: string }, secret: string, ttlSec?: number, now?: number): string`——HS256 JWT，payload `{org, did, nonce, iat, exp}`，**默认 ttl 120s**（Task 3 的代理验签要按同一格式实现）。
  - `GET /reports/:id/edit-url`（`data:manage`）→ `200 { url }`；`renderer='platform'` 的行 → `409 { error: 'RENDERER_NOT_EDITABLE' }`；跨租户/不存在 → `404 { error: 'NOT_FOUND' }`；`MB_PROXY_PUBLIC_ORIGIN` 未配 → `503 { error: 'EDIT_PROXY_UNCONFIGURED' }`。

- [ ] **Step 1: 写失败测试**（新建 `modules/data/domain/edit-handoff.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { signEditHandoff } from './edit-handoff'

const SECRET = 'test-secret-test-secret-test-secret!'

/** 独立解出 payload（不依赖被测实现的 decode 函数——那是自证） */
function payloadOf(token: string): Record<string, unknown> {
  const [h, p] = token.split('.')
  expect(h).toBe(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'))
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
}

describe('edit-handoff 票据', () => {
  it('payload 字段与 TTL：org/did/nonce + exp-iat=120', () => {
    const now = 1_700_000_000
    const t = signEditHandoff({ org: 'acme', did: 42, nonce: 'n-1' }, SECRET, 120, now)
    const p = payloadOf(t)
    expect(p).toMatchObject({ org: 'acme', did: 42, nonce: 'n-1', iat: now, exp: now + 120 })
  })

  it('签名是 HS256(**派生**子密钥)（独立复算，同时钉死 KDF 标签串）', () => {
    const t = signEditHandoff({ org: 'acme', did: 7, nonce: 'n-2' }, SECRET, 120, 1_700_000_000)
    const [h, p, s] = t.split('.')
    // 独立复算派生（不复用被测的 editHandoffKey）——把 'edit-handoff-v1' 这个标签也钉住
    const key = createHmac('sha256', SECRET).update('edit-handoff-v1').digest()
    expect(s).toBe(createHmac('sha256', key).update(`${h}.${p}`).digest('base64url'))
  })

  it('⚠️ 用**原始**密钥签同 payload ⇒ 与派生密钥的签名不同（域分隔真的生效）', () => {
    const t = signEditHandoff({ org: 'acme', did: 7, nonce: 'n-3' }, SECRET, 120, 1_700_000_000)
    const [h, p, s] = t.split('.')
    expect(s).not.toBe(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'))
  })

  it('★ 金样本（跨实现契约）：同一输入必须给出同一 token 串', () => {
    // 这串同时出现在 apps/mb-proxy/src/handoff.test.ts 里（Task 3）。
    // 任一侧改格式 ⇒ 另一侧红。改这一行必须同时改另一处。
    const t = signEditHandoff({ org: 'acme', did: 7, nonce: 'golden' }, SECRET, 120, 1_700_000_000)
    expect(t).toBe('<GOLDEN_TOKEN>')   // ← 首次实现后跑一次，把真实输出粘到这里与代理侧测试
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run domain/edit-handoff.test.ts`
Expected: FAIL（`signEditHandoff is not a function`）。

- [ ] **Step 3: 实现 `modules/data/domain/edit-handoff.ts`**

```ts
// edit-handoff.ts — 编辑页一次性票据（spec §3⑦ ②）。**手搓 HS256**：仓内先例见
// domain/metabase.ts 的 signEmbedToken（本仓禁 jose 出现在 packages/auth-core 之外，见
// scripts/lint-architecture.mjs 的 B2）——所以这里用 node:crypto 自己拼 JWT。
//
// 为什么由**模块**签而不是平台签：登记表 data.reports 只有模块能读（B1：apps/packages 只许
// platform schema）⇒「该 dashboard 确属本 org 且已登记」这一判定只能发生在这里。
import { createHmac, randomUUID } from 'node:crypto'

/** 编辑票据的存活秒数。**短**是安全设计的一部分：它只用来把身份一次性渡给反代。 */
export const EDIT_HANDOFF_TTL_SEC = 120

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

/**
 * 票据密钥：从 `PLATFORM_SESSION_SECRET` **派生**的子密钥（域分隔），**不是**直接复用原始密钥。
 *
 * ⚠️ 为什么必须派生（Task 1 评审 I-1/I-2，2026-09-29 人裁修）：原始密钥有**双向串用**风险——
 *   ① 票据（会出现在 URL 里）用原始密钥签的话，宿主会话验签 `verifySession` 会把 120s 票据
 *      当**合法会话**收下，甚至被「滑动续期」分支重签成 7 天 Cookie（空 scope 身份）；
 *   ② 反过来，任何登录用户的会话 Cookie（7 天、带 org）在代理眼里也是合法票据 ⇒ 只持 `data:query`
 *      的人可能绕过 `data:manage` 页门换到编辑会话。
 *   派生后两侧**互不承认**（密钥不同），且**不新增任何 env 密钥**（派生是确定性的，两侧同式）。
 */
export function editHandoffKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('edit-handoff-v1').digest()
}

/**
 * 签一枚编辑票据。payload `{org, did, nonce, iat, exp}`。
 * ⚠️ 格式是**跨包契约**：代理侧 `apps/mb-proxy/src/handoff.ts` 独立实现验签，两侧用同一金样本
 * 钉住（见两处测试里的 `<GOLDEN_TOKEN>`）。改这里必须同步改那边。
 */
export function signEditHandoff(
  input: { org: string; did: number; nonce: string },
  secret: string,
  ttlSec: number = EDIT_HANDOFF_TTL_SEC,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    org: input.org, did: input.did, nonce: input.nonce, iat: now, exp: now + ttlSec,
  }))
  // ⚠️ 用**派生**子密钥（editHandoffKey），不是 secret 本身——见函数头顶注（I-1/I-2）
  const sig = createHmac('sha256', editHandoffKey(secret)).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
```

- [ ] **Step 4: 跑测试确认绿，并**回填金样本**

Run: 同 Step 2。Expected: 前两条 PASS；第三条 FAIL（占位符不匹配）。
把 FAIL 输出里的实际 token 串**粘进**本文件与 `apps/mb-proxy/src/handoff.test.ts`（Task 3 创建，**同一个串**），再跑一次 → PASS。

- [ ] **Step 5: 写端点失败测试**（追加进 `modules/data/routes/reports.test.ts` 的 PG describe 内）

```ts
  it('★ GET /reports/:id/edit-url：本租户 metabase 行 → 200 + 票据可解出本 org', async () => {
    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test'
    const { app, identity } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()

    const res = await app.request(`/reports/${id}/edit-url`)
    expect(res.status).toBe(200)
    const { url } = await res.json() as { url: string }
    expect(url.startsWith('https://mb.example.test/handoff?t=')).toBe(true)
    const payload = JSON.parse(Buffer.from(url.split('t=')[1].split('.')[1], 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ org: identity.orgId })
    expect(payload.did).toBeGreaterThan(0)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
  })

  it('★ 负测：platform 行 409 / 跨租户 404 / 未配代理 origin 503', async () => {
    const { app, identity } = manage()
    const id = await upsertReport(pool, identity.orgId, {
      title: '自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(503)

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test'
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(409)

    const other = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] })).app
    const { id: realId } = await (await post(app, { title: '别租户看不见' })).json()
    expect((await other.request(`/reports/${realId}/edit-url`)).status).toBe(404)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
  })

  it('★ 负测（评审 I-3）：origin 非 https / 带尾斜杠 的形状都 fail-closed 或归一', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '形状用例' })).json()

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'http://mb.example.test'      // 非 https ⇒ 503（不许降级）
    expect((await app.request(`/reports/${id}/edit-url`)).status).toBe(503)

    process.env.MB_PROXY_PUBLIC_ORIGIN = 'https://mb.example.test///'  // 尾斜杠 ⇒ 归一，不许出 '//handoff'
    const { url } = await (await app.request(`/reports/${id}/edit-url`)).json() as { url: string }
    expect(url.startsWith('https://mb.example.test/handoff?t=')).toBe(true)
    delete process.env.MB_PROXY_PUBLIC_ORIGIN
  })
```

> ⚠️ 同文件既有的 `afterEach` 里**补上** `delete process.env.MB_PROXY_PUBLIC_ORIGIN`（与相邻的
> `DATA_METABASE_*` 卫生约定一致，评审 M-1）——别只靠每个用例自己删。

- [ ] **Step 5b: 宿主侧隔离测试（新建 `apps/server/src/edit-handoff-isolation.test.ts`）**

把 I-1 的修复**端到端钉住**：票据（派生密钥签）**不得**被会话验签接受。用金样本串做常量，**不** import
任何模块文件（宿主引模块内部是反向依赖）：

```ts
import { describe, expect, it } from 'vitest'
import { verifySession } from '@platform/auth-core'

// Task 1 回填的金样本（与 modules/data/domain/edit-handoff.test.ts 同一串、与代理侧测试同一串）
const GOLDEN_HANDOFF =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmciOiJhY21lIiwiZGlkIjo3LCJub25jZSI6ImdvbGRlbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMTIwfQ.<按你回填的签名>'
const SECRET = 'test-secret-test-secret-test-secret!'

describe('★ 票据与会话互不承认（域分隔，评审 I-1）', () => {
  it('编辑票据**不得**被 verifySession 接受（否则会被续签分支放大成 7 天会话）', async () => {
    expect(await verifySession(GOLDEN_HANDOFF, SECRET)).toBeNull()
  })
})
```

> ⚠️ 判据是「**同一个** root secret，票据仍不被会话验签接受」——所以 `SECRET` 必须与模块侧生成金样本
> 用的密钥**逐字相同**；否则验签失败只是因为密钥不对，这条测试就变恒真、咬不住 I-1。
> **变异确认（必须做）**：临时把 fixture 换成「同 payload 但用**原始** `SECRET` 签」的 token ⇒
> 这条测试**应变红**（`verifySession` 会接受它）——红了才证明它真的在测域分隔；确认后还原。

- [ ] **Step 6: 实现端点**（`routes/reports.ts`：import `signEditHandoff`；在 PUT handler 之后加）

```ts
  // ── 编辑页入口（spec §3⑦：把 Metabase 编辑页经反代搬进后台）─────────────────────────
  // 判定只能在这里做（登记表只有模块能读）；签一枚 120s 一次性票据，身份由**专用入口**的反代替换
  // 成它自己的 host-only Cookie（平台会话 Cookie 不设 Domain、不扩散）。
  r.get('/reports/:id/edit-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // ⚠️ fail-closed（评审 I-3）：缺配/形状不对一律 503——**不许** `?? ''` 用空密钥签票据，
    //    也不许把非 https 或带尾斜杠的 origin 直接拼进 URL。
    const proxyOrigin = process.env.MB_PROXY_PUBLIC_ORIGIN?.trim().replace(/\/+$/, '')
    const sessionSecret = process.env.PLATFORM_SESSION_SECRET ?? ''
    if (!proxyOrigin || !proxyOrigin.startsWith('https://') || sessionSecret.length < 32) {
      return c.json({ error: 'EDIT_PROXY_UNCONFIGURED' }, 503)
    }
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // platform 自绘行没有 Metabase dashboard（metabaseId=0 是哨兵）⇒ 没有可编辑的页
    if (row.renderer === 'platform') return c.json({ error: 'RENDERER_NOT_EDITABLE' }, 409)
    // 票据只绑 org + 单张 dashboard（不绑用户）：代理侧只按这两个维度授权，用户维度由本端点的
    // `data:manage` 页门把关。残余风险（同租户成员截获票据后 120s 内使用）由「短 TTL + 一次性
    // nonce + 入口即清 t + no-referrer」共同压缩——见 Task 3 与 spec §3⑦。
    const t = signEditHandoff(
      { org: requester.orgId, did: row.metabaseId, nonce: randomUUID() },
      sessionSecret,
    )
    return c.json({ url: `${proxyOrigin}/handoff?t=${t}` })
  })
```

（`randomUUID` 从 `node:crypto` import；`getReport` 从 `../domain/report-store` 追加 import。）

- [ ] **Step 7: manifest 同一提交**（`api.internal` 报表段加一行，列对齐）

```yaml
    - { method: GET,    path: /reports/:id/edit-url,  scope: data:manage }
```

- [ ] **Step 8: `.env.example` 加键**（B9；放报表那组旁边）

```
MB_PROXY_PUBLIC_ORIGIN=
```

- [ ] **Step 9: 跑测试确认绿 + 全模块**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data test`
Expected: PASS（含声明用例已改为八个端点——**记得把既有的「七个端点」断言同步改成八个**）。

- [ ] **Step 10: Commit**（路由 + manifest + 域文件 + 测试 + `.env.example` **同一提交**）

```bash
git add modules/data/domain/edit-handoff.ts modules/data/domain/edit-handoff.test.ts \
        modules/data/routes/reports.ts modules/data/routes/reports.test.ts \
        modules/data/manifest.yaml .env.example
git commit -m "feat(data): 编辑页一次性票据 + GET /reports/:id/edit-url（反代入口的第一步）"
```

---

### Task 2: 代理服务骨架 + 自有 Cookie 校验 + compose 接线

**Files:**
- Create: `apps/mb-proxy/package.json`、`apps/mb-proxy/tsconfig.json`、`apps/mb-proxy/vitest.config.ts`
- Create: `apps/mb-proxy/src/config.ts`、`apps/mb-proxy/src/session.ts`、`apps/mb-proxy/src/index.ts`
- Modify: `deploy/docker-compose.yml`（加 `mb-proxy` 服务）
- Modify: `.env.example`（加 `MB_PROXY_CONSOLE_ORIGIN`）
- Test: `apps/mb-proxy/src/session.test.ts`

**Interfaces:**
- Consumes: env `PORT`、`PLATFORM_SESSION_SECRET`、`MB_PROXY_CONSOLE_ORIGIN`、`DATA_METABASE_URL`、`DATA_METABASE_API_KEY`（后两个 Task 4 用）。
- Produces:
  - `loadProxyConfig(env = process.env)` → `{ port, sessionSecret, consoleOrigin, upstreamUrl, upstreamApiKey }`，缺必填即抛（照 `apps/server/src/config.ts` 的 fail-fast 风格）。
  - `EDIT_COOKIE = 'mb_edit'`；`serializeEditCookie(token)` / `clearEditCookie()`（host-only：**不设 Domain**；`Path=/; HttpOnly; Secure; SameSite=Lax`）。
  - 服务入口：`/healthz` → `{ok:true}`（**在任何鉴权之前**，照宿主 `app.ts:205` 的位置纪律）。
  - ⚠️ **「非 `/healthz` 一律 401」这条契约归 Task 4**（本任务只搭骨架，`index.ts` 里尚未挂鉴权中间件，所以此刻其余路径是 404）：Task 4 挂上鉴权后必须兑现——别以为 Task 2 已经做了。

- [ ] **Step 1: 写失败测试**（`apps/mb-proxy/src/session.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { EDIT_COOKIE, clearEditCookie, serializeEditCookie } from './session'

describe('mb_edit Cookie 序列化', () => {
  it('host-only + HttpOnly + Secure + SameSite=Lax（**不设 Domain**——不扩散到兄弟子域）', () => {
    const s = serializeEditCookie('tok')
    expect(s).toBe(`${EDIT_COOKIE}=tok; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`)
    expect(s).not.toMatch(/Domain=/i)
  })
  it('清除版 Max-Age=0', () => {
    expect(clearEditCookie()).toContain('Max-Age=0')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm --filter @platform/mb-proxy exec vitest run`
Expected: FAIL（包还不存在 / 函数未定义）。

- [ ] **Step 3: 建包骨架**

`apps/mb-proxy/package.json`（照 `apps/server/package.json` 的字段风格；**name 用 `@platform/mb-proxy`**，加 `"private": true`、`"type": "module"`，scripts `{ "start": "tsx src/index.ts", "test": "vitest run", "typecheck": "tsc --noEmit" }`；**deps 只需 `hono` + `@hono/node-server`**（`src/index.ts` 用 `serve`）——**不要 `pg`**（Constraint 3：代理不碰数据库）；devDeps 照 `apps/server` 抄 `tsx`/`vitest`/`typescript`/`@types/node`）。改完跑一次 `pnpm install` 让 `pnpm-lock.yaml` 同步（**lock 要一起提交**，CI 与镜像构建都跑 `--frozen-lockfile`）。

`apps/mb-proxy/tsconfig.json`：照 `apps/server/tsconfig.json` 抄（extends 仓根 `tsconfig.base.json`）。

`apps/mb-proxy/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', fileParallelism: false } })
```

- [ ] **Step 4: 实现 `src/config.ts` + `src/session.ts` + `src/index.ts`**

`src/session.ts`（Cookie 名与序列化；`EDIT_TTL_SEC = 28800` = 8 小时）：

```ts
// session.ts — 反代**自己的**第一方会话 Cookie（spec §3⑦ ②）。它**不是**平台会话：
// 平台会话 Cookie 不设 Domain（host-only），专用入口收不到；一次性 handoff 兑换后由这里发一枚
// 同名不同命的自有 Cookie，浏览器只跟专用入口说话。
export const EDIT_COOKIE = 'mb_edit'
export const EDIT_TTL_SEC = 28800

export function serializeEditCookie(token: string): string {
  return `${EDIT_COOKIE}=${token}; Path=/; Max-Age=${EDIT_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
}
export function clearEditCookie(): string {
  return `${EDIT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}
```

`src/config.ts`（fail-fast；**B8：不硬编码域名**）：

```ts
/** 代理的 env 契约。缺必填一律启动期抛（照 apps/server/src/config.ts 的口径）。 */
export interface ProxyConfig {
  port: number
  sessionSecret: string
  consoleOrigin: string
  upstreamUrl: string
  upstreamApiKey: string
}

export function loadProxyConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  // ⚠️ 访问器**必须叫 `requireValue`**（就是宿主 `apps/server/src/config.ts:62` 那个名字）：
  //    B9 门禁只认四种**读法构造**——点号取 env、方括号取 env、以及按**标识符**匹配的
  //    `requireValue(<键名>)` / `optional(<键名>)`。自己起名 `need(...)` ⇒ 这些键**不被机械守住**
  //    （删掉 `.env.example` 里的声明，门禁也照样绿，只靠人记得）。
  //    ⚠️ 这条注释本身也踩过坑：B9 **不剥注释**（与 lint-architecture 的注释掩码不同）⇒ 在注释里
  //    写「点号取 env 的范例」会被当成真读法、报出「KEY 未声明」的假阳性。所以本文件里**只写
  //    `<键名>` 占位**，别写真实形态的范例（改回去必红）。
  const requireValue = (k: string): string => {
    const v = env[k]
    if (v === undefined || v.trim() === '') throw new Error(`缺少必填环境变量 ${k}`)
    return v
  }
  const secret = requireValue('PLATFORM_SESSION_SECRET')
  if (secret.length < 32) throw new Error(`PLATFORM_SESSION_SECRET 至少 32 字符（当前 ${secret.length}）`)
  const port = Number(requireValue('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT 必须是 1-65535 的整数`)
  return {
    port,
    sessionSecret: secret,
    consoleOrigin: requireValue('MB_PROXY_CONSOLE_ORIGIN'),
    upstreamUrl: requireValue('DATA_METABASE_URL').replace(/\/+$/, ''),
    upstreamApiKey: requireValue('DATA_METABASE_API_KEY'),
  }
}
```

`src/index.ts`（骨架；T3/T4 往 `app` 里挂 handoff 与授权中间件）：

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { loadProxyConfig } from './config'

export const app = new Hono()
// ① /healthz 在鉴权之前（照宿主 app.ts:205 的位置纪律：探活不带业务身份）
app.get('/healthz', (c) => c.json({ ok: true }))
// ② T3 挂 /handoff（兑换）；③ T4 挂鉴权中间件 + 授权规则表 + 上游透传

const cfg = loadProxyConfig()
serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`[mb-proxy] listening on http://127.0.0.1:${i.port}`)
})
```

- [ ] **Step 5: compose 加服务**（`deploy/docker-compose.yml`，加在 `server` 之后；**ports 判据 a/c：回环前缀 + 缩进 4/6**）

```yaml
  # 报表编辑页专用入口（spec §3⑦）：反代会话。与 server 同镜像、换 command。
  # 对外由 edge 路由到一个每客户专用 host（部署 SOP 见 deploy/data-plane-deploy-sop.md）。
  mb-proxy:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.server
    image: platform-core-mb-proxy:local
    # ⚠️ **必须覆盖 command**：Dockerfile.server 的 CMD 是跑 @platform/server（`Dockerfile.server:118`），
    #    不覆盖的话这个容器会把**平台宿主**再起一遍（同镜像、错入口）。
    command: ['pnpm', '--filter', '@platform/mb-proxy', 'start']
    # ⚠️ **`profiles` 只是本机 `docker compose` 的默认启停语义，不是部署闸门**（2026-09-29 生产实测，issue #369）：
    #    `MB_PROXY_CONSOLE_ORIGIN`（+ 复用的 `PLATFORM_SESSION_SECRET`/`DATA_METABASE_URL`/`DATA_METABASE_API_KEY`），
    #    而这些是**每客户**才备的；`MB_PROXY_PUBLIC_ORIGIN` 只被**模块端点**（Task 1）读，不是代理的启动前提。
    #    openship **按服务清单逐服务显式启停**、**不认 `profiles`** ⇒ 合并当天它照样被拉起、缺 env 即
    #    crash loop（**实测：13 次重启 + 健康看板开事故 + 发出通知**）。
    #    **真正的闸门 = openship 服务级 `enabled`**（默认 false；启用某客户时先备 env 再置 true）。
    profiles: ['edit-proxy']
    env_file:
      - path: ../.env
        required: false
    environment:
      PORT: '13010'
    ports:
      - '127.0.0.1:13010:13010'
    restart: unless-stopped
```

**（订正记录 2026-09-29，issue #369：下面这段原写「profile 让服务声明在案但不默认启动」——**已被生产证伪**，
别照旧稿理解）**：`profiles` 只对**本机 `docker compose`** 的默认启停有效；**openship 不认它** ⇒ 闸门必须落在
**服务级 `enabled`** 上。原稿误以为「漏挂 profile 的后果是生产 crash loop」，实际「挂了也一样」（未配 env ⇒
`loadProxyConfig` 启动期抛 ⇒ 容器反复重启 ⇒ 健康看板报事故）。

（**不加** `depends_on`：代理不碰数据库、不依赖 server。探活由镜像自带的 HEALTHCHECK（`Dockerfile.server:113-118` 的 `wget /healthz`，端口读 `${PORT}`）覆盖。）

- [ ] **Step 6: `.env.example` 加键**

```
MB_PROXY_CONSOLE_ORIGIN=
```

- [ ] **Step 7: 跑测试 + 守卫 + typecheck**

Run:
```bash
pnpm --filter @platform/mb-proxy exec vitest run
pnpm typecheck
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
```
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add apps/mb-proxy deploy/docker-compose.yml .env.example pnpm-lock.yaml
git commit -m "feat(mb-proxy): 编辑页反代服务骨架（自有 Cookie + /healthz + compose 服务）"
```

---

### Task 3: handoff 兑换（一次性 nonce + 设自有 Cookie + 302）

**Files:**
- Create: `apps/mb-proxy/src/handoff.ts`
- Create: `apps/mb-proxy/src/app.ts`——**抽成工厂 `export function createApp(cfg: ProxyConfig): Hono`**
  （⚠️ 订正记录 2026-09-29：原稿写「导出 app」。**必须**是工厂——模块级 `app` 在 import 期就要全量
  env（`loadProxyConfig()` 会抛），拆分的目的就落空了），`index.ts` 只留 `loadProxyConfig()` + `serve()`
  （Task 2 的 `index.ts` 顶层就 `serve()`，HTTP 级测试会**真绑端口**；照 `apps/server` 的
  `app.ts`/`index.ts` 分工。Task 2 的 `app.get('/healthz')` 随之搬到 `app.ts`）
- Modify: `apps/mb-proxy/src/index.ts`（import `app` 并 serve）
- Test: `apps/mb-proxy/src/handoff.test.ts`

**Interfaces:**
- Consumes: Task 1 的票据格式（`{org,did,nonce,iat,exp}`，HS256 + `PLATFORM_SESSION_SECRET`）。
- Produces:
  - `verifyEditHandoff(token: string, secret: string, now?: number): {org:string;did:number;nonce:string} | null`——**验签 + 校验 exp**；失败一律 null（照 `packages/auth-core/src/session.ts:60` 的风格：不抛）。
  - `claimNonce(nonce: string, now?: number): boolean`——**一次性**：首次 true，之后 false；进程内 `Map<string, number>` + 过期清理（TTL 120s）。
  - `GET /handoff?t=<token>` → 成功：`Set-Cookie: mb_edit=…` + `302 Location: /dashboard/<did>`；失败：`401 {error:'INVALID_HANDOFF'}`（**不**设 Cookie）。

- [ ] **Step 1: 写失败测试**（`apps/mb-proxy/src/handoff.test.ts`）

```ts
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { claimNonce, verifyEditHandoff } from './handoff'
import { signForTest } from './test-sign'   // 测试专用：与模块 signEditHandoff 同算法的**极小**复刻
                                            // ⚠️ 它也必须走**派生**子密钥（同 'edit-handoff-v1' 标签），
                                            //    否则「坏签名 ⇒ null」那条会因为密钥不对而恒真

const SECRET = 'test-secret-test-secret-test-secret!'

describe('handoff 验签', () => {
  it('★ 金样本（与 modules/data/domain/edit-handoff.test.ts 同一个串）', () => {
    const t = '<GOLDEN_TOKEN>'   // ← 与模块侧测试里的**同一个** token 串
    // ⚠️ 订正记录（2026-09-29，Task 3 实施中发现）：原稿这里写 `now = 1_700_000_120`，而该串的
    //    `exp` 恰是 1_700_000_120 ⇒ 按下面实现的 `exp <= now ⇒ 过期` 语义，这条**必然失败**（自相矛盾）。
    //    契约是「exp 当秒即失效」（半开区间），故断言取**到期前 1 秒**，边界单独钉一条：
    expect(verifyEditHandoff(t, SECRET, 1_700_000_119)).toMatchObject({ org: 'acme', did: 7, nonce: 'golden' })
    expect(verifyEditHandoff(t, SECRET, 1_700_000_120)).toBeNull()   // ★ 边界：exp 当秒即过期
  })

  it('坏签名 / 过期 / 结构错 ⇒ null（不抛）', () => {
    const good = signForTest({ org: 'a', did: 1, nonce: 'n' }, SECRET, 60, 1000)
    expect(verifyEditHandoff(good + 'x', SECRET, 1000)).toBeNull()
    expect(verifyEditHandoff(good, SECRET, 1061)).toBeNull()          // exp=1060 < now
    expect(verifyEditHandoff('not-a-jwt', SECRET, 1000)).toBeNull()
    expect(verifyEditHandoff(good, 'another-secret-another-secret!!', 1000)).toBeNull()
  })

  it('★ 域分隔（评审 I-1/I-2）：**会话形状**的 token（原始密钥签、有 org/scopes/exp、无 did/nonce）⇒ null', async () => {
    // 这是「只持 data:query 的登录用户拿自己的会话 Cookie 当票据使」的攻击面
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', org: 'acme', name: '路人', scopes: ['data:query'], authVia: 'password',
      iat: 1000, exp: 9_999_999_999, sfa: 1000,
    })).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
    expect(verifyEditHandoff(`${header}.${payload}.${sig}`, SECRET, 1000)).toBeNull()
  })
})

describe('nonce 一次性', () => {
  it('首次 true、重复 false', () => {
    expect(claimNonce('n-once', 1000)).toBe(true)
    expect(claimNonce('n-once', 1000)).toBe(false)
  })
  it('过期后可再用同一 nonce（窗口只有 TTL，无状态可丢）', () => {
    expect(claimNonce('n-ttl', 1000)).toBe(true)
    expect(claimNonce('n-ttl', 1000 + 121)).toBe(true)
  })
})
```

（`src/test-sign.ts`：测试专用签名器，**只在测试里用**——实现体与 Task 1 的 `signEditHandoff` 同形；它的存在只是为了不把模块的代码搬进代理包。生产代码路径里代理**只验不签**。）

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm --filter @platform/mb-proxy exec vitest run`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/handoff.ts`**

```ts
// handoff.ts — 一次性票据的**验签**侧（票据由模块签，见 modules/data/domain/edit-handoff.ts）。
// 代理只验不签：它没有签的能力，也就没有「自己给自己发身份」的面。
import { createHmac, timingSafeEqual } from 'node:crypto'

interface HandoffClaims { org: string; did: number; nonce: string }

const b64urlToBuf = (s: string): Buffer => Buffer.from(s, 'base64url')

/**
 * 票据密钥 = 从 root secret **派生**的子密钥，**与模块侧同式**（`'edit-handoff-v1'` 标签必须逐字相同）。
 * 域分隔保证：会话 Cookie（原始密钥签）在这里**验不过**，票据在宿主会话验签那边也**验不过**（评审 I-1/I-2）。
 */
function handoffKey(rootSecret: string): Buffer {
  return createHmac('sha256', rootSecret).update('edit-handoff-v1').digest()
}

/** 验签 + 校验 exp。任何失败返回 null（不抛——照 auth-core 的 verifySession 风格）。 */
export function verifyEditHandoff(token: string, secret: string, now?: number): HandoffClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  const expect = createHmac('sha256', handoffKey(secret)).update(`${h}.${p}`).digest()
  const got = b64urlToBuf(s)
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
  try {
    const header = JSON.parse(b64urlToBuf(h).toString('utf8')) as { alg?: string }
    if (header.alg !== 'HS256') return null
    const c = JSON.parse(b64urlToBuf(p).toString('utf8')) as Record<string, unknown>
    const exp = Number(c.exp)
    if (!Number.isFinite(exp) || exp <= (now ?? Math.floor(Date.now() / 1000))) return null
    if (typeof c.org !== 'string' || !c.org) return null
    if (!Number.isInteger(c.did)) return null
    if (typeof c.nonce !== 'string' || !c.nonce) return null
    return { org: c.org, did: c.did as number, nonce: c.nonce }
  } catch {
    return null
  }
}

const used = new Map<string, number>()
const NONCE_TTL_SEC = 120

/** 一次性判定：首次 true。⚠️ 进程内状态 ⇒ 重启后同一 nonce 在 TTL 内可再用一次（窗口 120s，可接受）。 */
export function claimNonce(nonce: string, now = Math.floor(Date.now() / 1000)): boolean {
  for (const [k, exp] of used) if (exp <= now) used.delete(k)
  if (used.has(nonce)) return false
  used.set(nonce, now + NONCE_TTL_SEC)
  return true
}
```

- [ ] **Step 4: 挂 `/handoff`**（`src/index.ts`）

```ts
app.get('/handoff', (c) => {
  const t = c.req.query('t') ?? ''
  const claims = verifyEditHandoff(t, cfg.sessionSecret)
  if (claims === null || !claimNonce(claims.nonce)) {
    return c.json({ error: 'INVALID_HANDOFF' }, 401)
  }
  // 兑换：发**自己的**会话票据（同样 HS256，但用途是代理侧会话，不是 handoff）
  const session = signProxySession({ org: claims.org, did: claims.did }, cfg.sessionSecret)
  return new Response(null, {
    status: 302,
    headers: { 'set-cookie': serializeEditCookie(session), location: `/dashboard/${claims.did}` },
  })
})
```

（`signProxySession` 放 `src/handoff.ts`：payload `{org, did, iat, exp: now+EDIT_TTL_SEC}`——**不含 nonce**（会话可复用）。
Task 4 的鉴权中间件用它解身份——**必须**用同一个导出 `proxySessionKey`。）

⚠️ **订正记录（2026-09-29，Task 3 实施中发现）**：`signProxySession` **也必须用派生密钥**
（标签串 `'mb-edit-session-v1'`，独立于 `'edit-handoff-v1'`）：不派生的话，宿主会话验签
`verifySession` 会把这枚 8 小时 Cookie 当成**合法平台会话**收下（空 scope 身份）——与 Task 1
修掉的 I-1 同一类串用，只是方向相反。导出 `proxySessionKey(rootSecret)` 供 Task 4 与测试独立复算。
测试要照 Task 1 的做法：**独立复算**派生（不复用被测函数），并断言「原始密钥签同 payload ⇒ 签名不同」。

- [ ] **Step 5: 跑测试确认绿**

Run: `pnpm --filter @platform/mb-proxy exec vitest run` → PASS；`pnpm typecheck` → OK。

- [ ] **Step 6: Commit**

```bash
git add apps/mb-proxy/src/handoff.ts apps/mb-proxy/src/handoff.test.ts apps/mb-proxy/src/test-sign.ts \
        apps/mb-proxy/src/app.ts apps/mb-proxy/src/index.ts   # ⚠️ app.ts 别漏（订正记录：原稿漏了它）
git commit -m "feat(mb-proxy): handoff 兑换（验签+一次性 nonce+自有 Cookie+302）"
```

---

### Task 4: 授权规则表（deny-by-default）+ 上游透传

**Files:**
- Create: `apps/mb-proxy/src/rules.ts`（规则表，**纯函数、可单测**）、`apps/mb-proxy/src/upstream.ts`（透传 + 头改写）
- Modify: `apps/mb-proxy/src/app.ts`（鉴权中间件 + 规则中间件 + 兜底——⚠️ 订正记录 2026-09-29：
  原稿写 `index.ts`，但 Task 3 已把组装搬进 `createApp(cfg)` 工厂，这里要改的是 **app.ts**）
- Test: `apps/mb-proxy/src/rules.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `verifyEditHandoff`/`signProxySession`。
- Produces:
  - `decide(path: string, method: string, ctx: { did: number; cards: ReadonlySet<number> }): 'allow' | 'deny'`——**纯函数**（Task 4 的全部安全逻辑都在这里，便于穷举测试）。
  - `GET <upstream>/api/dashboard/<did>` 取 dashcards → `Set<cardId>`（带 60s 缓存），供 `decide` 用。
  - 兜底：`decide` 之外的一切请求 → `403 {error:'NOT_ALLOWED'}`。

- [ ] **Step 1: 写规则表测试**（先写测试，穷举放行/拒绝面）

> ⚠️ **订正记录（2026-09-29，Task 4 实施中由变异确认挖出）**：**判定路径必须先归一化，且判的路径
> = 上行给 Metabase 的路径**。实测 Hono 的 `c.req.path` 只走 `decodeURI`、**不解析 `%2f`** ⇒
> `GET /app/..%2f..%2fapi/search` 会**命中 `/app/` 前缀被放行（200）并原样上行**，
> 「封枚举面」那条被整条绕过。修法：加 `normalizePath()`（拒绝任何仍含 `%` 的路径 = fail-closed，
> 其余解析出 `..`/`.` 段并归约），**规则表与透传共用同一个归约结果**。
> 测试必须含这条绕过样本（`/app/..%2f..%2fapi/search` ⇒ deny）与「含 `%` 的合法路径被拒」的取舍断言。

```ts
import { describe, expect, it } from 'vitest'
import { decide } from './rules'

const ctx = { did: 7, cards: new Set([70, 71]) }
const allowed = [
  ['GET', '/'],
  ['GET', '/favicon.ico'],
  ['GET', '/app/dist/main.js'],
  ['GET', '/static/app-main.js'],
  ['GET', `/dashboard/${ctx.did}`],
  ['GET', `/api/dashboard/${ctx.did}`],
  ['GET', `/api/dashboard/${ctx.did}/dashcard/3/card/70/query`],
  ['POST', `/api/card/70/query`],
  ['GET', '/api/session/properties'],
] as const
const denied = [
  // ① 枚举面（spec §3⑦ ③：封掉「列出全站」的口子）
  ['GET', '/api/search'],
  ['GET', '/api/collection/1/items'],
  ['GET', '/api/collection/root/items'],
  ['GET', '/api/table'],
  ['GET', '/api/database'],
  ['GET', '/api/user'],
  ['GET', '/api/setting'],
  ['GET', '/api/permissions/group'],
  // ② 任意查询面（「用编辑页自己写 SQL 查任意数据」的口子）
  ['POST', '/api/dataset'],
  ['POST', '/api/dataset/csv'],
  // ③ 别的对象（本票据只授权这一张）
  ['GET', '/dashboard/8'],
  ['GET', '/api/dashboard/8'],
  ['GET', '/question/99'],
  ['GET', '/api/card/99/query'],
  ['GET', '/api/card/70'],          // 卡片**内容**面：只放行它的 query，不放行卡片本身（避免改查询）
  // ④ 页面壳也要判（非白名单路径一律拒）
  ['GET', '/collection/1'],
  ['GET', '/admin/settings'],
] as const

describe('deny-by-default 规则表', () => {
  it.each(allowed)('放行 %s %s', (m, p) => expect(decide(p, m, ctx)).toBe('allow'))
  it.each(denied)('拒绝 %s %s', (m, p) => expect(decide(p, m, ctx)).toBe('deny'))
  it('未知路径一律 deny（兜底）', () => {
    expect(decide('/whatever/unknown', 'GET', ctx)).toBe('deny')
  })
})
```

- [ ] **Step 2: 跑测试确认红** → `pnpm --filter @platform/mb-proxy exec vitest run`，FAIL。

> ⚠️ **订正记录（2026-09-29，Task 4 评审轮，四条一并做）**：
> 1. **卡片集合缓存键必须带 org**（`${org}:${did}`）：现在只有 `did`，靠「did 全局唯一 + 单实例单 key」
>    两个未落码的前提才不串味——把那两个前提写进缓存键更省心。
> 2. **`cfg.consoleOrigin` 要校验形状**（`https://` 起头 + 去尾斜杠，照 `DATA_METABASE_URL` 的归一）：
>    配错时现在的后果是「CSP 失效 + XFO 已剥」= 任意站可 iframe（fail-open）。
> 3. **透传响应也加 `Cache-Control: no-store`**（与 401/403/handoff 口径一致）。
> 4. **`claims.org` 解出来但没人用**：那是**有意的**——隔离由 Task 1 在**签发侧**按会话 org 定死，
>    代理只认「票据里那一张 dashboard」。要在代码里写一句注释说明，别让后人以为是漏用。


- [ ] **Step 3: 实现 `src/rules.ts`**

```ts
// rules.ts — 反代的授权规则表（spec §3⑦ ③）。**deny-by-default**：不在放行表里的一律拒。
//
// 设计上只授权**票据里那一张 dashboard**（+ 它的卡片的 query 面）：比「本租户全部已登记对象」
// 更严，代价是编辑页里不能跳去别的报表（console 列表才是导航面，每张各自领一张票据）。
// 每条放行都必须写明用途；枚举类与任意查询类**永久禁止**（见 denied 测试的注释）。
//
// ⚠️ **两条订正记录（2026-09-29，Task 4 评审轮）**：
//   ① **归一化必须按「段白名单」收口**，不能只折精确 `..` 段——实测 `/app/..;/api/search`、
//      `/app/..%20/api/search`、`/app/..%00/api/search` 都能满足 `/app/` 前缀而被放行并上行
//      （上游 Jetty 对 `;`/空白/NUL 的 canonicalization 不可控 ⇒ 不能赌它）。任何含白名单外
//      字符的段**整条路径拒**（含 `%`：合法路径里几乎不出现，fail-closed 的代价可接受）。
//   ② **dashcard 路径必须同时校验卡片归属**（`cid ∈ cards`），否则「卡片集合」那道 fail-closed
//      门形同虚设（只判 did 时，任何卡片 id 都能借本 dashboard 的壳上行）。
const SEG_RE = /^[A-Za-z0-9._~-]+$/

/** 归约路径；任何不合规段返回 null（= 调用方按 deny 处理）。判定与上行**共用**它的结果。 */
export function normalizePath(rawPath: string): string | null {
  const out: string[] = []
  for (const seg of rawPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (out.length === 0) return null; out.pop(); continue }
    if (!SEG_RE.test(seg)) return null          // '..;' / '%20' / '%00' / 空白 / 非 ASCII 一律拒
    out.push(seg)
  }
  return '/' + out.join('/')
}

const SHELL_PREFIXES = ['/app/', '/static/', '/assets/'] as const
const SHELL_EXACT = new Set(['/', '/index.html', '/favicon.ico', '/api/session/properties'])
const SHELL_METHODS = new Set(['GET', 'HEAD'])   // 壳/静态只读：PUT/DELETE /app/** 不放行

export function decide(
  path: string, method: string, ctx: { did: number; cards: ReadonlySet<number> },
): 'allow' | 'deny' {
  const isRead = SHELL_METHODS.has(method)
  if (SHELL_EXACT.has(path) && isRead) return 'allow'
  if (isRead && SHELL_PREFIXES.some((p) => path.startsWith(p))) return 'allow'

  // 本票据授权的那张 dashboard：页面 + 它的 API
  if (isRead && path === `/dashboard/${ctx.did}`) return 'allow'
  if (isRead && path === `/api/dashboard/${ctx.did}`) return 'allow'
  // dashcard 查询：**did 与 cid 都要过**（订正记录 ②）
  const dc = /^\/api\/dashboard\/(\d+)\/dashcard\/\d+\/card\/(\d+)\/query$/.exec(path)
  if (dc && Number(dc[1]) === ctx.did && ctx.cards.has(Number(dc[2]))) return 'allow'

  // 卡片**查询**面：只放行属于本 dashboard 的卡片，且只有 query 这一个动作
  if (method === 'POST') {
    const cq = /^\/api\/card\/(\d+)\/query$/.exec(path)
    if (cq && ctx.cards.has(Number(cq[1]))) return 'allow'
  }
  return 'deny'
}
```

- [ ] **Step 4: 实现 `src/upstream.ts` + 挂路由**

`upstream.ts` 要点（**逐条写进实现注释**）：

```ts
// upstream.ts — 透传到 Metabase 上游。三条纪律：
// ① **服务身份**：注入 X-API-Key（env，与模块同一把），绝不用浏览器 Cookie；
// ② **绝不透传**浏览器的 Cookie 头（platform_session / mb_edit 都不许到上游）——浏览器到反代是
//    第一方关系，反代到上游是服务关系，两者不能混；
// ③ 头改写：剥掉上游的 X-Frame-Options（否则 console 里 iframe 打不开），换成
//    `Content-Security-Policy: frame-ancestors <MB_PROXY_CONSOLE_ORIGIN>`（**只许 console 嵌它**）。
export async function fetchDashboardCards(cfg, did: number): Promise<Set<number>>  // 60s 缓存
export async function proxy(cfg, req): Promise<Response>                            // 流式回传
```

`index.ts` 挂中间件顺序：`/healthz` → `/handoff` → **鉴权**（解 `mb_edit` Cookie，失败 401）→ **规则**（`decide` 不过 403）→ 透传。

> ⚠️ **残余风险（订正记录 2026-09-29，Task 4 实施中登记）**：透传用 `redirect: 'manual'` ⇒
> 上游的 3xx 会把 `location` 原样回给浏览器，**那条 location 必须也落在放行表内**才走得通；
> 真机下 `/` 回 200 还是 3xx **未验**（Task 7 必须确认；若是 3xx，要么把该 location 纳入放行表、
> 要么改为跟随重定向但**逐跳复检**）。

- [ ] **Step 4b: 上游纪律的 HTTP 级测试**（新建 `apps/mb-proxy/src/app.test.ts`；用 `createApp(cfg)` + 桩掉 `globalThis.fetch`，照模块测试 `fakeMetabase` 的形态）

至少要咬住三条**安全不变量**（写在测试名里，别让它们只活在注释里）：
1. **浏览器 Cookie 绝不上行**：带合法 `mb_edit` Cookie 请求一条放行路径 ⇒ 断言桩收到的请求头里**没有** `cookie`，且**有** `x-api-key`（服务身份）。
2. **头改写**：桩返回 `x-frame-options: DENY` + 正常 body ⇒ 断言响应**没有** `x-frame-options`，且有 `content-security-policy: frame-ancestors <cfg.consoleOrigin>`；**并且上游 `set-cookie` 必须被剥掉**（纪律②的镜像面：不许上游把会话 Cookie 种到反代自己的域上——订正记录 2026-09-29，Task 4 实施中补）。
3. **401/403 契约**：无 Cookie ⇒ 401；有 Cookie 但路径不在规则表 ⇒ 403（**这两条是 Task 2 欠下的契约**，本任务必须兑现；`/healthz` 除外，它免鉴权）。

- [ ] **Step 5: 跑测试确认绿 + typecheck**

Run: `pnpm --filter @platform/mb-proxy exec vitest run`（rules + session + handoff 三套）→ PASS；`pnpm typecheck` → OK。

- [ ] **Step 6: Commit**

```bash
git add apps/mb-proxy/src/rules.ts apps/mb-proxy/src/rules.test.ts apps/mb-proxy/src/upstream.ts \
        apps/mb-proxy/src/app.ts apps/mb-proxy/src/app.test.ts apps/mb-proxy/src/handoff.ts   # ⚠️ 订正记录：组装在 app.ts，原稿误列 index.ts
git commit -m "feat(mb-proxy): 授权规则表（deny-by-default，封枚举面与任意查询面）+ 上游透传"
```

---

### Task 5: console「编辑 Metabase」入口

**Files:**
- Modify: `modules/data/console/reports/index.tsx`（管理视图加动作 + 编辑面板）
- Modify: `modules/data/console/lib/api.ts`（`MESSAGES` 加两条）
- Test: `modules/data/console/reports/index.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 1 的 `GET /reports/:id/edit-url` → `{url}`。
- Produces: 无下游消费方（页面是端点）。

- [ ] **Step 1: 写失败测试**（追加；harness 与既有 7 条相同）

```tsx
  it('编辑：点击后向平台换 handoff URL，并用 iframe 打开（同父域 ⇒ SameSite=Lax 可用）', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) return json({ url: 'https://mb.test/handoff?t=T' })
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    await waitFor(() => {
      const f = document.querySelector('iframe[title^="报表编辑"]') as HTMLIFrameElement
      expect(f?.src).toBe('https://mb.test/handoff?t=T')
    })
  })

  it('platform 行没有「编辑」（没有 Metabase dashboard 可编辑）', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    const row = screen.getByText('自绘大盘').closest('tr')!
    expect(within(row).queryByRole('button', { name: /编\s*辑/ })).not.toBeInTheDocument()
  })

  it('★ 服务端 503（未配代理 origin）⇒ 出人话文案', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) return json({ error: 'EDIT_PROXY_UNCONFIGURED' }, 503)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    expect(await screen.findByText('编辑入口未配置（请联系运维）')).toBeInTheDocument()
  })
```

- [ ] **Step 1b: 三条必须补的断言**（⚠️ 订正记录 2026-09-29，Task 5 评审轮）

1. **`canManage` 那半条硬约束必须有覆盖**：评审判定「删掉 `canManage &&` 后 10 条全绿」——即现有的
   「只有 `data:query`」用例只咬住了 `renderer` 那一半。在该用例里补：该行的**编辑按钮缺席**，
   同时**「打开」仍在**（正向对照，防「整页没渲染」冒充通过）。
2. **请求路径可断言**：新用例里 `calls` 已记录请求，补一条
   `expect(calls.some((c) => c.url.endsWith(`/reports/r1/edit-url`))).toBe(true)`——
   否则「只有 edit-url 才回 url」的 mock 只是**间接**钉住路径。
3. **兜底必须真能开**：断言点击「在新标签打开」会**再次**请求 `edit-url`（`calls` 里该 url 出现两次）
   并以**同步预开窗**（`window.open('about:blank','_blank')` → 拿到新票后 `pre.location.replace(url)`；⚠️ features 不可带 `noopener`，Chromium 恒返 null）把新票在新标签里用掉（测试里 stub `window.open`，并断言「第二次 `edit-url` 未返回时 open 已收到 about:blank」以钉住**同步性**）。删掉这次重新领票 ⇒ 必红。

- [ ] **Step 2: 跑测试确认红** → `pnpm --filter data exec vitest run console/reports/index.test.tsx`，FAIL。

- [ ] **Step 3: 实现**（`reports/index.tsx`：加 `editUrl` state + `edit()`；管理视图行内、`renderer === 'metabase'` 时给「编辑」按钮；面板与嵌入面板同构）

```tsx
  // ⚠️ 订正记录（2026-09-29，Task 5 实施中发现）：取 URL 的函数叫 `edit`，**state 必须叫
  //    `editUrl`**（原稿的片段里写成 `setEdit(...)`，与函数名撞名 ⇒ esbuild 报 symbol 已声明）。
  //    面板里的引用一律用 `editUrl`。
  // `editRow` 记住当前要编辑的那一行：兜底按钮要用它**重新领票**（票据一次性，见 JSX 注）。
  const [editRow, setEditRow] = useState<ReportRow | null>(null)
  const edit = async (r: ReportRow, opts?: { newTab?: boolean }) => {
    // 兜底路径要**同步**预开一个空白标签页（见下行注：await 之后再 window.open 会被弹窗拦截）
    // ⚠️ 订正记录（2026-09-29，终审修复轮实测）：**features 里不要写 `noopener`**——Chromium 下
    //    带 `noopener` 时 `window.open` **恒返回 null**（MDN + 本机 Chromium 实测），于是「预开窗 +
    //    判 null 提示被拦」这套模式会退化成「每次都说被拦」。正确做法：同步开普通窗，拿到引用后
    //    **立刻切断 opener**（反 tab-nabbing 的等价反制）；`noreferrer` 也不必（Referer 只带 console
    //    origin，不含票据）。
    const pre = opts?.newTab === true ? window.open('about:blank', '_blank') : null
    if (pre !== null) pre.opener = null
    try {
      const b = await apiGet(`/reports/${r.id}/edit-url`) as { url: string }
      setEditRow(r)
      if (opts?.newTab === true) {
        // ⚠️ 订正记录（2026-09-29，Task 5 重审轮）：**弹窗必须在 await 之前就打开**——浏览器只认
        //    同步点击上下文里的 window.open，`await fetch` 之后再开会被判成弹窗、直接拦掉，
        //    用户看到的是「点了没反应」。故先开空白窗（上面 `pre`），拿到新票后再导航；开不出就明说。
        if (pre === null || pre.closed) {
          messageApi.warning('浏览器拦下了新标签页，请允许本站弹窗后重试')
          return
        }
        pre.location.replace(b.url)
        return
      }
      setEditUrl({ title: r.title, url: b.url })
    } catch (e) {
      pre?.close()          // 失败时别把空白标签留在用户眼前
      messageApi.error(messageOf(e))
    }
  }
```

```tsx
      {editUrl !== null && editRow !== null && (   // 收窄 editRow（**别用 `editRow!`**，见下行注）
        <div>
          <Typography.Text type="secondary">
            {editUrl.title}——编辑页（专用入口；会话 8 小时有效，关闭后需从列表重新进入）
          </Typography.Text>
          {/* 同父域 ⇒ iframe 内仍是同站，反代的 SameSite=Lax Cookie 照发 */}
          <iframe
            title={`报表编辑：${editUrl.title}`}
            src={editUrl.url}
            style={{ width: '100%', height: 720, border: '1px solid #f0f0f0', marginTop: 8 }}
          />
          {/* ⚠️ 订正记录（2026-09-29，Task 5 评审轮）：**兜底不能复用同一枚票据**——票据是
              一次性（nonce 在 `/handoff` 即被消费），iframe 一渲染它就用掉了；若兜底链接的 href 也指向
              它，点开必然 401，而「CSP 挡住 iframe」那种**最需要兜底**的场景下票据同样已被消费 ⇒
              兜底路径整体失效。改为**重新领取**：再打一次 `edit-url` 换一枚新票，在新标签打开。 */}
          <Button size="small" onClick={() => void edit(editRow, { newTab: true })}>在新标签打开</Button>
          {/* ⚠️ 订正记录（2026-09-29，Task 5 修复轮）：**上面这个按钮要在 `editRow !== null` 的分支里**，
              否则 `editRow: ReportRow | null` 传给 `edit(r: ReportRow, …)` 是 TS2345（实测复现）。
              把外层条件写成 `{editUrl !== null && editRow !== null && (` 即可自然收窄，
              **不要**图省事用 `editRow!`（非空断言是类型逃逸，收窄才是正解）。 */}
        </div>
      )}
```

（行内动作：`{canManage && r.renderer === 'metabase' && (<Button size="small" onClick={() => void edit(r)}>编辑</Button>)}`——放在「打开」之后。）

- [ ] **Step 4: `MESSAGES` 加两条**（`lib/api.ts`）

```ts
  RENDERER_NOT_EDITABLE: '平台自绘报表没有可编辑的 Metabase 页面',
  EDIT_PROXY_UNCONFIGURED: '编辑入口未配置（请联系运维）',
```

- [ ] **Step 5: 跑测试确认绿 + 回归**

Run: `pnpm --filter data exec vitest run console/` → PASS；`pnpm --filter data test` → PASS；`pnpm --filter web test` → PASS。

- [ ] **Step 6: Commit**

```bash
git add modules/data/console/reports/index.tsx modules/data/console/reports/index.test.tsx modules/data/console/lib/api.ts
git commit -m "feat(data): console 加「编辑 Metabase」入口（专用入口 iframe + 新标签兜底）"
```

---

### Task 6: 部署接线 SOP（每客户）

**Files:**
- Modify: `deploy/data-plane-deploy-sop.md`（或新建 `deploy/mb-edit-proxy-runbook.md`——两者选一并在提交信息里说明）
- Test: 无（纯文档；但 Task 7 会按它逐条验收）

**Interfaces:**
- Consumes: Task 2 的 compose 服务、Task 1/2 的 env 键。
- Produces: 可照做的**每客户接线清单**（含验收判据）。

- [ ] **Step 1: 写 SOP 小节**（逐条可执行；**不写任何明文密钥，只写「在哪、怎么取」**）

内容必须覆盖（每条给出确切命令或面板路径）：
1. **专用 host**：为客户域新增一个 host（如 `mb.<客户域>`）；openship 侧加路由 → 该客户项目的 `mb-proxy` 服务；签证书（openship edge 原生）。
2. **平台↔Metabase 网络**：照 `data-plane-deploy-sop.md` P7 的 `pg_duckdb` 先例，把 **metabase 容器**连进平台网络并给 alias：
   `docker network connect --alias metabase <平台网络> <metabase 容器>`；随后平台侧 `DATA_METABASE_URL` 可用容器名（或保留 `127.0.0.1:13030`，由 env 决定——**两点都要在 SOP 里写明哪种形态用哪个值**）。
3. **env 清单 + 启用服务（顺序不能反）**（每客户）：先在该客户项目的 env 里备好
   `MB_PROXY_PUBLIC_ORIGIN=https://mb.<客户域>`、`MB_PROXY_CONSOLE_ORIGIN=https://platform.<客户域>`，
   **再**把该项目的 `mb-proxy` 服务置 `enabled: true`（未备 env 就启用 = crash loop）；⚠️ `services_sync`
   可能重置该开关 ⇒ **每次同步后回查**；复用键：
   `PLATFORM_SESSION_SECRET`、`DATA_METABASE_URL`、`DATA_METABASE_API_KEY`（**取值位置**：openship 项目 env isSecret，不落文档）。
4. **验收判据**（照 spec §3⑦ 的实测读数逐条）：本租户打开编辑页 200 且参数可改；**别租户 403**；无凭证 401；`/api/search` 403；样例 dashboard 403。
5. **已知边界**（写进 SOP）：编辑页内**不能**搜索/浏览其他报表（这是设计，不是缺陷——枚举面被主动封掉）；跨租户对象一律 403。

- [ ] **Step 2: Commit**

```bash
git add deploy/data-plane-deploy-sop.md
git commit -m "docs(deploy): 编辑页反代的每客户接线 SOP（专用 host/网络/env/验收判据）"
```

---

### Task 7: 真机端到端验收（spec §3⑦ 读数复现）

**前置（写进任务首行，缺一不可）**：① Docker daemon 可用；② `deploy/data-compose.yml` 起 `pg_duckdb` / `metabase-db` / `metabase`（真镜像 `metabase/metabase:v0.63.18.1`）；③ 本机 dev-stack（`scripts/dev-stack.mjs`）已按 `platform-core-local-ui-verify-recipe` 起；④ 两个租户各登记一张报表。
**若本机无 Docker**：本任务改在**交付环境**执行，并按 SOP（Task 6）逐条验收——**不得**因为「本机跑不了」就跳过。

- [ ] **Step 1: 起栈并种两租户数据**（命令逐条给出：compose up、psql 种 `data.reports` 两 org 各一行、dev-stack）
- [ ] **Step 2: 断言本租户可用**：经专用入口打开 `/handoff?t=…` → 302 + `Set-Cookie: mb_edit=…`；随后 `/dashboard/<did>` 200、`/api/dashboard/<did>` 200；**参数可改**（编辑态租户参数是普通参数，Constraint 2）。
- [ ] **Step 3: 断言四条负读数**：别租户对象 → 403；无 Cookie → 401；`/api/search` → 403；样例 dashboard（未登记）→ 403。
- [ ] **Step 4: 断言「编辑页不能任意查询」**：`POST /api/dataset` → 403（Constraint 6 的口子实测关上）。
- [ ] **Step 4b: 上游重定向与 canonicalization 探针**（评审轮补的必验项，**不得静默丢**）
  1. 真机 `GET /` 回的是 **200 还是 3xx**？若是 3xx，其 `location` **是否落在放行表内**（不落 ⇒ 编辑页首页打不开；落 ⇒ 记下它，且确认 `location` 里没有内网主机名泄露）。
  2. **canonicalization 绕过探针**：逐条打 `/app/..;/api/search`、`/app/..%3b..%3bapi/search`、`/app/..%20/api/search`、`/app/..%00/api/search`，**全部必须 403**（本地只证到「归一化收口后拒」，上游 Jetty 如何解释由真机定论）。
  3. 记下**服务 API key 在 Metabase 的权限档位**（若为 admin 档，代理的放行表就是唯一边界——这决定 Important 项的严重度）。

- [ ] **Step 5: 记档**：把命令、响应码、关键响应体片段写进 **`deploy/mb-edit-proxy-runbook.md` 的 §F 实测记录**小节
  （⚠️ 订正记录 2026-09-29：Task 6 选了新文件而非 `data-plane-deploy-sop.md`，回填落点随之改；含**日期与镜像 ID**），
  并更新 spec 若实测与 §3⑦ 有出入（有出入就订正 spec 并说明）。
- [ ] **Step 6: Commit**（文档与实测记录）

```bash
git add deploy/mb-edit-proxy-runbook.md docs/superpowers/specs/2026-09-28-report-authoring-design.md
git commit -m "docs(deploy): 编辑页反代真机验收记录（本租户 200/别租户 403/无凭证 401/搜索面 403/样例 403）"
```

---

## Self-Review（写完后自查，已过）

**1. spec 覆盖**（§3⑦ 三条硬约束 + 尾注）：
- ① 专用入口不挂子路径 → Task 2/6（独立服务 + 每客户专用 host 由 edge 路由到根）。
- ② 服务端会话 Cookie → Task 3（一次性 handoff → 代理自有 host-only `HttpOnly; SameSite=Lax` Cookie；平台会话不扩散）。
- ③ 租户隔离由反代补 → Task 1（模块核对「本 org 已登记」后签票）+ Task 4（deny-by-default；封枚举面与任意查询面；页面壳也判）。
- 尾注「编辑态租户参数是普通参数」→ Constraint 2 + Task 7 Step 2 的验收点（**别当缺陷修**）。
- §8 步骤 4「反代会话」= 本计划；步骤 2 写保护与步骤 5 agent 通路仍归计划 4。

**2. 占位符扫描**：唯一占位符是两处 `<GOLDEN_TOKEN>`——**故意**的跨实现契约锚点，Task 1 Step 4 明确要求首次实现后回填**同一串**；其余代码块可逐字落地。

**3. 类型一致性**：`signEditHandoff({org,did,nonce}, secret, ttlSec?, now?)`（Task 1 产）↔ 代理 `verifyEditHandoff(token, secret, now?) → {org,did,nonce}|null`（Task 3 消）；`decide(path, method, {did, cards})`（Task 4 内产消）；`{url}` 形状在 Task 1 端点与 Task 5 console 两处一致；`RENDERER_NOT_EDITABLE` / `EDIT_PROXY_UNCONFIGURED` 在 Task 1（产出）与 Task 5（MESSAGES）同码；`mb_edit` 在 Task 2（序列化）与 Task 3/4（读写）一致。

## 已定裁决（人裁 2026-09-29，实施前不要再翻）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | 身份怎么过桥 | **一次性 handoff**（短时票据 → 代理自有 host-only Cookie） | 平台会话 Cookie 不设 Domain + 会话中间件按 Host 解析租户（`session-middleware.ts:88-91,156`）⇒ 专用 host 收不到它；放宽 cookie 到父域会扩大安全面 |
| 2 | 反代住哪 | **独立服务**（`deploy/docker-compose.yml` 加第三服务） | 与平台控制面隔离崩溃/阻塞面；与 spec「四个最小进程」模型一致 |
| 3 | 票据谁签 | **模块签**（`modules/data` 手搓 HS256，先例 `signEmbedToken`） | 架构 lint **B1**：`apps/`+`packages/` 只许 `platform` schema ⇒ 平台与代理**都读不到** `data.reports`，而「本 org 已登记」只能在模块判；**B2** 的**操作性**规则不禁手搓 HS256（它只禁 jose/jsonwebtoken/casdoor specifier 与 `@platform/auth-core` 引用） |

## 与另几份计划的关系

| 计划 | 内容 | 状态 |
|---|---|---|
| 1 | 写路径底座 | 已交付（PR #329） |
| 2 | 统一管理面 | 已交付（PR #338，生产已上线并验证） |
| **3（本份）** | 编辑页反代会话（spec §3⑦ 三约束） | 待实施 |
| 4 | 写保护（spec §8 步骤 2）+ agent 制作通路（步骤 5）+ 语义源维度（依赖 §7 待拍 6） | 待写 |

**顺序 1 → 2 → 3 → 4**。计划 4 若要做「编辑页里的写保护」，必须建立在本计划的**代理层**上（写请求已经在反代眼前）。
