// store.ts —— 需求台账的读写（唯一 SQL 落点）。判定规则不在这里（classify.ts）。
import type { Pool } from 'pg'

export type DemandKind = 'alias_gap' | 'new_metric' | 'drill_gap' | 'metric_hunt'

export interface DemandRow {
  id: number; kind: DemandKind; target: string
  detail: Record<string, unknown>; occurrences: number
  firstSeen: string; lastSeen: string; evidence: unknown[]
  dismissedAt: string | null; dismissedBy: string | null; dismissReason: string | null
}

export interface DemandUpsert {
  kind: DemandKind; target: string
  detail: Record<string, unknown>; evidence: unknown[]
}

const toRow = (r: Record<string, unknown>): DemandRow => ({
  id: Number(r.id), kind: r.kind as DemandKind, target: String(r.target),
  detail: (r.detail ?? {}) as Record<string, unknown>, occurrences: Number(r.occurrences),
  firstSeen: String(r.first_seen), lastSeen: String(r.last_seen),
  evidence: Array.isArray(r.evidence) ? r.evidence : [],
  dismissedAt: r.dismissed_at === null || r.dismissed_at === undefined ? null : String(r.dismissed_at),
  dismissedBy: r.dismissed_by === null || r.dismissed_by === undefined ? null : String(r.dismissed_by),
  dismissReason: r.dismiss_reason === null || r.dismiss_reason === undefined ? null : String(r.dismiss_reason),
})

/**
 * 幂等累加。`evidence` 合并后**新在前**、只留 5 条——一次挖掘的一条证据是够用的；
 * 留全量会让 jsonb 随使用量无界增长。
 */
export async function upsertDemand(pool: Pool, org: string, d: DemandUpsert): Promise<void> {
  await pool.query(
    `insert into data.demand_signals (org, kind, target, detail, occurrences, evidence)
     values ($1, $2, $3, $4::jsonb, 1, $5::jsonb)
     on conflict (org, kind, target) do update set
       occurrences = data.demand_signals.occurrences + 1,
       last_seen   = now(),
       detail      = data.demand_signals.detail || excluded.detail,
       evidence    = (
         select coalesce(jsonb_agg(e), '[]'::jsonb) from (
           select jsonb_array_elements(excluded.evidence || data.demand_signals.evidence) as e
           limit 5
         ) t
       )`,
    [org, d.kind, d.target, JSON.stringify(d.detail), JSON.stringify(d.evidence)],
  )
}

export async function listDemands(
  pool: Pool, org: string,
  opts: { kind?: DemandKind; includeDismissed?: boolean; limit: number },
): Promise<DemandRow[]> {
  const { rows } = await pool.query(
    `select * from data.demand_signals
      where org = $1
        and ($2::text is null or kind = $2)
        and ($3::boolean or dismissed_at is null)
      order by occurrences desc, last_seen desc
      limit $4`,
    [org, opts.kind ?? null, opts.includeDismissed === true, opts.limit],
  )
  return rows.map(toRow)
}

export async function getDemand(pool: Pool, org: string, id: number): Promise<DemandRow | null> {
  const { rows } = await pool.query(
    'select * from data.demand_signals where org = $1 and id = $2', [org, id],
  )
  return rows.length === 0 ? null : toRow(rows[0])
}

/** 否决幂等：已否决 ⇒ `already`（回原否决信息），不存在 ⇒ `not_found`。 */
export async function dismissDemand(
  pool: Pool, org: string, id: number, by: string, reason: string,
): Promise<{ status: 'dismissed' } | { status: 'already'; row: DemandRow } | { status: 'not_found' }> {
  const cur = await getDemand(pool, org, id)
  if (cur === null) return { status: 'not_found' }
  if (cur.dismissedAt !== null) return { status: 'already', row: cur }
  await pool.query(
    `update data.demand_signals set dismissed_at = now(), dismissed_by = $3, dismiss_reason = $4
      where org = $1 and id = $2`,
    [org, id, by, reason],
  )
  return { status: 'dismissed' }
}

const SOURCES = ['query_audit', 'askdata_conv'] as const
export type CursorSource = (typeof SOURCES)[number]

export async function readCursor(pool: Pool, org: string, source: CursorSource): Promise<number> {
  const { rows } = await pool.query(
    'select last_cursor from data.demand_mining_state where org = $1 and source = $2', [org, source],
  )
  return rows.length === 0 ? 0 : Number(rows[0].last_cursor)
}

export async function writeCursor(pool: Pool, org: string, source: CursorSource, value: number): Promise<void> {
  await pool.query(
    `insert into data.demand_mining_state (org, source, last_cursor, updated_at)
     values ($1, $2, $3, now())
     on conflict (org, source) do update set last_cursor = excluded.last_cursor, updated_at = now()`,
    [org, source, value],
  )
}
