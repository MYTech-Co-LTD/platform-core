// worker.test.ts — 编排核心：匹配→渲染冻结→到期发送→回执（依赖全注入，无 DB）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import type { DeliveryRow, InsertDeliveryInput, PendingEvent } from './storage-v2'
import type { NotificationRule } from './domain/rules-v2'
import { nextAt, runOnce, type WorkerDeps } from './worker'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: { u: { type: 'user' }, title: { type: 'string' }, link: { type: 'url' } },
  recipients: {
    approver: { kind: 'field', field: 'u' },
    managers: { kind: 'scope_holders', scope: 'm:manage' },
  },
}

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  org: 'o', id: 'r1', enabled: true, eventKey: 'm.a.b', scope: 's1',
  recipientKey: 'approver', recipientLiteral: null, templateKey: 't1',
  channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual', createdAt: '2026-01-01',
  ...over,
})

const event = (over: Partial<PendingEvent> = {}): PendingEvent => ({
  org: 'o', eventId: 'e1', eventKey: 'm.a.b', scope: 's1',
  payload: { u: 'u1', title: 'T', link: 'https://x' },
  ...over,
})

const dueRow = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  org: 'o', eventId: 'e1', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
  address: 'wecom-u1', templateKey: 't1', revision: 1, rendered: { text: 'hi' },
  status: 'pending', attempts: 0, lockedUntil: null,
  ...over,
})

function makeDeps(over: Partial<WorkerDeps> = {}) {
  const inserted: InsertDeliveryInput[] = []
  const failed: { d: DeliveryRow; msg: string; at: Date }[] = []
  const dead: { d: DeliveryRow; msg: string }[] = []
  const sent: DeliveryRow[] = []
  const marks: { status: string }[] = []

  const deps: WorkerDeps = {
    now: () => new Date('2026-01-01T00:00:00Z'),
    claimEvents: async () => [event()],
    markEvent: async (_ev, status) => { marks.push({ status }) },
    listRules: async () => [rule()],
    getEventDecl: async () => decl,
    getPublishedTemplate: async () => ({
      revision: 1, contents: { wecom_chat: { text: 'Hi {{title}}' } },
    }),
    getChannel: async () => ({ provider: 'wecom_chat', enabled: true, config: {} }),
    claimDueDeliveries: async () => [],
    insertDelivery: async (d) => { inserted.push(d) },
    insertAttempt: async () => {},
    markDeliverySent: async (d) => { sent.push(d) },
    markDeliveryFailed: async (d, msg, at) => { failed.push({ d, msg, at }) },
    markDeliveryDead: async (d, msg) => { dead.push({ d, msg }) },
    resolveScopeHolders: async () => [],
    resolveAddress: async () => 'wecom-u1',
    isCoolingDown: async () => false,
    send: async () => ({ ok: true }),
    ...over,
  }
  return { deps, inserted, failed, dead, sent, marks }
}

describe('runOnce', () => {
  it('事件 → 规则 → 冻结渲染 → pending delivery', async () => {
    const f = makeDeps()
    const stats = await runOnce(f.deps)

    expect(stats).toMatchObject({ events: 1, deliveries: 1, sent: 0, failed: 0, dead: 0 })
    expect(f.inserted).toHaveLength(1)
    expect(f.inserted[0]).toMatchObject({
      recipient: 'u1', channel: 'wecom_default', address: 'wecom-u1',
      revision: 1, rendered: { text: 'Hi T' }, status: 'pending',
    })
    expect(f.marks).toEqual([{ status: 'matched' }])
  })

  it('无规则 ⇒ no_rules；冷却命中 ⇒ suppressed 且不发送', async () => {
    const noRules = makeDeps({ listRules: async () => [] })
    await runOnce(noRules.deps)
    expect(noRules.marks).toEqual([{ status: 'no_rules' }])

    const cool = makeDeps({ isCoolingDown: async () => true })
    const stats = await runOnce(cool.deps)
    expect(stats.deliveries).toBe(0)
    expect(cool.inserted[0]).toMatchObject({ status: 'suppressed', recipient: 'u1' })
  })

  it('映射不到渠道地址 ⇒ dead（不假装成功）', async () => {
    const f = makeDeps({ resolveAddress: async () => null })
    const stats = await runOnce(f.deps)
    expect(stats.deliveries).toBe(0)
    expect(f.inserted[0]).toMatchObject({
      status: 'dead', address: '', lastError: 'missing_channel_address',
    })
  })

  it('scope_holders 解析出的收件人也走同一管道', async () => {
    const f = makeDeps({
      listRules: async () => [rule({ recipientKey: 'managers' })],
      resolveScopeHolders: async () => ['u2'],
      resolveAddress: async ({ casdoorName }) => `wecom-${casdoorName}`,
    })
    const stats = await runOnce(f.deps)
    expect(stats.deliveries).toBe(1)
    expect(f.inserted[0]).toMatchObject({ recipient: 'u2', address: 'wecom-u2' })
  })

  it('retryable ⇒ failed + 退避；permanent ⇒ dead；第 5 次失败 ⇒ dead', async () => {
    const retry = makeDeps({
      claimDueDeliveries: async () => [dueRow()],
      send: async () => ({ ok: false, kind: 'retryable', code: '502', summary: 'bridge 502' }),
    })
    const s1 = await runOnce(retry.deps)
    expect(s1.failed).toBe(1)
    expect(retry.failed[0]!.msg).toBe('bridge 502')
    expect(retry.failed[0]!.at.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime())

    const perm = makeDeps({
      claimDueDeliveries: async () => [dueRow()],
      send: async () => ({ ok: false, kind: 'permanent', code: '401', summary: 'bad token' }),
    })
    const s2 = await runOnce(perm.deps)
    expect(s2.dead).toBe(1)
    expect(perm.dead[0]!.msg).toBe('bad token')

    const last = makeDeps({
      claimDueDeliveries: async () => [dueRow({ attempts: 4 })],
      send: async () => ({ ok: false, kind: 'retryable', code: '502', summary: 'again' }),
    })
    expect((await runOnce(last.deps)).dead).toBe(1)
  })

  it('成功发送 ⇒ sent 回执', async () => {
    const f = makeDeps({ claimDueDeliveries: async () => [dueRow()] })
    expect((await runOnce(f.deps)).sent).toBe(1)
    expect(f.sent).toHaveLength(1)
  })
})

describe('nextAt', () => {
  it('退避随尝试次数增长（30s/2m/10m/30m ±20%）', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const d1 = nextAt(1, now).getTime() - now.getTime()
    const d4 = nextAt(4, now).getTime() - now.getTime()
    expect(d1).toBeGreaterThanOrEqual(24_000)
    expect(d1).toBeLessThanOrEqual(36_000)
    expect(d4).toBeGreaterThanOrEqual(1_440_000)
    expect(d4).toBeLessThanOrEqual(2_160_000)
  })
})
