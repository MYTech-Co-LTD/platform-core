# 山海组织架构与角色管理后台（console 侧）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** platform-core console 新增「组织架构」「角色管理」两页 + 后端 Casdoor 代理（group 树 / 角色 CRUD / 码↔角色），使租户管理员能按部门视图批量授权。

**Architecture:** Casdoor 为组织权威源（spec D5），console 纯代理读、无本地表。CasdoorClient 扩展全部走既有 `#adminJson` 通道；角色继承**零改动**——真机 spike（附录 B）实证 get-user 回填 roles，`effectiveScopes` 的 `matchRoles`（`packages/auth-core/src/effective-scopes.ts:26`）直接生效；**附录 A 不执行**（保留作历史记录）。目标 org = `shanhaiyiguo-org`（用户 2026-10-24 指示；`shanhai` org 是另一套生产体系，红线勿动）。

**Tech Stack:** Hono + zod（后端）、React + antd + vite（前端）、vitest、TypeScript。

**Spec:** `docs/superpowers/specs/2026-10-24-shanhai-wecom-directory-and-org-admin-design.md`（开工前先读全文）

## Global Constraints

- **Casdoor 三铁律**（spec §1.2 / AGENTS #9）：delete 类端点一律 JSON body `{owner,name}`；update 类一律带 `?id=<owner>/<name>`；每次写后回读验证目标状态。
- **admin 路由三结构锁**（`routes/admin.ts` 顶部注释）不动：org 永远取自 `c.get('tenant').casdoor_org`；整路由 `requireScope('tenant:admin')`；写操作校验 x-csrf-token。
- **锚用户 `tenantsub`**：不可见、不可授权进角色（spec §6.2 延伸）。
- **Casdoor `name` 禁用字符集** `"/?:#&%=+;"`（`safePermissionName` 同款）——角色 `name` 必须校验，`displayName` 不限。
- **mock 收严到真机形状**（AGENTS #11）：Task 1 spike 的实测形状回填 mock，不按想象放宽。
- **桶文件纪律**（AGENTS #10）：`packages/auth-core` 桶 export 只放值，绝不混入 interface/type。
- 提交纪律：Conventional Commits；feat/fix 先建 issue；PR body 含 `Closes #N`；CHANGELOG 由 release.mjs 生成不手写。
- 本地跑 server 测试需 `DATABASE_URL`（本地 compose pg）；测试命令 `pnpm --dir <pkg> test`。
- API 形状注释里钉形状的写法沿用现有文件风格（形状出处 + 为什么）。

---

### Task 1: Spike——真机 group/role API 形状与 roles 回填实测

**Files:**
- Modify: 本计划附录 B（回填形状记录）
- Modify: `docs/superpowers/specs/2026-10-24-shanhai-wecom-directory-and-org-admin-design.md` §1.2（若形状与预期不符）

**Interfaces:**
- Produces: 六项形状结论（附录 B），Task 2 的 mock 按它收严；roles 回填判定决定附录 A 是否执行。

- [ ] **Step 1: 取 admin 凭据（值不落任何文档）**

经 openship MCP 读 platform-core **生产服务** env 的键：`CASDOOR_URL`、`CASDOOR_ADMIN_USER`、`CASDOOR_ADMIN_PWD`、`CASDOOR_ADMIN_APPLICATION`（缺省则不用）。只取这四个键，导出到当前 shell 会话（`export`），**不写进文件、不进命令历史常驻**。

- [ ] **Step 2: 登 admin 会话**

```sh
COOKIE=$(curl -s -D - -o /dev/null -X POST "$CASDOOR_URL/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"application\":\"${CASDOOR_ADMIN_APPLICATION:-app-built-in}\",\"organization\":\"admin\",\"username\":\"$CASDOOR_ADMIN_USER\",\"password\":\"$CASDOOR_ADMIN_PWD\"}" \
  | grep -i 'set-cookie' | grep -o 'casdoor_session_id=[^;]*')
```

验证：`curl -s "$CASDOOR_URL/api/get-account" -H "Cookie: $COOKIE"` 返回 `status":"ok"`。

- [ ] **Step 3: 探六个形状（mytech org 是已同步形状的 oracle）**

对 mytech 的 Casdoor org（下称 `<mytech-org>`，可从 get-organizations 列表确认）逐项 curl 并**逐字记录** JSON 到附录 B：

```sh
# a. Role 对象字段
curl -s "$CASDOOR_URL/api/get-roles?owner=<mytech-org>" -H "Cookie: $COOKIE"
# b. Group 对象字段（若 404/空 → 试 /api/get-groups-tree、/api/groups，逐字记录真实路径）
curl -s "$CASDOOR_URL/api/get-groups?owner=<mytech-org>" -H "Cookie: $COOKIE"
# c. 已同步用户的 group 字段形状 + roles 是否回填（抽 2 个企微同步来的用户）
curl -s "$CASDOOR_URL/api/get-users?owner=<mytech-org>" -H "Cookie: $COOKIE" | python3 -m json.tool | head -80
# d. get-user 的 roles 回填（effectiveScopes 命门）
curl -s "$CASDOOR_URL/api/get-user?id=<mytech-org>/<某同步用户>" -H "Cookie: $COOKIE" | python3 -c "import json,sys; u=json.load(sys.stdin)['data']; print('roles=',u.get('roles'),'group=',repr(u.get('group')))"
# e. 权限记录的 roles[] 形态（裸名 vs org/role 全形）
curl -s "$CASDOOR_URL/api/get-permissions?owner=<mytech-org>" -H "Cookie: $COOKIE" | python3 -m json.tool | head -60
# f. 读写参考：update-role 的 id 形参形状（对一条测试 role 做改名→回读→改名复原，写后必须复原）
```

- [ ] **Step 4: 决策门**

- c/d 任一返回 `roles` 非空数组 ⇒ 真机回填成立，**附录 A 不执行**；
- 两处 `roles` 全空/缺失 ⇒ 真机不回填，**附录 A 纳入执行**（在 Task 7 前实施）；
- 结论一行写进附录 B 顶部。

- [ ] **Step 5: 形状回填**

把与 Task 2 预期形状不符的项，回填本计划附录 B 并同步订正 spec §1.2（`docs(...)` 提交）。若全部符合预期，附录 B 填「与预期一致」即可。

---

### Task 2: mock-casdoor 扩展 role/group 端点

**Files:**
- Modify: `packages/auth-core/src/test-util/mock-casdoor.ts`
- Test: `packages/auth-core/src/test-util/mock-casdoor.test.ts`

**Interfaces:**
- Produces（Task 3–8 的 mock 依赖，形状按 Task 1 回填修正）:
  - `GET /api/get-roles?owner=<org>` → `{status:'ok',data:MockRole[]}`，owner 缺失 → `{status:'error',msg:'owner is required'}`（分桶纪律，同 get-permissions）
  - `POST /api/add-role` body `{owner,name,displayName?}` → 重名 `{status:'error',msg:'the role already exists: <owner>/<name>'}`
  - `POST /api/update-role?id=<org>/<name>` → 整记录替换 `users/displayName`；id 缺失或段数≠2 → `{status:'error',msg:'wrong token count…'}`（镜像 update-permission 纪律）
  - `POST /api/delete-role` body `{owner,name}` → body 缺任一键 → error（delete JSON body 铁律）
  - `GET /api/get-groups?owner=<org>` → `{status:'ok',data:MockGroup[]}`
  - `get-users` 的行增加 `groups: string[]`（全形 `org/组名`，附录 B）与 `roles: string[]` 投影

**内部状态：** `#roles: Map<string, Map<string, { displayName: string; users: string[] }>>`（外层键=org）、`#groups: Map<string, Array<{ name: string; displayName: string; parentId: string; isTopGroup?: boolean }>>`；`roleOf(org,name)` 断言助手照 `permissionOf` 模式。

- [ ] **Step 1: 写失败测试**

```ts
// mock-casdoor.test.ts 追加
test('get-roles 按 owner 分桶、缺 owner 报错', async () => {
  const m = new MockCasdoor({ org: 'o1' })
  await m.start()
  const cookie = await m.adminCookie()
  await m.addRoleRaw('o1', 'r1', '角色一', ['o1/u1'])
  const hit = await fetch(`${m.origin}/api/get-roles?owner=o1`, { headers: { cookie } }).then((r) => r.json())
  expect(hit.status).toBe('ok')
  expect(hit.data).toHaveLength(1)
  expect(hit.data[0].users).toEqual(['o1/u1'])
  const miss = await fetch(`${m.origin}/api/get-roles`, { headers: { cookie } }).then((r) => r.json())
  expect(miss.status).toBe('error')
  await m.stop()
})

test('update-role 缺 id 或段数≠2 报 wrong token count；delete-role 必须 JSON body', async () => {
  const m = new MockCasdoor({ org: 'o1' })
  await m.start()
  const cookie = await m.adminCookie()
  await m.addRoleRaw('o1', 'r1', '角色一', [])
  const noId = await m.post('/api/update-role', { users: [] }, cookie) // 无 ?id=
  expect(noId.status).toBe('error')
  const badId = await m.post('/api/update-role?id=r1', { users: [] }, cookie) // 段数≠2
  expect(badId.status).toBe('error')
  const del = await m.post('/api/delete-role', { owner: 'o1', name: 'r1' }, cookie)
  expect(del.status).toBe('ok')
  expect((await fetch(`${m.origin}/api/get-roles?owner=o1`, { headers: { cookie } }).then((r) => r.json())).data).toHaveLength(0)
  await m.stop()
})
```

（`m.post`/`m.adminCookie`/`m.addRoleRaw` 若与现有测试助手形状不符，以现有助手为准新增 `addRoleRaw`，其余用现有 helper 的实际形状改写断言的发送方式——**断言内容不放松**。）

- [ ] **Step 2: 跑测试确认失败**

```sh
pnpm --dir packages/auth-core test -- mock-casdoor
```
Expected: FAIL（端点不存在 / helper 不存在）。

- [ ] **Step 3: 实现端点**

在 mock-casdoor.ts 路由注册区（`this.#app.get('/api/get-permissions'…)` 同区域）追加 get-roles/add-role/update-role/delete-role/get-groups 五端点，纪律与 get-permissions/get-users 完全同构：owner= query 分桶、不回 password、会话失效按端点回 error。`get-users` 的 `.map()` 投影补 `group: String(u.group ?? '')`、`roles: Array.isArray(u.roles) ? u.roles.map(String) : []`。

- [ ] **Step 4: 跑测试确认通过**

```sh
pnpm --dir packages/auth-core test -- mock-casdoor
```
Expected: PASS（含既有用例零回归）。

- [ ] **Step 5: Commit**

```sh
git add packages/auth-core/src/test-util/mock-casdoor.ts packages/auth-core/src/test-util/mock-casdoor.test.ts
git commit -m "test(auth-core): mock-casdoor 补 role/group 端点（形状按真机 spike 收严）"
```

---

### Task 3: buildGroupTree 纯函数 + listGroups 客户端方法

**Files:**
- Create: `packages/auth-core/src/group-tree.ts`
- Test: `packages/auth-core/src/group-tree.test.ts`
- Modify: `packages/auth-core/src/casdoor-client.ts`（追加方法）

**Interfaces:**
- Produces（形状按附录 B 实测：显示名是 `displayName`、无 `title`；根判定需 org 参数）:
  ```ts
  // group-tree.ts
  export interface CasdoorGroupLike { name: string; displayName: string; parentId: string }
  export interface GroupTreeNode {
    name: string; displayName: string; parentId: string
    orphan: boolean            // parentId 非空、非 org 名、父又不存在 → 挂根并标记，不丢人（spec §3.4）
    memberCount: number
    children: GroupTreeNode[]
  }
  export function buildGroupTree(org: string, groups: CasdoorGroupLike[], memberCounts?: Map<string, number>): GroupTreeNode[]
  // casdoor-client.ts
  export interface CasdoorGroup { name: string; displayName: string; parentId: string; isTopGroup?: boolean }
  async listGroups(): Promise<CasdoorGroup[]>   // GET get-groups?owner=<org>，error 抛不静默
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { buildGroupTree } from './group-tree'

test('parentId 组装成树；memberCount 按名归节点', () => {
  const tree = buildGroupTree(
    'org',
    [
      { name: 'hq', displayName: '总部', parentId: 'org' },   // 真机形态：顶层 parentId=org 名
      { name: 'shop-a', displayName: 'A 店', parentId: 'hq' },
    ],
    new Map([['shop-a', 12]]),
  )
  expect(tree).toHaveLength(1)
  expect(tree[0].name).toBe('hq')
  expect(tree[0].children[0]).toMatchObject({ name: 'shop-a', memberCount: 12, orphan: false })
})

test('parentId 为空串的顶层组也是根（真机两种顶层形态并存）', () => {
  const tree = buildGroupTree('org', [{ name: 'top', displayName: '顶级', parentId: '' }])
  expect(tree).toHaveLength(1)
  expect(tree[0]).toMatchObject({ name: 'top', orphan: false })
})

test('孤儿节点挂根并标记 orphan（不丢人）', () => {
  const tree = buildGroupTree('org', [{ name: 'lost', displayName: '失联部门', parentId: 'ghost' }])
  expect(tree).toHaveLength(1)
  expect(tree[0]).toMatchObject({ name: 'lost', orphan: true, children: [] })
})

test('环引用不挂死：成环对按孤儿挂根', () => {
  const tree = buildGroupTree('org', [
    { name: 'a', displayName: 'A', parentId: 'b' },
    { name: 'b', displayName: 'B', parentId: 'a' },
  ])
  expect(tree.every((n) => n.orphan)).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

```sh
pnpm --dir packages/auth-core test -- group-tree
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// group-tree.ts — Casdoor group 平表 → 树（spec §3.4：孤儿挂根标记，不丢人；环引用同待遇）
// 根判定（附录 B 真机形态）：parentId === '' 或 === org 名 → 根；
// parentId 指向集合内父 → 挂父；其余（父不存在/成环）→ 孤儿挂根。
export interface CasdoorGroupLike { name: string; displayName: string; parentId: string }
export interface GroupTreeNode {
  name: string
  displayName: string
  parentId: string
  orphan: boolean
  memberCount: number
  children: GroupTreeNode[]
}

export function buildGroupTree(org: string, groups: CasdoorGroupLike[], memberCounts?: Map<string, number>): GroupTreeNode[] {
  const counts = memberCounts ?? new Map<string, number>()
  const nodes = new Map<string, GroupTreeNode>(
    groups.map((g) => [g.name, { ...g, orphan: false, memberCount: counts.get(g.name) ?? 0, children: [] }]),
  )
  const roots: GroupTreeNode[] = []
  const pending: Array<{ node: GroupTreeNode; parentName: string }> = []
  for (const g of groups) {
    const node = nodes.get(g.name)!
    if (g.parentId === '' || g.parentId === org) roots.push(node)
    else pending.push({ node, parentName: g.parentId })
  }
  // 挂链 + 环防护：attach 过的不再动；一轮挂不完的（成环/父缺失）标记孤儿挂根
  const attached = new Set<string>()
  let progress = true
  while (progress && pending.length > 0) {
    progress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const { node, parentName } = pending[i]
      if (attached.has(parentName) || roots.some((r) => r.name === parentName)) {
        nodes.get(parentName)?.children.push(node)
        attached.add(node.name)
        pending.splice(i, 1)
        progress = true
      }
    }
  }
  for (const { node } of pending) {
    node.orphan = true
    roots.push(node)
  }
  const sortRec = (n: GroupTreeNode) => {
    n.children.sort((x, y) => x.displayName.localeCompare(y.displayName, 'zh'))
    n.children.forEach(sortRec)
  }
  roots.sort((x, y) => x.displayName.localeCompare(y.displayName, 'zh')).forEach(sortRec)
  return roots
}
```

> 注：`roots.some(...)` 在组数（数百级）下无性能问题；若将来上千组再换 Map 化根索引（YAGNI）。环对（a↔b）两轮无 progress → 双双孤儿挂根，与测试判据一致。

- [ ] **Step 4: casdoor-client.ts 追加 listGroups**

```ts
export interface CasdoorGroup {
  name: string
  displayName: string
  parentId: string
  isTopGroup?: boolean
}

/** 列本 client org 的 group 平表（组织架构页数据源）。error 一律抛（listUsers 同口径）。 */
async listGroups(): Promise<CasdoorGroup[]> {
  const j = await this.#adminJson(`get-groups?owner=${encodeURIComponent(this.#o.org)}`)
  if (j.status !== 'ok') throw new Error(`casdoor get-groups: ${j.msg || 'error'}`)
  if (!Array.isArray(j.data)) return []
  return (j.data as Array<Record<string, unknown>>)
    .map((g) => ({
      name: String(g.name ?? ''),
      displayName: String(g.displayName ?? g.name ?? ''),
      parentId: String(g.parentId ?? ''),
      isTopGroup: g.isTopGroup === true,
    }))
    .filter((g) => g.name !== '')
}
```

- [ ] **Step 5: client 单测（casdoor-client.test.ts 追加）**——mock 起服务、listGroups 走通 + error 抛；照既有 `listUsers` 用例形状。

- [ ] **Step 6: 跑包测试全绿 + Commit**

```sh
pnpm --dir packages/auth-core test
git add packages/auth-core/src/group-tree.ts packages/auth-core/src/group-tree.test.ts packages/auth-core/src/casdoor-client.ts packages/auth-core/src/casdoor-client.test.ts
git commit -m "feat(auth-core): buildGroupTree 树组装 + listGroups 客户端方法（组织架构页数据源）"
```

---

### Task 4: Role CRUD 客户端方法

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/test-util/mock-casdoor.test.ts`（补 role 助手）+ `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 get-roles/add-role/update-role/delete-role mock 端点。
- Produces:
  ```ts
  export interface CasdoorRole { name: string; displayName: string; users: string[] }
  async listRoles(): Promise<CasdoorRole[]>                    // get-roles?owner=
  async createRole(input: { name: string; displayName?: string }): Promise<void>
    // add-role；竞态重读验证（createManagedUser 同口径：人已在即成功，仍无则抛）
  async deleteRole(name: string): Promise<void>
    // POST delete-role，JSON body {owner,name}（铁律①）；回读确认消失，仍可见即抛（铁律③）
  ```

- [ ] **Step 1: 写失败测试**（casdoor-client.test.ts）：

```ts
test('listRoles 走通；createRole 幂等竞态：已存在视为成功；deleteRole 回读确认消失', async () => {
  const m = new MockCasdoor({ org: 'org' })
  await m.start()
  const client = new CasdoorClient({ origin: m.origin, org: 'org', /* admin 凭据同既有用例 */ })
  await m.addRoleRaw('org', 'dup', '重复', [])
  await expect(client.createRole({ name: 'dup' })).resolves.toBeUndefined() // 已在 = 成功，不抛
  await client.createRole({ name: 'fresh', displayName: '新角色' })
  const roles = await client.listRoles()
  expect(roles.find((r) => r.name === 'fresh')).toMatchObject({ displayName: '新角色', users: [] })
  await client.deleteRole('dup')
  expect((await client.listRoles()).some((r) => r.name === 'dup')).toBe(false)
  await m.stop()
})
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**（`#adminJson('add-role', { method:'POST', body:{ owner: this.#o.org, name, displayName: displayName ?? name } })` → status!==ok 时 `getUser` 式重读 `listRoles()` 找同名，找到即成功；deleteRole 用 body `{owner,name}`，回读 `listRoles()` 不含 name）；**Step 4: 通过 → Step 5: Commit**

```sh
git commit -m "feat(auth-core): CasdoorClient 角色清单/建/删（三铁律：body 删、回读验）"
```

---

### Task 5: setRoleMembers（角色↔用户整组替换）

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  async setRoleMembers(name: string, users: ReadonlyArray<string>): Promise<void>
  // update-role?id=<org>/<name> 整记录替换——先 listRoles 取原记录带回 displayName/users，
  // users 换成入参的 org/<user> 全形（grantPermissionToUser 的全形惯例）；回读 users 集合逐个命中（铁律③）
  ```

- [ ] **Step 1: 失败测试**（casdoor-client.test.ts）：

```ts
test('setRoleMembers 全形落库 + 清空合法', async () => {
  const m = new MockCasdoor({ org: 'org' }); await m.start()
  const client = new CasdoorClient({ origin: m.origin, org: 'org', /* admin 凭据同既有用例 */ })
  await client.createRole({ name: 'r1' })
  await client.setRoleMembers('r1', ['a', 'b'])
  expect((await client.listRoles()).find((r) => r.name === 'r1')?.users)
    .toEqual(['org/a', 'org/b'])                       // 全形惯例（grantPermissionToUser 同款）
  await client.setRoleMembers('r1', [])                // 清空 = 合法操作
  expect((await client.listRoles()).find((r) => r.name === 'r1')?.users).toEqual([])
  await m.stop()
})
```
- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit**

```sh
git commit -m "feat(auth-core): setRoleMembers 角色成员整组替换（?id= + 回读）"
```

---

### Task 6: grant/revokePermissionToRole（码↔角色）

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`
- Test: `packages/auth-core/src/casdoor-client.test.ts`

**Interfaces:**
- Consumes: 既有 `#findPermissionByCode`、`grantPermissionToUser`（**照抄其 body 全字段与回读模式，唯一差异：操作 `roles` 数组而非 `users`**，role 入 `org/<role>` 全形，查重/幂等判定同时认短名与全形——matchRoles 的双向语义）。
- Produces:
  ```ts
  async grantPermissionToRole(code: string, roleName: string): Promise<void>
  async revokePermissionFromRole(code: string, roleName: string): Promise<void>   // 短名/全形一并清（revokePermissionFromUser 同款）
  ```

- [ ] **Step 1: 失败测试**（casdoor-client.test.ts）：

```ts
test('grant/revokePermissionToRole：roles 全形落库、幂等、短名/全形残留一并清', async () => {
  const m = new MockCasdoor({ org: 'org' }); await m.start()
  const client = new CasdoorClient({ origin: m.origin, org: 'org', /* admin 凭据同既有用例 */ })
  await client.upsertPermissions([{ code: 'demo:view', name: 'demo:view' }])
  await client.createRole({ name: 'store-manager' })
  await client.grantPermissionToRole('demo:view', 'store-manager')
  expect(m.permissionOf('org', 'demo:view')?.roles).toContain('org/store-manager')  // 全形
  await client.grantPermissionToRole('demo:view', 'store-manager')                   // 幂等：已挂不炸
  // 模拟历史残留：直接把 roles 写成短名再 revoke，仍要清干净
  await m.setPermissionRolesRaw('org', 'demo:view', ['store-manager'])
  await client.revokePermissionFromRole('demo:view', 'store-manager')
  expect(m.permissionOf('org', 'demo:view')?.roles ?? []).not.toContain('store-manager')
  expect(m.permissionOf('org', 'demo:view')?.roles ?? []).not.toContain('org/store-manager')
  await m.stop()
})
```

（`m.permissionOf` 是 mock 既有断言助手；`m.setPermissionRolesRaw` 是本任务要在 mock 上新增的直写助手——形状照 `permissionOf` 系，仅测试用。）
- [ ] **Step 2–5: 红→实现→绿→Commit**

```sh
git commit -m "feat(auth-core): 权限码↔角色挂/收（roles 数组，全形惯例，回读验）"
```

---

### Task 7: admin 路由——组织架构树 + 成员（含 CasdoorListedUser 扩展）

**Files:**
- Modify: `packages/auth-core/src/casdoor-client.ts`（CasdoorListedUser 加 `group`/`roles` 投影）
- Modify: `apps/server/src/routes/admin.ts`
- Test: `packages/auth-core/src/test-util/mock-casdoor.ts`（get-users 投影）+ `apps/server/src/routes/admin.test.ts`

**Interfaces:**
- Produces（Task 9 前端消费）:
  ```
  GET /api/platform/admin/org-tree
    → { tree: Array<{ name,title,parentId,orphan,memberCount,children:[…] }> }   // buildGroupTree 产物数组
  GET /api/platform/admin/org-tree/members?group=<name>?      // group 缺省 = 全员
    → { users: Array<{ name,displayName,isForbidden,roles:string[] }> }        // 锚用户剔除（既有 toShortUser 同款）
  ```
- memberCount 统计口径（附录 B：用户组键是 `groups` 数组）：`listUsers()` 按 `u.groups.some(g => g === 节点名 || g.endsWith('/' + 节点名))` 计数（短名/全形双认，matchUser 同防御）；members 端点同口径过滤。

- [ ] **Step 1: mock get-users 投影扩展**（group/roles 透传）+ 失败的路由测试：

```ts
// admin.test.ts 追加（沿用文件内既有 app 构造与登录助剂）
test('org-tree 返回树且成员计数按 groups 归节点；members 剔除锚用户', async () => {
  // 注入 fake casdoor factory：listGroups 返回 hq+shop-a(hq)；listUsers 返回
  //   {name:'u1',groups:['org/shop-a'],…}、{name:'tenantsub',groups:['org/hq'],…}
  const tree = await GET('/api/platform/admin/org-tree')
  expect(tree.tree[0].name).toBe('hq')
  expect(tree.tree[0].memberCount).toBe(0)            // tenantsub 被剔除后 hq 计 0
  expect(tree.tree[0].children[0]).toMatchObject({ name: 'shop-a', memberCount: 1 })
  const members = await GET('/api/platform/admin/org-tree/members?group=shop-a')
  expect(members.users.map((u) => u.name)).toEqual(['u1'])
})
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**（client 投影：`groups: Array.isArray(u.groups) ? u.groups.map(String) : []`、`roles: Array.isArray(u.roles) ? u.roles.map(String) : []`；路由 `GET /org-tree` 组装 `buildGroupTree(org, listGroups(), counts)`，counts 从剔除锚用户后的 listUsers 按 groups 统计；`GET /org-tree/members` 同口径过滤 + 剔除锚用户）。**Step 4: 绿 → Step 5: Commit**

```sh
git commit -m "feat(server): 管理端组织架构树与成员代理端点（锁 org、剔锚用户）"
```

---

### Task 8: admin 路由——角色 CRUD + 成员替换 + 码↔角色

**Files:**
- Modify: `apps/server/src/routes/admin.ts`
- Test: `apps/server/src/routes/admin.test.ts`

**Interfaces:**
- Consumes: Task 4–6 的 client 方法。
- Produces（Task 9/10 前端消费）:
  ```
  GET    /api/platform/admin/roles → { roles: Array<{ name,displayName,members:number,codes:string[],users:string[] }> }
     // codes = getPermissions() 里 roles[] 命中该角色的码（短名/全形双认），与 effectiveScopes.matchRoles 同口径
     // users = 角色成员短名数组（listRoles 的 users 全形 → 短名化，toShortUser 同款）——OrgTree 授角色拿它算整组替换
  POST   /api/platform/admin/roles            body { name, displayName? }   → audit 'admin.role.create'
  DELETE /api/platform/admin/roles/:name                                     → audit 'admin.role.delete'
  PUT    /api/platform/admin/roles/:name/members  body { users: string[] }    → audit 'admin.role.members'
  POST   /api/platform/admin/permissions/:code/roles   body { role }          → audit 'admin.role.grant'
  DELETE /api/platform/admin/permissions/:code/roles   body { role }          → audit 'admin.role.revoke'
  ```
- 角色名 zod 校验：`z.string().regex(/^[^/?:#&%=+;]{1,64}$/)`（Casdoor name 禁用字符集 + 长度上限）；displayName `z.string().max(128)`。
- `members` 入参含 `tenantsub` → 400 `{error:'ANCHOR_FORBIDDEN'}`（锚用户不可授权，spec §6.2 延伸）。
- `writeAudit` 的 action 联合类型扩上表五个值（platform.audit.action 是 TEXT，无迁移）。

- [ ] **Step 1: 失败测试**（admin.test.ts 追加，每端点一用例）：建角色（含禁用字符 422/400）、删角色、成员替换（锚用户拒绝 + 正常全形落库）、码↔角色挂/收（fake client 断言调用 + audit 行数）。**写操作用例必须带 x-csrf-token（既有写用例同款助剂）**。
- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 绿 → Step 5: Commit**

```sh
git commit -m "feat(server): 管理端角色 CRUD/成员/码↔角色代理端点（角色名禁用字符校验、锚用户拒授）"
```

---

### Task 9: api.ts + 组织架构页

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/pages/admin/OrgTree.tsx`
- Test: `apps/web/src/pages/admin/OrgTree.test.tsx`

**Interfaces:**
- Consumes: Task 7/8 端点。
- Produces（api.ts 追加，Task 10 复用成员选择器）:

```ts
export interface AdminGroupNode {
  name: string; displayName: string; parentId: string; orphan: boolean
  memberCount: number; children: AdminGroupNode[]
}
export const getAdminOrgTree = () => request<{ tree: AdminGroupNode[] }>('/api/platform/admin/org-tree')
export interface AdminMember { name: string; displayName: string; isForbidden: boolean; roles: string[] }
export const listAdminMembers = (group?: string) =>
  request<{ users: AdminMember[] }>(
    `/api/platform/admin/org-tree/members${group ? `?group=${encodeURIComponent(group)}` : ''}`,
  )
```

- [ ] **Step 1: 页面失败测试**（OrgTree.test.tsx，mock `../../lib/api` 模块）：渲染后断言树节点「总部」出现、选中节点调 `listAdminMembers('shop-a')`、表格出现成员行；授角色操作调 `setAdminRoleMembers`。

- [ ] **Step 2: 确认失败 → Step 3: 实现页面**。结构（照 Users.tsx 的 reload/错误处理纪律——**成功后先 reload 再 message**）：

```tsx
// pages/admin/OrgTree.tsx — 组织架构（账户和权限体系 spec：Casdoor group 树代理视图）
// 数据源 /api/platform/admin/org-tree + /org-tree/members（后端已锁 org、剔锚用户）。
// 写操作（授/收角色）走 setAdminRoleMembers（整组替换语义：先取现员，增删后回写）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { App, Card, Form, Input, Modal, Select, Table, Tag, Tree } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError, getAdminOrgTree, listAdminMembers, listAdminRoles,
  setAdminRoleMembers, type AdminGroupNode, type AdminMember, type AdminRoleRow,
} from '../../lib/api'
import type { ConsoleOutletContext } from '../Console'

// antd Tree需要 {title,key,children} —— AdminGroupNode → TreeDataNode 的映射
function toTreeData(nodes: AdminGroupNode[]): { title: string; key: string; children: ReturnType<typeof toTreeData> }[] {
  return nodes.map((n) => ({
    title: `${n.displayName}${n.orphan ? '（未挂接）' : ''}（${n.memberCount}）`,
    key: n.name,
    children: toTreeData(n.children),
  }))
}

export default function AdminOrgTreePage() {
  const { message } = App.useApp()
  const [tree, setTree] = useState<AdminGroupNode[]>([])
  const [selected, setSelected] = useState<string | undefined>()
  const [members, setMembers] = useState<AdminMember[]>([])
  const [roles, setRoles] = useState<AdminRoleRow[]>([])
  const [granting, setGranting] = useState<AdminMember | null>(null)
  const [search, setSearch] = useState('')
  const [form] = Form.useForm<{ roles: string[] }>()

  const reload = useCallback(async () => {
    try {
      const t = await getAdminOrgTree()
      setTree(t.tree)
      const r = await listAdminRoles()
      setRoles(r.roles)
      if (selected) setMembers((await listAdminMembers(selected)).users)
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    }
  }, [message, selected])
  useEffect(() => { void reload() }, [reload])  // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => members.filter((m) => !search || m.displayName.includes(search) || m.name.includes(search)),
    [members, search],
  )

  const onGrant = async () => {
    if (!granting) return
    const picked = new Set(form.getFieldValue('roles') as string[])
    const current = new Set(granting.roles) // 该用户现持有的角色（members 端点的短名数组）
    try {
      // 关键语义：setAdminRoleMembers 设置的是【角色的成员表】，不是「用户的角色列表」。
      // 给用户授/收角色 = 对每个发生变更的角色，做「现成员 ± 该用户」的整组替换。
      const changed: Array<Promise<unknown>> = []
      for (const r of roles) {
        const members = new Set(r.users) // GET /roles 的短名成员清单
        if (picked.has(r.name) === current.has(r.name)) continue
        if (picked.has(r.name)) members.add(granting.name)
        else members.delete(granting.name)
        changed.push(setAdminRoleMembers(r.name, [...members]))
      }
      await Promise.all(changed)
      setGranting(null)
      void reload() // 顺序纪律（Users.tsx 实测）：先刷新再 message，防 UI 调用抛错吞刷新
      message.success(`已更新 ${granting.displayName || granting.name} 的角色`)
    } catch (e) {
      message.error(e instanceof ApiError ? `操作失败：${e.code}` : '操作失败')
    }
  }

  const columns: ColumnsType<AdminMember> = [
    { title: '姓名', dataIndex: 'displayName' },
    { title: '账号', dataIndex: 'name' },
    { title: '状态', dataIndex: 'isForbidden', render: (v: boolean) => (v ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>) },
    { title: '角色', dataIndex: 'roles', render: (roles: string[]) => roles.map((r) => <Tag key={r}>{r}</Tag>) },
    {
      title: '操作',
      render: (_, u) => (
        <a onClick={() => { setGranting(u); form.setFieldValue('roles', u.roles) }}>授角色</a>
      ),
    },
  ]

  return (
    <Card title="组织架构" extra={<Input.Search placeholder="姓名/账号" onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />}>
      <div style={{ display: 'flex', gap: 16 }}>
        <Card style={{ width: 280 }} size="small">
          <Tree
            treeData={toTreeData(tree)}
            defaultExpandAll
            onSelect={(keys) => setSelected(keys[0] as string | undefined)}
          />
        </Card>
        <Table<AdminMember> style={{ flex: 1 }} rowKey="name" columns={columns} dataSource={shown} size="small" />
      </div>
      <Modal
        title={granting ? `授予角色：${granting.displayName || granting.name}` : ''}
        open={granting !== null}
        onOk={onGrant}
        onCancel={() => setGranting(null)}
        destroyOnClose
      >
        <Form form={form}>
          <Form.Item name="roles" label="角色">
            <Select mode="multiple" options={roles.map((r) => ({ value: r.name, label: r.displayName || r.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
```

> 注：授角色语义见 `onGrant` 内注释——**按变更角色逐个整组替换成员**，不是改「用户的角色列表」（Casdoor 没有后者的写端点）。`u.roles`/`r.users` 两处都是**短名数组**（members/roles 端点已短名化），`setAdminRoleMembers` 直传短名、后端全形化——前后端口径一致。若实现中发现任一端点返回全形，在**后端**统一 strip（前端不做第二份清洗），并在测试里钉死。

- [ ] **Step 4: 绿 → Step 5: Commit**

```sh
git commit -m "feat(web): 组织架构页——部门树+成员表+授角色"
```

---

### Task 10: api.ts + 角色管理页

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/pages/admin/Roles.tsx`
- Test: `apps/web/src/pages/admin/Roles.test.tsx`

**Interfaces:**
- api.ts 追加:

```ts
export interface AdminRoleRow { name: string; displayName: string; members: number; codes: string[]; users: string[] }
export const listAdminRoles = () => request<{ roles: AdminRoleRow[] }>('/api/platform/admin/roles')
export const createAdminRole = (v: { name: string; displayName?: string }) =>
  csrfWrite<{ ok: true }>('/api/platform/admin/roles', 'POST', v)
export const deleteAdminRole = (name: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/roles/${encodeURIComponent(name)}`, 'DELETE')
export const setAdminRoleMembers = (name: string, users: string[]) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/roles/${encodeURIComponent(name)}/members`, 'PUT', { users })
export const grantAdminPermissionRole = (code: string, role: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/roles`, 'POST', { role })
export const revokeAdminPermissionRole = (code: string, role: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/roles`, 'DELETE', { role })
```

- [ ] **Step 1: 失败测试**：渲染角色表；建角色弹窗提交调 `createAdminRole`；删角色二次确认后调 `deleteAdminRole`；编辑成员勾选后调 `setAdminRoleMembers`；权限码勾选调 `grant/revokeAdminPermissionRole`。
- [ ] **Step 2: 确认失败 → Step 3: 实现**。页面结构：Card+Table（角色名/成员数/挂码数/操作）+ 建角色 Modal（name 校验正则 `^[^/?:#&%=+;]{1,64}$` 与后端同款、displayName 可选）+ 编辑 Modal 两段（成员多选：`listAdminMembers()` 全员为候选；权限码 Checkbox 组：`listAdminPermissions()` 的 code 清单，勾选变化即调 grant/revoke）。错误处理与 reload 顺序照 Users.tsx 纪律（**先 reload 再 message**）。
- [ ] **Step 4: 绿 → Step 5: Commit**

```sh
git commit -m "feat(web): 角色管理页——建删/成员管理/码↔角色勾选"
```

---

### Task 11: 菜单与路由注册

**Files:**
- Modify: `apps/web/src/pages/console-menu.ts`（adminGroup children）
- Modify: `apps/web/src/App.tsx`（静态路由）
- Test: `apps/web/src/pages/Console.test.tsx`

- [ ] **Step 1: 更新/断言测试**：Console.test.tsx 若断言管理组子项清单，补「组织架构」「角色管理」两项断言；无断言则新增一条 admin 组 children 快照式断言。
- [ ] **Step 2: console-menu.ts** 的 `adminGroup()` children 数组在「用户管理」之后插入：

```ts
{ path: '/console/admin/org-tree', name: '组织架构' },
{ path: '/console/admin/roles', name: '角色管理' },
```

- [ ] **Step 3: App.tsx** 静态路由区（`admin/users` 同款特异性排序区）插入（import 与现有 admin 页同款顶部 import）：

```tsx
{ path: 'admin/org-tree', element: <AdminGate><AdminOrgTreePage /></AdminGate> },
{ path: 'admin/roles', element: <AdminGate><AdminRolesPage /></AdminGate> },
```

- [ ] **Step 4: `pnpm --dir apps/web test` + `pnpm --dir apps/web typecheck` 绿 → Step 5: Commit**

```sh
git commit -m "feat(web): 管理组挂组织架构/角色管理两页（AdminGate 门禁）"
```

---

### Task 12: 全量验证 + issue/PR + 真机验收

**Files:** 无新文件（验证与交付门）

- [ ] **Step 1: 建 issue**（feat 先有 issue）：

```sh
gh issue create -R MYTech-Co-LTD/platform-core \
  -t "feat(auth): console 组织架构与角色管理后台" \
  -b "spec: docs/superpowers/specs/2026-10-24-shanhai-wecom-directory-and-org-admin-design.md；plan: docs/superpowers/plans/2026-10-24-shanhai-org-admin-console.md"
```

- [ ] **Step 2: 全量验证**（该仓 CI 同款命令全跑，不只本任务相关）：

```sh
pnpm -r --if-present test && pnpm run test:guard
pnpm -r --if-present typecheck
pnpm --dir apps/web build
```
Expected: 全绿（本地 server 测试需 DATABASE_URL，本地 compose pg 起好）。

- [ ] **Step 3: 分支推送 + PR**（`Closes #<Task 12 Step 1 的 issue 号>`；PR 标题 `feat(auth): console 组织架构与角色管理后台`）。

- [ ] **Step 4: 真机验收（dev-stack 先行，merge 后生产复验）**：
  1. dev-stack（MockCasdoor）起栈，浏览器走通：管理组见两新页 → 组织架构树渲染 → 建角色「门店店长」→ 挂 `demo:view` → 授给测试用户 → 该用户重新登录后菜单出现 → 收角色 → 消失（**这是 effectiveScopes 角色继承的最终判定**；MockCasdoor 的 get-user 已投影 roles，真机行为以 Task 1 spike 结论为准——若附录 A 在执行，此步验收的是展开后的链路）。
  2. merge main（CI CLEAN 才合；山海不在自动部署通路——生产复验走**山海手工更版 webhook 链路**，按长期记忆 `shanhai-manual-deploy-webhook` 的例行执行，属部署作业、不在本计划展开；merge 后先等同步侧 runbook 产出真实组织数据，生产复验才有内容可看）。

---

## 附录 A（条件任务）：session-middleware 角色展开

**执行条件：Task 1 Step 4 判定真机 get-user/get-users 不回填 roles。**
**Files:** `apps/server/src/session-middleware.ts`（内部分支 scopes 刷新处，~L184）+ 对应单测。

在 `getUser(name)` 之后、`effectiveScopes(name, roles, perms)` 之前插入展开：

```ts
// 真机 get-user 不回填 roles（Task 1 spike 结论）→ 读侧展开：
// 从角色清单反查该用户所属角色（users[] 短名/全形双认，matchUser 同口径）
const roleList = await client.listRoles()
const userRoles = roleList
  .filter((r) => r.users.some((u) => u === name || u.endsWith(`/${name}`)))
  .map((r) => r.name)
```

`effectiveScopes` 调用改传 `userRoles`。测试：mock-casdoor 场景下 get-user 不带 roles、role 挂用户 → 刷新后 scopes 含角色间接码；listRoles 抛错 → 降级沿用旧 scopes（与 Casdoor 拉取失败同一降级分支，不另设通道）。Commit: `fix(server): session scopes 读侧展开角色成员（真机不回填 roles 的兜底）`。

---

## 附录 B：Spike 形状记录（2026-10-24 实测回填）

**结论（决策门）：真机 get-user 回填 roles（shanhai/LiuHeFa 实证，返回完整 Role 对象数组）⇒ effectiveScopes 链路成立，附录 A 不执行。**

| # | 探针 | 预期（Casdoor master） | 实测 |
|---|---|---|---|
| orgs | get-organizations | — | `mytech / woke / customerb / built-in / shanhai / shanhaiyiguo-org`；**目标 org=`shanhaiyiguo-org`**（3 户/0 组/0 角色，platform 实例 `PLATFORM_ORG` 实证）；**`shanhai`（628 户/27 角色/49 组）是另一套生产体系，红线勿动**（用户 2026-10-24 明确指示） |
| a | get-roles 字段 | owner/name/displayName/users[] | ✅ 另有 `roles[]/domains[]/groups[]/isEnabled/description`；users 全形 `org/name` |
| b | get-groups 路径与字段 | get-groups?owner=；owner/name/parentId/title/isTopGroup | ✅ 路径同预期；**无 `title` 字段——显示名是 `displayName`**；parentId=父组**名**；顶层组 parentId 可为 `""` 也可为 org 名（mytech 顶层即 parentId="mytech"） |
| c | get-users 的 group/roles | group=裸名或全形 | **用户无 `group` 单数字段——是 `groups` 数组**（全形 `org/组名`；WeCom 已同步户有值，如 `["mytech/62"]`）；roles 键在但 null |
| d | get-user 的 roles 回填 | 预期非空 | ✅ **回填**（完整 Role 对象数组） |
| e | permission.roles 形态 | org/role 全形 | ✅ `{owner,name,users[],roles[],resources[],actions[],groups,...}` 与既有 grantPermissionToUser 假设一致 |
| f | 角色写形状（mytech org 实测，已清理） | add/update/delete | ✅ `add-role` body 含 `{owner,name,displayName,users,roles,domains,isEnabled}`；`update-role?id=<owner>/<name>` ok；`delete-role` JSON body `{owner,name}` ok |
| — | get-syncers | — | 全库仅 2 个 syncer：mytech WeCom（disabled/只读）、`shanhai` Database（disabled）——**目标 org 无既有 syncer**；`shanhai` 的 49 组非 syncer 产物（另一套体系的） |

**对 Task 2–10 的订正（以本表为准）：**
1. Group/树节点显示名用 `displayName`（无 `title`）；`CasdoorGroupLike/GroupTreeNode/AdminGroupNode` 的 `title` 字段全改 `displayName`。
2. 用户组键是 `groups: string[]`（全形 `org/组名`）——`CasdoorListedUser` 投影 `groups: string[]`（非 `group: string`）；成员/计数过滤 = `groups.some(g => g === name || g.endsWith('/' + name))`。
3. 树根判定：`parentId === '' || parentId === org || 父名不在集合` 时挂根；其中「parentId 非空、非 org、父又不存在」才算 `orphan`（buildGroupTree 需接收 org 参数区分）。
4. 角色写：客户端一律「get 原记录 → merge → update 全形」（update-role 整记录替换语义与 update-permission 同族）。
5. 登录体：`{type:'login',username,password,application}` **不带 organization**（带错报 user-not-found）；新版 Casdoor 发两个 session cookie，取最后一个。
