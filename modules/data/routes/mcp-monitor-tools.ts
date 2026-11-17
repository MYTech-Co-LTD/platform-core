// mcp-monitor-tools.ts — 管理面「业务监控」片（B 子项目，2026-11-17）。
//
// 只暴露三件事：列监控、列运行记录、**建草稿**。`dry_run` 恒 true（创建期由
// monitor-spec/HTTP 同源保证），开启投递必须人到控制台；本片没有 enable/dryRun 参数。
// 目标存在性/阈值为可加指标/收件人可解析三道校验与 HTTP POST /monitors 同源复用 domain。
import { z } from 'zod'
import { writeAssetAudit } from '../domain/asset-auth'
import { loadMergedCatalog } from '../domain/metric-store'
import { panelTargetOf } from '../domain/monitor-eval'
import { resolveMonitorRecipients } from '../domain/monitor-recipients'
import { validateNewMonitor, type NewMonitorInput } from '../domain/monitor-spec'
import {
  createMonitor, getMonitor, listMonitors, listRuns, MonitorStoreError,
} from '../domain/monitor-store'
import { manageFaceOfSlice } from './mcp-manage-face'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

const NAMES: readonly string[] = manageFaceOfSlice('monitor').map((t) => t.name)
const ok = (o: Record<string, unknown>): McpToolResult =>
  ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })
const refused = (error: string, extra: Record<string, unknown> = {}): McpToolResult =>
  ({ text: JSON.stringify({ status: 'refused', error, ...extra }), isError: true })

const Recipient = z.object({ kind: z.enum(['dept', 'user']), ref: z.string().min(1) })

const CreateArgs = z.object({
  name: z.string().trim().min(1).max(120),
  targetKind: z.enum(['metric', 'report_panel']),
  metricId: z.string().min(1).optional(),
  reportId: z.string().min(1).optional(),
  panelIndex: z.number().int().min(0).optional(),
  verdict: z.enum(['missing', 'stale', 'threshold']),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']).optional(),
  threshold: z.number().finite().optional(),
  windowDays: z.number().int().min(1).max(30).optional(),
  cadenceSecs: z.number().int().min(300),
  recipients: z.array(Recipient).min(1),
}).strict()

const RunsArgs = z.object({
  id: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()

export const monitorTools: McpToolGroup = {
  async list(deps: McpDeps) {
    if (deps.requester === null) return []
    return manageFaceOfSlice('monitor').map((t) => t.wire)
  },

  async call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    if (!NAMES.includes(name)) return null
    if (deps.requester === null) return refused('unauthenticated')

    if (name === 'list_monitors') {
      return ok({ monitors: await listMonitors(deps.pool, deps.org) })
    }

    if (name === 'list_monitor_runs') {
      const parsed = RunsArgs.safeParse(args)
      if (!parsed.success) return refused('BAD_PARAM')
      if (await getMonitor(deps.pool, deps.org, parsed.data.id) === null) {
        return refused('NOT_FOUND')
      }
      return ok({
        runs: await listRuns(deps.pool, deps.org, parsed.data.id, parsed.data.limit ?? 50),
      })
    }

    if (name === 'create_monitor') {
      const parsed = CreateArgs.safeParse(args)
      if (!parsed.success) return refused('BAD_PARAM', { issues: parsed.error.issues.map((i) => i.path.join('.')) })
      const input: NewMonitorInput = {
        ...parsed.data,
        org: deps.org,
        createdBy: deps.requester.accountName ?? deps.requester.userId,
      }
      const v = validateNewMonitor(input)
      if (!v.ok) return refused(v.code, { detail: v.message })

      // 目标存在性：与 HTTP 面同一判据。
      let totalable: boolean | null = null
      if (v.value.targetKind === 'metric') {
        const catalog = await loadMergedCatalog(deps.pool, deps.org)
        const row = catalog.find((m) => m.id === v.value.metricId)
        if (row === undefined) return refused('MONITOR_TARGET_INVALID', { detail: 'metric_not_declared' })
        totalable = row.totalable === true
      } else {
        const panel = await panelTargetOf(
          deps.pool, deps.org, v.value.reportId!, v.value.panelIndex!)
        if (panel === null) return refused('MONITOR_TARGET_INVALID', { detail: 'panel_has_no_metric' })
        const catalog = await loadMergedCatalog(deps.pool, deps.org)
        totalable = catalog.find((m) => m.id === panel.metricId)?.totalable === true
      }
      if (v.value.verdict === 'threshold' && totalable !== true) {
        return refused('MONITOR_METRIC_NOT_ADDITIVE', { detail: 'threshold 仅支持可加指标' })
      }

      const resolved = await resolveMonitorRecipients(deps.pool, deps.org, v.value.recipients)
      if (resolved.to.length === 0) {
        return refused('MONITOR_NO_RECIPIENTS', { excluded: resolved.excluded })
      }

      try {
        const { id } = await createMonitor(deps.pool, v.value)
        await writeAssetAudit(deps.pool, {
          org: deps.org, assetId: `monitor:${id}`, actor: input.createdBy,
          action: 'monitor.create', detail: {
            targetKind: v.value.targetKind, metricId: v.value.metricId ?? null,
            reportId: v.value.reportId ?? null, panelIndex: v.value.panelIndex ?? null,
            verdict: v.value.verdict, recipients: resolved.to,
          },
        })
        // dry_run 恒 true：开启投递必须人到控制台。
        return ok({ id, dryRun: true, recipients: resolved.to })
      } catch (e) {
        if (e instanceof MonitorStoreError) {
          return refused(e.code, { detail: e.message })
        }
        throw e
      }
    }

    return refused('unknown_tool', { name })
  },
}
