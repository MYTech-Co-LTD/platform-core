// monitor-recipients.ts — 监控收件人解析（Wave 7 V1，spec §9「两道门」的第二道）。
//
// 第一道在创建期（路由校验 ref 形如 dept/user）；**第二道在这里**：投递期重新展开，
// 部门会搬、成员会退、ACL 会改 ⇒ 越权/不存在的人静默剔除并留痕（不再是收件人）。
//
// 部门展开与通知板块同一套平台视图（`platform.v_org_node` / `v_org_membership`，data 模块
// manifest 已声明这两个只读依赖）——不新造组织模型。区别：这里不做 Casdoor 禁用态过滤
// （投递侧通道解析会再判一次），V1 保持「只回答谁在组织里」。
import type { Pool } from 'pg'
import type { MonitorRecipient } from './monitor-spec'

export interface ResolvedMonitorRecipients {
  to: string[]
  excluded: Array<{ ref: string; reason: 'not_member' | 'no_dept_members' | 'no_tenant' }>
}

export interface RecipientDeps {
  /** 组织成员（可用于测试注入）。 */
  membersOf?: (org: string) => Promise<string[]>
  /** 部门（含后代）成员。 */
  deptMembersOf?: (org: string, extIds: string[]) => Promise<string[]>
}

async function tenantIdOf(pool: Pool, org: string): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    'select id from platform.tenant where casdoor_org = $1', [org],
  )
  return rows[0]?.id ?? null
}

/** 默认成员展开：platform.org_membership（按 Casdoor name 灌）。 */
async function defaultMembersOf(pool: Pool, org: string): Promise<string[]> {
  const tenantId = await tenantIdOf(pool, org)
  if (tenantId === null) return []
  const { rows } = await pool.query<{ user_name: string }>(
    'select distinct user_name from platform.org_membership where tenant_id = $1', [tenantId],
  )
  return rows.map((r) => r.user_name)
}

/** 默认部门展开：活节点子树（`path = p OR path LIKE p.||'.%'`）→ 成员去重。 */
async function defaultDeptMembersOf(pool: Pool, org: string, extIds: string[]): Promise<string[]> {
  const ids = [...new Set(extIds.filter((x) => typeof x === 'string' && x !== ''))]
  if (ids.length === 0) return []
  const tenantId = await tenantIdOf(pool, org)
  if (tenantId === null) return []
  const { rows } = await pool.query<{ user_name: string }>(
    `with roots as (
        select path from platform.v_org_node
         where tenant_id = $1 and status = 1 and ext_id = any($2::text[])
      ), sub as (
        select n.ext_id, n.path from platform.v_org_node n
         where n.tenant_id = $1 and n.status = 1
           and exists (select 1 from roots r
                        where n.path = r.path or n.path like r.path || '.%')
      )
      select distinct m.user_name
        from platform.v_org_membership m
        join sub s on s.ext_id = m.ext_id
       where m.tenant_id = $1`,
    [tenantId, ids],
  )
  return rows.map((r) => r.user_name)
}

/**
 * 投递期解析：给出**当时**合法且存在的收件人名字；被剔除的逐个留原因。
 * 去重、保序（先 user 后 dept 的展开顺序不保证，最终按插入序去重）。
 */
export async function resolveMonitorRecipients(
  pool: Pool, org: string, recipients: readonly MonitorRecipient[], deps: RecipientDeps = {},
): Promise<ResolvedMonitorRecipients> {
  const membersOf = deps.membersOf ?? ((o) => defaultMembersOf(pool, o))
  const deptMembersOf = deps.deptMembersOf ?? ((o, ids) => defaultDeptMembersOf(pool, o, ids))

  const userRefs = recipients.filter((r) => r.kind === 'user').map((r) => r.ref)
  const deptRefs = recipients.filter((r) => r.kind === 'dept').map((r) => r.ref)

  const excluded: ResolvedMonitorRecipients['excluded'] = []
  const to: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!seen.has(name)) { seen.add(name); to.push(name) }
  }

  if (userRefs.length > 0) {
    const members = new Set(await membersOf(org))
    for (const ref of userRefs) {
      if (members.has(ref)) push(ref)
      else excluded.push({ ref, reason: 'not_member' })
    }
  }

  if (deptRefs.length > 0) {
    const names = await deptMembersOf(org, deptRefs)
    if (names.length === 0) {
      for (const ref of deptRefs) excluded.push({ ref, reason: 'no_dept_members' })
    } else {
      for (const name of names) push(name)
    }
  }

  return { to, excluded }
}
