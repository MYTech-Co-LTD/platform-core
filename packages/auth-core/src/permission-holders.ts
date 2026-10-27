// permission-holders.ts — 「权限码 → 持有者」的唯一权威实现。
// 与 effectiveScopes（用户 → 码）互为反面；两处口径必须一致：
//   有效权限 = 用户直挂 ∪ 角色关联（历史坑见 effective-scopes.ts 头注：短名/全形都要命中）。
//
// 为什么需要它：通知层要按「谁能审批」找收件人（`scope_holders`），而权限记录里既有
// 直挂 users[] 也有 roles[]——只读 users[] 会漏掉角色授予（issue #1121 踩过）。
// 正典函数放这里，审计脚本（scripts/audit-permission-holders-lib.mjs）与宿主解析器共用。

export type HolderPermission = { users?: string[]; roles?: string[]; resources?: string[] }
export type HolderRole = { name: string; users?: string[] }
export type Holders = {
  direct: string[]
  viaRole: Array<{ user: string; roles: string[] }>
}

/** Casdoor 可能存短名（`alice`）或全形（`org/alice`）；按 org 内唯一名归一。 */
export function shortName(id: string): string {
  const s = String(id)
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s
}

/**
 * 一个权限码的全部持有者：直接用户 ∪ 角色成员。
 * - 多条权限记录取并集（历史 upsert 可能留下同名多条）；
 * - 直接持有优先：既是直挂又在角色里，只记 direct；
 * - `viaRole` 保留角色来源，便于人工判断该不该收。
 */
export function collectHolders(
  perms: readonly HolderPermission[],
  roles: readonly HolderRole[],
  code: string,
): Holders {
  const roleUsers = new Map<string, string[]>()
  for (const r of roles) {
    const members = (r.users ?? []).map(shortName)
    for (const name of new Set([r.name, shortName(r.name)])) {
      roleUsers.set(name, members)
    }
  }

  const direct = new Set<string>()
  const viaRole = new Map<string, Set<string>>()

  for (const p of perms) {
    if (!(p.resources ?? []).includes(code)) continue
    for (const u of p.users ?? []) direct.add(shortName(u))
    for (const r of p.roles ?? []) {
      const members = [...new Set([r, shortName(r)].flatMap((n) => roleUsers.get(n) ?? []))]
      for (const u of members) {
        const short = shortName(u)
        if (direct.has(short)) continue
        if (!viaRole.has(short)) viaRole.set(short, new Set())
        viaRole.get(short)?.add(r)
      }
    }
  }

  return {
    direct: [...direct].sort(),
    viaRole: [...viaRole]
      .map(([user, rs]) => ({ user, roles: [...rs].sort() }))
      .sort((a, b) => a.user.localeCompare(b.user)),
  }
}
