// query-detail.ts — POST /query/detail：明细下钻的 HTTP 面（spec 2026-10-21 §2.4）。
// 状态码映射与 /query 同一三分法（#30 订正）：ok → 200；denied → 403；error → 502。
// denied 的 body 带 reason/detail——`no_detail_binding` 是能力陈述，企微插件靠它换措辞
// （不当「没权限」说），所以 body 必须透传 reason，不得吞成统一文案。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { runDetailQuery } from '../domain/drill'

const DetailBody = z.object({
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  dimensions: z.array(z.string()).optional(),
  orderBy: z.string().optional(),
  desc: z.boolean().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
})

export function registerQueryDetail(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/query/detail', async (c) => {
    const parsed = DetailBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // 隔离键 org（text）= 租户的 Casdoor org——与 /query 同源
    const org = c.get('tenant').casdoor_org

    // `adoptedSources` 接线点与 /query 同款（计划 5 §3⑧）：宿主投影在这里读，经 deps 穿下去；
    // 宿主没投影 ⇒ 空集 ⇒ 平台 L1 一律不可见（fail-closed）。
    const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
    const { metricId, args, ...rest } = parsed.data
    const outcome = await runDetailQuery(
      { pool: ctx.pool, execute: ctx.execute, adoptedSources },
      org, requesterOf(c), metricId, args, rest,
    )

    if (outcome.status === 'ok') return c.json(outcome)
    if (outcome.status === 'denied') return c.json(outcome, 403)
    return c.json(outcome, 502)
  })
}
