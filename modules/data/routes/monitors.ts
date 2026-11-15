// routes/monitors.ts — 业务监控管理面（Wave 7 V1，spec §2/§9；issue #2278）。
//
// 门 = `data:query`（manifest api.internal 声明，宿主施加；本文件零鉴权代码）。
// 改/停只允许「创建者」或 `data:manage`——监控是别人建的，随便谁都能关掉就是静默失明入口。
// 创建期三道校验（spec「两道门」的第一道）：目标存在、收件人可解析、V1 闭集。
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf } from './context'
import {
  createMonitor, getMonitor, listMonitors, listRuns, MonitorStoreError, updateMonitorFlags,
} from '../domain/monitor-store'
import { validateNewMonitor, type NewMonitorInput } from '../domain/monitor-spec'
import { resolveMonitorRecipients } from '../domain/monitor-recipients'
import { panelTargetOf } from '../domain/monitor-eval'
import { loadMergedCatalog } from '../domain/metric-store'
import { writeAssetAudit } from '../domain/asset-auth'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

function actorOf(c: Context<ModuleVars>): string {
  const requester = requesterOf(c)
  return requester?.accountName ?? requester?.userId ?? 'unknown'
}

function hasManage(c: Context<ModuleVars>): boolean {
  const requester = requesterOf(c)
  return requester !== null && requester.hasScope('data:manage')
}

const BODY_KEYS = new Set([
  'name', 'targetKind', 'metricId', 'reportId', 'panelIndex', 'filters', 'verdict',
  'windowDays', 'cadenceSecs', 'cooldownSecs', 'recipients', 'channelPolicy',
])

export function registerMonitors(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/monitors', async (c) => {
    return c.json({ monitors: await listMonitors(ctx.pool, orgOf(c)) })
  })

  // 静态路径要在 `/:id` 之前（loader 门卫按注册顺序匹配）。
  r.get('/monitors/:id/runs', async (c) => {
    const org = orgOf(c)
    const id = c.req.param('id')
    if ((await getMonitor(ctx.pool, org, id)) === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const limit = Number(c.req.query('limit') ?? '50')
    return c.json({ runs: await listRuns(ctx.pool, org, id, Number.isFinite(limit) ? limit : 50) })
  })

  r.post('/monitors', async (c) => {
    const org = orgOf(c)
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400)
    }
    // 只收声明内的键：多余字段静默丢弃是「以为配上了」的来源，直接拒。
    const extra = Object.keys(body).filter((k) => !BODY_KEYS.has(k))
    if (extra.length > 0) return c.json({ error: 'UNKNOWN_FIELD', detail: extra.join(',') }, 400)

    const input = {
      org,
      name: body.name,
      targetKind: body.targetKind,
      metricId: body.metricId,
      reportId: body.reportId,
      panelIndex: body.panelIndex,
      filters: body.filters,
      verdict: body.verdict,
      windowDays: body.windowDays,
      cadenceSecs: body.cadenceSecs,
      cooldownSecs: body.cooldownSecs,
      recipients: body.recipients,
      channelPolicy: body.channelPolicy,
      createdBy: actorOf(c),
    } as NewMonitorInput

    const v = validateNewMonitor(input)
    if (!v.ok) return c.json({ error: v.code, detail: v.message }, 400)

    // 目标存在性：metric 在词表里；report_panel 的面板能解析出指标（文本/AI 面板不行）。
    if (v.value.targetKind === 'metric') {
      const catalog = await loadMergedCatalog(ctx.pool, org)
      if (!catalog.some((m) => m.id === v.value.metricId)) {
        return c.json({ error: 'MONITOR_TARGET_INVALID', detail: 'metric_not_declared' }, 400)
      }
    } else {
      const panel = await panelTargetOf(ctx.pool, org, v.value.reportId!, v.value.panelIndex!)
      if (panel === null) {
        return c.json({ error: 'MONITOR_TARGET_INVALID', detail: 'panel_has_no_metric' }, 400)
      }
    }

    // 收件人第一道门：创建时就解析一次；全被剔除 ⇒ 拒（别造一条发不出去的规则）。
    const resolved = await resolveMonitorRecipients(ctx.pool, org, v.value.recipients)
    if (resolved.to.length === 0) {
      return c.json({ error: 'MONITOR_NO_RECIPIENTS', detail: JSON.stringify(resolved.excluded) }, 400)
    }

    try {
      const { id } = await createMonitor(ctx.pool, v.value)
      await writeAssetAudit(ctx.pool, {
        org, assetId: `monitor:${id}`, actor: actorOf(c), action: 'monitor.create',
        detail: { targetKind: v.value.targetKind, metricId: v.value.metricId ?? null,
          reportId: v.value.reportId ?? null, panelIndex: v.value.panelIndex ?? null,
          verdict: v.value.verdict, recipients: resolved.to },
      })
      return c.json({ id, dryRun: true, recipients: resolved.to }, 201)
    } catch (err) {
      if (err instanceof MonitorStoreError) {
        const status = err.code === 'MONITOR_QUOTA_EXCEEDED' ? 409 : 400
        return c.json({ error: err.code, detail: err.message }, status)
      }
      throw err
    }
  })

  // 启停 / 影子期开闸。dry_run 只能在这里关（创建时恒 true）。
  r.patch('/monitors/:id', async (c) => {
    const org = orgOf(c)
    const id = c.req.param('id')
    const monitor = await getMonitor(ctx.pool, org, id)
    if (monitor === null) return c.json({ error: 'NOT_FOUND' }, 404)
    if (monitor.createdBy !== actorOf(c) && !hasManage(c)) return c.json({ error: 'FORBIDDEN' }, 403)

    let body: { enabled?: unknown; dryRun?: unknown }
    try {
      body = (await c.req.json()) as { enabled?: unknown; dryRun?: unknown }
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400)
    }
    const patch: { enabled?: boolean; dryRun?: boolean } = {}
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'INVALID_BODY' }, 400)
      patch.enabled = body.enabled
    }
    if (body.dryRun !== undefined) {
      if (typeof body.dryRun !== 'boolean') return c.json({ error: 'INVALID_BODY' }, 400)
      patch.dryRun = body.dryRun
    }
    if (Object.keys(patch).length === 0) return c.json({ error: 'INVALID_BODY', detail: 'nothing_to_update' }, 400)

    await updateMonitorFlags(ctx.pool, org, id, patch)
    await writeAssetAudit(ctx.pool, {
      org, assetId: `monitor:${id}`, actor: actorOf(c), action: 'monitor.toggle', detail: patch,
    })
    return c.json({ ok: true })
  })
}
