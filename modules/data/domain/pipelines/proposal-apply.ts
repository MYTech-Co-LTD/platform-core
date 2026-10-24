// proposal-apply.ts —— 提案应用通路的 GitHub 客户端（#1003 / D-W3-5）。
//
// 决策与全部口径见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
// 本文件只做机制：conflict 预检、建分支（撞名加后缀）、逐文件 PUT、开 draft PR；
// 不做校验（那是 apply.ts 的闸）、不抛业务错误——一切失败都是判别联合的 outcome。
//
// 红线：一切写动作只落在提案分支 + draft PR；base 分支永不直写。
import { createHash, randomBytes } from 'node:crypto'

const API = 'https://api.github.com'
const DEFAULT_REPO = 'MYTech-Co-LTD/platform-core'
const DEFAULT_BASE = 'main'

export interface ProposalPiece { path: string; content: string }

export type ProposalApplyOutcome =
  | { kind: 'conflict'; path: string; currentSha256: string }
  | { kind: 'github_rejected'; detail: string }
  | { kind: 'unknown'; detail: string; branch?: string }
  | { kind: 'nothing_to_apply'; skipped: string[] }
  | { kind: 'applied'; branch: string; prUrl: string; prNumber: number; commitCount: number; skipped: string[] }

export interface ProposalApplyInput {
  title: string
  rationale: string
  branch: string
  pieces: ProposalPiece[]
  downstream: readonly unknown[]
  validation: readonly unknown[]
}

export interface ProposalApplier {
  apply(input: ProposalApplyInput): Promise<ProposalApplyOutcome>
}

export interface ProposalApplyConfig {
  repo: string
  token: string
  /** 默认 `main` */
  baseBranch?: string
}

const sha256hex = (s: string): string =>
  createHash('sha256').update(s).digest('hex')

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** PR body：rationale + validation 结论 + downstream 清单（#1003：body 里带下游清单与校验结论）。 */
const renderPrBody = (input: ProposalApplyInput): string => {
  const lines: string[] = [`## 为什么`, '', input.rationale, '', '## 静态校验结论', '']
  if (input.validation.length === 0) lines.push('- 全部通过（无 issue）')
  else for (const v of input.validation) {
    const item = v as { path?: string; message?: string }
    lines.push(`- ❌ \`${item.path ?? '?'}\`：${item.message ?? ''}`)
  }
  lines.push('', '## 还差的件（downstream）', '')
  if (input.downstream.length === 0) lines.push('- 无')
  else for (const d of input.downstream) {
    const item = d as { path?: string; why?: string; kind?: string; targets?: readonly string[] }
    const targets = item.targets !== undefined && item.targets.length > 0 ? `（${item.targets.join('、')}）` : ''
    lines.push(`- [${item.kind ?? '?'}] \`${item.path ?? '?'}\`${targets}：${item.why ?? ''}`)
  }
  lines.push('', '> 由 `apply_pipeline_proposal` 经 GitHub API 创建；合并前请确认 dbt staging 第三件已补齐。')
  return lines.join('\n')
}

export const createProposalApplier = (cfg: ProposalApplyConfig, io: { fetchImpl?: typeof fetch } = {}): ProposalApplier => {
  const fetchImpl = io.fetchImpl ?? fetch
  const base = cfg.baseBranch ?? DEFAULT_BASE
  const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
    try {
      const res = await fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'platform-core-data-mcp',
          ...init.headers,
        },
      })
      const text = await res.text().catch(() => '')
      let body: unknown = undefined
      if (text.trim() !== '') { try { body = JSON.parse(text) } catch { body = text } }
      return { status: res.status, body }
    } catch (err) {
      // 网络层异常统一折进 5xx 语义（unknown）
      return { status: 599, body: errText(err) }
    }
  }

  return {
    async apply(input: ProposalApplyInput): Promise<ProposalApplyOutcome> {
      // ① 基线 head
      const ref = await api(`/repos/${cfg.repo}/git/ref/heads/${base}`)
      if (ref.status !== 200) {
        return ref.status >= 500
          ? { kind: 'unknown', detail: `读取基线 ref 失败：HTTP ${ref.status}` }
          : { kind: 'github_rejected', detail: `读取基线 ref 失败：HTTP ${ref.status}` }
      }
      const baseSha = (ref.body as { object?: { sha?: string } })?.object?.sha ?? ''

      // ② 冲突预检（#1003 第 3 条）：内容不同 ⇒ 拒绝并回当前内容摘要；一致 ⇒ skipped；404 ⇒ 新文件
      const skipped: string[] = []
      const toWrite: { piece: ProposalPiece; remoteSha?: string }[] = []
      for (const p of input.pieces) {
        const q = encodeURIComponent(p.path)
        const res = await api(`/repos/${cfg.repo}/contents/${q}?ref=${encodeURIComponent(base)}`)
        if (res.status === 404) { toWrite.push({ piece: p }); continue }
        if (res.status >= 500) return { kind: 'unknown', detail: `读取 ${p.path} 失败：HTTP ${res.status}` }
        if (res.status !== 200) return { kind: 'github_rejected', detail: `读取 ${p.path} 失败：HTTP ${res.status}` }
        const body = res.body as { content?: string | null }
        // content 为 null ⇒ 文件超过 1MB，contents API 不内联返回内容；本仓契约/管线条目都是小文件，
        // 正常不会命中。真命中时按空串比对 ⇒ 落 conflict（保守：宁可误报冲突，也不盲写覆盖大文件）。
        const remote = body.content !== undefined && body.content !== null ? Buffer.from(body.content, 'base64').toString('utf8') : ''
        if (remote === p.content) { skipped.push(p.path); continue }
        return { kind: 'conflict', path: p.path, currentSha256: sha256hex(remote).slice(0, 16) }
      }
      if (toWrite.length === 0) return { kind: 'nothing_to_apply', skipped }

      // ③ 建分支：建议名已存在（422）⇒ 换 -<6hex> 后缀重试（命名碰撞 ≠ 他人改动，不是拒绝路径）
      const randomToken = (): string => randomBytes(3).toString('hex')
      let branch = input.branch
      let branchSha = ''
      for (let attempt = 0; ; attempt += 1) {
        const created = await api(`/repos/${cfg.repo}/git/refs`, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
        })
        if (created.status >= 200 && created.status < 300) { branchSha = String((created.body as { object?: { sha?: string } })?.object?.sha ?? ''); break }
        if (created.status === 422 && attempt < 2) { branch = `${input.branch}-${randomToken()}`; continue }
        return created.status >= 500
          ? { kind: 'unknown', detail: `建分支失败：HTTP ${created.status}` }
          : { kind: 'github_rejected', detail: `建分支失败：HTTP ${created.status}` }
      }

      // ④ 逐文件 PUT（每文件一个 commit；一条 PR 多 commit 满足三件套纪律的前两件）
      for (let i = 0; i < toWrite.length; i += 1) {
        const { piece: p, remoteSha } = toWrite[i]!
        const put = await api(`/repos/${cfg.repo}/contents/${encodeURIComponent(p.path)}`, {
          method: 'PUT',
          body: JSON.stringify({
            message: `chore(proposal): ${input.title} (${i + 1}/${toWrite.length})`,
            content: Buffer.from(p.content, 'utf8').toString('base64'),
            branch,
            ...(remoteSha === undefined ? {} : { sha: remoteSha }),
          }),
        })
        if (put.status < 200 || put.status >= 300) {
          const detail = `写 ${p.path} 失败：HTTP ${put.status}（分支 ${branch} 上已有部分提交，人工处理或删除该分支）`
          return put.status >= 500 ? { kind: 'unknown', detail, branch } : { kind: 'github_rejected', detail }
        }
      }

      // ⑤ 开 draft PR（dbt staging 第三件不机械生成 ⇒ draft + downstream 清单 = 诚实的半成品）
      const body = renderPrBody(input)
      const pull = await api(`/repos/${cfg.repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: input.title, head: branch, base, draft: true, body }),
      })
      if (pull.status < 200 || pull.status >= 300) {
        const detail = `开 PR 失败：HTTP ${pull.status}（分支 ${branch} 已建好，可手工开 PR）`
        return pull.status >= 500 ? { kind: 'unknown', detail, branch } : { kind: 'github_rejected', detail }
      }
      const pb = pull.body as { number?: number; html_url?: string }
      return {
        kind: 'applied', branch,
        prUrl: pb.html_url ?? '', prNumber: pb.number ?? 0,
        commitCount: toWrite.length, skipped,
      }
    },
  }
}

// io 为可选测试 seam（与任务书的差异：测试头注要求「fetch 全注入，不连网」，而 seam 缺位会走真网络；
// 可选参数对 Task 2/3 的单参调用点零影响）。
export const proposalApplierFromEnv = (env: Record<string, string | undefined>, io: { fetchImpl?: typeof fetch } = {}): ProposalApplier | null => {
  const token = (env.DATA_MCP_GITHUB_TOKEN ?? '').trim()
  if (token === '') return null
  const repo = (env.DATA_MCP_GITHUB_REPO ?? '').trim() || DEFAULT_REPO
  return createProposalApplier({ repo, token }, io)
}
