// console/index.tsx — 售后管理端入口（M3a）。
//
// **一个 console 条目 + 模块内 tabs**（spec §3.1）：manifest 的前端条目在 console 菜单里是
// 平铺的（`apps/web/src/pages/console-menu.ts` 只给平台「管理」组做了 children），而
// `frontend.console` 是扁平数组、协议不支持嵌套 ⇒ 声明一个条目，页内分区，URL 可深链。
//
// ⚠️ **不用嵌套 `<Routes>`**（浏览器实测推翻了初版做法）：本组件挂在宿主壳的路由
// `{ path: '*', element: <ConsoleModulePage /> }`（`apps/web/src/App.tsx:28`，挂在 `/console` 下）
// 之下，**嵌套 `<Routes>` 是相对父路由匹配的** ⇒ 它拿到的是 splat 剩余段（`aftersales/tickets`），
// `path="tickets"` 永远匹配不上 ⇒ **整块空白**（路由换了、页面不出来，且没有任何报错）。
// ⇒ 改为**按 pathname 的末段直接选页**：URL 仍是唯一驱动（深链照常），但不依赖嵌套匹配语义。
//
// 另：**导航必须用绝对路径**。相对导航（`navigate(key)`）会以壳的 splat 路由为基准解析到
// `/console/`，把 `aftersales` 段丢掉 ⇒ 点页签跳到 `/console/rules`。同样由浏览器实测抓到。
import { useEffect } from 'react'
import { Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import TicketsPage from './tickets'
import RulesPage from './rules'
import EmployeesPage from './employees'
import ProductsPage from './products'
import StoresPage from './stores'

const TABS = [
  { key: 'tickets', label: '工单' },
  { key: 'rules', label: '规则' },
  { key: 'employees', label: '员工' },
  { key: 'products', label: '商品' },
  { key: 'stores', label: '门店' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)
const DEFAULT_TAB: TabKey = 'tickets'

/** 末段是不是页签段（决定当前 URL 是「页签」还是「裸条目路径」） */
function isTabSegment(seg: string): seg is TabKey {
  return TAB_KEYS.includes(seg)
}

export default function AftersalesConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  const active: TabKey = isTabSegment(last) ? last : DEFAULT_TAB
  // 末段是页签 ⇒ 基路径 = 去掉末段；否则当前 pathname 就是基路径（裸条目路径）
  const basePath = isTabSegment(last) ? pathname.slice(0, pathname.lastIndexOf('/')) : pathname

  // 裸 `/console/aftersales` 规范化到工单页：让 URL 与「页面上显示的内容」始终一致
  // （否则同一个 URL 对应的页签取决于内部默认值，深链/刷新语义含混）
  useEffect(() => {
    if (!isTabSegment(last)) navigate(`${pathname}/${DEFAULT_TAB}`, { replace: true })
  }, [last, pathname, navigate])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    tickets: TicketsPage,
    rules: RulesPage,
    employees: EmployeesPage,
    products: ProductsPage,
    stores: StoresPage,
  }
  const Active = PAGES[active]

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(`${basePath}/${key}`)}
        style={{ marginBottom: 16 }}
      />
      <Active />
    </Layout>
  )
}
