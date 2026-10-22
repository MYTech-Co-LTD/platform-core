// envelope.test.ts — 信封构造：缺字段可辨（缺席 ≠ 空对象），键序稳定。
import { describe, expect, it } from 'vitest'
import { buildEnvelope, ENVELOPE_SCHEMA } from './envelope'

describe('buildEnvelope', () => {
  it('只带有值的 section；status 缺省 ok 且居首', () => {
    const env = buildEnvelope({
      metric: { id: 'm:1', version: 3 },
      audit: { id: 42, ts: '2026-10-21T18:00:00+08:00' },
    })
    expect(Object.keys(env)[0]).toBe('status')
    expect(env.status).toBe('ok')
    expect(env.metric).toEqual({ id: 'm:1', version: 3 })
    expect('subject' in env).toBe(false)
    expect('asOf' in env).toBe(false)
    expect('result' in env).toBe(false)
  })
  it('全部 section 在场时形状与 spec §4 对齐（键集合恰好）', () => {
    const env = buildEnvelope({
      metric: {}, subject: {}, asOf: {}, query: {}, result: {}, lineage: {}, audit: {},
    })
    expect(Object.keys(env)).toEqual(['status', 'metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit'])
  })
  it('ENVELOPE_SCHEMA 是 object 类型且 properties 覆盖七 section', () => {
    expect((ENVELOPE_SCHEMA as { type: string }).type).toBe('object')
    for (const k of ['metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit']) {
      expect((ENVELOPE_SCHEMA as { properties: Record<string, unknown> }).properties[k]).toBeDefined()
    }
  })
})
