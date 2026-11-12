// console/index.tsx — 数据模块 console 入口（问数 / 指标 / 报表 / 数据范围）。
//
// #1953 二期：PC 的页内 tabs 已撤，四个页面改为宿主左侧菜单的子项（manifest 声明 4 个子路径）。
// 本组件只剩「按 URL 末段选页」+ 移动端段控；不要再把功能页塞回页内 tab。
//
// ⚠️ 三条实测结论（照 modules/aftersales/console/index.tsx，本仓浏览器实测得来，勿「优化」）：
// 1. **不用嵌套 `<Routes>`**：本组件挂在宿主壳的 `{ path: '*', element: <ConsoleModulePage /> }`
//    之下，嵌套 Routes 是相对父路由匹配的 ⇒ 拿到的是 splat 剩余段，`path="query"` 永远匹配不上
//    ⇒ **整块空白且无任何报错**。改为按 pathname 末段直接选页。
// 2. **导航必须用绝对路径**：相对导航会以壳的 splat 为基准解析到 `/console/`，把 `data` 段丢掉。
// 3. 裸条目路径规范化到默认页：让 URL 与页面内容始终一致（否则深链/刷新语义含混）。
import { useEffect } from 'react'
import { Layout, Segmented, Typography } from 'antd'
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import MetricsPage from './metrics'
import ReportsPage from './reports'
import ScopesPage from './scopes'
import CandidatesPage from './candidates'
import ChangesPage from './changes'
import { useIsMobile } from './lib/useIsMobile'

/** 本模块在宿主壳的挂载基路径（manifest frontend.console 首条 path）。 */
const BASE = '/console/data'

const TABS = [
  { key: 'metrics', label: '指标' },
  { key: 'reports', label: '报表' },
  // data:manage 才出现（#1901 scope 管理面）：菜单过滤只是入口姿态，API 门卫才是真闸
  { key: 'scopes', label: '数据范围', manageOnly: true },
  // 候选池（Wave 2.3，spec §3「console 可浏览、一键采用」）：同样是管理面。
  // 标签用业务说法「可能的指标」——页面默认层不出现「候选池/置信度/聚合」这类工程词。
  { key: 'candidates', label: '可能的指标', manageOnly: true },
  // 待核对（Wave 5 P0）：agent 提案单的评审面——人只做采纳/驳回（决策端点只认会话）。
  { key: 'changes', label: '待核对', manageOnly: true },
] as const

type TabKey = (typeof TABS)[number]['key']
const DEFAULT_TAB: TabKey = 'metrics'

/**
 * 体系地图是独立追溯页（服务端渲染单文件 HTML，hash 路由），不是本 console 的路由页——
 * 写成路由会让 `navigate` 指到一个不存在的 console 路径（白屏），故保留为页内外链（W5 定案 A）。
 */

/** 末段是不是页签段（决定当前 URL 是「页签」还是「裸条目路径」）；manageOnly 页签对无码者不可达 */
function isTabSegment(seg: string, canManage: boolean): seg is TabKey {
  const hit = TABS.find((t) => t.key === seg)
  if (hit === undefined) return false
  return !('manageOnly' in hit && hit.manageOnly === true) || canManage
}

export default function DataConsolePage() {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // 入口过滤用（reports 页同款；API 门卫才是真闸）
  const { session } = useOutletContext<{ session: { scopes: string[] } }>()
  const canManage = session.scopes.includes('data:manage')
  const visibleTabs = TABS.filter((t) => !('manageOnly' in t && t.manageOnly === true) || canManage)
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  const active: TabKey = isTabSegment(last, canManage) ? last : DEFAULT_TAB
  // 裸 /console/data 与不可达末段（如无 data:manage 却深链 /scopes）都规范回默认页：
  // 让 URL 与「页面上显示的内容」始终一致。基路径是常量——模块可能被挂在更深的子路径下，
  // 用 pathname 反推会把 `/console/data/scopes` 当成基路径、拼出 `/scopes/query`（实测）。
  useEffect(() => {
    if (!isTabSegment(last, canManage)) navigate(`${BASE}/${DEFAULT_TAB}`, { replace: true })
  }, [last, navigate, canManage])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    metrics: MetricsPage, reports: ReportsPage, scopes: ScopesPage,
    candidates: CandidatesPage,
    changes: ChangesPage,
  }
  const Active = PAGES[active]

  return (
    <Layout style={{ background: 'transparent' }}>
      {/* PC 的页内 tabs 已撤（#1953 二期）：页签全部变成左侧菜单子项。
          移动端左侧菜单收进抽屉，留段控做「一屏内换页」。 */}
      {isMobile ? (
        <Segmented
          block
          value={active}
          onChange={(v) => navigate(`${BASE}/${String(v)}`)}
          options={visibleTabs.map((t) => ({ label: t.label, value: t.key }))}
          style={{ marginBottom: 12 }}
        />
      ) : (
        // 体系地图是独立追溯页（服务端渲染单文件 HTML，hash 路由），不是本 console 的路由页——
        // 保留为外链（W5 定案 A），不塞回菜单
        <div style={{ textAlign: 'right', marginBottom: 4 }}>
          <Typography.Link
            href="/api/modules/data/system-map#/overview"
            target="_blank"
            rel="noopener"
          >
            体系地图 ↗
          </Typography.Link>
        </div>
      )}
      <Active />
    </Layout>
  )
}
