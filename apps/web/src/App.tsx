import { lazy, Suspense, useMemo } from 'react'
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import ConsoleShell, { AdminGate, ConsoleModulePage, ConsoleOverview, StorageGate } from './pages/Console'
import LoginPage from './pages/Login'
import AdminUsersPage from './pages/admin/Users'
import AdminOrgTreePage from './pages/admin/OrgTree'
import AdminRolesPage from './pages/admin/Roles'
import AdminPermissionsPage from './pages/admin/Permissions'
import AdminSubscriptionsPage from './pages/admin/Subscriptions'
import AdminStoragePage from './pages/admin/Storage'
import AdminKeysPage from './pages/admin/Keys'
import AdminIntegrationsPage from './pages/admin/Integrations'
import MyKeysPage from './pages/me/Keys'
import MobileHome from './pages/MobileHome'

/**
 * 报表独立页（计划 2026-10-26 Task 13）：`/r/:id` 顶层裸路由，**在 `/console` 壳之外**——
 * 无 ProLayout / 导航 / 菜单 / 关闭按钮，登录态只读渲染已发布版本（session-only，无 token/公开通道）。
 * 懒加载：独立页只带它自己的渲染分包，不为 console 用户增重（echarts 在模块分包里）。
 */
const StandaloneReport = lazy(() => import('../../../modules/data/console/standalone'))

/**
 * 路由表（Task 17 骨架 / Task 18 console 壳 / #36 SaaS 化 / #38 根路径修订 / #46 M3 管理组）：
 * 唯一前端应用。`/` 与顶层未知路径一律重定向 /console（工作台本体；未登录由 platformFetch
 * 401 带 next 跳登录）。唯一例外是 `/r/:id`（报表独立页，Task 13）：裸路由、无 console 壳。/console 为管理台壳（ProLayout），模块页由 console-registry 聚合
 * 懒加载，壳内 404 自带；/console/admin/* 为管理区——平台内置页（不走 registry）与模块
 * admin 页（走 registry 聚合）一律 AdminGate 组门（#127，模块 admin 页同待遇）。
 */
export function createAppRouter() {
  return createBrowserRouter([
    { path: '/login', element: <LoginPage /> },
    { path: '/', element: <Navigate to="/console" replace /> },
    // 报表独立页：顶层裸路由，**必须在 `*` 兜底之前**（否则会被重定向 /console）。
    // 未登录时 platformFetch 401 会带 search 跳 /login?next=/r/:id?v=N，登录后原样回跳。
    { path: '/r/:id', element: <Suspense fallback={null}><StandaloneReport /></Suspense> },
    // 移动端业务入口页（spec 2026-11-01 §5.1）：IM 工作台应用的主页就填
    // `/api/platform/auth/wecom/silent?next=/m`。裸路由、无 console 壳（手机上不需要侧边栏）。
    { path: '/m', element: <MobileHome /> },
    {
      path: '/console',
      element: <ConsoleShell />,
      children: [
        { index: true, element: <ConsoleOverview /> },
        // 静态路由按特异性胜出通配（react-router v6 排序规则：admin/users > admin/* > *），
        // 平台内置管理页不会被模块通配吃掉
        { path: 'admin/users', element: <AdminGate><AdminUsersPage /></AdminGate> },
        { path: 'admin/integrations', element: <AdminGate><AdminIntegrationsPage /></AdminGate> },
        // 组织架构/角色管理（账户和权限体系 Task 11）：AdminGate 组门与平台内置四项同待遇
        { path: 'admin/org-tree', element: <AdminGate><AdminOrgTreePage /></AdminGate> },
        { path: 'admin/roles', element: <AdminGate><AdminRolesPage /></AdminGate> },
        { path: 'admin/permissions', element: <AdminGate><AdminPermissionsPage /></AdminGate> },
        { path: 'admin/subscriptions', element: <AdminGate><AdminSubscriptionsPage /></AdminGate> },
        { path: 'admin/storage', element: <AdminGate><StorageGate><AdminStoragePage /></StorageGate></AdminGate> },
        { path: 'admin/keys', element: <AdminGate><AdminKeysPage /></AdminGate> },
        // 个人 Key（issue #894）：**不套 AdminGate**——发 token 不提权（它只承载本账号自己的
        // scopes），故任何已登录账号都该能管自己的。这是本壳**第一个免 scope 的自有页**。
        { path: 'me/keys', element: <MyKeysPage /> },
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
