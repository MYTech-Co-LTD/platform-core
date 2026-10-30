// rules.test.tsx — 规则列表/启停 + 收件人选项只来自事件声明
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import RulesTab, {
  recipientOptions, publishedTemplateOptions, enabledChannelOptions, deptTreeOf, recipientKindOf,
} from './rules'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => {
  cleanup()
  fetchMock.mockReset()
  // antd message 会起 3s 定时器；测试拆除后触发会被报成 unhandled error
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
})

const rule = {
  id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*',
  recipientKey: 'approver', recipientLiteral: null, templateKey: 't1',
  channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual',
  createdAt: '2026-10-27T00:00:00Z',
}
const event = {
  key: 'm.a.b', title: '测试事件', payload: { u: { type: 'user' } },
  recipients: { approver: { kind: 'field', field: 'u' } },
}

function mockBase() {
  routeFetch({
    'GET /api/modules/notify/rules': () => json({ rules: [rule] }),
    'GET /api/modules/notify/events': () => json({ events: [event] }),
    'GET /api/modules/notify/templates': () => json({
      templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
    }),
    'GET /api/modules/notify/channels': () => json({
      channels: [{
        id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
        config: {}, secretRefs: {}, health: null, healthAt: null,
      }],
    }),
  })
}

describe('RulesTab', () => {
  it('渲染规则并在启停时 PUT', async () => {
    const calls: string[] = []
    mockBase()
    routeFetch({
      'GET /api/modules/notify/rules': () => json({ rules: [rule] }),
      'GET /api/modules/notify/events': () => json({ events: [event] }),
      'GET /api/modules/notify/templates': () => json({
        templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
      }),
      'GET /api/modules/notify/channels': () => json({
        channels: [{
          id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
          config: {}, secretRefs: {}, health: null, healthAt: null,
        }],
      }),
      'PUT /api/modules/notify/rules/r1/enabled': (init) => {
        calls.push(String(init!.body))
        return json({ ok: true })
      },
    })

    render(<RulesTab />)
    expect(await screen.findByText('m.a.b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!)).toEqual({ enabled: false })
  })

  it('规则表显示可解析人数；0 人时显示原因', async () => {
    routeFetch({
      'GET /api/modules/notify/rules': () => json({ rules: [
        { ...rule, id: 'r-ok' }, { ...rule, id: 'r-bad' },
      ] }),
      'GET /api/modules/notify/rules/deliverability': () => json({ rules: [
        { ruleId: 'r-ok', eventKey: 'm.a.b', blocked: null, recipientCount: 2 },
        { ruleId: 'r-bad', eventKey: 'm.a.b', blocked: 'no_recipient', recipientCount: 0 },
      ] }),
      'GET /api/modules/notify/events': () => json({ events: [event] }),
      'GET /api/modules/notify/templates': () => json({ templates: [] }),
      'GET /api/modules/notify/channels': () => json({ channels: [] }),
    })

    render(<RulesTab />)
    expect(await screen.findByText('2 人')).toBeInTheDocument()
    expect(screen.getByText(/无可解析收件人/)).toBeInTheDocument()
  })

  it('deliverability 拉取失败不该拖垮规则列表', async () => {
    routeFetch({
      'GET /api/modules/notify/rules': () => json({ rules: [rule] }),
      'GET /api/modules/notify/rules/deliverability': () => json({ error: 'BOOM' }, 500),
      'GET /api/modules/notify/events': () => json({ events: [event] }),
      'GET /api/modules/notify/templates': () => json({ templates: [] }),
      'GET /api/modules/notify/channels': () => json({ channels: [] }),
    })

    render(<RulesTab />)
    expect(await screen.findByText('m.a.b')).toBeInTheDocument()
  })

  it('收件人/模板/通道选项只来自声明与启用集', () => {
    expect(recipientOptions(event as never).map((o) => o.value)).toEqual(['approver'])
    expect(recipientOptions(undefined)).toEqual([])
    expect(publishedTemplateOptions([
      { key: 't1', status: 'published', publishedRevision: 1 },
      { key: 't2', status: 'draft', publishedRevision: null },
    ] as never).map((o) => o.value)).toEqual(['t1'])
    expect(enabledChannelOptions([
      { id: 'on', provider: 'wecom_chat', enabled: true },
      { id: 'off', provider: 'wecom_chat', enabled: false },
    ] as never).map((o) => o.value)).toEqual(['on'])
  })
})

// ── 部门收件人（组织架构 Phase C；#1174）──────────────────────────────────────────
describe('RulesTab: 按部门发', () => {
  const deptEvent = {
    key: 'm.a.b', title: '测试事件', payload: { u: { type: 'user' } },
    recipients: {
      approver: { kind: 'field', field: 'u' },
      byDept: { kind: 'dept', label: '按部门' },
    },
  }
  const baseRoutes = () => ({
    'GET /api/modules/notify/rules': () => json({ rules: [] }),
    'GET /api/modules/notify/events': () => json({ events: [deptEvent] }),
    'GET /api/modules/notify/templates': () => json({
      templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
    }),
    'GET /api/modules/notify/channels': () => json({
      channels: [{
        id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
        config: {}, secretRefs: {}, health: null, healthAt: null,
      }],
    }),
    'GET /api/modules/notify/rules/deliverability': () => json({ rules: [] }),
  })

  it('平表 → 树：按 parentExtId 挂，孤儿当根不丢节点', () => {
    const tree = deptTreeOf([
      { extId: 'D1', name: '共享中心', parentExtId: null, memberCount: 3 },
      { extId: 'D2', name: '数字技术部', parentExtId: 'D1', memberCount: 2 },
      { extId: 'DX', name: '孤儿', parentExtId: 'MISSING', memberCount: 0 },
    ])
    expect(tree.map((n) => n.key)).toEqual(['D1', 'DX'])
    expect(tree[0]!.children.map((n) => n.key)).toEqual(['D2'])
    expect(tree[0]!.title).toBe('共享中心（3）')
  })

  it('★ 「按部门」档的判定与选项都来自事件声明（不是前端硬编码）', () => {
    expect(recipientOptions(deptEvent as never).map((o) => [o.value, o.label]))
      .toEqual([['approver', 'approver'], ['byDept', '按部门']])
    expect(recipientKindOf(deptEvent as never, 'byDept')).toBe('dept')
    expect(recipientKindOf(deptEvent as never, 'approver')).toBe('field')
    // 未选 / 未知档 ⇒ undefined（树不出现）
    expect(recipientKindOf(deptEvent as never, undefined)).toBeUndefined()
    expect(recipientKindOf(deptEvent as never, 'nope')).toBeUndefined()
  })
})
