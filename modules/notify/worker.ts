// worker.ts — 通知投递编排核心（纯编排，依赖全部注入；进程入口见 scripts/notify-worker.mjs）。
// 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §7
// 关键语义：事件先入队；worker 匹配 → 渲染冻结 → 到期领取 → provider 发送 → 回执。
import type { DeptExpansion, NotificationEventDecl } from '@platform/sdk'
import { matchRules, type NotificationRule } from './domain/rules'
import {
  aggregateEventStatus, isChannelUsable, resolveDeliverability, type Blocked,
} from './domain/deliverability'
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
  /**
   * 部门 → 成员展开（含子树、已排除禁用）。**未注入 = 查不了**（该规则落
   * `dept_resolver_unavailable`，不静默发 0 人）。
   */
  resolveDeptMembers?(org: string, extIds: readonly string[]): Promise<DeptExpansion>
  /**
   * 写一条审计（部门展开三数等）。缺省 = 不写（只打日志）——单测与旧组合根不强制提供。
   * 生产由 `buildWorkerDeps` 注入到 `notify.audit`。
   */
  audit?(org: string, action: string, target: string, detail: Record<string, unknown>): Promise<void>
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
  /** 通道限流：返回剩余等待毫秒；null = 放行。未注入 = 不限流。 */
  channelRateLimited?(org: string, channel: string, now: Date): Promise<number | null>
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

    // D2：逐规则记录阻塞原因，最后聚合成一个事件状态（不再逐条静默 continue）
    const perRule: Array<Blocked | null> = []
    let produced = false

    for (const rule of rules) {
      // 可送达性解析（**唯一实现**）：模板/收件人/通道一次算清。
      const deliv = await resolveDeliverability(
        { org: ev.org, rule, payload: ev.payload },
        {
          getEventDecl: deps.getEventDecl,
          getPublishedTemplate: async (org, key) => {
            const t = await deps.getPublishedTemplate(org, key)
            return t ? { revision: t.revision, contents: t.contents } : null
          },
          getChannel: async (org, id) => {
            const ch = await deps.getChannel(org, id)
            return ch ? { id, provider: ch.provider, enabled: ch.enabled, config: ch.config } : null
          },
          resolveScopeHolders: deps.resolveScopeHolders,
          resolveDeptMembers: deps.resolveDeptMembers,
        },
      )
      // ── 部门规则的展开三数（spec 2026-10-30 §3.5；#1174）────────────────────────
      // 位置在 blocked 判定**之前**：展开数本身是有用事实（哪怕这次因为通道停用没发出去），
      // 「谁该收到、排除了谁、谁没解析出来」不能因为下游阻塞就丢掉。
      if (deliv.deptExpansion) {
        const exp = deliv.deptExpansion
        const detail = {
          ruleId: rule.id,
          depts: exp.depts,
          expanded: exp.names.length,
          members: exp.members,
          excluded: exp.excluded,
          unresolved: exp.unresolved,
          blocked: deliv.blocked,
        }
        // 未解析 > 0 是**数据问题**（企微有/平台无）：warning 不阻断发送，但必须留痕
        if (exp.unresolved > 0) {
          console.warn(
            `[notify] 部门展开有 ${exp.unresolved} 人未解析（org 表有/平台无）org=${ev.org} rule=${rule.id}`,
          )
        }
        if (deps.audit) await deps.audit(ev.org, 'notify.dept-expand', rule.id, detail)
      }
      perRule.push(deliv.blocked)
      if (deliv.blocked !== null) continue

      const recipients = deliv.recipients.map((r) => r.name)
      // ⚠️ 用 `isChannelUsable`（启用 ∧ 已配置），不是裸 `enabled`：未配置的通道（secret_refs
      //    指向的 env 键缺失）真发时每个收件人各记一条 `secret_missing` 永久失败——那时
      //    「规则看起来能发、结果全红」。这里与预检共用同一个判据，两边不会各说各话。
      const channelRows = deliv.channels
        .filter(isChannelUsable)
        .map((c) => ({
          id: c.id,
          row: { provider: c.provider, enabled: c.enabled, config: c.config, configured: c.configured },
        }))
      if (channelRows.length === 0) continue

      // 模板内容按 provider 组织（wecom_chat / in_app / webhook），规则引用的是通道实例 id
      const providers = [...new Set(channelRows.map((c) => c.row.provider))]
      const rendered = renderContents(deliv.tpl!.contents as Contents, ev.payload, providers)
      if (!rendered.ok) {
        for (const c of channelRows) {
          await deps.insertDelivery({
            org: ev.org, eventId: ev.eventId, eventKey: ev.eventKey, ruleId: rule.id,
            recipient: '<render>', channel: c.id, address: '', templateKey: rule.templateKey,
            revision: deliv.tpl!.revision, rendered: {}, status: 'dead',
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
            templateKey: rule.templateKey, revision: deliv.tpl!.revision,
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
          // D2：只有「真的排进投递」才算发出去一部分 ⇒ 事件不判阻塞
          produced = true
        }
      }
    }

    await deps.markEvent(ev, aggregateEventStatus(perRule, produced))
  }

  const due = await deps.claimDueDeliveries(50)
  let sent = 0
  let failed = 0
  let dead = 0

  for (const d of due) {
    const wait = deps.channelRateLimited
      ? await deps.channelRateLimited(d.org, d.channel, deps.now())
      : null
    if (wait !== null) {
      await deps.markDeliveryFailed(
        d, 'channel_rate_limited', new Date(deps.now().getTime() + wait))
      failed++
      continue
    }

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
