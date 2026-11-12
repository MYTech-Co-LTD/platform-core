// json-schema-lite.mjs — 够用就好的 JSON Schema 校验器（**只实现本仓元 schema 用到的关键字**）。
//
// 为什么自己写而不是引 ajv：契约元 schema（`contracts/common/_schema.schema.json`）只用到
// 一个很小的关键字子集（type/required/properties/additionalProperties/items/const/enum/
// pattern/minItems/minLength/minimum + 本地 $defs/$ref）。为此在公开仓里加一个 JSON Schema
// 引擎依赖，收益（校验 28 份契约）与成本（依赖面 / lock 变更 / 版本漂移）不成比例。
//
// **纪律（比实现更重要）**：遇到**不认识的关键字就抛错**，绝不静默放过——静默放过会让
// 「元 schema 加了约束但校验器没跟上」变成假绿，那正是这个校验器要防的那类问题。
//
// 支持的子集见 `SUPPORTED`；新增关键字 = 改这个文件 + 加单测（并把该关键字移出 UNSUPPORTED 检查）。

/** 单独处理的值关键字（不影响校验结果）。 */
const ANNOTATION = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
])

/** 真正参与校验的关键字。 */
export const SUPPORTED = new Set([
  '$defs', '$ref',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'const', 'enum', 'pattern', 'minItems', 'minLength', 'minimum', 'maximum',
  'allOf', 'anyOf', 'not', 'if', 'then', 'else',
])

/**
 * 校验一份文档。
 *
 * @param {any} root 元 schema（`$ref` 的解析根）
 * @param {any} schema 当前子 schema
 * @param {any} data 待校验值
 * @param {string} path 当前位置（报错定位用）
 * @returns {Array<{ path: string, message: string }>} 违规项（空 = 通过）
 */
export function validate(root, schema, data, path = '$') {
  /** @type {Array<{ path: string, message: string }>} */
  const out = []
  validateInto(root, schema, data, path, out)
  return out
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

/**
 * @param {string} expected
 * @param {unknown} v
 * @returns {boolean}
 */
function matchesType(expected, v) {
  const actual = typeOf(v)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'integer') return actual === 'integer'
  return actual === expected
}

/** 本地 ref（`#/$defs/<name>`）；非本地/找不到 ⇒ 抛错（不静默）。 */
/**
 * @param {any} root
 * @param {string} ref
 * @returns {any}
 */
function resolveRef(root, ref) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref)
  if (m === null) throw new Error(`json-schema-lite: 只支持 #/$defs/<name> 形式的 $ref（收到 ${ref}）`)
  const def = root?.$defs?.[m[1]]
  if (def === undefined) throw new Error(`json-schema-lite: $ref 指向不存在的 $defs/${m[1]}`)
  return def
}

/**
 * @param {any} root
 * @param {any} schema
 * @param {any} data
 * @param {string} path
 * @param {Array<{ path: string, message: string }>} out
 */
function validateInto(root, schema, data, path, out) {
  if (schema === true || schema === undefined) return
  if (schema === false) {
    out.push({ path, message: '此处不允许出现值（schema=false）' })
    return
  }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`json-schema-lite: 子 schema 必须是对象（${path}）`)
  }

  // 关键字白名单：不认识的宁可炸，也不静默放过
  for (const key of Object.keys(schema)) {
    if (SUPPORTED.has(key) || ANNOTATION.has(key)) continue
    throw new Error(`json-schema-lite: 不支持的关键字 '${key}'（${path}）—— 实现它或从元 schema 去掉，别静默放过`)
  }

  if (schema.$ref !== undefined) {
    // 2020-12 允许 $ref 与其它关键字并列（本仓元 schema 确实这么用，如 `$ref` + `allOf`）
    validateInto(root, resolveRef(root, String(schema.$ref)), data, path, out)
  }

  // 组合关键字（allOf / anyOf / not / if-then-else）
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateInto(root, sub, data, path, out)
  }
  if (Array.isArray(schema.anyOf)) {
    // 任一支通过即可；全失败才报一条（不把各分支的内部错误一股脑倒出来）
    const anyPassed = schema.anyOf.some((/** @type {any} */ sub) => validate(root, sub, data, path).length === 0)
    if (!anyPassed) out.push({ path, message: `不满足 anyOf 的任何一个分支（${schema.anyOf.length} 个）` })
  }
  if (schema.not !== undefined) {
    if (validate(root, schema.not, data, path).length === 0) {
      out.push({ path, message: '命中了 not 分支（该形状不被允许）' })
    }
  }
  if (schema.if !== undefined) {
    const condOk = validate(root, schema.if, data, path).length === 0
    if (condOk && schema.then !== undefined) validateInto(root, schema.then, data, path, out)
    if (!condOk && schema.else !== undefined) validateInto(root, schema.else, data, path, out)
  }

  if (schema.type !== undefined) {
    const expected = schema.type
    if (Array.isArray(expected)) {
      if (!expected.some((t) => matchesType(t, data))) {
        out.push({ path, message: `类型应为 ${expected.join('|')}（实际 ${typeOf(data)}）` })
        return
      }
    } else if (!matchesType(expected, data)) {
      out.push({ path, message: `类型应为 ${expected}（实际 ${typeOf(data)}）` })
      return
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    out.push({ path, message: `必须是常量 ${JSON.stringify(schema.const)}（实际 ${JSON.stringify(data)}）` })
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    out.push({ path, message: `必须取 ${schema.enum.map((/** @type {unknown} */ x) => JSON.stringify(x)).join(' / ')} 之一（实际 ${JSON.stringify(data)}）` })
  }
  if (typeof schema.pattern === 'string' && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    out.push({ path, message: `不匹配 ${schema.pattern}（实际 ${JSON.stringify(data)}）` })
  }
  if (typeof schema.minLength === 'number' && typeof data === 'string' && data.length < schema.minLength) {
    out.push({ path, message: `长度不得小于 ${schema.minLength}（实际 ${data.length}）` })
  }
  if (typeof schema.minimum === 'number' && typeof data === 'number' && data < schema.minimum) {
    out.push({ path, message: `不得小于 ${schema.minimum}（实际 ${data}）` })
  }
  if (typeof schema.maximum === 'number' && typeof data === 'number' && data > schema.maximum) {
    out.push({ path, message: `不得大于 ${schema.maximum}（实际 ${data}）` })
  }

  if (typeOf(data) === 'array') {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      out.push({ path, message: `至少 ${schema.minItems} 项（实际 ${data.length}）` })
    }
    if (schema.items !== undefined) {
      data.forEach((/** @type {any} */ v, /** @type {number} */ i) => validateInto(root, schema.items, v, `${path}[${i}]`, out))
    }
  }

  if (typeOf(data) === 'object') {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) out.push({ path, message: `缺少必填字段 '${key}'` })
      }
    }
    const props = schema.properties ?? {}
    for (const [key, v] of Object.entries(data)) {
      if (props[key] !== undefined) {
        validateInto(root, props[key], v, `${path}.${key}`, out)
      } else if (schema.additionalProperties === false) {
        out.push({ path: `${path}.${key}`, message: `未知字段 '${key}'（元 schema additionalProperties=false）` })
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        validateInto(root, schema.additionalProperties, v, `${path}.${key}`, out)
      }
    }
  }
}
