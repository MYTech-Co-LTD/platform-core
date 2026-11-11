// warehouse.ts — 数据仓库连接（pg_duckdb，物化层）。
//
// ⚠️ 这是**部署级**连接，不是租户级：一条连接看得到所有租户的数据。
//   这不违反 M3c「装载期不读任何配置」——那条规矩管的是**租户级存储配置**
//   （每租户一份 bucket/AK，必须在请求期投影）。仓库连接全部署一份，租户隔离由
//   授权核心的**主体钉死**保证（这正是授权必须落在平台、而不是落在那条连接上的原因）。
import { Pool } from 'pg'

export const DATA_WAREHOUSE_UNCONFIGURED = 'DATA_WAREHOUSE_UNCONFIGURED'

// ── 连接与资源预算（#1951 Wave 0.1）────────────────────────────────────────────────
// 为什么必须显式配：pg_duckdb **每条连接一个 DuckDB 实例**、`duckdb.memory_limit=1536MB`，
// 而数据面容器 `mem_limit` 默认 4g。node-pg 的默认 `max=10` ⇒ 理论 10 × 1.5GB 直接超容器上限，
// 表现是 backend 被 OOM kill / postmaster `terminating any other active server processes`。
// 我们**两个池**（写池 + 分析师只读池）各连同一实例，所以每个池的上限都要单独算。
//
// 默认值取 3：`3 × 1.5GB = 4.5GB` 略高于 4g，但 DuckDB 的 memory_limit 是**上限**不是常驻；
// 实测 3 路并发 30 天明細（各约 40MB 扫描）峰值远低于预算。要更保守可设 2。
const DEFAULT_POOL_MAX = 3
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

/** 读一个正整数 env；非法/缺失回落默认值（不抛：配置错误不该让进程起不来）。 */
function positiveInt(env: Record<string, string | undefined>, key: string, def: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : def
}

/** Pool 配置的唯一构造点（写池与只读池共用；测试直接断言本函数）。 */
export function warehousePoolConfig(env: Record<string, string | undefined> = process.env): {
  max: number
  idleTimeoutMillis: number
  connectionTimeoutMillis: number
  statement_timeout: number
} {
  return {
    max: positiveInt(env, 'DATA_WAREHOUSE_POOL_MAX', DEFAULT_POOL_MAX),
    idleTimeoutMillis: positiveInt(env, 'DATA_WAREHOUSE_IDLE_MS', DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: positiveInt(env, 'DATA_WAREHOUSE_CONNECT_MS', DEFAULT_CONNECT_TIMEOUT_MS),
    statement_timeout: positiveInt(env, 'DATA_QUERY_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
  }
}

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
  singleton = new Pool({ connectionString: url, ...warehousePoolConfig(env) })
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

/** 参数化版本（W6 `explore_query`）：值一律走 `$n`，绝不字符串拼接。
 *  归一形状与 `runWarehouseSql` 一致，消费方不必区分两条通道。 */
export async function runWarehouseSqlParams(
  pool: Pool, sql: string, params: readonly unknown[] = [],
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const r = await pool.query(sql, params as unknown[])
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
  const pool = new Pool({ connectionString: url, ...warehousePoolConfig(env) })
  pool.on('connect', (client) => { void client.query('set default_transaction_read_only = on') })
  analystSingleton = pool
  return analystSingleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调；与 resetWarehousePool 对称）。 */
export function resetAnalystPool(): void {
  analystSingleton = null
}
