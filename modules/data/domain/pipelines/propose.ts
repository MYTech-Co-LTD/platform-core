// propose.ts —— 三件套**草案生成**（D-W3-5）。
//
// ★ 本文件**零写入**：只拼字符串、只读仓内事实（只读枚举 + 只读文件），
//   绝不写任何文件、绝不建分支、绝不调网络。红线（spec §7「不直写 contracts/ duckle/
//   正式目录」）因此是**结构性成立**的——不是靠「记得别写」。
//
// 三件套纪律（contracts/README.md + duckle/README.md）：契约 + 管线 + dbt staging 必须同 PR。
// 本文件生成前两件；第三件（dbt staging 模型）**不机械生成**——它要 var() 前缀、subject_org()、
// read_parquet 的位置参数形态等域内知识（见 dbt/models/lemeng/staging/stg_lemeng_item.sql 头注），
// 机械产出必是错的。故它只进 downstream 清单，由人/后续流程补。
//
// 基线口径（「未知 ≠ 没有」）：契约面 / 管线面读不到时**显式写进 downstream**，
// 绝不把「读不到」静默当成「仓里没有」，也绝不据此断言「这是新表 / 没有受影响管线」。
import { contractFor, loadContracts, loadPipelines, PIPELINE_ID_RE } from './defs'
import type { ContractRef, PipelineDef } from './defs'
import type { PipelineDeps, PipelineImpl } from './types'
import { validateContractDraft, validatePipelineDraft } from './validate'
import type { Issue } from './validate-types'

export interface ProposedFile { path: string; bytes: number; content: string }
export interface DownstreamItem { path: string; why: string }
export interface PipelineProposal {
  title: string
  rationale: string
  branch: string
  pieces: ProposedFile[]
  downstream: DownstreamItem[]
  validation: Issue[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const PIPELINES_DIR = 'deploy/duckle/console/pipelines'

/** 标题 → 分支 slug（只建议，不创建）：小写、非字母数字折成 '-'、折叠、截 40。 */
export function slugOf(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s === '' ? 'change' : s.replace(/-+$/, '')
}

const file = (path: string, content: string): ProposedFile =>
  ({ path, bytes: Buffer.byteLength(content, 'utf8'), content })

/** 契约草案的落点（形态非法时给占位符——validation 已非空，路由片会拒，不会发出占位路径）。 */
const contractPathOf = (domain: string, table: string): string =>
  (DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
    ? `contracts/${domain}/${domain}.${table}.json`
    : 'contracts/<invalid>/<invalid>.json')

/** dbt staging 落点：domain/table 已知才拼实名，否则留占位（不猜）。 */
const stagingPathOf = (domain: string, table: string): string =>
  (DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
    ? `dbt/models/${domain}/staging/stg_${domain}_${table}.sql`
    : 'dbt/models/<域>/staging/stg_<domain>_<table>.sql')

export function buildPipelineProposal(
  deps: PipelineDeps,
  input: { pipeline: unknown; contract?: unknown; title: string; rationale: string },
): PipelineProposal {
  const pipelineId = str((input.pipeline as { name?: unknown } | null | undefined)?.name)
  const nameOk = PIPELINE_ID_RE.test(pipelineId)
  const validation: Issue[] = [
    ...(nameOk ? [] : [{ path: 'pipeline.name', message: '管线名必须是 [A-Za-z0-9_.-] 且非空' }]),
    ...validatePipelineDraft(input.pipeline),
  ]
  const pieces: ProposedFile[] = [file(
    `${PIPELINES_DIR}/${nameOk ? pipelineId : '<invalid>'}.json`,
    `${JSON.stringify(input.pipeline ?? null, null, 2)}\n`,
  )]

  const contractsLoad = loadContracts(deps.roots)
  const baseline = contractsLoad.contracts
  // 契约面读不全（整目录不可读或个别文件坏）：**不许**据此推断「没有契约」。
  const baselineUnknown = contractsLoad.warnings.length > 0
  const existing = nameOk ? contractFor(pipelineId, baseline) : null

  let contractDomain = ''
  let contractTable = ''
  let contractId = ''
  if (input.contract !== undefined) {
    const c = input.contract as { domain?: unknown; table?: unknown } | null | undefined
    contractDomain = str(c?.domain)
    contractTable = str(c?.table)
    contractId = `${contractDomain}.${contractTable}`
    validation.push(...validateContractDraft(input.contract))
    pieces.push(file(contractPathOf(contractDomain, contractTable), `${JSON.stringify(input.contract ?? null, null, 2)}\n`))
  }

  const downstream: DownstreamItem[] = []
  if (input.contract === undefined) {
    if (baselineUnknown) {
      downstream.push({
        path: 'contracts/',
        why: `契约未提供，且契约面读不全（${contractsLoad.warnings.join('；')}）：`
          + '无法确认是否已有契约——未知 ≠ 没有，请先确认基线再提案',
      })
    } else if (existing !== null) {
      downstream.push({
        path: existing.path,
        why: '契约未提供：请确认沿用现有契约；若列集变了必须同 PR 改它（三件套之一）',
      })
    } else {
      downstream.push({
        path: 'contracts/<domain>/<domain>.<table>.json',
        why: '契约未提供：新表必须先有契约（三件套之一）',
      })
    }
  } else if (!baselineUnknown && contractId !== '' && baseline.some((c) => c.id === contractId)) {
    // 基线读得到且同名契约已存在 ⇒ 这是**改**它，不是新增；说清楚，别让人以为是新文件。
    downstream.push({
      path: contractPathOf(contractDomain, contractTable),
      why: '契约已存在（基线里有同名契约）：本提案是修改它，列集/类型/布局变更需与下游同 PR 核对',
    })
  }

  // 域/表从已知信息推：本次带的契约 > 该管线现有契约 > 占位（不猜）。
  const stagedDomain = contractDomain !== '' && contractTable !== '' ? contractDomain : (existing?.domain ?? '')
  const stagedTable = contractDomain !== '' && contractTable !== '' ? contractTable : (existing?.table ?? '')
  downstream.push({
    path: stagingPathOf(stagedDomain, stagedTable),
    why: 'dbt staging 模型（三件套之一）：需按域内既有形态手写，不机械生成',
  })

  return {
    title: input.title, rationale: input.rationale,
    branch: `proposal/${slugOf(input.title)}`, pieces, downstream, validation,
  }
}

export function buildContractProposal(
  deps: PipelineDeps,
  input: { contract: unknown; title: string; rationale: string },
): PipelineProposal {
  const c = input.contract as { domain?: unknown; table?: unknown } | null | undefined
  const domain = str(c?.domain)
  const table = str(c?.table)
  const validation = validateContractDraft(input.contract)
  const path = contractPathOf(domain, table)

  const pipelinesLoad = loadPipelines(deps.roots)
  const contractsLoad = loadContracts(deps.roots)
  const baseline = contractsLoad.contracts
  const targetId = DOMAIN_RE.test(domain) && DOMAIN_RE.test(table) ? `${domain}.${table}` : ''

  const downstream: DownstreamItem[] = []
  if (!pipelinesLoad.readable) {
    // 读不到管线面 ≠ 没有受影响管线：必须显式说出来，否则读者会把「空」当结论。
    downstream.push({
      path: `${PIPELINES_DIR}/`,
      why: `管线目录不可读（${pipelinesLoad.warnings.join('；')}）：`
        + '无法反查受影响管线——未知 ≠ 没有受影响管线',
    })
  } else if (targetId === '') {
    downstream.push({
      path: `${PIPELINES_DIR}/`,
      why: '契约 domain/table 形态非法，无法反查受影响管线（先修 validation 再提案）',
    })
  } else {
    // 反查分两档（都用 contractFor，与 check 面同一命名约定）：
    //   ① 直接写入者：管线当前解析到的契约就是它（或 id 以它为前缀）；
    //   ② 同域候选：本域契约变更可能波及，但不是直接写入者——是否受影响由人判定。
    // 有①就只列①（精确）；没有①才退回②并标明「同域候选」，绝不把②说成「受影响」。
    const direct: { def: PipelineDef; current: ContractRef | null }[] = []
    const sameDomain: { def: PipelineDef; current: ContractRef | null }[] = []
    for (const def of [...pipelinesLoad.defs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const current = contractFor(def.id, baseline)
      const isDirect = current?.id === targetId || def.id === targetId || def.id.startsWith(`${targetId}.`)
      if (isDirect) direct.push({ def, current })
      else if (def.id.startsWith(`${domain}.`) || current?.domain === domain) sameDomain.push({ def, current })
    }
    const chosen = direct.length > 0 ? direct : sameDomain
    for (const { def, current } of chosen) {
      downstream.push({
        path: `${PIPELINES_DIR}/${def.id}.json`,
        why: direct.length > 0
          ? `该管线解析到本契约（${current?.id ?? targetId}）：列集/类型/布局变更需同步核对`
          : `同域候选（当前解析到 ${current?.id ?? '无契约'}）：不是直接写入者，本域契约变更是否波及需人工判定`,
      })
    }
    if (chosen.length === 0) {
      downstream.push({
        path: `${PIPELINES_DIR}/`,
        why: `未找到引用该契约的管线（已枚举 ${pipelinesLoad.defs.size} 个）：新增表时属正常，不是「没有影响」的断言`,
      })
    }
  }

  downstream.push({
    path: stagingPathOf(domain, table),
    why: 'staging 模型按契约列集取列：契约变了要同步',
  })
  downstream.push({
    path: 'dbt/semantics/l1_metrics.yml',
    why: '若该表参与了 L1 口径，语义声明可能要跟着改',
  })
  if (contractsLoad.warnings.length > 0) {
    downstream.push({
      path: 'contracts/',
      why: `契约面读不全（${contractsLoad.warnings.join('；')}）：受影响判定可能不完整——未知 ≠ 没有`,
    })
  }

  return {
    title: input.title, rationale: input.rationale,
    branch: `proposal/${slugOf(input.title)}`,
    pieces: [file(path, `${JSON.stringify(input.contract ?? null, null, 2)}\n`)],
    downstream,
    validation,
  }
}

// ── 两个工具实现（路由片把 validation 非空翻译成 refused/invalid_draft）──────────────────
const NOTE = '草案只在本回包里：本服务不落盘、不开 PR。应用方式由人决定（红线：不直写正式目录）。'

const badParam = (): { payload: Record<string, unknown>; isError: true; auditRowCount: null } => ({
  payload: { status: 'denied', reason: 'bad_param', detail: 'title/rationale 必填' },
  isError: true, auditRowCount: null,
})

const textArg = (v: unknown, max: number): string =>
  (typeof v === 'string' && v !== '' ? v.slice(0, max) : '')

const okPayload = (p: PipelineProposal): {
  payload: Record<string, unknown>; isError: false; auditRowCount: null
} => ({
  payload: {
    status: 'ok', title: p.title, rationale: p.rationale, branch: p.branch,
    pieces: p.pieces.map((x) => ({ path: x.path, bytes: x.bytes, content: x.content })),
    downstream: p.downstream,
    note: NOTE,
  },
  isError: false, auditRowCount: null,
})

const refused = (issues: Issue[]): {
  payload: Record<string, unknown>; isError: true; auditRowCount: null
} => ({
  payload: { status: 'refused', reason: 'invalid_draft', issues },
  isError: true, auditRowCount: null,
})

export const proposePipelineChangeImpl: PipelineImpl = async (deps, args) => {
  const title = textArg(args.title, 120)
  const rationale = typeof args.rationale === 'string' ? args.rationale : ''
  if (title === '' || rationale === '') return badParam()
  const p = buildPipelineProposal(deps, {
    pipeline: args.pipeline, contract: args.contract, title, rationale,
  })
  return p.validation.length > 0 ? refused(p.validation) : okPayload(p)
}

export const proposeContractChangeImpl: PipelineImpl = async (deps, args) => {
  const title = textArg(args.title, 120)
  const rationale = typeof args.rationale === 'string' ? args.rationale : ''
  if (title === '' || rationale === '') return badParam()
  const p = buildContractProposal(deps, { contract: args.contract, title, rationale })
  return p.validation.length > 0 ? refused(p.validation) : okPayload(p)
}
