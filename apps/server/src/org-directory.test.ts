// org-directory.test.ts — 宿主组织查询面（`ModuleContext.org`，计划 T2 / OA spec §5）。
// 真 PG（本地 docker postgres:16，同 org-sync.test.ts 约定）：未提供 DATABASE_URL 时整体跳过。
//
// 夹具用**专用租户**（不是 acme）：org-sync.test.ts 会整组清空 acme 的 org 表，
// 两个文件在 CI 里是并行 worker —— 共用租户 = 互相踩（channel-address.test.ts 同款取舍）。
// 因此本文件的断言不依赖任何种子数据，全部自建自清。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from './migrate'
import { createOrganizationPort } from './org-directory'

const dbUrl = process.env.DATABASE_URL
const d = dbUrl ? describe : describe.skip

const TENANT = 9413
const ORG = 'org-dir-test'
/** 部门 10（根）/ 11（10 的子部门）——子树展开与「不展开」两侧都要有非空夹具 */
const ROOT = '10'
const CHILD = '11'

d('org-directory（OrganizationPort）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
    await pool.query(
      `insert into platform.tenant(id, slug, casdoor_org) values ($1,$2,$3)
       on conflict (id) do update set casdoor_org = excluded.casdoor_org`,
      [TENANT, 'org-dir', ORG],
    )
    const dept = (ext: string, name: string, parent: string | null, path: string) =>
      pool.query(
        `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
         values ($1,$2,$3,$4,$5,1)
         on conflict (tenant_id, ext_id) do update
           set name=excluded.name, parent_ext_id=excluded.parent_ext_id, path=excluded.path, status=1`,
        [TENANT, ext, name, parent, path],
      )
    await dept(ROOT, '总部', null, ROOT)
    await dept(CHILD, '数字技术部', ROOT, `${ROOT}.${CHILD}`)
    // 软删部门：子树展开必须排除（status=0 的人不算「在册」）
    await dept('12', '已撤销部门', ROOT, `${ROOT}.12`)
    await pool.query('update platform.org_node set status = 0 where tenant_id=$1 and ext_id=$2', [TENANT, '12'])

    const member = (user: string, ext: string, primary: boolean) =>
      pool.query(
        `insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary, source, external_id)
         values ($1,$2,$3,$4,'wecom',$2)
         on conflict (tenant_id, user_name, ext_id) do update set is_primary = excluded.is_primary`,
        [TENANT, user, ext, primary],
      )
    await member('u1', ROOT, true)          // 总部直属
    await member('u3', CHILD, true)         // 子部门成员
    await member('u3', ROOT, false)         // 同一人另有非主部门（primaryDeptOf 要挑对）
    await member('gone', '12', true)        // 软删部门里的人：子树展开不该带出

    const leader = (ext: string, user: string, sort: number) =>
      pool.query(
        `insert into platform.org_node_leader(tenant_id, node_ext_id, user_name, sort)
         values ($1,$2,$3,$4)
         on conflict (tenant_id, node_ext_id, user_name) do update set sort = excluded.sort`,
        [TENANT, ext, user, sort],
      )
    await leader(ROOT, 'u2', 1)   // 顺序故意倒着插：断言靠 sort，不靠插入顺序
    await leader(ROOT, 'u-lead', 0)
    await leader(CHILD, 'u-child-lead', 2) // 子部门负责人：不展开子树时不得出现

    await pool.query(
      `insert into platform.org_role_binding(tenant_id, node_ext_id, user_name, role, granted_by)
       values ($1,$2,$3,'dept_admin','seed-test')
       on conflict (tenant_id, node_ext_id, user_name, role) do nothing`,
      [TENANT, ROOT, 'u-admin'],
    )
  })

  afterAll(async () => {
    await pool.query('delete from platform.org_node_leader where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.org_role_binding where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.org_membership where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id=$1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.tenant where id=$1', [TENANT]).catch(() => {})
    await pool.end()
  })

  it('listDeptLeaders 按部门返回负责人（保持 sort），不展开子树', async () => {
    const port = createOrganizationPort({ pool })
    expect(await port.listDeptLeaders(ORG, [ROOT])).toEqual(['u-lead', 'u2'])
    // 子部门负责人只在单独点名时出现（② vs ③：负责人不继承）
    expect(await port.listDeptLeaders(ORG, [CHILD])).toEqual(['u-child-lead'])
    expect(await port.listDeptLeaders(ORG, [ROOT, CHILD])).toEqual(['u-lead', 'u2', 'u-child-lead'])
    expect(await port.listDeptLeaders(ORG, [])).toEqual([])
  })

  it('listSubtreeMembers 含子部门成员并去重；软删部门的人不算', async () => {
    const port = createOrganizationPort({ pool })
    expect(await port.listSubtreeMembers(ORG, [ROOT])).toEqual(['u1', 'u3'])
    // 只点名子部门 ⇒ 只剩子部门成员
    expect(await port.listSubtreeMembers(ORG, [CHILD])).toEqual(['u3'])
    // 软删部门（status=0）即使被点名也不展开
    expect(await port.listSubtreeMembers(ORG, ['12'])).toEqual([])
  })

  it('primaryDeptOf 取 is_primary 优先', async () => {
    const port = createOrganizationPort({ pool })
    expect(await port.primaryDeptOf(ORG, 'u3')).toBe(CHILD) // 非主部门 ROOT 不得胜出
    expect(await port.primaryDeptOf(ORG, 'u1')).toBe(ROOT)
    expect(await port.primaryDeptOf(ORG, 'nobody')).toBeNull()
  })

  it('listDeptAdmins 只认 role=dept_admin', async () => {
    const port = createOrganizationPort({ pool })
    expect(await port.listDeptAdmins(ORG, [ROOT])).toEqual(['u-admin'])
    expect(await port.listDeptAdmins(ORG, [CHILD])).toEqual([])
  })

  it('listRoleMembers 剥 org 前缀；无 Casdoor 客户端 ⇒ 空数组（查不了 ≠ 没人）', async () => {
    const casdoorFor = () => ({
      listRoles: async () => [
        { name: 'mgr', users: [`${ORG}/u-lead`, 'u2'] },
        { name: 'other', users: ['x'] },
      ],
    })
    const port = createOrganizationPort({ pool, casdoorFor })
    expect(await port.listRoleMembers(ORG, 'mgr')).toEqual(['u-lead', 'u2'])
    expect(await port.listRoleMembers(ORG, 'missing')).toEqual([])

    const bare = createOrganizationPort({ pool })
    expect(await bare.listRoleMembers(ORG, 'mgr')).toEqual([])
  })

  it('未知 org ⇒ 空结果（不是抛错，也不是 403）', async () => {
    const port = createOrganizationPort({ pool })
    expect(await port.listDeptLeaders('nope-org', [ROOT])).toEqual([])
    expect(await port.listSubtreeMembers('nope-org', [ROOT])).toEqual([])
    expect(await port.listDeptAdmins('nope-org', [ROOT])).toEqual([])
    expect(await port.primaryDeptOf('nope-org', 'u1')).toBeNull()
  })
})
