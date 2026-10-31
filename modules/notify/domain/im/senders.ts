// im/senders.ts — 出站渠道的**统一发送契约**（spec 2026-10-31-multi-channel-im-provider-design.md §3.1）。
//
// 本轮只**留架构空间**（用户 2026-10-31 定：「只需要留出架构空间，暂时还不做其他 provider」）：
// 把 worker 里原来那段 if 链收敛成「一个 provider 一张表」，行为**逐字不变**。
// 加飞书/钉钉时的增量 = 写一个 sender + 在 SENDERS 注册 + 模板加一个渲染键，
// 不需要再动 worker 的编排逻辑。
//
// 刻意不做（等真有第二个 provider 再定，避免提前抽象）：
//   · 不引入 `ImProvider` 的 token/send/probe 三段式接口——现有三个 sender 的入参差异很大
//     （in_app 落库、webhook 要 DNS 守卫、wecom 走桥），硬统一个形状会造出一堆可选字段；
//   · 不做凭据表 / KEK 加密——那是「直连某渠道」时才需要的（spec §3.2），没有直连就没有消费者。
//
// 统一形状：`(ctx, delivery) => Promise<ProviderResult>`，ctx 携带**provider 无关**的投递上下文。
import type { Pool } from 'pg'
import { sendInApp } from '../../providers/in-app'
import { sendWebhook } from '../../providers/webhook'
import { sendWecom } from '../../providers/wecom'
import type { NotifyProvider } from '../providers'
import { sendDirect } from './wecom-direct'
import type { WecomDirectCred } from './wecom-direct'

export type ProviderResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

/** 一条投递（worker 侧的最小形状，避免本文件依赖 storage 的完整行类型）。 */
export interface DeliveryLike {
  org: string
  eventId: string
  eventKey: string
  recipient: string
  address: string
  templateKey: string
  revision: number
  rendered: Record<string, unknown>
}

/** provider 无关的发送上下文（通道配置 + 已解析密钥 + 宿主能力）。 */
export interface SendContext {
  pool: Pool
  channelId: string
  /** 非敏感配置（rate_limit 等之外的 provider 专用项，如 webhook 的 timeout_ms） */
  config: Record<string, unknown>
  /** `secret_refs` 解析出来的值（键 → env 值） */
  secrets: Record<string, string>
  /** webhook 的 DNS 守卫（宿主注入；缺省 = 真 lookup） */
  resolveHost?: (host: string) => Promise<string[]>
  /** 测试缝：所有 provider 的 HTTP 走它（缺省 = 全局 fetch） */
  fetchImpl?: typeof fetch
  /**
   * 企微直连凭据（已解密）。`transport==='direct'` 时由调用方解析后传入；
   * 缺省 ⇒ 走共享桥（与改造前逐字一致）。
   */
  credential?: WecomDirectCred
}

export type ImSender = (ctx: SendContext, d: DeliveryLike) => Promise<ProviderResult>

const SENDERS: Record<NotifyProvider, ImSender> = {
  in_app: (ctx, d) =>
    sendInApp({
      pool: ctx.pool,
      org: d.org,
      recipient: d.recipient,
      eventId: d.eventId,
      eventKey: d.eventKey,
      templateKey: d.templateKey,
      revision: d.revision,
      rendered: d.rendered as { title: string; body: string; link?: string },
    }),
  // 企微：**有直连凭据就直连，否则走共享桥**（transport 由通道 config 决定，默认 bridge）。
  // 直连的意义：凭据只在客户自己的实例里、判据=能取到 token（桥的 /healthz 只能证明桥活着）。
  wecom_chat: (ctx, d) =>
    ctx.credential !== undefined
      ? sendDirect({
        cred: ctx.credential,
        to: d.address,
        content: (d.rendered.text as string | undefined) ?? '',
        fetchImpl: ctx.fetchImpl,
      })
      : sendWecom({
        bridgeUrl: ctx.secrets.bridge_url,
        to: d.address,
        content: (d.rendered.text as string | undefined) ?? '',
        fetchImpl: ctx.fetchImpl,
      }),
  webhook: (ctx, d) =>
    sendWebhook({
      url: ctx.secrets.url,
      secret: ctx.secrets.key,
      payload: {
        eventId: d.eventId,
        eventKey: d.eventKey,
        recipient: d.recipient,
        templateKey: d.templateKey,
        revision: d.revision,
        rendered: d.rendered,
      },
      timeoutMs: typeof ctx.config.timeout_ms === 'number' ? ctx.config.timeout_ms : undefined,
      resolveHost: ctx.resolveHost,
      fetchImpl: ctx.fetchImpl,
    }),
}

/** 分发：provider 表里没有 ⇒ 永久失败（与改造前的 `provider_unsupported` 同码同文案）。 */
export async function dispatchSend(provider: string, ctx: SendContext, d: DeliveryLike): Promise<ProviderResult> {
  const sender = SENDERS[provider as NotifyProvider]
  if (sender === undefined) {
    return { ok: false, kind: 'permanent', code: 'provider_unsupported', summary: provider }
  }
  return sender(ctx, d)
}
