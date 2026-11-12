// metric-change-preview.ts —— 试算：编译（不生效）→ 只读求值 → 快照（spec §6）。
// 纯度约束：execute 由调用方注入（生产=只读池；测试=假执行器）。本文件永不写 data.metrics。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { compileL2, resolveL1Base } from './semantic-compiler'
import { loadMergedCatalog } from './metric-store'
import { compileOverrideDeclaration } from './tenant-declaration-write'
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
 * override 档：W8 声明经与写路径同一把编译尺编译（P1 Task 7），baseline = 被 override 的
 * L1 同窗值；meta/delete 档：编译「当前生效口径」（证明改前/删前这个数仍算得出来）。
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
    } else if (change.kind === 'override') {
      // override 档试算（P1 Task 7）：与写路径**同一把编译尺**——compileOverrideDeclaration
      // 就是从 createOverrideDeclaration 抽出的编译段（不复制上下文拼装）。编译失败 ⇒
      // preview_failed（错误码透传：DECLARATION_INVALID / SEMANTICS_YAML_*）。
      // 刻意不复刻「对行」判据（grain 同形等）：这类单要能试算、在采纳时被透传的 400 拒——
      // 先试后断，与 create/update 档「试算能红、采纳把关」同语义。
      const pre = await compileOverrideDeclaration({ pool: deps.pool }, change.payload)
      if (!pre.ok) return { ok: false, error: pre.outcome.error }
      selectSql = pre.compiled.selectSql
      groupBy = pre.compiled.groupBy
      // baseline = 被 override 的 L1 同窗值（编译段顺带带回平台目录，按 id 取行）
      const l1 = pre.catalog.find((m) => m.id === change.metricId)
      if (l1 !== undefined) {
        const b = await withTimeout(evalSql(deps, l1.selectSql, l1.groupBy, win), PREVIEW_TIMEOUT_MS)
        baseline = { id: l1.id, value: b.value, deltaPct: null }
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
 * 快照历史回写表达式（P1 Task 5，销缓办①）：UPDATE 的 SET 里**同一语句内**读旧行值——
 * 把被新快照顶掉的旧 `preview` unshift 进 `preview_history`（最新在前），FIFO 封顶 5 条
 * （子查询 `limit 5` 截头＝丢最旧）；首跑无旧快照（preview is null）⇒ 归一 `[]`，不写
 * jsonb null。纯 SQL 而非「先读后写」：读改写两次往返有并发窗，同语句表达式的行值读取
 * 对本行天然一致。成功/失败两分支共用同一段——失败回写同样保历史（旧成功快照是
 * 「之前试过什么」的证据，不能被失败对象冲掉），只是新落地的 preview 换成错误对象。
 * 终态单不受影响：整个 UPDATE 仍钉 PENDING_STATUSES（Task 4 修复②），rowCount=0 连
 * history 都不写。
 */
const PREVIEW_HISTORY_SET = `preview_history = (
    select coalesce(jsonb_agg(v order by o), '[]'::jsonb)
    from (
      select v, o from jsonb_array_elements(
        (case when preview is null then '[]'::jsonb else jsonb_build_array(preview) end)
          || coalesce(preview_history, '[]'::jsonb)
      ) with ordinality as x(v, o)
      limit 5
    ) q
  )`

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
        `update data.metric_change set status = 'preview_ready', preview = $2::jsonb, ${PREVIEW_HISTORY_SET}
          where id = $1 and status = any($3)`,
        [id, JSON.stringify(outcome.snapshot), PENDING_STATUSES],
      )
    : await pool.query(
        `update data.metric_change set status = 'preview_failed', preview = $2::jsonb, ${PREVIEW_HISTORY_SET}
          where id = $1 and status = any($3)`,
        [id, JSON.stringify({ error: outcome.error, ranAt: new Date().toISOString() }), PENDING_STATUSES],
      )
  if ((r.rowCount ?? 0) === 0) {
    console.warn(`[data] applyPreview skipped: change ${id} 已终态，试算结果作废（重跑落后于裁决）`)
  }
}
