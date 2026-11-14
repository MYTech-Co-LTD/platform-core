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
  loadDbtModels,
  loadDbtVars,
  loadSystemMapFacts,
  renderSystemMapHtml,
} from '../domain/system-map/map'
import type { SystemMapInput, SystemMapModel } from '../domain/system-map/map'
import { buildSystemMapOntology } from '../domain/system-map/ontology'
import { buildMetricTrail, lakeStagingFromContracts, pipelineIdsOf, stagingRelationsOf } from '../domain/system-map/trail'
import { buildPipelineMap, lakeConsumers } from '../domain/system-map/pipeline-map'
import { loadContracts, loadPipelines, loadSchedules, rootsOf } from '../domain/pipelines/defs'
import { warehousePool } from '../domain/warehouse'
import { watermarkSqlFor } from '../domain/query-service'
import { runSourceFromEnv } from '../domain/pipelines/run-source'

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
  pipelineCache.clear()
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

  // 指标链路（节点抽屉）：结构（声明/推断逐段标注）+ 运行态（最近 run / 物化钟 / 水位）。
  // 运行态有时效，不进上面那份 10 分钟缓存——每次打开抽屉现查，查不到就留空并给 note。
  r.get('/system-map/metrics/:id/trail', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const result = await modelFor(ctx, requester.orgId)
    if (!('metrics' in result)) return c.json(result, 500)

    const roots = rootsOf(process.env, ctx.repoRoot)
    const loaded = loadPipelines(roots)
    const loadedContracts = loadContracts(roots)
    const trail = buildMetricTrail(
      result,
      c.req.param('id'),
      [...loaded.defs.values()].map((d) => ({ id: d.id, lakeKeys: d.lakeKeys })),
      lakeStagingFromContracts(loadedContracts.contracts),
    )
    if (trail === null) return c.json({ error: 'NO_SUCH_METRIC' }, 404)

    // 最近 run：链路里**所有**管线里挑时间最新的一条（不能只取第一条——同一条链路常有
    // day/window/tick 多条，字母序第一条未必在跑）
    const pipeIds = pipelineIdsOf(trail)
    const runs = runSourceFromEnv(process.env)
    let lastRun: { runId: string; at: string; status: string; durationMs?: number; error?: string } | null = null
    let lastRunPipeline: string | null = null
    if (runs !== null && pipeIds.length > 0) {
      for (const pid of pipeIds) {
        try {
          const list = await runs.list({ pipelineId: pid, limit: 1 })
          const r0 = list.runs[0]
          if (r0 === undefined) continue
          if (lastRun === null || r0.startedAt > lastRun.at) {
            lastRun = {
              runId: r0.runId, at: r0.startedAt, status: r0.status,
              ...(r0.durationMs === undefined ? {} : { durationMs: r0.durationMs }),
              ...(r0.error === undefined ? {} : { error: r0.error }),
            }
            lastRunPipeline = pid
          }
        } catch { /* 读不到 ⇒ 缺席（未知 ≠ 没跑过） */ }
      }
    } else if (pipeIds.length > 0) {
      trail.notes.push('本服务未配置运行记录挂载（DATA_RUN_DIRS），看不到最近一次跑没跑')
    }

    // 物化钟 / 水位：仓库库的 data.load_log（平台库常态没有该表 ⇒ 缺席并说明）
    const rels = stagingRelationsOf(trail)
    let materializedAt: string | null = null
    let maxBizday: string | null = null
    if (rels.length > 0) {
      try {
        // 物化钟在**仓库库**（pg_duckdb）；平台库常态没有 load_log ⇒ 用 warehousePool，
        // 未配置时退回平台池（仍可能缺席，catch 里给 note）。
        const pool = ctx.warehouse ?? safeWarehousePool() ?? ctx.pool
        // 水位口径必须用 #844 订正后的唯一拼装点：先按关系取「最新一行」，再跨关系取 min。
        // 别再手写 min(max_bizday)——load_log 是追加式，全历史 min = 历史最差一次
        // （实测净销售额报 10-16 而真实水位 11-12；上一版 #2151 只加了 import 没换查询，等于没修）。
        const res = await pool.query(watermarkSqlFor(rels))
        const row = res.rows[0] as { materialized_at?: unknown; watermark?: unknown } | undefined
        materializedAt = row?.materialized_at instanceof Date ? row.materialized_at.toISOString() : (typeof row?.materialized_at === 'string' ? row.materialized_at : null)
        maxBizday = row?.watermark instanceof Date ? row.watermark.toISOString().slice(0, 10) : (typeof row?.watermark === 'string' ? row.watermark : null)
      } catch {
        trail.notes.push('物化钟不可用（data.load_log 不在当前库或未接入）')
      }
    }

    trail.runtime = { pipelineId: lastRunPipeline ?? pipeIds[0] ?? null, lastRun, materializedAt, maxBizday }
    return c.json({ trail })
  })

  // 管线视角的全局图：资产（湖前缀）→ staging → marts。运行态（最近一次 run 状态）60 秒缓存——
  // 比本体图短得多，因为它就是要回答「现在通不通」。
  r.get('/system-map/pipelines', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const now = Date.now()
    const hit = pipelineCache.get('global')
    if (hit !== undefined && hit.expiresAt > now) return c.json(hit.body)

    const roots = rootsOf(process.env, ctx.repoRoot)
    const loadedPipelines = loadPipelines(roots)
    const loadedSchedules = loadSchedules(roots)
    const loadedContracts = loadContracts(roots)
    const models = loadDbtModels(ctx.repoRoot)
    const staging = models.filter((m) => m.name.startsWith('stg_')).map((m) => m.name)
    const marts = models.filter((m) => m.name.startsWith('fct_') || m.name.startsWith('dim_') || m.name.startsWith('recon_'))
      .map((m) => ({ name: m.name, refs: m.refs ?? [] }))

    // 湖前缀字典 = 契约 layout.prefix ∪ 管线 sink key 前缀（两边都是声明锚）
    const lakePrefixes = new Set<string>()
    for (const c of loadedContracts.contracts) {
      const prefix = lakeStagingFromContracts([c]).values().next().value
      if (typeof prefix === 'string') lakePrefixes.add(prefix)
    }
    for (const d of loadedPipelines.defs.values()) {
      for (const key of d.lakeKeys) {
        const seg = key.split('/')
        if (seg.length >= 2 && !seg[0].includes('${') && !seg[1].includes('${')) lakePrefixes.add(`${seg[0]}/${seg[1]}`)
      }
    }
    const map = buildPipelineMap({
      pipelines: [...loadedPipelines.defs.values()].map((d) => ({ id: d.id, lakeKeys: d.lakeKeys })),
      schedules: loadedSchedules.byPipeline,
      contractLakes: lakeStagingFromContracts(loadedContracts.contracts),
      consumers: lakeConsumers(models, lakePrefixes, loadDbtVars(ctx.repoRoot)),
      staging,
      marts,
    })

    // 每条管线最近 3 次 run（排障要看「一直红」还是「偶发一次」，一条不够）。
    // 运行记录未接 ⇒ 空数组，前端标「未知」而不是「正常」。
    const runs = runSourceFromEnv(process.env)
    const recentRuns: Record<string, Array<{ status: string; at: string; durationMs?: number; error?: string }>> = {}
    if (runs !== null) {
      for (const a of map.assets) {
        for (const p of a.pipelines) {
          try {
            const list = await runs.list({ pipelineId: p.id, limit: 3 })
            recentRuns[p.id] = list.runs.map((r) => ({
              status: r.status,
              at: r.startedAt,
              ...(r.durationMs === undefined ? {} : { durationMs: r.durationMs }),
              ...(r.error === undefined ? {} : { error: r.error }),
            }))
          } catch { recentRuns[p.id] = [] }
        }
      }
    }

    // 在跑失败也由服务端数：只算 scheduled && enabled 的管线（口径与前端原逻辑一致，但只此一处）
    const failedLive = map.assets
      .flatMap((a) => a.pipelines)
      .filter((p) => p.scheduled && p.enabled)
      .filter((p) => recentRuns[p.id]?.[0]?.status === 'failed')
      .length

    const body = {
      generatedAt: new Date().toISOString(),
      runsWired: runs !== null,
      ...map,
      summary: { ...map.summary, failedLive },
      warnings: [...loadedPipelines.warnings, ...loadedSchedules.warnings, ...map.warnings],
      recentRuns,
    }
    pipelineCache.set('global', { body, expiresAt: now + PIPELINE_CACHE_TTL_MS })
    return c.json(body)
  })
}

/** warehousePool 在未配 `DATA_WAREHOUSE_URL` 时会抛——这里吞掉，交给 catch 的 note。 */
function safeWarehousePool(): ReturnType<typeof warehousePool> | null {
  try { return warehousePool() } catch { return null }
}

const PIPELINE_CACHE_TTL_MS = 60 * 1000
const pipelineCache = new Map<string, { body: unknown; expiresAt: number }>()
