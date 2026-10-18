// api-key-store.ts — 个人 Key（通道 B，PAT）的存储层。**唯一哈希实现**。
//
// 位置（issue #894，正典 §1.5）：本表与实现原在 `modules/data`（`data.query_keys` + 同名 key-store），
// 2026-10-18 上移宿主——token 是**平台级身份能力**（「每个账号生成 token」），不该长在首个消费者
// （问数）的模块 schema 里。上移后那条 `runtime.port('data','resolvePatKey')` 间接层（宿主绕 B1
// 去模块取凭据）整个退役，**哈希实现从「模块唯一一份」变成「宿主唯一一份」**——原来的
// 「宿主不得复制这一行」反转成了「模块不再持有第二份」（模块侧那份已删）。
//
// 形状与 `data.query_keys` 逐条对齐（列/约束/语义），**只有表名与 schema 变**：
//   隔离键是 `org text`（不是 tenant_id int）——pat-auth 的跨租户判定就是拿它比 `tenant.casdoor_org`。
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export const PAT_PREFIX = 'dkq_'
export const MAX_KEY_NAME_LEN = 64

export interface PatKeyRow {
  id: number
  name: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}
export interface ResolvedPat {
  keyId: number
  org: string
  casdoorUser: string
}

/** 32 字节随机 → base64url，带可辨识前缀（日志/告警里一眼认出是 PAT）。 */
export function newPatToken(): string {
  return PAT_PREFIX + randomBytes(32).toString('base64url')
}

export function hashPat(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 建 key：明文只在本函数的返回值里出现这一次，库里只有哈希。
 * 名称超长/空 ⇒ 抛（路由层先校验，这里是最后一道）。
 */
export async function createPatKey(
  pool: Pool,
  org: string,
  casdoorUser: string,
  name: string,
): Promise<{ id: number; token: string }> {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_NAME_LEN) {
    throw new Error(`key 名称长度必须是 1..${MAX_KEY_NAME_LEN}`)
  }
  const token = newPatToken()
  const r = await pool.query(
    `insert into platform.api_key (org, casdoor_user, name, token_hash)
     values ($1, $2, $3, $4) returning id`,
    [org, casdoorUser, trimmed, hashPat(token)],
  )
  // ⚠️ node-pg 把 bigint(int8) 读成 **string** —— 不归一，后面 `===` 比较与 JSON 回包都会变味
  return { id: Number(r.rows[0].id), token }
}

export async function listPatKeys(pool: Pool, org: string, casdoorUser: string): Promise<PatKeyRow[]> {
  const r = await pool.query(
    `select id, name, created_at, last_used_at, revoked_at
       from platform.api_key
      where org = $1 and casdoor_user = $2
      order by created_at desc`,
    [org, casdoorUser],
  )
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revoked: row.revoked_at !== null,
  }))
}

/** 吊销：**必须带 casdoor_user** —— 不带就能吊销别人的 key。返回是否真命中一行。 */
export async function revokePatKey(
  pool: Pool,
  org: string,
  casdoorUser: string,
  id: number,
): Promise<boolean> {
  const r = await pool.query(
    `update platform.api_key set revoked_at = now()
      where id = $1 and org = $2 and casdoor_user = $3 and revoked_at is null`,
    [id, org, casdoorUser],
  )
  return (r.rowCount ?? 0) > 0
}

/** 解析 token → 主体。已吊销 / 不存在一律 null（fail-closed）。 */
export async function resolvePat(pool: Pool, token: string): Promise<ResolvedPat | null> {
  const r = await pool.query(
    `select id, org, casdoor_user from platform.api_key
      where token_hash = $1 and revoked_at is null`,
    [hashPat(token)],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]
  return { keyId: Number(row.id), org: row.org, casdoorUser: row.casdoor_user }
}

/** 记一次使用。org 与 id 双条件：即便传错 id，只要 org 是自己的就写不到别家的 key
 *  （写路径一律带隔离键）。fire-and-forget 调用（失败不阻断业务）。 */
export async function touchPatKey(pool: Pool, org: string, id: number): Promise<void> {
  await pool.query('update platform.api_key set last_used_at = now() where org = $1 and id = $2', [
    org,
    id,
  ])
}

/** 解析 + 触碰 last_used_at（pat-auth 的注入源；触碰失败不影响解析结果）。 */
export function resolveKeyWithTouch(pool: Pool): (token: string) => Promise<ResolvedPat | null> {
  return async (token: string) => {
    const resolved = await resolvePat(pool, token)
    if (resolved === null) return null
    void touchPatKey(pool, resolved.org, resolved.keyId).catch(() => {})
    return resolved
  }
}

// ── 管理档（tenant:admin 视图用）──

export interface OrgPatKeyRow extends PatKeyRow {
  casdoorUser: string
}

/** 本租户全部 key（含归属用户）——管理档列表。org 仍钉死（跨租户结构上取不到）。 */
export async function listPatKeysInOrg(pool: Pool, org: string): Promise<OrgPatKeyRow[]> {
  const r = await pool.query(
    `select id, casdoor_user, name, created_at, last_used_at, revoked_at
       from platform.api_key where org = $1 order by created_at desc`,
    [org],
  )
  return r.rows.map((row) => ({
    id: Number(row.id),
    casdoorUser: row.casdoor_user,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revoked: row.revoked_at !== null,
  }))
}

/** 管理档吊销：仍钉 org（跨租户不可能），但**不要求 casdoor_user**——管理档已过 tenant:admin 门。 */
export async function revokePatKeyInOrg(pool: Pool, org: string, id: number): Promise<boolean> {
  const r = await pool.query(
    'update platform.api_key set revoked_at = now() where id = $1 and org = $2 and revoked_at is null',
    [id, org],
  )
  return (r.rowCount ?? 0) > 0
}
