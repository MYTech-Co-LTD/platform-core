// metric-change.test.ts — 变更单状态机 + 采纳/驳回（P0）。隔离键与其它文件不同。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { submitChange, listChanges, getChange, withdrawChange, adoptChange, rejectChange } from './metric-change'
import { upsertL1Metric } from './metric-store'
import type { MetricWriteDeps } from './metric-write'
import type { Requester } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-metric-change'
const DECL = { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '我的销售' }
// 采纳用例的 L1 夹具：文件专属 id（不与真实物化 L1 撞名，upsertL1Metric 固定写平台桶），
// sourceSystem='lemeng' 与 writeDeps.adoptedSources 对齐（源接入闸）。
const L1_ID = 'b:p0mc_adopt_sales'
const L1_FIXTURE = {
  id: L1_ID,
  title: '销售(采纳夹具)',
  description: 'metric-change 测试夹具',
  requiredScope: null,
  subjectColumn: 'org',
  // 形状契约（parseL1Select）：`select <表达式> as value[, <维度>…] from <关系>`——不带 FROM 别名。
  selectSql: 'select sum(t.amt) as value, org, bizday from marts.f',
  groupBy: 'org, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}
const DECL_ADOPT = { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '我的销售' }

/** 身份夹具（同 metric-write.test.ts 形状）：pat 通道带 keyId，审计身份三件套非空。 */
const REQ: Requester = {
  userId: 'reviewer', orgId: ORG, channel: 'pat', keyId: 3, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
}
const writeDeps = (p: Pool): MetricWriteDeps => ({ pool: p, adoptedSources: new Set(['lemeng']), requester: REQ })

/** 把单据直接推到 preview_ready（跳过试算执行：采纳链路只关心状态与快照在位）。 */
async function markReady(id: number, preview: Record<string, unknown> = { rows: 1 }): Promise<void> {
  await pool.query(`update data.metric_change set status = 'preview_ready', preview = $2::jsonb where id = $1`,
    [id, JSON.stringify(preview)])
}

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（同 audit-store / asset-auth 约定）：重复跑本文件时旧单会累积，
  // 「重复提交 ⇒ 旧单 superseded 恰一条」的断言需要干净起点。只删本文件专属 ORG。
  await pool.query('delete from data.metric_change where org = $1', [ORG])
  await pool.query('delete from data.metrics where org = $1', [ORG])
})
afterAll(async () => {
  // 平台桶只回收本文件的夹具行（精确 id；不碰真实物化 L1）。
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID])
  await pool.end()
})

describePg('submitChange', () => {
  it('create 档：合法声明落单（draft），重复提交把旧单 superseded', async () => {
    const r1 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', DECL)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.change.status).toBe('draft')

    const r2 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', { ...DECL, alias: '改' })
    expect(r2.ok).toBe(true)
    const all = await listChanges(pool, ORG)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'superseded')).toHaveLength(1)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'draft')).toHaveLength(1)
  })

  it('自由 SQL 字段 ⇒ INVALID_DECLARATION（结构化声明纪律）', async () => {
    const r = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:bad', 'create',
      { baseMetric: 'b:sales', op: { kind: 'refine' }, selectSql: 'select 1' })
    expect(r).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
  })

  it('meta 档：三字段字符串；非法类型 ⇒ INVALID_META', async () => {
    const ok = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_ok', 'meta',
      { bizDescription: '不含税', unit: '元', caliberNote: '' })
    expect(ok.ok).toBe(true)
    const bad = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_bad', 'meta',
      { bizDescription: 123 })
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_META' })
  })

  it('withdraw 只允许提交者本人', async () => {
    const r = await submitChange(pool, ORG, { userId: 'u1', channel: 'pat' }, 'x:w', 'create', DECL)
    if (!r.ok) throw new Error('unreachable')
    expect(await withdrawChange(pool, ORG, r.change.id, '别人')).toBe(false)
    expect(await withdrawChange(pool, ORG, r.change.id, 'u1')).toBe(true)
  })
})

describePg('adoptChange / rejectChange', () => {
  it('未试算（draft）⇒ 409 PREVIEW_UNAVAILABLE；不生效任何东西', async () => {
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:no_preview', 'create', DECL)
    if (!s.ok) throw new Error('unreachable')
    const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
    expect(out).toMatchObject({ ok: false, error: 'PREVIEW_UNAVAILABLE' })
    // 未生效：data.metrics 里不得出现该指标
    const live = await pool.query(`select id from data.metrics where org = $1 and id = 'x:no_preview'`, [ORG])
    expect(live.rows).toHaveLength(0)
  })

  it('preview_ready ⇒ 采纳走唯一编译点：data.metrics 出现行，单据 adopted 且带快照', async () => {
    await upsertL1Metric(pool, L1_FIXTURE)
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'create', DECL_ADOPT)
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
    expect(out.ok).toBe(true)
    const live = await pool.query(`select id, title from data.metrics where org = $1 and id = $2`, [ORG, 'x:adopt_me'])
    expect(live.rows[0]?.title).toBe('我的销售')
    const after = await getChange(pool, ORG, s.change.id)
    expect(after?.status).toBe('adopted')
    expect(after?.decidedBy).toBe('reviewer')
    expect(after?.decidedAt).not.toBeNull()
    expect(after?.preview).toMatchObject({ rows: 1 })
  })

  it('重复采纳 ⇒ 409 CHANGE_STATE_CHANGED（CAS：已决单不再吃第二次采纳）', async () => {
    const adopted = (await listChanges(pool, ORG, 'adopted')).find((c) => c.metricId === 'x:adopt_me')
    if (adopted === undefined) throw new Error('前置缺失')
    const again = await adoptChange(writeDeps(pool), ORG, adopted.id)
    expect(again).toMatchObject({ ok: false, error: 'CHANGE_STATE_CHANGED' })
  })

  it('meta 档采纳：只动声明了的字段（缺席键不得清空既有值）', async () => {
    // 第一张：两字段都写 → 生效
    const s1 = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'meta',
      { bizDescription: '含税口径', unit: '元' })
    if (!s1.ok) throw new Error('unreachable')
    await markReady(s1.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, s1.change.id)).ok).toBe(true)
    const row1 = await pool.query(
      `select biz_description, unit, caliber_note from data.metrics where org = $1 and id = 'x:adopt_me'`, [ORG])
    expect(row1.rows[0]?.biz_description).toBe('含税口径')
    expect(row1.rows[0]?.unit).toBe('元')
    // 第二张：只声明 unit → bizDescription 缺席键必须保持原值（updateMetricMeta 语义：缺席=不改）
    const s2 = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'meta', { unit: '万元' })
    if (!s2.ok) throw new Error('unreachable')
    await markReady(s2.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, s2.change.id)).ok).toBe(true)
    const row2 = await pool.query(
      `select biz_description, unit from data.metrics where org = $1 and id = 'x:adopt_me'`, [ORG])
    expect(row2.rows[0]?.biz_description).toBe('含税口径')
    expect(row2.rows[0]?.unit).toBe('万元')
  })

  it('delete 档采纳：唯一编译点删除 L2 行，单据 adopted 留凭据', async () => {
    const mk = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:del_me', 'create', DECL_ADOPT)
    if (!mk.ok) throw new Error('unreachable')
    await markReady(mk.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, mk.change.id)).ok).toBe(true)
    const del = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:del_me', 'delete', {})
    if (!del.ok) throw new Error('unreachable')
    await markReady(del.change.id)
    const out = await adoptChange(writeDeps(pool), ORG, del.change.id)
    expect(out.ok).toBe(true)
    const live = await pool.query(`select id from data.metrics where org = $1 and id = 'x:del_me'`, [ORG])
    expect(live.rows).toHaveLength(0)
    expect((await getChange(pool, ORG, del.change.id))?.status).toBe('adopted')
  })

  it('驳回必填原因；驳回后单据 rejected 且原因可读', async () => {
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rej', 'create', DECL)
    if (!s.ok) throw new Error('unreachable')
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '')).toBe(false)
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '差 12%，疑似含退货')).toBe(true)
    const after = await getChange(pool, ORG, s.change.id)
    expect(after?.status).toBe('rejected')
    expect(after?.rejectReason).toBe('差 12%，疑似含退货')
    expect(after?.decidedBy).toBe('reviewer')
    // 已决单不可再驳回（状态机单向）
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '再驳一次')).toBe(false)
  })
})
