# multi 权限供给（M1 闭债 R1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `TENANT_MODE=multi` 下每个租户都能在自己的 Casdoor org 内拿到模块权限码，并把「门禁对这一故障结构性失明」一并修掉。

**Architecture:** 权限记录在 Casdoor 里按 org（`owner=`）分桶，而读侧按租户 org 读（`session-middleware.ts`）。故写侧必须遍历 `platform.tenant` 的每个 `casdoor_org` 各建一套码——权威租户清单来自 DB，不再来自 `PLATFORM_ORG` 环境变量。冒烟侧：mock 的 `owner=` 真正生效，权限码不再预种（改由租户管理员走 HTTP 授权），并驱动第二个租户来暴露「其余租户恒 403」。

**Tech Stack:** TypeScript / Hono / PostgreSQL(pg) / zod / vitest / tsx；Casdoor（HTTP API，冒烟用 `MockCasdoor` 真 HTTP 替身）

**设计依据:** `docs/superpowers/specs/2026-09-11-multi-tenant-permission-provisioning-design.md`（issue #3 第一、二节）

## Global Constraints

- Node `>=22`；包管理器 `pnpm@11.22.0`（`package.json` 的 `packageManager`，**不要在别处写第二份版本号**）
- 本地 PG：`docker compose -f deploy/docker-compose.yml up -d postgres`
  → `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（宿主视角）
- **权限码的 `name` 就是 `code` 本身**：`CasdoorClient.upsertPermission` 建码时
  `name = existing?.name ?? code`，manifest 里的中文名落在 `displayName`。
  （旧冒烟预种时用的 `p-demo-view` 是虚构的，与真实建码形状不符）
- 供给的**权威租户清单 = `platform.tenant.casdoor_org`**，不是 env。
  `PLATFORM_ORG` 自本轮起**只服务 single 模式的租户解析**。
- `effectiveScopes` 只读 `permissions[].resources`（`normalize-scopes.ts`）——
  断言权限归属时看 `resources`，不是 `name`。
- 提交纪律（`docs/standards/dev-discipline.md`）：可见变更必须在 `CHANGELOG.md` 行内标
  **【新增】/【优化】/【修复】**；改动走 PR，不直推 `main`。
- 四个守卫脚本对本仓真跑：`check-manifests` / `lint-architecture` / `check-compose` / `check-env-example`
- **每个任务的新断言必须先在改动前跑红**（spec §5.4）：一条「修完才第一次运行」的断言，
  等于没有验证过它测的是不是那个 bug。这正是本 issue 第二条的教训本身。

---

### Task 1: MockCasdoor 权限按 org 分桶（`owner=` 生效）

mock 自陈「单 org、忽略 `owner=`」（`mock-casdoor.ts:253`），这是**门禁对 multi 权限失明的根因**。先修替身，后面的任务才有可信的观测面。

**Files:**
- Modify: `packages/auth-core/src/test-util/mock-casdoor.ts`
- Modify: `packages/auth-core/src/casdoor-client.test.ts`（既有用例的 org 归属要跟着修正）
- Test: `packages/auth-core/src/test-util/mock-casdoor.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `MockCasdoorPerm.owner?: string`（缺省 `MOCK_ORG`，旧用例兼容）
  - `MockCasdoor.permissionsIn(org: string): Array<Record<string, unknown>>`
  - `MockCasdoor.addPermissionCalls: ReadonlyArray<{ owner: string; name: string }>`
  - HTTP 契约：`GET /api/get-permissions?owner=<org>` 只回该 org（**owner 缺失 → `status:error`**）；
    `POST /api/add-permission` 的 `body.owner` 必填并据此归桶；
    `POST /api/update-permission?id=<org>/<name>` 按 **(owner, name)** 二元组定位

- [ ] **Step 1: 写失败测试**

新建 `packages/auth-core/src/test-util/mock-casdoor.test.ts`：

```ts
// mock 的 owner= 隔离是「门禁对 multi 权限失明」的根因（issue #3 第二节成因①）：
// mock 自陈"单 org、忽略 owner=" ⇒ 真实的写读分叉在冒烟里看不见。
// 测试替身自己的语义也要有测试——否则它给出的"全绿"没有任何证据价值。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from './mock-casdoor'

let m: MockCasdoor
beforeAll(async () => {
  m = new MockCasdoor({
    users: [{ name: 'admin1', password: 'pw' }],
    perms: [{ owner: 'acme', name: 'demo:view', users: ['admin1'], resources: ['demo:view'] }],
  })
  await m.start()
})
afterAll(async () => { await m.stop() })

/** 原生 admin 登录拿会话 cookie（管理端点门禁；凭据走 JSON body） */
async function adminCookie(): Promise<string> {
  const r = await fetch(`${m.origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'pw' }),
  })
  const hit = /casdoor_session_id=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')
  return hit ? `casdoor_session_id=${hit[1]}` : ''
}

/** @param {string} owner @returns {Promise<any>} */
async function getPerms(owner?: string): Promise<any> {
  const qs = owner === undefined ? '' : `?owner=${encodeURIComponent(owner)}`
  return (await fetch(`${m.origin}/api/get-permissions${qs}`, { headers: { Cookie: await adminCookie() } })).json()
}

/** 建码（add-permission） */
async function addPerm(owner: string, name: string, users: string[] = []): Promise<any> {
  return (await fetch(`${m.origin}/api/add-permission`, {
    method: 'POST',
    headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, name, displayName: name, resources: [name], users }),
  })).json()
}

describe('MockCasdoor：权限按 org 分桶（owner= 生效）', () => {
  it('★ 负例：owner=beta 不回 acme 桶的权限码', async () => {
    const j = await getPerms('beta')
    expect(j.status).toBe('ok')
    expect(j.data).toEqual([])
  })

  it('owner=acme 回 acme 桶', async () => {
    const j = await getPerms('acme')
    expect(j.data.map((p: { name: string }) => p.name)).toEqual(['demo:view'])
  })

  it('owner 缺失 → status error（绝不"忽略形参回全部"——那正是失明的形状）', async () => {
    const j = await getPerms()
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/owner/)
  })

  it('add-permission 按 body.owner 归桶，并记入调用记录', async () => {
    expect((await addPerm('beta', 'demo:note')).status).toBe('ok')
    expect(m.permissionsIn('beta').map((p) => p.name)).toEqual(['demo:note'])
    expect(m.permissionsIn('acme').map((p) => p.name)).toEqual(['demo:view'])
    expect(m.addPermissionCalls).toEqual([{ owner: 'beta', name: 'demo:note' }])
  })

  it('add-permission 缺 owner → status error', async () => {
    const j = await (await fetch(`${m.origin}/api/add-permission`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-owner', resources: ['no-owner'] }),
    })).json()
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/owner/)
  })

  it('update-permission 按 (owner,name) 定位：跨 org 同名互不影响', async () => {
    expect((await addPerm('acme', 'shared:code')).status).toBe('ok')
    expect((await addPerm('gamma', 'shared:code')).status).toBe('ok')

    const upd = await (await fetch(
      `${m.origin}/api/update-permission?id=${encodeURIComponent('gamma/shared:code')}`,
      {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: ['admin1'] }),
      },
    )).json()
    expect(upd.status).toBe('ok')

    expect(m.permissionsIn('gamma').find((p) => p.name === 'shared:code')?.users).toEqual(['admin1'])
    expect(m.permissionsIn('acme').find((p) => p.name === 'shared:code')?.users).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/auth-core test
```

预期：**「★ 负例」失败**（现在 `owner=beta` 会回全部权限码而非空集），
「owner 缺失」失败（现在返回 ok），`permissionsIn` / `addPermissionCalls` 报「不是函数」。

- [ ] **Step 3: 改 mock 实现**

`packages/auth-core/src/test-util/mock-casdoor.ts` 五处改动：

**① `MockCasdoorPerm` 加 `owner`**（在 `name?: string` 之后）：

```ts
export interface MockCasdoorPerm {
  /** Casdoor 权限必有 name；种子未给时以首个 resource 兜底（装载器场景 code 即 name） */
  name?: string
  /** 权限归属 org（Casdoor 权限记录按 owner 分桶）。缺省 = MOCK_ORG，旧用例兼容 */
  owner?: string
  users?: string[]
  roles?: string[]
  resources?: string[]
  actions?: string[]
  isEnabled?: boolean
}
```

**② 加调用记录字段 + 访问器**（`#oidcCodes` 那一组字段旁加字段）：

```ts
  #addPermissionCalls: Array<{ owner: string; name: string }> = []
```

（访问器加在 `get origin()` 附近）

```ts
  /** 某 org 的权限记录（断言用；等价 get-permissions?owner=，但不经 HTTP） */
  permissionsIn(org: string): Array<Record<string, unknown>> {
    return this.#perms.filter((p) => p.owner === org).map((p) => ({ ...p }))
  }

  /**
   * add-permission 调用记录——「装载器真的建过码」的唯一机检证据。
   * issue #3 第二节成因②：旧冒烟预种权限码 ⇒ 查重必命中 ⇒ 走 update 分支 ⇒ 此处恒空。
   */
  get addPermissionCalls(): ReadonlyArray<{ owner: string; name: string }> {
    return this.#addPermissionCalls
  }
```

**③ 构造器种子按 `owner` 归桶**（把 `owner: MOCK_ORG,` 那一行改掉）：

```ts
    for (const [i, p] of (opts.perms ?? []).entries()) {
      const name = p.name ?? p.resources?.[0] ?? `perm-${i + 1}`
      this.#perms.push({
        owner: p.owner ?? MOCK_ORG,
        name,
        displayName: name,
        users: p.users ?? [],
        roles: p.roles ?? [],
        resources: p.resources ?? [],
        actions: p.actions ?? ['Read'],
        isEnabled: p.isEnabled ?? true,
        model: 'built-in/user-model-built-in',
      })
    }
```

（即：只把硬写的 `owner: MOCK_ORG` 换成 `owner: p.owner ?? MOCK_ORG`，其余九个字段一字不动。）

**④ `#updatePermission` 改按 (owner, name) 定位**（替换开头三行）：

```ts
  #updatePermission = async (c: Context) => {
    if (!this.#isAdminSession(c)) return this.#unauthorized(c)
    // 纪律 ②：id=<org>/<name> 全形 query 形参。owner 参与定位——跨 org 同名权限互不干扰
    // （旧实现只按 name 找，两个 org 各有一枚 demo:view 时会改错那一枚）
    const segs = (c.req.query('id') ?? '').split('/')
    if (segs.length !== 2 || !segs[0] || !segs[1]) {
      return c.json({ status: 'error', msg: 'wrong token count, expect <org>/<name>' })
    }
    const p = this.#perms.find((x) => x.owner === segs[0] && x.name === segs[1])
    if (!p) return c.json({ status: 'error', msg: 'permission not found' })
```

**⑤ `get-permissions` 按 owner 过滤 + `add-permission` 按 owner 归桶**：

```ts
    // GET /api/get-permissions?owner=<org> —— 纪律 ②：owner= query 形参，**按 org 分桶**。
    // owner 缺失一律 status:error：绝不"忽略形参回全部"——那正是 M0 门禁对 multi 权限
    // 结构性失明的根因（issue #3 第二节成因①），回退成那个形状必须立刻可见
    .get('/api/get-permissions', (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      const owner = c.req.query('owner') ?? ''
      if (!owner) return c.json({ status: 'error', msg: 'owner required' })
      return c.json({ status: 'ok', data: this.permissionsIn(owner) })
    })
    // POST /api/add-permission —— 载荷在 JSON body；owner 必填并据此归桶；
    // (owner,name) 重复拒绝（钉死 upsert 必须先查重）
    .post('/api/add-permission', async (c) => {
      if (!this.#isAdminSession(c)) return this.#unauthorized(c)
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const owner = String(b.owner ?? '')
      const name = String(b.name ?? '')
      if (!owner) return c.json({ status: 'error', msg: 'owner required' })
      if (!name) return c.json({ status: 'error', msg: 'name required' })
      if (this.#perms.some((p) => p.owner === owner && p.name === name)) {
        return c.json({ status: 'error', msg: 'duplicate permission name' })
      }
      this.#addPermissionCalls.push({ owner, name })
      this.#perms.push({
        owner,
        name,
        displayName: String(b.displayName ?? name),
        model: String(b.model ?? 'built-in/user-model-built-in'),
        users: (b.users as string[]) ?? [],
        roles: (b.roles as string[]) ?? [],
        resources: (b.resources as string[]) ?? [],
        actions: (b.actions as string[]) ?? ['Read'],
        isEnabled: (b.isEnabled as boolean) ?? true,
      })
      return c.json({ status: 'ok', data: name })
    })
```

同时把文件头注释里「mock 单 org」那半句删掉，改为「权限按 owner 分桶，`owner=` 生效」。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @platform/auth-core test
```

预期：`mock-casdoor.test.ts` 全绿。

- [ ] **Step 5: 修正既有用例里「权限属于 mock-org」的假设**

`owner=` 一生效，`casdoor-client.test.ts` 里用 `org: 'acme'` 的 client 就查不到 `mock-org` 桶的权限了。这是**该红的红**（spec 风险表已预期）。

`packages/auth-core/src/casdoor-client.test.ts` 两处：

```ts
// ① beforeAll 的种子：加 owner: 'acme'（下面所有 client 的 org 都是 acme）
beforeAll(async () => { m = new MockCasdoor({ users: [{ name: 'admin1', password: 'pw', roles: ['ops'] }],
  perms: [{ owner: 'acme', users: ['admin1'], resources: ['demo:view'] }] }); await m.start() })
```

```ts
// ② 「update-permission 形状钉死」用例里的 PUT 探针：mock-org → acme
    const put = await fetch(`${m.origin}/api/update-permission?id=acme/demo:view`, {
```

- [ ] **Step 6: 跑全包测试确认通过**

```bash
pnpm --filter @platform/auth-core test
```

预期：全绿。若还有红的，逐条核对**是否都是「权限归 mock-org」这一条假设的显影**——是则改归属，不是则停下来查（不要为了让测试变绿而放宽断言）。

- [ ] **Step 7: Commit**

```bash
git add packages/auth-core/src/test-util/mock-casdoor.ts \
        packages/auth-core/src/test-util/mock-casdoor.test.ts \
        packages/auth-core/src/casdoor-client.test.ts
git commit -m "fix(auth-core): MockCasdoor 权限按 org 分桶（owner= 生效）"
```

---

### Task 2: 装载器按租户 org 供给权限码（+ 宿主装配与启动次序）

**Files:**
- Modify: `apps/server/src/loader.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/loader.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MockCasdoor.permissionsIn(org)` 与生效的 `owner=`
- Produces:
  - `LoadModulesDeps.casdoorFor?: (org: string) => CasdoorClient`（**替代**原有的 `casdoor?: CasdoorClient`）
  - `provisionModulePermissions(pool: Pool, casdoorFor: (org: string) => CasdoorClient, permissions: ReadonlyArray<ProvisionPermission>): Promise<string[]>`（导出，返回实际供给到的 org 列表）
  - `ProvisionPermission = { code: string; name: string }`
  - `buildApp` 内部次序：`runMigrations(platform)` → `seedDemo` → `loadModules`

- [ ] **Step 1: 起本地 PG**

```bash
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml ps postgres   # 等到 State = healthy
```

预期：`platform-core-postgres-1` 处于 `healthy`。PG 不起，`loader.test.ts` 会整体 skip，**等于这一步之后所有断言都没跑**。

- [ ] **Step 2: 写失败测试**

`apps/server/src/loader.test.ts` 四处改动。

**① 把单体 client 换成工厂**（替换 `casdoorClient()` 那个 helper）：

```ts
  /** 按 org 返回 client 的工厂（与宿主 app.ts 的 casdoorFactory 同形状） */
  function casdoorFactoryFor(): (org: string) => CasdoorClient {
    const cache = new Map<string, CasdoorClient>()
    return (org) => {
      let c = cache.get(org)
      if (!c) {
        c = new CasdoorClient({
          origin: mock.origin,
          clientId: 'test-client',
          clientSecret: '',
          org,
          adminUser: 'admin',
          adminPwd: 'pw',
        })
        cache.set(org, c)
      }
      return c
    }
  }
```

**② 既有用例的调用点改名**：把全部 `casdoor: casdoorClient()` 改成 `casdoorFor: casdoorFactoryFor()`
（出现 3 处：happy path、userApp 静态目录、enabledFor）。

**③ happy path 的权限断言改为按租户 org 查**（替换该用例的 ③ 段）：

```ts
    // ③ 权限码供给到 platform.tenant 的每个租户 org（acme/beta 由 beforeAll 的 seedDemo 种下）
    expect(mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])).toContain('fixturemod:view')
    expect(mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])).toContain('fixturemod:view')
```

**④ 追加四个新用例**（放在文件末尾 `})` 之前）：

```ts
  it('权限码供给到每个租户各自的 org（写侧遍历 platform.tenant，不依赖任何 env）', async () => {
    cleanupModules.push('orgmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'orgmod', {
      'manifest.yaml': manifestYaml('orgmod'),
      'index.ts': indexTs('orgmod', 'orgmod:view'),
    })

    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    expect(runtime.modules.map((m) => m.manifest.id)).toEqual(['orgmod'])

    // 修复前：写侧只落单个 org ⇒ beta 恒空，而读侧按 beta 读 ⇒ 该租户用户全线 403
    expect(mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])).toContain('orgmod:view')
    expect(mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])).toContain('orgmod:view')
  })

  it('零租户：不供给、不抛错（全新库尚未 seed 是正常分支，不是异常）', async () => {
    const requested: string[] = []
    const emptyPool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const orgs = await provisionModulePermissions(
      emptyPool,
      (org) => { requested.push(org); throw new Error('零租户时不应取 client') },
      [{ code: 'x:y', name: 'X' }],
    )
    expect(orgs).toEqual([])
    expect(requested).toEqual([])
  })

  it('无 casdoorFor：跳过供给、不抛错，且该模块的码不存在于任何 org', async () => {
    cleanupModules.push('nofacmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'nofacmod', {
      'manifest.yaml': manifestYaml('nofacmod'),
      'index.ts': indexTs('nofacmod', 'nofacmod:view'),
    })

    const runtime = await loadModules(modulesDir, { pool })
    expect(runtime.modules.map((m) => m.manifest.id)).toEqual(['nofacmod'])
    const all = [...mock.permissionsIn('acme'), ...mock.permissionsIn('beta')]
    expect(all.flatMap((p) => p.resources ?? [])).not.toContain('nofacmod:view')
  })

  it('重跑不重复建码：第二次走 update 分支，add-permission 调用数不增', async () => {
    cleanupModules.push('idemmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'idemmod', {
      'manifest.yaml': manifestYaml('idemmod'),
      'index.ts': indexTs('idemmod', 'idemmod:view'),
    })

    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const afterFirst = mock.addPermissionCalls.length
    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    expect(mock.addPermissionCalls.length).toBe(afterFirst) // 查重命中 ⇒ 走 update，不再 add
  })
```

并更新 import 行：

```ts
import { loadModules, provisionModulePermissions } from './loader'
```

- [ ] **Step 3: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
```

预期：新用例**全部失败**（`provisionModulePermissions` 不存在 / `casdoorFor` 不被识别）；
`跳过` 数应为 0（PG 已起，测试真跑）。

- [ ] **Step 4: 改装载器**

`apps/server/src/loader.ts`。

**① 接口替换**（`LoadModulesDeps`）：

```ts
export interface LoadModulesDeps {
  pool: Pool
  /**
   * 按 org 返回 CasdoorClient 的工厂（宿主传 casdoorFactory，内部按 org 缓存实例）。
   * 缺省 → 权限码供给 warn 跳过（保留「只登录不管理」的部署形态）。
   */
  casdoorFor?: (org: string) => CasdoorClient
}

/** 待供给的权限码（manifest.permissions 的元素形状） */
export interface ProvisionPermission {
  code: string
  name: string
}

/**
 * 把模块权限码供给到【每个租户各自的 Casdoor org】。
 *
 * 为什么必须遍历租户：权限码是平台级能力，但 Casdoor 的权限记录按 org（owner=）存储，
 * 读侧又按租户 org 读（session-middleware.ts 的 casdoor(p.org)）。只写一个 org ⇒
 * 其余租户 effectiveScopes 恒空 ⇒ 模块 API 全线 403 而宿主全绿（issue #3 第一节）。
 *
 * 权威租户清单来自 platform.tenant，**不是 env**：PLATFORM_ORG 只服务 single 的租户解析。
 * 返回实际供给到的 org 列表——调用方据此区分「没有租户可供给」与「没有权限码可供给」。
 */
export async function provisionModulePermissions(
  pool: Pool,
  casdoorFor: (org: string) => CasdoorClient,
  permissions: ReadonlyArray<ProvisionPermission>,
): Promise<string[]> {
  if (permissions.length === 0) return []
  const { rows } = await pool.query<{ casdoor_org: string }>(
    'select distinct casdoor_org from platform.tenant order by casdoor_org',
  )
  for (const { casdoor_org: org } of rows) {
    const casdoor = casdoorFor(org)
    for (const p of permissions) {
      await casdoor.upsertPermission(p.code, p.name)
    }
  }
  return rows.map((r) => r.casdoor_org)
}
```

**② 删掉循环里的逐模块 upsert**（原 ④ 段整块删除），改为循环结束后一次性供给：

```ts
  // ④ 权限码供给：全部模块的权限码一次性供给到每个租户各自的 org（见 provisionModulePermissions）。
  //    放在循环之后而非之内：租户清单只需查一次，且 manifest 全部校验通过后才产生副作用
  const allPermissions = loaded.flatMap((m) => m.manifest.permissions)
  if (deps.casdoorFor) {
    const orgs = await provisionModulePermissions(deps.pool, deps.casdoorFor, allPermissions)
    if (orgs.length === 0 && allPermissions.length > 0) {
      console.warn('[modules] platform.tenant 无租户，权限码未供给任何 org（先跑租户 seed）')
    }
  } else if (allPermissions.length > 0) {
    // warn 必须说清后果：不是「少做了一步」，而是这些租户的用户会全线 403
    const { rows } = await deps.pool.query<{ casdoor_org: string }>(
      'select distinct casdoor_org from platform.tenant order by casdoor_org',
    )
    console.warn(
      '[modules] 无 CasdoorClient 工厂，跳过权限码供给：'
        + `${allPermissions.map((p) => p.code).join(', ')} → 租户 org `
        + `[${rows.map((r) => r.casdoor_org).join(', ') || '(无租户)'}] 的用户将全部 403`,
    )
  }
```

**③ 更新文件头注释**：把「权限 upsert 的 org 策略（M0 简化）」那一段（第 9-12 行）改写为：

```ts
// 权限码供给的 org 策略（M1）：权限码是平台级能力，但 Casdoor 权限记录按 org 存储，
// 读侧按租户 org 读 —— 故装载器遍历 platform.tenant 的每个 casdoor_org 各建一套码
// （provisionModulePermissions）。权威清单来自 DB，不是 PLATFORM_ORG 环境变量。
```

- [ ] **Step 5: 改宿主装配与启动次序**

`apps/server/src/app.ts` 三处。

**① 次序：seed 提到装载之前**（把现 ② ③ 两块对调）：

```ts
  // ② demo 种子（SEED_DEMO=1；幂等收敛，重跑安全）。**必须先于装载**：装载器的权限码
  //    供给按 platform.tenant 取租户 org，全新库上租户还不存在时会一个码都建不出来
  //    （本设计引入的次序约束，见 docs/superpowers/specs/2026-09-11-*）
  if (config.seedDemo) await seedDemo(pool)

  // ③ 模块装载（overrides.modules 注入时跳过）。权限码供给交给工厂：装载器自己按
  //    platform.tenant 的各租户 org 逐个 upsert —— multi 下每个租户各有一套码，
  //    写侧与读侧（session-middleware 的 casdoor(p.org)）因此同源
  let runtime: ModulesRuntime
  if (overrides.modules) {
    runtime = overrides.modules
  } else {
    runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactory })
  }
```

**② 删掉 `PLATFORM_ORG` 缺失的 warn**（原第 87-91 行整块删除）——它的前提（拿 `platformOrg`
当供给 org）已经不成立。

**③ 同步文件头的顺序列表**（第 6-8 行）：

```ts
//   loadConfig → getPool → runMigrations(platform) → seed(可选) → loadModules →
```

- [ ] **Step 6: 跑测试确认通过**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
```

预期：`loader.test.ts` 全绿（含四个新用例）。

- [ ] **Step 7: 跑类型检查**

```bash
pnpm typecheck
```

预期：全绿。`app.ts` 是 `casdoorFor` 的**唯一**调用点——若这里漏改，typecheck 会直接报出来。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts apps/server/src/app.ts
git commit -m "fix(server): 权限码按租户 org 逐个供给 + seed 先于装载"
```

---

### Task 3: 冒烟三治（撤预种 / 管理员 HTTP 授权 / 驱动 beta / 诱饵 PLATFORM_ORG）

**Files:**
- Modify: `scripts/smoke-load.mjs`

**Interfaces:**
- Consumes: Task 1 的 `permissionsIn` / `addPermissionCalls` / 生效的 `owner=`；Task 2 的按租户 org 供给
- Produces: 无（冒烟是终端验证，不被其他任务消费）

- [ ] **Step 1: 加常量**

`scripts/smoke-load.mjs` 常量区（`ACME_PRODUCT_NAME` 附近）：

```js
const TENANT_HOST = 'acme.test'
const BETA_HOST = 'beta.test' // 第二个租户：其余租户恒 403 的观测面（issue #3 第二节成因③）
const UNKNOWN_HOST = 'unknown.test'
/** demo 种子的品牌名（apps/server/src/seed.ts）——断言 branding 命中的锚点 */
const ACME_PRODUCT_NAME = 'Acme 工单'
const BETA_PRODUCT_NAME = 'Beta 平台'
/**
 * multi 形态的 PLATFORM_ORG【诱饵值】：故意指向不存在的租户 org。
 * 修复前写侧拿它当供给 org、读侧按租户 org 读 —— 两条路分叉而冒烟照样全绿（issue #3 第二节实证）。
 * 修复后供给由 platform.tenant 驱动，这个值必须【完全不起作用】：全链路仍通过 ⇒ 写读同源。
 */
const DECOY_PLATFORM_ORG = 'NOT-ACME-ORG'
```

（把原 `const TENANT_HOST` / `UNKNOWN_HOST` / `ACME_PRODUCT_NAME` 三行合并进上面这块，不要留重复声明。）

- [ ] **Step 2: 撤掉权限预种**

`main()` 里的 MockCasdoor 构造（原 `perms:` 两项整块删除）：

```js
  const mock = new MockCasdoor({
    users: [
      { name: ADMIN1, password: USER_PASSWORD, displayName: 'Admin One' },
      { name: VIEWER1, password: USER_PASSWORD, displayName: 'Viewer One' },
    ],
    // 刻意【不预种任何权限码】：预种会让装载器的 upsert 查重必命中、add-permission 全程零调用，
    // 于是「装载器真的建过码」这件事在门禁里不可见（issue #3 第二节成因②）。
    // 用户授权改由 grantPermission() 以租户管理员身份走 HTTP 完成——装载器建码、管理员授权是两件事
  })
```

- [ ] **Step 3: 加两个授权辅助函数**

放在 `login()` 之后：

```js
/**
 * MockCasdoor 的 admin 会话 cookie（管理端点门禁；凭据走 JSON body）。
 * @param {MockCasdoor} mock @returns {Promise<string>}
 */
async function mockAdminCookie(mock) {
  const res = await httpRequest({
    port: mock.port,
    path: '/api/login',
    method: 'POST',
    body: JSON.stringify({ username: CASDOOR_ADMIN_USER, password: CASDOOR_ADMIN_PWD }),
  })
  const hit = /casdoor_session_id=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''))
  check(res.status === 200 && !!hit, 'MockCasdoor：admin 登录取得管理会话（授权前置）', describe(res))
  return `casdoor_session_id=${hit[1]}`
}

/**
 * 以租户管理员身份把权限码授予用户。
 * 走真 HTTP 是刻意的：这是真实租户管理员的路径（POST /api/update-permission，POST 非 PUT）。
 * 注意权限码的 name = code（CasdoorClient.upsertPermission 建码时 name 取 code，
 * manifest 里的中文名落在 displayName）——旧冒烟预种时用的 'p-demo-view' 是虚构的。
 * @param {MockCasdoor} mock @param {string} cookie
 * @param {string} org @param {string} permCode @param {string[]} users
 */
async function grantPermission(mock, cookie, org, permCode, users) {
  const res = await httpRequest({
    port: mock.port,
    method: 'POST',
    cookie,
    path: `/api/update-permission?id=${encodeURIComponent(`${org}/${permCode}`)}`,
    body: JSON.stringify({ users }),
  })
  check(
    res.status === 200 && json(res)?.status === 'ok',
    `租户管理员把 ${org} 的 ${permCode} 授予 [${users.join(',')}]`,
    describe(res),
  )
}
```

- [ ] **Step 4: `runMulti` 接收 mock，加供给断言与授权**

签名改 `async function runMulti(child, port, mock)`，并在 `await assertStaticServing(b)` 之后、
`step('multi：登录 / 授权 / 登出 全链路')` 之前插入：

```js
  step('multi：权限码供给落到每个租户各自的 org（issue #3 第一节回归锁）')
  const mockCookie = await mockAdminCookie(mock)
  const acmeCodes = mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])
  const betaCodes = mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])
  check(
    acmeCodes.includes('demo:view') && acmeCodes.includes('demo:note'),
    `acme org 内已建出 demo:view + demo:note（PLATFORM_ORG=${DECOY_PLATFORM_ORG} 是诱饵，供给不该依赖它）`,
    { acmeCodes, decoyPlatformOrg: DECOY_PLATFORM_ORG },
  )
  check(
    betaCodes.includes('demo:view') && betaCodes.includes('demo:note'),
    'beta org 内同样建出两条码 —— 修复前此处置空（写侧只落一个 org ⇒ 其余租户恒 403）',
    { betaCodes },
  )
  check(
    mock.addPermissionCalls.length >= 2,
    `装载器确实经 add-permission 建码（${mock.addPermissionCalls.length} 次）——修复前该调用数恒为 0`,
    { addPermissionCalls: mock.addPermissionCalls },
  )

  // 授予用户是租户管理员的事，与装载器建码分开：只授 acme，beta 刻意不授（下面用它证 403 在拦）
  await grantPermission(mock, mockCookie, 'acme', 'demo:view', [ADMIN1])
  await grantPermission(mock, mockCookie, 'acme', 'demo:note', [ADMIN1])
```

在 `runMulti` 末尾（viewer 会话不受影响那条断言之后）追加：

```js
  step('multi：beta 租户 —— 码在、授权不在 ⇒ 403（issue #3 第二节成因③）')
  const betaBase = base(port, BETA_HOST)
  const betaBranding = await betaBase.get('/api/platform/branding')
  check(
    betaBranding.status === 200 && json(betaBranding)?.productName === BETA_PRODUCT_NAME,
    `beta.test 解析到 beta 租户（productName=${BETA_PRODUCT_NAME}）`,
    describe(betaBranding),
  )
  const betaJar = new CookieJar()
  await login(betaBase, betaJar, ADMIN1, 'beta')
  const betaSession = await betaBase.get('/api/platform/auth/session', { cookie: betaJar.header() })
  check(
    !((json(betaSession)?.scopes ?? []).includes('demo:view')),
    'beta 下 admin1 的 scopes 不含 demo:view（授权只给了 acme）',
    { scopes: json(betaSession)?.scopes },
  )
  const betaPing = await betaBase.get('/api/modules/demo/ping', { cookie: betaJar.header() })
  check(
    betaPing.status === 403 && json(betaPing)?.error === 'FORBIDDEN',
    'beta 下 GET /api/modules/demo/ping 403 FORBIDDEN —— 码存在但未授权，403 是授权在拦',
    describe(betaPing),
  )
```

- [ ] **Step 5: `runSingle` 也自持授权（不依赖 multi 先跑过）**

签名改 `async function runSingle(child, port, mock)`，在 `waitReady` 之后、登录之前插入：

```js
  // single 与 multi 共用同一枚 mock（进程内单例），但本函数自持授权，不依赖 multi 先跑过——
  // 两个形态各自是一份可独立理解的验收
  const singleCookie = await mockAdminCookie(mock)
  await grantPermission(mock, singleCookie, 'acme', 'demo:view', [ADMIN1])
  await grantPermission(mock, singleCookie, 'acme', 'demo:note', [ADMIN1])
```

- [ ] **Step 6: 两条调用点改传 mock 与诱饵**

`main()` 末尾 try 块：

```js
    // 形态 1：multi —— PLATFORM_ORG 刻意设为【诱饵】（不指向任何租户）：供给必须由
    // platform.tenant 驱动，这个值不该在任何一处起作用（issue #3 第二节回归锁）
    multiChild = startServer(commonEnv(multiPort, 'multi', DECOY_PLATFORM_ORG), 'multi')
    await runMulti(multiChild, multiPort, mock)
    await stopServer(multiChild, 'multi')
    multiChild = undefined

    // 形态 2：single —— PLATFORM_ORG=acme，走「无 Host 头也按它命中租户」分支
    singleChild = startServer(commonEnv(singlePort, 'single', 'acme'), 'single')
    await runSingle(singleChild, singlePort, mock)
```

- [ ] **Step 7: 跑冒烟确认绿（需先构建 web）**

```bash
pnpm --filter @platform/web build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```

预期：`smoke-load: OK（multi + single 双形态全通过）`，且输出里能看到新增的三段
`== multi：权限码供给…` / `== multi：beta 租户…` 的 ✓。

- [ ] **Step 8: 红检（mutation）——证明新断言真的咬得住**

新断言必须在**修复前**失败，否则它测的可能不是那个 bug。用最小变异复现原始缺陷
（「写侧只落一个 org」）：把 `apps/server/src/loader.ts` 里 `provisionModulePermissions`
的租户查询临时改成只取一个 org：

```bash
# 临时变异：只供给第一个 org（= 原始缺陷的等效形状）
perl -0pi -e "s/select distinct casdoor_org from platform\.tenant order by casdoor_org/select distinct casdoor_org from platform.tenant order by casdoor_org limit 1/" apps/server/src/loader.ts
grep -n "limit 1" apps/server/src/loader.ts   # 确认变异已生效
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```

预期：**冒烟变红**，且红的正是新增断言之一（`acme org 内已建出…` 或 `beta org 内同样建出…`）。
把红的那一行原文记进本任务的报告。

然后还原并复验：

```bash
git checkout apps/server/src/loader.ts
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke   # 复绿
```

若变异后冒烟**仍然全绿**：新断言没有咬住，停下来查断言为什么没起作用，**不要**就这样提交。

- [ ] **Step 9: Commit**

```bash
git add scripts/smoke-load.mjs
git commit -m "fix(smoke): 撤权限预种+管理员 HTTP 授权+驱动 beta+诱饵 PLATFORM_ORG"
```

---

### Task 4: 文档同步 + CHANGELOG + 全量门禁

**Files:**
- Modify: `deploy/openship-adopt.md`
- Modify: `.env.example`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–3 的全部行为变化
- Produces: 无

- [ ] **Step 1: 改 adopt runbook 的 env 表**

`deploy/openship-adopt.md` 第 128 行的 `TENANT_MODE` 一行（「且**跳过**启动期权限 upsert」已不成立）：

```markdown
| `TENANT_MODE` | `single`（单客户）/ `multi`（多租户） | `multi` 时租户由 Host 解析，`PLATFORM_ORG` 不再参与；**两种模式都会**按 `platform.tenant` 的各租户 org 逐个供给模块权限码 |
```

- [ ] **Step 2: 改已知陷阱 2**

`deploy/openship-adopt.md` 第 216 行起那一条，改为：

```markdown
2. **启动期连不上 Casdoor 就起不来**（设计如此，fail-fast）：配置了 `CASDOOR_ADMIN_USER`/`_PWD`
   时，装载器会按 `platform.tenant` 的每个租户 org 调 `upsertPermission`——**`single` 与 `multi`
   都一样**（M1 起 `multi` 不再跳过供给）。**别把 Casdoor 排在平台容器后面部署**；共享 SSO
   短暂不可用时，`restart: unless-stopped` 会让容器反复重启直到它恢复。
   未配 admin 凭据时不触发本陷阱：装载器只打一行 warn 并跳过供给（但那意味着各租户用户
   没有权限码、模块 API 全线 403）。
```

- [ ] **Step 3: 改 `.env.example` 的 `PLATFORM_ORG`**

在 `PLATFORM_ORG=acme` 上方加注释（**只加注释，不改键名/键数**——`check-env-example` 守卫盯着键全集）：

```
# single 模式：唯一租户的 casdoor org（必填）。multi 模式：不参与租户解析与权限供给，
# 留空即可。模块权限码的供给按 platform.tenant 的各租户 org 进行，与此键无关。
PLATFORM_ORG=acme
```

- [ ] **Step 4: 加 CHANGELOG 条目**

`CHANGELOG.md` 的 `## [Unreleased]` 下、现有内容之前插入：

```markdown
### Fixed - M1 闭债 R1：multi 形态的模块权限供给 + 冒烟失明（issue #3 第一、二节）

- 【修复】**multi 形态下除 `PLATFORM_ORG` 所指租户外，其余租户模块 API 全线 403**：权限码是
  平台级能力，但 Casdoor 的权限记录按 org（`owner=`）存储，而**写侧只往一个 org 写、读侧按
  租户 org 读**，两侧不同源。原实现 `app.ts` 拿 `config.platformOrg` 当供给 org——而
  `config.ts` 自己写明「multi 模式恒为空串」，属自我违背；multi 冒烟又传空串 ⇒ 整条 upsert
  被 warn 跳过。改为**装载器遍历 `platform.tenant` 的每个 `casdoor_org` 各建一套码**
  （权威租户清单来自 DB，`PLATFORM_ORG` 自本轮起只服务 single 的租户解析）
- 【修复】**启动次序：`seedDemo` 必须先于 `loadModules`**。改成从 DB 取租户 org 后，原次序
  （装载 ② → 种子 ③）在全新库上会**一个权限码都建不出来**，要等下次重启才供给。这是本次
  改动**引入**的缺陷（`tenant_module.module_id` 无外键，seed 不依赖装载器，重排安全）
- 【修复】**测试门禁对上述故障结构性失明**（三条成因逐条对治）：① `MockCasdoor` 的
  `get-permissions` 此前**忽略 `owner=`**（自陈"mock 单 org"）⇒ 改为按 org 分桶，且 owner
  缺失直接 `status:error`，绝不给"忽略形参回全部"的旧形状留活口；② 冒烟把 `p-demo-view`/
  `p-demo-note` **预种**进 mock ⇒ 装载器查重必命中、`add-permission` 全程零调用 ⇒ 撤掉预种，
  改由冒烟以**租户管理员身份走真 HTTP**（`POST /api/update-permission`）授权，使「装载器建码」
  与「管理员授权」两件事各自可见；③ 冒烟的 multi 只驱动 `acme.test`、**从不驱动 beta** ⇒
  补驱动 `beta.test` 并断言其 403（码在、授权不在 ⇒ 403 是授权在拦，而非路由不存在）
- 【新增】**multi 冒烟把 `PLATFORM_ORG` 设为诱饵值 `NOT-ACME-ORG`**（不指向任何租户）——
  即终审复评员手工探针的形状：修复前这条**因错误原因通过**，修复后必须因正确原因通过
- 【优化】**跳过供给时的 warn 说清后果**：从"跳过权限 upsert"改为点名哪些租户 org 的用户
  将全部 403——只报"少做了一步"会让 403 的归因成本全部留给排障者
- 【新增】**装载器导出 `provisionModulePermissions`**：未来的租户创建入口直接复用它，
  避免「新增租户只能靠重启」成为死路（本轮不造租户创建 API）
```

- [ ] **Step 5: 跑全量门禁**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm smoke
```

预期：三者全绿，且 `pnpm test` 里**没有大面积 skip**（`loader`/`tenant`/`migrate` 的 50 条
PG 测试应当真跑）——若仍是大片 `↓ skipped`，说明 PG 没起，等于没验证。

- [ ] **Step 6: 单跑四个守卫脚本对真仓**

```bash
node scripts/check-manifests.mjs
node scripts/lint-architecture.mjs
node scripts/check-compose.mjs
node scripts/check-env-example.mjs
```

预期：四者全绿（`.env.example` 只改了注释，键全集不变）。

- [ ] **Step 7: Commit**

```bash
git add deploy/openship-adopt.md .env.example CHANGELOG.md
git commit -m "docs: adopt runbook/env/CHANGELOG 同步 multi 权限供给"
```

---

## 完成判据（全部满足才算做完）

1. `pnpm test` 全绿且 PG 测试真跑（非 skip）
2. `pnpm typecheck` 全绿
3. `pnpm smoke` 绿，且**红检（Task 3 Step 8）证明新断言在变异下变红**
4. 四个守卫脚本绿
5. `git log` 中四个任务各一条 commit，均带 `X-Issue: 3` trailer
6. spec §5.4 满足：每个新断言都有「先红后绿」的记录

## 本计划不做（spec §2 非目标）

工单模块化、真机验证（`sso.hookflow.cn`）、登录限速 / branding 语义 / `/readyz` 拆分 /
`getPermissions` 翻页、issue 第五节工程 Minor、**撤销「multi 按非生产可用对待」那句警告**
（保留到做过一次真实 multi 生产演练之后）。
