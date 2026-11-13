// scripts/report-scope-scan.test.ts — 巡检脚本的**纯部分**单测（P5 Task 4）。
//
// 判据本身（`reportScopeViolations`）在 `modules/data/domain/report-scope-gate.test.ts` 有真库
// 单测；本文件钉的是巡检壳最容易漂移的两处：
//   ① **谁是「已发布」**：metabase 行看行上门、platform 行看发布指针——统一成 `required_scope
//      IS NULL` 会同时造成漏判（快照门非 null 的已发布行）与误判（没有线上内容的草稿行）；
//   ② 判据输入**取快照还是取行**：platform 行的行上是草稿/下次发布的门，线上是 `report_versions`
//      快照；取错就判错对象。
// 另加 formatReport 的干净/违规两态（job 判红只看退出码，退出码由这两态推出）。
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_NAME,
  classifyReport,
  formatReport,
  parseOrgArg,
  scopeInputOf,
} from './report-scope-scan.mjs'

/** 一行 `queryOrgReports` 的形状（默认：未发布平台行）。 */
const platformRow = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  title: '月报',
  renderer: 'platform',
  visibility: 'tenant',
  required_scope: 'data:manage',
  required_depts: null,
  published_version_id: null,
  published_spec: null,
  published_scope: null,
  published_depts: null,
  ...over,
})

const metabaseRow = (over: Record<string, unknown> = {}) => ({
  id: 'r-m',
  title: 'Metabase 报表',
  renderer: 'metabase',
  visibility: 'tenant',
  required_scope: null,
  required_depts: null,
  published_version_id: null,
  published_spec: null,
  published_scope: null,
  published_depts: null,
  ...over,
})

describe('classifyReport（谁是「已发布」，两种渲染器不同源）', () => {
  it('metabase：required_scope IS NULL = 已发布', () => {
    expect(classifyReport(metabaseRow())).toBe('published_metabase')
    expect(classifyReport(metabaseRow({ required_scope: 'data:query' }))).toBe('unpublished')
  })

  it('platform：发布指针才是真值，行上门不参与', () => {
    expect(classifyReport(platformRow({ published_version_id: 'v-1' }))).toBe('published_platform')
    // 指针为空 ⇒ 没有线上内容（发布链接 404），即使行上门是 null 也不是已发布
    expect(classifyReport(platformRow({ required_scope: null }))).toBe('unpublished')
    // 指针非空 + 快照门非 null ⇒ 仍是已发布（统一成 required_scope 判会漏掉这一行）
    expect(classifyReport(platformRow({
      published_version_id: 'v-1', published_scope: 'data:query',
    }))).toBe('published_platform')
  })

  it('未知渲染器点名（不静默归成任一已知档）', () => {
    expect(classifyReport(platformRow({ renderer: 'metabase_v2' }))).toBe('unknown_renderer')
  })
})

describe('scopeInputOf（判据输入取快照，不取行上草稿）', () => {
  it('平台已发布行：门与规格一律来自 report_versions 快照', () => {
    const input = scopeInputOf(platformRow({
      required_scope: 'data:manage', // 行上门（草稿/下次发布）
      required_depts: ['draft-dept'],
      published_version_id: 'v-2',
      published_spec: { panels: [{ chart: 'table', title: 't', metricId: 'm:1' }] },
      published_scope: null, // 快照门：拿到模块即可见
      published_depts: ['snap-dept'],
      visibility: 'restricted',
    }))
    expect(input).not.toBeNull()
    expect(input!.requiredScope).toBeNull()
    expect(input!.requiredDepts).toEqual(['snap-dept'])
    expect(input!.visibility).toBe('restricted')
    expect(input!.spec).toEqual({ panels: [{ chart: 'table', title: 't', metricId: 'm:1' }] })
  })

  it('非平台已发布行没有判定输入', () => {
    expect(scopeInputOf(metabaseRow())).toBeNull()
    expect(scopeInputOf(platformRow())).toBeNull()
  })
})

describe('parseOrgArg', () => {
  it('缺省 = 全部；空串非法；正常取值去空白', () => {
    expect(parseOrgArg(undefined)).toBeUndefined()
    expect(parseOrgArg('   ')).toBeNull()
    expect(parseOrgArg('  shanhaiyiguo-org ')).toBe('shanhaiyiguo-org')
  })
})

describe('formatReport（干净 / 违规两态）', () => {
  const cleanOrg = {
    org: 'org-a', tenantId: 3, reports: 4, published: 2, metabase: 1,
    violations: [], warnings: [], errors: [],
  }

  it('干净：exit 0 的形态（OK + 覆盖行 + 总账）', () => {
    const text = formatReport({ orgs: [cleanOrg] })
    expect(text).toContain(`${SCRIPT_NAME}: org=org-a tenant=3 reports=4 published=2`)
    expect(text).toContain(
      `${SCRIPT_NAME}: OK（orgs 1 / reports 4 / published 2 / metabase 1`
      + ' / violations 0 / warnings 0 / errors 0）',
    )
    expect(text).not.toContain('✗')
  })

  it('违规：exit 1 的形态（逐条点名 + FAIL + 差集部门）', () => {
    const text = formatReport({
      orgs: [{
        ...cleanOrg,
        violations: [{
          index: 2, metricId: 'lemeng:net_sales', reason: 'audience_dept_outside_metric_scope',
          missingDepts: ['sib-1', 'sib-2'], reportId: 'r-9', title: '门店月报',
        }],
      }],
    })
    expect(text).toContain(
      '✗ [audience_dept_outside_metric_scope] org=org-a report r-9「门店月报」'
      + ' panel 2 metric=lemeng:net_sales missingDepts=sib-1,sib-2',
    )
    expect(text).toContain('/ violations 1 /')
    expect(text).toContain(`${SCRIPT_NAME}: FAIL`)
  })

  it('判不了（errors）也判 FAIL —— 不把「无法判定」当干净', () => {
    const text = formatReport({
      orgs: [{
        ...cleanOrg,
        errors: [{ kind: 'tenant_not_registered', detail: 'platform.tenant 无此 org' }],
      }],
    })
    expect(text).toContain('✗ [tenant_not_registered] org=org-a：platform.tenant 无此 org')
    expect(text).toContain(`${SCRIPT_NAME}: FAIL`)
  })

  it('warnings 不判 FAIL（结构性提示不制造假红）', () => {
    const text = formatReport({
      orgs: [{ ...cleanOrg, warnings: ['report r-1「月报」 面板 0 的指标 m:1 不在词表中 ⇒ 可见范围无法判定，已跳过'] }],
    })
    expect(text).toContain('⚠ org=org-a report r-1')
    expect(text).toContain(`${SCRIPT_NAME}: OK`)
  })
})
