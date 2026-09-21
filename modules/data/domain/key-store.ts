// key-store.ts — 个人 Key（通道 B）的存储层。
//
// ⚠️ 哈希实现只在本文件存在一份（约束 5/14 订正后宿主侧没有也不得再建第二份）：
//     createHash('sha256').update(token).digest('hex')
//   宿主不复制这一行——静态 import 模块是架构违规，且会打掉 worktree 并行；
//   解析一律走模块端口（resolvePat，T6 包成 resolvePatKey 暴露给宿主）。
//   跨进程一致性由 T10 的往返契约测试负责（模块建 key → 宿主中间件认下来）。
import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'
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
  pool: Pool, org: string, casdoorUser: string, name: string,
): Promise<{ id: number; token: string }> {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_NAME_LEN) {
    throw new Error(`key 名称长度必须是 1..${MAX_KEY_NAME_LEN}`)
  }
  const token = newPatToken()
  const r = await pool.query(
    `insert into data.query_keys (org, casdoor_user, name, token_hash)
     values ($1, $2, $3, $4) returning id`,
    [org, casdoorUser, trimmed, hashPat(token)],
  )
  // ⚠️ node-pg 把 bigint(int8) 读成 **string** —— 不归一，后面 `===` 比较与 JSON 回包都会变味
  return { id: Number(r.rows[0].id), token }
}

export async function listPatKeys(
  pool: Pool, org: string, casdoorUser: string,
): Promise<PatKeyRow[]> {
  const r = await pool.query(
    `select id, name, created_at, last_used_at, revoked_at
       from data.query_keys
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
  pool: Pool, org: string, casdoorUser: string, id: number,
): Promise<boolean> {
  const r = await pool.query(
    `update data.query_keys set revoked_at = now()
      where id = $1 and org = $2 and casdoor_user = $3 and revoked_at is null`,
    [id, org, casdoorUser],
  )
  return (r.rowCount ?? 0) > 0
}

/** 解析 token → 主体。已吊销 / 不存在一律 null（fail-closed）。 */
export async function resolvePat(pool: Pool, token: string): Promise<ResolvedPat | null> {
  const r = await pool.query(
    `select id, org, casdoor_user from data.query_keys
      where token_hash = $1 and revoked_at is null`,
    [hashPat(token)],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]
  return { keyId: Number(row.id), org: row.org, casdoorUser: row.casdoor_user }
}

/** 记一次使用。org 与 id 双条件：即便传错 id，只要 org 是自己的就写不到别家的 key
 *  （约束 13：写路径一律带隔离键）。fire-and-forget 调用（失败不阻断问数）。 */
export async function touchPatKey(pool: Pool, org: string, id: number): Promise<void> {
  await pool.query('update data.query_keys set last_used_at = now() where org = $1 and id = $2', [org, id])
}
