// relations.ts —— 语义关系的解析与 join 编译（W7 Task 2，纯函数）。
//
// 纪律（与 relations.yml 头注同源）：
//   · 只有 `status: verified` 且 `matchRate >= 0.95` 的关系可用于分析 join；
//   · 目标关系若声明了 `dedupRule`（如 latest_snapshot），生成**去重子查询**再 join——
//     2026-11-07 实测：维表 ≈42 行/商品，不去重会把 7,221 行放大成 298,709（41 倍）。
import { parse as parseYaml } from 'yaml'

export interface RelationDecl {
  name: string
  from: { relation: string; column: string }
  to: { relation: string; column: string }
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M'
  dedupRule?: string
  status: 'candidate' | 'verified'
  evidence: { matchRate: number | null; sampledDay?: string | null }
}

export type RelationIssue = { name: string; code: 'BAD_SHAPE' | 'LOW_MATCH' | 'NOT_VERIFIED' }

const RELATION_RE = /^[a-z_][a-z0-9_]*$/

/** 解析 relations.yml；坏形状进 issues（不静默丢弃，也不抛）。 */
export function parseRelationsYaml(raw: string | null | undefined): { relations: RelationDecl[]; issues: RelationIssue[] } {
  const relations: RelationDecl[] = []
  const issues: RelationIssue[] = []
  if (typeof raw !== 'string' || raw.trim() === '') return { relations, issues }
  let doc: unknown
  try { doc = parseYaml(raw) } catch { return { relations, issues: [{ name: '(yaml)', code: 'BAD_SHAPE' }] } }
  const list = (doc as { relations?: unknown })?.relations
  if (!Array.isArray(list)) return { relations, issues }
  for (const item of list) {
    const o = item as Record<string, unknown>
    const name = String(o?.name ?? '')
    const from = o?.from as Record<string, unknown> | undefined
    const to = o?.to as Record<string, unknown> | undefined
    const ev = (o?.evidence ?? {}) as Record<string, unknown>
    const shapeOk = RELATION_RE.test(name)
      && RELATION_RE.test(String(from?.relation ?? '')) && RELATION_RE.test(String(from?.column ?? ''))
      && RELATION_RE.test(String(to?.relation ?? '')) && RELATION_RE.test(String(to?.column ?? ''))
      && ['1:1', '1:N', 'N:1', 'N:M'].includes(String(o?.cardinality))
    if (!shapeOk) { issues.push({ name: name || '(unnamed)', code: 'BAD_SHAPE' }); continue }
    relations.push({
      name,
      from: { relation: String(from!.relation), column: String(from!.column) },
      to: { relation: String(to!.relation), column: String(to!.column) },
      cardinality: o!.cardinality as RelationDecl['cardinality'],
      ...(typeof o?.dedupRule === 'string' && o.dedupRule !== '' ? { dedupRule: o.dedupRule } : {}),
      status: o?.status === 'verified' ? 'verified' : 'candidate',
      evidence: {
        matchRate: typeof ev.matchRate === 'number' ? ev.matchRate : null,
        sampledDay: typeof ev.sampledDay === 'string' ? ev.sampledDay : null,
      },
    })
  }
  return { relations, issues }
}

export const JOIN_MIN_MATCH_RATE = 0.95
/** 只有 verified + 命中率达标的关系能用于分析 join。 */
export function joinableOf(decl: RelationDecl): RelationIssue['code'] | null {
  if (decl.status !== 'verified') return 'NOT_VERIFIED'
  if (decl.evidence.matchRate === null || decl.evidence.matchRate < JOIN_MIN_MATCH_RATE) return 'LOW_MATCH'
  return null
}

/**
 * 生成 join 片段。`dedupRule === 'latest_snapshot'` ⇒ 目标表先用
 * `distinct on (key) order by key, snapshot desc` 去重再 join（其余值暂不猜，报错让调用方显式加）。
 */
export function joinClauseOf(decl: RelationDecl, alias: string): string {
  const on = `${alias}.${decl.to.column} = ${decl.from.relation}.${decl.from.column}`
  if (decl.dedupRule === undefined) return `join ${decl.to.relation} ${alias} on ${on}`
  if (decl.dedupRule === 'latest_snapshot') {
    return `join (select distinct on (${decl.to.column}) ${decl.to.column} from ${decl.to.relation} order by ${decl.to.column} desc) ${alias} on ${alias}.${decl.to.column} = ${decl.from.relation}.${decl.from.column}`
  }
  throw new Error(`未支持的 dedupRule: ${decl.dedupRule}`)
}
