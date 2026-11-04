// ReportsView — 移动端报表页：列表/状态/搜索/未发布提示（不做配置动作）。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportsView from './ReportsView'

const origFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = origFetch })

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ROWS = [
  { id: 'r1', title: '门店销售日报', renderer: 'platform', publishedVersion: 3, hasUnpublishedChanges: false, owner: 'admin1' },
  { id: 'r2', title: '会员复购分析', renderer: 'platform', publishedVersion: null, hasUnpublishedChanges: false, owner: 'viewer1' },
  { id: 'r3', title: '库存周转看板', renderer: 'platform', publishedVersion: 2, hasUnpublishedChanges: true, owner: 'admin1', ownerActive: false },
]

beforeEach(() => {
  globalThis.fetch = (async () => json({ reports: ROWS })) as unknown as typeof fetch
})

describe('移动端报表页', () => {
  it('列出报表并标状态：已发布 / 未发布 / 有更新 / 所有者已停用', async () => {
    render(<ReportsView />)
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    expect(screen.getByText('已发布')).toBeTruthy()
    expect(screen.getByText('未发布')).toBeTruthy()
    expect(screen.getByText('有更新')).toBeTruthy()
    expect(screen.getByText(/所有者 admin1（已停用）/)).toBeTruthy()
  })

  it('搜索过滤 + 无匹配空态', async () => {
    render(<ReportsView />)
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    const input = screen.getByPlaceholderText('搜索报表名称')

    fireEvent.change(input, { target: { value: '会员' } })
    expect(screen.getByText('会员复购分析')).toBeTruthy()
    expect(screen.queryByText('门店销售日报')).toBeNull()

    fireEvent.change(input, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的报表，试试清空搜索。')).toBeTruthy()
  })
})
