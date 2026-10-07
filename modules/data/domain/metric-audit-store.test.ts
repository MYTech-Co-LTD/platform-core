// metric-audit-store.test.ts — 口径变更审计的 store 行为（#489）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { listMetricAudit, writeMetricAudit } from './metric-audit-store'
import type { MetricRowSnapshot } from './metric-audit-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-ma-store'
const OTHER = 'org-ma-store-other'

/** 快照夹具：只有 title 变化，用来区分「从什么」到「什么」。 */
const snap = (title: string): MetricRowSnapshot => ({
  title, description: 'L2 派生自 l1x', subjectColumn: 'org',
  selectSql: 'select sum(t.value) as value, bizday from (select 1) t', groupBy: 'bizday', params: {},
})

describePg('口径变更审计 store（#489）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => { await applyMigrations(pool) })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = any($1::text[])', [[ORG, OTHER]]).catch(() => {})
    await pool.end()
  })

  it('★ 建/改/删三态的前后列填充（create: before=null；delete: after=null）', async () => {
    const base = { org: ORG, metricId: 'm1', keyId: 7 as number | null }
    await writeMetricAudit(pool, { ...base, action: 'create', userId: 'ZhangDuo', channel: 'pat', before: null, after: snap('建时') })
    await writeMetricAudit(pool, { ...base, action: 'update', userId: 'ZhangDuo', channel: 'pat', before: snap('建时'), after: snap('改后') })
    await writeMetricAudit(pool, { ...base, action: 'delete', userId: 'LiLei', channel: 'session', keyId: null, before: snap('改后'), after: null })

    const rows = await listMetricAudit(pool, ORG, 'm1')
    expect(rows.map((r) => r.action)).toEqual(['delete', 'update', 'create'])   // 时间倒序
    const by = Object.fromEntries(rows.map((r) => [r.action, r]))
    expect(by.create!.before).toBeNull()          // 建：没有前态
    expect(by.create!.after!.title).toBe('建时')
    expect(by.update!.before!.title).toBe('建时')  // ★「从什么」
    expect(by.update!.after!.title).toBe('改后')   // ★「到什么」
    expect(by.delete!.before!.title).toBe('改后')  // ★ 删除留证（被删时是什么）
    expect(by.delete!.after).toBeNull()
    expect(by.delete!.userId).toBe('LiLei')       // 记的是**人**
    expect(by.delete!.channel).toBe('session')
    expect(by.update!.keyId).toBe(7)              // pat 通道带 key_id
  })

  it('时间倒序：同一条口径的先后两次写，新的在前（created_at 同级时按 id 兜底）', async () => {
    await writeMetricAudit(pool, { org: ORG, metricId: 'm2', action: 'create', userId: 'a', channel: 'session', keyId: null, before: null, after: snap('一') })
    await writeMetricAudit(pool, { org: ORG, metricId: 'm2', action: 'update', userId: 'b', channel: 'session', keyId: null, before: snap('一'), after: snap('二') })
    const rows = await listMetricAudit(pool, ORG, 'm2')
    expect(rows[0]!.after!.title).toBe('二')
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id)
  })

  it('按 org 隔离：别家 org 的同 id 历史看不到', async () => {
    await writeMetricAudit(pool, { org: OTHER, metricId: 'm1', action: 'create', userId: 'x', channel: 'session', keyId: null, before: null, after: snap('别家') })
    const mine = await listMetricAudit(pool, ORG, 'm1')
    expect(mine.every((r) => r.org === ORG)).toBe(true)
    expect(mine.some((r) => r.after?.title === '别家')).toBe(false)
  })

  it('limit 生效（页面只取最近若干条）', async () => {
    const rows = await listMetricAudit(pool, ORG, 'm1', 1)
    expect(rows.length).toBe(1)
    expect(rows[0]!.action).toBe('delete')   // 最近一条
  })
})
