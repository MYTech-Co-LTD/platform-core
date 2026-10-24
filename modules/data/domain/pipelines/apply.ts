// apply.ts —— apply_pipeline_proposal：提案回传闸 + GitHub 落盘/开 PR（#1003 / D-W3-5）。
//
// 顺序固定：**白名单 → 内容重校验 → seam → 机制**。前两道是纯函数，不过就零网络；
// 决策与失败语义见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
//
// 红线：本工具只往「提案分支 + draft PR」写（经 GitHub API），永不直写正式目录；
// PAT 未配 ⇒ not_executed（与沙箱 seam 同构）——不配不生效。
import { validateContractDraft, validatePipelineDraft } from './validate'
import type { Issue } from './validate-types'
import type { ProposalApplier } from './proposal-apply'
import type { PipelineDeps, PipelineImpl } from './types'
import { CONTRACTS_DIR, PIPELINES_DIR } from './propose'

const NOTE_UNCONFIGURED = '本服务未配 `DATA_MCP_GITHUB_TOKEN` ⇒ 提案应用通路不生效（只做了白名单与重校验）。接入见 docs/architecture.md 的提案应用小节。'

/** 路径白名单（spec §1）：PR 会触发分支 CI ⇒ 放任任意路径等于允许改 workflow（提权通道）。 */
const pathViolations = (path: string): string | null => {
  if (!path.startsWith('/') === false) return '不得以 / 开头'
  if (path.includes('..')) return '不得包含 ..'
  if (!path.endsWith('.json')) return '必须以 .json 结尾'
  const ok = path.startsWith(`${CONTRACTS_DIR}/`) || path.startsWith(`${PIPELINES_DIR}/`)
  return ok ? null : `必须在 ${CONTRACTS_DIR}/ 或 ${PIPELINES_DIR}/ 下`
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const applyPipelineProposalImpl: PipelineImpl = async (deps: PipelineDeps, args: { proposal?: unknown }) => {
  const proposal = isObj(args.proposal) ? args.proposal : null
  if (proposal === null || !Array.isArray(proposal.pieces) || proposal.pieces.length === 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: [{ path: 'proposal.pieces', message: '必须回传 propose_* 的完整回包（pieces 非空数组）' }] }, isError: true, auditRowCount: null }
  }

  // ① 白名单 + 内容重校验（零网络）
  const issues: Issue[] = []
  const pieces: { path: string; content: string }[] = []
  for (let i = 0; i < proposal.pieces.length; i += 1) {
    const p = proposal.pieces[i]
    if (!isObj(p)) { issues.push({ path: `proposal.pieces[${i}]`, message: '必须是 {path, content}' }); continue }
    const path = str(p.path)
    const why = pathViolations(path)
    if (why !== null) { issues.push({ path: `proposal.pieces[${i}].path`, message: why }); continue }
    const content = str(p.content)
    let doc: unknown
    try { doc = JSON.parse(content) as unknown } catch { issues.push({ path: `proposal.pieces[${i}].content`, message: '不是合法 JSON' }); continue }
    const found = path.startsWith(`${PIPELINES_DIR}/`) ? validatePipelineDraft(doc) : validateContractDraft(doc)
    issues.push(...found.map((x) => ({ path: `proposal.pieces[${i}] ${x.path}`, message: x.message })))
    pieces.push({ path, content })
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
