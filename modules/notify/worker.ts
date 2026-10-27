// worker.ts — 通知投递编排核心（纯编排，依赖全部注入；进程入口见 scripts/notify-worker.mjs）。
// 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §7
// 关键语义：事件先入队；worker 匹配 → 渲染冻结 → 到期领取 → provider 发送 → 回执。
import type { NotificationEventDecl } from '@platform/sdk'
import { matchRules, type NotificationRule } from './domain/rules'
import { resolveRecipientNames } from './domain/recipients'
import { renderContents, type Contents } from './domain/render'
import type { DeliveryRow, InsertDeliveryInput, PendingEvent } from './storage'

export type ProviderResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

export type WorkerStats = {
  events: number
  deliveries: number
  sent: number
  failed: number
  dead: number
}

export type WorkerDeps = {
  now(): Date
  claimEvents(n: number): Promise<PendingEvent[]>
  markEvent(ev: { org: string; eventId: string }, status: string): Promise<void>
  listRules(org: string): Promise<NotificationRule[]>
  getEventDecl(key: string): Promise<NotificationEventDecl | null>
  getPublishedTemplate(
    org: string,
    key: string,
  ): Promise<{ revision: number; contents: Contents } | null>
  getChannel(
    org: string,
    id: string,
  ): Promise<{ provider: string; enabled: boolean; config?: Record<string, unknown> } | null>
  claimDueDeliveries(n: number): Promise<DeliveryRow[]>
  insertDelivery(row: InsertDeliveryInput): Promise<void>
  insertAttempt(d: DeliveryRow, r: ProviderResult): Promise<void>
  markDeliverySent(d: DeliveryRow): Promise<void>
  markDeliveryFailed(d: DeliveryRow, msg: string, at: Date): Promise<void>
  markDeliveryDead(d: DeliveryRow, msg: string): Promise<void>
  resolveScopeHolders(
    org: string,
    key: string,
    decl: NotificationEventDecl,
  ): Promise<string[]>
  resolveAddress(input: {
    org: string
    provider: string
    casdoorName: string
  }): Promise<string | null>
  isCoolingDown(
    org: string,
    rule: NotificationRule,
    recipient: string,
    now: Date,
  ): Promise<boolean>
  send(d: DeliveryRow): Promise<ProviderResult>
}

/** 退避：30s / 2m / 10m / 30m（±20% 抖动）；attempt 从 1 起 */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]

export function nextAt(attempt: number, now: Date): Date {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!
  const jitter = 0.8 + Math.random() * 0.4
  return new Date(now.getTime() + Math.round(base * jitter))
}

export async function runOnce(deps: WorkerDeps): Promise<WorkerStats> {
  const now = deps.now()
  const events = await deps.claimEvents(50)
  let deliveries = 0

  for (const ev of events) {
    const rules = matchRules(await deps.listRules(ev.org), {
      eventKey: ev.eventKey,
      scope: ev.scope,
    })
    if (rules.length === 0) {
      await deps.markEvent(ev, 'no_rules')
      continue
    }

    const decl = await deps.getEventDecl(ev.eventKey)
    if (!decl) {
      await deps.markEvent(ev, 'invalid')
      continue
    }

    for (const rule of rules) {
      const tpl = await deps.getPublishedTemplate(ev.org, rule.templateKey)
      if (!tpl) {
        await deps.markEvent(ev, 'invalid')
        continue
      }

      const names = resolveRecipientNames(rule, decl, ev.payload)
      const holders = rule.recipientLiteral
        ? []
        : await deps.resolveScopeHolders(ev.org, rule.recipientKey, decl)
      const recipients = [...new Set([...names, ...holders])].filter(Boolean)
      if (recipients.length === 0) continue

      const hits = await Promise.all(rule.channels.map(async (id) => ({
        id, row: await deps.getChannel(ev.org, id),
      })))
      const channelRows = hits
        .filter((c) => c.row !== null && c.row.enabled)
        .map((c) => ({ id: c.id, row: c.row! }))
      if (channelRows.length === 0) continue

      // 模板内容按 provider 组织（wecom_chat / in_app / webhook），规则引用的是通道实例 id
      const providers = [...new Set(channelRows.map((c) => c.row.provider))]
      const rendered = renderContents(tpl.contents, ev.payload, providers)
      if (!rendered.ok) {
        for (const c of channelRows) {
          await deps.insertDelivery({
            org: ev.org, eventId: ev.eventId, eventKey: ev.eventKey, ruleId: rule.id,
            recipient: '<render>', channel: c.id, address: '', templateKey: rule.templateKey,
            revision: tpl.revision, rendered: {}, status: 'dead',
            lastError: rendered.issues.join('; '),
          })
        }
        continue
      }

      for (const recipient of recipients) {
        for (const { id: channelId, row: ch } of channelRows) {
          const out = rendered.rendered[ch.provider]
          if (!out) continue

          const base = {
            org: ev.org, eventId: ev.eventId, eventKey: ev.eventKey, ruleId: rule.id,
            recipient, channel: channelId,
            templateKey: rule.templateKey, revision: tpl.revision,
          }

          if (await deps.isCoolingDown(ev.org, rule, recipient, now)) {
            await deps.insertDelivery({ ...base, address: '', rendered: out, status: 'suppressed' })
            continue
          }

          const resolved = await deps.resolveAddress({
            org: ev.org, provider: ch.provider, casdoorName: recipient,
          })
          // 只有显式开了 address_fallback 的租户才允许把 Casdoor 名当企微 userid（fail-closed 默认）
          const address = resolved
            ?? (ch.provider === 'wecom_chat' && ch.config?.address_fallback === 'casdoor_name'
              ? recipient
              : null)
          if (!address && ch.provider !== 'in_app') {
            await deps.insertDelivery({
              ...base, address: '', rendered: out, status: 'dead',
              lastError: 'missing_channel_address',
            })
            continue
          }

          await deps.insertDelivery({
            ...base, address: address ?? recipient, rendered: out, status: 'pending',
          })
          deliveries++
        }
      }
    }

    await deps.markEvent(ev, 'matched')
  }

  const due = await deps.claimDueDeliveries(50)
  let sent = 0
  let failed = 0
  let dead = 0

  for (const d of due) {
    const res = await deps.send(d)
    await deps.insertAttempt(d, res)
    if (res.ok) {
      await deps.markDeliverySent(d)
      sent++
    } else if (res.kind === 'permanent' || d.attempts + 1 >= 5) {
      await deps.markDeliveryDead(d, res.summary)
      dead++
    } else {
      await deps.markDeliveryFailed(d, res.summary, nextAt(d.attempts + 1, deps.now()))
      failed++
    }
  }

  return { events: events.length, deliveries, sent, failed, dead }
}
