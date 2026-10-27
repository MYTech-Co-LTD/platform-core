// scope-holders.ts — 把 Casdoor「权限码持有者」算成收件人（宿主侧，worker 用）。
// 为什么在 apps/server：它要 Casdoor 客户端 + 展开角色，模块层（B1）两样都拿不到。
//
// 复用 @platform/auth-core 的 collectHolders（直挂 ∪ 角色展开）——与审计脚本**同一口径**，
// 别再写第二份（审计脚本曾因「只读 users[] 漏掉角色授予」踩过一次，见 #1121/#1122）。
import type { CasdoorClient } from '@platform/auth-core'
import { collectHolders } from '@platform/auth-core'

export type ScopeHolderResolver = (
  org: string,
  permissionCode: string,
) => Promise<string[]>

/**
 * 造一个「按 (org, 权限码) 列持有者」的解析器。
 *
 * - `casdoorFor(org)` 与宿主装载期/权限供给用的是**同一个工厂**（同一份 admin 会话语义）；
 * - 结果按 org 内短名归一（Casdoor 可能存 `org/alice`）；
 * - **失败抛错**：调用方（worker）必须把「解析不出来」与「没有人持有」区分开——
 *   前者不能让通知静默发成 0 收件人。
 */
export function createScopeHolderResolver(
  casdoorFor: (org: string) => CasdoorClient,
  cacheTtlMs = 60_000,
): ScopeHolderResolver {
  const cache = new Map<string, { at: number; names: string[] }>()

  return async (org, permissionCode) => {
    const key = `${org}\u0000${permissionCode}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < cacheTtlMs) return hit.names

    const client = casdoorFor(org)
    const [perms, roles] = await Promise.all([client.getPermissions(), client.listRoles()])
    const holders = collectHolders(perms, roles, permissionCode)
    const names = [...new Set([
      ...holders.direct,
      ...holders.viaRole.map((x: { user: string }) => x.user),
    ])].sort()

    cache.set(key, { at: Date.now(), names })
    return names
  }
}
