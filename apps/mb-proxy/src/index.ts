import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { loadProxyConfig } from './config'

export const app = new Hono()
// ① /healthz 在鉴权之前（照宿主 app.ts:205 的位置纪律：探活不带业务身份）
app.get('/healthz', (c) => c.json({ ok: true }))
// ② T3 挂 /handoff（兑换）；③ T4 挂鉴权中间件 + 授权规则表 + 上游透传

const cfg = loadProxyConfig()
serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`[mb-proxy] listening on http://127.0.0.1:${i.port}`)
})
