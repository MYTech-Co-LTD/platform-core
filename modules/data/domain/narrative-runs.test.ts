// narrative-runs.test.ts — 叙事运行台账（R5）：回退率口径与聚合。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { narrativeStats, recordNarrativeRun } from './narrative-runs'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-narrative-runs'

describePg('narrativeStats（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  const run = (outcome: 'ok' | 'fallback' | 'cached' | 'error', promptVersion = 'v-test', durationMs = 100) =>
    recordNarrativeRun(pool, {
      org: ORG, reportId: 'r1', focus: 'daily_review', mode: 'range',
      model: 'm', promptVersion, outcome, durationMs,
    })

  it('回退率 = fallback/(ok+fallback)；cached/error 不进分母', async () => {
    await run('ok'); await run('ok'); await run('fallback'); await run('cached'); await run('error')
    const s = await narrativeStats(pool, ORG, 7)
    expect(s.total).toBe(5)
    expect(s.byOutcome).toEqual({ ok: 2, fallback: 1, cached: 1, error: 1 })
    expect(s.fallbackRate).toBeCloseTo(1 / 3, 5)
    expect(s.byPromptVersion[0]).toMatchObject({ promptVersion: 'v-test', total: 5, fallback: 1 })
    expect(s.byDay.length).toBeGreaterThan(0)
  })

  it('没有生成样本（只有 cached/error）⇒ fallbackRate=null，不画 0', async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    await run('cached'); await run('error')
    const s = await narrativeStats(pool, ORG, 7)
    expect(s.fallbackRate).toBeNull()
  })

  it('按租户隔离：别的 org 的行不计入', async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    await run('ok')
    await recordNarrativeRun(pool, {
      org: 'org-other', reportId: 'r1', focus: 'daily_review', mode: 'day',
      model: null, promptVersion: 'v-test', outcome: 'fallback',
    })
    const s = await narrativeStats(pool, ORG, 7)
    expect(s.total).toBe(1)
    expect(s.byOutcome.fallback).toBe(0)
    await pool.query('delete from data.narrative_runs where org = $1', ['org-other'])
  })
})
