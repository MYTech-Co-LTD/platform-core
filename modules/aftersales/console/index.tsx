// console/index.tsx — 售后管理端入口（M3a）。
//
// **manifest 多个子路径 + 本组件按 URL 选页**（#1953 二期，原「一个条目 + 模块内 tabs」已撤）：
// 子路径 = 父 path + `/`（如 `/console/aftersales/tickets`），宿主按路径前缀把父条目渲染成
// 左侧二级菜单的分组标题（协议见 docs/module-protocol.md「二级菜单用路径前缀表达」）。
//
// ⚠️ **不用嵌套 `<Routes>`**（浏览器实测推翻了初版做法）：本组件挂在宿主壳的路由
// `{ path: '*', element: <ConsoleModulePage /> }`（`apps/web/src/App.tsx:28`，挂在 `/console` 下）
// 之下，**嵌套 `<Routes>` 是相对父路由匹配的** ⇒ 它拿到的是 splat 剩余段（`aftersales/tickets`），
// `path="tickets"` 永远匹配不上 ⇒ **整块空白**（路由换了、页面不出来，且没有任何报错）。
// ⇒ 改为**按 pathname 的末段直接选页**：URL 仍是唯一驱动（深链照常），但不依赖嵌套匹配语义。
//
// 另：**导航必须用绝对路径**。相对导航（`navigate(key)`）会以壳的 splat 路由为基准解析到
// `/console/`，把 `aftersales` 段丢掉 ⇒ 点菜单项跳到 `/console/rules`。同样由浏览器实测抓到。
import { useEffect } from 'react'
import { Layout } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import TicketsPage from './tickets'
import RulesPage from './rules'
import EmployeesPage from './employees'
import ProductsPage from './products'
import StoresPage from './stores'
import ApprovalsPage from './approvals'
import LinksPage from './links'

const TABS = [
  { key: 'tickets', label: '工单' },
  { key: 'rules', label: '规则' },
  { key: 'employees', label: '员工' },
  { key: 'products', label: '商品' },
  { key: 'stores', label: '门店' },
  { key: 'approvals', label: '申请审批' },
  { key: 'links', label: '身份绑定' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)
const DEFAULT_TAB: TabKey = 'tickets'

/** 末段是不是可识别的子页段（决定当前 URL 是「子页」还是「裸条目路径」） */
function isTabSegment(seg: string): seg is TabKey {
  return TAB_KEYS.includes(seg)
}

export default function AftersalesConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  const active: TabKey = isTabSegment(last) ? last : DEFAULT_TAB

  // 裸 `/console/aftersales` 规范化到工单页：让 URL 与「页面上显示的内容」始终一致
  // （否则同一个 URL 对应的页面取决于内部默认值，深链/刷新语义含混）
  useEffect(() => {
    if (!isTabSegment(last)) navigate(`${pathname}/${DEFAULT_TAB}`, { replace: true })
  }, [last, pathname, navigate])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    tickets: TicketsPage,
    rules: RulesPage,
    employees: EmployeesPage,
    products: ProductsPage,
    stores: StoresPage,
    approvals: ApprovalsPage,
    links: LinksPage,
  }
  const Active = PAGES[active]

  // #1953 二期：页内 tabs 已撤，各页改为宿主左侧菜单子项（manifest 声明 7 个子路径）。
  return (
    <Layout style={{ background: 'transparent' }}>
      <Active />
    </Layout>
  )
}
