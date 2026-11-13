// report-scope-gate.test.ts — 报表发布门（P5 Task 2，spec 2026-11-12 §9.1）。
//
// 判定是纯规则的（不做 requester 上下文的逆运算）：有界受众的 dept 集 = 报表 requiredDepts ∪
// ACL 里 relation=viewer 的 dept 主体。若存在**无界入口**（visibility=tenant 且无部门门，
// 或 ACL 里有 user/scope viewer）⇒ 受众无法用部门集合界定，每块部门归属面板都违规
// （reason audience_unbounded）。owner 主体不计入受众（owner 豁免，见 domain 文件头）。
// 指标归属部门非空时，受众**每个** dept 必须 ∈（归属部门链 ∪ visible_depts）。
//
// 真库夹具：指标走 `upsertMetric`（L2，本 org 独占），部门链走 `platform.v_org_node`
// 只读视图（reports.test.ts / metric-visibility.test.ts 同款做法）。合成租户 + `p5g-` 前缀隔离。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, applyPlatformMigrations } from '../test-util'
import type { AclRow } from './asset-auth'
import { deptChainOf, subtreeOf } from './metric-visibility'
import { upsertMetric } from './metric-store'
import { parseReportSpec } from './report-spec'
import type { ReportSpec } from './report-spec'
import { reportScopeViolations } from './report-scope-gate'
import type { ReportScopeRow } from './report-scope-gate'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const TENANT = 9217 // 合成租户（metric-visibility.test.ts 用 9207，错开）
const ORG = 'org-p5-gate'
const ROOT = 'p5g-root'
const FIN = 'p5g-fin' // 归属部门（财务）
const GRAND = 'p5g-fin-grand' // FIN 的后代
const SIB = 'p5g-sib' // 兄弟部门（销售）
const DEAD = 'p5g-fin-dead' // 软删后代：不得进链

const FIN_METRIC = 'p5g:finance'
const SHARED_METRIC = 'p5g:shared'
const PLATFORM_METRIC = 'p5g:platform'
const DENOM_METRIC = 'p5g:denom'

const metricDef = (id: string, title: string) => ({
  id, title, description: `${title}（发布门夹具）`, requiredScope: null,
  subjectColumn: 'org', selectSql: 'select 1 as value', groupBy: '', params: {},
})

const specOf = (...panels: unknown[]): ReportSpec => {
  const parsed = parseReportSpec({ panels })
  if (!parsed.ok) throw new Error(`夹具规格应通过白名单：${parsed.code}`)
  return parsed.spec
}
const tablePanel = (metricId: string) => ({ chart: 'table', title: metricId, metricId })
const kpiPanel = (metricId: string, denominatorMetricId: string) => ({
  chart: 'kpi', title: 'kpi', metricId, denominatorMetricId, format: 'number',
})

const baseReport = (): ReportScopeRow => ({
  renderer: 'platform', spec: null, requiredScope: null, requiredDepts: null, visibility: 'tenant',
})
const viewerDept = (deptId: string): AclRow => ({ subjectType: 'dept', subjectId: deptId, relation: 'viewer' })
const viewerUser = (userId: string): AclRow => ({ subjectType: 'user', subjectId: userId, relation: 'viewer' })

describePg('reportScopeViolations（发布门，真库夹具）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  const gate = (deps: {
    report?: Partial<ReportScopeRow>
    acl?: readonly AclRow[]
  }) => reportScopeViolations({
    pool, tenantId: TENANT, org: ORG,
    report: { ...baseReport(), ...deps.report },
    acl: deps.acl ?? [],
  })

  const insDept = async (extId: string, parent: string | null, path: string, status = 1) => {
    await pool.query(
      `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, ext_id) do update
         set parent_ext_id = excluded.parent_ext_id, path = excluded.path, status = excluded.status`,
      [TENANT, extId, extId, parent, path, status],
    )
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await applyPlatformMigrations(pool)
    await pool.query(
      `insert into platform.tenant(id, slug, casdoor_org) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [TENANT, 'org-p5-gate-fixture', ORG],
    )
    // 幂等清场（专用租户 + p5g- 前缀，不碰别人）
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT])
    await pool.query('delete from data.metrics where org = $1', [ORG])
    await insDept(ROOT, null, ROOT)
    await insDept(FIN, ROOT, `${ROOT}.${FIN}`)
    await insDept(GRAND, FIN, `${ROOT}.${FIN}.${GRAND}`)
    await insDept(SIB, ROOT, `${ROOT}.${SIB}`)
    await insDept(DEAD, FIN, `${ROOT}.${FIN}.${DEAD}`, 0)

    await upsertMetric(pool, ORG, metricDef(FIN_METRIC, '财务口径'), 'fixture', { ownership: { ownerDept: FIN } })
    await upsertMetric(pool, ORG, metricDef(SHARED_METRIC, '财务共享口径'), 'fixture', { ownership: { ownerDept: FIN } })
    await upsertMetric(pool, ORG, metricDef(PLATFORM_METRIC, '平台口径'), 'fixture')
    await upsertMetric(pool, ORG, metricDef(DENOM_METRIC, '财务分母'), 'fixture', { ownership: { ownerDept: FIN } })
    // visible_depts 暂无写 API（P2 只接读）⇒ 夹具直落列（与生产读形状一致）
    await pool.query(
      'update data.metrics set visible_depts = $3::text[] where org = $1 and id = $2',
      [ORG, SHARED_METRIC, [SIB]],
    )
  })

  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.tenant where id = $1', [TENANT]).catch(() => {})
    await pool.end()
  })

  it('deptChainOf：自身 ∪ 祖先 ∪ 后代（含软删排除），不含兄弟', async () => {
    const chain = await deptChainOf(pool, TENANT, FIN)
    expect([...chain].sort()).toEqual([ROOT, FIN, GRAND].sort())
    expect(chain.has(SIB)).toBe(false)
    expect(chain.has(DEAD)).toBe(false)
  })

  it('subtreeOf：自身 ∪ 严格后代（不含祖先/兄弟/软删）', async () => {
    const sub = await subtreeOf(pool, TENANT, FIN)
    expect([...sub].sort()).toEqual([FIN, GRAND].sort())
    expect(sub.has(ROOT)).toBe(false) // 祖先不进
    expect(sub.has(SIB)).toBe(false)
    expect(sub.has(DEAD)).toBe(false)
  })

  it('★ 受众含兄弟部门 + 面板指标归属财务 ⇒ 违规并点名差集部门', async () => {
    const out = await gate({ report: { requiredDepts: [SIB], spec: specOf(tablePanel(FIN_METRIC)) } })
    expect(out).not.toBeNull()
    expect(out?.warnings).toEqual([])
    expect(out?.panels).toEqual([{
      index: 0, metricId: FIN_METRIC, missingDepts: [SIB], reason: 'audience_dept_outside_metric_scope',
    }])
  })

  it('受众 = 归属部门自身 / 后代 ⇒ 通过（部门链覆盖后代）', async () => {
    expect(await gate({ report: { requiredDepts: [FIN], spec: specOf(tablePanel(FIN_METRIC)) } })).toBeNull()
    expect(await gate({ report: { requiredDepts: [GRAND], spec: specOf(tablePanel(FIN_METRIC)) } })).toBeNull()
  })

  it('★ 受众挂祖先部门 ⇒ 展开子树后**兄弟支**被点名（不因父部门在链上就放行）', async () => {
    // requiredDepts=[ROOT] 的实际受众 = ROOT 整棵子树 {ROOT, FIN, GRAND, SIB}；
    // 指标归属 FIN ⇒ SIB 支的人渲染时面板不可见 ⇒ 必须拒。
    const out = await gate({ report: { requiredDepts: [ROOT], spec: specOf(tablePanel(FIN_METRIC)) } })
    expect(out?.panels).toEqual([{
      index: 0, metricId: FIN_METRIC, missingDepts: [SIB], reason: 'audience_dept_outside_metric_scope',
    }])
    // 挂归属部门自身仍通过（子树 ⊆ 归属链）
    expect(await gate({ report: { requiredDepts: [FIN], spec: specOf(tablePanel(FIN_METRIC)) } })).toBeNull()
  })

  it('★ ACL dept 主体同样展开子树：授给祖先部门 ⇒ 兄弟支被点名', async () => {
    // 有界受众需要 restricted：tenant 行即使加了 dept ACL 也仍是全租户（ACL 只加不减）。
    const out = await gate({
      report: { visibility: 'restricted', requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
      acl: [viewerDept(ROOT)],
    })
    expect(out?.panels[0]).toMatchObject({
      metricId: FIN_METRIC, missingDepts: [SIB], reason: 'audience_dept_outside_metric_scope',
    })
  })

  it('平台指标（owner_dept 空）⇒ 恒通过，与受众部门无关', async () => {
    expect(await gate({ report: { requiredDepts: [SIB], spec: specOf(tablePanel(PLATFORM_METRIC)) } })).toBeNull()
    expect(await gate({ report: { requiredDepts: null, spec: specOf(tablePanel(PLATFORM_METRIC)) } })).toBeNull()
  })

  it('★ 受众无任何部门（tenant + scope）+ 归属指标 ⇒ 违规 reason=audience_unbounded', async () => {
    const out = await gate({
      report: { requiredScope: 'data:query', requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
    })
    expect(out?.panels).toEqual([{ index: 0, metricId: FIN_METRIC, reason: 'audience_unbounded' }])
  })

  it('ACL user 主体 = 具名个人（人可能在任意部门）⇒ audience_unbounded', async () => {
    const out = await gate({
      report: { requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
      acl: [viewerUser('p5g-user')],
    })
    expect(out?.panels[0]).toMatchObject({ metricId: FIN_METRIC, reason: 'audience_unbounded' })
  })

  it('ACL dept 主体进受众：兄弟部门 ⇒ 违规（union 口径）', async () => {
    const out = await gate({
      report: { visibility: 'restricted', requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
      acl: [viewerDept(SIB)],
    })
    expect(out?.panels[0]).toMatchObject({
      metricId: FIN_METRIC, missingDepts: [SIB], reason: 'audience_dept_outside_metric_scope',
    })
  })

  // ── 受众「无法界定」的三条钉子（终审 Important：不能拿 dept 集合当代理）──────────────────
  it('★ 混合 dept + user viewer（restricted）⇒ 部门归属面板一律违规（dept 部分在链上也不放行）', async () => {
    const out = await gate({
      report: { visibility: 'restricted', requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
      // FIN 本身在指标归属链上——若只看 dept 集合这条会「通过」；user viewer 让受众无界。
      acl: [viewerDept(FIN), viewerUser('p5g-user')],
    })
    expect(out?.panels).toEqual([{ index: 0, metricId: FIN_METRIC, reason: 'audience_unbounded' }])
  })

  it('★ 历史 tenant 行（无部门门）+ 部门 ACL ⇒ 仍按全租户判（ACL 加性，不收窄 tenant）', async () => {
    const out = await gate({
      report: {
        visibility: 'tenant', requiredDepts: null, requiredScope: null,
        spec: specOf(tablePanel(FIN_METRIC)),
      },
      acl: [viewerDept(FIN)],
    })
    expect(out?.panels).toEqual([{ index: 0, metricId: FIN_METRIC, reason: 'audience_unbounded' }])
  })

  it('★ owner 豁免：ACL owner 主体不计入受众，不触发 audience_unbounded', async () => {
    const out = await gate({
      report: { visibility: 'restricted', requiredDepts: [FIN], spec: specOf(tablePanel(FIN_METRIC)) },
      acl: [{ subjectType: 'user', subjectId: 'p5g-owner', relation: 'owner' }],
    })
    expect(out).toBeNull()
    // restricted 且无任何 viewer ⇒ 实际受众 = owner 一人（豁免）⇒ 同样不判违规
    expect(await gate({
      report: { visibility: 'restricted', requiredDepts: null, spec: specOf(tablePanel(FIN_METRIC)) },
    })).toBeNull()
  })

  it('visible_depts 显式共享兄弟部门 ⇒ 通过', async () => {
    expect(await gate({ report: { requiredDepts: [SIB], spec: specOf(tablePanel(SHARED_METRIC)) } })).toBeNull()
  })

  it('kpi 分母也是面板指标：归属财务的分母同样被点名', async () => {
    const out = await gate({
      report: { requiredDepts: [SIB], spec: specOf(kpiPanel(PLATFORM_METRIC, DENOM_METRIC)) },
    })
    expect(out?.panels).toEqual([{
      index: 0, metricId: DENOM_METRIC, missingDepts: [SIB], reason: 'audience_dept_outside_metric_scope',
    }])
  })

  it('kpi 主指标 = 分母（同 id）⇒ 去重，同一面板只报一条', async () => {
    const out = await gate({
      report: { requiredDepts: [SIB], spec: specOf(kpiPanel(FIN_METRIC, FIN_METRIC)) },
    })
    expect(out?.panels).toHaveLength(1)
    expect(out?.panels[0]).toMatchObject({ index: 0, metricId: FIN_METRIC })
  })

  it('★ Metabase 行无面板（metricIds 空）⇒ 跳过（不阻断）+ warning', async () => {
    const out = await gate({ report: { renderer: 'metabase', spec: null, requiredScope: 'data:query' } })
    expect(out).not.toBeNull()
    expect(out?.panels).toEqual([])
    expect(out?.warnings).toHaveLength(1)
    expect(out?.warnings[0]).toContain('metabase')
  })

  it('文本面板（无 metricId）⇒ 视为无面板，不误判', async () => {
    const spec = specOf({ chart: 'text', content: '说明' })
    expect(await gate({ report: { requiredDepts: null, spec } })).toBeNull()
  })
})
