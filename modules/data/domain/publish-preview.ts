// publish-preview.ts — 发布前「谁能看到」的预览（R6）。
//
// 为什么：发布是一次不可逆的可见面变化（生成快照后独立链接立即按这一版的门判权）。
// 发布人在点确认之前应该看到：这次发布后**哪些人**能看到——而不是发布完再被问「怎么别人也看见了」。
//
// 边界：这里只解释**已配置的门**（visibility / requiredScope / requiredDepts / ACL），
// 不查 Casdoor 成员列表（那是运行期解析，且可能很大）。预览回答「规则是什么、宽窄如何」。
import type { AclRow } from './asset-auth'

export interface ExposureSummary {
  /** 可见面的主判据：tenant = 全租户；acl = 仅名单；scope = 页门（叠加在 tenant/acl 之上）。 */
  audience: 'tenant' | 'acl'
  summary: string
  warnings: string[]
}

export function summarizeExposure(input: {
  visibility: 'tenant' | 'restricted'
  /** 已派生的页门（deriveRequiredScope 的结论）；未知/冲突时由调用方传 null。 */
  requiredScope: string | null
  requiredDepts: readonly string[]
  acl: readonly AclRow[]
}): ExposureSummary {
  const warnings: string[] = []
  const audience: 'tenant' | 'acl' = input.visibility === 'tenant' ? 'tenant' : 'acl'
  const aclViewers = input.acl
  const depts = input.requiredDepts.filter((d) => d !== '')

  const parts: string[] = []
  parts.push(audience === 'tenant' ? '本租户所有持 data:query 的成员' : `仅共享名单（${aclViewers.length} 人/部门/角色）`)
  if (input.requiredScope !== null) parts.push(`且需具备 ${input.requiredScope}`)
  if (depts.length > 0) parts.push(`且属于 ${depts.length} 个部门（含子部门）`)
  const summary = `发布后可见：${parts.join('，')}。`

  // 只在「确实宽」或「确实窄到异常」时提示，避免每次发布都刷一屏。
  if (audience === 'tenant' && input.requiredScope === null && depts.length === 0) {
    warnings.push('这是最宽的可见面：全租户可见，且没有页门与部门门')
  }
  if (audience === 'acl' && aclViewers.length === 0) {
    warnings.push('共享名单为空：发布后只有所有者能看到')
  }
  if (input.requiredScope === null) {
    warnings.push('未派生页门：持 data:query 即可打开')
  }
  if (depts.length === 0) {
    warnings.push('未配置部门门：不按部门限制')
  }
  return { audience, summary, warnings }
}
