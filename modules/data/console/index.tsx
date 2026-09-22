// console/index.tsx — 数据模块 console 入口：四页签（问数 / 指标 / 我的 Key / 报表）。
//
// ⚠️ 三条实测结论（照 modules/aftersales/console/index.tsx，本仓浏览器实测得来，勿「优化」）：
// 1. **不用嵌套 `<Routes>`**：本组件挂在宿主壳的 `{ path: '*', element: <ConsoleModulePage /> }`
//    之下，嵌套 Routes 是相对父路由匹配的 ⇒ 拿到的是 splat 剩余段，`path="query"` 永远匹配不上
//    ⇒ **整块空白且无任何报错**。改为按 pathname 末段直接选页。
// 2. **导航必须用绝对路径**：相对导航会以壳的 splat 为基准解析到 `/console/`，把 `data` 段丢掉。
// 3. 裸条目路径规范化到默认页签：让 URL 与页面内容始终一致（否则深链/刷新语义含混）。
import { useEffect } from 'react'
import { Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import QueryPage from './query'
import MetricsPage from './metrics'
import KeysPage from './keys'
import ReportsPage from './reports'

const TABS = [
  { key: 'query', label: '问数' },
  { key: 'metrics', label: '指标' },
  { key: 'keys', label: '我的 Key' },
  { key: 'reports', label: '报表' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)
const DEFAULT_TAB: TabKey = 'query'

/** 末段是不是页签段（决定当前 URL 是「页签」还是「裸条目路径」） */
function isTabSegment(seg: string): seg is TabKey {
  return TAB_KEYS.includes(seg)
}

export default function DataConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  const active: TabKey = isTabSegment(last) ? last : DEFAULT_TAB
  // 末段是页签 ⇒ 基路径 = 去掉末段；否则当前 pathname 就是基路径（裸条目路径）
  const basePath = isTabSegment(last) ? pathname.slice(0, pathname.lastIndexOf('/')) : pathname

  // 裸 /console/data 规范化到问数页：让 URL 与「页面上显示的内容」始终一致
  useEffect(() => {
    if (!isTabSegment(last)) navigate(`${pathname}/${DEFAULT_TAB}`, { replace: true })
  }, [last, pathname, navigate])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    query: QueryPage, metrics: MetricsPage, keys: KeysPage, reports: ReportsPage,
  }
  const Active = PAGES[active]

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu mode="horizontal" selectedKeys={[active]}
            items={TABS.map((t) => ({ key: t.key, label: t.label }))}
            onClick={({ key }) => navigate(`${basePath}/${key}`)}
            style={{ marginBottom: 16 }} />
      <Active />
    </Layout>
  )
}
