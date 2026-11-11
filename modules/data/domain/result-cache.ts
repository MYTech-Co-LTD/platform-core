// result-cache.ts — 明细查询的**结果缓存**（#1945 后续：唯一能到毫秒级的手段）。
//
// 为什么只缓存结果、不缓存数据：直读 ZOS 的物理地板是 ~550ms（30 天 / 2 个月文件，实测），
// 任何"扫 40MB"的查询都不可能在个位数毫秒完成；但**同一查询**在 30–60 秒内重复执行很常见
// （看板轮询、同一页面刷新、多人看同一指标），命中缓存即 1–5ms。
//
// 安全边界（三条，缺一不可）：
//   ① **键 = 最终 SQL 的 sha256**（含 org 钉死、掩码投影、月份谓词、limit/offset）——SQL 同
//      ⇒ 结果同，跨用户复用也安全：不同 org/不同掩码会生成不同 SQL；
//   ② 缓存只在**执行成功后**写入（错误/被拒永不入缓存）；
//   ③ 鉴权、参数校验、审计**每次都照走**，缓存只替代"执行"这一步（审计的 auditId 每次新生成）。
//
// 失效：TTL（默认 60s）+ LRU 容量上限（默认 200）。不做主动失效——封版/合并后最长 60s 内
// 自然过期；需要更严可调 RESULT_CACHE_TTL_MS。
import { createHash } from 'node:crypto'

export interface CachedDetail {
  columns: string[]
  rows: unknown[][]
  rowCountTotal: number
  retried: boolean
}

interface Entry {
  at: number
  value: CachedDetail
}

const MAX = Math.max(1, Number(process.env.RESULT_CACHE_MAX ?? 200) || 200)
const TTL_MS = Math.max(0, Number(process.env.RESULT_CACHE_TTL_MS ?? 60_000) || 60_000)

const store = new Map<string, Entry>()
let hits = 0
let misses = 0
let evictions = 0

/** 缓存键：最终 SQL 的 sha256（同时把 count SQL 纳入，避免两者口径漂开）。 */
export function cacheKey(sql: string, countSql: string): string {
  return createHash('sha256').update(sql).update('\u0000').update(countSql).digest('hex')
}

export function cacheGet(key: string, now: number = Date.now()): CachedDetail | null {
  const e = store.get(key)
  if (e === undefined) {
    misses += 1
    return null
  }
  if (now - e.at > TTL_MS) {
    store.delete(key)
    misses += 1
    return null
  }
  // LRU：命中后移到队尾（Map 保持插入序，delete+set 即“最近使用”）。
  store.delete(key)
  store.set(key, e)
  hits += 1
  return e.value
}

export function cacheSet(key: string, value: CachedDetail, now: number = Date.now()): void {
  if (TTL_MS === 0) return
  store.delete(key)
  store.set(key, { at: now, value })
  while (store.size > MAX) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
    evictions += 1
  }
}

/** 观测面：命中率/容量。供健康页或日志读取（不改变行为）。 */
export function cacheStats(): { size: number; hits: number; misses: number; evictions: number; ttlMs: number; max: number } {
  return { size: store.size, hits, misses, evictions, ttlMs: TTL_MS, max: MAX }
}

/** 仅测试用：清空缓存与计数器。 */
export function cacheClear(): void {
  store.clear()
  hits = 0
  misses = 0
  evictions = 0
}
