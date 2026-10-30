// worker-deps.ts — worker 的组合根（TS，可测；scripts/notify-worker.mjs 只是 CLI 薄壳）。
// secret_refs 的逻辑键 → env 值；缺任一键 ⇒ null（该通道视为未配置，不假装成功）。
import type { Pool } from 'pg'
import type { ChannelAddressResolver, NotificationEventDecl } from '@platform/sdk'
import { createChannelAddressResolver } from '../../apps/server/src/channel-address'
import { sendInApp } from './providers/in-app'
import { sendWecom } from './providers/wecom'
import { rateLimitVerdict } from './domain/rate-limit'
import { sendWebhook } from './providers/webhook'
import * as storage from './storage'
import { audit } from './storage'
import { runOnce, type WorkerDeps, type WorkerStats } from './worker'

/** 事件目录读取器（由 scripts/ 注入；模块不读 platform schema —— B1） */
export type EventDeclLoader = (key: string) => Promise<NotificationEventDecl | null>

export type ScopeHolderLoader = (
  org: string,
  permissionCode: string,
) => Promise<string[]>

export function buildWorkerDeps(
  pool: Pool,
  getEventDecl: EventDeclLoader,
  env: NodeJS.ProcessEnv = process.env,
  /** 测试注入：webhook 的 DNS 解析（缺省 = 真 lookup）。生产不需要传。 */
  resolveHost?: (host: string) => Promise<string[]>,
  /**
   * 权限码持有者解析（宿主注入：Casdoor 直挂 ∪ 角色展开）。
   * **缺省 = 未注入 ⇒ 返回 []**（旧宿主/单测），此时只能靠 manual literal 规则。
   */
  resolveScopeHolderNames?: ScopeHolderLoader,
  /**
   * 部门 → 成员展开（宿主注入：平台 org 表 + Casdoor 禁用过滤，模块层 B1 拿不到）。
   * 缺省 = 未注入 ⇒ 部门规则落 `dept_resolver_unavailable`（不静默发 0 人）。
   * ⚠️ 参数放**最后**：既有调用点（worker.test.ts 等）按位置传 5 个参数，插中间会静默错位。
   */
  deptMembers?: ChannelAddressResolver['resolveDeptMembers'],
): WorkerDeps {
  const addresses = createChannelAddressResolver({ pool })

  const secretsOf = (ch: { secret_refs: Record<string, string> }): Record<string, string> | null => {
    const out: Record<string, string> = {}
    for (const [k, envKey] of Object.entries(ch.secret_refs ?? {})) {
      const v = env[envKey]
      if (!v) return null
      out[k] = v
    }
    return out
  }

  return {
    now: () => new Date(),
    claimEvents: (n) => storage.claimEvents(pool, n),
    markEvent: (ev, st) => storage.markEvent(pool, ev, st),
    listRules: (org) => storage.listRules(pool, org),
    getEventDecl,
    getPublishedTemplate: (org, key) => storage.getPublishedTemplate(pool, org, key),
    getChannel: (org, id) => storage.getChannel(pool, org, id),
    claimDueDeliveries: (n) => storage.claimDueDeliveries(pool, n),
    insertDelivery: (row) => storage.insertDelivery(pool, row),
    insertAttempt: (d, r) => storage.insertAttempt(pool, d, r),
    markDeliverySent: (d) => storage.markDeliverySent(pool, d),
    markDeliveryFailed: (d, msg, at) => storage.markDeliveryFailed(pool, d, msg, at),
    markDeliveryDead: (d, msg) => storage.markDeliveryDead(pool, d, msg),
    resolveScopeHolders: async (org, key, decl) => {
      const r = decl.recipients[key]
      if (r?.kind !== 'scope_holders' || !r.scope) return []
      if (!resolveScopeHolderNames) {
        console.warn(`[notify] scope_holders 未注入解析器，跳过 recipient=${key}`)
        return []
      }
      return resolveScopeHolderNames(org, r.scope)
    },
    resolveDeptMembers: deptMembers ?? addresses.resolveDeptMembers?.bind(addresses),
    // 审计三数落 notify.audit（actor 固定 'system:notify-worker'：这不是人做的动作）
    audit: (org, action, target, detail) => audit(pool, org, 'system:notify-worker', action, target, detail),
    resolveAddress: (input) => addresses.resolve(input),
    isCoolingDown: (org, rule, recipient, now) =>
      storage.isCoolingDown(pool, org, rule, recipient, now),
    channelRateLimited: async (org, channel) => {
      const ch = await storage.getChannel(pool, org, channel)
      const limit = typeof ch?.config.rate_limit_per_min === 'number'
        ? ch.config.rate_limit_per_min
        : 0
      if (limit <= 0) return null
      const sent = await storage.countChannelSends(pool, org, channel, 60)
      const v = rateLimitVerdict(sent, limit)
      return v.allow ? null : v.retryAfterMs
    },
    send: async (d) => {
      const ch = await storage.getChannel(pool, d.org, d.channel)
      if (!ch || !ch.enabled) {
        return { ok: false, kind: 'permanent', code: 'channel_missing', summary: 'channel not found/disabled' }
      }
      const secrets = secretsOf(ch)
      if (!secrets) {
        return { ok: false, kind: 'permanent', code: 'secret_missing', summary: 'secret_refs 指向的 env 未配置' }
      }
      if (ch.provider === 'in_app') {
        return sendInApp({
          pool,
          org: d.org,
          recipient: d.recipient,
          eventId: d.eventId,
          eventKey: d.eventKey,
          templateKey: d.templateKey,
          revision: d.revision,
          rendered: d.rendered as { title: string; body: string; link?: string },
        })
      }
      if (ch.provider === 'wecom_chat') {
        return sendWecom({
          bridgeUrl: secrets.bridge_url,
          to: d.address,
          content: d.rendered.text ?? '',
        })
      }
      if (ch.provider === 'webhook') {
        return sendWebhook({
          url: secrets.url,
          secret: secrets.key,
          payload: {
            eventId: d.eventId,
            eventKey: d.eventKey,
            recipient: d.recipient,
            templateKey: d.templateKey,
            revision: d.revision,
            rendered: d.rendered,
          },
          timeoutMs: typeof ch.config.timeout_ms === 'number' ? ch.config.timeout_ms : undefined,
          resolveHost,
        })
      }
      return { ok: false, kind: 'permanent', code: 'provider_unsupported', summary: ch.provider }
    },
  }
}

/** 跑一轮并写心跳（供 CLI 与测试复用）。 */
export async function runOnceCli(
  pool: Pool,
  getEventDecl: EventDeclLoader,
  env: NodeJS.ProcessEnv = process.env,
  resolveScopeHolderNames?: ScopeHolderLoader,
  deptMembers?: ChannelAddressResolver['resolveDeptMembers'],
): Promise<WorkerStats> {
  const stats = await runOnce(
    buildWorkerDeps(pool, getEventDecl, env, undefined, resolveScopeHolderNames, deptMembers),
  )
  await pool.query(
    `insert into notify.worker_heartbeat(id,beat_at) values ('notify-worker',now())
     on conflict (id) do update set beat_at=now()`,
  )
  return stats
}
