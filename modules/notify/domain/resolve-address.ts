// resolve-address.ts — 「收件人 → 渠道地址」的**唯一实现**（spec 2026-10-31 §3.3）。
//
// 为什么要有它：兜底逻辑（`address_fallback === 'casdoor_name'` 时把名字当企微 userid）
// 原来在 `worker.ts` / `routes.ts` / `mcp.ts` **三处各写了一遍同样的三元表达式**。
// 三份同款代码 = 三份会各自漂移的语义：改一处、另两处照旧是这类 bug 的经典形状
// （对照 #1179：scope_holders 在两个入口结论不一致那次）。
//
// 职责边界：
//   · **显式解析**在宿主（`apps/server/src/channel-address.ts` 的 `resolve`）——它看得到 org 表；
//   · **兜底**在这里——它看得到通道配置（`config.address_fallback`），而宿主按 B1 不许读 notify schema。
//
// 兜底**不静默**：每次走兜底都打一条结构化 warn（`address_fallback_used`），
// 这样「谁还在靠猜发消息」在日志里可查，而不是等某条消息发丢了才发现。
export type AddressResolution = { org: string; provider: string; casdoorName: string }

export type AddressResolver = (input: AddressResolution) => Promise<string | null>

export interface ChannelLike {
  provider: string
  config?: Record<string, unknown> | null
}

/**
 * 解析投递地址：显式解析 → 兼容兜底（仅 `address_fallback==='casdoor_name'` 且为企微）→ null。
 *
 * 返回 `null` 的语义由调用方决定（现状：`missing_channel_address` 落 `dead`，不重试）。
 */
export async function resolveDeliveryAddress(
  resolver: AddressResolver | undefined,
  channel: ChannelLike,
  input: { org: string; casdoorName: string },
): Promise<string | null> {
  const explicit = resolver
    ? await resolver({ org: input.org, provider: channel.provider, casdoorName: input.casdoorName })
    : null
  if (explicit) return explicit

  // in_app 的「地址」就是用户名本身（收件箱按人查）——宿主的 resolve 也是这么回的，
  // 这里再写一遍是为了**解析器没注入时**（routes/mcp 的可选依赖）行为不漂移。
  if (channel.provider === 'in_app') return input.casdoorName

  if (channel.provider === 'wecom_chat' && channel.config?.address_fallback === 'casdoor_name') {
    console.warn(JSON.stringify({
      event: 'address_fallback_used',
      org: input.org,
      provider: channel.provider,
      casdoorName: input.casdoorName,
    }))
    return input.casdoorName
  }
  return null
}
