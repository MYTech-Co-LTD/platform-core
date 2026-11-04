// verified-questions.test.ts — W1 可信度地基：已验证问答（回归集）的存储层。
//
// 只钉域层（表形状 / upsert 幂等 / 状态机 / 租户隔离）；路由形状归 Task 2、回归比较归 Task 3。
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
    const weak = rows.find((r) => r.metricId === 'lemeng:retail:sales')!
    // 已被人工确认 ⇒ 人工身份覆盖自动档
    expect(weak).toMatchObject({ status: 'verified', verifiedBy: 'u-admin' })
  })

  it('重复投递幂等：同 question+params 只一行，baseline/tolerance 更新', async () => {
    await upsertCandidate(pool, ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: BASELINE,
      tolerance: 0.005,
      source: 'auto', strength: 'weak', sessionId: 's3',
    })
    const rows = (await listVerified(pool, ORG)).filter((r) => r.metricId === 'lemeng:retail:net_sales')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tolerance).toBe(0.005)
    // 已 verified ⇒ 弱信号不降级，verified_by 不被自动值覆盖
    expect(rows[0]).toMatchObject({ status: 'verified', verifiedBy: 'auto:strong' })
  })

  it('跨租户不串：别的 org 看不到本租户行，也改不动', async () => {
    await upsertCandidate(pool, OTHER_ORG, {
      question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
      params: {}, slicing: {}, baseline: BASELINE,
      source: 'auto', strength: 'weak',
    })
    const mine = await listVerified(pool, ORG)
    expect(mine).toHaveLength(2)
    // 别的 org：弱信号 ⇒ candidate，默认列表（verified）看不到它 = 没串过来
    expect(await listVerified(pool, OTHER_ORG)).toHaveLength(0)
    expect(await listVerified(pool, OTHER_ORG, { status: 'candidate' })).toHaveLength(1)
    // 用别的 org 的 id 做写操作：where org 兜住 ⇒ 目标行不受影响
    await setStatus(pool, OTHER_ORG, mine[0]!.id, 'rejected', 'u-other')
    expect((await listVerified(pool, ORG)).find((r) => r.id === mine[0]!.id)!.status).not.toBe('rejected')
  })

  it('recordCheck 落 last_checked_at / last_check_result，且按 org 收窄', async () => {
    const [row] = await listVerified(pool, ORG, { status: 'verified' })
    await recordCheck(pool, ORG, row!.id, 'fail')
    const after = (await listVerified(pool, ORG)).find((r) => r.id === row!.id)!
    expect(after.lastCheckResult).toBe('fail')
    expect(after.lastCheckedAt).not.toBeNull()
    // 别的 org 写同一个 id：不生效（不存在该 org 的行）
    await recordCheck(pool, OTHER_ORG, row!.id, 'pass')
    const untouched = (await listVerified(pool, ORG)).find((r) => r.id === row!.id)!
    expect(untouched.lastCheckResult).toBe('fail')
  })
})
