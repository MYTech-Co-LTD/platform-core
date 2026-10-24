# 数据面 MCP 提案应用通路（apply_pipeline_proposal）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `propose_*` 产出的三件套草案经 GitHub REST 落提案分支并开 draft PR（issue #1003 的「应用」一半），默认（未配 PAT）完全不生效。

**Architecture:** 两个新文件镜像 sandbox/sandbox-runner 的分层——`proposal-apply.ts` 是 GitHub 客户端（fetch 注入、纯机制、返回判别联合 outcome），`apply.ts` 是 `PipelineImpl`（校验闸 + outcome→payload 映射）。工具清单 7→8，闸门复用写总闸 + PAT seam。

**Tech Stack:** TypeScript / vitest（fetch 全注入，不连网）/ GitHub REST v3（git refs、contents、pulls）/ 无新依赖。

## Global Constraints

- Spec：`docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md`（已含两处修订：路径白名单、审计单行全文）。
- 红线：`propose.ts` 保持零写入；apply 的一切写动作只经 GitHub API 落在提案分支 + draft PR。
- PAT 最小权限：单仓 `contents:write` + `pull_requests:write`；只进 server 行 env（isSecret），不进代码/文档/提交。
- 工具清单 `PIPELINE_FACE_MAX_TOOLS` 7→8；`scripts/check-mcp-toolface.mjs` 读常量自动跟随，但 `tools.test.ts`、`mcp-manage.test.ts` 里的**手写名单**要同步。
- 测试命令：`cd modules/data && pnpm exec vitest run`；类型检查：`pnpm run typecheck`（在 `modules/data` 下）。
- 提交纪律：Conventional Commits；本计划各任务的提交信息已给出，**不要** `--no-verify`。
- 已知既有失败：`modules/data` 全量里 `query-service.test.ts` 7 条需真 PG，与本工作无关，**不要**试图修它。

## 文件结构（先看清落点）

- Create `modules/data/domain/pipelines/proposal-apply.ts` —— GitHub 客户端：conflict 预检、建分支（撞名加后缀）、逐文件 PUT、开 draft PR；`createProposalApplier(cfg, io)` + `proposalApplierFromEnv(env)`（token 空 ⇒ null）。
- Create `modules/data/domain/pipelines/apply.ts` —— `applyPipelineProposalImpl: PipelineImpl`：路径白名单 → 内容重校验 → 调 applier → outcome→payload。
- Create `modules/data/domain/pipelines/proposal-apply.test.ts`、`apply.test.ts` —— 机制与 impl 两层测试。
- Modify `modules/data/domain/pipelines/types.ts` —— `PipelineDeps` 加 `apply?: ProposalApplier | null`。
- Modify `modules/data/domain/pipelines/mcp-pipeline-tools.ts` —— wiring/IMPLS/depsOf 接线。
- Modify `modules/data/domain/pipelines/tools.ts` —— 第 8 个工具元数据 + `PIPELINE_FACE_MAX_TOOLS = 8`。
- Modify `modules/data/domain/pipelines/tools.test.ts`、`modules/data/routes/mcp-manage.test.ts` —— 名单同步。
- Modify `.env.example`、`docs/architecture.md`、`deploy/data-plane-deploy-sop.md` —— 文档与部署口径。
- Modify `docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md` —— spec §7 指针回填（Task 5）。

---

### Task 1: `proposal-apply.ts`——env seam + 冲突预检 + nothing_to_apply

**Files:**
- Create: `modules/data/domain/pipelines/proposal-apply.ts`
- Create: `modules/data/domain/pipelines/proposal-apply.test.ts`

**Interfaces:**
- Consumes: 无（本任务自包含；`propose.ts` 的 `PipelineProposal` 形状仅作回传入参参照）。
- Produces（Task 2/3 依赖，签名逐字）:
  ```ts
  export interface ProposalPiece { path: string; content: string }
  export type ProposalApplyOutcome =
    | { kind: 'conflict'; path: string; currentSha256: string }
    | { kind: 'github_rejected'; detail: string }
    | { kind: 'unknown'; detail: string; branch?: string }
    | { kind: 'nothing_to_apply'; skipped: string[] }
    | { kind: 'applied'; branch: string; prUrl: string; prNumber: number; commitCount: number; skipped: string[] }
  export interface ProposalApplyInput {
    title: string; rationale: string; branch: string; pieces: ProposalPiece[];
    downstream: readonly unknown[]; validation: readonly unknown[]
  }
  export interface ProposalApplier { apply(input: ProposalApplyInput): Promise<ProposalApplyOutcome> }
  export interface ProposalApplyConfig { repo: string; token: string; baseBranch?: string }
  export const createProposalApplier(cfg: ProposalApplyConfig, io?: { fetchImpl?: typeof fetch }): ProposalApplier
  export const proposalApplierFromEnv(env: Record<string, string | undefined>): ProposalApplier | null
  ```

- [ ] **Step 1: 写失败测试（文件头 + fake fetch 脚手架 + 三个用例）**

创建 `modules/data/domain/pipelines/proposal-apply.test.ts`：

```ts
// proposal-apply.test.ts —— GitHub 客户端的机制测试：fetch 全注入，不连网。
import { describe, expect, it } from 'vitest'
import { createProposalApplier, proposalApplierFromEnv } from './proposal-apply'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

interface Rec { url: string; method: string; body: unknown }
/** 假 GitHub：按 (method, url 正则) 查表回放；记录每次调用。 */
const fakeGithub = (routes: { match: RegExp; reply: (rec: Rec) => { status: number; body?: unknown } }[]) => {
  const seen: Rec[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const rec: Rec = { url: u, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    seen.push(rec)
    const path = u.replace(/^https:\/\/api\.github\.com/, '')
    const hit = routes.find((r) => r.match.test(path))
    if (hit === undefined) throw new Error(`unexpected ${rec.method} ${path}`)
    const { status, body } = hit.reply(rec)
    return new Response(body === undefined ? undefined : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

const repo = 'MYTech-Co-LTD/platform-core'
const refRoute = {
  match: /\/git\/ref\/heads\/main$/,
  reply: () => ({ status: 200, body: { object: { sha: 'base000' } } }),
}
const piece = { path: 'contracts/common/x.y.json', content: '{"a":1}\n' }

describe('proposalApplierFromEnv', () => {
  it('token 空 ⇒ null（seam：未配不生效）', () => {
    expect(proposalApplierFromEnv({})).toBeNull()
    expect(proposalApplierFromEnv({ DATA_MCP_GITHUB_TOKEN: '  ' })).toBeNull()
  })
  it('token 在 ⇒ applier；repo 默认 MYTech-Co-LTD/platform-core', async () => {
    const { fetchImpl, seen } = fakeGithub([refRoute])
    const ap = proposalApplierFromEnv({ DATA_MCP_GITHUB_TOKEN: 'tok' })
    expect(ap).not.toBeNull()
    await ap!.apply({ title: 't', rationale: 'r', branch: 'proposal/t', pieces: [piece], downstream: [], validation: [] })
    expect(seen[0]!.url).toContain(`repos/${repo}/`)
  })
})

describe('冲突预检与 nothing_to_apply', () => {
  it('远端内容不同 ⇒ conflict + 当前内容 sha256 前 16 位，且只有 contents GET（零写调用）', async () => {
    const { fetchImpl, seen } = fakeGithub([
      refRoute,
      { match: /\/contents\/contracts%2F.*x\.y\.json/, reply: () => ({ status: 200, body: { content: b64('{"a":2}\n'), sha: 'remote1' } }) },
    ])
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply({ title: 't', rationale: 'r', branch: 'proposal/t', pieces: [piece], downstream: [], validation: [] })
    expect(out).toMatchObject({ kind: 'conflict', path: piece.path })
    if (out.kind === 'conflict') {
      const want = (await import('node:crypto')).createHash('sha256').update('{"a":2}\n').digest('hex').slice(0, 16)
      expect(out.currentSha256).toBe(want)
    }
    expect(seen.every((r) => r.method === 'GET')).toBe(true)
  })

  it('全部 piece 内容一致 ⇒ nothing_to_apply（skipped=全部 path），零写调用', async () => {
    const { fetchImpl, seen } = fakeGithub([
      refRoute,
      { match: /\/contents\//, reply: () => ({ status: 200, body: { content: b64(piece.content), sha: 'same' } }) },
    ])
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply({ title: 't', rationale: 'r', branch: 'proposal/t', pieces: [piece], downstream: [], validation: [] })
    expect(out).toEqual({ kind: 'nothing_to_apply', skipped: [piece.path] })
    expect(seen.every((r) => r.method === 'GET')).toBe(true)
  })

  it('404 ⇒ 视为新文件（本任务只走到预检通过前的 rejected/unknown 映射留给 Task 2；这里断言不误判 conflict）', async () => {
    const { fetchImpl } = fakeGithub([
      refRoute,
      { match: /\/contents\//, reply: () => ({ status: 404, body: { message: 'Not Found' } }) },
    ])
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    // Task 1 阶段：新文件尚未有后续流程 ⇒ 以 github_rejected 收口（Task 2 会改成完整 applied 路径）
    const out = await ap.apply({ title: 't', rationale: 'r', branch: 'proposal/t', pieces: [piece], downstream: [], validation: [] })
    expect(out.kind).toBe('github_rejected')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/proposal-apply.test.ts`
Expected: FAIL（`Cannot find module './proposal-apply'`）

- [ ] **Step 3: 最小实现 `proposal-apply.ts`**

```ts
// proposal-apply.ts —— 提案应用通路的 GitHub 客户端（#1003 / D-W3-5）。
//
// 决策与全部口径见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
// 本文件只做机制：conflict 预检、建分支（撞名加后缀）、逐文件 PUT、开 draft PR；
// 不做校验（那是 apply.ts 的闸）、不抛业务错误——一切失败都是判别联合的 outcome。
//
// 红线：一切写动作只落在提案分支 + draft PR；base 分支永不直写。
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

export const proposalApplierFromEnv = (env: Record<string, string | undefined>): ProposalApplier | null => {
  const token = (env.DATA_MCP_GITHUB_TOKEN ?? '').trim()
  if (token === '') return null
  const repo = (env.DATA_MCP_GITHUB_REPO ?? '').trim() || DEFAULT_REPO
  return createProposalApplier({ repo, token })
}
```

头部补 import：`import { createHash } from 'node:crypto'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/proposal-apply.test.ts`
Expected: PASS（5 条）

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/pipelines/proposal-apply.ts modules/data/domain/pipelines/proposal-apply.test.ts
git commit -m "feat(data): proposal-apply 骨架——env seam、冲突预检（拒绝+内容摘要）、nothing_to_apply（#1003）"
```

---

### Task 2: `proposal-apply.ts`——建分支（撞名后缀）、逐文件提交、开 draft PR、4xx/5xx 映射

**Files:**
- Modify: `modules/data/domain/pipelines/proposal-apply.ts`
- Modify: `modules/data/domain/pipelines/proposal-apply.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部导出（不改签名）。
- Produces: `applied` / `unknown{branch}` / `github_rejected{detail 含分支名}` 三种终态的完整实现；`nothing_to_apply` / `conflict` 行为不变。

- [ ] **Step 1: 追加失败测试**

在 `proposal-apply.test.ts` 追加：

```ts
describe('写入通路（分支 → PUT → draft PR）', () => {
  const happyRoutes = () => {
    const seen: Rec[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      seen.push({ url: u, method, body })
      const path = u.replace(/^https:\/\/api\.github\.com/, '')
      const j = (status: number, body2?: unknown) => new Response(body2 === undefined ? undefined : JSON.stringify(body2), { status })
      if (/\/git\/ref\/heads\/main$/.test(path)) return j(200, { object: { sha: 'base000' } })
      if (/\/contents\/contracts%2F/.test(path) && method === 'GET') return j(404, { message: 'Not Found' })
      if (/\/git\/refs$/.test(path) && method === 'POST') return j(201, { ref: body!.ref })
      if (/\/contents\/contracts%2F/.test(path) && method === 'PUT') return j(201, { commit: { sha: 'c1' } })
      if (/\/pulls$/.test(path) && method === 'POST') return j(201, { number: 42, html_url: 'https://github.com/x/pull/42' })
      throw new Error(`unexpected ${method} ${path}`)
    }) as unknown as typeof fetch
    return { fetchImpl, seen }
  }

  const input = (extra?: Partial<Parameters<ReturnType<typeof createProposalApplier>['apply']>[0]>) =>
    ({ title: '加字段', rationale: '需要新列', branch: 'proposal/jia-zi-duan', pieces: [piece], downstream: [], validation: [], ...extra })

  it('成功路径：ref → contents GET → git/refs → PUT → pulls；回包齐', async () => {
    const { fetchImpl, seen } = happyRoutes()
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply(input({ downstream: [{ path: 'dbt/models/x', why: '要补 staging', kind: 'required' }], validation: [{ path: 'nodes[0]', message: '缺 label' }] }))
    expect(out).toEqual({ kind: 'applied', branch: 'proposal/jia-zi-duan', prUrl: 'https://github.com/x/pull/42', prNumber: 42, commitCount: 1, skipped: [] })
    const postRefs = seen.find((r) => r.url.endsWith('/git/refs') && r.method === 'POST')
    expect((postRefs!.body as { ref: string }).ref).toBe('refs/heads/proposal/jia-zi-duan')
    const pull = seen.find((r) => r.url.endsWith('/pulls') && r.method === 'POST')
    const pullBody = pull!.body as { title: string; draft: boolean; body: string; base: string }
    expect(pullBody.draft).toBe(true)
    expect(pullBody.base).toBe('main')
    expect(pullBody.body).toContain('dbt/models/x')      // downstream 进 PR body
    expect(pullBody.body).toContain('缺 label')           // validation 进 PR body
    const put = seen.find((r) => r.method === 'PUT')
    expect((put!.body as { branch: string; content: string }).branch).toBe('proposal/jia-zi-duan')
    expect((put!.body as { content: string }).content).toBe(b64(piece.content))
  })

  it('分支撞名（422）⇒ 换 -<6hex> 后缀重试并成功；PR 用最终分支名', async () => {
    const seen: Rec[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      seen.push({ url: u, method, body })
      const path = u.replace(/^https:\/\/api\.github\.com/, '')
      const j = (status: number, body2?: unknown) => new Response(body2 === undefined ? undefined : JSON.stringify(body2), { status })
      if (/\/git\/ref\/heads\/main$/.test(path)) return j(200, { object: { sha: 'base000' } })
      if (/\/contents\/contracts%2F/.test(path) && method === 'GET') return j(404)
      if (/\/git\/refs$/.test(path) && method === 'POST') {
        return (body as { ref: string }).ref === 'refs/heads/proposal/jia-zi-duan' ? j(422, { message: 'already exists' }) : j(201, {})
      }
      if (/\/contents\/contracts%2F/.test(path) && method === 'PUT') return j(201, { commit: { sha: 'c1' } })
      if (/\/pulls$/.test(path) && method === 'POST') return j(201, { number: 7, html_url: 'http://x/7' })
      throw new Error(`unexpected ${method} ${path}`)
    }) as unknown as typeof fetch
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply(input())
    expect(out.kind).toBe('applied')
    if (out.kind === 'applied') expect(out.branch).toMatch(/^proposal\/jia-zi-duan-[0-9a-f]{6}$/)
  })

  it('PUT 阶段 403 ⇒ github_rejected，detail 带已建分支名（部分提交可观测）', async () => {
    const seen: Rec[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? 'GET'
      seen.push({ url: u, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
      const path = u.replace(/^https:\/\/api\.github\.com/, '')
      const j = (status: number, body2?: unknown) => new Response(body2 === undefined ? undefined : JSON.stringify(body2), { status })
      if (/\/git\/ref\/heads\/main$/.test(path)) return j(200, { object: { sha: 'base000' } })
      if (/\/contents\/contracts%2F/.test(path) && method === 'GET') return j(404)
      if (/\/git\/refs$/.test(path) && method === 'POST') return j(201, {})
      return j(403, { message: 'Resource not accessible by personal access token' })
    }) as unknown as typeof fetch
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply(input())
    expect(out.kind).toBe('github_rejected')
    if (out.kind === 'github_rejected') expect(out.detail).toContain('proposal/jia-zi-duan')
  })

  it('pulls 500 ⇒ unknown + 已建分支名', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? 'GET'
      const path = u.replace(/^https:\/\/api\.github\.com/, '')
      const j = (status: number, body2?: unknown) => new Response(body2 === undefined ? undefined : JSON.stringify(body2), { status })
      if (/\/git\/ref\/heads\/main$/.test(path)) return j(200, { object: { sha: 'base000' } })
      if (/\/contents\/contracts%2F/.test(path) && method === 'GET') return j(404)
      if (/\/git\/refs$/.test(path) && method === 'POST') return j(201, {})
      if (/\/contents\/contracts%2F/.test(path) && method === 'PUT') return j(201, { commit: { sha: 'c1' } })
      if (/\/pulls$/.test(path) && method === 'POST') return j(502, { message: 'upstream' })
      throw new Error(`unexpected ${method} ${path}`)
    }) as unknown as typeof fetch
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    const out = await ap.apply(input())
    expect(out.kind).toBe('unknown')
    if (out.kind === 'unknown') expect(out.branch).toMatch(/^proposal\/jia-zi-duan/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/proposal-apply.test.ts`
Expected: FAIL（Task 1 的占位 `github_rejected` 让「成功路径」等 4 条红）

- [ ] **Step 3: 实现写入通路（替换 Task 1 的占位 return）**

在 `createProposalApplier` 的 `apply` 里，把 `if (toWrite.length === 0) ...` 之后的占位替换为：

```ts
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
```

文件头部补 import：`import { randomBytes } from 'node:crypto'`。并在文件级加 PR body 渲染函数：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/proposal-apply.test.ts`
Expected: PASS（9 条）

- [ ] **Step 5: typecheck**

Run: `cd modules/data && pnpm run typecheck`
Expected: 无输出（干净）

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/pipelines/proposal-apply.ts modules/data/domain/pipelines/proposal-apply.test.ts
git commit -m "feat(data): proposal-apply 写入通路——建分支（撞名后缀）、逐文件提交、开 draft PR、4xx/5xx 映射（#1003）"
```

---

### Task 3: `apply.ts`——impl（白名单、重校验、seam、payload 映射）+ types 接线

**Files:**
- Create: `modules/data/domain/pipelines/apply.ts`
- Create: `modules/data/domain/pipelines/apply.test.ts`
- Modify: `modules/data/domain/pipelines/types.ts`（`PipelineDeps` 加可选字段）

**Interfaces:**
- Consumes: Task 1/2 的 `ProposalApplier` / `ProposalApplyOutcome` / `proposalApplierFromEnv`；`validate.ts` 的 `validateContractDraft` / `validatePipelineDraft`；`propose.ts` 的路径常量改为导出（见 Step 3）；`types.ts` 的 `PipelineImpl`。
- Produces: `export const applyPipelineProposalImpl: PipelineImpl`（Task 4 的 IMPLS 注册它）；`PipelineDeps.apply?: ProposalApplier | null`。

- [ ] **Step 1: types.ts 加可选字段（先改类型，测试才写得出 deps）**

在 `modules/data/domain/pipelines/types.ts` 的 `PipelineDeps`（含 `sandbox` 字段那段）追加：

```ts
  /** 提案应用通路（#1003）；`null`/缺省 = PAT 未配 ⇒ apply 工具回 not_executed。 */
  apply?: ProposalApplier | null
```

头部 `import type { ProposalApplier } from './proposal-apply'`。

- [ ] **Step 2: 写失败测试 `apply.test.ts`**

```ts
// apply.test.ts —— apply_pipeline_proposal 的闸与映射：白名单、重校验、seam、outcome→payload。
import { describe, expect, it } from 'vitest'
import { verdictOf } from '../../routes/mcp-pipeline-tools'
import { applyPipelineProposalImpl } from './apply'
import { createProposalApplier, type ProposalApplyOutcome } from './proposal-apply'
import type { PipelineDeps } from './types'

const goodPiece = { path: 'contracts/common/x.y.json', content: '{"contractVersion":2,"id":"x.y","domain":"x","table":"y","source":{"system":"s","layer":"raw"},"grain":[],"columns":[]}\n' }

const proposal = {
  status: 'ok', title: '加字段', rationale: '需要新列', branch: 'proposal/jia-zi-duan',
  pieces: [goodPiece], downstream: [], validation: [],
}

const depsWith = (apply: PipelineDeps['apply']): PipelineDeps =>
  ({ roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {}, apply })

/** 假 applier：回放 outcome 或断言「不该被调到」。 */
const applierOf = (outcome: ProposalApplyOutcome) => {
  let calls = 0
  const applier = { apply: async () => { calls += 1; return outcome } }
  return { applier: applier as unknown as PipelineDeps['apply'], calls: () => calls }
}

describe('apply_pipeline_proposal', () => {
  it('PAT 未配（apply 缺省）⇒ not_executed/proposal_apply_unconfigured，零网络', async () => {
    const out = await applyPipelineProposalImpl(depsWith(undefined), { proposal })
    expect(out.payload).toMatchObject({ status: 'not_executed', reason: 'proposal_apply_unconfigured' })
    expect(out.isError).toBe(false)
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: 'proposal_apply_unconfigured' })
  })

  it('路径白名单：非允许前缀 / 含 .. / 非 .json ⇒ refused/invalid_draft，applier 零调用', async () => {
    for (const bad of ['.github/workflows/x.yml', 'contracts/../secrets.json', 'contracts/common/x.json ', 'contracts/common/x.txt']) {
      const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [{ path: bad.trim(), content: '{}\n' }] } })
      expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      expect(calls()).toBe(0)
    }
  })

  it('内容重校验：管线草案删 position ⇒ refused/invalid_draft，零网络', async () => {
    const badPipelinePiece = { path: 'deploy/duckle/console/pipelines/lemeng.a.b.json', content: '{"name":"lemeng.a.b","nodes":[{"id":"s1","type":"source","data":{"label":"s"}}],"edges":[]}\n' }
    const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
    const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [badPipelinePiece] } })
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
    expect(calls()).toBe(0)
  })

  it('outcome 映射：conflict ⇒ refused/proposal_conflict + 摘要；rejected ⇒ denied；unknown ⇒ unknown；nothing ⇒ ok', async () => {
    const cases: { outcome: ProposalApplyOutcome; payload: Record<string, unknown> }[] = [
      { outcome: { kind: 'conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' }, payload: { status: 'refused', reason: 'proposal_conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' } },
      { outcome: { kind: 'github_rejected', detail: 'HTTP 403' }, payload: { status: 'denied', reason: 'proposal_apply_rejected', detail: 'HTTP 403' } },
      { outcome: { kind: 'unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' }, payload: { status: 'unknown', reason: 'proposal_apply_unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' } },
      { outcome: { kind: 'nothing_to_apply', skipped: [goodPiece.path] }, payload: { status: 'ok', reason: 'nothing_to_apply' } },
      { outcome: { kind: 'applied', branch: 'proposal/x', prUrl: 'http://u/1', prNumber: 1, commitCount: 1, skipped: [] }, payload: { status: 'ok', prUrl: 'http://u/1', prNumber: 1, branch: 'proposal/x', commitCount: 1 } },
    ]
    for (const c of cases) {
      const { applier } = applierOf(c.outcome)
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal })
      expect(out.payload).toMatchObject(c.payload)
    }
  })
})
```

- [ ] **Step 3: 改 propose.ts 导出路径常量（apply 白名单复用，不抄两份）**

`modules/data/domain/pipelines/propose.ts` 61–62 行的两条私有常量加 `export`：

```ts
export const PIPELINES_DIR = 'deploy/duckle/console/pipelines'
export const CONTRACTS_DIR = 'contracts'
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/apply.test.ts`
Expected: FAIL（`Cannot find module './apply'`）

- [ ] **Step 5: 实现 `apply.ts`**

```ts
// apply.ts —— apply_pipeline_proposal：提案回传闸 + GitHub 落盘/开 PR（#1003 / D-W3-5）。
//
// 顺序固定：**白名单 → 内容重校验 → seam → 机制**。前两道是纯函数，不过就零网络；
// 决策与失败语义见 docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md。
//
// 红线：本工具只往「提案分支 + draft PR」写（经 GitHub API），永不直写正式目录；
// PAT 未配 ⇒ not_executed（与沙箱 seam 同构）——不配不生效。
import { applyPipelineProposalImplName } from './apply-meta' // ← 不需要：占位说明见下
```

> ⚠️ 上面这个 import 是**故意放的错误示例**，实现时**不要**它——直接用下面完整实现替换整个文件：

```ts
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
```

> ⚠️ 注意：`apply.ts` 文件里**不要**保留那个带 `apply-meta` 的错误 import 块——整个文件以第二段代码为准。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/apply.test.ts`
Expected: PASS（4 条；重校验用例要求管线 piece 里真的缺 `position`——上面 `badPipelinePiece` 的 nodes[0] 没写 position，正是依赖 validatePipelineDraft 的 2026-10-23 收紧）

- [ ] **Step 7: typecheck + 全量**

```bash
cd modules/data && pnpm run typecheck && pnpm exec vitest run 2>&1 | tail -4
```
Expected: typecheck 干净；7 条 query-service 既有失败照旧，其余绿。

- [ ] **Step 8: Commit**

```bash
git add modules/data/domain/pipelines/apply.ts modules/data/domain/pipelines/apply.test.ts modules/data/domain/pipelines/types.ts modules/data/domain/pipelines/propose.ts
git commit -m "feat(data): apply_pipeline_proposal impl——路径白名单、内容重校验、PAT seam、outcome 映射（#1003）"
```

---

### Task 4: 接线 + 工具清单 7→8

**Files:**
- Modify: `modules/data/domain/pipelines/mcp-pipeline-tools.ts`
- Modify: `modules/data/domain/pipelines/tools.ts`
- Modify: `modules/data/domain/pipelines/tools.test.ts`
- Modify: `modules/data/routes/mcp-manage.test.ts`

**Interfaces:**
- Consumes: `applyPipelineProposalImpl`（Task 3）、`proposalApplierFromEnv`（Task 1）。
- Produces: `/mcp-manage` 上可调用的第 8 个工具；`PipelineWiring.apply`。

- [ ] **Step 1: 更新既有测试的名单断言（先红）**

`modules/data/domain/pipelines/tools.test.ts`：`PIPELINE_FACE_MAX_TOOLS` 断言不变（改常量后自动满足）；凡手写 7 个名字的数组，在 `'propose_contract_change'` 后追加 `'apply_pipeline_proposal'`。`modules/data/routes/mcp-manage.test.ts:95` 的名单同样追加。

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/tools.test.ts routes/mcp-manage.test.ts`
Expected: FAIL（清单长度/名字对不上——因为常量还是 7 且工具未注册）

- [ ] **Step 2: tools.ts——常量与第 8 个工具元数据**

`PIPELINE_FACE_MAX_TOOLS = 7` 改 `= 8`，并在 `PIPELINE_TOOLS` 数组尾部（`propose_contract_change` 之后）追加：

```ts
  {
    name: 'apply_pipeline_proposal', group: 'pipeline', title: '提案应用：落盘并开 draft PR',
    description: '把 propose_* 的回包原样回传，经 GitHub API 落到提案分支并开 **draft PR**（每文件一个 commit；body 带 downstream 清单与 validation 结论）。三道前置：目标文件与基线不同 ⇒ 拒绝并回当前内容摘要（不自动合并）；piece 路径必须在 contracts/ 或 deploy/duckle/console/pipelines/ 下且为 .json；内容重校验不过 ⇒ 拒绝。本服务未配 DATA_MCP_GITHUB_TOKEN 时回 not_executed（不生效）；写总闸关闭时整个工具不可用。',
    inputSchema: {
      type: 'object',
      properties: { proposal: { type: 'object', description: 'propose_pipeline_change / propose_contract_change 的完整回包（原样回传，不要改写）' } },
      required: ['proposal'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
```

- [ ] **Step 3: mcp-pipeline-tools.ts——wiring 与 IMPLS**

头部 import：`import { applyPipelineProposalImpl } from '../domain/pipelines/apply'`、`import { proposalApplierFromEnv } from '../domain/pipelines/proposal-apply'`、`import type { ProposalApplier } from '../domain/pipelines/proposal-apply'`。

- `PipelineWiring` 接口（`sandbox: SandboxRunner | null` 同段）加 `apply: ProposalApplier | null`
- `defaultPipelineWiring` 返回对象加 `apply: proposalApplierFromEnv(env)`
- `depsOf` 加 `apply: wiring.apply`
- `IMPLS` 表加 `apply_pipeline_proposal: applyPipelineProposalImpl,`

Run: `cd modules/data && pnpm exec vitest run domain/pipelines/tools.test.ts routes/mcp-manage.test.ts`
Expected: PASS

- [ ] **Step 4: 全量 + 守卫**

```bash
cd modules/data && pnpm run typecheck && pnpm exec vitest run 2>&1 | tail -4
node scripts/check-mcp-toolface.mjs
```
Expected: typecheck 干净；全量除 7 条既有 PG 失败外全绿；toolface 门 OK（工具数 ≤ 上限、description 非空等）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/pipelines/mcp-pipeline-tools.ts modules/data/domain/pipelines/tools.ts modules/data/domain/pipelines/tools.test.ts modules/data/routes/mcp-manage.test.ts
git commit -m "feat(data): 接线 apply_pipeline_proposal——工具清单 7→8、总闸+PAT seam 生效（#1003）"
```

---

### Task 5: 文档与部署口径（.env.example、architecture、SOP、spec 指针）

**Files:**
- Modify: `.env.example`
- Modify: `docs/architecture.md`
- Modify: `deploy/data-plane-deploy-sop.md`
- Modify: `docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md`

**Interfaces:**
- Consumes: 全部前序任务（文档描述的是已实现行为）。
- Produces: 部署与运维口径（PAT 在哪、怎么取、怎么验）。

- [ ] **Step 1: `.env.example` 在 `DATA_SANDBOX_*` 段之后追加**

```
# 提案应用通路（apply_pipeline_proposal，#1003）：GitHub PAT，**scoped**——仅目标仓的
# contents:write + pull_requests:write。在哪取：GitHub → Settings → Developer settings →
# Fine-grained personal access tokens（只选 platform-core 仓）。不配 ⇒ 工具回
# not_executed/proposal_apply_unconfigured（不生效）；写入总闸 DATA_MCP_ALLOW_MUTATING 仍单独生效。
DATA_MCP_GITHUB_TOKEN=
# 目标仓（缺省 MYTech-Co-LTD/platform-core），一般不用配。
DATA_MCP_GITHUB_REPO=
```

- [ ] **Step 2: `docs/architecture.md`——数据 MCP 部分新增「提案应用通路」小节**

在 §2.8（沙箱执行面）小节之后新增 `### 2.9 提案应用通路（2026-10-24 拍板，issue #1003）`，正文四段（逐字用）：

```markdown
### 2.9 提案应用通路（2026-10-24 拍板，issue #1003）

**决定**：`propose_*` 保持零写入不变；应用走**独立工具 `apply_pipeline_proposal`**——
agent 把 propose 回包**原样回传**，服务端无状态。WYSIWYG：PR 内容 = 人 review 过的草案，
不依赖「重新生成是确定的」。

**闸门 = 写总闸 + PAT 存在性**：`DATA_MCP_ALLOW_MUTATING=true`（否则 `denied / mutating_disabled`）
且 `DATA_MCP_GITHUB_TOKEN` 已配（否则 `not_executed / proposal_apply_unconfigured`，与沙箱 seam 同构）。
生产**默认不配 PAT ⇒ 默认不生效**。

**机制 = GitHub REST（容器内 fetch，无 git）**：基线 head → 逐 piece contents 预检
（内容不同 ⇒ `refused / proposal_conflict` + 当前内容 sha256 前 16 位，**不自动合并**；一致 ⇒ 幂等跳过）
→ 建提案分支（建议名撞车 ⇒ 加 `-<6hex>` 后缀，不是拒绝路径）→ 逐文件 PUT（每文件一个 commit）
→ **draft PR**（dbt staging 第三件不机械生成 ⇒ draft + downstream 清单 = 诚实的半成品）。

**安全不变式**：piece 路径白名单 = `contracts/` 或 `deploy/duckle/console/pipelines/` 前缀、
`.json` 结尾、禁 `..`——PR 会触发分支 CI，放任任意路径等于允许改 `.github/workflows`（提权通道）。
PAT 最小权限（单仓 contents:write + pull_requests:write），只在 server 行 env。
审计：`params: args` 整包入库，与 `propose_*` 现状同口径。
```

- [ ] **Step 3: SOP 增「提案应用通路」段**

在 `deploy/data-plane-deploy-sop.md` 的沙箱 §G.1 之后新增：

```markdown
## G.2 提案应用通路（apply_pipeline_proposal）接线与自证

| 项 | 值 / 做法 |
|---|---|
| **PAT** | `DATA_MCP_GITHUB_TOKEN`（openship env isSecret，`server` 服务行）。**Fine-grained**：仅 platform-core 仓，`Contents: Read and write` + `Pull requests: Read and write`，其余全不给 |
| **目标仓** | `DATA_MCP_GITHUB_REPO`（缺省 `MYTech-Co-LTD/platform-core`，一般不配） |
| **不生效口径** | PAT 未配 ⇒ 工具回 `not_executed / proposal_apply_unconfigured`；总闸关 ⇒ `denied / mutating_disabled`。**生产默认不配 PAT** |
| **产出** | 提案分支 + draft PR（每文件一个 commit；body 带 downstream 与 validation）。**永不直写正式目录** |

部署后自证（每条都要看见）：
```sh
# ① 关闸冒烟（验收第三条）：DATA_MCP_ALLOW_MUTATING != true 时调 apply ⇒ denied/mutating_disabled
# ② 未配 PAT 冒烟：配了总闸但 DATA_MCP_GITHUB_TOKEN 空 ⇒ not_executed/proposal_apply_unconfigured
# ③ 白名单冒烟：piece.path = .github/workflows/x.yml ⇒ refused/invalid_draft（零网络）
# ④ 冲突冒烟：对一个基线上已存在的契约回传不同内容 ⇒ refused/proposal_conflict + 当前内容摘要
# ⑤ 端到端：propose_* → apply ⇒ GitHub 上出现提案分支 + draft PR（body 带 downstream/validation）
```
```

- [ ] **Step 4: spec 回填指针**

`docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md` 的 §6「spec §7 原文位置」一条，
实现后改成实际结论（找到正典位置就更新它；确认正典里没有工具清单正文就写明「spec §7 工具清单正典以
`modules/data/domain/pipelines/tools.ts` 头注 + `check-mcp-toolface.mjs` 门为准，SOP 给指针」并删「待沉淀」措辞）。

- [ ] **Step 5: 全量验证 + Commit**

```bash
cd modules/data && pnpm exec vitest run 2>&1 | tail -3 && pnpm run typecheck
node scripts/check-env-example.mjs
git add .env.example docs/architecture.md deploy/data-plane-deploy-sop.md docs/superpowers/specs/2026-10-24-data-mcp-proposal-apply-design.md
git commit -m "docs(data): 提案应用通路的部署与运维口径——PAT scoped、双闸冒烟、§2.9 正典（#1003）"
```

---

## Self-Review 结论（已跑）

- **Spec 覆盖**：§1 工具/白名单→Task 3+4；§2 机制→Task 1+2；§3 失败语义→Task 3 映射 + Task 2 outcome；§4 审计（单行 reply，无额外工作）；§5 测试 1–8→Task 1/2/3；§6 文档部署→Task 5；§7 红线→Global Constraints + Task 3 白名单。无缺口。
- **占位扫描**：Task 3 Step 5 的错误 import 块是**显式标注的教学性反例**，已加 ⚠️ 指令以第二段为准——实现者若照抄会立刻 typecheck 红，属可自纠；其余无 TBD/TODO。
- **类型一致性**：`ProposalApplyOutcome` 五个变体在 Task 1 定义、Task 2 补全实现、Task 3 消费，字段名逐一核对（`currentSha256` / `github_rejected.detail` / `unknown.branch` / `skipped` / `prUrl,prNumber,commitCount`）一致；`PipelineDeps.apply` 可选，旧测试的 deps 字面量不受影响。
