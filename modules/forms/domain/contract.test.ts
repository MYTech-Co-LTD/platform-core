import { describe, expect, it } from 'vitest'
import {
  BINDINGS,
  DICT_REF_RE,
  RESERVED_KEYS,
  compileGate,
  schemaOf,
  validateSubmission,
} from './contract'

// 契约编译闸 + 提交五道闸（issue #710；纪律出处 ADR-0005 §12.11–12.13：
// 纯函数（不 import pool/env/Hono）、写时校验、机检错误码、fail-closed）。
// 方言定案 draft-07（ADR-0005 §12.1：2020-12 会让 RJSF 校验静默失效）。

const okSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '姓名' },
    level: { type: 'string', title: '级别', 'x-dict': 'dict:level', 'x-binding': 'required' },
    note: { type: 'string', title: '备注', 'x-dict': 'dict:level', 'x-binding': 'open' },
  },
  required: ['name'],
}

/** 测试辅助：把裸 schema 包成契约 body（`{schema, uiSchema?}`，#724 形状）再调闸。 */
const gate = (schema: unknown) => compileGate({ schema })

describe('compileGate（发布门 = 编译闸；draft 期自由）', () => {
  it('合法 draft-07 契约 + 规范 dict 引用 → ok', () => {
    expect(gate(okSchema)).toEqual({ ok: true })
  })

  it('非对象 body → SCHEMA_COMPILE', () => {
    const r = gate('not-a-schema')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_COMPILE')
  })

  it('$schema 指到 2020-12 → SCHEMA_DIALECT（§12.1：该方言下校验静默失效）', () => {
    const r = gate({ ...okSchema, $schema: 'https://json-schema.org/draft/2020-12/schema' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_DIALECT')
  })

  it('$schema 为 draft-07 正典 URL → ok', () => {
    expect(gate({ ...okSchema, $schema: 'http://json-schema.org/draft-07/schema#' })).toEqual({ ok: true })
  })

  it('ajv 编不过的 body → SCHEMA_COMPILE（如 type: stringo）', () => {
    const r = gate({ type: 'object', properties: { a: { type: 'stringo' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_COMPILE')
  })

  it('x-dict 缺 x-binding → BINDING_REQUIRED（正典：每处引用必须声明绑定强度）', () => {
    const r = gate({
      type: 'object',
      properties: { a: { type: 'string', 'x-dict': 'dict:level' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BINDING_REQUIRED')
  })

  it('x-binding: extensible → BAD_BINDING（P7：v1 只落 required|open）', () => {
    const r = gate({
      type: 'object',
      properties: { a: { type: 'string', 'x-dict': 'dict:level', 'x-binding': 'extensible' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BAD_BINDING')
  })

  it('x-dict 不匹配引用格式（无前缀/坏 dict_id）→ BAD_DICT_REF', () => {
    for (const bad of ['level', 'dict:', 'gdict:Bad_Id', 'xdict:level']) {
      const r = gate({
        type: 'object',
        properties: { a: { type: 'string', 'x-dict': bad, 'x-binding': 'required' } },
      })
      expect(r.ok, `x-dict=${bad}`).toBe(false)
      if (!r.ok) expect(r.code, `x-dict=${bad}`).toBe('BAD_DICT_REF')
    }
  })

  it('孤立 x-binding（无 x-dict）→ BAD_DICT_REF（引用与强度成对出现）', () => {
    const r = gate({
      type: 'object',
      properties: { a: { type: 'string', 'x-binding': 'required' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BAD_DICT_REF')
  })

  it('条件字段：then 里没有目标字段 → CONDITIONAL_EMPTY（§12.7：八成字段被放顶层）', () => {
    const r = gate({
      type: 'object',
      properties: { t: { type: 'string', enum: ['a', 'b'] } },
      if: { properties: { t: { const: 'a' } }, required: ['t'] },
      then: {},
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CONDITIONAL_EMPTY')
  })

  it('条件字段：目标字段同时声明在顶层 properties → CONDITIONAL_TOPLEVEL（会常显）', () => {
    const r = gate({
      type: 'object',
      properties: {
        t: { type: 'string', enum: ['a', 'b'] },
        otherText: { type: 'string' }, // 放顶层 ⇒ 常显（PoC 首轮 100% 踩中的坑）
      },
      if: { properties: { t: { const: 'a' } }, required: ['t'] },
      then: { properties: { otherText: { type: 'string' } } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CONDITIONAL_TOPLEVEL')
  })

  it('条件字段：目标字段只声明在 then.properties → ok（正确显隐形态）', () => {
    const r = gate({
      type: 'object',
      properties: { t: { type: 'string', enum: ['a', 'b'] } },
      if: { properties: { t: { const: 'a' } }, required: ['t'] },
      then: { properties: { otherText: { type: 'string', minLength: 1 } }, required: ['otherText'] },
    })
    expect(r.ok).toBe(true)
  })
})

describe('DICT_REF_RE / BINDINGS / RESERVED_KEYS（契约约定常量）', () => {
  it('引用格式：dict:<id> 租户私有 / gdict:<id> 全局（P4 分档）', () => {
    expect(DICT_REF_RE.test('dict:level')).toBe(true)
    expect(DICT_REF_RE.test('gdict:china-region')).toBe(true)
    expect(DICT_REF_RE.test('dict:Level')).toBe(false)
    expect(DICT_REF_RE.test('level')).toBe(false)
  })
  it('绑定强度 v1 两档', () => {
    expect([...BINDINGS]).toEqual(['required', 'open'])
  })
  it('保留键含主体键（org/tenant 等）', () => {
    expect(RESERVED_KEYS).toContain('org')
    expect(RESERVED_KEYS).toContain('tenant')
  })
})

describe('validateSubmission（五道闸，按提交钉住的版本契约）', () => {
  const dictLookup = (ref: string): Set<string> => (ref === 'dict:level' ? new Set(['p1', 'p2', 'p3']) : new Set())

  it('合法 payload → ok', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: '张三', level: 'p1' }, dictLookup })
    expect(r.ok).toBe(true)
  })

  it('闸 1：payload 带保留键（org）→ RESERVED_KEY，不静默忽略', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: 'x', org: 'other' }, dictLookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('RESERVED_KEY')
  })

  it('闸 1：保留键 tenant/tenantId/id/submittedBy 全拦', () => {
    for (const k of ['tenant', 'tenantId', 'id', 'submittedBy']) {
      const r = validateSubmission({ schema: okSchema, payload: { name: 'x', [k]: 1 }, dictLookup })
      expect(r.ok, k).toBe(false)
      if (!r.ok) expect(r.code, k).toBe('RESERVED_KEY')
    }
  })

  it('payload 不是 JSON 对象 → NOT_JSON', () => {
    const r = validateSubmission({ schema: okSchema, payload: 'str', dictLookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_JSON')
  })

  it('闸 2：顶层契约外字段 → UNKNOWN_FIELD（§12.12：不静默丢弃）', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: 'x', hacker: 1 }, dictLookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_FIELD')
  })

  it('闸 3：契约必填缺失 → SCHEMA_INVALID（ajv draft-07 真校验）', () => {
    const r = validateSubmission({ schema: okSchema, payload: { level: 'p1' }, dictLookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_INVALID')
  })

  it('闸 4：required 绑定字段值不在生效 key 集 → DICT_REQUIRED_VIOLATION', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: 'x', level: 'p999' }, dictLookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('DICT_REQUIRED_VIOLATION')
  })

  it('open 绑定：集合外自由值放行（正典：一律 required 会卡死业务）', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: 'x', note: '不在集合内的话' }, dictLookup })
    expect(r.ok).toBe(true)
  })

  it('可选字典字段缺省 → 放行（不填不校验）', () => {
    const r = validateSubmission({ schema: okSchema, payload: { name: 'x' }, dictLookup })
    expect(r.ok).toBe(true)
  })

  it('gdict 引用走同一 dictLookup（前缀透传）', () => {

    const schema = {
      type: 'object',
      properties: { region: { type: 'string', 'x-dict': 'gdict:china-region', 'x-binding': 'required' } },
    }
    const lookup = (ref: string): Set<string> => (ref === 'gdict:china-region' ? new Set(['cn-11']) : new Set())
    expect(validateSubmission({ schema, payload: { region: 'cn-11' }, dictLookup: lookup }).ok).toBe(true)
    const bad = validateSubmission({ schema, payload: { region: 'xx' }, dictLookup: lookup })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('DICT_REQUIRED_VIOLATION')
  })
})

// readOnly 服务端复验（issue #722；ADR-0005 §12.11）：
// ui:readonly / ui:disabled 只是客户端表现（前者提交时**仍带值**），JSON Schema 的 readOnly
// 本身也只是**注解** ⇒ 服务端必须独立复验。契约声明 readOnly 的字段出现在提交体里即拒。
describe('readOnly 服务端复验（READONLY_FIELD）', () => {
  const schemaRO = {
    type: 'object',
    properties: {
      name: { type: 'string', title: '姓名' },
      submittedAt: { type: 'string', title: '提交时间', readOnly: true },
      storeNo: { type: 'string', title: '门店号', readOnly: true },
    },
    required: ['name'],
  }

  it('提交体带 readOnly 字段 ⇒ READONLY_FIELD（注解不是边界，服务端独立拒）', () => {
    const r = validateSubmission({
      schema: schemaRO,
      payload: { name: '张三', storeNo: 'S001' },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('READONLY_FIELD')
  })

  it('即便值与原值相同（原样回传）也拒——存在即写入尝试', () => {
    const r = validateSubmission({
      schema: schemaRO,
      payload: { name: '张三', storeNo: 'S001' },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('READONLY_FIELD')
  })

  it('同时是保留键时，闸 1 先拦（RESERVED_KEY 优先于 READONLY_FIELD）', () => {
    const r = validateSubmission({
      schema: schemaRO,
      payload: { name: '张三', submittedAt: '2026-10-16T00:00:00Z' },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('RESERVED_KEY')
  })

  it('带 null 值同样拒（不靠「值是否为空」判，避免服务端代填的歧义）', () => {
    const r = validateSubmission({
      schema: schemaRO,
      payload: { name: '张三', storeNo: null },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('READONLY_FIELD')
  })

  it('不带 readOnly 字段 ⇒ 通过（正常填报不受影响）', () => {
    const r = validateSubmission({ schema: schemaRO, payload: { name: '张三' }, dictLookup: () => new Set() })
    expect(r.ok).toBe(true)
  })

  it('非 readOnly 字段照常（不误伤）', () => {
    const r = validateSubmission({ schema: schemaRO, payload: { name: '李四' }, dictLookup: () => new Set() })
    expect(r.ok).toBe(true)
  })

  it('闸序：契约外字段先报 UNKNOWN_FIELD（顶层白名单优先于 readOnly）', () => {
    const r = validateSubmission({
      schema: schemaRO,
      payload: { name: '张三', notInContract: 1 },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_FIELD')
  })
})

// 契约 body 形状 = {schema, uiSchema?}（#724 定案）+ 两个新闸：uiSchema 漂移、控件白名单
describe('契约 body 形状与 uiSchema 两闸（#724）', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' }, level: { type: 'string', enum: ['a'] } }, required: ['name'] }

  it('body 缺 schema → SCHEMA_COMPILE（指到形状约定）', () => {
    const r = compileGate({ type: 'object', properties: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('SCHEMA_COMPILE')
      expect(r.detail).toContain('schema')
    }
  })

  it('uiSchema 不是对象 → SCHEMA_COMPILE', () => {
    const r = compileGate({ schema, uiSchema: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_COMPILE')
  })

  it('uiSchema 缺省 → 通过（没有 UI 意图就不写）', () => {
    expect(compileGate({ schema })).toEqual({ ok: true })
  })

  it('uiSchema 键不在 schema.properties → UI_SCHEMA_DRIFT（两半漂移）', () => {
    const r = compileGate({ schema, uiSchema: { notAField: { 'ui:placeholder': 'x' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UI_SCHEMA_DRIFT')
  })

  it('★ 条件字段（then.properties 内）带 uiSchema 提示**不算漂移**（真机实测抓到的回归）', () => {
    // §12.7：条件字段只声明在 then.properties 里；它同样可以带 uiSchema 提示。
    // 若漂移闸只查根 properties，会把合法契约误拒——2026-10-16 dev-stack 真实链路抓到。
    const withCond = {
      type: 'object',
      properties: { level: { type: 'string', enum: ['minor', 'severe'] } },
      if: { properties: { level: { const: 'severe' } }, required: ['level'] },
      then: { properties: { deadline: { type: 'string', format: 'date' } }, required: ['deadline'] },
    }
    const r = compileGate({ schema: withCond, uiSchema: { level: { 'ui:widget': 'radio' }, deadline: { 'ui:widget': 'date' } } })
    expect(r).toEqual({ ok: true })
  })

  it('组合子（allOf/anyOf/oneOf）里声明的字段同样可寻址', () => {
    const comb = { type: 'object', properties: { a: { type: 'string' } }, allOf: [{ properties: { b: { type: 'string' } } }] }
    expect(compileGate({ schema: comb, uiSchema: { b: { 'ui:widget': 'textarea' } } })).toEqual({ ok: true })
  })

  it('真漂移仍然拦：键在 schema 里根本不存在', () => {
    const r = compileGate({ schema, uiSchema: { ghost: { 'ui:widget': 'text' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UI_SCHEMA_DRIFT')
  })

  it('ui:globalOptions 是全局键、不算漂移', () => {
    expect(compileGate({ schema, uiSchema: { 'ui:globalOptions': { 'ui:emptyValue': '' } } })).toEqual({ ok: true })
  })

  it('uiSchema 键都在 schema 内 → 通过', () => {
    expect(compileGate({ schema, uiSchema: { name: { 'ui:placeholder': '请输入' }, level: { 'ui:widget': 'radio' } } })).toEqual({ ok: true })
  })

  it('★ ui:widget 不在支持集 → UNSUPPORTED_WIDGET（cascader/signature/file 都拒）', () => {
    for (const w of ['cascader', 'signature', 'file', 'richtext']) {
      const r = compileGate({ schema, uiSchema: { name: { 'ui:widget': w } } })
      expect(r.ok, w).toBe(false)
      if (!r.ok) expect(r.code, w).toBe('UNSUPPORTED_WIDGET')
    }
  })

  it('支持集内的 widget → 通过（含嵌套 items 里的）', () => {
    expect(compileGate({ schema, uiSchema: { name: { 'ui:widget': 'textarea' }, level: { 'ui:widget': 'radio' } } })).toEqual({ ok: true })
    const nested = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { note: { type: 'string' } } } } } }
    expect(compileGate({ schema: nested, uiSchema: { rows: { items: { note: { 'ui:widget': 'textarea' } } } } })).toEqual({ ok: true })
  })

  it('方言语义不变：$schema 在 schema 那一半（不是 body 顶层）', () => {
    const r = compileGate({ schema: { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_DIALECT')
  })

  it('schemaOf：取内层 / 非法形状给 null', () => {
    expect(schemaOf({ schema })).toEqual(schema)
    expect(schemaOf({ type: 'object' })).toBeNull()
    expect(schemaOf(null)).toBeNull()
    expect(schemaOf({ schema: [] })).toBeNull()
  })
})

// 条件字段与提交闸的交互（2026-10-16 dev-stack 真机实测抓到的**严重**回归：
// 条件字段按 §12.7 只声明在 then.properties，而提交闸只查根 properties
// ⇒ 带条件字段的表单**永远提交不了**。此处钉死修好后的行为。）
describe('提交闸与条件字段（then.properties）', () => {
  const condSchema = {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['minor', 'severe'] },
      note: { type: 'string', maxLength: 100 },
    },
    required: ['level'],
    if: { properties: { level: { const: 'severe' } }, required: ['level'] },
    then: {
      properties: { deadline: { type: 'string', minLength: 2 } },
      required: ['deadline'],
    },
  }

  it('★ 提交体带条件字段（then.properties 内）→ 放行（曾被误判 UNKNOWN_FIELD）', () => {
    const r = validateSubmission({
      schema: condSchema,
      payload: { level: 'severe', deadline: '三天内' },
      dictLookup: () => new Set(),
    })
    expect(r).toEqual({ ok: true })
  })

  it('条件字段在组合子（allOf）里声明时同样放行', () => {
    const combSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      allOf: [{ properties: { b: { type: 'string' } } }],
    }
    expect(
      validateSubmission({ schema: combSchema, payload: { a: 'x', b: 'y' }, dictLookup: () => new Set() }),
    ).toEqual({ ok: true })
  })

  it('真·契约外字段仍然拒（修完不能把闸放松成不拦）', () => {
    const r = validateSubmission({ schema: condSchema, payload: { level: 'minor', ghost: 1 }, dictLookup: () => new Set() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_FIELD')
  })

  it('★ then 里声明的 readOnly 字段同样被复验拦下（#722 闸不因位置而失效）', () => {
    const roCond = {
      type: 'object',
      properties: { t: { type: 'string', enum: ['a'] } },
      if: { properties: { t: { const: 'a' } }, required: ['t'] },
      then: { properties: { locked: { type: 'string', readOnly: true } } },
    }
    const r = validateSubmission({ schema: roCond, payload: { t: 'a', locked: 'x' }, dictLookup: () => new Set() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('READONLY_FIELD')
  })

  it('条件分支里的 required 绑定字典字段照常校验', () => {
    const dictCond = {
      type: 'object',
      properties: { t: { type: 'string', enum: ['a'] } },
      if: { properties: { t: { const: 'a' } }, required: ['t'] },
      then: { properties: { d: { type: 'string', 'x-dict': 'dict:x', 'x-binding': 'required' } } },
    }
    const ok = validateSubmission({ schema: dictCond, payload: { t: 'a', d: 'k1' }, dictLookup: () => new Set(['k1']) })
    expect(ok).toEqual({ ok: true })
    const bad = validateSubmission({ schema: dictCond, payload: { t: 'a', d: 'nope' }, dictLookup: () => new Set(['k1']) })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('DICT_REQUIRED_VIOLATION')
  })
})

// ── §2.4「指派与催办」：契约新增两个可选顶层键（assignees / due）的编译闸 ──────────────
describe('compileGate：指派与催办两键（§2.4）', () => {
  const base = { schema: { type: 'object', properties: { a: { type: 'string' } } } }

  it('两键缺省 → 通过（向后兼容，存量表单不受影响）', () => {
    expect(compileGate(base).ok).toBe(true)
  })

  it('assignees.dictRef 合法 → 通过', () => {
    expect(compileGate({ ...base, assignees: { dictRef: 'dict:store-staff' } }).ok).toBe(true)
    expect(compileGate({ ...base, assignees: { dictRef: 'gdict:staff' } }).ok).toBe(true)
  })

  it('assignees.dictRef 不匹配引用语法 → BAD_ASSIGNEE_REF', () => {
    expect(compileGate({ ...base, assignees: { dictRef: 'store-staff' } }))
      .toMatchObject({ ok: false, code: 'BAD_ASSIGNEE_REF' })
  })

  it('assignees 形状不对（数组 / 缺 dictRef / 非字符串 / null）→ BAD_ASSIGNEE_REF', () => {
    for (const bad of [['a'], {}, { dictRef: 7 }, null]) {
      expect(compileGate({ ...base, assignees: bad })).toMatchObject({ ok: false, code: 'BAD_ASSIGNEE_REF' })
    }
  })

  it('due.afterDays 正整数 → 通过', () => {
    expect(compileGate({ ...base, due: { afterDays: 7 } }).ok).toBe(true)
  })

  it('due.afterDays 非正整数（0 / 负数 / 小数 / 非数 / 缺）→ BAD_DUE', () => {
    for (const bad of [{ afterDays: 0 }, { afterDays: -1 }, { afterDays: 1.5 }, { afterDays: '7' }, {}, null]) {
      expect(compileGate({ ...base, due: bad })).toMatchObject({ ok: false, code: 'BAD_DUE' })
    }
  })
})
