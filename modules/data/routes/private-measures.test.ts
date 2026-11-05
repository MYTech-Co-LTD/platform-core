// private-measures.test.ts — W2 Task 3/5：私有测度的 HTTP 写面 + 候选池两条管理端点。
//
// 模块壳不挂宿主门卫（scope 拒绝归 T10 端到端），本文件钉的是：
//   · 新建写生效列 + basis=column_agg + certified=draft，且同租户另一用户立即可查；
//   · 三闸失败映射（输入类 400 / 环境类 500）；
//   · L1 id 保留 409、同档在用 409、跨档 409；
//   · 归档行默认从词表消失，但管理读面可见；租户隔离；
//   · 候选池：generate（仓只读/平台只写 + 规则筛报告）、adopt（三闸 + 候选状态 + 血统 origin）。
//
// ⚠️ 数据面用本文件的 `pm_route` schema 替身（同一 DATABASE_URL）；生产是两张库，
//    路由的 warehouse 测试缝（RouteCtx.warehouse）就是为此存在的。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { L1_ORG, upsertL1Metric } from '../domain/metric-store'
import type { L1MetricDef } from '../domain/metric-store'
import { listCandidates, setCandidateStatus, upsertCandidate } from '../domain/metric-candidates'
import type { CandidateInput } from '../domain/metric-candidates'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-w2-private-api'
const OTHER_ORG = 'org-w2-private-api-other'
const L1_PREFIX = 'w2route:'
const SCHEMA = 'pm_route'

let pool: Pool

function l1Def(over: Partial<L1MetricDef>): L1MetricDef {
  return {
    id: `${L1_PREFIX}net_sales`,
    title: '私有测度白名单基底',
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: `select sum(${SCHEMA}.fct_sales.amount) as value, day from ${SCHEMA}.fct_sales`,
    groupBy: 'day',
    params: {},
    sourceSystem: 'lemeng',
    slaDays: 1,
    freshnessRelations: [],
    masks: null,
    ...over,
  }
}

const L1_OK = l1Def({})
/** 关系在白名单里，但数据面看不到任何列 ⇒ COLUMNS_UNAVAILABLE（500，不是用户输入错）。 */
const L1_MISSING = l1Def({
  id: `${L1_PREFIX}missing`,
  selectSql: `select sum(${SCHEMA}.no_such_table.x) as value from ${SCHEMA}.no_such_table`,
})
/** `note` 是被掩码列（adopt 的闸③用例：候选把掩码列当维度必须拒；`branch` 保持未掩码，用于类型闸/成功路径）。 */
const L1_MASKED = l1Def({
  id: `${L1_PREFIX}masked`,
  selectSql: `select sum(${SCHEMA}.fct_sales.amount) as value, day, branch, note from ${SCHEMA}.fct_sales`,
  groupBy: 'day, branch, note',
  masks: [{ column: `${SCHEMA}.fct_sales.note`, kind: 'nullify', grantedBy: 'data:precise' }],
})
/**
 * 候选升级链（W3 Task 3）的白名单基底：**裸关系名**（生产 l1_metrics.yml 的形态——
 * 组装器的 AGG_SIMPLE_RE 只认 `agg(关系.列)` 单点形态，schema 限定的候选关系升不上去）。
 * id 取三段命名空间（`<源>:<域>:<指标>`）——name 缺席时的派生建议从它取前两段。
 */
const L1_PROMO_BASE = l1Def({
  id: 'w2route:promo:base_sales',
  title: '候选升级白名单基底',
  selectSql: 'select sum(fct_sales.amount) as value, day from fct_sales',
})

function app(org = ORG, scopes: string[] = ['data:query'], userId = 'u-private') {
  // warehouse 用变量携带：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool；
  // 与 branches.test.ts / chat.test.ts 携带 execute 测试缝同款）。
  const ctx = { pool, warehouse: pool }
  return buildTestApp(
    mod,
    makeIdentity({ orgId: org, scopes, userId }),
    ctx,
    { id: 1, casdoor_org: org },
    [],
  )
}

async function post(body: unknown, org = ORG, scopes: string[] = ['data:query'], userId = 'u-private') {
  return app(org, scopes, userId).request('/metrics/private', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const body = (over: Record<string, unknown> = {}) => ({
  id: 'pm_route_sales',
  title: '按日销售额',
  description: '私有口径',
  agg: 'sum',
  column: 'amount',
  dims: ['day'],
  relation: `${SCHEMA}.fct_sales`,
  ...over,
})

/**
 * 仓库替身：只截 `data.metric_profiles` 的查询（返回给定画像），其余 SQL 原样走真库
 * —— `information_schema` 的实际列查询因此仍是真的（`pm_route.fct_sales` 已建）。
 */
function warehouseWithProfiles(rows: unknown[]): Pool {
  return {
    query: (sql: string, params?: unknown[]) => (
      sql.includes('data.metric_profiles')
        ? Promise.resolve({ rows })
        : pool.query(sql, params as unknown[])
    ),
  } as unknown as Pool
}

/** profiler 的落表行形状（`data.metric_profiles`）。 */
function profileRow(column: string, over: Record<string, unknown> = {}) {
  return {
    relation: `${SCHEMA}.fct_sales`,
    column,
    stats: { column_type: 'VARCHAR', count: 100, approx_unique: 10, null_percentage: 0, ...over },
    profiled_at: new Date('2026-11-04T00:00:00.000Z'),
  }
}

/** 候选/生成端点的 app（`ctx.warehouse` 注入替身）。 */
function appWithWarehouse(
  warehouse: Pool, scopes: string[] = ['data:manage'], userId = 'u-candidates', org = ORG,
) {
  const ctx = { pool, warehouse }
  return buildTestApp(
    mod,
    makeIdentity({ orgId: org, scopes, userId }),
    ctx,
    { id: 1, casdoor_org: org },
    [],
  )
}

// ── W3 Task 3：候选 → L1 声明草案（propose-l1）────────────────────────────────────────────
/** 组装器的现行文件基底（fixture 仓根里的 l1_metrics.yml）：relation 用裸名 fct_sales。 */
const PROMO_FIXTURE = `version: 1

metrics:
  # 既有条目（候选升级链的 B11 基底；插入/替换都不得碰它逐字以外的区域）
  - name: 'w2route:promo:existing_sales'
    label: 既有条目
    definition: >-
      既有条目 = 测试口径（候选升级链路的 B11 白名单基底）。
    expression: 'sum(fct_sales.amount)'
    grain: [day]
    owner: data-platform
    tier: experimental
    source: w2route
    freshness_sla_days: 1
`

/** fixture 仓根：临时目录 + `dbt/semantics/l1_metrics.yml`（RouteCtx.repoRoot 缝注入；afterAll 统一删）。 */
const promoRepoRoots: string[] = []
function makeRepoRoot(yaml: string = PROMO_FIXTURE): string {
  const dir = mkdtempSync(join(tmpdir(), 'promo-l1-'))
  mkdirSync(join(dir, 'dbt/semantics'), { recursive: true })
  writeFileSync(join(dir, 'dbt/semantics/l1_metrics.yml'), yaml)
  promoRepoRoots.push(dir)
  return dir
}

/** propose-l1 端点的 app（data:manage + repoRoot 缝）。 */
function proposeApp(repoRoot: string, org = ORG, userId = 'u-promote') {
  const ctx = { pool, warehouse: pool, repoRoot }
  return buildTestApp(
    mod,
    makeIdentity({ orgId: org, scopes: ['data:manage'], userId }),
    ctx,
    { id: 1, casdoor_org: org },
    [],
  )
}

function proposeL1(candidateId: number, body: unknown, repoRoot = makeRepoRoot()) {
  return proposeApp(repoRoot).request(`/metrics/candidates/${candidateId}/propose-l1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 候选造厂：默认裸关系 fct_sales + dims [day]（可升级档）；over 覆盖任意入参。 */
function promoCandidate(over: Partial<CandidateInput> = {}) {
  return upsertCandidate(pool, ORG, {
    relation: 'fct_sales',
    expr: { agg: 'avg', column: 'amount', dims: ['day'] },
    evidence: {
      source: 'profile', profileRelation: 'staging.fct_sales', dataType: 'numeric',
      count: 100, nullPercentage: 0, approxUnique: 90,
    },
    rationale: '画像证据充分',
    confidence: 0.83,
    origin: 'profile',
    ...over,
  })
}

/** 回包草案 piece 里的新条目（解析回读，不按序列化文本断言）。 */
function entryOf(pieceContent: string, name: string): Record<string, unknown> {
  const metrics = (parseDocument(pieceContent).toJS() as { metrics: Array<Record<string, unknown>> }).metrics
  return metrics.find((m) => m.name === name)!
}

describePg('私有测度 HTTP 面（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await pool.query(`drop schema if exists ${SCHEMA} cascade`)
    await pool.query(`create schema ${SCHEMA}`)
    await pool.query(`create table ${SCHEMA}.fct_sales (
      org text not null, day date, amount numeric(12,2), branch text, note text)`)
    await upsertL1Metric(pool, L1_OK)
    await upsertL1Metric(pool, L1_MISSING)
    await upsertL1Metric(pool, L1_MASKED)
    await upsertL1Metric(pool, L1_PROMO_BASE)
  })

  beforeEach(async () => {
    await pool.query('delete from data.metric_audit where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    for (const dir of promoRepoRoots) rmSync(dir, { recursive: true, force: true })
    await pool.query('delete from data.metric_audit where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${L1_PREFIX}%`]).catch(() => {})
    await pool.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ POST /metrics/private：201 + 生效列/basis/draft；同租户另一用户 GET /metrics 立即可查', async () => {
    const res = await post(body())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })

    const row = (await pool.query(
      `select source, basis, certified, created_by, select_sql, group_by, draft_spec
         from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rows[0]
    expect(row).toMatchObject({
      source: 'l2', basis: 'column_agg', certified: 'draft', created_by: 'u-private',
      select_sql: `select sum(amount) as value, day from ${SCHEMA}.fct_sales`,
      group_by: 'day', draft_spec: null,
    })

    // 同租户、另一个 data:query 用户（租户共享，不是创建者私有）
    const other = await app(ORG, ['data:query'], 'u-someone-else').request('/metrics')
    const ids = (await other.json()).metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain('pm_route_sales')
    // 别家 org 看不见
    const foreign = await app(OTHER_ORG, ['data:query'], 'u-other').request('/metrics')
    expect((await foreign.json()).metrics.map((m: { id: string }) => m.id)).not.toContain('pm_route_sales')
  })

  it('三闸失败映射：白名单外 400 RELATION_NOT_ALLOWED；数据面看不到列 500 COLUMNS_UNAVAILABLE', async () => {
    const notAllowed = await post(body({ id: 'pm_bad', relation: 'not_a_mart' }))
    expect(notAllowed.status).toBe(400)
    expect(await notAllowed.json()).toEqual({ error: 'RELATION_NOT_ALLOWED', detail: expect.stringContaining('not_a_mart') })

    const unavailable = await post(body({
      id: 'pm_missing', relation: `${SCHEMA}.no_such_table`, column: 'x', dims: [],
    }))
    expect(unavailable.status).toBe(500)
    expect(await unavailable.json()).toMatchObject({ error: 'COLUMNS_UNAVAILABLE' })
  })

  it('L1 的 id 被保留 ⇒ 409 ID_RESERVED_BY_L1；同档在用重复建 ⇒ 409 METRIC_EXISTS', async () => {
    const reserved = await post(body({ id: L1_OK.id }))
    expect(reserved.status).toBe(409)
    expect(await reserved.json()).toEqual({ error: 'ID_RESERVED_BY_L1' })

    expect((await post(body())).status).toBe(201)
    const again = await post(body({ title: '改个名' }))
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'METRIC_EXISTS' })
  })

  // ── D6：私有测度的修改路径（评审 Important）────────────────────────────────────
  it('★ D6：column_agg 草稿保存 → 确认 → 生效列变化，basis 保持、draft_spec 清空、审计记 update', async () => {
    expect((await post(body())).status).toBe(201)

    const save = await app().request('/metrics/pm_route_sales/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftSpec: { kind: 'column_agg', agg: 'count', column: 'branch', dims: ['day'] },
      }),
    })
    expect(save.status).toBe(200)
    expect(await save.json()).toEqual({ ok: true })
    const draftRes = await app().request('/metrics/pm_route_sales/draft')
    expect((await draftRes.json()).draftSpec)
      .toEqual({ kind: 'column_agg', agg: 'count', column: 'branch', dims: ['day'] })

    const confirm = await app().request('/metrics/pm_route_sales/confirm-draft', { method: 'POST' })
    expect(confirm.status).toBe(200)
    expect(await confirm.json()).toEqual({ ok: true })

    const row = (await pool.query(
      `select basis, select_sql, group_by, draft_spec, version
         from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rows[0]
    expect(row).toMatchObject({
      basis: 'column_agg',
      select_sql: `select count(branch) as value, day from ${SCHEMA}.fct_sales`,
      group_by: 'day',
      draft_spec: null,
      version: 2,
    })
    expect((await pool.query(
      `select action from data.metric_audit where org = $1 and metric_id = 'pm_route_sales' order by id`,
      [ORG])).rows.map((r) => r.action)).toEqual(['create', 'update'])
  })

  it('★ D6：给 column_agg 行存树形草稿 ⇒ 400 DRAFT_BASIS_MISMATCH（不落库）', async () => {
    expect((await post(body())).status).toBe(201)
    const save = await app().request('/metrics/pm_route_sales/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftSpec: { baseMetric: L1_OK.id, op: { kind: 'refine' } } }),
    })
    expect(save.status).toBe(400)
    expect(await save.json()).toEqual({ error: 'DRAFT_BASIS_MISMATCH' })
    const row = (await pool.query(
      `select draft_spec from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rows[0]
    expect(row.draft_spec).toBeNull()
  })

  it('★ D6：确认时三闸不过 ⇒ 不生效、草稿保留（改了再确认）', async () => {
    expect((await post(body())).status).toBe(201)
    const badDraft = { kind: 'column_agg', agg: 'sum', column: 'no_such_column', dims: [] }
    const save = await app().request('/metrics/pm_route_sales/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftSpec: badDraft }),
    })
    expect(save.status).toBe(200)

    const before = (await pool.query(
      `select select_sql, version from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rows[0]
    const confirm = await app().request('/metrics/pm_route_sales/confirm-draft', { method: 'POST' })
    expect(confirm.status).toBe(400)
    expect(await confirm.json()).toMatchObject({ error: 'COLUMN_NOT_FOUND' })

    const after = (await pool.query(
      `select select_sql, version, draft_spec from data.metrics where org = $1 and id = 'pm_route_sales'`,
      [ORG])).rows[0]
    expect(after.select_sql).toBe(before.select_sql)   // 数字没变
    expect(after.version).toBe(before.version)
    expect(after.draft_spec).toEqual(badDraft)          // ★ 草稿原地保留
  })

  it('非法 body ⇒ 400 INVALID_BODY（strict：selectSql 等实现细节不得混进声明）', async () => {    for (const bad of [
      body({ id: '' }),
      body({ title: undefined }),
      body({ agg: 'median' }),
      body({ dims: 'day' }),
      body({ selectSql: 'select 1 as value' }),
    ]) {
      const res = await post(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
    }
  })

  it('无身份 ⇒ 403 UNAUTHENTICATED（不写无主行）', async () => {
    const anonCtx = { pool, warehouse: pool }
    const anon = await buildTestApp(
      mod, makeIdentity({ orgId: '', scopes: ['data:query'] }), anonCtx,
      { id: 1, casdoor_org: ORG }, [],
    ).request('/metrics/private', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()),
    })
    expect(anon.status).toBe(403)
    expect(await anon.json()).toEqual({ error: 'UNAUTHENTICATED' })
    expect((await pool.query(`select 1 from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rowCount).toBe(0)
  })

  it('★ 归档读面：归档后从 GET /metrics 消失，但 GET /metrics/private/archived 可见（租户隔离）', async () => {
    expect((await post(body())).status).toBe(201)
    expect((await post(body({ id: 'pm_route_active' }))).status).toBe(201)
    await pool.query(
      `update data.metrics set archived_at = now() where org = $1 and id = 'pm_route_sales'`, [ORG])
    // 别家 org 也有一条归档行——不得串进来
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations,
          created_by, certified, basis, archived_at)
       values ($1, 'pm_foreign_archived', '别家', '', null, 'org',
               'select 1 as value', '', '{}'::jsonb, 'l2', null, 'u-other', 1, false, null, null,
               'u-other', 'draft', 'column_agg', now())`,
      [OTHER_ORG])

    const visible = (await (await app(ORG, ['data:query']).request('/metrics')).json())
      .metrics.map((m: { id: string }) => m.id)
    expect(visible).toContain('pm_route_active')
    expect(visible).not.toContain('pm_route_sales')

    const archivedRes = await app(ORG, ['data:manage']).request('/metrics/private/archived')
    expect(archivedRes.status).toBe(200)
    const archived = (await archivedRes.json()).metrics
    expect(archived.map((m: { id: string }) => m.id)).toEqual(['pm_route_sales'])
    expect(archived[0]).toMatchObject({
      id: 'pm_route_sales', title: '按日销售额', createdBy: 'u-private',
    })
    expect(archived[0].archivedAt).toEqual(expect.any(String))
  })

  // ── 候选池（W2 Task 5）────────────────────────────────────────────────────────
  it('★ POST /metrics/candidates/generate：仓只读画像 → 规则筛 → 候选落平台库，返回统计', async () => {
    const wh = warehouseWithProfiles([
      profileRow('amount', { column_type: 'NUMERIC', approx_unique: 90 }),
      profileRow('branch', { approx_unique: 3 }),
    ])
    const res = await appWithWarehouse(wh).request('/metrics/candidates/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      org: ORG,
      profiles: 2,
      relations: 1,
      skippedRelations: 0,
      added: 3,          // avg(amount) + count(branch) + count_distinct(branch)
      refreshed: 0,
      skipped: 1,        // sum(amount) 已被 L1_OK 覆盖
      capped: 0,
      maxPerRelation: 20,
      expired: 0,
      revived: 0,
      pendingAfter: 3,   // 池级：处理完这 1 个关系后 pending（profile）共 3 条
      skippedBy: {
        'no-stats': 0,
        'no-data': 0,
        'all-null': 0,
        'single-value': 0,
        'not-enumerable': 0,
        'column-type-unavailable': 0,
        'covered-by-l1': 1,
      },
    })

    const rows = await listCandidates(pool, ORG)
    expect(rows.map((c) => `${c.expr.agg}(${c.expr.column})`).sort())
      .toEqual(['avg(amount)', 'count(branch)', 'count_distinct(branch)'])
    expect(rows.every((c) => c.relation === `${SCHEMA}.fct_sales` && c.origin === 'profile')).toBe(true)
  })

  it('★ POST /metrics/candidates/:id/adopt：候选 → 私有测度（三闸重校验 + 状态 created + 血统 profile）', async () => {
    const wh = warehouseWithProfiles([profileRow('amount', { column_type: 'NUMERIC', approx_unique: 90 })])
    expect((await appWithWarehouse(wh).request('/metrics/candidates/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).status).toBe(200)

    const candidate = (await listCandidates(pool, ORG))[0]!
    expect(candidate.expr).toEqual({ agg: 'avg', column: 'amount', dims: [] })

    const res = await appWithWarehouse(wh, ['data:manage'], 'u-adopt').request(
      `/metrics/candidates/${candidate.id}/adopt`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pm_from_candidate', title: '平均销售额' }),
      },
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, metricId: 'pm_from_candidate', candidateStatus: 'created' })

    const row = (await pool.query(
      `select source, basis, certified, created_by, select_sql, group_by
         from data.metrics where org = $1 and id = 'pm_from_candidate'`, [ORG])).rows[0]
    expect(row).toMatchObject({
      source: 'l2', basis: 'column_agg', certified: 'draft', created_by: 'u-adopt',
      select_sql: `select avg(amount) as value from ${SCHEMA}.fct_sales`,
      group_by: '',
    })
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('created')
    // 血统：adopt = profile（对话即时创建 = demand，见下一条）
    const audit = (await pool.query(
      `select row_after from data.metric_audit where org = $1 and metric_id = 'pm_from_candidate'`, [ORG])).rows[0]
    expect(audit.row_after.origin).toBe('profile')
  })

  it('对话即时路径：POST /metrics/private 缺省 origin=demand（审计留证，不新增列）', async () => {
    expect((await post(body())).status).toBe(201)
    const audit = (await pool.query(
      `select row_after from data.metric_audit where org = $1 and metric_id = 'pm_route_sales'`, [ORG])).rows[0]
    expect(audit.row_after.origin).toBe('demand')
  })

  it('adopt 的血统跟候选走：demand 来源候选采用后审计记 demand（不硬编码 profile）', async () => {
    const c = await upsertCandidate(pool, ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'avg', column: 'amount' },
      origin: 'demand',
    })
    const res = await appWithWarehouse(warehouseWithProfiles([]), ['data:manage'], 'u-adopt').request(
      `/metrics/candidates/${c.id}/adopt`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pm_demand_adopt' }),
      },
    )
    expect(res.status).toBe(201)
    const audit = (await pool.query(
      `select row_after from data.metric_audit where org = $1 and metric_id = 'pm_demand_adopt'`, [ORG])).rows[0]
    expect(audit.row_after.origin).toBe('demand')
  })

  it('★ adopt 不信任候选：关系不在白名单 ⇒ 400 RELATION_NOT_ALLOWED，候选仍 pending', async () => {
    const c = await upsertCandidate(pool, ORG, {
      relation: 'not_a_mart',
      expr: { agg: 'sum', column: 'amount' },
      origin: 'profile',
    })
    const res = await appWithWarehouse(warehouseWithProfiles([])).request(
      `/metrics/candidates/${c.id}/adopt`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pm_bad_candidate' }),
      },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'RELATION_NOT_ALLOWED' })
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
    expect((await pool.query(
      `select 1 from data.metrics where org = $1 and id = 'pm_bad_candidate'`, [ORG])).rowCount).toBe(0)
  })

  it('★ adopt 三闸重校验：sum(非数值列) ⇒ COLUMN_NOT_NUMERIC；掩码维度 ⇒ DIM_MASKED（失败回滚 pending）', async () => {
    const appManual = appWithWarehouse(warehouseWithProfiles([]))
    const adopt = (candidateId: number, metricId: string) => appManual.request(
      `/metrics/candidates/${candidateId}/adopt`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: metricId }),
      },
    )

    // 闸②：sum 要求数值列（branch 是 text）
    const nonNumeric = await upsertCandidate(pool, ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'sum', column: 'branch' },
      origin: 'profile',
    })
    const r1 = await adopt(nonNumeric.id, 'pm_non_numeric')
    expect(r1.status).toBe(400)
    expect(await r1.json()).toMatchObject({ error: 'COLUMN_NOT_NUMERIC' })
    expect((await listCandidates(pool, ORG)).find((c) => c.id === nonNumeric.id)!.status).toBe('pending')

    // 闸③：note 被 L1_MASKED 掩码 ⇒ 不得做维度
    const maskedDim = await upsertCandidate(pool, ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'avg', column: 'amount', dims: ['note'] },
      origin: 'profile',
    })
    const r2 = await adopt(maskedDim.id, 'pm_masked_dim')
    expect(r2.status).toBe(400)
    expect(await r2.json()).toMatchObject({ error: 'DIM_MASKED' })
    expect((await listCandidates(pool, ORG)).find((c) => c.id === maskedDim.id)!.status).toBe('pending')
    expect((await pool.query(
      `select 1 from data.metrics where org = $1 and id = any($2)`, [ORG, ['pm_non_numeric', 'pm_masked_dim']],
    )).rowCount).toBe(0)
  })

  it('adopt 的状态机：rejected ⇒ 409 CANDIDATE_NOT_ADOPTABLE；不存在 / 别家 org ⇒ 404', async () => {
    const c = await upsertCandidate(pool, ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'avg', column: 'amount' },
      origin: 'profile',
    })
    await setCandidateStatus(pool, ORG, c.id, 'rejected')
    const appManual = appWithWarehouse(warehouseWithProfiles([]))
    const rejected = await appManual.request(`/metrics/candidates/${c.id}/adopt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pm_rejected_candidate' }),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ error: 'CANDIDATE_NOT_ADOPTABLE', status: 'rejected' })

    const missing = await appManual.request('/metrics/candidates/999999999/adopt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pm_missing_candidate' }),
    })
    expect(missing.status).toBe(404)

    const foreign = await upsertCandidate(pool, OTHER_ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'count', column: 'branch' },
      origin: 'profile',
    })
    const cross = await appManual.request(`/metrics/candidates/${foreign.id}/adopt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pm_cross_org_candidate' }),
    })
    expect(cross.status).toBe(404)
  })

  it('adopt 非法 body ⇒ 400 INVALID_BODY（strict：客户端不得改写算式）', async () => {
    const c = await upsertCandidate(pool, ORG, {
      relation: `${SCHEMA}.fct_sales`,
      expr: { agg: 'avg', column: 'amount' },
      origin: 'profile',
    })
    const res = await appWithWarehouse(warehouseWithProfiles([])).request(
      `/metrics/candidates/${c.id}/adopt`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pm_x', agg: 'sum', selectSql: 'select 1 as value' }),
      },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
  })

  it('★ 画像读不到 ⇒ 500 PROFILE_UNAVAILABLE（不是「0 条候选」的假绿）', async () => {
    const broken = {
      query: async () => {
        throw Object.assign(new Error('relation "data.metric_profiles" does not exist'), { code: '42P01' })
      },
    } as unknown as Pool
    const res = await appWithWarehouse(broken).request('/metrics/candidates/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'PROFILE_UNAVAILABLE' })
    expect(await listCandidates(pool, ORG)).toHaveLength(0)
  })

  it('generate body：畸形 JSON ⇒ 400（写动作不把解析失败当空 body）；空 body ⇒ 200 默认全量', async () => {
    const appGen = appWithWarehouse(warehouseWithProfiles([]))
    const bad = await appGen.request('/metrics/candidates/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json',
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'INVALID_BODY' })
    expect(await listCandidates(pool, ORG)).toHaveLength(0)

    const empty = await appGen.request('/metrics/candidates/generate', { method: 'POST' })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ added: 0, profiles: 0, maxPerRelation: 20 })
  })

  it('generate 非法 body ⇒ 400 INVALID_BODY（maxPerRelation 上限 20）', async () => {
    for (const bad of [{ maxPerRelation: 0 }, { maxPerRelation: 21 }, { maxPerRelation: '20' }, { relations: 'x' }]) {
      const res = await appWithWarehouse(warehouseWithProfiles([])).request('/metrics/candidates/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
    }
  })

  // ── 候选 → L1 声明草案（W3 Task 3：propose-l1，零写盘）────────────────────────
  it('★ propose-l1：候选 → 组装器 → 草案回包（零写盘）+ 成功后状态置 promoted', async () => {
    const repoRoot = makeRepoRoot()
    const fixturePath = join(repoRoot, 'dbt/semantics/l1_metrics.yml')
    const before = readFileSync(fixturePath, 'utf8')
    const cand = await promoCandidate()

    const res = await proposeL1(cand.id, { name: 'w2route:promo:amount_avg', label: '平均销售额' }, repoRoot)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, candidateId: cand.id, mode: 'create' })

    // 组装映射逐字段钉死（agg/column→expression、dims→grain、缺省档派生）
    expect(body.pieces).toHaveLength(1)
    expect(body.pieces[0].path).toBe('dbt/semantics/l1_metrics.yml')
    expect(entryOf(body.pieces[0].content, 'w2route:promo:amount_avg')).toMatchObject({
      label: '平均销售额',
      definition: 'avg(fct_sales.amount) 按 day 分组',       // definition 缺省 = 算式的逐字陈述
      expression: 'avg(fct_sales.amount)',
      grain: ['day'],
      owner: 'u-promote',                                    // owner 缺省 = 调用者（谁提谁负责）
      tier: 'experimental',                                  // 机器产的草案 = 试验口径
      source: 'w2route',                                     // 源 = name 命名空间首段
      freshness_sla_days: 1,                                 // SLA 缺省 = 同关系既有声明的承诺
    })
    // gate ⑦ 不旁路：缺 auditSql ⇒ downstream required + validation 注明（不拒——draft PR 带红是预期）
    expect(body.downstream).toEqual([{
      kind: 'required',
      path: 'dbt/tests/w2route/audit_w2route__promo__amount_avg.sql',
      why: expect.stringContaining('独立复算'),
    }])
    expect(JSON.stringify(body.validation)).toContain('auditSql')

    // rationale 带候选血统 + evidence 摘要与 confidence
    expect(body.rationale).toContain(`候选 #${cand.id}`)
    expect(body.rationale).toContain('origin=profile')
    expect(body.rationale).toContain('confidence=0.83')
    expect(body.rationale).toContain('dataType=numeric')

    // ★ 零写盘：fixture 原文逐字未动（路由只读；写动作只经 apply_pipeline_proposal 工具面）
    expect(readFileSync(fixturePath, 'utf8')).toBe(before)

    // 候选状态在**调用成功后**置 promoted（组装失败路径见下面几条：状态不动）
    expect((await listCandidates(pool, ORG)).find((x) => x.id === cand.id)!.status).toBe('promoted')
  })

  it('count_distinct 候选 ⇒ count(distinct rel.col)；文件里已有同名条目 ⇒ 修改档（definition 必须变）', async () => {
    const cand = await promoCandidate({ expr: { agg: 'count_distinct', column: 'branch', dims: ['day'] } })
    const res = await proposeL1(cand.id, { name: 'w2route:promo:branch_uq', label: '去重门店数' })
    expect(res.status).toBe(200)
    expect(entryOf((await res.json()).pieces[0].content, 'w2route:promo:branch_uq'))
      .toMatchObject({ expression: 'count(distinct fct_sales.branch)', grain: ['day'] })

    // ★ 修改档只能对着「文件里已有同名条目」的基底出（本路由零写盘，上一通提案不落盘 ⇒
    //   重提同名仍是 create）。基底含同名条目 + definition 显式变 ⇒ 组装器走修改模式。
    const modifyFixture = `version: 1

metrics:
  - name: 'w2route:promo:branch_uq'
    label: 去重门店数
    definition: >-
      旧定义（修改档测试基底）。
    expression: 'count(distinct fct_sales.branch)'
    grain: [day]
    owner: data-platform
    tier: experimental
    source: w2route
    freshness_sla_days: 1
`
    const again = await proposeL1(cand.id, {
      name: 'w2route:promo:branch_uq', label: '去重门店数', definition: '改口径后的定义',
    }, makeRepoRoot(modifyFixture))
    expect(again.status).toBe(200)
    expect((await again.json()).mode).toBe('modify')
    expect((await listCandidates(pool, ORG)).find((x) => x.id === cand.id)!.status).toBe('promoted')
  })

  it('auditSql 随提案输入携带 ⇒ 成第二个 piece（原文不加工；gate ⑦ 的复算由人写）', async () => {
    const repoRoot = makeRepoRoot()
    const cand = await promoCandidate()
    const sql = 'select day, avg(amount) as value from fct_sales group by 1\n'
    const res = await proposeL1(cand.id, {
      name: 'w2route:promo:amount_avg2', label: '平均销售额', auditSql: sql,
    }, repoRoot)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pieces).toHaveLength(2)
    expect(body.pieces[1]).toEqual({
      path: 'dbt/tests/w2route/audit_w2route__promo__amount_avg2.sql',
      bytes: Buffer.byteLength(sql), content: sql,
    })
    expect(body.downstream).toEqual([])
  })

  it('★ 候选 relation 不在 L1 已用集合 ⇒ 400 RELATION_NOT_PROMOTABLE，状态不动（B11 路由侧先拒）', async () => {
    const repoRoot = makeRepoRoot()
    const cand = await promoCandidate({ relation: 'not_a_mart' })
    const res = await proposeL1(cand.id, { name: 'w2route:promo:x', label: 'x' }, repoRoot)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'RELATION_NOT_PROMOTABLE', relation: 'not_a_mart' })
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
  })

  it('★ name 缺席 ⇒ 400 NAME_REQUIRED + 服务端派生建议（<源>:<域>:<列>_<聚合>，前两段取同关系既有声明）', async () => {
    const repoRoot = makeRepoRoot()
    const cand = await promoCandidate()
    const res = await proposeL1(cand.id, { label: '平均销售额' }, repoRoot)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'NAME_REQUIRED', suggestedName: 'w2route:promo:amount_avg' })
    // 标识符是人的决策：建议不给自动采用，候选状态不动
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
  })

  it('组装器不过 ⇒ 400 INVALID_DECLARATION（issues 原样透出）+ 状态不动', async () => {
    const repoRoot = makeRepoRoot()
    // dims 空 ⇒ grain 空 ⇒ 组装器机检必拒（L1 声明的 grain 必须非空）
    const cand = await promoCandidate({ expr: { agg: 'avg', column: 'amount', dims: [] } })
    const res = await proposeL1(cand.id, { name: 'w2route:promo:no_grain', label: 'x' }, repoRoot)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('INVALID_DECLARATION')
    expect(body.issues.some((i: { path: string }) => i.path === 'grain')).toBe(true)
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
  })

  it('B11 兜底（组装器那道）：DB 白名单有该关系但现行文件没用过 ⇒ 400 INVALID_DECLARATION', async () => {
    // 文件基底只用了 fct_other ⇒ 路由侧白名单复核放行（DB 里有 fct_sales），组装器的 B11 拒
    const repoRoot = makeRepoRoot(PROMO_FIXTURE.replaceAll('fct_sales', 'fct_other'))
    const cand = await promoCandidate()
    const res = await proposeL1(cand.id, { name: 'w2route:promo:y', label: 'y' }, repoRoot)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('INVALID_DECLARATION')
    expect(JSON.stringify(body.issues)).toContain('不在现行 l1_metrics.yml 已用的关系集合里')
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
  })

  it('状态机：rejected/created ⇒ 409 CANDIDATE_NOT_PROMOTABLE；不存在 / 别家 org ⇒ 404', async () => {
    const repoRoot = makeRepoRoot()
    const rejected = await promoCandidate()
    await setCandidateStatus(pool, ORG, rejected.id, 'rejected')
    const r1 = await proposeL1(rejected.id, { name: 'w2route:promo:a', label: 'x' }, repoRoot)
    expect(r1.status).toBe(409)
    expect(await r1.json()).toEqual({ error: 'CANDIDATE_NOT_PROMOTABLE', status: 'rejected' })

    const created = await promoCandidate({ expr: { agg: 'count', column: 'branch', dims: ['day'] } })
    await setCandidateStatus(pool, ORG, created.id, 'created')
    const r2 = await proposeL1(created.id, { name: 'w2route:promo:b', label: 'x' }, repoRoot)
    expect(r2.status).toBe(409)
    expect(await r2.json()).toEqual({ error: 'CANDIDATE_NOT_PROMOTABLE', status: 'created' })

    const missing = await proposeL1(999999999, { name: 'w2route:promo:c', label: 'x' }, repoRoot)
    expect(missing.status).toBe(404)

    const foreign = await upsertCandidate(pool, OTHER_ORG, {
      relation: 'fct_sales', expr: { agg: 'avg', column: 'amount' }, origin: 'profile',
    })
    const cross = await proposeL1(foreign.id, { name: 'w2route:promo:d', label: 'x' }, repoRoot)
    expect(cross.status).toBe(404)
  })

  it('现行语义声明不可读 ⇒ 500 SEMANTICS_UNREADABLE（未知 ≠ 基线为空，不许静默当空文件）', async () => {
    const cand = await promoCandidate()
    const res = await proposeL1(cand.id, { name: 'w2route:promo:z', label: 'z' }, join(tmpdir(), 'promo-l1-not-exist'))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'SEMANTICS_UNREADABLE' })
    expect((await listCandidates(pool, ORG))[0]!.status).toBe('pending')
  })

  it('非法 body ⇒ 400 INVALID_BODY（strict：label 必填、多余键拒收、name 非字符串拒收）', async () => {
    const repoRoot = makeRepoRoot()
    const cand = await promoCandidate()
    for (const bad of [{ name: 'w2route:promo:a' }, { label: 'x', selectSql: 'select 1 as value' }, { name: 1, label: 'x' }]) {
      const res = await proposeL1(cand.id, bad, repoRoot)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
    }
  })
})

describe('propose-l1 的 manifest 声明（不需要数据库）', () => {
  it('POST /metrics/candidates/:id/propose-l1 声明为 data:manage（集合一致性由 module.test.ts 兜底）', () => {
    const entry = mod.manifest.api?.internal?.find((e) => e.path === '/metrics/candidates/:id/propose-l1')
    expect(entry).toMatchObject({ method: 'POST', scope: 'data:manage' })
  })
})
