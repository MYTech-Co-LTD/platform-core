// query-service.ts — 三通道**唯一**的执行入口。
//
// 通道差别到 Requester 为止：拿到 Requester 之后，会话/PAT/企微走的是同一条路径。
// 审计在**所有**结局都写（spec §5 约束 7）——包括被拒与出错，否则「为什么被拒」查不出来。
import type { Pool } from 'pg'
import { MAX_QUERY_ROWS, authorize, type DenyReason, type Requester } from './authz'
import { loadMergedCatalog } from './metric-store'
import { writeAudit } from './audit-store'
import { DATA_WAREHOUSE_UNCONFIGURED, runWarehouseSql, warehousePool } from './warehouse'

/** 见 Interfaces 块：命名出来，供 T6 的 RouteCtx 与 T8/T9 的 deps 共同引用。 */
export type SqlExecutor = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>

export interface QueryDeps {
  pool: Pool
  /** 缺省 = 真仓库（惰性连接）。测试注入假执行器。 */
  execute?: SqlExecutor
}

export interface QueryOk {
  status: 'ok'; subject: string; metricId: string
  columns: string[]; rows: unknown[][]; truncated: boolean
}
export interface QueryDenied {
  status: 'denied'; metricId: string
  reason: DenyReason | 'unauthenticated'; detail?: string
}
export interface QueryError {
  status: 'error'; metricId: string
  reason: 'warehouse_unconfigured' | 'warehouse_error'; detail: string
}
export type QueryOutcome = QueryOk | QueryDenied | QueryError

export async function runQuery(
  deps: QueryDeps,
  org: string,
  requester: Requester | null,
  metricId: string,
  args: Record<string, unknown>,
): Promise<QueryOutcome> {
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
  ) => writeAudit(deps.pool, {
    // 隔离键 `org` 就是审计里的主体值——**同一列**（见 T1 的 001_init.sql 注记）。
    // 值取 `org` 形参（= 路由传进来的 `identity.orgId`，宿主注入的权威值），
    // **不是** `requester.orgId`——那是通道解析出来的；生产上两者同值，但隔离键必须认宿主那一份。
    org,
    userId: requester?.userId ?? '(anonymous)',
    channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null,
    metricId,
    params: args,
    rowCount,
    verdict,
    reason,
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  // 词表 = L1（平台）∪ L2（本 org）——**合并加载器**，与 `GET /metrics`/MCP/chat 同一落点
  // （T8 评审 C1：这里曾用只回本 org 的加载器 ⇒ 平台指标在 /query 上 403「未声明」，
  //  而 console 把它列了出来——同一 id 在两条通道上胜负相反且无任何可观测信号）。
  const catalog = await loadMergedCatalog(deps.pool, org)
  const authz = authorize(catalog, requester, metricId, args)
  if (!authz.ok) {
    await audit('denied', authz.reason, null)
    return { status: 'denied', metricId, reason: authz.reason, detail: authz.detail }
  }

  let result: { columns: string[]; rows: unknown[][] }
  try {
    if (deps.execute) {
      result = await deps.execute(authz.plan.sql)
    } else {
      result = await runWarehouseSql(warehousePool(), authz.plan.sql)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const reason = detail === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured' : 'warehouse_error'
    await audit('error', reason, null)
    return { status: 'error', metricId, reason, detail }
  }

  await audit('ok', null, result.rows.length)
  return {
    status: 'ok',
    subject: authz.plan.subject,
    metricId,
    columns: result.columns,
    rows: result.rows,
    truncated: result.rows.length >= MAX_QUERY_ROWS,
  }
}
