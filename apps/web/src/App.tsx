import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import LoginPage from './pages/Login'
import ConsolePlaceholder from './pages/Placeholder'

/**
 * 路由骨架（Task 17）：唯一前端应用（门户 + console 同构建）。
 * / 与 /console 本任务为占位页；console 壳在 Task 18 实现。
 */
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <ConsolePlaceholder /> },
  { path: '/console', element: <ConsolePlaceholder /> },
  { path: '*', element: <ConsolePlaceholder /> },
])

export default function App() {
  return <RouterProvider router={router} />
}
