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
