// identity-links.ts — platform.identity_link 的宿主侧唯一读写层（账户统一设计 §1.2）。
// B1：本文件属宿主，只碰 platform schema；aftersales 数据由调用方作为入参传入。
// 单行可变：一个 (provider, org, external_id) 永远一行，换绑/解绑原地改 status；
// 历史留痕（platform.audit action='identity.link.*'）是**调用方**的责任，本层只管行状态。
import type { Pool } from 'pg'

export type LinkProvider = 'wechat-oa' | 'wecom'
export type LinkStatus = 'pending' | 'active' | 'revoked' | 'disputed'

export interface IdentityLinkRow {
  id: number
  org: string
  provider: LinkProvider
  externalId: string
  casdoorName: string
  status: LinkStatus
  phone: string | null
  boundVia: 'auto' | 'manual' | null
  sourceApprovalId: number | null
}

/** 手机号归一：取数字；「86 + 11 位」共 13 位时去国家码；恰好 11 位才返回（座机/乱码不匹配）。 */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2)
  return d.length === 11 ? d : null
}

// pg 驱动对 int8/bigserial 一律回**字符串**（防精度丢失），而本契约把 id/sourceApprovalId
// 钉成 number ⇒ 读路径显式 ::int 收窄，运行时形状与声明一致（#11：形状必须与真机一致）。
// identity_link 行数是人的量级、source_approval_id 是审批单号，int4 射程足够。
const ROW
  = 'id::int AS id, org, provider, external_id AS "externalId", casdoor_name AS "casdoorName",'
  + ' status, phone, bound_via AS "boundVia", source_approval_id::int AS "sourceApprovalId"'

/** 按外部身份取整行（不限 status）；未绑定返回 null。 */
export async function findLinkByExternal(
  pool: Pool,
  org: string,
  provider: LinkProvider,
  externalId: string,
): Promise<IdentityLinkRow | null> {
  const { rows } = await pool.query<IdentityLinkRow>(
    `select ${ROW} from platform.identity_link`
    + ' where org = $1 and provider = $2 and external_id = $3',
    [org, provider, externalId],
  )
  return rows[0] ?? null
}

/** 任一渠道 active 即正式态：provider 不限，只认 status='active'；没有则 null。 */
export async function findActiveLink(
  pool: Pool,
  org: string,
  externalId: string,
): Promise<{ casdoorName: string } | null> {
  const { rows } = await pool.query<{ casdoorName: string }>(
    'select casdoor_name AS "casdoorName" from platform.identity_link'
    + " where org = $1 and external_id = $2 and status = 'active' limit 1",
    [org, externalId],
  )
  return rows[0] ?? null
}

/** 某账户在某 org 下全部 active 的外部 id（pending/revoked 不列）。 */
export async function listActiveExternalIds(
  pool: Pool,
  org: string,
  casdoorName: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ external_id: string }>(
    "select external_id from platform.identity_link"
    + " where org = $1 and casdoor_name = $2 and status = 'active'",
    [org, casdoorName],
  )
  return rows.map((r) => r.external_id)
}

/** 手机号反查候选账户：distinct casdoor_name、只数 active、跨 provider（调用方先 normalizePhone）。 */
export async function listCandidatesByPhone(
  pool: Pool,
  org: string,
  phone: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ casdoor_name: string }>(
    'select distinct casdoor_name from platform.identity_link'
    + " where org = $1 and phone = $2 and status = 'active'",
    [org, phone],
  )
  return rows.map((r) => r.casdoor_name)
}

/** 绑定写入：同键 (provider, org, external_id) 已存在则**原地更新**（单行可变），返回更新后的行。
 *  bound_at = 最近一次「active 生效」的时点：首插分支与冲突分支都要盖（只在冲突分支写，
 *  全新空库上的首次 active 绑定会漏成 NULL——真机首跑即踩）；非 active 保留原值。 */
export async function upsertLink(
  pool: Pool,
  p: {
    org: string
    provider: LinkProvider
    externalId: string
    casdoorName: string
    phone: string | null
    boundVia: 'auto' | 'manual' | null
    status: LinkStatus
    sourceApprovalId: number | null
  },
): Promise<IdentityLinkRow> {
  const { rows } = await pool.query<IdentityLinkRow>(
    `insert into platform.identity_link
       (org, provider, external_id, casdoor_name, status, phone, bound_via, source_approval_id, bound_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $5 = 'active' then now() else null end)
     on conflict (provider, org, external_id) do update set
       casdoor_name = excluded.casdoor_name,
       phone = excluded.phone,
       bound_via = excluded.bound_via,
       status = excluded.status,
       source_approval_id = excluded.source_approval_id,
       bound_at = case when excluded.status = 'active' then now() else identity_link.bound_at end
     returning ${ROW}`,
    [p.org, p.provider, p.externalId, p.casdoorName, p.status, p.phone, p.boundVia, p.sourceApprovalId],
  )
  return rows[0]!
}

/** 行级变更（换绑/解绑/争议），org 圈死作用域：他 org 的 id 取不到（null）。
 *  revoked_at/revoked_by 只在 status 落 'revoked' 的那次变更盖上；单独传 revokedBy 而不落
 *  revoked 视为误用，不生效（行上留的是「最近一次吊销」的执行人与时点）。 */
export async function mutateLink(
  pool: Pool,
  org: string,
  id: number,
  patch: { status?: LinkStatus; casdoorName?: string; revokedBy?: string },
): Promise<IdentityLinkRow | null> {
  const params: unknown[] = [org, id] // $1 = org（作用域）、$2 = id
  const sets: string[] = []
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }
  if (patch.casdoorName !== undefined) {
    params.push(patch.casdoorName)
    sets.push(`casdoor_name = $${params.length}`)
  }
  if (patch.status === 'revoked') {
    sets.push('revoked_at = now()')
    if (patch.revokedBy !== undefined) {
      params.push(patch.revokedBy)
      sets.push(`revoked_by = $${params.length}`)
    }
  }
  if (sets.length === 0) {
    // 空 patch 不构成 update：退化为按 org+id 读取（org 不对照样 null，与 update 路径同语义）
    const { rows } = await pool.query<IdentityLinkRow>(
      `select ${ROW} from platform.identity_link where org = $1 and id = $2`,
      params,
    )
    return rows[0] ?? null
  }
  const { rows } = await pool.query<IdentityLinkRow>(
    `update platform.identity_link set ${sets.join(', ')}
     where org = $1 and id = $2 returning ${ROW}`,
    params,
  )
  return rows[0] ?? null
}
