import { createRouter, createWebHistory } from 'vue-router'

/**
 * `createWebHistory` 吃 `import.meta.env.BASE_URL`（vite 由 `base` 注入）——**必须**与
 * vite 的 base 同源，否则深链刷新时路由表对不上 `/app/aftersales/...` 的前缀。
 * 四条路由：`/` 工单提交（入口）、`/register` 员工登记、`/tickets` 本店工单列表、
 * `/tickets/:id` 工单详情（2026-11-25 门店可见性一并加）。
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'submit', component: () => import('./pages/afterSalesWorkOrderSubmit.vue') },
    { path: '/register', name: 'register', component: () => import('./pages/storeEmployeeApproval.vue') },
    // 2026-11-25 门店可见性：本店工单列表（多店切换）+ 详情
    { path: '/tickets', name: 'myTickets', component: () => import('./pages/myTickets.vue') },
    { path: '/tickets/:id', name: 'ticketDetail', component: () => import('./pages/ticketDetail.vue') },
  ],
})
