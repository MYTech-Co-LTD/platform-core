// data-version.ts — 明细数据的**版本戳**（#1953 Wave 0.2）。
//
// 为什么需要：结果缓存的键如果只有 SQL，**封版/月文件重建后的 60s 内**同一 SQL 会返回旧结果
// （缓存不知道数据变了）。把「数据版本」放进键，数据一变键就变 ⇒ 旧条目自然失效。
//
// 版本取两处水位（都是单行小查询）：
//   `data.lemeng_daily_sealed.max(checked_at)` —— 封版/对账推进
//   `data.lake_month_index.max(built_at)`      —— 月文件重建
// 二者任一变化都意味着读面可能变化。结果在进程内缓存 `DATA_VERSION_TTL_MS`（默认 5s），
// 避免每条明细都多打一次库；5s 内的封版延迟由 TTL 兜底（缓存本身 TTL 60s 是上限）。
//
// 失败语义：查询失败 ⇒ 返回空版本（**不缓存**错误结果），键退化为「只有 SQL」——
// 与没有版本戳时行为一致，不阻断查询。
import type { Pool } from 'pg'

export const DATA_VERSION_SQL = `select concat(
  coalesce((select max(checked_at)::text from data.lemeng_daily_sealed), ''),
  '|',
  coalesce((select max(built_at)::text from data.lake_month_index), '')
) as v`

export interface DataVersionCacheOptions {
  ttlMs?: number
  now?: () => number
}

let cached: { at: number; value: string } | null = null
let ttlMs = readTtl(process.env)

function readTtl(env: Record<string, string | undefined>): number {
  const raw = env.DATA_VERSION_TTL_MS?.trim()
  if (raw === undefined || raw === '') return 5_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 5_000
}

/** 更新 TTL（测试/换 env 用）。 */
export function resetDataVersionCache(env: Record<string, string | undefined> = process.env): void {
  cached = null
  ttlMs = readTtl(env)
}

/**
 * 取当前数据版本（带进程内短缓存）。失败返回 ''（键退化为 SQL-only，不阻断）。
 * @param query 执行查询的函数（生产传 pool.query；测试注入假实现）
 */
export async function dataVersion(
  query: (sql: string) => Promise<{ rows: Array<{ v?: unknown }> }>,
  now: () => number = Date.now,
): Promise<string> {
  const t = now()
  // TTL=0 ⇒ 从不复用（同一毫秒内也不复用）；否则窗口内复用。
  if (ttlMs > 0 && cached !== null && t - cached.at < ttlMs) return cached.value
  try {
    const r = await query(DATA_VERSION_SQL)
    const raw = r.rows[0]?.v
    const value = typeof raw === 'string' ? raw : ''
    cached = { at: t, value }
    return value
  } catch {
    return ''
  }
}

/** 便捷包装：用 pg Pool 取版本。 */
export async function dataVersionOf(pool: Pool): Promise<string> {
  return dataVersion((sql) => pool.query<{ v?: unknown }>(sql))
}
