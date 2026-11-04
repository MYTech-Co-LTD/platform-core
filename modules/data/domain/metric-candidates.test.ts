// metric-candidates.test.ts — W2 候选池的存储层（032 三档闭环 Task 1，迁移 034 的 data.metric_candidates）。
//
// 只钉域层（表形状 / upsert 幂等 / 决策不被自动信号复活 / 租户隔离）；候选生成规则归 Task 5。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  listCandidates,
  setCandidateStatus,
  upsertCandidate,
} from './metric-candidates'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键：各测试文件互不相同的 org（同 metric-store.test.ts 约定）。 */
const ORG = 'org-t1-candidates'
const OTHER_ORG = 'org-t1-candidates-OTHER'

/** 候选的典型形状：关系 + 单列聚合 + 可选维度。 */
const input = (over: Partial<Parameters<typeof upsertCandidate>[2]> = {}) => ({
  relation: 'fct_retail_sale',
  expr: { agg: 'sum', column: 'net_amount', dims: ['bizday'] },
  evidence: { nonNullRatio: 0.98, distinctCount: 812 },
  rationale: '金额列，覆盖率 98%',
  confidence: 0.8,
  origin: 'profile' as const,
  ...over,
})

describePg('metric-candidates（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('upsertCandidate 插入：expr/dims/evidence/confidence/origin 往返一致，初始 status=pending', async () => {
    const c = await upsertCandidate(pool, ORG, input())
    expect(c).toMatchObject({
      org: ORG,
      relation: 'fct_retail_sale',
      expr: { agg: 'sum', column: 'net_amount', dims: ['bizday'] },
      dims: ['bizday'],
      evidence: { nonNullRatio: 0.98, distinctCount: 812 },
      rationale: '金额列，覆盖率 98%',
      confidence: 0.8,
      origin: 'profile',
      status: 'pending',
    })
    expect(Number.isInteger(c.id), 'id 必须是可用的整数（bigserial）').toBe(true)
    expect(typeof c.createdAt, 'createdAt 是 ISO 字符串（不透传 Date）').toBe('string')
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt)
  })

  it('upsertCandidate 幂等：同 (org, relation, expr) 两次 → 一行，刷新证据/理由/置信度，不动 id/createdAt/status', async () => {
    const first = await upsertCandidate(pool, ORG, input({ relation: 'fct_order', rationale: '第一版', confidence: 0.5 }))
    const second = await upsertCandidate(pool, ORG, input({
      relation: 'fct_order',
      expr: { agg: 'sum', column: 'net_amount', dims: ['bizday'] },
      rationale: '第二版',
      confidence: 0.9,
      evidence: { distinctCount: 999 },
    }))

    expect(second.id, '幂等键没命中 ⇒ 重复候选池').toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second).toMatchObject({ rationale: '第二版', confidence: 0.9, evidence: { distinctCount: 999 }, status: 'pending' })

    const n = await pool.query(
      'select count(*)::int as n from data.metric_candidates where org = $1 and relation = $2',
      [ORG, 'fct_order'],
    )
    expect(n.rows[0]!.n).toBe(1)
  })

  it('★ 幂等键按 jsonb 规范形：key 顺序不同、dims 省缺与 [] 都命中同一行', async () => {
    const a = await upsertCandidate(pool, ORG, input({
      relation: 'fct_canon',
      expr: { agg: 'count', column: 'order_id', dims: [] },
    }))
    // key 顺序打乱 + dims 省缺（存储层归一成 dims: []）
    const b = await upsertCandidate(pool, ORG, input({
      relation: 'fct_canon',
      expr: { dims: undefined, column: 'order_id', agg: 'count' } as unknown as { agg: string; column: string; dims?: string[] },
    }))
    expect(b.id).toBe(a.id)
    expect(b.expr).toEqual({ agg: 'count', column: 'order_id', dims: [] })
    expect(b.dims).toEqual([])
  })

  it('★ 人工决策不被自动信号复活：rejected 后重新 upsert 仍 rejected（内容可刷新）', async () => {
    const c = await upsertCandidate(pool, ORG, input({ relation: 'fct_rejected', confidence: 0.3 }))
    expect(await setCandidateStatus(pool, ORG, c.id, 'rejected')).toBe(true)

    const again = await upsertCandidate(pool, ORG, input({ relation: 'fct_rejected', confidence: 0.95 }))
    expect(again.id).toBe(c.id)
    expect(again.status, '重新 profiling 把人工拒绝的行复活了').toBe('rejected')
    expect(again.confidence).toBe(0.95)
  })

  it('★ origin 只由首次插入确定（profile 先到，后续 demand 不改标注）', async () => {
    const a = await upsertCandidate(pool, ORG, input({ relation: 'fct_origin', origin: 'profile' }))
    const b = await upsertCandidate(pool, ORG, input({ relation: 'fct_origin', origin: 'demand' }))
    expect(b.id).toBe(a.id)
    expect(b.origin).toBe('profile')
  })

  it('listCandidates 只回本 org，支持 status / origin / relation 过滤，按 confidence 降序', async () => {
    await upsertCandidate(pool, OTHER_ORG, input({ relation: 'other_only' }))
    await upsertCandidate(pool, ORG, input({
      relation: 'fct_list',
      expr: { agg: 'avg', column: 'net_amount', dims: [] },
      confidence: 0.4,
      origin: 'demand',
    }))
    await upsertCandidate(pool, ORG, input({
      relation: 'fct_list',
      expr: { agg: 'max', column: 'net_amount', dims: [] },
      confidence: 0.7,
      origin: 'profile',
    }))
    await upsertCandidate(pool, ORG, input({
      relation: 'fct_list',
      expr: { agg: 'min', column: 'net_amount', dims: [] },
      confidence: 0.55,
      origin: 'profile',
    }))

    const all = await listCandidates(pool, ORG, { relation: 'fct_list' })
    expect(all.map((c) => c.expr.agg), '不是 confidence 降序').toEqual(['max', 'min', 'avg'])
    expect(all.map((c) => c.org).every((o) => o === ORG), '别家租户的候选漏进来了').toBe(true)
    expect(all.map((c) => c.relation)).not.toContain('other_only')

    expect((await listCandidates(pool, ORG, { relation: 'fct_list', origin: 'demand' })).map((c) => c.expr.agg))
      .toEqual(['avg'])
    expect((await listCandidates(pool, ORG, { relation: 'fct_list', status: 'pending' })).length).toBe(3)
    expect((await listCandidates(pool, ORG, { relation: 'fct_list', status: 'rejected' })).length).toBe(0)
  })

  it('setCandidateStatus 带 org：本 org 改得到，别家 org / 不存在的 id 都返回 false 且不动目标行', async () => {
    const mine = await upsertCandidate(pool, ORG, input({ relation: 'fct_status' }))
    expect(await setCandidateStatus(pool, OTHER_ORG, mine.id, 'promoted')).toBe(false)
    expect(await setCandidateStatus(pool, ORG, 999999999, 'promoted')).toBe(false)

    const untouched = (await listCandidates(pool, ORG, { relation: 'fct_status' }))[0]!
    expect(untouched.status, '别家 org 的调用改到了本租户的行').toBe('pending')

    expect(await setCandidateStatus(pool, ORG, mine.id, 'promoted')).toBe(true)
    expect((await listCandidates(pool, ORG, { relation: 'fct_status' }))[0]!.status).toBe('promoted')
  })
})

// ── 034 迁移（W2）：候选表形状。单独一个 describe：验的是 schema，不是 store 行为。──
describePg('034 迁移：data.metric_candidates（W2）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end().catch(() => {}) })

  it('★ 表/唯一索引就位，且迁移幂等（连跑两遍零效果）', async () => {
    await applyMigrations(pool)
    await applyMigrations(pool) // 第二遍：必须零效果、不报错（部署脚本每次全量重跑）

    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'data' and table_name = 'metric_candidates'
        order by ordinal_position`,
    )
    expect(cols.rows.map((r) => `${r.column_name}:${r.is_nullable}`)).toEqual([
      'id:NO', 'org:NO', 'relation:NO', 'expr:NO', 'evidence:NO', 'rationale:NO',
      'confidence:NO', 'origin:NO', 'status:NO', 'created_at:NO', 'updated_at:NO',
    ])

    const idx = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'data' and tablename = 'metric_candidates'
          and indexname = 'metric_candidates_org_rel_expr_idx'`,
    )
    expect(idx.rowCount, '唯一索引没建成 ⇒ upsertCandidate 的 on conflict 会报错').toBe(1)
    expect(idx.rows[0]!.indexdef.toLowerCase()).toContain('unique')
    expect(idx.rows[0]!.indexdef).toContain('md5')
  })
})
