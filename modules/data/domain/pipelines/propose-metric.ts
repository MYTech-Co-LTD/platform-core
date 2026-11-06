// propose-metric.ts —— L1 指标声明草案组装器（W3 Task 1，issue #1401；plan
// docs/superpowers/plans/2026-11-05-amd-w3-l1-proposal.md）。
//
// ★ 零写入是**结构性**的（同 propose.ts 的红线）：compose 是纯函数（不碰 fs、不碰网络），
//   piece 只进回包；唯二的 fs 接触在 impl 侧且都是**只读**（现行 l1_metrics.yml）。
//
// ── 全量文件 piece 的保真策略（为什么不是 parseDocument().toString()）───────────────────────
// 实测（2026-11-05）：对现行 l1_metrics.yml（1360 行）整树 parseDocument→toString 会**改写 1217 行**
// —— block scalar 按默认宽度重折、flow 序列补内衬空格、`domains:` 的键对齐丢失。手写的折行/对齐/注释
// 不是 AST 的一部分，toString 拼不回来。故本文件做**文本手术**：
//   · AST（parseDocument 的 item.range 源码偏移）只用来**定位**插入/替换锚点；
//   · 新条目文本 = 单独 Document 按 house style 序列化（name/expression 单引号、definition 折叠块
//     标量、grain/synonyms flow、sla 数值），再按条目缩进重排；
//   · piece = 现行**原文**在锚点处拼接——未触碰区域逐字不动（结构性成立，不靠「记得别碰」）；
//   · 拼完**回读校验**：重解析无错、条目数 ±1/不变、未触碰条目源码切片逐字相等、新条目 definition/
//     expression 回读与输入逐字一致——任一失配 ⇒ ok:false 拒绝产出（fail-closed，不出坏草案）。
//
// ── 修改模式（同名已存在）──────────────────────────────────────────────────────────────────
// 条目按输入整体重写（definition 必须变，防无意义重提）；**输入不管的键**（unit/sources/compose/
// detail/mask…以及输入未给的 entity/synonyms）从原条目**带过**（值保真，防重写丢键——丢 sources 会
// 静默断掉新鲜度水位链）。键序按本工具的固定序重排、条目内行内注释不保留（advisory 会注明）；
// 不能接受重排就人手改文件——本工具只负责把口径变更变成可审的草案。
//
// ── 判据同源（不新造尺）──────────────────────────────────────────────────────────────────
//   · 命名三段式 / 保留前缀 / ratio / sla 形状：`scripts/check-data-models.mjs` 的导出（领域门禁
//     ⑤⑥ 同一把尺）；`source` 形态：platform-sdk 的 `METRIC_SOURCE_RE`（声明侧与登记侧同字面量）。
//   · expression 形态与禁词：`parseL1Select`（semantic-compiler，编译/运行期同一解析器）。
//   · B11 relation 白名单：从 currentYaml 的 metrics[] 反解（同 private-measure.ts 的
//     `whitelistedRelations` 形态——同一 parseL1Select、坏条目跳过不授予）。
//   · 对账文件名：`metricToAuditFileName`（唯一映射事实源）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, Scalar, isMap, isSeq, parseDocument } from 'yaml'
import { REPO_ROOT } from './defs'
import type { PipelineRoots } from './defs'
import { MAX_RATIONALE, NOTE, badParam, refused, slugOf, textArg } from './propose'
import type { DownstreamItem, ProposedFile } from './propose'
import { METRIC_SOURCE_RE } from '@platform/sdk'
// 领域门禁的**同一把尺**（check-data-models 的纯核导出；plan 开工前置已验可直 import .mjs）。
// ⚠️ 该 .mjs 属**根 tsconfig 工程**（checkJs+allowJs，类型靠 JSDoc）；modules/* 工程没开 allowJs
// ⇒ 对它 TS7016（找不到声明）。不另写 .d.mts 壳：声明文件会在根工程里**遮蔽 .mjs 本体**，
// 把 test.ts 看到的导出砍到只剩壳里声明的几个（实测 TS2305 五连）。故就地压制这一条、值保持 any
// （RESERVED_METRIC_ID_PREFIXES.find 的回调参数等处因此要显式标注类型）。
// @ts-expect-error TS7016: Could not find a declaration file for module '../../../../scripts/check-data-models.mjs'
import { METRIC_NAME_RE, RESERVED_METRIC_ID_PREFIXES, freshnessSlaError, metricToAuditFileName, ratioShapeError } from '../../../../scripts/check-data-models.mjs'
import { SemanticCompileError, parseL1Select } from '../semantic-compiler'
import type { Issue } from './validate-types'
import type { PipelineDeps, PipelineImpl } from './types'

/** 现行语义声明的仓内相对路径（piece 1 的落点；impl 侧只读它；apply 白名单同源）。 */
export const SEMANTICS_YAML_REL = 'dbt/semantics/l1_metrics.yml'

/** 对账 singular test 的目录前缀（piece 2 的落点；apply 白名单同源，不抄第二份字面量）。 */
export const DBT_TESTS_DIR = 'dbt/tests'

/** tier 闭集（l1_metrics.yml 头注的字段约定；tier 是标记不是强制，但拼错等于没标）。 */
const TIERS = ['certified', 'experimental'] as const

/** 干净标识符（grain 每项会被消费层原样拼进 GROUP BY，同 semantic-compiler assertCleanDims 的理由）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 输入的 expression 形态：单列聚合 `sum|avg|min|max|count[ distinct](relation.column)`。
 * 这是**提案侧的收严**（W3 范围 = 私有测度/候选升级来的单列聚合）；现行文件里存在的复合表达
 * （`sum(a) - sum(b)`、`case when …`）不在此闭集内——它们是人工维护的既有事实，不是本工具的产出面。
 * 分组：1=聚合函数 2=relation 3=column（`distinct` 非捕获）。
 */
const AGG_SIMPLE_RE = /^(sum|avg|min|max|count)\s*\(\s*(?:distinct\s+)?([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\)$/

/** 「关系.列」引用（与 check-data-models ratioShapeError 内部正则同形；用于反解 relation）。 */
const REL_REF_RE = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*/g

/**
 * 声明草案输入。字段值按 `unknown` 收（调用方传 MCP 原始 args 或升级链的组装产物均可），
 * 逐字段机检在 compose 里做——非法形状出的是**逐字段 issue**，不是抛错。
 * `rationale` 不进 YAML（进回包/审计），由 impl 侧要求非空。
 */
export interface MetricDeclarationInput {
  name: unknown
  label: unknown
  definition: unknown
  /** 与 ratio 互斥：单列聚合（AGG_SIMPLE_RE + parseL1Select 双闸）。 */
  expression?: unknown
  /** 与 expression 互斥：率类声明 `{ numerator, denominator }`（ratioShapeError 判形状）。 */
  ratio?: unknown
  grain: unknown
  owner: unknown
  tier: unknown
  source: unknown
  freshnessSlaDays: unknown
  /** 选填：必须已声明在顶层 `entities:` 里（本工具不改 entities:——增量限定在 metrics[]）。 */
  entity?: unknown
  /** 选填：字符串数组。 */
  synonyms?: unknown
  /** 选填：对账 singular test 原文（piece 2，不加工）；缺省 ⇒ validation 注明 + downstream required。 */
  auditSql?: unknown
  rationale?: unknown
}

export type MetricComposeResult =
  | {
    ok: true
    /** create = 新条目；modify = 同名条目按输入重写（definition 必须已变）。 */
    mode: 'create' | 'modify'
    title: string
    branch: string
    pieces: ProposedFile[]
    downstream: DownstreamItem[]
    /** **advisory**（不拒）：auditSql 缺席注记、修改模式行为注记。 */
    validation: Issue[]
  }
  | { ok: false; issues: Issue[] }

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────────
const strOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** yaml 节点的最小结构面（只声明本文件用到的属性，避免与包类型纠缠）。 */
interface YamlScalarLike { value?: unknown; type?: string }
interface YamlPairLike { key: unknown; value: unknown }
interface YamlCollectionLike {
  get(key: string, keep?: boolean): unknown
  items: YamlPairLike[]
  range?: [number, number, number] | null
  flow?: boolean
}
const asMap = (v: unknown): YamlCollectionLike | null =>
  isMap(v) ? (v as unknown as YamlCollectionLike) : null
const asSeq = (v: unknown): YamlCollectionLike | null =>
  isSeq(v) ? (v as unknown as YamlCollectionLike) : null
const scalarOf = (node: unknown, key: string): YamlScalarLike | null => {
  const map = asMap(node)
  if (map === null) return null
  const s = map.get(key, true) as YamlScalarLike | null | undefined
  return s ?? null
}
const scalarText = (node: unknown, key: string): string => {
  const s = scalarOf(node, key)
  return s !== null && typeof s.value === 'string' ? s.value : ''
}
const keyNameOf = (pair: YamlPairLike): string => {
  const k = pair.key as YamlScalarLike | null | undefined
  return k !== null && k !== undefined && typeof k.value === 'string' ? k.value : ''
}

/** 从文本里反解「关系.列」引用的关系集合（单数才可信：多个关系 = 单 FROM 装不下）。 */
const relationsOfText = (text: string): Set<string> =>
  new Set([...text.matchAll(REL_REF_RE)].map((m) => m[1]))

/**
 * L1 已用 relation 集合：从 metrics[] 逐条反解（expression 优先，率类取 ratio 的分子分母），
 * 每条都要**过 parseL1Select** 才授予（坏条目跳过不授予——方向是少授权，同 whitelistedRelations）。
 */
function l1RelationsOf(items: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const item of items) {
    // YAMLSeq 的 items 是**节点**（块序列下每项直接是 YAMLMap），不是 {key,value} pair
    const map = asMap(item)
    if (map === null) continue
    const expr = scalarText(map, 'expression')
    const ratio = asMap(map.get('ratio', true))
    const text = expr !== ''
      ? expr
      : ratio !== null
        ? `${scalarText(ratio, 'numerator')} ${scalarText(ratio, 'denominator')}`.trim()
        : ''
    if (text === '') continue
    const rels = relationsOfText(text)
    if (rels.size !== 1) continue
    const rel = [...rels][0] ?? ''
    try {
      parseL1Select(`select ${text} as value from ${rel}`)
    } catch {
      continue
    }
    out.add(rel)
  }
  return out
}

// ── 新条目文本（house style 序列化）─────────────────────────────────────────────────────────
/** 输出键序：托管键按此固定序；修改模式「输入不管的键」带过后追加在末尾（保持原相对序）。 */
const MANAGED_KEYS = ['name', 'label', 'entity', 'synonyms', 'definition', 'expression', 'ratio',
  'grain', 'owner', 'tier', 'source', 'freshness_sla_days'] as const

interface EntryFields {
  name: string
  label: string
  definition: string
  expression: string          // '' = 用 ratio
  ratio: { numerator: string; denominator: string } | null
  grain: string[]
  owner: string
  tier: string
  source: string
  freshnessSlaDays: number
  entity: string              // '' = 不落该键
  synonyms: string[] | null   // null = 不落该键
}

/** 把单条目序列化成 `  - name: …` 起的块文本（首行加 `- `、其余缩进 4；空行保持空）。 */
const indentEntry = (body: string): string => {
  const lines = body.replace(/\n+$/, '').split('\n')
  return ['  - ' + (lines[0] ?? ''), ...lines.slice(1).map((l) => (l === '' ? l : '    ' + l)), ''].join('\n')
}

const serializeEntry = (f: EntryFields, carriedPairs: YamlPairLike[]): string => {
  const entryDoc = new Document()
  const obj: Record<string, unknown> = {
    name: f.name, label: f.label,
    ...(f.entity !== '' ? { entity: f.entity } : {}),
    ...(f.synonyms !== null ? { synonyms: f.synonyms } : {}),
    definition: f.definition,
    ...(f.ratio !== null
      ? { ratio: { numerator: f.ratio.numerator, denominator: f.ratio.denominator } }
      : { expression: f.expression }),
    grain: f.grain, owner: f.owner, tier: f.tier, source: f.source,
    freshness_sla_days: f.freshnessSlaDays,
  }
  entryDoc.contents = entryDoc.createNode(obj)
  const node = entryDoc.contents as unknown as YamlCollectionLike
  const quote = (key: string): void => {
    const s = node.get(key, true) as YamlScalarLike | null | undefined
    if (s !== null && s !== undefined) s.type = Scalar.QUOTE_SINGLE
  }
  quote('name')
  if (f.ratio === null) quote('expression')
  else {
    const ratio = node.get('ratio', true) as YamlCollectionLike | null | undefined
    if (ratio !== null && ratio !== undefined) {
      for (const k of ['numerator', 'denominator']) {
        const s = ratio.get(k, true) as YamlScalarLike | null | undefined
        if (s !== null && s !== undefined) s.type = Scalar.QUOTE_SINGLE
      }
    }
  }
  const def = node.get('definition', true) as YamlScalarLike | null | undefined
  if (def !== null && def !== undefined) def.type = Scalar.BLOCK_FOLDED
  for (const key of ['grain', 'synonyms']) {
    const seq = node.get(key, true) as YamlCollectionLike | null | undefined
    if (seq !== null && seq !== undefined) seq.flow = true
  }
  // 修改模式的带过键：原样搬 pair（键与值都是解析出的节点，值保真）；追加在托管键之后。
  for (const pair of carriedPairs) node.items.push(pair)
  return indentEntry(entryDoc.toString({ lineWidth: 100 }))
}

// ── 条目机检（compose 与 apply 重校验共用的同一把尺；W3 Task 2 抽出）────────────────────────
/** 归一化产物：机检 issues + 反解出的 relation + 归一后的字段值（EntryFields / apply 重校验共用）。 */
export interface MetricDeclarationCheck {
  issues: Issue[]
  /** expression/ratio 反解出的 relation（'' = 无有效 relation——该档缺输入或形状非法，已记 issue）。 */
  relation: string
  /** 归一后的 ratio（null = 不走 ratio；ratio 在场但反解失败时也为 null 且已记 issue）。 */
  ratio: { numerator: string; denominator: string } | null
  /** 归一后的托管字段值（strOf 去空白后；'' = 缺失/非法，已记 issue）。 */
  fields: {
    name: string
    label: string
    definition: string
    expression: string          // '' = 不走 expression（用 ratio / 或两者都缺）
    grain: string[]
    owner: string
    tier: string
    source: string
    freshnessSlaDays: unknown
    entity: string              // '' = 未声明（entity 的声明性检查在对现行文件的越界机检里）
    synonyms: string[] | null   // null = 不落该键
  }
}

/**
 * 单条目机检（原 compose 的 A 段，逐字抽出）：name/label/definition/expression|ratio/grain/owner/
 * tier/source/sla/synonyms 的形状判据全部来自本文件顶部引用的既有尺（check-data-models 导出 +
 * parseL1Select + METRIC_SOURCE_RE）——apply 重校验（semanticsYamlPieceIssues）调它，**不抄第二份**。
 * **不含** auditSql（compose 专属输入）与对现行文件的越界检查（见 {@link metricContextIssues}——
 * 那需要现行文件上下文）。
 */
export function checkMetricDeclaration(input: MetricDeclarationInput): MetricDeclarationCheck {
  const issues: Issue[] = []
  const name = strOf(input.name)
  if (name === '') issues.push({ path: 'name', message: '必填（非空白字符串）' })
  else if (!METRIC_NAME_RE.test(name)) {
    issues.push({ path: 'name', message: `不合规——必须是 \`<源>:<业务域>:<指标>\` 命名空间形态（三段都小写蛇形，如 \`lemeng:retail:net_sales\`）；命名空间决定对账文件名（\`:\`→\`__\`）` })
  } else {
    const reserved = (RESERVED_METRIC_ID_PREFIXES as string[]).find((p: string) => name.startsWith(p))
    if (reserved !== undefined) {
      issues.push({ path: 'name', message: `占用了**保留给测试夹具**的命名空间 \`${reserved}\`（${RESERVED_METRIC_ID_PREFIXES.join(' / ')}）——真声明占用后，某个测试的清理会把这条真行删掉（check-data-models 规则 ⑥-c）` })
    }
  }
  const label = strOf(input.label)
  if (label === '') issues.push({ path: 'label', message: '必填（非空白字符串）' })
  const definition = strOf(input.definition)
  if (definition === '') issues.push({ path: 'definition', message: '必填（口径的逐字定义，治理机制① 的必需字段）' })
  else if (definition.includes('\n')) {
    issues.push({ path: 'definition', message: '含换行——定义请写成一行（YAML 折叠排版由组装处理；换行会破坏回读逐字一致）' })
  }

  const exprRaw = strOf(input.expression)
  const hasExpr = exprRaw !== ''
  const hasRatio = input.ratio !== undefined && input.ratio !== null && input.ratio !== ''
  let relation = ''
  let ratio: { numerator: string; denominator: string } | null = null
  if (hasExpr && hasRatio) {
    issues.push({ path: 'expression', message: ratioShapeError({ name: name === '' ? '(未知名)' : name, expression: exprRaw, ratio: input.ratio }) ?? 'expression 与 ratio 互斥' })
  } else if (!hasExpr && !hasRatio) {
    issues.push({ path: 'expression', message: ratioShapeError({ name: name === '' ? '(未知名)' : name }) ?? '缺 expression（率类请改用 ratio）' })
  } else if (hasExpr) {
    const m = AGG_SIMPLE_RE.exec(exprRaw)
    if (m === null) {
      issues.push({ path: 'expression', message: `形态不合规——必须是 \`sum|avg|min|max|count[ distinct](relation.column)\`（如 \`sum(fct_retail_sale.sale_amount)\`）：${exprRaw}` })
    } else {
      relation = m[2] ?? ''   // 分组：1=聚合函数 2=relation 3=column
      try {
        parseL1Select(`select ${exprRaw} as value from ${relation}`)
      } catch (e) {
        issues.push({ path: 'expression', message: e instanceof SemanticCompileError ? e.message : `不合 L1 select 形状契约：${String(e)}` })
      }
    }
  } else {
    const err = ratioShapeError({ name: name === '' ? '(未知名)' : name, ratio: input.ratio })
    if (err !== null) {
      issues.push({ path: 'ratio', message: err })
    } else {
      const r = input.ratio as { numerator?: unknown; denominator?: unknown }
      const num = String(r.numerator ?? '')
      const den = String(r.denominator ?? '')
      const rels = relationsOfText(`${num} ${den}`)
      if (rels.size !== 1) {
        issues.push({ path: 'ratio', message: '分子/分母必须含「关系.列」形态的引用且为同一关系（FROM 关系由它反推）' })
      } else {
        relation = [...rels][0] ?? ''
        try {
          parseL1Select(`select ${num} as value from ${relation}`)
        } catch (e) {
          issues.push({ path: 'ratio', message: e instanceof SemanticCompileError ? e.message : `不合 L1 select 形状契约：${String(e)}` })
        }
      }
    }
    if (relation === '') ratio = null
    else ratio = { numerator: String((input.ratio as { numerator?: unknown }).numerator ?? ''), denominator: String((input.ratio as { denominator?: unknown }).denominator ?? '') }
  }

  const grainRaw = input.grain
  const grain = Array.isArray(grainRaw)
    ? grainRaw.map((g) => (typeof g === 'string' ? g.trim() : ''))
    : []
  if (grain.length === 0 || grain.some((g) => g === '' || !IDENT_RE.test(g))) {
    issues.push({ path: 'grain', message: '必须是非空数组，且每项是干净标识符（可聚合维度会被消费层原样拼进 GROUP BY）' })
  }
  const owner = strOf(input.owner)
  if (owner === '') issues.push({ path: 'owner', message: '必填（口径负责人：谁改谁负责）' })
  const tier = strOf(input.tier)
  if (!(TIERS as readonly string[]).includes(tier)) {
    issues.push({ path: 'tier', message: `必须是 ${TIERS.join(' | ')}（tier 是成熟度标记不是强制，但拼错等于没标）` })
  }
  const source = strOf(input.source)
  if (source === '') issues.push({ path: 'source', message: '必填（源系统，如 lemeng；消费侧按它与「已接入源」逐字比对）' })
  else if (!METRIC_SOURCE_RE.test(source)) {
    issues.push({ path: 'source', message: `\`${source}\` 形态不合规——必须是小写蛇形（^[a-z][a-z0-9_]*$）；大写/连字符会与登记值比对不上，症状是「指标谁都看不见」` })
  }
  const slaErr = freshnessSlaError({ name: name === '' ? '(未知名)' : name, freshness_sla_days: input.freshnessSlaDays })
  if (slaErr !== null) issues.push({ path: 'freshnessSlaDays', message: slaErr })

  let synonyms: string[] | null = null
  if (input.synonyms !== undefined && input.synonyms !== null && input.synonyms !== '') {
    const raw = Array.isArray(input.synonyms) ? input.synonyms : null
    const list = raw === null ? null : raw.map((s) => (typeof s === 'string' ? s.trim() : ''))
    if (list === null || list.length === 0 || list.some((s) => s === '' || s.includes('\n'))) {
      issues.push({ path: 'synonyms', message: '必须是字符串数组（非空、每项非空白且不含换行）' })
    } else synonyms = list
  }
  const entity = strOf(input.entity)

  return {
    issues, relation, ratio,
    fields: {
      name, label, definition, expression: hasExpr ? exprRaw : '',
      grain, owner, tier, source, freshnessSlaDays: input.freshnessSlaDays, entity, synonyms,
    },
  }
}

/** 顶层 entities: 里声明的实体名集合（entity 入参的比对基准）。 */
const entityNamesOf = (doc: Document): Set<string> => {
  const entities = asMap(doc.get('entities', true))
  const out = new Set<string>()
  if (entities === null) return out
  for (const pair of entities.items) {
    const k = keyNameOf(pair)
    if (k !== '') out.add(k)
  }
  return out
}

/**
 * 对现行文件的越界机检（B11 relation 白名单 + entity 必须已声明）——compose 与 apply 重校验共用。
 * `viaExpression` 只决定 issue 的 path 归到 expression 还是 ratio；白名单/实体集由调用方按
 * 「现行文件」算出（apply 侧同样取**现行**——piece 自带条目不能给自己授权新 relation）。
 */
export function metricContextIssues(
  shape: { relation: string; viaExpression: boolean; entity: string },
  ctx: { allowedRelations: ReadonlySet<string>; declaredEntities: ReadonlySet<string> },
): Issue[] {
  const issues: Issue[] = []
  if (shape.relation !== '' && !ctx.allowedRelations.has(shape.relation)) {
    issues.push({
      path: shape.viaExpression ? 'expression' : 'ratio',
      message: `relation \`${shape.relation}\` 不在现行 l1_metrics.yml 已用的关系集合里（B11：口径只引用 L1 已用 relation 的列）。现有：${[...ctx.allowedRelations].sort().join(', ') || '（空）'}`,
    })
  }
  if (shape.entity !== '' && !ctx.declaredEntities.has(shape.entity)) {
    issues.push({ path: 'entity', message: `实体 \`${shape.entity}\` 未在顶层 entities: 声明——本工具的增量限定在 metrics[]（不改 entities:），先在文件里声明实体或去掉 entity 入参` })
  }
  return issues
}

// ── 组装器本体 ──────────────────────────────────────────────────────────────────────────────
/**
 * 组装 L1 声明草案（**纯函数**）。`roots` 按 plan 的签名保留形参（候选升级链 Task 3 传真实
 * roots 以对齐其它 propose_*；本函数的全部事实来自注入的 `currentYaml`，不碰 fs）。
 * 拒绝（ok:false）只发生在：输入形状非法 / 现行 YAML 不可解析或无 metrics: 段 / B11 relation
 * 越界 / 同名重提 definition 未变 / entity 未声明。**缺 auditSql 不拒**（draft PR 允许带红，
 * gate ⑦ 在合并前拦）。
 */
export function composeMetricDeclaration(
  roots: PipelineRoots,
  input: MetricDeclarationInput,
  currentYaml: string,
): MetricComposeResult {
  void roots
  // ── A. 逐字段机检 + 归一化（同一把尺已抽出为 checkMetricDeclaration——apply 重校验复用，
  //      W3 Task 2，此处不再第二遍）────────────────────────────────────────────────────────
  const shape = checkMetricDeclaration(input)
  const issues: Issue[] = [...shape.issues]
  const { name, definition, expression: exprRaw } = shape.fields
  const ratio = shape.ratio
  const hasExpr = exprRaw !== ''

  let auditSql: string | null = null
  if (input.auditSql !== undefined && input.auditSql !== null) {
    if (typeof input.auditSql === 'string' && input.auditSql.trim() !== '') auditSql = input.auditSql
    else issues.push({ path: 'auditSql', message: '给了就必须是非空白字符串（内容按原文进 piece，不加工）' })
  }

  if (issues.length > 0) return { ok: false, issues }

  // ── B. 现行 YAML 必须可解析（全量拼接在坏基线上做不出可审的草案）────────────────────────
  const doc = parseDocument(currentYaml)
  if (doc.errors.length > 0) {
    return { ok: false, issues: [{ path: 'currentYaml', message: `现行 ${SEMANTICS_YAML_REL} 解析失败——无法在坏基线上做全量拼接（先人工修文件再提案）：${String(doc.errors[0])}` }] }
  }
  const seq = asSeq(doc.get('metrics', true))
  if (seq === null || seq.items.length === 0) {
    return { ok: false, issues: [{ path: 'metrics', message: `现行 ${SEMANTICS_YAML_REL} 没有 metrics: 段（或为空）——无法确定插入锚点` }] }
  }
  const dashStartIn = (text: string, item: unknown): number => {
    const range = (item as YamlCollectionLike).range
    if (range === null || range === undefined) return -1
    return text.lastIndexOf('\n', range[0] - 1) + 1
  }
  const endOf = (item: unknown): number => (item as YamlCollectionLike).range?.[2] ?? -1

  // ── C. 同名查找 / 修改模式 / B11 白名单 / entity 声明（一起收集，一次回给全部可修项）──────
  const entries: { name: string; item: YamlCollectionLike; dashStart: number; end: number }[] = []
  for (const node of seq.items) {
    // YAMLSeq 的 items 是节点（同 l1RelationsOf）；YAMLMap 的 items 才是 {key,value} pair
    const map = asMap(node)
    if (map === null) continue
    const n = scalarText(map, 'name')
    if (n === '') continue
    const dashStart = dashStartIn(currentYaml, map)
    const end = endOf(map)
    if (dashStart < 0 || end <= dashStart) {
      return { ok: false, issues: [{ path: 'currentYaml', message: `条目 \`${n}\` 的源码定位失败（AST 无 range）——拒绝拼接` }] }
    }
    entries.push({ name: n, item: map, dashStart, end })
  }
  const sameName = entries.filter((e) => e.name === name)
  if (sameName.length > 1) {
    issues.push({ path: 'name', message: `现行文件里同名指标有 ${sameName.length} 处（同名两处 = 口径分叉，gate ⑥-b 同罪）——先人工归一，本工具不猜改哪一份` })
  }
  const existing = sameName.length === 1 ? sameName[0] : null
  const mode = existing === null ? 'create' : 'modify'
  // 修改模式的「无意义重提」闸（#1427）：**definition 或 synonyms 至少一个变了**即算有效改动。
  // 原先只认 definition——导致 Phase 2 最常见的 `alias_gap`（补同义词、不动口径）走不了提案链。
  if (existing !== null) {
    const cur = (existing.item as unknown as { toJSON(): unknown }).toJSON() as Record<string, unknown>
    const curSynonyms = Array.isArray(cur.synonyms) ? cur.synonyms.map(String) : []
    const inSynonyms = shape.fields.synonyms
    // synonyms 未给（null）= 该键从原条目带过 ⇒ 不参与「是否有改动」的判断。
    const synonymsSame = inSynonyms === null
      || (inSynonyms.length === curSynonyms.length && inSynonyms.every((x, i) => x === curSynonyms[i]))
    if (definition === scalarText(existing.item, 'definition') && synonymsSame) {
      issues.push({
        path: 'definition',
        message: '与现行声明完全相同——同名重提必须至少改变定义（definition）或同义词（synonyms）（防无意义重提）',
      })
    }
  }
  issues.push(...metricContextIssues(
    { relation: shape.relation, viaExpression: hasExpr, entity: shape.fields.entity },
    { allowedRelations: l1RelationsOf(seq.items), declaredEntities: entityNamesOf(doc) },
  ))
  if (issues.length > 0) return { ok: false, issues }

  // ── D. 组条目文本（修改模式：输入不管的键从原条目带过）──────────────────────────────────
  const fields: EntryFields = {
    ...shape.fields,
    ratio: shape.ratio,
    freshnessSlaDays: shape.fields.freshnessSlaDays as number,
  }
  const carriedPairs: YamlPairLike[] = []
  if (existing !== null) {
    // entity / synonyms 只在**输入给了**时才算托管键（没给 ⇒ 从原条目带过，防重写丢别名/实体绑定）
    const managed = new Set<string>(MANAGED_KEYS)
    if (shape.fields.entity === '') managed.delete('entity')
    if (shape.fields.synonyms === null) managed.delete('synonyms')
    for (const pair of existing.item.items) {
      const k = keyNameOf(pair)
      if (k === '' || managed.has(k)) continue
      carriedPairs.push(pair)
    }
  }

  // ── E. 文本手术（锚点来自 AST 的 range；拼接的是现行原文）───────────────────────────────
  const entryText = serializeEntry(fields, carriedPairs)
  let out: string
  if (mode === 'modify') {
    if (existing === null) {
      return { ok: false, issues: [{ path: 'name', message: '修改模式下找不到同名条目（组装器内部状态矛盾，拒绝产出）' }] }
    }
    out = currentYaml.slice(0, existing.dashStart) + entryText + currentYaml.slice(existing.end)
  } else {
    const names = entries.map((e) => e.name)
    const insertAt = names.findIndex((n) => n > name)
    let offset: number
    if (insertAt === -1) {
      // 全都不大于新名 ⇒ 追加：锚 = 末条目 node 末尾（seq 之后若还有别的顶层键也不受影响）
      offset = endOf(seq.items[seq.items.length - 1])
    } else if (insertAt === 0) {
      // 锚 = 第一个更大条目的行首；紧贴它头上的连续注释行留给该条目（注释归属不动）
      offset = entries[0].dashStart
      for (;;) {
        if (offset <= 0) break
        const prevStart = currentYaml.lastIndexOf('\n', offset - 2) + 1
        const prevLine = currentYaml.slice(prevStart, offset - 1)
        if (!prevLine.trimStart().startsWith('#')) break
        offset = prevStart
      }
    } else {
      // 锚 = 前一条目 node 末尾：插入后，原先分隔两条目的空行/注释仍贴在「更大」那条头上
      offset = entries[insertAt - 1].end
    }
    out = currentYaml.slice(0, offset) + entryText + currentYaml.slice(offset)
  }

  // ── F. 回读校验（fail-closed：任一失配 ⇒ 拒绝产出，绝不出坏草案）────────────────────────
  const re = parseDocument(out)
  if (re.errors.length > 0) {
    return { ok: false, issues: [{ path: 'currentYaml', message: `拼接产物解析失败（组装器缺陷，拒绝产出，请人工编辑）：${String(re.errors[0])}` }] }
  }
  const reSeq = asSeq(re.get('metrics', true))
  const expectedCount = mode === 'create' ? entries.length + 1 : entries.length
  if (reSeq === null || reSeq.items.length !== expectedCount) {
    return { ok: false, issues: [{ path: 'currentYaml', message: `拼接后条目数 ${reSeq?.items.length ?? '—'} ≠ 期望 ${expectedCount}（组装器缺陷，拒绝产出）` }] }
  }
  const reEntries: { name: string; dashStart: number; end: number; item: YamlCollectionLike }[] = []
  for (const node of reSeq.items) {
    const map = asMap(node)   // YAMLSeq 的 items 是节点（同 entries 的构建）
    if (map === null) continue
    const n = scalarText(map, 'name')
    if (n === '') continue
    reEntries.push({ name: n, dashStart: dashStartIn(out, map), end: endOf(map), item: map })
  }
  const reByName = new Map(reEntries.map((e) => [e.name, e]))
  for (const e of entries) {
    if (mode === 'modify' && e.name === name) continue
    const reE = reByName.get(e.name)
    const oldText = currentYaml.slice(e.dashStart, e.end)
    if (reE === undefined || out.slice(reE.dashStart, reE.end) !== oldText) {
      return { ok: false, issues: [{ path: 'currentYaml', message: `未触碰条目 \`${e.name}\` 在拼接后字节漂移（组装器缺陷，拒绝产出）` }] }
    }
  }
  const reTarget = reByName.get(name)
  if (reTarget === undefined) {
    return { ok: false, issues: [{ path: 'currentYaml', message: '拼接后找不到新条目（组装器缺陷，拒绝产出）' }] }
  }
  const reRatioMap = asMap(reTarget.item.get('ratio', true))
  const ratioMismatch = ratio !== null
    && (reRatioMap === null
      || scalarText(reRatioMap, 'numerator') !== ratio.numerator
      || scalarText(reRatioMap, 'denominator') !== ratio.denominator)
  if (scalarText(reTarget.item, 'definition') !== definition
    || (hasExpr && scalarText(reTarget.item, 'expression') !== exprRaw)
    || ratioMismatch) {
    return { ok: false, issues: [{ path: 'currentYaml', message: '新条目回读与输入不一致（YAML 折叠改写了内容，组装器拒绝产出）' }] }
  }

  // ── G. 组回包（零写入：piece 只进回包）──────────────────────────────────────────────────
  const auditDomain = name.split(':')[0] ?? name
  // `baseSha256` = 本提案所依据的现行文件摘要（#1411）：apply 侧据此区分「没人动过 ⇒ 可安全更新」与
  // 「基线已变 ⇒ 拒绝」。不带上它，对已存在文件的提案会被一律判 conflict（L1 声明永远应用不了）。
  const pieces: ProposedFile[] = [
    {
      path: SEMANTICS_YAML_REL,
      bytes: Buffer.byteLength(out, 'utf8'),
      content: out,
      baseSha256: createHash('sha256').update(currentYaml, 'utf8').digest('hex'),
    },
  ]
  const downstream: DownstreamItem[] = []
  const validation: Issue[] = []
  if (mode === 'modify') {
    validation.push({ path: 'name', message: '同名指标已存在：本提案是**修改**该条目（diff 限定在该条目）；输入未声明的键从原条目带过、键序按本工具固定序重排，条目内的行内注释不保留' })
  }
  if (auditSql === null) {
    validation.push({ path: 'auditSql', message: '未提供——PR 合并前 gate ⑦（audit test）会红，draft PR 带红是预期' })
    downstream.push({
      path: `${DBT_TESTS_DIR}/${auditDomain}/${metricToAuditFileName(name)}`,
      kind: 'required',
      why: '对账 singular test（gate ⑦）：每个声明指标必须有一条**独立复算**（layered §7 硬约束 7）；本工具不代写（生成空壳 = 假绿），复算 SQL 请人工编写后随 PR 附上',
    })
  } else {
    pieces.push({
      path: `${DBT_TESTS_DIR}/${auditDomain}/${metricToAuditFileName(name)}`,
      bytes: Buffer.byteLength(auditSql, 'utf8'),
      content: auditSql,
    })
  }
  const title = `L1 指标声明提案：${name}`
  return { ok: true, mode, title, branch: `proposal/${slugOf(title)}`, pieces, downstream, validation }
}

// ── apply 重校验（W3 Task 2）：YAML piece 的 diff 限定 + 变更集同尺机检 ─────────────────────
/** 顶层键清单（metrics[] 之外的键逐字比对用）。 */
const topKeysOf = (doc: Document): string[] => {
  const m = asMap(doc.contents)
  return m === null ? [] : m.items.map((p) => keyNameOf(p)).filter((k) => k !== '')
}

/** metrics[] 的 name 索引（同名/缺名/非映射条目都记 issue——配对比对的底座必须干净）。 */
const metricsByName = (seq: YamlCollectionLike, into: Issue[]): Map<string, YamlCollectionLike> => {
  const out = new Map<string, YamlCollectionLike>()
  for (const item of seq.items) {
    const map = asMap(item)
    if (map === null) { into.push({ path: 'metrics', message: 'metrics[] 条目必须是映射（name 键对齐比对的底座）' }); continue }
    const n = scalarText(map, 'name')
    if (n === '') { into.push({ path: 'metrics', message: 'metrics[] 条目缺 name（非空字符串）——按 name 配对比对的底座' }); continue }
    if (out.has(n)) into.push({ path: 'metrics', message: `同名条目 \`${n}\` 重复（同名两处 = 口径分叉，gate ⑥-b 同罪）——先人工归一` })
    else out.set(n, map)
  }
  return out
}

/** 条目节点 → 组装输入（YAML 键名 → MetricDeclarationInput；形状机检交给同一套尺）。 */
const inputOfEntry = (map: YamlCollectionLike): MetricDeclarationInput => {
  // toJSON() 可脱离 Document 独立取 JS 值（toJS() 要 document 参数——实测 TypeError）
  const e = (map as unknown as { toJSON(): unknown }).toJSON() as Record<string, unknown>
  return {
    name: e.name, label: e.label, definition: e.definition,
    expression: e.expression ?? '', ratio: e.ratio,
    grain: e.grain ?? [], owner: e.owner, tier: e.tier, source: e.source,
    freshnessSlaDays: e.freshness_sla_days, entity: e.entity, synonyms: e.synonyms,
  }
}

/**
 * apply 重校验的 YAML 档（纯函数，零网络）。全量文件 piece 与现行文件的 diff 必须**只**落在
 * metrics[]，变更集（新增 ∪ 修改）逐条过 {@link checkMetricDeclaration} + {@link metricContextIssues}
 * ——与 propose 完全同一把尺。要点：
 *   · 未触碰条目**不做**形状检查（现行文件里的复合表达是人工维护的既有事实，不是本通路的产出面；
 *     一旦触碰（修改）就要过同一套机检 ⇒ 复合表达条目在本通路改不了，走人工编辑）；
 *   · B11 relation 白名单的基准是**现行文件**的 metrics[]（不是 piece 自带的）——新增条目不能
 *     通过「自带一条用新 relation 的条目」给自己授权；
 *   · 现行条目一律不得删除（本通路只收新增/修改；删除声明走人工编辑）。
 * 任何失配由调用方（apply.ts）落 refused/invalid_draft。
 */
export function semanticsYamlPieceIssues(content: string, currentYaml: string): Issue[] {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    return [{ path: 'content', message: `不是合法 YAML：${String(doc.errors[0])}` }]
  }
  if (doc.get('version', true) === undefined) {
    return [{ path: 'version', message: '顶层缺 version——全量文件 piece 必须保持现行文件的顶层结构（version/metrics）' }]
  }
  const seq = asSeq(doc.get('metrics', true))
  if (seq === null) {
    return [{ path: 'metrics', message: '顶层缺 metrics:（或不是列表）——全量文件 piece 必须含 metrics[]' }]
  }
  const cur = parseDocument(currentYaml)
  const curSeq = asSeq(cur.get('metrics', true))
  if (cur.errors.length > 0 || curSeq === null) {
    return [{ path: 'currentYaml', message: `现行 ${SEMANTICS_YAML_REL} 不可解析（或缺 metrics:）——无法比对，拒绝（fail-closed）` }]
  }

  const issues: Issue[] = []

  // ── ① 顶层键：metrics[] 之外不增不删、值深等（「逐字相等」按解析后的值面比对）─────────────
  const newKeys = topKeysOf(doc)
  const curKeys = topKeysOf(cur)
  const newJs = (doc.toJS() ?? {}) as Record<string, unknown>
  const curJs = (cur.toJS() ?? {}) as Record<string, unknown>
  for (const k of newKeys) {
    if (k !== 'metrics' && !curKeys.includes(k)) issues.push({ path: k, message: '顶层键不在现行文件里——增量限定在 metrics[]（不得新增顶层键）' })
  }
  for (const k of curKeys) {
    if (k !== 'metrics' && !newKeys.includes(k)) issues.push({ path: k, message: '删掉了现行顶层键——增量限定在 metrics[]（其余顶层键逐字保留）' })
  }
  for (const k of curKeys) {
    if (k === 'metrics' || !newKeys.includes(k)) continue
    if (JSON.stringify(newJs[k]) !== JSON.stringify(curJs[k])) {
      issues.push({ path: k, message: `非 metrics[] 的顶层键 \`${k}\` 有改动——本通路的增量限定在 metrics[]` })
    }
  }

  // ── ② metrics[] 按 name 配对：不删现行条目；变更集 = 新增 ∪ 修改，逐条同尺机检 ─────────────
  const curByName = metricsByName(curSeq, issues)
  const newByName = metricsByName(seq, issues)
  for (const n of curByName.keys()) {
    if (!newByName.has(n)) issues.push({ path: 'metrics', message: `删掉了现行条目 \`${n}\`——本通路只收新增/修改（删除声明走人工编辑）` })
  }
  const textOf = (m: YamlCollectionLike): string => JSON.stringify((m as unknown as { toJSON(): unknown }).toJSON())
  const allowedRelations = l1RelationsOf(curSeq.items)   // 基准 = 现行文件（不是 piece 自带的）
  const declaredEntities = entityNamesOf(doc)            // entities: 不许动（①已挡）⇒ 取 piece 侧即可
  for (const [n, map] of newByName) {
    const curMap = curByName.get(n)
    if (curMap !== undefined && textOf(map) === textOf(curMap)) continue   // 未触碰：不做形状检查
    const shape = checkMetricDeclaration(inputOfEntry(map))
    issues.push(...[...shape.issues, ...metricContextIssues(
      { relation: shape.relation, viaExpression: shape.fields.expression !== '', entity: shape.fields.entity },
      { allowedRelations, declaredEntities },
    )].map((x) => ({ path: `metrics[${n}] ${x.path}`, message: x.message })))
  }
  return issues
}

// ── impl（路由片注册 propose_metric_declaration）────────────────────────────────────────────
/**
 * 只读现行语义声明（生产 = 仓根按模块位置解析，镜像内 /app；dbt/ 整树 COPY 进镜像）。
 * `baseDir` 是测试注入缝（apply 重校验注入夹具目录；缺省 REPO_ROOT——与 Task 1 行为一致）。
 */
export const readCurrentSemanticsYaml = (baseDir: string = REPO_ROOT): string | null => {
  try {
    return readFileSync(join(baseDir, SEMANTICS_YAML_REL), 'utf8')
  } catch {
    return null
  }
}

/**
 * propose_metric_declaration 的实现：读现行 YAML（只读）→ 组装 → 回草案。
 * 现行文件不可读 ⇒ unknown/semantics_unreadable（未知 ≠ 没有基线，不许静默当「空文件」处理）。
 */
export const proposeMetricDeclarationImpl: PipelineImpl = async (deps, args) => {
  const name = textArg(args.name, 200)
  const rationale = textArg(args.rationale, MAX_RATIONALE)
  if (name === '' || rationale === '') return badParam('name/rationale 必填（非空白）')
  const current = readCurrentSemanticsYaml()
  if (current === null) {
    return {
      payload: {
        status: 'unknown', reason: 'semantics_unreadable', name,
        detail: `现行 ${SEMANTICS_YAML_REL} 不可读——无法组装全量草案（镜像内应有 /app/${SEMANTICS_YAML_REL}；未知 ≠ 基线为空）`,
      },
      isError: true, auditRowCount: null,
    }
  }
  const r = composeMetricDeclaration(deps.roots, {
    name,
    label: args.label,
    definition: args.definition,
    expression: args.expression,
    ratio: args.ratio,
    grain: args.grain,
    owner: args.owner,
    tier: args.tier,
    source: args.source,
    freshnessSlaDays: args.freshnessSlaDays,
    entity: args.entity,
    synonyms: args.synonyms,
    auditSql: args.auditSql,
    rationale,
  }, current)
  if (!r.ok) return refused(r.issues)
  return {
    payload: {
      status: 'ok', mode: r.mode, title: r.title, rationale, branch: r.branch,
      pieces: r.pieces, downstream: r.downstream, validation: r.validation, note: NOTE,
    },
    isError: false, auditRowCount: null,
  }
}
