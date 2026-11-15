// query-batch.ts — POST /query/batch：多面板一次取数（R4）。
//
// 为什么：报表页的多面板取数此前在**客户端**合并（同 body 只发一次），但 N 个面板仍是
// N 个 HTTP 往返——企微 WebView/弱网下连接开销可观。批量端点把「一页报表」收敛成 1 个请求，
// 服务端逐条走**同一个** runQuery（授权/掩码/审计/缓存/单飞全在同一链，零旁路）。
//
// 语义（与 /query 单条的有意差异）：
//   · HTTP 恒 200，逐条回 `status`（ok/denied/error）——一个面板被拒不该拖垮整页；
//     调用方本来就能逐条调 /query 得到同样信息，批量不放大能力（同一 data:query 页门）。
//   · 上限 12 条 = MAX_PANELS：批量是「一页报表」的形状，不是通用并行查询接口。
//   · 逐条超过 500ms 仍打慢查询日志（与单条同一口径）。
// 每条审计照写（writeAudit 在 runQuery 内），观察面不缺行。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { runQuery } from '../domain/query-service'
import { slicingOf } from './query'

const BatchItem = z.object({
  /** 客户端面板标识（原样回带，用于对位）；服务端不解释。 */
  id: z.string().min(1).max(64),
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  dimensions: z.array(z.string().min(1)).optional(),
  orderBy: z.array(z.object({
    column: z.string().min(1),
    dir: z.enum(['asc', 'desc']).optional(),
  })).optional(),
  limit: z.number().int().positive().optional(),
  total: z.boolean().optional(),
})

const BatchBody = z.object({
  queries: z.array(BatchItem).min(1).max(12),
}).strict()

export function registerQueryBatch(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/query/batch', async (c) => {
    const parsed = BatchBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const org = c.get('tenant').casdoor_org
    const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
    const requester = requesterOf(c)

    const results = await Promise.all(parsed.data.queries.map(async (q) => {
      const startedAt = Date.now()
      const outcome = await runQuery(
        { pool: ctx.pool, execute: ctx.execute, adoptedSources },
        org, requester, q.metricId, q.args, slicingOf(q),
      )
      const elapsed = Date.now() - startedAt
      if (elapsed >= 500) {
        const bizday = (q.args as { bizday?: unknown }).bizday
        const dims = q.dimensions ?? []
        console.warn(`[data/query/batch] slow ${elapsed}ms metric=${q.metricId} dims=${dims.join(',')} bizday=${JSON.stringify(bizday)} total=${String(q.total ?? false)}`)
      }
      // id 原样回带在前（客户端按它对位）；outcome 展开在后（status/metricId/columns/rows/…）
      return { id: q.id, ...outcome }
    }))

    return c.json({ results })
  })
}
