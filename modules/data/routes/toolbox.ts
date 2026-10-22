// toolbox.ts — POST /toolbox：registry 的 HTTP 薄封装（Wave 2 决策 D-C1，spec 2026-10-21 §6/§9）。
// 通道无关：声明 scope data:query，PAT/会话/企微三类请求者经各自中间件都能调；
// 分发与审计全部走 registry.callTool 单点（含拒绝/出错，channel 随身份）——本文件零权限逻辑。
// 状态码映射照 /query 的 #30 口径：ok → 200；denied/not_found/unknown_tool → 403；
// error（tool_exception/impl_missing）→ 502——插件 callPlatform 的文案映射零改动复用。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { callTool } from '../domain/toolbox/registry'
import { buildToolboxDeps } from '../domain/toolbox/all'

const ToolCallBody = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})

export function registerToolbox(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/toolbox', async (c) => {
    const parsed = ToolCallBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // requesterOf 的 M3 守卫在此收口：空 orgId → null → callTool 的 unauthenticated 路径（403）。
    // adoptedSources 是本路由的接线点（与 /query、/chat 同口径）：宿主没投影 ⇒ 空集 fail-closed。
    const deps = buildToolboxDeps(
      {
        pool: ctx.pool,
        org: c.get('tenant').casdoor_org,
        requester: requesterOf(c),
        adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
      },
      { wh: ctx.execute },
    )
    const out = await callTool(deps, parsed.data.tool, parsed.data.args)
    if (!out.isError) return c.json(out.payload)
    return c.json(out.payload, out.payload.status === 'error' ? 502 : 403)
  })
}
