// metrics.ts — 指标词表路由：GET /metrics（词表裁剪后的，给对话/管理界面选）、
// GET /metrics/all（管理面，全量）、POST/PUT/DELETE（管理面）。
// **门禁由宿主施加**（manifest 的 api.internal），本文件不写 requireScope；
// 词表裁剪只调 T2 的 visibleMetrics（授权核心单实现，路由层不自建权限判定）。
//
// ⚠️ 隔离键 org 一律取 `c.get('tenant').casdoor_org`（text）——**不是** `.id`（数字）：
// T3 存储层的 org 参数就是 Casdoor org 字符串，传数字既过不了 typecheck 也查不到行。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { visibleMetrics } from '../domain/authz'
import { deleteMetric, loadCatalog, upsertMetric } from '../domain/metric-store'

const MetricBody = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1),
  description: z.string().default(''),
  requiredScope: z.string().nullable().default(null),
  subjectColumn: z.string().min(1),
  selectSql: z.string().min(1),
  groupBy: z.string().default(''),
  params: z.record(z.object({
    column: z.string().min(1),
    type: z.enum(['date', 'string', 'number']),
    required: z.boolean().optional(),
  })).default({}),
})

/** 只投影消费面要的字段：`selectSql` / `subjectColumn` 属实现细节，不外泄。 */
const publicView = (m: { id: string; title: string; description: string }) =>
  ({ id: m.id, title: m.title, description: m.description })

/**
 * 指标 id 的**唯一**解析口径（PUT / DELETE 共用，两边必须同形）。
 *
 * ⚠️ 这里**不能**用 `parseIdParam`（T1 那个 `Number()` 解析器）：指标 id 是 `text`
 * （外部系统来的命名，如 `sales_daily`），数字解析器会把合法 id 判成非法 ⇒ 写操作**永远 404**。
 * `parseIdParam` 只服务 bigint 主键（T7 的 `query_keys.id` 用它，见那个任务的注记）。
 *
 * 形状校验的**真实承担者**是写入侧的 `MetricBody`（`z.string().min(1).max(64)`）；
 * 这里只挡「空/缺失」，一律 404 —— 与 aftersales 的「非法 id 一律 404」一致，不给存在性探针。
 */
const metricIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

export function registerMetrics(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/metrics', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：词表对其「看不见」（约束 3）——空词表，不是报错
    if (requester === null) return c.json({ metrics: [] })
    const all = await loadCatalog(ctx.pool, c.get('tenant').casdoor_org)
    return c.json({ metrics: visibleMetrics(all, requester).map(publicView) })
  })

  r.get('/metrics/all', async (c) => {
    const all = await loadCatalog(ctx.pool, c.get('tenant').casdoor_org)
    return c.json({ metrics: all })
  })

  r.post('/metrics', async (c) => {
    const parsed = MetricBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    await upsertMetric(ctx.pool, c.get('tenant').casdoor_org, parsed.data)
    return c.json({ ok: true }, 201)
  })

  r.put('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = MetricBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 路径 id 与 body id 必须同值：否则「改 A 结果写了 B」是静默的数据事故。
    if (parsed.data.id !== id) return c.json({ error: 'ID_MISMATCH' }, 400)
    await upsertMetric(ctx.pool, c.get('tenant').casdoor_org, parsed.data)
    return c.json({ ok: true })
  })

  r.delete('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const gone = await deleteMetric(ctx.pool, c.get('tenant').casdoor_org, id)
    return gone ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND' }, 404)
  })
}
