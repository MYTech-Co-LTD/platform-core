// query.ts — POST /query：三条通道共用的问数入口（通道 C 走这里；通道 B 的 MCP 也走这里）。
// 状态码映射（#30 订正）：ok → 200；denied → 403；error → **502**——
// warehouse_unconfigured 与 warehouse_error 都是上游数据仓库不可用，不是本服务的 bug ⇒ 不是 500。
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { runQuery } from '../domain/query-service'

const QueryBody = z.object({
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})

export function registerQuery(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/query', async (c) => {
    const parsed = QueryBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // 隔离键 org（text）= 租户的 Casdoor org——不是数字 id
    const org = c.get('tenant').casdoor_org

    // `execute` 必须透传：缺省会让 runQuery 去建真仓库连接，测试里就变成「断言被网络错误顶掉」。
    // requesterOf 的 M3 守卫在此收口：空 orgId → null → runQuery 的 unauthenticated 路径。
    //
    // `adoptedSources` 是本路由的**接线点**（计划 5 §3⑧）：域层（query-service）没有 Hono
    // context，宿主投影只能在这里读，再经 deps 穿下去。宿主没投影 ⇒ `?? []` ⇒ 空集
    // ⇒ 平台 L1 一律不可见（fail-closed；「未接入源」与「宿主没给这条事实」都不放行）。
    const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
    const outcome = await runQuery(
      { pool: ctx.pool, execute: ctx.execute, adoptedSources },
      org, requesterOf(c), parsed.data.metricId, parsed.data.args,
    )

    if (outcome.status === 'ok') return c.json(outcome)
    if (outcome.status === 'denied') {
      // 词表外的指标一律 403 + 统一 reason（**不**为「未声明」与「未授权」区分状态码：
      // 区分会变成一个存在性探针，与约束 3「看不见」冲突）
      return c.json(outcome, 403)
    }
    return c.json(outcome, 502)
  })
}
