// @ts-check
// audit-permission-holders-lib.mjs — 审计脚本的**薄入口**。
//
// 「权限码 → 持有者」的权威实现在 `packages/auth-core/src/permission-holders.ts`
// （宿主 worker 的 `scope_holders` 解析也用它，两边必须同一口径）。
// 本文件只保留**脚本侧特有**的东西：机器身份名单与标注（#1128）。
import { collectHolders, shortName } from '../packages/auth-core/src/public.ts'

export { collectHolders, shortName }

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
