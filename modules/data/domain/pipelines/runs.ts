// runs.ts —— 管线运行记录的**只读工具**（D-W3-3 / #1001）。
//
// 数据源：duckle console 的 per-账套 workspace 卷里的 `runs/` 目录，部署期以 `:ro`
// bind mount 挂进本容器（`DATA_RUN_DIRS=<账套>=<目录>,…`）。文件形状与读源纪律见 run-source.ts。
// 为什么不是 HTTP / 控制面 API：console 的 /api/runs 不带 runId、只覆盖已登记管线，
// 端口只绑回环（跨 compose 项目不可达）；控制面也没有这份数据。
//
// 三条语义（本期新增的两条与既有 seam 纪律一脉相承）：
//   · **未配置 ⇒ seam**：`DATA_RUN_DIRS` 缺失时回 `unknown/runs_source_not_wired`，绝不回空数组；
//   · **配置了但读不到 ⇒ unknown/runs_source_unreadable**（带上游摘要），不落成 ok/空；
//   · **窗口饱和 ⇒ unknown**：per-管线卷只留 50 条，打满时「没找到」不可证，只有未满才敢回
//     not_found（run-source 用 `absenceProven` 把这个判断交给来源，本文件只做映射）。
import type { ToolImplResult } from '../toolbox/registry'
import { PIPELINE_ID_RE, RUN_ID_RE } from './defs'
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineRunRecord, PipelineRunSource } from './types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const NOT_WIRED = 'runs_source_not_wired'
const UNREADABLE = 'runs_source_unreadable'
const SATURATED = 'runs_window_saturated'

const NOTE = '运行记录住在 duckle console 的 per-账套 workspace 卷（runs/），'
  + '本服务未配置只读挂载（DATA_RUN_DIRS）。未知 ≠ 没有失败——不要当成「没跑过」。'

const UNREADABLE_NOTE = '运行记录来源已配置但读不到（目录不存在/无权限/配置畸形）。'
  + '读不到不等于没跑过——不要当成空结果。'

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
 * 解析 `list_pipeline_runs` 的可选 `pipelineId` 过滤参数。
 * 缺省（undefined / null，以及空串——schema 未声明 minLength 故空串是 schema 合法值）⇒ 不过滤，回 `null`；
 * 其余一律必须过 PIPELINE_ID_RE，否则 fail closed（denied）——`typeof === 'string'` 松判会把
 * 数字等非法值静默放宽成「所有管线」，而来源按 `<pipeline_id>.json` 拼路径时更要挡注入。
 */
const pipelineIdOf = (v: unknown): { ok: true; value: string | undefined } | { ok: false } => {
  if (v === undefined || v === null || v === '') return { ok: true, value: undefined }
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
  const res = await deps.runs.list({ pipelineId, limit })
  const base = { limit, pipelineId: applied, scanned: res.scanned, truncated: res.truncated }
  const warnings = res.warnings.length === 0 ? {} : { warnings: res.warnings }
  const incomplete = res.unreadable.map((u) => u.workspace)
  // 一条都没读到、且有来源不可读 ⇒ 读不到（unknown），不能回 ok/count:0。
  if (res.unreadable.length > 0 && res.runs.length === 0) {
    return {
      payload: {
        status: 'unknown', reason: UNREADABLE, note: UNREADABLE_NOTE,
        upstream: res.unreadable, incomplete, ...base, ...warnings,
      },
      isError: false, auditRowCount: null,
    }
  }
  // 部分来源不可读但读到了记录 ⇒ ok + incomplete 点名（答案可信但不完整）。
  return {
    payload: {
      status: 'ok', count: res.runs.length, runs: res.runs, ...base,
      ...(res.unreadable.length > 0 ? { incomplete, upstream: res.unreadable } : {}),
      ...warnings,
    },
    isError: false, auditRowCount: res.runs.length,
  }
}

export const getPipelineRunImpl: PipelineImpl = async (deps: PipelineDeps, args) => {
  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (runId === '') return denied('runId_required')
  // 来源要把它拼进 receipts/<runId>.json ⇒ 先按 RUN_ID_RE 判（无 `/`、不以 `.` 开头），触盘前拒绝。
  if (!RUN_ID_RE.test(runId)) return denied('invalid_run_id')
  // 只声明了 runId（tools.ts required:['runId']）⇒ 这里不消费 args.pipelineId：
  // tools/call 不校验入参，接受未声明参数会造出「schema 未写但行为不同」的两套语义。
  if (deps.runs === null) return notWired({ runId, pipelineId: null })
  const res = await deps.runs.get(runId)
  const base = {
    runId, pipelineId: null, scanned: res.scanned,
    ...(res.warnings.length === 0 ? {} : { warnings: res.warnings }),
  }
  if (res.run !== null) {
    return {
      payload: {
        status: 'ok', run: res.run, ...base,
        ...(res.receipt === undefined ? {} : { detail: res.receipt }),
      },
      isError: false, auditRowCount: null,
    }
  }
  // 读不到优先于饱和：来源不可读时连「窗口满没满」都不知道。
  if (res.unreadable.length > 0) {
    return {
      payload: {
        status: 'unknown', reason: UNREADABLE, note: UNREADABLE_NOTE,
        upstream: res.unreadable, incomplete: res.unreadable.map((u) => u.workspace),
        limit: MAX_LIMIT, ...base,
      },
      isError: false, auditRowCount: null,
    }
  }
  // 窗口打满 ⇒ 缺席不可证：回 unknown，不回 not_found（否则把「看不到」说成「没跑过」）。
  if (!res.absenceProven) {
    return {
      payload: { status: 'unknown', reason: SATURATED, note: SATURATED_NOTE, limit: MAX_LIMIT, ...base },
      isError: false, auditRowCount: null,
    }
  }
  return {
    payload: { status: 'not_found', reason: 'not_found', ...base },
    isError: true, auditRowCount: null,
  }
}
