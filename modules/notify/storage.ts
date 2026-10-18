// storage.ts — notify 的 SQL 封装。
// 薄封装纪律：主体（org）一律来自调用方传入的 identity.orgId，**本层绝不读请求**；
// SQL 一律 `where org=$1`（org-scoped 行级隔离，§2.6 鉴权钉死）。
import type { Pool } from 'pg'
import type { Channel, NotificationRule, RecipientKind, RuleOrigin } from './domain/rules'

/** 机检错误码载体：routes 按 code 映射 HTTP 状态与文案，不解析 message。 */
export class NotifyError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

type RuleRow = {
  org: string
  id: string
  enabled: boolean
  event_type: string
  mount: string
  template_id: string
  recipient: RecipientKind
  recipient_arg: string | null
  channels: Channel[]
  cooldown_minutes: number | null
  origin: RuleOrigin
  created_at: Date
}

const COLS =
  'org,id,enabled,event_type,mount,template_id,recipient,recipient_arg,channels,cooldown_minutes,origin,created_at'

function toRule(r: RuleRow): NotificationRule {
  return {
    id: r.id,
    org: r.org,
    enabled: r.enabled,
    eventType: r.event_type,
    mount: r.mount,
    templateId: r.template_id,
    recipient: r.recipient,
    recipientArg: r.recipient_arg,
    channels: r.channels,
    cooldownMinutes: r.cooldown_minutes,
    origin: r.origin,
    createdAt: r.created_at.toISOString(),
  }
}

// ── 规则登记 ──

export async function listRules(pool: Pool, org: string): Promise<NotificationRule[]> {
  const { rows } = await pool.query<RuleRow>(
    `select ${COLS} from notify.rule where org=$1 order by created_at, id`,
    [org],
  )
  return rows.map(toRule)
}

/**
 * upsert（幂等）：撞 `(org,id)` 则更新业务列，**不覆盖 created_at**——保住「首次派生/创建时间」语义，
 * 让声明重算（derive 幂等）落成 no-op。
 */
export async function upsertRule(pool: Pool, org: string, rule: NotificationRule, actor: string): Promise<void> {
  await pool.query(
    `insert into notify.rule
       (org,id,enabled,event_type,mount,template_id,recipient,recipient_arg,channels,cooldown_minutes,origin,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (org,id) do update set
       enabled          = excluded.enabled,
       event_type       = excluded.event_type,
       mount            = excluded.mount,
       template_id      = excluded.template_id,
       recipient        = excluded.recipient,
       recipient_arg    = excluded.recipient_arg,
       channels         = excluded.channels,
       cooldown_minutes = excluded.cooldown_minutes,
       origin           = excluded.origin`,
    [
      org,
      rule.id,
      rule.enabled,
      rule.eventType,
      rule.mount,
      rule.templateId,
      rule.recipient,
      rule.recipientArg ?? null,
      rule.channels,
      rule.cooldownMinutes ?? null,
      rule.origin,
      actor,
    ],
  )
}

export async function setRuleEnabled(pool: Pool, org: string, id: string, enabled: boolean): Promise<number> {
  const res = await pool.query('update notify.rule set enabled=$3 where org=$1 and id=$2', [org, id, enabled])
  return res.rowCount ?? 0
}

export async function deleteRule(pool: Pool, org: string, id: string): Promise<number> {
  const res = await pool.query('delete from notify.rule where org=$1 and id=$2', [org, id])
  return res.rowCount ?? 0
}

// ── 投递回执 ──

export type DeliveryRow = {
  ruleId: string
  eventId: string
  eventType: string
  recipient: string
  template: string
}

/**
 * **认领**投递（幂等去重的实现）：撞 `(org,event_id,rule_id)` 即 no-op 并返回 false ⇒ 调用方**跳过**，
 * 不双发。返回 true = 本次认领成功（**先认领后投递**：认领即占位，投递失败再 markDeliveryFailed）。
 * 崩溃窗口（认领后未投递）在 v1 可接受——fail-open、无队列，靠 Novu 自身重试 + 人工重触发（§2.6 取舍④）。
 */
export async function claimDelivery(pool: Pool, org: string, row: DeliveryRow): Promise<boolean> {
  const res = await pool.query(
    `insert into notify.delivery (org,rule_id,event_id,event_type,recipient,template,status)
     values ($1,$2,$3,$4,$5,$6,'sent')
     on conflict (org,event_id,rule_id) do nothing`,
    [org, row.ruleId, row.eventId, row.eventType, row.recipient, row.template],
  )
  return (res.rowCount ?? 0) > 0
}

export async function markDeliveryFailed(
  pool: Pool,
  org: string,
  eventId: string,
  ruleId: string,
  error: string,
): Promise<void> {
  await pool.query(
    "update notify.delivery set status='failed', error=$4 where org=$1 and event_id=$2 and rule_id=$3",
    [org, eventId, ruleId, error],
  )
}

export async function listDeliveries(pool: Pool, org: string, limit = 100): Promise<
  { ruleId: string; eventId: string; eventType: string; recipient: string; template: string; status: string; error: string | null; createdAt: string }[]
> {
  const { rows } = await pool.query(
    `select rule_id, event_id, event_type, recipient, template, status, error, created_at
       from notify.delivery where org=$1 order by created_at desc limit $2`,
    [org, limit],
  )
  return rows.map((r) => ({
    ruleId: r.rule_id,
    eventId: r.event_id,
    eventType: r.event_type,
    recipient: r.recipient,
    template: r.template,
    status: r.status,
    error: r.error,
    createdAt: (r.created_at as Date).toISOString(),
  }))
}
