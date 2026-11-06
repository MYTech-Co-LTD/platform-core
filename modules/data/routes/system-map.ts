// system-map.ts — 「数据体系地图」的路由装配层（只做装配 + 鉴权，领域逻辑全在 domain/system-map/map.ts）。
//
// 门禁由宿主按 manifest 的 api.internal 施加（本文件不写 requireScope）：
//   GET /api/modules/data/system-map → scope `data:query`（与问数面同档）。
//
// 缓存：地图是**观测面**不是实时交易面——单次生成要扫 YAML / contracts / dbt 全图 + 查运行库，
// 故进程内缓存 10 分钟（按 org + repoRoot 分键；多租户共用一个进程时不会串租户）。
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import {
  buildSystemMapModel,
  loadSystemMapFacts,
  renderSystemMapHtml,
} from '../domain/system-map/map'
import type { SystemMapInput } from '../domain/system-map/map'

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { html: string; expiresAt: number }>()

/** 测试缝：清空进程内缓存（生产不调用）。 */
export function clearSystemMapCache(): void {
  cache.clear()
}

export function registerSystemMap(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/system-map', async (c) => {
    const requester = requesterOf(c)
    // 宿主门卫先挡匿名；这里再兜一层（门卫放行但 org 为空 ⇒ 不生成全租户视图）。
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const key = `${requester.orgId}|${ctx.repoRoot ?? ''}`
    const now = Date.now()
    const hit = cache.get(key)
    if (hit !== undefined && hit.expiresAt > now) {
      return c.html(hit.html)
    }

    let input: SystemMapInput
    try {
      input = await loadSystemMapFacts({
        pool: ctx.pool,
        org: requester.orgId,
        repoRoot: ctx.repoRoot,
      })
    } catch (err) {
      // 地图是观测面：读面整体失败时明确报错，不返回一张「看起来正常」的空图。
      // （域内的单块降级已在 loadSystemMapFacts 里做；走到这里说明连兜底都失败了。）
      return c.json({ error: 'SYSTEM_MAP_LOAD_FAILED', detail: err instanceof Error ? err.message : String(err) }, 500)
    }

    const html = renderSystemMapHtml(buildSystemMapModel(input))
    cache.set(key, { html, expiresAt: now + CACHE_TTL_MS })
    return c.html(html)
  })
}
