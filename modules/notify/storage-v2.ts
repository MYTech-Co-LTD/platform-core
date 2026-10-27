// storage-v2.ts — 新通知存储层（expand 阶段：rule/delivery 用 _v2 表名，Task 15 rename）。
// 纪律：org 一律由调用方传入；SQL 一律 where org=$1；本层不读请求/身份。
import type { Pool } from 'pg'
import type { EnqueueEventInput } from '@platform/sdk'
import type { NotificationRule } from './domain/rules-v2'

export type RuleInput = {
  id: string
  enabled: boolean
  eventKey: string
  scope: string
  recipientKey: string
  recipientLiteral: string[] | null
  templateKey: string
  channels: string[]
  cooldownMinutes: number | null
  origin: 'derived' | 'manual'
}

export type DeliveryRow = {
  org: string
  eventId: string
  ruleId: string
  recipient: string
  channel: string
  address: string
  templateKey: string
  revision: number
  rendered: Record<string, string>
  status: string
  attempts: number
  lockedUntil: string | null
}

export type PendingEvent = {
  org: string
  eventId: string
  eventKey: string
  scope: string
  payload: Record<string, unknown>
}

// ── 入队 ──────────────────────────────────────────────────────────────────────

export async function enqueueEvent(
  pool: Pool,
  e: EnqueueEventInput,
): Promise<{ accepted: boolean; reason?: string }> {
  const r = await pool.query(
    `insert into notify.event(org,event_id,event_key,scope,payload,producer)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     on conflict (org,event_id) do nothing`,
    [e.org, e.eventId, e.eventKey, e.scope, JSON.stringify(e.payload), e.producer],
  )
  return (r.rowCount ?? 0) > 0 ? { accepted: true } : { accepted: false, reason: 'duplicate' }
}

export async function claimEvents(pool: Pool, limit = 50): Promise<PendingEvent[]> {
  const { rows } = await pool.query(
    `with picked as (
       select org,event_id from notify.event
        where status='new' and (locked_until is null or locked_until < now())
        order by created_at limit $1 for update skip locked
     )
     update notify.event e set locked_until = now() + interval '60 seconds'
       from picked p where e.org=p.org and e.event_id=p.event_id
     returning e.org, e.event_id as "eventId", e.event_key as "eventKey", e.scope, e.payload`,
    [limit],
  )
  return rows as PendingEvent[]
}

export async function markEvent(
  pool: Pool,
  ev: { org: string; eventId: string },
  status: string,
): Promise<void> {
  await pool.query(
    `update notify.event set status=$3, processed_at=now(), locked_until=null
      where org=$1 and event_id=$2`,
    [ev.org, ev.eventId, status],
  )
}

// ── 规则 ──────────────────────────────────────────────────────────────────────

export async function listRules(pool: Pool, org: string): Promise<NotificationRule[]> {
  const { rows } = await pool.query(
    `select org,id,enabled,event_key,scope,recipient_key,recipient_literal,template_key,
            channels,cooldown_minutes,origin,created_at
       from notify.rule_v2 where org=$1 order by created_at,id`,
    [org],
  )
  return rows.map((r) => ({
    org: r.org,
    id: r.id,
    enabled: r.enabled,
    eventKey: r.event_key,
    scope: r.scope,
    recipientKey: r.recipient_key,
    recipientLiteral: r.recipient_literal,
    templateKey: r.template_key,
    channels: r.channels,
    cooldownMinutes: r.cooldown_minutes,
    origin: r.origin,
    createdAt: (r.created_at as Date).toISOString(),
  }))
}

export async function upsertRule(
  pool: Pool,
  org: string,
  rule: RuleInput,
  actor: string,
): Promise<void> {
  await pool.query(
    `insert into notify.rule_v2
       (org,id,enabled,event_key,scope,recipient_key,recipient_literal,
        template_key,channels,cooldown_minutes,origin,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (org,id) do update set
       enabled=excluded.enabled,
       event_key=excluded.event_key,
       scope=excluded.scope,
       recipient_key=excluded.recipient_key,
       recipient_literal=excluded.recipient_literal,
       template_key=excluded.template_key,
       channels=excluded.channels,
       cooldown_minutes=excluded.cooldown_minutes,
       origin=excluded.origin`,
    [org, rule.id, rule.enabled, rule.eventKey, rule.scope, rule.recipientKey,
     rule.recipientLiteral, rule.templateKey, rule.channels, rule.cooldownMinutes,
     rule.origin, actor],
  )
}

export async function setRuleEnabled(
  pool: Pool, org: string, id: string, enabled: boolean,
): Promise<number> {
  const r = await pool.query('update notify.rule_v2 set enabled=$3 where org=$1 and id=$2',
    [org, id, enabled])
  return r.rowCount ?? 0
}

export async function deleteRule(pool: Pool, org: string, id: string): Promise<number> {
  const r = await pool.query('delete from notify.rule_v2 where org=$1 and id=$2', [org, id])
  return r.rowCount ?? 0
}

// ── 模板 / 通道 ───────────────────────────────────────────────────────────────

export async function getPublishedTemplate(
  pool: Pool, org: string, key: string,
): Promise<{ revision: number; contents: Record<string, Record<string, string>> } | null> {
  const { rows } = await pool.query(
    `select r.revision, r.contents from notify.template t
       join notify.template_revision r
         on r.org=t.org and r.key=t.key and r.revision=t.published_revision
      where t.org=$1 and t.key=$2 and t.status='published'`,
    [org, key],
  )
  return rows[0]
    ? { revision: rows[0].revision as number, contents: rows[0].contents }
    : null
}

export type ChannelRow = {
  org: string
  id: string
  provider: string
  enabled: boolean
  config: Record<string, unknown>
  secret_refs: Record<string, string>
}

export async function getChannel(pool: Pool, org: string, id: string): Promise<ChannelRow | null> {
  const { rows } = await pool.query(
    `select org,id,provider,enabled,config,secret_refs from notify.channel
      where org=$1 and id=$2`,
    [org, id],
  )
  return (rows[0] as ChannelRow | undefined) ?? null
}

// ── 投递 ──────────────────────────────────────────────────────────────────────

export type InsertDeliveryInput = {
  org: string
  eventId: string
  ruleId: string
  recipient: string
  channel: string
  address: string
  templateKey: string
  revision: number
  rendered: unknown
  status: 'pending' | 'suppressed' | 'dead'
  lastError?: string
}

export async function insertDelivery(pool: Pool, d: InsertDeliveryInput): Promise<void> {
  await pool.query(
    `insert into notify.delivery_v2
       (org,event_id,rule_id,recipient,channel,address,template_key,revision,rendered,status,last_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     on conflict (org,event_id,rule_id,recipient,channel) do nothing`,
    [d.org, d.eventId, d.ruleId, d.recipient, d.channel, d.address, d.templateKey,
     d.revision, JSON.stringify(d.rendered), d.status, d.lastError ?? null],
  )
}

export async function claimDueDeliveries(pool: Pool, limit = 50): Promise<DeliveryRow[]> {
  const { rows } = await pool.query(
    `with picked as (
       select org,event_id,rule_id,recipient,channel from notify.delivery_v2
        where status in ('pending','failed') and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
        order by next_attempt_at limit $1 for update skip locked
     )
     update notify.delivery_v2 d set locked_until = now() + interval '60 seconds', updated_at = now()
       from picked p
      where d.org=p.org and d.event_id=p.event_id and d.rule_id=p.rule_id
        and d.recipient=p.recipient and d.channel=p.channel
     returning d.org, d.event_id, d.rule_id, d.recipient, d.channel, d.address,
               d.template_key, d.revision, d.rendered, d.status, d.attempts, d.locked_until`,
    [limit],
  )
  return rows.map((r) => ({
    org: r.org,
    eventId: r.event_id,
    ruleId: r.rule_id,
    recipient: r.recipient,
    channel: r.channel,
    address: r.address,
    templateKey: r.template_key,
    revision: r.revision,
    rendered: r.rendered,
    status: r.status,
    attempts: r.attempts,
    lockedUntil: r.locked_until ? (r.locked_until as Date).toISOString() : null,
  }))
}

export function deliveryKey(d: {
  eventId: string; ruleId: string; recipient: string; channel: string
}): string {
  return `${d.eventId}|${d.ruleId}|${d.recipient}|${d.channel}`
}

export async function insertAttempt(
  pool: Pool,
  d: DeliveryRow,
  r: { ok: true } | { ok: false; kind: string; code: string; summary: string },
): Promise<void> {
  await pool.query(
    `insert into notify.delivery_attempt
       (org,delivery_key,attempt_no,provider,status,error_code,error_summary)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [d.org, deliveryKey(d), d.attempts + 1, d.channel, r.ok ? 'sent' : 'failed',
     r.ok ? null : r.code, r.ok ? null : r.summary],
  )
}

/** 只按投递键更新时用的最小形状（不需要整行） */
export type DeliveryKey = Pick<DeliveryRow, 'org' | 'eventId' | 'ruleId' | 'recipient' | 'channel'>

export async function markDeliverySent(pool: Pool, d: DeliveryKey): Promise<void> {
  await pool.query(
    `update notify.delivery_v2 set status='sent', attempts=attempts+1, locked_until=null,
       updated_at=now()
      where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org, d.eventId, d.ruleId, d.recipient, d.channel],
  )
}

export async function markDeliveryFailed(
  pool: Pool, d: DeliveryKey, msg: string, at: Date,
): Promise<void> {
  await pool.query(
    `update notify.delivery_v2 set status='failed', attempts=attempts+1, locked_until=null,
       next_attempt_at=$6, last_error=$7, updated_at=now()
      where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org, d.eventId, d.ruleId, d.recipient, d.channel, at.toISOString(), msg],
  )
}

export async function markDeliveryDead(pool: Pool, d: DeliveryKey, msg: string): Promise<void> {
  await pool.query(
    `update notify.delivery_v2 set status='dead', attempts=attempts+1, locked_until=null,
       last_error=$6, updated_at=now()
      where org=$1 and event_id=$2 and rule_id=$3 and recipient=$4 and channel=$5`,
    [d.org, d.eventId, d.ruleId, d.recipient, d.channel, msg],
  )
}

export async function isCoolingDown(
  pool: Pool,
  org: string,
  rule: { id: string; cooldownMinutes: number | null },
  recipient: string,
  now: Date,
): Promise<boolean> {
  if (!rule.cooldownMinutes || rule.cooldownMinutes <= 0) return false
  const { rows } = await pool.query(
    `select 1 from notify.delivery_v2
      where org=$1 and rule_id=$2 and recipient=$3 and status='sent'
        and created_at > $4::timestamptz - ($5 || ' minutes')::interval
      limit 1`,
    [org, rule.id, recipient, now.toISOString(), String(rule.cooldownMinutes)],
  )
  return rows.length > 0
}

// ── 回执列表（console） ───────────────────────────────────────────────────────

export async function listDeliveries(pool: Pool, org: string, limit = 100) {
  const { rows } = await pool.query(
    `select event_id,rule_id,recipient,channel,address,template_key,revision,
            status,attempts,last_error,created_at
       from notify.delivery_v2 where org=$1 order by created_at desc limit $2`,
    [org, limit],
  )
  return rows.map((r) => ({
    eventId: r.event_id,
    ruleId: r.rule_id,
    recipient: r.recipient,
    channel: r.channel,
    address: r.address,
    templateKey: r.template_key,
    revision: r.revision,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: (r.created_at as Date).toISOString(),
  }))
}

// ── in-app 收件箱 ─────────────────────────────────────────────────────────────

export async function listInbox(
  pool: Pool, org: string, recipient: string, unreadOnly: boolean,
) {
  const { rows } = await pool.query(
    `select id,event_id,event_key,title,body,link,read_at,created_at
       from notify.inbox
      where org=$1 and recipient=$2 ${unreadOnly ? 'and read_at is null' : ''}
      order by created_at desc limit 100`,
    [org, recipient],
  )
  return rows
}

export async function markInboxRead(
  pool: Pool, org: string, recipient: string, id: string,
): Promise<void> {
  await pool.query(
    'update notify.inbox set read_at=now() where org=$1 and recipient=$2 and id=$3',
    [org, recipient, id],
  )
}
