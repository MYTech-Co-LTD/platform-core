// verified-baseline-refresh.ts —— W6 Task 4：刷新回归基线（带操作人、时间与原因）。
//
// 为什么要它：基线是「某时点重放出来的数值快照」。数据回填/退货冲减之后老基线与当前值必然
// 分叉，回归会红——**那是基线过期，不是口径错**（真机 #3：230.5 万 → 174.0 万）。
// 没有这条路，只能靠人手工 update，审计上查不出「谁刷的、为什么」。
//
// 纪律：
//   · 操作人（`by`）与原因（`reason`）**必填**——刷新是有主体的写操作；
//   · 只刷 `status='verified'` 的行（candidate / rejected 不该有基线可言）；
//   · 刷新后清 `last_check_result`（旧结果是对旧基线的成绩，不能当新基线的成绩）；
//   · 返回 before/after 与相对漂移，调用方自己决定要不要打印/告警。
import type { Pool } from 'pg'
import type { Baseline } from './verified-questions'

export interface RefreshOutcome {
  ok: boolean
  id: number
  before: Baseline | null
  after: Baseline | null
  /** 主数值的相对漂移（|after-before| / max(|before|,1e-9)）；无法比较 = null */
  driftPct: number | null
  reason?: 'not_found' | 'not_verified' | 'compute_failed' | 'bad_input'
}

/** `sum(value)` 的主数值（逐列摘要里挑 value 列；没有就取第一列的 sum）。 */
export function primaryValueOf(baseline: Baseline | null): number | null {
  if (baseline === null) return null
  const value = baseline.summary?.value
  if (value !== undefined && Number.isFinite(value.sum)) return value.sum
  const first = Object.values(baseline.summary ?? {})[0]
  return first !== undefined && Number.isFinite(first.sum) ? first.sum : null
}

export function driftPctOf(before: Baseline | null, after: Baseline | null): number | null {
  const b = primaryValueOf(before)
  const a = primaryValueOf(after)
  if (b === null || a === null) return null
  return Math.round((Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)) * 1e6) / 1e6
}

export interface RefreshDeps {
  /** 重放该行并产出新基线；抛错 = 本次刷新失败（不写库）。 */
  compute: (row: { id: number; metricId: string; params: unknown; slicing: unknown }) => Promise<Baseline>
  /**
   * `false` = 只计算不落库（CLI 的 dry-run）。缺省 `true`。
   *
   * 为什么放在 domain 而不是只在 CLI 里绕过：守卫（not_found / not_verified /
   * compute_failed）与漂移计算必须**两种模式同源**——CLI 自己再实现一遍就会漂。
   * 2026-11-07 实测：CLI 号称 dry-run，但 `refreshBaseline` 恒写库 ⇒ dry-run 也改了生产基线。
   */
  write?: boolean
  now?: () => Date
}

/**
 * 刷新单条基线。返回结果里 `ok=false` 时**没有写库**。
 */
export async function refreshBaseline(
  pool: Pool,
  org: string,
  id: number,
  opts: { by: string; reason: string },
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const by = opts.by.trim()
  const reason = opts.reason.trim()
  if (by === '' || reason === '') {
    return { ok: false, id, before: null, after: null, driftPct: null, reason: 'bad_input' }
  }
  const { rows } = await pool.query(
    `select id, metric_id, params, slicing, baseline, status
       from data.verified_questions
      where org = $1 and id = $2`,
    [org, id],
  )
  const row = rows[0] as { id: number; metric_id: string; params: unknown; slicing: unknown; baseline: Baseline | null; status: string } | undefined
  if (row === undefined) return { ok: false, id, before: null, after: null, driftPct: null, reason: 'not_found' }
  if (row.status !== 'verified') {
    return { ok: false, id, before: row.baseline, after: null, driftPct: null, reason: 'not_verified' }
  }

  let after: Baseline
  try {
    after = await deps.compute({
      id: row.id,
      metricId: row.metric_id,
      params: row.params,
      slicing: row.slicing,
    })
  } catch {
    return { ok: false, id, before: row.baseline, after: null, driftPct: null, reason: 'compute_failed' }
  }

  const at = (deps.now ?? (() => new Date()))().toISOString()
  if (deps.write !== false) {
    await pool.query(
      `update data.verified_questions
          set baseline = $3::jsonb,
              baseline_refreshed_by = $4,
              baseline_refreshed_at = $5,
              baseline_refresh_reason = $6,
              last_check_result = null,
              last_checked_at = null,
              updated_at = now()
        where org = $1 and id = $2`,
      [org, id, JSON.stringify(after), by, at, reason],
    )
  }
  return {
    ok: true,
    id,
    before: row.baseline,
    after,
    driftPct: driftPctOf(row.baseline, after),
  }
}
