// notify-port.ts — 宿主侧的 emit 端口：事件目录校验 → 调 notify 模块的 enqueueEvent。
// 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §3.3/§3.4
// 校验面只有这一处：模块只拿宿主包装后的 ctx.notify，不直接拿 notify 的 port。
import { validatePayload } from '@platform/sdk'
import type {
  EnqueueEventInput, EventCatalogReader, Identity, NotifyPort,
} from '@platform/sdk'

export function buildNotifyPort(deps: {
  catalog: EventCatalogReader
  enqueue?: (input: EnqueueEventInput) => Promise<{ accepted: boolean; reason?: string }>
}): NotifyPort {
  return {
    async emit(identity: Identity, input) {
      if (!identity?.orgId) return { accepted: false, reason: 'org_required' }

      const decl = deps.catalog.get(input.eventKey)
      if (!decl) return { accepted: false, reason: 'event_not_declared' }

      if (!input.eventId || input.eventId.trim() === '') {
        return { accepted: false, reason: 'event_id_required' }
      }
      if (!decl.scope && input.scope && input.scope !== '*') {
        return { accepted: false, reason: 'scope_not_declared' }
      }

      const bad = validatePayload(decl, input.payload)
      if (bad) {
        // 对外只给机检码；字段级摘要进日志（fail-open：不阻塞业务，也不把内部形状透给调用方）
        console.warn(`[notify] payload_invalid event=${input.eventKey} detail=${bad}`)
        return { accepted: false, reason: 'payload_invalid' }
      }

      if (!deps.enqueue) return { accepted: false, reason: 'notify_not_loaded' }

      return deps.enqueue({
        org: identity.orgId,
        eventId: input.eventId,
        eventKey: input.eventKey,
        scope: input.scope ?? '*',
        payload: input.payload,
        // 事件 key 的第一段 = manifest.id（manifest schema 强约束），故可作为 producer。
        producer: decl.key.slice(0, decl.key.indexOf('.')),
      })
    },
  }
}
