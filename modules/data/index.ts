import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './routes/context'
import { registerKeys } from './routes/keys'
import { registerMcp } from './routes/mcp'
import { registerMetrics } from './routes/metrics'
import { registerQuery } from './routes/query'
import { registerChat } from './routes/chat'
import { registerReports } from './routes/reports'
import { resolvePat, touchPatKey } from './domain/key-store'

// 装配形状照 modules/demo/index.ts 与 modules/aftersales/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: (moduleCtx) => {
    // 必须写泛型：裸 `new Hono()` 得到 `Hono<BlankEnv>`，Env 泛型不变 ⇒ 赋给 `ModuleHono` 报错。
    const r: ModuleHono = new Hono<ModuleVars>()
    // `ModuleContext` 协议上只有 pool；`execute` 是宿主给模块测试用的扩展点，
    // 生产装配下它是 undefined（= 走真仓库）。写显式转型而不是改协议。
    const _ctx: RouteCtx = {
      pool: moduleCtx.pool,
      execute: (moduleCtx as RouteCtx).execute,
    }
    // register* 与 manifest.yaml 的 api.internal 必须同一提交对齐（装载期双向核对）
    registerKeys(r, _ctx) // T7
    registerMetrics(r, _ctx) // T6
    registerQuery(r, _ctx) // T6
    registerMcp(r, _ctx) // T8
    registerChat(r, _ctx) // T9
    registerReports(r, _ctx) // #150 T7：Metabase 报表 facade
    return r
  },
  // 模块端口（约束 14）：宿主在 mount 前经 runtime.port('data','resolvePatKey') 取用。
  // **不声明 ⇒ 宿主取到 undefined ⇒ 通道 B 全线 503**（fail-closed 空窗，声明完即闭合）。
  createPorts: ({ pool }) => ({
    resolvePatKey: async (token) => {
      const resolved = await resolvePat(pool, token)
      if (resolved === null) return null
      // fire-and-forget 触碰 last_used_at（#142：**唯一**写入点，端口化后宿主不再写这条 update）——
      // 不 await、失败不阻断问数。签名 (pool, org, id)（#141 订正）。
      void touchPatKey(pool, resolved.org, resolved.keyId).catch(() => {})
      // 原样转交：ResolvedPat 恰与 SDK 的 ResolvedPatKey 同形（keyId/org/casdoorUser）
      return resolved
    },
  }),
})
