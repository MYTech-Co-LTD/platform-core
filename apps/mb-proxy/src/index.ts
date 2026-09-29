import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { loadProxyConfig } from './config'

export const app = new Hono()
// ① /healthz 在鉴权之前（照宿主 app.ts:205 的位置纪律：探活不带业务身份）
app.get('/healthz', (c) => c.json({ ok: true }))
// ② T3 挂 /handoff（兑换）；③ T4 挂鉴权中间件 + 授权规则表 + 上游透传

const cfg = loadProxyConfig()
// ⚠️ 这里**不传 `hostname`**：`serve()` 监听全部接口（与 `apps/server/src/index.ts` 同款仓内惯例）。
//    环回保证**来自 compose 的 `127.0.0.1:<宿主端口>:<容器端口>` 端口映射**，不是这里 bind 的地址——
//    容器内绑 `127.0.0.1` 会让 docker 的端口转发（它连的是容器网络 IP）够不到进程 ⇒ 宿主 published
//    端口失效。故日志**只说端口**，不宣称自己绑在 127.0.0.1（那是宿主侧的事实，不是进程侧的事实）。
serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`[mb-proxy] listening on port ${i.port}`)
})
