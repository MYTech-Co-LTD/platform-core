// dept-gate.ts — 报表部门门（spec 2026-10-30 §3.4，#1173 Phase B）。
//
// D-O3 子树继承：授权「共享中心(49)」⇒ 数字技术部(57) 成员自动可见——实现靠 org_node 的
// 物化 path（"49.57"）拆段即得祖先链，无需递归查询。
// D-O4 叠加不替代：部门门只做 scope 门之上的行级收窄，本文件不读 scopes。
//
// 为什么在**请求时**解析用户部门（而非 spec 初稿的「会话刷新时进 payload」）：
// /reports 的观看面有三条通道（session/pat/wecom），只有 session 走会话刷新——
// 部门集进 payload 对 pat/wecom 通道结构性缺位。请求时一次索引查询（org_membership
// 按 (tenant_id, user_name) 主键前缀）对三条通道同形，且免动会话签名/兼容红线。
// 量级：个位数部门/人，272 节点租户。
import type { Pool } from 'pg'

/**
 * 用户部门闭包（本人部门 + 全部祖先）。org 表无该用户 ⇒ 空集（部门门对空集=拒，fail-closed）。
 *
 * `userNames` 收**候选名数组**而不是单个名字，因为通道之间的人标识不是同一个键：
 * 会话通道 `identity.userId` = 会话 `sub`（企微登录下即 Casdoor name，与 org_membership 同键），
 * 微信 OA 访客 `sub` = openid（Casdoor name 在 `accountName`），PAT 通道则是签发者主体。
 * 由调用方按 `[accountName, userId]` 给出候选，这里取并集——查两行与查一行成本同阶，
 * 比「猜哪个通道用哪个键」稳。
 */
export async function userDeptClosure(
  pool: Pool, tenantId: number, userNames: string | readonly string[],
): Promise<Set<string>> {
  const names = typeof userNames === 'string' ? [userNames] : [...new Set(userNames)]
  if (names.length === 0) return new Set()
  const r = await pool.query(
    `select n.path
       from platform.v_org_membership m
       join platform.v_org_node n on n.tenant_id = m.tenant_id and n.ext_id = m.ext_id and n.status = 1
      where m.tenant_id = $1 and m.user_name = any($2::text[])`,
    [tenantId, names],
  )
  const out = new Set<string>()
  for (const row of r.rows as Array<{ path: string }>) {
    // path "49.57" ⇒ 祖先链 49、57 都入集（含自身部门）
    for (const seg of row.path.split('.')) if (seg !== '') out.add(seg)
  }
  return out
}

/**
 * 请求者 → org 表的候选用户键（顺序即查询顺序，去重）。
 * `accountName`（Casdoor name，账户统一设计的正式态身份）优先——org_membership 就是按它灌的；
 * 中间态 / 旧形状会话没有 `acct`，退回 `userId`（企微登录下两者同值）。
 */
export function deptNamesOf(requester: { userId: string; accountName?: string }): string[] {
  const ids = [requester.accountName, requester.userId]
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))]
}

/** 部门门判定（纯函数）。requiredDepts 为 null = 无门；交集非空 = 放行。 */
export function deptGatePasses(
  requiredDepts: string[] | null | undefined,
  userDepts: ReadonlySet<string>,
): boolean {
  if (requiredDepts === null || requiredDepts === undefined || requiredDepts.length === 0) return true
  return requiredDepts.some((d) => userDepts.has(d))
}

/** 配置期校验：部门门里的 ext_id 必须都存在于本租户 org 表（活节点）。
 *  org 表空（未同步）⇒ 拒配部门门（配了也恒拒，fail-closed 在配置期拦）。 */
export async function validateDeptGate(
  pool: Pool, tenantId: number, requiredDepts: string[] | null,
): Promise<{ ok: true } | { ok: false; code: 'ORG_NOT_SYNCED' | 'UNKNOWN_DEPT'; unknown?: string[] }> {
  if (requiredDepts === null || requiredDepts.length === 0) return { ok: true }
  const r = await pool.query(
    'select ext_id from platform.v_org_node where tenant_id = $1 and status = 1',
    [tenantId],
  )
  const known = new Set((r.rows as Array<{ ext_id: string }>).map((x) => x.ext_id))
  if (known.size === 0) return { ok: false, code: 'ORG_NOT_SYNCED' }
  const unknown = [...new Set(requiredDepts)].filter((d) => !known.has(d))
  if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_DEPT', unknown }
  return { ok: true }
}
