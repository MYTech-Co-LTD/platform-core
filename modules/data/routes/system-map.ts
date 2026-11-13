// system-map.ts — 「数据体系地图」的路由装配层（只做装配 + 鉴权，领域逻辑全在 domain/system-map/）。
//
// 门禁由宿主按 manifest 的 api.internal 施加（本文件不写 requireScope）：
//   GET /api/modules/data/system-map        → scope `data:query`（服务端渲染单文件 HTML，移动端/旧链接）
//   GET /api/modules/data/system-map/graph  → scope `data:query`（本体图 JSON，控制台内嵌页用）
//
// 缓存：地图是**观测面**不是实时交易面——单次生成要扫 YAML / contracts / dbt 全图 + 查运行库，
// 故进程内缓存 10 分钟（按 org + repoRoot 分键；多租户共用一个进程时不会串租户）。
// HTML 与 JSON 共用同一份 `SystemMapModel`：两个端点命中同一个缓存，不各扫一遍盘。
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import {
  buildSystemMapModel,
  loadSystemMapFacts,
  renderSystemMapHtml,
} from '../domain/system-map/map'
import type { SystemMapInput, SystemMapModel } from '../domain/system-map/map'
import { buildSystemMapOntology } from '../domain/system-map/ontology'

const CACHE_TTL_MS = 10 * 60 * 1000
interface CachedMap {
  model: SystemMapModel
  html: string
  expiresAt: number
}
const cache = new Map<string, CachedMap>()

/** 测试缝：清空进程内缓存（生产不调用）。 */
export function clearSystemMapCache(): void {
  cache.clear()
}

/** 取模型（命中缓存直接回；未命中重新扫盘并连同 HTML 一起缓存）。 */
async function modelFor(ctx: RouteCtx, org: string): Promise<SystemMapModel | { error: string; detail: string }> {
  const key = `${org}|${ctx.repoRoot ?? ''}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && hit.expiresAt > now) return hit.model

  let input: SystemMapInput
  try {
    input = await loadSystemMapFacts({ pool: ctx.pool, org, repoRoot: ctx.repoRoot })
  } catch (err) {
    // 地图是观测面：读面整体失败时明确报错，不返回一张「看起来正常」的空图。
    // （域内的单块降级已在 loadSystemMapFacts 里做；走到这里说明连兜底都失败了。）
    return { error: 'SYSTEM_MAP_LOAD_FAILED', detail: err instanceof Error ? err.message : String(err) }
  }

  const model = buildSystemMapModel(input)
  cache.set(key, { model, html: renderSystemMapHtml(model), expiresAt: now + CACHE_TTL_MS })
  return model
}

export function registerSystemMap(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/system-map', async (c) => {
    const requester = requesterOf(c)
    // 宿主门卫先挡匿名；这里再兜一层（门卫放行但 org 为空 ⇒ 不生成全租户视图）。
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const result = await modelFor(ctx, requester.orgId)
    if (!('metrics' in result)) return c.json(result, 500)
    const key = `${requester.orgId}|${ctx.repoRoot ?? ''}`
    return c.html(cache.get(key)?.html ?? renderSystemMapHtml(result))
  })

  // 本体图（控制台内嵌页）：返回 entities + relations 形状，前端只管画。
  r.get('/system-map/graph', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const result = await modelFor(ctx, requester.orgId)
    if (!('metrics' in result)) return c.json(result, 500)
    return c.json({
      generatedAt: result.generatedAt,
      health: result.health,
      ontology: buildSystemMapOntology(result),
      warnings: result.warnings,
    })
  })
}
