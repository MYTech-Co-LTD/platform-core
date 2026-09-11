// db.ts — pg Pool 单例工厂（按 databaseUrl 模块级缓存）
// 宿主全进程共用一个池；测试用不同 DATABASE_URL 即天然隔离。
import { Pool } from 'pg'

const pools = new Map<string, Pool>()

/** 结构化收窄到 databaseUrl：AppConfig / 显式对象都能喂 */
export function getPool(cfg: { databaseUrl: string }): Pool {
  let pool = pools.get(cfg.databaseUrl)
  if (!pool) {
    pool = new Pool({ connectionString: cfg.databaseUrl })
    pools.set(cfg.databaseUrl, pool)
  }
  return pool
}
