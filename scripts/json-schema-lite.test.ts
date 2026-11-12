// json-schema-lite.test.ts — 元 schema 校验器的行为钉（Wave 2.2 残项）。
//
// 这个校验器的**纪律比实现重要**：不认识的关键字必须抛错，绝不静默放过——静默放过会让
// 「元 schema 加了约束但校验器没跟上」变成假绿。下面每一条都在钉这个纪律或某个关键字的语义。
import { describe, expect, it } from 'vitest'
import { SUPPORTED, validate } from './lib/json-schema-lite.mjs'

const root = (defs: Record<string, unknown> = {}) => ({ $defs: defs })
const run = (schema: unknown, data: unknown, defs: Record<string, unknown> = {}) =>
  validate(root(defs), schema, data)

describe('json-schema-lite：关键字纪律', () => {
  it('不认识的关键字 ⇒ **抛错**（不静默放过）', () => {
    expect(() => run({ type: 'string', uniqueItems: true }, 'x')).toThrow(/不支持的关键字 'uniqueItems'/)
  })

  it('SUPPORTED 集合与实现同步（列出来的必须真能用）', () => {
    for (const k of ['type', 'required', 'enum', 'pattern', 'allOf', 'anyOf', 'not', 'if', 'then', 'else']) {
      expect(SUPPORTED.has(k)).toBe(true)
    }
  })

  it('$ref 只认本地 #/$defs；找不到就抛', () => {
    expect(run({ $ref: '#/$defs/s' }, 'ok', { s: { type: 'string' } })).toEqual([])
    expect(() => run({ $ref: 'https://x/y.json' }, 'ok')).toThrow(/只支持/)
    expect(() => run({ $ref: '#/$defs/missing' }, 'ok')).toThrow(/不存在/)
  })
})

describe('json-schema-lite：值与形状', () => {
  it('type（含 integer vs number 的区分）', () => {
    expect(run({ type: 'integer' }, 3)).toEqual([])
    expect(run({ type: 'integer' }, 3.5)).toHaveLength(1)
    expect(run({ type: 'number' }, 3.5)).toEqual([])
    expect(run({ type: 'string' }, 3)).toHaveLength(1)
  })

  it('required / additionalProperties=false / properties', () => {
    const s = {
      type: 'object', required: ['a'], additionalProperties: false,
      properties: { a: { type: 'string' } },
    }
    expect(run(s, { a: 'x' })).toEqual([])
    expect(run(s, {})[0]!.message).toContain("缺少必填字段 'a'")
    expect(run(s, { a: 'x', b: 1 })[0]!.message).toContain("未知字段 'b'")
    expect(run(s, { a: 1 })[0]!.path).toBe('$.a')
  })

  it('const / enum / pattern / minLength / minimum / maximum / minItems / items', () => {
    expect(run({ const: 2 }, 1)).toHaveLength(1)
    expect(run({ enum: ['a', 'b'] }, 'c')).toHaveLength(1)
    expect(run({ pattern: '^[a-z]+$' }, 'AB')).toHaveLength(1)
    expect(run({ minLength: 2 }, 'a')).toHaveLength(1)
    expect(run({ minimum: 1 }, 0)).toHaveLength(1)
    expect(run({ maximum: 1 }, 2)).toHaveLength(1)
    expect(run({ type: 'array', minItems: 2, items: { type: 'string' } }, ['a'])).toHaveLength(1)
    expect(run({ type: 'array', items: { type: 'string' } }, ['a', 1])[0]!.path).toBe('$[1]')
  })

  it('allOf 全部生效；anyOf 至少一支；not 反向', () => {
    expect(run({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a')).toHaveLength(1)
    expect(run({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1)).toEqual([])
    expect(run({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true)[0]!.message).toContain('anyOf')
    expect(run({ not: { type: 'string' } }, 'x')[0]!.message).toContain('not')
    expect(run({ not: { type: 'string' } }, 1)).toEqual([])
  })

  it('if/then/else：条件不产生报错，只选分支', () => {
    const s = {
      if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' },
    }
    expect(run(s, 'ab')).toEqual([])
    expect(run(s, 'a')).toHaveLength(1)      // 走 then
    expect(run(s, 1)).toEqual([])            // 走 else
    expect(run(s, true)).toHaveLength(1)     // 走 else 且类型不符
  })
})
