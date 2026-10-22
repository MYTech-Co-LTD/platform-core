// runs.ts —— 管线运行记录的**只读 seam**（D-W3-3）。
//
// 为什么本轮只有 seam：真实运行记录住在 duckle console 的 **per-账套 Docker 命名卷**
// （/workspace/runs/<pipeline_id>.json，留 50 条；/workspace/runs/receipts/ 留 200 条，
// 见 deploy/duckle/console/README.md §排障入口）。platform-core 的 server 容器既看不到那个卷，
// 也够不到 consoles 的回环端口（127.0.0.1:18080/18081，跨 compose 项目、openship 不建模
// extra_hosts 且硬拒 host 网络）⇒ 本轮无路可达。
//
// seam 为 null ⇒ 回 **显式 unknown**，绝不回空数组：空数组会被读成
// 「跑过、且一条都没问题」——这跟「读不到」是两件事（同 get_quality 的纪律）。
// 同一纪律延伸到接通后：console 每管线只留 50 条，扫描窗口打满时「没找到」不可证 ⇒
// 回 unknown（runs_window_saturated），只有窗口未满才敢回 not_found。
import type { ToolImplResult } from '../toolbox/registry'
import { PIPELINE_ID_RE } from './defs'
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineRunRecord, PipelineRunSource } from './types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const NOT_WIRED = 'runs_source_not_wired'
const NOTE = '运行记录住在 duckle console 的 per-账套 workspace 卷（/workspace/runs/），'
  + '本服务容器不可达（跨 compose 项目 + 回环端口）。未知 ≠ 没有失败——不要当成「没跑过」。'

// 窗口饱和时的说明：per-管线卷留 50 条，全量扫描也是 50 条 ⇒ 窗口打满就等于「可能还有更早的没看到」。
const SATURATED_NOTE = `扫描窗口只有 ${MAX_LIMIT} 条（duckle console 的 per-管线保留量）。`
  + '窗口已打满 ⇒ 更早的运行记录看不到，缺席不能证明不存在。未知 ≠ 没跑过。'

const limitOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return DEFAULT_LIMIT
  return Math.min(v, MAX_LIMIT)
}

const denied = (detail: string): ToolImplResult => ({
  payload: { status: 'denied', reason: 'bad_param', detail },
  isError: true, auditRowCount: null,
})

/**
 * 解析可选的 `pipelineId` 过滤参数。缺省（undefined / null）⇒ 不过滤，回 `null`；
 * 其余一律必须过 PIPELINE_ID_RE，否则 fail closed（denied）——`typeof === 'string'` 松判会把
 * 数字等非法值静默放宽成「所有管线」，而 seam 未来按 `<pipeline_id>.json` 拼路径时更要挡注入。
 */
const pipelineIdOf = (v: unknown): { ok: true; value: string | undefined } | { ok: false } => {
  if (v === undefined || v === null) return { ok: true, value: undefined }
  if (typeof v !== 'string' || !PIPELINE_ID_RE.test(v)) return { ok: false }
  return { ok: true, value: v }
}

const notWired = (extra: Record<string, unknown> = {}): ToolImplResult => ({
  payload: { status: 'unknown', reason: NOT_WIRED, note: NOTE, ...extra },
  isError: false, auditRowCount: null,
})

export const listPipelineRunsImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const limit = limitOf(args.limit)
  const id = pipelineIdOf(args.pipelineId)
  if (!id.ok) return denied('invalid_pipeline_id')
  const pipelineId = id.value
  const applied = pipelineId ?? null
  if (deps.runs === null) return notWired({ pipelineId: applied, limit })
  const runs = await deps.runs({ pipelineId, limit })
  return {
    payload: { status: 'ok', count: runs.length, limit, pipelineId: applied, scanned: runs.length, runs },
    isError: false, auditRowCount: runs.length,
  }
}

export const getPipelineRunImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (runId === '') return denied('runId_required')
  const id = pipelineIdOf(args.pipelineId)
  if (!id.ok) return denied('invalid_pipeline_id')
  const pipelineId = id.value
  const applied = pipelineId ?? null
  if (deps.runs === null) return notWired({ runId, pipelineId: applied })
  const hits = await deps.runs({ pipelineId, limit: MAX_LIMIT })
  const scanned = hits.length
  const run = hits.find((r) => r.runId === runId)
  if (run !== undefined) {
    return { payload: { status: 'ok', run, pipelineId: applied, scanned }, isError: false, auditRowCount: null }
  }
  // 窗口打满 ⇒ 缺席不可证：回 unknown，不回 not_found（否则把「看不到」说成「没跑过」）。
  if (scanned === MAX_LIMIT) {
    return {
      payload: {
        status: 'unknown', reason: 'runs_window_saturated', note: SATURATED_NOTE,
        runId, pipelineId: applied, scanned, limit: MAX_LIMIT,
      },
      isError: false, auditRowCount: null,
    }
  }
  return {
    payload: { status: 'not_found', reason: 'not_found', runId, pipelineId: applied, scanned },
    isError: true, auditRowCount: null,
  }
}
