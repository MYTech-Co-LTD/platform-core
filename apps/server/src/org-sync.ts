// org-sync.ts — 企微组织架构 → 平台 org 表的同步器（spec 2026-10-30 §3.2，#1171 Phase A）。
//
// 三条硬纪律写在本文件（不是写在文档）：
//   1. 只读企微，绝不反写通讯录；
//   2. fail-closed：拉到 0 部门、或部门数相对现存断崖（<50%）⇒ 抛错不写库——
//      2026-10 实测 10-26 那次同步静默缺 29 个部门（凭证可见范围问题）以「成功」姿态
//      存在了一个月，这道门就是防它复发（spec §1.2）；
//   3. 不物理删：企微侧消失的部门 → status=0（软删）；membership 是纯投影，可整组重写。
//
// 双轨取 token（D-O2）：自建应用 gettoken(corpId, corpSecret)；代开发收敛到
// gettoken(corpId, permanent_code)（spec §1.3 实测）——两者对数据接口完全同形，
// 故本模块只认「已取到的 corp access_token」，取 token 差异留给调用方/配置。
// 建号（issue #1847）：企微有/Casdoor 无 ⇒ apply 时由调用方注入的 `createUser` 自动建号；
// **只读企微**——本模块没有任何写通讯录的路径，Casdoor 有/企微无也不会反写或禁用。
import type { Pool, PoolClient } from 'pg'

/** 归一后的组织快照（两路来源——企微 API / Casdoor groups 种子——都汇到这个形状再入 apply）。 */
export interface OrgSnapshot {
  depts: Array<{ extId: string; name: string; parentExtId: string | null }>
  /**
   * `externalId` = **该源渠道的原生地址**（企微源 = userid；Casdoor 源 = null，不知道就不猜）。
   * 与 `userName`（平台标识）分开存：今天企微源两者同值，但语义不同（spec 2026-10-31 §3.1）。
   */
  memberships: Array<{ userName: string; extId: string; isPrimary: boolean; externalId: string | null }>
  /**
   * 用户维度的建号材料（issue #1847 自动建号）：
   * `displayName` / `status` 只来自企微源；Casdoor 源没有（人已在 Casdoor，不需要建号）。
   * `status`：企微 1=已激活、2=已禁用、4=未激活、5=退出企业；null = 源未提供。
   */
  users: Array<{ userName: string; displayName: string | null; status: number | null }>
}

/** 同步来源：写进 `org_membership.source`，解析时按它决定 external_id 能否当某渠道地址用。 */
export type OrgSyncSource = 'wecom' | 'casdoor'

export interface OrgSyncPlan {
  deptCount: number
  userCount: number
  nodesCreated: number
  nodesRenamed: number
  nodesReparented: number
  nodesDisabled: number
  nodesReactivated: number
  membersAdded: number
  membersRemoved: number
  /** 企微有 / Casdoor 无的用户（apply 时由 `createUser` 自动建号，spec §3.5 / #1847） */
  usersNotInCasdoor: string[]
}

export class OrgSyncError extends Error {
  constructor(
    public code: 'EMPTY_DEPARTMENTS' | 'DEPT_COUNT_DROP' | 'WECOM_API' | 'CASDOOR_CREATE_FAILED',
    detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}

// ── 企微拉取 ────────────────────────────────────────────────────────────────
// 形状按真机实测（2026-10-28，A 机 + 全量可见凭证）：department/list 一次返回全部；
// user/list?department_id=1&fetch_child=1 递归拉全员（474 人在单页内，无翻页）。
// 注入 fetchFn 供单测注入假企微（auth-wecom.ts 同款约定）。

const QYAPI = 'https://qyapi.weixin.qq.com'

export async function fetchWecomSnapshot(
  cfg: { corpId: string; secret: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OrgSnapshot> {
  const tr = await fetchFn(`${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`)
  const tj = (await tr.json()) as { errcode?: number; errmsg?: string; access_token?: string }
  if (tj.errcode) throw new OrgSyncError('WECOM_API', `gettoken ${tj.errcode} ${tj.errmsg ?? ''}`)
  if (!tj.access_token) throw new OrgSyncError('WECOM_API', 'gettoken missing access_token')

  const dr = await fetchFn(`${QYAPI}/cgi-bin/department/list?access_token=${tj.access_token}`)
  const dj = (await dr.json()) as { errcode?: number; errmsg?: string; department?: Array<{ id: number; name?: string; parentid?: number }> }
  if (dj.errcode) throw new OrgSyncError('WECOM_API', `department/list ${dj.errcode} ${dj.errmsg ?? ''}`)
  const rawDepts = dj.department ?? []

  const ur = await fetchFn(`${QYAPI}/cgi-bin/user/list?access_token=${tj.access_token}&department_id=1&fetch_child=1`)
  const uj = (await ur.json()) as {
    errcode?: number
    errmsg?: string
    userlist?: Array<{
      userid: string
      name?: string
      status?: number
      department?: number[]
      main_department?: number
    }>
  }
  if (uj.errcode) throw new OrgSyncError('WECOM_API', `user/list ${uj.errcode} ${uj.errmsg ?? ''}`)
  const rawUsers = uj.userlist ?? []

  // 归一：企微 parentid 0/1 → 根（NULL）。与 10-29 手工基线一致（部门 1「山海一果」是顶级节点、
  // 其子部门提升为顶级）——console 现网树形状即按此展示；若将来要严格单根，只改这一行归一。
  const depts = rawDepts.map((d) => ({
    extId: String(d.id),
    name: d.name ?? String(d.id),
    parentExtId: d.parentid === 0 || d.parentid === 1 ? null : String(d.parentid),
  }))
  const memberships = rawUsers.flatMap((u) =>
    (u.department ?? []).map((dep) => ({
      userName: u.userid,
      extId: String(dep),
      isPrimary: u.main_department === dep,
      externalId: u.userid, // 企微源：原生地址就是 userid
    })),
  )
  // 建号材料（issue #1847）：只读企微，**没有任何写通讯录的路径**；status 用于建号时定 isForbidden。
  const users = rawUsers.map((u) => ({
    userName: u.userid,
    displayName: typeof u.name === 'string' && u.name !== '' ? u.name : null,
    status: typeof u.status === 'number' ? u.status : null,
  }))
  return { depts, memberships, users }
}

// ── Casdoor groups 种子（spec §3.6：首次切源的基线 = 2026-10-29 手工对齐结果）──
// 结构化最小面：不耦合 CasdoorClient 具体类型，测试可注入同形状替身。
export interface OrgSeedCasdoor {
  listGroups(): Promise<Array<{ name: string; displayName: string; parentId: string }>>
  listUsers(): Promise<Array<{ name: string; displayName?: string | null; groups?: string[] | null }>>
}

export async function snapshotFromCasdoor(
  org: string,
  cas: OrgSeedCasdoor,
): Promise<OrgSnapshot> {
  const groups = await cas.listGroups()
  const users = await cas.listUsers()
  // parentId 真机形态三种：'' / org 名 / 全形 `org/父组名`（2026-10-29 实测 57 的 parent 就是
  // `shanhaiyiguo-org/49`）——先剥 org 前缀再判根，三态归一到 null | 裸父名。
  const bare = (raw: string) => (raw.startsWith(`${org}/`) ? raw.slice(org.length + 1) : raw)
  const depts = groups.map((g) => {
    const p = bare(g.parentId)
    return { extId: g.name, name: g.displayName || g.name, parentExtId: p === '' || p === org ? null : p }
  })
  const memberships = users.flatMap((u) =>
    (u.groups ?? []).map((raw) => ({
      userName: u.name,
      extId: raw.startsWith(`${org}/`) ? raw.slice(org.length + 1) : raw,
      isPrimary: false, // Casdoor 无主部门概念；真源切换到企微后由 fetchWecomSnapshot 带上
      externalId: null, // Casdoor groups 不含渠道地址——**不知道就不猜**
    })),
  )
  // 种子路径不建号（人已经在 Casdoor）；users 仍带出来，形状与企微源一致。
  const usersOut = users.map((u) => ({
    userName: u.name,
    displayName: typeof u.displayName === 'string' && u.displayName !== '' ? u.displayName : null,
    status: null,
  }))
  return { depts, memberships, users: usersOut }
}

// ── fail-closed 门 ─────────────────────────────────────────────────────────

export function assertSnapshotViable(snapshot: OrgSnapshot, existingActiveNodes: number): void {
  if (snapshot.depts.length === 0) {
    throw new OrgSyncError('EMPTY_DEPARTMENTS', '企微返回 0 个部门——按 fail-closed 拒绝写入（spec §3.2）')
  }
  if (existingActiveNodes > 0 && snapshot.depts.length < existingActiveNodes * 0.5) {
    throw new OrgSyncError(
      'DEPT_COUNT_DROP',
      `部门数断崖：现存 ${existingActiveNodes}，本次拉到 ${snapshot.depts.length}（<50%）——疑似凭证可见范围收窄`,
    )
  }
}

// ── diff + apply ───────────────────────────────────────────────────────────

interface ExistingNode { ext_id: string; name: string; parent_ext_id: string | null; status: number }

export function planSync(
  snapshot: OrgSnapshot,
  existing: ExistingNode[],
  existingMembers: Set<string>,
  casdoorNames: Set<string>,
): OrgSyncPlan {
  const byExt = new Map(existing.map((n) => [n.ext_id, n]))
  const activeExt = new Set(existing.filter((n) => n.status === 1).map((n) => n.ext_id))
  const fetchedExt = new Set(snapshot.depts.map((d) => d.extId))
  let nodesCreated = 0, nodesRenamed = 0, nodesReparented = 0, nodesDisabled = 0, nodesReactivated = 0
  for (const d of snapshot.depts) {
    const cur = byExt.get(d.extId)
    if (!cur || cur.status !== 1) {
      if (cur) nodesReactivated++
      else nodesCreated++
      continue
    }
    if (cur.name !== d.name) nodesRenamed++
    if ((cur.parent_ext_id ?? null) !== d.parentExtId) nodesReparented++
  }
  for (const ext of activeExt) if (!fetchedExt.has(ext)) nodesDisabled++

  const fetchedMembers = new Set(snapshot.memberships.map((m) => `${m.userName}\u0000${m.extId}`))
  let membersAdded = 0
  for (const key of fetchedMembers) if (!existingMembers.has(key)) membersAdded++
  let membersRemoved = 0
  for (const key of existingMembers) if (!fetchedMembers.has(key)) membersRemoved++

  return {
    deptCount: snapshot.depts.length,
    userCount: new Set(snapshot.memberships.map((m) => m.userName)).size,
    nodesCreated, nodesRenamed, nodesReparented, nodesDisabled, nodesReactivated,
    membersAdded, membersRemoved,
    usersNotInCasdoor: [...new Set(snapshot.memberships.map((m) => m.userName))]
      .filter((n) => !casdoorNames.has(n)),
  }
}

/** 应用快照：单事务——节点 upsert + 软删、membership 整组重写、path 全量重算。幂等。 */
export async function applySnapshot(
  pool: Pool,
  tenantId: number,
  snapshot: OrgSnapshot,
  /** 写入来源（进 `org_membership.source`）。**必填**：默认值会让「忘了传」变成静默错源。 */
  source: OrgSyncSource,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const d of snapshot.depts) {
      await client.query(
        `insert into platform.org_node (tenant_id, ext_id, name, parent_ext_id, path, status, synced_at)
         values ($1, $2, $3, $4, $2, 1, now())
         on conflict (tenant_id, ext_id) do update
           set name = excluded.name, parent_ext_id = excluded.parent_ext_id,
               status = 1, synced_at = now()`,
        [tenantId, d.extId, d.name, d.parentExtId],
      )
    }
    // 软删：现存 status=1 且本次未出现的部门（不物理删——spec 三纪律）
    await client.query(
      `update platform.org_node set status = 0, synced_at = now()
        where tenant_id = $1 and status = 1
          and ext_id <> all($2::text[])`,
      [tenantId, snapshot.depts.map((d) => d.extId)],
    )
    // membership 是纯投影：整组重写（≈520 行，量级无负担），天然幂等且清除悬挂行
    await client.query('delete from platform.org_membership where tenant_id = $1', [tenantId])
    for (const m of snapshot.memberships) {
      await client.query(
        `insert into platform.org_membership
           (tenant_id, user_name, ext_id, is_primary, source, external_id, synced_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (tenant_id, user_name, ext_id) do update
           set is_primary = excluded.is_primary,
               source = excluded.source,
               external_id = excluded.external_id,
               synced_at = now()`,
        [tenantId, m.userName, m.extId, m.isPrimary, source, m.externalId],
      )
    }
    await recomputePaths(client, tenantId)
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** path 全量重算：迭代求解 parent 链（272 节点量级，一次 pass 循环到稳定；环/孤儿 → path=ext_id 落根）。 */
async function recomputePaths(client: PoolClient, tenantId: number): Promise<void> {
  const r = await client.query(
    'select ext_id, parent_ext_id from platform.org_node where tenant_id = $1 and status = 1',
    [tenantId],
  )
  const parent = new Map(r.rows.map((x) => [x.ext_id as string, x.parent_ext_id as string | null]))
  const path = new Map<string, string>()
  const resolve = (id: string, guard: Set<string>): string => {
    if (path.has(id)) return path.get(id)!
    const p = parent.get(id) ?? null
    if (!p || !parent.has(p) || guard.has(p)) {
      path.set(id, id)
      return id
    }
    guard.add(id)
    const full = `${resolve(p, guard)}.${id}`
    path.set(id, full)
    return full
  }
  for (const id of parent.keys()) resolve(id, new Set())
  for (const [id, full] of path) {
    await client.query(
      'update platform.org_node set path = $3 where tenant_id = $1 and ext_id = $2',
      [tenantId, id, full],
    )
  }
}

// ── 对外入口：dry-run / apply 一体 ────────────────────────────────────────

export interface SyncResult extends OrgSyncPlan {
  dryRun: boolean
  /** 本轮实际建号成功的用户名（dry-run / source=casdoor / 未注入 createUser 时为空）。 */
  usersCreated: string[]
}

export async function runOrgSync(
  pool: Pool,
  tenantId: number,
  snapshot: OrgSnapshot,
  opts: {
    dryRun: boolean
    casdoorNames: Iterable<string>
    source: OrgSyncSource
    /**
     * 企微有 / Casdoor 无时的建号动作（issue #1847）。缺省 = 只列清单不建号
     * （dry-run / 测试 / 无 Casdoor 客户端的场景）。只在 `source='wecom'` 且非 dry-run 时调用。
     */
    createUser?: (user: { userName: string; displayName: string | null; status: number | null }) => Promise<void>
  },
): Promise<SyncResult> {
  const nodes = await pool.query(
    'select ext_id, name, parent_ext_id, status from platform.org_node where tenant_id = $1',
    [tenantId],
  )
  const existing: ExistingNode[] = nodes.rows.map((x) => ({
    ext_id: x.ext_id, name: x.name, parent_ext_id: x.parent_ext_id, status: x.status,
  }))
  const mr = await pool.query(
    `select m.user_name, m.ext_id from platform.org_membership m
       join platform.org_node n on n.tenant_id = m.tenant_id and n.ext_id = m.ext_id and n.status = 1
      where m.tenant_id = $1`,
    [tenantId],
  )
  const existingMembers = new Set(mr.rows.map((x) => `${x.user_name}\u0000${x.ext_id}`))

  assertSnapshotViable(snapshot, existing.filter((n) => n.status === 1).length)

  const plan = planSync(snapshot, existing, existingMembers, new Set(opts.casdoorNames))

  // 自动建号（issue #1847）：**先建号、后写 org 表**。建号失败 ⇒ 整轮失败（不写 org 表），
  // 下次重跑幂等重试；绝不静默跳过缺失账号。
  const usersCreated: string[] = []
  if (!opts.dryRun && opts.source === 'wecom' && opts.createUser) {
    const byName = new Map(snapshot.users.map((u) => [u.userName, u]))
    for (const name of plan.usersNotInCasdoor) {
      const u = byName.get(name) ?? { userName: name, displayName: null, status: null }
      try {
        await opts.createUser(u)
      } catch (e) {
        throw new OrgSyncError(
          'CASDOOR_CREATE_FAILED',
          `${name}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      usersCreated.push(name)
    }
  }

  if (!opts.dryRun) await applySnapshot(pool, tenantId, snapshot, opts.source)
  return { ...plan, dryRun: opts.dryRun, usersCreated }
}
