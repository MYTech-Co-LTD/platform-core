// org-tree-check.ts — 组织树一致性检查（P2 Task 1，spec 2026-11-12 §17.1 前置门）。
//
// 为什么是前置门：P2 的部门可见判定（metric-visibility）全部吃 `v_org_node.path` 这一条
// 物化祖先链——树本身坏了（环 / 断链 / 死挂），可见判定就会把「看不见」判成「看得见」。
// 故法案前先取证：errors=0 才允许后续任务合并（台账纪律，见 P2 计划 Task 1 Step 3）。
//
// 结构：**纯判定 + 薄 SQL 壳**。视图只读，夹具进不去 ⇒ judgeOrgTree 吃行数组可全量单测；
// checkOrgTree 只做取数与行名映射，不含任何判断（判断全在 judge，单一事实源）。
//
// 判据（P2 计划 Task 1，按真实 path 惯例订正一处）：
//   ① 环：祖先段含自身 ⇒ cycle。
//      订正说明：计划原文写 `path.split('.').includes(ext_id) ⇒ cycle`，但本仓物化 path
//      **含自身**（dept-gate.ts:37-38「path "49.57" ⇒ 祖先链 49、57 都入集（含自身部门）」；
//      实测本地根节点 ext_id=10 path="10" 按原文会误报环）⇒ 判据落在**去掉末段的祖先段**上，
//      等价于「ext_id 在 path 段中出现 ≥2 次」。末段=自身是常态，不是环。
//   ② 悬挂父：祖先段不在本租户**活节点集** ⇒ dangling_parent。计划判据是「首段」，
//      这里泛化到整条祖先链报第一个缺失段——中段断链同样让 dept-gate 闭包把死部门
//      ext_id 收进可见集，性质相同。
//   ③ 重复：同租户 ext_id 唯一。PK (tenant_id, ext_id) 应保证，查出即报（防御性）。
//   ④ 死节点挂人：membership 指向 status≠1 **或不存在**的节点 ⇒ dead_node_membership。
//      两种都被 dept-gate 的 `n.status = 1` join 静默丢——这里点名。
//   ⑤ 深度>10（段数）与空支（活节点无任何 membership）**仅告警不红**（空分支合法）。
//
// 死节点（status≠1）不参与 ②⑤：它本来就不可见，只经 ③④ 现身——否则每次软删都刷一片
// 告警噪音。环（①）对死节点也判：path 是物化数据，坏了就是坏了，复活前就该被发现。
import type { Pool } from 'pg'

/** 深度告警阈值（段数；根=1）。仅告警，不红。 */
export const MAX_DEPTH = 10

/** v_org_node 行（模块消费面只取判定所需列；snake_case 在 SQL 壳里映射成 camelCase）。 */
export interface OrgNodeRow {
  tenantId: number
  extId: string
  name: string
  path: string
  status: number
}

/** v_org_membership 行。 */
export interface OrgMembershipRow {
  tenantId: number
  userName: string
  extId: string
}

export type OrgTreeIssueKind =
  | 'cycle'
  | 'dangling_parent'
  | 'duplicate_ext_id'
  | 'dead_node_membership'

export interface OrgTreeIssue {
  kind: OrgTreeIssueKind
  tenantId: number
  detail: string
}

export interface OrgTreeReport {
  /** 请求口径：传了 tenantId 就是它；没传 = 全租户（'all'）。 */
  tenantId: number | 'all'
  /** 口径内的节点行数（含死节点）。 */
  nodes: number
  errors: OrgTreeIssue[]
  /** 深度/空支类告警（带 [tenant N] 前缀）；不参与 exit code。 */
  warnings: string[]
}

/**
 * 纯判定：给定行数组（可跨租户），产出报告。错误与告警都按 (tenantId, extId) 排序——
 * 同样的输入永远得到同样的顺序（对账/快照可比）。
 */
export function judgeOrgTree(
  tenantId: number | 'all',
  nodes: readonly OrgNodeRow[],
  memberships: readonly OrgMembershipRow[],
): OrgTreeReport {
  const errors: OrgTreeIssue[] = []
  const warnings: string[] = []

  // 租户分组（首现行序保留）；membership 单独分组（节点不存在的租户也要点名 ④）
  const nodesByTenant = new Map<number, OrgNodeRow[]>()
  for (const n of nodes) {
    const list = nodesByTenant.get(n.tenantId)
    if (list === undefined) nodesByTenant.set(n.tenantId, [n])
    else list.push(n)
  }
  const msByTenant = new Map<number, OrgMembershipRow[]>()
  for (const m of memberships) {
    const list = msByTenant.get(m.tenantId)
    if (list === undefined) msByTenant.set(m.tenantId, [m])
    else list.push(m)
  }

  const tenants = [...new Set([...nodesByTenant.keys(), ...msByTenant.keys()])].sort((a, b) => a - b)
  for (const t of tenants) {
    const rows = nodesByTenant.get(t) ?? []
    const msRows = msByTenant.get(t) ?? []

    // ③ 重复（同租户 ext_id 唯一；PK 应保证，查出即报）
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.extId, (counts.get(r.extId) ?? 0) + 1)
    const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([e]) => e).sort()
    for (const ext of dupes) {
      errors.push({
        kind: 'duplicate_ext_id', tenantId: t,
        detail: `节点 ${ext} 在租户 ${t} 出现 ${counts.get(ext)} 次（同租户 ext_id 必须唯一）`,
      })
    }

    // 首现行代表该 ext_id 参与结构判（重复本身已由 ③ 点名，不重复刷结构错）
    const first = new Map<string, OrgNodeRow>()
    for (const r of rows) if (!first.has(r.extId)) first.set(r.extId, r)
    const live = new Set([...first.entries()].filter(([, r]) => r.status === 1).map(([e]) => e))

    // ①环（含死节点）+ ②悬挂父 + ⑤深度（仅活节点）
    for (const ext of [...first.keys()].sort()) {
      const r = first.get(ext)
      if (r === undefined) continue
      const segs = r.path.split('.')
      const ancestors = segs.slice(0, -1)
      if (ancestors.includes(ext)) {
        errors.push({
          kind: 'cycle', tenantId: t,
          detail: `节点 ${ext} 的 path(${r.path}) 祖先段含自身（物化 path 成环）`,
        })
      }
      if (r.status !== 1) continue // 死节点不参与 ②⑤
      const missing = ancestors.find((s) => s !== '' && !live.has(s))
      if (missing !== undefined) {
        errors.push({
          kind: 'dangling_parent', tenantId: t,
          detail: `节点 ${ext} 的 path(${r.path}) 祖先段 ${missing} 不在活节点集（断链会让部门闭包收进死部门）`,
        })
      }
      if (segs.length > MAX_DEPTH) {
        warnings.push(`[tenant ${t}] 节点 ${ext}(${r.name}) 深度 ${segs.length} 超过 ${MAX_DEPTH}（仅告警）`)
      }
    }

    // ④ 死节点挂人（不存在与 status≠1 都点名——dept-gate 的 join 对两者都静默丢）
    for (const m of msRows) {
      const n = first.get(m.extId)
      if (n === undefined) {
        errors.push({
          kind: 'dead_node_membership', tenantId: t,
          detail: `用户 ${m.userName} 挂在节点 ${m.extId}：节点不存在（dept-gate join 静默丢）`,
        })
      } else if (n.status !== 1) {
        errors.push({
          kind: 'dead_node_membership', tenantId: t,
          detail: `用户 ${m.userName} 挂在死节点 ${m.extId}（status=${n.status}；dept-gate join 静默丢）`,
        })
      }
    }

    // ⑤ 空支：活节点无任何 membership（合法，仅告警；死节点不告）
    const withMs = new Set(msRows.map((m) => m.extId))
    for (const ext of [...first.keys()].sort()) {
      const r = first.get(ext)
      if (r !== undefined && r.status === 1 && !withMs.has(ext)) {
        warnings.push(`[tenant ${t}] 节点 ${ext}(${r.name}) 无任何 membership（空分支合法，仅告警）`)
      }
    }
  }

  return { tenantId, nodes: nodes.length, errors, warnings }
}

/**
 * 薄 SQL 壳：读两个只读稳定视图（013_org_views.sql）后交给 judgeOrgTree。
 * 不传 tenantId = 全租户（报告 tenantId='all'，issue 各自带具体租户）。
 */
export async function checkOrgTree(pool: Pool, tenantId?: number): Promise<OrgTreeReport> {
  const where = tenantId === undefined ? '' : 'where tenant_id = $1'
  const params = tenantId === undefined ? [] : [tenantId]
  const [nodeRes, msRes] = await Promise.all([
    pool.query(
      `select tenant_id, ext_id, name, path, status from platform.v_org_node ${where}`,
      params,
    ),
    pool.query(
      `select tenant_id, user_name, ext_id from platform.v_org_membership ${where}`,
      params,
    ),
  ])
  return judgeOrgTree(
    tenantId ?? 'all',
    (nodeRes.rows as Array<Record<string, unknown>>).map((r) => ({
      tenantId: r.tenant_id as number,
      extId: r.ext_id as string,
      name: r.name as string,
      path: r.path as string,
      status: r.status as number,
    })),
    (msRes.rows as Array<Record<string, unknown>>).map((r) => ({
      tenantId: r.tenant_id as number,
      userName: r.user_name as string,
      extId: r.ext_id as string,
    })),
  )
}
