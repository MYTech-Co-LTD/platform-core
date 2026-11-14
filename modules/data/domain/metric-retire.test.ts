// metric-retire.test.ts — 下线提案域层（尾波 2026-11-14）：安全过滤四条 + 自动提单。
// 只钉域层判定与提单行为（job 脚本 / console 展示是后续面）。隔离键 org-retire-*；
// 真库用例自建夹具（同 metric-usage.test.ts 约定），空库可绿。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertL1Metric, upsertMetric } from './metric-store'
import { adoptChange, submitChange } from './metric-change'
import type { MetricWriteDeps } from './metric-write'
import type { MetricDef, Requester } from './authz'
import { retireEligibleOf, retireOrgs, submitRetireProposals } from './metric-retire'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键：org-retire-* 前缀（本波约定）；OTHER 用来钉「报表引用过滤的租户隔离」。 */
const ORG = 'org-retire-w1'
const OTHER = 'org-retire-w1-other'
/** 窗口口径（天）：夹具行龄 31 天 > 30，太新行 updated_at = now。 */
const DAYS = 30

// ── 夹具 id（retire:w1: 前缀，文件专属）─────────────────────────────────────
// E 是四条过滤的**公共正例**：L2 + 窗口 0 次 + 够龄 + 无引用 + 无未决单 ⇒ 唯一合格候选。
const E = 'retire:w1:eligible'
const R_USED = 'retire:w1:used'          // 反例①：窗口内有使用
const R_NEW = 'retire:w1:too_new'        // 反例②：行太新（updated_at = now）
const R_DRAFT = 'retire:w1:ref_draft'    // 反例③a：被草稿 spec（data.reports）引用
const R_PUB = 'retire:w1:ref_pub'        // 反例③b：只被已发布快照（report_versions）引用
const R_DENOM = 'retire:w1:ref_denom'    // 反例③c：只被 kpi 分母（denominatorMetricId）引用
const R_PEND = 'retire:w1:pending'       // 反例④：已有未决单

const L1_ID = 'retire:w1:l1_fixture'
const L1_FIXTURE = {
  id: L1_ID,
  title: '下线候选·L1 夹具',
  description: 'metric-retire 测试夹具',
  requiredScope: null,
  subjectColumn: 'org',
  selectSql: 'select sum(t.amt) as value, org, bizday from marts.f',
  groupBy: 'org, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}

function def(id: string, title: string): MetricDef {
  return {
    id, title, description: '', requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.mart_retire_fixture', groupBy: '', params: {},
  }
}

/** 采纳用例身份（同 metric-change.test.ts 形状）：pat 通道带 data:manage。 */
const REQ: Requester = {
  userId: 'retire-reviewer', orgId: ORG, channel: 'pat', keyId: 3, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
}
const writeDeps = (p: Pool): MetricWriteDeps => ({ pool: p, adoptedSources: new Set(['lemeng']), requester: REQ })

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（重跑幂等）：org 专属行 + 平台桶 L1 夹具行（精确 id）。
  await pool.query('delete from data.metric_change where org = any($1)', [[ORG, OTHER]])
  await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER]])
  await pool.query('delete from data.query_audit where org = $1', [ORG])
  await pool.query('delete from data.metrics where org = $1', [ORG])
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID])

  // ── L2 夹具：七个 id 一把落（creator 必在——下线候选要能找到人）──────────
  for (const [id, title] of [
    [E, '合格候选'], [R_USED, '窗口内用过'], [R_NEW, '太新的行'],
    [R_DRAFT, '草稿引用'], [R_PUB, '已发布引用'], [R_DENOM, '分母引用'], [R_PEND, '已有未决单'],
  ] as const) {
    await upsertMetric(pool, ORG, def(id, title), 'u-retire-creator')
  }
  // 行龄：除「太新」外全部回拨到 31 天前（> 30 天窗口）。
  await pool.query('update data.metrics set updated_at = now() - interval \'31 days\' where org = $1 and id <> $2', [ORG, R_NEW])

  // 反例①夹具：窗口内一次使用（非回归身份 ⇒ 算使用）。
  await pool.query(
    `insert into data.query_audit (org, user_id, channel, metric_id, verdict, created_at)
     values ($1, 'u-alice', 'session', $2, 'ok', now() - interval '1 day')`, [ORG, R_USED])

  // 反例③夹具：报表引用三种形态 + metabase 无 spec 行（walk 必须忍）。
  // ⚠️ CHECK data_reports_spec_by_renderer：platform ⇒ spec 非空；metabase ⇒ spec 空。
  // 「已发布」行故意让**草稿**指向别的指标（moved_on）、只有快照引用 R_PUB——
  // 钉「草稿改走了、旧快照仍占着引用」这条真形态。
  await pool.query(
    `insert into data.reports (org, id, title, metabase_id, renderer, spec) values
       ($1, 'retire-w1-draft',    '下线引用·草稿',   910001, 'platform', $2::jsonb),
       ($1, 'retire-w1-pub',      '下线引用·已发布', 910002, 'platform', $3::jsonb),
       ($1, 'retire-w1-kpi',      '下线引用·分母',   910003, 'platform', $4::jsonb),
       ($1, 'retire-w1-metabase', '下线引用·无spec', 910004, 'metabase', null),
       ($5, 'retire-w1-other',    '跨租户引用',      910005, 'platform', $2::jsonb)`,
    [ORG,
      JSON.stringify({ panels: [{ chart: 'table', metricId: R_DRAFT }] }),
      JSON.stringify({ panels: [{ chart: 'table', metricId: 'retire:w1:moved_on' }] }),
      JSON.stringify({ panels: [{ chart: 'kpi', metricId: 'retire:w1:kpi_main', denominatorMetricId: R_DENOM }] }),
      OTHER,
    ],
  )
  // 已发布快照：引用 R_PUB（草稿已改走 ⇒ 只有快照占着引用——过滤必须查 report_versions）。
  await pool.query(
    `insert into data.report_versions (id, org, report_id, version, title, spec, draft_version, published_by)
     values ('retire-w1-ver-1', $1, 'retire-w1-pub', 1, '下线引用·已发布', $2::jsonb, 1, 'test')`,
    [ORG, JSON.stringify({ panels: [{ chart: 'table', metricId: R_PUB }] })],
  )

  // 反例④夹具：给 R_PEND 手工立一张未决单（delete 档空对象；行在 ⇒ 预检过）。
  const pend = await submitChange(pool, ORG, { userId: 'u-human', channel: 'session' }, R_PEND, 'delete', {})
  expect(pend.ok).toBe(true)

  // L1 夹具：平台桶（L1 永不进候选的断言对象）。
  await upsertL1Metric(pool, L1_FIXTURE)
})

afterAll(async () => {
  await pool.query('delete from data.metric_change where org = any($1)', [[ORG, OTHER]]).catch(() => {})
  await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER]]).catch(() => {})
  await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
  await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID]).catch(() => {})
  await pool.end().catch(() => {})
})

describePg('retireEligibleOf（需要 DATABASE_URL）', () => {
  it('四条安全过滤一正一反：合格清单 = [E]，四个反例全部挡下', async () => {
    const eligible = await retireEligibleOf(pool, ORG, DAYS)
    const ids = eligible.map((c) => c.metricId)
    // 正例：E 过全部四条（L2+0 次、够龄、无引用、无未决）
    expect(ids).toEqual([E])
    // 反例①：窗口内有使用
    expect(ids).not.toContain(R_USED)
    // 反例②：行太新（updated_at 不早于 now−days）
    expect(ids).not.toContain(R_NEW)
    // 反例③：报表引用（草稿 / 已发布快照 / kpi 分母，三形态各自独立挡下）
    expect(ids).not.toContain(R_DRAFT)
    expect(ids).not.toContain(R_PUB)
    expect(ids).not.toContain(R_DENOM)
    // 反例④：已有未决单
    expect(ids).not.toContain(R_PEND)
    // 合格候选带全展示字段：referenced 恒 false（被引用的在过滤期已剔除）
    const e = eligible[0]!
    expect(e).toMatchObject({ metricId: E, title: '合格候选', source: 'l2', referenced: false })
    expect(e.createdBy).toBe('u-retire-creator')
    expect(e.lastUsedAt).toBeNull()
  })

  it('安全过滤③租户隔离：别的 org 的报表引用不阻断本租户候选', async () => {
    // OTHER 的报表面板引用了 E —— org 作用域的引用查询必须看不见它。
    const eligible = await retireEligibleOf(pool, ORG, DAYS)
    expect(eligible.map((c) => c.metricId)).toContain(E)
  })

  it('L1 永不进候选（平台口径行，下线走代码评审不走提单）', async () => {
    const eligible = await retireEligibleOf(pool, ORG, DAYS)
    expect(eligible.map((c) => c.metricId)).not.toContain(L1_ID)
    for (const c of eligible) expect(c.source).toBe('l2')
  })
})

describePg('retireOrgs（需要 DATABASE_URL）', () => {
  it('有 L2 行的 org 全列；无 L2 行的 org 不列', async () => {
    const orgs = await retireOrgs(pool)
    expect(orgs).toContain(ORG)
    expect(orgs).not.toContain(OTHER) // OTHER 只有报表夹具，没有 metrics 行
  })
})

describePg('submitRetireProposals（需要 DATABASE_URL）', () => {
  it('对合格候选提 delete 单：reason 落 payload，单留 draft（试算由提交面跑，域层不跑）', async () => {
    const out = await submitRetireProposals(pool, ORG, DAYS, { userId: 'metric-retire-job', channel: 'job' })
    expect(out.proposed).toBe(1)
    expect(out.tickets).toEqual([{ metricId: E, changeId: expect.any(Number) }])
    const changeId = out.tickets[0]!.changeId
    const row = await pool.query('select kind, payload, status from data.metric_change where org = $1 and id = $2', [ORG, changeId])
    expect(row.rows[0]).toMatchObject({ kind: 'delete', status: 'draft' })
    expect(row.rows[0]!.payload).toEqual({ reason: `连续 ${DAYS} 天 0 次使用（报表引用已排除）` })
  })

  it('重复跑 ⇒ proposed=0（未决单过滤生效，不重复提单）', async () => {
    const out = await submitRetireProposals(pool, ORG, DAYS, { userId: 'metric-retire-job', channel: 'job' })
    expect(out.proposed).toBe(0)
    expect(out.tickets).toEqual([])
    const pend = await pool.query(
      `select count(*)::int as n from data.metric_change
        where org = $1 and metric_id = $2 and status = any($3)`, [ORG, E, ['draft', 'preview_ready', 'preview_failed']])
    expect(pend.rows[0]!.n).toBe(1)
  })

  it('delete 单带 reason 采纳后行被删（reason 不阻断执行）', async () => {
    const ticket = await pool.query(
      `select id from data.metric_change where org = $1 and metric_id = $2 and status = 'draft' order by id desc limit 1`, [ORG, E])
    const id = Number(ticket.rows[0]!.id)
    // 域层提单不跑试算（提交面才跑）；采纳链只关心状态与快照在位 ⇒ 直接推 preview_ready。
    await pool.query(`update data.metric_change set status = 'preview_ready', preview = $2::jsonb where id = $1`,
      [id, JSON.stringify({ rows: 0 })])
    const decided = await adoptChange(writeDeps(pool), ORG, id)
    expect(decided.ok).toBe(true)
    const gone = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [ORG, E])
    expect(gone.rowCount).toBe(0)
  })
})
