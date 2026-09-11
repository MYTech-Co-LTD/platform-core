# Casdoor `get-user`：「错误」与「不存在」不再混为一谈（M1 闭债 R3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `getUser` 只把「真·不存在」判成 `null`，把 Casdoor 的 `status:error` 如实抛错；并让 admin 会话能在服务端失效后自愈。堵住 issue #3 第三节那条已用真机确认的**静默登出通道**。

**Architecture:** 本仓两个同类调用口径不一致——`#permissionsRaw` 对 `status!=='ok'` **抛错**，而 `getUser` 把它折叠成 `null`；而 `null` 在会话中间件里是**唯一清 cookie 的分支**。真机实测把形状钉死了：用户不存在 = `HTTP 200 + {status:'ok', data:null}`，而 `status:'error'` 覆盖的是「id 非两段 / admin 会话失效 / org 不存在 / org 非公开且权限不过 / DB 或角色扩展出错」等与"不存在"无关的情形。修法是让 `getUser` 对齐 `#permissionsRaw`，并补上「admin 会话失效」的自愈重试。

**Tech Stack:** TypeScript / Hono 4.13 / PostgreSQL(pg) / vitest / tsx；PG 真跑（非 skip）

**设计依据:** 本计划 §「真机证据」；issue #3 第三节（本轮由"待验证"升格为"已确认缺陷"）。

## 真机证据（2026-09-11 对 `sso.hookflow.cn` 实测，无需凭据即可复现）

| 探针 | HTTP | 响应体 |
|---|---|---|
| `get-user?id=shanhai/a/b` | 200 | `{"status":"error","msg":"GetOwnerAndNameFromId() error, wrong token count for ID: shanhai/a/b"}` |
| `get-user?id=noorg` | 200 | 同上（无斜杠也非两段） |
| `get-user?id=built-in/admin` | 200 | `{"status":"error","msg":"Please login first"}` ← **admin 会话失效的形态** |
| `get-user?id=shanhai/admin` | 200 | `{"status":"ok","data":null}` ← **"用户不存在"的真实形态** |

配合上游源码（`controllers/user.go` 的 `GetUser` / `util/string.go` 的 `GetOwnerFromId`）与客户端现状（`#adminJson` 只在**非 2xx** 抛错、`#adminRequest` 只在 **401** 重取会话、`#sessionCookie` 缓存**无 TTL**），得出一条完整的失效链：

**admin 会话失效 ⇒ `get-user` 回 200+`status:error` ⇒（既不重登也不抛错）⇒ `getUser` 返回 `null` ⇒ `session-middleware` 判 `userGone` ⇒ 清终端用户 cookie ⇒ 全体静默登出，且永久持续**（死 cookie 一直被缓存）。

## 根因的另一半：mock 与真机不一致（**缺陷在测试里结构性看不见**）

`packages/auth-core/src/test-util/mock-casdoor.ts` 的 `get-user` 对未知用户回
`{status:'error', msg:'user not found'}` —— 而真机回 `{status:'ok', data:null}`。
代码照 mock 写（"非 ok ⇒ null"），测试自然全绿。

**这与 issue #3 第二节（"门禁对故障结构性失明"）是同一类病**：替身与真身行为不一致时，
门禁给出的"全绿"没有证据价值。故本轮**必须同时修 mock**，否则下次回退无人能拦。

## Global Constraints

- Node `>=22`；包管理器 `pnpm@11.22.0`（`package.json` 的 `packageManager`，不要在别处写第二份）
- 本地 PG：`docker compose -f deploy/docker-compose.yml up -d postgres`
  → `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`
- **守卫脚本必须经 `tsx`**：`pnpm exec tsx scripts/<x>.mjs`（直接 `node` 会 ERR_MODULE_NOT_FOUND）
- **验收命令必须覆盖本仓 CI 跑的全部命令**——尤其 `pnpm typecheck`
  （R2 的教训：任务书只列 smoke，结果把 CI 的 gates job 打红，直到评审才暴露）
- **不匹配 Casdoor 的错误文案**：文案随版本/分支变，本仓明确反对把正确性押在字符串上
  （见 `casdoor-client.ts` 里 `upsertPermission` 的既有注释）。区分**只靠响应形状**。
- 提交纪律：可见变更必须在 `CHANGELOG.md` 行内标 **【修复】**；改动走 PR，不直推 `main`
- **每个新断言必须先跑红**再修（含"删掉修复即变红"的咬合力自检）

---

### Task 1: `getUser` 口径对齐 + admin 会话自愈 + mock 与真机对齐

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`（`getUser` / `#adminJson` / `#adminRequest` / `#sessionCookie` 调用点）
- Modify: `packages/auth-core/src/test-util/mock-casdoor.ts`（未知用户改回 `ok+null`；加 get-user 故障注入）
- Modify: `packages/auth-core/src/casdoor-client.test.ts`
- Modify: `packages/auth-core/src/test-util/mock-casdoor.test.ts`
- Modify: `apps/server/src/routes/auth.ts`（`user === null` 时 fail loudly）
- Modify: `apps/server/src/routes/auth.test.ts`
- Modify: `CHANGELOG.md`

**为什么是一个任务而不是两个：** 验收侧的断言（会话不清 cookie、登录 502）**依赖本任务给 mock 加的故障注入 API**；拆成两任务会因"下游拿不到上游的新接口"而无法各自独立验证（R2 的波次基线教训），故合一。

**Interfaces:**
- Consumes: 无
- Produces:
  - `CasdoorClient.getUser(name: string): Promise<CasdoorUser | null>` —— **语义变更**：`status:'error'` 时**抛错**；仅 `status:'ok' && data == null` 返回 `null`
  - `MockCasdoor.setGetUserFault(mode: 'off' | 'error' | 'errorOnce'): void`
    （`'error'` = 此后每次都回 `{status:'error',msg:'Please login first'}`；`'errorOnce'` = 只回一次错、随后自动复位）
  - `MockCasdoor.adminLoginCalls: number`（只读；断言"自愈确实重登了一次"）
  - Mock 的 `get-user` 对未知用户改回 **`{status:'ok', data:null}`**（对齐真机）

- [ ] **Step 1: 写失败测试（auth-core）**

在 `packages/auth-core/src/casdoor-client.test.ts` 末尾追加（沿用该文件既有的 `MockCasdoor` + `CasdoorClient` 装配；若文件里已有 `describe`，追加新 `describe` 即可）：

```ts
// M1 闭债 R3：真机把"用户不存在"回成 ok+null，把一堆与不存在无关的情形回成 status:error。
// 把 error 折叠成 null 会让调用方误判 ⇒ 静默登出（issue #3 第三节，真机已确认）。
describe('getUser：错误 ≠ 不存在', () => {
  /** 与 casdoor-client.test.ts 既有装配同形状的最小 client 工厂 */
  const clientFor = (m: MockCasdoor, org: string): CasdoorClient => new CasdoorClient({
    origin: m.origin, clientId: 'test-client', clientSecret: '', org,
    adminUser: 'admin', adminPwd: 'pw',
  })

  it('★ 负例：未知用户 ⇒ null', async () => {
    const m = new MockCasdoor({ users: [] })
    await m.start()
    try {
      expect(await clientFor(m, 'mock-org').getUser('nobody')).toBeNull()
    } finally {
      await m.stop()
    }
  })

  it('★ 负例：status:error ⇒ 抛错，绝不返回 null（旧实现把它当"用户不存在"）', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = clientFor(m, 'mock-org')
      m.setGetUserFault('error') // 模拟 admin 会话失效 / 上游内部错
      await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
    } finally {
      await m.stop()
    }
  })

  it('★ admin 会话失效后可自愈：首次 error ⇒ 强制重登并重试成功', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = clientFor(m, 'mock-org')
      const before = m.adminLoginCalls
      m.setGetUserFault('errorOnce') // 只错一次：等价于"缓存里的 admin cookie 已失效"
      const u = await c.getUser('alice')
      expect(u?.name).toBe('alice')              // 重试后拿到正确结果
      expect(m.adminLoginCalls).toBe(before + 1) // 且确实重登了一次
    } finally {
      await m.stop()
    }
  })
})
```

**"mock 的响应形状对不对"另开一处断言**，放 `packages/auth-core/src/test-util/mock-casdoor.test.ts`
（该文件已有 `adminCookie(m)` 这类 helper，直接复用，别在新文件里另造一套）：

```ts
  it('★ 负例：未知用户 ⇒ ok + data:null（真机形状；旧 mock 回 status:error 与真机不符）', async () => {
    const j = await (await fetch(`${m.origin}/api/get-user?id=acme/nobody`, {
      headers: { Cookie: await adminCookie(m) },
    })).json() as { status: string; data: unknown }
    expect(j.status).toBe('ok')
    expect(j.data).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/auth-core test
```
预期：**四条**红——

- `mock-casdoor.test.ts` 的"未知用户 ⇒ ok+data:null"：红在 `expected 'error' to be 'ok'`（mock 现状与真机不符）
- `casdoor-client.test.ts` 的"status:error ⇒ 抛错"：红在 `promise resolved "null" instead of rejecting`（旧实现把 error 折叠成 null）
- 同文件的"自愈"：红在 `adminLoginCalls` 没增加（`#adminRequest` 只在 401 重登，而 mock 回的是 200+error）
- 同文件的"未知用户 ⇒ null"：**这条预期是绿的**（旧实现恰好也能过）——它存在是为了在 Step 10 的变异下变红（把 mock 改回 error 形状时），别把它当红态证据

若 `setGetUserFault` 尚未实现会先报 "not a function"，同样属于预期的红。

- [ ] **Step 3: 改 mock —— 未知用户对齐真机 + 加故障注入**

`packages/auth-core/src/test-util/mock-casdoor.ts` 三处：

① 类字段区（`#tokenFault` 那一组旁边）加：

```ts
  #getUserFault: 'off' | 'error' | 'errorOnce' = 'off'
  #adminLoginCount = 0
```

② `get-user` 处理器里，**未知用户改回真机形状**（原来是 `status:'error', msg:'user not found'`）：

```ts
      const user = this.#users.find((u) => u.name === parts[1])
      // 真机（sso.hookflow.cn 实测）：用户不存在 ⇒ HTTP 200 + {status:'ok', data:null}，
      // **不是** status:error。旧 mock 回 error 与真机不符，正是"error 被折叠成 null"
      // 这个缺陷在测试里结构性看不见的原因（M1 闭债 R3）。改动前先读本文件头注的 mock 三纪律。
      if (!user) return c.json({ status: 'ok', data: null })
```

③ 同处理器**最前面**（在 admin 会话校验之后、id 解析之前）加故障注入：

```ts
      if (this.#getUserFault === 'error' || this.#getUserFault === 'errorOnce') {
        if (this.#getUserFault === 'errorOnce') this.#getUserFault = 'off'
        return c.json({ status: 'error', msg: 'Please login first' })
      }
```

④ 访问器区（`get origin()` 附近）加：

```ts
  /** get-user 故障注入：'error' 持续、'errorOnce' 只一次（用于验证 admin 会话自愈） */
  setGetUserFault(mode: 'off' | 'error' | 'errorOnce'): void {
    this.#getUserFault = mode
  }

  /** admin 登录次数——"自愈确实重登了一次"的唯一机检证据 */
  get adminLoginCalls(): number {
    return this.#adminLoginCount
  }
```

⑤ `#adminLoginCount` 的自增点：在 `POST /api/login` 处理器**校验成功**之后加一行
`if (this.#isAdminCredential(...)) this.#adminLoginCount++`（按该处理器现有结构就地插入；
若它已把"是否 admin"算好，直接用那个判定，不要另造一套）。

- [ ] **Step 4: 改 `getUser` 口径 + admin 会话自愈**

`packages/auth-core/src/casdoor-client.ts` 三处：

① `getUser`（替换第 67-71 行那段的判定）：

```ts
  async getUser(name: string): Promise<CasdoorUser | null> {
    const path = `get-user?id=${encodeURIComponent(`${this.#o.org}/${name}`)}`
    const j = await this.#adminJson(path)
    // 口径与 #permissionsRaw 一致（M1 闭债 R3）：**只有 ok 才是应答**。
    // 真机（sso.hookflow.cn 实测）：用户不存在 ⇒ 200 + {status:'ok', data:null}；
    // 而 status:'error' 覆盖的是与"不存在"无关的一堆情形——id 非 <org>/<name> 两段
    // （wrong token count）、admin 会话失效（'Please login first'）、org 不存在、
    // org 非公开且权限不过、DB/角色扩展/脱敏出错。
    // 把 error 折叠成 null 会让调用方误判"用户不存在"：会话中间件据此清 cookie（静默登出）、
    // 登录路据此发出"没有角色派生 scopes"的会话（表现为登录了但每个模块 API 都 403）。
    // 不匹配错误文案——形状就够区分（文案随 Casdoor 版本变，见本文件 upsertPermission 的注释）。
    if (j.status !== 'ok') throw new Error(`casdoor get-user: ${j.msg || 'error'}`)
    const u = j.data as Record<string, unknown> | null | undefined
    if (!u || typeof u !== 'object' || !u.name) return null
```

② `#adminRequest` 增加"强制重取会话"入参：

```ts
  async #adminRequest(
    path: string,
    init?: { method?: string; body?: unknown },
    forceSession = false,
  ): Promise<Response> {
    const doFetch = (cookie: string): Promise<Response> => { /* 原样不动 */ }
    let r = await doFetch(await this.#sessionCookie(forceSession))
    if (r.status === 401) {
      r = await doFetch(await this.#sessionCookie(true))
    }
    return r
  }
```

③ `#adminJson` 在**响应体**层补一次自愈重试：

```ts
  async #adminJson(path: string, init?: { method?: string; body?: unknown }): Promise<Record<string, unknown>> {
    const readOnce = async (forceSession: boolean): Promise<Record<string, unknown> | null> => {
      const r = await this.#adminRequest(path, init, forceSession)
      if (!r.ok) throw new Error(`casdoor request failed: ${r.status} ${path}`)
      return (await r.json().catch(() => ({}))) as Record<string, unknown>
    }
    const j = await readOnce(false)
    if (j.status !== 'error') return j
    // 真机把"admin 会话失效"回成 **HTTP 200 + status:error**（'Please login first'），
    // **不是 401** ⇒ #adminRequest 里那个 401 重试永不触发，缓存的死 cookie 也永不刷新。
    // 这里补一次强制重登 + 重试：不匹配文案（任何 error 都重试一次；真错的第二次照样错，
    // 由调用方按既有口径抛/降级）。
    return (await readOnce(true)) as Record<string, unknown>
  }
```

- [ ] **Step 5: 跑测试确认通过（auth-core）**

```bash
pnpm --filter @platform/auth-core test
```
预期：全绿。**特别注意**：既有的 `casdoor-client.test.ts` 用例若断言过
"未知用户 ⇒ error 文案"，会因 mock 形状变更而变红——那是**该红的红**（它锁的是与真机不符的旧形状），
逐条按真机形状修正，**不要**为了让测试变绿把 mock 改回去。

- [ ] **Step 6: 写失败测试（apps/server 侧的两个后果）**

`apps/server/src/routes/auth.test.ts` 末尾（`})` 之前）追加：

```ts
  // ⑰ M1 闭债 R3：admin 会话失效（get-user 回 status:error）时——
  //    session-middleware **不得**清终端用户 cookie（那是静默登出通道），
  //    而应走既有的"降级用旧 scopes 继续"分支。
  it('★ 负例：会话刷新遇 get-user 错误 ⇒ 降级不清 cookie（旧实现判 userGone 直接清）', async () => {
    const now = nowSec()
    const stale = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['old:scope'], authVia: 'password' },
      SECRET,
      now - SCOPES_TTL_SEC - 60,
    )
    mock.setGetUserFault('error')
    try {
      const res = await client.api.platform.auth.session.$get(undefined, {
        headers: { host: 'acme.test', cookie: `platform_session=${stale}` },
      })
      expect(res.status).toBe(200)
      expect(setCookies(res)).toEqual([])             // 不重签、**更不清 cookie**
      expect((await res.json()).scopes).toEqual(['old:scope'])
    } finally {
      mock.setGetUserFault('off')
    }
  })

  // ⑱ M1 闭债 R3：登录时"密码已验证通过却查无此人"= 上游不一致 ⇒ 502 fail loudly，
  //    绝不发一个"没有角色派生 scopes"的会话（那表现为登录成功但模块 API 全 403）。
  it('★ 负例：登录遇 get-user 错误 ⇒ 502，且不发会话 cookie', async () => {
    const c2 = testClient(makeApp(pool))
    mock.setGetUserFault('error')
    try {
      const res = await c2.api.platform.auth.login.$post(
        { json: { username: 'alice', password: 'pw' } },
        { headers: { host: 'acme.test' } },
      )
      expect(res.status).toBe(502)
      expect(setCookies(res)).toEqual([])
    } finally {
      mock.setGetUserFault('off')
    }
  })
```

- [ ] **Step 7: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- auth.test
```
预期：两条红——⑰ 红在 `expected 401 to be 200`（且带了 `Max-Age=0` 的清除 cookie）、
⑱ 红在 `expected 200 to be 502`（旧实现照发会话）。

- [ ] **Step 8: 登录路 fail loudly**

`apps/server/src/routes/auth.ts`，替换 `effectiveScopes` 那一行之前的位置：

```ts
      const [user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
      // 密码已验证通过却查无此人 = 上游不一致（M1 闭债 R3）：绝不发一个"没有角色派生
      // scopes"的会话——那表现为"登录成功但每个模块 API 都 403"，且无人知道为什么。
      // 与企微路 `NO_ACCOUNT` 同风格：查无此人就不发会话。
      if (user === null) return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
      scopes = effectiveScopes(name, user.roles ?? [], perms)
```

- [ ] **Step 9: 跑测试确认通过（全量）**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
```
预期：全绿，且 `pnpm test` 无大面积 skip。

- [ ] **Step 10: 咬合力自检（证明新断言真的咬得住）**

逐条做**最小变异**，确认对应断言变红，然后**精确还原**（**别用 `git checkout <file>`**——
它会连同本任务尚未提交的正当改动一起冲掉，这是 R2 踩过的坑）：

1. 把 `getUser` 的 `if (j.status !== 'ok') throw` 改回 `return null`
   ⇒ ① 用例 ⑰/⑱ 与 auth-core 的"status:error ⇒ 抛错"用例必红
2. 把 `#adminJson` 的自愈重试整段去掉 ⇒ auth-core 的"自愈"用例必红（`adminLoginCalls` 不增）
3. 把 mock 的未知用户改回 `status:'error'` ⇒ "未知用户 ⇒ null"用例必红

把三条的红态原文记进报告。

- [ ] **Step 11: CHANGELOG**

`CHANGELOG.md` 的 `## [Unreleased]` 下插入：

```markdown
### Fixed - M1 闭债 R3：Casdoor「错误」与「不存在」不再混为一谈（issue #3 第三节，真机已确认）

- 【修复】**静默登出通道**：`getUser` 此前把 Casdoor 的一切 `status:error` 折叠成 `null`，
  而 `null` 在会话中间件里是**唯一清 cookie 的分支**。真机实测（`sso.hookflow.cn`）：
  用户不存在回的是 `200 + {status:'ok', data:null}`，而 `status:error` 覆盖的是**与"不存在"
  无关**的情形——id 非 `<org>/<name>` 两段、**admin 会话失效**（`Please login first`）、
  org 不存在、org 非公开且权限不过、DB/角色扩展出错。⇒ admin 会话一旦失效，
  **全体终端用户会在会话刷新时被静默登出，且永久持续**（死 cookie 被永久缓存）
- 【修复】**admin 会话自愈**：`#adminRequest` 只在 **HTTP 401** 重取会话，而真机把会话失效
  回成 **200 + `status:error`** ⇒ 该重试永不触发、缓存的死 cookie 永不刷新。改为响应体
  `status:error` 时**强制重登一次并重试**（不匹配文案——任何 error 都重试一次，真错的第二次照样错）
- 【修复】**登录不再发"空 scopes 会话"**：密码已验证通过却查无此人时，此前会发出一个
  没有角色派生 scopes 的会话（表现为"登录成功但每个模块 API 都 403"）；改为 **502 fail loudly**
- 【修复】**测试替身与真机对齐**（同类病的第二次）：`MockCasdoor` 对未知用户回的是
  `status:error`，而真机回 `ok + data:null` —— 代码照 mock 写，**缺陷因此在测试里结构性看不见**。
  已把 mock 改回真机形状，并新增 `get-user` 故障注入（`error` / `errorOnce`）与
  `adminLoginCalls` 计数，让"会话失效清 cookie""自愈重登"两件事都有机检面
```

- [ ] **Step 12: 全量门禁 + 提交**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs \
  && pnpm exec tsx scripts/check-compose.mjs && pnpm exec tsx scripts/check-env-example.mjs
pnpm --filter @platform/web build && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
预期：全绿。

```bash
git add packages/auth-core/src/casdoor-client.ts packages/auth-core/src/test-util/mock-casdoor.ts \
        packages/auth-core/src/casdoor-client.test.ts packages/auth-core/src/test-util/mock-casdoor.test.ts \
        apps/server/src/routes/auth.ts apps/server/src/routes/auth.test.ts CHANGELOG.md
git commit -m "fix(auth-core): Casdoor 错误与不存在不再混为一谈 + admin 会话自愈 + mock 对齐真机"
```

---

## 集成后由协调者执行的**真机回探**（不在 worker 范围内）

改完并合并后，用本计划 §真机证据 的五条探针复跑一遍，确认：
① 真机行为未变（对照表仍成立）；② 修复后的判定逻辑对 `status:error` 抛错、对 `ok+null` 返回 `null`。
把回探输出贴进 PR 正文。

## 完成判据

1. `pnpm test` 全绿且 PG 用例真跑（非 skip）；`pnpm typecheck` EXIT 0
2. 四个守卫脚本绿；`pnpm smoke` 绿
3. Step 10 的三条咬合力自检都做过，红态原文进报告
4. 真机回探输出留档

## 本计划不做

- `getPermissions` 的 `pageSize=100` 翻页（issue #3 第四节，另立）
- 给 admin cookie 加 TTL（自愈重试已覆盖按需恢复；TTL 属可选优化，YAGNI）
- issue #3 第五节工程 Minor、其余第四节条目
