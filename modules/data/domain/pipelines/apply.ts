// apply.ts —— apply_pipeline_proposal：提案回传闸 + GitHub 落盘/开 PR（#1003 / D-W3-5）。
//
// 顺序固定：**白名单 → 内容重校验 → seam → 机制**。前两道是纯函数，不过就零网络；
// 决策与失败语义见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
// W3 起白名单四档（#1401）：contracts/**.json、deploy/duckle/console/pipelines/**.json、
// dbt/semantics/l1_metrics.yml（精确单文件 + 增量重校验）、dbt/tests/**.sql（对账 test 守卫）。
//
// 红线：本工具只往「提案分支 + draft PR」写（经 GitHub API），永不直写正式目录；
// PAT 未配 ⇒ not_executed（与沙箱 seam 同构）——不配不生效。
import { validateContractDraft, validatePipelineDraft } from './validate'
import type { Issue } from './validate-types'
import type { ProposalApplier } from './proposal-apply'
import type { PipelineDeps, PipelineImpl } from './types'
import { CONTRACTS_DIR, PIPELINES_DIR } from './propose'
import { FORBIDDEN_SQL_RE } from '../semantic-compiler'
import { DBT_TESTS_DIR, SEMANTICS_YAML_REL, readCurrentSemanticsYaml, semanticsYamlPieceIssues } from './propose-metric'

const NOTE_UNCONFIGURED = '本服务未配 `DATA_MCP_GITHUB_TOKEN` ⇒ 提案应用通路不生效（只做了白名单与重校验）。接入见 docs/architecture.md 的提案应用小节。'

/**
 * 路径白名单（spec §1 + W3 四档）：PR 会触发分支 CI ⇒ 放任任意路径等于允许改 workflow（提权通道）。
 * 四档 = contracts/**.json、deploy/duckle/console/pipelines/**.json、
 * dbt/semantics/l1_metrics.yml（**精确单文件**——白名单越窄越好）、dbt/tests/**.sql（对账 singular test）。
 */
const pathViolations = (path: string): string | null => {
  if (path.startsWith('/')) return '不得以 / 开头'
  if (path.includes('..')) return '不得包含 ..'
  if (path === SEMANTICS_YAML_REL) return null
  if (path.startsWith(`${DBT_TESTS_DIR}/`) && path.endsWith('.sql')) return null
  if (path.endsWith('.json') && (path.startsWith(`${CONTRACTS_DIR}/`) || path.startsWith(`${PIPELINES_DIR}/`))) return null
  return `不在白名单内（允许：${CONTRACTS_DIR}/**.json、${PIPELINES_DIR}/**.json、${SEMANTICS_YAML_REL}、${DBT_TESTS_DIR}/**.sql）`
}

/** SQL piece（对账 singular test）的内容守卫：非空 + 禁词。gate ⑦ 不旁路——复算逻辑是**人写的**，
 *  本闸不深检内容（那是合并前 CI 的事），只挡「空壳 = 假绿」与跑偏成写操作的危险词。 */
const sqlPieceIssues = (content: string): Issue[] => {
  const found: Issue[] = []
  if (content.trim() === '') found.push({ path: 'content', message: '对账 test 不能是空文件（空壳 = gate ⑦ 假绿）' })
  const m = FORBIDDEN_SQL_RE.exec(content)
  if (m !== null) found.push({ path: 'content', message: `含禁词 \`${m[0]}\`——对账 test 只做独立复算的 select（gate ⑦ 不旁路）` })
  return found
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const applyPipelineProposalImpl: PipelineImpl = async (deps: PipelineDeps, args: { proposal?: unknown }) => {
  const proposal = isObj(args.proposal) ? args.proposal : null
  if (proposal === null || !Array.isArray(proposal.pieces) || proposal.pieces.length === 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: [{ path: 'proposal.pieces', message: '必须回传 propose_* 的完整回包（pieces 非空数组）' }] }, isError: true, auditRowCount: null }
  }

  // ① 白名单 + 内容重校验（零网络：YAML 档读现行语义声明是**读仓**，不是网络）
  const issues: Issue[] = []
  const pieces: { path: string; content: string; baseSha256?: string }[] = []
  // 现行语义声明按需懒读（undefined = 还没读；null = 读了但不可读）。JSON-only 提案不触发读仓。
  let currentYaml: string | null | undefined
  for (let i = 0; i < proposal.pieces.length; i += 1) {
    const p = proposal.pieces[i]
    if (!isObj(p)) { issues.push({ path: `proposal.pieces[${i}]`, message: '必须是 {path, content}' }); continue }
    const path = str(p.path)
    const why = pathViolations(path)
    if (why !== null) { issues.push({ path: `proposal.pieces[${i}].path`, message: why }); continue }
    const content = str(p.content)
    // #1411：提案自带基线摘要时透传给 applier（用于区分「可安全更新」与「基线已变」）。
    // 形状不合（非 64 位 hex）一律忽略 ⇒ 退回今天的两态行为，不因脏字段放开写权限。
    const rawBase = str(p.baseSha256)
    const baseSha256 = /^[0-9a-f]{64}$/i.test(rawBase) ? rawBase.toLowerCase() : undefined
    const pushPiece = (): void => {
      pieces.push(baseSha256 === undefined ? { path, content } : { path, content, baseSha256 })
    }
    // YAML 档（W3）：与容器内现行文件比对——diff 只许落在 metrics[]，变更集逐条过 Task 1 同一套机检
    if (path === SEMANTICS_YAML_REL) {
      if (currentYaml === undefined) currentYaml = readCurrentSemanticsYaml(deps.roots.repoRoot)
      if (currentYaml === null) {
        return {
          payload: {
            status: 'unknown', reason: 'semantics_unreadable',
            detail: `现行 ${SEMANTICS_YAML_REL} 不可读——全量文件 piece 无法与现行文件比对（fail-closed，此时零网络未发生）`,
          },
          isError: true, auditRowCount: null,
        }
      }
      issues.push(...semanticsYamlPieceIssues(content, currentYaml)
        .map((x) => ({ path: `proposal.pieces[${i}] ${x.path}`, message: x.message })))
      pushPiece()
      continue
    }
    // SQL 档（W3）：对账 singular test 只挡空壳与危险词（复算逻辑人写，gate ⑦ 在合并前拦）
    if (path.startsWith(`${DBT_TESTS_DIR}/`)) {
      issues.push(...sqlPieceIssues(content)
        .map((x) => ({ path: `proposal.pieces[${i}] ${x.path}`, message: x.message })))
      pushPiece()
      continue
    }
    // JSON 两档（契约 / 管线）——校验原样不动
    let doc: unknown
    try { doc = JSON.parse(content) as unknown } catch { issues.push({ path: `proposal.pieces[${i}].content`, message: '不是合法 JSON' }); continue }
    const found = path.startsWith(`${PIPELINES_DIR}/`) ? validatePipelineDraft(doc) : validateContractDraft(doc)
    issues.push(...found.map((x) => ({ path: `proposal.pieces[${i}] ${x.path}`, message: x.message })))
    pushPiece()
  }
  if (issues.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues }, isError: true, auditRowCount: null }
  }

  // ② seam：PAT 未配 ⇒ 不生效
  const applier: ProposalApplier | null | undefined = deps.apply
  if (applier === null || applier === undefined) {
    return { payload: { status: 'not_executed', reason: 'proposal_apply_unconfigured', checked: { pathAllowlist: true, contentValidation: true }, note: NOTE_UNCONFIGURED }, isError: false, auditRowCount: null }
  }

  // ③ 机制
  const outcome = await applier.apply({
    title: str(proposal.title) || '数据面提案',
    rationale: str(proposal.rationale),
    branch: str(proposal.branch) || 'proposal/data-mcp',
    pieces,
    downstream: Array.isArray(proposal.downstream) ? proposal.downstream : [],
    validation: Array.isArray(proposal.validation) ? proposal.validation : [],
  })

  switch (outcome.kind) {
    case 'conflict':
      return { payload: { status: 'refused', reason: 'proposal_conflict', path: outcome.path, currentSha256: outcome.currentSha256, note: '目标文件在基线上已被他人改动：回显当前内容摘要（sha256 前 16 位），不自动合并。' }, isError: true, auditRowCount: null }
    case 'github_rejected':
      return { payload: { status: 'denied', reason: 'proposal_apply_rejected', detail: outcome.detail }, isError: true, auditRowCount: null }
    case 'unknown':
      return { payload: { status: 'unknown', reason: 'proposal_apply_unknown', detail: outcome.detail, ...(outcome.branch === undefined ? {} : { branch: outcome.branch }), note: 'GitHub 侧 5xx/网络错误：可能部分完成（分支可能已建）；用 detail 里的分支名人工处理后重试。' }, isError: true, auditRowCount: null }
    case 'nothing_to_apply':
      return { payload: { status: 'ok', reason: 'nothing_to_apply', skipped: outcome.skipped, note: '全部 piece 与基线一致，无需开 PR。' }, isError: false, auditRowCount: null }
    case 'applied':
      return { payload: { status: 'ok', prUrl: outcome.prUrl, prNumber: outcome.prNumber, branch: outcome.branch, commitCount: outcome.commitCount, ...(outcome.skipped.length === 0 ? {} : { skipped: outcome.skipped }), note: '已开 draft PR：dbt staging 第三件不机械生成，合并前按 downstream 清单补齐。' }, isError: false, auditRowCount: null }
  }
}
