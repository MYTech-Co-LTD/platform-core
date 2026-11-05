// handlers.ts —— 需求台账工具的 impl。payload 形状与其它 MCP 工具一致（status/reason）。
//
// ⚠️ 依赖面刻意用**本文件自带的最小窄类型**，不从 `../../routes/mcp-rpc` import `McpDeps`：
//   domain 层不得反向依赖路由层（路由只是调用方之一）。`McpDeps` 在结构上可赋给本类型。
import type { Pool } from 'pg'
import { loadPlatformCatalog } from '../metric-store'
import type { MetricRow } from '../metric-store'
import { dismissDemand, listDemands } from './store'
import type { DemandKind, DemandRow } from './store'

/** 本文件需要的那部分 deps（结构窄类型；`McpDeps` / 测试桩都能直接传）。 */
export interface DemandToolDeps {
  pool: Pool
  org: string
  requester: { userId: string } | null
}

const KINDS: readonly DemandKind[] = ['alias_gap', 'new_metric', 'drill_gap', 'metric_hunt']

/**
 * 取数扫描上限（**安全上限，不是分页**）：`resolved` 是词表快照上的运行期判定，SQL 里没有
 * 这一列 ⇒ 必须先取一批、判完再按 `limit` 截。若把 `limit` 直接压给 SQL，累积 20+ 条已被
 * 词表自动消解（但没人 dismiss）的高 occurrence 行会把窗口占满，默认清单看起来是空的，
 * 真正未消解的新需求排在窗口外且无 offset 可翻。
 *
 * 500 行的量级足够覆盖单租户台账的活跃面；**命中上限时回包带 `truncated: true`**，
 * 不静默——让人知道还有没扫到的（再要就给 kind 过滤，而不是假装扫全了）。
 */
export const LIST_SCAN_LIMIT = 500

/**
 * resolved：词表快照上的自动判定（不写回）。`metric_hunt` 永不自动消解——口径是人决。
 */
export function resolvedOf(row: DemandRow, byId: ReadonlyMap<string, MetricRow>): { resolved: boolean; resolvedBy: string | null } {
  if (row.kind === 'alias_gap') {
    const t = row.target.toLowerCase()
    for (const m of byId.values()) {
      if (m.synonyms.some((s) => s.toLowerCase() === t)) return { resolved: true, resolvedBy: `synonym@${m.id}` }
    }
    return { resolved: false, resolvedBy: null }
  }
  if (row.kind === 'new_metric') {
    return byId.has(row.target)
      ? { resolved: true, resolvedBy: `metric@${row.target}` }
      : { resolved: false, resolvedBy: null }
  }
  if (row.kind === 'drill_gap') {
    return byId.get(row.target)?.drill !== undefined
      ? { resolved: true, resolvedBy: `drill@${row.target}` }
      : { resolved: false, resolvedBy: null }
  }
  return { resolved: false, resolvedBy: null }
}

export async function callDemandTool(
  d: DemandToolDeps, name: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === 'list_demand_signals') {
    const kind = typeof args.kind === 'string' && KINDS.includes(args.kind as DemandKind) ? args.kind as DemandKind : undefined
    if (args.kind !== undefined && kind === undefined) return { status: 'refused', reason: 'bad_kind' }
    const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, Number(args.limit))) : 20
    // **先取后过滤**：resolved 只存在于词表判定里，SQL 无法先滤；limit 压给 SQL 会被
    // 已消解的高 occurrence 行占满窗口（见 LIST_SCAN_LIMIT 头注）。
    const rows = await listDemands(d.pool, d.org, {
      ...(kind === undefined ? {} : { kind }),
      includeDismissed: args.includeDismissed === true,
      limit: LIST_SCAN_LIMIT,
    })
    const catalog = await loadPlatformCatalog(d.pool)
    const byId = new Map(catalog.map((m) => [m.id, m]))
    const items = rows.map((r) => ({ ...r, ...resolvedOf(r, byId) }))
      .filter((r) => args.includeResolved === true || !r.resolved)
      .slice(0, limit)
    return { status: 'ok', count: items.length, items, truncated: rows.length >= LIST_SCAN_LIMIT }
  }
  if (name === 'dismiss_demand_signal') {
    const id = Number(args.id)
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!Number.isInteger(id) || id <= 0 || reason === '') return { status: 'refused', reason: 'invalid_args' }
    const out = await dismissDemand(d.pool, d.org, id, d.requester?.userId ?? '(anonymous)', reason)
    if (out.status === 'not_found') return { status: 'not_found', reason: 'demand_not_found', id }
    if (out.status === 'already') {
      return { status: 'ok', reason: 'already_dismissed', id, dismissedBy: out.row.dismissedBy, dismissReason: out.row.dismissReason }
    }
    return { status: 'ok', id }
  }
  return { status: 'refused', reason: 'unknown_tool', name }
}
