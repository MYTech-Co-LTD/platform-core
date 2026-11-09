// declaration-compiler.ts — L1 声明 → 物化形状的**纯推导**（W8 起从
// `scripts/sync-data-semantics.mjs` 抽出，供「租户运行时声明写入」与 sync 脚本共用同一把尺）。
//
// 为什么抽出来：租户声明（`basis='declared'`）的 `select_sql` / `params` / `totalable` /
// `freshness_relations` 必须与 L1 物化**逐字同源**——两份实现漂开就是「同一条声明，仓库物化
// 一个形状、租户写入另一个形状」。脚本侧改为 re-export（`scripts/sync-data-semantics.mjs`），
// 原有 import 该脚本的测试/门禁不受影响。
//
// 纯函数：不碰 FS / 不碰 DB / 不读 env。调用方负责取声明、写库、审计。
import type { MetricParamDef } from './authz'

/** 关系.列 形态的引用（deriveRelation 的唯一判据）。 */
const QUALIFIED_REF_RE = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)/g
/** sources 路径里的资产段（要拼成 `stg_lemeng_<资产>`，故只允许小写字母/数字/下划线）。 */
const FRESHNESS_ASSET_RE = /^[a-z0-9_]+$/

/**
 * 新鲜度关系集推导（spec §10.7.3）：声明 `sources` 的存储路径段 `lemeng/<资产>` ⇒ 关系名
 * `stg_lemeng_<资产>`。推导不出来就**响亮失败**（瞎猜会让水位查询静默查空）。
 */
export function deriveFreshnessRelations(sources: readonly string[] | undefined): string[] {
  if (!Array.isArray(sources) || sources.length === 0) return []
  const relations: string[] = []
  for (const raw of sources) {
    const p = String(raw)
    const idx = p.indexOf('lemeng/')
    if (idx === -1) {
      throw new Error(
        `指标声明 sources 路径 \`${p}\` 里没有 \`lemeng/<资产>\` 段，推不出新鲜度关系名 `
        + '（spec §10.7.3 的推导依赖路径段与 staging 模型名 `stg_lemeng_<资产>` 同构）。'
        + '请把 sources 写成实际读的湖路径（如 `s3://<bucket>/lemeng/<资产>/…`），'
        + '或显式不写 sources（= 该指标无自动水位，响应不带 freshness 字段）。',
      )
    }
    const rest = p.slice(idx + 'lemeng/'.length)
    const asset = rest.split('/')[0] ?? ''
    if (!FRESHNESS_ASSET_RE.test(asset)) {
      throw new Error(
        `指标声明 sources 路径 \`${p}\` 的资产段 \`${asset}\` 形态不合规 —— 它要拼成 SQL 标识符 `
        + `\`stg_lemeng_${asset}\`，只允许小写字母/数字/下划线（staging 模型名同构）。`,
      )
    }
    const relation = `stg_lemeng_${asset}`
    if (!relations.includes(relation)) relations.push(relation)
  }
  return relations
}

/**
 * 从 expression 推 FROM 关系。只允许一个关系（跨模型聚合属于 marts 层）。
 */
export function deriveRelation(expression: string, metricName: string): string {
  const relations = new Set<string>()
  for (const m of expression.matchAll(QUALIFIED_REF_RE)) relations.add(m[1]!)
  if (relations.size === 0) {
    throw new Error(
      `指标 \`${metricName}\` 的 expression \`${expression}\` 里没有「关系.列」形态的引用，`
      + '取不到 FROM 的关系名 —— L1 的 select_sql 只能是 `select <表达式> as value[, <维度>] from <关系>` '
      + '这一形状，请把表达式的列写成 `<关系>.<列>`。',
    )
  }
  if (relations.size > 1) {
    throw new Error(
      `指标 \`${metricName}\` 的 expression 引用了多个关系（${[...relations].join(', ')}）：`
      + '单条 L1 声明的 select_sql 只有一个 FROM（跨模型聚合属于 marts 层的活，不是词表层能拼的）。',
    )
  }
  return [...relations][0]!
}

/**
 * 组装 `select_sql`（形状契约：与 semantic-compiler.ts 的 L1_SELECT_RE 同一条）。
 */
export function buildSelectSql(expression: string, grain: readonly string[], relation: string): string {
  const dims = grain.length > 0 ? `, ${grain.join(', ')}` : ''
  return `select ${expression} as value${dims} from ${relation}`
}

/** 问数参数白名单（spec 2026-10-15 §2.2；参数名 = 列名）。 */
const ASK_PARAM_WHITELIST: Record<string, MetricParamDef> = {
  bizday: { column: 'bizday', type: 'date_range' },
  system_book: { column: 'system_book', type: 'string' },
  domain: { column: 'domain', type: 'string' },
  branch_num: { column: 'branch_num', type: 'string' },
}

/** grain ∩ 白名单 → 参数面。 */
export function deriveParams(grain: readonly string[]): Record<string, MetricParamDef> {
  return Object.fromEntries(
    grain.filter((c) => Object.hasOwn(ASK_PARAM_WHITELIST, c))
      .map((c) => [c, ASK_PARAM_WHITELIST[c]!] as [string, MetricParamDef]),
  )
}

/**
 * 可加标记（spec §8.4）：flow + `sum(` 开头 + 无「空格夹除号」⇒ 可合计。
 */
export function deriveTotalable(expression: string, additivity = 'flow'): boolean {
  if (additivity !== 'flow') return false
  return /^\s*sum\s*\(/i.test(expression) && !/\s\/\s/.test(expression)
}

// ── 租户声明（W8，basis='declared'）编译与校验 ──────────────────────────────────
//
// 与 L1 的关系：L1 声明由 `dbt/semantics/l1_metrics.yml` 经 sync 物化；租户声明来自管理面请求体，
// **只收声明、不收 SQL**，形状校验与派生走同一组纯函数。v1 刻意不支持 `ratio:` 与
// `compose/dimensions/detail`（下钻）——它们需要 measures/domains 上下文与额外校验，先拒绝而不是
// 半支持（半支持的静默形态最贵）。

import { MASK_KINDS } from './authz'
import type { MaskSpec } from './authz'
import { sqlMentionsColumn } from './mask'
import { parseL1Select } from './semantic-compiler'

const TENANT_METRIC_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
const SCOPE_CODE_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
const ADDITIVITY = new Set(['flow', 'stock', 'non_additive'])

export interface DeclarationIssue { path: string; message: string }

export interface TenantDeclarationContext {
  /** B11：只允许 L1 已在用的 relation（租户不得引用未纳管表）。 */
  allowedRelations: ReadonlySet<string>
  /** 已声明实体名（`entity` 只能引用它们）。 */
  entities: ReadonlySet<string>
  /** relation → 实际列集合；缺省（无 warehouse）= 跳过列存在性检查（其余校验不降级）。 */
  columnsOf?: (relation: string) => ReadonlySet<string> | null
}

/** 编译结果：字段名与 `L1MetricDef` 对齐（写库侧再补 source/basis/certified）。 */
export interface CompiledTenantDeclaration {
  id: string
  title: string
  description: string
  sourceSystem: string
  requiredScope: string | null
  subjectColumn: string
  selectSql: string
  groupBy: string
  params: Record<string, MetricParamDef>
  totalable: boolean
  scopeNote: string
  slaDays: number
  freshnessRelations: string[]
  masks: MaskSpec[] | null
  unit: string | null
  entity: string | null
  synonyms: string[]
}

export type TenantDeclarationResult =
  | { ok: true; compiled: CompiledTenantDeclaration }
  | { ok: false; issues: DeclarationIssue[] }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * 校验并编译一条租户声明。任何一项不过 ⇒ 返回全部 issues（一次给全，不让人逐条试）。
 */
export function compileTenantDeclaration(
  input: unknown, ctx: TenantDeclarationContext,
): TenantDeclarationResult {
  const issues: DeclarationIssue[] = []
  const e = (input ?? {}) as Record<string, unknown>
  const push = (path: string, message: string): void => { issues.push({ path, message }) }

  const name = e.name
  if (!isStr(name) || !TENANT_METRIC_NAME_RE.test(name)) {
    push('name', '指标名必须是 `<源>:<业务域>:<指标>` 三段小写蛇形')
  }
  for (const f of ['expression', 'grain', 'owner', 'tier', 'definition', 'source', 'freshness_sla_days'] as const) {
    if (e[f] === undefined || e[f] === null || e[f] === '') push(f, `必填字段缺失：${f}`)
  }
  if (e.ratio !== undefined) {
    push('ratio', 'v1 不支持 ratio 声明（请用 expression；比率可用 `sum(a) / nullif(sum(b), 0)` 直接写）')
  }

  const expression = isStr(e.expression) ? e.expression.trim() : ''
  const grainRaw = e.grain
  const grain = Array.isArray(grainRaw) ? grainRaw.map(String) : []
  if (Array.isArray(grainRaw) && grain.length === 0) push('grain', 'grain 不能为空（至少一个维度，租户声明必须声明粒度）')

  let relation = ''
  let selectSql = ''
  if (expression !== '' && grain.length > 0) {
    try {
      relation = deriveRelation(expression, String(name))
      selectSql = buildSelectSql(expression, grain, relation)
      parseL1Select(selectSql)
    } catch (err) {
      push('expression', (err as Error).message)
    }
  }
  if (relation !== '' && !ctx.allowedRelations.has(relation)) {
    push('expression', `relation \`${relation}\` 不在 L1 已用关系集合里（B11：租户不得引用未纳管表）`)
  }
  // 列存在性（仅在有 warehouse 时）：表达式里 `<relation>.<col>` 的 col 逐个核。
  const cols = relation !== '' && ctx.columnsOf !== undefined ? ctx.columnsOf(relation) : null
  if (cols !== null && relation !== '') {
    const re = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g
    const seen = new Set<string>()
    for (const m of expression.matchAll(re)) {
      if (m[1] !== relation) continue
      if (!seen.has(m[2]!)) {
        seen.add(m[2]!)
        if (!cols.has(m[2]!)) push('expression', `列 \`${m[2]}\` 不在 ${relation} 的实际列清单里`)
      }
    }
    // grain 的列也必须真实存在（否则 group by 直接报错——那属于「写进去才发现」的晚失败）
    for (const g of grain) {
      if (!cols.has(g)) push('grain', `维度 \`${g}\` 不在 ${relation} 的实际列清单里`)
    }
  }

  const masksRaw = e.mask
  let masks: MaskSpec[] | null = null
  if (masksRaw !== undefined) {
    if (!Array.isArray(masksRaw) || masksRaw.length === 0) {
      push('mask', 'mask 必须是数组（或省略）')
    } else {
      masks = []
      for (const [i, item] of masksRaw.entries()) {
        const m = (item ?? {}) as Record<string, unknown>
        const column = typeof m.column === 'string' && m.column !== '' ? m.column : null
        const kind = typeof m.kind === 'string' ? m.kind : ''
        const grantedBy = typeof m.granted_by === 'string' ? m.granted_by.trim() : ''
        // 豁免码必填（fail-closed）：省略它等于让掩码对所有人静默不生效（安全面）。
        if (grantedBy === '' || !SCOPE_CODE_RE.test(grantedBy)) push(`mask[${i}].granted_by`, 'granted_by 必填且必须是 `<域>:<动作>` 形态')
        if (!(MASK_KINDS as readonly string[]).includes(kind)) push(`mask[${i}].kind`, `kind 必须是 ${MASK_KINDS.join(' / ')}`)
        if (column !== null && selectSql !== '' && !sqlMentionsColumn(selectSql, column)) {
          push(`mask[${i}].column`, `列 \`${column}\` 不在 select_sql 里（掩码不会生效）`)
        }
        const step = kind === 'round' && typeof m.step === 'number' && Number.isInteger(m.step) && m.step > 0 ? m.step : undefined
        if (kind === 'round' && step === undefined) push(`mask[${i}].step`, 'round 掩码必须给正整数 step')
        if (grantedBy !== '' && SCOPE_CODE_RE.test(grantedBy) && (MASK_KINDS as readonly string[]).includes(kind)) {
          masks.push({ column, kind: kind as MaskSpec['kind'], grantedBy, ...(step === undefined ? {} : { step }) })
        }
      }
      if (masks.length === 0) masks = null
    }
  }

  const entity = isStr(e.entity) ? e.entity.trim() : null
  if (entity !== null && !ctx.entities.has(entity)) push('entity', `实体 \`${entity}\` 不在 entities 声明里`)

  const scope = e.required_scope === undefined || e.required_scope === null || e.required_scope === ''
    ? null
    : String(e.required_scope).trim()
  if (scope !== null && !SCOPE_CODE_RE.test(scope)) push('required_scope', 'required_scope 必须是 `<域>:<动作>` 形态')

  const additivity = e.additivity === undefined ? 'flow' : String(e.additivity)
  if (!ADDITIVITY.has(additivity)) push('additivity', 'additivity 必须是 flow / stock / non_additive')

  const slaRaw = e.freshness_sla_days
  const slaDays = typeof slaRaw === 'number' ? slaRaw : Number(slaRaw)
  if (!Number.isInteger(slaDays) || slaDays < 1) push('freshness_sla_days', 'freshness_sla_days 必须是 ≥1 的整数')

  let freshnessRelations: string[] = []
  try {
    freshnessRelations = deriveFreshnessRelations(Array.isArray(e.sources) ? e.sources.map(String) : undefined)
  } catch (err) {
    push('sources', (err as Error).message)
  }

  const scopeNoteRaw = e.scope_note
  const scopeNote = scopeNoteRaw === undefined || scopeNoteRaw === null ? '' : String(scopeNoteRaw).trim()
  if (scopeNoteRaw !== undefined && scopeNoteRaw !== null && scopeNote === '') push('scope_note', 'scope_note 声明了但为空')

  const synonyms = Array.isArray(e.synonyms) ? e.synonyms.map(String).filter((x) => x.trim() !== '') : []
  const tier = isStr(e.tier) ? e.tier.trim() : ''
  if (tier !== '' && tier !== 'experimental') push('tier', '租户声明只允许 tier=experimental（租户不能自升 certified）')

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    compiled: {
      id: String(name),
      title: isStr(e.label) ? e.label.trim() : String(name),
      description: String(e.definition),
      sourceSystem: String(e.source),
      requiredScope: scope,
      subjectColumn: 'org',
      selectSql,
      groupBy: grain.join(', '),
      params: deriveParams(grain),
      totalable: deriveTotalable(expression, additivity),
      scopeNote,
      slaDays,
      freshnessRelations,
      masks,
      unit: isStr(e.unit) ? e.unit.trim() : null,
      entity,
      synonyms,
    },
  }
}
