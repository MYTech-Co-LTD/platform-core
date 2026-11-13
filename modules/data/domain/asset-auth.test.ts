// asset-auth.test.ts — 资产级授权（spec 2026-11-01 §4）
//
// 纯函数部分穷举判据；存储部分（owner/viewer 落库、幂等、审计）走真 PG。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  applyPanelRenderGate, canEditAsset, canViewAsset, ensureOwner, factsSpecOf, isAdminOverride, isOwner,
  loadAssetAcl, replaceViewers, writeAssetAudit,
  type AclRow, type RenderGateMetric,
} from './asset-auth'
import type { DeptContext } from './metric-visibility'
import { parseReportSpec } from './report-spec'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

const req = (userId: string, scopes: string[] = []) => ({
  userId,
  hasScope: (code: string) => scopes.includes(code),
})
const row = (over: Partial<{ visibility: 'tenant' | 'restricted'; requiredScope: string | null; requiredDepts: string[] | null }> = {}) => ({
  visibility: 'restricted' as const,
  requiredScope: null,
  requiredDepts: null,
  ...over,
})
const ownerRow = (user: string): AclRow => ({ subjectType: 'user', subjectId: user, relation: 'owner' })
const viewer = (t: AclRow['subjectType'], id: string): AclRow => ({ subjectType: t, subjectId: id, relation: 'viewer' })

describe('canViewAsset', () => {
  it('★ owner 恒可见（即使是 restricted 且无 viewer）', () => {
    expect(canViewAsset(row(), req('alice'), [ownerRow('alice')], undefined)).toBe(true)
  })

  it('★ restricted + 非 owner + 无 grant ⇒ 拒（**不回落旧粗门**）', () => {
    // 旧粗门允许「所有拿到本模块的人」；restricted 的意义就是不看它
    expect(canViewAsset(row({ requiredScope: null }), req('bob', ['data:query']), [ownerRow('alice')], undefined))
      .toBe(false)
  })

  it('★ 三类受让方都生效：点名 / 部门（在闭包内）/ 权限码', () => {
    const acl = [ownerRow('alice'), viewer('user', 'bob'), viewer('dept', '57'), viewer('scope', 'data:query')]
    expect(canViewAsset(row(), req('bob'), acl, undefined)).toBe(true)
    expect(canViewAsset(row(), req('carol'), acl, new Set(['49', '57']))).toBe(true)
    expect(canViewAsset(row(), req('dave', ['data:query']), acl, undefined)).toBe(true)
  })

  it('★ 部门受让方在"部门未解析"时**不算命中**（fail-closed）', () => {
    const acl = [ownerRow('alice'), viewer('dept', '57')]
    expect(canViewAsset(row(), req('carol'), acl, undefined)).toBe(false)
    expect(canViewAsset(row(), req('carol'), acl, new Set(['57']))).toBe(true)
  })

  it('history: visibility=tenant ⇒ 行为与改造前一致（旧粗门 + 部门门）', () => {
    const acl = [ownerRow('alice')]
    // requiredScope=null（本域兼"已发布"）⇒ 拿到模块的人可见
    expect(canViewAsset(row({ visibility: 'tenant' }), req('bob', ['data:query']), acl, undefined)).toBe(true)
    // 有内容门 ⇒ 要有码
    expect(canViewAsset(row({ visibility: 'tenant', requiredScope: 'data:query' }), req('bob'), acl, undefined)).toBe(false)
    expect(canViewAsset(row({ visibility: 'tenant', requiredScope: 'data:query' }), req('bob', ['data:query']), acl, undefined)).toBe(true)
    // 部门门：未解析 ⇒ 拒
    expect(canViewAsset(row({ visibility: 'tenant', requiredDepts: ['57'] }), req('bob', ['data:query']), acl, undefined)).toBe(false)
    expect(canViewAsset(row({ visibility: 'tenant', requiredDepts: ['57'] }), req('bob', ['data:query']), acl, new Set(['57']))).toBe(true)
  })

  it('★ viewer 不给编辑权（可看 ≠ 可改）', () => {
    const acl = [ownerRow('alice'), viewer('user', 'bob')]
    expect(canEditAsset(acl, req('bob'), 'data:manage')).toBe(false)
    expect(canEditAsset(acl, req('alice'), 'data:manage')).toBe(true)
    expect(canEditAsset(acl, req('admin', ['data:manage']), 'data:manage')).toBe(true)
  })

  it('isAdminOverride 区分"owner 自己改"与"管理员代管"', () => {
    const acl = [ownerRow('alice')]
    expect(isAdminOverride(acl, req('alice', ['data:manage']), 'data:manage')).toBe(false)
    expect(isAdminOverride(acl, req('admin', ['data:manage']), 'data:manage')).toBe(true)
    expect(isAdminOverride(acl, req('bob'), 'data:manage')).toBe(false)
  })

  it('isOwner / ownerOf 边界：历史资产无 owner 行', () => {
    expect(isOwner([], 'alice')).toBe(false)
  })
})

describePg('asset-auth 存储', () => {
  const ORG = 'org-asset-auth'
  const ASSET = 'asset-1'
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from data.asset_acl where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from data.asset_audit where org=$1', [ORG]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from data.asset_acl where org=$1', [ORG])
    await pool.query('delete from data.asset_audit where org=$1', [ORG])
  })

  it('ensureOwner 幂等：同名 upsert 不抢所有权', async () => {
    await ensureOwner(pool, ORG, ASSET, 'alice')
    await ensureOwner(pool, ORG, ASSET, 'bob')   // 第二个人来"创建同名"
    const acl = await loadAssetAcl(pool, ORG, ASSET)
    expect(acl).toEqual([{ subjectType: 'user', subjectId: 'alice', relation: 'owner' }])
  })

  it('replaceViewers 是**整体覆盖**：第二次 PUT 删掉第一次的', async () => {
    await ensureOwner(pool, ORG, ASSET, 'alice')
    await replaceViewers(pool, ORG, ASSET, [viewer('user', 'bob'), viewer('dept', '57')], 'alice')
    expect((await loadAssetAcl(pool, ORG, ASSET)).filter((a) => a.relation === 'viewer')).toHaveLength(2)
    await replaceViewers(pool, ORG, ASSET, [viewer('scope', 'data:query')], 'alice')
    const acl = await loadAssetAcl(pool, ORG, ASSET)
    expect(acl.filter((a) => a.relation === 'viewer')).toEqual([
      { subjectType: 'scope', subjectId: 'data:query', relation: 'viewer' },
    ])
    // owner 不受 viewer 覆盖影响
    expect(acl.some((a) => a.relation === 'owner')).toBe(true)
  })

  it('审计落库：by_admin 标记可查', async () => {
    await writeAssetAudit(pool, {
      org: ORG, assetId: ASSET, actor: 'admin', action: 'acl.update',
      detail: { viewers: 1 }, byAdmin: true,
    })
    const { rows } = await pool.query(
      'select actor, action, by_admin from data.asset_audit where org=$1', [ORG],
    )
    expect(rows[0]).toMatchObject({ actor: 'admin', action: 'acl.update', by_admin: true })
  })
})

// ── 渲染闸（P5 Task 3）：纯函数判据 ─────────────────────────────────────────────
const specOf = (panels: unknown[]) => {
  const parsed = parseReportSpec({ panels })
  if (!parsed.ok) throw new Error(`夹具规格应通过白名单：${parsed.code}`)
  return parsed.spec
}
const deptCtx = (canOwn: string[], memberOf: string[]): DeptContext => ({
  canOwn: new Set(canOwn), memberOf: new Set(memberOf),
})
const panel = (metricId: string, extra: Record<string, unknown> = {}) =>
  ({ chart: 'table', title: `标题-${metricId}`, metricId, ...extra })

describe('applyPanelRenderGate', () => {
  it('可见指标原样；不可见指标所在面板只剩 {index,denied:true}（无 title/metricId/chart/args）', () => {
    const spec = specOf([
      panel('m:owned', { args: { branch_num: '92' } }),
      panel('m:open'),
    ])
    const catalog: RenderGateMetric[] = [
      { id: 'm:owned', ownerDept: '57', reveal: 'panel' },
      { id: 'm:open', ownerDept: null },
    ]
    const out = applyPanelRenderGate(spec, catalog, deptCtx(['80'], ['80']))
    expect(out.blocked).toBe(false)
    expect(out.deniedPanels).toEqual([0])
    expect(out.denials).toEqual([{ index: 0, reason: 'metric_invisible' }])
    expect(out.spec.panels[0]).toEqual({ index: 0, denied: true })
    expect(JSON.stringify(out.spec.panels[0])).not.toMatch(/metricId|chart|title|args/)
    expect(out.spec.panels[1]).toEqual(spec.panels[1])
  })

  it('★ 词表里查不到的指标 fail-closed（reason=metric_unknown），不触发 reveal、不保留面板', () => {
    const spec = specOf([panel('m:gone'), panel('m:open')])
    const catalog: RenderGateMetric[] = [{ id: 'm:open', ownerDept: null }]
    const out = applyPanelRenderGate(spec, catalog, undefined)
    expect(out.blocked).toBe(false) // 没有行可读 reveal ⇒ 不冒充整表拒
    expect(out.deniedPanels).toEqual([0])
    expect(out.denials).toEqual([{ index: 0, reason: 'metric_unknown' }])
    expect(out.spec.panels[0]).toEqual({ index: 0, denied: true })
  })

  it('★ 不可见 + reveal=report ⇒ blocked（防「总数−其他」反推）', () => {
    const spec = specOf([panel('m:secret')])
    const out = applyPanelRenderGate(
      spec, [{ id: 'm:secret', ownerDept: '57', reveal: 'report' }], deptCtx(['80'], ['80']),
    )
    expect(out.blocked).toBe(true)
    expect(out.deniedPanels).toEqual([0])
  })

  it('★ kpi 分母不可见 ⇒ 整格降级（分母口径同样泄露）', () => {
    const spec = specOf([{
      chart: 'kpi', title: '客单价', metricId: 'm:sales', denominatorMetricId: 'm:orders', format: 'number',
    }])
    const out = applyPanelRenderGate(spec, [
      { id: 'm:sales', ownerDept: null },
      { id: 'm:orders', ownerDept: '57' },
    ], deptCtx(['80'], ['80']))
    expect(out.deniedPanels).toEqual([0])
    expect(out.denials).toEqual([{ index: 0, reason: 'metric_invisible' }])
  })

  it('factsSpecOf：降级占位符换成**空文本面板**（叙述事实包不再看到标题/metricId）', () => {
    const spec = specOf([panel('m:owned'), panel('m:open')])
    const gate = applyPanelRenderGate(
      spec, [{ id: 'm:owned', ownerDept: '57' }, { id: 'm:open', ownerDept: null }], deptCtx(['80'], ['80']),
    )
    const factsSpec = factsSpecOf(gate.spec)
    expect(factsSpec.panels[0]).toEqual({ chart: 'text', content: '', span: 12, format: 'plain' })
    expect(JSON.stringify(factsSpec.panels[0])).not.toMatch(/metricId|标题|table/)
    expect(factsSpec.panels[1]).toEqual(spec.panels[1])
  })
})
