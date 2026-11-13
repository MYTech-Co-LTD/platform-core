// org-tree-check.test.ts — 组织树一致性检查（P2 Task 1，spec §17.1 前置门）
//
// 结构：judgeOrgTree 是**纯函数**（喂行数组，不占库）——夹具覆盖
//   干净 / 环 / 悬挂父 / 重复 / 死节点挂人 / 仅告警（深度+空支）/ 多租户同 ext_id，
//   无 DATABASE_URL 也全跑。
// checkOrgTree 是薄 SQL 壳（视图只读，夹具进不去），冒烟一条：真实视图上
//   返回良构报告且本地现存数据 0 错误——有 DATABASE_URL 才跑。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { checkOrgTree, judgeOrgTree, MAX_DEPTH } from './org-tree-check'
import type { OrgMembershipRow, OrgNodeRow, OrgTreeIssue } from './org-tree-check'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

function node(over: Partial<OrgNodeRow> & { extId: string; path: string }): OrgNodeRow {
  return { tenantId: 1, name: `部门${over.extId}`, status: 1, ...over }
}
function ms(userName: string, extId: string, tenantId = 1): OrgMembershipRow {
  return { tenantId, userName, extId }
}
const kinds = (errors: OrgTreeIssue[]) => errors.map((e) => e.kind)

describe('judgeOrgTree（纯判定，喂行数组）', () => {
  it('干净树：0 错误 0 告警（根 path 只含自身不是环）', () => {
    const nodes = [
      node({ extId: '49', path: '49' }),
      node({ extId: '57', path: '49.57' }),
      node({ extId: '66', path: '49.57.66' }),
    ]
    const r = judgeOrgTree(1, nodes, [ms('a', '49'), ms('b', '57'), ms('c', '66')])
    // 回归卫：物化 path 惯例**含自身**（dept-gate 按段拆闭包）——「末段=自身」绝不能判环
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.nodes).toBe(3)
    expect(r.tenantId).toBe(1)
  })

  it('环：祖先段含自身 ⇒ cycle（path "49.57.57"）', () => {
    const nodes = [
      node({ extId: '49', path: '49' }),
      node({ extId: '57', path: '49.57.57' }),
    ]
    const r = judgeOrgTree(1, nodes, [ms('a', '49'), ms('b', '57')])
    expect(kinds(r.errors)).toEqual(['cycle'])
    expect(r.errors[0]).toMatchObject({ kind: 'cycle', tenantId: 1 })
    expect(r.errors[0].detail).toContain('57')
  })

  it('悬挂父（plan 判据）：path 首段 99 不存在 ⇒ dangling_parent', () => {
    const nodes = [node({ extId: '57', path: '99.57' })]
    const r = judgeOrgTree(1, nodes, [ms('a', '57')])
    expect(kinds(r.errors)).toEqual(['dangling_parent'])
    expect(r.errors[0].detail).toContain('99')
  })

  it('悬挂父（泛化）：祖先中段 98 缺失同样报（path "49.98.66"）', () => {
    const nodes = [
      node({ extId: '49', path: '49' }),
      node({ extId: '66', path: '49.98.66' }),
    ]
    const r = judgeOrgTree(1, nodes, [ms('a', '49'), ms('b', '66')])
    expect(kinds(r.errors)).toEqual(['dangling_parent'])
    expect(r.errors[0].detail).toContain('98')
  })

  it('死节点挂人：status=0 与节点不存在都点名（dept-gate 的 join 会静默丢）', () => {
    const nodes = [
      node({ extId: '49', path: '49' }),
      node({ extId: '99', path: '99', status: 0 }),
    ]
    const r = judgeOrgTree(1, nodes, [ms('u1', '99'), ms('u2', '123'), ms('u3', '49')])
    expect(kinds(r.errors)).toEqual(['dead_node_membership', 'dead_node_membership'])
    expect(r.errors[0].detail).toContain('u1')
    expect(r.errors[0].detail).toContain('99')
    expect(r.errors[1].detail).toContain('u2')
    expect(r.errors[1].detail).toContain('123')
  })

  it('重复：同租户 ext_id 出现两次 ⇒ duplicate_ext_id', () => {
    const nodes = [
      node({ extId: '49', path: '49' }),
      node({ extId: '57', path: '49.57' }),
      node({ extId: '57', path: '49.57', name: '重名行' }),
    ]
    const r = judgeOrgTree(1, nodes, [ms('a', '49'), ms('b', '57')])
    expect(kinds(r.errors)).toEqual(['duplicate_ext_id'])
    expect(r.errors[0].detail).toContain('2')
  })

  it('多租户：同 ext_id 跨租户不判重；issue 各自带 tenantId', () => {
    const nodes = [
      node({ tenantId: 1, extId: '57', path: '57' }),
      node({ tenantId: 2, extId: '57', path: '57' }),
      node({ tenantId: 2, extId: '88', path: '77.88' }), // 租户2 悬挂父
    ]
    const r = judgeOrgTree(
      'all', nodes,
      [ms('a', '57', 1), ms('b', '57', 2)],
    )
    expect(kinds(r.errors)).toEqual(['dangling_parent'])
    expect(r.errors[0].tenantId).toBe(2)
    expect(r.tenantId).toBe('all')
    expect(r.nodes).toBe(3)
  })

  it('深度>10 与空支（活节点无 membership）只告警不红', () => {
    // 一条 11 段的链：extId 1..11，path 逐段拼接（祖先段必须都在节点集里，否则是悬挂不是深度）
    const segs: string[] = []
    for (let i = 1; i <= MAX_DEPTH + 1; i += 1) segs.push(String(i))
    const deep = segs[segs.length - 1]
    const nodes = segs.map((seg, i) => node({ extId: seg, path: segs.slice(0, i + 1).join('.') }))
    const r = judgeOrgTree(1, nodes, [ms('a', '1')])
    expect(r.errors).toEqual([])
    expect(r.warnings.length).toBe(segs.length) // 10 条空支 + 1 条深度
    expect(r.warnings.some((w) => w.includes(deep) && w.includes('深度'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('节点 2(') && w.includes('membership'))).toBe(true)
  })

  it('死节点不参与深度/空支告警（只在重复与死挂里现身）', () => {
    const nodes = [node({ extId: '99', path: '99', status: 0 })]
    const r = judgeOrgTree(1, nodes, [])
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('全空：无节点无成员 ⇒ 良构空报告', () => {
    const r = judgeOrgTree('all', [], [])
    expect(r).toEqual({ tenantId: 'all', nodes: 0, errors: [], warnings: [] })
  })
})

describePg('org-tree-check 冒烟（真实视图，需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(() => pool.end())

  it('checkOrgTree 对真实视图返回良构报告；本地现存数据 0 错误', async () => {
    await applyMigrations(pool)
    const report = await checkOrgTree(pool)
    expect(report.tenantId).toBe('all')
    expect(report.nodes).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(report.warnings)).toBe(true)
    expect(report.errors).toEqual([])
    // 单租户窄化：tenantId 透传，节点数不超过全租户
    const one = await checkOrgTree(pool, 1)
    expect(one.tenantId).toBe(1)
    expect(one.nodes).toBeLessThanOrEqual(report.nodes)
  })
})
