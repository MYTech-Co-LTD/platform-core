# AI 原生 OA（P0 + P1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 platform-core 与 case-engine 落地 AI 原生 OA 的 P0 前置与 P1「请假」端到端：事项模板/审批模板、计划编译、应用内审批链（引擎执行）、企微模板消息 + 深链、回调与对账。

**Architecture:** 模板与治理在 platform-core（扩展现有 `modules/forms` 资产内核）；非标准审批由 case-engine 的 Mastra durable workflow 逐节点执行（`suspend`/`resume`），平台只做 UI 与授权；标准审批（`wecom_native`）不在本计划范围（P2）。跨服务契约是公开的 HTTP JSON，携带 org 与 `externalRef` 幂等键。

**Tech Stack:** TypeScript / Hono / pg / zod / React + antd / RJSF（已有）；case-engine = Mastra 1.78 durable workflows + pg；Vitest。

## Repo roots 与执行顺序

| 仓 | 根目录（本机） | 本计划中的任务 |
|---|---|---|
| platform-core（公开） | `/Users/duo/mytechcode/platform-core` | T0/T1–T5、T7–T12、T15 |
| case-engine（私有） | `/Users/duo/mytechcode/case-engine` | T6、T13、T14 |
| explore（设计正典） | `/Users/duo/mytechcode/explore` | T0 |

- **每个仓单独 worktree/分支**；禁止在一个 worktree 里跨仓改文件。
- 执行顺序：**T0 → T1–T5（platform P0）→ T6（engine P0）→ T7–T12（platform P1）→ T13–T14（engine P1）→ T15**。
- case-engine 的改动以 `origin/main` 为基线（当前本地 checkout 可能在文档分支上）。
- 所有 feat/fix PR 必须先有 issue；T0 建平台 issue 并在后续 PR body 写 `Closes #N`；case-engine PR 用 `Refs #N` 指回同一 issue。**下文所有 `#OA` 占位在执行时替换成 T0 产出的真实 issue 编号。**
- 事件 key 必须以其声明模块 id 开头（`ManifestSchema` 强制）；external 事件仍用 `forms.*`，归属由 `producer` 元数据表达。

## Global Constraints

- 提交格式 `type(scope): subject`；feat/fix PR 必须有 issue；可见变更必须 PR。
- 迁移幂等：`create ... if not exists` / `drop ... if exists` / DML `on conflict`；重复执行不报错。
- **B1**：模块不直读其他 schema；组织数据经宿主注入的 port（T2）。
- **B12**：公开仓不得依赖私有包；跨仓只走 HTTP 契约。
- **事件先声明后接线**：未在 manifest 声明的事件 `/emit` 恒 400，生产者 fail-open ⇒ 静默；联调前必须查目录。
- **AI 永不发布**：发布走 `forms:publish`/`forms:global-manage` 人 gate；AI 工具面只有 manage。
- 既有 forms/collection 行为在 `OA_ENABLED` off 时逐字不变。
- 敏感值不落库明文：引擎 PAT 走 secret 引用（`pat_secret_ref`），代码/日志不出现值。
- 时间：API 一律 RFC3339 UTC；展示按北京时间。
- 测试命令：platform `pnpm vitest run <file>`；engine `npx vitest run <file>`；全量 platform `pnpm test`，engine `npm test`。

---

## Task 0: 架构先行（文档 + issue）

**Files:**
- Modify: `explore/docs/adr/0005-collection-form-layer.md`（§15）
- Modify: `platform-core/docs/architecture.md`（§2.4、§2.6）
- Modify: `platform-core/docs/module-protocol.md`（事件 external 声明）
- Create: platform-core GitHub issue（`feat(oa): AI 原生 OA P0+P1`）

**Interfaces:**
- Produces: issue 编号（后续所有 PR 引用）；三份文档的定稿条文。

- [ ] **Step 1: 建 issue**

```bash
cd /Users/duo/mytechcode/platform-core
gh issue create --title "feat(oa): AI 原生 OA P0+P1——事项模板/应用内审批链/企微通知" \
  --body "Spec: docs/superpowers/specs/2026-11-16-ai-native-oa-design.md
范围：P0 前置 + P1 请假端到端。标准审批（wecom_native）在 P2。

验收：
- P0：org 负责人/部门管理员可查；事件 external 协议可用；引擎 external_ref/查询/capabilities 可用。
- P1：企微消息深链 → 应用内两级审批 → 回调幂等 → 在途单不受模板改版影响。"
```
记录 issue 编号（下称 `#OA`）。

- [ ] **Step 2: 修订 ADR-0005 §15**

在 `explore/docs/adr/0005-collection-form-layer.md` §15 追加（不改原职责切分）：

```markdown
### 15.5 Provider 路由（2026-11-16 修订）

- 标准审批（公司级、固定链、预置企微审批模板）：`wecom_native`。平台只做「选模板 + 深链 + 镜像」，
  **不复制表单、不存附件、不建引擎 case**。
- 非标准审批：`inapp`。平台编译计划快照 → case-engine 逐节点执行 → 应用内审批页；
  企微只发模板消息 + 深链，不做卡片内批。
- §15.4「带审批表单延后到 case-engine 可用」**作废**：非标准审批由本次 B 方案接管；
  标准审批由企微原生接管。
```

- [ ] **Step 3: 修订 `docs/architecture.md`**

在 §2.4 末尾追加「事项平台与 provider 路由」小节，写死：
`mode = approval | collection | collaboration`；`provider = wecom_native | inapp`；模板在平台、inapp 执行在引擎；标准审批不进引擎。
在 §2.6 追加 OA 事件：`forms.approval.awaiting` / `forms.approval.decided` / `forms.task.assigned` / `forms.collection.assigned` / `forms.collection.due` / `forms.case.sla.breach`。

- [ ] **Step 4: 修订 `docs/module-protocol.md`**

在「通知事件声明」节追加：

```markdown
### external 生产者声明

`notifications.events[]` 支持可选 `producer: "external:<name>"`。声明后：
- 事件目录的 `module_id` 记为 `external:<name>`（不是声明它的模块 id），`source = external`；
- `/emit` 接受该事件；未声明仍 400 `EVENT_NOT_DECLARED`；
- 外部生产者必须自带确定性 `eventId`（幂等）。
```

- [ ] **Step 5: 跑架构门禁并提交**

```bash
cd /Users/duo/mytechcode/platform-core && node scripts/lint-architecture.mjs
```

Expected: PASS（文档改动不触 B1/B12）。

```bash
git add docs/architecture.md docs/module-protocol.md
git commit -m "docs(oa): 事项平台 provider 路由与 external 事件协议（#OA）"
cd /Users/duo/mytechcode/explore && git add docs/adr/0005-collection-form-layer.md
git commit -m "docs(adr): 审批 provider 路由与 inapp 执行归属（#OA）"
```

---

## Task 1: org 负责人 + 部门管理员（迁移 + 同步）

**Files:**
- Create: `apps/server/src/migrations/018_org_leader_and_roles.sql`
- Modify: `apps/server/src/org-sync.ts`
- Test: `apps/server/src/org-sync.test.ts`

**Interfaces:**
- Produces: `platform.org_node_leader(tenant_id,node_ext_id,user_name,sort)`、`platform.org_role_binding(tenant_id,node_ext_id,user_name,role)`、视图 `v_org_node_leader` / `v_org_role_binding`；`OrgSnapshot.depts[].leaders: Array<{ userName: string; sort: number }>`。

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/org-sync.test.ts` 追加（复用本文件既有的 `fakeWecom` / `pool` / `tenantId` 夹具与 `json` 辅助；`json` 即 `Response.json(body)`）：

```ts
it('fetchWecomSnapshot 取 department_leader 并归一为 leaders', async () => {
  const fetchFn = (async (url: string) => {
    if (url.includes('/gettoken')) return json({ access_token: 't' })
    if (url.includes('/department/list')) return json({
      department: [
        { id: 1, name: '总部', parentid: 0, department_leader: ['u-lead', 'u-lead2'] },
      ],
    })
    return json({ userlist: [] })
  }) as unknown as typeof fetch
  const snap = await fetchWecomSnapshot({ corpId: 'c', secret: 's' }, fetchFn)
  expect(snap.depts[0].leaders).toEqual([
    { userName: 'u-lead', sort: 0 },
    { userName: 'u-lead2', sort: 1 },
  ])
})

it('applySnapshot 整组重写负责人（幂等）', async () => {
  // 使用测试库：先建 tenant + org_node，再 apply 两次，断言行数不变
  await applySnapshot(pool, tenantId, snap, 'wecom')
  await applySnapshot(pool, tenantId, snap, 'wecom')
  const { rows } = await pool.query(
    'select user_name, sort from platform.org_node_leader where tenant_id=$1 order by sort',
    [tenantId],
  )
  expect(rows).toEqual([{ user_name: 'u-lead', sort: 0 }, { user_name: 'u-lead2', sort: 1 }])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/org-sync.test.ts`
Expected: FAIL（`department_leader` 未读取 / 表不存在）。

- [ ] **Step 3: 写迁移**

`apps/server/src/migrations/018_org_leader_and_roles.sql`：

```sql
-- 018 — OA 前置：部门负责人（企微同步）与部门管理员（平台授予）。
create table if not exists platform.org_node_leader (
  tenant_id   integer not null references platform.tenant(id),
  node_ext_id text    not null,
  user_name   text    not null,
  sort        integer not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (tenant_id, node_ext_id, user_name)
);
create index if not exists idx_org_node_leader_user
  on platform.org_node_leader (tenant_id, user_name);

create table if not exists platform.org_role_binding (
  tenant_id   integer not null references platform.tenant(id),
  node_ext_id text    not null,
  user_name   text    not null,
  role        text    not null check (role in ('dept_admin')),
  granted_by  text    not null,
  granted_at  timestamptz not null default now(),
  primary key (tenant_id, node_ext_id, user_name, role)
);
create index if not exists idx_org_role_binding_user
  on platform.org_role_binding (tenant_id, user_name, role);

drop view if exists platform.v_org_node_leader;
create view platform.v_org_node_leader as
  select tenant_id, node_ext_id, user_name, sort, synced_at
    from platform.org_node_leader;

drop view if exists platform.v_org_role_binding;
create view platform.v_org_role_binding as
  select tenant_id, node_ext_id, user_name, role, granted_at
    from platform.org_role_binding;
```

- [ ] **Step 4: 改 snapshot 类型与拉取**

`org-sync.ts`：

```ts
export interface OrgSnapshot {
  depts: Array<{
    extId: string; name: string; parentExtId: string | null
    leaders: Array<{ userName: string; sort: number }>
  }>
  memberships: Array<{ userName: string; extId: string; isPrimary: boolean; externalId: string | null }>
}
```

`fetchWecomSnapshot` 的 department 类型加 `department_leader?: string[]`，归一：

```ts
leaders: (d.department_leader ?? []).map((userName, sort) => ({ userName, sort })),
```

`snapshotFromCasdoor` 的 depts 加 `leaders: []`。**所有 `OrgSnapshot` 字面量构造点都要补 `leaders`**——执行 `grep -rn "OrgSnapshot" apps/server/src` 逐个改，漏一个就是 TS 编译错。

- [ ] **Step 5: 改 applySnapshot**

在 membership 重写之后、`recomputePaths` 之前整组重写负责人：

```ts
await client.query('delete from platform.org_node_leader where tenant_id = $1', [tenantId])
for (const d of snapshot.depts) {
  for (const l of d.leaders) {
    await client.query(
      `insert into platform.org_node_leader (tenant_id, node_ext_id, user_name, sort, synced_at)
       values ($1,$2,$3,$4,now())`,
      [tenantId, d.extId, l.userName, l.sort],
    )
  }
}
```

- [ ] **Step 6: 跑测试与全量回归**

Run: `pnpm vitest run apps/server/src/org-sync.test.ts`
Expected: PASS。
Run: `pnpm vitest run apps/server/src/org-sync.test.ts apps/server/src/org-directory.test.ts`（后者在 T2 建；此步只跑前者）。
Run: `pnpm --filter @platform/server test`（若脚本不存在则 `pnpm vitest run apps/server/src`）。
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/migrations/018_org_leader_and_roles.sql apps/server/src/org-sync.ts apps/server/src/org-sync.test.ts
git commit -m "feat(org): 部门负责人与部门管理员原语（#OA）"
```

---

## Task 2: OrganizationPort（宿主注入的组织查询面）

**Files:**
- Modify: `packages/platform-sdk/src/module.ts`（`ModuleContext.org?` + `OrganizationPort`）
- Modify: `packages/platform-sdk/src/index.ts`（导出 `OrganizationPort`）
- Create: `apps/server/src/org-directory.ts`
- Modify: `apps/server/src/loader.ts`（构造并注入）
- Test: `apps/server/src/org-directory.test.ts`

**Interfaces:**
- Produces: `OrganizationPort`（见下）；`ModuleContext.org?: OrganizationPort`；`createOrganizationPort({ pool, casdoorFor })`。

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/org-directory.test.ts`，照 `org-sync.test.ts` 的「DATABASE_URL 缺省则 skip + 真 PG + runMigrations + 夹具」写法建 `pool`，并插入 tenant/org_node/org_membership/org_node_leader 夹具：

```ts
import { describe, it, expect } from 'vitest'
import { createOrganizationPort } from './org-directory'

it('listDeptLeaders 按部门返回负责人（保持 sort）', async () => {
  const port = createOrganizationPort({ pool })
  // 夹具：tenant=1, org_node 10，leader u1(sort0), u2(sort1)
  expect(await port.listDeptLeaders('acme', ['10'])).toEqual(['u1', 'u2'])
})

it('listSubtreeMembers 含子部门成员并去重', async () => {
  const port = createOrganizationPort({ pool })
  expect(await port.listSubtreeMembers('acme', ['10'])).toEqual(['u1', 'u3'])
})

it('primaryDeptOf 取 is_primary 优先', async () => {
  const port = createOrganizationPort({ pool })
  expect(await port.primaryDeptOf('acme', 'u3')).toBe('11')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/org-directory.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 定义接口**

`packages/platform-sdk/src/module.ts`：

```ts
export interface OrganizationPort {
  /** 部门子树（含自身）去重成员，过滤 status=1；成员来自 v_org_membership */
  listSubtreeMembers(org: string, deptExtIds: readonly string[]): Promise<string[]>
  /** 部门负责人（按 sort）；只查所列部门，不展开子树 */
  listDeptLeaders(org: string, deptExtIds: readonly string[]): Promise<string[]>
  /** 部门管理员（role=dept_admin） */
  listDeptAdmins(org: string, deptExtIds: readonly string[]): Promise<string[]>
  /** Casdoor 角色成员（短名归一） */
  listRoleMembers(org: string, role: string): Promise<string[]>
  /** 用户主部门 ext_id；无记录 → null */
  primaryDeptOf(org: string, userName: string): Promise<string | null>
}
```

`ModuleContext` 加：

```ts
/** 组织查询面（B1：模块不直读 platform.org_*）；未注入 = 旧宿主/单测，调用点显式判空。 */
org?: OrganizationPort
```

- [ ] **Step 4: 实现**

`apps/server/src/org-directory.ts`：

```ts
import type { Pool } from 'pg'
import type { OrganizationPort } from '@platform/sdk'

type CasdoorLike = { listRoles(): Promise<Array<{ name: string; users?: string[] }>> }

export function createOrganizationPort(deps: {
  pool: Pool
  casdoorFor?: (org: string) => CasdoorLike
}): OrganizationPort {
  const tenantOf = async (org: string): Promise<number | null> => {
    const { rows } = await deps.pool.query<{ id: number }>(
      'select id from platform.tenant where casdoor_org = $1', [org])
    return rows[0]?.id ?? null
  }
  const subtree = async (tenantId: number, extIds: readonly string[]): Promise<string[]> => {
    if (extIds.length === 0) return []
    const { rows } = await deps.pool.query<{ ext_id: string }>(
      `select ext_id from platform.v_org_node
        where tenant_id=$1 and status=1
          and (ext_id = any($2::text[]) or path like any($3::text[]))`,
      [tenantId, [...extIds], extIds.map((e) => `${e}.%`)])
    return rows.map((r) => r.ext_id)
  }
  return {
    async listSubtreeMembers(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      const depts = await subtree(tenantId, extIds); if (depts.length === 0) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select distinct user_name from platform.v_org_membership
          where tenant_id=$1 and ext_id = any($2::text[]) order by user_name`,
        [tenantId, depts])
      return rows.map((r) => r.user_name)
    },
    async listDeptLeaders(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select user_name from platform.v_org_node_leader
          where tenant_id=$1 and node_ext_id = any($2::text[]) order by sort, user_name`,
        [tenantId, [...extIds]])
      return rows.map((r) => r.user_name)
    },
    async listDeptAdmins(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select user_name from platform.v_org_role_binding
          where tenant_id=$1 and node_ext_id = any($2::text[]) and role='dept_admin'
          order by user_name`,
        [tenantId, [...extIds]])
      return rows.map((r) => r.user_name)
    },
    async listRoleMembers(org, role) {
      if (!deps.casdoorFor) return []
      const roles = await deps.casdoorFor(org).listRoles()
      const hit = roles.find((r) => r.name === role)
      return (hit?.users ?? []).map((u) => (u.startsWith(`${org}/`) ? u.slice(org.length + 1) : u))
    },
    async primaryDeptOf(org, userName) {
      const tenantId = await tenantOf(org); if (tenantId === null) return null
      const { rows } = await deps.pool.query<{ ext_id: string }>(
        `select ext_id from platform.v_org_membership
          where tenant_id=$1 and user_name=$2
          order by is_primary desc, ext_id limit 1`, [tenantId, userName])
      return rows[0]?.ext_id ?? null
    },
  }
}
```

- [ ] **Step 5: 注入 loader**

`apps/server/src/loader.ts` 在 `baseCtx` 构造处加：

```ts
const org = createOrganizationPort({ pool: deps.pool, casdoorFor: deps.casdoorFor })
const baseCtx: ModuleContext = { pool: deps.pool, identityLinks, events, addresses, userStatus, org }
```

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run apps/server/src/org-directory.test.ts apps/server/src/loader.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/platform-sdk/src/module.ts apps/server/src/org-directory.ts apps/server/src/loader.ts apps/server/src/org-directory.test.ts
git commit -m "feat(org): 模块组织查询 port（#OA）"
```

---

## Task 3: 事件目录支持 external 生产者

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Modify: `apps/server/src/event-catalog.ts`
- Test: `apps/server/src/event-catalog.test.ts`

**Interfaces:**
- Produces: `NotificationEventDecl.producer?: string`；`CatalogEntry.moduleId = producer ?? module.id`；`source = producer ? 'external' : 'module'`。

- [ ] **Step 1: 写失败测试**

```ts
it('producer 存在时 moduleId 记为 external:<name>，source=external', () => {
  const entries = buildCatalog([{
    id: 'forms',
    notifications: { events: [{
      key: 'forms.approval.awaiting', title: '待审批',
      producer: 'external:case-engine',
      payload: {
        submissionId: { type: 'string', required: true },
        assignee: { type: 'string', required: true },
      },
      recipients: { approver: { kind: 'field', field: 'assignee' } },
    }] },
  }] as never)
  expect(entries[0]).toMatchObject({ moduleId: 'external:case-engine', source: 'external' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/event-catalog.test.ts`
Expected: FAIL（`producer` 不被 schema/构建器识别）。

- [ ] **Step 3: 加字段**

`packages/platform-sdk/src/manifest.ts` 的 `NotificationEventDecl` 加：

```ts
/** 外部生产者（如 case-engine）：存在时事件归属 `external:<name>`，不是声明它的模块。 */
producer?: string
```

- [ ] **Step 4: 改构建器**

`apps/server/src/event-catalog.ts`：

```ts
moduleId: ev.producer ?? m.id,
source: ev.producer ? 'external' : 'module',
```

- [ ] **Step 5: 补 schema 前缀回归测试**

```ts
it('ManifestSchema：external 事件的 key 仍必须以声明模块 id 开头', () => {
  const base = { id: 'forms', name: 'x', version: '0.2.0', platform: '>=0.1', permissions: [], notifications: { events: [] } }
  const ev = { key: 'forms.approval.awaiting', title: 't', producer: 'external:case-engine',
    payload: { submissionId: { type: 'string', required: true } },
    recipients: { approver: { kind: 'field', field: 'assignee' } } }
  expect(ManifestSchema.safeParse({ ...base, notifications: { events: [ev] } }).success).toBe(true)
  expect(ManifestSchema.safeParse({ ...base, notifications: { events: [{ ...ev, key: 'approval.awaiting' }] } }).success).toBe(false)
})
```

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run apps/server/src/event-catalog.test.ts apps/server/src/notify-port.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/platform-sdk/src/manifest.ts apps/server/src/event-catalog.ts apps/server/src/event-catalog.test.ts
git commit -m "feat(notify): 事件声明支持 external 生产者（#OA）"
```

---

## Task 4: forms 内核支持 approval_def + 提交状态列

**Files:**
- Create: `modules/forms/migrations/002_item_platform.sql`
- Modify: `modules/forms/storage.ts`（kind 参数化）
- Test: `modules/forms/kernel.test.ts`（追加）

**Interfaces:**
- Produces: `FormsKind = 'form_def' | 'approval_def'`；所有 storage 生命周期函数新增可选尾参 `kind: FormsKind = 'form_def'`；`forms.submission` 新列 `status/provider/root_submission_id/supersedes_id/case_ref/approval_plan/decided_at/decision_action/decision_comment/withdrawn_at`；`forms.audit`。

- [ ] **Step 1: 写失败测试**

在 `modules/forms/kernel.test.ts` 追加：

```ts
it('approval_def 走同一内核：draft → publish → head', async () => {
  const v = await newDraft(pool, ORG, 'leave', { provider: 'inapp', nodes: [] }, 'u1', 'approval_def')
  await publish(pool, ORG, 'leave', v, 'admin', 'approval_def')
  expect(await headVersion(pool, ORG, 'leave', 'approval_def')).toBe(v)
})

it('form_def 与 approval_def 同 id 互不干扰', async () => {
  await newDraft(pool, ORG, 'x', { schema: {} }, 'u1') // form_def
  await newDraft(pool, ORG, 'x', { provider: 'inapp', nodes: [] }, 'u1', 'approval_def')
  expect(await listVersions(pool, ORG, 'x')).toHaveLength(1) // 默认 kind 只看 form_def
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/kernel.test.ts`
Expected: FAIL（`newDraft` 不接第 6 参 / kind 不存在）。

- [ ] **Step 3: 写迁移**

`modules/forms/migrations/002_item_platform.sql`：

```sql
-- 002 — 事项平台：审批模板 kind、提交状态、审计。
insert into forms.kind (kind, publish_policy, note)
values ('approval_def', 'human_gate', '审批模板：inapp 链 DSL / wecom_native 绑定')
on conflict (kind) do update set publish_policy = excluded.publish_policy, note = excluded.note;

alter table forms.submission add column if not exists status text not null default 'submitted';
alter table forms.submission add column if not exists provider text;
alter table forms.submission add column if not exists root_submission_id bigint;
alter table forms.submission add column if not exists supersedes_id bigint;
alter table forms.submission add column if not exists case_ref text;
alter table forms.submission add column if not exists approval_plan jsonb;
alter table forms.submission add column if not exists decided_at timestamptz;
alter table forms.submission add column if not exists decision_action text;
alter table forms.submission add column if not exists decision_comment text;
alter table forms.submission add column if not exists withdrawn_at timestamptz;

alter table forms.submission drop constraint if exists forms_submission_status_check;
alter table forms.submission add constraint forms_submission_status_check
  check (status in ('submitted','pending_approval','approved','rejected','withdrawn'));

create index if not exists idx_forms_submission_pending
  on forms.submission (org, status, submitted_at desc)
  where status = 'pending_approval';

create table if not exists forms.audit (
  id bigserial primary key,
  org text not null,
  actor text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index if not exists idx_forms_audit_org_at on forms.audit (org, at desc);
```

- [ ] **Step 4: kind 参数化**

`modules/forms/storage.ts`：

```ts
export type FormsKind = 'form_def' | 'approval_def'
const DEFAULT_KIND: FormsKind = 'form_def'
```

把每个生命周期函数（`newDraft/updateDraft/dropDraft/publish/rollbackTo/retire/headVersion/bodyAt/assetExists/listVersions/listDefs/submit/listSubmissions`）的 `KIND` 换成可选尾参：

```ts
export async function newDraft(
  pool: Pool, org: string, assetId: string, body: unknown, actor: string,
  kind: FormsKind = DEFAULT_KIND,
): Promise<number> {
  const { rows } = await pool.query('select forms.new_draft($1,$2,$3,$4,$5) v', [
    org, kind, assetId, JSON.stringify(body ?? null), actor,
  ])
  return rows[0].v
}
```

> `listAssignmentTargets` 保持只看 `form_def`（收集类）；不要给它加 kind 参数。

同时加审计写入：

```ts
export async function audit(
  pool: Pool, org: string, actor: string, action: string, target: string | null, detail: unknown,
): Promise<void> {
  await pool.query(
    `insert into forms.audit (org, actor, action, target, detail) values ($1,$2,$3,$4,$5::jsonb)`,
    [org, actor, action, target, JSON.stringify(detail ?? {})])
}
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run modules/forms/kernel.test.ts modules/forms/routes.test.ts modules/forms/dict.test.ts`
Expected: PASS（既有 form_def 行为不变）。

- [ ] **Step 6: 提交**

```bash
git add modules/forms/migrations/002_item_platform.sql modules/forms/storage.ts modules/forms/kernel.test.ts
git commit -m "feat(forms): 受管数据集支持 approval_def 与提交状态（#OA）"
```

---

## Task 5: org→engine 映射 + OA 开关

**Files:**
- Create: `apps/server/src/migrations/019_oa_engine.sql`
- Create: `apps/server/src/oa-engine.ts`
- Test: `apps/server/src/oa-engine.test.ts`

**Interfaces:**
- Produces: `platform.oa_engine(org,base_url,pat_secret_ref,engine_version,enabled)`；`createOaEngineStore(pool).get(org)` / `.upsert(cfg)`；`OaEngineConfig`。

- [ ] **Step 1: 写失败测试**

```ts
it('无映射 = null（OA 对该租户关闭）', async () => {
  const store = createOaEngineStore(pool)
  expect(await store.get('acme')).toBeNull()
})
it('upsert 后可读且 enabled 生效', async () => {
  const store = createOaEngineStore(pool)
  await store.upsert({ org: 'acme', baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: '0.3.0', enabled: true })
  expect(await store.get('acme')).toMatchObject({ baseUrl: 'http://engine:3100', enabled: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/oa-engine.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 迁移**

`apps/server/src/migrations/019_oa_engine.sql`：

```sql
-- 019 — OA 引擎映射：平台的唯一登记点；无行 = 该租户 OA 关闭。
create table if not exists platform.oa_engine (
  org            text primary key,
  base_url       text not null,
  pat_secret_ref text not null,
  engine_version text,
  enabled        boolean not null default true,
  updated_at     timestamptz not null default now()
);
```

- [ ] **Step 4: 实现**

`apps/server/src/oa-engine.ts`：

```ts
import type { Pool } from 'pg'

export interface OaEngineConfig {
  org: string; baseUrl: string; patSecretRef: string
  engineVersion: string | null; enabled: boolean
}
export function createOaEngineStore(pool: Pool) {
  return {
    async get(org: string): Promise<OaEngineConfig | null> {
      const { rows } = await pool.query(
        `select org, base_url, pat_secret_ref, engine_version, enabled
           from platform.oa_engine where org=$1 and enabled`, [org])
      const r = rows[0]
      return r ? { org: r.org, baseUrl: r.base_url, patSecretRef: r.pat_secret_ref,
        engineVersion: r.engine_version, enabled: r.enabled } : null
    },
    async upsert(c: OaEngineConfig): Promise<void> {
      await pool.query(
        `insert into platform.oa_engine (org, base_url, pat_secret_ref, engine_version, enabled, updated_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (org) do update set base_url=excluded.base_url,
           pat_secret_ref=excluded.pat_secret_ref, engine_version=excluded.engine_version,
           enabled=excluded.enabled, updated_at=now()`,
        [c.org, c.baseUrl, c.patSecretRef, c.engineVersion, c.enabled])
    },
  }
}
```

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm vitest run apps/server/src/oa-engine.test.ts`
Expected: PASS。

```bash
git add apps/server/src/migrations/019_oa_engine.sql apps/server/src/oa-engine.ts apps/server/src/oa-engine.test.ts
git commit -m "feat(oa): org→引擎映射与租户开关（#OA）"
```

---

## Task 6: case-engine P0 契约（external_ref / 查询 / capabilities / withdraw）

**Files:**
- Create: `core/migrations/004_oa_contract.sql`
- Modify: `core/engine/src/trace.ts`（`CaseRepo` + Pg 实现）
- Modify: `core/engine/src/guardrail.ts`（`CaseInput` 加 `externalRef?` / `plan?`）
- Modify: `core/engine/src/repo-memory.ts`
- Modify: `core/engine/src/mastra.ts`（路由）
- Test: `core/engine/__tests__/oa-contract.test.ts`

**Interfaces:**
- Produces: `CaseRepo.createCase(input & { externalRef?: string; plan?: unknown })`；`getByExternalRef(ref)`；`listCases(filter: { assignee?: string; status?: CaseStatus; updatedSince?: string; limit?: number })`；`withdraw(caseId, actor, reason): Promise<'ok'|'already-decided'|'not-found'>`；`recordNodeDecision(caseId, nodeKey, approver, action, comment): Promise<boolean>`；`listNodeDecisions(caseId)`；`GET /capabilities`；`POST /cases/:id/withdraw`。
- **节点决策不能塞进 `case_events`**：`case_events.seq` 是按事件类型固定的（每 case 每 type 一条），多节点/多审批人会撞 seq。用独立表 `case_node_decisions`，主键保证同节点同人只落一次（幂等）。

- [ ] **Step 1: 写失败测试**

```ts
it('externalRef 幂等：重复 createCase 返回同一 id', async () => {
  const repo = new InMemoryCaseRepo()
  const a = await repo.createCase({ title: 't', externalRef: 'forms:submission:1' } as never)
  const b = await repo.createCase({ title: 't', externalRef: 'forms:submission:1' } as never)
  expect(b).toBe(a)
})

it('listCases 按 assignee + status 过滤', async () => {
  const repo = new InMemoryCaseRepo()
  const id = await repo.createCase({ title: 't' })
  await repo.setStatus(id, 'gate'); await repo.setAssignee(id, 'u1', 'medium')
  expect((await repo.listCases({ assignee: 'u1', status: 'gate' })).map(c => c.id)).toEqual([id])
})

it('withdraw 仅在没有决策事件时允许', async () => {
  const repo = new InMemoryCaseRepo()
  const id = await repo.createCase({ title: 't' })
  await repo.appendEvent(id, 'gate', { action: 'approve' }, 'u1')
  expect(await repo.withdraw(id, 'u0', '撤回')).toBe('already-decided')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run core/engine/__tests__/oa-contract.test.ts`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 迁移**

`core/migrations/004_oa_contract.sql`：

```sql
alter table cases add column if not exists external_ref text;
create unique index if not exists cases_external_ref_uq
  on cases (external_ref) where external_ref is not null;
alter table cases add column if not exists plan jsonb;

create table if not exists case_node_decisions (
  case_id   uuid not null references cases(id),
  node_key  text not null,
  approver  text not null,
  action    text not null check (action in ('approve','reject','reassign','veto')),
  comment   text,
  at        timestamptz not null default now(),
  primary key (case_id, node_key, approver)
);
create index if not exists idx_case_node_decisions_case on case_node_decisions (case_id, node_key);
```

- [ ] **Step 4: 扩展 CaseRepo/Pg/InMemory**

`core/engine/src/guardrail.ts` 的 `CaseInput` 加两个可选字段（不要新建第二个 `CaseInput` 类型）：

```ts
export type CaseInput = {
  title: string; description?: string; dept?: string
  priority?: 'low' | 'medium' | 'high'; requesterId?: string; source?: string
  /** OA 契约：入口幂等键（forms:submission:<id>） */
  externalRef?: string
  /** OA 契约：平台编译的审批计划快照（inapp） */
  plan?: unknown
}
```

在 `trace.ts` 的 `CaseRepo` 加方法签名；在 `repo-memory.ts` 与 Pg 实现里落地。`recordNodeDecision` 用 `on conflict (case_id,node_key,approver) do nothing`，返回是否真插入（供 quorum 计数，避免重放重复计数）。

Pg `createCase`：先 `select id from cases where external_ref=$1`，命中直接返回；否则 INSERT 带 `external_ref/plan`；并发冲突（unique violation）再查一次返回。

- [ ] **Step 5: 路由**

`mastra.ts` 加：

```ts
registerApiRoute('/capabilities', { method: 'GET', handler: async c =>
  c.json({ planVersion: 1, engineVersion: process.env.ENGINE_VERSION ?? 'dev',
    providers: ['inapp'], features: ['nodeLoop', 'quorum', 'nodeSla', 'collab'] }) })

registerApiRoute('/cases/:id/withdraw', { method: 'POST', handler: async c => {
  const out = await repo.withdraw(c.req.param('id'), body.actor, body.reason)
  if (out === 'not-found') return c.json({ error: 'not found' }, 404)
  if (out === 'already-decided') return c.json({ error: 'already decided' }, 409)
  return c.json({ ok: true })
} })
```

`GET /cases` 现有 handler 只认 `attention=1`；扩展为：无查询参数或 `externalRef/assignee/status` 时走 `repo.listCases`，保留 `attention=1` 原路径。`GET /cases/:id` 响应追加 `plan`、`currentNode`（由 plan + node decisions 推导）、`nodeDecisions`。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run core/engine/__tests__/oa-contract.test.ts core/engine/__tests__/cases-routes.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add core/migrations/004_oa_contract.sql core/engine/src/trace.ts core/engine/src/repo-memory.ts core/engine/src/mastra.ts core/engine/__tests__/oa-contract.test.ts
git commit -m "feat(engine): OA 契约 P0——external_ref/查询/capabilities/withdraw（#OA）"
```

---

## Task 7: 审批 DSL 校验器（纯函数）

**Files:**
- Create: `modules/forms/domain/approval.ts`
- Test: `modules/forms/domain/approval.test.ts`

**Interfaces:**
- Produces: `ApprovalBody` / `ApprovalNode` / `ApproverSource` / `validateApprovalBody(body): { ok: true; body } | { ok: false; code; detail }`。

- [ ] **Step 1: 写失败测试**

```ts
it('合法 DSL 通过，默认值补齐', () => {
  const r = validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }] }] })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.body.rejectionPolicy).toBe('first_reject_ends')
})
it('空 nodes 拒绝', () => {
  expect(validateApprovalBody({ provider: 'inapp', nodes: [] })).toMatchObject({ ok: false, code: 'NODES_EMPTY' })
})
it('quorum n 超过来源上限无法在编译期判，但 n<1 拒绝', () => {
  expect(validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], quorum: { n: 0 } }] }))
    .toMatchObject({ ok: false, code: 'QUORUM_INVALID' })
})
it('未知 approver source 拒绝', () => {
  expect(validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'a', title: 'A', approvers: [{ source: 'boss' }] }] }))
    .toMatchObject({ ok: false, code: 'APPROVER_SOURCE_UNKNOWN' })
})
it('P1 明确拒绝 block_runtime / auto_approve / all_must_decide（不静默降级）', () => {
  expect(validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], onTimeout: 'auto_approve' }] }))
    .toMatchObject({ ok: false, code: 'AUTO_APPROVE_UNSUPPORTED' })
  expect(validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }] }], emptyNode: 'block_runtime' }))
    .toMatchObject({ ok: false, code: 'EMPTY_NODE_MODE_UNSUPPORTED' })
  expect(validateApprovalBody({ provider: 'inapp', nodes: [{
    key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }] }], rejectionPolicy: 'all_must_decide' }))
    .toMatchObject({ ok: false, code: 'REJECTION_POLICY_UNSUPPORTED' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/approval.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`modules/forms/domain/approval.ts`：

```ts
export type ApproverSource =
  | { source: 'user'; users: string[] }
  | { source: 'role'; role: string }
  | { source: 'dept_members'; deptExtId?: string }
  | { source: 'dept_leader'; deptExtId?: string }
  | { source: 'dept_admin'; deptExtId?: string }
  | { source: 'field'; field: string }

export interface ApprovalNode {
  key: string; title: string; approvers: ApproverSource[]
  quorum: 'all' | 'any' | { n: number }
  slaHours?: number
  onTimeout?: 'escalate' | 'notify' | 'auto_approve'
  escalateTo?: ApproverSource[]
}
export interface ApprovalBody {
  provider: 'inapp'
  nodes: ApprovalNode[]
  conditions?: Array<{ when: { field: string; op: 'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'in'; value: unknown }; addNode: ApprovalNode }>
  rejectionPolicy: 'first_reject_ends' | 'all_must_decide'
  selfApproval: 'skip' | 'allow' | 'forbid'
  dedupe: 'first_occurrence' | 'allow_repeat'
  emptyNode: 'block_publish' | 'block_runtime'
}

const SOURCES = new Set(['user','role','dept_members','dept_leader','dept_admin','field'])
const KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/

export function validateApprovalBody(input: unknown):
  { ok: true; body: ApprovalBody } | { ok: false; code: string; detail: string } {
  const b = input as Record<string, unknown>
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail('BODY_NOT_OBJECT', '审批模板 body 必须是对象')
  if (b.provider !== 'inapp') return fail('PROVIDER_INVALID', 'provider 必须是 inapp（wecom_native 走绑定）')
  const nodes = b.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return fail('NODES_EMPTY', '至少一个节点')
  const keys = new Set<string>()
  for (const n of nodes) {
    if (!n || typeof n !== 'object') return fail('NODE_INVALID', '节点必须是对象')
    const node = n as Record<string, unknown>
    if (typeof node.key !== 'string' || !KEY_RE.test(node.key)) return fail('NODE_KEY_INVALID', 'node.key 必须匹配 ^[a-z][a-z0-9_-]{0,63}$')
    if (keys.has(node.key)) return fail('NODE_KEY_DUP', `节点 key 重复：${node.key}`)
    keys.add(node.key)
    if (typeof node.title !== 'string' || !node.title.trim()) return fail('NODE_TITLE_REQUIRED', '节点标题必填')
    if (!Array.isArray(node.approvers) || node.approvers.length === 0) return fail('APPROVERS_EMPTY', 'approvers 不能为空')
    for (const s of node.approvers) {
      const src = (s as Record<string, unknown>)?.source
      if (typeof src !== 'string' || !SOURCES.has(src)) return fail('APPROVER_SOURCE_UNKNOWN', `未知来源：${String(src)}`)
      if (src === 'user' && (!Array.isArray((s as any).users) || (s as any).users.length === 0)) return fail('APPROVER_USERS_EMPTY', 'user 来源必须有 users')
      if (src === 'role' && typeof (s as any).role !== 'string') return fail('APPROVER_ROLE_REQUIRED', 'role 来源必须有 role')
      if (src === 'field' && typeof (s as any).field !== 'string') return fail('APPROVER_FIELD_REQUIRED', 'field 来源必须有 field')
    }
    const q = node.quorum
    if (q !== undefined && q !== 'all' && q !== 'any') {
      const n2 = (q as { n?: unknown })?.n
      if (typeof n2 !== 'number' || !Number.isInteger(n2) || n2 < 1) return fail('QUORUM_INVALID', 'quorum.n 必须是 >=1 的整数')
    }
    if (node.slaHours !== undefined && (typeof node.slaHours !== 'number' || node.slaHours <= 0)) return fail('SLA_INVALID', 'slaHours 必须 >0')
    if (node.onTimeout === 'auto_approve') return fail('AUTO_APPROVE_UNSUPPORTED', 'P1 不支持自动通过；请用 escalate/notify')
  }
  if (b.emptyNode === 'block_runtime') return fail('EMPTY_NODE_MODE_UNSUPPORTED', 'P1 只支持 block_publish；运行时阻塞在 P2 开')
  if (b.rejectionPolicy === 'all_must_decide') return fail('REJECTION_POLICY_UNSUPPORTED', 'P1 只支持 first_reject_ends；all_must_decide 与 deriveCurrentNode 契约冲突，P2 再开')
  return { ok: true, body: {
    provider: 'inapp', nodes: nodes as ApprovalNode[],
    conditions: (b.conditions as ApprovalBody['conditions']) ?? [],
    rejectionPolicy: (b.rejectionPolicy as ApprovalBody['rejectionPolicy']) ?? 'first_reject_ends',
    selfApproval: (b.selfApproval as ApprovalBody['selfApproval']) ?? 'skip',
    dedupe: (b.dedupe as ApprovalBody['dedupe']) ?? 'first_occurrence',
    emptyNode: (b.emptyNode as ApprovalBody['emptyNode']) ?? 'block_publish',
  } }
}
function fail(code: string, detail: string) { return { ok: false as const, code, detail } }
```

- [ ] **Step 4: 跑测试并提交**

Run: `pnpm vitest run modules/forms/domain/approval.test.ts`
Expected: PASS。

```bash
git add modules/forms/domain/approval.ts modules/forms/domain/approval.test.ts
git commit -m "feat(forms): 审批模板 DSL 校验器（#OA）"
```

---

## Task 8: 计划编译器 + dry-run

**Files:**
- Create: `modules/forms/domain/approval-compile.ts`
- Test: `modules/forms/domain/approval-compile.test.ts`

**Interfaces:**
- Produces: `compilePlan(input, orgPort): Promise<ApprovalPlan>`；`ApprovalPlan = { templateRef; contractVersion: 1; nodes: PlanNode[]; appliedConditions: string[] }`；`PlanNode = { key; title; approvers: string[]; quorum; slaHours?; onTimeout?; escalateTo: string[] }`；失败抛 `FormsError('APPROVERS_UNRESOLVED'|'EMPTY_NODE'|'QUORUM_EXCEEDS_APPROVERS', detail)`。

- [ ] **Step 1: 写失败测试**

```ts
it('dept_leader 解析成具体人；self 跳过；重复人只保留首个', async () => {
  const plan = await compilePlan({
    org: 'acme', templateRef: { id: 'leave', version: 1 }, requester: 'u1',
    payload: {},
    body: { provider: 'inapp', rejectionPolicy: 'first_reject_ends', selfApproval: 'skip',
      dedupe: 'first_occurrence', emptyNode: 'block_publish',
      nodes: [
        { key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' },
        { key: 'hr', title: 'HR', approvers: [{ source: 'user', users: ['u1'] }], quorum: 'all' },
      ] } as never,
  }, port)
  expect(plan.nodes[0].approvers).toEqual(['u-lead'])
  expect(plan.nodes[1].approvers).toEqual([]) // self 剔除后为空
  expect(plan.appliedConditions).toEqual([])
})
it('条件按金额加节点', async () => {
  const plan = await compilePlan({ org: 'acme', templateRef: { id: 'x', version: 1 }, requester: 'u1',
    payload: { amount: 6000 }, body: withAmountCondition }, port)
  expect(plan.nodes.map(n => n.key)).toEqual(['leader', 'cfo'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/approval-compile.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`approval-compile.ts` 核心：

```ts
export async function compilePlan(
  input: { org: string; templateRef: { id: string; version: number }; requester: string
    payload: Record<string, unknown>; body: ApprovalBody },
  orgPort: OrganizationPort,
): Promise<ApprovalPlan> {
  const ctx = { ...input, primaryDept: await orgPort.primaryDeptOf(input.org, input.requester) }
  const nodes: PlanNode[] = []
  for (const n of input.body.nodes) nodes.push(await resolveNode(n, ctx, orgPort, nodes))
  for (const c of input.body.conditions ?? []) {
    if (evalCondition(c.when, input.payload)) nodes.push(await resolveNode(c.addNode, ctx, orgPort, nodes))
  }
  const kept = nodes.filter((n) => n.approvers.length > 0)
  if (kept.length === 0) throw new FormsError('EMPTY_NODE', '所有节点解析后为空')
  for (const n of kept) {
    if (typeof n.quorum === 'object' && n.quorum.n > n.approvers.length)
      throw new FormsError('QUORUM_EXCEEDS_APPROVERS', `${n.key}: n=${n.quorum.n} > ${n.approvers.length}`)
  }
  return { templateRef: input.templateRef, contractVersion: 1, nodes: kept,
    appliedConditions: (input.body.conditions ?? []).filter(c => evalCondition(c.when, input.payload)).map(c => c.addNode.key) }
}
```

`resolveNode`：逐个 source 解析 → 合并去重（`dedupe`）→ 剔除 requester（`selfApproval='skip'`）。`dept_leader/dept_members/dept_admin` 缺省用 `primaryDept`；缺失抛 `APPROVERS_UNRESOLVED`。

- [ ] **Step 4: 跑测试并提交**

Run: `pnpm vitest run modules/forms/domain/approval-compile.test.ts`
Expected: PASS。

```bash
git add modules/forms/domain/approval-compile.ts modules/forms/domain/approval-compile.test.ts
git commit -m "feat(forms): 审批计划编译器与 dry-run（#OA）"
```

---

## Task 9: 审批模板路由 + 发布门

**Files:**
- Modify: `modules/forms/routes.ts`
- Modify: `modules/forms/storage.ts`（`audit` 写入）
- Modify: `modules/forms/manifest.yaml`
- Test: `modules/forms/routes.test.ts`（追加）

**Interfaces:**
- Produces endpoints（全部在 `/api/modules/forms` 下）：`GET/POST /approval-defs`、`GET /approval-defs/:id`、`PUT/DELETE /approval-defs/:id/versions/:v`、`POST /approval-defs/:id/versions/:v/publish`、`POST /approval-defs/:id/dry-run`。
- 权限码新增：`forms:approval:view`、`forms:approval:manage`、`forms:approval:publish`。

- [ ] **Step 1: 写失败测试**

在 `modules/forms/routes.test.ts` 追加（复用该文件既有的 `makeApp` / `post` / 身份夹具与 `jsonResponse`）：

```ts
it('POST /approval-defs 建草稿（manage）；publish 前 dry-run 必过', async () => {
  const app = makeApp()
  await post(app, '/api/modules/forms/approval-defs', { assetId: 'leave', body: validBody }, MANAGER)
    .expect(201)
  const dry = await post(app, '/api/modules/forms/approval-defs/leave/dry-run',
    { payload: {}, requester: 'u1' }, MANAGER).expect(200)
  expect(dry.body.plan.nodes[0].key).toBe('leader')
  await post(app, '/api/modules/forms/approval-defs/leave/versions/1/publish', {}, PUBLISHER).expect(200)
})
it('dry-run 失败 ⇒ publish 409 且不写入 head', async () => {
  // 无负责人夹具：dept_leader 解析为空
  await post(app, '/api/modules/forms/approval-defs/leave/versions/1/publish', {}, PUBLISHER).expect(409)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/routes.test.ts`
Expected: FAIL（404）。

- [ ] **Step 3: 实现路由**

`createFormsRouter` 的签名加 `org?: OrganizationPort`（T10 会从 `index.ts` 注入），供 dry-run / publish 编译使用。在 `routes.ts` 加一组薄路由，复用 `store.newDraft/updateDraft/publish/...` 并传 `'approval_def'`。发布前：

```ts
const body = await store.bodyAt(pool, org, assetId, version, 'approval_def')
const parsed = validateApprovalBody(body)
if (!parsed.ok) return fail(c, 400, parsed.code, parsed.detail)
// 用调用方给的样例跑 dry-run；未给样例 ⇒ 用 {} + 当前用户
const plan = await compilePlan({ org, templateRef: { id: assetId, version },
  requester: identity.userId, payload: samplePayload ?? {}, body: parsed.body }, orgPort)
await store.publish(..., 'approval_def')
await store.audit(pool, org, identity.userId, 'approval.publish', assetId, { version, plan })
```

`dry-run` 路由只读，返回 `{ plan }`，不写库。

- [ ] **Step 4: manifest 声明**

`modules/forms/manifest.yaml` 增加权限码与 `api.internal` 条目，并**逐条与 createRouter 注册集合一致**（否则装载失败）。示例：

```yaml
  - { code: forms:approval:view,    name: 审批模板查看 }
  - { code: forms:approval:manage,  name: 审批模板起草与编辑 }
  - { code: forms:approval:publish, name: 审批模板发布（人 gate） }
api:
  internal:
    - { method: GET,    path: /approval-defs,                              scope: forms:approval:view }
    - { method: GET,    path: /approval-defs/:assetId,                     scope: forms:approval:view }
    - { method: POST,   path: /approval-defs,                              scope: forms:approval:manage }
    - { method: PUT,    path: /approval-defs/:assetId/versions/:v,         scope: forms:approval:manage }
    - { method: DELETE, path: /approval-defs/:assetId/versions/:v,         scope: forms:approval:manage }
    - { method: POST,   path: /approval-defs/:assetId/dry-run,             scope: forms:approval:manage }
    - { method: POST,   path: /approval-defs/:assetId/versions/:v/publish, scope: forms:approval:publish }
```

- [ ] **Step 5: 跑测试与装载冒烟**

Run: `pnpm vitest run modules/forms/routes.test.ts modules/forms/module.test.ts`
Expected: PASS。
Run: `pnpm smoke`
Expected: PASS（装载期双向核对通过）。

- [ ] **Step 6: 提交**

```bash
git add modules/forms/routes.ts modules/forms/storage.ts modules/forms/manifest.yaml modules/forms/routes.test.ts
git commit -m "feat(forms): 审批模板路由与发布 dry-run 门（#OA）"
```

---

## Task 10: 提交 → 编译 → 建 case（engine client）

**Files:**
- Create: `modules/forms/domain/engine-client.ts`
- Modify: `modules/forms/storage.ts`（`submitApproval`）
- Modify: `modules/forms/routes.ts`（`/defs/:assetId/submissions` 分流）
- Modify: `modules/forms/index.ts`（注入 `org` port）
- Test: `modules/forms/domain/engine-client.test.ts`、`modules/forms/routes.test.ts`

**Interfaces:**
- Produces: `createEngineClient({ baseUrl, pat, fetchFn? })` → `{ createCase, getCase, listCases, withdraw }`；`submitApproval(pool, org, assetId, payload, userId, deps)`。
- `createFormsRouter` 签名扩展为 `{ pool, org?: OrganizationPort, notify?: NotifyPort, chatModel? }`。

- [ ] **Step 1: 写失败测试**

```ts
it('createCase 发 Bearer + JSON，返回 caseId', async () => {
  const calls: any[] = []
  const client = createEngineClient({ baseUrl: 'http://e', pat: 'p',
    fetchFn: (async (url, init) => { calls.push({ url, init }); return json({ caseId: 'c1', runId: 'r1' }, 201) }) as never })
  expect(await client.createCase({ org: 'acme', externalRef: 'forms:submission:1' } as never)).toEqual({ caseId: 'c1', runId: 'r1' })
  expect(calls[0].url).toBe('http://e/cases')
  expect(calls[0].init.headers.Authorization).toBe('Bearer p')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/engine-client.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 client**

`engine-client.ts`：

```ts
export function createEngineClient(cfg: { baseUrl: string; pat: string; fetchFn?: typeof fetch }) {
  const f = cfg.fetchFn ?? fetch
  const call = async (path: string, init?: RequestInit) => {
    const res = await f(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.pat}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new FormsError('ENGINE_HTTP_ERROR', `${res.status} ${JSON.stringify(body)}`)
    return body
  }
  return {
    createCase: (body: unknown) => call('/cases', { method: 'POST', body: JSON.stringify(body) }),
    getCase: (id: string) => call(`/cases/${encodeURIComponent(id)}`),
    listCases: (q: Record<string, string>) => call(`/cases?${new URLSearchParams(q)}`),
    withdraw: (id: string, body: unknown) => call(`/cases/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: JSON.stringify(body) }),
  }
}
```

- [ ] **Step 4: 提交分流与模块装配**

`modules/forms/index.ts` 改为把组织 port 与 notify 一起注入：

```ts
export default defineModule({
  manifest,
  createRouter: ({ pool, org, notify }) => createFormsRouter({ pool, org, notify, chatModel }),
})
```

`storage.submit` 读 body 后：
- `mode === 'approval'`：走 `submitApproval`（校验 + 编译 + 建 case）；否则保持现有 collection 路径逐字不变。
- 新 `submitApproval`：
  1. 解析 `approvalRef`，读审批模板 published 版本，`validateApprovalBody`；
  2. `compilePlan`；
  3. `insert into forms.submission (..., status='pending_approval', provider='inapp', approval_plan=$plan) returning id`；
  4. `client.createCase({ org, externalRef: 'forms:submission:<id>', planVersion: 1, provider: 'inapp', type: 'approval', title, requesterId, payload, plan })`；
  5. `update forms.submission set case_ref=$caseId where id=$id`。
  - **失败补偿**：建 case 失败 ⇒ 把 submission 标 `withdrawn` 并写审计（不留 pending 孤儿）；返回 502。
- 撤回路由（scope `forms:fill`，数据授权 = 仅提交人 + 仅 pending）：
  `POST /submissions/:id/withdraw` → `client.withdraw(caseRef, { org, actor, reason })` → `update ... status='withdrawn', withdrawn_at=now() where id=$1 and status='pending_approval' and submitted_by=$2`；引擎 409（已有决策）原样映射 409。
- 平台侧**经宿主注入的 `OaEnginePort`** 取配置（`ctx.oaEngine.get(org)`，读 `platform.oa_engine` 并把 `pat_secret_ref` 解析成 secret；**不要用 per-org env map**——多租户下一个进程服务多 org，env 表达不了）。无映射/secret 缺失 ⇒ 409 `OA_NOT_ENABLED`，fail-closed。

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run modules/forms/domain/engine-client.test.ts modules/forms/routes.test.ts`
Expected: PASS。用 fake fetch 断言提交后 `case_ref` 写入。

- [ ] **Step 6: 提交**

```bash
git add modules/forms/domain/engine-client.ts modules/forms/storage.ts modules/forms/routes.ts modules/forms/index.ts modules/forms/domain/engine-client.test.ts modules/forms/routes.test.ts
git commit -m "feat(forms): 审批提交编译计划并创建引擎 case（#OA）"
```

---

## Task 11: 回调 + 对账（状态回写幂等）

**Files:**
- Modify: `modules/forms/routes.ts`（`POST /approval-callback`）
- Create: `scripts/oa-approval-reconcile.mjs`
- Test: `modules/forms/routes.test.ts`（回调）、`scripts/oa-approval-reconcile.test.mjs`（若 scripts 有测试模式；无则用 `pnpm test:guard`）

**Interfaces:**
- Produces: `POST /api/modules/forms/approval-callback`（scope `forms:case:callback`）；`scripts/oa-approval-reconcile.mjs` 小时级补偿。

- [ ] **Step 1: 写失败测试**

```ts
it('回调幂等：重复 final 只写一次', async () => {
  const app = makeApp()
  await post(app, '/api/modules/forms/approval-callback',
    { org: 'acme', caseId: 'c1', externalRef: 'forms:submission:1', final: true, action: 'approved', decidedBy: 'u1', decidedAt: '2026-11-16T00:00:00Z' }, SERVICE).expect(200)
  const s1 = await getSubmission(pool, 'acme', '1')
  await post(app, '/api/modules/forms/approval-callback', sameBody, SERVICE).expect(200)
  const s2 = await getSubmission(pool, 'acme', '1')
  expect(s2.status).toBe('approved'); expect(s2.decidedAt).toEqual(s1.decidedAt)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/routes.test.ts`
Expected: FAIL（404）。

- [ ] **Step 3: 实现回调**

```ts
r.post('/approval-callback', (c) => handle(c, async () => {
  const { identity } = ctx(c)
  const body = await c.req.json()
  if (body.org !== identity.orgId) return fail(c, 403, 'ORG_MISMATCH')
  const { rows } = await pool.query(
    `update forms.submission
        set status = $3, decided_at = $4, decision_action = $3, decision_comment = $5
      where org=$1 and case_ref=$2 and status='pending_approval'
      returning id`, [identity.orgId, body.caseId,
        body.action === 'approved' ? 'approved' : body.action === 'withdrawn' ? 'withdrawn' : 'rejected',
        body.decidedAt, body.comment ?? null])
  if (rows.length === 0) return c.json({ ok: true, deduped: true })
  const link = body.link ?? `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/m/oa/${body.caseId}`
  await notify?.emit(identity, {
    eventKey: 'forms.approval.decided',
    eventId: `forms:submission:${rows[0].id}:decided`,
    scope: body.caseId,
    payload: {
      submissionId: String(rows[0].id), caseId: body.caseId, action: body.action,
      decidedBy: body.decidedBy, decidedAt: body.decidedAt,
      submitter: body.submitter ?? '', link,
    },
  })
  return c.json({ ok: true })
}))
```

- [ ] **Step 4: manifest 声明**

`approval-callback` 加 `api.internal`，scope `forms:case:callback`；新增权限码 `forms:case:callback`（服务账号专用）。P1 只声明 `forms.approval.awaiting`（`producer: external:case-engine`）与 `forms.approval.decided`（本模块）；`forms.task.assigned` / `forms.case.sla.breach` 随 P4/P1.5 再加。

- [ ] **Step 5: 对账脚本**

`scripts/oa-approval-reconcile.mjs`：

```js
// 读 pending 超 10 分钟的 submission → 逐个 org 取 oa_engine → GET /cases?externalRef=...
// final 则按回调同一 SQL 回写；只更新 status='pending_approval'，天然幂等。
```

Run: `node scripts/oa-approval-reconcile.mjs --dry-run`
Expected: 打印候选数与回写数，不写库。

- [ ] **Step 6: 跑测试并提交**

Run: `pnpm vitest run modules/forms/routes.test.ts`
Run: `pnpm test:guard`
Expected: PASS。

```bash
git add modules/forms/routes.ts modules/forms/manifest.yaml scripts/oa-approval-reconcile.mjs modules/forms/routes.test.ts
git commit -m "feat(forms): 审批回调与对账（#OA）"
```

---

## Task 12: 应用内审批 UI（响应式 console 页）

**Files:**
- Create: `modules/forms/console/Approvals.tsx`
- Create: `modules/forms/console/ApprovalDetail.tsx`
- Modify: `modules/forms/console/index.tsx`（加 tab）
- Modify: `modules/forms/console/api.ts`（新增调用）
- Test: `modules/forms/console/console.test.tsx`

**Interfaces:**
- Consumes: `GET /approvals/mine`、`GET /approvals/:caseId`、`POST /approvals/:caseId/decision`（T10/T11 的路由，需同任务补：`routes.ts` 增加三条代理端点）。
- Produces: 响应式页面（移动浏览器直接可用；独立 `/m` 移动壳接入后置）。

- [ ] **Step 1: 写失败测试**

```tsx
it('待审批列表渲染标题与发起人', async () => {
  platformFetchMock.mockImplementation(async (input: string) => {
    if (input === '/api/modules/forms/approvals/mine') {
      return jsonResponse({ approvals: [{ caseId: 'c1', title: '请假 - 张三', requester: '张三', nodeTitle: '直属主管' }] })
    }
    throw new Error('unexpected platformFetch: ' + input)
  })
  renderAt('/console/forms/approvals', ['forms:view'])
  expect(await screen.findByText('请假 - 张三')).toBeTruthy()
})
it('详情页拒绝必须填意见；通过不需要', async () => {
  // mock GET /approvals/c1；断言 reject 按钮在意见为空时 disabled，approve 不 disabled
})
```

> 使用本文件既有的 `platformFetchMock` / `jsonResponse` / `renderAt`，不引入 msw。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/console/console.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现代理端点**

在 `routes.ts` 加，并同步在 `manifest.yaml` 的 `api.internal` 逐条声明（装载期双向核对，漏一条即装载失败）。**scope 用宽档 + 数据授权收窄**——审批人是普通员工，不该要求额外授权：
- `GET /approvals/mine`、`GET /approvals/:caseId` → scope `forms:view`；数据授权：当前节点审批人 / 发起人 / 部门管理员。
- `POST /approvals/:caseId/decision` → scope `forms:fill`；数据授权：只有计划快照里当前节点的审批人能过。
- `POST /submissions/:id/withdraw` → scope `forms:fill`；数据授权：仅提交人 + 仅 pending。

```ts
GET  /approvals/mine        // 查 pending_approval 的 submission，按 approval_plan 节点含 identity.userId 过滤
GET  /approvals/:caseId     // 按 case_ref 找 submission；authz：当前节点审批人/发起人/部门管理员；再 GET engine /cases/:id
POST /approvals/:caseId/decision // authz 同 detail；当前节点校验；调 engine POST /cases/:id/decision
```

- [ ] **Step 4: 实现页面**

`Approvals.tsx`：表格式列表（标题/发起人/当前节点/提交时间/动作），antd `Table` + 移动端 `List` 二选一按 `useMediaQuery`（或 CSS 断点）；空态两种（无待办 / 加载失败）。
`ApprovalDetail.tsx`：字段只读渲染（复用 `FillForm` 的 RJSF 只读模式）、当前节点、历史事件（引擎返回）、动作按钮；`reject` 弹意见输入，空则禁用。

- [ ] **Step 5: 跑测试与构建**

Run: `pnpm vitest run modules/forms/console/console.test.tsx`
Run: `pnpm build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add modules/forms/console/Approvals.tsx modules/forms/console/ApprovalDetail.tsx modules/forms/console/index.tsx modules/forms/console/api.ts modules/forms/console/console.test.tsx modules/forms/routes.ts
git commit -m "feat(forms): 应用内审批列表与详情（#OA）"
```

---

## Task 13: case-engine 应用内审批链（inapp gate + 节点循环）

**Files:**
- Create: `core/decision-gate/src/inapp.ts`
- Create: `core/workflows/case-approval.ts`
- Modify: `core/engine/src/mastra.ts`（注册 workflow + 按 plan 路由）
- Test: `core/engine/__tests__/case-approval.test.ts`

**Interfaces:**
- Produces: `InAppDecisionGate`（`createHumanDecision` 返回本地 ref，不建外部单）；workflow `case-approval`；`POST /cases` 带 `plan` 时走该 workflow。
- Consumes: `plan` = `{ nodes: [{ key, title, approvers: string[], quorum: 'all'|'any'|{n}, slaHours?, onTimeout?, escalateTo? }], rejectionPolicy, selfApproval, dedupe }`。

- [ ] **Step 1: 写失败测试**

新建 `core/engine/__tests__/case-approval.test.ts`，用 `InMemoryCaseRepo` + Mastra 测试装配（照 `case-intake-workflow.test.ts`）定义四个小 helper：`start(plan)` 建 case 并起 run、`decide(caseId, nodeKey, user, action, comment?)` 调 resume、`current(caseId)` 取当前节点、`status(caseId)` 取 case 状态。

```ts
it('顺序节点：第一节点 any 通过后进入第二节点', async () => {
  const run = await start({ nodes: [node('a', ['u1','u2'], 'any'), node('b', ['u3'], 'all')] })
  await decide(run.caseId, 'a', 'u1', 'approve')
  expect(await current(run.caseId)).toBe('b')
  await decide(run.caseId, 'b', 'u3', 'approve')
  expect(await status(run.caseId)).toBe('closed')
})
it('任一 reject 立即终止（first_reject_ends）', async () => {
  const run = await start({ nodes: [node('a', ['u1'], 'all'), node('b', ['u2'], 'all')] })
  await decide(run.caseId, 'a', 'u1', 'reject')
  expect(await status(run.caseId)).toBe('closed')
  expect((await repo.listEvents(run.caseId)).some(e => e.type === 'gate.node.decided')).toBe(true)
})
it('同人重复节点只保留首次；空节点被跳过', async () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run core/engine/__tests__/case-approval.test.ts`
Expected: FAIL（workflow 不存在）。

- [ ] **Step 3: 实现 InAppDecisionGate**

```ts
export class InAppDecisionGate implements DecisionGate {
  readonly provider = 'inapp' as const
  async createHumanDecision(req: HumanDecisionRequest): Promise<DecisionRef> {
    // 不建外部单：ref 即 caseId；挂起由 workflow 负责
    return { provider: 'inapp', externalRef: `inapp:${req.caseId}`, caseId: req.caseId }
  }
  async resolveDecision(): Promise<HumanDecisionResult> {
    throw new Error('inapp 决策走 HTTP 端点，不走 resolveDecision')
  }
}
```

- [ ] **Step 4: 实现 case-approval workflow**

结构（照 `case-intake` 的 `withErrorTrace`/幂等风格）：

```
intake（append intake 事件, status=routing）
  → node（dountil 循环；每次一个节点）
      execute 无 resumeData：
        setStatus('gate'); setAssignee(当前节点第一审批人);
        emit forms.approval.awaiting（逐审批人，eventId 确定性）；
        suspend({ caseId, nodeKey })
      resume：
        recordNodeDecision(caseId, nodeKey, decidedBy, action, comment)   // 独立表，幂等
        校验 action ∈ DECISION_ACTIONS、decidedBy ∈ node.approvers（否则抛错，不静默）
        reject/veto → output { outcome:'reject' }
        quorum 满足 → output { outcome:'next' }
        否则 → 同一节点重新 suspend（保留已表态集合）
  → writeback：approve → setStatus('approved')；reject → closeCase('reject')；
              oaCallback.finalize({ org, caseId, externalRef, action, decidedBy, decidedAt,
                                    submitter: requesterId, comment })（见 T14；fail-open + 对账兜底）
```

循环条件：`outcome === 'next' && index < nodes.length`；`outcome === 'reject'` 立即结束。节点集合输入输出同形（Mastra `dountil` 约束）。

> 实现注记（2026-11-16 实测）：节点 SLA **不要**和主 run 用同一个 `sleepUntil`——Mastra 1.78 会让主 run 处于 running，之后 resume 抛 `WORKFLOW_RUN_NOT_SUSPENDED`。用独立 `case-node-sla` run 承载定时，到点发超时事件。另：P1 的 `normalizePlan` 明确拒绝 `rejectionPolicy=all_must_decide`（与 P0 `deriveCurrentNode` 契约冲突），不静默降级。

- [ ] **Step 5: 注册与路由**

`mastra.ts`：`POST /cases` 若 body 带 `plan`（`planVersion=1`）→ 走 `case-approval`，否则走现有 `case-intake`。`GET /cases/:id` 返回 `plan`、`currentNode`、`nodeDecisions`（从 `cases.plan` + `case_node_decisions` 推导；不要重复实现一套节点状态推导在平台侧）。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run core/engine/__tests__/case-approval.test.ts core/engine/__tests__/cases-routes.test.ts core/engine/__tests__/case-intake-workflow.test.ts`
Expected: PASS（既有 case-intake 不回归）。

- [ ] **Step 7: 提交**

```bash
git add core/decision-gate/src/inapp.ts core/workflows/case-approval.ts core/engine/src/mastra.ts core/engine/__tests__/case-approval.test.ts
git commit -m "feat(engine): 应用内审批链——节点循环/或签/驳回短路（#OA）"
```

---

## Task 14: 引擎事件 → 平台通知（先声明后接线）

**Files:**
- Modify: `core/engine/src/notify.ts`（通用 emit + `NotifyEmitter` 接口新方法）
- Create: `core/engine/src/oa-callback.ts`（final 结论回调平台）
- Modify: `core/engine/__tests__/notify-emit.test.ts`
- Modify: `platform-core/modules/forms/manifest.yaml`（事件声明）
- Test: platform `apps/server/src/event-catalog.test.ts`（T3 已覆盖协议）

**Interfaces:**
- Produces: 事件 `forms.approval.awaiting` / `forms.approval.node.decided` / `forms.case.sla.breach`；`createOaCallback(env, fetchImpl)` → `finalize({org, caseId, externalRef, action, decidedBy, decidedAt, comment})`。
- `NotifyEmitter` 新增 `emitApprovalAwaiting(e: ApprovalAwaitingEvent): Promise<void>`。

- [ ] **Step 1: 写失败测试**

```ts
it('emitApprovalAwaiting 发 POST /api/modules/notify/emit，eventId 确定性', async () => {
  const calls: any[] = []
  const emitter = createNotifyEmitter(
    { NOTIFY_PLATFORM_BASE: 'http://p', NOTIFY_PAT: 'k' },
    (async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return ok() }) as never,
  )
  await emitter.emitApprovalAwaiting({ submissionId: '1', caseId: 'c1', nodeKey: 'leader',
    title: '请假', assignee: 'u1', link: 'http://p/m/oa/c1' })
  expect(calls[0].body).toMatchObject({ eventKey: 'forms.approval.awaiting',
    eventId: 'forms:submission:1:node:leader:awaiting', payload: { assignee: 'u1' } })
})

it('oa-callback finalize 发 /api/modules/forms/approval-callback', async () => {
  const calls: any[] = []
  const cb = createOaCallback({ NOTIFY_PLATFORM_BASE: 'http://p', NOTIFY_PAT: 'k' },
    (async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return ok() }) as never)
  await cb.finalize({ org: 'acme', caseId: 'c1', externalRef: 'forms:submission:1',
    action: 'approved', decidedBy: 'u1', decidedAt: '2026-11-16T00:00:00Z', submitter: 'u1' })
  expect(calls[0].url).toBe('http://p/api/modules/forms/approval-callback')
  expect(calls[0].body).toMatchObject({ org: 'acme', caseId: 'c1', final: true, action: 'approved' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run core/engine/__tests__/notify-emit.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现通用 emit 与 callback**

`notify.ts` 加（保持既有 `createNotifyEmitter(env, fetchImpl)` 签名不变，只扩接口与实现）：

```ts
export interface ApprovalAwaitingEvent {
  submissionId: string; caseId: string; nodeKey: string
  title: string; assignee: string; link: string; dueAt?: string
}

export interface NotifyEmitter {
  emitCaseAwaitingApproval(e: AwaitingApprovalEvent): Promise<void>
  emitApprovalAwaiting(e: ApprovalAwaitingEvent): Promise<void>
}
```

> `NOOP_NOTIFY_EMITTER` 也要补空实现（接口改动是编译硬约束）；`loadNotifyConfig` 缺省仍返回 NOOP。

在现有 `createNotifyEmitter` 的返回对象里追加：

```ts
async emitApprovalAwaiting(e) {
  await postJson('forms.approval.awaiting',
    `forms:submission:${e.submissionId}:node:${e.nodeKey}:awaiting`, { ...e })
},
```

其中 `postJson` 是本文件内的私有 helper（与 `emitCaseAwaitingApproval` 共用同一 `fetchImpl`、Bearer 头、fail-open try/catch）。

`oa-callback.ts`：

```ts
export interface OaCallback {
  finalize(e: { org: string; caseId: string; externalRef: string
    action: 'approved' | 'rejected' | 'withdrawn'; decidedBy: string
    decidedAt: string; submitter: string; comment?: string }): Promise<void>
}
export function createOaCallback(env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch): OaCallback {
  const cfg = loadNotifyConfig(env)
  if (!cfg) return { async finalize() {} }
  return {
    async finalize(e) {
      try {
        await fetchImpl(`${stripTrailingSlash(cfg.platformBase)}/api/modules/forms/approval-callback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.pat}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...e, final: true }),
        })
      } catch { /* fail-open：对账 job 兜底 */ }
    },
  }
}
```

- [ ] **Step 4: 平台声明事件**

`modules/forms/manifest.yaml`（**P1 只声明这两个**；`forms.task.assigned` / `forms.case.sla.breach` 随 P4/P1.5 再加，不提前占坑）：

```yaml
notifications:
  events:
    - key: forms.approval.awaiting
      title: 待审批
      producer: external:case-engine
      scope: { key: caseId, label: 审批 }
      payload:
        submissionId: { type: string, required: true }
        caseId: { type: string, required: true }
        nodeKey: { type: string, required: true }
        title: { type: string, required: true }
        assignee: { type: string, required: true }
        link: { type: url, required: true }
      recipients:
        approver: { kind: field, field: assignee }
      defaults: { recipient: approver, template: oa_approval_awaiting, channels: [wecom_default, inapp_default] }
    - key: forms.approval.decided
      title: 审批有结果
      scope: { key: caseId, label: 审批 }
      payload:
        submissionId: { type: string, required: true }
        caseId: { type: string, required: true }
        action: { type: string, required: true }
        decidedBy: { type: string, required: true }
        decidedAt: { type: string, required: true }
        submitter: { type: string, required: true }
        link: { type: url, required: true }
      recipients:
        submitter: { kind: field, field: submitter }
      defaults: { recipient: submitter, template: oa_approval_decided, channels: [wecom_default, inapp_default] }
```

> 模板键 `oa_approval_awaiting` 必须同时在 `modules/notify/templates/builtin.ts` + `seed-builtin.ts` 落（三处同描，漏一处 = `no_rules` 静默丢弃）。

- [ ] **Step 5: 跑测试与事件目录检查**

Run: `npx vitest run core/engine/__tests__/notify-emit.test.ts`
Run: `pnpm vitest run apps/server/src/event-catalog.test.ts modules/notify/*.test.ts`
Expected: PASS。
检查：`GET /api/modules/notify/events` 返回 `forms.approval.awaiting`（本地起服务或用 catalog 测试读取）。

- [ ] **Step 6: 提交**

```bash
# 两个仓分别提交
cd /Users/duo/mytechcode/case-engine && git add core/engine/src/notify.ts core/engine/src/oa-callback.ts core/engine/__tests__/notify-emit.test.ts && git commit -m "feat(engine): 应用内审批事件 emit 与 final 回调（#OA）"
cd /Users/duo/mytechcode/platform-core && git add modules/forms/manifest.yaml modules/notify/templates/builtin.ts modules/notify/seed-builtin.ts && git commit -m "feat(notify): OA 审批事件与模板声明（#OA）"
```

---

## Task 15: P1 端到端验收（请假）

**Files:**
- Create: `docs/superpowers/plans/2026-11-16-oa-p1-acceptance.md`（验收记录）
- Create: `scripts/oa-p1-smoke.mjs`（本地端到端脚本，fake engine 或真 engine）

**Steps:**

- [x] **Step 1: 起本地栈**（执行形态：验收脚本自起宿主子进程 + MockCasdoor，不跑 `dev:stack`；见验收记录 §0）

```bash
cd /Users/duo/mytechcode/platform-core && pnpm dev:stack   # 起 pg + server + web
# case-engine 用 docker compose 起 app/worker（或本地 node）
```

- [x] **Step 2: 种子**（脚本用独立租户 `oa-smoke`，不写 acme；引擎 = 假引擎，`platform.oa_engine` 仍走真登记行）

- 建 tenant/org、`org_node` 10（负责人 u-lead）、`org_membership`（u1 在 10，u-lead 在 10）。
- `platform.oa_engine` upsert：org=`acme`，baseUrl=`http://127.0.0.1:3100`，PAT secret。
- 发布审批模板 `leave`（节点：dept_leader → HR 指定人）。
- 发布事项模板 `leave`（mode=approval，schema：开始日期/结束日期/事由）。

- [x] **Step 3: 主路径**

1. `POST /defs/leave/submissions`（u1）→ 201，DB `submission.status=pending_approval`，`case_ref` 非空。
2. 引擎 `GET /cases/:id` → status=gate，currentNode=leader。
3. 平台 `GET /approvals/:caseId`（u-lead）→ 200；`POST /approvals/:caseId/decision`（u-lead, approve）→ 200。
4. 引擎进入 HR 节点；HR approve → case closed；回调 → `submission.status=approved`；`notify` 收件箱有 `forms.approval.decided`。
5. 断言：审批事件数 = 2 个节点；无重复 `gate.node.decided`。

- [x] **Step 3b: 撤回路径**

1. 新建一笔 pending 请假（u1）。
2. 在任何节点决策前，u1 调 `POST /submissions/:id/withdraw` → 200；`submission.status=withdrawn`；引擎 case `closed`。
3. 已有一个节点决策后再撤回 → 409，状态不变。

- [x] **Step 4: 负对照（全部必须过）**

| 用例 | 期望 |
|---|---|
| org 不一致调引擎 | 403 |
| AI/无 publish scope 调 publish | 403 |
| dept_leader 缺失时发布 | 409（dry-run 失败），head 不变 |
| 回调重放两次 | 第二次 `deduped:true`，`decided_at` 不变 |
| 在途单 + 发布模板 v2 | 在途单仍按 v1 计划执行 |
| 并发两次 decision 同一节点 | 一个 200/409，不双落 |
| 未声明事件 emit | 400 `EVENT_NOT_DECLARED`（用未声明 key 验证） |

- [x] **Step 5: 记录验收**

把命令、输出摘要、时间（北京时间）写入 `docs/superpowers/plans/2026-11-16-oa-p1-acceptance.md`，附 `submission`/`case_events` 的关键行。

- [x] **Step 6: 提交**

```bash
git add docs/superpowers/plans/2026-11-16-oa-p1-acceptance.md scripts/oa-p1-smoke.mjs
git commit -m "test(oa): P1 请假端到端验收记录（#OA）"
```

> 执行记录：2026-11-16 完成，25 条机检断言全过（含 7 类负对照）。结论与边界见
> `docs/superpowers/plans/2026-11-16-oa-p1-acceptance.md`（真引擎未跑、企微通道因环境缺
> 地址数据未送达——两处都在该文 §5 显式标注）。

---

## Self-Review

### Spec coverage（P0/P1 范围）

| Spec 节 | 任务 |
|---|---|
| §5 总体架构 / D1–D15 | T0/T2/T3/T6 |
| §6.1 模板层（item/approval、归属/可见性） | T4/T7/T9 |
| §6.2 实例层（submission/audit） | T4/T10/T11 |
| §6.3 执行层（external_ref/plan/节点循环） | T6/T13 |
| §7.1–7.2 模板/审批状态机 | T9/T10/T11/T13 |
| §8 审批 DSL + 判定表 | T7/T8/T13 |
| §9 provider 路由（inapp 部分） | T9/T10；`wecom_native` 属 P2 |
| §10 接缝契约 | T6/T10/T11 |
| §11 引擎改造 E1–E12（P1 范围） | T6/T13/T14 |
| §12 平台改造 P1–P11（P1 范围） | T1–T5/T9–T12 |
| §13 AI 生成面 | **本计划未覆盖**（P1 用手工/console 建模板；AI 工具面在 P1.5 单独计划） |
| §14 统一待办/通知 | T11/T14 |
| §15 数据面 | 不在 P1（P5） |
| §16 安全/审计 | T1/T2/T4/T9/T10/T11 |
| §17 迁移/开关 | T4/T5/T10 |
| §18 P0/P1 验收 | T15 |

### 已知取舍（写进 PR 描述）

- AI 生成工具面不在 P1；P1 先用 console 手工建模板（AI 起草复用现有 `/generate` 路径，未接审批 DSL）。
- 移动端用响应式 console 页承接；独立 `/m` 壳接入后置。
- 采集轮次/协作/标准审批镜像不在 P1。
- 节点级 SLA 在 P1 只落 `slaHours` 字段与超时事件；自动升级动作在 P1.5（先保证不静默）。实现用**独立 `case-node-sla` run**（Mastra 1.78 `sleepUntil` 不能与主 run 的 `suspend` 同 run）。
- `rejectionPolicy` P1 只支持 `first_reject_ends`；`all_must_decide` 与 P0 `deriveCurrentNode` 契约冲突，P2 再开，平台发布门显式拒绝（不静默降级）。

### Placeholder scan

- 所有任务给出文件、接口、测试断言与提交命令；无 `TBD`/`TODO`。
- 路由/UI 任务给出端点契约与组件职责；具体样式沿用 `DESIGN.md` 与 `console-ui-conventions.md`。

### Type consistency

- `ApprovalBody`/`ApprovalNode`/`ApproverSource` 在 T7 定义，T8/T9/T13 引用同一组名字。
- `PlanNode.quorum` 在平台是 `'all'|'any'|{n}`，引擎 workflow 按同形状校验。
- `externalRef` 前缀统一 `forms:submission:<id>`；事件 id 统一 `forms:submission:<id>:node:<key>:awaiting`。
- 事件 key 统一 `forms.approval.awaiting` / `forms.approval.decided` / `forms.approval.node.decided` / `forms.task.assigned` / `forms.case.sla.breach`。
