import { useMemo } from 'react'
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import ConsoleShell, { AdminGate, ConsoleModulePage, ConsoleOverview } from './pages/Console'
import LoginPage from './pages/Login'
import AdminUsersPage from './pages/admin/Users'
import AdminPermissionsPage from './pages/admin/Permissions'
import AdminSubscriptionsPage from './pages/admin/Subscriptions'

/**
 * 路由表（Task 17 骨架 / Task 18 console 壳 / #36 SaaS 化 / #38 根路径修订 / #46 M3 管理组）：
 * 唯一前端应用。`/` 与顶层未知路径一律重定向 /console（工作台本体；未登录由 platformFetch
 * 401 带 next 跳登录）。/console 为管理台壳（ProLayout），模块页由 console-registry 聚合
 * 懒加载，壳内 404 自带；/console/admin/* 为平台内置管理页（不走 registry，AdminGate 门禁）。
 */
export function createAppRouter() {
  return createBrowserRouter([
    { path: '/login', element: <LoginPage /> },
    { path: '/', element: <Navigate to="/console" replace /> },
    {
      path: '/console',
      element: <ConsoleShell />,
      children: [
        { index: true, element: <ConsoleOverview /> },
        // 静态路由按特异性胜出 '*' 通配（react-router v6 排序规则），管理页不会被模块通配吃掉
        { path: 'admin/users', element: <AdminGate><AdminUsersPage /></AdminGate> },
        { path: 'admin/permissions', element: <AdminGate><AdminPermissionsPage /></AdminGate> },
        { path: 'admin/subscriptions', element: <AdminGate><AdminSubscriptionsPage /></AdminGate> },
        { path: '*', element: <ConsoleModulePage /> },
      ],
    },
    { path: '*', element: <Navigate to="/console" replace /> },
  ])
}

// router 按挂载创建（useMemo）：生产单挂载无差别；测试里每次 render 从当前 location 起步，
// 避免跨用例共享同一个 router 实例的内部状态。
export default function App() {
  const router = useMemo(() => createAppRouter(), [])
  return <RouterProvider router={router} />
}
