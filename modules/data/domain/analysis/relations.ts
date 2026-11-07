// relations.ts —— 语义关系的解析与 join 编译（W7 Task 2，纯函数）。
//
// 纪律（与 relations.yml 头注同源）：
//   · 只有 `status: verified` 且 `matchRate >= 0.95` 的关系可用于分析 join；
//   · 目标关系若声明了 `dedupRule`（如 latest_snapshot），生成**去重子查询**再 join——
//     2026-11-07 实测：维表 ≈42 行/商品，不去重会把 7,221 行放大成 298,709（41 倍）。
import { parse as parseYaml } from 'yaml'

export interface RelationKeyPair { from: string; to: string }

export interface RelationDecl {
  name: string
  from: { relation: string; column: string }
  to: { relation: string; column: string }
  /**
   * 附加等值键。**键列名字面量**，参与 join 的 on 与去重分区。
   *
   * ★ 为什么必须支持（2026-11-07 真机实测）：单列键会跨账套串表——
   *   `fct_retail_sale` 与 `dim_lemeng_branch` 都含 3120/64188 两账套，`branch_num` 跨账套重号；
   *   单键 join 把 202 行放大成 14,292 行（70×）。带上 `system_book` 后逐行不变。
   *   `fct_retail_item_sale × dim_item_latest` 单键 7,867→8,785 行（+11.7%），同样要带账套。
   */
  keys: RelationKeyPair[]
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
    const keysRaw = o?.keys === undefined || o?.keys === null ? [] : o.keys
    const keysOk = Array.isArray(keysRaw) && keysRaw.every((k) => {
      const kp = (k ?? {}) as Record<string, unknown>
      return RELATION_RE.test(String(kp.from ?? '')) && RELATION_RE.test(String(kp.to ?? ''))
    })
    // dedupRule 只认已实现的语义；未知值进 issues（不猜，避免编译期抛错穿透执行层）。
    const dedupOk = o?.dedupRule === undefined || o?.dedupRule === 'latest_snapshot'
    const shapeOk = RELATION_RE.test(name)
      && RELATION_RE.test(String(from?.relation ?? '')) && RELATION_RE.test(String(from?.column ?? ''))
      && RELATION_RE.test(String(to?.relation ?? '')) && RELATION_RE.test(String(to?.column ?? ''))
      && ['1:1', '1:N', 'N:1', 'N:M'].includes(String(o?.cardinality))
      && keysOk && dedupOk
    if (!shapeOk) { issues.push({ name: name || '(unnamed)', code: 'BAD_SHAPE' }); continue }
    relations.push({
      name,
      from: { relation: String(from!.relation), column: String(from!.column) },
      to: { relation: String(to!.relation), column: String(to!.column) },
      keys: (keysRaw as Array<Record<string, unknown>>).map((k) => ({ from: String(k.from), to: String(k.to) })),
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
 * `distinct on (主键+附加键) ... order by ..., snapshot desc` 取最新一版再 join。
 *
 * `targetHasOrg`：目标表有 org 列时，去重分区带 org、join 也钉同 org——
 * 避免多租户同库时把别家的维表行当成本租户标签。
 */
export function joinClauseOf(
  decl: RelationDecl,
  alias: string,
  opts: { targetHasOrg?: boolean } = {},
): string {
  const hasOrg = opts.targetHasOrg === true
  const on = [
    `${alias}.${decl.to.column} = ${decl.from.relation}.${decl.from.column}`,
    ...decl.keys.map((k) => `${alias}.${k.to} = ${decl.from.relation}.${k.from}`),
    ...(hasOrg ? [`${alias}.org = ${decl.from.relation}.org`] : []),
  ].join(' and ')
  if (decl.dedupRule === undefined) return `join ${decl.to.relation} ${alias} on ${on}`
  if (decl.dedupRule === 'latest_snapshot') {
    const partition = [...(hasOrg ? ['org'] : []), decl.to.column, ...decl.keys.map((k) => k.to)]
    return `join (select distinct on (${partition.join(', ')}) * from ${decl.to.relation}`
      + ` order by ${partition.join(', ')}, snapshot desc) ${alias} on ${on}`
  }
  throw new Error(`未支持的 dedupRule: ${decl.dedupRule}`)
}

/**
 * 为一次探索挑选可用的 join 子句：只取**本表作为 from 侧**、且 `joinableOf` 通过的关系。
 * 未通过的关系**不进 SQL**（宁可不 join，也不生成一个会放大行数的连接）。
 * 别名即关系名：调用方用 `<关系名>.<列>` 引用被 join 表的列。
 */
export function joinsForRelation(
  declarations: readonly RelationDecl[],
  relation: string,
): Array<{ declaration: RelationDecl; clause: string; alias: string }> {
  const out: Array<{ declaration: RelationDecl; clause: string; alias: string }> = []
  for (const d of declarations) {
    if (d.from.relation !== relation) continue
    if (joinableOf(d) !== null) continue
    const alias = d.name
    out.push({ declaration: d, alias, clause: joinClauseOf(d, alias) })
  }
  return out
}
