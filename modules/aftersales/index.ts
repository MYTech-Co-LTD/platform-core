import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, TENANT_STORAGE, defineModule } from '@platform/sdk'
import type { Identity, TenantStorageConfig } from '@platform/sdk'
import { registerTicketManage } from './routes/ticket-manage'
import { registerTicketGuest } from './routes/ticket-guest'
import { registerRule } from './routes/rule'
import { registerMasterData } from './routes/masterdata'
import { registerAttachmentGuest, registerAttachmentManage } from './routes/attachment'
import { registerRegistrationGuest } from './routes/registration-guest'
import { registerRegistrationManage } from './routes/registration-manage'
import type { RouteCtx } from './routes/context'

// 装配形状照 modules/demo/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    // ⚠️ 装载期**不读任何配置**（M3c 步 4）：存储配置由宿主按请求投影进 `TENANT_STORAGE`，
    // 各 handler 自己 `c.get`。这里读 env 是步 4 之前的形态，已消灭——它带来的正是
    // 「多租户同进程必然共用一份配置」。
    const r = new Hono<{ Variables: { identity: Identity; [TENANT_STORAGE]?: TenantStorageConfig } }>()
    const ctx: RouteCtx = { pool } // storage 已从 RouteCtx 消失，配置改为按请求取

    registerTicketManage(r, ctx)
    registerTicketGuest(r, ctx)
    registerRule(r, ctx)
    registerMasterData(r, ctx)
    registerAttachmentGuest(r, ctx)
    registerAttachmentManage(r, ctx)
    registerRegistrationGuest(r, ctx)
    registerRegistrationManage(r, ctx)
    return r
  },
})
