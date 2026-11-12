// console/index.tsx — 数据模块 console 入口：四页签（问数 / 指标 / 我的 Key / 报表）。
//
// ⚠️ 三条实测结论（照 modules/aftersales/console/index.tsx，本仓浏览器实测得来，勿「优化」）：
// 1. **不用嵌套 `<Routes>`**：本组件挂在宿主壳的 `{ path: '*', element: <ConsoleModulePage /> }`
//    之下，嵌套 Routes 是相对父路由匹配的 ⇒ 拿到的是 splat 剩余段，`path="query"` 永远匹配不上
//    ⇒ **整块空白且无任何报错**。改为按 pathname 末段直接选页。
// 2. **导航必须用绝对路径**：相对导航会以壳的 splat 为基准解析到 `/console/`，把 `data` 段丢掉。
// 3. 裸条目路径规范化到默认页签：让 URL 与页面内容始终一致（否则深链/刷新语义含混）。
import { useEffect } from 'react'
import { Layout, Menu, Segmented } from 'antd'
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import QueryPage from './query'
import MetricsPage from './metrics'
import ReportsPage from './reports'
import ScopesPage from './scopes'
import CandidatesPage from './candidates'
import { useIsMobile } from './lib/useIsMobile'

const TABS = [
  { key: 'query', label: '问数' },
  { key: 'metrics', label: '指标' },
  { key: 'reports', label: '报表' },
  // data:manage 才出现（#1901 scope 管理面）：菜单过滤只是入口姿态，API 门卫才是真闸
  { key: 'scopes', label: '数据范围', manageOnly: true },
  // 候选池（Wave 2.3，spec §3「console 可浏览、一键采用」）：同样是管理面
  { key: 'candidates', label: '候选池', manageOnly: true },
] as const

type TabKey = (typeof TABS)[number]['key']
const DEFAULT_TAB: TabKey = 'query'

/**
 * PC 菜单项：可见页签 + 一个**外链**（W5 Task 4 定案 A）。
 * 体系地图是独立追溯页（服务端渲染单文件 HTML，hash 路由），不是本 console 的路由页签——
 * 写成页签会让 `navigate(basePath/key)` 指到一个不存在的 console 路由（白屏）。
 * 菜单项在组件内按 session.scopes 现算（manageOnly 页签过滤），不再提成模块级常量。
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
  // 末段是页签 ⇒ 基路径 = 去掉末段；否则当前 pathname 就是基路径（裸条目路径）
  const basePath = isTabSegment(last, canManage) ? pathname.slice(0, pathname.lastIndexOf('/')) : pathname

  // 裸 /console/data 规范化到问数页：让 URL 与「页面上显示的内容」始终一致
  useEffect(() => {
    if (!isTabSegment(last, canManage)) navigate(`${pathname}/${DEFAULT_TAB}`, { replace: true })
  }, [last, pathname, navigate, canManage])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    query: QueryPage, metrics: MetricsPage, reports: ReportsPage, scopes: ScopesPage,
    candidates: CandidatesPage,
  }
  const Active = PAGES[active]

  return (
    <Layout style={{ background: 'transparent' }}>
      {isMobile ? (
        // 移动端：「一屏」优先——段控一行（36px 级），不再用 PC 的横向 Menu
        <Segmented
          block
          value={active}
          onChange={(v) => navigate(`${basePath}/${String(v)}`)}
          options={visibleTabs.map((t) => ({ label: t.label, value: t.key }))}
          style={{ marginBottom: 12 }}
        />
      ) : (
        <Menu mode="horizontal" selectedKeys={[active]}
              items={[
                ...visibleTabs.map((t) => ({ key: t.key, label: t.label })),
                {
                  key: 'system-map',
                  label: (
                    <a href="/api/modules/data/system-map#/overview" target="_blank" rel="noopener">
                      体系地图
                    </a>
                  ),
                },
              ]}
              onClick={({ key }) => { if (isTabSegment(key, canManage)) navigate(`${basePath}/${key}`) }}
              style={{ marginBottom: 16 }} />
      )}
      <Active />
    </Layout>
  )
}
