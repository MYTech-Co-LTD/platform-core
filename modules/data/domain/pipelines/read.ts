// read.ts —— 提案面两个只读工具的实现（清单 / 详情）。纯读：不写盘、不联网。
import {
  contractFor, loadContracts, loadPipelines, loadSchedules, PIPELINE_ID_RE,
} from './defs'
import type { ContractRef, PipelineDef, ScheduleEntry } from './defs'
import { validatePipelineDraft } from './validate'
// 共享类型住在 types.ts（Task 4 建），此处只取用并对外转出，避免与 runs.ts 形成类型循环。
import type { PipelineDeps, PipelineImpl } from './types'

export type { PipelineDeps, PipelineImpl } from './types'

export interface ReadAll {
  defs: Map<string, PipelineDef>
  schedules: Map<string, ScheduleEntry[]>
  contracts: ContractRef[]
  warnings: string[]
}

/** 三份定义一次读完（两个工具共用；每份都自带 warnings 汇总）。 */
export function readAll(deps: PipelineDeps): ReadAll {
  const p = loadPipelines(deps.roots)
  const s = loadSchedules(deps.roots)
  const c = loadContracts(deps.roots)
  return {
    defs: p.defs, schedules: s.byPipeline, contracts: c.contracts,
    warnings: [...p.warnings, ...s.warnings, ...c.warnings],
  }
}

const schedulesOf = (all: ReadAll, id: string, source: string | null): ScheduleEntry[] =>
  (all.schedules.get(id) ?? []).filter((e) => source === null || e.source === source)

export const listPipelinesImpl: PipelineImpl = async (deps, args) => {
  const all = readAll(deps)
  const q = typeof args.q === 'string' && args.q !== '' ? args.q.toLowerCase() : null
  const source = typeof args.source === 'string' && args.source !== '' ? args.source : null
  const pipelines = [...all.defs.values()]
    .filter((d) => q === null || d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
    .filter((d) => source === null || schedulesOf(all, d.id, source).length > 0)
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
  const all = readAll(deps)
  const def = PIPELINE_ID_RE.test(id) ? all.defs.get(id) : undefined
  if (def === undefined) {
    return { payload: { status: 'not_found', id }, isError: true, auditRowCount: null }
  }
  const contract = contractFor(def.id, all.contracts)
  return {
    payload: {
      status: 'ok', id: def.id, name: def.name, version: def.version,
      nodes: def.counts, lakeKeys: def.lakeKeys,
      schedules: schedulesOf(all, def.id, null),
      contract: contract === null ? null : {
        id: contract.id, path: contract.path, columns: contract.columns,
      },
      validation: validatePipelineDraft(def.doc),
      definition: def.doc,
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: null,
  }
}
