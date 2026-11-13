// metric-visibility.ts — 指标可见性的部门上下文与纯谓词（P2 Task 2，spec 2026-11-12 §8）。
//
// 有效可见集（spec §8.1）：`owner_dept` 为空 ⇒ 全租户（行为与今天逐字节相同——现网 57 行
// owner_dept 全空）；否则观看者的**部门链**（直属 ∪ 祖先 ∪ 后代）命中归属部门，或
// `visible_depts` 显式共享命中观看者的**直属**部门（兄弟开门的唯一途径——只认直属，
// 祖先/后代不吃共享）。fail-closed：观看者无部门上下文 ⇒ 只能看 owner_dept 空的指标。
//
// 单一实现纪律：部门可见判定只在本文件的纯谓词里；`visibleMetrics`（authz.ts）只经它判，
// 别处不得自写第二份（P2 计划 Global Constraints，静态断言钉在 authz.test.ts）。
//
// 实现分工（与 dept-gate.ts 同一套 org 惯例）：
//   loadDeptContext —— 请求时**一条查询**取部门上下文（见函数注）；
//   metricVisibleWithDept —— 纯谓词，列表与按 id 查询共用同一份（spec §8.3）。
import type { Pool } from 'pg'
import { deptNamesOf } from './dept-gate'

/** 观看者的部门可见上下文（一次请求解析一份，六处调用点共用）。 */
export interface DeptContext {
  /** 直属部门的自身 ∪ 祖先 ∪ 后代（spec §8.1 部门链）——判 `owner_dept` 归属用。 */
  readonly canOwn: ReadonlySet<string>
  /** 直属部门集（**不含**祖先/后代）——判 `visible_depts` 显式共享用（只认直属）。 */
  readonly memberOf: ReadonlySet<string>
}

/**
 * 请求时解析观看者的部门上下文。`requester` 与 `dept-gate.deptNamesOf` 同形
 * （`accountName` 优先、`userId` 兜底——三条通道的人标识不是同一个键）；`tenantId` 是
 * 数值租户 id，由调用方解析后传入。
 *
 * 为什么是**一条**查询：`direct` CTE（membership join 活节点，dept-gate 同款）一次拿到
 * 直属集与各自的物化 path；后代用 `x.path like d.path || '.%'` 在同一语句里自联拿全
 * （物化 path 前缀即子树，D-O3——不用递归）；祖先链在 JS 里拆段（path 含自身，拆段即得）。
 * 两条查询的替代（先取直属再 `path like any($paths)`）多一次往返，272 节点租户下无收益。
 * 死节点（status≠1）直属与后代都不进——与 dept-gate 的 join 行为一致，软删即失权。
 */
export async function loadDeptContext(
  pool: Pool, tenantId: number, requester: { userId: string; accountName?: string },
): Promise<DeptContext> {
  const memberOf = new Set<string>()
  const canOwn = new Set<string>()
  const names = deptNamesOf(requester)
  if (names.length === 0) return { canOwn, memberOf } // 无候选名 = 无部门信息（fail-closed）
  const r = await pool.query(
    `with direct as (
        select n.ext_id, n.path
          from platform.v_org_membership m
          join platform.v_org_node n on n.tenant_id = m.tenant_id and n.ext_id = m.ext_id and n.status = 1
         where m.tenant_id = $1 and m.user_name = any($2::text[])
     )
     select d.ext_id as direct_id, d.path as direct_path, x.ext_id as desc_id
       from direct d
       left join platform.v_org_node x
         on x.tenant_id = $1 and x.status = 1 and x.path like d.path || '.%'`,
    [tenantId, names],
  )
  for (const row of r.rows as Array<{ direct_id: string; direct_path: string; desc_id: string | null }>) {
    memberOf.add(row.direct_id)
    canOwn.add(row.direct_id)
    // path "49.57.66" ⇒ 祖先链 49、57、66 都入 canOwn（含自身，dept-gate 同一惯例）
    for (const seg of row.direct_path.split('.')) if (seg !== '') canOwn.add(seg)
    // 严格后代（前缀带点，"49.5%" 不会误吃 "49.57"）：多直属/共享后代靠 Set 去重
    if (row.desc_id !== null) canOwn.add(row.desc_id)
  }
  return { canOwn, memberOf }
}

/**
 * 调用点接线入口（P2 Task 4，六面共用这一份守卫）：词表里**没有**归属行 ⇒ ctx 不影响
 * 输出，返回 undefined 且**不发查询**（懒加载——现网 57 行全 null，这条让接线后的生产行为
 * 逐字节不变）；有归属行才按 `requester.tenantId`（路由侧 `requesterOf` 从 `c.get('tenant').id`
 * 注入的**租户数字 id**，不是 casdoor_org）加载上下文。
 *
 * `tenantId` 缺位（测试夹具 / 未注入的通道）⇒ 返回 undefined——owned 行对该请求不可见
 * （fail-closed，宁少勿错），并记一条 structured warn：这是「配了归属但观看通道没带租户 id」
 * 的错配态，应当可观测（与 scope.ts 的 `data_scope_dept_unresolved` 同一告警口径）。
 */
export async function deptContextIfOwned(
  pool: Pool, tenantId: number | undefined, requester: { userId: string; accountName?: string },
  catalog: ReadonlyArray<{ ownerDept?: string | null }>,
): Promise<DeptContext | undefined> {
  // `'' → null` 归一与谓词同一口径：空串归属 = 平台通用桶，不因它发查询
  const hasOwned = catalog.some((m) => (m.ownerDept ?? '') !== '')
  if (!hasOwned) return undefined
  if (tenantId === undefined) {
    console.warn(JSON.stringify({
      event: 'metric_dept_ctx_unresolved', userId: requester.userId,
      effect: '词表含部门归属指标但 requester 无 tenantId ⇒ 这些行按 fail-closed 隐藏——检查 requesterOf 是否注入了 tenantId',
    }))
    return undefined
  }
  return loadDeptContext(pool, tenantId, requester)
}

/**
 * 部门可见判定（**纯谓词**，spec §8.1 真值表——列表与按 id 查询共用这一份）：
 * - `ownerDept` 空（null / **缺席** / 空串）⇒ 真——平台通用指标，无论 ctx 在不在
 *   （与今天行为逐字节相同）。三个入参形状都收口在第一行：
 *     · 缺席 = 结构兼容面（`MetricDef` 行不必带这两个字段，P2 Task 3）；
 *     · 空串 = P1 台账边界（同名互斥索引 `coalesce(owner_dept,'')` 早已把空串并进平台桶，
 *       可见性判定同口径，Task 3 订正——不再按「归属空串部门」拒）。
 * - `deptCtx === undefined`（观看面没接部门上下文）⇒ 假（fail-closed，宁可多拒）；
 * - 否则归属部门在链上（canOwn）或 `visible_depts` 命中直属（memberOf）⇒ 真。
 */
export function metricVisibleWithDept(
  metric: { ownerDept?: string | null; visibleDepts?: string[] | null },
  deptCtx: DeptContext | undefined,
): boolean {
  const ownerDept = metric.ownerDept === '' ? null : (metric.ownerDept ?? null)
  if (ownerDept === null) return true
  if (deptCtx === undefined) return false
  if (deptCtx.canOwn.has(ownerDept)) return true
  return (metric.visibleDepts ?? []).some((d) => deptCtx.memberOf.has(d))
}
