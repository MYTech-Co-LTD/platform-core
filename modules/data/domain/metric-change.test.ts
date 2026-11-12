// metric-change.test.ts — 变更单状态机（P0）。隔离键与其它文件不同。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { submitChange, listChanges, withdrawChange } from './metric-change'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-metric-change'
const DECL = { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '我的销售' }

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（同 audit-store / asset-auth 约定）：重复跑本文件时旧单会累积，
  // 「重复提交 ⇒ 旧单 superseded 恰一条」的断言需要干净起点。只删本文件专属 ORG。
  await pool.query('delete from data.metric_change where org = $1', [ORG])
})
afterAll(async () => { await pool.end() })

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
