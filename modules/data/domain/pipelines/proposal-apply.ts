// proposal-apply.ts —— 提案应用通路的 GitHub 客户端（#1003 / D-W3-5）。
//
// 决策与全部口径见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
// 本文件只做机制：conflict 预检、建分支（撞名加后缀）、逐文件 PUT、开 draft PR；
// 不做校验（那是 apply.ts 的闸）、不抛业务错误——一切失败都是判别联合的 outcome。
//
// 红线：一切写动作只落在提案分支 + draft PR；base 分支永不直写。
import { createHash } from 'node:crypto'

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
          ...(init.body === undefined ? {} : {}),
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
        const remote = body.content !== undefined && body.content !== null ? Buffer.from(body.content, 'base64').toString('utf8') : ''
        if (remote === p.content) { skipped.push(p.path); continue }
        return { kind: 'conflict', path: p.path, currentSha256: sha256hex(remote).slice(0, 16) }
      }
      if (toWrite.length === 0) return { kind: 'nothing_to_apply', skipped }
      // Task 2 接手：建分支 → 逐文件 PUT → 开 draft PR（本任务先以显式失败收口占位）
      return { kind: 'github_rejected', detail: '写入通路未实现（Task 2）' }
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
