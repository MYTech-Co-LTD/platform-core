// org-directory.ts — 宿主侧的**组织查询面**（`ModuleContext.org`，计划 T2 / OA spec §5）。
//
// 为什么在宿主而不是模块里：模块读不到 `platform.org_*`（B1：跨 schema 只读必须有显式声明面），
// 而「谁是部门负责人」「谁在子部门里」「某人的主部门是哪个」是审批链编译的基础事实。
// 于是宿主把这几条查询收敛成一个只读 port 注入 —— 模块拿到的是一组**语义**，不是表名。
//
// 与 `channel-address.ts` 的分工（别合并）：那个端口回答「怎么把这个人发到企微」，
// 本端口回答「组织结构长什么样」。共用同一批表，但读者、判据与失败口径都不同。
//
// 口径（与 `packages/platform-sdk/src/module.ts` 的 `OrganizationPort` 注释逐字一致）：
//  ① 全部按 **org（Casdoor org 名）** 解析租户；未知 org ⇒ 空结果，**不抛错**；
//  ② 子树展开只认 `status=1` 的部门（软删部门的人不算在内）；
//  ③ `listDeptLeaders` / `listDeptAdmins` **不展开子树**；
//  ④ 没有 Casdoor 客户端时 `listRoleMembers` 返回空数组（「查不了」，不是「没人」）。
import type { Pool } from 'pg'
import type { OrganizationPort } from '@platform/sdk'

/** 宿主侧需要的 Casdoor 能力（只声明用到的，测试好造形状；与 channel-address 同款）。 */
type CasdoorLike = { listRoles(): Promise<Array<{ name: string; users?: string[] }>> }

export function createOrganizationPort(deps: {
  pool: Pool
  /**
   * 按 org 取 Casdoor 客户端（宿主传 `casdoorFactory`）。
   * **缺省 ⇒ `listRoleMembers` 恒空**：生产不存在这种形态（`config.ts` 已把 admin 凭据设为必填），
   * 缺省只为 loader 测试与注入式用法留口子。
   */
  casdoorFor?: (org: string) => CasdoorLike
}): OrganizationPort {
  const tenantOf = async (org: string): Promise<number | null> => {
    const { rows } = await deps.pool.query<{ id: number }>(
      'select id from platform.tenant where casdoor_org = $1', [org])
    return rows[0]?.id ?? null
  }
  /**
   * 所列部门 → 「自身 + 全部后代」的 ext_id 集合。
   * 走 `path` 前缀（`<ext>.%`）而不是递归 CTE：path 是 012 起就物化的子树入口（D-O3），
   * 一次索引扫描即可；递归 CTE 在每次调用上都要重算一遍父子关系。
   */
  const subtree = async (tenantId: number, extIds: readonly string[]): Promise<string[]> => {
    if (extIds.length === 0) return []
    const { rows } = await deps.pool.query<{ ext_id: string }>(
      `select ext_id from platform.v_org_node
        where tenant_id=$1 and status=1
          and (ext_id = any($2::text[]) or path like any($3::text[]))`,
      [tenantId, [...extIds], extIds.map((e) => `${e}.%`)])
    return rows.map((r) => r.ext_id)
  }
  return {
    async listSubtreeMembers(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      const depts = await subtree(tenantId, extIds); if (depts.length === 0) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select distinct user_name from platform.v_org_membership
          where tenant_id=$1 and ext_id = any($2::text[]) order by user_name`,
        [tenantId, depts])
      return rows.map((r) => r.user_name)
    },
    async listDeptLeaders(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      if (extIds.length === 0) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select user_name from platform.v_org_node_leader
          where tenant_id=$1 and node_ext_id = any($2::text[]) order by sort, user_name`,
        [tenantId, [...extIds]])
      return rows.map((r) => r.user_name)
    },
    async listDeptAdmins(org, extIds) {
      const tenantId = await tenantOf(org); if (tenantId === null) return []
      if (extIds.length === 0) return []
      const { rows } = await deps.pool.query<{ user_name: string }>(
        `select user_name from platform.v_org_role_binding
          where tenant_id=$1 and node_ext_id = any($2::text[]) and role='dept_admin'
          order by user_name`,
        [tenantId, [...extIds]])
      return rows.map((r) => r.user_name)
    },
    async listRoleMembers(org, role) {
      if (!deps.casdoorFor) return []
      const roles = await deps.casdoorFor(org).listRoles()
      const hit = roles.find((r) => r.name === role)
      // Casdoor 的 users 是全形 `org/name`；短名归一与 channel-address / scope-holders 同口径
      return (hit?.users ?? []).map((u) => (u.startsWith(`${org}/`) ? u.slice(org.length + 1) : u))
    },
    async primaryDeptOf(org, userName) {
      const tenantId = await tenantOf(org); if (tenantId === null) return null
      const { rows } = await deps.pool.query<{ ext_id: string }>(
        `select ext_id from platform.v_org_membership
          where tenant_id=$1 and user_name=$2
          order by is_primary desc, ext_id limit 1`, [tenantId, userName])
      return rows[0]?.ext_id ?? null
    },
  }
}
