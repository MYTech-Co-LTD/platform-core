// channel-address.test.ts — Casdoor 用户 → 渠道地址（2026-10-27 通知基础设施 §4.3）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { createChannelAddressResolver } from './channel-address'
import { runMigrations } from './migrate'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

describePg('channel-address', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.end()
  })

  it('wecom 走 identity_link；无绑定/跨 org 返回 null；in_app 用 Casdoor 名', async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.query(
      `insert into platform.identity_link(org,provider,external_id,casdoor_name,status,bound_via)
       values ('org-ca','wecom','wecom-u1','u1','active','manual')`,
    )

    const r = createChannelAddressResolver({ pool })
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u1' })).toBe('wecom-u1')
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u2' })).toBeNull()
    expect(await r.resolve({ org: 'org-other', provider: 'wecom_chat', casdoorName: 'u1' })).toBeNull()
    expect(await r.resolve({ org: 'org-ca', provider: 'in_app', casdoorName: 'u1' })).toBe('u1')
    expect(await r.resolve({ org: 'org-ca', provider: 'webhook', casdoorName: 'u1' })).toBeNull()
  })

  it('只认 active 绑定（pending/revoked 不解析）', async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.query(
      `insert into platform.identity_link(org,provider,external_id,casdoor_name,status,bound_via)
       values ('org-ca','wecom','wecom-p','u-p','pending','manual')`,
    )
    const r = createChannelAddressResolver({ pool })
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u-p' })).toBeNull()
  })
})

// ── 部门展开（组织架构 Phase C；spec 2026-10-30 §3.5）─────────────────────────────
// 断言的是**授权结果**（谁收到 / 谁被排除 / 谁没解析出来），不是 SQL 形状。
describePg('channel-address: resolveDeptMembers', () => {
  const ORG = 'org-ca-dept'
  const TENANT = 9411
  const ROOT = 'CA1'          // 共享中心
  const CHILD = 'CA2'         // 数字技术部（ROOT 的子部门）
  const OTHER = 'CA3'         // 销售部（另一支）
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
    await pool.query(
      `insert into platform.tenant(id, slug, casdoor_org) values ($1,$2,$3) on conflict (id) do nothing`,
      [TENANT, 'ca-dept', ORG],
    )
    const dept = (ext: string, name: string, parent: string | null, path: string) =>
      pool.query(
        `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
         values ($1,$2,$3,$4,$5,1)
         on conflict (tenant_id, ext_id) do update
           set name=excluded.name, parent_ext_id=excluded.parent_ext_id, path=excluded.path, status=1`,
        [TENANT, ext, name, parent, path],
      )
    await dept(ROOT, '共享中心', null, ROOT)
    await dept(CHILD, '数字技术部', ROOT, `${ROOT}.${CHILD}`)
    await dept(OTHER, '销售部', null, OTHER)
    const member = (user: string, ext: string) =>
      pool.query(
        `insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary)
         values ($1,$2,$3,true) on conflict do nothing`,
        [TENANT, user, ext],
      )
    await member('alice', CHILD)     // 子部门成员（靠子树继承命中）
    await member('bob', ROOT)        // 父部门直属
    await member('carol', OTHER)     // 另一支
    await member('ghost', ROOT)      // org 表有、Casdoor 没有（未解析）
  })

  afterAll(async () => {
    await pool.query('delete from platform.org_membership where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.tenant where id=$1', [TENANT]).catch(() => {})
    await pool.end()
  })

  /**
   * Casdoor 假面：alice/bob/carol 存在，bob 被禁用；ghost 不存在。
   * 权限面（#1179）：`m:manage` 直挂 alice + 角色 `mgr` 的成员 carol。
   */
  const fakeCasdoor = () => ({
    listUsers: async () => [
      { name: 'alice', displayName: 'alice', isForbidden: false, groups: [], roles: [] },
      { name: 'bob', displayName: 'bob', isForbidden: true, groups: [], roles: [] },
      { name: 'carol', displayName: 'carol', isForbidden: false, groups: [], roles: [] },
    ],
    getPermissions: async () => [{ resources: ['m:manage'], users: ['alice'], roles: ['mgr'] }],
    listRoles: async () => [{ name: 'mgr', users: ['carol'] }],
  })

  it('★ 子树继承 + 排除禁用 + 未解析计数（三数同源）', async () => {
    const r = createChannelAddressResolver({ pool, casdoorFor: () => fakeCasdoor() })
    const exp = await r.resolveDeptMembers!(ORG, [ROOT])
    // ROOT 子树 = ROOT + CHILD ⇒ 成员 alice/bob/ghost；carol 在别的支 ⇒ 不在
    expect(exp.depts.sort()).toEqual([ROOT, CHILD].sort())
    expect(exp.members).toBe(3)
    expect(exp.names).toEqual(['alice'])          // bob 禁用、ghost 未解析
    expect(exp.excluded).toBe(1)
    expect(exp.unresolved).toBe(1)
  })

  it('选子部门只取到子部门（不反向包含父部门成员）', async () => {
    const r = createChannelAddressResolver({ pool, casdoorFor: () => fakeCasdoor() })
    const exp = await r.resolveDeptMembers!(ORG, [CHILD])
    expect(exp.depts).toEqual([CHILD])
    expect(exp.names).toEqual(['alice'])
  })

  it('多选部门 ⇒ 并集去重；未知/空 id ⇒ 空展开（不炸）', async () => {
    const r = createChannelAddressResolver({ pool, casdoorFor: () => fakeCasdoor() })
    const exp = await r.resolveDeptMembers!(ORG, [ROOT, OTHER])
    expect(exp.names.sort()).toEqual(['alice', 'carol'])
    expect(exp.members).toBe(4)
    expect(await r.resolveDeptMembers!(ORG, [])).toMatchObject({ names: [], depts: [], members: 0 })
    expect(await r.resolveDeptMembers!(ORG, ['NOPE'])).toMatchObject({ names: [], depts: [] })
  })

  it('未注入 Casdoor ⇒ 不做禁用过滤（如实回 0/0，调用方决定信不信）', async () => {
    const r = createChannelAddressResolver({ pool })
    const exp = await r.resolveDeptMembers!(ORG, [ROOT])
    expect(exp.names.sort()).toEqual(['alice', 'bob', 'ghost'])
    expect(exp).toMatchObject({ excluded: 0, unresolved: 0 })
  })

  // ── 权限码持有者（issue #1179：控制台预检与 worker 同一份口径）─────────────────
  it('★ resolveScopeHolders：按**收件人档**取码（直挂 ∪ 角色展开，与 worker 同一语义）', async () => {
    const r = createChannelAddressResolver({ pool, casdoorFor: () => fakeCasdoor() })
    expect(r.resolveScopeHolders).toBeDefined()
    const decl = {
      key: 'm.a.b', title: '', payload: {},
      recipients: { mgrs: { kind: 'scope_holders' as const, scope: 'm:manage' } },
    }
    // ⚠️ 传的是**档名** `mgrs`，不是权限码——码从 decl 里取（2026-10-30 实测订正：
    //    把 key 当码用 ⇒ collectHolders 恒空 ⇒ 控制台永远「0 人」）
    const names = await r.resolveScopeHolders!(ORG, 'mgrs', decl)
    expect(names.sort()).toEqual(['alice', 'carol'])
  })

  it('非 scope_holders 档 / 未知档 ⇒ 空且**不调 Casdoor**（不白跑一次 admin 会话）', async () => {
    let called = false
    const r = createChannelAddressResolver({
      pool, casdoorFor: () => { called = true; return fakeCasdoor() },
    })
    const decl = {
      key: 'm.a.b', title: '', payload: {},
      recipients: { one: { kind: 'field' as const, field: 'u' } },
    }
    expect(await r.resolveScopeHolders!(ORG, 'one', decl)).toEqual([])
    expect(await r.resolveScopeHolders!(ORG, 'nope', decl)).toEqual([])
    // `createScopeHolderResolver` 惰性取客户端：没命中 scope_holders 档 ⇒ 一次 Casdoor 都不打
    expect(called).toBe(false)
  })

  it('缺 casdoorFor ⇒ 不提供该方法（调用方据此报 unavailable，而不是拿到假空集）', () => {
    const r = createChannelAddressResolver({ pool })
    expect(r.resolveScopeHolders).toBeUndefined()
    expect(r.resolveDeptMembers).toBeDefined()
  })

  it('选择器平表：活节点 + 直属人数 + 按 path 深度优先', async () => {
    const r = createChannelAddressResolver({ pool })
    const nodes = await r.listOrgNodes!(ORG)
    expect(nodes.map((n) => n.extId)).toEqual([ROOT, CHILD, OTHER])   // path 序：CA1, CA1.CA2, CA3
    expect(nodes.find((n) => n.extId === ROOT)).toMatchObject({ name: '共享中心', parentExtId: null, memberCount: 2 })
    expect(nodes.find((n) => n.extId === CHILD)).toMatchObject({ parentExtId: ROOT, memberCount: 1 })
  })
})
