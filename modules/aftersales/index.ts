import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { Identity } from '@platform/sdk'

// 装配形状照 modules/demo/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  // 本任务先返回空 router：装载期双向核对（注册集合 ⟺ 声明集合）在两边都空时通过。
  // T6 起逐域在这里 register*；每次注册都必须与 manifest 的声明同批改。
  createRouter: () => new Hono<{ Variables: { identity: Identity } }>(),
})
