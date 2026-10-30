// org-store.ts — 平台 org 表的读写薄层（spec 2026-10-30 §3.1）。
// 只做存储访问与树形状组装，不做同步（同步在 org-sync.ts）、不做鉴权（路由层）。
// 语义：企微是事实源；本表是平台内唯一组织存储（D-O1）。部门软删（status=0）不物理删。
import type { Pool } from 'pg'
import type { CasdoorGroupLike, GroupTreeNode } from '@platform/auth-core'
import { buildGroupTree } from '@platform/auth-core'

export interface OrgNodeRow {
  extId: string
  name: string
  parentExtId: string | null
  path: string
  status: number
}

export async function countNodes(pool: Pool, tenantId: number): Promise<number> {
  const r = await pool.query('select count(*)::int as n from platform.org_node where tenant_id = $1', [tenantId])
  // 空结果按 0 容错（测试桩池对未知 SQL 回空数组；语义上空表 = 未同步 = 走回退路径）
  return r.rows[0]?.n ?? 0
}

export async function listNodes(pool: Pool, tenantId: number): Promise<OrgNodeRow[]> {
  const r = await pool.query(
    'select ext_id, name, parent_ext_id, path, status from platform.org_node where tenant_id = $1 order by ext_id',
    [tenantId],
  )
  return r.rows.map((x) => ({
    extId: x.ext_id, name: x.name, parentExtId: x.parent_ext_id, path: x.path, status: x.status,
  }))
}

/** 各部门成员数（含未激活成员——展示口径与旧 Casdoor 路径一致：只按归属计数）。 */
export async function memberCounts(pool: Pool, tenantId: number): Promise<Map<string, number>> {
  const r = await pool.query(
    `select m.ext_id, count(*)::int as n
       from platform.org_membership m
       join platform.org_node n on n.tenant_id = m.tenant_id and n.ext_id = m.ext_id and n.status = 1
      where m.tenant_id = $1
      group by m.ext_id`,
    [tenantId],
  )
  return new Map(r.rows.map((x) => [x.ext_id, x.n]))
}

/** 树形状复用 auth-core 的 buildGroupTree：根归一（parentId 为 org 名）、孤儿挂根标记。
 * 映射：org_node.parent_ext_id NULL → CasdoorGroupLike.parentId = org（buildGroupTree 的根判据）。 */
export function orgTreeOf(org: string, nodes: OrgNodeRow[], counts: Map<string, number>): GroupTreeNode[] {
  const likes: CasdoorGroupLike[] = nodes
    .filter((n) => n.status === 1)
    .map((n) => ({ name: n.extId, displayName: n.name, parentId: n.parentExtId ?? org }))
  return buildGroupTree(org, likes, counts)
}

/** 某部门的成员用户名（不含软删部门）。 */
export async function membersOf(pool: Pool, tenantId: number, extId: string): Promise<string[]> {
  const r = await pool.query(
    `select m.user_name from platform.org_membership m
       join platform.org_node n on n.tenant_id = m.tenant_id and n.ext_id = m.ext_id and n.status = 1
      where m.tenant_id = $1 and m.ext_id = $2
      order by m.user_name`,
    [tenantId, extId],
  )
  return r.rows.map((x) => x.user_name)
}

/** 某用户的全量部门归属（org-sync 判定/展示用；授权消费走「含祖先链」的扩展，Phase B 接线）。 */
export async function deptsOfUser(pool: Pool, tenantId: number, userName: string): Promise<string[]> {
  const r = await pool.query(
    'select ext_id from platform.org_membership where tenant_id = $1 and user_name = $2',
    [tenantId, userName],
  )
  return r.rows.map((x) => x.ext_id)
}
