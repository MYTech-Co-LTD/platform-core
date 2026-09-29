# 报表统一管理面 实施计划（报表制作域 2/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec §8 步骤 3（管理面）落成后端两端点 + console 双视图：租户管理员在平台 console 看全量、改页门、发布、回收；观看面行为不变；reconcile 回读失败按行降级；embed-url 对 platform 行显式拒绝（不签死链）。

**Architecture:** 管理面唯一（spec §2/§3⑤）——管理动作（页门/发布/回收）只存在于平台：后端新增**管理清单** `GET /reports/manage`（data:manage，不按行裁剪）与**页门改动** `PUT /reports/:id`（data:manage，「发布」= 置 null，**不新增 published 列**）；console 报表页签按 `session.scopes`（Outlet context，demo 模块先例）选**管理视图**或**观看视图**——这是视图选择不是鉴权，真正的门由宿主按 manifest 施加。`renderer='platform'` 的行在本计划只被**展示与守卫**（创建通路归计划 4）。

**Tech Stack:** Hono + zod + node-postgres（`pg`）+ vitest（Metabase 内存桩，照 `routes/reports.test.ts` 既有脚手架）；前端 antd + react-router（`useOutletContext` 读 session.scopes）。零迁移、零新 env。

## Global Constraints

1. **唯一事实源 `data.reports`**：本计划**零迁移**——不新增表/列；「发布」= `required_scope` 置 null（口径同 `data.metrics.required_scope`：NULL = 所有拿到本模块的人可见），**不新增 published 列**（spec §2：登记表 + renderer 列就是全部状态）。
2. **org 隔离**：行读写一律 `where org = $1`；跨租户/不存在一律 **404**（不给存在性探针）。
3. **门禁由宿主施加（声明即授权 fail-closed）**：新增路由必须**同一提交**改 `manifest.yaml` 的 `api.internal`；改路由不改 manifest（或反之）= 装载期双向核对失败 = 部署即挂。前端按 session.scopes 选视图只是**视图选择**，不是鉴权（服务端 403 由 SDK `declaredScopeGate` 给）。
4. **不碰 `domain/metabase.ts`（纯 HTTP 客户端）与 `domain/report-content.ts`**：本计划没有 Metabase 写路径。
5. **写保护归计划 4**（spec §8 步骤 2：版本守卫 + 锁 + 冲突人话文案）：`PUT /reports/:id` **故意不做**版本比对 / If-Match / 409 陈旧写——别「顺手补上」，守卫的比对物（指纹）与冲突文案是计划 4 的交付物。
6. **platform 行的创建通路归计划 4**：本计划对 `renderer='platform'` 只做「不签死链」守卫（409）与管理面展示。测试里 platform 行用 `upsertReport(pool, org, { …, renderer: 'platform', metabaseId: 0 })` 直插（`metabaseId=0` 是哨兵，见 `ReportRow` 头注）。
7. **不在本计划范围**：审计（spec §2 提及、无定义——待 spec 补充后另议）、console 内对账按钮、报表登记表单（创建仍走 `POST /reports` API/管线，console 不做第二次口径）、反代编辑页（spec §3⑦ 三约束，人裁 2026-09-29 **拆为计划 3**）。
8. **外部字段 text**（既定纪律）；本计划无 DDL，万一任务演进需要迁移，照 004 的幂等模板（`do $$ … exception when duplicate_object then null; end $$`）。
9. **提交**：Conventional Commits，每任务一提交；不删改 provenance trailer（铁律 L3）。
10. **测试环境**：`DATABASE_URL` 由 shell 提供（vitest 不读 dotenv），正典值 `postgres://platform:platform@127.0.0.1:5432/platform`；各测试文件的 `ORG` 隔离键常量互不相同（避免互相擦数据）。

---

### Task 1: `report-store.updateRequiredScope`（存储层）

**Files:**
- Modify: `modules/data/domain/report-store.ts`（文件尾追加函数）
- Test: `modules/data/domain/report-store.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 `toReportRow` / `ReportRow`（同文件）。
- Produces: `updateRequiredScope(pool: Pool, org: string, id: string, requiredScope: string | null): Promise<ReportRow | null>`——Task 2 的 PUT handler 是唯一消费方；命中返回更新后的整行，没命中返回 null。

- [ ] **Step 1: 写失败测试**（追加进 `report-store.test.ts` 的既有 `describePg` 块内，复用其 `pool`/`ORG`/`upsertReport` import）

```ts
  it('updateRequiredScope：改页门落库并返回整行；没命中（跨租户/不存在）返回 null', async () => {
    const org = 'org-gate-store'
    await pool.query('delete from data.reports where org = $1', [org])
    const id = await upsertReport(pool, org, {
      title: 'D', metabaseId: 13, embedParams: {}, requiredScope: 'sales:read',
    })

    const updated = await updateRequiredScope(pool, org, id, 'finance:read')
    expect(updated).toMatchObject({ id, title: 'D', requiredScope: 'finance:read', renderer: 'metabase' })
    const db = await pool.query('select required_scope from data.reports where org = $1 and id = $2', [org, id])
    expect(db.rows[0].required_scope).toBe('finance:read')

    // 发布（置 null）
    expect((await updateRequiredScope(pool, org, id, null))!.requiredScope).toBeNull()

    // 跨租户 org ⇒ null（不存在性的唯一表达，不给存在性探针）
    expect(await updateRequiredScope(pool, 'org-gate-store-other', id, null)).toBeNull()
  })
```

并把文件头 import 行补上 `updateRequiredScope`：

```ts
import { getReport, updateRequiredScope, upsertReport } from './report-store'
```

- [ ] **Step 2: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run report-store.test.ts`
Expected: FAIL，`updateRequiredScope is not a function`（import 不存在）。

- [ ] **Step 3: 最小实现**（追加到 `report-store.ts` 文件尾，紧跟 `deleteReport`）

```ts
/**
 * 页门改动（管理面动作，spec §3⑤）：`requiredScope` 传 null = **发布**（所有拿到本模块的人
 * 可见，口径同 `data.metrics.required_scope`）。**没有独立的 published 列**——「未发布」就是
 * 页门未放行在观看面的表现，不为管理动作新增状态列。
 *
 * 返回更新后的整行（`updatedAt` 由 SQL 侧 `updated_at = now()` 维护，不在投影里）；
 * 没命中（跨租户 / id 不存在）返回 null ⇒ 路由层一律 404。
 */
export async function updateRequiredScope(
  pool: Pool, org: string, id: string, requiredScope: string | null,
): Promise<ReportRow | null> {
  const r = await pool.query(
    `update data.reports
        set required_scope = $3, updated_at = now()
      where org = $1 and id = $2
      returning id, title, metabase_id, embed_params, required_scope, renderer`,
    [org, id, requiredScope],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run report-store.test.ts`
Expected: PASS（含既有 renderer 用例）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/report-store.ts modules/data/domain/report-store.test.ts
git commit -m "feat(data): report-store 页门改动 updateRequiredScope（null=发布）"
```

---

### Task 2: 路由与 manifest——管理清单 + 页门改动 + 观看投影补 renderer

**Files:**
- Modify: `modules/data/routes/reports.ts`（新增 GET `/reports/manage`、PUT `/reports/:id`；GET `/reports` 投影补 `renderer`）
- Modify: `modules/data/manifest.yaml`（`api.internal` 加两行，**与路由同一提交**——Global Constraint 3）
- Test: `modules/data/routes/reports.test.ts`（声明用例改七个端点 + 新负测/正测）

**Interfaces:**
- Consumes: Task 1 的 `updateRequiredScope`；既有 `listReports` / `requesterOf` / `reportIdOf`。
- Produces:
  - `GET /reports/manage` → `200 { reports: [{ id, title, requiredScope, renderer }] }`（**全量**本 org 行，不做 `visibleTo` 行裁剪；行序 `order by title`）
  - `PUT /reports/:id`，body `{ requiredScope: string | null }`（`.strict()`，多余键 400）→ `200 { id, title, requiredScope, renderer }`；body 不合法 400 `INVALID_BODY`；跨租户/不存在 404 `NOT_FOUND`
  - `GET /reports`（观看面）投影从 `{id,title,requiredScope}` 扩为 `{id,title,requiredScope,renderer}`（**附加字段**，Task 5 的观看视图靠它置灰 platform 行）

- [ ] **Step 1: 写失败测试**——三处改动：

①声明用例（`describe('报表面声明（不需要数据库）')` 内）五个端点改七个，并加新负测：

```ts
  it('七个端点都声明了，且页门分档：管理动作=data:manage，观看面=data:query', () => {
    const declared = new Map(
      (mod.manifest.api?.internal ?? []).map((d) => [`${d.method} ${d.path}`, d.scope]),
    )
    expect(declared.get('POST /reports')).toBe('data:manage')
    expect(declared.get('GET /reports')).toBe('data:query')
    expect(declared.get('GET /reports/:id/embed-url')).toBe('data:query')
    expect(declared.get('DELETE /reports/:id')).toBe('data:manage')
    expect(declared.get('POST /reports/reconcile')).toBe('data:manage')
    expect(declared.get('GET /reports/manage')).toBe('data:manage')
    expect(declared.get('PUT /reports/:id')).toBe('data:manage')
  })

  it('★ 页门负测：只有 data:query ⇒ 管理清单 / 页门改动同样 403', async () => {
    const app = gatedApp(makeIdentity({ orgId: ORG, scopes: ['data:query'] }), null)
    // ⚠️ 断言必须带 body（`need: 'data:manage'`），不能只断 status（订正记录 2026-09-29，Task 2
    // 实施中发现）：**未声明**的路径走门卫的 `!hit` 兜底，同样给 403——只断 status 的话，这条负测
    // 在「manifest 还没加两行声明」的红跑里就是绿的，manifest 声明根本没被这测试承重。
    const list = await app.request('/reports/manage')
    expect(list.status).toBe(403)
    expect(await list.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
    const put = await app.request('/reports/whatever', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: null }),
    })
    expect(put.status).toBe(403)
    expect(await put.json()).toEqual({ error: 'FORBIDDEN', need: 'data:manage' })
  })
```

②PG describe 内新增正测（复用既有 `shell`/`manage`/`post` helper 与 `pool`）：

```ts
  it('GET /reports/manage：data:manage 身份看全量本 org 行（含页门未放行的）+ renderer', async () => {
    const { app, identity } = manage()
    // 插入序刻意与标题序**不一致**（platform 行先插、标题最大的反而最先落库）——见下「订正记录」
    await upsertReport(pool, identity.orgId, {
      title: '3 自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })
    await post(app, { title: '2 未放行报表', requiredScope: 'sales:read' })
    await post(app, { title: '1 已发布报表', requiredScope: null })

    const res = await app.request('/reports/manage')
    expect(res.status).toBe(200)
    const body = await res.json()
    // 行序 = order by title（listReports 既有口径）。⚠️ 三条订正记录（2026-09-29，Task 2 实施 +
    // 评审后由人裁定「现在修」）：
    //  ① 原稿期望值 ['公开报表','自绘大盘','未放行报表'] 与同一句声明的公式 order by title 冲突——
    //     原稿是错的（控制器已 psql 独立复核本库次序）。
    //  ② 但**照实测值硬写中文次序**等于把库的 CJK collation 钉进测试（repo 未 pin locale，
    //     `order by title` 也没写 COLLATE）⇒ 换 locale 就红。改为标题带 **ASCII 数字前缀**：
    //     次序由 ASCII 决定，与 collation 无关。
    //  ③ 且插入序必须**不等于**标题序：否则「按 title 排」与「按堆序（=插入序）返回」两种实现
    //     都绿 ⇒ 断言不承重（删掉 order by title 也发现不了）。故 platform 行先插。
    // 这条断言同时兼作「管理面不按行裁剪」的证据：若误用 visibleTo 裁行，
    // 「2 未放行报表」会消失、此处变 2 行而红。
    expect(body.reports.map((r: { title: string }) => r.title)).toEqual(
      ['1 已发布报表', '2 未放行报表', '3 自绘大盘'],
    )
    expect(body.reports.find((r: { title: string }) => r.title === '2 未放行报表'))
      .toMatchObject({ requiredScope: 'sales:read', renderer: 'metabase' })
    expect(body.reports.find((r: { title: string }) => r.title === '3 自绘大盘'))
      .toMatchObject({ renderer: 'platform' })
  })

  it('GET /reports（观看面）投影补 renderer；页门未放行的行照旧不可见', async () => {
    const { app } = manage()
    await post(app, { title: '公开报表', requiredScope: null })
    await post(app, { title: '未放行报表', requiredScope: 'data:manage' })
    const viewerApp = shell(makeIdentity({ orgId: ORG, scopes: ['data:query'] })).app
    const body = await (await viewerApp.request('/reports')).json()
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0]).toMatchObject({ title: '公开报表', renderer: 'metabase' })
  })
  // ⚠️ 注意：观看面投影多一个 `renderer` 会**连带打破**文件里既有的「投影键集」断言
  //    （形如 `toEqual({ id, title, requiredScope })`）——这是必然的，按新四元组同步订正即可，
  //    不是回归。

  it('PUT /reports/:id：改页门落库并返回整行；置 null = 发布', async () => {
    const { app } = manage()
    const { id } = await (await post(app, { title: '销售日报', requiredScope: 'sales:read' })).json()

    const res = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'finance:read' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json())
      .toMatchObject({ id, title: '销售日报', requiredScope: 'finance:read', renderer: 'metabase' })
    const db = await pool.query('select required_scope from data.reports where id = $1', [id])
    expect(db.rows[0].required_scope).toBe('finance:read')

    const pub = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: null }),
    })
    expect(pub.status).toBe(200)
    expect((await pub.json()).requiredScope).toBeNull()
  })

  it('★ PUT 负测：多余键 400（strict）/ 空串 400 / 跨租户 404 且写不动', async () => {
    const { app, identity } = manage()
    const { id } = await (await post(app, { title: '销售日报' })).json()

    const extra = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'a:read', title: '顺手改名' }),
    })
    expect(extra.status).toBe(400)

    const empty = await app.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: '' }),
    })
    expect(empty.status).toBe(400)

    const other = shell(makeIdentity({ orgId: OTHER_ORG, scopes: ['data:query', 'data:manage'] })).app
    const cross = await other.request(`/reports/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requiredScope: 'hacked:scope' }),
    })
    expect(cross.status).toBe(404)
    const db = await pool.query('select org, required_scope from data.reports where id = $1', [id])
    expect(db.rows[0]).toMatchObject({ org: identity.orgId, required_scope: null })
  })
```

③（订正记录 2026-09-29：原稿此处要求「文件头 import 补 `updateRequiredScope`」——**本任务的测试
不消费它**（用 `upsertReport` 直插行即可，页门改动由 HTTP 端到端覆盖），加了就是死 import。
该指令已作废；若实施者已加，属待清理项。）

- [ ] **Step 2: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: FAIL——声明用例缺两条断言、新用例 404/路由不存在。

- [ ] **Step 3: 实现**

`manifest.yaml` 的 `api.internal` reports 段加两行（保持列对齐风格）：

```yaml
    - { method: GET,    path: /reports/manage,        scope: data:manage }
    - { method: PUT,    path: /reports/:id,           scope: data:manage }
```

`routes/reports.ts`：import 行补 `updateRequiredScope`（与 `upsertReport` 并列）；`registerReports` 内、**`GET /reports` 之后**加两个 handler（注册序：字面量静态路径在前，param 路由在后——#145 口径；本计划 GET 侧无 param 兄弟，顺序只是显式表达）：

```ts
  // ── 管理清单（spec §3⑤：租户管理员看**全量**本 org 行，含页门未放行的）─────────────
  // 与观看清单 GET /reports 的分野：观看面按行 required_scope 裁剪（visibleTo），管理面**不裁**
  // ——页门未放行的行对管理员必须可见、可改，否则没人能把未发布的报表发出来。
  // 授权由宿主门卫按 manifest（data:manage）施加，handler 不再判权限。
  r.get('/reports/manage', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const rows = await listReports(ctx.pool, c.get('tenant').casdoor_org)
    return c.json({
      reports: rows.map((row) => ({
        id: row.id, title: row.title, requiredScope: row.requiredScope, renderer: row.renderer,
      })),
    })
  })

  const GateBody = z.object({ requiredScope: z.string().min(1).nullable() }).strict()

  // ── 页门改动（管理面动作：页门/发布/回收之「页门」「发布」）─────────────────────────
  // 发布 = requiredScope 置 null；改页门 = 换成新 scope。**没有独立的 published 列**
  // （见函数头顶注与计划 Global Constraints 1）。
  // ⚠️ 写保护（陈旧版本写 409）归计划 4（spec §8 步骤 2）——这里**故意**没有版本守卫。
  r.put('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = GateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const row = await updateRequiredScope(
      ctx.pool, c.get('tenant').casdoor_org, id, parsed.data.requiredScope,
    )
    // 跨租户/不存在一律 404——不给存在性探针（口径同 DELETE）
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({
      id: row.id, title: row.title, requiredScope: row.requiredScope, renderer: row.renderer,
    })
  })
```

并给观看清单投影补 `renderer`（附加字段，一行改动）：

```ts
      return c.json({
        reports: rows.filter((row) => visibleTo(row, requester))
          .map((row) => ({
            id: row.id, title: row.title, requiredScope: row.requiredScope, renderer: row.renderer,
          })),
      })
```

- [ ] **Step 4: 跑测试确认绿 + 守卫**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: PASS。
Run: `pnpm --filter data test`（全模块，含 manifest 双向核对/隔离守卫）Expected: PASS。

- [ ] **Step 5: 文档**（`modules/data/README.md` 的「报表面」小节补**管理面**语义；人裁 2026-09-29「加一小节」）

在「### Metabase 侧的名称 = `<org>/<title>`」小节**之前**插入下述内容（锚点：紧随页门/数据门那张两列表格下方，即 `| 数据门 | ... ` 那一行之后空行处）：

````markdown
### 管理面（改页门 / 发布 / 回收）：动作都在平台，**没有独立的 published 状态**

「未发布」不是一种状态位，而是**页门未放行在观看面的表现**（`data.reports` **没有** `published`
列，也不打算加）：

| 动作 | 怎么做 | 端点 |
|---|---|---|
| 发布（所有人可见） | 把页门清空 | `PUT /reports/:id` body `{"requiredScope": null}` |
| 改页门（换成新 scope） | 换一个 scope 串 | `PUT /reports/:id` body `{"requiredScope":"sales:read"}` |
| 回收 | 归档 dashboard + 删登记行 | `DELETE /reports/:id`（既有） |

- **管理清单 `GET /reports/manage`**（`data:manage`）与观看清单 `GET /reports`（`data:query`）
  的分野是**行裁剪**：观看面按行 `required_scope` 过滤（`visibleTo`），管理面**不裁**——
  页门未放行的行对管理员必须可见、可改，否则没人能把未发布的报表发出来。
- 跨租户 / 不存在的 id 一律 **404**（不给存在性探针）；`PUT` body 用 `.strict()`（多余键 400）。
- ⚠️ **写保护（陈旧版本写 409 / If-Match）尚未落地**，归计划 4（spec §8 步骤 2）。
- ⚠️ **入口可见性**：本模块 console 入口声明是单值 `data:query`（`manifest.yaml` 的
  `frontend.console`）⇒ 只持 `data:manage` 的人**看不到本模块入口**。这是模块入口的既有口径，
  非管理面引入；要改成「任一持有即可进」得先改宿主 `frontend.console` 的 scope 语义（架构先行）。
````

- [ ] **Step 6: Commit**（路由 + manifest **同一提交**）

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts modules/data/manifest.yaml modules/data/README.md
git commit -m "feat(data): 报表管理面端点——管理清单 GET /reports/manage + 页门 PUT /reports/:id"
```

---

### Task 3: embed-url 渲染器通道守卫（platform 行不签死链）

**Files:**
- Modify: `modules/data/routes/reports.ts`（`GET /reports/:id/embed-url` handler，`visibleTo` 检查之后加守卫）
- Test: `modules/data/routes/reports.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 `ReportRow.renderer`。
- Produces: embed-url 对 `renderer='platform'` 的行返回 `409 { error: 'RENDERER_NOT_EMBEDDABLE' }`——Task 5 的 console MESSAGES 用同一错误码出人话文案。

- [ ] **Step 1: 写失败测试**（PG describe 内追加）

```ts
  it('★ renderer=platform ⇒ embed-url 409 RENDERER_NOT_EMBEDDABLE（不签死链 token）', async () => {
    const { app, identity } = manage()
    const id = await upsertReport(pool, identity.orgId, {
      title: '自绘大盘', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })
    const res = await app.request(`/reports/${id}/embed-url`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'RENDERER_NOT_EMBEDDABLE' })
    // 守卫必须发生在任何 Metabase 调用之前（metabaseId=0 是哨兵，拿它签 token = 签死链）
    expect(mb.state.calls).toHaveLength(0)
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: FAIL——现状返回 200 + 指向不存在 dashboard 的死链 URL。

- [ ] **Step 3: 实现**（`embed-url` handler 内、`visibleTo` 检查之后插入）

```ts
    // 渲染器通道守卫：platform 行没有 Metabase dashboard（metabaseId=0 是哨兵），给它签 token
    // = 签一张**指向不存在 dashboard 的死链**。显式 409，等平台自绘渲染通路（计划 4）接上后
    // 由前端按 renderer 走另一条观看通道。
    if (row.renderer === 'platform') {
      return c.json({ error: 'RENDERER_NOT_EMBEDDABLE' }, 409)
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "fix(data): embed-url 对 platform 行显式 409，不再签死链 token"
```

---

### Task 4: reconcile 回读按行降级（一行坏不再整单 502）

**Files:**
- Modify: `modules/data/routes/reports.ts`（`POST /reports/reconcile` 的回读循环，:253 起的 `try { for … }` 块）
- Test: `modules/data/routes/reports.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 `readDashboardContent`（对非 2xx 抛 `MetabaseError`）。
- Produces: reconcile 响应新增字段 `contentUnreadable: [{ id, title, metabaseId }]`——回读失败（`MetabaseError`）的行落这里，**不再让整单 502**；`ok` 判据纳入它（非空 ⇒ false）；`console.warn` 摘要行同步加计数。其余差集语义不变。

- [ ] **Step 1: 写失败测试**（PG describe 内追加；`json` helper 已在文件头）

```ts
  it('★ 对账按行降级：一行回读 500 只落 contentUnreadable，其余行照常判（不再整单 502）', async () => {
    const { app, identity } = manage()
    const badId = await upsertReport(pool, identity.orgId, {
      title: '坏盘', metabaseId: 5, embedParams: {}, requiredScope: null,
    })
    const goodId = await upsertReport(pool, identity.orgId, {
      title: '未锁盘', metabaseId: 6, embedParams: {}, requiredScope: null,
    })
    // 两张都在可嵌入集（否则会先落 missingInMetabase 而不是走到回读）
    mb.state.dashboards.push(
      { id: 5, name: `${identity.orgId}/坏盘`, embeddable: true, archived: false },
      { id: 6, name: `${identity.orgId}/未锁盘`, embeddable: true, archived: false },
    )
    // dashboard 5 的 GET 回 500 ⇒ readDashboardContent 抛 MetabaseError；其余透传原桩
    const inner = mb.fetcher
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/5') return json({ message: 'boom' }, 500)
      return inner(String(url), init)
    })

    const res = await app.request('/reports/reconcile', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.contentUnreadable).toEqual([{ id: badId, title: '坏盘', metabaseId: 5 }])
    // 好盘照常判：可嵌入但 tenant 没锁 ⇒ tenantUnlocked 照报（降级不吞别的差集）
    expect(body.tenantUnlocked).toEqual([{ id: goodId, title: '未锁盘', metabaseId: 6 }])
  })

  // ⚠️ 订正记录（2026-09-29，Task 4 实施者用变异验证发现）：**上面这一条不够承重**——
  //    ① 把 `ok` 判据里 `contentUnreadable.length === 0` 那一项删掉，它照样绿（那条断言里还有
  //       别的差集非空在撑 ok:false）；② 把 per-row catch 改成「全吞」（不分 MetabaseError）也照样绿。
  //    两条都是本任务的明确要求，「不被断言钉住的要求 = 下一个人删掉它不会有任何红」。故各补一条：
  it('★ ok 判据承重：contentUnreadable 是**唯一**非空差集时 ok 也 false（其余四项全空，只有这一项撑着）', async () => {
    const { app, identity } = manage()
    const badId = await upsertReport(pool, identity.orgId, {
      title: '唯一坏盘', metabaseId: 7, embedParams: {}, requiredScope: null,
    })
    mb.state.dashboards.push(
      { id: 7, name: `${identity.orgId}/唯一坏盘`, embeddable: true, archived: false },
    )
    const inner = mb.fetcher
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/7') return json({ message: 'boom' }, 500)
      return inner(String(url), init)
    })

    const body = await (await app.request('/reports/reconcile', { method: 'POST' })).json()
    expect(body.contentUnreadable).toEqual([{ id: badId, title: '唯一坏盘', metabaseId: 7 }])
    // 其余四个差集与 unregistered 都空 —— 故 ok 只可能被 contentUnreadable 那一项压成 false
    expect(body.missingInMetabase).toEqual([])
    expect(body.tenantUnlocked).toEqual([])
    expect(body.tenantUnbound).toEqual([])
    expect(body.unregistered).toEqual({ recoverable: [], needsHuman: [] })
    expect(body.ok).toBe(false)
  })

  it('★ 只吞 MetabaseError：回读抛的不是 MetabaseError（代码缺陷 / 连接层异常）⇒ 继续往上抛 500，不伪装成按行降级', async () => {
    const { app, identity } = manage()
    await upsertReport(pool, identity.orgId, {
      title: '连接炸盘', metabaseId: 8, embedParams: {}, requiredScope: null,
    })
    mb.state.dashboards.push(
      { id: 8, name: `${identity.orgId}/连接炸盘`, embeddable: true, archived: false },
    )
    const inner = mb.fetcher
    // fetch 自己抛（连不上/被中止）——metabase.ts 的 call() 不包这一层 ⇒ 原样上抛，不是 MetabaseError。
    // 全吞式 catch 会把它误报成「这一行读不出」= 把代码缺陷降级成业务状态（静默）；500 才是它的位置。
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/dashboard/8') throw new Error('socket hang up')
      return inner(String(url), init)
    })

    const res = await app.request('/reports/reconcile', { method: 'POST' })
    expect(res.status).toBe(500)
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: FAIL——现状整单 502 `METABASE_ERROR`。

- [ ] **Step 3: 实现**——把回读循环的**外层 try/catch 整体拆除**，改为**包住每一次 `readDashboardContent`** 的逐行 catch：

```ts
    const tenantUnlocked: { id: string; title: string; metabaseId: number }[] = []
    const tenantUnbound: { id: string; title: string; metabaseId: number }[] = []
    // 按行降级（计划 2）：一行回读失败（上游对**这一个** dashboard 说不行）只落 contentUnreadable，
    // 不再让整单 502——对账的存在意义就是把「哪里坏了」**显式报出来**，一行坏拖死全租户的报告
    // 恰是相反。只有非 MetabaseError（代码缺陷等）才继续往上抛。
    const contentUnreadable: { id: string; title: string; metabaseId: number }[] = []
    for (const r of rows) {
      // renderer=platform：整体跳过（metabaseId=0 是哨兵，比对/回读都只会产出永久噪声）
      if (r.renderer === 'platform') continue
      // 已经报成 missingInMetabase 的行不重复报（回读也只会 404）
      if (!embeddableIds.has(r.metabaseId)) continue
      let content: Awaited<ReturnType<typeof readDashboardContent>>
      try {
        content = await readDashboardContent(deps, r.metabaseId)
      } catch (err) {
        if (err instanceof MetabaseError) {
          contentUnreadable.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
          continue
        }
        throw err
      }
      const params = content.embeddingParams
      if (params[TENANT_SLUG] !== 'locked') {
        tenantUnlocked.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
        continue
      }
      // ① 参数没声明 或 ② 任一卡带 tenant 标签但**没映射** ⇒ 锁了但绑不到（判据原样保留，见下）
      const declared = content.parameters.some((p) => p['slug'] === TENANT_SLUG)
      const isTenantMapped = (d: { parameterMappings?: unknown[] }) =>
        (d.parameterMappings ?? []).some(
          (m) => (m as { parameter_id?: unknown }).parameter_id === TENANT_PARAM_ID,
        )
      const unboundCards = content.dashcards.filter(
        (d) => d.cardId !== null && (content.cardTags[d.cardId] ?? []).includes(TENANT_SLUG) && !isTenantMapped(d),
      )
      if (!declared || unboundCards.length > 0) {
        tenantUnbound.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
      }
    }
```

（循环体从 `tenantUnlocked` 声明行到 `tenantUnbound.push` 为止是**原代码平移**——判据一行不改，只动 try/catch 的粒度与位置；原注释一并随行保留。）

`ok` 判据加一项、`console.warn` 摘要加计数、响应体加字段：

```ts
    const ok = missingInMetabase.length === 0
      && unregistered.recoverable.length === 0
      && unregistered.needsHuman.length === 0
      && tenantUnlocked.length === 0
      && tenantUnbound.length === 0
      && contentUnreadable.length === 0
```

```ts
        + `tenantUnlocked=${tenantUnlocked.length} `
        + `tenantUnbound=${tenantUnbound.length} `
        + `contentUnreadable=${contentUnreadable.length}`,
```

```ts
      missingInMetabase,
      tenantUnlocked,
      tenantUnbound,
      contentUnreadable,
      unregistered,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: PASS（既有对账用例语义不变）。

- [ ] **Step 5: 文档**（`modules/data/README.md`：差集表加第五行 + 改小标题）

把 `### \`POST /reports/reconcile\` 的四个差集（spec §7 双写面对账）` 的标题改为
`### \`POST /reports/reconcile\` 的五个差集（spec §7 双写面对账）`，并在表格 `unregistered.needsHuman`
那一行**之后**追加：

```markdown
| `contentUnreadable` | 回读 `GET /api/dashboard/{id}` 抛 `MetabaseError`（上游对**这一张**说不行） | **本 org**（逐行降级：不再整单 502） |
```

并在该表下方补一句：`contentUnreadable` 非空 ⇒ `ok:false`；回读按**行**降级——一个 dashboard
回读失败只把那一行报出来，不让整租户的对账整单 502（对账的意义就是把「哪里坏了」显式报出来）。

- [ ] **Step 6: Commit**

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts modules/data/README.md
git commit -m "fix(data): reconcile 回读失败按行降级，一行坏不再整单 502"
```

---

### Task 5: console 报表页签双视图（管理视图 + 观看视图）

**Files:**
- Modify: `modules/data/console/reports/index.tsx`（整页改造：双视图 + 管理动作 + renderer 徽章）
- Modify: `modules/data/console/lib/api.ts`（`MESSAGES` 加一条）
- Test: `modules/data/console/reports/index.test.tsx`（新建，脚手架照 `console/index.test.tsx`）

**Interfaces:**
- Consumes: Task 2 的 `GET /reports/manage` / `PUT /reports/:id` / `GET /reports`（含 `renderer`）；Task 3 的 `RENDERER_NOT_EMBEDDABLE`；既有 `apiGet` / `apiSend`（已支持 `'PUT' | 'DELETE'`）/ `messageOf`；Outlet context 的 `session.scopes`（demo 模块先例：本地声明结构子集，零宿主 import）。
- Produces: 无下游消费方（页面是端点）。

- [ ] **Step 1: 写失败测试**（新建 `console/reports/index.test.tsx`；antd `Popconfirm`/`Modal` 的测试交互照 `console/metrics/index.test.tsx` 既有写法，下面的 selector 辅助如与该文件现成写法不同，以那边的为准）

```tsx
// index.test.tsx — 报表页签：双视图选择（session.scopes）+ 管理动作（页门/发布/回收）。
// 挂载形态照宿主壳真实结构：ReportsPage 经 Outlet 注入 session（demo 模块先例）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ReportsPage from './index'

const m = vi.mocked(platformFetch)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const ROWS = [
  { id: 'r1', title: '销售日报', requiredScope: null, renderer: 'metabase' },
  { id: 'r2', title: '未放行报表', requiredScope: 'sales:read', renderer: 'metabase' },
  { id: 'r3', title: '自绘大盘', requiredScope: null, renderer: 'platform' },
]

function renderPage(scopes: string[]) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes } }} />,
        children: [{ path: '/console/data/reports', element: <ReportsPage /> }],
      },
    ],
    { initialEntries: ['/console/data/reports'] },
  )
  render(<RouterProvider router={router} />)
}

// ⚠️ 订正记录（2026-09-29，Task 5 实施中的实测；**as-built 权威版本在仓库文件里**）——本节代码块
//    是按 **antd v5** 的惯用法写的，本仓实际是 **antd 6.6.3**，四处必须改：
//    ① 确认按钮查询：不要用 DOM 结构 selector（`.ant-popconfirm .ant-btn-primary` 随版本/主题漂，
//       v6 里 primary 已是 color/variant 三元组）⇒ 改用**显式 okText + Role 文案查询**（见下 helper）；
//       ⚠️ 结论：**给每个 Popconfirm 显式写 `okText`**（`确认发布`/`确认回收`），否则默认取 locale
//       （无宿主 ConfigProvider 时是 "OK"，测试会随宿主 locale 漂）。
//    ② 中文按钮名必须用**容空白正则**查：antd v6 的 `spaceChildren` 会在两个汉字之间插入**真实空格**，
//       `{ name: /发\s*布/ }` 必然找不到 ⇒ 一律写成 `{ name: /发\s*布/ }`（同理 `/回\s*收/`、`/改\s*页\s*门/`、
//       `/打\s*开/`、`/确\s*定/`）。
//    ③ Modal 必须**显式** `okText="确定"`：无宿主 ConfigProvider 时 antd 默认是 `OK`，本文件实现块
//       若漏写而测试按「确 定」查 ⇒ 该用例必红。实现块已同步补 `okText="确定" cancelText="取消"`。
//    ④ 「回收」按钮**每一行都有** ⇒ 单数 `getByRole` 会 multiple，要用 `getAllByRole` 后取 [0]。
const confirmPopconfirm = async (okText: string) => {
  // 按 Role + 显式 okText 文案查——不赌 DOM 结构、也不赌宿主 locale
  fireEvent.click(await screen.findByRole('button', { name: okText }))
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    // 顺序 matters：/reports/manage 与 /reports/:id/embed-url 都以 /reports 开头，长的先判
    if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
    if (/\/reports\/[^/]+\/embed-url$/.test(url)) return json({ url: 'https://mb.test/embed/abc' })
    if (url.endsWith('/reports')) return json({ reports: ROWS.filter((r) => r.requiredScope === null) })
    if (init?.method === 'PUT') return json({ ok: true })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return json({})
  })
})
afterEach(cleanup)

describe('报表页签双视图', () => {
  it('data:manage ⇒ 拉管理清单，行全量可见（含未放行），有管理动作', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    expect(calls[0]?.url.endsWith('/reports/manage')).toBe(true)
    expect(screen.getByText('平台自绘')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /发\s*布/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /回\s*收/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /改\s*页\s*门/ }).length).toBeGreaterThan(0)
  })

  it('只有 data:query ⇒ 拉观看清单（不发 /reports/manage），无管理动作，platform 行打开置灰', async () => {
    renderPage(['data:query'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    expect(calls.some((c) => c.url.endsWith('/reports/manage'))).toBe(false)
    expect(screen.queryByRole('button', { name: /发\s*布/ })).not.toBeInTheDocument()
    const selfDrawnRow = screen.getByText('自绘大盘').closest('tr')!
    expect((selfDrawnRow.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('发布：Popconfirm 确认 ⇒ PUT requiredScope=null', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /发\s*布/ }))
    await confirmPopconfirm('确认发布')
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')
      expect(put?.url).toMatch(/\/reports\/r2$/)
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: null })
    })
  })

  it('改页门：Modal 输入 scope 保存 ⇒ PUT requiredScope=<值>', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /改\s*页\s*门/ })[0])
    fireEvent.change(screen.getByPlaceholderText('如 sales:read'), { target: { value: 'finance:read' } })
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }))
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')
      expect(put?.url).toMatch(/\/reports\/r[123]$/)
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: 'finance:read' })
    })
  })

  it('回收：Popconfirm 确认 ⇒ DELETE', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /回\s*收/ })[0])
    await confirmPopconfirm('确认回收')
    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === 'DELETE')
      expect(del?.url).toMatch(/\/reports\/r[123]$/)
    })
  })

  it('打开时服务端 409 ⇒ 出人话文案（RENDERER_NOT_EMBEDDABLE；真实通路 = embed-url）', async () => {
    // ⚠️ 订正记录（2026-09-29，Task 3 评审提出）：原稿这里桩的是 **PUT** 返回该码——**假通路**：
    // 全仓唯一产出 `RENDERER_NOT_EMBEDDABLE` 的是 `GET /reports/:id/embed-url`（Task 3 的守卫），
    // PUT 永远不会返它。改桩 embed-url，同时这也是**唯一**能走到该文案的路径：
    // 列表里的 platform 行「打开」已置灰（前一条用例），只有「加载后该行才变成 platform」这种
    // 陈旧视图/竞态才会点到——即该 MESSAGES 条目是**防御性**的，不是主路径。
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })   // 销售日报（metabase 行）
      if (/\/reports\/[^/]+\/embed-url$/.test(url)) {
        return json({ error: 'RENDERER_NOT_EMBEDDABLE' }, 409)
      }
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /打\s*开/ }))
    expect(await screen.findByText('平台自绘报表没有嵌入预览通道')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm --filter data exec vitest run console/reports/index.test.tsx`
Expected: FAIL——现页面不发 `/reports/manage`、无管理动作。

- [ ] **Step 3: 实现**——`console/reports/index.tsx` 整页改造。文件头注释改写（原「②只读：不含建/改/删」的裁决被 spec 管理面取代，**必须改注释**否则与代码自相矛盾）：

```tsx
// console/reports/index.tsx — 「报表」页签：观看面（清单 + 嵌入预览）+ 管理面（data:manage）。
//
// 三条纪律落在这个文件里：
//  ① **不发 Metabase 凭据、不自己拼嵌入 URL**：iframe 的 src 只能来自平台的
//     `GET /reports/:id/embed-url`（服务端签的短期 JWT，locked.tenant = 调用者 org）。
//     前端拿不到 secret，也就没有「自己换租户」的面。
//  ② 管理动作（页门/发布/回收）只对 `data:manage` 身份出现（spec §3⑤ 管理面唯一）——
//     scope 判定读 Console 壳经 Outlet 注入的 session.scopes（demo 模块先例），这只是
//     **视图选择**；真正的授权由宿主门卫按 manifest 施加，前端不重复判权。
//     登记/改登记内容（标题、锁参）仍走 API/管线，不在消费层第二次定义口径。
//  ③ renderer='platform'（平台自绘）的行**没有 Metabase 嵌入通道**——「打开」置灰；
//     服务端 embed-url 同样守卫（409 RENDERER_NOT_EMBEDDABLE），这里是前置体验。
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

/** Console 壳 Outlet context 的结构子集（壳侧真实形状见 apps/web ConsoleOutletContext；demo 模块先例） */
interface ConsoleContext {
  session: { scopes: string[] }
}

interface ReportRow {
  id: string
  title: string
  requiredScope: string | null
  renderer: 'metabase' | 'platform'
}

export default function ReportsPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('data:manage')

  const [rows, setRows] = useState<ReportRow[]>([])
  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null)
  const [gateEdit, setGateEdit] = useState<ReportRow | null>(null)
  const [gateDraft, setGateDraft] = useState('')
  const [messageApi, ctx] = message.useMessage()

  const load = () => {
    // 视图选择（不是鉴权）：manage 身份用管理清单（含页门未放行的行），观看清单不变
    const path = canManage ? '/reports/manage' : '/reports'
    return apiGet(path)
      .then((b) => setRows((b as { reports: ReportRow[] }).reports))
      .catch((e) => messageApi.error(messageOf(e)))
  }
  useEffect(() => { void load() }, [])

  /** 打开 = 向平台换一次嵌入 URL（每次现签，10 分钟有效）。失败只提示，不留半开的面板。 */
  const open = async (r: ReportRow) => {
    try {
      const b = await apiGet(`/reports/${r.id}/embed-url`) as { url: string }
      setEmbed({ title: r.title, url: b.url })
    } catch (e) {
      messageApi.error(messageOf(e))
    }
  }

  const publish = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}`, 'PUT', { requiredScope: null })
      messageApi.success(`已发布「${r.title}」`)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const recycle = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}`, 'DELETE')
      messageApi.success(`已回收「${r.title}」`)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const saveGate = async () => {
    if (gateEdit === null || gateDraft.trim() === '') return
    try {
      await apiSend(`/reports/${gateEdit.id}`, 'PUT', { requiredScope: gateDraft.trim() })
      messageApi.success('页门已更新')
      setGateEdit(null)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const openBtn = (r: ReportRow) =>
    r.renderer === 'platform' ? (
      <Tooltip title="平台自绘报表暂无嵌入预览通道（渲染通路接入后开放）">
        <Button size="small" disabled>打开</Button>
      </Tooltip>
    ) : (
      <Button size="small" onClick={() => void open(r)}>打开</Button>
    )

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '报表标题', dataIndex: 'title' },
        ...(canManage ? [{
          title: '渲染器', dataIndex: 'renderer',
          render: (v: ReportRow['renderer']) => (v === 'platform' ? <Tag color="purple">平台自绘</Tag> : <Tag>Metabase</Tag>),
        }] : []),
        { title: '页门', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        {
          title: '操作', render: (_: unknown, r: ReportRow) => (
            <Space size="small">
              {openBtn(r)}
              {canManage && (
                <>
                  <Button size="small" onClick={() => { setGateEdit(r); setGateDraft(r.requiredScope ?? '') }}>
                    改页门
                  </Button>
                  {r.requiredScope !== null && (
                    <Popconfirm title={`发布后所有拿到本模块的人都能看到「${r.title}」，确定？`}
                                okText="确认发布" cancelText="取消"
                                onConfirm={() => void publish(r)}>
                      <Button size="small">发布</Button>
                    </Popconfirm>
                  )}
                  <Popconfirm title={`回收会删除「${r.title}」及其报表本体，确定？`}
                              okText="确认回收" cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => void recycle(r)}>
                    <Button size="small" danger>回收</Button>
                  </Popconfirm>
                </>
              )}
            </Space>
          ),
        },
      ]} />
      <Modal title={`改页门：${gateEdit?.title ?? ''}`}
             open={gateEdit !== null}
             onOk={() => void saveGate()}
             okText="确定" cancelText="取消"
             okButtonProps={{ disabled: gateDraft.trim() === '' }}
             onCancel={() => setGateEdit(null)}>
        <Typography.Paragraph type="secondary">
          页门 = 持有该 scope 才能在清单和嵌入里看到这张报表；发布（清空页门）用上方「发布」。
        </Typography.Paragraph>
        <Input value={gateDraft} onChange={(e) => setGateDraft(e.target.value)} placeholder="如 sales:read" />
      </Modal>
      {embed !== null && (
        <div>
          <Typography.Text type="secondary">
            {embed.title}——嵌入预览（嵌入令牌 10 分钟有效，刷新页面即失效）
          </Typography.Text>
          {/* title 必填：无标题的 iframe 对读屏器是一块无名的空白 */}
          <iframe
            title={`报表嵌入预览：${embed.title}`}
            src={embed.url}
            style={{ width: '100%', height: 640, border: '1px solid #f0f0f0', marginTop: 8 }}
          />
        </div>
      )}
    </Space>
  )
}
```

`console/lib/api.ts` 的 `MESSAGES` 加一条（放在报表面那组旁边）：

```ts
  RENDERER_NOT_EMBEDDABLE: '平台自绘报表没有嵌入预览通道',
```

- [ ] **Step 4: 跑测试确认绿 + 全模块回归**

Run: `pnpm --filter data exec vitest run console/reports/index.test.tsx` → PASS。
Run: `pnpm --filter data test` → PASS。
Run: `pnpm --filter web test`（宿主 web 壳回归，确认 console 挂载不破）→ PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/console/reports/index.tsx modules/data/console/reports/index.test.tsx modules/data/console/lib/api.ts
git commit -m "feat(data): console 报表页签管理视图（页门/发布/回收 + renderer 徽章）"
```

---

## Self-Review（写完后自查，已过）

**1. spec 覆盖**（spec §8 步骤 3 的动作清单 = 页门/发布/回收 + §3⑤ 三身份分级）：
- 管理动作三件 → Task 2（端点）+ Task 5（console）：页门 = PUT scope 串；发布 = PUT null（**不新增 published 列**，口径同 data.metrics）；回收 = 既有 DELETE。
- 三身份分级 → 管理清单不裁剪（Task 2）+ 观看清单 visibleTo 既有 + console 双视图（Task 5）；越权 403（门卫负测）、跨租户 404（Task 2 负测）、**陈旧版本 409 归计划 4**（Global Constraint 5 显式划出）。
- §3⑤「覆盖两种渲染器」→ renderer 全量投影 + 徽章（Task 2/5）+ embed-url 死链守卫（Task 3）+ platform 行 reconcile/DELETE 的既有跳过（计划 1 终审修复 3，不回退）。
- 转办项：reconcile 按行降级（终审 Minor）→ Task 4；embed-url 死链（#150 转办）→ Task 3。
- §2 管理面动作里的「审计」：spec 无定义 ⇒ Global Constraint 7 显式出范围，不编。

**2. 占位符扫描**：无 TBD/「适当处理」/「照 Task N」；全部代码块可逐字落地。

**3. 类型一致性**：`updateRequiredScope(pool, org, id, requiredScope): Promise<ReportRow | null>`（Task 1 产、Task 2 消）；行投影四元组 `{id,title,requiredScope,renderer}` 在 Task 2 两个端点与 Task 5 `ReportRow` 一致；`RENDERER_NOT_EMBEDDABLE` 在 Task 3 与 Task 5 MESSAGES 同码；`contentUnreadable: [{id,title,metabaseId}]` 在 Task 4 实现/warn/测试三处一致。

## 与另几份计划的关系（人裁 2026-09-29：反代从本计划拆出）

| 计划 | 内容 | 依赖 |
|---|---|---|
| **1（已交付，PR #329）** | 报表写入面：非破坏性发布 + 三件套 + 指纹 + 对账加厚 | 无 |
| **2（本份）** | 统一管理面（console 列表/页门/发布/回收）+ reconcile 按行降级 + embed-url renderer 守卫 | 计划 1 |
| **3** | 反代编辑页三约束（spec §3⑦：专用入口/服务端会话/按租户放行且封搜索面）——动**数据面交付物**（Metabase 反代 + 会话桥，部署单元 B），与管理面（部署单元 A）分属不同风险面；写前需一轮数据面部署侦查 | 计划 1 |
| **4** | agent 制作通路（选指标/选维度、自绘规格、L2 提议）+ 语义的源维度（依赖 §7 待拍 6）+ **写保护守卫**（spec §8 步骤 2，含本计划 `PUT /reports/:id` 的版本守卫/409 与冲突人话文案） | 计划 1/2 |

**顺序 1 → 2 → 3 → 4**（spec §8 的落地顺序即此；写保护步骤 2 并入计划 4 随 agent 通路一起交付——它守的写路径正是 agent 要用的那条）。
