// index-v2.ts — 通知模块 v2 入口（expand 阶段；Task 15 rename 为 index.ts）。
// 与旧 index.ts 并存：loader 仍读旧 manifest.yaml/index.ts，直到 Task 15 切换。
import { defineModule, type ModuleManifest } from '@platform/sdk'
import { createPortsV2 } from './ports-v2'
import { createNotifyRouterV2 } from './routes-v2'

const manifest: ModuleManifest = {
  id: 'notify',
  name: '通知基础设施',
  version: '0.2.0',
  platform: '>=0.1',
  permissions: [
    { code: 'notify:view', name: '通知查看' },
    { code: 'notify:manage', name: '通知规则管理' },
    { code: 'notify:publish', name: '通知文案发布' },
    { code: 'notify:channel', name: '通知通道配置' },
    { code: 'notify:emit', name: '事件触发' },
  ],
  api: {
    internal: [
      { method: 'GET', path: '/rules', scope: 'notify:view' },
      { method: 'POST', path: '/rules', scope: 'notify:manage' },
      { method: 'PUT', path: '/rules/:id/enabled', scope: 'notify:manage' },
      { method: 'DELETE', path: '/rules/:id', scope: 'notify:manage' },
      { method: 'GET', path: '/deliveries', scope: 'notify:view' },
      { method: 'POST', path: '/emit', scope: 'notify:emit' },
      { method: 'GET', path: '/inbox', scope: 'notify:view' },
      { method: 'POST', path: '/inbox/:id/read', scope: 'notify:view' },
    ],
  },
  migrations: { dir: './migrations' },
}

export default defineModule({
  manifest,
  createPorts: ({ pool }) => createPortsV2({ pool }),
  createRouter: ({ pool, events }) => createNotifyRouterV2({ pool, events }),
})
