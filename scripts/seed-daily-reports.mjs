#!/usr/bin/env node
// seed-daily-reports.mjs —— R1 验收用的「真实日报」内容播种（#2620）。
//
// 背景：R1 的出口判据要**3 份真实日报**（平台自绘 + 有 KPI 卡 + 已发布），而生产库只有 1 份
// （`门店经营日报`）。其余两份不是工程能力问题，是**内容没人建**。
//
// 本脚本只做两件事，且都走平台自己的写路径（不直插 SQL）：
//   ① `upsertReport(..., 'create-only')` —— 撞名不覆盖（agent 工具面同款纪律：绝不改写既有报表）；
//   ② `publishVersion(...)` —— **发布前过白名单/目录/语义 lint**（`publishVersion` 内部自己会跑）。
//
// 选型（2026-11-21，用户授权「随便选」）：两份都只用 **totalable 指标**，这样 R1 验收的第 ④ 步
// 「按日组成加总 = 页面值」是**可校验**的（非可加指标在验收脚本里只能记「不适用」）。
//
// 用法（容器内，WORKDIR=/app，有 DATABASE_URL）：
//   pnpm exec tsx scripts/seed-daily-reports.mjs --dry-run   # 默认：只打印将写入什么
//   pnpm exec tsx scripts/seed-daily-reports.mjs --apply     # 真写
//
// 退出码：0 = 成功（含「已存在跳过」）；1 = 有定义发布失败；2 = 缺依赖/参数。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { getReport, upsertReport } from '../modules/data/domain/report-store.ts'
import { publishVersion } from '../modules/data/domain/report-version.ts'
import { loadAdoptedSources } from './tenant-sources.ts'

/** 发布身份：与历史报表编辑一致的服务身份（不是某个真人的会话）。 */
export const PUBLISHER = 'ops-report-edit'
export const ORG = 'shanhaiyiguo-org'

/** KPI 面板的公共形状（与 `report-spec.ts` 的 KpiPanel `.strict()` 对齐，多一个键就 400）。 */
/**
 * @param {string} title
 * @param {string} metricId
 * @param {{format?: 'currency'|'number'|'percent', goodDirection?: 'up'|'down'|'none', denominatorMetricId?: string}} [opts]
 */
const kpi = (title, metricId, opts = {}) => ({
  chart: 'kpi',
  title,
  metricId,
  args: { system_book: '3120' },
  format: opts.format ?? 'currency',
  compare: 'auto',
  goodDirection: opts.goodDirection ?? 'up',
  span: 8,
  timeScoped: true,
  ...(opts.denominatorMetricId ? { denominatorMetricId: opts.denominatorMetricId } : {}),
})

/**
 * 两份日报的定义。**只用 totalable 指标**（按日加总可校验，R1 第 ④ 步才有意义）。
 * @type {Array<{title: string, note: string, spec: {panels: any[]}}>}
 */
export const DEFINITIONS = [
  {
    title: '门店会员日报',
    note: 'R1 验收用日报（#2620）：会员销售额/交易笔数/会员销售占比，均为可加指标',
    spec: {
      panels: [
        kpi('会员销售额', 'lemeng:member:branch_vip_money'),
        kpi('会员交易笔数', 'lemeng:member:branch_vip_nums', { format: 'number' }),
        kpi('会员销售占比', 'lemeng:member:branch_vip_money', {
          format: 'percent',
          denominatorMetricId: 'lemeng:retail:net_sales',
        }),
      ],
    },
  },
  {
    title: '门店报损日报',
    note: 'R1 验收用日报（#2620）：报损金额/出库毛利/采购金额，均为可加指标',
    spec: {
      panels: [
        kpi('报损金额', 'lemeng:loss:branch_amount', { goodDirection: 'down' }),
        kpi('出库毛利', 'lemeng:outbound:gross_profit'),
        kpi('采购金额', 'lemeng:purchase:amount'),
      ],
    },
  },
]

/**
 * 播种一份：create-only + publish。
 * @param {any} pool
 * @param {{title: string, note: string, spec: any}} def
 * @param {{apply: boolean, sources: ReadonlySet<string>|null}} opts
 */
export async function seedOne(pool, def, opts) {
  const id = await upsertReport(pool, ORG, {
    title: def.title,
    metabaseId: 0,
    embedParams: {},
    requiredScope: null,
    renderer: 'platform',
    spec: def.spec,
  }, 'create-only')
  if (id === null) {
    // 撞名 = 已存在。**不改写**（agent 工具面纪律）；只报告是否有已发布版本，便于人工判断。
    const existing = await findReportByTitle(pool, def.title)
    return {
      title: def.title,
      status: 'skipped-exists',
      published: existing?.published_version_id != null,
    }
  }
  if (!opts.apply) return { title: def.title, status: 'dry-run-create', id }
  const row = await getReport(pool, ORG, id)
  if (row === null) return { title: def.title, status: 'publish-failed:NOT_FOUND', id }
  const out = await publishVersion(
    pool, ORG, id, row.version, PUBLISHER, def.note, opts.sources ?? new Set(),
  )
  return {
    title: def.title,
    status: out.ok ? 'published' : `publish-failed:${out.reason}`,
    id,
    detail: out.ok ? undefined : ('detail' in out ? out.detail : undefined),
  }
}

/** 只读：按标题找既有登记行（撞名时用）。
 * @param {any} pool
 * @param {string} title
 * @returns {Promise<{id: string, published_version_id: string|null}|null>}
 */
async function findReportByTitle(pool, title) {
  const { rows } = await pool.query(
    'select id, published_version_id from data.reports where org = $1 and title = $2 limit 1',
    [ORG, title],
  )
  return rows[0] ?? null
}

async function main() {
  const apply = process.argv.includes('--apply')
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('seed-daily-reports: 缺 DATABASE_URL')
    return 2
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  let rc = 0
  try {
    const sources = apply ? await loadAdoptedSources(pool, ORG) : null
    for (const def of DEFINITIONS) {
      const r = await seedOne(pool, def, { apply, sources })
      console.log(JSON.stringify(r))
      if (String(r.status).startsWith('publish-failed')) rc = 1
    }
  } catch (e) {
    console.error(`seed-daily-reports: ${e instanceof Error ? e.message : String(e)}`)
    rc = 2
  } finally {
    await pool.end().catch(() => {})
  }
  console.log(`SEED_DAILY_REPORTS_DONE mode=${apply ? 'apply' : 'dry-run'} rc=${rc}`)
  return rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
