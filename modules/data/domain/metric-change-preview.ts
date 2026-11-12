// metric-change-preview.ts —— 试算：编译（不生效）→ 只读求值 → 快照（spec §6）。
// 纯度约束：execute 由调用方注入（生产=只读池；测试=假执行器）。本文件永不写 data.metrics。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { compileL2, resolveL1Base } from './semantic-compiler'
import { loadMergedCatalog } from './metric-store'
import { PENDING_STATUSES } from './metric-change'
import type { MetricChangeRow } from './metric-change'

export const PREVIEW_TIMEOUT_MS = 10_000

export interface PreviewSnapshot {
  window: { from: string; to: string } | null
  value: number | null
  rows: number
  baseline: { id: string; value: number | null; deltaPct: number | null } | null
  sample: Record<string, unknown>[]
  compiledHash: string
  ranAt: string
  durationMs: number
}
export type PreviewOutcome = { ok: true; snapshot: PreviewSnapshot } | { ok: false; error: string }

export interface PreviewDeps {
  pool: Pool
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

const TIME_COLS = ['bizday', 'biz_date', 'day', 'date']
export function timeColumnOf(groupBy: string): string | null {
  const dims = groupBy.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return dims.find((d) => TIME_COLS.includes(d.toLowerCase())) ?? null
}

const beijingDay = (offsetDays: number): string =>
  new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
/** 窗口 = 北京时区 [昨天-7 天, 昨天]（不含今天：当日未封版，比了必假红）。 */
export function previewWindow(): { from: string; to: string } {
  return { from: beijingDay(-8), to: beijingDay(-1) }
}

async function evalSql(deps: PreviewDeps, selectSql: string, groupBy: string, win: { from: string; to: string } | null): Promise<{ value: number | null; rows: number }> {
  const tc = timeColumnOf(groupBy)
  const inner = tc !== null && win !== null
    ? `select * from (${selectSql}) p where p."${tc}"::text between $1 and $2`
    : `select * from (${selectSql}) p`
  const r = await deps.execute(
    `select count(*)::bigint as rows, sum(value)::double precision as value from (${inner}) t`,
    inner.includes('between') ? [win!.from, win!.to] : [],
  )
  const first = r.rows[0] ?? {}
  return { value: first.value === null || first.value === undefined ? null : Number(first.value), rows: Number(first.rows ?? 0) }
}

const deltaPctOf = (v: number | null, b: number | null): number | null =>
  v === null || b === null || b === 0 ? null : Math.round(((v - b) / b) * 10000) / 100

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => {
    const t = setTimeout(() => rej(new Error('PREVIEW_TIMEOUT')), ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
  })])
}

/**
 * 试算一条变更单。create/update 档：编译草稿声明（compileL2，不落库）；
 * meta/delete 档：编译「当前生效口径」（证明改前/删前这个数仍算得出来）。
 */
export async function runPreview(deps: PreviewDeps, org: string, change: MetricChangeRow): Promise<PreviewOutcome> {
  const startedAt = Date.now()
  const win = previewWindow()
  try {
    let selectSql: string
    let groupBy: string
    let baseline: PreviewSnapshot['baseline'] = null

    if (change.kind === 'create' || change.kind === 'update') {
      const catalog = await loadMergedCatalog(deps.pool, org)
      const l1 = catalog.filter((m) => m.source === 'l1')
      const compiled = compileL2(l1, change.payload as never)
      selectSql = compiled.selectSql
      groupBy = compiled.groupBy
      const decl = change.payload as { baseMetric?: string }
      if (typeof decl.baseMetric === 'string' && decl.baseMetric !== '') {
        const base = resolveL1Base(l1, decl.baseMetric)
        const b = await withTimeout(evalSql(deps, base.selectSql, base.groupBy, win), PREVIEW_TIMEOUT_MS)
        baseline = { id: base.id, value: b.value, deltaPct: null }
      }
    } else {
      const cur = await deps.pool.query(
        'select select_sql, group_by from data.metrics where org = $1 and id = $2', [org, change.metricId],
      )
      if (cur.rows[0] === undefined) return { ok: false, error: 'METRIC_NOT_FOUND' }
      selectSql = String(cur.rows[0].select_sql)
      groupBy = String(cur.rows[0].group_by)
    }

    const main = await withTimeout(evalSql(deps, selectSql, groupBy, win), PREVIEW_TIMEOUT_MS)
    const sample = (await withTimeout(
      deps.execute(`select * from (${selectSql}) p limit 10`), PREVIEW_TIMEOUT_MS,
    )).rows.map((r) => r as Record<string, unknown>)

    if (baseline !== null) baseline = { ...baseline, deltaPct: deltaPctOf(main.value, baseline.value) }
    return {
      ok: true,
      snapshot: {
        window: win, value: main.value, rows: main.rows, baseline, sample,
        compiledHash: createHash('sha256').update(selectSql).digest('hex'),
        ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 把试算结果写回变更单：成功 ⇒ preview_ready；失败 ⇒ preview_failed（仍不可采纳）。
 * UPDATE **钉 PENDING_STATUSES**（P1 Task 4 修复②）：重跑试算若在采纳的 CAS 翻状态之后
 * 才落地，无条件 `where id=$1` 会把 ADOPTED 单复活成 preview_ready（可二次采纳）。
 * 路由在调本函数前已 getChange 闸过一次（Task 3 评审遗留的那层），这里钉的是「闸过后、
 * 写落地前」的残余窗口。rowCount=0 ⇒ 单已终态（adopted/rejected/superseded/withdrawn），
 * 试算结果作废即可——warn 留痕不抛（这不是错误路径，是竞态输家的正常下场）。
 */
export async function applyPreview(pool: Pool, id: number, outcome: PreviewOutcome): Promise<void> {
  const r = outcome.ok
    ? await pool.query(
        `update data.metric_change set status = 'preview_ready', preview = $2::jsonb
          where id = $1 and status = any($3)`,
        [id, JSON.stringify(outcome.snapshot), PENDING_STATUSES],
      )
    : await pool.query(
        `update data.metric_change set status = 'preview_failed', preview = $2::jsonb
          where id = $1 and status = any($3)`,
        [id, JSON.stringify({ error: outcome.error, ranAt: new Date().toISOString() }), PENDING_STATUSES],
      )
  if ((r.rowCount ?? 0) === 0) {
    console.warn(`[data] applyPreview skipped: change ${id} 已终态，试算结果作废（重跑落后于裁决）`)
  }
}
