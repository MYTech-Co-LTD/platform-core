// ReportsView — 报表中心(看)/报表管理(管自己的)双 tab（#1369/#1371/#1373）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReportsView, { type ReportRow } from './ReportsView'

afterEach(cleanup)

const ROWS: ReportRow[] = [
  { id: 'r1', title: '门店销售日报', renderer: 'platform', publishedVersion: 3, hasUnpublishedChanges: false, owner: 'admin1', canEdit: true, version: 5, metricIds: ['lemeng:retail:net_sales'] },
  // 自己的未发布草稿：中心不显示；管理 tab 显示并可预览
  { id: 'r2', title: '会员复购分析', renderer: 'platform', publishedVersion: null, hasUnpublishedChanges: false, owner: 'admin1', canEdit: true, version: 2 },
  // 别人的已发布：中心显示；管理 tab 不显示（管别人的属配置面，在 PC）
  { id: 'r3', title: '库存周转看板', renderer: 'platform', publishedVersion: 2, hasUnpublishedChanges: true, owner: 'viewer1', ownerActive: false, canEdit: false, version: 4 },
  { id: 'r4', title: '售后处理时效', renderer: 'metabase', publishedVersion: null, owner: null, canEdit: false },
]

const renderView = (tab: 'center' | 'manage', self = 'admin1') =>
  render(<ReportsView rows={ROWS} reload={async () => {}} tab={tab} self={self} />)

describe('报表中心 / 报表管理（#1373 拆分）', () => {
  it('中心：只列已发布（自己的+别人的），标 已发布/有更新/所有者；未发布草稿不出现', async () => {
    renderView('center')
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    expect(screen.getByText('库存周转看板')).toBeTruthy()
    expect(screen.getByText('售后处理时效')).toBeTruthy()
    expect(screen.queryByText('会员复购分析')).toBeNull()
    expect(screen.getByText('已发布')).toBeTruthy()
    expect(screen.getByText('有更新')).toBeTruthy()
    expect(screen.getByText(/所有者 viewer1/)).toBeTruthy()
  })

  it('中心：点整卡在 App 内打开（iframe /r/:id）', async () => {
    renderView('center')
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    fireEvent.click(screen.getByText('门店销售日报'))
    const frame = await screen.findByTitle('门店销售日报')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/r/r1')
  })

  it('管理：只列**我创建的**（含未发布草稿）；别人的不出现；点卡弹管理面板（#1373）', async () => {
    renderView('manage')
    await waitFor(() => expect(screen.getByText('会员复购分析')).toBeTruthy())
    expect(screen.getByText('门店销售日报')).toBeTruthy()          // 自己的已发布
    expect(screen.queryByText('库存周转看板')).toBeNull()          // 别人的 ⇒ 不在管理列表
    expect(screen.getByText('未发布草稿')).toBeTruthy()

    // 点卡 = 管理面板：打开/预览 + 发布（未发布草稿没有「下线」）
    // 卡标题与面板标题同文 ⇒ 用 getAllByText 取卡片（面板未开前只有一个）
    fireEvent.click(screen.getAllByText('会员复购分析')[0]!)
    await waitFor(() => expect(screen.getAllByText('预览报表').length).toBeGreaterThan(0))
    expect(screen.getByText('发布')).toBeTruthy()
    expect(screen.queryByText('下线')).toBeNull()
  })

  it('管理面板「预览报表」⇒ 阅读层打开 /r/:id?preview=1（#1367）', async () => {
    renderView('manage')
    await waitFor(() => expect(screen.getByText('会员复购分析')).toBeTruthy())
    fireEvent.click(screen.getByText('会员复购分析'))
    fireEvent.click(await screen.findByText('预览报表'))
    const frame = await screen.findByTitle('会员复购分析')
    expect(frame.getAttribute('src')).toBe('/r/r2?preview=1')
  })

  it('W5 定案 A：报表卡「口径与来源」深链 + 页头「体系地图」次级入口；无指标 id 不渲染链接', async () => {
    renderView('center')
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())

    // 页头次级入口（不占底部 tab）
    const mapEntry = screen.getByText('体系地图')
    expect(mapEntry.getAttribute('href')).toBe('/api/modules/data/system-map#/overview')

    // 有 metricIds 的报表卡 → 指标详情深链（冒号编码，页面侧解码）
    const links = screen.getAllByText('口径与来源')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href'))
      .toBe('/api/modules/data/system-map#/metrics/lemeng%3Aretail%3Anet_sales')
    // 同 tab 打开（不 target=_blank）：返回时 history.back() 才回得到原报表
    expect(links[0]!.getAttribute('target')).toBeNull()

    // 没有 metricIds 的报表（r3/r4）不加链接
    expect(screen.queryByText(/口径与来源 · /)).toBeNull()
  })

  it('搜索过滤 + 无匹配空态', async () => {
    renderView('center')
    await waitFor(() => expect(screen.getByText('门店销售日报')).toBeTruthy())
    const input = screen.getByPlaceholderText('搜索报表名称')

    // 中心 tab 只有已发布 ⇒ 搜「会员」（未发布草稿）无命中
    fireEvent.change(input, { target: { value: '会员' } })
    expect(screen.queryByText('会员复购分析')).toBeNull()

    fireEvent.change(input, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的报表，试试清空搜索。')).toBeTruthy()
  })
})
