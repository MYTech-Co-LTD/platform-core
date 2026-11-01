// asset-auth.ts — 资产级授权（spec 2026-11-01-mobile-first-business-surface-design.md §4）。
//
// 两件事，两个函数，**各自只有一份实现**（PC/移动/列表/详情/导出/嵌入 URL 全走它们）：
//   · `canViewAsset` —— 谁能看这条资产的内容
//   · `canEditAsset` —— 谁能改这条资产的配置（含共享设置）
// 业界对照（Google Drive / GitHub / Notion）：**可看 ≠ 可改**，且 owner 是"可改"的默认持有者；
// 管理员可代管但必须留审计。把三者混成一个"权限"判断，是这类系统最常见的越权来源。
//
// 三维度别混（本域已有两维，本文件加一维）：
//   · ACL（本文件）      —— 谁被点名/按部门/按权限码授予了访问
//   · `visibility`       —— 默认可见面（tenant = 沿用旧粗门；restricted = 只有 ACL 里的人）
//   · `required_scope`   —— **内容门**：在本域 NULL 还兼「已发布」语义（report-store 头注）
import type { Pool } from 'pg'
import { deptGatePasses } from './dept-gate'

export type AclSubjectType = 'user' | 'dept' | 'scope'
export type AclRelation = 'owner' | 'viewer'

export interface AclRow {
  subjectType: AclSubjectType
  subjectId: string
  relation: AclRelation
}

/** 判定所需的资产形状（比 ReportRow 更窄：只要可见性三要素）。 */
export interface AssetVisibility {
  visibility: 'tenant' | 'restricted'
  /** 内容门：NULL = 全模块可见（且在本域兼「已发布」语义） */
  requiredScope: string | null
  requiredDepts: string[] | null
}

export interface AuthRequester {
  userId: string
  hasScope(code: string): boolean
}

/** 该资产的所有者（可能是历史资产：没有任何 owner 行）。 */
export function ownerOf(acl: readonly AclRow[]): string | null {
  const row = acl.find((a) => a.relation === 'owner' && a.subjectType === 'user')
  return row?.subjectId ?? null
}

export function isOwner(acl: readonly AclRow[], userId: string): boolean {
  return acl.some((a) => a.relation === 'owner' && a.subjectType === 'user' && a.subjectId === userId)
}

/**
 * 能否**看**这条资产。
 *
 * 顺序固定：ACL（owner/viewer 三类受让方）→ `visibility` → 旧内容门。
 * 三个判断点都 fail-closed：
 *   · 部门受让方在 `userDepts === undefined`（未解析）时**不算命中**——「不知道你在哪个部门」
 *     不等于「你在」；
 *   · `restricted` 且 ACL 无命中 ⇒ 拒（不回落旧粗门，否则"默认私有"形同虚设）；
 *   · 旧粗门的部门门在 `userDepts === undefined` 时同样拒（沿用既有口径）。
 */
export function canViewAsset(
  row: AssetVisibility,
  requester: AuthRequester,
  acl: readonly AclRow[],
  userDepts: ReadonlySet<string> | undefined,
): boolean {
  if (isOwner(acl, requester.userId)) return true
  for (const a of acl) {
    if (a.relation !== 'viewer') continue
    if (a.subjectType === 'user' && a.subjectId === requester.userId) return true
    if (a.subjectType === 'scope' && requester.hasScope(a.subjectId)) return true
    if (a.subjectType === 'dept' && userDepts !== undefined && userDepts.has(a.subjectId)) return true
  }
  if (row.visibility === 'restricted') return false
  // 旧粗门（历史资产）：与改造前逐字一致
  if (row.requiredScope !== null && !requester.hasScope(row.requiredScope)) return false
  if (userDepts === undefined && (row.requiredDepts ?? []).length > 0) return false
  return deptGatePasses(row.requiredDepts, userDepts ?? new Set())
}

/**
 * 能否**改配置**（共享设置 / 门 / 删除）。
 * **不看 viewer**：被点名可看 ≠ 可改配置；只有 owner 与模块管理码持有者可以。
 */
export function canEditAsset(
  acl: readonly AclRow[],
  requester: AuthRequester,
  manageScope: string,
): boolean {
  return isOwner(acl, requester.userId) || requester.hasScope(manageScope)
}

/** 管理码代管他人资产时，审计必须能看出"这是管理员动作"（spec §4.2）。 */
export function isAdminOverride(
  acl: readonly AclRow[],
  requester: AuthRequester,
  manageScope: string,
): boolean {
  return !isOwner(acl, requester.userId) && requester.hasScope(manageScope)
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const fromRow = (r: { subject_type: string; subject_id: string; relation: string }): AclRow => ({
  subjectType: r.subject_type as AclSubjectType,
  subjectId: r.subject_id,
  relation: r.relation as AclRelation,
})

/** 单条资产的 ACL（详情/编辑判定）。 */
export async function loadAssetAcl(pool: Pool, org: string, assetId: string): Promise<AclRow[]> {
  const { rows } = await pool.query(
    'select subject_type, subject_id, relation from data.asset_acl where org = $1 and asset_id = $2',
    [org, assetId],
  )
  return rows.map(fromRow)
}

/** 批量取（列表页一次查询，避免 N+1）。 */
export async function loadAssetAcls(
  pool: Pool, org: string, assetIds: readonly string[],
): Promise<Map<string, AclRow[]>> {
  const out = new Map<string, AclRow[]>()
  if (assetIds.length === 0) return out
  const { rows } = await pool.query(
    `select asset_id, subject_type, subject_id, relation
       from data.asset_acl
      where org = $1 and asset_id = any($2::text[])`,
    [org, [...assetIds]],
  )
  for (const r of rows as Array<{ asset_id: string; subject_type: string; subject_id: string; relation: string }>) {
    const list = out.get(r.asset_id) ?? []
    list.push(fromRow(r))
    out.set(r.asset_id, list)
  }
  return out
}

/** 资产级管理动作审计（spec §4.2）。by_admin=true 表示"不是 owner 的管理员代管"。 */
export async function writeAssetAudit(
  pool: Pool,
  e: { org: string; assetId: string; actor: string; action: string; detail?: unknown; byAdmin?: boolean },
): Promise<void> {
  await pool.query(
    `insert into data.asset_audit(org, asset_id, actor, action, detail, by_admin)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [e.org, e.assetId, e.actor, e.action, JSON.stringify(e.detail ?? {}), e.byAdmin === true],
  )
}

/** 新资产落所有者。**幂等**：已有人持有 owner 行时不改（同一标题 upsert 不抢所有权）。 */
export async function ensureOwner(pool: Pool, org: string, assetId: string, owner: string): Promise<void> {
  // **一个资产只有一个 owner**：冲突键含 subject_id，`do nothing` 拦不住"第二个人"——
  // 必须用 not exists 显式表达"已有 owner 就不写"（否则同名 upsert 会造出两个所有者）。
  await pool.query(
    `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
     select $1, $2, 'user', $3, 'owner', $3
      where not exists (
        select 1 from data.asset_acl where org = $1 and asset_id = $2 and relation = 'owner'
      )`,
    [org, assetId, owner],
  )
}

/**
 * 整体替换 viewer 集合（PUT /acl 的语义：**幂等覆盖**，不是增量）。
 * owner 行不受影响——所有权转移是独立动作（spec §4.4）。
 */
export async function replaceViewers(
  pool: Pool, org: string, assetId: string, viewers: readonly AclRow[], actor: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      "delete from data.asset_acl where org = $1 and asset_id = $2 and relation = 'viewer'",
      [org, assetId],
    )
    for (const v of viewers) {
      await client.query(
        `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
         values ($1, $2, $3, $4, 'viewer', $5)
         on conflict do nothing`,
        [org, assetId, v.subjectType, v.subjectId, actor],
      )
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * 转移所有权（spec §4.4）：`owner` 行整体换人（旧 owner 不再保留任何特权）。
 *
 * 为什么单独一个动作而不是"再加一个 owner 行"：多个 owner 会让「谁负责」失去单一答案；
 * 业界（Drive/GitHub）转移就是把唯一 owner 换人，**旧 owner 若仍需访问**应作为 viewer 显式加回。
 * 审计由调用方写（带 byAdmin）——本函数只管行状态。
 */
export async function transferOwner(
  pool: Pool, org: string, assetId: string, nextOwner: string, actor: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      "delete from data.asset_acl where org = $1 and asset_id = $2 and relation = 'owner'",
      [org, assetId],
    )
    await client.query(
      `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
       values ($1, $2, 'user', $3, 'owner', $4)`,
      [org, assetId, nextOwner, actor],
    )
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
