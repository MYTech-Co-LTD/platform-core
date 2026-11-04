// verified-questions.test.ts — W1 可信度地基 Task 2：已验证问答的平台 HTTP 面
// （列出 / 人工确认 / 人工拒绝）。
//
// 与 metrics.test.ts 同款装配：模块壳不挂宿主门卫，故**scope 拒绝**归宿主门卫（这里验不了），
// 本文件验的是：列表默认口径（只列 verified）、状态过滤、确认把 source/strength 升为 human、
// 拒绝不写确认身份、跨租户 404、以及 id/身份的形状闸。
//
// 租户隔离一律用本文件专用 ORG（同 metric-store.test.ts 的约定）——不同测试文件并行跑，
// 隔离键重合会互相擦数据。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { listVerified, upsertCandidate } from '../domain/verified-questions'
import type { Baseline, CandidateInput, VerifiedQuestionStatus } from '../domain/verified-questions'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-t2-verified-api'
const OTHER_ORG = 'org-t2-verified-api-OTHER'
const ADMIN = 'u-verified-admin'

const baselineOf = (sum: number): Baseline => ({
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum, min: sum, max: sum, nulls: 0 } },
})

let pool: Pool

function app(org: string, scopes: string[] = ['data:query', 'data:manage'], userId = ADMIN) {
  return buildTestApp(mod, makeIdentity({ orgId: org, scopes, userId }), { pool }, { id: 1, casdoor_org: org }, [])
}

/** 直落一条候选/已验证行（自动信号 path），返回该行 id。 */
async function seed(over: Partial<CandidateInput> = {}, org = ORG): Promise<number> {
  const input: CandidateInput = {
    question: '上个月净销售额',
    metricId: 'lemeng:retail:net_sales',
    params: {},
    slicing: {},
    baseline: baselineOf(100),
    source: 'auto',
    strength: 'strong',
    ...over,
  }
  await upsertCandidate(pool, org, input)
  // 自动强信号 ⇒ verified；弱信号 ⇒ candidate。按 source/strength 反推应查哪个状态，
  // 而不是「先查 verified 再查 candidate」（那会把断言写进夹具里）。
  const status: VerifiedQuestionStatus = input.source === 'auto' && input.strength === 'strong'
    ? 'verified' : 'candidate'
  const rows = await listVerified(pool, org, { status, metricId: input.metricId })
  const row = rows.find((r) => r.question === input.question)
  if (row === undefined) throw new Error(`夹具未落库：${input.question}`)
  return row.id
}

const getVerified = (query = '', org = ORG) =>
  app(org, ['data:manage']).request(`/metrics/verified${query}`)

const postAction = (id: number | string, action: 'verify' | 'reject', org = ORG, userId = ADMIN) =>
  app(org, ['data:query', 'data:manage'], userId).request(`/metrics/verified/${id}/${action}`, { method: 'POST' })

describePg('已验证问答平台 API（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('delete from data.verified_questions where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.verified_questions where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  // ── 读面 ──────────────────────────────────────────────────────────────────────
  it('GET /metrics/verified：默认只列 verified（候选不出现），字段按 camelCase 透出', async () => {
    const verifiedId = await seed()
    await seed({ question: '上个月销售额', metricId: 'lemeng:retail:sales', strength: 'weak' })

    const res = await getVerified()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.questions).toHaveLength(1)
    expect(body.questions[0]).toMatchObject({
      id: verifiedId,
      question: '上个月净销售额',
      metricId: 'lemeng:retail:net_sales',
      status: 'verified',
      source: 'auto',
      strength: 'strong',
      verifiedBy: 'auto:strong',
      tolerance: 0.001,
    })
    expect(body.questions[0].baseline).toEqual(baselineOf(100))
  })

  it('GET ?status=candidate 列候选；?metricId= 收窄；非法 status ⇒ 400', async () => {
    await seed()
    const candidateId = await seed({
      question: '上个月销售额', metricId: 'lemeng:retail:sales', strength: 'weak',
    })
    const secondCandidateId = await seed({
      question: '上季度毛利', metricId: 'lemeng:retail:margin', strength: 'weak',
    })

    const candidates = await (await getVerified('?status=candidate')).json()
    expect(candidates.questions.map((q: { id: number }) => q.id).sort((a: number, b: number) => a - b))
      .toEqual([candidateId, secondCandidateId].sort((a, b) => a - b))

    const narrowed = await (await getVerified('?status=candidate&metricId=lemeng%3Aretail%3Asales')).json()
    expect(narrowed.questions).toHaveLength(1)
    expect(narrowed.questions[0].id).toBe(candidateId)

    const bad = await getVerified('?status=whatever')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'INVALID_STATUS' })
  })

  it('无身份（orgId 空）⇒ 空列表（不是报错，也不是全租户数据）', async () => {
    await seed()
    const anon = await buildTestApp(
      mod, makeIdentity({ orgId: '', scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG }, [],
    ).request('/metrics/verified')
    expect(anon.status).toBe(200)
    expect(await anon.json()).toEqual({ questions: [] })
    // 对照：正常身份看得到同一条（证明不是数据没落库）
    const normal = await getVerified()
    expect((await normal.json()).questions).toHaveLength(1)
  })

  // ── 写面：确认 ────────────────────────────────────────────────────────────────
  it('POST /:id/verify：候选 → verified，且 source/strength 升为 human（verified+weak 不可能出现）', async () => {
    const id = await seed({ question: '上个月销售额', metricId: 'lemeng:retail:sales', strength: 'weak' })

    const res = await postAction(id, 'verify')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const rows = await listVerified(pool, ORG, { metricId: 'lemeng:retail:sales' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id, status: 'verified', source: 'human', strength: 'human',
      // 确认：verified_by（谁确认过）与 decided_by（谁做的这次决策）都写
      verifiedBy: ADMIN, decidedBy: ADMIN,
    })
    expect(rows[0]!.verifiedAt).not.toBeNull()
    expect(rows[0]!.decidedAt).not.toBeNull()
    // 候选列表里不再有它
    expect(await listVerified(pool, ORG, { status: 'candidate', metricId: 'lemeng:retail:sales' })).toHaveLength(0)
  })

  // ── 写面：拒绝 ────────────────────────────────────────────────────────────────
  it('POST /:id/reject：候选 → rejected；决策人落 decided_by，verified_by 仍为 NULL', async () => {
    const id = await seed({ question: '上个月销售额', metricId: 'lemeng:retail:sales', strength: 'weak' })

    const res = await postAction(id, 'reject')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const rejected = await listVerified(pool, ORG, { status: 'rejected', metricId: 'lemeng:retail:sales' })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      id, status: 'rejected',
      // 从未确认过的行：verified_by 恒 NULL；拒绝人必须落在 decided_by（否则库里没人拒绝的痕迹）
      verifiedBy: null, decidedBy: ADMIN,
    })
    expect(rejected[0]!.decidedAt).not.toBeNull()
    expect(await listVerified(pool, ORG, { metricId: 'lemeng:retail:sales' })).toHaveLength(0)
  })

  // ── 写面：拒绝空哨兵基线 ──────────────────────────────────────────────────────
  it('POST /:id/verify：空哨兵基线（重放失败的候选）⇒ 409 EMPTY_BASELINE，行保持 candidate', async () => {
    const id = await seed({
      question: '重放失败的空基线',
      metricId: 'lemeng:retail:empty-baseline',
      strength: 'weak',
      baseline: { columns: [], rowCount: 0, summary: {} },
    })

    const res = await postAction(id, 'verify')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'EMPTY_BASELINE' })
    const rows = await listVerified(pool, ORG, { status: 'candidate', metricId: 'lemeng:retail:empty-baseline' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, status: 'candidate', verifiedBy: null })
  })

  // ── 租户隔离 / 形状闸 ─────────────────────────────────────────────────────────
  it('跨租户：用别家 org 的 id 调 verify ⇒ 404，目标行原样不动', async () => {
    const foreignId = await seed({ question: '别家的问题', strength: 'weak' }, OTHER_ORG)

    const res = await postAction(foreignId, 'verify', ORG)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' })

    const untouched = await listVerified(pool, OTHER_ORG, {
      status: 'candidate', metricId: 'lemeng:retail:net_sales',
    })
    expect(untouched).toHaveLength(1)
    expect(untouched[0]).toMatchObject({ id: foreignId, status: 'candidate', verifiedBy: null })
  })

  it('非法 id（非数字 / 0 / 不存在）⇒ 404；无身份写 ⇒ 403 UNAUTHENTICATED', async () => {
    for (const raw of ['abc', '0', '999999999']) {
      const res = await postAction(raw, 'verify')
      expect(res.status, `id=${raw}`).toBe(404)
      expect(await res.json()).toEqual({ error: 'NOT_FOUND' })
    }

    const id = await seed({ strength: 'weak' })
    const anon = await buildTestApp(
      mod, makeIdentity({ orgId: '', scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG }, [],
    ).request(`/metrics/verified/${id}/verify`, { method: 'POST' })
    expect(anon.status).toBe(403)
    expect(await anon.json()).toEqual({ error: 'UNAUTHENTICATED' })
    // 无身份写入被拒 ⇒ 行没被改
    const rows = await listVerified(pool, ORG, { status: 'candidate' })
    expect(rows.map((r) => r.id)).toContain(id)

    // userId 为空但 orgId 有值：requesterOf 只拦空 orgId ⇒ 路由必须自己挡成 403，
    // 不能让它落到域层「必须带操作人」抛错冒成 500（评审 Minor）。
    const id2 = await seed({
      question: '空账号写入', metricId: 'lemeng:retail:emptyuser', strength: 'weak',
    })
    const noUser = await buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'], userId: '' }), { pool }, { id: 1, casdoor_org: ORG }, [],
    ).request(`/metrics/verified/${id2}/reject`, { method: 'POST' })
    expect(noUser.status).toBe(403)
    expect(await noUser.json()).toEqual({ error: 'UNAUTHENTICATED' })
    // 仍未被拒（403 发生在写之前）
    expect((await listVerified(pool, ORG, { status: 'candidate' })).map((r) => r.id)).toContain(id2)
  })
})
