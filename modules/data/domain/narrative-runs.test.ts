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

  it('★ 越界率/缓存命中率/阈值越线（R5 观测面）', async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    await run('ok')
    await run('fallback')
    await run('cached')
    await recordNarrativeRun(pool, {
      org: ORG, reportId: 'r1', focus: 'daily_review', mode: 'range',
      model: 'm', promptVersion: 'v-test', outcome: 'fallback', reason: 'number_check', durationMs: 100,
    })
    const s = await narrativeStats(pool, ORG, 7)
    expect(s.numberCheckCount).toBe(1)
    // 生成样本 = ok + fallback（3 条：ok/fallback/number_check）
    expect(s.numberCheckRate).toBeCloseTo(1 / 3, 5)
    expect(s.cacheHitRate).toBeCloseTo(1 / 4, 5)
    expect(s.breaches).toContain('number_check')
    expect(s.breaches).toContain('fallback_rate')   // 2/3 > 0.2
    expect(s.slo).toEqual({ fallbackRate: 0.2, p95Ms: 45_000, numberCheckRate: 0.05 })
  })

  it('★ facts p95 分项：有 samples 才给数；旧行（无分项）⇒ null 而不是 0', async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    const withFacts = (factsMs: number) => recordNarrativeRun(pool, {
      org: ORG, reportId: 'r1', focus: 'daily_review', mode: 'range',
      model: 'm', promptVersion: 'v-test', outcome: 'ok', durationMs: 1000, factsMs,
    })
    await withFacts(300)
    await withFacts(500)
    const withSamples = await narrativeStats(pool, ORG, 7)
    expect(withSamples.factsP95Ms).toBeGreaterThanOrEqual(300)

    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    await run('ok')   // 不带 factsMs 的旧形态
    expect((await narrativeStats(pool, ORG, 7)).factsP95Ms).toBeNull()
  })

  it('健康窗口 ⇒ breaches 为空（不误报）', async () => {
    await pool.query('delete from data.narrative_runs where org = $1', [ORG])
    await run('ok', 'v-test', 1000)
    await run('ok', 'v-test', 1000)
    const s = await narrativeStats(pool, ORG, 7)
    expect(s.breaches).toEqual([])
    expect(s.numberCheckRate).toBe(0)
    expect(s.cacheHitRate).toBe(0)
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
