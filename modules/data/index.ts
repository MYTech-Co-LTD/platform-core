import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './routes/context'

// 装配形状照 modules/demo/index.ts 与 modules/aftersales/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    // 必须写泛型：裸 `new Hono()` 得到 `Hono<BlankEnv>`，Env 泛型不变 ⇒ 赋给 `ModuleHono` 报错。
    const r: ModuleHono = new Hono<ModuleVars>()
    const _ctx: RouteCtx = { pool }
    // T6/T7/T8 在此逐个 register*（每加一个，同任务里必须同步改 manifest.yaml 的 api.internal）
    void _ctx
    return r
  },
})
