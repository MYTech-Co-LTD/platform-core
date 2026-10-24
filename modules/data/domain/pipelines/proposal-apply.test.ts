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
    // 第二参为测试 seam（Task 1 评审已批的偏离：proposalApplierFromEnv 带可选 io 透传 fetchImpl），注入假 fetch 不连网
    const ap = proposalApplierFromEnv({ DATA_MCP_GITHUB_TOKEN: 'tok' }, { fetchImpl })
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

  it('404 ⇒ 视为新文件（不误判 conflict；走完整写入通路至 applied）', async () => {
    const { fetchImpl, seen } = fakeGithub([
      refRoute,
      { match: /\/contents\//, reply: (rec) => rec.method === 'PUT'
        ? { status: 201, body: { commit: { sha: 'c1' } } }
        : { status: 404, body: { message: 'Not Found' } } },
      { match: /\/git\/refs$/, reply: () => ({ status: 201, body: { ref: 'refs/heads/proposal/t' } }) },
      { match: /\/pulls$/, reply: () => ({ status: 201, body: { number: 1, html_url: 'http://x/1' } }) },
    ])
    const ap = createProposalApplier({ repo, token: 't' }, { fetchImpl })
    // Task 2 起：新文件走完整通路（建分支 → PUT → draft PR），404 不再以 github_rejected 收口
    const out = await ap.apply({ title: 't', rationale: 'r', branch: 'proposal/t', pieces: [piece], downstream: [], validation: [] })
    expect(out.kind).toBe('applied')
    expect(seen.some((r) => r.method === 'PUT')).toBe(true)
  })
})

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
