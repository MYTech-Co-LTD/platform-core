// domain/engine-client.test.ts — 引擎契约 client（OA P1 Task 10 / issue #2363）。
import { describe, expect, it } from 'vitest'
import type { OaEnginePort } from '@platform/sdk'
import {
  EngineHttpError, approversOfNode, clientForConfigured, createEngineClient, currentNodeOf,
  envEngineEntry, firstNodeTitleFor, makeEnvEngineResolver, makeOaEngineResolver, planHasApprover,
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

  it('getCase / listCases / decide / withdraw 路径与查询编码，且每次调用都携 org', async () => {
    const urls: string[] = []
    const bodies: unknown[] = []
    const client = createEngineClient({
      baseUrl: 'http://e',
      pat: 'p',
      fetchFn: (async (url: string, init?: RequestInit) => {
        urls.push(url)
        bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
        return json({ ok: true })
      }) as never,
    })
    await client.getCase('c/1', 'acme')
    await client.listCases('acme', { externalRef: 'forms:submission:1', status: 'gate' })
    await client.decide('c1', 'acme', { nodeKey: 'leader', action: 'approve' })
    await client.withdraw('c1', 'acme', { actor: 'u1', reason: '不想请了' })
    expect(urls[0]).toBe('http://e/cases/c%2F1?org=acme')
    expect(urls[1]).toContain('http://e/cases?')
    expect(urls[1]).toContain('externalRef=forms%3Asubmission%3A1')
    expect(urls[1]).toContain('status=gate')
    expect(urls[1]).toContain('org=acme')
    expect(urls[2]).toBe('http://e/cases/c1/decision')
    expect(urls[3]).toBe('http://e/cases/c1/withdraw')
    // 写面：org 在 body（T9：引擎校验后才推进）
    expect(bodies[2]).toMatchObject({ nodeKey: 'leader', action: 'approve', org: 'acme' })
    expect(bodies[3]).toMatchObject({ actor: 'u1', reason: '不想请了', org: 'acme' })
  })

  it('org 由显式入参决定，body 里的同名字段不能覆盖（防串租户）', async () => {
    let body: unknown
    const client = createEngineClient({
      baseUrl: 'http://e', pat: 'p',
      fetchFn: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return json({ ok: true })
      }) as never,
    })
    await client.decide('c1', 'acme', { action: 'approve', org: 'beta' })
    expect(body).toMatchObject({ action: 'approve', org: 'acme' })
  })

  it('非 2xx → EngineHttpError 保留 status（409 = 已决策，不是平台故障）', async () => {
    const client = createEngineClient({
      baseUrl: 'http://e', pat: 'p',
      fetchFn: (async () => json({ error: 'already decided' }, 409)) as never,
    })
    await expect(client.withdraw('c1', 'acme', {})).rejects.toMatchObject({ code: 'ENGINE_HTTP_ERROR', status: 409 })
    await expect(client.withdraw('c1', 'acme', {})).rejects.toBeInstanceOf(EngineHttpError)
  })

  it('网络失败 → ENGINE_UNAVAILABLE（502 面）', async () => {
    const client = createEngineClient({
      baseUrl: 'http://e', pat: 'p',
      fetchFn: (async () => { throw new Error('ECONNREFUSED') }) as never,
    })
    await expect(client.getCase('c1', 'acme')).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })
})

describe('env 兜底（本地测试/脚本；单租户）', () => {
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    FORMS_OA_ENGINE_URL: 'http://env-engine',
    FORMS_OA_ENGINE_PAT: 'env-pat',
    ...over,
  })

  it('两键齐全才可用；缺任一 ⇒ null（不猜）', () => {
    expect(envEngineEntry(env())).toEqual({ baseUrl: 'http://env-engine', pat: 'env-pat' })
    expect(envEngineEntry(env({ FORMS_OA_ENGINE_PAT: '' }))).toBeNull()
    expect(envEngineEntry(env({ FORMS_OA_ENGINE_URL: '  ' }))).toBeNull()
  })

  it('makeEnvEngineResolver：配好 ⇒ client；没配 ⇒ null', async () => {
    expect(await makeEnvEngineResolver(env())('acme')).not.toBeNull()
    expect(await makeEnvEngineResolver({})('acme')).toBeNull()
  })

  it('clientForConfigured 可直接造 client（脚本/测试用）', () => {
    expect(clientForConfigured({ baseUrl: 'http://e', pat: 'p' })).toBeTruthy()
  })
})

describe('makeOaEngineResolver（宿主 OaEnginePort 优先）', () => {
  const env = { FORMS_OA_ENGINE_URL: 'http://env-engine', FORMS_OA_ENGINE_PAT: 'env-pat' }

  const portOf = (cfg: Awaited<ReturnType<OaEnginePort['get']>>): OaEnginePort => ({
    async get() { return cfg },
  })

  it('注入 port ⇒ 用登记配置（baseUrl + 已解析 PAT），不读 env', async () => {
    const urls: string[] = []
    const auths: string[] = []
    const resolver = makeOaEngineResolver({
      oaEngine: portOf({ baseUrl: 'http://port-engine', pat: 'port-pat', engineVersion: '0.3.0' }),
      env,
      fetchFn: (async (url: string, init: RequestInit) => {
        urls.push(url)
        auths.push((init.headers as Record<string, string>).Authorization)
        return json({ ok: true })
      }) as never,
    })
    const client = await resolver('acme')
    expect(client).not.toBeNull()
    await client!.getCase('c1', 'acme')
    expect(urls[0]).toBe('http://port-engine/cases/c1?org=acme')
    expect(auths[0]).toBe('Bearer port-pat')
  })

  it('port 返回 null（无行/disabled/secret 缺失）⇒ null，**不回落 env**（fail-closed）', async () => {
    const resolver = makeOaEngineResolver({ oaEngine: portOf(null), env })
    expect(await resolver('acme')).toBeNull()
  })

  it('未注入 port（旧宿主/单测）⇒ env 兜底；都没有 ⇒ null', async () => {
    expect(await makeOaEngineResolver({ oaEngine: null, env })('acme')).not.toBeNull()
    expect(await makeOaEngineResolver({ oaEngine: undefined, env })('acme')).not.toBeNull()
    expect(await makeOaEngineResolver({ oaEngine: null, env: {} })('acme')).toBeNull()
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
