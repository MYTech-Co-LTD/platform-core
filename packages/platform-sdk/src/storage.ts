// storage.ts — 租户存储配置的**纯函数**面：规范化、配置标识、平台默认。
//
// 为什么这三样进 SDK 而不是各写一份：`storage_ref`（行上记的「写入当时的配置标识」）是
// **宿主与模块之间的字符串契约** —— 宿主拿它写、模块拿它比。两处各实现一次 = 两份事实源，
// 而失败形态是**静默的**（ref 永远匹配不上 ⇒ 存量附件全部读不出，平台侧只有一条日志）。
//
// 边界：SDK 只定义**配置的形状、标识与来源**，**不定义客户端**（`ZosStorage` 留在
// modules/aftersales/storage.ts —— spec §2.3「第二个消费者出现再抽公共包」）。
import type { TenantStorageConfig } from './module'

/**
 * 平台默认存储的 env 键。**缺任一 ⇒ 没有平台默认**（等价于「不注入」，见正典的兜底表）。
 *
 * ⚠️ 键名是 `AFTERSALES_ZOS_*`——**模块命名空间**。M3c 的裁定是「五键保留、语义从『唯一来源』
 * 降为『平台默认』」，故此处照裁定冻结键名；但从此宿主也要读它们，**第二个声明 `storage`
 * 的模块出现时，「平台默认」就变成了「aftersales 的默认」**。这是已知命名债，记账在此：
 * 改名 = 改协议 + 改 .env.example + 改 openship env，属**单独决定**（待拍板 3 → (A)：**保持键名**，2026-09-17）。
 * 收进 SDK 一处是为了消灭「宿主一套、模块一套」的双实现漂移——债的**范围**不减，但**漂移面**归零。
 */
export const PLATFORM_STORAGE_ENV_KEYS = [
  'AFTERSALES_ZOS_ENDPOINT',
  'AFTERSALES_ZOS_REGION',
  'AFTERSALES_ZOS_BUCKET',
  'AFTERSALES_ZOS_ACCESS_KEY',
  'AFTERSALES_ZOS_SECRET',
] as const

/** endpoint 可能没写协议 ⇒ 补 https://；顺带吃掉首尾空白与尾斜杠（正典要求注入值是「已规范化」的）。 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * 配置标识 = `storage_ref` 的值。**只用于相等比较**（从不拆开解析）。
 *
 * 三个字段的取法：
 *  · `kind` —— 目前只有 `s3`，带上它是**廉价的去歧义**（第二个 kind 出现时不会与 s3 撞串）；
 *  · `endpoint` —— 已规范化（`normalizeEndpoint` 之后），故同一配置的不同写法收敛成同一串；
 *  · `bucket` —— S3 桶名不含 `|`，URL 也不含裸 `|` ⇒ `|` 是无歧义分隔符。
 * **故意不含 region / AK / SK**：裁定②定的最小可用是「bucket + endpoint」；纳入 AK 会让
 * AK 轮换使存量行失去归属，而那是**数据面**的伤害，不该由标识符承担。
 */
export function storageRefOf(cfg: Pick<TenantStorageConfig, 'kind' | 'endpoint' | 'bucket'>): string {
  return `${cfg.kind}|${cfg.endpoint}|${cfg.bucket}`
}

/**
 * 平台默认配置（进程 env 五键）。**五键缺任一（或为空串）⇒ `null`** —— 「没有平台默认」
 * 是一个**确定状态**，宿主据此不 set、模块据此拿不到（与今天 `zosConfigFromEnv` 的语义逐字同款）。
 */
export function platformStorageFromEnv(
  env: Record<string, string | undefined>,
): TenantStorageConfig | null {
  const values = PLATFORM_STORAGE_ENV_KEYS.map((k) => env[k])
  if (values.some((v) => v === undefined || v === '')) return null
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values as [string, string, string, string, string]
  return { kind: 's3', endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}
