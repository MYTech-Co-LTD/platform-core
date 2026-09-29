// index.ts — 进程入口：装配（config + createApp）→ serve。路由在 `app.ts`（T3 拆出，见其头注）。
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { loadProxyConfig } from './config'

const cfg = loadProxyConfig()
const app = createApp(cfg)

// ⚠️ 这里**不传 `hostname`**：`serve()` 监听全部接口（与 `apps/server/src/index.ts` 同款仓内惯例）。
//    环回保证**来自 compose 的 `127.0.0.1:<宿主端口>:<容器端口>` 端口映射**，不是这里 bind 的地址——
//    容器内绑 `127.0.0.1` 会让 docker 的端口转发（它连的是容器网络 IP）够不到进程 ⇒ 宿主 published
//    端口失效。故日志**只说端口**，不宣称自己绑在 127.0.0.1（那是宿主侧的事实，不是进程侧的事实）。
serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`[mb-proxy] listening on port ${i.port}`)
})
