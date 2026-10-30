// deliverability.test.ts — 可送达性解析（纯编排，D1 核心）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import type { NotificationRule } from './rules'
import { aggregateEventStatus, resolveDeliverability, type DeliverabilityDeps } from './deliverability'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: { u: { type: 'user' }, us: { type: 'user_list' } },
  recipients: {
    one: { kind: 'field', field: 'u' },
    many: { kind: 'field', field: 'us' },
    mgrs: { kind: 'scope_holders', scope: 'm:manage' },
    lit: { kind: 'literal' },
    dept: { kind: 'dept' },
  },
}

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  org: 'o',
  id: 'r1',
  enabled: true,
  eventKey: 'm.a.b',
  scope: '*',
  recipientKey: 'one',
  recipientLiteral: null, recipientDepts: null,
  templateKey: 't1',
  channels: ['wecom_default'],
  cooldownMinutes: null,
  origin: 'manual',
  createdAt: '2026-01-01',
  ...over,
})

const deps = (over: Partial<DeliverabilityDeps> = {}): DeliverabilityDeps => ({
  getEventDecl: async () => decl,
  getPublishedTemplate: async () => ({ revision: 1, contents: {} }),
  getChannel: async (_o, id) => ({ id, provider: 'wecom_chat', enabled: true }),
  resolveScopeHolders: async () => [],
  ...over,
})

describe('resolveDeliverability', () => {
  it('field 收件人 + 可用通道 ⇒ 不阻塞，带 source', async () => {
    const r = await resolveDeliverability({ org: 'o', rule: rule(), payload: { u: 'alice' } }, deps())
    expect(r.blocked).toBeNull()
    expect(r.recipients).toEqual([{ name: 'alice', source: 'field' }])
    expect(r.usableChannels).toEqual(['wecom_default'])
    expect(r.tpl).toEqual({ revision: 1, contents: {} })
  })

  it('scope_holders 解析出人 ⇒ source=scope_holders', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ recipientKey: 'mgrs' }), payload: {} },
      deps({ resolveScopeHolders: async () => ['bob'] }),
    )
    expect(r.recipients).toEqual([{ name: 'bob', source: 'scope_holders' }])
  })

  it('scope_holders 解析为空 ⇒ blocked=no_recipient', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ recipientKey: 'mgrs' }), payload: {} },
      deps(),
    )
    expect(r.blocked).toBe('no_recipient')
    expect(r.recipients).toEqual([])
  })

  it('literal 名单 ⇒ 不调 scope_holders', async () => {
    let called = false
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ recipientKey: 'lit', recipientLiteral: ['carol'] }), payload: {} },
      deps({
        resolveScopeHolders: async () => {
          called = true
          return []
        },
      }),
    )
    expect(r.recipients).toEqual([{ name: 'carol', source: 'literal' }])
    expect(called).toBe(false)
  })

  it('field 缺失 / 空串 / 空数组 ⇒ no_recipient', async () => {
    for (const [key, payload] of [
      ['one', {}],
      ['one', { u: '' }],
      ['many', { us: [] }],
    ] as const) {
      const r = await resolveDeliverability(
        { org: 'o', rule: rule({ recipientKey: key }), payload },
        deps(),
      )
      expect(r.blocked, `${key} ${JSON.stringify(payload)}`).toBe('no_recipient')
    }
  })

  it('通道全停用 / 不存在 ⇒ blocked=no_channel', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ channels: ['a', 'b'] }), payload: { u: 'alice' } },
      deps({ getChannel: async (_o, id) => ({ id, provider: 'wecom_chat', enabled: false }) }),
    )
    expect(r.blocked).toBe('no_channel')
    expect(r.usableChannels).toEqual([])
  })

  it('模板未发布 ⇒ blocked=template_missing（优先于其他原因）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule(), payload: {} },
      deps({ getPublishedTemplate: async () => null }),
    )
    expect(r.blocked).toBe('template_missing')
    expect(r.tpl).toBeUndefined()
  })

  it('事件声明缺失 ⇒ 解析出 0 人（decl 缺失由 worker 先判 invalid，不并进 blocked）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule(), payload: { u: 'alice' } },
      deps({ getEventDecl: async () => null }),
    )
    expect(r.recipients).toEqual([])
    expect(r.blocked).toBe('no_recipient')
  })

  it('去重：同一人只算一次', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ recipientKey: 'many' }), payload: { us: ['a', 'b', 'a'] } },
      deps(),
    )
    expect(r.recipients.map((x) => x.name)).toEqual(['a', 'b'])
  })

  it('field 与 scope_holders 同名 ⇒ field 优先（先入为主）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ recipientKey: 'many' }), payload: { us: ['dup'] } },
      deps({ resolveScopeHolders: async () => ['dup', 'other'] }),
    )
    expect(r.recipients).toEqual([
      { name: 'dup', source: 'field' },
      { name: 'other', source: 'scope_holders' },
    ])
  })
})

describe('aggregateEventStatus', () => {
  it('任一规则产出投递 ⇒ matched', () => {
    expect(aggregateEventStatus([null, 'no_recipient'], true)).toBe('matched')
    expect(aggregateEventStatus(['no_recipient'], true)).toBe('matched')
  })

  it('全部阻塞时取最靠后（invalid > no_channel > no_recipient）', () => {
    expect(aggregateEventStatus(['no_recipient', 'no_channel'], false)).toBe('no_channel')
    expect(aggregateEventStatus(['no_recipient', 'template_missing'], false)).toBe('invalid')
    expect(aggregateEventStatus(['no_channel', 'template_missing'], false)).toBe('invalid')
    expect(aggregateEventStatus(['no_recipient'], false)).toBe('no_recipients')
  })

  it('无规则 ⇒ no_rules', () => {
    expect(aggregateEventStatus([], false)).toBe('no_rules')
  })

  it('全 null 但没产出投递（如全被冷却/渲染失败）⇒ matched（不是阻塞）', () => {
    expect(aggregateEventStatus([null], false)).toBe('matched')
  })
})

// ── 部门档（组织架构 Phase C；spec 2026-10-30 §3.5）────────────────────────────────
describe('resolveDeliverability: 部门收件人', () => {
  const exp = {
    names: ['alice', 'carol'], depts: ['D1', 'D2'], members: 4, excluded: 1, unresolved: 1,
  }
  const deptRule = (depts: string[] | null) =>
    rule({ recipientKey: 'dept', recipientDepts: depts })

  it('★ 展开结果进收件人（source=dept）且三数原样带出（审计的唯一来源）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: deptRule(['D1']), payload: {} },
      deps({ resolveDeptMembers: async () => exp }),
    )
    expect(r.blocked).toBeNull()
    expect(r.recipients).toEqual([
      { name: 'alice', source: 'dept' }, { name: 'carol', source: 'dept' },
    ])
    // 三数原样透传：worker 拿它写审计、预检拿它显示「将发送给 N 人」
    expect(r.deptExpansion).toEqual(exp)
  })

  it('解析器未注入 ⇒ blocked=dept_resolver_unavailable（**不是** no_recipient）', async () => {
    const r = await resolveDeliverability({ org: 'o', rule: deptRule(['D1']), payload: {} }, deps())
    expect(r.blocked).toBe('dept_resolver_unavailable')
    expect(r.recipients).toEqual([])
  })

  it('选了部门档却没选部门 ⇒ no_recipient（不静默发 0 人、也不调解析器）', async () => {
    let called = false
    const r = await resolveDeliverability(
      { org: 'o', rule: deptRule([]), payload: {} },
      deps({ resolveDeptMembers: async () => { called = true; return exp } }),
    )
    expect(r.blocked).toBe('no_recipient')
    expect(called).toBe(false)
  })

  it('展开后一个人都没有 ⇒ no_recipient，但三数仍回（all-excluded 要看得见）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: deptRule(['D1']), payload: {} },
      deps({ resolveDeptMembers: async () => ({ ...exp, names: [] }) }),
    )
    expect(r.blocked).toBe('no_recipient')
    expect(r.deptExpansion).toMatchObject({ excluded: 1, unresolved: 1 })
  })

  it('部门档**不**叠加 scope_holders（两档互斥，别把持有权限码的人也发一遍）', async () => {
    let holdersCalled = false
    const r = await resolveDeliverability(
      { org: 'o', rule: deptRule(['D1']), payload: {} },
      deps({
        resolveDeptMembers: async () => exp,
        resolveScopeHolders: async () => { holdersCalled = true; return ['zzz'] },
      }),
    )
    expect(holdersCalled).toBe(false)
    expect(r.recipients.map((x) => x.name)).toEqual(['alice', 'carol'])
  })

  it('事件级聚合：解析器缺失归 no_recipients（与 scope_holders 未注入同口径）', () => {
    expect(aggregateEventStatus(['dept_resolver_unavailable'], false)).toBe('no_recipients')
    // 反证：有投递就算 matched
    expect(aggregateEventStatus(['dept_resolver_unavailable'], true)).toBe('matched')
  })
})

// ── 未配置通道不算可送达（2026-10-30 山海实测：seed 的 wecom_default 是空壳）───────────
describe('resolveDeliverability: 通道未配置', () => {
  it('★ 启用但未配置 ⇒ 不算 usable，并列入 unconfiguredChannels', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule(), payload: { u: 'alice' } },
      deps({ getChannel: async (_o, id) => ({ id, provider: 'wecom_chat', enabled: true, configured: false }) }),
    )
    expect(r.usableChannels).toEqual([])
    expect(r.unconfiguredChannels).toEqual(['wecom_default'])
    expect(r.blocked).toBe('no_channel')     // 全都没配 ⇒ 明确阻塞，而不是发出去全红
  })

  it('★ 一半配一半没配 ⇒ 只走配好的那条（不因为另一条是空壳就整条规则阻塞）', async () => {
    const r = await resolveDeliverability(
      { org: 'o', rule: rule({ channels: ['wecom_default', 'inapp_default'] }), payload: { u: 'alice' } },
      deps({
        getChannel: async (_o, id) => (id === 'wecom_default'
          ? { id, provider: 'wecom_chat', enabled: true, configured: false }
          : { id, provider: 'in_app', enabled: true, configured: true }),
      }),
    )
    expect(r.blocked).toBeNull()
    expect(r.usableChannels).toEqual(['inapp_default'])
    expect(r.unconfiguredChannels).toEqual(['wecom_default'])
  })

  it('不传 configured ⇒ 视为已配置（旧调用方行为不变）', async () => {
    const r = await resolveDeliverability({ org: 'o', rule: rule(), payload: { u: 'a' } }, deps())
    expect(r.usableChannels).toEqual(['wecom_default'])
    expect(r.unconfiguredChannels).toEqual([])
  })
})
