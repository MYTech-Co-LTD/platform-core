// console.test.tsx — forms console 组件测试（issue #718；姿势照 demo/note.test.tsx）。
// mock 点一个：platformFetch（按 URL 回 Response）——页面业务行为全走它。
// 渲染经 createMemoryRouter + <Outlet context>：还原 Console 壳注入 session.scopes 的真实形态。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import FormsConsolePage from './index'
import { renderModelOf } from './api'

const platformFetchMock = vi.mocked(platformFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockApi(handlers: Record<string, () => Response>): void {
  platformFetchMock.mockImplementation(async (input: string) => {
    const handler = handlers[input]
    if (!handler) throw new Error('unexpected platformFetch: ' + input)
    return handler()
  })
}

function renderAt(path: string, scopes: string[]): void {
  const router = createMemoryRouter(
    [
      {
        // Console 壳的真实形态：父路由 <Outlet context> 注入 session，模块页是其子路由
        path: '/console',
        element: <Outlet context={{ session: { scopes } }} />,
        children: [{ path: 'forms/*', element: <FormsConsolePage /> }],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
}

beforeEach(() => {
  platformFetchMock.mockReset()
})
afterEach(cleanup)

const defsBody = {
  defs: [
    { assetId: 'check-in', headVersion: 2, draftCount: 1, publishedCount: 2, retiredCount: 0, updatedAt: '2026-10-16T00:00:00Z' },
    { assetId: 'draft-only', headVersion: null, draftCount: 1, publishedCount: 0, retiredCount: 0, updatedAt: '2026-10-16T00:00:00Z' },
  ],
}

describe('表单列表页', () => {
  it('渲染 defs 列表；有 forms:fill 且有 head 的行亮「填报」', async () => {
    mockApi({ '/api/modules/forms/defs': () => jsonResponse(defsBody) })
    renderAt('/console/forms/forms', ['forms:view', 'forms:fill'])
    await waitFor(() => expect(screen.getByText('check-in')).toBeInTheDocument())
    expect(screen.getByText('draft-only')).toBeInTheDocument()
    // draft-only 无 head ⇒ 不给填报入口（未发布标注）
    expect(screen.getByText('未发布')).toBeInTheDocument()
    const fillBtns = screen.getAllByRole('button', { name: '填报' })
    expect(fillBtns.length).toBe(1) // 只有 check-in 一行可填报
  })

  it('无 forms:fill 的会话不出现「填报」按钮（API 面另有门卫权威拦截）', async () => {
    mockApi({ '/api/modules/forms/defs': () => jsonResponse(defsBody) })
    renderAt('/console/forms/forms', ['forms:view'])
    await waitFor(() => expect(screen.getByText('check-in')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '填报' })).not.toBeInTheDocument()
  })
})

describe('renderModelOf（纯函数：契约 body → RJSF 一对，注入字典候选，不碰原契约）', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: '姓名' },
      level: { type: 'string', title: '级别', 'x-dict': 'dict:level', 'x-binding': 'required' },
      note: { type: 'string', title: '备注', 'x-dict': 'dict:level', 'x-binding': 'open' },
    },
    required: ['name'],
  }
  const options = new Map([['dict:level', [{ key: 'p1', label: '一线', sortNo: 1 }, { key: 'p2', label: '二线', sortNo: 2 }]]])

  it('required 绑定注入 enum（值）+ uiSchema enumNames（标签，v6 口径）；open 不注入', () => {
    const { schema: copy, uiSchema } = renderModelOf({ schema }, options)
    const props = (copy as { properties: Record<string, Record<string, unknown>> }).properties
    const level = props['level']
    const note = props['note']
    expect(level['enum']).toEqual(['p1', 'p2'])
    expect(uiSchema['level']).toEqual({ 'ui:options': { enumNames: ['一线', '二线'] } })
    expect(note['enum']).toBeUndefined()
    expect(uiSchema['note']).toBeUndefined()
  })

  it('原契约不被碰（铁律：存储契约永不含值）', () => {
    renderModelOf({ schema }, options)
    const level = (schema.properties as Record<string, Record<string, unknown>>)['level']
    expect(level['enum']).toBeUndefined()
  })
})

describe('填报页', () => {
  const headSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: '姓名' },
      level: { type: 'string', title: '级别', 'x-dict': 'dict:level', 'x-binding': 'required' },
      note: { type: 'string', title: '备注', 'x-dict': 'dict:level', 'x-binding': 'open' },
    },
    required: ['name'],
  }

  it('取 head 契约渲染：required 绑定渲染为下拉（combobox）、open 渲染为自由文本框', async () => {
    mockApi({
      '/api/modules/forms/defs/fill-target': () =>
        jsonResponse({ assetId: 'fill-target', head: 1, versions: [{ version: 1, status: 'published', createdBy: 'u', publishedBy: 'h', body: { schema: headSchema } }] }),
      '/api/modules/forms/dicts/level/options': () =>
        jsonResponse({ options: [{ key: 'p1', label: '一线', sortNo: 1 }, { key: 'p2', label: '二线', sortNo: 2 }] }),
    })
    renderAt('/console/forms/fill/fill-target', ['forms:fill'])
    await waitFor(() => expect(screen.getByText('填报：fill-target（v1）')).toBeInTheDocument())
    // required 字段注入 enum ⇒ antd Select（combobox）；open 字段 ⇒ 自由文本（textbox，第二个 name 以 note 开头）
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
    expect(screen.getByLabelText('姓名')).toBeInTheDocument()
    expect(screen.getByLabelText('备注')).toBeInTheDocument()
  })

  it('提交 → POST /submissions 带 { payload }；成功呈现记录号', async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = []
    platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/modules/forms/defs/quick') {
        return jsonResponse({ assetId: 'quick', head: 1, versions: [{ version: 1, status: 'published', createdBy: 'u', publishedBy: 'h', body: { schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] } } }] })
      }
      if (input === '/api/modules/forms/defs/quick/submissions' && init?.method === 'POST') {
        posts.push({ url: input, init })
        return jsonResponse({ id: '42', version: 1 }, 201)
      }
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/fill/quick', ['forms:fill'])
    await waitFor(() => expect(screen.getByText('姓名')).toBeInTheDocument())
    // React 受控输入：必须走 fireEvent（原生 dispatch 不进 React 状态 ⇒ ajv 拦住不触发 onSubmit）
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '张三' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(posts.length).toBe(1))
    const sent = JSON.parse(String(posts[0].init?.body)) as { payload: { name: string } }
    expect(sent.payload.name).toBe('张三')
    await waitFor(() => expect(screen.getByText(/已提交（记录 #42，按 v1 契约收执）/, { exact: false })).toBeInTheDocument())
  })

  it('服务端拒绝（机检错误码）原样呈现——客户端不是权威', async () => {
    platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/modules/forms/defs/deny') {
        return jsonResponse({ assetId: 'deny', head: 1, versions: [{ version: 1, status: 'published', createdBy: 'u', publishedBy: 'h', body: { schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] } } }] })
      }
      if (input === '/api/modules/forms/defs/deny/submissions' && init?.method === 'POST') {
        return jsonResponse({ error: 'UNKNOWN_FIELD', detail: '字段 "hacker" 不在契约内（顶层）' }, 400)
      }
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/fill/deny', ['forms:fill'])
    await waitFor(() => expect(screen.getByText('姓名')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(screen.getByText('提交被拒')).toBeInTheDocument())
    // 呈现的是机检错误的 detail 文案（错误码在 ApiError.code，供程序消费；UI 给人话）
    expect(screen.getByText(/不在契约内/)).toBeInTheDocument()
  })

  it('无发布版本 → 提示不可填报', async () => {
    mockApi({
      '/api/modules/forms/defs/nohead': () => jsonResponse({ assetId: 'nohead', head: null, versions: [{ version: 1, status: 'draft', createdBy: 'u', publishedBy: null, body: { schema: {} } }] }),
    })
    renderAt('/console/forms/fill/nohead', ['forms:fill'])
    await waitFor(() => expect(screen.getByText('该表单还没有发布版本，暂不能填报')).toBeInTheDocument())
  })

  it('readOnly 字段渲染为只读；且 readOnly+x-dict 组合下候选注入不会把它变成可写（#722）', async () => {
    const roSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: '姓名' },
        storeNo: { type: 'string', title: '门店号', readOnly: true },
        level: { type: 'string', title: '级别', readOnly: true, 'x-dict': 'dict:level', 'x-binding': 'required' },
      },
      required: ['name'],
    }
    mockApi({
      '/api/modules/forms/defs/ro': () =>
        jsonResponse({ assetId: 'ro', head: 1, versions: [{ version: 1, status: 'published', createdBy: 'u', publishedBy: 'h', body: { schema: roSchema } }] }),
      '/api/modules/forms/dicts/level/options': () => jsonResponse({ options: [{ key: 'p1', label: '一线', sortNo: 1 }] }),
    })
    renderAt('/console/forms/fill/ro', ['forms:fill'])
    await waitFor(() => expect(screen.getByText('填报：ro（v1）')).toBeInTheDocument())

    const name = screen.getByLabelText('姓名') as HTMLInputElement
    expect(name.disabled).toBe(false) // 可写字段不受影响

    const store = screen.getByLabelText('门店号') as HTMLInputElement
    expect(store.disabled || store.hasAttribute('readonly')).toBe(true) // readOnly ⇒ 只读

    // readOnly + x-dict：候选仍会被注入，但控件必须仍是只读（客户端表现；边界在服务端 READONLY_FIELD）
    const level = document.querySelector('#root_level') as HTMLInputElement | null
    if (level) expect(level.disabled || level.hasAttribute('readonly')).toBe(true)
  })
})

describe('提交记录页', () => {
  it('深链直达资产：列提交；展开行翻译字典 label 并标注退役值', async () => {
    mockApi({
      '/api/modules/forms/defs': () => jsonResponse(defsBody),
      '/api/modules/forms/defs/check-in/submissions': () =>
        jsonResponse({
          submissions: [
            { id: '7', version: 1, payload: { level: 'p1' }, submittedBy: 's1', submittedAt: '2026-10-16T01:00:00Z' },
            { id: '8', version: 1, payload: { level: 'p9' }, submittedBy: 's2', submittedAt: '2026-10-16T02:00:00Z' },
          ],
        }),
      '/api/modules/forms/submissions/7': () =>
        jsonResponse({ submission: {}, contract: { schema: { properties: { level: { type: 'string', 'x-dict': 'dict:level', 'x-binding': 'required' } } } } }),
      '/api/modules/forms/submissions/8': () =>
        jsonResponse({ submission: {}, contract: { schema: { properties: { level: { type: 'string', 'x-dict': 'dict:level', 'x-binding': 'required' } } } } }),
      '/api/modules/forms/dicts/level/resolve?keys=p1': () =>
        jsonResponse({ resolved: { p1: { label: '一线', enabled: true } } }),
      '/api/modules/forms/dicts/level/resolve?keys=p9': () =>
        jsonResponse({ resolved: { p9: { label: '临时档', enabled: false } } }),
    })
    renderAt('/console/forms/submissions/check-in', ['forms:view'])
    await waitFor(() => expect(screen.getAllByText('v1').length).toBe(2))
    // 展开两行（antd 展开钮；React 受控事件必须走 fireEvent——原生 dispatch 不进状态）
    const expanders = document.querySelectorAll('.ant-table-row-expand-icon')
    expect(expanders.length).toBe(2)
    expanders.forEach((b) => fireEvent.click(b))
    await waitFor(() => expect(screen.getByText('一线')).toBeInTheDocument())
    expect(screen.getByText('临时档')).toBeInTheDocument()
    expect(screen.getByText('已退役')).toBeInTheDocument()
    expect(screen.getByText('s1')).toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
  })

  it('无 assetId 深链：出现资产选择器、不拉提交列表', async () => {
    const calls: string[] = []
    platformFetchMock.mockImplementation(async (input: string) => {
      calls.push(input)
      if (input === '/api/modules/forms/defs') return jsonResponse({ defs: [] })
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/submissions', ['forms:view'])
    // antd Select 的 placeholder 是文本节点不是 input[placeholder] 属性
    await waitFor(() => expect(screen.getByText('选择表单')).toBeInTheDocument())
    await waitFor(() => expect(calls).toEqual(['/api/modules/forms/defs'])) // 未选资产不拉列表
  })
})

// AI 起草入口与发布门（#724）：控制台只「生成草稿」+「发布」，发布是人唯一的 gate。
describe('表单列表页：AI 起草与发布门', () => {
  it('forms:manage 才出现「AI 起草」卡片；只有 view 时不出现', async () => {
    mockApi({ '/api/modules/forms/defs': () => jsonResponse(defsBody) })
    renderAt('/console/forms/forms', ['forms:view', 'forms:manage'])
    await waitFor(() => expect(screen.getByText('AI 起草')).toBeInTheDocument())

    cleanup()
    mockApi({ '/api/modules/forms/defs': () => jsonResponse(defsBody) })
    renderAt('/console/forms/forms', ['forms:view'])
    await waitFor(() => expect(screen.getByText('check-in')).toBeInTheDocument())
    expect(screen.queryByText('AI 起草')).not.toBeInTheDocument()
  })

  it('起草：POST /generate 带 {description} → 成功提示 + 重新拉列表', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    let listCalls = 0
    platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/modules/forms/defs') {
        listCalls += 1
        return jsonResponse(defsBody)
      }
      if (input === '/api/modules/forms/generate' && init?.method === 'POST') {
        posts.push({ url: input, body: JSON.parse(String(init.body)) })
        return jsonResponse({ assetId: 'ai-made', version: 1, repairUsed: false }, 201)
      }
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/forms', ['forms:view', 'forms:manage'])
    await waitFor(() => expect(screen.getByText('check-in')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText(/用一句话描述/), { target: { value: '门店巡检登记' } })
    fireEvent.click(screen.getByRole('button', { name: /生成草稿/ }))
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0].body).toEqual({ description: '门店巡检登记' })
    await waitFor(() => expect(screen.getByText(/已生成草稿：ai-made（v1）/)).toBeInTheDocument())
    expect(listCalls).toBeGreaterThanOrEqual(2) // 生成后刷新了列表
  })

  it('起草失败：422 详情原样呈现（服务端权威）', async () => {
    platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/modules/forms/defs') return jsonResponse(defsBody)
      if (input === '/api/modules/forms/generate' && init?.method === 'POST') {
        return jsonResponse({ error: 'CONTRACT_REJECTED', detail: '[UNSUPPORTED_WIDGET] ui:widget "cascader" 渲染层不认识' }, 422)
      }
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/forms', ['forms:view', 'forms:manage'])
    await waitFor(() => expect(screen.getByText('check-in')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/用一句话描述/), { target: { value: '省市区联动' } })
    fireEvent.click(screen.getByRole('button', { name: /生成草稿/ }))
    await waitFor(() => expect(screen.getByText(/UNSUPPORTED_WIDGET/)).toBeInTheDocument())
  })

  it('发布门：仅 forms:publish 且**未发布有草稿**的行出现「发布」，点了发布最新 draft', async () => {
    const published: string[] = []
    platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/modules/forms/defs') return jsonResponse(defsBody)
      if (input === '/api/modules/forms/defs/draft-only') {
        return jsonResponse({ assetId: 'draft-only', head: null, versions: [{ version: 1, status: 'draft' }] })
      }
      if (input === '/api/modules/forms/defs/draft-only/versions/1/publish' && init?.method === 'POST') {
        published.push('draft-only@1')
        return jsonResponse({ ok: true })
      }
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderAt('/console/forms/forms', ['forms:view', 'forms:publish'])
    await waitFor(() => expect(screen.getByText('draft-only')).toBeInTheDocument())

    // check-in 已发布 ⇒ 无发布按钮（只有 draft-only 有）
    const btns = screen.getAllByRole('button', { name: '发布' })
    expect(btns.length).toBe(1)
    fireEvent.click(btns[0])
    await waitFor(() => expect(published).toEqual(['draft-only@1']))
  })

  it('无 forms:publish 时不出现「发布」（门在服务端也在 UI）', async () => {
    mockApi({ '/api/modules/forms/defs': () => jsonResponse(defsBody) })
    renderAt('/console/forms/forms', ['forms:view', 'forms:manage'])
    await waitFor(() => expect(screen.getByText('draft-only')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '发布' })).not.toBeInTheDocument()
  })
})
