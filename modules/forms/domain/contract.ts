// domain/contract.ts — 契约编译闸 + 提交五道闸（issue #710）。
//
// 纪律（ADR-0005 §12.11–12.13，正典 docs/architecture.md §2.4）：
// - **纯函数**：不 import 任何 pool / env / Hono——它是纯的，才能被单测穷举（照 data/authz.ts 形状）；
// - **写时校验**：坏契约在 publish 门拦下，不静默入库拖到某租户提交时 500；
// - **机检错误码**：调用方按 code 映射 HTTP 状态与文案，不解析 message；
// - **fail-closed**：未声明/未授权/形状非法一律拒；
// - 方言定案 **draft-07**：RJSF 默认校验器（ajv8）不认 2020-12，那 under-它整个校验静默失效
//   （ADR-0005 §12.1 实测）。这里服务端 ajv 与渲染端同源，才能两头咬得住同一个契约。
//
// 铁律（§2.4）：契约里永不含值，只含引用——`x-dict: "dict:<id>"`（租户私有）| `"gdict:<id>"`
// （平台全局，P4 分档）；`x-binding: "required" | "open"`（P7：v1 两档，extensible 拒）。
import Ajv from 'ajv'
import { itemWecomRefOf } from './wecom-binding'
// 统计白名单（聚合算子 / 字段名形态 / kind 映射）与视图校验的**单一事实源**在 stats.ts；
// 本文件以值导入取用，stats.ts 反向只以 `import type` 引用本文件的类型 ⇒ 运行期无环。
import { AGGS, FIELD_IDENT_RE, fieldKindOf, isFieldKind, validateStatsView } from './stats'
export { AGGS, FIELD_IDENT_RE, fieldKindOf } from './stats'

/** 字典引用格式（P4 分档前缀）。第二消费者出现时迁 `@platform/sdk`（可搬迁纪律）。 */
export const DICT_REF_RE = /^(dict|gdict):([a-z][a-z0-9-]*)$/

/** 绑定强度 v1 两档（P7 拍板：extensible 不做，出现即拒）。 */
export const BINDINGS = ['required', 'open'] as const
export type Binding = (typeof BINDINGS)[number]

/** 提交体保留键：主体/审计字段只来自身份与宿主，请求里出现即 400（照 authz.ts SUBJECT_RESERVED_KEYS）。 */
export const RESERVED_KEYS = ['org', 'tenant', 'tenantId', 'id', 'submittedBy', 'submittedAt'] as const

const DRAFT07_METASCHEMA = new Set([
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
])

// strict 关掉：契约里合法携带 `x-*` 扩展注解（x-dict/x-binding/x-pii…），strict 模式会对
// 未知关键词抱怨；校验力不受影响（ajv 的校验语义与 strict 无关，strict 只管「像不像手滑」）。
const ajv = new Ajv({ allErrors: true, strict: false })

export type GateResult = { ok: true } | { ok: false; code: GateErrorCode; detail?: string }
export type GateErrorCode =
  | 'SCHEMA_COMPILE'
  | 'SCHEMA_DIALECT'
  | 'BINDING_REQUIRED'
  | 'BAD_BINDING'
  | 'BAD_DICT_REF'
  | 'CONDITIONAL_EMPTY'
  | 'CONDITIONAL_TOPLEVEL'
  | 'UI_SCHEMA_DRIFT'
  | 'UNSUPPORTED_WIDGET'
  | 'BAD_ASSIGNEE_REF'
  | 'BAD_DUE'
  | 'APPROVAL_REF_INVALID'
  | 'DATA_PLANE_FIELD_NAME_INVALID'
  | 'DATA_PLANE_TYPE_UNSUPPORTED'
  // ── 件④ dataPlane v2（#2755）：显式字段声明 / 统计 / 分析能力位 ──
  | 'DATA_PLANE_STRUCTURE'
  | 'DATA_PLANE_FIELD_UNKNOWN'
  | 'DATA_PLANE_FIELD_MISSING'
  | 'DATA_PLANE_KIND_MISMATCH'
  | 'STATS_NO_MEASURE'
  | 'STATS_BAD_AGG'
  | 'STATS_AGG_TYPE_MISMATCH'
  | 'STATS_AGG_NOT_ALLOWED'
  | 'STATS_NOT_GROUPABLE'
  | 'STATS_FIELD_NOT_ALLOWED'
  | 'STATS_TOO_MANY_GROUP_BY'
  | 'STATS_TOO_MANY_MEASURES'
  | 'STATS_TOO_MANY_WHERE'
  | 'STATS_LIMIT_TOO_LARGE'
  | 'STATS_IN_TOO_LARGE'
  | 'STATS_BAD_FILTER'
  | 'STATS_VIEW_BAD_SHAPE'
  | 'STATS_VIEW_BAD_LABEL'
  | 'STATS_VIEW_DUPLICATE_KEY'
  | 'STATS_VIEW_NOT_FOUND'

// ── dataPlane v2 类型（件④ #2755）────────────────────────────────────────────────
// 契约把「湖投影」与「实时统计」拆成两个能力位：`analytics`（湖 → 摊平 → mart，需平台审批）
// 与 `stats`（平台 PG 实时聚合，发布者自开）。两者共用一份显式字段声明 `fields`。

/** 统计聚合算子（字段声明与 `/stats` 入参共用同一套白名单；运行时白名单在 stats.ts）。 */
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max'

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'enum'

/**
 * 字段声明：`field` = 契约顶层字段名，`kind` = 湖/payload 提取类型，`agg` = 允许的聚合，
 * `groupable` = 是否可作为分组维度。声明必须与 schema 同名字段的类型一致（kind 对照）。
 */
export interface FieldDecl {
  field: string
  kind: FieldKind
  agg?: Agg[]
  groupable?: boolean
}

export interface StatsMeasure { field: string; agg: Agg }
export type StatsWhereOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'
export interface StatsWhere { field: string; op: StatsWhereOp; value: unknown }
export interface StatsFilter {
  /** `YYYY-MM-DD`，按 Asia/Shanghai 日界（含当日）。 */
  submittedFrom?: string
  submittedTo?: string
  where?: StatsWhere[]
}

/** 预声明统计视图（agent 起草表单时一并产出；发布时过与 `/stats` 同一套白名单）。 */
export interface StatsViewDecl {
  key: string
  label: string
  groupBy?: string[]
  measures: StatsMeasure[]
  filter?: StatsFilter
  limit?: number
}

/** `/stats` 入参（ad-hoc）或视图入参（`viewId`）。org 永不在此——只来自 identity。 */
export interface StatsInput {
  assetId?: string
  viewId?: string
  groupBy?: string[]
  measures?: StatsMeasure[]
  filter?: StatsFilter
  limit?: number
}

/** dataPlane v2：`enabled` 是 legacy 兼容位（等价 `analytics.enabled`）。 */
export interface DataPlaneV2 {
  /** @deprecated 等价 `analytics.enabled=true`（存量 goal 表单的写法，不迁移数据）。 */
  enabled?: boolean
  fields?: FieldDecl[]
  stats?: { enabled?: boolean; views?: StatsViewDecl[] }
  analytics?: { enabled?: boolean }
}

const NUMERIC_AGGS: ReadonlySet<Agg> = new Set(['sum', 'avg', 'min', 'max'])
const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(['number', 'integer', 'date'])
/** 分组维度允许的基础类型（文本/枚举/日期/布尔都能分组）。 */
const GROUPABLE_KINDS: ReadonlySet<FieldKind> = new Set(['string', 'enum', 'date', 'boolean'])

/** 未显式声明的字段（legacy 从 schema 派生）给的保守默认聚合。 */
const DEFAULT_AGGS: Record<FieldKind, Agg[]> = {
  number: ['sum', 'avg', 'min', 'max', 'count'],
  integer: ['sum', 'avg', 'min', 'max', 'count'],
  date: ['min', 'max', 'count'],
  string: ['count'],
  enum: ['count'],
  boolean: ['count'],
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** legacy 兼容：`dataPlane.enabled=true` 按 `analytics.enabled=true` 读取（不迁移数据）。 */
export function analyticsEnabledOf(body: unknown): boolean {
  const dp = asRecord(asRecord(body)?.['dataPlane'])
  if (dp === null) return false
  return asRecord(dp['analytics'])?.['enabled'] === true || dp['enabled'] === true
}

/** 实时统计能力位（发布者自己开：`stats.enabled === true`）。 */
export function statsEnabledOf(body: unknown): boolean {
  return asRecord(asRecord(asRecord(body)?.['dataPlane'])?.['stats'])?.['enabled'] === true
}

/**
 * 契约 body → 字段声明（统计端点的白名单事实源）：
 * - v2：`dataPlane.fields` 原样（已由发布门校验）；
 * - legacy：从 `schema.properties` 派生（kind 直映 + 保守默认 agg/groupable）。
 */
export function fieldDeclsOf(body: unknown): FieldDecl[] {
  const rec = asRecord(body)
  if (rec === null) return []
  const dp = asRecord(rec['dataPlane'])
  const declared = dp?.['fields']
  if (Array.isArray(declared)) {
    const out: FieldDecl[] = []
    for (const entry of declared) {
      const e = asRecord(entry)
      if (e === null || typeof e['field'] !== 'string' || !isFieldKind(e['kind'])) continue
      const agg = Array.isArray(e['agg'])
        ? (e['agg'].filter((a): a is Agg => typeof a === 'string' && (AGGS as readonly string[]).includes(a)))
        : undefined
      const groupable = typeof e['groupable'] === 'boolean' ? e['groupable'] : undefined
      out.push({
        field: e['field'],
        kind: e['kind'],
        ...(agg !== undefined ? { agg } : {}),
        ...(groupable !== undefined ? { groupable } : {}),
      })
    }
    return out
  }
  const props = asRecord(asRecord(rec['schema'])?.['properties'])
  if (props === null) return []
  const out: FieldDecl[] = []
  for (const [field, def] of Object.entries(props)) {
    const kind = fieldKindOf(def)
    if (kind === null) continue
    out.push({ field, kind, agg: [...DEFAULT_AGGS[kind]], groupable: GROUPABLE_KINDS.has(kind) })
  }
  return out
}

/**
 * dataPlane（件① 字段级数据通路，#2706）v1 白名单：字段名的形态与可摊平类型。
 * 字段名会成为湖上的 `f_<name>` 列，故必须是小写蛇形；类型决定生成器（
 * scripts/gen-forms-data-projection.mjs）用哪种 SQL 提取。枚举只挂 string（int 枚举
 * 按其基础类型提取）。⚠️ 与 storage.listDataPlaneForms 的 kind 映射同构——
 * 闸放行的字段必须能在清单里映出 kind，两处漂开就会出现「发布得了但摊平不出」。
 */
export const DATA_PLANE_FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const DATA_PLANE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean'])

/** 收集契约中全部字典引用（去重）——storage 据此预载各 ref 的生效 key 集。 */
export function dictRefs(schema: unknown): string[] {
  const nodes: Record<string, unknown>[] = []
  collectDictNodes(schema, nodes)
  const refs = new Set<string>()
  for (const n of nodes) {
    if (typeof n['x-dict'] === 'string' && DICT_REF_RE.test(n['x-dict'])) refs.add(n['x-dict'])
  }
  return [...refs]
}

/**
 * 条件字段两查（ADR-0005 §12.7，issue #718）：PoC 首轮 5 用例 100% 踩中的坑——
 * 条件目标字段声明在外层 properties ⇒ **常显**（if/then 只对校验生效，不管显隐）；
 * 必须只声明在 then/else 的 properties 里才正确显隐。发布门拦下这两态：
 * - CONDITIONAL_TOPLEVEL：then/else 的目标字段同时出现在外层 properties（常显 bug）
 * - CONDITIONAL_EMPTY：有 if/then 但 then/else 没声明任何目标字段（八成字段被放顶层了）
 */
function conditionalChecks(node: unknown, parentProps: ReadonlySet<string>): GateResult | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = conditionalChecks(item, parentProps)
      if (r) return r
    }
    return null
  }
  const rec = node as Record<string, unknown>
  const ownProps = new Set<string>()
  const props = rec['properties']
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const k of Object.keys(props)) ownProps.add(k)
  }
  const here = ownProps.size > 0 ? ownProps : parentProps

  if ('if' in rec) {
    const declared = new Set<string>()
    for (const branch of ['then', 'else']) {
      const b = rec[branch]
      if (b === null || typeof b !== 'object') continue
      const bp = (b as Record<string, unknown>)['properties']
      if (bp !== null && typeof bp === 'object' && !Array.isArray(bp)) {
        for (const k of Object.keys(bp)) declared.add(k)
      }
    }
    if ('then' in rec && declared.size === 0) {
      return {
        ok: false,
        code: 'CONDITIONAL_EMPTY',
        detail: 'if/then 的 then/else 未声明任何目标字段——条件字段必须只声明在 then.properties 内（放外层会常显，§12.7）',
      }
    }
    for (const k of declared) {
      if (here.has(k)) {
        return {
          ok: false,
          code: 'CONDITIONAL_TOPLEVEL',
          detail: `条件目标字段 "${k}" 同时声明在外层 properties——会常显；只能声明在 then.properties 内（§12.7）`,
        }
      }
    }
  }
  for (const value of Object.values(rec)) {
    const r = conditionalChecks(value, here)
    if (r) return r
  }
  return null
}

/** 深度收集契约里所有出现 `x-dict` / `x-binding` 的节点（顶层 properties 与
 *  条件分支 then.properties 等——ADR-0005 §12.7：条件字段必须声明在 then.properties 内，
 *  它们同样要带引用与强度，不能只查顶层）。 */
function collectDictNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectDictNodes(item, out)
    return
  }
  const rec = node as Record<string, unknown>
  if ('x-dict' in rec || 'x-binding' in rec) out.push(rec)
  for (const value of Object.values(rec)) collectDictNodes(value, out)
}

/**
 * 契约 body 形状（issue #724 定案，2026-10-16）：
 * **数据事实在 `schema`、UI 事实在 `uiSchema`**——
 * `x-dict`/`x-binding`/`x-pii`（数据绑定）留 schema；`ui:widget`/`ui:placeholder`/`ui:options`
 * （表现）进 uiSchema。ADR §12.14/§16 两处均如此描述表单契约。
 * 两半同在一个 body 内**随版本原子发布**（published 被 DB 触发器锁不可变）⇒ 跨版本无从漂移；
 * 版本内的一致性由下方 `UI_SCHEMA_DRIFT` / `UNSUPPORTED_WIDGET` 两闸闭合。
 */
export interface FormContractBody {
  schema: Record<string, unknown>
  /** 可选：没有 UI 意图就不写（RJSF 用默认渲染）。 */
  uiSchema?: Record<string, unknown>
  /** 可选（§2.4「指派与催办」）：谁该填——**只存对名单的引用**，名单本体在受管数据集（字典）。 */
  assignees?: { dictRef: string }
  /** 可选（§2.4）：截止 = 发布时刻 + afterDays 天（v1 只此一种）。 */
  due?: { afterDays: number }
  /** 可选（件④ #2755）：字段级数据通路（湖投影 analytics）+ 实时统计 stats。 */
  dataPlane?: DataPlaneV2
}

/**
 * 渲染层**真实认识**的 `ui:widget` 值（2026-10-16 实测枚举 @rjsf/antd 6.11 注册集 +
 * core 默认）。⚠️ `cascader` / `signature` **不在内**——ADR §9 明说这两个控件需自研、
 * 尚未实现；写 `file` 也会渲染失败（PoC 实测，材料清单 #11 因此要求附件不写 widget）。
 * 物料清单教的 widget 集必须 ⊆ 本集合（单测钉住，防「教 AI 用渲染不出的控件」）。
 */
export const SUPPORTED_WIDGETS: ReadonlySet<string> = new Set([
  'text', 'textarea', 'password', 'radio', 'select', 'checkboxes', 'checkbox',
  'updown', 'range', 'date', 'datetime', 'alt-date', 'alt-datetime', 'hidden',
])

/** 从 body 取 schema（提交校验与渲染共用一处，避免各处各写一遍拆包）。 */
export function schemaOf(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const s = (body as Record<string, unknown>)['schema']
  return s !== null && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
}

/** 收集 uiSchema 里出现的全部 `ui:widget` 名（递归，含 items/嵌套对象）。 */
function collectWidgets(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const it of node) collectWidgets(it, out)
    return
  }
  const rec = node as Record<string, unknown>
  const w = rec['ui:widget']
  if (typeof w === 'string') out.add(w)
  for (const v of Object.values(rec)) collectWidgets(v, out)
}

/** uiSchema 的顶层键必须都存在于 schema 里**可寻址的顶层字段**（防两半漂移；嵌套 v1 不深查）。 */
function uiSchemaKeys(uiSchema: Record<string, unknown>): string[] {
  return Object.keys(uiSchema).filter((k) => k !== 'ui:globalOptions' && !k.startsWith('ui:'))
}

/**
 * schema 里**顶层可寻址**的字段 → 定义 映射：根 `properties` ∪ `then`/`else.properties`
 * ∪ 组合子（allOf/anyOf/oneOf）里的 properties。
 *
 * ⚠️ **必须含 `then.properties`**——条件字段按 §12.7 **只**声明在 `then` 里。只查根 properties
 * 会让两类闸一起出错，2026-10-16 dev-stack 真机链路先后抓到两处：
 *   ① 漂移闸把合法条件字段误判为「不在 schema 内」（AI 产出的 deadline 被拒）；
 *   ② **提交闸把条件字段当契约外字段拒掉** ⇒ **任何带条件字段的表单永远提交不了**。
 * 所以这张表是**两处共用**的唯一事实源（单独一份就会再漂一次）。
 */
function declaredFieldDefs(schema: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const addProps = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    const p = (node as Record<string, unknown>)['properties']
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.set(k, v as Record<string, unknown>)
    }
  }
  addProps(schema)
  for (const branch of ['then', 'else']) addProps(schema[branch])
  for (const comb of ['allOf', 'anyOf', 'oneOf']) {
    const arr = schema[comb]
    if (Array.isArray(arr)) for (const sub of arr) addProps(sub)
  }
  return out
}

/**
 * 发布门 = 编译闸（draft 期自由，publish 前必须过）：
 * ① body 是对象且含 `schema`（对象）、`uiSchema` 若在必须是对象；
 * ② schema 方言 draft-07（2020-12 显式拒）；③ ajv 编译通过；④ 条件字段两查；
 * ⑤ 每个 x-dict 引用格式合法、与 x-binding 成对且 ∈ v1 两档；
 * ⑥ **新增**：uiSchema 键 ⊆ schema.properties（防 scope 漂移）；
 * ⑦ **新增**：uiSchema 用的 ui:widget ∈ SUPPORTED_WIDGETS（渲染层不认识的一律拒）；
 * ⑧ dataPlane opt-in 闸（#2706 件①）：仅当 `dataPlane.enabled === true` 时，顶层字段必须
 *    能落成湖上 `f_` 列（名字/类型白名单，见 DATA_PLANE_FIELD_NAME_RE 处注释）。
 */
export function compileGate(body: unknown): GateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'SCHEMA_COMPILE', detail: '契约 body 必须是 JSON 对象' }
  }
  // ⑩ 标准审批（P2 / issue #2385）：字段与附件都在企微 ⇒ 事项模板契约 `schema` 可为 null/缺省。
  // 发布门仍咬住两件事：只能用于 `mode=approval`；`approvalRef` 形状必须合法。
  // 「引用是否**已发布**（绑定退役即不可新发布）」要看库，由 routes 的发布门查——纯函数不碰 DB。
  const provider = (body as Record<string, unknown>)['provider']
  if (provider === 'wecom_native') {
    if ((body as Record<string, unknown>)['mode'] !== 'approval') {
      return {
        ok: false,
        code: 'SCHEMA_COMPILE',
        detail: 'provider=wecom_native 只允许用于 mode=approval 的事项模板（标准审批在企微执行）',
      }
    }
    const ref = itemWecomRefOf(body)
    if (!ref.ok) return { ok: false, code: 'APPROVAL_REF_INVALID', detail: ref.detail }
    return { ok: true }
  }
  const schema = schemaOf(body)
  if (schema === null) {
    return { ok: false, code: 'SCHEMA_COMPILE', detail: '契约 body 必须含 schema（{schema, uiSchema?} 形状，见 #724）' }
  }
  const rawUi = (body as Record<string, unknown>)['uiSchema']
  if (rawUi !== undefined && (rawUi === null || typeof rawUi !== 'object' || Array.isArray(rawUi))) {
    return { ok: false, code: 'SCHEMA_COMPILE', detail: 'uiSchema 必须是 JSON 对象（缺省则不写）' }
  }
  const meta = schema['$schema']
  if (meta !== undefined && (typeof meta !== 'string' || !DRAFT07_METASCHEMA.has(meta))) {
    return {
      ok: false,
      code: 'SCHEMA_DIALECT',
      detail: '契约方言必须是 draft-07（2020-12 会让 ajv/RJSF 校验静默失效，见 ADR-0005 §12.1）',
    }
  }
  try {
    ajv.compile(schema as object)
  } catch (e) {
    return { ok: false, code: 'SCHEMA_COMPILE', detail: (e as Error).message }
  }
  const cond = conditionalChecks(schema, new Set())
  if (cond) return cond
  const nodes: Record<string, unknown>[] = []
  collectDictNodes(schema, nodes)
  for (const n of nodes) {
    const ref = n['x-dict']
    const binding = n['x-binding']
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !DICT_REF_RE.test(ref)) {
        return { ok: false, code: 'BAD_DICT_REF', detail: `x-dict "${String(ref)}" 不匹配 dict:<id> / gdict:<id>` }
      }
      if (binding === undefined) return { ok: false, code: 'BINDING_REQUIRED', detail: `x-dict "${ref}" 必须带 x-binding` }
    }
    if (binding !== undefined) {
      if (ref === undefined) return { ok: false, code: 'BAD_DICT_REF', detail: 'x-binding 必须与 x-dict 成对出现' }
      if (typeof binding !== 'string' || !(BINDINGS as readonly string[]).includes(binding)) {
        return { ok: false, code: 'BAD_BINDING', detail: `x-binding "${String(binding)}" 不在 v1 两档（required|open，P7）` }
      }
    }
  }
  if (rawUi !== undefined) {
    const uiSchema = rawUi as Record<string, unknown>
    const declared = declaredFieldDefs(schema)
    for (const key of uiSchemaKeys(uiSchema)) {
      if (!declared.has(key)) {
        return { ok: false, code: 'UI_SCHEMA_DRIFT', detail: `uiSchema 的键 "${key}" 不在 schema 的顶层字段内（两半漂移）` }
      }
    }
    const widgets = new Set<string>()
    collectWidgets(uiSchema, widgets)
    for (const w of widgets) {
      if (!SUPPORTED_WIDGETS.has(w)) {
        return {
          ok: false,
          code: 'UNSUPPORTED_WIDGET',
          detail: `ui:widget "${w}" 渲染层不认识（可用：${[...SUPPORTED_WIDGETS].join('/')}）`,
        }
      }
    }
  }
  // dataPlane 闸（件① #2706 v1 / 件④ #2755 v2）：
  //   v1 legacy：`dataPlane.enabled === true` ⇒ 每个顶层字段都要能落成湖上的一列（名字/类型/无嵌套）。
  //   v2：`fields` 显式声明（field∈schema、kind 与 schema 类型一致、agg/groupable 合法）；
  //       `stats.enabled` 允许子集（只统计选中的字段）；`analytics.enabled` 要求全覆盖
  //       （湖投影不能悄悄丢列）且字段名须是小写蛇形（湖列 `f_<name>`）。
  // 闸跑在 publish 门（写时校验纪律）——坏声明不静默入库拖到生成器/物化时才炸。
  const dpRaw = (body as Record<string, unknown>)['dataPlane']
  if (dpRaw !== undefined) {
    const dp = asRecord(dpRaw)
    if (dp === null) return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane 必须是对象' }
    for (const key of ['enabled'] as const) {
      if (dp[key] !== undefined && typeof dp[key] !== 'boolean') {
        return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: `dataPlane.${key} 必须是布尔` }
      }
    }
    const statsRaw = dp['stats']
    const statsEnabled = statsEnabledOf(body)
    if (statsRaw !== undefined) {
      const stats = asRecord(statsRaw)
      if (stats === null) return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane.stats 必须是对象' }
      if (stats['enabled'] !== undefined && typeof stats['enabled'] !== 'boolean') {
        return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane.stats.enabled 必须是布尔' }
      }
    }
    if (dp['analytics'] !== undefined) {
      const analytics = asRecord(dp['analytics'])
      if (analytics === null) return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane.analytics 必须是对象' }
      if (analytics['enabled'] !== undefined && typeof analytics['enabled'] !== 'boolean') {
        return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane.analytics.enabled 必须是布尔' }
      }
    }
    const analytics = analyticsEnabledOf(body)
    const propsRaw = schema['properties']
    const props = asRecord(propsRaw) ?? {}

    // ── 显式 fields（v2）──
    const fieldsRaw = dp['fields']
    const declared = new Set<string>()
    if (fieldsRaw !== undefined) {
      if (!Array.isArray(fieldsRaw)) {
        return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: 'dataPlane.fields 必须是数组' }
      }
      for (const entryRaw of fieldsRaw) {
        const e = asRecord(entryRaw)
        if (e === null || typeof e['field'] !== 'string' || !isFieldKind(e['kind'])) {
          return {
            ok: false,
            code: 'DATA_PLANE_STRUCTURE',
            detail: 'dataPlane.fields 条目须是 { field: string, kind: 白名单类型, agg?, groupable? }',
          }
        }
        const field = e['field'] as string
        const kind = e['kind'] as FieldKind
        if (!FIELD_IDENT_RE.test(field)) {
          return {
            ok: false,
            code: 'DATA_PLANE_FIELD_NAME_INVALID',
            detail: `dataPlane 字段名须是 SQL 安全标识符（^[a-zA-Z_][a-zA-Z0-9_]{0,63}$）：${field}`,
          }
        }
        if (analytics && !DATA_PLANE_FIELD_NAME_RE.test(field)) {
          return {
            ok: false,
            code: 'DATA_PLANE_FIELD_NAME_INVALID',
            detail: `analytics 字段名须 ^[a-z][a-z0-9_]{0,63}$（湖列 f_<name>）：${field}`,
          }
        }
        if (declared.has(field)) {
          return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: `dataPlane.fields 重复声明：${field}` }
        }
        declared.add(field)
        if (!(field in props)) {
          return {
            ok: false,
            code: 'DATA_PLANE_FIELD_UNKNOWN',
            detail: `dataPlane 字段 ${field} 不在 schema.properties 内`,
          }
        }
        const derived = fieldKindOf(props[field])
        if (derived === null) {
          return {
            ok: false,
            code: 'DATA_PLANE_TYPE_UNSUPPORTED',
            detail: `dataPlane 字段类型不支持：${field}（string/number/integer/boolean/string+format:date/string 枚举）`,
          }
        }
        if (derived !== kind) {
          return {
            ok: false,
            code: 'DATA_PLANE_KIND_MISMATCH',
            detail: `dataPlane 字段 ${field} 声明 kind=${kind}，schema 实际是 ${derived}`,
          }
        }
        if (e['groupable'] !== undefined && typeof e['groupable'] !== 'boolean') {
          return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: `dataPlane 字段 ${field} 的 groupable 必须是布尔` }
        }
        if (e['groupable'] === true && !GROUPABLE_KINDS.has(kind)) {
          return {
            ok: false,
            code: 'STATS_NOT_GROUPABLE',
            detail: `字段 ${field}（${kind}）不能作为分组维度（只许 string/enum/date/boolean）`,
          }
        }
        if (e['agg'] !== undefined) {
          if (!Array.isArray(e['agg'])) {
            return { ok: false, code: 'DATA_PLANE_STRUCTURE', detail: `dataPlane 字段 ${field} 的 agg 必须是数组` }
          }
          for (const agg of e['agg']) {
            if (typeof agg !== 'string' || !(AGGS as readonly string[]).includes(agg)) {
              return { ok: false, code: 'STATS_BAD_AGG', detail: `字段 ${field} 的聚合 ${String(agg)} 不在白名单 ${AGGS.join('/')}` }
            }
            if (NUMERIC_AGGS.has(agg as Agg) && !NUMERIC_KINDS.has(kind)) {
              return {
                ok: false,
                code: 'STATS_AGG_TYPE_MISMATCH',
                detail: `字段 ${field}（${kind}）不能做 ${agg}（sum/avg/min/max 只许 number/integer/date）`,
              }
            }
          }
        }
      }
      if (analytics) {
        for (const name of Object.keys(props)) {
          if (!declared.has(name)) {
            return {
              ok: false,
              code: 'DATA_PLANE_FIELD_MISSING',
              detail: `analytics 要求声明全部 schema 字段：缺 ${name}`,
            }
          }
        }
      }
    } else if (analytics) {
      // Phase A（v1 行为逐字不变）：每个顶层字段都要能落成湖上的一列。
      for (const [name, def] of Object.entries(props)) {
        if (!DATA_PLANE_FIELD_NAME_RE.test(name)) {
          return {
            ok: false,
            code: 'DATA_PLANE_FIELD_NAME_INVALID',
            detail: `dataPlane 字段名须 ^[a-z][a-z0-9_]{0,63}$：${name}`,
          }
        }
        const d = (def ?? {}) as Record<string, unknown>
        const t = typeof d.type === 'string' ? d.type : ''
        const okType = DATA_PLANE_TYPES.has(t) || (t === 'string' && d.format === 'date')
        const isStringEnum = t === 'string' && Array.isArray(d.enum) && d.enum.every((v) => typeof v === 'string')
        if (!okType && !isStringEnum) {
          return {
            ok: false,
            code: 'DATA_PLANE_TYPE_UNSUPPORTED',
            detail: `dataPlane 字段类型不支持：${name}（v1 白名单 string/number/integer/boolean/string+format:date/string 枚举）`,
          }
        }
        if (d.properties !== undefined || d.items !== undefined) {
          return {
            ok: false,
            code: 'DATA_PLANE_TYPE_UNSUPPORTED',
            detail: `dataPlane 字段不支持嵌套/数组：${name}`,
          }
        }
      }
    }

    // ── stats 能力位 + 视图（与 `/stats` 入参同一套白名单）──
    if (statsEnabled) {
      const decls = fieldDeclsOf(body)
      const hasMeasure = decls.some((d) => Array.isArray(d.agg) && d.agg.length > 0)
      if (!Array.isArray(fieldsRaw) || !hasMeasure) {
        return {
          ok: false,
          code: 'STATS_NO_MEASURE',
          detail: 'stats.enabled 需要显式 fields 且至少一个字段声明非空 agg（不猜聚合）',
        }
      }
      const views = asRecord(statsRaw)?.['views']
      if (views !== undefined) {
        if (!Array.isArray(views)) {
          return { ok: false, code: 'STATS_VIEW_BAD_SHAPE', detail: 'dataPlane.stats.views 必须是数组' }
        }
        const seen = new Set<string>()
        for (const view of views) {
          const err = validateStatsView(view, decls)
          if (err !== null) return { ok: false, code: err.code as GateErrorCode, detail: err.detail }
          const key = (asRecord(view) as { key: string }).key
          if (seen.has(key)) {
            return { ok: false, code: 'STATS_VIEW_DUPLICATE_KEY', detail: `统计视图 key 重复：${key}` }
          }
          seen.add(key)
        }
      }
    } else if (asRecord(statsRaw)?.['views'] !== undefined) {
      // views 只在 stats.enabled 时有意义；结构也照样校验（发布时别把坏声明落库）
      const views = (asRecord(statsRaw) as { views: unknown }).views
      if (!Array.isArray(views)) {
        return { ok: false, code: 'STATS_VIEW_BAD_SHAPE', detail: 'dataPlane.stats.views 必须是数组' }
      }
      const decls = fieldDeclsOf(body)
      for (const view of views) {
        const err = validateStatsView(view, decls)
        if (err !== null) return { ok: false, code: err.code as GateErrorCode, detail: err.detail }
      }
    }
  }
  // ⑧ 指派声明（§2.4「指派与催办」）：只存引用，且引用语法与字段字典**同一套**（不新增解析器）。
  const rawAssignees = (body as Record<string, unknown>)['assignees']
  if (rawAssignees !== undefined) {
    const ref = (rawAssignees as { dictRef?: unknown } | null)?.dictRef
    if (
      rawAssignees === null || typeof rawAssignees !== 'object' || Array.isArray(rawAssignees) ||
      typeof ref !== 'string' || !DICT_REF_RE.test(ref)
    ) {
      return { ok: false, code: 'BAD_ASSIGNEE_REF', detail: 'assignees.dictRef 必须匹配 dict:<id> / gdict:<id>' }
    }
  }
  // ⑨ 截止声明（§2.4）：v1 只支持「发布后 N 天」，N 必须是正整数。
  const rawDue = (body as Record<string, unknown>)['due']
  if (rawDue !== undefined) {
    const n = (rawDue as { afterDays?: unknown } | null)?.afterDays
    if (
      rawDue === null || typeof rawDue !== 'object' || Array.isArray(rawDue) ||
      typeof n !== 'number' || !Number.isInteger(n) || n <= 0
    ) {
      return { ok: false, code: 'BAD_DUE', detail: 'due.afterDays 必须是正整数（v1 只支持「发布后 N 天」）' }
    }
  }
  return { ok: true }
}

export type SubmitResult =
  | { ok: true }
  | {
      ok: false
      code:
        | 'RESERVED_KEY'
        | 'NOT_JSON'
        | 'UNKNOWN_FIELD'
        | 'READONLY_FIELD'
        | 'SCHEMA_INVALID'
        | 'DICT_REQUIRED_VIOLATION'
      detail?: string
    }

/**
 * 提交六道闸（§12.14 闸序 + 本仓的字典绑定闸）。schema 一律是**提交钉住版本**的契约
 * （历史提交按当时版本校验，§14.1）——调用方用 body_at(pinned version) 取，不认 head。
 * dictLookup 由 storage 注入（ref → 生效 key 集），本函数保持纯度。
 */
export function validateSubmission(args: {
  schema: object
  payload: unknown
  dictLookup: (ref: string) => Set<string>
}): SubmitResult {
  const { schema, payload, dictLookup } = args

  // 闸 1：保留键——主体/审计字段绝不收请求值（写侧保留键注入 → 400 不是静默忽略，§12.12(c)）
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of RESERVED_KEYS) {
      if (key in (payload as Record<string, unknown>)) {
        return { ok: false, code: 'RESERVED_KEY', detail: `payload 携带保留键 "${key}"` }
      }
    }
  }

  // 闸 2：必须是 JSON 对象
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'NOT_JSON', detail: 'payload 必须是 JSON 对象' }
  }
  const obj = payload as Record<string, unknown>

  // 闸 3：契约外字段 → 显式拒（不静默丢弃）。可寻址集含 `then/else.properties` 与组合子——
  // 条件字段按 §12.7 只声明在 then 里，只查根 properties 会把它们当契约外字段拒掉
  // ⇒ 带条件字段的表单永远提交不了（2026-10-16 真机实测抓到）。
  const declared = declaredFieldDefs(schema as Record<string, unknown>)
  for (const key of Object.keys(obj)) {
    if (!declared.has(key)) {
      return { ok: false, code: 'UNKNOWN_FIELD', detail: `字段 "${key}" 不在契约内（顶层字段）` }
    }
  }

  // 闸 4：readOnly 服务端复验（issue #722；ADR-0005 §12.11）——契约声明 `readOnly: true` 的
  // 字段**出现在提交体里即拒**。「存在即写入尝试」：客户端表现（ui:readonly）不是边界，
  // 连原样回传/带 null 也拒，避免「服务端该不该代填」的歧义。排在 ajv 之前——它是更具体的
  // 病因（本就不该写这个字段），不该被随后的类型错盖掉。
  for (const key of Object.keys(obj)) {
    if (declared.get(key)?.['readOnly'] === true) {
      return { ok: false, code: 'READONLY_FIELD', detail: `字段 "${key}" 在契约中声明为 readOnly，不接受提交值` }
    }
  }

  // 闸 5：ajv 真校验（必填/类型/格式……服务端独立复核，readOnly/前端表现不是边界）
  const validate = ajv.compile(schema)
  if (!validate(payload)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: ajv.errorsText(validate.errors) }
  }

  // 闸 6：required 绑定字典的字段，值必须 ∈ 生效 key 集（退役值在此拒绝；open 放行）。
  // 走同一张可寻址表（含 then/else）——条件分支里的字典字段同样受管。
  for (const [name, rec] of declared) {
    if (rec['x-binding'] !== 'required' || typeof rec['x-dict'] !== 'string') continue
    const value = obj[name]
    if (value === undefined || value === null) continue // 缺省交闸 5（required 由契约决定）
    const active = dictLookup(rec['x-dict'])
    if (typeof value !== 'string' || !active.has(value)) {
      return {
        ok: false,
        code: 'DICT_REQUIRED_VIOLATION',
        detail: `字段 "${name}" 的值不在字典 ${rec['x-dict']} 的生效值集内`,
      }
    }
  }
  return { ok: true }
}
