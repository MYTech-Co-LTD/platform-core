import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './routes/context'
import { registerMcp } from './routes/mcp'
import { registerMcpManage } from './routes/mcp-manage'
import { registerMetrics } from './routes/metrics'
import { registerQuery } from './routes/query'
import { registerChat } from './routes/chat'
import { registerReports } from './routes/reports'

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
    // 个人 Key 管理已上移宿主（issue #894，正典 §1.5）⇒ 本模块不再有 /keys 路由与声明。
    // T6，T8 收紧写路径：POST/PUT 只收结构化 L2Declaration（SQL 由 domain/semantic-compiler.ts
    // 这个**唯一编译点**生成）；`source='l1'` 的行经 API 只读。端点集合未变 ⇒ 本清单无新声明。
    registerMetrics(r, _ctx)
    registerQuery(r, _ctx) // T6
    registerMcp(r, _ctx) // T8：MCP 读面（问数）
    registerMcpManage(r, _ctx) // MCP 写面（本租户口径的定义；#486）
    registerChat(r, _ctx) // T9
    registerReports(r, _ctx) // #150 T7：Metabase 报表 facade
    return r
  },
  // 模块端口（约束 14）：**本模块已不再声明任何端口**——原 `resolvePatKey` 随 PAT 密钥表
  // 上移宿主（issue #894）一并退役：宿主现在直接查自己的 `platform.api_key`，
  // 不再需要「绕 B1 去模块 schema 取凭据」这条间接层。
})
