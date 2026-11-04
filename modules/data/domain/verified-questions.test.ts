// verified-questions.test.ts — W1 可信度地基：已验证问答（回归集）的存储层。
//
// 只钉域层（表形状 / upsert 幂等 / 冲突语义 / 状态机 / 租户隔离）；路由形状归 Task 2、
// 回归比较归 Task 3。冲突语义以计划 2026-11-04-amd-w1-verified-questions「冲突语义」表为准。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  listVerified,
  recordCheck,
  setStatus,
  upsertCandidate,
} from './verified-questions'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键：各测试文件互不相同的 org（同 metric-store.test.ts 约定）。 */
const ORG = 'org-t1-verified'
const OTHER_ORG = 'org-t1-verified-OTHER'

const BASELINE = {
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum: 100, min: 100, max: 100, nulls: 0 } },
}
const baselineOf = (sum: number) => ({
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum, min: sum, max: sum, nulls: 0 } },
})

describePg('verified-questions（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.verified_questions where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    await pool.query('delete from data.verified_questions where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('候选 → 人工确认 → 可列出；自动强信号直接 verified', async () => {
    await upsertCandidate(pool, ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: BASELINE,
      source: 'auto', strength: 'strong', sessionId: 's1',
    })
    const verified = await listVerified(pool, ORG)
    expect(verified).toHaveLength(1)
    expect(verified[0]!.status).toBe('verified')

    await upsertCandidate(pool, ORG, {
      question: '上个月销售额', metricId: 'lemeng:retail:sales',
      params: {}, slicing: {}, baseline: { columns: ['value'], rowCount: 1, summary: {} },
      source: 'auto', strength: 'weak', sessionId: 's2',
    })
    expect((await listVerified(pool, ORG))).toHaveLength(1)
    const candidates = await listVerified(pool, ORG, { status: 'candidate' })
    expect(candidates).toHaveLength(1)
    await setStatus(pool, ORG, candidates[0]!.id, 'verified', 'u-admin')
    expect((await listVerified(pool, ORG))).toHaveLength(2)
  })

  it('强信号写入即 verified / verified_by=auto:strong；弱信号落 candidate', async () => {
    const rows = await listVerified(pool, ORG)
    const strong = rows.find((r) => r.metricId === 'lemeng:retail:net_sales')!
    expect(strong).toMatchObject({ source: 'auto', strength: 'strong', status: 'verified', verifiedBy: 'auto:strong' })
    expect(strong.verifiedAt).not.toBeNull()
    // insert 没写 tolerance ⇒ 表默认 0.001（默认值只有表定义一处事实源）
    expect(strong.tolerance).toBe(0.001)
    const weak = rows.find((r) => r.metricId === 'lemeng:retail:sales')!
    // 已被人工确认 ⇒ 人工身份覆盖自动档
    expect(weak).toMatchObject({ status: 'verified', verifiedBy: 'u-admin' })
  })

  it('弱信号不得覆盖已验证行的基线 / 容差，旧检查结果也保留', async () => {
    const before = (await listVerified(pool, ORG)).find((r) => r.metricId === 'lemeng:retail:net_sales')!
    await recordCheck(pool, ORG, before.id, 'pass')
    await upsertCandidate(pool, ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: baselineOf(999), tolerance: 0.005,
      source: 'auto', strength: 'weak', sessionId: 's3',
    })
    const after = (await listVerified(pool, ORG)).find((r) => r.id === before.id)!
    expect(after.baseline).toEqual(before.baseline)
    expect(after.tolerance).toBe(before.tolerance)
    expect(after.lastCheckResult).toBe('pass')
    expect(after).toMatchObject({ status: 'verified', verifiedBy: 'auto:strong', strength: 'strong' })
    // 反向确认打到了冲突路径（不是悄悄插了一条新候选）
    expect(await listVerified(pool, ORG, { status: 'candidate', metricId: 'lemeng:retail:net_sales' })).toHaveLength(0)
  })

  it('强信号可覆盖已验证基线，并清空针对旧基线的 last_check_result', async () => {
    const row = (await listVerified(pool, ORG)).find((r) => r.metricId === 'lemeng:retail:net_sales')!
    expect(row.lastCheckResult).toBe('pass')
    await upsertCandidate(pool, ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: baselineOf(150), tolerance: 0.002,
      source: 'auto', strength: 'strong', sessionId: 's4',
    })
    const after = (await listVerified(pool, ORG)).find((r) => r.id === row.id)!
    expect(after.baseline.summary.value!.sum).toBe(150)
    expect(after.tolerance).toBe(0.002)
    expect(after.lastCheckResult).toBeNull()
    expect(after).toMatchObject({ status: 'verified', strength: 'strong', verifiedBy: 'auto:strong' })
  })

  it('先弱后强：同一行升级为 verified / strength=strong，基线更新', async () => {
    const metricId = 'lemeng:retail:net_sales_q'
    await upsertCandidate(pool, ORG, {
      question: '上季度净销售额', metricId,
      params: {}, slicing: {}, baseline: baselineOf(100),
      source: 'auto', strength: 'weak',
    })
    let rows = await listVerified(pool, ORG, { status: 'candidate', metricId })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'candidate', strength: 'weak' })

    await upsertCandidate(pool, ORG, {
      question: '上季度净销售额', metricId,
      params: {}, slicing: {}, baseline: baselineOf(200),
      source: 'auto', strength: 'strong',
    })
    rows = await listVerified(pool, ORG, { metricId })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'verified', strength: 'strong', verifiedBy: 'auto:strong' })
    expect(rows[0]!.baseline.summary.value!.sum).toBe(200)
    // 升级是同一行（不是另插一条 verified、留下原 candidate）
    expect(await listVerified(pool, ORG, { status: 'candidate', metricId })).toHaveLength(0)
  })

  it('rejected 不被自动信号复活；人工 setStatus 可重开', async () => {
    const metricId = 'lemeng:retail:rejected'
    await upsertCandidate(pool, ORG, {
      question: '被否的问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(100),
      source: 'auto', strength: 'strong',
    })
    const row = (await listVerified(pool, ORG, { metricId }))[0]!
    await setStatus(pool, ORG, row.id, 'rejected', 'u-admin')

    await upsertCandidate(pool, ORG, {
      question: '被否的问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(999),
      source: 'auto', strength: 'strong',
    })
    const rejected = await listVerified(pool, ORG, { status: 'rejected', metricId })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.id).toBe(row.id)
    expect(await listVerified(pool, ORG, { metricId })).toHaveLength(0)

    // 只有人工路径能重开
    await setStatus(pool, ORG, row.id, 'verified', 'u-admin')
    expect((await listVerified(pool, ORG, { metricId })).map((r) => r.id)).toEqual([row.id])
  })

  it('slicing 不同 = 不同行（唯一键含 slicing，不能静默合行）', async () => {
    const metricId = 'lemeng:retail:sliced'
    await upsertCandidate(pool, ORG, {
      question: '按月销售额', metricId,
      params: {}, slicing: { branch: 'A' }, baseline: baselineOf(10),
      source: 'auto', strength: 'weak',
    })
    await upsertCandidate(pool, ORG, {
      question: '按月销售额', metricId,
      params: {}, slicing: { branch: 'B' }, baseline: baselineOf(20),
      source: 'auto', strength: 'weak',
    })
    const rows = await listVerified(pool, ORG, { status: 'candidate', metricId })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.slicing.branch).sort()).toEqual(['A', 'B'])
  })

  it('source 取最强：人工写入把 auto 候选升为 human', async () => {
    const metricId = 'lemeng:retail:human-source'
    await upsertCandidate(pool, ORG, {
      question: '人工来源问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(10),
      source: 'auto', strength: 'weak',
    })
    await upsertCandidate(pool, ORG, {
      question: '人工来源问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(11),
      source: 'human', strength: 'human',
    })
    const rows = await listVerified(pool, ORG, { status: 'candidate', metricId })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'human', strength: 'human', status: 'candidate' })
    expect(rows[0]!.baseline.summary.value!.sum).toBe(11)
  })

  it('setStatus 置 verified / rejected 都必须带操作人（否则抛错）', async () => {
    const row = (await listVerified(pool, ORG))[0]!
    await expect(setStatus(pool, ORG, row.id, 'verified')).rejects.toThrow(/确认人/)
    // 拒绝也是人工动作：没有操作人的 rejected 行 = 审计缺口（Task 2 补的守卫）
    await expect(setStatus(pool, ORG, row.id, 'rejected')).rejects.toThrow(/操作人/)
    await expect(setStatus(pool, ORG, row.id, 'rejected', '   ')).rejects.toThrow(/操作人/)
  })

  it('decided_by/decided_at 记录人工决策：拒绝不占用 verified_by；确认时两者都写', async () => {
    const metricId = 'lemeng:retail:decided'
    await upsertCandidate(pool, ORG, {
      question: '决策痕迹问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(1),
      source: 'auto', strength: 'weak',
    })
    const candidate = (await listVerified(pool, ORG, { status: 'candidate', metricId }))[0]!

    await setStatus(pool, ORG, candidate.id, 'rejected', 'u-rejecter')
    const rejected = (await listVerified(pool, ORG, { status: 'rejected', metricId }))[0]!
    // 从未 confirmed 的行：verified_by 保持 NULL，拒绝人由 decided_by 承载
    expect(rejected).toMatchObject({ decidedBy: 'u-rejecter', verifiedBy: null })
    expect(rejected.decidedAt).not.toBeNull()

    await setStatus(pool, ORG, candidate.id, 'verified', 'u-verifier')
    const verified = (await listVerified(pool, ORG, { metricId }))[0]!
    expect(verified).toMatchObject({ decidedBy: 'u-verifier', verifiedBy: 'u-verifier' })
    expect(verified.verifiedAt).not.toBeNull()
    expect(verified.decidedAt).not.toBeNull()
  })

  it('跨租户不串：别的 org 看不到本租户行，也改不动', async () => {
    await upsertCandidate(pool, OTHER_ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: BASELINE,
      source: 'auto', strength: 'weak',
    })
    // 弱信号 ⇒ candidate，默认列表（verified）看不到它 = 没串过来
    expect(await listVerified(pool, OTHER_ORG)).toHaveLength(0)
    expect(await listVerified(pool, OTHER_ORG, { status: 'candidate' })).toHaveLength(1)

    // 用别的 org 的 id 做写操作：where org 兜住 ⇒ 目标行不受影响
    const orgRow = (await listVerified(pool, ORG))[0]!
    await setStatus(pool, OTHER_ORG, orgRow.id, 'rejected', 'u-other')
    expect((await listVerified(pool, ORG)).some((r) => r.id === orgRow.id && r.status === 'verified')).toBe(true)
  })

  it('forceCandidate：强信号重放失败也只落 candidate，并返回行 id 供 recordCheck', async () => {
    const metricId = 'lemeng:retail:force-candidate'
    // 摄入侧重放失败的形状：基线只能是空哨兵（不猜数值），且不得冒充 verified。
    const id = await upsertCandidate(pool, ORG, {
      question: '强信号但重放失败', metricId,
      params: {}, slicing: {}, baseline: { columns: [], rowCount: 0, summary: {} },
      source: 'auto', strength: 'strong', forceCandidate: true,
    })
    expect(Number.isInteger(id)).toBe(true)
    const candidate = (await listVerified(pool, ORG, { status: 'candidate', metricId }))[0]!
    expect(candidate.id).toBe(id)
    expect(candidate).toMatchObject({ status: 'candidate', strength: 'strong', verifiedBy: null })

    // 之后重放成功（不带 forceCandidate）：同一唯一键升级为 verified，返回同一 id。
    const again = await upsertCandidate(pool, ORG, {
      question: '强信号但重放失败', metricId,
      params: {}, slicing: {}, baseline: BASELINE,
      source: 'auto', strength: 'strong',
    })
    expect(again).toBe(id)
    const verified = (await listVerified(pool, ORG)).find((r) => r.id === id)!
    expect(verified).toMatchObject({ status: 'verified', verifiedBy: 'auto:strong' })
  })

  it('preserveBaseline：重放失败不拿空哨兵覆盖已验证基线；tolerance 缺省不被重置', async () => {
    const metricId = 'lemeng:retail:preserve-baseline'
    const id = await upsertCandidate(pool, ORG, {
      question: '保留基线问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(100), tolerance: 0.005,
      source: 'auto', strength: 'strong',
    })
    const before = (await listVerified(pool, ORG)).find((r) => r.id === id)!

    // 重放失败：空哨兵 + forceCandidate + preserveBaseline（Task 5 的失败路径）
    await upsertCandidate(pool, ORG, {
      question: '保留基线问题', metricId,
      params: {}, slicing: {}, baseline: { columns: [], rowCount: 0, summary: {} },
      source: 'auto', strength: 'strong', forceCandidate: true, preserveBaseline: true,
    })
    const afterFail = (await listVerified(pool, ORG)).find((r) => r.id === id)!
    expect(afterFail.baseline).toEqual(before.baseline)
    expect(afterFail.slicing).toEqual(before.slicing)
    expect(afterFail.tolerance).toBe(0.005)
    expect(afterFail).toMatchObject({ status: 'verified', verifiedBy: 'auto:strong' })

    await recordCheck(pool, ORG, id, 'error')
    expect((await listVerified(pool, ORG)).find((r) => r.id === id)!.lastCheckResult).toBe('error')

    // 之后重放成功：新基线可覆盖，但**没给 tolerance** ⇒ 保留已有容差（Minor 9），
    // 且内容变化 ⇒ 旧的 error 清空。
    await upsertCandidate(pool, ORG, {
      question: '保留基线问题', metricId,
      params: {}, slicing: {}, baseline: baselineOf(200),
      source: 'auto', strength: 'strong',
    })
    const afterOk = (await listVerified(pool, ORG)).find((r) => r.id === id)!
    expect(afterOk.baseline.summary.value!.sum).toBe(200)
    expect(afterOk.tolerance).toBe(0.005)
    expect(afterOk.lastCheckResult).toBeNull()
  })

  it('recordCheck 落 last_checked_at / last_check_result，且按 org 收窄', async () => {
    const row = (await listVerified(pool, ORG))[0]!
    await recordCheck(pool, ORG, row.id, 'error')
    const after = (await listVerified(pool, ORG)).find((r) => r.id === row.id)!
    expect(after.lastCheckResult).toBe('error')
    expect(after.lastCheckedAt).not.toBeNull()
    // 别的 org 写同一个 id：不生效（不存在该 org 的行）
    await recordCheck(pool, OTHER_ORG, row.id, 'pass')
    const untouched = (await listVerified(pool, ORG)).find((r) => r.id === row.id)!
    expect(untouched.lastCheckResult).toBe('error')
  })
})
