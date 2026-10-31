// channel-address.ts — Casdoor 用户 → 渠道地址（正典 §4.3）。
// 这是与旧实现的关键差异：旧代码把 Casdoor id 直接当企微 userid（会 81013）；
// 这里显式查 identity_link，映射不到就返回 null（调用方记 failed，不假装成功）。
//
// 2026-10-30 起同文件再挂一件宿主级能力：**部门 → 成员展开**（`resolveDeptMembers`，
// 组织架构 Phase C）。为什么在宿主而不是 notify 模块里：它要读平台 org 表（B1 禁止模块
// 跨 schema 读，哪怕走只读视图也要消费模块自己声明）+ 要 Casdoor 客户端（`isForbidden`
// 只有 admin 会话拿得到）。与 `resolveScopeHolders` 同一个理由。
import type { CasdoorListedUser } from '@platform/auth-core'
import type { ChannelAddressResolver, DeptExpansion, OrgNodeOption } from '@platform/sdk'
import type { Pool } from 'pg'
import { createScopeHolderResolver } from './scope-holders'

/** 宿主侧解析器需要的 Casdoor 能力（只声明用到的，测试好造形状）。 */
type CasdoorLike = {
  listUsers(): Promise<CasdoorListedUser[]>
  getPermissions(): Promise<Array<{ users?: string[]; roles?: string[]; resources?: string[] }>>
  listRoles(): Promise<Array<{ name: string; users?: string[] }>>
}

export function createChannelAddressResolver(deps: {
  pool: Pool
  /**
   * 按 org 取 Casdoor 客户端（宿主传 `casdoorFactory`）。**缺省 ⇒ 禁用过滤与未解析计数不可用时
   * 只能按 org 表全量发**——那条路会在结果里把它标出来（`complete: false` 没有，见下），
   * 生产不存在这种形态（`config.ts` 已把 admin 凭据设为必填）。
   */
  casdoorFor?: (org: string) => CasdoorLike
  /** 用户表的进程内缓存（默认 60s，与 `createScopeHolderResolver` 同口径）。 */
  userCacheTtlMs?: number
}): ChannelAddressResolver {
  /** org → 用户快照。部门群发一次要问「谁是禁用的」，逐人查 Casdoor 是 N 次 RPC。 */
  const userCache = new Map<string, { at: number; byName: Map<string, { forbidden: boolean }> }>()
  const ttl = deps.userCacheTtlMs ?? 60_000
  /**
   * 「权限码 → 持有者」解析器（issue #1179）：**与 worker 脚本同一份实现**
   * （`createScopeHolderResolver`：直挂 ∪ 角色展开、按 org 60s 缓存）。
   *
   * 为什么必须在这里实现：控制台的规则预检走 HTTP 路由，它拿的是本解析器；此前本文件
   * 没实现 `resolveScopeHolders` ⇒ 预检恒落 `?? []` + `scope_holders_unavailable` 警告，
   * 于是**同一条规则**在控制台显示「0 人」、worker 真发时却发得出去——两个入口结论不一致。
   *
   * 失败**抛错**（与 resolver 本身的口径一致）：让调用方看见「查不了」，而不是静默成空集。
   */
  const scopeHolders = deps.casdoorFor === undefined
    ? undefined
    : createScopeHolderResolver((org) => deps.casdoorFor!(org) as never)

  const usersOf = async (org: string) => {
    const hit = userCache.get(org)
    if (hit && Date.now() - hit.at < ttl) return hit.byName
    if (!deps.casdoorFor) return null
    const listed = await deps.casdoorFor(org).listUsers()
    // Casdoor 可能存 `org/alice`：按短名归一（与 scope-holders 同口径）
    const byName = new Map<string, { forbidden: boolean }>()
    for (const u of listed) {
      const bare = u.name.startsWith(`${org}/`) ? u.name.slice(org.length + 1) : u.name
      byName.set(bare, { forbidden: u.isForbidden })
    }
    userCache.set(org, { at: Date.now(), byName })
    return byName
  }

  return {
    async resolve({ org, provider, casdoorName }) {
      if (provider === 'in_app') return casdoorName
      if (provider !== 'wecom_chat') return null

      // ① 显式地址（spec 2026-10-31 §3.3）：同步时把渠道原生地址落在 org_membership.external_id。
      //    只认 `source` 与本 provider 匹配的行——`source` 不同（如 casdoor 源）或旧行（NULL）
      //    不知道 external_id 属于哪个渠道，**不跨渠道硬套**。
      const byMembership = await deps.pool.query<{ external_id: string }>(
        `select m.external_id
           from platform.org_membership m
           join platform.tenant t on t.id = m.tenant_id
          where t.casdoor_org = $1 and m.user_name = $2
            and m.source = $3 and m.external_id is not null and m.external_id <> ''
          limit 1`,
        [org, casdoorName, sourceOf(provider)],
      )
      if (byMembership.rows[0]?.external_id) return byMembership.rows[0].external_id

      // ② 显式绑定（who 用过企微登录 ⇒ identity_link）
      const { rows } = await deps.pool.query<{ external_id: string }>(
        `select external_id from platform.identity_link
          where org = $1 and provider = 'wecom' and casdoor_name = $2 and status = 'active'
          order by id desc limit 1`,
        [org, casdoorName],
      )
      return rows[0]?.external_id ?? null
    },

    /**
     * 收件人档 → 持有者（Casdoor 直挂 ∪ 角色展开）。缺 `casdoorFor` ⇒ **不提供这个方法**
     * （调用方据此报 `scope_holders_unavailable`，而不是拿到一个假的空集）。
     *
     * ⚠️ 第二个参数是 **recipientKey**（如 `approvers`），不是权限码——真正的码在
     * `decl.recipients[key].scope`。这是 `deliverability` 与 worker 的既有契约
     * （`worker-deps.ts` 同一段逻辑）：**三处必须同源**，否则症状是「解析器在、结果恒空」
     * （2026-10-30 亲测：按 SDK 旧形参名当码用 ⇒ 控制台永远 0 人）。
     */
    resolveScopeHolders: scopeHolders === undefined
      ? undefined
      : (org, recipientKey, decl) => {
        const r = decl?.recipients?.[recipientKey]
        if (r?.kind !== 'scope_holders' || r.scope === undefined || r.scope === '') return Promise.resolve([])
        return scopeHolders(org, r.scope)
      },

    /**
     * 部门 ext_id（可多选）→ 成员（**含全部后代部门**，spec 2026-10-30 §3.5）。
     *
     * 三步，全在一条 org 事务视图上：
     *  ① 所选部门（活节点）→ 子树：`path = p OR path LIKE p || '.%'`（物化 path，无递归）；
     *  ② 子树里的成员（`org_membership` 去重 `user_name`）；
     *  ③ 过滤：Casdoor 里不存在的算 `unresolved`（企微有/平台无），存在但 `isForbidden` 的算
     *     `excluded`。两个数都要回给调用方——「少发了谁」必须可解释。
     *
     * ⚠️ 租户未同步（org 表空）⇒ 展开为空且 `depts=[]`：调用方据此判 `no_recipient`，
     * 与 Phase B 的「未同步 ⇒ 部门门不可配」同一口径（不会静默按全公司发）。
     */
    async resolveDeptMembers(org, extIds): Promise<DeptExpansion> {
      const ids = [...new Set(extIds.filter((x) => typeof x === 'string' && x !== ''))]
      if (ids.length === 0) {
        return { names: [], depts: [], members: 0, excluded: 0, unresolved: 0 }
      }
      const { rows: tenantRows } = await deps.pool.query<{ id: number }>(
        'select id from platform.tenant where casdoor_org = $1',
        [org],
      )
      const tenantId = tenantRows[0]?.id
      if (tenantId === undefined) {
        return { names: [], depts: [], members: 0, excluded: 0, unresolved: 0 }
      }

      const { rows } = await deps.pool.query<{ ext_id: string; user_name: string }>(
        `with roots as (
           select path from platform.v_org_node
            where tenant_id = $1 and status = 1 and ext_id = any($2::text[])
         ), sub as (
           select n.ext_id, n.path from platform.v_org_node n
            where n.tenant_id = $1 and n.status = 1
              and exists (select 1 from roots r
                           where n.path = r.path or n.path like r.path || '.%')
         )
         select m.ext_id, m.user_name
           from platform.v_org_membership m
           join sub s on s.ext_id = m.ext_id
          where m.tenant_id = $1
          order by m.user_name`,
        [tenantId, ids],
      )

      const depts = [...new Set(rows.map((r) => r.ext_id))]
      const members = [...new Set(rows.map((r) => r.user_name))]
      const users = await usersOf(org)

      // 解析器缺省（无 Casdoor 客户端）⇒ 不做禁用过滤，也判不出未解析：如实回 0，
      // 由调用方决定要不要相信这两个数（生产不存在这条路径）。
      if (users === null) {
        return { names: members, depts, members: members.length, excluded: 0, unresolved: 0 }
      }

      const names: string[] = []
      let excluded = 0
      let unresolved = 0
      for (const name of members) {
        const u = users.get(name)
        if (u === undefined) { unresolved += 1; continue }
        if (u.forbidden) { excluded += 1; continue }
        names.push(name)
      }
      return { names, depts, members: members.length, excluded, unresolved }
    },

    /**
     * 部门选择器的数据源：活节点平表 + 直属人数（按 `path` 深度优先）。
     * 与 `data` 模块 `/reports/dept-options` 同口径（那处是模块内的实现；本处是宿主面，
     * 供 notify 等**不该碰 platform schema** 的模块共用）。
     */
    async listOrgNodes(org): Promise<OrgNodeOption[]> {
      const { rows: tenantRows } = await deps.pool.query<{ id: number }>(
        'select id from platform.tenant where casdoor_org = $1',
        [org],
      )
      const tenantId = tenantRows[0]?.id
      if (tenantId === undefined) return []
      const { rows } = await deps.pool.query<{
        ext_id: string; name: string; parent_ext_id: string | null; members: number
      }>(
        `select n.ext_id, n.name, n.parent_ext_id,
                (select count(*)::int from platform.v_org_membership m
                  where m.tenant_id = n.tenant_id and m.ext_id = n.ext_id) as members
           from platform.v_org_node n
          where n.tenant_id = $1 and n.status = 1
          order by n.path`,
        [tenantId],
      )
      return rows.map((r) => ({
        extId: r.ext_id, name: r.name, parentExtId: r.parent_ext_id, memberCount: r.members,
      }))
    },
    /**
     * 抽 N 个成员的**渠道原生地址**（spec 2026-10-31 §3.4 Phase 2）。
     *
     * 只取 `source` 与本渠道匹配、且 `external_id` 非空的行——旧行（source=NULL）与 Casdoor 源
     * 不知道地址，**不参与抽样**（拿名字去猜会把「不知道」混进「不可达」的统计里）。
     * `order by random()` 是有意的：抽样要覆盖不同人，而不是永远同一批。
     */
    async sampleMemberAddresses(org, limit) {
      if (limit <= 0) return []
      const { rows } = await deps.pool.query<{ external_id: string }>(
        `select m.external_id
           from platform.org_membership m
           join platform.tenant t on t.id = m.tenant_id
          where t.casdoor_org = $1 and m.source = 'wecom'
            and m.external_id is not null and m.external_id <> ''
          order by random()
          limit $2`,
        [org, Math.min(limit, 50)],
      )
      return rows.map((r) => r.external_id)
    },
  }
}

/**
 * provider → 写入 `org_membership.source` 的源名（同一件事的唯一映射）。
 * wecom_chat 的成员来自企微通讯录同步；将来飞书/钉钉各加一行即可，**不做字符串猜测**。
 */
export function sourceOf(provider: string): string {
  return provider === 'wecom_chat' ? 'wecom' : provider
}
