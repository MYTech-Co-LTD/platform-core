import { useMemo } from 'react'
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import ConsoleShell, { AdminGate, ConsoleModulePage, ConsoleOverview, StorageGate } from './pages/Console'
import LoginPage from './pages/Login'
import AdminUsersPage from './pages/admin/Users'
import AdminPermissionsPage from './pages/admin/Permissions'
import AdminSubscriptionsPage from './pages/admin/Subscriptions'
import AdminStoragePage from './pages/admin/Storage'

/**
 * 路由表（Task 17 骨架 / Task 18 console 壳 / #36 SaaS 化 / #38 根路径修订 / #46 M3 管理组）：
 * 唯一前端应用。`/` 与顶层未知路径一律重定向 /console（工作台本体；未登录由 platformFetch
 * 401 带 next 跳登录）。/console 为管理台壳（ProLayout），模块页由 console-registry 聚合
 * 懒加载，壳内 404 自带；/console/admin/* 为管理区——平台内置页（不走 registry）与模块
 * admin 页（走 registry 聚合）一律 AdminGate 组门（#127，模块 admin 页同待遇）。
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
        // 静态路由按特异性胜出通配（react-router v6 排序规则：admin/users > admin/* > *），
        // 平台内置管理页不会被模块通配吃掉
        { path: 'admin/users', element: <AdminGate><AdminUsersPage /></AdminGate> },
        { path: 'admin/permissions', element: <AdminGate><AdminPermissionsPage /></AdminGate> },
        { path: 'admin/subscriptions', element: <AdminGate><AdminSubscriptionsPage /></AdminGate> },
        { path: 'admin/storage', element: <AdminGate><StorageGate><AdminStoragePage /></StorageGate></AdminGate> },
        // 模块 admin 页（registry 聚合，路径 /console/admin/<module>/<page>）：#127 起先过
        // AdminGate 组门再进 ConsoleModulePage（config 门 + 页门），与平台内置四项同待遇
        { path: 'admin/*', element: <AdminGate><ConsoleModulePage /></AdminGate> },
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
