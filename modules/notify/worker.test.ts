// worker.test.ts — 编排核心：匹配→渲染冻结→到期发送→回执（依赖全注入，无 DB）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import type { DeliveryRow, InsertDeliveryInput, PendingEvent } from './storage'
import type { NotificationRule } from './domain/rules'
import { nextAt, runOnce, type WorkerDeps } from './worker'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: { u: { type: 'user' }, title: { type: 'string' }, link: { type: 'url' } },
  recipients: {
    approver: { kind: 'field', field: 'u' },
    managers: { kind: 'scope_holders', scope: 'm:manage' },
    dept: { kind: 'dept' },
  },
}

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  org: 'o', id: 'r1', enabled: true, eventKey: 'm.a.b', scope: 's1',
  recipientKey: 'approver', recipientLiteral: null, recipientDepts: null, templateKey: 't1',
  channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual', createdAt: '2026-01-01',
  ...over,
})

const event = (over: Partial<PendingEvent> = {}): PendingEvent => ({
  org: 'o', eventId: 'e1', eventKey: 'm.a.b', scope: 's1',
  payload: { u: 'u1', title: 'T', link: 'https://x' },
  ...over,
})

const dueRow = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  org: 'o', eventId: 'e1', eventKey: 'm.a.b', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
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

  it('通道达上限 ⇒ 不发送，delivery 顺延（failed + retryAfter）', async () => {
    const f = makeDeps({
      claimDueDeliveries: async () => [dueRow()],
      channelRateLimited: async () => 12_000,
    })
    const s = await runOnce(f.deps)
    expect(s.sent).toBe(0)
    expect(f.sent).toHaveLength(0)
    expect(f.failed[0]!.msg).toBe('channel_rate_limited')
    expect(f.failed[0]!.at.getTime())
      .toBe(new Date('2026-01-01T00:00:00Z').getTime() + 12_000)
  })

  // ── D1 等价性守门（正常路径仍须一致；零结果语义已由 D2 改变）──────────────
  it('D1 等价：正常路径 1 人 1 通道 ⇒ 1 条 delivery + matched', async () => {
    const f = makeDeps()
    const stats = await runOnce(f.deps)
    expect(stats).toMatchObject({ deliveries: 1, sent: 0 })
    expect(f.inserted).toHaveLength(1)
    expect(f.marks).toEqual([{ status: 'matched' }])
  })

  // ── D2：零结果是状态，不再静默 ──────────────────────────────────────────────
  it('D2：零收件人 ⇒ event=no_recipients', async () => {
    const f = makeDeps({
      listRules: async () => [rule({ recipientKey: 'managers' })],
      resolveScopeHolders: async () => [],
      claimEvents: async () => [event({ payload: { title: 'T', link: 'https://x' } })],
    })
    await runOnce(f.deps)
    expect(f.marks).toEqual([{ status: 'no_recipients' }])
  })

  it('D2：通道全停用 ⇒ event=no_channel', async () => {
    const f = makeDeps({ getChannel: async () => ({ provider: 'wecom_chat', enabled: false }) })
    await runOnce(f.deps)
    expect(f.marks).toEqual([{ status: 'no_channel' }])
  })

  it('D2：模板缺失 ⇒ event=invalid', async () => {
    const f = makeDeps({ getPublishedTemplate: async () => null })
    await runOnce(f.deps)
    expect(f.marks).toEqual([{ status: 'invalid' }])
  })

  it('D2：两条规则一好一坏 ⇒ matched（有投递即算通）', async () => {
    const f = makeDeps({
      listRules: async () => [rule({ id: 'ok' }), rule({ id: 'bad', recipientKey: 'managers' })],
      resolveScopeHolders: async () => [],
    })
    await runOnce(f.deps)
    expect(f.marks).toEqual([{ status: 'matched' }])
    expect(f.inserted.length).toBeGreaterThan(0)
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

// ── 部门收件人（组织架构 Phase C；spec 2026-10-30 §3.5；#1174）────────────────────
describe('runOnce: 部门收件人', () => {
  const deptRule = () => rule({ recipientKey: 'dept', recipientDepts: ['D1'] })
  const expansion = { names: ['u1', 'u2'], depts: ['D1', 'D2'], members: 4, excluded: 1, unresolved: 0 }

  it('★ 展开→投递，并写审计三数（展开/排除/未解析 + 目标部门）', async () => {
    const audits: { action: string; target: string; detail: Record<string, unknown> }[] = []
    const f = makeDeps({
      listRules: async () => [deptRule()],
      resolveDeptMembers: async () => expansion,
      resolveAddress: async ({ casdoorName }) => `wecom-${casdoorName}`,
      audit: async (_org, action, target, detail) => { audits.push({ action, target, detail }) },
    })
    await runOnce(f.deps)

    expect(f.inserted.map((d) => d.recipient)).toEqual(['u1', 'u2'])
    expect(f.marks).toEqual([{ status: 'matched' }])
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'notify.dept-expand',
      target: 'r1',
      detail: { depts: ['D1', 'D2'], expanded: 2, members: 4, excluded: 1, unresolved: 0, blocked: null },
    })
  })

  it('★ 未解析 > 0：审计照写、发送**不阻断**（warn 只留痕）', async () => {
    const audits: Record<string, unknown>[] = []
    const f = makeDeps({
      listRules: async () => [deptRule()],
      resolveDeptMembers: async () => ({ ...expansion, unresolved: 3 }),
      resolveAddress: async ({ casdoorName }) => `wecom-${casdoorName}`,
      audit: async (_o, _a, _t, detail) => { audits.push(detail) },
    })
    await runOnce(f.deps)
    expect(audits[0]).toMatchObject({ unresolved: 3 })
    expect(f.inserted).toHaveLength(2)              // 仍发
    expect(f.marks).toEqual([{ status: 'matched' }])
  })

  it('解析器未注入 ⇒ 显式阻塞（no_recipients），一个 delivery 都不产', async () => {
    const f = makeDeps({ listRules: async () => [deptRule()] })
    await runOnce(f.deps)
    expect(f.inserted).toHaveLength(0)
    expect(f.marks).toEqual([{ status: 'no_recipients' }])
  })

  it('展开为空（全员被禁用/未解析）⇒ no_recipients，但审计仍记下三数', async () => {
    const audits: Record<string, unknown>[] = []
    const f = makeDeps({
      listRules: async () => [deptRule()],
      resolveDeptMembers: async () => ({ ...expansion, names: [], excluded: 4, unresolved: 0 }),
      audit: async (_o, _a, _t, detail) => { audits.push(detail) },
    })
    await runOnce(f.deps)
    expect(f.inserted).toHaveLength(0)
    expect(f.marks).toEqual([{ status: 'no_recipients' }])
    expect(audits[0]).toMatchObject({ expanded: 0, excluded: 4 })
  })
})
