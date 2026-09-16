import { createRouter, createWebHistory } from 'vue-router'

/**
 * `createWebHistory` 吃 `import.meta.env.BASE_URL`（vite 由 `base` 注入）——**必须**与
 * vite 的 base 同源，否则深链刷新时路由表对不上 `/app/aftersales/...` 的前缀。
 * 两条路由：`/` 工单提交（入口）、`/register` 员工登记（未登记时由提交页引导过来）。
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'submit', component: () => import('./pages/afterSalesWorkOrderSubmit.vue') },
    { path: '/register', name: 'register', component: () => import('./pages/storeEmployeeApproval.vue') },
  ],
})
