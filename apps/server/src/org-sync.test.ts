// org-sync.test.ts — 组织同步器（spec 2026-10-30 §3.2，#1171 Phase A）。
// 真 PG + 注入假企微/假 Casdoor（fetch 与 OrgSeedCasdoor 均可注入）。
// 未提供 DATABASE_URL 时整体跳过（auth.test.ts 同款约定）。
// 覆盖：三纪律（只读/fail-closed 两门/软删）、dry-run 零写、apply 幂等、path 物化、
// Casdoor 种子归一、usersNotInCasdoor 清单。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from './migrate'
import { seedDemo } from './seed'
import {
  applySnapshot, assertSnapshotViable, fetchWecomSnapshot, runOrgSync,
  snapshotFromCasdoor, OrgSyncError, type OrgSnapshot,
} from './org-sync'
import { countNodes, listNodes, membersOf, memberCounts, orgTreeOf } from './org-store'

const dbUrl = process.env.DATABASE_URL
const d = dbUrl ? describe : describe.skip

/** 假企微 fetch：三段式（gettoken → department/list → user/list），形状按 2026-10-28 真机实测。 */
function fakeWecom(depts: Array<{ id: number; name: string; parentid: number }>,
  users: Array<{ userid: string; department: number[]; main_department?: number }>,
  token = 'tok') {
  return (async (input: RequestInfo | URL) => {
    const u = String(input)
    if (u.includes('/gettoken')) return Response.json({ errcode: 0, access_token: token, expires_in: 7200 })
    if (u.includes('/department/list')) return Response.json({ errcode: 0, department: depts })
    if (u.includes('/user/list')) return Response.json({ errcode: 0, userlist: users })
    return Response.json({ errcode: -1, errmsg: 'unknown ' + u })
  }) as typeof fetch
}

const DEPTS = [
  { id: 1, name: '山海一果', parentid: 0 },
  { id: 49, name: '共享中心', parentid: 1 },
  { id: 57, name: '数字技术部', parentid: 49 },
  { id: 2, name: '总经办', parentid: 1 },
]
const USERS = [
  { userid: 'yangwei', department: [57], main_department: 57 },
  { userid: 'ZhangDuo', department: [2], main_department: 2 },
  { userid: 'duo', department: [2, 57], main_department: 2 }, // 一人多部门
  { userid: 'ghost', department: [57], main_department: 57 }, // 企微有/Casdoor 无
]

d('org-sync（企微组织 → 平台 org 表）', () => {
  let pool: Pool
  let tenantId: number
  const CASDOOR_NAMES = new Set(['yangwei', 'ZhangDuo', 'duo'])

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
    await seedDemo(pool)
    const { rows } = await pool.query<{ id: number }>("select id from platform.tenant where slug = 'acme'")
    tenantId = rows[0]!.id
  })
  afterAll(async () => { await pool.end() })

  async function clean() {
    await pool.query('delete from platform.org_membership where tenant_id = $1', [tenantId])
    await pool.query('delete from platform.org_node where tenant_id = $1', [tenantId])
  }

  it('fetchWecomSnapshot：拉取 + parentid 0/1 归一为根 + isPrimary 跟随 main_department', async () => {
    const snap = await fetchWecomSnapshot({ corpId: 'ww1', secret: 's' }, fakeWecom(DEPTS, USERS))
    expect(snap.depts).toEqual([
      { extId: '1', name: '山海一果', parentExtId: null },
      { extId: '49', name: '共享中心', parentExtId: null },   // parentid=1 → 根（与 10-29 基线一致）
      { extId: '57', name: '数字技术部', parentExtId: '49' },
      { extId: '2', name: '总经办', parentExtId: null },
    ])
    expect(snap.memberships).toContainEqual({ userName: 'duo', extId: '2', isPrimary: true, externalId: 'duo' })
    expect(snap.memberships).toContainEqual({ userName: 'duo', extId: '57', isPrimary: false, externalId: 'duo' })
  })

  it('fail-closed 门一：0 部门 ⇒ EMPTY_DEPARTMENTS（变异确认：门真的会被触发）', () => {
    expect(() => assertSnapshotViable({ depts: [], memberships: [] }, 0))
      .toThrowError(OrgSyncError)
    expect(() => assertSnapshotViable({ depts: [], memberships: [] }, 0))
      .toThrowError(/EMPTY_DEPARTMENTS/)
  })

  it('fail-closed 门二：部门数断崖（<现存 50%）⇒ DEPT_COUNT_DROP', () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({ ext_id: String(i), name: 'n', parent_ext_id: null, status: 1 }))
    expect(() => assertSnapshotViable({ depts: new Array(40).fill(0).map((_, i) => ({ extId: String(i), name: 'n', parentExtId: null })), memberships: [] }, existing.length))
      .toThrowError(/DEPT_COUNT_DROP/)
  })

  it('runOrgSync dry-run（缺省写路径的对照面）：零写入 + plan 数字准确', async () => {
    await clean()
    const snap = await fetchWecomSnapshot({ corpId: 'ww1', secret: 's' }, fakeWecom(DEPTS, USERS))
    const r = await runOrgSync(pool, tenantId, snap, { dryRun: true, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    expect(r.dryRun).toBe(true)
    expect(r).toMatchObject({ deptCount: 4, userCount: 4, nodesCreated: 4, membersAdded: 5 })
    expect(r.usersNotInCasdoor).toEqual(['ghost'])
    expect(await countNodes(pool, tenantId)).toBe(0) // 未写库
  })

  it('apply：树/path/成员落库正确，幂等重跑 diff 全零', async () => {
    await clean()
    const snap = await fetchWecomSnapshot({ corpId: 'ww1', secret: 's' }, fakeWecom(DEPTS, USERS))
    const r1 = await runOrgSync(pool, tenantId, snap, { dryRun: false, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    expect(r1.nodesCreated).toBe(4)
    // path 物化：子树入口（D-O3 的实现基础）
    const nodes = await listNodes(pool, tenantId)
    const pathOf = new Map(nodes.map((n) => [n.extId, n.path]))
    expect(pathOf.get('57')).toBe('49.57')
    expect(pathOf.get('1')).toBe('1')
    // 成员：正查（部门→人）与计数
    expect(await membersOf(pool, tenantId, '57')).toEqual(['duo', 'ghost', 'yangwei'])
    const counts = await memberCounts(pool, tenantId)
    expect(counts.get('57')).toBe(3)
    expect(counts.get('2')).toBe(2)
    // 树形状：57 挂在 49 下（orgTreeOf 复用 buildGroupTree）
    const tree = orgTreeOf('acme', nodes, counts)
    const g49 = tree.find((n) => n.name === '49')
    expect(g49?.children.map((n) => n.name)).toEqual(['57'])
    // spec 2026-10-31 §3.2：来源与渠道原生地址必须落库（解析的第一优先来源）
    const ident = await pool.query<{ source: string; external_id: string }>(
      "select source, external_id from platform.org_membership where tenant_id = $1 and user_name = 'yangwei'",
      [tenantId],
    )
    expect(ident.rows[0]).toEqual({ source: 'wecom', external_id: 'yangwei' })

    // 幂等：同快照重跑 ⇒ 除计数外 diff 全零
    const r2 = await runOrgSync(pool, tenantId, snap, { dryRun: false, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    expect(r2).toMatchObject({
      nodesCreated: 0, nodesRenamed: 0, nodesReparented: 0, nodesDisabled: 0,
      membersAdded: 0, membersRemoved: 0,
    })
  })

  it('软删纪律：部门从快照消失 ⇒ status=0（不物理删），其成员退出计数/正查', async () => {
    await clean()
    const snap = await fetchWecomSnapshot({ corpId: 'ww1', secret: 's' }, fakeWecom(DEPTS, USERS))
    await runOrgSync(pool, tenantId, snap, { dryRun: false, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    // 新快照：数字技术部(57)整个消失，但部门数 3 ≥ 4×0.5，不触断崖门
    const snap2 = await fetchWecomSnapshot({ corpId: 'ww1', secret: 's' },
      fakeWecom(DEPTS.filter((d) => d.id !== 57), USERS.map((u) => ({ ...u, department: u.department.filter((x) => x !== 57) }))))
    const r = await runOrgSync(pool, tenantId, snap2, { dryRun: false, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    expect(r.nodesDisabled).toBe(1)
    expect(r.membersRemoved).toBe(3) // yangwei + duo + ghost 在 57 的行
    const nodes = await listNodes(pool, tenantId)
    expect(nodes.find((n) => n.extId === '57')?.status).toBe(0)   // 软删在库
    expect(await membersOf(pool, tenantId, '57')).toEqual([])      // 正查排除
    expect((await memberCounts(pool, tenantId)).get('57')).toBeUndefined()
    // 复活：57 回到快照 ⇒ reactivated（不是新建）
    const r3 = await runOrgSync(pool, tenantId, snap, { dryRun: false, casdoorNames: CASDOOR_NAMES, source: 'wecom' })
    expect(r3.nodesReactivated).toBe(1)
    expect(r3.nodesCreated).toBe(0)
  })

  it('Casdoor 种子（source=casdoor）：groups/users → 快照归一（前缀剥离 + 根归一）', async () => {
    const cas = {
      listGroups: async () => [
        { name: '49', displayName: '共享中心', parentId: 'acme' },
        { name: '57', displayName: '数字技术部', parentId: 'acme/49' },
        { name: '2', displayName: '总经办', parentId: '' },
      ],
      listUsers: async () => [
        { name: 'yangwei', groups: ['acme/57'] },
        { name: 'ZhangDuo', groups: ['acme/2'] },
        { name: 'legacy', groups: ['2'] }, // 裸名历史形态也要认（matchUser 双口径同源）
      ],
    }
    const snap = await snapshotFromCasdoor('acme', cas)
    expect(snap.depts).toEqual(expect.arrayContaining([
      { extId: '49', name: '共享中心', parentExtId: null },
      { extId: '57', name: '数字技术部', parentExtId: '49' },
      { extId: '2', name: '总经办', parentExtId: null },
    ]))
    expect(snap.memberships).toContainEqual({ userName: 'legacy', extId: '2', isPrimary: false, externalId: null })
    // 种子可 apply（基线路径与企微路径共用同一 apply）
    await clean()
    const r = await runOrgSync(pool, tenantId, snap, { dryRun: false, casdoorNames: new Set(['yangwei', 'ZhangDuo', 'legacy']), source: 'casdoor' })
    expect(r.nodesCreated).toBe(3)
  })

  it('applySnapshot 事务性：快照含悬空 parentExtId（孤儿）不炸——落根，path=自身', async () => {
    await clean()
    const snap: OrgSnapshot = {
      depts: [
        { extId: '10', name: '正常', parentExtId: null },
        { extId: '99', name: '孤儿', parentExtId: '不存在' },
      ],
      memberships: [],
    }
    await applySnapshot(pool, tenantId, snap, 'wecom')
    const nodes = await listNodes(pool, tenantId)
    const orphan = nodes.find((n) => n.extId === '99')
    expect(orphan?.path).toBe('99') // 环/孤儿守卫：path=extId，不递归炸栈
  })
})
