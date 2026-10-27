// index.ts — 通知模块入口（通知基础设施；正典 docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md）。
// manifest.yaml 是单一事实源（装载期 ManifestSchema 校验），不在 TS 里维护第二份副本。
// 端口：enqueueEvent（宿主包装成 ctx.notify.emit）；路由：规则/回执/emit/收件箱。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import { createPorts } from './ports'
import { createNotifyRouter } from './routes'

// manifest 路径用 node:path 取（happy-dom 下全局 URL 分辨不出 file: 方案，#718 实测）
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.yaml'), 'utf8')),
)

export default defineModule({
  manifest,
  createPorts: ({ pool }) => createPorts({ pool }),
  createRouter: ({ pool, events }) => createNotifyRouter({ pool, events }),
})
