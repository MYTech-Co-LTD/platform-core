// domain/engine-client.test.ts — 引擎契约 client（OA P1 Task 10 / issue #2363）。
import { describe, expect, it } from 'vitest'
import {
  EngineHttpError, approversOfNode, clientForConfigured, createEngineClient, currentNodeOf,
  engineEntryOf, firstNodeTitleFor, makeEnvEngineResolver, planHasApprover,
} from './engine-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('createEngineClient', () => {
  it('createCase 发 Bearer + JSON，返回 caseId（路径无重复斜杠）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = createEngineClient({
      baseUrl: 'http://e/',
      pat: 'p',
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return json({ caseId: 'c1', runId: 'r1' }, 201)
      }) as never,
    })
    expect(await client.createCase({ org: 'acme', externalRef: 'forms:submission:1' })).toEqual({ caseId: 'c1', runId: 'r1' })
    expect(calls[0].url).toBe('http://e/cases')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer p')
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ org: 'acme', externalRef: 'forms:submission:1' })
  })

  it('getCase / listCases / decide / withdraw 路径与查询编码', async () => {
    const urls: string[] = []
    const client = createEngineClient({
      baseUrl: 'http://e',
      pat: 'p',
      fetchFn: (async (url: string) => {
        urls.push(url)
        return json({ ok: true })
      }) as never,
    })
    await client.getCase('c/1')
    await client.listCases({ externalRef: 'forms:submission:1', status: 'gate' })
    await client.decide('c1', { nodeKey: 'leader', action: 'approve' })
    await client.withdraw('c1', { org: 'acme', actor: 'u1', reason: '不想请了' })
    expect(urls[0]).toBe('http://e/cases/c%2F1')
    expect(urls[1]).toContain('http://e/cases?')
    expect(urls[1]).toContain('externalRef=forms%3Asubmission%3A1')
    expect(urls[1]).toContain('status=gate')
    expect(urls[2]).toBe('http://e/cases/c1/decision')
    expect(urls[3]).toBe('http://e/cases/c1/withdraw')
  })

  it('非 2xx → EngineHttpError 保留 status（409 = 已决策，不是平台故障）', async () => {
    const client = createEngineClient({
      baseUrl: 'http://e', pat: 'p',
      fetchFn: (async () => json({ error: 'already decided' }, 409)) as never,
    })
    await expect(client.withdraw('c1', {})).rejects.toMatchObject({ code: 'ENGINE_HTTP_ERROR', status: 409 })
    await expect(client.withdraw('c1', {})).rejects.toBeInstanceOf(EngineHttpError)
  })

  it('网络失败 → ENGINE_UNAVAILABLE（502 面）', async () => {
    const client = createEngineClient({
      baseUrl: 'http://e', pat: 'p',
      fetchFn: (async () => { throw new Error('ECONNREFUSED') }) as never,
    })
    await expect(client.getCase('c1')).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })
})

describe('makeEnvEngineResolver', () => {
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    FORMS_OA_ENGINE_MAP: JSON.stringify({ acme: { baseUrl: 'http://e', patSecretRef: 'ACME_PAT' } }),
    ACME_PAT: 'secret-p',
    ...over,
  })

  it('按 org 从 map 取引擎；PAT 由 secret 引用从 env 取（值不进配置）', async () => {
    const client = await makeEnvEngineResolver(env())('acme')
    expect(client).not.toBeNull()
  })

  it('无条目 ⇒ null（OA 未开通，routes 回 409）；条目缺 PAT ⇒ 503 OA_ENGINE_MISCONFIGURED', async () => {
    const resolver = makeEnvEngineResolver(env())
    expect(await resolver('other-org')).toBeNull()
    const bad = makeEnvEngineResolver(env({ ACME_PAT: undefined }))
    await expect(bad('acme')).rejects.toMatchObject({ code: 'OA_ENGINE_MISCONFIGURED' })
  })

  it('map 不是合法 JSON ⇒ 炸出声，不静默当未开通', async () => {
    expect(() => engineEntryOf('acme', { FORMS_OA_ENGINE_MAP: '{oops' }))
      .toThrowError(expect.objectContaining({ code: 'OA_ENGINE_MISCONFIGURED' }))
    const dev = engineEntryOf('acme', { FORMS_OA_ENGINE_URL: 'http://e', FORMS_OA_ENGINE_PAT: 'p' })
    expect(dev).toEqual({ baseUrl: 'http://e', pat: 'p' })
  })

  it('clientForConfigured 可直接造 client（脚本/测试用）', () => {
    expect(clientForConfigured({ baseUrl: 'http://e', pat: 'p' })).toBeTruthy()
  })
})

describe('计划快照工具（授权用纯函数）', () => {
  const plan = {
    nodes: [
      { key: 'leader', title: '直属主管', approvers: ['u-lead'] },
      { key: 'hr', title: 'HR', approvers: ['u-hr'] },
    ],
  }

  it('approversOfNode / planHasApprover / firstNodeTitleFor', () => {
    expect(approversOfNode(plan, 'leader')).toEqual(['u-lead'])
    expect(approversOfNode(plan, 'nope')).toEqual([])
    expect(planHasApprover(plan, 'u-hr')).toBe(true)
    expect(planHasApprover(plan, 'u-x')).toBe(false)
    expect(firstNodeTitleFor(plan, 'u-hr')).toBe('HR')
    expect(firstNodeTitleFor(plan, 'u-x')).toBeNull()
    expect(planHasApprover(null, 'u')).toBe(false)
  })

  it('currentNodeOf 兼容字符串与 { key }', () => {
    expect(currentNodeOf({ currentNode: 'leader' })).toBe('leader')
    expect(currentNodeOf({ currentNode: { key: 'hr' } })).toBe('hr')
    expect(currentNodeOf({})).toBeNull()
  })
})
