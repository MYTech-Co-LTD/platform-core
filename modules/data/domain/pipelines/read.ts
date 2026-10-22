// read.ts —— 提案面两个只读工具的实现（清单 / 详情）。纯读：不写盘、不联网。
//
// 三态纪律（同 runs.ts 的「未知 ≠ 没有」）：
//   ok      —— 读到了，答案就是 payload；
//   unknown —— **读不到**（pipelines 根目录不可读）⇒ isError=false 但明确说「不知道」，
//              绝不回 {status:'ok', count:0}（空清单会被读成「确实没有管线」）；
//   not_found —— 目录读得到、也枚举过了，就是没有这个 id（坏文件在 warnings 里点名）；
//                **非法 id 形态**另带 reason:'invalid_id'，审计可筛（畸形输入 ≠ 确实没有）。
// not_found 在 Task 8 里按 verdict=ok 审计，所以「读不到」绝不能落到 not_found。
//
// 「读不全」不翻 status：ok/not_found 回包里恒有 `incomplete`（'pipelines'|'schedules'|'contracts'），
// 只有**带 source 过滤**且调度面读不全时才答不了（unknown/schedules_incomplete）；
// 契约同 id 重复时另出 `ambiguousContracts`（contractFor 只取第一份 ⇒ contract 可能指错）。
//
// ★ 两个「字段缺席」的语义**相反**，别混用（终审 R1）：
//   · `incomplete` **只在读过之后出现**：`deniedFilter`（bad_param）与 `invalid_id` 两个出口
//     在读之前就返回，故不带该字段 —— 缺席 =「没读，不表态」。**不要**补成 `[]`：那会谎称
//     「三棵树都读全了」，而实际情况是一棵都没读。
//   · `ambiguousContracts` **缺席 = 无歧义**（只有真的同 id 重复才出现），因为它在读之后计算。
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
  /** 三棵树各自的「读不全」信号——缺席的一行不等于不存在（「未知 ≠ 没有」）。 */
  pipelinesIncomplete: boolean
  schedulesIncomplete: boolean
  contractsIncomplete: boolean
  /** 同 id 多份的契约 id（`contractFor` 只取第一份 ⇒ 回包里的 contract 可能是错的）。 */
  contractDuplicates: string[]
  warnings: string[]
}

/** 三份定义一次读完（两个工具共用；每份都自带 warnings 汇总）。 */
export function readAll(deps: PipelineDeps): ReadAll {
  const p = loadPipelines(deps.roots)
  const s = loadSchedules(deps.roots)
  const c = loadContracts(deps.roots)
  return {
    defs: p.defs, schedules: s.byPipeline, contracts: c.contracts, readable: p.readable,
    pipelinesIncomplete: p.incomplete, schedulesIncomplete: s.incomplete,
    contractsIncomplete: c.incomplete, contractDuplicates: c.duplicateIds,
    warnings: [...p.warnings, ...s.warnings, ...c.warnings],
  }
}

/** 读不全的根名（顺序固定，便于断言与阅读）：只列**这次确实没读全**的。 */
const incompleteOf = (all: ReadAll): ('pipelines' | 'schedules' | 'contracts')[] => [
  ...(all.pipelinesIncomplete ? (['pipelines'] as const) : []),
  ...(all.schedulesIncomplete ? (['schedules'] as const) : []),
  ...(all.contractsIncomplete ? (['contracts'] as const) : []),
]

/** 回包里「契约有歧义」的机器通道：只有真的重复时才出现（否则字段缺席 = 无歧义）。 */
const ambiguousOf = (all: ReadAll): { ambiguousContracts?: string[] } =>
  (all.contractDuplicates.length > 0 ? { ambiguousContracts: all.contractDuplicates } : {})

const schedulesOf = (all: ReadAll, id: string, source: string | null): ScheduleEntry[] =>
  (all.schedules.get(id) ?? []).filter((e) => source === null || e.source === source)

/** 读不到 pipelines 根时的统一回包：isError=false（不是调用方的错），但语义是「不知道」。 */
const unreadable = (roots: PipelineRoots, warnings: string[], incomplete: string[]): Record<string, unknown> => ({
  status: 'unknown', reason: 'pipelines_root_unreadable', roots, warnings, incomplete,
})

/**
 * 解析可选的字符串过滤参数（`q` / `source`）。
 * 缺省（undefined / null）与空串 ⇒ 不过滤（回 `null`）；
 * 非字符串或**纯空白串** ⇒ fail closed：静默当成「不过滤」会把一次错误的调用
 * 放大成「所有管线都匹配」，读数的人无从察觉。
 * 有值则**去掉首尾空白**再匹配：`' retail '` 原样匹配只会回 `ok/count:0`，
 * 与「确实没有」同形（同一条不变式）。
 */
const filterOf = (v: unknown): { ok: true; value: string | null } | { ok: false } => {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string' || v.trim() === '') return { ok: false }
  return { ok: true, value: v.trim() }
}

// 读之前就返回 ⇒ 不带 `incomplete`（缺席 = 没读，不是读全；理由见文件头 ★）。
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
      payload: unreadable(deps.roots, all.warnings, incompleteOf(all)),
      isError: false, auditRowCount: null,
    }
  }
  // 带 source 过滤时，调度面读不全就**答不了**这个问题：缺席可能只是没读到。
  // 回 unknown 而不是 ok/count:0 —— 后者会被读成「这个账套没有任何管线」。
  if (source.value !== null && all.schedulesIncomplete) {
    return {
      payload: {
        status: 'unknown', reason: 'schedules_incomplete', source: source.value,
        warnings: all.warnings, incomplete: incompleteOf(all),
      },
      isError: false, auditRowCount: null,
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
      // 清单始终可答（不带 source 过滤时不需要调度面完整）；读不全只作为附注，不改 status。
      incomplete: incompleteOf(all),
      ...ambiguousOf(all),
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: pipelines.length,
  }
}

export const getPipelineImpl: PipelineImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  // 先过 id 形态再读三棵树：非法 id 结构上不可能命中，没必要为它扫盘（也不给它拼路径的机会）。
  // `reason: 'invalid_id'` 是**审计可筛**的机器通道：畸形 id 与「确实没有这个管线」都落在
  // not_found（verdict 仍是 ok），没有 reason 就分不出「有人在打畸形输入」。
  if (!PIPELINE_ID_RE.test(id)) {
    // 同样在读之前返回 ⇒ 不带 `incomplete`（缺席 = 没读；理由见文件头 ★）。
    return {
      payload: { status: 'not_found', id, reason: 'invalid_id' },
      isError: true, auditRowCount: null,
    }
  }
  const all = readAll(deps)
  if (!all.readable) {
    return {
      payload: unreadable(deps.roots, all.warnings, incompleteOf(all)),
      isError: false, auditRowCount: null,
    }
  }
  const def = all.defs.get(id)
  if (def === undefined) {
    // not_found 必须带上 warnings 与 incomplete：目录读得到但**这个文件坏了**（「跳过不可解析的管线」）
    // 与「确实没有这个 id」在读者眼里必须可区分。
    return {
      payload: {
        status: 'not_found', id, incomplete: incompleteOf(all), warnings: all.warnings,
        ...ambiguousOf(all),
      },
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
      incomplete: incompleteOf(all),
      ...ambiguousOf(all),
      ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}),
    },
    isError: false, auditRowCount: null,
  }
}
