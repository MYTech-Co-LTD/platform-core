// monitor-store.ts — 业务监控的存储层（Wave 7 V1，spec §5/§8/§11）。
//
// 隔离键一律 org（text = Casdoor org）。**每一条 SQL 都带 `where org = $1`**——
// 跨租户读写必须在 SQL 层就不可表达（spec §16.5；机器判据 check-tenant-isolation.mjs）。
import type { Pool, PoolClient } from 'pg'
import type {
  MonitorChannelPolicy, MonitorRecipient, MonitorState, MonitorTargetKind, MonitorVerdict,
  NewMonitorInput, MonitorValidationError,
} from './monitor-spec'
import { MONITOR_QUOTA_PER_ORG, validateNewMonitor } from './monitor-spec'

export interface MonitorRow {
  id: string
  org: string
  name: string
  targetKind: MonitorTargetKind
  metricId: string | null
  reportId: string | null
  panelIndex: number | null
  filters: Record<string, unknown>
  verdict: MonitorVerdict
  windowDays: number
  cadenceSecs: number
  cooldownSecs: number
  dryRun: boolean
  recipients: MonitorRecipient[]
  channelPolicy: MonitorChannelPolicy
  state: MonitorState
  stateSince: Date | null
  lastEvalAt: Date | null
  notifiedAt: Date | null
  consecutiveFail: number
  enabled: boolean
  createdBy: string
}

/** 唯一列清单：读写共用（新增列只改这里，避免 toMonitorRow 拿到 undefined）。 */
const MONITOR_COLUMNS = [
  'id', 'org', 'name', 'target_kind', 'metric_id', 'report_id', 'panel_index', 'filters',
  'verdict', 'window_days', 'cadence_secs', 'cooldown_secs', 'dry_run', 'recipients',
  'channel_policy', 'state', 'state_since', 'last_eval_at', 'notified_at',
  'consecutive_fail', 'enabled', 'created_by',
].join(', ')

interface MonitorDbRow {
  id: string; org: string; name: string; target_kind: MonitorTargetKind
  metric_id: string | null; report_id: string | null; panel_index: number | null
  filters: Record<string, unknown>; verdict: MonitorVerdict
  window_days: number; cadence_secs: number; cooldown_secs: number; dry_run: boolean
  recipients: MonitorRecipient[]; channel_policy: MonitorChannelPolicy
  state: MonitorState; state_since: Date | null; last_eval_at: Date | null
  notified_at: Date | null; consecutive_fail: number; enabled: boolean; created_by: string
}

export function toMonitorRow(r: MonitorDbRow): MonitorRow {
  return {
    id: String(r.id), org: r.org, name: r.name,
    targetKind: r.target_kind, metricId: r.metric_id, reportId: r.report_id,
    panelIndex: r.panel_index, filters: r.filters ?? {},
    verdict: r.verdict, windowDays: r.window_days, cadenceSecs: r.cadence_secs,
    cooldownSecs: r.cooldown_secs, dryRun: r.dry_run,
    recipients: (r.recipients ?? []) as MonitorRecipient[],
    channelPolicy: r.channel_policy,
    state: r.state, stateSince: r.state_since, lastEvalAt: r.last_eval_at, notifiedAt: r.notified_at,
    consecutiveFail: r.consecutive_fail, enabled: r.enabled, createdBy: r.created_by,
  }
}

/** 到期规则（启用的，且距上次求值已满 cadence）。**限制在单 org**——tick 逐 org 调用。 */
export async function dueMonitors(
  pool: Pool, org: string, now: Date, limit: number,
): Promise<MonitorRow[]> {
  const { rows } = await pool.query<MonitorDbRow>(
    `select ${MONITOR_COLUMNS} from data.monitor
      where org = $1 and enabled
        and (last_eval_at is null or last_eval_at <= $2::timestamptz - make_interval(secs => cadence_secs))
      order by coalesce(last_eval_at, 'epoch'::timestamptz), id
      limit $3`,
    [org, now, Math.max(1, Math.min(500, limit))],
  )
  return rows.map(toMonitorRow)
}

/** tick 覆盖的租户：有启用规则的 org（按 org 分片求值，spec §8 容量判据）。 */
export async function monitorOrgs(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ org: string }>(
    'select distinct org from data.monitor where enabled order by org',
  )
  return rows.map((r) => r.org)
}

export interface MonitorRunInput {
  monitorId: string
  org: string
  verdict: 'ok' | 'missing' | 'stale' | 'unknown'
  value: number | null
  watermarkRef: string | null
  stateAfter: MonitorState
  notified: boolean
  dryRun: boolean
  durationMs: number | null
  error: string | null
}

export async function recordRun(pool: Pool, run: MonitorRunInput): Promise<void> {
  await pool.query(
    `insert into data.monitor_run
       (monitor_id, org, verdict, value, watermark_ref, state_after, notified, dry_run, duration_ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [run.monitorId, run.org, run.verdict, run.value, run.watermarkRef, run.stateAfter,
      run.notified, run.dryRun, run.durationMs, run.error],
  )
}

export interface ApplyOutcomeInput {
  state: MonitorState
  stateSince: Date
  lastEvalAt: Date
  notified: boolean
  consecutiveFail: number
  /** 熔断：置 false（spec §11）。 */
  enabled?: boolean
}

/** 单条 UPDATE 落状态与求值元数据；跨 org 恒 0 行。 */
export async function applyOutcome(
  pool: Pool, m: Pick<MonitorRow, 'id' | 'org'>, next: ApplyOutcomeInput,
): Promise<void> {
  await pool.query(
    `update data.monitor
        set state = $3,
            state_since = $4,
            last_eval_at = $5,
            notified_at = case when $6 then $5 else notified_at end,
            consecutive_fail = $7,
            enabled = coalesce($8, enabled),
            updated_at = now()
      where id = $1 and org = $2`,
    [m.id, m.org, next.state, next.stateSince, next.lastEvalAt, next.notified,
      next.consecutiveFail, next.enabled ?? null],
  )
}

export class MonitorStoreError extends Error {
  constructor(public code: MonitorValidationError | 'MONITOR_QUOTA_EXCEEDED', message: string) {
    super(message)
    this.name = 'MonitorStoreError'
  }
}

export async function createMonitor(pool: Pool, input: NewMonitorInput): Promise<{ id: string }> {
  const v = validateNewMonitor(input)
  if (!v.ok) throw new MonitorStoreError(v.code, v.message)
  const n = v.value

  const client: PoolClient = await pool.connect()
  try {
    await client.query('begin')
    // 并发防超建：同一 org 的创建串行化（advisory 锁按 org 哈希，事务结束自动释放）。
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`monitor-quota:${n.org}`])
    const { rows } = await client.query<{ n: string }>(
      'select count(*)::text as n from data.monitor where org = $1 and enabled', [n.org],
    )
    if (Number(rows[0]?.n ?? 0) >= MONITOR_QUOTA_PER_ORG) {
      throw new MonitorStoreError('MONITOR_QUOTA_EXCEEDED', `每个租户最多 ${MONITOR_QUOTA_PER_ORG} 条启用监控`)
    }
    const ins = await client.query<{ id: string }>(
      `insert into data.monitor
         (org, name, target_kind, metric_id, report_id, panel_index, filters, verdict,
          window_days, cadence_secs, cooldown_secs, dry_run, recipients, channel_policy, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14)
       returning id`,
      [n.org, n.name, n.targetKind, n.metricId ?? null, n.reportId ?? null, n.panelIndex ?? null,
        JSON.stringify(n.filters), n.verdict, n.windowDays, n.cadenceSecs, n.cooldownSecs,
        JSON.stringify(n.recipients), n.channelPolicy, n.createdBy],
    )
    await client.query('commit')
    return { id: String(ins.rows[0].id) }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function listMonitors(pool: Pool, org: string): Promise<MonitorRow[]> {
  const { rows } = await pool.query<MonitorDbRow>(
    `select ${MONITOR_COLUMNS} from data.monitor where org = $1 order by id`,
    [org],
  )
  return rows.map(toMonitorRow)
}

export async function getMonitor(pool: Pool, org: string, id: string): Promise<MonitorRow | null> {
  const { rows } = await pool.query<MonitorDbRow>(
    `select ${MONITOR_COLUMNS} from data.monitor where org = $1 and id = $2`,
    [org, id],
  )
  return rows[0] ? toMonitorRow(rows[0]) : null
}

/** 启停与影子期开闸。只改传了的那一项（undefined = 不动）。 */
export async function updateMonitorFlags(
  pool: Pool, org: string, id: string, patch: { enabled?: boolean; dryRun?: boolean },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update data.monitor
        set enabled = coalesce($3, enabled),
            dry_run = coalesce($4, dry_run),
            updated_at = now()
      where org = $1 and id = $2`,
    [org, id, patch.enabled ?? null, patch.dryRun ?? null],
  )
  return (rowCount ?? 0) > 0
}

export async function listRuns(
  pool: Pool, org: string, monitorId: string, limit: number,
): Promise<Array<{
  id: string; evaluatedAt: Date; verdict: string; value: string | null
  watermarkRef: string | null; stateAfter: string; notified: boolean; dryRun: boolean; error: string | null
}>> {
  const { rows } = await pool.query(
    `select id, evaluated_at, verdict, value, watermark_ref, state_after, notified, dry_run, error
       from data.monitor_run
      where org = $1 and monitor_id = $2
      order by evaluated_at desc
      limit $3`,
    [org, monitorId, Math.max(1, Math.min(100, limit))],
  )
  return rows.map((r) => ({
    id: String(r.id), evaluatedAt: r.evaluated_at, verdict: r.verdict, value: r.value,
    watermarkRef: r.watermark_ref, stateAfter: r.state_after,
    notified: r.notified, dryRun: r.dry_run, error: r.error,
  }))
}

export async function quotaOf(pool: Pool, org: string): Promise<{ used: number; limit: number }> {
  const { rows } = await pool.query<{ n: string }>(
    'select count(*)::text as n from data.monitor where org = $1 and enabled', [org],
  )
  return { used: Number(rows[0]?.n ?? 0), limit: MONITOR_QUOTA_PER_ORG }
}
