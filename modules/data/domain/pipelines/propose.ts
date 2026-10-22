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
// 契约落点口径（contracts/README.md §1，**不是** `contracts/<domain>/…`）：
//   · 基线里已有同 id 契约 ⇒ **用它真实的 path**（`common/` 还是 `customers/<客户>/` 由基线说了算，
//     本文件不猜）；猜错会造出第二份同 id 契约，被 `contractFor` 的等长取首规则静默遮蔽。
//   · 基线里没有 ⇒ `contracts/common/<domain>.<table>.json`（正典的「新源」位置）。
//   · **永不合成 `contracts/customers/<客户>/`**：客户不是入参能知道的。
//
// 基线口径（「未知 ≠ 没有」）：契约面 / 管线面读不到**或读不全**时，出 `kind:'unknown'`
// 下游项显式声明——绝不把「读不到」静默当成「仓里没有」，也绝不据此断言
// 「这是新表 / 没有受影响管线」。
import { contractFor, loadContracts, loadPipelines, PIPELINE_ID_RE } from './defs'
import type { ContractRef, PipelineDef } from './defs'
import type { PipelineDeps, PipelineImpl } from './types'
import { validateContractDraft, validatePipelineDraft } from './validate'
import type { Issue } from './validate-types'

export interface ProposedFile { path: string; bytes: number; content: string }

/** 下游项的**机器可判**档位（消费方常是读 structuredContent 的 agent，不能只靠中文措辞区分）。 */
export type DownstreamKind =
  | 'required'   // 必做件：三件套里还缺/要一起改的（dbt staging、契约、语义声明）
  | 'affected'   // 已确认受影响：反查命中的直接写入者（事实）
  | 'candidate'  // 同域候选：不是直接写入者，是否受影响需人判定（猜测，聚合为一条）
  | 'unknown'    // 基线读不到/读不全：无法判定（未知 ≠ 没有）

export interface DownstreamItem { path: string; why: string; kind: DownstreamKind }

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
const CONTRACTS_DIR = 'contracts'
/** 标题/理由的长度上限：两者都会进审计与回包，不设界就是把入参原样放大。 */
const MAX_TITLE = 120
const MAX_RATIONALE = 500

/** 标题 → 分支 slug（只建议，不创建）：去空白、小写、非字母数字折 '-'、折叠、截 40。 */
export function slugOf(title: string): string {
  const s = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s === '' ? 'change' : s.replace(/-+$/, '')
}

const file = (path: string, content: string): ProposedFile =>
  ({ path, bytes: Buffer.byteLength(content, 'utf8'), content })

/**
 * 契约草案的落点：**基线里有同 id 就照抄它的 path**（可能是 customers/<客户>/），
 * 否则落正典的 `contracts/common/<domain>.<table>.json`。形态非法时给占位符——
 * 此时 validation 已非空、路由片会拒，占位路径不会发出去。
 */
const contractPathFor = (domain: string, table: string, existing: ContractRef | null): string => {
  if (existing !== null) return existing.path
  return DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
    ? `${CONTRACTS_DIR}/common/${domain}.${table}.json`
    : `${CONTRACTS_DIR}/common/<invalid>.<invalid>.json`
}

/** dbt staging 落点：domain/table 已知才拼实名，否则留占位（不猜）。 */
const stagingPathOf = (domain: string, table: string): string =>
  (DOMAIN_RE.test(domain) && DOMAIN_RE.test(table)
    ? `dbt/models/${domain}/staging/stg_${domain}_${table}.sql`
    : 'dbt/models/<域>/staging/stg_<domain>_<table>.sql')

/** 基线里按 id 精确查契约（`contractFor` 是「前缀最长」，语义不同，别混用）。 */
const contractById = (id: string, contracts: readonly ContractRef[]): ContractRef | null =>
  (id === '' ? null : contracts.find((c) => c.id === id) ?? null)

/** 该管线是否**直接写入**目标契约（两种证据，措辞必须区分，见下）。 */
interface DirectHit { def: PipelineDef; basis: string }
interface DirectLookup { direct: DirectHit[]; sameDomainIds: string[] }

const lookupPipelines = (
  defs: Iterable<PipelineDef>, contracts: readonly ContractRef[], domain: string, targetId: string,
): DirectLookup => {
  const direct: DirectHit[] = []
  const sameDomainIds: string[] = []
  for (const def of [...defs].sort((a, b) => a.id.localeCompare(b.id))) {
    const current = contractFor(def.id, contracts)
    const prefixHit = def.id === targetId || def.id.startsWith(`${targetId}.`)
    // 前缀命中只有在「没有更长契约抢走它」时才算直接写入者：否则按 contractFor 的最长前缀语义，
    // 该管线写的是更具体的另一张表（例如契约 `lemeng.a.b` 存在 ⇒ 管线 `lemeng.a.b.c` 不写 `a`）。
    const prefixDirect = prefixHit && (current === null || targetId.length > current.id.length)
    if (current?.id === targetId) {
      direct.push({ def, basis: `其当前契约即 ${current.id}` })
    } else if (prefixDirect) {
      // 说清楚命中的是「id 相等」还是「id 前缀」——两种证据不是一回事。
      direct.push({
        def,
        basis: def.id === targetId
          ? `其管线 id 即契约 id（${def.id}）：按命名约定写入该表`
          : `其管线 id 以契约 id 为前缀（${def.id}）：按命名约定写入该表`,
      })
    } else if (def.id.startsWith(`${domain}.`) || current?.domain === domain) {
      sameDomainIds.push(def.id)
    }
  }
  return { direct, sameDomainIds }
}

export function buildPipelineProposal(
  deps: PipelineDeps,
  input: { pipeline: unknown; contract?: unknown; title: string; rationale: string },
): PipelineProposal {
  const pipelineId = str((input.pipeline as { name?: unknown } | null | undefined)?.name)
  const nameOk = PIPELINE_ID_RE.test(pipelineId)
  const validation: Issue[] = [
    // path 是草案内 JSON 路径（不是参数名）：与 get_pipeline 的 validation 同一形态。
    ...(nameOk ? [] : [{ path: 'name', message: '管线名必须是 [A-Za-z0-9_.-] 且非空' }]),
    ...validatePipelineDraft(input.pipeline),
  ]
  const pieces: ProposedFile[] = [file(
    `${PIPELINES_DIR}/${nameOk ? pipelineId : '<invalid>'}.json`,
    `${JSON.stringify(input.pipeline ?? null, null, 2)}\n`,
  )]

  const contractsLoad = loadContracts(deps.roots)
  const baseline = contractsLoad.contracts
  // 契约面读不全（整目录不可读，或个别文件坏）：**不许**据此推断「没有契约」。
  // 这条与「是否带了契约草案」无关——带了也照样说不出基线长什么样。
  const baselineIncomplete = contractsLoad.warnings.length > 0
  const existingForPipeline = nameOk ? contractFor(pipelineId, baseline) : null

  let contractDomain = ''
  let contractTable = ''
  let suppliedExisting: ContractRef | null = null
  if (input.contract !== undefined) {
    const c = input.contract as { domain?: unknown; table?: unknown } | null | undefined
    contractDomain = str(c?.domain)
    contractTable = str(c?.table)
    const suppliedId = DOMAIN_RE.test(contractDomain) && DOMAIN_RE.test(contractTable)
      ? `${contractDomain}.${contractTable}`
      : ''
    suppliedExisting = contractById(suppliedId, baseline)
    validation.push(...validateContractDraft(input.contract))
    pieces.push(file(
      contractPathFor(contractDomain, contractTable, suppliedExisting),
      `${JSON.stringify(input.contract ?? null, null, 2)}\n`,
    ))
  }

  const downstream: DownstreamItem[] = []
  if (baselineIncomplete) {
    downstream.push({
      path: `${CONTRACTS_DIR}/`,
      kind: 'unknown',
      why: `契约面读不全（${contractsLoad.warnings.join('；')}）：无法确认基线里是否已有这份契约——`
        + '未知 ≠ 没有，请先确认基线再提案',
    })
  }
  if (input.contract === undefined) {
    // 「新表必须先有契约」这句话只有**基线完整**时才敢说（否则是拿未知当没有）。
    if (!baselineIncomplete) {
      downstream.push(existingForPipeline !== null
        ? {
          path: existingForPipeline.path,
          kind: 'required',
          why: '契约未提供：请确认沿用现有契约；若列集变了必须同 PR 改它（三件套之一）',
        }
        : {
          path: `${CONTRACTS_DIR}/common/<domain>.<table>.json`,
          kind: 'required',
          why: '契约未提供：新表必须先有契约（三件套之一）',
        })
    }
  } else if (suppliedExisting !== null) {
    // 基线里有同 id 契约 ⇒ 这是**改**它，不是新增；说清楚，别让人以为是新文件。
    downstream.push({
      path: suppliedExisting.path,
      kind: 'required',
      why: '契约已存在（基线里有同 id 契约）：本提案是修改它，列集/类型/布局变更需与下游同 PR 核对',
    })
  }

  // 域/表从已知信息推：本次带的契约 > 该管线现有契约 > 占位（不猜）。
  const haveSupplied = DOMAIN_RE.test(contractDomain) && DOMAIN_RE.test(contractTable)
  downstream.push({
    path: stagingPathOf(
      haveSupplied ? contractDomain : (existingForPipeline?.domain ?? ''),
      haveSupplied ? contractTable : (existingForPipeline?.table ?? ''),
    ),
    kind: 'required',
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

  const pipelinesLoad = loadPipelines(deps.roots)
  const contractsLoad = loadContracts(deps.roots)
  const baseline = contractsLoad.contracts
  const targetId = DOMAIN_RE.test(domain) && DOMAIN_RE.test(table) ? `${domain}.${table}` : ''
  // 基线里已有同 id ⇒ 用它的真实 path（common/ 或 customers/<客户>/ 由基线决定，不猜）。
  const path = contractPathFor(domain, table, contractById(targetId, baseline))

  const downstream: DownstreamItem[] = []
  if (!pipelinesLoad.readable) {
    // 读不到管线面 ≠ 没有受影响管线：必须显式说出来，否则读者会把「空」当结论。
    downstream.push({
      path: `${PIPELINES_DIR}/`,
      kind: 'unknown',
      why: `管线目录不可读（${pipelinesLoad.warnings.join('；')}）：`
        + '无法反查受影响管线——未知 ≠ 没有受影响管线',
    })
  } else if (targetId === '') {
    downstream.push({
      path: `${PIPELINES_DIR}/`,
      kind: 'unknown',
      why: '契约 domain/table 形态非法，无法反查受影响管线（先修 validation 再提案）',
    })
  } else {
    // 反查两档：affected（直接写入者，逐条）与 candidate（同域猜测，**聚合一条**——
    // lemeng 域有 ~30 条管线，逐条刷屏会让真正的 affected 淹没在里面）。
    const { direct, sameDomainIds } = lookupPipelines(pipelinesLoad.defs.values(), baseline, domain, targetId)
    for (const { def, basis } of direct) {
      downstream.push({
        path: `${PIPELINES_DIR}/${def.id}.json`,
        kind: 'affected',
        why: `直接写入者：${basis}；列集/类型/布局变更需同步核对`,
      })
    }
    if (direct.length === 0 && sameDomainIds.length > 0) {
      const shown = sameDomainIds.slice(0, 5).join('、')
      downstream.push({
        path: `${PIPELINES_DIR}/`,
        kind: 'candidate',
        why: `本域另有 ${sameDomainIds.length} 条管线（${shown}${sameDomainIds.length > 5 ? ' 等' : ''}），`
          + '它们都不解析到该契约：不是直接写入者，是否受影响需人工判定',
      })
    }
    if (pipelinesLoad.warnings.length > 0) {
      // 读得到但有文件被跳过（非法名/坏 JSON）⇒ 枚举是**部分**的：正命中仍是事实，
      // 但没命中的部分不能当成「没有」。
      downstream.push({
        path: `${PIPELINES_DIR}/`,
        kind: 'unknown',
        why: `管线面读不全（${pipelinesLoad.warnings.join('；')}）：受影响判定可能不完整——未知 ≠ 没有`,
      })
    }
  }

  downstream.push({
    path: stagingPathOf(domain, table),
    kind: 'required',
    why: 'staging 模型按契约列集取列：契约变了要同步',
  })
  downstream.push({
    path: 'dbt/semantics/l1_metrics.yml',
    kind: 'required',
    why: '若该表参与了 L1 口径，语义声明可能要跟着改',
  })
  if (contractsLoad.warnings.length > 0) {
    downstream.push({
      path: `${CONTRACTS_DIR}/`,
      kind: 'unknown',
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

const badParam = (detail: string): { payload: Record<string, unknown>; isError: true; auditRowCount: null } => ({
  payload: { status: 'denied', reason: 'bad_param', detail }, isError: true, auditRowCount: null,
})

/** 入参字符串：**先 trim**（纯空白与缺失同罪），再按字段上限截断。 */
const textArg = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.trim().slice(0, max) : '')

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
  const title = textArg(args.title, MAX_TITLE)
  const rationale = textArg(args.rationale, MAX_RATIONALE)
  if (title === '' || rationale === '') return badParam('title/rationale 必填（非空白）')
  const p = buildPipelineProposal(deps, {
    pipeline: args.pipeline, contract: args.contract, title, rationale,
  })
  return p.validation.length > 0 ? refused(p.validation) : okPayload(p)
}

export const proposeContractChangeImpl: PipelineImpl = async (deps, args) => {
  const title = textArg(args.title, MAX_TITLE)
  const rationale = textArg(args.rationale, MAX_RATIONALE)
  if (title === '' || rationale === '') return badParam('title/rationale 必填（非空白）')
  const p = buildContractProposal(deps, { contract: args.contract, title, rationale })
  return p.validation.length > 0 ? refused(p.validation) : okPayload(p)
}
