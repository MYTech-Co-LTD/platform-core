# 售后模块 M3b-1（员工登记与审批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把移动端的「加盟商登记/变更 → 管理端审批 → 写回员工档案」这条链在后端与 console 上补齐，使 M3b-2 的移动端 shim 有端点可映射。

**Architecture:** 新表 `employee_approval`（申请）+ `employee_store`（员工↔门店多对多）落在模块自己的 `aftersales` schema；路由沿用 `registerXxx(r, ctx)` 范式，**访客面与管理面分文件**（照 `ticket-guest.ts` / `ticket-manage.ts` 的先例）；**路由与 manifest 声明必须原子**（装载期双向核对：注册了没声明 = 模块装载失败）。

**Tech Stack:** Hono + pg（参数化 SQL）+ zod；测试为 **真 PG**（与既有 `routes/*.test.ts` 同栈）；console 页 React + antd 6。

## Global Constraints

以下逐字取自 spec §2.5 与 AGENTS.md，每个任务的要求都隐含包含本节。

- **三条实现纪律（spec §2.5）**：
  1. **防重由库保证**：`unique(org, open_id) where status='pending'`（部分唯一索引）——源里那句「您已有待审批的申请」是提交前查一次的前端判定，并发下会漏。
  2. **差异计算放服务端**：客户端只表达「我要变成什么」（目标值），`old_info`/`new_info` 由服务端算。
  3. **审批通过单事务写回**：申请记录的 `status`/`decided_*` 与 `employee`（+ `employee_store`）的写入**同一事务**。
- **租户隔离（spec-1 §2 / AGENTS.md #11 相关门禁）**：新表一律带 `org text not null`；读写一律 `where org = $1`；唯一索引含 org；热路径索引以 org 为前缀列。
- **大整数上界按列型分档**（M2a I-1 的教训）：`bigint` 列用 `.safe()`；`integer` 列用 `.max(2_147_483_647)`。
- **路径 id 一律走 `parseIdParam`**（`routes/context.ts`，全仓唯一一份）——**不写内联守卫**。
- **分页参数一律走 `parsePageParam`**（同址），不要自己 `Number()`。
- **契约与行为**：`M3a 的 POST /employees/:id/approve 保持不动`（加而不改）。
- **门禁**：`pnpm typecheck` / `pnpm test` / `pnpm --filter @platform/web build` / 四道守卫脚本 / `smoke-load` 全绿。
- **迁移纪律**：`migrations/*.sql` 按文件名排序执行、**每个文件一个事务**、**必须幂等**（`if not exists` 一类的写法）；文件名 `002_…`。

## 波次划分（派发用）

| 波 | 任务 | 并行性 |
|---|---|---|
| **Wave 1** | Task 1 迁移 → Task 2 域内核 → Task 3 访客面路由 → Task 4 管理面路由 | **串行**。T2 依赖 T1 的表；T3/T4 都改 `manifest.yaml`（且**声明必须与路由原子**，见下），故不可并行 |
| **Wave 2** | Task 5 console「申请审批」页签 | 依赖 T4 的管理面端点 |
| **Wave 3** | Task 6 收口 | 串行（波末全量门禁 + 端到端） |

> **这一期基本是串行链**（迁移 → 内核 → 路由 → UI），这是任务间**真实的数据依赖**决定的，不是派发方式保守。
> T3 与 T4 本可并行，但**两者都要改 `manifest.yaml`**，而「注册了没声明 = 装载失败」是硬约束
> ⇒ 拆成两个提交但必须串行，避免半声明状态下装载失败。

## 文件结构

```
modules/aftersales/
  migrations/002_employee_registration.sql   新：employee_approval + employee_store 两张表
  domain/registration.ts                     新：登记/变更的纯函数内核（diff + 校验）
  domain/registration.test.ts                新
  api-types.ts                               改：登记相关的服务端/console 共用类型
  routes/registration-guest.ts               新：访客面 3 个端点
  routes/registration-guest.test.ts          新（真 PG）
  routes/registration-manage.ts              新：管理面 2 个端点 + 单事务写回
  routes/registration-manage.test.ts         新（真 PG）
  routes/context.ts                          不动（parseIdParam / parsePageParam 复用）
  index.ts                                   改：接线两个 registerXxx
  manifest.yaml                              改：5 条新声明（**与路由同任务原子**）
  console/index.tsx                          改：加第 6 个页签
  console/approvals/index.tsx                新：申请审批页
  console/approvals/index.test.tsx           新
apps/web/src/console-registry.gen.ts         改：build 时重生成（进 git）
```

---

## Wave 1

### Task 1: 迁移 `002_employee_registration.sql`（两张新表）

**Files:**
- Create: `modules/aftersales/migrations/002_employee_registration.sql`

**Interfaces:**
- Produces: 表 `aftersales.employee_approval`、`aftersales.employee_store`（列定义见下）

- [ ] **Step 1: 写迁移**

```sql
-- 002_employee_registration.sql — M3b-1（spec §2.5）：员工登记/变更申请 + 员工↔门店多对多。
--
-- 幂等：本执行器按文件名记账、每个文件一个事务，但**部署脚本可能全量重跑** ⇒ 一律
-- `if not exists`（本仓迁移纪律）。
--
-- 两张表都是【租户数据表】：带 org text not null、唯一索引含 org、热路径索引以 org 为前缀列
-- （spec-1 §2 的三条纪律；门禁见 scripts/check-tenant-isolation.mjs）。

create schema if not exists aftersales;

-- ── 登记/变更申请 ────────────────────────────────────────────────────────────
-- 对应源侧 employee_info_approve（spec §2.1）。**不照搬**源的两个嵌套字段：源把 old/new 塞进
-- 一个 approveinfo 里（spec §0.1 记为「全区唯一的嵌套突破扁平」），这里显式两列 jsonb。
create table if not exists aftersales.employee_approval (
  id           bigserial primary key,
  org          text not null,
  -- 申请人身份锚（访客 session 的 identity.userId = openid）
  open_id      text not null,
  -- 注册 vs 变更：定死英文枚举（源侧中文「注册/变更」是展示层的事，spec §5 #9）
  approve_type text not null check (approve_type in ('register', 'change')),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  -- 服务端算出的差异（spec §2.5 纪律②）：变更时只含**实际变了的字段**
  old_info     jsonb not null default '{}'::jsonb,
  new_info     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text
);

-- ★ 防重**由库保证**（spec §2.5 纪律①）：同一个人的待审申请同时只能有一条。
-- 源侧那句「您已有待审批的申请」是提交前查一次的前端判定 —— 两个并发的提交请求都能查到 0 条
-- ⇒ 都插入 ⇒ 两条待审。部分唯一索引把这件事变成数据库层面的不可能，且**只约束 pending**
-- （已决的历史申请可以有多条，不受影响）。
create unique index if not exists aftersales_employee_approval_pending_idx
  on aftersales.employee_approval(org, open_id)
  where status = 'pending';

-- 管理端列表的热路径：where org = $1 [and status = $2] order by id desc ⇒ org 前缀列
create index if not exists aftersales_employee_approval_org_status_idx
  on aftersales.employee_approval(org, status, id desc);

-- ── 员工↔门店多对多 ──────────────────────────────────────────────────────────
-- 源侧 employee_info.store_info 是**逗号分隔的多门店串**（多选），而 employee.store_id 是单值 FK
-- ⇒ 规范化为关联表；employee.store_id 保留为「主门店」（可空），不改 M2a 已上线的列语义。
-- M2b 迁移时把串拆成行、并挑一个作主门店。
create table if not exists aftersales.employee_store (
  id          bigserial primary key,
  org         text not null,
  -- 员工被删则关联同删（on delete cascade）——关联行离开员工没有意义
  employee_id bigint not null references aftersales.employee(id) on delete cascade,
  store_id    bigint not null references aftersales.store(id)
);

-- 同一员工对同一门店只关联一次；org 在列里，兼作「按 org 查我的门店」的索引前缀
create unique index if not exists aftersales_employee_store_org_emp_store_idx
  on aftersales.employee_store(org, employee_id, store_id);
```

- [ ] **Step 2: 跑迁移并确认幂等**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
# 经模块装载器应用（与生产同路径）：smoke-load 会启动宿主、装载模块、跑 migrations
pnpm exec tsx scripts/smoke-load.mjs
```
Expected: `smoke-load: OK（multi + single 双形态全通过）`

- [ ] **Step 3: 验两张表真的建了、且**幂等重跑不报错**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
psql "$DATABASE_URL" -Atc "select to_regclass('aftersales.employee_approval') || ' / ' || to_regclass('aftersales.employee_store')"
# 幂等：再跑一次装载（记账表去重 ⇒ 不重复执行；即使重放 DDL 也不该报错）
pnpm exec tsx scripts/smoke-load.mjs
```
Expected: 两个 `to_regclass` 都非空；第二次 smoke-load 仍 OK。

- [ ] **Step 4: 验部分唯一索引真的只约束 pending**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 <<'SQL'
begin;
insert into aftersales.employee_approval(org, open_id, approve_type) values ('plan-check','o1','register');
-- 第二条 pending 应当**违反唯一索引**
insert into aftersales.employee_approval(org, open_id, approve_type) values ('plan-check','o1','change');
rollback;
SQL
```
Expected: 第一条 `INSERT 0 1`；第二条报 **`duplicate key value violates unique constraint "aftersales_employee_approval_pending_idx"`**。
（整个事务 rollback，不留数据。）

- [ ] **Step 5: 跑租户隔离门禁**（若该门禁已在 main；不在则跳过并在报告里记一句）

```bash
pnpm exec tsx scripts/check-tenant-isolation.mjs
```
Expected: `check-tenant-isolation: OK`（两张新表都有 `org`）。

- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/migrations/002_employee_registration.sql
git commit -m "feat(aftersales): M3b-1 迁移——登记申请表 + 员工门店关联表（防重靠部分唯一索引）(#81)"
```

---

### Task 2: 域内核 `domain/registration.ts`（纯函数）

**为什么单独一层**：照 `domain/ticket.ts` 的先例——**业务内核是纯函数、可单测**，路由只负责 IO 与事务。
spec §2.5 纪律②（差异由服务端算）就落在这一层。

**Files:**
- Create: `modules/aftersales/domain/registration.ts`
- Create: `modules/aftersales/domain/registration.test.ts`

**Interfaces:**
- Produces:
  - `interface RegistrationTarget { name: string; phone: string; storeIds: number[] }`
  - `interface EmployeeSnapshot { name: string; phone: string; storeIds: number[] }`
  - `class RegistrationError extends Error`
  - `computeRegistration(current: EmployeeSnapshot | null, target: RegistrationTarget): { approveType: 'register' | 'change'; oldInfo: Partial<RegistrationTarget>; newInfo: Partial<RegistrationTarget> }`
  - `pickPrimaryStoreId(target: RegistrationTarget): number | null`

- [ ] **Step 1: 写失败测试 `domain/registration.test.ts`**

```ts
// domain/registration.test.ts — 登记内核的纯函数测试（无 DB、无 HTTP）
import { describe, expect, it } from 'vitest'
import { RegistrationError, computeRegistration, pickPrimaryStoreId } from './registration'

const target = (over: Partial<{ name: string; phone: string; storeIds: number[] }> = {}) => ({
  name: '张三',
  phone: '13800000000',
  storeIds: [1, 2],
  ...over,
})

describe('computeRegistration', () => {
  it('无当前档案 ⇒ register，old 空、new 含全部目标字段', () => {
    const r = computeRegistration(null, target())
    expect(r.approveType).toBe('register')
    expect(r.oldInfo).toEqual({})
    expect(r.newInfo).toEqual({ name: '张三', phone: '13800000000', storeIds: [1, 2] })
  })

  it('★ 变更：old/new **只含实际变了的字段**（照源侧行为，spec §2.5）', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    const r = computeRegistration(cur, target({ phone: '13900000000' }))
    expect(r.approveType).toBe('change')
    expect(r.oldInfo).toEqual({ phone: '13800000000' })   // name / storeIds 没变 ⇒ 不出现
    expect(r.newInfo).toEqual({ phone: '13900000000' })
  })

  it('门店集合按**无序**比较：同样两个门店换顺序不算变更', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    const r = computeRegistration(cur, target({ storeIds: [2, 1] }))
    // 顺序不同但集合相同 ⇒ 什么都不算变；此时整体无差异 ⇒ 抛「没有修改任何信息」
    expect(() => r).toThrow(RegistrationError)
  })

  it('★ 无任何变更 ⇒ 抛 RegistrationError（源侧「您没有修改任何信息」的服务端落点）', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    expect(() => computeRegistration(cur, target())).toThrow(/没有修改/)
  })

  it('storeIds 归一：去重 + 升序（避免 [1,1,2] 与 [1,2] 被判成不同）', () => {
    const r = computeRegistration(null, target({ storeIds: [2, 1, 2] }))
    expect(r.newInfo.storeIds).toEqual([1, 2])
  })

  it('空门店列表是合法目标（人可以不属于任何门店）', () => {
    const r = computeRegistration(null, target({ storeIds: [] }))
    expect(r.newInfo.storeIds).toEqual([])
  })
})

describe('pickPrimaryStoreId', () => {
  it('取归一后的第一个门店作主门店（只影响 employee.store_id 这个遗留列）', () => {
    expect(pickPrimaryStoreId(target({ storeIds: [5, 3] }))).toBe(3)
  })
  it('无门店 ⇒ null', () => {
    expect(pickPrimaryStoreId(target({ storeIds: [] }))).toBeNull()
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— `Failed to resolve import "./registration"`。

- [ ] **Step 3: 写 `domain/registration.ts`**

```ts
// domain/registration.ts — 员工登记/变更的**纯函数内核**（spec §2.5）。
//
// 为什么差异计算在这一层而不在路由：spec §2.5 纪律②——源侧 `submitApproval` 在**前端**逐字段
// diff 后把 old_info/new_info 传给后端（`wuji-2/src/composables/useStoreEmployeeApproval.ts`），
// 按 §0.3 属「前端式编排」。平台的服务端本就知道当前 employee 行 ⇒ **由这里算**，
// 客户端只表达目标值。纯函数 ⇒ 可单测、无 IO。
//
// 门店用**集合语义**（源侧是多选，存成逗号串后顺序无意义）：比较与输出都先归一（去重 + 升序），
// 否则「[1,2] → [2,1]」会被判成一次变更，产生一条什么都没有改的申请。

/** 客户端表达的目标状态（M3b-2 的移动端表单就提交这个形状） */
export interface RegistrationTarget {
  name: string
  phone: string
  storeIds: number[]
}

/** 当前档案的快照（路由从 employee + employee_store 读出后传进来） */
export interface EmployeeSnapshot {
  name: string
  phone: string
  storeIds: number[]
}

/** 登记/变更域的错误——路由把它翻成 400 + message（与 domain/ticket.ts 的 AmountValidationError 同构） */
export class RegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistrationError'
  }
}

/** 归一门店集合：去重 + 升序。集合语义下顺序无意义，不归一会造出假变更。 */
function normalizeStoreIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * 算登记/变更：返回 `{ approveType, oldInfo, newInfo }`，**两个 info 只含实际变了的字段**
 * （照源侧行为——变更申请只记差异，审批人一眼看到改了什么）。
 *
 * @throws RegistrationError 当前已有档案但**没有任何字段变化**时（源侧「您没有修改任何信息」）
 */
export function computeRegistration(
  current: EmployeeSnapshot | null,
  target: RegistrationTarget,
): { approveType: 'register' | 'change'; oldInfo: Partial<RegistrationTarget>; newInfo: Partial<RegistrationTarget> } {
  const next = {
    name: target.name,
    phone: target.phone,
    storeIds: normalizeStoreIds(target.storeIds),
  }

  // 无档案 ⇒ 注册：old 空、new 是全部目标字段
  if (current === null) {
    return { approveType: 'register', oldInfo: {}, newInfo: next }
  }

  const prev = {
    name: current.name,
    phone: current.phone,
    storeIds: normalizeStoreIds(current.storeIds),
  }

  const oldInfo: Partial<RegistrationTarget> = {}
  const newInfo: Partial<RegistrationTarget> = {}
  if (prev.name !== next.name) {
    oldInfo.name = prev.name
    newInfo.name = next.name
  }
  if (prev.phone !== next.phone) {
    oldInfo.phone = prev.phone
    newInfo.phone = next.phone
  }
  if (!sameIds(prev.storeIds, next.storeIds)) {
    oldInfo.storeIds = prev.storeIds
    newInfo.storeIds = next.storeIds
  }

  if (Object.keys(newInfo).length === 0) {
    throw new RegistrationError('您没有修改任何信息')
  }
  return { approveType: 'change', oldInfo, newInfo }
}

/**
 * 审批通过时写回 `employee.store_id`（「主门店」遗留列）用哪个门店。
 * 取归一后的第一个。**注意这只是遗留列**——「我的门店」以 `employee_store` 为准。
 */
export function pickPrimaryStoreId(target: RegistrationTarget): number | null {
  const ids = normalizeStoreIds(target.storeIds)
  return ids.length > 0 ? ids[0]! : null
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter aftersales test`
Expected: PASS（`|backend| domain/registration.test.ts` 8 条）。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/domain/registration.ts modules/aftersales/domain/registration.test.ts
git commit -m "feat(aftersales): M3b-1 登记内核——差异由服务端算（纯函数 + 单测）(#81)"
```

---

### Task 3: 访客面路由 `routes/registration-guest.ts`（3 个端点）

> ⚠️ **本任务必须同时改 `manifest.yaml`**：装载期双向核对里「注册了没声明 = **模块装载失败**」
> （AGENTS.md #2）。**路由与声明原子**，不要先加路由后补声明。

**Files:**
- Create: `modules/aftersales/routes/registration-guest.ts`
- Create: `modules/aftersales/routes/registration-guest.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（+3 条 `aftersales:guest` 声明）
- Modify: `modules/aftersales/index.ts`（接线）
- Modify: `modules/aftersales/api-types.ts`（+登记相关类型，console 侧共用）

**Interfaces:**
- Consumes: `computeRegistration` / `RegistrationError` / `pickPrimaryStoreId`（Task 2）；`parsePageParam`（`routes/context.ts`）
- Produces:
  - `registerRegistrationGuest(r: ModuleHono, ctx: RouteCtx): void`
  - 响应类型（写进 `api-types.ts`）：`MyRegistration`、`EmployeeApprovalItem`

- [ ] **Step 1: 写失败测试 `routes/registration-guest.test.ts`**

```ts
// routes/registration-guest.test.ts — 访客面登记端点（真 PG，与既有 routes/*.test.ts 同栈）
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { registerRegistrationGuest } from './registration-guest'

const ORG = 'test-m3b1-guest'
const OPENID = 'openid-guest-1'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function app(openid = OPENID) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', { userId: openid, orgId: ORG, displayName: openid, scopes: [], hasScope: () => true })
    await next()
  })
  registerRegistrationGuest(r, { pool, storage: null })
  return r
}

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
  await pool.query(`delete from aftersales.store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.product where org = $1`, [ORG])
}

beforeAll(cleanup)
beforeEach(async () => {
  await cleanup()
  // ⚠️ 门店必须建在 cleanup **之后**：写在 beforeAll 里会被第一个 beforeEach 的 cleanup 删掉，
  //    后续用例拿到空的门店 id 列表 ⇒ 解构出 undefined ⇒ employee_store 的 store_id not-null 报错
  //    （而报错点离真因很远 —— 实施时实测踩到）
  await pool.query(`insert into aftersales.store(org, name, address, phone) values ($1,'店A','',''), ($1,'店B','','')`, [ORG])
})
afterAll(async () => { await cleanup(); await pool.end() })

const storeIds = async (): Promise<number[]> =>
  (await pool.query<{ id: string }>(`select id from aftersales.store where org=$1 order by id`, [ORG])).rows.map((r) => Number(r.id))

const submit = (a: Hono, body: unknown) =>
  a.request('/guest/employee-approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('GET /guest/me/registration', () => {
  it('未登记 ⇒ registration 为 null、hasPendingApproval 为 false', async () => {
    const res = await app().request('/guest/me/registration')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ registration: null, hasPendingApproval: false })
  })

  it('已登记 ⇒ 回档案 + 我的门店（多门店）', async () => {
    const [s1, s2] = await storeIds()
    const emp = await pool.query<{ id: string }>(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status) values ($1,'张三','138','$OPENID','approved') returning id`
        .replace('$OPENID', OPENID),
      [ORG],
    )
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_id) values ($1,$2,$3),($1,$2,$4)`, [ORG, Number(emp.rows[0]!.id), s1, s2])
    const body = (await (await app().request('/guest/me/registration')).json()) as any
    expect(body.registration).toEqual({ name: '张三', phone: '138', storeIds: [s1, s2] })
    expect(body.hasPendingApproval).toBe(false)
  })

  it('★ 只回**自己的**（org + open_id 双向收窄）—— 别人的登记看不见', async () => {
    await pool.query(`insert into aftersales.employee(org, name, phone, open_id, approve_status) values ($1,'别人','','other-openid','approved')`, [ORG])
    const body = (await (await app().request('/guest/me/registration')).json()) as any
    expect(body.registration).toBeNull()
  })
})

describe('POST /guest/employee-approvals', () => {
  it('首次提交 ⇒ 建 register 申请，old 空、new 是目标值', async () => {
    const [s1] = await storeIds()
    const res = await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    expect(res.status).toBe(201)
    const row = (await pool.query(`select approve_type, status, old_info, new_info from aftersales.employee_approval where org=$1`, [ORG])).rows[0] as any
    expect(row.approve_type).toBe('register')
    expect(row.status).toBe('pending')
    expect(row.old_info).toEqual({})
    expect(row.new_info).toEqual({ name: '张三', phone: '138', storeIds: [s1] })
  })

  it('★ 已有待审 ⇒ 409（由**库**的部分唯一索引保证，不是先查后插）', async () => {
    const [s1] = await storeIds()
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })).status).toBe(201)
    const second = await submit(app(), { name: '张三', phone: '139', storeIds: [s1] })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'APPROVAL_PENDING' })
    // 且确实只落了一条
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee_approval where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
  })

  it('体不合法 ⇒ 400 INVALID_BODY', async () => {
    expect((await submit(app(), { name: '', phone: '138', storeIds: [] })).status).toBe(400)
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [-1] })).status).toBe(400)
  })

  it('★ 变更：old/new 只含变了的字段', async () => {
    const [s1] = await storeIds()
    await pool.query(`insert into aftersales.employee(org, name, phone, open_id, approve_status) values ($1,'张三','138','${OPENID}','approved')`, [ORG])
    const res = await submit(app(), { name: '张三', phone: '139', storeIds: [s1] })
    expect(res.status).toBe(201)
    const row = (await pool.query(`select approve_type, old_info, new_info from aftersales.employee_approval where org=$1`, [ORG])).rows[0] as any
    expect(row.approve_type).toBe('change')
    expect(row.old_info).toEqual({ phone: '138' })
    expect(row.new_info).toEqual({ phone: '139' })
  })

  it('★ 变更但什么都没改 ⇒ 400 且 message 是「没有修改」', async () => {
    const [s1] = await storeIds()
    await pool.query(`insert into aftersales.employee(org, name, phone, open_id, approve_status) values ($1,'张三','138','${OPENID}','approved')`, [ORG])
    const res = await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    expect(res.status).toBe(400)
    expect((await res.json() as any).message).toContain('没有修改')
  })

  it('★ 防重索引**按 org 分桶**：另一个 org 的同名 openid 的 pending 不会挡住我', async () => {
    const [s1] = await storeIds()
    // 先在**别的 org** 放一条同 openid 的 pending —— 若唯一索引漏了 org 列，下面这次提交会撞 409
    await pool.query(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ('test-m3b1-other', $1, 'register', '{}'::jsonb)`,
      [OPENID],
    )
    const res = await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    expect(res.status).toBe(201)
    // 自清（不属于本 org 的 fixture，cleanup 删不到）
    await pool.query(`delete from aftersales.employee_approval where org = 'test-m3b1-other'`)
  })
})

describe('GET /guest/products', () => {
  it('搜索 + 分页；只回本 org 的', async () => {
    await pool.query(`insert into aftersales.product(org, name, basic_quantity, basic_unit_price_minor) values ($1,'苹果',1,100),($1,'香蕉',1,200),('test-m3b1-other','别人的',1,300)`, [ORG])
    const body = (await (await app().request('/guest/products?page=1&size=20&q=苹')).json()) as any
    expect(body.items.map((i: any) => i.name)).toEqual(['苹果'])
    expect(body.total).toBe(1)
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— `Failed to resolve import "./registration-guest"`。

- [ ] **Step 3: 写 `routes/registration-guest.ts`**

```ts
// routes/registration-guest.ts — 访客面：我的登记 / 提交登记变更 / 选商品（spec §2.5）。
//
// 身份：访客 session（identity.userId = openid、orgId = 租户），**不查 Casdoor**（§1.3）。
// 「有限制」落在业务数据上：提交前必须有已审批的登记 —— 该判定在 M3b-2 的移动端消费本文件
// 的 `GET /guest/me/registration` 结果；本文件**不替它决定** UI 怎么呈现。
import { z } from 'zod'
import { computeRegistration, RegistrationError } from '../domain/registration'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/** 目标值：客户端只表达「我要变成什么」（spec §2.5 纪律②），差异由服务端算 */
const TargetBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50),
  // 门店 id 落 bigint 列 ⇒ `.safe()`（M2a I-1 的教训：z.number().int() 的 int 就是 Number.isInteger，
  // 1e30 会被放行 ⇒ 22P02 ⇒ Hono 兜成 500）。全模块 bigint 列只用这一种写法。
  storeIds: z.array(z.number().int().positive().safe()).max(50),
})

/** 读「我的档案」快照：employee 行 + employee_store 展开。org + open_id 双向收窄。 */
async function readMySnapshot(ctx: RouteCtx, org: string, openid: string) {
  const emp = await ctx.pool.query<{ id: string; name: string; phone: string }>(
    `select id, name, phone from aftersales.employee where org = $1 and open_id = $2 and approve_status = 'approved'`,
    [org, openid],
  )
  const row = emp.rows[0]
  if (!row) return null
  const stores = await ctx.pool.query<{ store_id: string }>(
    `select store_id from aftersales.employee_store where org = $1 and employee_id = $2 order by store_id`,
    [org, Number(row.id)],
  )
  return { id: Number(row.id), name: row.name, phone: row.phone, storeIds: stores.rows.map((s) => Number(s.store_id)) }
}

export function registerRegistrationGuest(r: ModuleHono, ctx: RouteCtx): void {
  // ── 我的登记 ──────────────────────────────────────────────────────────────
  r.get('/guest/me/registration', async (c) => {
    const { orgId: org, userId: openid } = c.get('identity')
    const snap = await readMySnapshot(ctx, org, openid)
    const pending = await ctx.pool.query(
      `select 1 from aftersales.employee_approval where org = $1 and open_id = $2 and status = 'pending'`,
      [org, openid],
    )
    return c.json({
      registration: snap ? { name: snap.name, phone: snap.phone, storeIds: snap.storeIds } : null,
      hasPendingApproval: pending.rowCount! > 0,
    })
  })

  // ── 提交登记/变更 ────────────────────────────────────────────────────────
  r.post('/guest/employee-approvals', async (c) => {
    const { orgId: org, userId: openid } = c.get('identity')
    const parsed = TargetBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const target = parsed.data

    const snap = await readMySnapshot(ctx, org, openid)
    let diff
    try {
      diff = computeRegistration(snap ? { name: snap.name, phone: snap.phone, storeIds: snap.storeIds } : null, target)
    } catch (e) {
      if (e instanceof RegistrationError) return c.json({ error: 'INVALID_BODY', message: e.message }, 400)
      throw e
    }

    try {
      const ins = await ctx.pool.query<{ id: string }>(
        `insert into aftersales.employee_approval(org, open_id, approve_type, old_info, new_info)
         values ($1, $2, $3, $4::jsonb, $5::jsonb) returning id`,
        [org, openid, diff.approveType, JSON.stringify(diff.oldInfo), JSON.stringify(diff.newInfo)],
      )
      return c.json({ id: Number(ins.rows[0]!.id), approveType: diff.approveType }, 201)
    } catch (e) {
      // ★ 防重**由库保证**（spec §2.5 纪律①）：部分唯一索引在并发下也拦得住。
      //   不先查后插——那正是源侧前端判定的做法，两个并发请求都能查到 0 条。
      if ((e as { code?: string }).code === '23505') return c.json({ error: 'APPROVAL_PENDING' }, 409)
      throw e
    }
  })

  // ── 选商品（M3b-2 的移动端要用；`GET /products` 是管理面，协议一条声明一个 scope ⇒ 分面）──
  r.get('/guest/products', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
      where += ` and name ilike $${params.length}`
    }
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.product where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, spec, basic_quantity, basic_unit_price_minor from aftersales.product
        where ${where} order by id limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((p) => ({
        id: Number(p.id),
        name: p.name,
        spec: p.spec,
        basicQuantity: Number(p.basic_quantity),
        basicUnitPriceMinor: Number(p.basic_unit_price_minor),
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    })
  })
}
```

- [ ] **Step 4: 接线 `index.ts`**

```ts
// 顶部 import 补：
import { registerRegistrationGuest } from './routes/registration-guest'
// createRouter 里补（与既有 registerXxx 并列）：
    registerRegistrationGuest(r, ctx)
```

- [ ] **Step 5: manifest 声明（**必须与上一步同一个提交**）**

`modules/aftersales/manifest.yaml` 的 `api.internal` 里，紧接访客面那组之后加：

```yaml
    # ── 登记/变更·访客面（aftersales:guest，M3b-1 / spec §2.5）──
    - { method: GET,  path: /guest/me/registration,     scope: aftersales:guest }
    - { method: POST, path: /guest/employee-approvals,  scope: aftersales:guest }
    # GET /guest/products 与管理面 GET /products 分面：协议里同一条 (method,path) 只能声明一次、
    # 一条声明只带一个 scope（spec §2.2 的同一条理由）。
    - { method: GET,  path: /guest/products,            scope: aftersales:guest }
```

- [ ] **Step 6: 跑测试 + 填 api-types**

Run: `pnpm --filter aftersales test`
Expected: PASS（访客面 9 条）。

同时把 console 侧要用的类型补进 `modules/aftersales/api-types.ts`：

```ts
/** `GET /guest/me/registration` 的响应（M3b-1） */
export interface MyRegistration {
  registration: { name: string; phone: string; storeIds: number[] } | null
  hasPendingApproval: boolean
}
/** 提交登记/变更的**目标值**（差异由服务端算，spec §2.5 纪律②） */
export interface RegistrationTarget {
  name: string
  phone: string
  storeIds: number[]
}
/** `GET /employee-approvals` 的一行 */
export interface EmployeeApprovalItem {
  id: number
  openId: string
  approveType: 'register' | 'change'
  status: 'pending' | 'approved' | 'rejected'
  oldInfo: Partial<RegistrationTarget>
  newInfo: Partial<RegistrationTarget>
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
}
```

- [ ] **Step 7: 跑门禁（装载期双向核对的机检）**

```bash
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/smoke-load.mjs
```
Expected: 两条都 OK（若漏声明，`smoke-load` 会因模块装载失败而红）。

- [ ] **Step 8: 提交**

```bash
git add modules/aftersales/routes/registration-guest.ts modules/aftersales/routes/registration-guest.test.ts \
        modules/aftersales/index.ts modules/aftersales/manifest.yaml modules/aftersales/api-types.ts
git commit -m "feat(aftersales): M3b-1 访客面登记端点——我的登记/提交变更/选商品（含 manifest 声明）(#81)"
```

---

### Task 4: 管理面路由 `routes/registration-manage.ts`（2 个端点 + 单事务写回）

**Files:**
- Create: `modules/aftersales/routes/registration-manage.ts`
- Create: `modules/aftersales/routes/registration-manage.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（+2 条 `aftersales:manage` 声明）
- Modify: `modules/aftersales/index.ts`（接线）

**Interfaces:**
- Consumes: `pickPrimaryStoreId`（Task 2）；`parseIdParam`（`routes/context.ts`）
- Produces: `registerRegistrationManage(r: ModuleHono, ctx: RouteCtx): void`

- [ ] **Step 1: 写失败测试 `routes/registration-manage.test.ts`**

```ts
// routes/registration-manage.test.ts — 管理面申请审批（真 PG）。
// 重点：**通过 ⇒ 单事务写回 employee + employee_store**；并发决定只有一个能落。
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { registerRegistrationManage } from './registration-manage'

const ORG = 'test-m3b1-manage'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function app() {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', { userId: 'admin1', orgId: ORG, displayName: '管理员', scopes: [], hasScope: () => true })
    await next()
  })
  registerRegistrationManage(r, { pool, storage: null })
  return r
}

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
  await pool.query(`delete from aftersales.store where org = $1`, [ORG])
}
beforeAll(cleanup)
beforeEach(cleanup)
afterAll(async () => { await cleanup(); await pool.end() })

async function seedRegisterApproval(openid: string, storeIds: number[]) {
  const ins = await pool.query<{ id: string }>(
    `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
     values ($1, $2, 'register', $3::jsonb) returning id`,
    [ORG, openid, JSON.stringify({ name: '张三', phone: '138', storeIds })],
  )
  return Number(ins.rows[0]!.id)
}

const decide = (id: number, decision: 'approve' | 'reject') =>
  app().request(`/employee-approvals/${id}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
  })

describe('GET /employee-approvals', () => {
  it('列表 + status 筛选；只回本 org', async () => {
    await seedRegisterApproval('o1', [])
    await seedRegisterApproval('o2', [])
    await pool.query(`update aftersales.employee_approval set status='approved' where org=$1 and open_id='o2'`, [ORG])
    expect(((await (await app().request('/employee-approvals')).json()) as any).items).toHaveLength(2)
    const pend = (await (await app().request('/employee-approvals?status=pending')).json()) as any
    expect(pend.items.map((i: any) => i.openId)).toEqual(['o1'])
  })
})

describe('POST /employee-approvals/:id/decide', () => {
  it('★ 通过 register ⇒ 建 employee 行（approved）+ 写 employee_store 关联', async () => {
    await pool.query(`insert into aftersales.store(org, name, address, phone) values ($1,'店A','','')`, [ORG])
    const [s1] = (await pool.query<{ id: string }>(`select id from aftersales.store where org=$1`, [ORG])).rows.map((r) => Number(r.id))
    const id = await seedRegisterApproval('o1', [s1])

    expect((await decide(id, 'approve')).status).toBe(200)

    const emp = (await pool.query(`select id, name, phone, store_id, approve_status from aftersales.employee where org=$1 and open_id='o1'`, [ORG])).rows[0] as any
    expect(emp.name).toBe('张三')
    expect(emp.approve_status).toBe('approved')
    expect(Number(emp.store_id)).toBe(s1)                 // 主门店 = 归一后第一个
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee_store where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
    const ap = (await pool.query(`select status, decided_by from aftersales.employee_approval where id=$1`, [id])).rows[0] as any
    expect(ap.status).toBe('approved')
    expect(ap.decided_by).toBe('管理员')
  })

  it('★ 通过 change ⇒ 改 employee 行 + **重建** employee_store（删除旧关联）', async () => {
    await pool.query(`insert into aftersales.store(org, name, address, phone) values ($1,'店A','',''),($1,'店B','','')`, [ORG])
    const [s1, s2] = (await pool.query<{ id: string }>(`select id from aftersales.store where org=$1 order by id`, [ORG])).rows.map((r) => Number(r.id))
    const emp = await pool.query<{ id: string }>(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status) values ($1,'张三','138','o1','approved') returning id`, [ORG])
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_id) values ($1,$2,$3)`, [ORG, Number(emp.rows[0]!.id), s1])
    const ins = await pool.query<{ id: string }>(
      `insert into aftersales.employee_approval(org, open_id, approve_type, old_info, new_info)
       values ($1,'o1','change',$2::jsonb,$3::jsonb) returning id`,
      [ORG, JSON.stringify({ storeIds: [s1] }), JSON.stringify({ storeIds: [s2] })])

    expect((await decide(Number(ins.rows[0]!.id), 'approve')).status).toBe(200)

    const rows = (await pool.query<{ store_id: string }>(`select store_id from aftersales.employee_store where org=$1 order by store_id`, [ORG])).rows.map((r) => Number(r.store_id))
    expect(rows).toEqual([s2])   // s1 的关联被删掉（重建而不是追加）
  })

  it('驳回 ⇒ 只改申请状态，**不碰 employee**', async () => {
    const id = await seedRegisterApproval('o1', [])
    expect((await decide(id, 'reject')).status).toBe(200)
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(0)
    expect(((await pool.query(`select status from aftersales.employee_approval where id=$1`, [id])).rows[0] as any).status).toBe('rejected')
  })

  it('★ 已决的申请再决 ⇒ 409（状态机条件更新，不是先查后改）', async () => {
    const id = await seedRegisterApproval('o1', [])
    expect((await decide(id, 'approve')).status).toBe(200)
    const again = await decide(id, 'approve')
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error).toBe('ALREADY_DECIDED')
    // 且没有重复建 employee
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
  })

  it('不存在的 id ⇒ 404；非法 id ⇒ 404（parseIdParam 口径）', async () => {
    expect((await decide(999999, 'approve')).status).toBe(404)
    expect((await app().request('/employee-approvals/1e5/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) })).status).toBe(404)
  })

  it('decision 不是 approve/reject ⇒ 400', async () => {
    const id = await seedRegisterApproval('o1', [])
    expect((await decide(id, 'maybe' as any)).status).toBe(400)
  })

  it('★ 租户隔离：另一个 org 的申请决不了（404 不是 403）', async () => {
    await pool.query(`insert into aftersales.employee_approval(org, open_id, approve_type, new_info) values ('test-m3b1-other','o1','register','{}'::jsonb)`)
    const other = Number((await pool.query(`select id from aftersales.employee_approval where org='test-m3b1-other'`)).rows[0]!.id)
    expect((await decide(other, 'approve')).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— `Failed to resolve import "./registration-manage"`。

- [ ] **Step 3: 写 `routes/registration-manage.ts`**

```ts
// routes/registration-manage.ts — 管理面：申请列表 + 决定（spec §2.5）。
//
// ★ 纪律③：**通过 ⇒ 申请状态与 employee/employee_store 的写入在同一事务**。
//   不允许「申请已通过但 employee 没改」——那会让申请列表与员工档案互相说谎。
//
// 与 M3a 的 `POST /employees/:id/approve` **语义不同**（那个直接改 employee 的 approve_status）：
// 本文的端点决的是**申请**，通过后按申请内容写回档案。**加而不改**。
import { z } from 'zod'
import { pickPrimaryStoreId } from '../domain/registration'
import { parseIdParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

const DecideBody = z.object({ decision: z.enum(['approve', 'reject']) })

export function registerRegistrationManage(r: ModuleHono, ctx: RouteCtx): void {
  // ── 申请列表 ──────────────────────────────────────────────────────────────
  r.get('/employee-approvals', async (c) => {
    const org = c.get('identity').orgId
    const status = c.req.query('status')
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (status) {
      params.push(status)
      where += ` and status = $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, open_id, approve_type, status, old_info, new_info, created_at, decided_at, decided_by
         from aftersales.employee_approval where ${where} order by id desc limit 500`,
      params,
    )
    return c.json({
      items: res.rows.map((a) => ({
        id: Number(a.id),
        openId: a.open_id,
        approveType: a.approve_type,
        status: a.status,
        oldInfo: a.old_info,
        newInfo: a.new_info,
        createdAt: a.created_at,
        decidedAt: a.decided_at,
        decidedBy: a.decided_by,
      })),
    })
  })

  // ── 决定（通过 ⇒ 单事务写回）────────────────────────────────────────────
  r.post('/employee-approvals/:id/decide', async (c) => {
    const org = c.get('identity').orgId
    const who = c.get('identity').displayName
    const id = parseIdParam(c.req.param('id'))
    // 404 不是 400：与 rule/masterdata 的既有口径一致（跨租户也走这条 ⇒ 不泄露存在性）
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = DecideBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { decision } = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // 状态机守卫：只决 pending 的（并发下另一个请求会 rowCount=0 ⇒ 409），不先查后改
      const lock = await client.query(
        `update aftersales.employee_approval set status = $3, decided_at = now(), decided_by = $4
          where org = $1 and id = $2 and status = 'pending' returning open_id, approve_type, new_info`,
        [org, id, decision === 'approve' ? 'approved' : 'rejected', who],
      )
      if (lock.rowCount === 0) {
        await client.query('rollback')
        // 区分「不存在」与「已决」：再读一次（读不到 ⇒ 404）
        const exists = await ctx.pool.query(`select 1 from aftersales.employee_approval where org = $1 and id = $2`, [org, id])
        return c.json({ error: exists.rowCount! > 0 ? 'ALREADY_DECIDED' : 'NOT_FOUND' }, exists.rowCount! > 0 ? 409 : 404)
      }

      if (decision === 'approve') {
        const ap = lock.rows[0] as { open_id: string; approve_type: string; new_info: Record<string, unknown> }
        const ni = ap.new_info as { name?: string; phone?: string; storeIds?: number[] }
        const primary = pickPrimaryStoreId({ name: ni.name ?? '', phone: ni.phone ?? '', storeIds: ni.storeIds ?? [] })

        // 写回档案：**先 select 再 insert/update**，不要写 `on conflict (org, open_id)`。
        // ⚠️ 实测：`employee` 在 `(org, open_id)` 上**只有普通索引、没有唯一约束**
        //    （唯一索引是 `(org, source_id) where source_id <> ''`，用部分谓词躲开空值默认）
        //    ⇒ `on conflict (org, open_id)` 会直接报
        //    「there is no unique or exclusion constraint matching the ON CONFLICT specification」。
        //    也**不要顺手加那个唯一索引**：源的 openid 拼写有两种（spec §3.3），M2b 导入时可能撞重复。
        //
        // 这里不加锁也安全：同一个 openid **同时只可能有一条 pending 申请**（Task 1 的部分唯一索引），
        // 而本事务已用条件 update 把它从 pending 拿走了 ⇒ 不存在两个决定并发写同一 employee 行的窗口。
        const existing = await client.query<{ id: string }>(
          `select id from aftersales.employee where org = $1 and open_id = $2 order by id limit 1`,
          [org, ap.open_id],
        )
        let employeeId: number
        if (existing.rows[0]) {
          employeeId = Number(existing.rows[0].id)
          await client.query(
            `update aftersales.employee
                set name = $3, phone = $4, store_id = $5, approve_status = 'approved'
              where org = $1 and id = $2`,
            [org, employeeId, ni.name ?? '', ni.phone ?? '', primary],
          )
        } else {
          const ins = await client.query<{ id: string }>(
            `insert into aftersales.employee(org, open_id, name, phone, store_id, approve_status)
             values ($1, $2, $3, $4, $5, 'approved') returning id`,
            [org, ap.open_id, ni.name ?? '', ni.phone ?? '', primary],
          )
          employeeId = Number(ins.rows[0]!.id)
        }

        // employee_store 只在申请**确实动了门店**时重建（重建 = 删旧 + 插新，同一事务）
        if (ni.storeIds !== undefined) {
          await client.query(`delete from aftersales.employee_store where org = $1 and employee_id = $2`, [org, employeeId])
          for (const sid of ni.storeIds) {
            await client.query(
              `insert into aftersales.employee_store(org, employee_id, store_id) values ($1, $2, $3)`,
              [org, employeeId, sid],
            )
          }
        }
      }

      await client.query('commit')
      return c.json({ ok: true, id, decision })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}
```

- [ ] **Step 4: 接线 `index.ts` + manifest 声明（**同一提交**）**

```ts
// index.ts 顶部：
import { registerRegistrationManage } from './routes/registration-manage'
// createRouter 里：
    registerRegistrationManage(r, ctx)
```

`manifest.yaml` 加：

```yaml
    # ── 登记/变更·管理面（aftersales:manage，M3b-1 / spec §2.5）──
    - { method: GET,  path: /employee-approvals,             scope: aftersales:manage }
    - { method: POST, path: /employee-approvals/:id/decide,  scope: aftersales:manage }
```

- [ ] **Step 5: 跑测试 + 门禁**

Run: `pnpm --filter aftersales test && pnpm exec tsx scripts/smoke-load.mjs`
Expected: 全绿（管理面 8 条；smoke-load OK ⇒ 声明与路由一致）。

- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/routes/registration-manage.ts modules/aftersales/routes/registration-manage.test.ts \
        modules/aftersales/index.ts modules/aftersales/manifest.yaml
git commit -m "feat(aftersales): M3b-1 管理面申请审批——单事务写回档案与门店关联 (#81)"
```

---

## Wave 2

### Task 5: console「申请审批」页签

> 照 M3a 已落地的 console 约定写：HTTP 走 `../lib/api` 的 `apiGet`/`apiSend`、
> 列表用 `../lib/useList`、**`Alert` 用 `title=` 不是 `message=`**、**`Modal`/`Popconfirm` 显式给
> `okText`/`cancelText`**（模块页不依赖宿主 locale）、**antd 两个汉字按钮的测试用正则匹配**。

**Files:**
- Create: `modules/aftersales/console/approvals/index.tsx`
- Create: `modules/aftersales/console/approvals/index.test.tsx`
- Modify: `modules/aftersales/console/index.tsx`（加第 6 个页签）

**Interfaces:**
- Consumes: `apiGet` / `apiSend` / `messageOf`（`../lib/api`）；`useList`（`../lib/useList`）；`EmployeeApprovalItem`（Task 3 加进 `api-types.ts`）
- Produces: `export default function ApprovalsPage()`

- [ ] **Step 1: 写失败测试 `console/approvals/index.test.tsx`**

```tsx
// approvals/index.test.tsx — 申请审批页：列表、通过/驳回、空态
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ApprovalsPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

const PENDING = {
  id: 7, openId: 'o1', approveType: 'register', status: 'pending',
  oldInfo: {}, newInfo: { name: '张三', phone: '138', storeIds: [1] },
  createdAt: '2026-09-16T00:00:00Z', decidedAt: null, decidedBy: null,
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    return json({ items: [PENDING] })
  })
})
afterEach(cleanup)

describe('申请审批页', () => {
  it('渲染待审申请：类型、申请人、变更内容', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(screen.getByText('注册')).toBeInTheDocument()
    expect(screen.getByText(/张三/)).toBeInTheDocument()
  })

  it('★ 通过 ⇒ POST /employee-approvals/7/decide { decision: "approve" }，并刷新列表', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /通\s*过/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/modules/aftersales/employee-approvals/7/decide')).toBe(true),
    )
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'approve' })
    // 刷新：GET 至少两次（初次 + 决定后）
    expect(calls.filter((c) => c.method === undefined).length).toBeGreaterThanOrEqual(2)
  })

  it('驳回发的是 decision: "reject"', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/decide'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/decide'))!.body).toEqual({ decision: 'reject' })
  })

  it('已决的申请不显示操作按钮', async () => {
    m.mockImplementation(async () => json({ items: [{ ...PENDING, status: 'approved', decidedBy: '管理员' }] }))
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /通\s*过/ })).toBeNull()
  })

  it('★ 无 total ⇒ 不出现分页控件', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter aftersales test`
Expected: FAIL —— 找不到 `o1`（文件不存在）。

- [ ] **Step 3: 写 `console/approvals/index.tsx`**

```tsx
// approvals/index.tsx — 员工登记/变更申请的审批（M3b-1 / spec §2.5）。
//
// `GET /employee-approvals` 回 `{ items }` **无 total** ⇒ 单页展示、不放分页控件
// （与 rules/employees/stores 同一条已知边界）。
import { useCallback, useState } from 'react'
import { Alert, Button, Modal, Table, Tag } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { EmployeeApprovalItem, Unpaged } from '../../api-types'

const TYPE_LABEL: Record<EmployeeApprovalItem['approveType'], string> = { register: '注册', change: '变更' }
const STATUS_LABEL: Record<EmployeeApprovalItem['status'], string> = {
  pending: '待审批', approved: '已通过', rejected: '已驳回',
}
const STATUS_COLOR: Record<EmployeeApprovalItem['status'], string> = {
  pending: 'orange', approved: 'green', rejected: 'red',
}

/** 把 old/new 差异渲染成「字段: 旧 → 新」的一行（变更只带实际改了的字段） */
function diffText(a: EmployeeApprovalItem): string {
  // register 与 change 的「显示内容」都在 new_info（change 只含实际变了的字段）
  const label: Record<string, string> = { name: '姓名', phone: '手机号', storeIds: '门店' }
  return Object.entries(a.newInfo)
    .map(([k, v]) => `${label[k] ?? k}: ${Array.isArray(v) ? v.join('/') : String(v)}`)
    .join('；')
}

export default function ApprovalsPage() {
  const load = useCallback(
    async () => (await apiGet<Unpaged<EmployeeApprovalItem>>('/employee-approvals')).items,
    [],
  )
  const { items, loading, error, reload } = useList(load)
  const [busy, setBusy] = useState<number | null>(null)

  const decide = async (id: number, decision: 'approve' | 'reject') => {
    setBusy(id)
    try {
      await apiSend(`/employee-approvals/${id}/decide`, 'POST', { decision })
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '操作失败', content: messageOf(e), okText: '确定' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<EmployeeApprovalItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '申请人', dataIndex: 'openId' },
          {
            title: '类型', dataIndex: 'approveType', width: 90,
            render: (v: EmployeeApprovalItem['approveType']) => <Tag>{TYPE_LABEL[v]}</Tag>,
          },
          { title: '内容', render: (_: unknown, a: EmployeeApprovalItem) => diffText(a) },
          {
            title: '状态', dataIndex: 'status', width: 110,
            render: (v: EmployeeApprovalItem['status']) => <Tag color={STATUS_COLOR[v]}>{STATUS_LABEL[v]}</Tag>,
          },
          {
            title: '操作', width: 170,
            render: (_: unknown, a: EmployeeApprovalItem) =>
              a.status === 'pending' ? (
                <>
                  <Button size="small" type="primary" loading={busy === a.id} onClick={() => void decide(a.id, 'approve')}>
                    通过
                  </Button>{' '}
                  <Button size="small" danger loading={busy === a.id} onClick={() => void decide(a.id, 'reject')}>
                    驳回
                  </Button>
                </>
              ) : (
                <span>{a.decidedBy ?? '—'}</span>
              ),
          },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 4: 加页签（`console/index.tsx`）**

```tsx
// TABS 末尾加一项：
  { key: 'approvals', label: '申请审批' },
// import 补：
import ApprovalsPage from './approvals'
// PAGES 映射补一行：
    approvals: ApprovalsPage,
```

- [ ] **Step 5: 跑测试 + 补「壳」的回归测试**

Run: `pnpm --filter aftersales test`
Expected: PASS（审批页 5 条 + 既有全部）。

同时在 `console/index.test.tsx` 的「五个页签都在菜单里」用例里**把新页签加进断言列表**
（`['工单','规则','员工','商品','门店','申请审批']`），否则那条用例名不副实。

- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/console/approvals modules/aftersales/console/index.tsx modules/aftersales/console/index.test.tsx
git commit -m "feat(aftersales): console 申请审批页签——通过/驳回登记与变更申请 (#81)"
```

---

## Wave 3

### Task 6: 收口（全量门禁 + 端到端验证）

- [ ] **Step 1: 重生成 registry 并确认是最新**

```bash
pnpm --filter @platform/web build
git diff --exit-code apps/web/src/console-registry.gen.ts && echo "registry 已是最新"
```
Expected: 无 diff（manifest 的 console 条目未变，只是页内多一个页签）。

- [ ] **Step 2: 跑该仓 CI 跑的全部命令**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
pnpm typecheck
pnpm test
pnpm --filter @platform/web build
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/smoke-load.mjs
pnpm exec tsx scripts/check-tenant-isolation.mjs   # 若该门禁已在 main
```
Expected: 全绿。

- [ ] **Step 3: 端到端跑一遍「登记 → 审批 → 写回」**（真库 + 真会话）

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
pnpm dev:stack   # MockCasdoor + 宿主；Ctrl-C 收
```
另开一个终端，用**访客身份**与**管理身份**各走一遍（访客 session 的构造见 `apps/server/src/routes/auth-wechat-oa.ts`；
本地没有真公众号，可用 smoke-load 里造访客 session 的同款手法，或直接对模块 API 用手工签的 session cookie）。
逐条记录实际结果：

- [ ] 访客提交登记 ⇒ `201`，库里有 `employee_approval` 行、`old_info` 为空、`new_info` 是目标值
- [ ] 同一访客**再提交一次** ⇒ `409 APPROVAL_PENDING`（**库拦的**，不是先查后插）
- [ ] 管理端 `GET /employee-approvals` 看得到这条
- [ ] 管理端决定通过 ⇒ 库里 `employee` 行 `approve_status='approved'`、`employee_store` 有对应行
- [ ] 访客 `GET /guest/me/registration` ⇒ 回刚写回的档案 + 门店
- [ ] 管理端**再决定一次** ⇒ `409 ALREADY_DECIDED`
- [ ] console 打开 `/console/aftersales/approvals` 页签，列表与操作可用（**浏览器实测**，
      与 M3a 同法：真登录 + 断言页面独有内容）

- [ ] **Step 4: 提交（若 Step 1 有 diff）**

```bash
git add -A && git commit -m "chore(aftersales): M3b-1 收口——registry 重生成 (#81)"
```
