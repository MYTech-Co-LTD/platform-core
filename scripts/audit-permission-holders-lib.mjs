// @ts-check
// audit-permission-holders-lib.mjs — 纯逻辑：把 Casdoor 权限码的持有者算全。
//
// 平台的有效权限 = 用户直挂 ∪ 角色关联（packages/auth-core/src/effective-scopes.ts）。
// 审计脚本原先只读权限记录的 users[]，通过角色授予的码会被静默漏报——本文件补上角色展开。
// 纯函数、零 IO：CLI 与单测共用。

/**
 * @typedef {{ name: string, users?: string[] }} AuditRole
 * @typedef {{ users?: string[], roles?: string[], resources?: string[] }} AuditPermission
 * @typedef {{ direct: string[], viaRole: Array<{ user: string, roles: string[] }> }} Holders
 */

/**
 * 平台自建 / 机器身份名单（2026-10-27 拍板：账号来源三分）。
 *
 * 人员的账号唯一来源是**企微通讯录同步**；下列名字不是人，不该按「同步名单外的账号」处理：
 *   · `tenantsub` —— 每 org 的订阅锚用户（Casdoor 内建，禁登）
 *   · `casdoor-user-1` —— case-engine 的「Case 决策门审批人」占位账号（外部系统直连 Casdoor 建，
 *     `platform.audit` 与 `platform.identity_link` 均无记录，2026-10-27 实测）
 *
 * ⚠️ **标注而非隐藏**：审计输出必须把它们列出来并打上 `[服务账号]` 标记，方便人工确认
 * 「这是机器身份，不是漏同步的真人」。静默过滤 = 又造一个盲区（同 #1121 的教训）。
 */
export const SERVICE_ACCOUNTS = new Set(['tenantsub', 'casdoor-user-1'])

/**
 * 该 holder 是否平台自建 / 机器身份。
 * @param {string} user
 * @returns {boolean}
 */
export function isServiceAccount(user) {
  return SERVICE_ACCOUNTS.has(shortName(user))
}

/**
 * Casdoor 的 users/roles 可能存短名（`alice`）或全形（`org/alice`）；审计按 org 内唯一名归一。
 * @param {string} id
 * @returns {string}
 */
export function shortName(id) {
  const s = String(id)
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s
}

/**
 * 一个权限码的全部持有者：直接用户 ∪ 角色成员。
 *
 * - **多条权限记录**取并集（历史 upsert 可能留下同名多条）；
 * - 直接持有优先：既是直挂又在角色里，只记 direct；
 * - `viaRole` 保留角色来源，便于人工判断该不该收。
 *
 * @param {readonly AuditPermission[]} perms
 * @param {readonly AuditRole[]} roles
 * @param {string} code
 * @returns {Holders}
 */
export function collectHolders(perms, roles, code) {
  /** @type {Map<string, string[]>} */
  const roleUsers = new Map()
  for (const r of roles) {
    const members = (r.users ?? []).map(shortName)
    for (const name of new Set([r.name, shortName(r.name)])) {
      roleUsers.set(name, members)
    }
  }

  const direct = new Set()
  /** @type {Map<string, Set<string>>} */
  const viaRole = new Map()
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
