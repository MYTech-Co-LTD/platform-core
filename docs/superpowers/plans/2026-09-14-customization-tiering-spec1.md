# 个性化分级 spec-1 落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec-1（`docs/superpowers/specs/2026-09-14-customization-tiering-design.md`）：模块租户数据隔离约定成文并修正 demo 参考模板、provision CLI 增加面向存量租户的批量发放。

**Architecture:** 约定正文回写 `docs/module-protocol.md`（唯一事实源），demo 模块用新迁移补 `org` 列并以真装配集成测试锁「租户互不可见」，CLI 批量发放走纯核函数（可测）+ 遍历 `platform.tenant` 各 org 幂等发放。

**Tech Stack:** TypeScript / Hono / pg / vitest（真 PG 集成测试 + MockCasdoor）/ Node ESM CLI。

## Global Constraints

- **分支**：`docs/customization-tiering-spec`（已含 spec 提交 `6647f01`，本计划在其上继续）。
- **feat/fix 必须先有 issue**（dev-discipline）：Task 1 建 issue，PR body 含 `Closes #N`。
- **提交格式**：`type(scope): 一句话`；本仓 subject 用中文，与 git log 现有风格一致。
- **迁移纪律**：DDL 一律 `if not exists` 形态；一个迁移文件一个事务（`runMigrations` 已保证，文件内不要写 `begin/commit`）；version = 文件名去掉 `.sql`，按文件名排序执行，未记账者才跑。
- **B1 三同纪律**：demo 模块保持 `demo` schema，不跨 schema 引 `platform.*`。
- **测试约定**：apps/server 的真 PG 测试在无 `DATABASE_URL` 时整体跳过；本地跑需先起 compose pg（`DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`）。注意本机 5432 可能是原生 postgres 遮蔽 compose 容器，连不上先查这个。
- **波末验证 = CI 全量命令**：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm smoke`（smoke 前先 `pnpm --filter @platform/web build`）。
- **CSRF**：只在 `/api/platform/admin/*`；模块 API 的 POST 测试**不需要** `x-csrf-token`。

---

### Task 1: 建 issue（纪律前置）

**Files:** 无代码文件。

**Interfaces:**
- Produces: issue 编号 `#N`，供 Task 5 的 PR body 引用（`Closes #N`）。

- [ ] **Step 1: 创建 issue**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "demo 模块缺租户隔离；provision CLI 缺批量发放（spec-1 落地）" \
  --body "$(cat <<'EOF'
## 背景

spec-1（docs/superpowers/specs/2026-09-14-customization-tiering-design.md）落地。
demo 参考模块的 note 表没有租户维度（modules/demo/migrations/001_note.sql），共享部署上
租户间数据互见；provision CLI 只有单租户 --module，新模块对存量租户的发放无批量手段。

## 要做

- [ ] module-protocol.md 新节「租户数据隔离」+ architecture.md §5 加行
- [ ] demo：002 迁移补 org 列 + 路由按 identity.orgId 过滤 + 多租户互不可见测试
- [ ] provision-tenant.mjs 增 --all-tenants --module <id> 批量发放（幂等）

## 验收

1. org A 的 note 对 org B 不可见（测试绿）
2. --all-tenants 对两个测试租户幂等跑通（重跑无差异）
EOF
)"
```

- [ ] **Step 2: 记下返回的 issue 编号**（形如 `https://github.com/MYTech-Co-LTD/platform-core/issues/72` → `N=72`），Task 5 要用。

---

### Task 2: 约定正文回写（module-protocol.md + architecture.md）

**Files:**
- Modify: `docs/module-protocol.md`（在「## 实现注意（踩过的坑，勿重蹈）」一节**之前**插入新节）
- Modify: `docs/architecture.md:121-130`（§5 清单，现 6 条，插入后 7 条）

**Interfaces:**
- Consumes: spec-1 §2 的约定内容（本任务就是它的正文化）。
- Produces: 文档锚点——「`docs/module-protocol.md` 租户数据隔离」一节，后续任务与评审引用它。

- [ ] **Step 1: module-protocol.md 插入新节**

在 `## 实现注意（踩过的坑，勿重蹈）` 之前插入（保持该文档「规则 + 为什么」的行文风格）：

```markdown
## 租户数据隔离（spec-1 §2，2026-09-14）

模块的表分两类，**类属是设计决定，写迁移前就要想清楚**：

- **租户数据表**：存「某租户的数据」的表，必须带 `org text not null` 列，值 =
  `identity.orgId`（宿主注入的身份里现成的租户材料，即该租户的 Casdoor org）。
- **全局表**：字典/配置类跨租户共享的数据，可不带 org——但必须在模块 README 声明理由，
  评审时按此核对。

三条纪律：

1. **读写一律按 org 过滤**：`where org = $1`，参数取 `c.get('identity')!.orgId`。漏过滤 =
   共享部署上租户间数据互见（这正是本约定要堵的洞——demo 模块曾没有 org 列）。
2. **唯一约束必须含 org**：`unique(org, …)`。漏掉会出现「A 租户占住名字，B 租户用不了」。
   没有业务唯一键的表（如纯流水）不适用，不强加。
3. **热路径索引以 org 为前缀列**：查询都带 org，不前缀等于全表扫。

**为什么隔离键是 `org` 文本而不是 `tenant_id` 外键**：identity 里现成的是 orgId，模块代码
零 join、自包含；不跨 schema 引 `platform.tenant`（B1 边界干净）；org 与租户 1:1，权威源
在 Casdoor + 租户行。

**存量数据回填口径**（示例见 `modules/demo/migrations/002_note_org.sql`）：无法归属的旧行
回填**空串**——空串不等于任何真 org，对所有租户不可见；宁可不可见，不可错归属。

CI 门禁：暂无（文档 + 评审守）；等第一个真实业务模块落地后再评估要不要扫 migrations 的
建表语句（本仓规矩：门禁升级是单独的决定）。
```

- [ ] **Step 2: architecture.md §5 清单插入一行**

在第 4 条（权限码写进 `manifest.permissions[]`…）之后插入，原第 5、6 条顺延为 6、7：

```markdown
5. **租户数据表必须带 `org` 列**（值 = `identity.orgId`），读写按 org 过滤——约定正文读
   `docs/module-protocol.md`「租户数据隔离」
```

- [ ] **Step 3: 验证文档路径真实**

Run: `rg -n "租户数据隔离" docs/module-protocol.md docs/architecture.md`
Expected: 两文件各命中新内容。

- [ ] **Step 4: Commit**

```bash
git add docs/module-protocol.md docs/architecture.md
git commit -m "docs(module-protocol): 租户数据隔离约定——模块表带 org 列、读写按 org 过滤（spec-1 §2）"
```

---

### Task 3: demo 租户隔离（TDD：先红后绿）

**Files:**
- Create: `apps/server/src/demo-tenant-isolation.test.ts`
- Create: `modules/demo/migrations/002_note_org.sql`
- Modify: `modules/demo/index.ts:39-56`（GET/POST /notes 两个 handler）

**Interfaces:**
- Consumes: `buildApp`（`apps/server/src/app.ts`）、`getPool`（`apps/server/src/db.ts`）、
  `MockCasdoor`（`@platform/auth-core/src/test-util/mock-casdoor`，构造器收 `{users, perms}`，
  权限按 `owner` 分桶、scope 读侧消费 `resources`）。
- Produces: `demo.note.org` 列（`text not null`）；两个端点的行为契约——每个租户只见自己的 note。

- [ ] **Step 1: 写失败测试（完整文件）**

`apps/server/src/demo-tenant-isolation.test.ts`：

```ts
// demo-tenant-isolation.test.ts — spec-1 §2 的机检面：模块租户数据表按 identity.orgId 隔离。
//
// 为什么走真装配而不是手搭模块 router：隔离由「路由按 org 过滤 + identity 注入」两层合成，
// 手搭 router 只测得到第一层；Host→租户→identity.orgId 这条链（I-1 契约）只有 buildApp 有。
// 真 PG + MockCasdoor + multi 形态（同 app.test.ts 约定：无 DATABASE_URL 整体跳过）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 文件级关池（app.test.ts 同款守卫：防某个 describe 私自关池让后续用例拿死池）
afterAll(async () => {
  if (!dbUrl) return
  const pool = getPool({ databaseUrl: dbUrl })
  expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await pool.end().catch(() => {})
})

const ISO_PW = 'pw-isolation-1'

describePg('demo 模块租户隔离（spec-1 §2：org 不可互见）', () => {
  const mock = new MockCasdoor({
    // owner = 用户归属 org（真机语义，smoke-load 同款）：acme/beta 各一名
    users: [
      { name: 'iso-acme', password: ISO_PW, owner: 'acme' },
      { name: 'iso-beta', password: ISO_PW, owner: 'beta' },
    ],
    // 权限按 owner 分桶；scope 读侧消费 resources（loader 供给同形状）
    perms: [
      { owner: 'acme', resources: ['demo:note'], users: ['iso-acme'] },
      { owner: 'beta', resources: ['demo:note'], users: ['iso-beta'] },
    ],
  })
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  beforeAll(async () => {
    await mock.start()
    const config: AppConfig = {
      port: 13000,
      databaseUrl: dbUrl!,
      tenantMode: 'multi', // 两租户并存，Host 头分流（acme.test / beta.test）
      platformOrg: '',
      sessionSecret: 'test-secret-test-secret-test-secret!',
      casdoor: {
        url: mock.origin,
        clientId: 'test-client',
        clientSecret: '',
        application: 'app-built-in',
        adminUser: 'admin',
        adminPwd: 'pw',
      },
      publicOrigin: 'http://127.0.0.1:13000',
      seedDemo: true, // 种 acme/beta 两租户 + demo 启用（tenant_module 源，默认订阅源=platform）
    }
    app = (await buildApp({ config })).app
  })
  afterAll(async () => {
    await mock.stop()
  })

  /** 账密登录拿 platform_session cookie（smoke-load 同款路径） */
  async function sessionCookie(host: string, username: string): Promise<string> {
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host },
      body: JSON.stringify({ username, password: ISO_PW }),
    })
    expect(res.status, `登录 ${username}@${host} 应 200`).toBe(200)
    const jar = res.headers.getSetCookie().join('; ')
    const hit = /platform_session=[^;]+/.exec(jar)
    if (!hit) throw new Error('登录响应未带 platform_session cookie')
    return hit[0]
  }

  it('acme 建的 note，beta 看不到；反向亦然；库里 org 列 = 写入者 org', async () => {
    const acmeCookie = await sessionCookie('acme.test', 'iso-acme')
    const betaCookie = await sessionCookie('beta.test', 'iso-beta')
    const marker = `iso-${Date.now()}`

    const create = async (host: string, cookie: string, body: string) => {
      const res = await app.request('/api/modules/demo/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host, cookie },
        body: JSON.stringify({ body }),
      })
      expect(res.status, `POST note @${host} 应 201`).toBe(201)
      return (await res.json()).note as { id: number }
    }
    const acmeNote = await create('acme.test', acmeCookie, `acme-${marker}`)
    const betaNote = await create('beta.test', betaCookie, `beta-${marker}`)

    const listIds = async (host: string, cookie: string) => {
      const res = await app.request('/api/modules/demo/notes', {
        headers: { host, cookie },
      })
      expect(res.status).toBe(200)
      return ((await res.json()).notes as Array<{ id: number }>).map((n) => n.id)
    }
    const acmeIds = await listIds('acme.test', acmeCookie)
    const betaIds = await listIds('beta.test', betaCookie)

    // 正向：各自见自己（防「过滤成空集」的假绿——两边都空也能过反向断言）
    expect(acmeIds).toContain(acmeNote.id)
    expect(betaIds).toContain(betaNote.id)
    // 反向：互不可见（spec-1 §2 的核心断言）
    expect(acmeIds).not.toContain(betaNote.id)
    expect(betaIds).not.toContain(acmeNote.id)

    // 物理证据：行的 org 列确为写入者 org（列表断言可能被 limit 截断糊弄，这层糊弄不了）
    const pool = getPool({ databaseUrl: dbUrl! })
    const { rows } = await pool.query<{ id: number; org: string }>(
      'select id, org from demo.note where id = any($1::int[])',
      [[acmeNote.id, betaNote.id]],
    )
    const orgById = new Map(rows.map((r) => [r.id, r.org]))
    expect(orgById.get(acmeNote.id)).toBe('acme')
    expect(orgById.get(betaNote.id)).toBe('beta')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform \
  pnpm --filter @platform/server exec vitest run src/demo-tenant-isolation.test.ts
```

Expected: **FAIL**。红的位置：反向断言 `expect(betaIds).not.toContain(acmeNote.id)`（现状
无 org 过滤，beta 看到 acme 的 note）；或物理证据一步（`org` 列不存在，查询报错）。两种红都
算有效红。若因连不上 PG 跳过/报连接错——先解决 DATABASE_URL（本机 5432 可能被原生 postgres
遮蔽 compose 容器）。

- [ ] **Step 3: 写迁移 `modules/demo/migrations/002_note_org.sql`**

```sql
-- 002_note_org.sql — demo.note 补租户维度（spec-1 §2：租户数据表必须带 org）。
-- 幂等：add column if not exists + 回填受 where 约束 + set not null 对已 not null 列是 no-op。
-- 回填口径：无法归属的旧行回填空串——空串不等于任何真 org，对所有租户不可见；
-- 宁可不可见，不可错归属（demo 是占位模块，存量行不可见可接受）。
alter table demo.note add column if not exists org text;
update demo.note set org = '' where org is null;
alter table demo.note alter column org set not null;
-- 热路径索引以 org 为前缀列（查询形状：where org = $1 order by id desc limit 50）
create index if not exists demo_note_org_id_idx on demo.note(org, id);
```

- [ ] **Step 4: 改 `modules/demo/index.ts` 两个 handler**

`GET /notes`（原 39-44 行）改为：

```ts
    r.get('/notes', async (c) => {
      // 租户隔离（spec-1 §2）：读写一律按 identity.orgId 过滤，见 docs/module-protocol.md
      const org = c.get('identity')!.orgId
      const { rows } = await pool.query<NoteRow>(
        'select id, body, created_at from demo.note where org = $1 order by id desc limit 50',
        [org],
      )
      return c.json({ notes: rows })
    })
```

`POST /notes` 的 insert（原 51-54 行）改为：

```ts
      const org = c.get('identity')!.orgId
      const { rows } = await pool.query<NoteRow>(
        'insert into demo.note(org, body) values ($1, $2) returning id, body, created_at',
        [org, text],
      )
```

- [ ] **Step 5: 跑测试确认绿**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform \
  pnpm --filter @platform/server exec vitest run src/demo-tenant-isolation.test.ts
```

Expected: PASS（1 passed）。若红在迁移：检查 002 文件名排序（`002_` > `001_` 字典序成立）、
`platform.schema_migrations` 是否记账。

- [ ] **Step 6: 跑 demo 模块自身与受影响的 server 测试**

```bash
pnpm --filter demo test
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform \
  pnpm --filter @platform/server test
```

Expected: 全绿（app.test.ts 里 POST /api/modules/demo/notes 的 413 用例不受影响——bodyLimit
在业务之前；loader.test 不碰真表结构）。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/demo-tenant-isolation.test.ts modules/demo/migrations/002_note_org.sql modules/demo/index.ts
git commit -m "fix(demo): note 表补租户维度并按 orgId 隔离读写——共享部署租户互见堵洞（spec-1 §2）"
```

---

### Task 4: provision-tenant 增 `--all-tenants`（TDD 纯核先行）

**Files:**
- Modify: `scripts/provision-tenant.mjs`
- Modify: `scripts/provision-tenant.test.ts`

**Interfaces:**
- Consumes: `tenantProvisionSteps`（既有导出，不动）；CLI 既有 Casdoor 调用形状
  `c.ensureModulePlan(org, moduleId)` / `c.upsertSubscription(org, moduleId, { state: 'Active' })`。
- Produces: `planAllTenantGrants(orgs: string[], modules?: string[]): string[]`（新导出，
  纯函数）；CLI 用法 `node scripts/provision-tenant.mjs --all-tenants --module <id>...`。

- [ ] **Step 1: 写失败测试（追加到 `scripts/provision-tenant.test.ts`）**

```ts
import { planAllTenantGrants, tenantProvisionSteps } from './provision-tenant.mjs'
// （原 import 行替换为上面这行，其余原文件内容不动）

describe('planAllTenantGrants（纯核）', () => {
  it('每 org × 每 module 生成 plan/subscribe 两步，顺序稳定（幂等重跑的计划面）', () => {
    expect(planAllTenantGrants(['acme', 'beta'], ['demo'])).toEqual([
      'plan:acme:demo', 'subscribe:acme:demo', 'plan:beta:demo', 'subscribe:beta:demo',
    ])
    expect(planAllTenantGrants(['o1', 'o2'], ['demo', 'case-engine'])).toEqual([
      'plan:o1:demo', 'subscribe:o1:demo', 'plan:o1:case-engine', 'subscribe:o1:case-engine',
      'plan:o2:demo', 'subscribe:o2:demo', 'plan:o2:case-engine', 'subscribe:o2:case-engine',
    ])
  })
  it('空 org 或空 module → 空计划', () => {
    expect(planAllTenantGrants([], ['demo'])).toEqual([])
    expect(planAllTenantGrants(['acme'], [])).toEqual([])
    expect(planAllTenantGrants([], [])).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm run test:guard 2>&1 | tail -20`（守卫单测跑 scripts/ 的测试）
Expected: FAIL——`planAllTenantGrants` 未导出（SyntaxError/undefined is not a function）。

- [ ] **Step 3: 实现（`scripts/provision-tenant.mjs`）**

在 `tenantProvisionSteps` 函数之后加纯核：

```js
export function planAllTenantGrants(orgs, modules = []) {
  const steps = []
  for (const org of orgs) for (const m of modules) steps.push(`plan:${org}:${m}`, `subscribe:${org}:${m}`)
  return steps
}
```

`main()` **整体替换**为下面这版（相对原版的变化：参数解析收拢到 `args`、CasdoorClient 构造
抽成 `makeClient`、`--all-tenants` 分流在前、单租户路径逻辑逐行保留）：

```js
async function main() {
  const args = process.argv.slice(2)
  const allTenants = args.includes('--all-tenants')
  const slug = allTenants ? undefined : args[0]
  const org = (() => { const i = args.indexOf('--org'); return i > 0 ? args[i + 1] : (slug ? `${slug}-org` : '') })()
  const modules = args.flatMap((a, i) => (a === '--module' ? [args[i + 1]] : []))
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  const { Pool: P } = await import('pg')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
  const pool = new P({ connectionString: dbUrl })
  const makeClient = (orgName) => new CasdoorClient({
    origin: process.env.CASDOOR_URL, clientId: process.env.CASDOOR_CLIENT_ID ?? 'x', clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? 'x',
    org: orgName, adminUser: process.env.CASDOOR_ADMIN_USER, adminPwd: process.env.CASDOOR_ADMIN_PWD,
  })

  if (allTenants) {
    // 批量发放（spec-1 §4）：新模块 → 存量租户。orgs 来自 platform.tenant（权威清单，
    // 与装载器同源），每 org 一套 plan+订阅（SaaS spec D2：plan 按租户 org 各建一份）。
    if (modules.length === 0) throw new Error('--all-tenants 需要至少一个 --module <id>')
    const { rows } = await pool.query('select distinct casdoor_org from platform.tenant order by casdoor_org')
    const orgs = rows.map((r) => r.casdoor_org)
    console.log('[provision] 批量发放计划：', planAllTenantGrants(orgs, modules).join(' → '))
    for (const orgName of orgs) {
      const c = makeClient(orgName)
      for (const m of modules) {
        await c.ensureModulePlan(orgName, m)
        await c.upsertSubscription(orgName, m, { state: 'Active' })
        console.log(`  ✓ ${orgName} mod-${m}`)
      }
    }
    await pool.end()
    return
  }

  if (!slug) throw new Error('用法: node scripts/provision-tenant.mjs <slug> [--org <org>] [--module <id>]... | --all-tenants --module <id>...')
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules }).join(' → '))
  const c = makeClient(org)
  await c.ensureOrg(org); console.log('  ✓ org')
  const { rows } = await pool.query(
    `insert into platform.tenant(slug, casdoor_org) values ($1, $2)
     on conflict (slug) do update set casdoor_org = excluded.casdoor_org returning id`,
    [slug, org],
  )
  const tenantId = rows[0].id; console.log('  ✓ tenant-row #' + tenantId)
  await c.ensureAnchorUser(org); console.log('  ✓ anchor')
  // 权限码扇出：modules/*/manifest 的 permissions（与装载器同源）
  const modulesDir = path.join(import.meta.dirname, '..', 'modules')
  const perms = []
  for (const d of await readdir(modulesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const m = parseYaml(await readFile(path.join(modulesDir, d.name, 'manifest.yaml'), 'utf8'))
    for (const p of m?.permissions ?? []) perms.push({ code: p.code, name: p.name })
  }
  await provisionModulePermissions(pool, (o) => (o === org ? c : c), perms); console.log('  ✓ permissions ×' + perms.length)
  for (const m of modules) {
    await c.ensureModulePlan(org, m)
    await c.upsertSubscription(org, m, { state: 'Active' })
    console.log('  ✓ subscribe mod-' + m)
  }
  await pool.end()
}
```

顶部用法注释（第 4 行）同步改为：

```js
// 用法：node scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...（org 缺省 <slug>-org）
//       node scripts/provision-tenant.mjs --all-tenants --module <id>...（批量发放：遍历 platform.tenant 各 org）
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm run test:guard`
Expected: PASS（原 tenantProvisionSteps 用例 + 新 planAllTenantGrants 用例全绿）。

- [ ] **Step 5: 幂等真机走查（有 Casdoor 测试环境时）**

```bash
# 对两个测试租户的库跑两遍，第二遍应无差异、无报错（幂等）：
DATABASE_URL=... CASDOOR_URL=... CASDOOR_ADMIN_USER=... CASDOOR_ADMIN_PWD=... \
  node scripts/provision-tenant.mjs --all-tenants --module demo
```

没有可用的真机 Casdoor 凭据时跳过本步，在 PR body 里注明「--all-tenants 幂等真机走查待环境」。

- [ ] **Step 6: Commit**

```bash
git add scripts/provision-tenant.mjs scripts/provision-tenant.test.ts
git commit -m "feat(scripts): provision-tenant 增 --all-tenants 批量发放订阅（spec-1 §4）"
```

---

### Task 5: 全量验证 + push + PR

**Files:** 无新文件。

**Interfaces:**
- Consumes: Task 1 的 issue 编号 `#N`。

- [ ] **Step 1: 全量验证（CI 跑什么本地跑什么）**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @platform/web build && pnpm smoke
```

Expected: 全绿。`pnpm test` 含 apps/server 真 PG 测试（需 DATABASE_URL，无则跳过——CI 的
unit job 挂 PG 跑，本地至少把 Task 3 的单文件用 DATABASE_URL 跑过）。

- [ ] **Step 2: push 分支**

```bash
git push -u origin docs/customization-tiering-spec
```

（git 代理 7897 时好时坏：先直接 push，SSL 错才用
`git -c http.proxy= -c https.proxy= push ...` 绕过。）

- [ ] **Step 3: 开 PR**

```bash
gh pr create --repo MYTech-Co-LTD/platform-core \
  --base main \
  --title "feat(demo): 模块租户数据隔离 + provision 批量发放（spec-1） (#N)" \
  --body "$(cat <<'EOF'
Closes #N

## 内容

- docs：module-protocol.md 新节「租户数据隔离」+ architecture.md §5 加行（spec-1 §2 正文）
- fix(demo)：002 迁移补 org 列（存量回填空串=对所有租户不可见）、GET/POST /notes 按
  identity.orgId 过滤；真装配集成测试锁「acme/beta 互不可见 + 行的 org 列=写入者」
- feat(scripts)：provision-tenant 增 --all-tenants --module，遍历 platform.tenant 各 org
  幂等发放 plan+Active 订阅（纯核 planAllTenantGrants 带测）

## 验证

- [x] demo-tenant-isolation.test.ts 绿（真 PG + MockCasdoor + multi 形态）
- [x] pnpm test / typecheck / build / smoke 全绿
- [ ] --all-tenants 幂等真机走查（待环境 / 已走查，二选一留真话）

spec：docs/superpowers/specs/2026-09-14-customization-tiering-design.md
EOF
)"
```

（`#N` 替换为 Task 1 记下的编号；走查 checkbox 按实际情况勾，**不编**。）

- [ ] **Step 4: 等 CI CLEAN 再请求合并**

PR 开出后盯 CI；`merge-only-on-clean-ci`：**UNSTABLE 不合**。CI 全绿后人审合并（squash）。
