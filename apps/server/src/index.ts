// index.ts — 宿主进程入口（Task 16）：.env 装配 → buildApp → listen
//
// dev：tsx watch（pnpm dev，脚本 cwd=apps/server——modules/ 相对路径依赖此约定，见 app.ts）。
// 配置错误（缺必填 env / secret 太短 / modules 装载失败）在 buildApp 内 fail-fast 抛出，
// 进程起不来即正确行为——绝不带病起服务。
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { buildApp } from './app'

const { app, config, modules } = await buildApp()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[server] listening on http://127.0.0.1:${info.port}`
    + ` (tenantMode=${config.tenantMode}, modules=${modules.modules.length})`,
  )
})
