// pipeline.ts — 规则管道编排：匹配 → 解析收件人 → novu.trigger → 落回执。
// 正典 §2.6：**fail-open**——投递失败不阻塞业务；**幂等**——先认领回执再投递，重复 emit 不双发。
import type { Pool } from 'pg'
import { matchRules, type NotificationRule } from './domain/rules'
import { trigger, type NovuResolver } from './domain/novu'
import { claimDelivery, listRules, markDeliveryFailed } from './storage'

export type EmitInput = {
  org: string
  eventId: string // 确定性 event_id：业务转移一次一枚（幂等去重键）
  eventType: string
  mount: string
  payload: Record<string, unknown>
}

export type EmitResult = { matched: number; delivered: number; failed: number }

function asIds(v: unknown): string[] {
  if (typeof v === 'string' && v.length > 0) return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return []
}

/**
 * 解析收件人 → subscriberId 列表。
 * v1 payload 键约定（payload schema 由**触发源**负责，§15 已定 case-engine 解析 assignee）：
 *   assignee → `payload.assignee`；submitter → `payload.submitter`；
 *   user_list / field → `payload[recipientArg]`（字符串或字符串数组）。
 * 跨租户引用（§2.6 鉴权钉死②）由触发源在解析时保证只给本 org 用户；本层不再查。
 */
function resolveRecipients(rule: NotificationRule, payload: Record<string, unknown>): string[] {
  switch (rule.recipient) {
    case 'assignee':
      return asIds(payload.assignee)
    case 'submitter':
      return asIds(payload.submitter)
    case 'user_list':
    case 'field':
      return rule.recipientArg ? asIds(payload[rule.recipientArg]) : []
  }
}

/**
 * 入口 A（事件驱动）与入口 B（定时驱动）共用此管道。
 * 返回计数而非抛出：投递失败已落回执（fail-open）。**DB 异常会抛**——由调用边界（routes）兜，
 * 边界层不得让通知失败阻塞业务。
 */
export async function emit(deps: { pool: Pool; novu: NovuResolver }, input: EmitInput): Promise<EmitResult> {
  const rules = await listRules(deps.pool, input.org)
  const matched = matchRules(rules, { eventType: input.eventType, mount: input.mount })

  // §2.6 方案 A：凭据按 input.org 解析（`NOVU_API_KEY__<ORG>` → 全局回落 → null = 未开通）。
  // 一次 emit 只解析一次：org 在本调用内恒定；null 也**不抛**，逐条回执记 failed。
  const novu = deps.novu(input.org)

  let delivered = 0
  let failed = 0

  for (const rule of matched) {
    for (const subscriberId of resolveRecipients(rule, input.payload)) {
      // ① 先认领（幂等去重）：撞 (org,event_id,rule_id) ⇒ 已被处理过 ⇒ 跳过，不双发。
      const claimed = await claimDelivery(deps.pool, input.org, {
        ruleId: rule.id,
        eventId: input.eventId,
        eventType: input.eventType,
        recipient: subscriberId,
        template: rule.templateId,
      })
      if (!claimed) continue

      // ② 投递：客户端未配置（缺 env）视同投递失败（fail-open，不抛）。
      if (novu === null) {
        await markDeliveryFailed(deps.pool, input.org, input.eventId, rule.id, 'novu not configured')
        failed++
        continue
      }
      const res = await trigger(novu, {
        templateId: rule.templateId,
        subscriberId,
        payload: input.payload,
      })
      if (res.ok) {
        delivered++
      } else {
        await markDeliveryFailed(deps.pool, input.org, input.eventId, rule.id, res.error)
        failed++
      }
    }
  }

  return { matched: matched.length, delivered, failed }
}
