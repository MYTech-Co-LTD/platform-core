// read.ts —— 提案面两个只读工具的实现（清单 / 详情）。纯读：不写盘、不联网。
//
// 三态纪律（同 runs.ts 的「未知 ≠ 没有」）：
//   ok      —— 读到了，答案就是 payload；
//   unknown —— **读不到**（pipelines 根目录不可读）⇒ isError=false 但明确说「不知道」，
//              绝不回 {status:'ok', count:0}（空清单会被读成「确实没有管线」）；
//   not_found —— 目录读得到、也枚举过了，就是没有这个 id（坏文件在 warnings 里点名）。
// not_found 在 Task 8 里按 verdict=ok 审计，所以「读不到」绝不能落到 not_found。
import {
  contractFor, loadContracts, loadPipelines, loadSchedules, PIPELINE_ID_RE,
} from './defs'
import type { ContractRef, PipelineDef, PipelineRoots, ScheduleEntry } from './defs'
import { validatePipelineDraft } from './validate'
// 共享类型住在 types.ts（Task 4 建），此处只取用并对外转出，避免与 runs.ts 形成类型循环。
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineDeps, PipelineImpl } from './types'

export interface ReadAll {
  defs: Map<string, PipelineDef>
  schedules: Map<string, ScheduleEntry[]>
  contracts: ContractRef[]
  /** pipelines 根目录是否读得到（`loadPipelines` 的显式信号，不靠 warnings 文本反推）。 */
  readable: boolean
  warnings: string[]
}

/** 三份定义一次读完（两个工具共用；每份都自带 warnings 汇总）。 */
export function readAll(deps: PipelineDeps): ReadAll {
  const p = loadPipelines(deps.roots)
  const s = loadSchedules(deps.roots)
  const c = loadContracts(deps.roots)
  return {
    defs: p.defs, schedules: s.byPipeline, contracts: c.contracts, readable: p.readable,
    warnings: [...p.warnings, ...s.warnings, ...c.warnings],
  }
}

const schedulesOf = (all: ReadAll, id: string, source: string | null): ScheduleEntry[] =>
  (all.schedules.get(id) ?? []).filter((e) => source === null || e.source === source)

/** 读不到 pipelines 根时的统一回包：isError=false（不是调用方的错），但语义是「不知道」。 */
const unreadable = (roots: PipelineRoots, warnings: string[]): Record<string, unknown> => ({
  status: 'unknown', reason: 'pipelines_root_unreadable', roots, warnings,
})

/**
 * 解析可选的字符串过滤参数（`q` / `source`）。
 * 缺省（undefined / null）与空串 ⇒ 不过滤（回 `null`）；
 * 非字符串或**纯空白串** ⇒ fail closed：静默当成「不过滤」会把一次错误的调用
 * 放大成「所有管线都匹配」，读数的人无从察觉。
 */
const filterOf = (v: unknown): { ok: true; value: string | null } | { ok: false } => {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string' || v.trim() === '') return { ok: false }
  return { ok: true, value: v }
}

const deniedFilter = (): { payload: Record<string, unknown>; isError: true; auditRowCount: null } => ({
  payload: { status: 'denied', reason: 'bad_param', detail: 'invalid_filter' },
  isError: true, auditRowCount: null,
})

export const listPipelinesImpl: PipelineImpl = async (deps, args) => {
  const q = filterOf(args.q)
  const source = filterOf(args.source)
  if (!q.ok || !source.ok) return deniedFilter()
  const all = readAll(deps)
  if (!all.readable) {
    return {
      payload: unreadable(deps.roots, all.warnings), isError: false, auditRowCount: null,
    }
  }
  const needle = q.value === null ? null : q.value.toLowerCase()
  const pipelines = [...all.defs.values()]
    .filter((d) => needle === null || d.id.toLowerCase().includes(needle) || d.name.toLowerCase().includes(needle))
    .filter((d) => source.value === null || schedulesOf(all, d.id, source.value).length > 0)
    .map((d) => ({
      id: d.id, name: d.name, version: d.version, nodes: d.counts,
      lakeKeys: d.lakeKeys.length,
      schedules: schedulesOf(all, d.id, null),
      contractId: contractFor(d.id, all.contracts)?.id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    payload: {
      status: 'ok', count: pipelines.length, pipelines,
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: pipelines.length,
  }
}

export const getPipelineImpl: PipelineImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  // 先过 id 形态再读三棵树：非法 id 结构上不可能命中，没必要为它扫盘（也不给它拼路径的机会）。
  if (!PIPELINE_ID_RE.test(id)) {
    return { payload: { status: 'not_found', id }, isError: true, auditRowCount: null }
  }
  const all = readAll(deps)
  if (!all.readable) {
    return {
      payload: unreadable(deps.roots, all.warnings), isError: false, auditRowCount: null,
    }
  }
  const def = all.defs.get(id)
  if (def === undefined) {
    // not_found 必须带上 warnings：目录读得到但**这个文件坏了**（「跳过不可解析的管线」）
    // 与「确实没有这个 id」在读者眼里必须可区分。
    return {
      payload: { status: 'not_found', id, warnings: all.warnings },
      isError: true, auditRowCount: null,
    }
  }
  const contract = contractFor(def.id, all.contracts)
  return {
    payload: {
      status: 'ok', id: def.id, name: def.name, version: def.version,
      nodes: def.counts, lakeKeys: def.lakeKeys,
      schedules: schedulesOf(all, def.id, null),
      // 投影是有损的（无 layout / 无列名），字段名必须说真话：这里是列数，不是列清单。
      contract: contract === null ? null : {
        id: contract.id, path: contract.path, columnCount: contract.columns,
      },
      validation: validatePipelineDraft(def.doc),
      definition: def.doc,
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: null,
  }
}
