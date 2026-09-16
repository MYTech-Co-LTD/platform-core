// console/index.tsx — 售后管理端入口（M3a）。
//
// **一个 console 条目 + 模块内 tabs**（spec §3.1）：manifest 的前端条目在 console 菜单里是
// 平铺的（`apps/web/src/pages/console-menu.ts` 只给平台「管理」组做了 children），而
// `frontend.console` 是扁平数组、协议不支持嵌套。⇒ 声明一个条目，页内用**真子路由**分区，
// 这样每个页签仍可深链、浏览器后退可用。
//
// 纪律（Global Constraints）：HTTP 只走 platformFetch、权限只读 Outlet 注入的 scopes、
// 零反向依赖 apps/web。
import { Layout, Menu } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
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

export default function AftersalesConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // 末段即当前页签；裸路径时回落工单（下面 index 路由也会重定向过去）
  const active = TABS.find((t) => pathname.endsWith(`/${t.key}`))?.key ?? 'tickets'

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(key)}
        style={{ marginBottom: 16 }}
      />
      <Routes>
        <Route index element={<Navigate to="tickets" replace />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="stores" element={<StoresPage />} />
      </Routes>
    </Layout>
  )
}
