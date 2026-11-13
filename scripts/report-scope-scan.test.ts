// scripts/report-scope-scan.test.ts — 巡检脚本的**纯部分**单测（P5 Task 4）。
//
// 判据本身（`reportScopeViolations`）在 `modules/data/domain/report-scope-gate.test.ts` 有真库
// 单测；本文件钉的是巡检壳最容易漂移的两处：
//   ① **谁是「已发布」**：metabase 行看行上门、platform 行看发布指针——统一成 `required_scope
//      IS NULL` 会同时造成漏判（快照门非 null 的已发布行）与误判（没有线上内容的草稿行）；
//   ② 判据输入**取快照还是取行**：platform 行的行上是草稿/下次发布的门，线上是 `report_versions`
//      快照；取错就判错对象。
// 另加 formatReport 的干净/违规两态（job 判红只看退出码，退出码由这两态推出）。
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// 迁移引导与 modules/data 的测试同源（不另写一份 runMigrations）：
// 本文件必须**自足**——单独 `pnpm run test:guard`（库里没跑过 data 迁移）也要能建表。
// 只跑 data 迁移：scanOrg 只读 data.reports / data.report_versions，不碰平台原语。
import { applyMigrations } from '../modules/data/test-util.ts'
import {
  SCRIPT_NAME,
  classifyReport,
  formatReport,
  parseOrgArg,
  scanOrg,
  scopeInputOf,
  verdictOf,
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

  it('warnings 不判 FAIL，并标 [warn]（别让读日志的人以为已覆盖）', () => {
    const text = formatReport({
      orgs: [{ ...cleanOrg, warnings: ['report r-1「月报」 面板 0 的指标 m:1 不在词表中 ⇒ 可见范围无法判定，已跳过'] }],
    })
    expect(text).toContain('[warn] org=org-a report r-1')
    expect(text).toContain(`${SCRIPT_NAME}: OK`)
  })
})

describe('verdictOf（告警判据唯一实现）', () => {
  const org = {
    org: 'o', tenantId: 1, reports: 1, published: 1, metabase: 0,
    violations: [], warnings: [], errors: [],
  }
  it('干净与只有 warning ⇒ OK；violation 或 error ⇒ FAIL', () => {
    expect(verdictOf({ orgs: [org] })).toBe('OK')
    expect(verdictOf({ orgs: [{ ...org, warnings: ['x'] }] })).toBe('OK')
    expect(verdictOf({ orgs: [{ ...org, violations: [{ index: 0, metricId: 'm' }] }] })).toBe('FAIL')
    expect(verdictOf({ orgs: [{ ...org, errors: [{ kind: 'x' }] }] })).toBe('FAIL')
  })
})

// ── 真库：scanOrg 的取数与列别名（DATABASE_URL 缺失时跳过）─────────────────────────
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const TENANT_DB = 9898
const ORG_DB = 'org-p5scan-scan'
const SNAP_SPEC = { panels: [{ chart: 'table', title: '口径', metricId: 'm:1' }] }

describePg('scanOrg（真库夹具）', () => {
  // pg 只在 apps/server 的依赖里（与 scripts/*.mjs 同款解析）
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const pool = new Pool({ connectionString: dbUrl })

  const stubDeps = (over: Record<string, unknown> = {}) => ({
    pool,
    gate: async () => null,
    loadCatalog: async () => [],
    loadAcls: async () => new Map(),
    parseSpec: (v: unknown) => ({ ok: true, spec: v }),
    ...over,
  })

  beforeAll(async () => {
    // 自足：先应用本仓 data 迁移（幂等、有空库建表能力）。不依赖「别的测试套件恰好先跑过」。
    await applyMigrations(pool)
    // 幂等清场（专用 org，不碰别人）
    await pool.query('delete from data.report_versions where org = $1', [ORG_DB])
    await pool.query('delete from data.reports where org = $1', [ORG_DB])

    // r-alias：行与快照的门/标题/规格**刻意不同**，钉住「取快照」与 SQL 列别名
    // （published_title / published_scope / published_depts / published_spec 任一写错都会红）。
    await pool.query(
      `insert into data.reports(org,id,title,metabase_id,required_scope,renderer,version,spec,
                                published_version_id,required_depts,visibility)
       values ($1,'r-alias','草稿标题',0,'row-scope','platform',2,$2::jsonb,'v-alias',$3::jsonb,'tenant')`,
      [ORG_DB, JSON.stringify(SNAP_SPEC), JSON.stringify(['row-dept'])],
    )
    await pool.query(
      `insert into data.report_versions(id,org,report_id,version,title,spec,required_scope,
                                        required_depts,draft_version,published_by,note)
       values ('v-alias',$1,'r-alias',2,'线上标题',$2::jsonb,'snap-scope',$3::jsonb,2,'fixture','')`,
      [ORG_DB, JSON.stringify(SNAP_SPEC), JSON.stringify(['snap-dept'])],
    )

    // r-missing：发布指针非空但没有版本行（悬空指针）⇒ 必须报 published_snapshot_missing。
    await pool.query(
      `insert into data.reports(org,id,title,metabase_id,required_scope,renderer,version,spec,
                                published_version_id,required_depts,visibility)
       values ($1,'r-missing','快照丢失',0,'data:manage','platform',1,$2::jsonb,'v-missing',null,'tenant')`,
      [ORG_DB, JSON.stringify(SNAP_SPEC)],
    )
  })

  afterAll(async () => {
    await pool.query('delete from data.report_versions where org = $1', [ORG_DB]).catch(() => {})
    await pool.query('delete from data.reports where org = $1', [ORG_DB]).catch(() => {})
    await pool.end()
  })

  it('判据输入取快照（SQL 列别名 published_*）；违规行用快照标题', async () => {
    const calls: Array<{ report: Record<string, unknown> }> = []
    const out = await scanOrg(stubDeps({
      gate: async (d: { report: Record<string, unknown> }) => {
        calls.push(d)
        return {
          panels: [{ index: 0, metricId: 'm:1', reason: 'audience_unbounded' }],
          warnings: [],
        }
      },
    }), ORG_DB, TENANT_DB) as any

    // 悬空指针那张被点名，且没有被当成「判过」
    expect(out.errors.map((e: { kind: string }) => e.kind)).toContain('published_snapshot_missing')
    expect(out.errors.find((e: { kind: string; detail: string }) => e.kind === 'published_snapshot_missing')!.detail)
      .toContain('r-missing')
    expect(out.published).toBe(1)

    // 别名 / 快照取值的唯一真值源
    const input = calls[0]!.report as {
      requiredScope: unknown; requiredDepts: unknown; spec: unknown
    }
    expect(input.requiredScope).toBe('snap-scope') // 行上是 'row-scope'
    expect(input.requiredDepts).toEqual(['snap-dept']) // 行上是 ['row-dept']
    expect(input.spec).toEqual(SNAP_SPEC)
    // 违规行标题来自快照（'线上标题'），不是行上草稿标题（'草稿标题'）
    expect(out.violations[0]!.title).toBe('线上标题')
  })

  it('租户未登记 ⇒ tenant_not_registered（fail-closed，不静默跳过）', async () => {
    const out = await scanOrg(stubDeps(), ORG_DB, null) as any
    expect(out.errors.map((e: { kind: string }) => e.kind)).toContain('tenant_not_registered')
    expect(out.errors.find((e: { kind: string }) => e.kind === 'tenant_not_registered')!.detail)
      .toContain('部门链无法解析')
    expect(out.published).toBe(0)
  })
})

