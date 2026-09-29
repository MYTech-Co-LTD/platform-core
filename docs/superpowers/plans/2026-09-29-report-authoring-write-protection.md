# 报表写保护 实施计划（报表制作域 4/5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落 spec §3③「写不静默覆盖」：**内容指纹 / 登记表版本号**这两个"平台算的版本" + **每对象一把锁** +
**可解释的 409**，让陈旧写拿到「一句能读懂的话 + 当前版本」，而不是把人改的内容静默抹掉。

**Architecture:**
- **两条写路径、两种版本**（spec §3③ 的两种形态各归其位）：
  - **内容侧**（Metabase dashboard：布局/参数/卡片/锁参）→ 比对物 = **现算指纹**（`readDashboardContent(...).fingerprint`，24 hex，已存在且 `publishWithTenantBinding` 已在返回它）——**不存库**（spec 待拍 1 的建议：这条不变量存在的意义就是别信陈旧状态）。
  - **登记侧**（`data.reports` 行：页门/发布/回收）→ 比对物 = **登记表版本号**（新增 `version integer`，每次写 +1）——指纹覆盖不到 `required_scope` 这类登记字段，所以这条必须有自己的单调计数。
- **写请求必须带版本（人裁 2026-09-29：fail-closed）**：对**已存在**的对象，更新**必须**带对应版本；不带 ⇒ 409（让人先读再写）。首次创建不需要版本（没有可覆盖的东西）。
- **每对象一把锁**：进程内互斥（仓内零锁基建，不引依赖，手搓 ~15 行）。键 = 内容侧按**规范名** `${org}/${title}`（创建前没有 id，且这样并发同名创建也串行）、登记侧按 `${org}:${id}`。
- **锁是"把竞态窗口关掉"，版本比对是"把陈旧写挡掉"**——两者都要（spec 实测：单线程服务会把竞态藏起来 ⇒ 测试必须真并发）。

**Tech Stack:** node-postgres（迁移 006）+ Hono（`modules/data/routes/reports.ts`）+ zod（body 放宽为带版本）+ React/antd（console 携带版本与冲突人话）。**零新依赖**。

## Global Constraints

1. **两条版本通路不许混名**（记忆里的教训：先确认术语指哪条通路）：内容侧一律叫 **`expectedFingerprint`（string）**，登记侧一律叫 **`expectedVersion`（integer）**。任何地方出现「version」都指登记侧、出现「fingerprint」都指内容侧。
2. **迁移必须幂等**（既有纪律）：`alter table … add column if not exists …`；`005` 号段**已核**（2026-09-29：仓内实际只有 001–004）——**原稿写的是 `006`，是错的**（没有 005 就跳号）；实施前仍照纪律 `ls modules/data/migrations/` 再确认一次。
3. **跨 schema 纪律（架构 lint B1）**：只动 `modules/data/**`（schema = `data`）。**不碰** `apps/server/**`、`apps/mb-proxy/**`（编辑反代今天 deny `PUT /api/dashboard/{did}`，与写保护正交，见"不在范围"）。
4. **不引依赖**（B2 与仓内惯例）：锁手搓、指纹复用既有 `createHash`，**不加** `async-mutex` / `p-limit` / `jose`。
5. **`POST /reports` 的 body 是 `.strict()`**（`ReportBody`）——新增键必须同时进 schema，否则 400。
6. **`DELETE` 的版本走 query 串**（`?expectedVersion=N`）而**不是**请求体：DELETE 体可能被中间层剥掉（openship edge 是 OpenResty），query 串没有这个风险。`apiSend` 已支持 DELETE（方法集 `'POST' | 'PUT' | 'DELETE'`，无 PATCH）。
7. **进程内锁的边界要写在代码注释与 README 里**：单实例成立；多副本部署时会退化成"只有版本比对生效"（不静默，只是并发窗口变宽）。别把它说成分布式锁。
8. **既有并发用例的期望要按设计变化更新**：`modules/data/routes/reports.test.ts` 里那条「并发建同名 ⇒ 造出孤儿 dashboard」的用例，在加锁后**应当**不再造孤儿——改断言并在注释里写明"这条不变量由写保护改了，不是回归"。
9. **测试口径**：`DATABASE_URL` 由 shell 提供（正典值见 README）；**并发用例必须真并发**（数组字面量里同时发起 + `Promise.all`，照既有 `reports.test.ts` 的 stub 竞态写法），不要用 `describe.concurrent`（本包 `fileParallelism: false`，仓内零 usage）。
10. **提交**：Conventional Commits，**单 scope**（`fix(data): …` / `feat(data): …`），每任务一提交；不删改 provenance trailer。
11. **不在本范围**：agent 制作通路与语义源维度（计划 5）；编辑反代侧对 dashboard 的**写**放行（今天 deny，属计划 5/后续）；审计（spec §2 提及、无定义——本计划只在 409 响应里带 `currentVersion`，不落审计表）。

---

### Task 1: 登记表版本列 + 存储层带上版本

**Files:**
- Create: `modules/data/migrations/005_report_version.sql`
- Modify: `modules/data/domain/report-store.ts`
- Test: `modules/data/domain/report-store.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `ReportRow` / `toReportRow` / `listReports` / `getReport` / `upsertReport` / `updateRequiredScope`。
- Produces:
  - `ReportRow` 新增字段 **`version: number`**（登记表单调计数）。
  - `updateRequiredScope(pool, org, id, requiredScope, expectedVersion): Promise<ReportRow | null>`——**签名加一个必填参数**；语义：`version = expectedVersion` 才更新（`version = version + 1`），否则返回 `null`（**与"行不存在"合流**：路由层要先 `getReport` 区分 404 与 409，见 Task 3）。
  - `upsertReport(...)` 的冲突分支 `version = data.reports.version + 1`（新建行由列默认 `1`），返回值仍是 `id`（**新增** `version` 的读取走 `getReport`）。
  - 新导出 `getReportVersion(pool, org, id): Promise<number | null>`（轻量只读，供路由层做 409 的 `currentVersion`）。

- [ ] **Step 1: 写迁移**（幂等；先 `ls modules/data/migrations/` 确认号段没被占）

```sql
-- 005_report_version.sql — 登记侧版本号（spec §3③ 的「登记表上的单调计数」形态）。
-- 幂等：重复执行不报错（部署脚本每次全量重跑全部迁移）。
alter table data.reports add column if not exists version integer not null default 1;
```

- [ ] **Step 2: 写失败测试**（追加进 `report-store.test.ts` 的 `describePg` 块内）

```ts
  it('version：新建行 = 1；每次写 +1；expectedVersion 不符 ⇒ 不更新', async () => {
    const org = 'org-version-store'
    await pool.query('delete from data.reports where org = $1', [org])
    const id = await upsertReport(pool, org, {
      title: 'V', metabaseId: 21, embedParams: {}, requiredScope: null,
    })
    expect((await getReport(pool, org, id))!.version).toBe(1)

    // 命中版本 ⇒ 更新且 +1
    const ok = await updateRequiredScope(pool, org, id, 'sales:read', 1)
    expect(ok).toMatchObject({ requiredScope: 'sales:read', version: 2 })

    // 陈旧版本 ⇒ null（不更新）
    expect(await updateRequiredScope(pool, org, id, 'finance:read', 1)).toBeNull()
    expect((await getReport(pool, org, id))!.requiredScope).toBe('sales:read')

    // 跨租户 ⇒ null
    expect(await updateRequiredScope(pool, 'org-version-store-other', id, null, 2)).toBeNull()

    // 重新登记（upsert 冲突分支）也 +1
    await upsertReport(pool, org, { title: 'V', metabaseId: 21, embedParams: {}, requiredScope: null })
    expect((await getReport(pool, org, id))!.version).toBe(3)
  })
```

- [ ] **Step 3: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run domain/report-store.test.ts`
Expected: FAIL（`version` 未定义 / 参数个数不符）。

- [ ] **Step 4: 实现**（`report-store.ts`：投影加 `version`、`ReportRow` 加字段、`updateRequiredScope` 加参数与条件、新增 `getReportVersion`）

```ts
export interface ReportRow {
  id: string
  title: string
  metabaseId: number      // renderer='platform' 时为哨兵 0
  embedParams: Record<string, string>
  requiredScope: string | null
  renderer: ReportRenderer
  /** 登记侧版本号（spec §3③）：每次写 +1；写请求必须回带它（人裁 2026-09-29 fail-closed）。 */
  version: number
}
```

```ts
/** 条件更新：只有 version 命中才落，返回更新后的整行；不命中（陈旧 / 跨租户 / 不存在）返回 null。 */
export async function updateRequiredScope(
  pool: Pool, org: string, id: string, requiredScope: string | null, expectedVersion: number,
): Promise<ReportRow | null> {
  const r = await pool.query(
    `update data.reports
        set required_scope = $3, version = version + 1, updated_at = now()
      where org = $1 and id = $2 and version = $4
      returning ${REPORT_COLS}`,
    [org, id, requiredScope, expectedVersion],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}

/** 轻量只读：只为 409 的 currentVersion（给客户端重试用）。 */
export async function getReportVersion(pool: Pool, org: string, id: string): Promise<number | null> {
  const r = await pool.query('select version from data.reports where org = $1 and id = $2', [org, id])
  return r.rowCount === 0 ? null : (r.rows[0].version as number)
}
```

（把六列投影提成常量 `REPORT_COLS = 'id, title, metabase_id, embed_params, required_scope, renderer, version'`，四处 `select/returning` 共用——避免漏改一处导致 `toReportRow` 拿到 `undefined`。）

- [ ] **Step 4b: 同步路由调用点（否则本任务收不了尾）**

`updateRequiredScope` 加参数会让 `routes/reports.ts` 的调用点**编译失败** ⇒ 本任务必须顺手把它改到能编译、且**行为与改前一致**（临时传"刚读到的版本"，等 Task 3 再把版本从请求里来）：

```ts
  // 临时形态（Task 3 会把 expectedVersion 改成从请求体/查询串取）：
  const before = await getReport(ctx.pool, org, id)
  if (before === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const row = await updateRequiredScope(ctx.pool, org, id, parsed.data.requiredScope, before.version)
  if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)   // 走到这里只可能是并发删行
```

⚠️ 这只是让**每个任务各自收得了尾**的过渡；**别停在这**——Task 3 负责把它换成真正的守卫（版本来自请求，不符 ⇒ 409）。
并在 `report-store.test.ts` 里把既有 `updateRequiredScope(...)` 调用一并补上版本参数。

- [ ] **Step 5: 跑测试确认绿 + 全模块回归**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data test`（域层 + 路由层 + console 三套都应绿）

- [ ] **Step 6: Commit**

```bash
git add modules/data/migrations/005_report_version.sql modules/data/domain/report-store.ts modules/data/domain/report-store.test.ts
git commit -m "feat(data): 登记表加 version 列（写保护：登记侧单调计数 + 条件更新）"
```

---

### Task 2: 内容侧版本契约（`POST /reports` 回指纹 + 必填 `expectedFingerprint`）

**Files:**
- Modify: `modules/data/routes/reports.ts`（`ReportBody`、`POST /reports` 的写序列与响应）
- Test: `modules/data/routes/reports.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `upsertDashboard`（返回 `{id, created}`）、`publishWithTenantBinding`（**已返回 `{mapped, fingerprint, embeddingParams}`**）、`readDashboardContent`。
- Produces:
  - `POST /reports` body 新增可选键 **`expectedFingerprint: string | null`**（`.strict()` 里加）。
    语义：**当命中同名 dashboard 时（更新既有对象）必填**；缺失 ⇒ `409 {error:'VERSION_REQUIRED', currentFingerprint}`；不符 ⇒ `409 {error:'STALE_WRITE', currentFingerprint}`；新建（`created === true`）时带上它也接受但忽略。
  - `201` 响应体新增 **`fingerprint`**（写后的现算值）与 **`version`**（Task 1 的登记侧版本，写后回读）。

- [ ] **Step 1: 写失败测试**（追加进 PG describe）

```ts
  it('★ 内容侧写保护：命中同名（更新既有）不带 expectedFingerprint ⇒ 409 VERSION_REQUIRED + 当前指纹', async () => {
    const { app } = manage()
    const first = await (await post(app, { title: '写保护报表' })).json() as { fingerprint: string }
    expect(typeof first.fingerprint).toBe('string')          // 201 回指纹（此前没有）

    const res = await post(app, { title: '写保护报表' })      // 第二次 = 更新既有 dashboard
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('VERSION_REQUIRED')
    expect(typeof body.currentFingerprint).toBe('string')

    // 带对的指纹 ⇒ 201；带过期的 ⇒ 409 STALE_WRITE
    const ok = await post(app, { title: '写保护报表', expectedFingerprint: first.fingerprint })
    expect(ok.status).toBe(201)
    const stale = await post(app, { title: '写保护报表', expectedFingerprint: 'deadbeef' })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe('STALE_WRITE')
  })

  it('★ 首次创建不需要版本（没有可覆盖的东西）', async () => {
    const { app } = manage()
    expect((await post(app, { title: '全新报表' })).status).toBe(201)
  })
```

- [ ] **Step 2: 跑测试确认红** → `DATABASE_URL=… pnpm --filter data exec vitest run routes/reports.test.ts`，FAIL。

- [ ] **Step 3: 实现**（`reports.ts`）

```ts
const ReportBody = z.object({
  title: z.string().trim().min(1).max(200),
  lockedParams: z.record(z.string()).default({}),
  requiredScope: z.string().min(1).nullable().default(null),
  // 内容侧版本（写保护）：更新既有 dashboard 时**必填**；见 handler 里的 fail-closed 分支
  expectedFingerprint: z.string().min(1).nullable().default(null),
}).strict()
```

handler 里在 `upsertDashboard` 之后、`publishWithTenantBinding` **之前**插守卫（关键：**必须在写之前判**，且 `created === false` 时才要求）：

```ts
      const up = await upsertDashboard(deps, dashboardName(org, parsed.data.title))
      // ── 内容侧写保护（spec §3③；人裁 2026-09-29 fail-closed）──────────────────────────
      // 命中同名 ⇒ 这是**更新既有对象**：必须回带它当前的指纹，否则一律拒（不带就让人先读再写，
      // 不接受「省略 = 强制覆盖」——那正是实测里"人的两张图被静默抹掉"的那条路）。
      if (!up.created) {
        const cur = await readDashboardContent(deps, up.id)
        if (parsed.data.expectedFingerprint === null) {
          return c.json({ error: 'VERSION_REQUIRED', currentFingerprint: cur.fingerprint }, 409)
        }
        if (parsed.data.expectedFingerprint !== cur.fingerprint) {
          return c.json({ error: 'STALE_WRITE', currentFingerprint: cur.fingerprint }, 409)
        }
      }
```

并在 `201` 响应里补两个值（`publishWithTenantBinding` 已算过指纹，零额外请求；`version` 用 `getReport` 回读一次）：

```ts
      return c.json({ id, metabaseId: up.id, created: up.created, fingerprint: pub.fingerprint, version: row.version }, 201)
```
（把现有的 `await publishWithTenantBinding(...)` 的返回值接住为 `pub`——它**当前被丢弃**了。）

- [ ] **Step 4: 跑测试确认绿**

Run: `DATABASE_URL=… pnpm --filter data exec vitest run routes/reports.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "feat(data): 内容侧写保护——回指纹 + 更新既有报表必带 expectedFingerprint"
```

---

### Task 3: 登记侧守卫（`PUT`/`DELETE` 必带 `expectedVersion`）+ 管理清单回版本

**Files:**
- Modify: `modules/data/routes/reports.ts`（`GateBody`、`PUT /reports/:id`、`DELETE /reports/:id`、`GET /reports/manage` 投影）
- Test: `modules/data/routes/reports.test.ts`（追加 + 改既有 PUT/DELETE 用例的调用）

**Interfaces:**
- Consumes: Task 1 的 `updateRequiredScope(…, expectedVersion)` / `getReportVersion`；既有 `getReport` / `deleteReport` / `listReports`。
- Produces:
  - `GET /reports/manage` 每行新增 **`version: number`**（console 拿它回带）。
  - `PUT /reports/:id` body 新增必填 **`expectedVersion: number`**（`.strict()`）：缺失/非法 ⇒ `400 INVALID_BODY`；行不存在 ⇒ `404`；**行存在但版本不符 ⇒ `409 {error:'STALE_WRITE', currentVersion}`**。
  - `DELETE /reports/:id?expectedVersion=N`：query 缺/非法 ⇒ `400 INVALID_BODY`；不存在 ⇒ `404`；不符 ⇒ `409 {error:'STALE_WRITE', currentVersion}`；相符 ⇒ 归档 + 删行 + `204`。

- [ ] **Step 1: 写失败测试**（追加；并把既有「PUT 改页门」「DELETE 回收」两条用例的调用补上 `expectedVersion`——从 `GET /reports/manage` 读回来）

```ts
  it('★ 登记侧写保护：缺版本 400 / 陈旧 409（带 currentVersion）/ 命中 200 且版本 +1', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '登记写保护' })).json()

    const listed = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    const v0 = listed.reports.find((r) => r.id === id)!.version
    expect(v0).toBe(1)

    // 缺 expectedVersion ⇒ 400（strict + 必填）
    const missing = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read' }),
    })
    expect(missing.status).toBe(400)

    // 命中 ⇒ 200 且版本推进
    const ok = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: v0 }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).version).toBe(v0 + 1)

    // 陈旧（拿 v0 再写）⇒ 409 + 当前版本
    const stale = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'finance:read', expectedVersion: v0 }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'STALE_WRITE', currentVersion: v0 + 1 })
  })

  it('★ 回收也带版本：陈旧 ⇒ 409，且**没有被归档**（Metabase 侧无调用）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '回收写保护' })).json()
    mb.state.calls.length = 0
    const stale = await app.request(`/reports/${id}?expectedVersion=99`, { method: 'DELETE' })
    expect(stale.status).toBe(409)
    expect(mb.state.calls).toHaveLength(0)     // 守卫必须先于归档
    expect((await app.request(`/reports/${id}?expectedVersion=1`, { method: 'DELETE' })).status).toBe(204)
  })
```

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**（`reports.ts`）

```ts
const GateBody = z.object({
  requiredScope: z.string().min(1).nullable(),
  // 登记侧版本（写保护；人裁 fail-closed）：必填，缺则 400
  expectedVersion: z.number().int().positive(),
}).strict()
```

```ts
  r.put('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = GateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    const row = await updateRequiredScope(ctx.pool, org, id, parsed.data.requiredScope, parsed.data.expectedVersion)
    if (row === null) {
      // 分不清「不存在」与「版本不符」会有两种错判 ⇒ 先查一次给准确答复（不泄漏跨租户：带 org 查）
      const cur = await getReportVersion(ctx.pool, org, id)
      if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
      return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
    }
    return c.json({ id: row.id, title: row.title, requiredScope: row.requiredScope, renderer: row.renderer, version: row.version })
  })
```

DELETE：把 `expectedVersion` 从 query 串取（`Number(c.req.query('expectedVersion'))`，非正整数 ⇒ 400），**先**用 `updateRequiredScope` 同款条件做版本判定——但删除语义不同（要真删），所以拆两步：先 `getReportVersion` 比版本（不符 ⇒ 409），相符再走既有「先归档、再删行」序列。⚠️ 步骤 1 的用例已断言 409 时 `mb.state.calls` 为空 ⇒ **版本判定必须发生在 `archiveDashboard` 之前**。

- [ ] **Step 4: 跑测试确认绿 + 全模块**

Run: `DATABASE_URL=… pnpm --filter data test` → PASS（既有 PUT/DELETE 用例都已补 `expectedVersion`）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "feat(data): 登记侧写保护——PUT/DELETE 必带 expectedVersion，管理清单回版本号"
```

---

### Task 4: 每对象一把锁（进程内）+ 并发承重测试

**Files:**
- Create: `modules/data/domain/object-lock.ts`
- Modify: `modules/data/routes/reports.ts`（把三处写序列包进锁）
- Test: `modules/data/domain/object-lock.test.ts`（新建）+ `modules/data/routes/reports.test.ts`（并发用例）

**Interfaces:**
- Consumes: 无（零依赖手搓）。
- Produces: `withObjectLock<T>(key: string, fn: () => Promise<T>): Promise<T>`——同键串行、异键并行；`fn` 抛错不影响后续排队者。

- [ ] **Step 1: 写失败测试**（新建 `object-lock.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { withObjectLock } from './object-lock'

describe('withObjectLock', () => {
  it('同键串行：后一个必须等前一个结束', async () => {
    const order: string[] = []
    const slow = withObjectLock('k', async () => {
      order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end')
    })
    const fast = withObjectLock('k', async () => { order.push('b') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('异键并行：互不等待', async () => {
    const order: string[] = []
    await Promise.all([
      withObjectLock('x', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('x') }),
      withObjectLock('y', async () => { order.push('y') }),
    ])
    expect(order).toEqual(['y', 'x'])
  })

  it('前一个抛错不卡死后续', async () => {
    await expect(withObjectLock('e', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await withObjectLock('e', async () => 'ok')).toBe('ok')
  })
})
```

- [ ] **Step 2: 跑测试确认红** → `pnpm --filter data exec vitest run domain/object-lock.test.ts`。

- [ ] **Step 3: 实现 `modules/data/domain/object-lock.ts`**

```ts
// object-lock.ts — 每对象一把锁（spec §3③）。**进程内**：单实例成立；多副本部署时退化成
// 「只有版本比对生效」（不静默，只是并发窗口变宽）——别当分布式锁用。
//
// 为什么手搓而不引 async-mutex：仓内零锁基建、零相关依赖（实测 grep），这点需求不值得引包。
// 语义：同键串行、异键并行；前一个抛错不影响后续排队者（用 settled 的链尾做锚）。
const chains = new Map<string, Promise<unknown>>()

export function withObjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // 前一个无论成功失败都继续排队（失败已由它自己的调用方处理）
  const run = prev.then(fn, fn)
  const tail = run.then(() => {}, () => {})
  chains.set(key, tail)
  // 链尾就是自己时清掉，避免 Map 无限增长
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}
```

- [ ] **Step 4: 把写序列包进锁**（`routes/reports.ts`）

- `POST /reports`：整段（`upsertDashboard → 指纹守卫 → publish → setEmbedding → upsertReport → 回读`）包进
  `withObjectLock(\`${org}/dash:${dashboardName(org, title)}\`, async () => { … })`——键用**规范名**（创建前没有 id；顺带把"并发同名创建"也串起来）。
- `PUT /reports/:id`、`DELETE /reports/:id`：包进 `withObjectLock(\`${org}/row:${id}\`, …)`。

- [ ] **Step 5: 写并发承重测试**（照既有 `reports.test.ts:965` 的确定性竞态范式）

```ts
  it('★ 并发写：6 个同版本 PUT ⇒ 恰 1 成功 + 5 × 409（账实相符，spec §3③ 读数）', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '并发写保护' })).json()
    const listed = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    const v0 = listed.reports.find((r) => r.id === id)!.version

    // 数组字面量里同时发起（真并发；本包 fileParallelism:false，串行描述块不会替我们制造并发）
    const pending = Array.from({ length: 6 }, () => app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'sales:read', expectedVersion: v0 }),
    }))
    const results = await Promise.all((await Promise.all(pending)).map((r) => r.status))
    expect(results.filter((s) => s === 200)).toHaveLength(1)
    expect(results.filter((s) => s === 409)).toHaveLength(5)
    const after = await (await app.request('/reports/manage')).json() as { reports: { id: string; version: number }[] }
    expect(after.reports.find((r) => r.id === id)!.version).toBe(v0 + 1)   // 只落一次
  })
```

并把既有「并发建同名 ⇒ 造孤儿」用例**改断言**：加锁后不再造孤儿（`mb.state.dashboards` 长度 1），注释写明「这条不变量由写保护改了，不是回归」。

- [ ] **Step 6: 跑测试确认绿 + 全模块**

Run: `DATABASE_URL=… pnpm --filter data test` → PASS。

- [ ] **Step 7: Commit**

```bash
git add modules/data/domain/object-lock.ts modules/data/domain/object-lock.test.ts modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "feat(data): 每对象一把锁（进程内）+ 并发写承重测试（6 并发恰 1 落）"
```

---

### Task 5: console 携带版本 + 409 人话 + 冲突后自动刷新

**Files:**
- Modify: `modules/data/console/reports/index.tsx`、`modules/data/console/lib/api.ts`（`MESSAGES`）
- Test: `modules/data/console/reports/index.test.tsx`（追加 + 改既有两条写用例的桩）

**Interfaces:**
- Consumes: Task 3 的 `version` 字段与 409 形状。
- Produces: 无下游消费方（页面是端点）。

- [ ] **Step 1: 写失败测试**（追加；既有「发布」「改页门」「回收」用例的断言要跟着带上版本）

```tsx
  it('★ 写请求带上读到的版本；409 ⇒ 出人话并自动刷新列表', async () => {
    let reloads = 0
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) { reloads += 1; return json({ reports: [ROWS[0]] }) }
      if (init?.method === 'PUT') return json({ error: 'STALE_WRITE', currentVersion: 9 }, 409)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /发\s*布/ }))
    await confirmPopconfirm('确认发布')

    // ① 请求体带版本（ROWS[0].version）② 409 出人话 ③ 列表被重新拉取（reload）
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')!
      expect(JSON.parse(String(put.init?.body))).toMatchObject({ requiredScope: null, expectedVersion: ROWS[0].version })
    })
    expect(await screen.findByText('这份报表刚被别人改过，已为你刷新，请重试')).toBeInTheDocument()
    await waitFor(() => expect(reloads).toBeGreaterThan(1))
  })
```

（`ROWS` 夹具要补 `version` 字段——所有行给 1，自绘行也给（登记侧版本与渲染器无关）。）

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**

- `ReportRow` 加 `version: number`；发布/改页门/回收三处提交都带上 `expectedVersion: r.version`（回收走 query 串：`apiSend(\`/reports/${r.id}?expectedVersion=${r.version}\`, 'DELETE')`）。
- `MESSAGES` 加三条：

```ts
  STALE_WRITE: '这份报表刚被别人改过，已为你刷新，请重试',
  VERSION_REQUIRED: '需要先读取最新版本再提交（页面已为你刷新）',
  RENDERER_NOT_EDITABLE: '平台自绘报表没有可编辑的 Metabase 页面',   // 已有，别重复加
```

- 三处 `catch` 里：`messageOf(e)` 出人话后**总是** `await load()`（冲突后列表即刷新，与文案一致）。

- [ ] **Step 4: 跑测试确认绿 + 回归**

Run: `pnpm --filter data exec vitest run console/` → `pnpm --filter data test` → `pnpm --filter web test`。

- [ ] **Step 5: Commit**

```bash
git add modules/data/console/reports/index.tsx modules/data/console/reports/index.test.tsx modules/data/console/lib/api.ts
git commit -m "feat(data): console 写动作携带版本 + 409 冲突人话与自动刷新"
```

---

### Task 6: 文档与 spec 订正（写保护语义、调用方义务、锁的边界）

**Files:**
- Modify: `modules/data/README.md`（「报表面」小节）
- Modify: `docs/superpowers/specs/2026-09-28-report-authoring-design.md`（§7 待拍 1/2 标为已定 + §3③ 补"已落地"注记）

**Interfaces:** 无代码接口（纯文档）。

- [ ] **Step 1: README 补「写保护」小节**（逐字；放在「管理面」小节之后）

````markdown
### 写保护：两条版本通路 + 每对象一把锁（spec §3③）

| 写什么 | 比对物 | 谁提供 | 哪里读 |
|---|---|---|---|
| Metabase 报表**内容**（布局/参数/卡片/锁参） | **内容指纹**（现算 24 hex） | 平台算（`readDashboardContent`） | `POST /reports` 的 201 响应 `fingerprint` |
| **登记行**（页门/发布/回收） | **登记表版本号**（整数，每次写 +1） | 平台算（`data.reports.version`） | `GET /reports/manage` 每行 `version` |

- **调用方义务（fail-closed）**：**更新既有对象必须回带版本**。缺 ⇒ `409 VERSION_REQUIRED`，不符 ⇒ `409 STALE_WRITE`（响应带 `currentVersion`/`currentFingerprint`）⇒ 读最新的再重试。
  首次创建无需版本（没有可覆盖的东西）。
- ⚠️ **重跑登记（`POST /reports`）现在也需要指纹**：它是"更新既有 dashboard"这条路 ⇒ 先读一次再写。
- **每对象一把锁**：进程内（同键串行）。⚠️ **单实例成立**；多副本部署时退化为"只有版本比对生效"（不静默，只是并发窗口变宽）。
````

- [ ] **Step 2: spec 订正**（把人裁与实际选择记进去）
  - §7 待拍 1（指纹存哪）：标 **已定 = 现算**，并注明内容侧现算、登记侧用登记表计数列（两种形态各归其位）。
  - §7 待拍 2（串行化到哪一步）：标 **已定 = 乐观比对 + 每对象一把锁（进程内）**，注明"单写队列留待有并发案例再加"。
  - §3③ 末补一行：「**已落地（计划 4）**：内容侧指纹现算 + 登记侧 `version` 列 + 进程内每对象一把锁 + 409 带当前版本」。

- [ ] **Step 3: Commit**

```bash
git add modules/data/README.md docs/superpowers/specs/2026-09-28-report-authoring-design.md
git commit -m "docs(data): 写保护语义与调用方义务（README）+ spec 待拍 1/2 结案"
```

---

## Self-Review（写完后自查）

**1. spec 覆盖**：§3③ 的两条实测现象（agent 静默抹掉两张图 / 6 并发只落 2 条）→ Task 2/3 的守门 + Task 4 的锁与并发测试（**读数对齐**：6 并发 ⇒ 1 成功 + 5 被拒）。§3⑤ 的「陈旧版本写 409」→ Task 3。§8 步骤 2 的三件（版本守卫 + 锁 + 冲突人话文案）→ Task 2/3/4/5。§7 待拍 1/2 → Task 6 结案。
**2. 占位符扫描**：无 TBD；`…` 只用在命令里替代重复的 `DATABASE_URL` 前缀（首次出现已给全）。
**3. 类型一致性**：`ReportRow.version: number`（Task 1 产，Task 3/5 消）；`updateRequiredScope(pool,org,id,requiredScope,expectedVersion)`（Task 1 产，Task 3 消）；`expectedFingerprint: string|null`（Task 2 body）与 `expectedVersion: number`（Task 3 body）**分属两条通路**（Constraint 1）；409 码 `STALE_WRITE`/`VERSION_REQUIRED` 在 Task 2/3 产出、Task 5 消费。

## 已定裁决（人裁 2026-09-29，实施前不要再翻）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | 版本比对必填还是可选 | **必填、fail-closed**（更新既有对象不带版本 ⇒ 409） | spec §3③ 的存在意义就是「写不静默覆盖」；可选 = 不变量降级成建议，而那正是实测复现过的失效 |
| 2 | 指纹存哪 | **现算**（不存库） | spec 待拍 1 建议；`readDashboardContent` 已是现算且 `publishWithTenantBinding` 已在返回它（零成本可得） |
| 3 | 串行化做到哪一步 | **乐观比对 + 每对象一把锁（进程内）**，不做单写队列 | spec 待拍 2 建议 + 本仓「无案例不立标准」 |
| 4 | `DELETE` 的版本载体 | **query 串**（`?expectedVersion=N`），不用请求体 | DELETE 体可能被中间层剥掉（edge 是 OpenResty）；`apiSend` 已支持 DELETE |
| 5 | 编辑反代侧对 dashboard 的**写**放行 | **不在本计划**（今天 deny；与写保护正交） | 与计划 3 的规则表一致，改动属计划 5 或后续 issue |

## 与另几份计划的关系

| 计划 | 内容 | 状态 |
|---|---|---|
| 1 | 写路径底座（含**现算指纹**） | 已交付（PR #329） |
| 2 | 统一管理面（PUT 页门**故意无守卫**，注明归本计划） | 已交付（PR #338） |
| 3 | 编辑页反代会话 | 已交付（PR #366 + 纠偏 #372） |
| **4（本份）** | **写保护**（spec §8 步骤 2） | 待实施 |
| 5 | agent 制作通路（步骤 5）+ 语义的源维度（§3⑧ / 待办 6-7，**需先裁 spec 待办 6 的建议方案与待办 7 的命名**） | 待写 |
