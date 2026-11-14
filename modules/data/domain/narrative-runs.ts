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
  /** 事实包构建耗时（R4 分项基线）；旧行/未测量 ⇒ null。 */
  factsMs?: number | null
}

/** best-effort：观测失败不反噬生成（只告警）。 */
export async function recordNarrativeRun(pool: Pool, row: NarrativeRunRow): Promise<void> {
  try {
    await pool.query(
      `insert into data.narrative_runs
         (org, report_id, focus, mode, model, prompt_version, outcome, reason, duration_ms, facts_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.org, row.reportId, row.focus, row.mode, row.model, row.promptVersion,
        row.outcome, row.reason ?? null, row.durationMs ?? null, row.factsMs ?? null],
    )
  } catch (e) {
    console.warn(`[data/narrative] run record failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 叙事质量的运维阈值（R5）。单一事实源在服务端：console 面板与将来的告警 job 读同一份，
 * 不在前端各写一套「多少算红」。
 *
 * 口径：fallback 率与越界率只对**真实生成样本**（ok+fallback）计；p95 是墙钟时长。
 */
export const NARRATIVE_SLO = {
  fallbackRate: 0.2,
  p95Ms: 45_000,
  numberCheckRate: 0.05,
} as const

export type NarrativeSloBreach = 'fallback_rate' | 'p95' | 'number_check'

export interface NarrativeStats {
  days: number
  total: number
  byOutcome: Record<NarrativeOutcome, number>
  /** 回退率 = fallback / (ok + fallback)；cached/error 不计入分母（它们不是「生成质量」样本）。 */
  fallbackRate: number | null
  /** 数字校验越界次数与比率（reason='number_check'）：模型引用了不存在/超范围的数。 */
  numberCheckCount: number
  numberCheckRate: number | null
  /** 缓存命中率 = cached / total（含 cached 在内的全部尝试）。 */
  cacheHitRate: number | null
  p95Ms: number | null
  /** 事实包构建耗时 p95（R4 分项基线；无样本 ⇒ null，不画 0）。 */
  factsP95Ms: number | null
  /** 当前窗口越过阈值的项（空数组 = 健康）；阈值见 `NARRATIVE_SLO`。 */
  breaches: NarrativeSloBreach[]
  slo: typeof NARRATIVE_SLO
  byPromptVersion: Array<{ promptVersion: string; total: number; fallback: number }>
  byDay: Array<{ day: string; total: number; fallback: number }>
}

/** 只读聚合；`days` 由调用方夹在 1..90。 */
export async function narrativeStats(pool: Pool, org: string, days: number): Promise<NarrativeStats> {
  const since = `now() - ($2::int * interval '1 day')`
  const main = await pool.query<{
    total: string; ok: string; fallback: string; cached: string; error: string
    number_check: string; p95: string | null; facts_p95: string | null
  }>(
    `select count(*)::text as total,
            count(*) filter (where outcome = 'ok')::text as ok,
            count(*) filter (where outcome = 'fallback')::text as fallback,
            count(*) filter (where outcome = 'cached')::text as cached,
            count(*) filter (where outcome = 'error')::text as error,
            count(*) filter (where reason = 'number_check')::text as number_check,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null)::text as p95,
            percentile_cont(0.95) within group (order by facts_ms)
              filter (where facts_ms is not null)::text as facts_p95
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

  const total = num(r?.total)
  const numberCheckCount = num(r?.number_check)
  const fallbackRate = generated === 0 ? null : byOutcome.fallback / generated
  const numberCheckRate = generated === 0 ? null : numberCheckCount / generated
  const cacheHitRate = total === 0 ? null : byOutcome.cached / total
  const p95Ms = r?.p95 === null || r?.p95 === undefined ? null : Number(r.p95)
  const factsP95Ms = r?.facts_p95 === null || r?.facts_p95 === undefined ? null : Number(r.facts_p95)
  const breaches: NarrativeSloBreach[] = []
  if (fallbackRate !== null && fallbackRate > NARRATIVE_SLO.fallbackRate) breaches.push('fallback_rate')
  if (p95Ms !== null && p95Ms > NARRATIVE_SLO.p95Ms) breaches.push('p95')
  if (numberCheckRate !== null && numberCheckRate > NARRATIVE_SLO.numberCheckRate) breaches.push('number_check')
  return {
    days,
    total,
    byOutcome,
    fallbackRate,
    numberCheckCount,
    numberCheckRate,
    cacheHitRate,
    p95Ms,
    factsP95Ms,
    breaches,
    slo: NARRATIVE_SLO,
    byPromptVersion: versions.rows.map((x) => ({
      promptVersion: x.prompt_version, total: num(x.total), fallback: num(x.fallback),
    })),
    byDay: daily.rows.map((x) => ({ day: x.day, total: num(x.total), fallback: num(x.fallback) })),
  }
}
