// warehouse.ts — 数据仓库连接（pg_duckdb，物化层）。
//
// ⚠️ 这是**部署级**连接，不是租户级：一条连接看得到所有租户的数据。
//   这不违反 M3c「装载期不读任何配置」——那条规矩管的是**租户级存储配置**
//   （每租户一份 bucket/AK，必须在请求期投影）。仓库连接全部署一份，租户隔离由
//   授权核心的**主体钉死**保证（这正是授权必须落在平台、而不是落在那条连接上的原因）。
import { Pool } from 'pg'

export const DATA_WAREHOUSE_UNCONFIGURED = 'DATA_WAREHOUSE_UNCONFIGURED'
const STATEMENT_TIMEOUT_MS = 30_000

export function warehouseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.DATA_WAREHOUSE_URL?.trim()
  return Boolean(v)
}

let singleton: Pool | null = null

/** 惰性单例：模块装载期**不**建连接（没配仓库的部署也要能起来）。
 *  单例不只是省连接——每条 Pool 都是独立连接池，每次问数新建一条会直接把仓库打爆。 */
export function warehousePool(env: Record<string, string | undefined> = process.env): Pool {
  if (singleton) return singleton
  const url = env.DATA_WAREHOUSE_URL?.trim()
  if (!url) throw new Error(DATA_WAREHOUSE_UNCONFIGURED)
  singleton = new Pool({ connectionString: url, statement_timeout: STATEMENT_TIMEOUT_MS })
  return singleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调）。 */
export function resetWarehousePool(): void {
  singleton = null
}

/** 执行并归一成 { columns, rows }（pg 的 Result 带 command/oid 等噪声，不外泄）。
 *  ⚠️ 行**必须**按 columns 的顺序摊平成值数组：直接把 pg 的行对象透出去，
 *     就成了一条「驱动版 jsonb」形状的隐性契约，消费方（T4 的 runQuery）会被驱动实现细节绑住。 */
export async function runWarehouseSql(
  pool: Pool, sql: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const r = await pool.query(sql)
  const columns = r.fields.map((f) => f.name)
  const rows = r.rows.map((row) => columns.map((c) => (row as Record<string, unknown>)[c]))
  return { columns, rows }
}

// ── 分析师只读池（spec 2026-10-21 §8：分析师面 warehouse 连接强制只读）─────────────────
// 与写池同一份 DATA_WAREHOUSE_URL、同一个部署——差别只在**会话**：每条新连接先
// `set default_transaction_read_only = on`。写池不动（dbt 物化继续走 warehousePool()），
// 分析师面（toolbox）的主计划与辅助读全走这里 ⇒ 「持 data:query 的连接对湖写必失败」。
let analystSingleton: Pool | null = null

export function analystPool(env: Record<string, string | undefined> = process.env): Pool {
  if (analystSingleton) return analystSingleton
  const url = env.DATA_WAREHOUSE_URL?.trim()
  if (!url) throw new Error(DATA_WAREHOUSE_UNCONFIGURED)
  const pool = new Pool({ connectionString: url, statement_timeout: STATEMENT_TIMEOUT_MS })
  pool.on('connect', (client) => { void client.query('set default_transaction_read_only = on') })
  analystSingleton = pool
  return analystSingleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调；与 resetWarehousePool 对称）。 */
export function resetAnalystPool(): void {
  analystSingleton = null
}
