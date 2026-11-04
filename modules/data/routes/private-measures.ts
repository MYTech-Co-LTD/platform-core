// private-measures.ts — W2 私有测度（`basis='column_agg'`）的 HTTP 面。
//
//   POST /metrics/private            新建（manifest: data:query；真判据在域层）
//   GET  /metrics/private/archived   归档行读面（manifest: data:manage）
//
// 门禁由宿主按 manifest 的 `api.internal` 施加——本文件**不写** requireScope（与 metrics.ts 同纪律）。
//
// 为什么新建申报 data:query（与 D6 草稿端点同档）：一次新建的 creator 就是调用者自己，
// 「data:manage ∪ creator」的并集用单一宿主 scope 表达不了 ⇒ 取低档进门，真判据在域层
// `writePrivateMeasure`（同源闸见那里：修改走 D6；归档复活需 creator ∪ data:manage）。
// 持 data:manage 的 PAT 需同时持 data:query 才能走此端点——与 /metrics/:id/meta 的取舍一致。
//
// 形状校验（zod）只做「是不是一份完整的列级聚合声明」；白名单/实际列/维度三闸在
// `domain/private-measure.ts`（需要 DB，不能进路由）。
import { z } from 'zod'
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf, writeOutcome } from './context'
import { COLUMN_AGG_FUNCS } from '../domain/semantic-compiler'
import { writePrivateMeasure } from '../domain/metric-write'
import type { PrivateMeasureWriteDeps } from '../domain/metric-write'
import { listArchivedPrivateMeasures } from '../domain/private-measure-lifecycle'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/**
 * POST body：行属性（id/title/description）+ 列级聚合声明（agg/column/dims/relation）。
 *
 * `.strict()` 与 L2 的写面同一纪律：`selectSql` / `groupBy` 等实现细节混进来 ⇒ **400**，
 * 不是静默忽略——否则调用方会以为自己写的 SQL 生效了。
 */
const PrivateMeasureBody = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  agg: z.enum(COLUMN_AGG_FUNCS),
  column: z.string().min(1).max(128),
  dims: z.array(z.string().min(1).max(128)).max(64).optional(),
  relation: z.string().min(1).max(256),
}).strict()

export function registerPrivateMeasures(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/metrics/private', async (c) => {
    const requester = requesterOf(c)
    // 写入必须能归属到人（审计要记 created_by）；无身份 ⇒ 拒，不写「无主」审计。
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    const parsed = PrivateMeasureBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, title, description, ...decl } = parsed.data
    const deps: PrivateMeasureWriteDeps = {
      pool: ctx.pool,
      requester,
      // 生产不传 ⇒ 域层走 warehousePool()；测试注入同一个库的替身
      ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }),
    }
    return writeOutcome(c, await writePrivateMeasure(deps, orgOf(c), {
      id, title, ...(description === undefined ? {} : { description }), ...decl,
    }), 201)
  })

  r.get('/metrics/private/archived', async (c) => {
    const requester = requesterOf(c)
    // 与 GET /metrics 同口径：无身份不是报错，也不是全租户数据
    if (requester === null) return c.json({ metrics: [] })
    return c.json({ metrics: await listArchivedPrivateMeasures(ctx.pool, orgOf(c)) })
  })
}
