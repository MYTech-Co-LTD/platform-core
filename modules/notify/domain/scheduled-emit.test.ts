// scheduled-emit.test.ts — `notify.emit` job handler 的纯函数契约
import { describe, it, expect, vi } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import {
  MAX_JOB_PARAMS_BYTES, assertNamespace, buildOccurrenceEventId,
  parseScheduledEmitParams, runScheduledEmitJob, substituteOccurrenceVars,
} from './scheduled-emit'

describe('parseScheduledEmitParams', () => {
  it('接受最小形状；可选 scope/eventId', () => {
    const r = parseScheduledEmitParams(JSON.stringify({
      eventKey: 'ext.agent-a.daily', payload: { n: 1 },
    }))
    expect(r).toEqual({
      ok: true,
      params: { eventKey: 'ext.agent-a.daily', payload: { n: 1 } },
    })

    const full = parseScheduledEmitParams(JSON.stringify({
      eventKey: 'ext.agent-a.daily', scope: 's1', payload: { n: 1 }, eventId: 'e-{{occurrence}}',
    }))
    expect(full).toEqual({
      ok: true,
      params: {
        eventKey: 'ext.agent-a.daily', scope: 's1', payload: { n: 1 }, eventId: 'e-{{occurrence}}',
      },
    })
  })

  it('非法 JSON / 非对象 / 缺字段 / 超限 ⇒ 机检原因', () => {
    expect(parseScheduledEmitParams('{')).toEqual({ ok: false, reason: 'params_invalid_json' })
    expect(parseScheduledEmitParams('[]')).toEqual({ ok: false, reason: 'params_invalid_shape' })
    expect(parseScheduledEmitParams('{"payload":{}}')).toEqual({ ok: false, reason: 'params_invalid_shape' })
    expect(parseScheduledEmitParams('{"eventKey":"x","payload":[]}'))
      .toEqual({ ok: false, reason: 'params_invalid_shape' })
    expect(parseScheduledEmitParams(JSON.stringify({
      eventKey: 'x', payload: {}, eventId: '',
    }))).toEqual({ ok: false, reason: 'params_invalid_shape' })

    const huge = JSON.stringify({ eventKey: 'x', payload: { s: 'a'.repeat(MAX_JOB_PARAMS_BYTES) } })
    expect(parseScheduledEmitParams(huge)).toEqual({ ok: false, reason: 'params_too_large' })
  })
})

describe('buildOccurrenceEventId', () => {
  it('缺省 schedule:<id>:<occurrence>；模板只替换两个占位符', () => {
    expect(buildOccurrenceEventId('42', '2026-11-14T01:00:00.000Z'))
      .toBe('schedule:42:2026-11-14T01:00:00.000Z')
    expect(buildOccurrenceEventId('42', 'T', 's{{scheduleId}}-{{occurrence}}'))
      .toBe('s42-T')
    expect(buildOccurrenceEventId('42', 'T', 'literal')).toBe('literal')
  })
})

describe('substituteOccurrenceVars', () => {
  const ctx = {
    occurrence: '2026-11-14T01:00:00.000Z',
    now: '2026-11-14T02:00:00.000Z',
    timezone: 'Asia/Shanghai',
  }

  it('替换四个保留 token，递归对象/数组，非字符串原样', () => {
    expect(substituteOccurrenceVars({
      a: '{{occurrence}}', b: '{{now}}', c: '{{date}}', d: '{{timezone}}',
      n: 1, arr: ['{{date}}'], nested: { x: 'at {{occurrence}}' },
    }, ctx)).toEqual({
      a: '2026-11-14T01:00:00.000Z',
      b: '2026-11-14T02:00:00.000Z',
      c: '2026-11-14',
      d: 'Asia/Shanghai',
      n: 1,
      arr: ['2026-11-14'],
      nested: { x: 'at 2026-11-14T01:00:00.000Z' },
    })
  })

  it('非法 timezone 退回 UTC，不抛错', () => {
    expect(substituteOccurrenceVars('{{date}}', { ...ctx, timezone: 'Not/AZone' }))
      .toBe('2026-11-14')
  })
})

describe('assertNamespace', () => {
  it('ext 事件必须由同名 namespace 发', () => {
    expect(assertNamespace('ext.agent-a.daily', 'agent-a')).toEqual({ ok: true })
    expect(assertNamespace('ext.agent-a.daily', 'agent-b'))
      .toEqual({ ok: false, reason: 'namespace_mismatch' })
    expect(assertNamespace('ext.agent-a.daily', undefined))
      .toEqual({ ok: false, reason: 'namespace_required' })
    expect(assertNamespace('ext.agent-a', 'agent-a'))
      .toEqual({ ok: false, reason: 'event_key_invalid' })
  })

  it('平台事件只允许系统 job（无 namespace）', () => {
    expect(assertNamespace('aftersales.employee_approval.pending', undefined)).toEqual({ ok: true })
    expect(assertNamespace('aftersales.employee_approval.pending', 'agent-a'))
      .toEqual({ ok: false, reason: 'namespace_mismatch' })
  })
})

describe('runScheduledEmitJob', () => {
  const decl: NotificationEventDecl = {
    key: 'ext.agent-a.daily',
    title: '',
    payload: {
      n: { type: 'number', required: true },
      link: { type: 'url', required: true },
    },
    recipients: { assignee: { kind: 'field', field: 'n' } },
  }
  const base = {
    scheduleId: '42',
    occurrence: '2026-11-14T01:00:00.000Z',
    rawParams: JSON.stringify({
      eventKey: 'ext.agent-a.daily',
      payload: { n: 1, link: 'https://x', at: '{{occurrence}}' },
    }),
    org: 'acme',
    namespace: 'agent-a',
    timezone: 'Asia/Shanghai',
  }

  it('成功：确定性 eventId + 时间变量替换 + producer=agent:<ns>', async () => {
    const enqueue = vi.fn(async () => ({ accepted: true }))
    const r = await runScheduledEmitJob({
      getEventDecl: async () => decl,
      enqueue,
      now: () => new Date('2026-11-14T02:00:00.000Z'),
    }, base)
    expect(r).toEqual({
      ok: true, eventId: 'schedule:42:2026-11-14T01:00:00.000Z', accepted: true,
    })
    expect(enqueue).toHaveBeenCalledWith({
      org: 'acme',
      eventId: 'schedule:42:2026-11-14T01:00:00.000Z',
      eventKey: 'ext.agent-a.daily',
      scope: '*',
      payload: { n: 1, link: 'https://x', at: '2026-11-14T01:00:00.000Z' },
      producer: 'agent:agent-a',
    })
  })

  it('重复 occurrence ⇒ accepted=false 仍算 job 成功', async () => {
    const r = await runScheduledEmitJob({
      getEventDecl: async () => decl,
      enqueue: async () => ({ accepted: false, reason: 'duplicate' }),
      now: () => new Date(),
    }, base)
    expect(r).toMatchObject({ ok: true, accepted: false, reason: 'duplicate' })
  })

  it('namespace 不匹配 / 未声明 / payload 非法 ⇒ 不重试', async () => {
    const enqueue = vi.fn(async () => ({ accepted: true }))
    expect(await runScheduledEmitJob({
      getEventDecl: async () => decl, enqueue, now: () => new Date(),
    }, { ...base, namespace: 'agent-b' })).toEqual({
      ok: false, retryable: false, reason: 'namespace_mismatch',
    })
    expect(await runScheduledEmitJob({
      getEventDecl: async () => null, enqueue, now: () => new Date(),
    }, base)).toEqual({ ok: false, retryable: false, reason: 'event_not_declared' })
    expect(await runScheduledEmitJob({
      getEventDecl: async () => decl, enqueue, now: () => new Date(),
    }, {
      ...base,
      rawParams: JSON.stringify({ eventKey: 'ext.agent-a.daily', payload: { n: 1 } }),
    })).toMatchObject({ ok: false, retryable: false, reason: expect.stringMatching(/^payload_invalid:/) })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('声明查询/入队异常 ⇒ 可重试', async () => {
    expect(await runScheduledEmitJob({
      getEventDecl: async () => { throw new Error('db down') },
      enqueue: async () => ({ accepted: true }),
      now: () => new Date(),
    }, base)).toEqual({ ok: false, retryable: true, reason: 'decl_lookup_failed' })

    expect(await runScheduledEmitJob({
      getEventDecl: async () => decl,
      enqueue: async () => { throw new Error('db down') },
      now: () => new Date(),
    }, base)).toEqual({ ok: false, retryable: true, reason: 'enqueue_failed' })
  })
})
