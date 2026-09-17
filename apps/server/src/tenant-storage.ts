// tenant-storage.ts — 租户行 → 模块可用的存储配置（**纯函数、零 IO**）。
//
// 为什么是宿主做投影而不是模块自己去查租户行：B1（模块只许自身 schema）+ 正典「安全性质」第 1 条
// （模块没有任何途径指定 org）。宿主是唯一能同时看见 `platform.tenant` 与模块上下文的地方。
//
// 零额外 DB 往返：租户行本来就已被请求链的租户中间件取过（apps/server/src/tenant.ts 的 `select t.*`），
// 这里只是把它**投影**成窄值 —— 不 new 连接、不发查询。
import { normalizeEndpoint, platformStorageFromEnv, type TenantStorageConfig } from '@platform/sdk'
import type { TenantRow } from './tenant'

/**
 * 三态判定（正典兜底表，**照抄不许改**）：
 *   全空     ⇒ 平台默认（env 五键；缺任一 ⇒ undefined = 「没有平台默认」）
 *   部分填写 ⇒ **undefined**（不注入）。⚠️ 绝不回落平台桶 —— 回落不是容错，是**把红改成绿**：
 *              租户以为附件落在自己的桶、实际落在平台桶 ⇒ 数据位置被误述 + 平台替租户承担成本。
 *  全填     ⇒ 该租户的配置。
 *
 * 「空」的判据包含 `null` / `''` / 纯空白（管理端表单与手改库都容易留下这些）——统一 trim 后判空，
 * 且 **trim 后的值才进配置**（粘进一个尾随空格不该让 endpoint 变成另一个主机名）。
 */
export function resolveTenantStorage(row: TenantRow | undefined): TenantStorageConfig | undefined {
  const platformDefault = platformStorageFromEnv(process.env) ?? undefined
  if (!row) return platformDefault

  const raw = [row.storage_endpoint, row.storage_region, row.storage_bucket,
    row.storage_access_key, row.storage_secret].map((v) => (v ?? '').trim())
  const filled = raw.filter((v) => v !== '').length
  if (filled === 0) return platformDefault        // 未配 ⇒ 平台默认
  if (filled < raw.length) return undefined       // 部分填写 ⇒ 不注入（fail-explicit）

  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = raw as [string, string, string, string, string]
  return { kind: 's3', endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}
