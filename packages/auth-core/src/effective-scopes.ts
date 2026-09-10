// effectiveScopes：「权限直挂用户 ∪ 角色关联」的 effective 计算唯一权威实现。
// 语义移植自旧仓 gateway/sso-shell.js:198-226 fetchUserScopes（生产验证版）——
// 历史坑：fetchUserScopes 曾因角色比较全等语义恒 false 踩坑，故短名/全形两种匹配都必须命中
// （perms.users / perms.roles 里存的是 `org/xxx` 全形，调用方可能只传短名）。
// 去重排序复用 normalizeScopes（唯一拷贝纪律，不另写一份）。
import { normalizeScopes } from './normalize-scopes'

// 短名/全形匹配：pu 直接含 name，或 pu 中存在 `org/name` 全形（以 `/name` 结尾）
function matchUser(pu: string[], name: string): boolean {
  return pu.includes(name) || pu.some((u) => u.endsWith('/' + name))
}

// 角色交集：双向短名/全形——perms.roles 可能 `org/role` 全形而用户 roles 短名，反之亦然
function matchRoles(userRoles: string[], permRoles: string[]): boolean {
  return userRoles.some((ur) =>
    permRoles.some((pr) => ur === pr || ur.endsWith('/' + pr) || pr.endsWith('/' + ur)),
  )
}

export function effectiveScopes(
  userName: string,
  roles: string[],
  perms: Array<{ users?: string[]; roles?: string[]; resources?: string[] }>,
): string[] {
  const hit = perms.filter(
    (p) => matchUser(p.users ?? [], userName) || matchRoles(roles, p.roles ?? []),
  )
  return normalizeScopes({ permissions: hit })
}
