import { useMemo } from 'react'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import ConsoleShell, { ConsoleModulePage, ConsoleOverview } from './pages/Console'
import LoginPage from './pages/Login'
import ConsolePlaceholder from './pages/Placeholder'

/**
 * 路由表（Task 17 骨架 / Task 18 console 壳）：唯一前端应用（门户 + console 同构建）。
 * / 工作台仍为占位；/console 为管理台壳（ProLayout），模块页由 console-registry 聚合懒加载。
 */
export function createAppRouter() {
  return createBrowserRouter([
    { path: '/login', element: <LoginPage /> },
    { path: '/', element: <ConsolePlaceholder /> },
    {
      path: '/console',
      element: <ConsoleShell />,
      children: [
        { index: true, element: <ConsoleOverview /> },
        { path: '*', element: <ConsoleModulePage /> },
      ],
    },
    { path: '*', element: <ConsolePlaceholder /> },
  ])
}

// router 按挂载创建（useMemo）：生产单挂载无差别；测试里每次 render 从当前 location 起步，
// 避免跨用例共享同一个 router 实例的内部状态。
export default function App() {
  const router = useMemo(() => createAppRouter(), [])
  return <RouterProvider router={router} />
}
