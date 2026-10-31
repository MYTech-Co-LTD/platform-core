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
