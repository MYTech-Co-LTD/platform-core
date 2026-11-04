// ReportsView — 移动端报表页：列表/状态/搜索/未发布提示（不做配置动作）。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportsView, { type ReportRow } from './ReportsView'

const origFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = origFetch })

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ROWS: ReportRow[] = [
  { id: 'r1', title: '门店销售日报', renderer: 'platform', publishedVersion: 3, hasUnpublishedChanges: false, owner: 'admin1', canEdit: false },
  { id: 'r2', title: '会员复购分析', renderer: 'platform', publishedVersion: null, hasUnpublishedChanges: false, owner: 'viewer1', canEdit: true },
  { id: 'r3', title: '库存周转看板', renderer: 'platform', publishedVersion: 2, hasUnpublishedChanges: true, owner: 'admin1', ownerActive: false, canEdit: true },
  { id: 'r4', title: '售后处理时效', renderer: 'metabase', publishedVersion: null, hasUnpublishedChanges: false, owner: null, canEdit: false },
]

beforeEach(() => {
  globalThis.fetch = (async () => json({ reports: ROWS })) as unknown as typeof fetch
})

describe('移动端报表页', () => {
  it('列出报表并标状态：已发布 / 未发布 / 有更新 / 所有者已停用', async () => {
    render(<ReportsView rows={ROWS} reload={async () => {}} tab="center" />)
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    // 中心 tab 只显示**已发布**：metabase 行与已发布的 platform 行；未发布草稿不出现
    expect(screen.getByText('库存周转看板')).toBeTruthy()
    expect(screen.getByText('售后处理时效')).toBeTruthy()
    expect(screen.queryByText('会员复购分析')).toBeNull()
    expect(screen.getByText('已发布')).toBeTruthy()
    expect(screen.getByText('有更新')).toBeTruthy()
    expect(screen.getByText(/所有者 admin1（已停用）/)).toBeTruthy()
  })

  it('点整卡在 App 内打开（iframe /r/:id）；未发布只提示、不跳转', async () => {
    render(<ReportsView rows={ROWS} reload={async () => {}} tab="center" />)
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    fireEvent.click(screen.getByText('门店销售日报'))
    const frame = await screen.findByTitle('门店销售日报')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/r/r1')

    // 管理manage tab：点自己的未发布草稿 ⇒ 预览模式（#1367），阅读层 src 带 preview=1
    render(<ReportsView rows={ROWS} reload={async () => {}} tab="manage" />)
    await waitFor(() => expect(screen.getByText('会员复购分析')).toBeTruthy())
    fireEvent.click(screen.getByText('会员复购分析'))
    const preview = await screen.findByTitle('会员复购分析')
    expect(preview.getAttribute('src')).toBe('/r/r2?preview=1')
  })

  it('搜索过滤 + 无匹配空态', async () => {
    render(<ReportsView rows={ROWS} reload={async () => {}} tab="center" />)
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    const input = screen.getByPlaceholderText('搜索报表名称')

    // 中心 tab 只有已发布报表 ⇒ 搜「会员」（未发布草稿）无命中
    fireEvent.change(input, { target: { value: '会员' } })
    expect(screen.queryByText('会员复购分析')).toBeNull()

    fireEvent.change(input, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的报表，试试清空搜索。')).toBeTruthy()
  })

  it('管理 tab：只列 canEdit 的报表（自己的），并给「报表管理」标题', async () => {
    render(<ReportsView rows={ROWS} reload={async () => {}} tab="manage" />)
    await waitFor(() => expect(screen.getByText('报表管理')).toBeTruthy())
    expect(screen.getByText('会员复购分析')).toBeTruthy()     // 自己的未发布草稿
    expect(screen.queryByText('门店销售日报')).toBeNull()      // 别人的（canEdit=false）
    expect(screen.queryByText('售后处理时效')).toBeNull()      // metabase 行（无 canEdit）
  })
})
