// providers.ts — 通知通道 provider 的**唯一代码事实源**（spec 2026-10-31-integration-health §2.5）。
//
// 为什么单独抽一个文件：provider 目前有三处事实源——DB 的 check 约束（migrations/002）、
// worker 的发送分发（worker-deps.ts）、控制台的选项。门禁 `check-integrations` 要能回答
// 「新增 provider 有没有登记活性判据」，就必须有一个代码侧可枚举的清单（SQL 里的 check
// 约束文本没法可靠解析）。**新增 provider = 改这里 + 改迁移 + 登记 registry**，门禁会把
// 第三条漏掉的情况拦下来。
//
// ⚠️ 与迁移 002 的 `check (provider in (...))` 必须同步：加 provider 时两处一起改，
//    `check-integrations` 会读本文件、读不到迁移，所以迁移侧的漂移靠评审与 DB 报错兜底。
export const NOTIFY_PROVIDERS = ['wecom_chat', 'in_app', 'webhook'] as const

export type NotifyProvider = (typeof NOTIFY_PROVIDERS)[number]

/**
 * 该 provider 是否**必须**先解析出「收件人地址」才能发。
 *
 * - `wecom_chat`：要企微 userid，解析不到 = `missing_channel_address`（dead）；
 * - `in_app`：收件箱按用户名查，地址就是用户名，不需要外部地址；
 * - `webhook`：目标是通道 URL，payload 里带 recipient 即可，**不需要**每收件人地址。
 *
 * 这张表是 worker / HTTP test-send / MCP send_test 三处的唯一判据——此前三处各写
 * `provider !== 'in_app'`，导致 webhook 投递在 worker 里恒判 `missing_channel_address`。
 */
export const PROVIDER_REQUIRES_ADDRESS: Record<NotifyProvider, boolean> = {
  wecom_chat: true,
  in_app: false,
  webhook: false,
}

/** 未知 provider 保守按“需要地址”处理；发送侧会先报 `provider_unsupported`。 */
export function providerRequiresAddress(provider: string): boolean {
  return PROVIDER_REQUIRES_ADDRESS[provider as NotifyProvider] ?? true
}
