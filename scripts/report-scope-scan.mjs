#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（同 check-org-tree.mjs / org-sync-all.mjs）：pg 经 createRequire 动态取，
// 仓内 TS 域模块经动态 import（tsx 下可解析）；判据本身全在 `modules/data/domain/report-scope-gate.ts`
// 的 `reportScopeViolations`（P5 Task 2，有真库单测），本壳只做取数、打印与退出码。
//
// report-scope-scan.mjs — 报表**受众漂移**的每日巡检（P5 Task 4，spec 2026-11-12 §9.1）。
//
// 它补的是发布门**管不到的那一类漂移**：发布门只在「发布那一刻」判受众 ⊆ 面板指标可见范围；
// 发布之后指标可以改归属 / 改 visible_depts / 被归档，报表一行没动也可能变得「受众比指标宽」。
// 巡检每天把**已发布**报表重新判一遍，有漂移就点名（exit 1 ⇒ openship job 失败通知）。
//
// ── 「已发布」的判据（本轮核对过，与 report-store 头顶注一致，但**两种渲染器不同源**）──────
//   · metabase 行：没有定义版本通路，`required_scope IS NULL` **就是**「已发布」（页门放行）；
//     DB 跨列 check 钉死 spec 为 null ⇒ 没有面板指标可判（spec §9.2：Metabase 做不到面板级），
//     只计数、不判（不是静默漏掉：总数会打在每张报表的行里）。
//   · platform 行：**published_version_id IS NOT NULL** 才是已发布（下线总闸在存储层，见
//     domain/report-version.ts）。行上的 `required_scope/required_depts/spec` 是**草稿/下次发布**的
//     门与内容——线上那份是 `report_versions` 的不可变快照（`canViewVersionedContent` 同口径）。
//     ⇒ 判据输入一律取**快照**，取行上草稿值会造出两类假判：草稿合法中间态被误杀、
//     线上门与草稿门不同步时漏判。
//   平台行的**草稿**不在本巡检范围（发布门负责；草稿允许未知指标等中间态）。
//
// ── 退出码（供 openship job 判红）──────────────────────────────────────────────
//   0 干净（warnings 不判红：如「面板指标不在词表」是存在性/漂移提示，非受众问题；
//     Metabase 已发布行的「无法判定」是结构性的，只计数）
//   1 有受众漂移（violations）**或**有判不了的项（errors：租户未登记 / 快照缺失 / 快照不可解析 /
//     单租户扫描异常）——两者都要人看，别把「判不了」当干净
//   2 查不成账（缺 DATABASE_URL / 读租户或报表清单失败）
//
// 用法：
//   pnpm exec tsx scripts/report-scope-scan.mjs                # 全部租户（platform.tenant ∪ data.reports 的 org）
//   pnpm exec tsx scripts/report-scope-scan.mjs --org <org>    # 只跑一个 org（casdoor org 文本，排障用）
// 环境：DATABASE_URL（平台库）。**不打印任何连接串/密钥**。
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const SCRIPT_NAME = 'report-scope-scan'

/** `--org`：缺省（undefined）= 全部；空串/纯空白非法（返回 null 让 main 报用法错）。 */
export function parseOrgArg(raw) {
  if (raw === undefined) return undefined
  const v = String(raw).trim()
  return v === '' ? null : v
}

/**
 * 发布判定（纯函数，单测钉住）：`'published_metabase' | 'published_platform' | 'unpublished'`。
 *
 * ⚠️ 两种渲染器的「已发布」判据不同源——见文件头。**不要**统一成 `required_scope IS NULL`：
 * 平台行的快照门可以非 null（如 'data:query'），那样会漏判；而指针为空的平台行即使行门为 null
 * 也没有线上内容（发布链接 404），不该按线上受众判。
 */
export function classifyReport(row) {
  if (row.renderer === 'metabase') {
    return row.required_scope === null ? 'published_metabase' : 'unpublished'
  }
  if (row.renderer !== 'platform') return 'unknown_renderer'
  return row.published_version_id == null ? 'unpublished' : 'published_platform'
}

/**
 * 平台已发布行的判定输入：**一律取快照**（`published_*` 列），不取行上草稿值。
 * 非平台已发布行返回 null。快照 spec 的解析与缺失检查在调用侧（要 parseReportSpec）。
 */
export function scopeInputOf(row) {
  if (classifyReport(row) !== 'published_platform') return null
  return {
    renderer: 'platform',
    spec: row.published_spec ?? null,
    requiredScope: row.published_scope ?? null,
    requiredDepts: row.published_depts ?? null,
    visibility: row.visibility ?? 'tenant',
  }
}

/** 一条违规的人读行（不打印数据、不含敏感值：报表标题与 metric id 本身是租户可见信息）。 */
function formatViolation(org, v) {
  const missing = v.missingDepts === undefined || v.missingDepts.length === 0
    ? ''
    : ` missingDepts=${v.missingDepts.join(',')}`
  return `  ✗ [${v.reason}] org=${org} report ${v.reportId}「${v.title}」`
    + ` panel ${v.index} metric=${v.metricId}${missing}`
}

/**
 * 人读输出（纯函数，单测钉住干净/违规两态）。逐条细节在前，每 org 一行覆盖，末尾总账。
 *
 * @param {{
 *   orgs: Array<{
 *     org: string, tenantId: number | null, reports: number, published: number,
 *     metabase: number, violations: Array<object>, warnings: string[], errors: Array<object>,
 *   }>,
 * }} scan
 */
export function formatReport(scan) {
  const lines = []
  for (const o of scan.orgs) {
    for (const v of o.violations) lines.push(formatViolation(o.org, v))
  }
  for (const o of scan.orgs) {
    for (const e of o.errors) lines.push(`  ✗ [${e.kind}] org=${o.org}${e.detail === undefined ? '' : `：${e.detail}`}`)
  }
  for (const o of scan.orgs) {
    for (const w of o.warnings) lines.push(`  ⚠ org=${o.org} ${w}`)
  }
  for (const o of scan.orgs) {
    const tenant = o.tenantId === null ? '未登记' : String(o.tenantId)
    lines.push(
      `${SCRIPT_NAME}: org=${o.org} tenant=${tenant} reports=${o.reports} published=${o.published}`
      + ` metabase=${o.metabase} violations=${o.violations.length}`
      + ` warnings=${o.warnings.length} errors=${o.errors.length}`,
    )
  }
  const totals = scan.orgs.reduce(
    (acc, o) => ({
      reports: acc.reports + o.reports,
      published: acc.published + o.published,
      metabase: acc.metabase + o.metabase,
      violations: acc.violations + o.violations.length,
      warnings: acc.warnings + o.warnings.length,
      errors: acc.errors + o.errors.length,
    }),
    { reports: 0, published: 0, metabase: 0, violations: 0, warnings: 0, errors: 0 },
  )
  const head = totals.violations > 0 || totals.errors > 0 ? 'FAIL' : 'OK'
  lines.push(
    `${SCRIPT_NAME}: ${head}（orgs ${scan.orgs.length} / reports ${totals.reports}`
    + ` / published ${totals.published} / metabase ${totals.metabase}`
    + ` / violations ${totals.violations} / warnings ${totals.warnings} / errors ${totals.errors}）`,
  )
  return lines.join('\n')
}

/**
 * 单 org 的全部登记（一次查询；已发布平台行的快照随 left join 带出）。
 * `visibility` 是**资产级**（行级，非版本快照）——与发布快照的门正交。
 */
async function queryOrgReports(pool, org) {
  const r = await pool.query(
    `select r.id, r.title, r.renderer, r.visibility, r.required_scope, r.required_depts,
            r.published_version_id,
            v.spec            as published_spec,
            v.required_scope  as published_scope,
            v.required_depts  as published_depts
       from data.reports r
       left join data.report_versions v
         on v.org = r.org and v.id = r.published_version_id
      where r.org = $1
      order by r.title, r.id`,
    [org],
  )
  return r.rows
}

/** 判一个 org。任何单 org 异常折成 error（不吞掉、不中断其他 org）。 */
async function scanOrg({ pool, gate, loadCatalog, loadAcls, parseSpec }, org, tenantId) {
  const out = {
    org, tenantId, reports: 0, published: 0, metabase: 0,
    violations: [], warnings: [], errors: [],
  }
  let rows
  try {
    rows = await queryOrgReports(pool, org)
  } catch (e) {
    out.errors.push({ kind: 'scan_failed', detail: e instanceof Error ? e.message : String(e) })
    return out
  }
  out.reports = rows.length

  const platformRows = rows.filter((row) => classifyReport(row) === 'published_platform')
  out.metabase = rows.filter((row) => classifyReport(row) === 'published_metabase').length
  // 渲染器取值域由库侧 check 钉死；出现第三种说明库/代码不同步 ⇒ 点名，不静默归类。
  const unknown = rows.filter((row) => classifyReport(row) === 'unknown_renderer')
  if (unknown.length > 0) {
    out.errors.push({
      kind: 'unknown_renderer',
      detail: `${unknown.length} 行渲染器不认识：${unknown.map((row) => `${row.id}=${row.renderer}`).join(',')}`,
    })
  }

  // 部门链按 tenant 数字 id 隔离；org 没登记进 platform.tenant ⇒ 链解析不出来。
  // fail-closed：有已发布平台报表就点名报错（不静默跳过——那正是巡检要防的假绿）。
  if (tenantId === null) {
    if (platformRows.length > 0) {
      out.errors.push({
        kind: 'tenant_not_registered',
        detail: `platform.tenant 无此 org ⇒ 部门链无法解析，已发布平台报表 ${platformRows.length} 张未判`,
      })
    }
    return out
  }

  let catalog
  try {
    // 词表一次加载全量（每张报表都复用；gate 的 deps.catalog 就是为此留的口子）
    catalog = platformRows.length === 0 ? [] : await loadCatalog(pool, org)
  } catch (e) {
    out.errors.push({ kind: 'catalog_unavailable', detail: e instanceof Error ? e.message : String(e) })
    return out
  }

  let acls
  try {
    acls = await loadAcls(pool, org, platformRows.map((row) => row.id))
  } catch (e) {
    out.errors.push({ kind: 'acl_unavailable', detail: e instanceof Error ? e.message : String(e) })
    return out
  }

  for (const row of platformRows) {
    const input = scopeInputOf(row)
    // 指针非空但 join 不到快照（悬空指针）：线上内容读不到，必须人看。
    if (row.published_spec == null) {
      out.errors.push({ kind: 'published_snapshot_missing', detail: `report ${row.id}「${row.title}」` })
      continue
    }
    const parsed = parseSpec(row.published_spec)
    if (!parsed.ok) {
      out.errors.push({
        kind: 'published_spec_unparseable',
        detail: `report ${row.id}「${row.title}」 code=${parsed.code}`,
      })
      continue
    }
    input.spec = parsed.spec
    out.published += 1
    let result
    try {
      result = await gate({
        pool, tenantId, org, report: input, acl: acls.get(row.id) ?? [], catalog,
      })
    } catch (e) {
      out.errors.push({
        kind: 'gate_failed',
        detail: `report ${row.id}「${row.title}」 ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }
    if (result === null) continue
    for (const v of result.panels) out.violations.push({ ...v, reportId: row.id, title: row.title })
    for (const w of result.warnings) out.warnings.push(`report ${row.id}「${row.title}」 ${w}`)
  }
  return out
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { org: { type: 'string' } },
    allowPositionals: false,
  })
  const orgFilter = parseOrgArg(values.org)
  if (orgFilter === null) {
    console.error(`${SCRIPT_NAME}: --org 只接受非空 org 文本，收到 ${JSON.stringify(values.org)}`)
    return 2
  }
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error(`${SCRIPT_NAME}: 缺 DATABASE_URL`)
    return 2
  }

  const { createRequire } = await import('node:module')
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const { reportScopeViolations } = await import('../modules/data/domain/report-scope-gate.ts')
  const { loadMergedCatalog } = await import('../modules/data/domain/metric-store.ts')
  const { loadAssetAcls } = await import('../modules/data/domain/asset-auth.ts')
  const { parseReportSpec } = await import('../modules/data/domain/report-spec.ts')

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    // 租户清单 = platform.tenant ∪ data.reports 里出现过的 org：只扫前者是**盲区**（未登记 org 的
    // 报表永不判），只扫后者拿不到部门链的 tenant id。两者并集，未登记的由 scanOrg 点名报错。
    const tenantRows = orgFilter === undefined
      ? (await pool.query(
        "select id, casdoor_org from platform.tenant where casdoor_org is not null and casdoor_org <> '' order by id",
      )).rows
      : (await pool.query(
        "select id, casdoor_org from platform.tenant where casdoor_org = $1 order by id",
        [orgFilter],
      )).rows
    const tenantOf = new Map(tenantRows.map((t) => [t.casdoor_org, t.id]))

    let orgs
    if (orgFilter !== undefined) {
      orgs = [orgFilter]
    } else {
      const reportOrgs = (await pool.query(
        "select distinct org from data.reports where org is not null and org <> '' order by org",
      )).rows.map((r) => r.org)
      orgs = [...new Set([...tenantOf.keys(), ...reportOrgs])]
    }

    const deps = {
      pool,
      gate: reportScopeViolations,
      loadCatalog: loadMergedCatalog,
      loadAcls: loadAssetAcls,
      parseSpec: parseReportSpec,
    }
    const scan = { orgs: [] }
    for (const org of orgs) {
      scan.orgs.push(await scanOrg(deps, org, tenantOf.has(org) ? tenantOf.get(org) : null))
    }
    console.log(formatReport(scan))
    const failed = scan.orgs.some((o) => o.violations.length > 0 || o.errors.length > 0)
    return failed ? 1 : 0
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`${SCRIPT_NAME} 查不成账:`, e instanceof Error ? e.message : e)
      process.exitCode = 2
    })
}
