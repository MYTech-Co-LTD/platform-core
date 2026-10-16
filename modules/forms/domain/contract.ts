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
 * 发布门 = 编译闸（draft 期自由，publish 前必须过）：
 * ① body 是对象；② 方言 draft-07（2020-12 显式拒）；③ ajv 编译通过；
 * ④ 每个 x-dict 引用格式合法、与 x-binding 成对且 ∈ v1 两档。
 */
export function compileGate(body: unknown): GateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'SCHEMA_COMPILE', detail: '契约 body 必须是 JSON 对象' }
  }
  const schema = body as Record<string, unknown>
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
  return { ok: true }
}

export type SubmitResult =
  | { ok: true }
  | {
      ok: false
      code: 'RESERVED_KEY' | 'NOT_JSON' | 'UNKNOWN_FIELD' | 'SCHEMA_INVALID' | 'DICT_REQUIRED_VIOLATION'
      detail?: string
    }

/**
 * 提交五道闸。schema 一律是**提交钉住版本**的契约（历史提交按当时版本校验，§14.1）——
 * 调用方用 body_at(pinned version) 取，不认 head。
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

  // 闸 3：顶层契约外字段 → 显式拒（不静默丢弃；v1 只查顶层，嵌套为不透明值——实施期定已录 #710）
  const props = (schema as Record<string, unknown>)['properties']
  const declared = new Set(props !== null && typeof props === 'object' ? Object.keys(props) : [])
  for (const key of Object.keys(obj)) {
    if (!declared.has(key)) {
      return { ok: false, code: 'UNKNOWN_FIELD', detail: `字段 "${key}" 不在契约内（顶层）` }
    }
  }

  // 闸 4：ajv 真校验（必填/类型/格式……服务端独立复核，readOnly/前端表现不是边界）
  const validate = ajv.compile(schema)
  if (!validate(payload)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: ajv.errorsText(validate.errors) }
  }

  // 闸 5：required 绑定字典的字段，值必须 ∈ 生效 key 集（退役值在此拒绝；open 放行）。
  // v1 字典绑定只认顶层属性（嵌套/条件分支的绑定随 M1.3 真实表单形状复评——#710 实施期定）。
  for (const [name, prop] of Object.entries((props ?? {}) as Record<string, unknown>)) {
    const rec = prop !== null && typeof prop === 'object' ? (prop as Record<string, unknown>) : undefined
    if (!rec || rec['x-binding'] !== 'required' || typeof rec['x-dict'] !== 'string') continue
    const value = obj[name]
    if (value === undefined || value === null) continue // 缺省交闸 4（required 由契约决定）
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
