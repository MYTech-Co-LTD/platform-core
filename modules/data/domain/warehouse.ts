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
