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
import type { ToolImplResult } from '../toolbox/registry'
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineRunRecord, PipelineRunSource } from './types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const NOT_WIRED = 'runs_source_not_wired'
const NOTE = '运行记录住在 duckle console 的 per-账套 workspace 卷（/workspace/runs/），'
  + '本服务容器不可达（跨 compose 项目 + 回环端口）。未知 ≠ 没有失败——不要当成「没跑过」。'

const limitOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return DEFAULT_LIMIT
  return Math.min(v, MAX_LIMIT)
}

const notWired = (extra: Record<string, unknown> = {}): ToolImplResult => ({
  payload: { status: 'unknown', reason: NOT_WIRED, note: NOTE, ...extra },
  isError: false, auditRowCount: null,
})

export const listPipelineRunsImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const limit = limitOf(args.limit)
  const pipelineId = typeof args.pipelineId === 'string' && args.pipelineId !== '' ? args.pipelineId : undefined
  if (deps.runs === null) return notWired({ pipelineId: pipelineId ?? null, limit })
  const runs = await deps.runs({ pipelineId, limit })
  return {
    payload: { status: 'ok', count: runs.length, limit, runs },
    isError: false, auditRowCount: runs.length,
  }
}

export const getPipelineRunImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (runId === '') {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'runId_required' }, isError: true, auditRowCount: null }
  }
  if (deps.runs === null) return notWired({ runId })
  const hits = await deps.runs({ limit: MAX_LIMIT })
  const run = hits.find((r) => r.runId === runId)
  if (run === undefined) return { payload: { status: 'not_found', runId }, isError: true, auditRowCount: null }
  return { payload: { status: 'ok', run }, isError: false, auditRowCount: null }
}
