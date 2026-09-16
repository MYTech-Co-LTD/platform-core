# 售后模块 M3b-2（移动端 userApp 整迁）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 wuji-2 的两个售后保留页（工单提交 / 员工登记）搬进平台宿主的 `userApp` 挂载点，用三个收窄 shim 把源侧的「无极宿主能力」映射到 M2a/M3b-1 已上线的域端点。

**Architecture:** `modules/aftersales/mobile/` 是一个 Vite + Vue 3.5 + TDesign 的 **workspace 包**，源码**整包搬**（页面/组件/composable 的调用字面量一字不改），差异全部收敛在 `src/shims/*`（`@wujibase/wuji` / `wuji-data` / `wuji-upload` 三个别名）与少量被测的适配点。宿主侧补两处：`loader.ts` 的挂载点 SPA 兜底（否则深链落到 console 壳）、`/silent?next=` 回跳（否则访客登录后回不到移动端）。

**Tech Stack:** Vite 6 + Vue 3.5.17 + TDesign Vue Next 1.9.7 + Tailwind 3 + vue-router 4；测试用 vitest + happy-dom + `@vue/test-utils`（移动端）与**真 PG**（宿主/模块侧，与既有 `routes/*.test.ts` 同栈）。

## Global Constraints

以下逐字取自 spec §3.2 与 AGENTS.md，每个任务的要求都隐含包含本节。

- **声明即授权**（AGENTS.md #1）：新增模块端点**必须**在 `manifest.yaml` 的 `api.internal` 逐条声明，
  且**与路由注册原子**（装载期双向核对：注册了没声明 = 模块**装载失败**，不是告警）。
- **路径按 scope 分面**（spec §2.2）：同一条 `(method, path)` 只能声明一次、一条声明只带一个 scope
  ⇒ 访客面端点必须与同名管理面端点**分成两条不同路径**（`/guest/stores` vs `/stores`）。
- **大整数上界按列型分档**（M2a I-1）：`bigint` 列用 `.safe()`；`int4` 列用 `.max(2_147_483_647)`。
- **分页参数走 `parsePageParam`、路径 id 走 `parseIdParam`**（`routes/context.ts`，全仓唯一一份），
  **不写内联守卫**。
- **租户隔离**：所有查询 `where org = $1`；访客身份一律取自 `c.get('identity')`，**绝不从请求体取**。
- **`clientRequestId` 三条语义**（spec §3.2）：重试同键 / 跨刷新同键 / **提交成功后必须轮换**。
- **移动端不用 `platformFetch`**：它在 401 跳 `/login`（console 的登录页），移动端要跳
  `/api/platform/auth/wechat-oa/silent?next=`。两条身份路**不共用**客户端。
- **移动端 tsconfig `strict: false`**（有意）：源工程是 `strict: false`，整包搬的代码按 strict 走
  会产生成百条改写；这是**一次显式声明的弱化**，不是默认值——收紧列为 M3b-2 之后的跟进项
  （见 Task 9 的收口清单），`README.md` 的已知边界里记一句。
- **不要删改 provenance trailer**（`X-Orca-*`）；`CHANGELOG` 禁止手写。
- **门禁**：`pnpm typecheck` / `pnpm test` / `pnpm --filter @platform/web build` /
  `pnpm --filter @aftersales/mobile build` / 四道守卫脚本 / `smoke-load` 全绿。

## 波次划分（派发用）

| 波 | 任务 | 并行性 |
|---|---|---|
| **Wave 1** | Task 1 `GET /guest/stores` → Task 2 `/silent?next=` → Task 3 loader SPA 兜底 | **可并行**：三者碰的文件互不相交（`routes/registration-guest.{ts,test.ts}` + `manifest.yaml`／`routes/auth-wechat-oa.{ts,test.ts}`／`loader.{ts,test.ts}`） |
| **Wave 2** | Task 4 壳与构建链 | **串行**，依赖 T3（声明 `userApp` 前先有兜底。） |
| **Wave 3** | Task 5 三 shim → Task 6 登记页 | 串行（T6 依赖 T5） |
| **Wave 4** | Task 7 提交页数据层 → Task 8 提交页模板 | 串行（T8 依赖 T7；且 T7 改 composable、T8 改页面，同一路由的两次改动不该并行） |
| **Wave 5** | Task 9 收口（smoke 断言 + CI 构建 + 全量门禁） | 串行（波末全量验证） |

> **T1/T2/T3 的并行是真实的**：三处改动落在三个不同的子系统（模块路由 / 宿主认证路由 / 宿主装载器），
> 无共享文件、无共享状态。Wave 3–5 基本是串行链，这由**真实的数据依赖**决定（shim 是页面的前提，
> 页面是 smoke 断言的前提），不是派发方式保守。

## 文件结构

```
modules/aftersales/
  manifest.yaml                              改：api.internal 加 /guest/stores；frontend 加 userApp（T1/T4）
  routes/context.ts                          改：MAX_STORES 上移到这里（T1）
  routes/masterdata.ts                       改：改从 context 取 MAX_STORES（T1）
  routes/registration-guest.ts               改：加 GET /guest/stores（T1）
  routes/registration-guest.test.ts          改：/guest/stores 用例（T1）
  mobile/                                    新：移动端 workspace 包（T4 起）
    package.json  vite.config.ts  tsconfig.json
    tailwind.config.js  postcss.config.js  index.html  env.d.ts
    src/main.ts  src/App.vue  src/router.ts  src/style.css
    src/shims/http.ts                        新：移动端 HTTP 薄封装（401 → silent?next=）
    src/shims/client-request-id.ts           新：幂等键三条语义（T5）
    src/shims/wuji.ts                        新：Message / Confirm（T5）
    src/shims/wuji-data.ts                   新：5 个表对象 → 域端点（T5）
    src/shims/wuji-upload.ts                 新：uploadImage / uploadFile → 预签名直传（T5）
    src/shims/*.test.ts                      新（T5）
    src/composables/…                        新：从 wuji-2 搬 + 适配（T6/T7）
    src/pages/storeEmployeeApproval.vue      新：搬 + 适配（T6）
    src/pages/afterSalesWorkOrderSubmit.vue  新：搬 + 适配（T7/T8）
    src/types/…  src/utils/afterSalesHelpers.ts  新：从 wuji-2 搬（T6/T7）
apps/server/src/
  routes/auth-wechat-oa.ts                   改：/silent 收 next、callback 校验后回跳（T2）
  routes/auth-wechat-oa.test.ts              改：回跳 + 开放重定向用例（T2）
  loader.ts                                  改：挂载点 SPA 兜底（T3）
  loader.test.ts                             改：深链回壳用例（T3）
pnpm-workspace.yaml                          改：加 'modules/*/*'（T4）
.github/workflows/ci.yml                     改：smoke job 构建移动端（T9）
scripts/smoke-load.mjs                       改：userApp 挂载断言（T9）
README.md                                    改：已知边界一句（strict / 端到端留试点）（T9）
```

---

## Wave 1

### Task 1: 模块面 —— `GET /guest/stores` + manifest 声明

**Files:**
- Modify: `modules/aftersales/routes/context.ts`（`MAX_STORES` 上移）
- Modify: `modules/aftersales/routes/masterdata.ts:12-14`（改从 context 取）
- Modify: `modules/aftersales/routes/registration-guest.ts`（`/guest/products` 之后加 `/guest/stores`）
- Modify: `modules/aftersales/routes/registration-guest.test.ts`（加用例）
- Modify: `modules/aftersales/manifest.yaml`（`api.internal` 加一条）

**Interfaces:**
- Consumes: `RouteCtx`（`{pool, storage}`）、`escapeLike`（本文件已有）、`parsePageParam` / `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` / `MAX_STORES`（`./context`）。
- Produces: `GET /api/modules/aftersales/guest/stores?q=&ids=&page=&size=`
  → `200 {items: StoreItem[], total: number, page: number, size: number}`；`ids` 含非法段 → `400 {error:'INVALID_IDS'}`。
  `StoreItem` 复用 `api-types.ts` 的既有定义（`{id, name, regionId, address, phone}`，camelCase）。

- [ ] **Step 1: 把 `MAX_STORES` 上移到 `routes/context.ts`**

`masterdata.ts` 里的 `MAX_STORES` 与本次新增的访客面要共用同一个上界——两个面各写一个常量必然漂移
（`parsePageParam` 当初就是为了消灭这类漂移才收进 context 的）。在 `context.ts` 的
`DEFAULT_PAGE_SIZE` 一行下面插入：

```ts
/** 门店是选择器数据（源侧 322 行），一次给全但设上界。**管理面与访客面共用这一个**。 */
export const MAX_STORES = 1000
```

然后把 `masterdata.ts:12` 一行删掉：

```ts
/** 门店是选择器数据（源侧 322 行），一次给全但设上界。 */
const MAX_STORES = 1000
```

并在 `masterdata.ts` 的 context 导入行里加上 `MAX_STORES`：

```ts
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_STORES, parseIdParam, parsePageParam } from './context'
```

- [ ] **Step 2: 写失败的测试**

加到 `routes/registration-guest.test.ts` 末尾（文件顶部已 import 了 `describe/expect/it`、已有 `pool`、
`ORG`、`cleanup()`，且 `beforeEach` 已插入两家门店「店A」「店B」）：

```ts
// ── GET /guest/stores（M3b-2 增补；spec §3.2）───────────────────────────────
describe('GET /guest/stores', () => {
  it('无参数：回本 org 的门店，形状是 camelCase 的 StoreItem', async () => {
    const res = await app().request('/guest/stores')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
    // 形状与 console 共用一份类型（api-types.ts）——field 名错了 console 侧也会错
    expect(Object.keys(body.items[0]).sort()).toEqual(['address', 'id', 'name', 'phone', 'regionId'])
  })

  it('q：按名称模糊搜索（ILIKE），且 % 被转义（不是通配全表）', async () => {
    const hit = await (await app().request('/guest/stores?q=店A')).json()
    expect(hit.items.map((s: { name: string }) => s.name)).toEqual(['店A'])
    // `%` 不转义就是「匹配所有」——这正是 escapeLike 存在的理由
    const all = await (await app().request('/guest/stores?q=%25')).json()
    expect(all.items).toEqual([])
  })

  it('ids：只回指定的那几个（提交页「我的门店」走这条）', async () => {
    const ids = await storeIds()
    const res = await app().request(`/guest/stores?ids=${ids[1]}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { id: number }) => s.id)).toEqual([ids[1]])
  })

  it('ids= 空串：合法的空集（不是「不过滤」）——否则会把全量门店回给访客', async () => {
    const res = await app().request('/guest/stores?ids=')
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it('ids 含非法段：400 INVALID_IDS（不静默丢坏值）', async () => {
    for (const bad of ['1,abc', '1,-2', '1,1.5', '1,1e3']) {
      const res = await app().request(`/guest/stores?ids=${encodeURIComponent(bad)}`)
      expect(res.status, `ids=${bad}`).toBe(400)
      expect((await res.json()).error).toBe('INVALID_IDS')
    }
  })

  it('租户隔离：别的 org 的门店看不见', async () => {
    await pool.query(`insert into aftersales.store(org, name, address, phone) values ($1,'别家店','','')`, [OTHER_ORG])
    const body = await (await app().request('/guest/stores')).json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
  })

  it('分页：非法 size 回落默认值、超上界夹住（与 /guest/products 同一口径）', async () => {
    const body = await (await app().request('/guest/stores?page=1&size=99999')).json()
    expect(body.size).toBe(100) // MAX_PAGE_SIZE，不是 99999
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd modules/aftersales && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run routes/registration-guest.test.ts`
Expected: FAIL —— `GET /guest/stores` 未注册，Hono 回 404，第一条断言 `expect(res.status).toBe(200)` 红。

- [ ] **Step 4: 实现端点**

在 `routes/registration-guest.ts` 的 `registerRegistrationGuest` 内、`/guest/products` 那一段**之后**追加：

```ts
  // ── 选门店（M3b-2 的移动端要用；spec §3.2）──────────────────────────────
  // 与 `GET /stores` 分面是**协议硬约束**：同一条 (method,path) 只能声明一次、一条声明只带
  // 一个 scope（spec §2.2 的同一条理由，与 /guest/products 同构）。
  //
  // 两个调用方（实读源侧）：登记页按**名称**搜（`q`）；提交页按**我的登记 id** 取明细（`ids`）。
  // `ids` 不是可有可无——提交页的口径是「选我登记的门店」，id 来自 /guest/me/registration，
  // 而**名字**只能从这里取（源侧那半边靠拼 OR filter，是因为源数据源没有 id__in）。
  r.get('/guest/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const idsRaw = c.req.query('ids')
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    if (idsRaw !== undefined) {
      // 约定：空串 = **空集**（调用方说「我没有任何门店」），不是「不过滤」——
      // 不过滤会把全量门店回给访客，是这批端点里最不该发生的一种静默降级。
      const parts = idsRaw === '' ? [] : idsRaw.split(',')
      // 只认十进制正整数字面量（与 parseIdParam 同一口径）：非规范写法（`1e3` / `-2` / `1.5`）
      // 一律 400，**不静默丢弃坏值**——少几个门店比报错难查得多。
      const nums = parts.map((t) => (/^\d+$/.test(t) ? Number(t) : NaN))
      if (nums.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
        return c.json({ error: 'INVALID_IDS' }, 400)
      }
      if (nums.length === 0) return c.json({ items: [], total: 0, page, size })
      params.push(nums)
      where += ` and id = any($${params.length}::bigint[])`
    }

    // 与 /guest/products 同构：回 total ⇒ 可真分页（对照 /stores 只回 {items}）
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.store where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, region_id, address, phone from aftersales.store
        where ${where} order by id limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        regionId: s.region_id === null ? null : Number(s.region_id),
        address: s.address,
        phone: s.phone,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    })
  })
```

该文件的 context 导入行保持**原样不动**：

```ts
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageParam } from './context'
```

> **为什么访客面不 import `MAX_STORES`**（免得读 Step 1 时以为漏了）：`/guest/stores` 的
> `limit` 由 `size` 兜住，而 `size` 已被 `parsePageParam` 夹在 `MAX_PAGE_SIZE = 100`；
> `ids` 数组长度另受 `TargetBody.storeIds` 的 `.max(50)` 约束 ⇒ 这个端点**拿不出**
> 超过 100 行的响应，再叠一层 `MAX_STORES` 只是重复表述同一个上界。
> Step 1 的 `MAX_STORES` 上移仍要做——它服务的是**管理面** `/stores`（那个端点没有分页、
> 真需要 1000 的上界），上移到 `context.ts` 是为了 `masterdata.ts` 与将来可能的第二个
> 管理面消费者**共用一个常量**，而不是各写一份。

- [ ] **Step 5: 声明到 manifest（与路由原子）**

`modules/aftersales/manifest.yaml` 的 `api.internal` 里，紧挨已有的 `GET /guest/products` 一行之后插入：

```yaml
    # 门店的访客面（M3b-2 / spec §3.2）：两个保留页都要门店数据。与上面管理面 GET /stores
    # 分面的理由同上——同一条 (method,path) 只能声明一次、一条声明只带一个 scope。
    - { method: GET,  path: /guest/stores,              scope: aftersales:guest }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd modules/aftersales && DATABASE_URL=… pnpm vitest run routes/registration-guest.test.ts`
Expected: PASS（全部用例，含既有登记用例）。

- [ ] **Step 7: 跑装载器测试（证明「注册 ↔ 声明」双向一致）**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/loader.test.ts`
Expected: PASS。装载期双向核对是硬门禁——路由注册了但 manifest 没声明（或反之）会让
loadModules 抛错，这条测试就是那个契约的执行面。

- [ ] **Step 8: 提交**

```bash
git add modules/aftersales/routes/context.ts modules/aftersales/routes/masterdata.ts \
        modules/aftersales/routes/registration-guest.ts modules/aftersales/routes/registration-guest.test.ts \
        modules/aftersales/manifest.yaml
git commit -m "feat(aftersales): 访客面 GET /guest/stores——两个保留页都要门店数据 (#83)"
```

---

### Task 2: 宿主面 —— `/silent?next=` 回跳 + 开放重定向防护

**Files:**
- Modify: `apps/server/src/routes/auth-wechat-oa.ts`
- Test: `apps/server/src/routes/auth-wechat-oa.test.ts`

**Interfaces:**
- Consumes: 既有的 `stateCookie` / `readStateCookie` / `STATE_COOKIE` / `STATE_TTL_SEC`（本文件内）。
- Produces: `export function safeNextPath(raw: string | undefined): string`（供测试直接断言，
  形状照本文件 `OA_ANON_ACTOR` 的先例——导出是为了让测试**同源**断言而不是重写一份规则）。
  行为：`GET /api/platform/auth/wechat-oa/silent?next=<path>` 把 `next` 编进 `wechat_oa_state`
  cookie；`GET /callback` 成功后 302 到该 `next`，非法/缺失一律 302 `/`。

- [ ] **Step 1: 写失败的测试**

追加到 `apps/server/src/routes/auth-wechat-oa.test.ts`。先看该文件已有的成功用例（⑥ 之后的
「成功」那条）是怎么造 `state` + cookie 的——**复用同一套 fixture**（真 PG + seedDemo 的 acme +
假微信 fetch）。新用例：

```ts
// ── M3b-2：/silent?next= 回跳（spec §3.2 未登录节）────────────────────────
describe('safeNextPath：只放行同源相对路径（开放重定向防护）', () => {
  it('合法相对路径原样返回', () => {
    expect(safeNextPath('/app/aftersales')).toBe('/app/aftersales')
    expect(safeNextPath('/app/aftersales/register?x=1')).toBe('/app/aftersales/register?x=1')
  })
  it('缺失 / 空 ⇒ 回落 "/"', () => {
    expect(safeNextPath(undefined)).toBe('/')
    expect(safeNextPath('')).toBe('/')
  })
  it('外部 URL ⇒ 回落 "/"（协议相对 // 是跨源，必须挡）', () => {
    for (const bad of ['https://evil.test', 'http://evil.test', '//evil.test', '/\\evil.test', 'evil.test', 'javascript:alert(1)']) {
      expect(safeNextPath(bad), bad).toBe('/')
    }
  })
  it('控制字符 ⇒ 回落 "/"（Location 头不能带 CR/LF）', () => {
    expect(safeNextPath('/a\r\nSet-Cookie: x=1')).toBe('/')
  })
})

describe('silent/callback 的 next 回跳', () => {
  it('next 存在：callback 成功 ⇒ 302 到 next（不是恒回 "/"）', async () => {
    // ① /silent 拿 state cookie（复用既有成功用例的取法）
    const silent = await client.get('/silent?next=%2Fapp%2Faftersales%2Fregister', {
      headers: { 'user-agent': WECHAT_UA },
    })
    expect(silent.status).toBe(302)
    const cookie = (silent.headers.get('set-cookie') ?? '').split(';')[0]!
    expect(cookie).toMatch(/^wechat_oa_state=/)
    const state = decodeURIComponent(cookie.slice('wechat_oa_state='.length)).split('.')[0]!

    // ② callback：state 与 cookie 里前半段一致 ⇒ 成功 ⇒ 回跳到 next
    const cb = await client.get(`/callback?code=good&state=${state}`, { headers: { cookie } })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/app/aftersales/register')
  })

  it('next 是外部 URL：cookie 照发，但 callback 成功仍回 "/"（不成为开放重定向）', async () => {
    const silent = await client.get('/silent?next=https%3A%2F%2Fevil.test', {
      headers: { 'user-agent': WECHAT_UA },
    })
    const cookie = (silent.headers.get('set-cookie') ?? '').split(';')[0]!
    const state = decodeURIComponent(cookie.slice('wechat_oa_state='.length)).split('.')[0]!
    const cb = await client.get(`/callback?code=good&state=${state}`, { headers: { cookie } })
    expect(cb.headers.get('location')).toBe('/')
  })

  it('无 next：行为与改动前一致（302 "/"）——不能回归既有契约', async () => {
    const silent = await client.get('/silent', { headers: { 'user-agent': WECHAT_UA } })
    const cookie = (silent.headers.get('set-cookie') ?? '').split(';')[0]!
    const state = decodeURIComponent(cookie.slice('wechat_oa_state='.length)).split('.')[0]!
    const cb = await client.get(`/callback?code=good&state=${state}`, { headers: { cookie } })
    expect(cb.headers.get('location')).toBe('/')
  })

  it('BAD_STATE 判据没被 next 段破坏（cookie 里带 next 也要比 state）', async () => {
    const silent = await client.get('/silent?next=%2Fapp%2Faftersales', {
      headers: { 'user-agent': WECHAT_UA },
    })
    const cookie = (silent.headers.get('set-cookie') ?? '').split(';')[0]!
    // 用**别的** state 打，cookie 原封带上 ⇒ 必须仍是 BAD_STATE
    const cb = await client.get('/callback?code=good&state=00000000-0000-0000-0000-000000000000', {
      headers: { cookie },
    })
    expect(cb.headers.get('location')).toBe('/login?error=BAD_STATE')
  })
})
```

> **fixture 一律复用该文件已有的**（不要另造）：① `WECHAT_UA` 常量已在该文件顶部；
> ② 客户端变量与该文件「成功」那条用例用的是同一个（`hono/testing` 的 `testClient`，
> 文件顶部已 import）；③ 假微信 mock 里**返回有效 openid 的那个 code 字面量**，
> 照该文件既有成功用例用过的值。做法：把这四条新用例**照着既有成功用例逐行改**
> （只改 `next` 参数与最后的断言），不要重新搭一套 harness——那会造出第二个事实源，
> 将来 mock 形状变了只改一边。

也要在文件顶部的 import 行里加上 `safeNextPath`：

```ts
import { wechatOaRoutes, OA_ANON_ACTOR, safeNextPath } from './auth-wechat-oa'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/routes/auth-wechat-oa.test.ts`
Expected: FAIL —— `safeNextPath` 未导出（import 报 undefined），且 `/silent?next=` 的用例断言
`location` 为 `/app/aftersales/register` 而实际恒为 `/`。

- [ ] **Step 3: 实现 `safeNextPath`**

在 `auth-wechat-oa.ts` 的 `readStateCookie` 之后插入：

```ts
/**
 * 回跳目标白名单化（spec §3.2 未登录节）：**只放行同源相对路径**，其余一律回落 `/`。
 *
 * `next` 完全由 URL 控制 ⇒ 不校验就是一个**开放重定向**：攻击者构造
 * `/silent?next=https://evil.test` 就能把刚完成微信授权的用户送去任意站点，
 * 而且是从**我们自己的可信域名**出发的跳转（钓鱼场景里这是最值钱的一种）。
 *
 * 判据只有一条「单个 `/` 开头」是不够的：`//evil.test` 是**协议相对 URL**，浏览器按跨源处理；
 * `/\evil.test` 在部分浏览器里同样被当作跨源。两者都必须在 `startsWith('/')` 之后单独挡掉。
 * 控制字符一并拒——这个值最终进 `Location` 头，CR/LF 是头注入面。
 */
export function safeNextPath(raw: string | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  // eslint 之外的理由：`\x00-\x1f` 与 `\x7f` 在 Location 头里没有合法位置
  for (const ch of raw) if (ch < ' ' || ch === '\x7f') return '/'
  return raw
}
```

- [ ] **Step 4: 把 `next` 编进 state cookie**

把 `stateCookie` 改成收两个参数：

```ts
/**
 * state cookie 载荷 = `<state>` 或 `<state>.<base64url(next)>`。
 *
 * **不新开 cookie**：一个 state 一个 nonce，`Path`/`Max-Age`/`HttpOnly`/`SameSite` 一字不改——
 * 少一个 cookie 名就少一处将来要一起改的属性面。base64url（不是 base64）：`+` `/` `=` 在
 * cookie 值里都要再编码一次，base64url 三个全避开。
 */
function stateCookie(state: string, next: string): string {
  const payload = next === '/' ? state : `${state}.${Buffer.from(next, 'utf8').toString('base64url')}`
  return `${STATE_COOKIE}=${payload}; Path=/; Max-Age=${STATE_TTL_SEC}; HttpOnly; SameSite=Lax`
}

/**
 * cookie 载荷 → `{state, next}`。**state 段照比，next 段只做白名单化**。
 * 坏 base64 不抛（`Buffer.from` 对非法输入是宽容的）——解出来是垃圾字符，`safeNextPath`
 * 自会把它挡成 `/`，所以这里不需要 try/catch。
 */
function splitStateCookie(payload: string | null): { state: string; next: string } {
  if (payload === null) return { state: '', next: '/' }
  const dot = payload.indexOf('.')
  if (dot < 0) return { state: payload, next: '/' }
  const decoded = Buffer.from(payload.slice(dot + 1), 'base64url').toString('utf8')
  return { state: payload.slice(0, dot), next: safeNextPath(decoded) }
}
```

`/silent` 处理器的三行改成：

```ts
    const state = randomUUID()
    const next = safeNextPath(c.req.query('next'))
    const url = buildWechatOaSilentUrl(t.wechat_oa_app_id, callbackUri, state)
    c.res.headers.append('Set-Cookie', stateCookie(state, next))
    return c.redirect(url)
```

`/callback` 里读 cookie 的那处：

```ts
    // 原：if (!code || !state || readStateCookie(c.req.header('cookie')) !== state) {
    const baked = splitStateCookie(readStateCookie(c.req.header('cookie')))
    if (!code || !state || baked.state !== state) {
```

并在成功分支末尾（`c.res.headers.append('Set-Cookie', serializeSessionCookie(token))` 之后）：

```ts
    // 回跳：`baked.next` 已在拆 cookie 时过了一遍 safeNextPath（非法一律被折成 '/'）
    return c.redirect(baked.next)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/routes/auth-wechat-oa.test.ts`
Expected: PASS。**特别确认既有六条用例一条没红**——这一改动了登录路的成功出口，
旧契约（无 next ⇒ 302 `/`；BAD_STATE 判据；限速计数）必须原样成立。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/auth-wechat-oa.ts apps/server/src/routes/auth-wechat-oa.test.ts
git commit -m "feat(server): wechat-oa /silent 支持 next 回跳——开放重定向防护 + 回归 (#83)"
```

---

### Task 3: 宿主面 —— loader 的挂载点 SPA 兜底

**Files:**
- Modify: `apps/server/src/loader.ts:427-435`
- Test: `apps/server/src/loader.test.ts`（`userApp 静态目录存在` 那条用例之后）

**Interfaces:**
- Consumes: 既有 `mountPath` / `dist` 局部变量（`loader.ts` 的 `mount()` 内）。
- Produces: 行为契约——`GET <mount>` 与 `GET <mount>/<任意非文件路径>` 都回
  `dist/index.html`（200 + `text/html`），**不是** 404、**也不是** web（console）的 index.html。

- [ ] **Step 1: 写失败的测试**

追加到 `apps/server/src/loader.test.ts` 的那条 `userApp 静态目录存在` 用例**之后**：

```ts
  it('userApp 深链回**本模块的** SPA 壳（挂载点 SPA 兜底，M3b-2 I1）', async () => {
    cleanupModules.push('spamod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'spamod', {
      'manifest.yaml': manifestYaml(
        'spamod',
        'frontend:\n  userApp:\n    mount: /apps/spamod\n    dist: web/dist',
      ),
      'index.ts': indexTs('spamod', 'spamod:view'),
      'web/dist/index.html': '<html>spamod shell</html>',
      'web/dist/assets/app.js': 'console.log(1)',
    })
    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono()
    runtime.mount(app)

    // ① 入口（带尾斜杠）
    const root = await app.request('/apps/spamod/')
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('spamod shell')

    // ② 入口（不带尾斜杠）——客户端路由的 base 就是这个形状
    const bare = await app.request('/apps/spamod')
    expect(bare.status).toBe(200)
    expect(await bare.text()).toContain('spamod shell')

    // ③ **深链**：这条是本次修的核心。修之前它 404（本 Hono 实例没有全局兜底），
    //    而在真宿主里它更糟——会被 app.ts 的 app.get('*') 兜成 **web 的** index.html，
    //    也就是「刷新移动端页 ⇒ 打开 React 控制台壳」。
    const deep = await app.request('/apps/spamod/register')
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('spamod shell')

    // ④ 产物文件仍走静态本体（兜底不能把 assets 也吞掉）
    const asset = await app.request('/apps/spamod/assets/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('console.log(1)')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/loader.test.ts -t "深链"`
Expected: FAIL —— `deep.status` 是 404（静态未命中后没有兜底）。

- [ ] **Step 3: 实现挂载点兜底**

在 `apps/server/src/loader.ts` 的 `mount()` 里，userApp 的 `serveStatic` 之后追加：

```ts
        // userApp 的 **SPA 兜底**（M3b-2 I1）。必须在这里补，**不能**指望 app.ts 的全局
        // `app.get('*')`：那条兜的是 **web（console）的** index.html ⇒ 深链/刷新
        // `/app/aftersales/<route>` 会拿到 React 控制台壳（同一套 assets 前缀下尤其难查）。
        // 注册点在 §⑨（模块挂载），早于 app.ts §⑩ 的全局兜底 ⇒ Hono 按注册序天然优先。
        // 只挂 `get`：`serveStatic` 未命中的**非 GET** 仍该落 notFound（兜底不是「什么都接」）。
        const userAppIndex = serveStatic({ root: dist, path: 'index.html' })
        app.get(mountPath, userAppIndex)
        app.get(mountPath + '/*', userAppIndex)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/loader.test.ts`
Expected: PASS。**重点确认既有的「dist 不存在 ⇒ 404」与「停用 ⇒ 404 同形」两条没红**——
兜底是挂在 `if (!existsSync(dist)) continue` **之后**的，dist 缺失时整段都不会执行；
停用时 `gate` 先回 404、不再走到这里。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts
git commit -m "fix(server): userApp 补挂载点 SPA 兜底——深链不再落到 console 壳 (#83)"
```

---

## Wave 2

### Task 4: 移动端壳与构建链接入

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `modules/aftersales/manifest.yaml`（`frontend.userApp`）
- Create: `modules/aftersales/mobile/package.json`
- Create: `modules/aftersales/mobile/vite.config.ts`
- Create: `modules/aftersales/mobile/tsconfig.json`
- Create: `modules/aftersales/mobile/env.d.ts`
- Create: `modules/aftersales/mobile/tailwind.config.js`
- Create: `modules/aftersales/mobile/postcss.config.js`
- Create: `modules/aftersales/mobile/index.html`
- Create: `modules/aftersales/mobile/src/main.ts`
- Create: `modules/aftersales/mobile/src/App.vue`
- Create: `modules/aftersales/mobile/src/router.ts`
- Create: `modules/aftersales/mobile/src/style.css`
- Create: `modules/aftersales/mobile/src/pages/afterSalesWorkOrderSubmit.vue`（**占位**，Task 8 填实体）
- Create: `modules/aftersales/mobile/src/pages/storeEmployeeApproval.vue`（**占位**，Task 6 填实体）
- Modify: `pnpm-lock.yaml`（`pnpm install` 生成）

**Interfaces:**
- Produces: workspace 包 `@aftersales/mobile`，`build` 产出 `modules/aftersales/mobile/dist/index.html`；
  路由名 `submit`（`/`）与 `register`（`/register`）；全局 `window.defineWujiPageMeta`。
  Task 5 起的所有 shim 与页面都活在这个包里。

- [ ] **Step 1: 让 mobile 成为 workspace 包**

`pnpm-workspace.yaml` 改成：

```yaml
# `modules/*/*` 是 M3b-2 加的：模块的**前端子包**（`modules/aftersales/mobile`）不在这三个 glob 里
# ⇒ 不是 workspace 包 ⇒ `pnpm -r --if-present build` 跳过它 ⇒ 镜像里没有 dist ⇒
# `loader.ts` 的 `if (!existsSync(dist)) continue` 静默不挂载（**不报错**）。
# 没有子 package.json 的目录（console/ routes/ migrations/ …）pnpm 自动忽略，无需 exclude。
packages: [ 'apps/*', 'packages/*', 'modules/*', 'modules/*/*' ]
allowBuilds:
  esbuild: true
```

- [ ] **Step 2: 建包骨架**

`modules/aftersales/mobile/package.json`：

```json
{
  "name": "@aftersales/mobile",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "typecheck": "vue-tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@fortawesome/fontawesome-free": "^6.7.2",
    "dayjs": "^1.11.13",
    "tdesign-vue-next": "1.9.7",
    "vue": "3.5.17",
    "vue-router": "^4.4.5"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "@vue/test-utils": "^2.4.6",
    "autoprefixer": "^10.4.20",
    "happy-dom": "^20.14.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.6.0",
    "vite": "^6.4.3",
    "vitest": "^3.2.7",
    "vue-tsc": "^2.2.0"
  }
}
```

> `vue` / `tdesign-vue-next` 用**源工程 pin 的精确版本**（`3.5.17` / `1.9.7`）：整包搬的
> 模板与组件 API 是按这两个版本写的，浮动到新版是免费的重写风险。其余用 `^`。

- [ ] **Step 3: 建构建配置**

`modules/aftersales/mobile/vite.config.ts`：

```ts
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // ⚠️ 必须与 manifest 的 `userApp.mount` 一致（M3b-2 I2）：
  // 不设 base ⇒ index.html 引用**站点绝对**的 `/assets/*`，而 apps/web 的 vite 产物也在
  // `/assets/*`（app.ts 的全局 serveStatic 在给 web 供文件）⇒ 移动端会加载到 **console 的**
  // 同路径产物（或反之），症状是白屏/杂壳，且两侧都「构建成功」。
  base: '/app/aftersales/',
  plugins: [vue()],
  resolve: {
    alias: {
      // 三个 shim 用**别名**而不是三个 workspace 包：源码里的 import 字面量
      // （`from '@wujibase/wuji-data'`）因此**一字不改**，「整包搬」才成立。
      // 键是**精确匹配 + '/子路径'**语义（vite 的 alias 实现），故 `@wujibase/wuji`
      // 不会误吃 `@wujibase/wuji-data`（后者不以 `@wujibase/wuji/` 开头）。
      '@wujibase/wuji': here('./src/shims/wuji.ts'),
      '@wujibase/wuji-data': here('./src/shims/wuji-data.ts'),
      '@wujibase/wuji-upload': here('./src/shims/wuji-upload.ts'),
      '@': here('./src'),
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
```

`modules/aftersales/mobile/tsconfig.json`：

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    // ⚠️ **有意关掉**（Global Constraints 有记，Task 9 Step 5 会写进 README 的已知边界）：
    // 本包整包搬自 wuji-2，而源工程就是 `strict: false`。开着它会让 955 行的页面一次爆出
    // 成百条 strict-null 改写，那是**另一个任务**的范围。这是**显式声明的弱化**，不是默认值。
    "strict": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "paths": {
      "@/*": ["./src/*"],
      "@wujibase/wuji": ["./src/shims/wuji.ts"],
      "@wujibase/wuji-data": ["./src/shims/wuji-data.ts"],
      "@wujibase/wuji-upload": ["./src/shims/wuji-upload.ts"]
    }
  },
  "include": ["src", "env.d.ts"],
  "exclude": ["**/*.test.ts"]
}
```

`modules/aftersales/mobile/env.d.ts`：

```ts
/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const c: DefineComponent<{}, {}, any>
  export default c
}

/**
 * 源侧的**宿主全局**（`gogo-runtime-stuff.d.ts` 声明、页面直接当裸标识符调用）。
 * 我们在 main.ts 里补一个退化实现（设 document.title）。
 *
 * ⚠️ **`window.w.global.appid` 刻意不补**：引用它的是页内那段前端微信 OAuth，
 * 而那些块在移植时**整体删除**（spec §3.2：身份只有 session 一份来源）。
 * 若哪次改动让它又冒出来，请在类型上就不给（编译期红好过运行期白屏）。
 */
declare function defineWujiPageMeta(options: { title: string; description?: string }): void

interface Window {
  /** main.ts 里赋的退化实现（`declare function` 声明的是全局函数，赋值目标是 window） */
  defineWujiPageMeta?: (options: { title: string; description?: string }) => void
}
```

`modules/aftersales/mobile/tailwind.config.js`：

```js
/** @type {import('tailwindcss').Config} */
export default {
  // 只扫移动端自己的源码：扫到仓根会把 console 的类也编译进来（产物没人用还变大）。
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: [],
}
```

`modules/aftersales/mobile/postcss.config.js`：

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

- [ ] **Step 4: 建入口与路由**

`modules/aftersales/mobile/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <!-- viewport-fit=cover 是 safe-area-inset-bottom 生效的前提（底部固定操作栏） -->
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
    />
    <title>售后工单</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`modules/aftersales/mobile/src/style.css`：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* 源页用到 `safe-area-inset-bottom`（提交页底部固定操作栏，`fixed bottom-0 … safe-area-inset-bottom`），
   那是无极宿主提供的自定义 utility，Tailwind 本身没有 ⇒ 不补的话 iPhone 上按钮会被横条压住。 */
@layer utilities {
  .safe-area-inset-bottom {
    padding-bottom: calc(1rem + env(safe-area-inset-bottom));
  }
}
```

`modules/aftersales/mobile/src/App.vue`：

```vue
<template>
  <router-view />
</template>
```

`modules/aftersales/mobile/src/router.ts`：

```ts
import { createRouter, createWebHistory } from 'vue-router'

/**
 * `createWebHistory` 吃 `import.meta.env.BASE_URL`（vite 由 `base` 注入）——**必须**与
 * vite 的 base 同源，否则深链刷新时路由表对不上 `/app/aftersales/...` 的前缀。
 * 两条路由：`/` 工单提交（入口）、`/register` 员工登记（未登记时由提交页引导过来）。
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'submit', component: () => import('./pages/afterSalesWorkOrderSubmit.vue') },
    { path: '/register', name: 'register', component: () => import('./pages/storeEmployeeApproval.vue') },
  ],
})
```

`modules/aftersales/mobile/src/main.ts`：

```ts
import { createApp } from 'vue'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import './style.css'
import App from './App.vue'
import { router } from './router'

// 宿主全局的退化实现：源页直接调用裸标识符 `defineWujiPageMeta({title})`，
// 页面代码因此一字不改。只保留「设 title」这一条真实行为。
window.defineWujiPageMeta = (o) => {
  if (o?.title) document.title = o.title
}

createApp(App).use(TDesign).use(router).mount('#app')
```

- [ ] **Step 5: 建两个占位页面**

`modules/aftersales/mobile/src/pages/afterSalesWorkOrderSubmit.vue`（Task 8 换实体）：

```vue
<template>
  <div class="min-h-screen bg-gray-50 p-4">工单提交（M3b-2 待填）</div>
</template>
```

`modules/aftersales/mobile/src/pages/storeEmployeeApproval.vue`（Task 6 换实体）：

```vue
<template>
  <div class="min-h-screen bg-gray-50 p-4">员工登记（M3b-2 待填）</div>
</template>
```

- [ ] **Step 6: 声明 userApp**

`modules/aftersales/manifest.yaml` 的 `frontend:` 段改成：

```yaml
frontend:
  console:
    - { path: /console/aftersales, title: 售后管理, icon: ToolOutlined, scope: aftersales:manage, entry: ./console/index.tsx }
  # 移动端 userApp（M3b-2）：Vite 壳 + Vue 3.5 + TDesign，搬自 wuji-2 的两个保留页。
  # mount 与 mobile/vite.config.ts 的 `base` **必须一致**（不一致 ⇒ 产物引用错前缀）。
  # dist 相对**模块目录**解析（loader 的 path.resolve(m.dir, dist)）。
  userApp: { mount: /app/aftersales, dist: ./mobile/dist }
```

- [ ] **Step 7: 装依赖并构建**

Run: `pnpm install && pnpm --filter @aftersales/mobile build`
Expected: `modules/aftersales/mobile/dist/index.html` 生成；`dist/index.html` 里对产物的引用
是 `/app/aftersales/assets/…` 开头。

校验（这条是 I2 的机检，别跳过）：

```bash
grep -o '/app/aftersales/assets/[^"]*' modules/aftersales/mobile/dist/index.html | head -3
```
Expected: 至少一行，且**没有**裸的 `"/assets/…"`：
```bash
grep -c 'src="/assets/' modules/aftersales/mobile/dist/index.html   # 期望 0
```

- [ ] **Step 8: 全量门禁（新增包要能被 -r 扫到）**

Run: `pnpm typecheck && pnpm test`
Expected: PASS。`pnpm -r --if-present typecheck` 必须**真的跑到** `@aftersales/mobile`——用
`pnpm -r --if-present typecheck --reporter=append-only 2>&1 | grep -c aftersales` 之类的办法确认
它没被静默漏掉（漏掉就是「新包没人检查」这类静默洞）。

- [ ] **Step 9: 提交**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml modules/aftersales/manifest.yaml modules/aftersales/mobile
git commit -m "feat(aftersales): M3b-2 移动端壳——Vite+Vue+TDesign 包、workspace glob、userApp 声明 (#83)"
```

---

## Wave 3

### Task 5: 三个 shim + `clientRequestId`

**Files:**
- Create: `modules/aftersales/mobile/src/shims/http.ts`
- Create: `modules/aftersales/mobile/src/shims/client-request-id.ts`
- Create: `modules/aftersales/mobile/src/shims/wuji.ts`
- Create: `modules/aftersales/mobile/src/shims/wuji-data.ts`
- Create: `modules/aftersales/mobile/src/shims/wuji-upload.ts`
- Test: `modules/aftersales/mobile/src/shims/client-request-id.test.ts`
- Test: `modules/aftersales/mobile/src/shims/wuji.test.ts`
- Test: `modules/aftersales/mobile/src/shims/wuji-data.test.ts`
- Test: `modules/aftersales/mobile/src/shims/wuji-upload.test.ts`
- Test: `modules/aftersales/mobile/src/shims/http.test.ts`

**Interfaces:**
- Produces（Task 6/7/8 依赖这些**确切**名字）：
  - `http.ts`: `ApiError`（`{status, code, message}`）、`apiGet<T>(path)`、`apiSend<T>(path, method, body?)`、`redirectToGuestLogin()`、`API_BASE`
  - `client-request-id.ts`: `currentClientRequestId(): string`、`rotateClientRequestId(): void`
  - `wuji.ts`: `Message.{success,warning,error,info}`、`Confirm(opts): {hide()}`
  - `wuji-data.ts`: `store_info` / `employee_info` / `employee_info_approve` / `product_archive` / `after_sales_work_order`，以及行类型 `StoreRow` / `EmployeeRow` / `ProductRow` / `ApprovalRow`（**全是值导出 + 类型导出**：本包的 `tsconfig` 不做桶文件运行时加载，没有 #44 的那个面）
  - `wuji-upload.ts`: `uploadImage(file, path)`、`uploadFile(file, path)` → `Promise<{id: number; objectKey: string}>`

- [ ] **Step 1: 写 `clientRequestId` 的失败测试（三条语义）**

`src/shims/client-request-id.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { currentClientRequestId, rotateClientRequestId } from './client-request-id'

describe('clientRequestId 三条语义（spec §3.2）', () => {
  beforeEach(() => sessionStorage.clear())

  it('语义①重试同键：同一会话内反复取到的是同一个键', () => {
    const a = currentClientRequestId()
    expect(currentClientRequestId()).toBe(a)
    expect(currentClientRequestId()).toBe(a)
  })

  it('语义②跨刷新同键：键存在 sessionStorage 里（新「模块实例」也读得到同一个）', () => {
    const a = currentClientRequestId()
    // 模拟「整页刷新」：内存全没了，只有 sessionStorage 还在
    expect(sessionStorage.getItem('aftersales.clientRequestId')).toBe(a)
  })

  it('语义③提交成功后轮换：rotate 之后必须换一个新键', () => {
    const a = currentClientRequestId()
    rotateClientRequestId()
    const b = currentClientRequestId()
    expect(b).not.toBe(a)
  })

  it('键是 UUID 形状（不是自增/时间戳这类会撞的值）', () => {
    expect(currentClientRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('sessionStorage 里是空串 ⇒ 当作没有（不当成一个合法的空键）', () => {
    sessionStorage.setItem('aftersales.clientRequestId', '')
    expect(currentClientRequestId()).not.toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/client-request-id.test.ts`
Expected: FAIL —— `./client-request-id` 不存在。

- [ ] **Step 3: 实现 `client-request-id.ts`**

```ts
// src/shims/client-request-id.ts —— 幂等键（= 附件 object key 里的 {ticket_ref}，spec §3.2）。
//
// 三条语义各自对着一个**具体的线上症状**，别把它们当成风格问题：
//   ① 重试同键 —— 否则幂等失效，一次重试建两张工单；
//   ② 跨刷新同键 —— 否则刷新后换了新键，**之前传的附件认领不回来**（§5 #12 的孤儿附件）；
//   ③ 成功后轮换 —— 否则同一会话提交第二笔时被幂等判重、**服务端静默返回第一笔**，
//      而前端显示「提交成功」：用户以为提交了新工单，落库的却是旧的那笔。
//
// 上传与提交**共用**这个键（附件就是挂在它下面的），所以它只有一处读写面。
const KEY = 'aftersales.clientRequestId'

/** 取当前会话的键；没有就现造一个（语义①②：只有这里造键，所有调用方读同一个）。 */
export function currentClientRequestId(): string {
  const existing = sessionStorage.getItem(KEY)
  if (existing !== null && existing !== '') return existing
  const fresh = crypto.randomUUID()
  sessionStorage.setItem(KEY, fresh)
  return fresh
}

/**
 * 语义③。**调用点只有一个**：提交**成功**（含服务端回 `duplicated: true` 的那种——
 * 那也是这一笔已经落库了，用户的下一次提交理应是一张新工单）。
 */
export function rotateClientRequestId(): void {
  sessionStorage.removeItem(KEY)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/client-request-id.test.ts`
Expected: PASS（5 条）。

- [ ] **Step 5: 写 `http.ts` 的失败测试**

`src/shims/http.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiGet, apiSend } from './http'

const origFetch = globalThis.fetch
const origLocation = window.location

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('shims/http', () => {
  let calls: Array<{ url: string; init?: RequestInit }>
  let hrefs: string[]

  beforeEach(() => {
    calls = []
    hrefs = []
    // happy-dom 的 location 不可直接赋值 —— 换成一个只记 href 的替身
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app/aftersales/', search: '?x=1', set href(v: string) { hrefs.push(v) } },
    })
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return json(200, { ok: true })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    Object.defineProperty(window, 'location', { configurable: true, value: origLocation })
  })

  it('拼上模块前缀，且带 same-origin 凭据（访客会话是 cookie）', async () => {
    await apiGet('/guest/stores?q=x')
    expect(calls[0]!.url).toBe('/api/modules/aftersales/guest/stores?q=x')
    expect(calls[0]!.init?.credentials).toBe('same-origin')
  })

  it('401 ⇒ 跳 silent 静默授权，并带上 next（本期补的回跳）', async () => {
    globalThis.fetch = vi.fn(async () => json(401, { error: 'UNAUTHENTICATED' })) as unknown as typeof fetch
    await expect(apiGet('/guest/me/registration')).rejects.toMatchObject({ status: 401 })
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toBe(
      '/api/platform/auth/wechat-oa/silent?next=' + encodeURIComponent('/app/aftersales/?x=1'),
    )
  })

  it('非 2xx ⇒ 抛 ApiError，code 取自响应体的 error 字段', async () => {
    globalThis.fetch = vi.fn(async () => json(409, { error: 'APPROVAL_PENDING' })) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGet('/x')).rejects.toMatchObject({ status: 409, code: 'APPROVAL_PENDING' })
  })

  it('响应体带 message ⇒ 收进 ApiError.message（「您没有修改任何信息」靠这条透出）', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(400, { error: 'INVALID_BODY', message: '您没有修改任何信息' }),
    ) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toMatchObject({ code: 'INVALID_BODY', message: '您没有修改任何信息' })
  })

  it('响应体不是 JSON ⇒ 回落成 HTTP_<status>（不因解析失败吞掉状态码）', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' })
  })

  it('apiSend 带 JSON body 与 Content-Type；无 body 时不带', async () => {
    await apiSend('/guest/tickets', 'POST', { a: 1 })
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ a: 1 }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    await apiSend('/guest/tickets', 'POST')
    expect(calls[1]!.init?.body).toBeUndefined()
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/http.test.ts`
Expected: FAIL —— `./http` 不存在。

- [ ] **Step 7: 实现 `http.ts`**

```ts
// src/shims/http.ts —— 移动端的 HTTP 薄封装。
//
// ⚠️ **刻意不用 `@platform/sdk/web` 的 `platformFetch`**：它在 401 时跳 `/login`
// （console 的账号密码登录页），而移动端要的是宿主的**公众号访客登录路**——在微信里打开
// `/login` 只会渲染一个用不了的账密表单。两条是**不同的身份路**，客户端不共用。
export const API_BASE = '/api/modules/aftersales'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 服务端 `{error, message}` 里的 message（部分端点带，如「您没有修改任何信息」） */
    override readonly message: string = '',
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

/**
 * 访客 session 缺失 ⇒ 带 `next` 跳宿主静默授权（spec §3.2 未登录节）。
 * `next` 是本期在宿主侧补的能力：没有它，登录成功后恒落 `/`（console 首页），
 * 用户回不到移动端页。
 */
export function redirectToGuestLogin(): void {
  const next = location.pathname + location.search
  location.href = '/api/platform/auth/wechat-oa/silent?next=' + encodeURIComponent(next)
}

async function toApiError(res: Response): Promise<ApiError> {
  // 体可能不是 JSON（反代 502 之类）——解析失败不能把状态码也吞掉
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  const message = typeof body?.message === 'string' ? body.message : ''
  return new ApiError(res.status, code, message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, { ...init, credentials: 'same-origin' })
  if (res.status === 401) {
    redirectToGuestLogin()
    // 跳转已经发起，本页不会再渲染出有意义的结果 —— 抛出让调用方收尾 loading
    throw new ApiError(401, 'UNAUTHENTICATED')
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/http.test.ts`
Expected: PASS（6 条）。

- [ ] **Step 9: 写 `wuji.ts`（`Message` / `Confirm`）的失败测试**

`src/shims/wuji.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Confirm, Message } from './wuji'

const success = vi.fn()
const confirmFn = vi.fn()
const hide = vi.fn()
vi.mock('tdesign-vue-next', () => ({
  MessagePlugin: { success: (...a: unknown[]) => success(...a), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  DialogPlugin: { confirm: (...a: unknown[]) => { confirmFn(...a); return { hide } } },
}))

describe('shims/wuji', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    success.mockClear(); confirmFn.mockClear(); hide.mockClear()
  })

  it('Message.success(字符串)：文案原样交给 TDesign', () => {
    Message.success('提交成功')
    expect(success).toHaveBeenCalledWith({ content: '提交成功', duration: 3000 })
  })

  it('onClose 必须被调用（提交页靠它 router.back()）——超时后触发', () => {
    const onClose = vi.fn()
    Message.success({ content: '工单提交成功！', duration: 2000, onClose })
    expect(onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Confirm 返回 {hide}，透传到 TDesign 的 dialog 实例', () => {
    const d = Confirm({ header: '确认提交', body: '确定吗', confirmBtn: '提交', cancelBtn: '取消', theme: 'info' })
    d.hide()
    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({ header: '确认提交', body: '确定吗', confirmBtn: '提交', cancelBtn: '取消', theme: 'info' }),
    )
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('Confirm 的 onConfirm 被透传（源页在回调里 hide）', () => {
    const onConfirm = vi.fn()
    Confirm({ onConfirm })
    expect(confirmFn.mock.calls[0]![0].onConfirm).toBeTypeOf('function')
    ;(confirmFn.mock.calls[0]![0].onConfirm as () => void)()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 10: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/wuji.test.ts`
Expected: FAIL —— `./wuji` 不存在。

- [ ] **Step 11: 实现 `wuji.ts`**

```ts
// src/shims/wuji.ts —— `@wujibase/wuji` 的收窄替身（spec §3.2 三 shim 表）。
//
// 源侧消费面只有两个符号：`Message`、`Confirm`。
// **`getCurrentUser` 不提供**：它在裁剪后的调用图里已无任何调用点（唯一消费它的
// `useAfterSalesData.loadUserStores()` 是死码且已删），而实现它还得新开「访客 whoami」端点
// ——为死码开端点不划算（spec §3.2「只提供保留页真正调到的」）。
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'

type MessageLevel = 'success' | 'warning' | 'error' | 'info'

interface MessageOptions {
  content: string
  duration?: number
  /** 源侧用它做提交后的跳转/刷新：提交页 `router.back()`、登记页重载档案 */
  onClose?: () => void
}

const DEFAULT_DURATION = 3000

/**
 * 源侧两种调用形状都在用：`Message.error('文案')` 与 `Message.success({content, duration, onClose})`。
 *
 * ⚠️ `onClose` 是**行为契约不是装饰**（有单测钉住）：提交页靠它在提示消失后 `router.back()`。
 * 不赌 TDesign 的 `MessagePlugin` 会不会回调 —— **自己起定时器保证它恰好被调用一次**，
 * 这样「提交成功后回到上一页」这件事不依赖第三方组件的实现细节。
 */
function message(level: MessageLevel) {
  return (msg: string | MessageOptions): void => {
    const opts: MessageOptions = typeof msg === 'string' ? { content: msg } : msg
    const duration = opts.duration ?? DEFAULT_DURATION
    MessagePlugin[level]({ content: opts.content, duration })
    if (opts.onClose) setTimeout(opts.onClose, duration)
  }
}

export const Message = {
  success: message('success'),
  warning: message('warning'),
  error: message('error'),
  info: message('info'),
}

interface ConfirmOptions {
  header?: string
  body?: string
  confirmBtn?: string
  cancelBtn?: string
  theme?: 'info' | 'warning' | 'danger' | 'success' | 'default'
  onConfirm?: () => void
  onClose?: () => void
}

/**
 * 源侧形状：`const d = Confirm({...}); d.hide()`（页面在 onConfirm / onClose 里各自 hide）。
 * TDesign 的 `DialogPlugin.confirm` 正好返回带 `hide()` 的实例 ⇒ 直接透传，
 * 不自己包一层状态机（那只会造出第二份"弹窗开没开"的事实）。
 */
export function Confirm(opts: ConfirmOptions = {}): { hide: () => void } {
  const dialog = DialogPlugin.confirm({
    header: opts.header ?? '确认',
    body: opts.body ?? '',
    confirmBtn: opts.confirmBtn ?? '确定',
    cancelBtn: opts.cancelBtn ?? '取消',
    theme: opts.theme ?? 'info',
    onConfirm: () => opts.onConfirm?.(),
    onCancel: () => opts.onClose?.(),
    onClose: () => opts.onClose?.(),
  })
  return { hide: () => dialog.hide() }
}
```

- [ ] **Step 12: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/wuji.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 13: 写 `wuji-data.ts` 的失败测试**

`src/shims/wuji-data.test.ts`（只针对**纯映射**逻辑——真端点由 Task 9 的端到端与后端的真 PG
测试覆盖；shim 这一层钉的是「认哪个 filter、拼哪个 query、行怎么翻」）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
// ApiError 也从被 mock 的模块里取（下面的工厂把它换成了一个最小实现）——测试断言的是
// 「409 APPROVAL_PENDING 被翻成中文文案」这个行为，不是 ApiError 的实现。
import { ApiError, apiGet, apiSend } from './http'
import { after_sales_work_order, employee_info, employee_info_approve, product_archive, store_info } from './wuji-data'

vi.mock('./http', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  ApiError: class MockApiError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code) }
  },
}))

const get = vi.mocked(apiGet)
const send = vi.mocked(apiSend)

beforeEach(() => {
  get.mockReset()
  send.mockReset()
})

describe('store_info.query', () => {
  it('登记页形状（OR 里是名字）⇒ 转成 q 搜索，行翻成源侧 snake_case', async () => {
    get.mockResolvedValue({ items: [{ id: 7, name: '城东店', regionId: null, address: 'a', phone: 'p' }], total: 1, page: 1, size: 20 })
    const rows = await store_info.query({ filter: { OR: [{ store_name__eq: '城东' }, { store_number__eq: '城东' }] }, sort: 'store_name' })
    expect(get).toHaveBeenCalledWith('/guest/stores?q=%E5%9F%8E%E4%B8%9C')
    expect(rows[0]).toMatchObject({ id: 7, store_name: '城东店', is_enabled: '1' })
  })

  it('提交页形状（OR 里是 id）⇒ 转成 ids（不是「不过滤」）', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 })
    await store_info.query({ filter: { is_enabled__eq: '1', OR: [{ id__eq: 3 }, { id__eq: 5 }] } })
    expect(get).toHaveBeenCalledWith('/guest/stores?ids=3%2C5')
  })

  it('OR 里有 id__eq 但一个都没给（空集）⇒ 仍然走 ids=，绝不回落成「查全部」', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 })
    await store_info.query({ filter: { OR: [{ id__eq: undefined }] } })
    // 空集：`ids=`（服务端按空集处理），**不是**不带参数的「不过滤」
    expect(get).toHaveBeenCalledWith('/guest/stores?ids=')
  })

  it('认不出的 filter ⇒ 抛（不猜、不静默降级成全量）', async () => {
    await expect(store_info.query({ filter: { foo__eq: 1 } })).rejects.toThrow(/认不出的 filter/)
  })
})

describe('employee_info.query', () => {
  it('未登记 ⇒ 空数组（源侧靠 employees[0] 为空判「没登记」）', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: false })
    expect(await employee_info.query({ filter: { openId__eq: 'o1' } })).toEqual([])
  })

  it('已登记 ⇒ 一行，门店 id 用逗号串（源侧就是这个形状）', async () => {
    get.mockResolvedValue({ registration: { name: '张三', phone: '138', storeIds: [3, 5] }, hasPendingApproval: false })
    const rows = await employee_info.query({ filter: { openId__eq: 'o1' } })
    expect(rows[0]).toMatchObject({ employee_name: '张三', employee_phonenumber: '138', store_info: '3,5', status: '通过' })
  })

  it('filter 里的 openid 被忽略——身份只由 session 给', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: false })
    await employee_info.query({ filter: { openId__eq: '别人的-openid' } })
    expect(get).toHaveBeenCalledWith('/guest/me/registration')
  })
})

describe('employee_info_approve', () => {
  it('query：hasPendingApproval=true ⇒ 非空（源侧据此提示「已有待审批」）', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: true })
    expect(await employee_info_approve.query({ filter: { openid__eq: 'o1', status__eq: '待审批' } })).toHaveLength(1)
  })

  it('create：把表单目标值映射成域端点的 {name, phone, storeIds}', async () => {
    send.mockResolvedValue({ id: 1 })
    await employee_info_approve.create({
      approvetype: '注册',
      approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3,5' },
    })
    expect(send).toHaveBeenCalledWith('/guest/employee-approvals', 'POST', {
      name: '张三', phone: '138', storeIds: [3, 5],
    })
  })

  it('create：只提交目标值（**不发 old_info/new_info**——差异由服务端算，spec §2.5 纪律②）', async () => {
    send.mockResolvedValue({ id: 1 })
    await employee_info_approve.create({ approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3' } })
    const body = send.mock.calls[0]![2] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['name', 'phone', 'storeIds'])
  })

  it('create：服务端 409 APPROVAL_PENDING ⇒ 翻成源侧那句文案（页面 catch 分支不用改）', async () => {
    send.mockRejectedValue(new ApiError(409, 'APPROVAL_PENDING'))
    await expect(
      employee_info_approve.create({ approveinfo: { employee_name: '张', employee_phonenumber: '1', store_info: '' } }),
    ).rejects.toThrow('您已有待审批的申请')
  })
})

describe('product_archive.query', () => {
  it('把域侧分页翻成源侧「一次拿完」：按 page 循环直到收齐 total', async () => {
    get
      .mockResolvedValueOnce({ items: [{ id: 1, name: 'P1', spec: null, basicQuantity: 10, basicUnitPriceMinor: 500 }], total: 2, page: 1, size: 100 })
      .mockResolvedValueOnce({ items: [{ id: 2, name: 'P2', spec: null, basicQuantity: 20, basicUnitPriceMinor: 600 }], total: 2, page: 2, size: 100 })
    const rows = await product_archive.query({ filter: { status__eq: 1 }, sort: 'product_name', pageSize: 1000 })
    expect(rows.map((r) => r.product_name)).toEqual(['P1', 'P2'])
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('搜索词走 q（域侧没有「商品编码」这一路，源侧的双分支合并因此收成一路）', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 100 })
    await product_archive.query({ filter: { product_name__contains: '螺栓', status__eq: 1 } })
    expect(get).toHaveBeenCalledWith('/guest/products?q=%E8%9E%BA%E6%A0%93&size=100')
  })
})

describe('after_sales_work_order.create', () => {
  it('只映射域端点收的那几个字段，且带上 sessionStorage 里的幂等键', async () => {
    sessionStorage.clear()
    send.mockResolvedValue({ id: 9, code: 'AS-00000009', status: 'pending', duplicated: false })
    await after_sales_work_order.create({
      product_id: 4, store_selection: 7, damage_quantity: 2, damage_reason: '破损',
      damage_images: [{ attachmentId: 11 }, { attachmentId: 12 }],
      // 下面这些源侧字段域端点**不收**，必须被丢掉（不是拼进 body）
      order_number: 'YYMMDD00001', related_order: 3, damage_amount: 1000,
    })
    const body = send.mock.calls[0]![2] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['attachmentIds', 'clientRequestId', 'damageQuantity', 'productId', 'remark', 'storeId'])
    expect(body).toMatchObject({ productId: 4, storeId: 7, damageQuantity: 2, remark: '破损', attachmentIds: [11, 12] })
    expect(typeof body.clientRequestId).toBe('string')
  })

  it('server 回 duplicated:true ⇒ 视为「已落库」（调用方据此也轮换幂等键）', async () => {
    sessionStorage.clear()
    send.mockResolvedValue({ id: 9, duplicated: true })
    await expect(after_sales_work_order.create({ product_id: 4, damage_quantity: 1 })).resolves.toMatchObject({ duplicated: true })
  })
})
```

- [ ] **Step 14: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/wuji-data.test.ts`
Expected: FAIL —— `./wuji-data` 不存在。

- [ ] **Step 15: 实现 `wuji-data.ts`**

```ts
// src/shims/wuji-data.ts —— `@wujibase/wuji-data` 的收窄替身（spec §3.2 三 shim 表）：
// **5 个表对象**，每个只实现保留页真正调到的方法，映射到具体域端点。
//
// 收窄的边界（写在这里免得后来者以为漏了）：
//   · `wechat_openid` —— 前端微信 OAuth 的 token 缓存，已由 M1 宿主路取代 ⇒ 不提供；
//   · `users` / `outbound_detail` —— 只出现在被裁掉的 loadUserStores / loadOrders 里 ⇒ 不提供；
//   · `after_sales_work_order.count` —— 源侧拿它按前缀数单生成工单号，而域侧工单号由服务端
//     生成（`AS-00000001`，spec §2.2 ③）⇒ 不提供，`generateOrderNumber` 一并删除。
import { ApiError, apiGet, apiSend } from './http'
import { currentClientRequestId } from './client-request-id'

// ── 源侧行形状：camelCase 的域响应 → snake_case 的源侧字段，页面/组件因此一行不改 ──
export interface StoreRow {
  id: number
  store_name: string
  store_number: string
  is_enabled: string
}
export interface EmployeeRow {
  id: number
  employee_name: string
  employee_phonenumber: string
  /** 逗号分隔的门店 id（源侧形态；平台侧已规范化成 employee_store 关联表，spec §2.5） */
  store_info: string
  status: string
  _ctime: string
  _mtime: string
}
export interface ApprovalRow {
  id: number
  openid: string
  status: string
}
export interface ProductRow {
  id: number
  product_name: string
  basic_quantity: number
  basic_unit_price_minor: number
}

interface StoreItem { id: number; name: string; regionId: number | null; address: string; phone: string }
interface ProductItem { id: number; name: string; spec: string | null; basicQuantity: number; basicUnitPriceMinor: number }
interface MyRegistration {
  registration: { name: string; phone: string; storeIds: number[] } | null
  hasPendingApproval: boolean
}

/** 域侧分页上界（`routes/context.ts` 的 `MAX_PAGE_SIZE`）——写在这里是这个数字的第二份来源，
 *  故旁边写明它的出处；改动后端上界时要一起改（Task 9 的收口清单里有这一条）。 */
const SERVER_MAX_PAGE_SIZE = 100
const MAX_PRODUCT_PAGES = 50

/**
 * 认 `store_info.query` 的**两种已知 filter 形状**，认不出就**抛**。
 *
 * 为什么抛而不是回落：静默回落成「不过滤」= 把**全量门店**回给访客（本仓反复批的静默降级）。
 * 调用点只有两个、都有测试，抛出去的是一条开发期就能撞见的错。
 */
function parseStoreFilter(filter: unknown): { kind: 'ids'; ids: number[] } | { kind: 'search'; text: string } {
  const or = (filter as { OR?: unknown } | null)?.OR
  if (Array.isArray(or)) {
    const ids: number[] = []
    let sawId = false
    let sawName = false
    let text = ''
    for (const cond of or) {
      const c = cond as { id__eq?: unknown; store_name__eq?: unknown } | null
      if (c?.id__eq !== undefined) {
        sawId = true
        ids.push(Number(c.id__eq))
      }
      if (typeof c?.store_name__eq === 'string') {
        sawName = true
        if (c.store_name__eq !== '') text = c.store_name__eq
      }
    }
    if (sawId) return { kind: 'ids', ids }
    if (sawName) return { kind: 'search', text }
  }
  throw new Error(
    `store_info.query: 认不出的 filter（本 shim 只支持 id__eq / store_name__eq 两种形状）：${JSON.stringify(filter)}`,
  )
}

export const store_info = {
  async query(args: { filter?: unknown; sort?: string; pageSize?: number } = {}): Promise<StoreRow[]> {
    const f = parseStoreFilter(args.filter)
    const params = new URLSearchParams()
    if (f.kind === 'ids') {
      // 空集显式写成 `ids=`（服务端按空集处理），**不是**省略参数——省略等于「不过滤」
      params.set('ids', f.ids.join(','))
    } else if (f.text !== '') {
      params.set('q', f.text)
    }
    if (args.pageSize) params.set('size', String(Math.min(args.pageSize, SERVER_MAX_PAGE_SIZE)))
    const qs = params.toString()
    const body = await apiGet<{ items: StoreItem[] }>(`/guest/stores${qs ? `?${qs}` : ''}`)
    return body.items.map((s) => ({
      id: s.id,
      store_name: s.name,
      // 域侧门店**没有「编号」列**（spec §3.2）：退化成 id 的字符串，让源侧按编号搜那条路
      // 仍有确定行为（服务端只按名字搜）。这是**已知落差**，不是本 shim 的 bug。
      store_number: String(s.id),
      is_enabled: '1',
    }))
  },
}

export const employee_info = {
  /**
   * 源侧一律 `{filter: {openId__eq}}` ⇒ `GET /guest/me/registration`。
   * **filter 里的 openid 被忽略**：访客身份由 session（HttpOnly cookie）给，前端传什么都不改变
   * 服务端收窄的口径——这正是「身份只有一份来源」的落地（spec §3.2 摘 OAuth 块的同一条理由）。
   */
  async query(_args: { filter?: unknown; pageSize?: number } = {}): Promise<EmployeeRow[]> {
    const body = await apiGet<MyRegistration>('/guest/me/registration')
    if (body.registration === null) return []
    return [
      {
        id: 0,
        employee_name: body.registration.name,
        employee_phonenumber: body.registration.phone,
        store_info: body.registration.storeIds.join(','),
        // 能读到快照 ⇒ 档案已是 approved（服务端只回 approved 的）。状态词表按源侧
        // `employee_info` 那一套（中文；spec §5 #9 记的三套并存），展示层保持原样。
        status: '通过',
        _ctime: '',
        _mtime: '',
      },
    ]
  },
}

export const employee_info_approve = {
  /**
   * 源侧 `{filter: {openid__eq, status__eq: '待审批'}}` ⇒ 读 `hasPendingApproval`。
   * ⚠️ 源侧这里是小写 `openid__eq`（`employee_info` 那边是 `openId__eq`）——**源里就不一致**，
   * 本 shim 不纠：纠了反而与源侧调用点对不上，而它本来就只用来判「有没有」。
   */
  async query(_args: { filter?: unknown } = {}): Promise<ApprovalRow[]> {
    const body = await apiGet<MyRegistration>('/guest/me/registration')
    return body.hasPendingApproval ? [{ id: 0, openid: '', status: '待审批' }] : []
  },

  /**
   * 域端点收的是**目标值** `{name, phone, storeIds}`（spec §2.5 纪律②：差异由服务端算）。
   * 源侧 payload 里的 `approvetype` / `openid` / `status` / `old_info` **一律不发**——
   * `old_info` 尤其不能发：服务端本来就知道当前行，发过去只会变成第二份事实。
   */
  async create(data: { approveinfo?: unknown } = {}): Promise<unknown> {
    const info = (data.approveinfo ?? {}) as {
      employee_name?: unknown
      employee_phonenumber?: unknown
      store_info?: unknown
    }
    const raw = info.store_info
    const storeIds = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    try {
      return await apiSend('/guest/employee-approvals', 'POST', {
        name: String(info.employee_name ?? ''),
        phone: String(info.employee_phonenumber ?? ''),
        storeIds,
      })
    } catch (e) {
      // 「已有待审批」在**服务端**是 409 APPROVAL_PENDING（部分唯一索引兜底，spec §2.5 纪律①）。
      // 源侧靠提交前查一次提示——那个判定并发下会漏，所以服务端的才算数；这里翻成源侧那句
      // 文案，页面的 catch 分支因此不用改。
      if (e instanceof ApiError && e.code === 'APPROVAL_PENDING') {
        throw new Error('您已有待审批的申请，请等待审批')
      }
      // 「您没有修改任何信息」由服务端 400 带 message 回（computeRegistration 抛的）——
      // 原样透出，与源侧那句提示一致。
      if (e instanceof ApiError && e.message !== '') throw new Error(e.message)
      throw e
    }
  },
}

export const product_archive = {
  /**
   * 源侧要「一次拿完」（`pageSize: 1000`），而域侧 `/guest/products` 的 `size` 上界是 100
   * ⇒ 这里**按页循环收齐**。上界 `MAX_PRODUCT_PAGES` 是防御：服务端 total 若因并发变动
   * 让我们永远收不齐，也不能把移动端拖进死循环。
   */
  async query(args: { filter?: unknown; sort?: string; pageSize?: number } = {}): Promise<ProductRow[]> {
    const f = (args.filter ?? {}) as { product_name__contains?: unknown }
    const q = typeof f.product_name__contains === 'string' ? f.product_name__contains : ''
    const size = Math.min(args.pageSize ?? SERVER_MAX_PAGE_SIZE, SERVER_MAX_PAGE_SIZE)

    const out: ProductRow[] = []
    for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
      const params = new URLSearchParams({ page: String(page), size: String(size) })
      if (q !== '') params.set('q', q)
      const body = await apiGet<{ items: ProductItem[]; total: number }>(`/guest/products?${params}`)
      out.push(...body.items.map((p) => ({
        id: p.id,
        product_name: p.name,
        basic_quantity: p.basicQuantity,
        basic_unit_price_minor: p.basicUnitPriceMinor,
      })))
      if (out.length >= body.total || body.items.length === 0) break
    }
    return out
  },
}

export const after_sales_work_order = {
  /**
   * 源侧 payload 有 23 个键（含 `order_number` / `related_order` / `damage_amount` /
   * `damage_images` / `damage_video` …），而域端点 `POST /guest/tickets` 只收 6 个
   * （spec §2.2）。**只映射这 6 个，其余丢掉**——不是"以后再补"：
   * 工单号服务端生成、金额由服务端按规则快照算（§0.3 把「前端算金额」列为要消灭的模式）。
   */
  async create(payload: {
    product_id?: unknown
    store_selection?: unknown
    damage_quantity?: unknown
    damage_reason?: unknown
    damage_images?: unknown
  } = {}): Promise<{ id: number; code?: string; duplicated?: boolean }> {
    const attachments = Array.isArray(payload.damage_images) ? payload.damage_images : []
    const attachmentIds = attachments
      .map((a) => Number((a as { attachmentId?: unknown } | null)?.attachmentId))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    return apiSend('/guest/tickets', 'POST', {
      clientRequestId: currentClientRequestId(),
      productId: Number(payload.product_id),
      ...(payload.store_selection === undefined || payload.store_selection === null
        ? {}
        : { storeId: Number(payload.store_selection) }),
      damageQuantity: Number(payload.damage_quantity),
      remark: String(payload.damage_reason ?? ''),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })
  },
}
```

- [ ] **Step 16: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/wuji-data.test.ts`
Expected: PASS（13 条）。

- [ ] **Step 17: 写 `wuji-upload.ts` 的失败测试**

`src/shims/wuji-upload.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFile, uploadImage } from './wuji-upload'

const calls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls.length = 0
  sessionStorage.clear()
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.startsWith('/api/modules/aftersales/guest/attachments')) {
      return json(201, { id: 42, objectKey: 'org/ref/a.jpg', uploadUrl: 'https://zos.test/put?a=1', expiresIn: 600 })
    }
    return new Response(null, { status: 200 }) // 直传 PUT
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = origFetch })

describe('shims/wuji-upload', () => {
  it('uploadImage：先拿预签名，再直传字节，回 {id, objectKey}', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' })
    const r = await uploadImage(file, 'after-sales/temp/2026/09/16/temp_1_abcdef.jpg')
    expect(r).toEqual({ id: 42, objectKey: 'org/ref/a.jpg' })

    // ① 预签名请求：带 content-type 与**会话级幂等键**（附件挂在工单幂等键下，spec §2.3）
    const presign = JSON.parse(String(calls[0]!.init?.body))
    expect(calls[0]!.url).toBe('/api/modules/aftersales/guest/attachments')
    expect(presign.contentType).toBe('image/jpeg')
    expect(presign.sizeBytes).toBe(3)
    expect(presign.clientRequestId).toBe(sessionStorage.getItem('aftersales.clientRequestId'))

    // ② 直传：PUT 到预签名 URL，字节不过平台
    expect(calls[1]!.url).toBe('https://zos.test/put?a=1')
    expect(calls[1]!.init?.method).toBe('PUT')
    expect(calls[1]!.init?.headers).toEqual({ 'Content-Type': 'image/jpeg' })
  })

  it('uploadFile：非图片走同一路（白名单在服务端，客户端不重复判）', async () => {
    const file = new File([new Uint8Array([1])], 'v.mp4', { type: 'video/mp4' })
    await uploadFile(file, 'p')
    expect(JSON.parse(String(calls[0]!.init?.body)).contentType).toBe('video/mp4')
  })

  it('ZOS 未配置（503）⇒ 上抛，让页面能提示而不是留一张传不上去的工单', async () => {
    globalThis.fetch = vi.fn(async () => json(503, { error: 'ZOS_NOT_CONFIGURED' })) as unknown as typeof fetch
    await expect(uploadImage(new File([], 'a.jpg', { type: 'image/jpeg' }), 'p')).rejects.toMatchObject({
      code: 'ZOS_NOT_CONFIGURED',
    })
  })

  it('预签名成功但直传失败 ⇒ 上抛（不返回一个「看起来成了」的 id）', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('/api/')) return json(201, { id: 42, objectKey: 'k', uploadUrl: 'https://zos.test/put' })
      return new Response('nope', { status: 403 })
    }) as unknown as typeof fetch
    await expect(uploadImage(new File([], 'a.jpg', { type: 'image/jpeg' }), 'p')).rejects.toMatchObject({ status: 403 })
  })
})
```

- [ ] **Step 18: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims/wuji-upload.test.ts`
Expected: FAIL —— `./wuji-upload` 不存在。

- [ ] **Step 19: 实现 `wuji-upload.ts`**

```ts
// src/shims/wuji-upload.ts —— `@wujibase/wuji-upload` 的收窄替身（spec §3.2 三 shim 表）。
//
// 源侧形状是 `uploadFn(file, uniqueFilePath)` → **string url**。域侧的路是**预签名直传**：
// `POST /guest/attachments` 拿 URL（字节**不过平台**，spec §2.3），再 PUT 到 ZOS。
//
// ⚠️ 返回值与源侧**不同**（`{id, objectKey}` 而不是 url）：源侧的 url 是它自己 CDN 的
// 可读地址，而平台的预签名 **PUT** URL 不是可读地址（GET 要另签）。页面需要的两样东西是
// 「本地预览」与「提交时认领的 attachmentId」——前者由 composable 用 `URL.createObjectURL`
// 自己持有，后者就是这里的 `id`。适配点写在 `useFileUpload.ts`（Task 7）。
import { ApiError, apiSend } from './http'
import { currentClientRequestId } from './client-request-id'

export interface UploadResult {
  id: number
  objectKey: string
}

interface PresignResponse {
  id: number
  objectKey: string
  uploadUrl: string
  expiresIn: number
}

async function upload(file: File, _path: string): Promise<UploadResult> {
  // `_path`（源侧的 object key）刻意不参与：key 由**服务端**按 `objectKeyFor(org, clientRequestId)`
  // 生成（spec §2.3），客户端拼的那条路径没有消费方。留着形参是为了让调用点一字不改。
  const presigned = await apiSend<PresignResponse>('/guest/attachments', 'POST', {
    clientRequestId: currentClientRequestId(),
    contentType: file.type,
    sizeBytes: file.size,
  })

  // 直传：字节从客户端直达 ZOS，平台全程不过手（spec §2.3）
  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  // ⚠️ 直传失败必须**上抛**：预签名成功只代表「拿到了一张票」，票没核销就没有对象。
  //    静默吞掉会留下一张永远看不到图的工单（比报错难查得多）。
  if (!put.ok) throw new ApiError(put.status, `UPLOAD_${put.status}`)

  return { id: presigned.id, objectKey: presigned.objectKey }
}

export const uploadImage = upload
export const uploadFile = upload
```

- [ ] **Step 20: 跑测试确认通过 + 全包门禁**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/shims && pnpm typecheck`
Expected: PASS（全部 shim 用例）。

- [ ] **Step 21: 提交**

```bash
git add modules/aftersales/mobile/src/shims
git commit -m "feat(aftersales): M3b-2 三 shim + clientRequestId 三条语义（含单测）(#83)"
```

---

### Task 6: 登记页（`storeEmployeeApproval`）

**Files:**
- Create: `modules/aftersales/mobile/src/types/store.ts`（从 `wuji-2/src/types/store.ts` 搬）
- Create: `modules/aftersales/mobile/src/utils/afterSalesHelpers.ts`（从 `wuji-2/src/utils/afterSalesHelpers.ts` 搬）
- Create: `modules/aftersales/mobile/src/composables/useStoreEmployeeApproval.ts`（搬 + 适配）
- Create: `modules/aftersales/mobile/src/composables/useStoreEmployeeApproval.test.ts`
- Modify: `modules/aftersales/mobile/src/pages/storeEmployeeApproval.vue`（占位换实体）
- Create: `modules/aftersales/mobile/src/pages/storeEmployeeApproval.test.ts`

**Interfaces:**
- Consumes: `store_info` / `employee_info` / `employee_info_approve`（Task 5）、`Message`（Task 5）、路由名 `register`。
- Produces: 组件 `storeEmployeeApproval.vue`（默认导出，无 props）；composable
  `useStoreEmployeeApproval()` 返回 `{pageLoading, loading, employeeInfo, storeList, formData, loadStores, loadSelectedStores, loadEmployeeInfo, submitApproval}`（**与源侧同名同形**）。

**源文件位置**（Task 6/7 的所有「搬」都从这里取，逐字对照）：
`/Users/duo/Documents/mytechcode/wuji-2/src/…`。
`wuji-2` 的 AGENTS.md 记着「移动端在微信里打开、看不到控制台，调试请用 alert」——
移植时**保留**这个约束，别顺手换成 `console.log`。

- [ ] **Step 1: 搬类型与工具**

逐字复制这两个文件（它们是纯类型/纯函数，无宿主依赖）：

- `wuji-2/src/types/store.ts` → `mobile/src/types/store.ts`
- `wuji-2/src/utils/afterSalesHelpers.ts` → `mobile/src/utils/afterSalesHelpers.ts`

（`afterSalesHelpers.ts` 依赖 `dayjs`——Task 4 已装。）

- [ ] **Step 2: 写 composable 的失败测试**

`src/composables/useStoreEmployeeApproval.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { employee_info, employee_info_approve, store_info } from '@/shims/wuji-data'
import { useStoreEmployeeApproval } from './useStoreEmployeeApproval'

vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  employee_info_approve: { query: vi.fn(), create: vi.fn() },
}))
vi.mock('@wujibase/wuji', () => ({
  Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(),
}))

const storeQuery = vi.mocked(store_info.query)
const empQuery = vi.mocked(employee_info.query)
const approvalQuery = vi.mocked(employee_info_approve.query)
const approvalCreate = vi.mocked(employee_info_approve.create)

const STORES = [
  { id: 3, store_name: '城东店', store_number: '3', is_enabled: '1' },
  { id: 5, store_name: '城西店', store_number: '5', is_enabled: '1' },
  { id: 7, store_name: '城南店', store_number: '7', is_enabled: '1' },
]

beforeEach(() => {
  storeQuery.mockReset().mockResolvedValue(STORES)
  empQuery.mockReset().mockResolvedValue([])
  approvalQuery.mockReset().mockResolvedValue([])
  approvalCreate.mockReset().mockResolvedValue({ id: 1 })
})

describe('useStoreEmployeeApproval', () => {
  it('loadEmployeeInfo：未登记 ⇒ employeeInfo 为 null（页面据此进「注册」态）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadEmployeeInfo()
    expect(c.employeeInfo.value).toBeNull()
    // 未登记且没有待审批 ⇒ 表单可编辑
    expect(approvalQuery).toHaveBeenCalledTimes(1)
  })

  it('loadEmployeeInfo：已登记 ⇒ 档案回填，并把门店 id 串回填进表单', async () => {
    empQuery.mockResolvedValue([
      { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3,5', status: '通过', _ctime: '', _mtime: '' },
    ])
    const c = useStoreEmployeeApproval()
    await c.loadEmployeeInfo()
    expect(c.employeeInfo.value?.employee_name).toBe('张三')
    expect(c.formData.store_info).toEqual(['3', '5'])
  })

  it('loadSelectedStores：**一次** query 取回全部门店（不是 N 次并发）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadSelectedStores(['3', '5'])
    expect(storeQuery).toHaveBeenCalledTimes(1)
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ id__eq: 3 }, { id__eq: 5 }] } })
    expect(c.storeList.value.map((s) => s.store_name)).toEqual(['城东店', '城西店'])
  })

  it('loadStores(搜索词)：把词翻成 store_name__eq 的 OR 形状（shim 认这个形状）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadStores('城东')
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ store_name__eq: '城东' }, { store_number__eq: '城东' }] }, sort: 'store_name' })
  })

  it('submitApproval：提交**完整目标值**（不做前端 diff——差异由服务端算，spec §2.5 纪律②）', async () => {
    const c = useStoreEmployeeApproval()
    c.formData.employee_name = '张三'
    c.formData.employee_phonenumber = '138'
    c.formData.store_info = ['3', '5']
    await c.submitApproval('注册')
    expect(approvalCreate).toHaveBeenCalledWith({
      approvetype: '注册',
      approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3,5' },
    })
  })

  it('submitApproval：服务端 409（已有待审批）⇒ 返回 false 且提示（不是抛给页面）', async () => {
    approvalCreate.mockRejectedValue(new Error('您已有待审批的申请，请等待审批'))
    const c = useStoreEmployeeApproval()
    c.formData.employee_name = '张三'
    await expect(c.submitApproval('注册')).resolves.toBe(false)
  })

  it('submitApproval：未填姓名/电话时不发请求（源侧的必填闸门）', async () => {
    const c = useStoreEmployeeApproval()
    c.formData.employee_name = ''
    c.formData.employee_phonenumber = ''
    await expect(c.submitApproval('注册')).resolves.toBe(false)
    expect(approvalCreate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/composables/useStoreEmployeeApproval.test.ts`
Expected: FAIL —— `./useStoreEmployeeApproval` 不存在。

- [ ] **Step 4: 搬并适配 composable**

从 `wuji-2/src/composables/useStoreEmployeeApproval.ts` 逐字搬过来，**只做这四处适配**：

1. **删掉顶部对 `@wujibase/wuji` 的 `Message` 之外的依赖**（源文件只 import `Message`，无需改动），
   `import { store_info } from '@wujibase/wuji-data'` 等三行**原样保留**（别名由 vite 解析）。
2. **`loadStores(searchText)`**：源侧 filter 已经是
   `{OR: [{store_name__eq: t}, {store_number__eq: t}]}` —— **保持原样**（shim 认这个形状）。
3. **`loadSelectedStores(storeIds)`：整段替换成一次 query**。源侧是
   `Promise.all(storeIds.map((id) => store_info.query({filter: {id__eq: id}})))` 后扁平化——
   域侧有了 `ids`，N 次并发收成 1 次：

```ts
  /** 取「我选中的门店」的明细。域侧 `/guest/stores?ids=` 支持批量 ⇒ **一次请求**，
   *  （源侧是 storeIds.map 并发 N 次单查，因为源数据源没有 id__in）。 */
  const loadSelectedStores = async (storeIds: string[]) => {
    if (storeIds.length === 0) {
      storeList.value = []
      return
    }
    try {
      storeList.value = await store_info.query({
        filter: { OR: storeIds.map((id) => ({ id__eq: Number(id) })) },
      })
    } catch (error: any) {
      Message.error(error?.message || '加载门店列表失败')
    }
  }
```

4. **`submitApproval(approveType)`：删掉整段前端 diff**（源侧「变更」分支里逐字段比较
   `old_info`/`new_info`，`_ctime`/`_mtime` 也在那一带）。按 spec §0.3 那是「前端式编排」，
   差异现在由服务端的 `computeRegistration` 算。适配后的函数体：

```ts
  /**
   * 提交登记/变更。**只提交目标值**（spec §2.5 纪律②）——源侧在这里逐字段 diff 出
   * old_info/new_info，那是要消灭的前端编排；服务端本就知道当前行，由它算。
   * 「您没有修改任何信息」仍会出现，只不过现在由服务端回 400 + message
   * （shim 把它翻成 Error，下面的 catch 原样展示）。
   */
  const submitApproval = async (approveType: '注册' | '变更'): Promise<boolean> => {
    const name = String(formData.value.employee_name ?? '').trim()
    const phone = String(formData.value.employee_phonenumber ?? '').trim()
    if (name === '' || phone === '') {
      Message.warning('请填写员工姓名与手机号')
      return false
    }
    const storeInfoString = Array.isArray(formData.value.store_info)
      ? (formData.value.store_info as string[]).join(',')
      : String(formData.value.store_info ?? '')

    loading.value = true
    try {
      await employee_info_approve.create({
        approvetype: approveType,
        approveinfo: {
          employee_name: name,
          employee_phonenumber: phone,
          store_info: storeInfoString,
        },
      })
      return true
    } catch (error: any) {
      // 409（已有待审批）与 400（没有修改任何信息）都在这条路上，文案来自服务端
      Message.error(error?.message || '提交失败')
      return false
    } finally {
      loading.value = false
    }
  }
```

其余（`pageLoading` / `employeeInfo` / `formData` 的初值 / `loadEmployeeInfo` 的门店回填 /
`getStoreNames`）**逐字保留**。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/composables/useStoreEmployeeApproval.test.ts`
Expected: PASS（7 条）。

- [ ] **Step 6: 搬页面并摘除页内 OAuth**

把 `wuji-2/src/pages/storeEmployeeApproval.vue` 搬到
`mobile/src/pages/storeEmployeeApproval.vue`，**只做这三处改动**：

1. **删掉页内前端微信 OAuth 那一整段**（源里在 `:306-373` 一带：`wechat_openid.request(...)`、
   `localStorage['wechat_openid']` 的读写、`window.w.global.appid`、手拼的 `open.weixin.qq.com`
   授权 URL、以及 `OPENID_STORAGE_KEY` 常量）。**身份改由 session 给**，页面不再持有 openid。
   连带删掉 `savedOpenid` 这个 ref。
2. **`handleSubmit` 成功后不再传 openid 重载**：源侧是
   `loadEmployeeInfo(savedOpenid.value)`（`:491-498` 的 `Message.success` 里），改成
   `loadEmployeeInfo()`（无参）。
3. `import { onMounted, ref } from 'vue'` / `useRoute` / `dayjs` / `defineWujiPageMeta(...)` /
   `Message` 全部**原样保留**（`defineWujiPageMeta` 由 Task 4 的 `main.ts` 提供全局实现）。

- [ ] **Step 7: 写页面的组件测试**

`src/pages/storeEmployeeApproval.test.ts`：

```ts
// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push }) }))
vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn().mockResolvedValue([]) },
  employee_info: { query: vi.fn().mockResolvedValue([]) },
  employee_info_approve: { query: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 1 }) },
}))
const success = vi.fn()
vi.mock('@wujibase/wuji', () => ({
  Message: { success, warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(),
}))

import StoreEmployeeApproval from './storeEmployeeApproval.vue'
import { employee_info_approve } from '@/shims/wuji-data'

beforeEach(() => {
  success.mockClear()
  vi.mocked(employee_info_approve.create).mockClear()
  ;(globalThis as unknown as { defineWujiPageMeta?: unknown }).defineWujiPageMeta = vi.fn()
})

const global = { stubs: { 't-card': false } }

describe('storeEmployeeApproval 页面', () => {
  it('挂载后拉一次档案（未登记 ⇒ 停在注册态）', async () => {
    const w = mount(StoreEmployeeApproval, { global })
    await flushPromises()
    expect(w.text()).toContain('注册')
  })

  it('页面上**没有**任何微信 OAuth 残留（localStorage / open.weixin.qq.com 都不该出现）', async () => {
    mount(StoreEmployeeApproval, { global })
    await flushPromises()
    expect(localStorage.getItem('wechat_openid')).toBeNull()
    // 源码级断言：OAuth 块是整体删除，不是被条件分支藏起来
    const src = (await import('./storeEmployeeApproval.vue?raw')).default as string
    expect(src).not.toContain('open.weixin.qq.com')
    expect(src).not.toContain('wechat_openid')
    expect(src).not.toContain('window.w')
  })

  it('提交成功 ⇒ Message.success 的文案是「注册已提交，等待审批」', async () => {
    const w = mount(StoreEmployeeApproval, { global })
    await flushPromises()
    // 填必填项（选择器是 t-input，直接写底层 formData 更稳：这里驱动 DOM 输入）
    const inputs = w.findAll('input')
    await inputs[0]!.setValue('张三')
    await inputs[1]!.setValue('13800000000')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('注册已提交') }))
  })
})
```

> `?raw` 导入 Vue SFC 需要 vite 的 raw 支持（vite 内建）。若该断言在 happy-dom 下不稳，
> 退化成读文件：`readFileSync(new URL('./storeEmployeeApproval.vue', import.meta.url), 'utf8')`
> ——**断言本身必须留**：它是「OAuth 块真的被删干净」的机检，而这类"删了一半"最容易静默留下。

- [ ] **Step 8: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/pages/storeEmployeeApproval.test.ts`
Expected: PASS（3 条）。若组件测试因 TDesign 组件未全局注册而报错，在 mount 的
`global.plugins` 里装上 `TDesign`（`import TDesign from 'tdesign-vue-next'`）。

- [ ] **Step 9: 全包门禁**

Run: `cd modules/aftersales/mobile && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add modules/aftersales/mobile/src
git commit -m "feat(aftersales): M3b-2 登记页整迁——一次批量取门店 + 摘除页内 OAuth (#83)"
```

---

## Wave 4

### Task 7: 提交页数据层（`useAfterSalesData` / `useFileUpload` / `useWorkOrderSubmit`）

**Files:**
- Create: `modules/aftersales/mobile/src/types/afterSalesWorkOrder.ts`（搬）
- Create: `modules/aftersales/mobile/src/types/outboundDetail.ts`（搬，供类型引用）
- Create: `modules/aftersales/mobile/src/composables/useAfterSalesData.ts`（搬 + **裁剪**）
- Create: `modules/aftersales/mobile/src/composables/useFileUpload.ts`（搬 + 适配）
- Create: `modules/aftersales/mobile/src/composables/useWorkOrderSubmit.ts`（搬 + **改写**）
- Create: `modules/aftersales/mobile/src/composables/useAfterSalesWorkOrder.ts`（搬，聚合器）
- Create: 上述三个的 `*.test.ts`
- Create: `modules/aftersales/mobile/src/composables/clientRequestId.test.ts`（见 Step 7）

**Interfaces:**
- Consumes: `store_info` / `product_archive` / `employee_info` / `after_sales_work_order`（Task 5）、
  `uploadImage` / `uploadFile`（Task 5）、`currentClientRequestId` / `rotateClientRequestId`（Task 5）。
- Produces: `useAfterSalesWorkOrder()` 返回**源侧同名同形**的
  `{loading, productLoading, productList, storeList, selectedStore, selectedProduct, attachments, formData, loadEmployeeStores, loadProducts, addAttachment, removeAttachment, submitWorkOrder, formatTime}`
  ——**注意去掉了 `orderList` / `selectedOrder` / `loadOrders`**（订单选择不做，见 spec §3.2）。

- [ ] **Step 1: 搬类型**

逐字复制：`wuji-2/src/types/afterSalesWorkOrder.ts`、`wuji-2/src/types/outboundDetail.ts`
→ `mobile/src/types/`。

- [ ] **Step 2: 裁剪 `useAfterSalesData.ts`**

搬 `wuji-2/src/composables/useAfterSalesData.ts` 过来，然后**删掉三块**：

1. `import { users } from '@wujibase/wuji-data'`、
   `import { outbound_detail } from '@wujibase/wuji-data'`
2. `useAfterSalesData.ts` 里的 `loadUserStores`（约 `:106-246`，含 `users.getById` /
   `users.query`）——它是死码（保留页的解构清单里没有它）。
3. `loadOrders`（约 `:325-379`，含 `outbound_detail.query`）——订单选择不做（spec §3.2）。
4. `const currentUser = getCurrentUser()`（`:20`）与其 import——裁剪后无调用点。

**保留**：`loadEmployeeStores`（门店，走 `store_info.query` 的 **ids** 形状）、`loadProducts`
（改：见 Step 3）、`formatTime`、`allowedStoreIds` 的计算。

**`loadEmployeeStores` 必须是 ids 形状**（提交页口径是「选**我登记的**门店」）：

```ts
  /**
   * 加载「我的登记门店」（**不是全量门店**——那是登记页的口径，spec §3.2）。
   * 源侧这里靠 `OR: [{id__eq}…]` 拼 filter，域侧 `/guest/stores` 直接收 `ids`，
   * 但 shim 认的正是 OR 形状 ⇒ 调用点保持源侧写法。
   */
  const loadEmployeeStores = async () => {
    const snap = await employee_info.query({ filter: { openId__eq: '' } })
    const allowedIds = snap[0]?.store_info ? snap[0].store_info.split(',').filter(Boolean) : []
    if (allowedIds.length === 0) {
      storeList.value = []
      return
    }
    storeList.value = await store_info.query({
      filter: { OR: allowedIds.map((id) => ({ id__eq: Number(id) })) },
    })
  }
```

- [ ] **Step 3: 改 `loadProducts`（双分支合并成一路）**

源侧 `loadProducts(searchText)` 发**两次** query（`product_name__contains` + `id__startswith`）
再按 id 去重合并。域侧 `/guest/products` **没有「商品编码」这一路** ⇒ 收成一次：

```ts
  /**
   * 商品搜索。源侧发两次（按名字 + 按编码前缀）再合并——域侧没有「商品编码」这一路
   * （spec §3.2），故收成一次按名字搜。**这是有意的行为收窄**，不是漏搬。
   */
  const loadProducts = async (searchText = '') => {
    productLoading.value = true
    try {
      productList.value = await product_archive.query({
        filter: { status__eq: 1, ...(searchText ? { product_name__contains: searchText } : {}) },
        sort: 'product_name',
        pageSize: 1000,
      })
    } catch (error: any) {
      Message.error(error?.message || '加载商品列表失败')
    } finally {
      productLoading.value = false
    }
  }
```

（`status__eq: 1` 域侧无对应列 ⇒ shim 忽略它，但调用点保留——将来域侧加了上下架再加映射，
比现在删掉更好找。）

- [ ] **Step 4: 跑裁剪后的 `useAfterSalesData` 测试**

`src/composables/useAfterSalesData.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { employee_info, product_archive, store_info } from '@/shims/wuji-data'
import { useAfterSalesData } from './useAfterSalesData'

vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  product_archive: { query: vi.fn() },
}))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const storeQuery = vi.mocked(store_info.query)
const empQuery = vi.mocked(employee_info.query)
const productQuery = vi.mocked(product_archive.query)

beforeEach(() => {
  storeQuery.mockReset().mockResolvedValue([{ id: 3, store_name: '城东店', store_number: '3', is_enabled: '1' }])
  empQuery.mockReset().mockResolvedValue([
    { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3', status: '通过', _ctime: '', _mtime: '' },
  ])
  productQuery.mockReset().mockResolvedValue([{ id: 4, product_name: '螺栓', basic_quantity: 10, basic_unit_price_minor: 500 }])
})

describe('useAfterSalesData（M3b-2 裁剪后）', () => {
  it('loadEmployeeStores：按**我的登记**取门店（不是全量）', async () => {
    const d = useAfterSalesData()
    await d.loadEmployeeStores()
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ id__eq: 3 }] } })
    expect(d.storeList.value.map((s: { store_name: string }) => s.store_name)).toEqual(['城东店'])
  })

  it('loadEmployeeStores：没登记门店 ⇒ 空列表，且**不**发门店请求（不发等于不泄露全量）', async () => {
    empQuery.mockResolvedValue([
      { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '', status: '通过', _ctime: '', _mtime: '' },
    ])
    const d = useAfterSalesData()
    await d.loadEmployeeStores()
    expect(d.storeList.value).toEqual([])
    expect(storeQuery).not.toHaveBeenCalled()
  })

  it('loadProducts：搜索词只发**一次** query（域侧没有商品编码那一路）', async () => {
    const d = useAfterSalesData()
    await d.loadProducts('螺栓')
    expect(productQuery).toHaveBeenCalledTimes(1)
    expect(productQuery).toHaveBeenCalledWith({ filter: { status__eq: 1, product_name__contains: '螺栓' }, sort: 'product_name', pageSize: 1000 })
  })

  it('裁剪面的负例：不再暴露 loadOrders / orderList / currentUser（订单选择不做）', () => {
    const d = useAfterSalesData() as unknown as Record<string, unknown>
    expect(d.loadOrders).toBeUndefined()
    expect(d.orderList).toBeUndefined()
  })
})
```

Run: `cd modules/aftersales/mobile && pnpm vitest run src/composables/useAfterSalesData.test.ts`
Expected: FAIL → 实现后 PASS（4 条）。

- [ ] **Step 5: 适配 `useFileUpload.ts`**

搬 `wuji-2/src/composables/useFileUpload.ts`。改动**只有**「返回值怎么用」这一处，因为
`wuji-upload` shim 回的**不是** url（见 Task 5 的实现注释）：

`IAttachment` 形状变成：

```ts
export interface IAttachment {
  type: 'image' | 'video'
  /** 本地预览（`URL.createObjectURL(file)`）——提交前展示用；提交后即可 revoke */
  previewUrl: string
  /** 服务端预签名时给的行 id：提交工单时作为 `attachmentIds` 认领（spec §2.3） */
  attachmentId: number | null
  name: string
  size: number
  originalName: string
  index: number
  uploadStatus: 'uploading' | 'completed' | 'failed'
  uploadProgress: number
}
```

上传那一段（源侧取 `result.data?.url` / `result.url` 的三分支）替换成：

```ts
      const result = await uploadFn(file as File, uniqueFilePath)
      attachmentId = result.id
```

并把占位对象里的 `url` 改名为 `previewUrl`（占位时就是 `URL.createObjectURL(file)`，
源侧已经有这一步）、上传成功后**不再** `URL.revokeObjectURL`（预览还要用），
改到 `removeAttachment` 里 revoke。

`removeAttachment` 在源侧注释里说「wuji-upload 没有 deleteFile」⇒ 保持**只删本地**，
但要把 `URL.revokeObjectURL(a.previewUrl)` 补上（源侧没有，因为它的 url 是远端地址）。

- [ ] **Step 6: 写 `useFileUpload` 的测试**

`src/composables/useFileUpload.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadImage } from '@/shims/wuji-upload'
import { useFileUpload } from './useFileUpload'

vi.mock('@/shims/wuji-upload', () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const up = vi.mocked(uploadImage)

beforeEach(() => {
  up.mockReset().mockResolvedValue({ id: 42, objectKey: 'k' })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:local-preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('useFileUpload', () => {
  it('成功后：previewUrl 是本地 blob、attachmentId 是服务端给的 id', async () => {
    const f = useFileUpload({ attachments: { value: [] } } as never)
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    const a = (f.attachments as { value: any[] }).value[0]
    expect(a).toMatchObject({ type: 'image', previewUrl: 'blob:local-preview', attachmentId: 42, uploadStatus: 'completed' })
  })

  it('失败：标记 failed 且上抛（不留下一个「看起来成了」的附件）', async () => {
    up.mockRejectedValue(new Error('boom'))
    const f = useFileUpload({ attachments: { value: [] } } as never)
    await expect(f.addAttachment(new File([], 'a.jpg', { type: 'image/jpeg' }))).rejects.toThrow('boom')
    expect((f.attachments as { value: any[] }).value[0].uploadStatus).toBe('failed')
  })

  it('removeAttachment：同时 revoke 本地预览 URL（源侧没有这一步，因为它的 url 是远端地址）', async () => {
    const f = useFileUpload({ attachments: { value: [] } } as never)
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    f.removeAttachment(0)
    expect((f.attachments as { value: any[] }).value).toEqual([])
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
  })
})
```

> **`useFileUpload` 的签名以源文件为准**：先读
> `wuji-2/src/composables/useFileUpload.ts` 的导出函数签名与它返回的字段名，测试按**同一个签名**
> 构造。上面假定的是源侧的无参形式（它自建 `attachments` ref，由 `useAfterSalesWorkOrder`
> 转出去给页面）——若实读不同，改**测试的构造方式**，不要改 composable 的对外签名
> （页面的解构清单是契约）。

Run: `cd modules/aftersales/mobile && pnpm vitest run src/composables/useFileUpload.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 7: 改写 `useWorkOrderSubmit.ts` + `clientRequestId` 轮换**

搬 `wuji-2/src/composables/useWorkOrderSubmit.ts`，做**三处**改动：

1. **整段删除 `generateOrderNumber()`**（`:18-28`）。它走 `after_sales_work_order.count(...)`
   按前缀数单——域侧工单号由服务端生成（`AS-00000001`，spec §2.2 ③），前端数单是第二份编号源。
2. **payload 换成域侧 6 键**，并**删掉金额计算**（`damageAmount` / `damage_images` 的拼装
   改为传 attachments）：

```ts
  /**
   * 提交工单。域侧 `POST /guest/tickets` 只收 6 个字段（spec §2.2），
   * **工单号与金额都由服务端出**——源侧在这里算 `damage_amount` 并拼 23 键 payload，
   * 按 spec §0.3 那是要消灭的「前端算金额」（服务端会按规则快照单价，前端算的会被覆盖，
   * 留着只是第二份公式）。
   */
  const submitWorkOrder = async (): Promise<boolean> => {
    const store = selectedStore.value
    const product = selectedProduct.value
    if (!product) {
      Message.warning('请选择商品')
      return false
    }
    submitting.value = true
    try {
      const res = await after_sales_work_order.create({
        product_id: product.id,
        store_selection: store?.id,
        damage_quantity: formData.value.damage_quantity,
        damage_reason: formData.value.damage_reason,
        // 只带**已完成**的附件；上传中的带上会被服务端按 id 认领但对象可能还没落
        damage_images: attachments.value.filter((a) => a.uploadStatus === 'completed'),
      })
      // ⚠️ 语义③：**成功后必须轮换幂等键**。不轮换的症状是——同一会话提交第二笔时服务端
      //    按幂等键判重、静默返回第一笔（`duplicated: true`），而前端显示「提交成功」：
      //    用户以为提交了新工单，落库的却是旧的那笔（spec §3.2）。
      //    `duplicated: true` 也算成功（这一笔确实已落库），故一并轮换。
      rotateClientRequestId()
      return true
    } catch (error: any) {
      // 源侧那段 'Failed to resolve module specifier' 的特判是**无极宿主的**动态 import 失败，
      // 平台没有这条宿主路径 ⇒ 删掉，不要带着一段永不触发的死代码。
      Message.error(error?.message || '工单提交失败')
      return false
    } finally {
      submitting.value = false
    }
  }
```

3. 源侧返回 `true` 后由页面弹提示并 `router.back()`——**保持不变**（页面在 Task 8 适配）。

`src/composables/clientRequestId.test.ts`（把三条语义钉在**提交这一侧**，与 Task 5 的
shim 单测互补）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { after_sales_work_order } from '@/shims/wuji-data'
import { currentClientRequestId } from '@/shims/client-request-id'
import { useWorkOrderSubmit } from './useWorkOrderSubmit'

vi.mock('@/shims/wuji-data', () => ({ after_sales_work_order: { create: vi.fn() } }))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const create = vi.mocked(after_sales_work_order.create)

beforeEach(() => {
  sessionStorage.clear()
  create.mockReset().mockResolvedValue({ id: 1, duplicated: false })
})

it('提交成功 ⇒ 幂等键被轮换（下一笔是新键，不会被判重）', async () => {
  const ctx = useWorkOrderSubmit({ selectedProduct: { value: { id: 4 } }, selectedStore: { value: null }, formData: { value: { damage_quantity: 1, damage_reason: '' } }, attachments: { value: [] } } as never)
  await ctx.submitWorkOrder()
  expect(create).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('aftersales.clientRequestId')).toBeNull()
  expect(currentClientRequestId()).not.toBe('')
})

it('提交失败 ⇒ **不**轮换（同一笔重试仍用同键，幂等才成立）', async () => {
  create.mockRejectedValue(new Error('boom'))
  const ctx = useWorkOrderSubmit({ selectedProduct: { value: { id: 4 } }, selectedStore: { value: null }, formData: { value: { damage_quantity: 1, damage_reason: '' } }, attachments: { value: [] } } as never)
  const key = currentClientRequestId()
  await ctx.submitWorkOrder()
  expect(sessionStorage.getItem('aftersales.clientRequestId')).toBe(key)
})
```

> **`useWorkOrderSubmit` 的签名同样以源文件为准**（`wuji-2/src/composables/useWorkOrderSubmit.ts`）。
> 上面两段测试**只约束行为与字段名**，不约束形参形状：
> ① 成功 ⇒ 幂等键被轮换；② 失败 ⇒ 不轮换（同键重试才幂等）；
> ③ `create` 收到的 payload 只含域侧那 6 个键。按源侧实际签名把这些断言接上去即可。

- [ ] **Step 8: 搬聚合器 `useAfterSalesWorkOrder.ts`**

逐字搬，但把聚合面里已裁掉的符号去掉（`orderList` / `selectedOrder` / `loadOrders` /
`loadUserStores`），并补上 `selectedProduct` 的来源（源侧它来自 `useAfterSalesData`）。

Run: `cd modules/aftersales/mobile && pnpm test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add modules/aftersales/mobile/src/composables modules/aftersales/mobile/src/types
git commit -m "feat(aftersales): M3b-2 提交页数据层——裁订单面 + 预签名附件 + 幂等键轮换 (#83)"
```

---

### Task 8: 提交页模板（订单块 → 商品块 + 闸门 + 摘除 OAuth）

**Files:**
- Modify: `modules/aftersales/mobile/src/pages/afterSalesWorkOrderSubmit.vue`（占位换实体）
- Create: `modules/aftersales/mobile/src/pages/afterSalesWorkOrderSubmit.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `useAfterSalesWorkOrder()`、Task 5 的 `Message` / `Confirm` / `employee_info`。
- Produces: 组件默认导出；未登记时跳到路由 `register`。

- [ ] **Step 1: 搬页面并做这五处改动**

搬 `wuji-2/src/pages/afterSalesWorkOrderSubmit.vue`（955 行）。**只做这五处**：

1. **闸门**：`onMounted` 里先查 `employee_info.query({filter:{openId__eq:''}})`；为空
   （未登记）⇒ `Message.warning('请先完成员工登记')` + `router.replace({name:'register'})`，
   **并且不发后续的商品/门店请求**（未登记的人不该看到可选门店）。
2. **订单选择整块换成商品选择**：删掉模板里 `selectedOrder` 的 `<t-select>`（约 `:79` 一带）
   与 `arrivalDate`/`arrivalTime` 里依赖 `currentOrder` 的部分；商品选择保留
   `v-model="selectedProduct"`（`:18` 已有）。报损数量上界改取**商品的**基本数量：
   `handleDamageQuantityBlur` 里的 `currentOrder.basic_quantity` → `selectedProduct.value?.basic_quantity`。
3. **删掉 `currentOrder`（`:503-505`）** 及其全部引用；删掉 `arrival_time` 相关的
   `formData` 写入与两个 computed（`:525-545`）——域侧 `SubmitBody` 不收到货时间。
   **`IWorkOrderFormData` 相应收缩成 `{product_id, damage_quantity, damage_reason}`**。
4. **摘除页内前端微信 OAuth**（约 `:766-816`：`wechat_openid.request`、`localStorage`、
   `window.w.global.appid`、手拼的授权 URL），以及 `defineWujiPageMeta` 之外的宿主全局引用。
5. **提交成功后的提示与返回保持源侧形状**（`Message.success({content, duration, onClose: () => router.back()})`，
   `:746-752`）——`onClose` 由 Task 5 的 shim 保证会被调用。

其余（`formData.damage_reason`、附件网格、`Confirm` 的用法、Tailwind 类、Font Awesome 图标）
**逐字保留**。

- [ ] **Step 2: 写组件测试**

`src/pages/afterSalesWorkOrderSubmit.test.ts`：

```ts
// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TDesign from 'tdesign-vue-next'

const replace = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ replace, back }), useRoute: () => ({ query: {} }) }))

const empQuery = vi.fn()
vi.mock('@/shims/wuji-data', () => ({
  employee_info: { query: (...a: unknown[]) => empQuery(...a) },
  store_info: { query: vi.fn().mockResolvedValue([]) },
  product_archive: { query: vi.fn().mockResolvedValue([]) },
  after_sales_work_order: { create: vi.fn().mockResolvedValue({ id: 1 }) },
}))
const success = vi.fn()
vi.mock('@wujibase/wuji', () => ({
  Message: { success, warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(() => ({ hide: vi.fn() })),
}))

import Submit from './afterSalesWorkOrderSubmit.vue'

beforeEach(() => {
  replace.mockClear(); back.mockClear(); success.mockClear(); empQuery.mockReset()
  ;(globalThis as unknown as { defineWujiPageMeta?: unknown }).defineWujiPageMeta = vi.fn()
})

describe('afterSalesWorkOrderSubmit 页面', () => {
  it('未登记 ⇒ 跳登记页，且不发门店/商品请求（闸门）', async () => {
    empQuery.mockResolvedValue([])
    mount(Submit, { global: { plugins: [TDesign] } })
    await flushPromises()
    expect(replace).toHaveBeenCalledWith({ name: 'register' })
  })

  it('已登记 ⇒ 不跳转', async () => {
    empQuery.mockResolvedValue([{ id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3', status: '通过', _ctime: '', _mtime: '' }])
    mount(Submit, { global: { plugins: [TDesign] } })
    await flushPromises()
    expect(replace).not.toHaveBeenCalled()
  })

  it('源码里没有订单选择 / 前端 OAuth 残留', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./afterSalesWorkOrderSubmit.vue', import.meta.url), 'utf8')
    expect(src).not.toContain('open.weixin.qq.com')
    expect(src).not.toContain('wechat_openid')
    expect(src).not.toContain('window.w')
    expect(src).not.toContain('outbound_detail')
    expect(src).not.toContain('generateOrderNumber')
    expect(src).not.toContain('currentOrder')
  })
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `cd modules/aftersales/mobile && pnpm vitest run src/pages/afterSalesWorkOrderSubmit.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 4: 全包门禁 + 构建**

Run: `cd modules/aftersales/mobile && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS；`dist/index.html` 存在且引用 `/app/aftersales/assets/*`。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/mobile/src/pages
git commit -m "feat(aftersales): M3b-2 提交页模板——订单块换商品块 + 登记闸门 + 摘除 OAuth (#83)"
```

---

## Wave 5

### Task 9: 收口（smoke 机检 + CI 构建 + 全量门禁）

**Files:**
- Modify: `scripts/smoke-load.mjs`
- Modify: `.github/workflows/ci.yml`（smoke job）
- Modify: `README.md`（已知边界一句）

**Interfaces:**
- Consumes: Task 4 的 `@aftersales/mobile` 包名与 manifest 的 `mount: /app/aftersales`。
- Produces: `smoke-load` 新增一组 H6 断言；CI 的 smoke job 在跑冒烟前构建移动端。

- [ ] **Step 1: 写 smoke 断言**

在 `scripts/smoke-load.mjs` 的 `assertStaticServing` 之后加一个函数，并在 `runMulti` 里
`assertStaticServing(b)` 之后调用它：

```js
/** 移动端 userApp 的挂载点（manifest 的 frontend.userApp.mount；改这里也要改那儿） */
const MOBILE_MOUNT = '/app/aftersales'
const MOBILE_DIST = path.join(repoRoot, 'modules', 'aftersales', 'mobile', 'dist')

/**
 * H6：userApp 静态**真的挂上了**（M3b-2；spec §3.2 的两条机检）。
 *
 * 为什么必须有这一条：`loader.ts` 的 `if (!existsSync(dist)) continue` 是**静默跳过** ——
 * 「构建没跑」表现为「API 照常、移动端 404」，整条流水线全绿。这正是本仓反复批的
 * 「静默失败 = 绿」，所以它必须在**真进程 + 真 HTTP** 这层被钉住。
 *
 * 三条断言各自防一件事：
 *   ① 入口回 SPA 壳而不是 404  → 防「没构建 / 路径写错」被静默跳过；
 *   ② 深链也回**移动端的**壳   → 防 loader 缺 SPA 兜底时被 app.ts 的全局兜底吞成 console 壳；
 *   ③ 产物引用带挂载点前缀     → 防 vite 的 base 没设，assets 与 console 的撞车。
 * @param {PhaseBase} b
 */
async function assertUserAppServing(b) {
  step('H6 移动端 userApp：入口与深链都回 SPA 壳，产物引用带挂载点前缀')
  check(
    existsSync(path.join(MOBILE_DIST, 'index.html')),
    `移动端构建产物存在：${path.relative(repoRoot, MOBILE_DIST)}（先跑 pnpm --filter @aftersales/mobile build）`,
  )

  const shell = readFileSync(path.join(MOBILE_DIST, 'index.html'))
  const webShell = readFileSync(path.join(webDistDir, 'index.html'))

  for (const p of [`${MOBILE_MOUNT}/`, MOBILE_MOUNT, `${MOBILE_MOUNT}/register`]) {
    const res = await b.get(p)
    check(res.status === 200, `GET ${p} 200`, describe(res))
    check(
      res.body.equals(shell),
      `GET ${p} 回的是**移动端**的 SPA 壳（不是 console 的、也不是 404）`,
      describe(res, { equalsWebShell: res.body.equals(webShell), bytes: res.body.length }),
    )
    check(
      String(res.headers['content-type'] ?? '').includes('text/html'),
      `GET ${p} content-type 是 html（实际 ${res.headers['content-type'] ?? '(空)'}）`,
      describe(res),
    )
  }

  // 产物路径前缀：index.html 里引的 assets 必须是挂载点前缀（vite 的 base 生效）
  const html = shell.toString('utf8')
  check(
    !/["'(]\/assets\//.test(html),
    'index.html 里**没有**裸 /assets/ 引用（有 ⇒ vite base 没设，会与 console 的产物撞路径）',
    html.slice(0, 800),
  )
  check(
    new RegExp(`["'(]${MOBILE_MOUNT}/assets/`).test(html),
    `index.html 里的产物引用带 ${MOBILE_MOUNT}/ 前缀`,
    html.slice(0, 800),
  )

  // 负例对照：不存在的子路径不该被两套壳中的任何一套假装成"有内容"
  const missing = await b.get(`${MOBILE_MOUNT}/definitely-not-a-real-asset.js`)
  check(
    missing.body.equals(shell),
    '深链落到 SPA 壳（同上，负例：非产物路径不吐别的东西）',
    describe(missing),
  )
}
```

在 `runMulti` 里紧接 `assertStaticServing(b)` 之后加一行：

```js
  await assertUserAppServing(b)
```

- [ ] **Step 2: 本地跑冒烟确认通过**

```bash
pnpm --filter @platform/web build && pnpm --filter @aftersales/mobile build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/smoke-load.mjs
```
Expected: H6 全部 ✓。

- [ ] **Step 3: 反证（**必须做**，否则不知道断言是否真的在拦）**

临时把 `modules/aftersales/mobile/dist` 改名，重跑冒烟：
Expected: H6 **红**，且报错文案指向「移动端构建产物存在：…（先跑 …）」。

改回来后，再把 `manifest.yaml` 的 `userApp.mount` 改成 `/app/aftersalesX` 跑一次：
Expected: H6 红在 `GET /app/aftersales/ 200`（因为挂载点对不上 ⇒ 落到全局兜底 ⇒ 拿到 console 壳
或 404）。两次反证都还原。

> 这一步是**验证「验证本身」**：一条从没红过的断言，不能证明它守得住任何东西。

- [ ] **Step 4: CI 补移动端构建**

`.github/workflows/ci.yml` 的 `smoke` job 里，把构建那一行改成两条（位置在 `run smoke` 之前）：

```yaml
      # 先构建 web：冒烟要断言 GET /assets/<hash>.<js|css> 返回的是构建产物本体…
      - run: pnpm --filter @platform/web build
      # 再构建移动端（M3b-2）：H6 要断言 userApp 挂载点回的是移动端壳本体，
      # 而 loader 在 dist 不存在时**静默跳过挂载** ⇒ 不构建就等于让 H6 永远没得断。
      - run: pnpm --filter @aftersales/mobile build
      - run: pnpm exec tsx scripts/smoke-load.mjs
```

同时确认 `gates` job 的 `pnpm typecheck` 会扫到新包（`pnpm -r --if-present typecheck` 靠
workspace glob，Task 4 已加 `modules/*/*`），以及 `unit` job 的 `pnpm test` 会跑到
`@aftersales/mobile` 的 `test`。

- [ ] **Step 5: README 记已知边界**

在 `README.md` 的已知边界/注意事项一节追加两条（**照实写，别粉饰**）：

```markdown
- **移动端（`modules/aftersales/mobile`）tsconfig 是 `strict: false`**：整包搬自 `wuji-2`
  （源工程即 `strict: false`），按 strict 走会一次爆出成百条改写，属另一个任务的范围。
  **这是一次显式声明的弱化**，收紧是 M3b-2 之后的跟进项。
- **移动端的端到端本地验不了**（spec §5 #13）：`MockCasdoor` 只做 Casdoor、**不做公众号 OAuth**
  ⇒ 本地拿不到**访客 session**。本地覆盖到 shim 单测 + 组件测试 + 装载冒烟（H6）；
  「真壳 + 真访客」这一段**只在试点客户机上验**。**别把「本地全绿」读成「端到端验过」。**
```

- [ ] **Step 6: 全量门禁（波末，跑**全部** CI 命令）**

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @platform/web build
pnpm --filter @aftersales/mobile build
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
bash scripts/check-dev-discipline.sh origin/main HEAD
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/smoke-load.mjs
```
Expected: 全绿。**`pnpm install --frozen-lockfile` 必须能过**——Task 4 改了
`pnpm-workspace.yaml` 与依赖，lockfile 必须已提交（否则 CI 第一步就红）。

- [ ] **Step 7: 容器构建链验证（Docker 里 mobile 真的会被构建）**

```bash
docker build -f deploy/Dockerfile.server -t platform-core-server:m3b2 .
```
Expected: 构建成功；且用 `docker run --rm platform-core-server:m3b2 ls modules/aftersales/mobile/dist`
能看到 `index.html`。

> 这条是 I3 的**最终证据**：`pnpm -r --if-present build` 在镜像里真的把移动端构建了。
> 宿主构建链这一层没有别的等价机检（`.dockerignore` 排除了宿主 `**/dist`，镜像里的 dist
> **只能**来自构建阶段）。

- [ ] **Step 8: 提交 + 开 PR**

```bash
git add scripts/smoke-load.mjs .github/workflows/ci.yml README.md
git commit -m "test(aftersales): M3b-2 收口——userApp 挂载冒烟 H6 + CI 构建移动端 (#83)"
git push -u origin feat/aftersales-m3b2-mobile
gh pr create --fill --base main
```

PR body 必须包含 `Closes #83`，并**照实**写明：
① 本期不是纯模块内（含 loader / auth-wechat-oa / workspace glob / CI 四处宿主面改动）；
② 提交页是**改造**不是直搬（订单驱动 → 商品驱动，源侧 23 键 payload → 域侧 6 键）；
③ 端到端本地验不了，留试点（spec §5 #13）。

- [ ] **Step 9: 合并只等 CI CLEAN**

CI 全绿（`unit` / `gates` / `web` / `smoke` / `discipline` 全过）才 squash 合并。
UNSTABLE 状态**不许强合**（本仓有过 UNSTABLE 强合出生产 502 的先例）。
合并 main = 自动部署（adopt runbook §7）。

- [ ] **Step 10: 部署后验证（按 `~/.claude/rules/common/deploy-verify.md`）**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://deploy.hookflow.cn/healthz          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' https://<生产域>/app/aftersales/            # 期望 200
curl -s https://<生产域>/app/aftersales/ | grep -o '/app/aftersales/assets/[^"]*' | head -2   # 期望有输出
curl -s -o /dev/null -w '%{http_code}\n' 'https://<生产域>/api/modules/aftersales/guest/stores'  # 期望 401（要凭据），不是 404
```

再加一条**行为**验证（比时间戳硬）：`/app/aftersales/register` 深链回的是**移动端**的壳
（体里应有 `<div id="app">` 与 `/app/aftersales/assets/` 前缀），不是 console 的壳。
```
