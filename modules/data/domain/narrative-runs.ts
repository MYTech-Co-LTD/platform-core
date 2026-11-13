// narrative-runs.ts — 叙事生成运行台账（R5）：回退率/越界率/时长可观测。
//
// 与 `report-narrative-store.ts` 的分工：那边存**结果**（可复用的文本）；这边存**尝试**
// （每次生成一行）。为什么必须分开：模型可用时回退模板**不缓存**，结果表里看不到回退；
// 而「回退率」正是质量回路的核心指标。
import type { Pool } from 'pg'

export type NarrativeOutcome = 'ok' | 'fallback' | 'cached' | 'error'

export interface NarrativeRunRow {
  org: string
  reportId: string
  focus: string
  mode: 'day' | 'range'
  model: string | null
  promptVersion: string
  outcome: NarrativeOutcome
  reason?: string | null
  durationMs?: number | null
}

/** best-effort：观测失败不反噬生成（只告警）。 */
export async function recordNarrativeRun(pool: Pool, row: NarrativeRunRow): Promise<void> {
  try {
    await pool.query(
      `insert into data.narrative_runs
         (org, report_id, focus, mode, model, prompt_version, outcome, reason, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.org, row.reportId, row.focus, row.mode, row.model, row.promptVersion,
        row.outcome, row.reason ?? null, row.durationMs ?? null],
    )
  } catch (e) {
    console.warn(`[data/narrative] run record failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface NarrativeStats {
  days: number
  total: number
  byOutcome: Record<NarrativeOutcome, number>
  /** 回退率 = fallback / (ok + fallback)；cached/error 不计入分母（它们不是「生成质量」样本）。 */
  fallbackRate: number | null
  p95Ms: number | null
  byPromptVersion: Array<{ promptVersion: string; total: number; fallback: number }>
  byDay: Array<{ day: string; total: number; fallback: number }>
}

/** 只读聚合；`days` 由调用方夹在 1..90。 */
export async function narrativeStats(pool: Pool, org: string, days: number): Promise<NarrativeStats> {
  const since = `now() - ($2::int * interval '1 day')`
  const main = await pool.query<{
    total: string; ok: string; fallback: string; cached: string; error: string; p95: string | null
  }>(
    `select count(*)::text as total,
            count(*) filter (where outcome = 'ok')::text as ok,
            count(*) filter (where outcome = 'fallback')::text as fallback,
            count(*) filter (where outcome = 'cached')::text as cached,
            count(*) filter (where outcome = 'error')::text as error,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null)::text as p95
       from data.narrative_runs
      where org = $1 and created_at >= ${since}`,
    [org, days],
  )
  const r = main.rows[0]
  const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v))
  const byOutcome: Record<NarrativeOutcome, number> = {
    ok: num(r?.ok), fallback: num(r?.fallback), cached: num(r?.cached), error: num(r?.error),
  }
  const generated = byOutcome.ok + byOutcome.fallback

  const versions = await pool.query<{ prompt_version: string; total: string; fallback: string }>(
    `select prompt_version,
            count(*)::text as total,
            count(*) filter (where outcome = 'fallback')::text as fallback
       from data.narrative_runs
      where org = $1 and created_at >= ${since}
      group by prompt_version
      order by count(*) desc`,
    [org, days],
  )
  const daily = await pool.query<{ day: string; total: string; fallback: string }>(
    `select to_char((created_at at time zone 'Asia/Shanghai')::date, 'YYYY-MM-DD') as day,
            count(*)::text as total,
            count(*) filter (where outcome = 'fallback')::text as fallback
       from data.narrative_runs
      where org = $1 and created_at >= ${since}
      group by 1
      order by 1`,
    [org, days],
  )

  return {
    days,
    total: num(r?.total),
    byOutcome,
    fallbackRate: generated === 0 ? null : byOutcome.fallback / generated,
    p95Ms: r?.p95 === null || r?.p95 === undefined ? null : Number(r.p95),
    byPromptVersion: versions.rows.map((x) => ({
      promptVersion: x.prompt_version, total: num(x.total), fallback: num(x.fallback),
    })),
    byDay: daily.rows.map((x) => ({ day: x.day, total: num(x.total), fallback: num(x.fallback) })),
  }
}
