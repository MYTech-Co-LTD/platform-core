// explore-exec.ts —— W6 Task 2：把 `explore_query` 接到真实的只读通道上（上下文装载 + 执行 + 审计）。
//
// 分工：`explore.ts` 只做纯校验/编译；本文件负责三件有副作用的事——
//   ① 装载上下文（仓内 marts 白名单 + 运行时列清单 + 掩码集合）；
//   ② 执行（只读池 + 参数化 SQL）；
//   ③ 写审计（成功/拒绝/出错都写，`tool='explore_query'`）。
// 审计里**不落过滤值**（可能是手机号这类业务敏感值）：只记列名与 op，shape 足以复盘。
import type { Pool } from 'pg'
import { loadMergedCatalog } from '../metric-store'
import { maskedTargets, wholeValueMaskedRelations } from '../private-measure'
import { writeAudit } from '../audit-store'
import type { Channel } from '../authz'
import { loadDbtModels } from '../system-map/map'
import { compileExplore } from './explore'
import type { ExploreContext, ExploreErrorCode, ExploreSpec } from './explore'

export interface ExploreExecutor {
  (sql: string, params: readonly unknown[]): Promise<{ columns: string[]; rows: unknown[][] }>
}

export interface ExploreDeps {
  /** 平台库（词表掩码 + 审计）。 */
  pool: Pool
  org: string
  requesterUserId: string
  channel: Channel
  keyId: number | null
  /** 只读执行器（分析师面恒为 `analystPool` + 参数化）。 */
  exec: ExploreExecutor
  /** 仓根（测试注入；缺省由 `loadDbtModels` 自己找）。 */
  repoRoot?: string
  /** 上下文装载缝（测试注入；缺省 = 真库 + 仓内 marts 白名单）。 */
  loadContext?: () => Promise<ExploreContext>
  /**
   * 是否由本层写审计（缺省 true）。
   * 经 `/mcp` 工具调用时传 false——`callTool` 是审计唯一分发点（registry 不变量），
   * 再写一条就是双份；此时由 impl 回填 `auditMetricId` / `auditRowCount` 给 callTool。
   */
  audit?: boolean
}

export interface ExploreOk {
  ok: true
  columns: string[]
  rows: unknown[][]
  rowCount: number
  /** true = 达到 limit（**可能**还有更多；不谎称"全集"）。 */
  truncated: boolean
  sql: string
  preview: string
  auditId: number | null
}

export interface ExploreFail {
  ok: false
  code: ExploreErrorCode | 'NO_CONTEXT' | 'EXEC_FAILED'
  detail?: string
  auditId: number | null
}

export type ExploreResult = ExploreOk | ExploreFail

/** 仓内 marts 模型名（唯一白名单事实源：`dbt/models/**\/marts/*.sql`）。 */
export function martsWhitelist(repoRoot?: string): Set<string> {
  return new Set(
    loadDbtModels(repoRoot)
      .filter((m) => (m.path ?? '').includes('/marts/'))
      .map((m) => m.name),
  )
}

/**
 * 装载上下文。列清单**每次现算**（schema 变了要立刻生效）；表未见 ⇒ 交由编译期
 * `RELATION_NOT_ALLOWED` 处理。掩码集合来自本租户词表（L1 声明 + L2 行）。
 */
export async function loadExploreContext(deps: {
  /** 平台库（词表/掩码）。⚠️ 列清单**不在这里**——列在仓库库。 */
  pool: Pool
  /** 仓库只读执行器（`information_schema` 必须问仓库，问平台库会恒空 ⇒ 全部表「不可见」）。 */
  exec: ExploreExecutor
  org: string
  repoRoot?: string
  /** 词表装载缝（测试注入；缺省 = `loadMergedCatalog(pool, org)`）。 */
  loadCatalog?: () => Promise<readonly import('../metric-store').MetricRow[]>
}): Promise<ExploreContext> {
  const allowedRelations = martsWhitelist(deps.repoRoot)
  const catalog = deps.loadCatalog !== undefined ? await deps.loadCatalog() : await loadMergedCatalog(deps.pool, deps.org)
  const maskedColumns = maskedTargets(catalog)
  const maskedRelations = wholeValueMaskedRelations(catalog)

  const colsResult = await deps.exec(
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = $1 and table_name = any($2::text[])
      order by table_name, ordinal_position`,
    ['staging', [...allowedRelations]],
  )
  const columns = new Map<string, Array<{ name: string; dataType: string }>>()
  for (const row of colsResult.rows) {
    const name = String(row[0] ?? '')
    const column = String(row[1] ?? '')
    const dataType = String(row[2] ?? '')
    if (name === '' || column === '') continue
    const list = columns.get(name) ?? []
    list.push({ name: column, dataType })
    columns.set(name, list)
  }
  return { allowedRelations, columns, maskedColumns, maskedRelations }
}

/** 审计用的 spec 形状（**值不落库**）。 */
function auditShapeOf(spec: unknown): Record<string, unknown> {
  const s = (typeof spec === 'object' && spec !== null ? spec : {}) as Record<string, unknown>
  const filters = Array.isArray(s.filters) ? s.filters : []
  return {
    relation: typeof s.relation === 'string' ? s.relation : null,
    measures: Array.isArray(s.measures) ? s.measures.length : 0,
    dimensions: Array.isArray(s.dimensions) ? s.dimensions : [],
    filters: filters.map((f) => {
      const r = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>
      return { column: r.column ?? null, op: r.op ?? null }
    }),
    limit: typeof s.limit === 'number' ? s.limit : null,
  }
}

/**
 * 执行一次 explore。顺序：装载上下文 → 编译（拒则审计 denied）→ 执行（错则审计 error）
 * → 成功审计 ok。任何分支都返回 `auditId`（能独立核对审计行）。
 */
export async function executeExplore(deps: ExploreDeps, spec: ExploreSpec | unknown): Promise<ExploreResult> {
  const shape = auditShapeOf(spec)
  const metricId = `explore:${String(shape.relation ?? 'unknown')}`
  const shouldAudit = deps.audit !== false
  const auditEntry = async (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
  ): Promise<number | null> => {
    if (!shouldAudit) return null
    const written = await writeAudit(deps.pool, {
      org: deps.org, userId: deps.requesterUserId, channel: deps.channel, keyId: deps.keyId,
      metricId, params: shape, rowCount, verdict, reason, masking: null, tool: 'explore_query',
    }).catch(() => null)
    return written?.id ?? null
  }

  let context: ExploreContext
  try {
    context = deps.loadContext !== undefined
      ? await deps.loadContext()
      : await loadExploreContext({ pool: deps.pool, exec: deps.exec, org: deps.org, repoRoot: deps.repoRoot })
  } catch (e) {
    return { ok: false, code: 'NO_CONTEXT', detail: (e as Error).message, auditId: await auditEntry('error', 'NO_CONTEXT', null) }
  }

  const compiled = compileExplore(spec, context)
  if (!compiled.ok) {
    return {
      ok: false, code: compiled.code, detail: compiled.detail,
      auditId: await auditEntry('denied', compiled.code, null),
    }
  }

  try {
    const result = await deps.exec(compiled.sql, [deps.org, ...compiled.params])
    const limit = (spec as { limit?: number }).limit ?? 200
    const auditId = await auditEntry('ok', null, result.rows.length)
    return {
      ok: true,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.rows.length >= limit,
      sql: compiled.sql,
      preview: compiled.preview,
      auditId,
    }
  } catch (e) {
    return { ok: false, code: 'EXEC_FAILED', detail: (e as Error).message, auditId: await auditEntry('error', 'EXEC_FAILED', null) }
  }
}
