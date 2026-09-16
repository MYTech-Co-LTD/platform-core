import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import { ZosStorage, zosConfigFromEnv } from './storage'
import { registerTicketManage } from './routes/ticket-manage'
import { registerTicketGuest } from './routes/ticket-guest'
import { registerRule } from './routes/rule'
import { registerMasterData } from './routes/masterdata'
import { registerAttachmentGuest, registerAttachmentManage } from './routes/attachment'
import { registerRegistrationGuest } from './routes/registration-guest'
import type { RouteCtx } from './routes/context'

// 装配形状照 modules/demo/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    const r = new Hono<{ Variables: { identity: Identity } }>()
    // 没有 ZOS 凭证时 storage 为 null：模块照常装载，只有附件端点回 503（见 storage.ts）
    const config = zosConfigFromEnv(process.env)
    const ctx: RouteCtx = { pool, storage: config ? new ZosStorage(config) : null }

    registerTicketManage(r, ctx)
    registerTicketGuest(r, ctx)
    registerRule(r, ctx)
    registerMasterData(r, ctx)
    registerAttachmentGuest(r, ctx)
    registerAttachmentManage(r, ctx)
    registerRegistrationGuest(r, ctx)
    return r
  },
})
