// notify-port.test.ts — 宿主 emit 端口：事件目录校验 + 入队包装（2026-10-27 通知基础设施 §3.4）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { buildNotifyPort } from './notify-port'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: {
    userId: { type: 'user', required: true },
    link: { type: 'url', required: true },
    n: { type: 'number' },
  },
  recipients: { approver: { kind: 'field', field: 'userId' } },
}
const catalog = { get: (k: string) => (k === 'm.a.b' ? decl : undefined), list: () => [decl] }
const id = {
  userId: 'u1', orgId: 'org1', displayName: 'u', scopes: [],
  hasScope: () => true,
}

describe('buildNotifyPort', () => {
  it('合法事件入队，org/scope/producer 来自宿主动态', async () => {
    const calls: unknown[] = []
    const port = buildNotifyPort({
      catalog,
      enqueue: async (x) => { calls.push(x); return { accepted: true } },
    })
    const r = await port.emit(id, {
      eventKey: 'm.a.b', eventId: 'e1',
      payload: { userId: 'u1', link: 'https://x' },
    })
    expect(r.accepted).toBe(true)
    expect(calls[0]).toMatchObject({
      org: 'org1', eventKey: 'm.a.b', eventId: 'e1', scope: '*', producer: 'm',
    })
  })

  it('未声明事件 / 缺 eventId / payload 违规 ⇒ 拒绝且不入队', async () => {
    const calls: unknown[] = []
    const port = buildNotifyPort({
      catalog,
      enqueue: async (x) => { calls.push(x); return { accepted: true } },
    })
    expect((await port.emit(id, { eventKey: 'm.x.y', eventId: 'e', payload: {} })).reason)
      .toBe('event_not_declared')
    expect((await port.emit(id, { eventKey: 'm.a.b', eventId: '', payload: {} })).reason)
      .toBe('event_id_required')
    expect((await port.emit(id, { eventKey: 'm.a.b', eventId: 'e', payload: { userId: 'u1' } })).reason)
      .toBe('payload_invalid')
    expect(calls).toHaveLength(0)
  })

  it('org 缺失 ⇒ 拒绝', async () => {
    const port = buildNotifyPort({ catalog, enqueue: async () => ({ accepted: true }) })
    expect((await port.emit({ ...id, orgId: '' }, {
      eventKey: 'm.a.b', eventId: 'e', payload: {},
    })).reason).toBe('org_required')
  })

  it('notify 模块未装载（无 enqueue）⇒ 拒绝但不是抛错', async () => {
    const port = buildNotifyPort({ catalog })
    expect((await port.emit(id, {
      eventKey: 'm.a.b', eventId: 'e', payload: { userId: 'u', link: 'https://x' },
    })).reason).toBe('notify_not_loaded')
  })
})
