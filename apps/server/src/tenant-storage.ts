// tenant-storage.ts — 租户行 → 模块可用的存储配置（**纯函数、零 IO**）。
//
// 为什么是宿主做投影而不是模块自己去查租户行：B1（模块只许自身 schema）+ 正典「安全性质」第 1 条
// （模块没有任何途径指定 org）。宿主是唯一能同时看见 `platform.tenant` 与模块上下文的地方。
//
// 零额外 DB 往返：租户行本来就已被请求链的租户中间件取过（apps/server/src/tenant.ts 的 `select t.*`），
// 这里只是把它**投影**成窄值 —— 不 new 连接、不发查询。
import { platformStorageFromEnv, type TenantStorageConfig } from '@platform/sdk'
import type { TenantRow } from './tenant'

/**
 * 本任务（正典步 2）只有平台默认分支：租户行上还没有配置列可读。
 * T5 会补上「租户行优先、env 兜底」的三态判定（全空 / 部分填 / 全填）——**只改这一个函数**。
 */
export function resolveTenantStorage(_row: TenantRow | undefined): TenantStorageConfig | undefined {
  return platformStorageFromEnv(process.env) ?? undefined
}
