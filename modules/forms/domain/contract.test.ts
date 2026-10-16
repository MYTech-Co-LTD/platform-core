import { describe, expect, it } from 'vitest'
import {
  BINDINGS,
  DICT_REF_RE,
  RESERVED_KEYS,
  compileGate,
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

describe('compileGate（发布门 = 编译闸；draft 期自由）', () => {
  it('合法 draft-07 契约 + 规范 dict 引用 → ok', () => {
    expect(compileGate(okSchema)).toEqual({ ok: true })
  })

  it('非对象 body → SCHEMA_COMPILE', () => {
    const r = compileGate('not-a-schema')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_COMPILE')
  })

  it('$schema 指到 2020-12 → SCHEMA_DIALECT（§12.1：该方言下校验静默失效）', () => {
    const r = compileGate({ ...okSchema, $schema: 'https://json-schema.org/draft/2020-12/schema' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_DIALECT')
  })

  it('$schema 为 draft-07 正典 URL → ok', () => {
    expect(compileGate({ ...okSchema, $schema: 'http://json-schema.org/draft-07/schema#' })).toEqual({ ok: true })
  })

  it('ajv 编不过的 body → SCHEMA_COMPILE（如 type: stringo）', () => {
    const r = compileGate({ type: 'object', properties: { a: { type: 'stringo' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_COMPILE')
  })

  it('x-dict 缺 x-binding → BINDING_REQUIRED（正典：每处引用必须声明绑定强度）', () => {
    const r = compileGate({
      type: 'object',
      properties: { a: { type: 'string', 'x-dict': 'dict:level' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BINDING_REQUIRED')
  })

  it('x-binding: extensible → BAD_BINDING（P7：v1 只落 required|open）', () => {
    const r = compileGate({
      type: 'object',
      properties: { a: { type: 'string', 'x-dict': 'dict:level', 'x-binding': 'extensible' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BAD_BINDING')
  })

  it('x-dict 不匹配引用格式（无前缀/坏 dict_id）→ BAD_DICT_REF', () => {
    for (const bad of ['level', 'dict:', 'gdict:Bad_Id', 'xdict:level']) {
      const r = compileGate({
        type: 'object',
        properties: { a: { type: 'string', 'x-dict': bad, 'x-binding': 'required' } },
      })
      expect(r.ok, `x-dict=${bad}`).toBe(false)
      if (!r.ok) expect(r.code, `x-dict=${bad}`).toBe('BAD_DICT_REF')
    }
  })

  it('孤立 x-binding（无 x-dict）→ BAD_DICT_REF（引用与强度成对出现）', () => {
    const r = compileGate({
      type: 'object',
      properties: { a: { type: 'string', 'x-binding': 'required' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BAD_DICT_REF')
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
  const dictLookup = (ref: string) => (ref === 'dict:level' ? new Set(['p1', 'p2', 'p3']) : new Set())

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
    const lookup = (ref: string) => (ref === 'gdict:china-region' ? new Set(['cn-11']) : new Set())
    expect(validateSubmission({ schema, payload: { region: 'cn-11' }, dictLookup: lookup }).ok).toBe(true)
    const bad = validateSubmission({ schema, payload: { region: 'xx' }, dictLookup: lookup })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('DICT_REQUIRED_VIOLATION')
  })
})
