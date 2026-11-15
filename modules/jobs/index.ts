// index.ts — jobs 模块入口（Wave 6 P4a）。
// manifest.yaml 是单一事实源（装载期 ManifestSchema 校验），不在 TS 里维护第二份副本。
// 端口：`ctx.jobs`（宿主注入，只读排班/台账 + 手动入队）；路由：见 routes.ts。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import { createJobsRouter } from './routes'

// manifest 路径用 node:path 取（happy-dom 下全局 URL 分辨不出 file: 方案，#718 实测）
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.yaml'), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ jobs, csrfVerify }) => createJobsRouter({ jobs, csrfVerify }),
})
