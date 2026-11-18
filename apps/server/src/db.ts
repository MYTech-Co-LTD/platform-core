// db.ts — pg Pool 单例工厂（按 databaseUrl 模块级缓存）
// 宿主全进程共用一个池；测试用不同 DATABASE_URL 即天然隔离。
import { Pool } from 'pg'

const pools = new Map<string, Pool>()

/** 结构化收窄到 databaseUrl：AppConfig / 显式对象都能喂 */
export function getPool(cfg: { databaseUrl: string }): Pool {
  let pool = pools.get(cfg.databaseUrl)
  if (!pool) {
    pool = new Pool({ connectionString: cfg.databaseUrl })
    // pg 的 Pool **没有** 'error' 监听时，会把「空闲连接被断开」升级成未捕获异常 ⇒ 整个进程退出。
    // 2026-11-18 实测（#2484）：postgres 后端被 SIGTERM（集群 reinit）⇒ notify-worker 直接崩，
    // 正跑着的长任务被启动对账收成 timeout。断连是基础设施常态（重启/故障转移/管理员操作），
    // 留痕即可；进程不能因为一条空闲连接死掉。
    pool.on('error', (err) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), pgPoolError: err.message }))
    })
    pools.set(cfg.databaseUrl, pool)
  }
  return pool
}
